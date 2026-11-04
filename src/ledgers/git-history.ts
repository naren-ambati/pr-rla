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
 *
 * It streams (P4, second-pass review finding 4): each object is parsed as `git cat-file --batch`
 * writes it and then dropped, so a commit keeps only its tree id and its parents, and a tree only
 * the one entry the path needs. Memory grows with the number of commits, not with their messages or
 * the size of their trees; only the file's own distinct versions are kept whole.
 */

export interface GitObject {
  type: string;
  /** The object's content. In `streamObjects`, valid only during the visit: copy what you keep. */
  body: Buffer;
}

/** Why an object could not be used: absent, or its content does not hash to its name. */
export type ObjectProblem = "missing" | "corrupt";

function objectHash(name: string, type: string, body: Buffer): string {
  return createHash(name.length === 64 ? "sha256" : "sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");
}

/** Where `streamObjects` takes the names to read from: a list, or the output of `git rev-list <args>`, piped. */
export type ObjectNames = readonly string[] | { revList: readonly string[] };

/**
 * Streams raw objects through one `git cat-file --batch`: `visit` sees each object, checked to hash
 * to its name, or its problem, in the order the names were given. The body is a view of the
 * reader's buffers, valid only during the call. A listed name git gave no answer for is visited as
 * missing at the end.
 */
export function streamObjects(cwd: string, names: ObjectNames, visit: (name: string, object: GitObject | ObjectProblem) => void): Promise<void> {
  const listed = Array.isArray(names) ? [...new Set(names as readonly string[])] : null;
  if (listed && !listed.length) return Promise.resolve();
  return new Promise((done, fail) => {
    const child = gitSafeSpawn(["cat-file", "--batch"], { cwd, root: cwd });
    let answered = 0;
    let stderr = "";
    let failed = false;
    const stop = (e: Error) => {
      if (failed) return;
      failed = true;
      child.kill();
      fail(e);
    };
    const call = (name: string, o: GitObject | ObjectProblem) => {
      answered++;
      try {
        visit(name, o);
      } catch (e) {
        stop(e as Error);
      }
    };
    // Parser state: a header line, then `size` body bytes and a LF.
    let head = "";
    let pending: { name: string; type: string; size: number } | null = null;
    let scratch = Buffer.alloc(0);
    let filled = 0;
    const emit = (body: Buffer) => {
      const p = pending!;
      pending = null;
      call(p.name, objectHash(p.name, p.type, body) === p.name ? { type: p.type, body } : "corrupt");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      let at = 0;
      while (at < chunk.length && !failed) {
        if (!pending) {
          const nl = chunk.indexOf(0x0a, at);
          if (nl < 0) {
            head += chunk.toString("latin1", at);
            return;
          }
          const line = (head + chunk.toString("latin1", at, nl)).split(" ");
          head = "";
          at = nl + 1;
          if (line.length !== 3) {
            call(line[0]!, "missing"); // "<name> missing" (or ambiguous)
            continue;
          }
          pending = { name: line[0]!, type: line[1]!, size: Number(line[2]) };
          filled = 0;
          // The whole body (and its LF) in this chunk: visit a view of it, no copy.
          if (chunk.length - at >= pending.size + 1) {
            const body = chunk.subarray(at, at + pending.size);
            at += pending.size + 1;
            emit(body);
            continue;
          }
          if (scratch.length < pending.size + 1) scratch = Buffer.allocUnsafe(Math.max(pending.size + 1, scratch.length * 2, 64 * 1024));
        }
        // A body split across chunks: gathered in one reused buffer.
        const take = Math.min(pending.size + 1 - filled, chunk.length - at);
        chunk.copy(scratch, filled, at, at + take);
        filled += take;
        at += take;
        if (filled === pending.size + 1) emit(scratch.subarray(0, pending.size));
      }
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", stop);
    child.on("close", (code) => {
      if (failed) return;
      if (code !== 0) return fail(new Error(`git cat-file --batch exited ${code}: ${stderr.trim()}`));
      // git answers each name in order: any it did not reach are missing.
      if (listed) for (const n of listed.slice(answered)) call(n, "missing");
      if (!failed) done();
    });
    child.stdin.on("error", () => {}); // git closing early is reported through "close"
    if (listed) child.stdin.end(`${listed.join("\n")}\n`);
    else {
      // The names come straight from `git rev-list`, piped: no list of every commit is held here.
      const rev = gitSafeSpawn(["rev-list", ...(names as { revList: readonly string[] }).revList], { cwd, root: cwd });
      rev.on("error", () => child.stdin.end());
      rev.stderr.resume();
      rev.stdout.pipe(child.stdin);
    }
  });
}

/**
 * Raw objects by name (copied, so they outlive the read), each kept only if it hashes to its name;
 * otherwise its problem is recorded. For a few objects; the walk below streams.
 */
export async function readObjects(cwd: string, names: readonly string[]): Promise<Map<string, GitObject | ObjectProblem>> {
  const out = new Map<string, GitObject | ObjectProblem>();
  await streamObjects(cwd, names, (name, o) => out.set(name, typeof o === "string" ? o : { type: o.type, body: Buffer.from(o.body) }));
  return out;
}

const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The object id after `prefix` on the line starting at `at` (`<prefix><hex>\n`), as a fresh string, and where the next line starts; or null. */
function idLine(body: Buffer, at: number, prefix: string): { id: string; next: number } | null {
  if (body.toString("latin1", at, at + prefix.length) !== prefix) return null;
  const nl = body.indexOf(0x0a, at + prefix.length);
  const end = nl < 0 ? body.length : nl;
  // Read from the bytes, not sliced from a larger string, so a kept id holds no commit text alive.
  const id = body.toString("latin1", at + prefix.length, end);
  return HEX.test(id) ? { id, next: end + 1 } : null;
}

/** `tree` and `parent` headers of a raw commit, as git's parse_commit_buffer reads them. Null if malformed. */
export function commitLinks(body: Buffer): { tree: string; parents: string[] } | null {
  const tree = idLine(body, 0, "tree ");
  if (!tree) return null;
  const parents: string[] = [];
  let at = tree.next;
  for (;;) {
    const p = idLine(body, at, "parent ");
    if (!p) break;
    parents.push(p.id);
    at = p.next;
  }
  return { tree: tree.id, parents };
}

/** The entry named `name` in a raw tree object (`<mode> <name>\0<raw id>` repeated), or null. */
export function treeEntry(body: Buffer, name: string, idBytes: number): { mode: string; id: string } | null {
  const want = Buffer.from(name, "utf8");
  let at = 0;
  while (at < body.length) {
    const sp = body.indexOf(0x20, at);
    const nul = body.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 1 + idBytes > body.length) return null;
    if (nul - sp - 1 === want.length && body.compare(want, 0, want.length, sp + 1, nul) === 0) return { mode: body.toString("latin1", at, sp), id: body.toString("hex", nul + 1, nul + 1 + idBytes) };
    at = nul + 1 + idBytes;
  }
  return null;
}

