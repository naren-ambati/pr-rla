import type { ChangeCheck, ChangeDescription, ChangeRecord, ChangedFile, CheckState, DescribeChangeOptions } from "../../sdk/provider.js";
import { attributesPath, readChangeAttributes } from "../attributes.js";
import { countPatch } from "../diff.js";
import { nextLink, type HttpClient } from "../http.js";
import { followPages } from "../paging.js";

/**
 * `describeChange` for GitLab (functional-design.md §U5): the MR and `merge_requests/:iid/diffs`
 * (paginated), the `.gitattributes` files at the MR's base (`diff_refs.base_sha`) and at its merge
 * commit (`repository/files/:path/raw?ref=`), and the pipelines at the MR's head commit
 * (`pipelines?sha=`). A direct push: `repository/commits/:sha` and its `/diff`; its base is its
 * first parent. GETs only.
 *
 * A diff GitLab marks `too_large` or `collapsed` has no patch here, and its line counts are not
 * known: the description says `truncated`. So does an MR whose `changes_count` is more than the
 * diffs listed (GitLab writes "1000+" past its limit), and a commit whose stats count more lines.
 */

interface GlDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  too_large?: boolean;
  collapsed?: boolean;
}

/** A pipeline's status on the contract's states. */
export function pipelineState(status: string): CheckState {
  switch (status) {
    case "success":
      return "success";
    case "failed":
    case "canceled":
      return "failure";
    case "skipped":
      return "skipped";
    case "manual":
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "pending":
    case "running":
    case "scheduled":
      return "pending";
    default:
      return "unknown";
  }
}

/** A diff GitLab left out (too large, or collapsed): no patch, no line counts. */
export const gitlabDiffWithheld = (d: GlDiff) => !!d.too_large || !!d.collapsed;

export const gitlabFile = (d: GlDiff): ChangedFile => {
  const patch = d.diff && !gitlabDiffWithheld(d) ? d.diff : null;
  const counts = patch === null ? { additions: 0, deletions: 0 } : countPatch(patch);
  return {
    path: d.deleted_file ? d.old_path : d.new_path,
    ...(d.renamed_file ? { previousPath: d.old_path } : {}),
    status: d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified",
    ...counts,
    patch,
  };
};

const paged = <T>(http: HttpClient, first: string, signal?: AbortSignal) =>
  followPages<T, string>(http.url(first), async (url) => {
    const { data, headers } = await http.get<T[]>(url, signal);
    return { items: data, next: nextLink(headers) };
  });

export async function describeGitLabChange(http: HttpClient, change: ChangeRecord, opts: DescribeChangeOptions = {}): Promise<ChangeDescription> {
  const project = encodeURIComponent(change.repo);
  const signal = opts.signal;
  let title: string;
  let body: string;
  let diffs: { items: GlDiff[]; complete: boolean };
  let head: string;
  let base: string | null;
  let truncated = false;
  if (change.kind === "pull_request") {
    const iid = Number(/#(\d+)$/.exec(change.id)?.[1]);
    if (!Number.isInteger(iid)) throw new Error(`gitlab: cannot read an MR iid from ${change.id}`);
    const { data: mr } = await http.get<{ title: string; description: string | null; sha: string; diff_refs?: { head_sha?: string; base_sha?: string } | null; changes_count?: string | null }>(`/projects/${project}/merge_requests/${iid}`, signal);
    title = mr.title;
    body = mr.description ?? "";
    head = mr.diff_refs?.head_sha ?? mr.sha;
    base = mr.diff_refs?.base_sha ?? null;
    diffs = await paged<GlDiff>(http, `/projects/${project}/merge_requests/${iid}/diffs?per_page=100`, signal);
    const count = typeof mr.changes_count === "string" ? mr.changes_count : null;
    if (count !== null && (count.endsWith("+") || Number(count) > diffs.items.length)) truncated = true;
  } else {
    const { data: c } = await http.get<{ title: string; message: string; parent_ids?: string[]; stats?: { additions?: number; deletions?: number } }>(`/projects/${project}/repository/commits/${change.mergeSha}`, signal);
    title = c.title;
    const nl = c.message.indexOf("\n");
    body = nl < 0 ? "" : c.message.slice(nl + 1).replace(/^\n+/, "");
    head = change.mergeSha;
    base = c.parent_ids?.[0] ?? null;
    diffs = await paged<GlDiff>(http, `/projects/${project}/repository/commits/${change.mergeSha}/diff?per_page=100`, signal);
    const counted = diffs.items.map(gitlabFile);
    const sum = (k: "additions" | "deletions") => counted.reduce((a, f) => a + f[k], 0);
    if ((typeof c.stats?.additions === "number" && sum("additions") < c.stats.additions) || (typeof c.stats?.deletions === "number" && sum("deletions") < c.stats.deletions)) truncated = true;
  }
  if (!diffs.complete || diffs.items.some(gitlabDiffWithheld)) truncated = true;
  const files = diffs.items.map(gitlabFile);
  const readAttributes = (dir: string, ref: string) => http.getText(`/projects/${project}/repository/files/${encodeURIComponent(attributesPath(dir))}/raw?ref=${ref}`, signal);
  const gitattributes = await readAttributes("", change.mergeSha);
  const attributes = base ? await readChangeAttributes(files, { base, head: change.mergeSha }, gitattributes, readAttributes) : undefined;
  const pipelines = await paged<{ id: number; status: string; source?: string; web_url: string | null }>(http, `/projects/${project}/pipelines?sha=${head}&per_page=100`, signal);
  const checks: ChangeCheck[] = pipelines.items.map((p) => ({ name: `pipeline #${p.id}${p.source ? ` (${p.source})` : ""}`, state: pipelineState(p.status), url: p.web_url ?? null }));
  return { changeId: change.id, title, body, files, gitattributes, checks, truncated, ...(attributes ? { attributes } : {}), ...(!pipelines.complete ? { checksTruncated: true } : {}) };
}
