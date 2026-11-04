import type { ChangeCheck, ChangeDescription, ChangeRecord, ChangedFile, ChangedFileStatus, CheckState, DescribeChangeOptions } from "../../sdk/provider.js";
import { attributesPath, encodePath, readChangeAttributes } from "../attributes.js";
import { splitUnifiedDiff } from "../diff.js";
import type { HttpClient } from "../http.js";
import { followPages } from "../paging.js";

/**
 * `describeChange` for Bitbucket Cloud (functional-design.md §U5): the PR, its `diffstat`
 * (paginated) and `diff` (one unified diff, split per file; paths git-quoted or not), the
 * `.gitattributes` files at the PR's destination commit and at its merge commit
 * (`src/<sha>/<dir>/.gitattributes`), and the commit statuses at the PR's source commit (paginated).
 * A direct push: `commit/<sha>`, `diffstat/<sha>` and `diff/<sha>`; its base is its first parent.
 * GETs only.
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

const values = <T>(http: HttpClient, first: string, signal?: AbortSignal) =>
  followPages<T, string>(http.url(first), async (url) => {
    const { data } = await http.get<{ values: T[]; next?: string }>(url, signal);
    return { items: data.values, next: data.next ?? null };
  });

export async function describeBitbucketCloudChange(http: HttpClient, change: ChangeRecord, opts: DescribeChangeOptions = {}): Promise<ChangeDescription> {
  const repo = `/repositories/${change.repo}`;
  const signal = opts.signal;
  let title: string;
  let body: string;
  let head: string;
  let spec: string;
  let base: string | null;
  if (change.kind === "pull_request") {
    const id = Number(/#(\d+)$/.exec(change.id)?.[1]);
    if (!Number.isInteger(id)) throw new Error(`bitbucket-cloud: cannot read a PR id from ${change.id}`);
    const { data: pr } = await http.get<{ title: string; description?: string | null; summary?: { raw?: string | null }; source?: { commit?: { hash?: string } }; destination?: { commit?: { hash?: string } } }>(`${repo}/pullrequests/${id}`, signal);
    title = pr.title;
    body = pr.description ?? pr.summary?.raw ?? "";
    head = pr.source?.commit?.hash ?? change.mergeSha;
    base = pr.destination?.commit?.hash ?? null;
    spec = `pullrequests/${id}`;
  } else {
    const { data: c } = await http.get<{ message: string; parents?: { hash?: string }[] }>(`${repo}/commit/${change.mergeSha}`, signal);
    const nl = c.message.indexOf("\n");
    title = nl < 0 ? c.message : c.message.slice(0, nl);
    body = nl < 0 ? "" : c.message.slice(nl + 1).replace(/^\n+/, "");
    head = change.mergeSha;
    base = c.parents?.[0]?.hash ?? null;
    spec = change.mergeSha;
  }
  const stats = await values<BbDiffstat>(http, change.kind === "pull_request" ? `${repo}/${spec}/diffstat?pagelen=500` : `${repo}/diffstat/${spec}?pagelen=500`, signal);
  const diff = (await http.getText(change.kind === "pull_request" ? `${repo}/${spec}/diff` : `${repo}/diff/${spec}`, signal)) ?? "";
  const patches = new Map(splitUnifiedDiff(diff).map((p) => [p.path, p]));
  const files: ChangedFile[] = stats.items.map((s) => {
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
  const readAttributes = (dir: string, ref: string) => http.getText(`${repo}/src/${ref}/${encodePath(attributesPath(dir))}`, signal);
  const gitattributes = await readAttributes("", change.mergeSha);
  const attributes = base ? await readChangeAttributes(files, { base, head: change.mergeSha }, gitattributes, readAttributes) : undefined;
  const statuses = await values<{ key: string; name?: string | null; state: string; url?: string | null }>(http, `${repo}/commit/${head}/statuses?pagelen=100`, signal);
  const checks: ChangeCheck[] = statuses.items.map((s) => ({ name: s.name || s.key, state: bitbucketStatusState(s.state), url: s.url ?? null }));
  return { changeId: change.id, title, body, files, gitattributes, checks, truncated: !stats.complete, ...(attributes ? { attributes } : {}), ...(!statuses.complete ? { checksTruncated: true } : {}) };
}
