import type { ChangeCheck, ChangeDescription, ChangeRecord, ChangedFile, ChangedFileStatus, CheckState } from "../../sdk/provider.js";
import type { HttpClient } from "../http.js";

/**
 * `describeChange` for Bitbucket Data Center (functional-design.md §U5): the PR, its `changes`
 * and `diff` (REST 1.0's JSON diff, turned into unified hunks), `raw/.gitattributes?at=<mergeSha>`,
 * and the build statuses at the PR's source commit (`/rest/build-status/1.0/commits/<sha>`).
 * A direct push: `commits/<sha>`, its `changes` and `diff`. GETs only. Unverified against a live
 * server, like the rest of this provider: built from Atlassian's documented response shapes.
 */

interface DcPage<T> {
  values: T[];
  isLastPage: boolean;
  nextPageStart?: number;
}
interface DcPath {
  toString: string;
}
interface DcChange {
  path: DcPath;
  srcPath?: DcPath | null;
  type: string;
}
interface DcSegment {
  type: "ADDED" | "REMOVED" | "CONTEXT" | string;
  lines: { line: string }[];
}
interface DcHunk {
  sourceLine: number;
  sourceSpan: number;
  destinationLine: number;
  destinationSpan: number;
  segments: DcSegment[];
}
interface DcFileDiff {
  source: DcPath | null;
  destination: DcPath | null;
  hunks?: DcHunk[];
  binary?: boolean;
}

/** A Data Center change type on the contract's statuses. */
export function dcFileStatus(type: string): ChangedFileStatus {
  if (type === "ADD" || type === "COPY") return "added";
  if (type === "DELETE") return "removed";
  if (type === "MOVE") return "renamed";
  return "modified";
}

/** A build status's state. */
export function dcBuildState(state: string): CheckState {
  if (state === "SUCCESSFUL") return "success";
  if (state === "FAILED") return "failure";
  if (state === "INPROGRESS") return "pending";
  return "unknown";
}

/** One file of REST 1.0's JSON diff as unified hunks, with its counts. */
export function dcPatch(d: DcFileDiff): { patch: string | null; additions: number; deletions: number } {
  if (d.binary || !d.hunks?.length) return { patch: null, additions: 0, deletions: 0 };
  const out: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const h of d.hunks) {
    out.push(`@@ -${h.sourceLine},${h.sourceSpan} +${h.destinationLine},${h.destinationSpan} @@`);
    for (const s of h.segments) {
      const mark = s.type === "ADDED" ? "+" : s.type === "REMOVED" ? "-" : " ";
      if (s.type === "ADDED") additions += s.lines.length;
      if (s.type === "REMOVED") deletions += s.lines.length;
      for (const l of s.lines) out.push(`${mark}${l.line}`);
    }
  }
  return { patch: out.join("\n"), additions, deletions };
}

async function all<T>(http: HttpClient, path: string): Promise<T[]> {
  const out: T[] = [];
  let start: number | undefined = 0;
  while (start !== undefined) {
    const sep = path.includes("?") ? "&" : "?";
    const { data }: { data: DcPage<T> } = await http.get<DcPage<T>>(`${path}${sep}start=${start}&limit=1000`);
    out.push(...data.values);
    start = data.isLastPage ? undefined : data.nextPageStart;
  }
  return out;
}

export async function describeBitbucketDcChange(http: HttpClient, root: string, change: ChangeRecord): Promise<ChangeDescription> {
  const [project, slug] = change.repo.split("/") as [string, string];
  const repo = `/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(slug)}`;
  let title: string;
  let body: string;
  let head: string;
  let base: string;
  if (change.kind === "pull_request") {
    const id = Number(/#(\d+)$/.exec(change.id)?.[1]);
    if (!Number.isInteger(id)) throw new Error(`bitbucket-data-center: cannot read a PR id from ${change.id}`);
    const { data: pr } = await http.get<{ title: string; description?: string | null; fromRef?: { latestCommit?: string } }>(`${repo}/pull-requests/${id}`);
    title = pr.title;
    body = pr.description ?? "";
    head = pr.fromRef?.latestCommit ?? change.mergeSha;
    base = `${repo}/pull-requests/${id}`;
  } else {
    const { data: c } = await http.get<{ message: string }>(`${repo}/commits/${change.mergeSha}`);
    const nl = c.message.indexOf("\n");
    title = nl < 0 ? c.message : c.message.slice(0, nl);
    body = nl < 0 ? "" : c.message.slice(nl + 1).replace(/^\n+/, "");
    head = change.mergeSha;
    base = `${repo}/commits/${change.mergeSha}`;
  }
  const changes = await all<DcChange>(http, `${base}/changes`);
  const { data: diff } = await http.get<{ diffs?: DcFileDiff[]; truncated?: boolean }>(`${base}/diff?contextLines=3`);
  const byPath = new Map((diff.diffs ?? []).map((d) => [(d.destination ?? d.source)?.toString ?? "", d]));
  const files: ChangedFile[] = changes.map((c) => {
    const p = byPath.get(c.path.toString);
    const counted = p ? dcPatch(p) : { patch: null, additions: 0, deletions: 0 };
    return { path: c.path.toString, ...(c.type === "MOVE" && c.srcPath ? { previousPath: c.srcPath.toString } : {}), status: dcFileStatus(c.type), ...counted };
  });
  const gitattributes = await http.getText(`${repo}/raw/.gitattributes?at=${change.mergeSha}`);
  const { data: builds } = await http.get<{ values: { key: string; name?: string | null; state: string; url?: string | null }[] }>(`${root}/rest/build-status/1.0/commits/${head}`);
  const checks: ChangeCheck[] = builds.values.map((b) => ({ name: b.name || b.key, state: dcBuildState(b.state), url: b.url ?? null }));
  return { changeId: change.id, title, body, files, gitattributes, checks, truncated: !!diff.truncated };
}
