import type { ChangeCheck, ChangeDescription, ChangeRecord, ChangedFile, ChangedFileStatus, CheckState, DescribeChangeOptions } from "../../sdk/provider.js";
import { attributesPath, encodePath, readChangeAttributes } from "../attributes.js";
import { followPages } from "../paging.js";
import { GitHubHttpError, type GitHubHttp } from "./http.js";

/**
 * `describeChange` for GitHub (functional-design.md §U5): `pulls/{n}` and `pulls/{n}/files`
 * (paginated; GitHub lists at most 3,000 files), the `.gitattributes` files at the PR's base and at
 * its merge commit (`contents/<dir>/.gitattributes?ref=`), and the check runs plus commit statuses at
 * the PR's head commit (what the merger saw), both paginated. A direct push: `commits/{sha}` (its
 * files paginated, also capped at 3,000) and the checks at that commit; its base is its first
 * parent. GETs only.
 */

interface RestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

/** GitHub lists at most this many files of a PR or a commit. */
export const GITHUB_FILE_CAP = 3000;

/** GitHub's file statuses on the contract's four: changed and unchanged count as modified; a copy is an added file with its source as previousPath. */
export function githubFileStatus(s: string): ChangedFileStatus {
  if (s === "added" || s === "removed" || s === "renamed") return s;
  if (s === "copied") return "added";
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
  ...(f.previous_filename && (f.status === "renamed" || f.status === "copied") ? { previousPath: f.previous_filename } : {}),
  status: githubFileStatus(f.status),
  additions: f.additions,
  deletions: f.deletions,
  patch: typeof f.patch === "string" ? f.patch : null,
});

// Absolute from the first page on, so a next link that repeats a page is seen as the same page.
const pages = <T>(http: GitHubHttp, first: string, pick: (data: unknown) => T[], signal?: AbortSignal) =>
  followPages<T, string>(first.startsWith("http") ? first : `${http.apiUrl}${first}`, async (url) => {
    const r = await http.rest<unknown>(url, signal);
    return { items: pick(r.data), next: r.next };
  });

export async function describeGitHubChange(http: GitHubHttp, change: ChangeRecord, opts: DescribeChangeOptions = {}): Promise<ChangeDescription> {
  const repo = change.repo;
  const signal = opts.signal;
  let title: string;
  let body: string;
  let files: ChangedFile[];
  let head: string;
  let base: string | null;
  let truncated: boolean;
  if (change.kind === "pull_request") {
    const n = Number(/#(\d+)$/.exec(change.id)?.[1]);
    if (!Number.isInteger(n)) throw new Error(`github: cannot read a PR number from ${change.id}`);
    const { data: pr } = await http.rest<{ title: string; body: string | null; head: { sha: string }; base?: { sha?: string }; changed_files?: number }>(`/repos/${repo}/pulls/${n}`, signal);
    title = pr.title;
    body = pr.body ?? "";
    head = pr.head.sha;
    base = pr.base?.sha ?? null;
    const listed = await pages<RestFile>(http, `/repos/${repo}/pulls/${n}/files?per_page=100`, (d) => d as RestFile[], signal);
    files = listed.items.map(toFile);
    // Evidence only: the PR's own file count, a walk that stopped early, or a listing at GitHub's cap.
    truncated = !listed.complete || (typeof pr.changed_files === "number" ? pr.changed_files > files.length : files.length >= GITHUB_FILE_CAP);
  } else {
    type RestCommit = { commit: { message: string }; parents?: { sha: string }[]; stats?: { additions?: number; deletions?: number }; files?: RestFile[] };
    const held: { first: RestCommit | null } = { first: null };
    const listed = await pages<RestFile>(http, `/repos/${repo}/commits/${change.mergeSha}`, (d) => {
      const c = d as RestCommit;
      held.first ??= c;
      return c.files ?? [];
    }, signal);
    const c = held.first;
    const message = c?.commit.message ?? "";
    const nl = message.indexOf("\n");
    title = nl < 0 ? message : message.slice(0, nl);
    body = nl < 0 ? "" : message.slice(nl + 1).replace(/^\n+/, "");
    head = change.mergeSha;
    base = c?.parents?.[0]?.sha ?? null;
    files = listed.items.map(toFile);
    const sum = (k: "additions" | "deletions") => files.reduce((a, f) => a + f[k], 0);
    const stats = c?.stats;
    truncated = !listed.complete || files.length >= GITHUB_FILE_CAP || (typeof stats?.additions === "number" && sum("additions") < stats.additions) || (typeof stats?.deletions === "number" && sum("deletions") < stats.deletions);
  }
  const readAttributes = async (dir: string, ref: string): Promise<string | null> => {
    try {
      const { data } = await http.rest<{ type?: string; encoding?: string; content?: string }>(`/repos/${repo}/contents/${encodePath(attributesPath(dir))}?ref=${ref}`, signal);
      return !Array.isArray(data) && data.type === "file" && data.encoding === "base64" && typeof data.content === "string" ? Buffer.from(data.content, "base64").toString("utf8") : null;
    } catch (e) {
      if (e instanceof GitHubHttpError && e.status === 404) return null;
      throw e;
    }
  };
  const gitattributes = await readAttributes("", change.mergeSha);
  const attributes = base ? await readChangeAttributes(files, { base, head: change.mergeSha }, gitattributes, readAttributes) : undefined;
  let runTotal: number | null = null;
  const runs = await followPages<{ name: string; status: string; conclusion: string | null; html_url: string | null }, string>(`${http.apiUrl}/repos/${repo}/commits/${head}/check-runs?per_page=100`, async (url) => {
    const r = await http.rest<{ total_count?: number; check_runs: never[] }>(url, signal);
    if (typeof r.data.total_count === "number") runTotal = r.data.total_count;
    return { items: r.data.check_runs, next: r.next };
  });
  const statuses = await followPages<{ context: string; state: string; target_url: string | null }, string>(`${http.apiUrl}/repos/${repo}/commits/${head}/status?per_page=100`, async (url) => {
    const r = await http.rest<{ statuses: { context: string; state: string; target_url: string | null }[] }>(url, signal);
    return { items: r.data.statuses, next: r.next };
  });
  const checks: ChangeCheck[] = [
    ...runs.items.map((r) => ({ name: r.name, state: checkRunState(r.status, r.conclusion), url: r.html_url ?? null })),
    ...statuses.items.map((s) => ({ name: s.context, state: commitStatusState(s.state), url: s.target_url ?? null })),
  ];
  const checksTruncated = !runs.complete || !statuses.complete || (runTotal !== null && runTotal > runs.items.length);
  return { changeId: change.id, title, body, files, gitattributes, checks, truncated, ...(attributes ? { attributes } : {}), ...(checksTruncated ? { checksTruncated } : {}) };
}