/** A version of the file: its bytes, absent (null), or a path that is not a regular file there. */
export type FileVersion = Buffer | null | "not-a-file";

/** What a tree entry's mode is, in words. */
export function describeMode(mode: string): string {
  if (mode === "120000") return "a symbolic link";
  if (mode === "160000") return "a submodule";
  if (mode === "40000") return "a directory";
  if (mode === "100644" || mode === "100755") return "a file";
  return `an entry of mode ${mode}`;
}

export interface FileHistory {
  /** HEAD's commit, or null before the first commit. */
  head: string | null;
  /** Every commit reachable from HEAD through raw parent links, parents before children. */
  commits: string[];
  /** The parents of `commits[i]`, as indices into `commits`, in their raw object's order. */
  parents: number[][];
  /** The file in `commits[i]` (one Buffer per distinct version). */
  versions: FileVersion[];
  /** Commits (indices) where the file is absent because a directory on its path is something else there, such as a symbolic link: that path and its mode. */
  blocked: Map<number, { path: string; mode: string }>;
  /** Why the history could not be read in full (missing or corrupt objects). */
  problems: string[];
}

const short = (sha: string) => sha.slice(0, 10);
const NO_PARENTS: number[] = [];

// Commit states while the graph is read.
const UNREAD = 0;
const COMMIT = 1;
const MISSING = 2;
const CORRUPT = 3;
const NOT_A_COMMIT = 4;
const MALFORMED = 5;

interface PathEntries {
  /** Per root, the entry the path names, or null where it is absent. */
  entries: ({ mode: string; id: string } | null)[];
  /** Per root, where a directory on the path is something else. */
  blocked: Map<number, { path: string; mode: string }>;
  /** Per root, a tree that is missing or does not hash to its name. */
  bad: Map<number, string>;
}

