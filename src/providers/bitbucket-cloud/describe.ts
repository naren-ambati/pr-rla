import type { ChangeCheck, ChangeDescription, ChangeRecord, ChangedFile, ChangedFileStatus, CheckState } from "../../sdk/provider.js";
import { splitUnifiedDiff } from "../diff.js";
import type { HttpClient } from "../http.js";

/**
 * `describeChange` for Bitbucket Cloud (functional-design.md §U5): the PR, its `diffstat`
 * (paginated) and `diff` (one unified diff, split per file), `src/<mergeSha>/.gitattributes`, and
 * the commit statuses at the PR's source commit. A direct push: `commit/<sha>`, `diffstat/<sha>`
 * and `diff/<sha>`. GETs only.
 */

interface BbDiffstat {
  status: string;
  lines_added: number;
  lines_removed: number;
  old: { path: string } | null;
  new: { path: string } | null;
}

/** A commit status's state. */
export function bitbucketStatusState(state: string): CheckState {
  if (state === "SUCCESSFUL") return "success";
  if (state === "FAILED" || state === "STOPPED") return "failure";
  if (state === "INPROGRESS") return "pending";
  return "unknown";
}

const status = (s: string): ChangedFileStatus => (s === "added" || s === "removed" || s === "renamed" ? s : "modified");

async function values<T>(http: HttpClient, first: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = first;
  while (url) {
    const { data }: { data: { values: T[]; next?: string } } = await http.get<{ values: T[]; next?: string }>(url);
    out.push(...data.values);
    url = data.next;
  }
  return out;
}

export async function describeBitbucketCloudChange(http: HttpClient, change: ChangeRecord): Promise<ChangeDescription> {
  const repo = `/repositories/${change.repo}`;
  let title: string;
  let body: string;
  let head: string;
  let spec: string;
  if (change.kind === "pull_request") {
    const id = Number(/#(\d+)$/.exec(change.id)?.[1]);
    if (!Number.isInteger(id)) throw new Error(`bitbucket-cloud: cannot read a PR id from ${change.id}`);
    const { data: pr } = await http.get<{ title: string; description?: string | null; summary?: { raw?: string | null }; source?: { commit?: { hash?: string } } }>(`${repo}/pullrequests/${id}`);
    title = pr.title;
    body = pr.description ?? pr.summary?.raw ?? "";
    head = pr.source?.commit?.hash ?? change.mergeSha;
    spec = `pullrequests/${id}`;
  } else {
    const { data: c } = await http.get<{ message: string }>(`${repo}/commit/${change.mergeSha}`);
    const nl = c.message.indexOf("\n");
    title = nl < 0 ? c.message : c.message.slice(0, nl);
    body = nl < 0 ? "" : c.message.slice(nl + 1).replace(/^\n+/, "");
    head = change.mergeSha;
    spec = change.mergeSha;
  }
  const stats = await values<BbDiffstat>(http, change.kind === "pull_request" ? `${repo}/${spec}/diffstat?pagelen=500` : `${repo}/diffstat/${spec}?pagelen=500`);
  const diff = (await http.getText(change.kind === "pull_request" ? `${repo}/${spec}/diff` : `${repo}/diff/${spec}`)) ?? "";
  const patches = new Map(splitUnifiedDiff(diff).map((p) => [p.path, p]));
  const files: ChangedFile[] = stats.map((s) => {
    const path = (s.new ?? s.old)!.path;
    return {
      path,
      ...(s.status === "renamed" && s.old ? { previousPath: s.old.path } : {}),
      status: status(s.status),
      additions: s.lines_added,
      deletions: s.lines_removed,
      patch: patches.get(path)?.patch ?? null,
    };
  });
  const gitattributes = await http.getText(`${repo}/src/${change.mergeSha}/.gitattributes`);
  const statuses = await values<{ key: string; name?: string | null; state: string; url?: string | null }>(http, `${repo}/commit/${head}/statuses?pagelen=100`);
  const checks: ChangeCheck[] = statuses.map((s) => ({ name: s.name || s.key, state: bitbucketStatusState(s.state), url: s.url ?? null }));
  return { changeId: change.id, title, body, files, gitattributes, checks, truncated: false };
}
