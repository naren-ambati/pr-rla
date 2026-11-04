import type { FirstParentCommit } from "../sdk/provider.js";

/**
 * `ScmProvider.firstParentPath` for the built-ins (U8): given the commits reachable from `head` and not from `base`
 * (any order; parents first-parent first), the default branch's first-parent chain from `head` back to, and not
 * including, `base`, newest first. Null when the chain leaves the set without reaching `base`: `base` is then not on
 * `head`'s first-parent history (reached only through a merge's other parent, or not an ancestor at all).
 */
export function firstParentChain(commits: Iterable<{ sha: string; parents: readonly string[]; committedAt: string }>, base: string, head: string): FirstParentCommit[] | null {
  const want = base.toLowerCase();
  const byOid = new Map<string, { parents: readonly string[]; committedAt: string }>();
  for (const c of commits) byOid.set(c.sha.toLowerCase(), c);
  const path: FirstParentCommit[] = [];
  for (let cur = head.toLowerCase(); cur !== want; ) {
    const c = byOid.get(cur);
    const first = c?.parents[0]?.toLowerCase();
    if (!c || !first) return null;
    const t = Date.parse(c.committedAt);
    path.push({ sha: cur, committedAt: Number.isNaN(t) ? c.committedAt : new Date(t).toISOString().replace(".000Z", "Z") });
    cur = first;
  }
  return path;
}
