import { createHash } from "node:crypto";
import { gitSafeSpawn, gitSafeText } from "../io/git-safe.js";

/**
 * A file's history read from git's raw objects, each checked to hash to its name (U9, after
 * review). The git-file ledger's append-only check walks it; nothing here is credited to a commit.
 *
 * What git could be told to show differently is never asked: parents come from each raw commit
 * object, not from `git log` or `git rev-list` (no history simplification, no rename following, no
 * commit-graph, no grafts, no replace refs), and file versions are read as blobs, never through
 * blame, diff or textconv. Every call goes through src/io/git-safe.ts (no inherited GIT_*
 * variable, no lazy fetch, no writes, no climbing above the repository).
 *
 * The walk needs the full history: a shallow, grafted or partial repository is refused before
 * anything is read (`historyRefusal` in git-safe.ts), and an object missing from the store makes
 * the history incomplete, reported as such.
 */

export interface GitObject {
  type: string;
  body: Buffer;
}

/** Why an object could not be used: absent, or its content does not hash to its name. */
export type ObjectProblem = "missing" | "corrupt";

function objectHash(name: string, type: string, body: Buffer): string {
  return createHash(name.length === 64 ? "sha256" : "sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
}

/**
 * Raw objects by name, through one `git cat-file --batch`, streamed (no output size limit). Each
 * is kept only if it hashes to its name; otherwise its problem is recorded.
 */
export function readObjects(cwd: string, names: readonly string[]): Promise<Map<string, GitObject | ObjectProblem>> {
  const out = new Map<string, GitObject | ObjectProblem>();
  const unique = [...new Set(names)];
  if (!unique.length) return Promise.resolve(out);
  return new Promise((done, fail) => {
    const child = gitSafeSpawn(["cat-file", "--batch"], { cwd, root: cwd });
    let buf: Buffer = Buffer.alloc(0);
    let pending: { name: string; type: string; size: number } | null = null;
    let stderr = "";
    const drain = () => {
      for (;;) {
        if (!pending) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          const head = buf.subarray(0, nl).toString("utf8").split(" ");
          buf = buf.subarray(nl + 1);
          if (head.length !== 3) {
            out.set(head[0]!, "missing"); // "<name> missing" (or ambiguous)
            continue;
          }
          pending = { name: head[0]!, type: head[1]!, size: Number(head[2]) };
        }
        if (buf.length < pending.size + 1) return;
        const body = Buffer.from(buf.subarray(0, pending.size));
        buf = buf.subarray(pending.size + 1);
        out.set(pending.name, objectHash(pending.name, pending.type, body) === pending.name ? { type: pending.type, body } : "corrupt");
        pending = null;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      drain();
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0) return fail(new Error(`git cat-file --batch exited ${code}: ${stderr.trim()}`));
      for (const n of unique) if (!out.has(n)) out.set(n, "missing");
      done(out);
    });
    child.stdin.on("error", () => {}); // git closing early is reported through "close"
    child.stdin.end(`${unique.join("\n")}\n`);
  });
}

/** `tree` and `parent` headers of a raw commit, as git's parse_commit_buffer reads them. Null if malformed. */
export function commitLinks(body: Buffer): { tree: string; parents: string[] } | null {
  const text = body.toString("latin1");
  const end = text.indexOf("\n\n");
  const lines = (end < 0 ? text : text.slice(0, end)).split("\n");
  const tree = /^tree ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(lines[0] ?? "");
  if (!tree) return null;
  const parents: string[] = [];
  for (const l of lines.slice(1)) {
    const p = /^parent ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(l);
    if (!p) break;
    parents.push(p[1]!);
  }
  return { tree: tree[1]!, parents };
}

/** The entry named `name` in a raw tree object (`<mode> <name>\0<raw id>` repeated), or null. */
export function treeEntry(body: Buffer, name: string, idBytes: number): { mode: string; id: string } | null {
  const want = Buffer.from(name, "utf8");
  let at = 0;
  while (at < body.length) {
    const sp = body.indexOf(0x20, at);
    const nul = body.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 1 + idBytes > body.length) return null;
    const mode = body.subarray(at, sp).toString("latin1");
    const entryName = body.subarray(sp + 1, nul);
    const id = body.subarray(nul + 1, nul + 1 + idBytes).toString("hex");
    if (entryName.equals(want)) return { mode, id };
    at = nul + 1 + idBytes;
  }
  return null;
}

/** A version of the file: its bytes, absent (null), or a path that is not a regular file there. */
export type FileVersion = Buffer | null | "not-a-file";

export interface FileHistory {
  /** HEAD's commit, or null before the first commit. */
  head: string | null;
  /** Every commit reachable from HEAD through raw parent links, parents before children. */
  commits: string[];
  parents: Map<string, string[]>;
  versions: Map<string, FileVersion>;
  /** Why the history could not be read in full (missing or corrupt objects). */
  problems: string[];
}

const short = (sha: string) => sha.slice(0, 10);

