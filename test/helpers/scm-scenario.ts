/**
 * One hand-built default-branch history with every merge strategy, rendered by
 * each provider's fake server (fake-gitlab, fake-bitbucket-cloud, ...) in that
 * SCM's own API shapes. Window: 2026-08-01 (UTC). Default branch: main.
 *
 * main, newest first:
 *   L10   08-02 10:00  squash of PR 10, merged after the window
 *   P9b   08-01 23:30  \ PR 9, fast-forwarded on 08-02 (after the window): dated
 *   P9a   08-01 23:00  /   inside it, but neither a direct push nor counted
 *   M11   08-01 21:00:05 merge commit of PR 11 (squash + merge commit), parents [D2, S11]
 *   S11   08-01 21:00     PR 11's squash commit
 *   D2    08-01 20:00  direct push (alice, human)
 *   M3    08-01 18:00  merge commit of PR 3, parents [S5, F3b]
 *   F3b   08-01 09:00     PR 3's branch commit (F3a, 07-31, is before the window)
 *   S5    08-01 16:00  squash of PR 5
 *   R2c..a 08-01 15:00  PR 2 rebased: new SHAs; the PR's original commits O2a..c are not on main
 *   FF4b  08-01 13:01  \ PR 4 fast-forwarded: its own commits land unchanged
 *   FF4a  08-01 13:00  /
 *   S1    08-01 12:00  squash of PR 1 (150 bot review comments: pagination)
 *   D1    08-01 08:00  direct push by a bot account
 *   S12   08-01 00:00:01 squash of PR 12, merged 00:00:02 but updated 23:59:58 the day before
 *   B0    07-31 23:00  before the window
 * Also: PR 6 merged into `release` in the window (excluded), PR 8 merged before it.
 */
export type Strategy = "merge" | "squash" | "squash+merge" | "rebase" | "fast-forward";

export interface ScUser {
  login: string;
  bot: boolean;
}

export interface ScCommit {
  oid: string;
  /** Committer date (ISO UTC). */
  date: string;
  /** Author date; differs from `date` for rebased commits. */
  authorDate: string;
  parents: string[];
  author: { name: string; email: string; user: ScUser | null };
  additions: number;
  deletions: number;
  subject: string;
}

export type ScEventKind = "approve" | "unapprove" | "request_changes" | "comment" | "reset_by_push";
export interface ScEvent {
  user: ScUser;
  kind: ScEventKind;
  at: string;
}

export interface ScPr {
  number: number;
  base: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  strategy: Strategy;
  /** Merge commit on the base branch (merge, squash+merge), else null. */
  mergeCommit: string | null;
  /** Squash commit (squash, squash+merge), else null. */
  squashCommit: string | null;
  /** Source branch head at merge time (after any rebase the SCM did itself). */
  head: string;
  /** Commits that landed on the base branch, oldest first (what the change brought in). */
  landed: string[];
  /** Commits the PR itself lists, oldest first (differs from `landed` for squash and for a rebase that rewrote SHAs). */
  listed: string[];
  author: ScUser;
  mergedBy: ScUser | null;
  events: ScEvent[];
  additions: number;
  deletions: number;
  labels: string[];
  title: string;
}

export const U = (login: string): ScUser => ({ login, bot: false });
export const BOT = (login: string): ScUser => ({ login, bot: true });
export const OID = (tag: string) => Buffer.from(tag).toString("hex").repeat(40).slice(0, 40);

const users = {
  alice: U("alice"),
  bob: U("bob"),
  carol: U("carol"),
  dave: U("dave"),
  erin: U("erin"),
  maint: U("maint"),
  agent: BOT("agent-bot"),
  reviewer: BOT("review-bot"),
  merger: BOT("merge-bot"),
  pusher: BOT("deploy-bot"),
};

