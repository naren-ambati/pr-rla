import { attributeDirs, isAttributesFile, isLinguistGenerated, parseGitattributes } from "../core/generated.js";
import type { ChangeAttributes, ChangedFile } from "../sdk/provider.js";

/**
 * Which `.gitattributes` files the built-ins read for a draw context (U5 fix round, H2), and the
 * reading: the root file at the change's base and landed commits, and, for the files the root marks
 * generated at both, the file of every directory above them at both commits, so a nested file that
 * unsets `linguist-generated` is seen (git's precedence is applied by src/core/generated.ts).
 *
 * A file the root does not mark is never read further: whatever a nested file says, it is shown,
 * which is the safe side. When the change touches a `.gitattributes`, only the roots are read: the
 * core drops nothing then. At most MAX_ATTRIBUTE_DIRS directories are read per commit, shallowest
 * first; files below the rest cannot be decided, and are shown.
 */
export const MAX_ATTRIBUTE_DIRS = 32;

export async function readChangeAttributes(
  files: readonly ChangedFile[],
  shas: { base: string; head: string },
  headRoot: string | null,
  read: (dir: string, sha: string) => Promise<string | null>,
): Promise<ChangeAttributes> {
  const baseRoot = await read("", shas.base);
  const out: ChangeAttributes = { baseSha: shas.base, base: { "": baseRoot }, head: { "": headRoot } };
  const paths = files.flatMap((f) => (f.previousPath !== undefined ? [f.path, f.previousPath] : [f.path]));
  if (paths.some(isAttributesFile) || baseRoot === null || headRoot === null) return out;
  const b = parseGitattributes(baseRoot);
  const h = parseGitattributes(headRoot);
  const candidates = files.filter((f) => [f.path, ...(f.previousPath !== undefined ? [f.previousPath] : [])].every((p) => isLinguistGenerated(b, p) && isLinguistGenerated(h, p)));
  const dirs = [...new Set(candidates.flatMap((f) => [f.path, ...(f.previousPath !== undefined ? [f.previousPath] : [])].flatMap((p) => attributeDirs(p).slice(1))))]
    .sort((x, y) => x.split("/").length - y.split("/").length || (x < y ? -1 : x > y ? 1 : 0))
    .slice(0, MAX_ATTRIBUTE_DIRS);
  for (const d of dirs) {
    out.base[d] = await read(d, shas.base);
    out.head[d] = await read(d, shas.head);
  }
  return out;
}

/** A repository path, each segment URL-encoded (for path parameters such as GitHub's `contents/{path}`). */
export const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** `<dir>/.gitattributes`, or `.gitattributes` for the root. */
export const attributesPath = (dir: string) => (dir === "" ? ".gitattributes" : `${dir}/.gitattributes`);