/** The history of `rel` (a path relative to the toplevel `top`) in every commit reachable from HEAD. */
export async function readFileHistory(top: string, rel: string): Promise<FileHistory> {
  const empty: FileHistory = { head: null, commits: [], parents: new Map(), versions: new Map(), problems: [] };
  let head: string;
  try {
    head = gitSafeText(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: top, root: top }).trim();
  } catch {
    return empty; // no commit yet
  }
  const idBytes = head.length / 2;
  const problems: string[] = [];
  // rev-list only suggests which commits to read; the walk below trusts nothing but the raw objects it reads.
  let hint: string[] = [head];
  try {
    hint = gitSafeText(["rev-list", "HEAD"], { cwd: top, root: top }).split("\n").filter(Boolean);
  } catch {
    hint = [head];
  }
  const objects = new Map<string, GitObject | ObjectProblem>();
  const links = new Map<string, { tree: string; parents: string[] } | null>();
  const linksOf = (c: string) => {
    if (!links.has(c)) {
      const o = objects.get(c);
      links.set(c, o && typeof o !== "string" && o.type === "commit" ? commitLinks(o.body) : null);
    }
    return links.get(c)!;
  };
  // Follow the raw parent links from HEAD, reading whatever the hint did not name, until nothing is new.
  let toRead = new Set([head, ...hint.filter((s) => s.length === head.length)]);
  const reachable = new Set<string>();
  const namedBy = new Map<string, string>();
  for (;;) {
    for (const [name, o] of await readObjects(top, [...toRead])) objects.set(name, o);
    const need = new Set<string>();
    reachable.clear();
    const stack = [head];
    while (stack.length) {
      const c = stack.pop()!;
      if (reachable.has(c)) continue;
      reachable.add(c);
      if (!objects.has(c)) {
        need.add(c);
        continue;
      }
      for (const p of linksOf(c)?.parents ?? []) {
        if (!namedBy.has(p)) namedBy.set(p, c);
        stack.push(p);
      }
    }
    if (!need.size) break;
    toRead = need;
  }
  for (const c of reachable) {
    const o = objects.get(c)!;
    if (o === "missing")
      problems.push(c === head ? `HEAD's commit ${short(c)} is not in the repository` : `commit ${short(namedBy.get(c)!)} names parent ${short(c)}, which is not in this repository: the history is incomplete`);
    else if (o === "corrupt") problems.push(`commit ${short(c)} does not hash to its name`);
    else if (o.type !== "commit") problems.push(`${short(c)} is a ${o.type}, not a commit`);
    else if (!linksOf(c)) problems.push(`commit ${short(c)} is not a well-formed commit object`);
  }
  if (problems.length) return { ...empty, head, problems: [...new Set(problems)] };

  // Parents before children (iterative post-order from HEAD).
  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const stack: [string, number][] = [[head, 0]];
  while (stack.length) {
    const top2 = stack[stack.length - 1]!;
    const [c, i] = top2;
    if (i === 0) {
      if (state.get(c) === 2) {
        stack.pop();
        continue;
      }
      state.set(c, 1);
    }
    const ps = linksOf(c)!.parents;
    if (i < ps.length) {
      top2[1] = i + 1;
      if (!state.has(ps[i]!)) stack.push([ps[i]!, 0]);
    } else {
      state.set(c, 2);
      order.push(c);
      stack.pop();
    }
  }

  // The path's entry, one tree level at a time, every tree read once.
  const parts = rel.split("/");
  const at = new Map<string, string | null>(); // commit -> object id at the current depth (null: absent)
  for (const c of order) at.set(c, linksOf(c)!.tree);
  const versions = new Map<string, FileVersion>();
  for (let depth = 0; depth < parts.length; depth++) {
    const ids = [...new Set([...at.values()].filter((x): x is string => x !== null))];
    const trees = await readObjects(top, ids);
    const next = new Map<string, { mode: string; id: string } | null | "bad">();
    for (const id of ids) {
      const o = trees.get(id)!;
      if (typeof o === "string" || o.type !== "tree") next.set(id, "bad");
      else next.set(id, treeEntry(o.body, parts[depth]!, idBytes));
    }
    for (const c of order) {
      const id = at.get(c);
      if (id === null || id === undefined) continue;
      const e = next.get(id)!;
      if (e === "bad") {
        problems.push(`tree ${short(id)} (commit ${short(c)}) is missing or does not hash to its name`);
        at.set(c, null);
      } else if (e === null) at.set(c, null);
      else if (depth < parts.length - 1) at.set(c, e.mode === "40000" ? e.id : null);
      else if (e.mode === "100644" || e.mode === "100755") at.set(c, e.id);
      else {
        versions.set(c, "not-a-file");
        at.set(c, null);
      }
    }
  }
  if (problems.length) return { ...empty, head, problems: [...new Set(problems)] };
  const blobIds = [...new Set([...at.values()].filter((x): x is string => x !== null))];
  const blobs = await readObjects(top, blobIds);
  for (const c of order) {
    if (versions.has(c)) continue;
    const id = at.get(c);
    if (id === null || id === undefined) {
      versions.set(c, null);
      continue;
    }
    const o = blobs.get(id)!;
    if (typeof o === "string" || o.type !== "blob") problems.push(`blob ${short(id)} (commit ${short(c)}) is missing or does not hash to its name`);
    else versions.set(c, o.body);
  }
  if (problems.length) return { ...empty, head, problems: [...new Set(problems)] };
  const parents = new Map(order.map((c) => [c, linksOf(c)!.parents]));
  return { head, commits: order, parents, versions, problems: [] };
}

/** True when `later` starts with all of `earlier`: an append. */
export const extendsBytes = (later: Buffer, earlier: Buffer): boolean => later.length >= earlier.length && later.subarray(0, earlier.length).equals(earlier);