export function scmScenario() {
  const ev = (user: ScUser, kind: ScEventKind, at: string): ScEvent => ({ user, kind, at: `2026-08-01T${at}Z` });
  const dev = { name: "Dev", email: "dev@example.com", user: U("dev") };
  const c = (tag: string, date: string, parents: string[], extra: Partial<ScCommit> = {}): ScCommit => ({
    oid: OID(tag),
    date,
    authorDate: date,
    parents: parents.map(OID),
    author: dev,
    additions: 10,
    deletions: 2,
    subject: `commit ${tag}`,
    ...extra,
  });
  const rebased = (tag: string, date: string, parents: string[], orig: string) => c(tag, date, parents, { authorDate: "2026-07-30T10:00:00Z", subject: `work ${orig}`, author: { name: "Bob", email: "bob@example.com", user: users.bob } });
  const commits: ScCommit[] = [
    c("L10", "2026-08-02T10:00:00Z", ["P9b"]),
    c("P9b", "2026-08-01T23:30:00Z", ["P9a"]),
    c("P9a", "2026-08-01T23:00:00Z", ["M11"]),
    c("M11", "2026-08-01T21:00:05Z", ["D2", "S11"], { additions: 4, deletions: 0 }),
    c("S11", "2026-08-01T21:00:00Z", ["D2"], { additions: 4, deletions: 0 }),
    c("D2", "2026-08-01T20:00:00Z", ["M3"], { author: { name: "Alice", email: "alice@example.com", user: users.alice }, additions: 5, deletions: 2 }),
    c("M3", "2026-08-01T18:00:00Z", ["S5", "F3b"], { additions: 40, deletions: 2 }),
    c("F3b", "2026-08-01T09:00:00Z", ["F3a"]),
    c("F3a", "2026-07-31T12:00:00Z", ["B0"]),
    c("S5", "2026-08-01T16:00:00Z", ["R2c"], { additions: 5, deletions: 5 }),
    rebased("R2c", "2026-08-01T15:00:03Z", ["R2b"], "c"),
    rebased("R2b", "2026-08-01T15:00:02Z", ["R2a"], "b"),
    rebased("R2a", "2026-08-01T15:00:01Z", ["FF4b"], "a"),
    c("FF4b", "2026-08-01T13:01:00Z", ["FF4a"], { author: { name: "agent-bot", email: "agent-bot@bots.example.com", user: users.agent } }),
    c("FF4a", "2026-08-01T13:00:00Z", ["S1"], { author: { name: "agent-bot", email: "agent-bot@bots.example.com", user: users.agent } }),
    c("S1", "2026-08-01T12:00:00Z", ["D1"], { additions: 150, deletions: 50 }),
    c("D1", "2026-08-01T08:00:00Z", ["S12"], { author: { name: "deploy-bot", email: "deploy-bot@bots.example.com", user: users.pusher }, additions: 3, deletions: 0 }),
    c("S12", "2026-08-01T00:00:01Z", ["B0"], { additions: 1, deletions: 1 }),
    c("B0", "2026-07-31T23:00:00Z", []),
    // Not on main:
    rebased("O2a", "2026-07-30T10:00:00Z", ["B0"], "a"),
    rebased("O2b", "2026-07-30T10:00:00Z", ["O2a"], "b"),
    rebased("O2c", "2026-07-30T10:00:00Z", ["O2b"], "c"),
    c("H1", "2026-08-01T11:00:00Z", ["D1"]),
    c("H5", "2026-08-01T15:30:00Z", ["R2c"]),
    c("H10", "2026-08-02T09:30:00Z", ["P9b"]),
    c("H11", "2026-08-01T20:30:00Z", ["D2"]),
    c("H12", "2026-07-31T23:30:00Z", ["B0"]),
    c("R6", "2026-08-01T14:00:00Z", ["B0"]),
    c("H8", "2026-07-31T22:00:00Z", []),
  ];
  const pr = (p: Partial<ScPr> & Pick<ScPr, "number" | "strategy" | "mergedAt" | "updatedAt">): ScPr => ({
    base: "main",
    createdAt: "2026-07-30T08:00:00Z",
    mergeCommit: null,
    squashCommit: null,
    head: p.landed?.[p.landed.length - 1] ?? OID(`H${p.number}`),
    landed: [],
    listed: [],
    author: users.bob,
    mergedBy: users.maint,
    events: [],
    additions: 10,
    deletions: 2,
    labels: [],
    title: `PR ${p.number}`,
    ...p,
  });
  const many = Array.from({ length: 150 }, (_, i) => ev(users.reviewer, "comment", `11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`));
  const prs: ScPr[] = [
    pr({ number: 10, strategy: "squash", mergedAt: "2026-08-02T10:00:05Z", updatedAt: "2026-08-02T10:00:09Z", squashCommit: OID("L10"), head: OID("H10"), landed: [OID("L10")], listed: [OID("H10")], author: users.agent }),
    pr({ number: 9, strategy: "fast-forward", mergedAt: "2026-08-02T09:00:00Z", updatedAt: "2026-08-02T09:00:04Z", landed: [OID("P9a"), OID("P9b")], listed: [OID("P9a"), OID("P9b")] }),
    pr({
      number: 11,
      strategy: "squash+merge",
      mergedAt: "2026-08-01T21:00:06Z",
      updatedAt: "2026-08-01T21:00:08Z",
      mergeCommit: OID("M11"),
      squashCommit: OID("S11"),
      head: OID("H11"),
      landed: [OID("S11"), OID("M11")],
      listed: [OID("H11")],
      events: [ev(users.carol, "approve", "19:00:00"), ev(users.carol, "reset_by_push", "20:30:00"), ev(users.reviewer, "approve", "20:45:00")],
      additions: 4,
      deletions: 0,
    }),
    pr({ number: 3, strategy: "merge", mergedAt: "2026-08-01T18:00:01Z", updatedAt: "2026-08-01T18:00:09Z", mergeCommit: OID("M3"), head: OID("F3b"), landed: [OID("F3a"), OID("F3b"), OID("M3")], listed: [OID("F3a"), OID("F3b")], events: [ev(users.carol, "approve", "17:00:00")], additions: 40, deletions: 2 }),
    pr({ number: 5, strategy: "squash", mergedAt: "2026-08-01T16:00:01Z", updatedAt: "2026-08-01T16:00:02Z", squashCommit: OID("S5"), head: OID("H5"), landed: [OID("S5")], listed: [OID("H5")], additions: 5, deletions: 5 }),
    pr({
      number: 2,
      strategy: "rebase",
      mergedAt: "2026-08-01T15:00:04Z",
      updatedAt: "2026-08-01T15:00:06Z",
      head: OID("R2c"),
      landed: [OID("R2a"), OID("R2b"), OID("R2c")],
      listed: [OID("O2a"), OID("O2b"), OID("O2c")],
      mergedBy: users.merger,
      events: [ev(users.dave, "request_changes", "09:00:00"), ev(users.erin, "approve", "10:00:00"), ev(users.erin, "unapprove", "11:00:00")],
      additions: 30,
      deletions: 3,
    }),
    pr({ number: 6, base: "release", strategy: "squash", mergedAt: "2026-08-01T14:00:00Z", updatedAt: "2026-08-01T14:00:01Z", squashCommit: OID("R6"), head: OID("R6"), landed: [OID("R6")], listed: [OID("R6")] }),
    pr({ number: 4, strategy: "fast-forward", mergedAt: "2026-08-01T13:01:30Z", updatedAt: "2026-08-01T13:01:40Z", landed: [OID("FF4a"), OID("FF4b")], listed: [OID("FF4a"), OID("FF4b")], author: users.agent, events: [ev(users.reviewer, "approve", "12:30:00")], additions: 20, deletions: 4 }),
    pr({ number: 1, strategy: "squash", mergedAt: "2026-08-01T12:00:01Z", updatedAt: "2026-08-01T12:30:00Z", squashCommit: OID("S1"), head: OID("H1"), landed: [OID("S1")], listed: [OID("H1")], author: users.agent, events: many, additions: 150, deletions: 50, labels: ["agent"] }),
    pr({ number: 12, strategy: "squash", mergedAt: "2026-08-01T00:00:02Z", updatedAt: "2026-07-31T23:59:58Z", squashCommit: OID("S12"), head: OID("H12"), landed: [OID("S12")], listed: [OID("H12")], author: users.agent, additions: 1, deletions: 1 }),
    pr({ number: 8, strategy: "squash", mergedAt: "2026-07-31T22:00:05Z", updatedAt: "2026-07-31T22:00:10Z", squashCommit: OID("B0"), head: OID("H8"), landed: [OID("B0")], listed: [OID("H8")] }),
  ];
  const byOid = new Map(commits.map((x) => [x.oid, x]));
  return {
    repo: "acme/widgets",
    defaultBranch: "main",
    head: OID("L10"),
    window: { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" },
    commits,
    byOid,
    prs,
    users,
    /** Commits reachable from `from` (all parents), newest committer date first, as `git log` lists them. */
    reachable(from: string): ScCommit[] {
      const out: ScCommit[] = [];
      const seen = new Set<string>();
      const stack = [from];
      while (stack.length) {
        const o = stack.pop()!;
        const x = byOid.get(o);
        if (!x || seen.has(o)) continue;
        seen.add(o);
        out.push(x);
        stack.push(...x.parents);
      }
      return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.oid < b.oid ? -1 : 1));
    },
  };
}
export type ScmScenario = ReturnType<typeof scmScenario>;