/**
 * Follows `parts` (a path split at "/") down from each of `roots` (tree ids), one tree level at a
 * time, each tree read once and streamed, keeping only the entry the path needs.
 */
async function resolvePath(top: string, roots: readonly string[], parts: readonly string[], idBytes: number): Promise<PathEntries> {
  // Most commits share their path's entries (one `audit` tree for many root trees): keep one object per entry.
  const interned = new Map<string, { mode: string; id: string }>();
  const keep = (e: { mode: string; id: string }) => {
    const k = `${e.mode} ${e.id}`;
    const x = interned.get(k);
    if (x) return x;
    interned.set(k, e);
    return e;
  };
  const at: (string | null)[] = [...roots];
  const entries: PathEntries["entries"] = new Array(roots.length).fill(null);
  const blocked: PathEntries["blocked"] = new Map();
  const bad: PathEntries["bad"] = new Map();
  for (let depth = 0; depth < parts.length; depth++) {
    const found = new Map<string, { mode: string; id: string } | null | "bad">();
    const name = parts[depth]!;
    await streamObjects(top, [...new Set(at.filter((x): x is string => x !== null))], (id, o) => {
      if (typeof o === "string" || o.type !== "tree") return void found.set(id, "bad");
      const e = treeEntry(o.body, name, idBytes);
      found.set(id, e && keep(e));
    });
    const last = depth === parts.length - 1;
    for (let i = 0; i < at.length; i++) {
      const id = at[i];
      if (id === null || id === undefined) continue;
      const e = found.has(id) ? found.get(id)! : "bad";
      at[i] = null;
      if (e === "bad") bad.set(i, id);
      else if (e === null) continue;
      else if (last) entries[i] = e;
      else if (e.mode === "40000") at[i] = e.id;
      else blocked.set(i, { path: parts.slice(0, depth + 1).join("/"), mode: e.mode });
    }
  }
  return { entries, blocked, bad };
}

