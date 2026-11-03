import type { AuditWindow } from "../../sdk/provider.js";

export interface HistoryNode {
  oid: string;
  committedDate: string;
  /** Parent oids in order; [0] is the first parent. */
  parents: string[];
  associatedPullRequests: { number: number; merged: boolean; baseRefName: string }[];
}

export interface HistoryClassification {
  /** Commits in the window that no merged PR into the default branch introduced. */
  directPushes: string[];
  /** PR number -> commits in the window it introduced (merge or squash commit, every rebased commit, a merge-commit PR's branch commits). */
  prCommits: Map<number, string[]>;
  /** Commits examined inside the window. */
  inWindow: number;
  /** Direct pushes that are themselves merge commits (e.g. a `git pull` merge pushed to the default branch). */
  directPushMerges: string[];
}

/**
 * Classifies every commit reachable from the default branch whose commit date
 * falls in the window (GitHub's `history`, which is all ancestors, not only
 * first parents):
 * - squash merge: the squash commit is associated with the PR;
 * - merge commit: the merge commit and the PR's own branch commits are all associated with the PR;
 * - rebase merge: every rebased commit is associated with the PR, so they map to one PR;
 * - any other commit is a direct push.
 * GitHub's `associatedPullRequests` can be empty for a PR's own merge commit
 * (seen on real gh-aw data: PR #73884), so a commit that is the
 * `merge_commit_sha` of a merged PR is attributed to that PR as well.
 *
 * Why not first-parent only: a `git pull` merge pushed to the default branch
 * ("foxtrot merge", 8 of them on gh-aw in Q3 2026) puts the local work on the
 * first parent and the real mainline on the second, so a first-parent walk
 * skips everything that landed on the mainline in between.
 */
export function classifyHistory(
  nodes: readonly HistoryNode[],
  window: AuditWindow,
  defaultBranch: string,
  mergeCommitToPr: ReadonlyMap<string, number> = new Map(),
): HistoryClassification {
  const opens = Date.parse(window.opensAt);
  const closes = Date.parse(window.closesAt);
  const directPushes: string[] = [];
  const directPushMerges: string[] = [];
  const prCommits = new Map<number, string[]>();
  let inWindow = 0;
  const seen = new Set<string>();
  const ordered = [...nodes].sort((a, b) => (a.committedDate < b.committedDate ? 1 : a.committedDate > b.committedDate ? -1 : a.oid < b.oid ? -1 : 1));
  for (const n of ordered) {
    if (seen.has(n.oid)) continue;
    seen.add(n.oid);
    const t = Date.parse(n.committedDate);
    if (t < opens || t >= closes) continue;
    inWindow++;
    const prs = n.associatedPullRequests.filter((p) => p.merged && p.baseRefName === defaultBranch).map((p) => p.number);
    const byMergeSha = mergeCommitToPr.get(n.oid);
    if (byMergeSha !== undefined && !prs.includes(byMergeSha)) prs.push(byMergeSha);
    if (prs.length === 0) {
      directPushes.push(n.oid);
      if (n.parents.length > 1) directPushMerges.push(n.oid);
    } else {
      const pr = Math.min(...prs);
      prCommits.set(pr, [...(prCommits.get(pr) ?? []), n.oid]);
    }
  }
  return { directPushes, prCommits, inWindow, directPushMerges };
}