/** What every provider must make of the scenario (ids built with the provider's own scheme). */
export function scenarioExpectations(scheme: string, repo = "acme/widgets") {
  const p = (n: number) => `${scheme}:${repo}#${n}`;
  const d = (tag: string) => `${scheme}:${repo}@${OID(tag)}`;
  const ids = { squash: p(1), rebase: p(2), merge: p(3), ff: p(4), squash5: p(5), squashMerge: p(11), atOpen: p(12), alice: d("D2"), bot: d("D1") };
  return {
    ids,
    pullRequests: [ids.squash, ids.rebase, ids.merge, ids.ff, ids.squash5, ids.squashMerge, ids.atOpen],
    directPushes: [ids.alice, ids.bot],
    all: Object.values(ids),
    prCommits: {
      [ids.rebase]: [OID("R2a"), OID("R2b"), OID("R2c")],
      [ids.merge]: [OID("M3"), OID("F3b")],
      [ids.ff]: [OID("FF4a"), OID("FF4b")],
      [ids.squashMerge]: [OID("M11"), OID("S11")],
      [ids.squash]: [OID("S1")],
    },
    mergeShas: { [ids.squash]: OID("S1"), [ids.rebase]: OID("R2c"), [ids.merge]: OID("M3"), [ids.ff]: OID("FF4b"), [ids.squash5]: OID("S5"), [ids.squashMerge]: OID("M11"), [ids.atOpen]: OID("S12"), [ids.alice]: OID("D2"), [ids.bot]: OID("D1") },
    changedLines: { [ids.squash]: 200, [ids.merge]: 42, [ids.alice]: 7, [ids.bot]: 3 },
    /** Commits on main dated in the window: 14 brought in by PRs (2 of them by PR 9, merged after the window) + 2 direct pushes. */
    inWindowCommits: 16,
  };
}