/** The history of `rel` (a path relative to the toplevel `top`) in every commit reachable from HEAD. */
export async function readFileHistory(top: string, rel: string): Promise<FileHistory> {
  const empty: FileHistory = { head: null, commits: [], parents: [], versions: [], blocked: new Map(), problems: [] };
  let head: string;
  try {
    head = gitSafeText(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: top, root: top }).trim();
  } catch {
    return empty; // no commit yet
  }
  const idBytes = head.length / 2;

  // The commit graph, by index: per commit only its tree id and its parents.
  const index = new Map<string, number>();
  const ids: string[] = [];
  const tree: (string | null)[] = [];
  const parentsOf: number[][] = [];
  const state: number[] = [];
  const typeOf = new Map<number, string>();
  const idOf = (name: string): number => {
    let i = index.get(name);
    if (i === undefined) {
      i = ids.length;
      index.set(name, i);
      ids.push(name);
      tree.push(null);
      parentsOf.push(NO_PARENTS);
      state.push(UNREAD);
    }
    return i;
  };
  const headIdx = idOf(head);
  const visitCommit = (name: string, o: GitObject | ObjectProblem) => {
    if (!HEX.test(name) || name.length !== head.length) return; // a hint is never trusted
    const i = idOf(name);
    if (state[i] !== UNREAD) return;
    if (o === "missing") state[i] = MISSING;
    else if (o === "corrupt") state[i] = CORRUPT;
    else if (o.type !== "commit") {
      state[i] = NOT_A_COMMIT;
      typeOf.set(i, o.type);
    } else {
      const links = commitLinks(o.body);
      if (!links) state[i] = MALFORMED;
      else {
        state[i] = COMMIT;
        tree[i] = links.tree;
        parentsOf[i] = links.parents.length ? links.parents.map(idOf) : NO_PARENTS;
      }
    }
  };
  // rev-list only suggests which commits to read; the walk trusts nothing but the raw objects it reads.
  await streamObjects(top, { revList: ["HEAD"] }, visitCommit);
  // Follow the raw parent links from HEAD, reading whatever the hint did not name, until nothing is new.
  const namedBy = new Map<number, number>();
  let reachable = new Uint8Array(0);
  for (;;) {
    reachable = new Uint8Array(ids.length);
    const need: string[] = [];
    const stack = [headIdx];
    while (stack.length) {
      const i = stack.pop()!;
      if (reachable[i]) continue;
      reachable[i] = 1;
      if (state[i] === UNREAD) {
        need.push(ids[i]!);
        continue;
      }
      for (const p of parentsOf[i]!) {
        if (!namedBy.has(p)) namedBy.set(p, i);
        stack.push(p);
      }
    }
    if (!need.length) break;
    await streamObjects(top, need, visitCommit);
  }
  const problems: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (!reachable[i]) continue;
    const c = ids[i]!;
    if (state[i] === MISSING)
      problems.push(i === headIdx ? `HEAD's commit ${short(c)} is not in the repository` : `commit ${short(ids[namedBy.get(i)!]!)} names parent ${short(c)}, which is not in this repository: the history is incomplete`);
    else if (state[i] === CORRUPT) problems.push(`commit ${short(c)} does not hash to its name`);
    else if (state[i] === NOT_A_COMMIT) problems.push(`${short(c)} is a ${typeOf.get(i)}, not a commit`);
    else if (state[i] === MALFORMED) problems.push(`commit ${short(c)} is not a well-formed commit object`);
  }
  if (problems.length) return { ...empty, head, problems: [...new Set(problems)] };

  // Parents before children (iterative post-order from HEAD).
  const order: number[] = [];
  const mark = new Uint8Array(ids.length); // 1: entered, 2: done
  const stack: [number, number][] = [[headIdx, 0]];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const [c, i] = frame;
    if (i === 0) {
      if (mark[c] === 2) {
        stack.pop();
        continue;
      }
      mark[c] = 1;
    }
    const ps = parentsOf[c]!;
    if (i < ps.length) {
      frame[1] = i + 1;
      if (!mark[ps[i]!]) stack.push([ps[i]!, 0]);
    } else {
      mark[c] = 2;
      order.push(c);
      stack.pop();
    }
  }
  const position = new Int32Array(ids.length).fill(-1);
  order.forEach((c, k) => (position[c] = k));

  // The path's entry in every commit, then the file's distinct versions.
  const { entries, blocked, bad } = await resolvePath(
    top,
    order.map((c) => tree[c]!),
    rel.split("/"),
    idBytes,
  );
  for (const [k, id] of bad) problems.push(`tree ${short(id)} (commit ${short(ids[order[k]!]!)}) is missing or does not hash to its name`);
  if (problems.length) return { ...empty, head, problems: [...new Set(problems)] };
  const versions: FileVersion[] = new Array(order.length).fill(null);
  const blobIds = new Set<string>();
  entries.forEach((e, k) => {
    if (!e) return;
    if (e.mode === "100644" || e.mode === "100755") blobIds.add(e.id);
    else versions[k] = "not-a-file";
  });
  const blobs = new Map<string, Buffer | null>();
  await streamObjects(top, [...blobIds], (id, o) => void blobs.set(id, typeof o === "string" || o.type !== "blob" ? null : Buffer.from(o.body)));
  entries.forEach((e, k) => {
    if (!e || versions[k] === "not-a-file") return;
    const b = blobs.get(e.id);
    if (!b) problems.push(`blob ${short(e.id)} (commit ${short(ids[order[k]!]!)}) is missing or does not hash to its name`);
    else versions[k] = b;
  });
  if (problems.length) return { ...empty, head, problems: [...new Set(problems)] };
  return { head, commits: order.map((c) => ids[c]!), parents: order.map((c) => parentsOf[c]!.map((p) => position[p]!)), versions, blocked, problems: [] };
}

/** The file at `rel` in HEAD's tree, read and hash-checked as the walk reads it: its bytes, absent (null), or not a regular file. */
export async function fileAtHead(top: string, rel: string): Promise<FileVersion> {
  let head: string;
  try {
    head = gitSafeText(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: top, root: top }).trim();
  } catch {
    return null;
  }
  const commit = (await readObjects(top, [head])).get(head);
  const links = commit && typeof commit !== "string" && commit.type === "commit" ? commitLinks(commit.body) : null;
  if (!links) return null;
  const e = (await resolvePath(top, [links.tree], rel.split("/"), head.length / 2)).entries[0];
  if (!e) return null;
  if (e.mode !== "100644" && e.mode !== "100755") return "not-a-file";
  const blob = (await readObjects(top, [e.id])).get(e.id);
  return blob && typeof blob !== "string" && blob.type === "blob" ? blob.body : null;
}

/** True when `later` starts with all of `earlier`: an append. */
export const extendsBytes = (later: Buffer, earlier: Buffer): boolean => later.length >= earlier.length && later.subarray(0, earlier.length).equals(earlier);
