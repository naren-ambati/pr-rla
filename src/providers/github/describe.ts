import type { ChangeCheck, ChangeDescription, ChangeRecord, ChangedFile, ChangedFileStatus, CheckState } from "../../sdk/provider.js";
import { GitHubHttpError, type GitHubHttp } from "./http.js";

/**
 * `describeChange` for GitHub (functional-design.md §U5): `pulls/{n}` and `pulls/{n}/files`
 * (paginated; GitHub lists at most 3,000 files), `contents/.gitattributes?ref=<mergeSha>`, and the
 * check runs plus commit statuses at the PR's head commit (what the merger saw). A direct push:
 * `commits/{sha}` (its files paginated) and the checks at that commit. GETs only.
 */

interface RestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

/** GitHub's file statuses on the contract's four: copied counts as renamed, changed and unchanged as modified. */
export function githubFileStatus(s: string): ChangedFileStatus {
  if (s === "added" || s === "removed" || s === "renamed") return s;
  if (s === "copied") return "renamed";
  return "modified";
}

/** A check run's state: pending until it completes, then by its conclusion. */
export function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "cancelled":
      return "failure";
    case "neutral":
      return "neutral";
    case "skipped":
      return "skipped";
    case "action_required":
      return "pending";
    default:
      return "unknown";
  }
}

/** A commit status's state. */
export function commitStatusState(state: string): CheckState {
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  if (state === "pending") return "pending";
  return "unknown";
}

const toFile = (f: RestFile): ChangedFile => ({
  path: f.filename,
  ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
  status: githubFileStatus(f.status),
  additions: f.additions,
  deletions: f.deletions,
  patch: typeof f.patch === "string" ? f.patch : null,
});

async function pages<T>(http: GitHubHttp, first: string, pick: (data: unknown) => T[]): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  while (url) {
    const r: { data: unknown; next: string | null } = await http.rest<unknown>(url);
    out.push(...pick(r.data));
    url = r.next;
  }
  return out;
}

export async function describeGitHubChange(http: GitHubHttp, change: ChangeRecord): Promise<ChangeDescription> {
  const repo = change.repo;
  let title: string;
  let body: string;
  let files: ChangedFile[];
  let head: string;
  let truncated = false;
  if (change.kind === "pull_request") {
    const n = Number(/#(\d+)$/.exec(change.id)?.[1]);
    if (!Number.isInteger(n)) throw new Error(`github: cannot read a PR number from ${change.id}`);
    const { data: pr } = await http.rest<{ title: string; body: string | null; head: { sha: string }; changed_files?: number }>(`/repos/${repo}/pulls/${n}`);
    title = pr.title;
    body = pr.body ?? "";
    head = pr.head.sha;
    files = (await pages<RestFile>(http, `/repos/${repo}/pulls/${n}/files?per_page=100`, (d) => d as RestFile[])).map(toFile);
    truncated = typeof pr.changed_files === "number" && pr.changed_files > files.length;
  } else {
    let first = true;
    let message = "";
    const raw = await pages<RestFile>(http, `/repos/${repo}/commits/${change.mergeSha}`, (d) => {
      const c = d as { commit: { message: string }; files?: RestFile[] };
      if (first) message = c.commit.message;
      first = false;
      return c.files ?? [];
    });
    const nl = message.indexOf("\n");
    title = nl < 0 ? message : message.slice(0, nl);
    body = nl < 0 ? "" : message.slice(nl + 1).replace(/^\n+/, "");
    head = change.mergeSha;
    files = raw.map(toFile);
  }
  let gitattributes: string | null = null;
  try {
    const { data } = await http.rest<{ type?: string; encoding?: string; content?: string }>(`/repos/${repo}/contents/.gitattributes?ref=${change.mergeSha}`);
    if (data.type === "file" && data.encoding === "base64" && typeof data.content === "string") gitattributes = Buffer.from(data.content, "base64").toString("utf8");
  } catch (e) {
    if (!(e instanceof GitHubHttpError && e.status === 404)) throw e;
  }
  const runs = await pages<{ name: string; status: string; conclusion: string | null; html_url: string | null }>(http, `/repos/${repo}/commits/${head}/check-runs?per_page=100`, (d) => (d as { check_runs: never[] }).check_runs);
  const { data: combined } = await http.rest<{ statuses: { context: string; state: string; target_url: string | null }[] }>(`/repos/${repo}/commits/${head}/status?per_page=100`);
  const checks: ChangeCheck[] = [
    ...runs.map((r) => ({ name: r.name, state: checkRunState(r.status, r.conclusion), url: r.html_url ?? null })),
    ...combined.statuses.map((s) => ({ name: s.context, state: commitStatusState(s.state), url: s.target_url ?? null })),
  ];
  return { changeId: change.id, title, body, files, gitattributes, checks, truncated };
}
