/**
 * Unified-diff helpers for the built-ins' `describeChange` (U5): count a patch's lines and split a
 * multi-file `git diff` (Bitbucket Cloud's /diff) into per-file patches. Pure.
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

const stripPrefix = (p: string) => (p === "/dev/null" ? null : p.replace(/^[ab]\//, "").replace(/\t.*$/, ""));

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
      else if (l.startsWith("rename from ")) renameFrom = l.slice(12);
      else if (l.startsWith("rename to ")) renameTo = l.slice(10);
    }
    if (renameFrom !== null) oldPath ??= renameFrom;
    if (renameTo !== null) newPath ??= renameTo;
    if (oldPath === null && newPath === null) {
      // No ---/+++ lines (a binary file, or a mode change): take the paths from the "diff --git a/x b/y" line.
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]!);
      oldPath = m?.[1] ?? null;
      newPath = m?.[2] ?? null;
      if (header.some((l) => l.startsWith("new file mode"))) oldPath = null;
      if (header.some((l) => l.startsWith("deleted file mode"))) newPath = null;
    }
    const patch = hunkAt < 0 ? null : lines.slice(hunkAt).join("\n");
    const counts = patch === null ? { additions: 0, deletions: 0 } : countPatch(patch);
    out.push({ path: (newPath ?? oldPath)!, oldPath, newPath, patch, ...counts });
  }
  return out;
}
