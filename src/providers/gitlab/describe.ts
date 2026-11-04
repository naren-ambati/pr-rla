import type { ChangeCheck, ChangeDescription, ChangeRecord, ChangedFile, CheckState } from "../../sdk/provider.js";
import { countPatch } from "../diff.js";
import { nextLink, type HttpClient } from "../http.js";

/**
 * `describeChange` for GitLab (functional-design.md §U5): the MR and `merge_requests/:iid/diffs`
 * (paginated), `repository/files/.gitattributes/raw?ref=<mergeSha>`, and the pipelines at the
 * MR's head commit (`pipelines?sha=`). A direct push: `repository/commits/:sha` and its `/diff`.
 * GETs only.
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

export const gitlabFile = (d: GlDiff): ChangedFile => {
  const patch = d.diff && !d.too_large ? d.diff : null;
  const counts = patch === null ? { additions: 0, deletions: 0 } : countPatch(patch);
  return {
    path: d.deleted_file ? d.old_path : d.new_path,
    ...(d.renamed_file ? { previousPath: d.old_path } : {}),
    status: d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified",
    ...counts,
    patch,
  };
};

async function paged<T>(http: HttpClient, first: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  while (url) {
    const { data, headers }: { data: T[]; headers: Headers } = await http.get<T[]>(url);
    out.push(...data);
    url = nextLink(headers);
  }
  return out;
}

export async function describeGitLabChange(http: HttpClient, change: ChangeRecord): Promise<ChangeDescription> {
  const project = encodeURIComponent(change.repo);
  let title: string;
  let body: string;
  let diffs: GlDiff[];
  let head: string;
  if (change.kind === "pull_request") {
    const iid = Number(/#(\d+)$/.exec(change.id)?.[1]);
    if (!Number.isInteger(iid)) throw new Error(`gitlab: cannot read an MR iid from ${change.id}`);
    const { data: mr } = await http.get<{ title: string; description: string | null; sha: string; diff_refs?: { head_sha?: string } | null }>(`/projects/${project}/merge_requests/${iid}`);
    title = mr.title;
    body = mr.description ?? "";
    head = mr.diff_refs?.head_sha ?? mr.sha;
    diffs = await paged<GlDiff>(http, `/projects/${project}/merge_requests/${iid}/diffs?per_page=100`);
  } else {
    const { data: c } = await http.get<{ title: string; message: string }>(`/projects/${project}/repository/commits/${change.mergeSha}`);
    title = c.title;
    const nl = c.message.indexOf("\n");
    body = nl < 0 ? "" : c.message.slice(nl + 1).replace(/^\n+/, "");
    head = change.mergeSha;
    diffs = await paged<GlDiff>(http, `/projects/${project}/repository/commits/${change.mergeSha}/diff?per_page=100`);
  }
  const gitattributes = await http.getText(`/projects/${project}/repository/files/.gitattributes/raw?ref=${change.mergeSha}`);
  const pipelines = await paged<{ id: number; status: string; source?: string; web_url: string | null }>(http, `/projects/${project}/pipelines?sha=${head}&per_page=100`);
  const checks: ChangeCheck[] = pipelines.map((p) => ({ name: `pipeline #${p.id}${p.source ? ` (${p.source})` : ""}`, state: pipelineState(p.status), url: p.web_url ?? null }));
  return { changeId: change.id, title, body, files: diffs.map(gitlabFile), gitattributes, checks, truncated: false };
}
