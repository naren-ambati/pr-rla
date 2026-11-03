import type { AuditWindow } from "../../sdk/provider.js";

export interface HistoryNode {
  oid: string;
  committedDate: string;
  /** Parent oids in order; [0] is the first parent. */
  parents: string[];
  associatedPullRequests: { number: number; merged: boolean; baseRefName: string }[];
}

export interface FirstParentClassification {
  /** First-parent commits in the window that no merged PR into the default branch introduced. */
  directPushes: string[];
  /** PR number -> first-parent commits in the window it introduced (1 for merge/squash, n for rebase). */
  prCommits: Map<number, string[]>;
  /** First-parent commits walked inside the window. */
  walkedInWindow: number;
  /** Why the walk ended. */
  stop: "before-window" | "root" | "missing-parent";
}

/**
 * Classifies what landed on the default branch in the window by walking its
 * FIRST-PARENT chain from `headOid`:
 * - squash merge: one first-parent commit, associated with the PR;
 * - merge commit: the merge commit is first-parent and associated with the PR;
 *   the PR's own commits sit on the second parent and are never walked;
 * - rebase merge: each rebased commit is first-parent and associated with the PR,
 *   so they all map to that one PR (no double counting);
 * - anything else on the first-parent chain is a direct push.
 * GitHub's `associatedPullRequests` can be empty for a PR's own merge commit
 * (seen on real gh-aw data: PR #73884), so a commit that is the
 * `merge_commit_sha` of a merged PR is attributed to that PR as well.
 * The walk stops at the first first-parent commit dated before the window opens.
 */
export function classifyFirstParent(
  nodes: readonly HistoryNode[],
  headOid: string,
  window: AuditWindow,
  defaultBranch: string,
  mergeCommitToPr: ReadonlyMap<string, number> = new Map(),
): FirstParentClassification {
  const byOid = new Map(nodes.map((n) => [n.oid, n]));
  const opens = Date.parse(window.opensAt);
  const closes = Date.parse(window.closesAt);
  const directPushes: string[] = [];
  const prCommits = new Map<number, string[]>();
  let walkedInWindow = 0;
  let cur: string | undefined = headOid;
  let stop: FirstParentClassification["stop"] = "root";
  const seen = new Set<string>();
  while (cur) {
    const n = byOid.get(cur);
    if (!n) {
      stop = "missing-parent";
      break;
    }
    if (seen.has(cur)) throw new Error(`history cycle at ${cur}`);
    seen.add(cur);
    const t = Date.parse(n.committedDate);
    if (t < opens) {
      stop = "before-window";
      break;
    }
    if (t < closes) {
      walkedInWindow++;
      const prs = n.associatedPullRequests.filter((p) => p.merged && p.baseRefName === defaultBranch).map((p) => p.number);
      const byMergeSha = mergeCommitToPr.get(n.oid);
      if (byMergeSha !== undefined && !prs.includes(byMergeSha)) prs.push(byMergeSha);
      if (prs.length === 0) directPushes.push(n.oid);
      else {
        const pr = Math.min(...prs);
        prCommits.set(pr, [...(prCommits.get(pr) ?? []), n.oid]);
      }
    }
    cur = n.parents[0];
    if (cur === undefined) stop = "root";
  }
  return { directPushes, prCommits, walkedInWindow, stop };
}
