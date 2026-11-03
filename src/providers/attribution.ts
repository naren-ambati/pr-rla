/**
 * Splits default-branch commits dated in the window into "brought in by a merged
 * PR into the default branch" and direct pushes, reading PR commit lists only
 * while unclaimed commits remain.
 *
 * 1. Commits whose SHA (or abbreviated SHA) is a PR's merge, squash or head
 *    commit are claimed without any request (`known`).
 * 2. While some commit is unclaimed, the next PR's commit list is read (in the
 *    given order) and its commits are claimed by SHA, or by `rebaseKey` (a rebase
 *    re-creates a commit with a new SHA but the same author and message).
 * 3. Whatever is left is a direct push.
 *
 * The result does not depend on the reading order or on when it stops: a commit
 * is a direct push exactly when no PR in `prs` (or `known`) claims it.
 */
export async function attributeCommits<C>(args: {
  commits: readonly C[];
  sha: (c: C) => string;
  /** SHA -> PR, from listings. Keys may be abbreviated to `prefixLength`. */
  known: ReadonlyMap<string, number>;
  prefixLength?: number;
  /** PRs whose commit lists may claim commits, in reading order. */
  prs: readonly number[];
  /** One PR's listed commits: their SHAs and, for rebase matching, their keys. */
  readCommits: (pr: number) => Promise<{ sha: string; key?: string }[]>;
  /** The rebase key of a default-branch commit (same author and message => same key). */
  rebaseKey?: (c: C) => string;
}): Promise<{ pushes: C[]; linked: number; byRebase: number; listsRead: number }> {
  const full = (c: C) => args.sha(c).toLowerCase();
  const isKnown = (s: string) => args.known.has(s) || (args.prefixLength !== undefined && args.known.has(s.slice(0, args.prefixLength)));
  let open = args.commits.filter((c) => !isKnown(full(c)));
  let byRebase = 0;
  let listsRead = 0;
  for (const pr of args.prs) {
    if (open.length === 0) break;
    const listed = await args.readCommits(pr);
    listsRead++;
    const shas = new Set(listed.map((l) => l.sha.toLowerCase()));
    const keys = new Set(listed.flatMap((l) => (l.key === undefined ? [] : [l.key])));
    open = open.filter((c) => {
      if (shas.has(full(c))) return false;
      if (args.rebaseKey && keys.has(args.rebaseKey(c))) {
        byRebase++;
        return false;
      }
      return true;
    });
  }
  return { pushes: open, linked: args.commits.length - open.length, byRebase, listsRead };
}
