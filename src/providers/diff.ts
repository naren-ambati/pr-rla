/**
 * Unified-diff helpers for the built-ins' `describeChange` (U5): count a patch's lines and split a
 * multi-file `git diff` (Bitbucket Cloud's /diff) into per-file patches, with paths plain or
 * git-quoted (`"caf\303\251.txt"`), so they match the diffstat's. Pure.
 */

/** Added and removed lines of a patch, counted from its first hunk on (headers are not lines). */
export function countPatch(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk) continue;
    else if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export interface DiffFilePatch {
  /** The path after the change (the path before it for a deletion). */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  /** The hunks (from the first `@@`), or null for a binary file or one with no hunks. */
  patch: string | null;
  additions: number;
  deletions: number;
}

/**
 * A path as git writes it in a diff header: plain, or C-quoted when it holds special bytes
 * (`"caf\303\251.txt"`: octal escapes of its UTF-8 bytes, and \\ \" \t \n …). Returns the path and
 * the rest of the text after it.
 */
export function readGitPath(s: string): { path: string; rest: string } {
  if (!s.startsWith('"')) {
    const tab = s.indexOf("\t");
    return { path: tab < 0 ? s : s.slice(0, tab), rest: tab < 0 ? "" : s.slice(tab) };
  }
  const bytes: number[] = [];
  const ESC: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 0x5c, '"': 0x22 };
  for (let i = 1; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') return { path: Buffer.from(bytes).toString("utf8"), rest: s.slice(i + 1) };
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const e = s[++i] ?? "";
    if (/[0-3]/.test(e) && /^[0-7]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else if (ESC[e] !== undefined) bytes.push(ESC[e]!);
    else bytes.push(...Buffer.from(e, "utf8"));
  }
  return { path: Buffer.from(bytes).toString("utf8"), rest: "" };
}

const stripPrefix = (p: string) => {
  const { path } = readGitPath(p);
  return path === "/dev/null" ? null : path.replace(/^[ab]\//, "");
};

/** The two paths of a `diff --git a/x b/y` line, each plain or quoted. */
function gitLinePaths(line: string): { a: string; b: string } | null {
  const body = line.slice("diff --git ".length);
  if (body.startsWith('"')) {
    const first = readGitPath(body);
    const second = readGitPath(first.rest.replace(/^ /, ""));
    return { a: first.path.replace(/^a\//, ""), b: second.path.replace(/^b\//, "") };
  }
  // Unquoted: "a/<p> b/<p>"; split at the " b/" that leaves the same path on both sides when it can.
  const m = /^a\/(.+) b\/(.+)$/.exec(body);
  if (!m) return null;
  const half = (body.length - 5) / 2;
  if (Number.isInteger(half) && body.slice(2, 2 + half) === body.slice(5 + half)) return { a: body.slice(2, 2 + half), b: body.slice(5 + half) };
  return { a: m[1]!, b: m[2]! };
}

/** Splits `git diff` output into one entry per file. */
export function splitUnifiedDiff(text: string): DiffFilePatch[] {
  const out: DiffFilePatch[] = [];
  const blocks = text.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git "));
  for (const block of blocks) {
    const lines = block.replace(/\n$/, "").split("\n");
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    const hunkAt = lines.findIndex((l) => l.startsWith("@@"));
    const header = hunkAt < 0 ? lines : lines.slice(0, hunkAt);
    for (const l of header) {
      if (l.startsWith("--- ")) oldPath = stripPrefix(l.slice(4));
      else if (l.startsWith("+++ ")) newPath = stripPrefix(l.slice(4));
      else if (l.startsWith("rename from ")) renameFrom = readGitPath(l.slice(12)).path;
      else if (l.startsWith("rename to ")) renameTo = readGitPath(l.slice(10)).path;
      else if (l.startsWith("copy from ")) renameFrom = readGitPath(l.slice(10)).path;
      else if (l.startsWith("copy to ")) renameTo = readGitPath(l.slice(8)).path;
    }
    if (renameFrom !== null) oldPath ??= renameFrom;
    if (renameTo !== null) newPath ??= renameTo;
    if (oldPath === null && newPath === null) {
      // No ---/+++ lines (a binary file, or a mode change): take the paths from the "diff --git a/x b/y" line.
      const m = gitLinePaths(lines[0]!);
      oldPath = m?.a ?? null;
      newPath = m?.b ?? null;
      if (header.some((l) => l.startsWith("new file mode"))) oldPath = null;
      if (header.some((l) => l.startsWith("deleted file mode"))) newPath = null;
    }
    const patch = hunkAt < 0 ? null : lines.slice(hunkAt).join("\n");
    const counts = patch === null ? { additions: 0, deletions: 0 } : countPatch(patch);
    out.push({ path: (newPath ?? oldPath)!, oldPath, newPath, patch, ...counts });
  }
  return out;
}
