import { describe, expect, it } from "vitest";
import { applySelector, normalizeSelector } from "../src/core/selector.js";
import github, { GitHubProvider } from "../src/providers/github/index.js";
import { classifyFirstParent, type HistoryNode } from "../src/providers/github/history.js";
import { normalizeActor, normalizeCommitAuthor, normalizeReviews } from "../src/providers/github/normalize.js";
import { prBatchQuery } from "../src/providers/github/queries.js";
import type { ProviderContext } from "../src/sdk/provider.js";
import { runProviderConformance, formatConformanceReport, type ConformanceFixture } from "../src/testing/index.js";
import { classificationScenario, fakeGitHub, OID } from "./helpers/fake-github.js";
import { readJsonFixture } from "./helpers/fixtures.js";
import { replayFetch, type Recording } from "./helpers/replay-fetch.js";

type RecordedFixture = Recording & {
  options: Record<string, number>;
  window: { opensAt: string; closesAt: string };
  repo: string;
  expected: { ids: string[]; pullRequests: number; directPushes: string[]; nativeCounts: { label: string; value: number }[] };
};

const rec = readJsonFixture<RecordedFixture>("github", "gh-aw-2026-11-02.json");
const ctx = (f: typeof fetch): ProviderContext & { now: () => number } => ({ cwd: ".", env: {}, log: () => {}, fetch: f, now: () => Date.parse(rec.recordedAt) });
const recordedProvider = (f = replayFetch(rec)) => new GitHubProvider(rec.options as never, ctx(f));

describe("GitHub provider on recorded gh-aw responses (2026-11-02, real data)", () => {
  it("passes the provider conformance kit (pagination over 4 REST pages, 4 GraphQL PR batches, 3 history pages)", async () => {
    let last = replayFetch(rec);
    const fixture: ConformanceFixture = {
      name: "gh-aw 2026-11-02",
      request: { repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] },
      expect: {
        ids: rec.expected.ids,
        directPushes: [],
        minPages: 10,
        reviewStates: { "github:github/gh-aw#74201": ["COMMENTED", "COMMENTED", "DISMISSED", "COMMENTED", "APPROVED"] },
        actors: { "github:github/gh-aw#74201": { author: { login: "copilot-swe-agent[bot]", kind: "bot" }, mergedBy: { login: "SivaKesava1", kind: "human" } } },
      },
      pagesServed: () => last.served(),
    };
    const report = await runProviderConformance(() => recordedProvider((last = replayFetch(rec))), [fixture]);
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });

  it("normalizes 38 merged PRs into main; the PR into another branch is excluded", async () => {
    const r = await recordedProvider().listChanges({ repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] });
    expect(r.changes).toHaveLength(38);
    expect(r.defaultBranch).toBe("main");
    expect(r.diagnostics).toContainEqual({ label: "PRs merged into other branches in window (excluded)", value: 1 });
    expect(r.limitations.join(" ")).toMatch(/commit author != pusher/);
  });

  it("PR #73884: its merge commit has no associatedPullRequests on GitHub, and is still not a direct push", async () => {
    const r = await recordedProvider().listChanges({ repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] });
    const pr = r.changes.find((c) => c.id === "github:github/gh-aw#73884")!;
    expect(pr.kind).toBe("pull_request");
    expect(r.changes.filter((c) => c.mergeSha === pr.mergeSha)).toHaveLength(1);
    expect(r.changes.some((c) => c.kind === "direct_push")).toBe(false);
  });

  it("matches GitHub search for Copilot PRs that day: 10 merged; 9 with no human approval/change request", async () => {
    const r = await recordedProvider().listChanges({ repo: rec.repo, window: rec.window, kinds: ["pull_request"] });
    const sel = normalizeSelector({ kinds: ["pull_request"], authors: ["copilot-swe-agent[bot]"], unreviewed: "no-human-review" });
    const s = applySelector(r.changes, sel, rec.recordedAt);
    expect(s.funnel.map((x) => x.count)).toEqual([38, 38, 10, 9]);
    expect(s.selected.map((c) => c.id)).not.toContain("github:github/gh-aw#74201"); // human APPROVED
    expect(s.selected.map((c) => c.id)).toContain("github:github/gh-aw#74166"); // only a bot APPROVED
    expect(s.mergedByBreakdown).toEqual({ human: 9, bot: 0, unknown: 0 });
    const native = await recordedProvider().nativeCounts!({ repo: rec.repo, window: rec.window, kinds: ["pull_request"] }, { authors: ["copilot-swe-agent[bot]"] });
    expect(native.map((n) => n.value)).toEqual([10, 9]);
  });
});

describe("GitHub provider on a synthetic graph: squash, merge commit, rebase merge, direct pushes", () => {
  const sc = classificationScenario();
  const make = () => {
    const fake = fakeGitHub(sc.repo, sc.head, sc.commits, sc.prs, { pageSize: 2 });
    return { fake, provider: new GitHubProvider({ page_size: 2, batch_size: 3, history_page_size: 2 }, { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch, now: () => Date.parse("2026-08-03T00:00:00Z") }) };
  };
  const ids = {
    squash: `github:${sc.repo}#1`,
    rebase: `github:${sc.repo}#2`,
    merge: `github:${sc.repo}#3`,
    unlinked: `github:${sc.repo}#5`,
    alice: `github:${sc.repo}@${OID("D2")}`,
    bot: `github:${sc.repo}@${OID("D1")}`,
  };

  it("classifies every case and passes the conformance kit", async () => {
    let last = make();
    const report = await runProviderConformance(
      () => (last = make()).provider,
      [
        {
          name: "synthetic acme/widgets 2026-08-01",
          request: { repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] },
          expect: {
            ids: Object.values(ids),
            pullRequests: [ids.squash, ids.rebase, ids.merge, ids.unlinked],
            directPushes: [ids.alice, ids.bot],
            reviewStates: { [ids.rebase]: ["CHANGES_REQUESTED", "DISMISSED"], [ids.merge]: ["APPROVED"] },
            actors: {
              [ids.rebase]: { author: { login: "copilot-swe-agent[bot]", kind: "bot" }, mergedBy: { login: "github-merge-queue[bot]", kind: "bot" } },
              [ids.alice]: { author: { login: "alice", kind: "human" }, mergedBy: null },
              [ids.bot]: { author: { login: "github-actions[bot]", kind: "bot" }, mergedBy: null },
            },
            changedLines: { [ids.squash]: 200, [ids.alice]: 7 },
            minPages: 12,
          },
          pagesServed: () => last.fake.served(),
        },
      ],
    );
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });

  it("follows review pagination past 100 (PR #1 has 150 reviews)", async () => {
    const r = await make().provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request"] });
    expect(r.changes.find((c) => c.id === ids.squash)!.reviews).toHaveLength(150);
  });

  it("a rebase merge's three commits map to one PR; a merge commit's PR commits are never walked", async () => {
    const r = await make().provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["direct_push"] });
    expect(r.changes.map((c) => c.id).sort()).toEqual([ids.alice, ids.bot].sort());
    expect(r.diagnostics).toContainEqual({ label: "first-parent commits walked in window", value: 8 });
    expect(r.diagnostics).toContainEqual({ label: "first-parent commits linked to a merged PR", value: 6 });
  });
});

describe("first-parent classifier (pure)", () => {
  const W = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };
  const n = (oid: string, date: string, parents: string[], prs: HistoryNode["associatedPullRequests"] = []): HistoryNode => ({ oid, committedDate: `2026-08-01T${date}:00Z`, parents, associatedPullRequests: prs });
  const merged = (number: number, baseRefName = "main") => ({ number, merged: true, baseRefName });

  it("squash merge: one commit, one PR", () => {
    const r = classifyFirstParent([n("s", "10:00", ["x"], [merged(1)])], "s", W, "main");
    expect([...r.prCommits]).toEqual([[1, ["s"]]]);
    expect(r.directPushes).toEqual([]);
  });

  it("merge commit: the PR's branch commits on parent 2 are not counted", () => {
    const r = classifyFirstParent([n("m", "10:00", ["base", "f2"], [merged(2)]), n("f2", "09:00", ["f1"], [merged(2)]), n("f1", "08:00", ["base"], [merged(2)]), n("base", "07:00", [])], "m", W, "main");
    expect([...r.prCommits]).toEqual([[2, ["m"]]]);
    expect(r.directPushes).toEqual(["base"]);
  });

  it("rebase merge: every rebased commit maps to the same PR", () => {
    const r = classifyFirstParent([n("r3", "10:03", ["r2"], [merged(3)]), n("r2", "10:02", ["r1"], [merged(3)]), n("r1", "10:01", [], [merged(3)])], "r3", W, "main");
    expect([...r.prCommits]).toEqual([[3, ["r3", "r2", "r1"]]]);
    expect(r.directPushes).toEqual([]);
  });

  it("direct push: no merged PR into the default branch (open PRs and other bases do not count)", () => {
    const r = classifyFirstParent([n("a", "10:00", ["b"], [{ number: 4, merged: false, baseRefName: "main" }]), n("b", "09:00", [], [merged(5, "release")])], "a", W, "main");
    expect(r.directPushes).toEqual(["a", "b"]);
  });

  it("merge-commit-sha fallback when GitHub has no association", () => {
    const r = classifyFirstParent([n("s", "10:00", [])], "s", W, "main", new Map([["s", 9]]));
    expect([...r.prCommits]).toEqual([[9, ["s"]]]);
    expect(r.directPushes).toEqual([]);
  });

  it("stops before the window and skips commits after it", () => {
    const r = classifyFirstParent(
      [{ oid: "late", committedDate: "2026-08-02T01:00:00Z", parents: ["in"], associatedPullRequests: [] }, n("in", "05:00", ["old"]), { oid: "old", committedDate: "2026-07-31T23:00:00Z", parents: [], associatedPullRequests: [] }],
      "late",
      W,
      "main",
    );
    expect(r.directPushes).toEqual(["in"]);
    expect(r.stop).toBe("before-window");
  });
});

describe("GitHub normalizers (pure)", () => {
  it("bots get the [bot] suffix; deleted accounts are ghost (human)", () => {
    expect(normalizeActor({ __typename: "Bot", login: "copilot-swe-agent" })).toEqual({ login: "copilot-swe-agent[bot]", kind: "bot" });
    expect(normalizeActor({ __typename: "User", login: "dependabot[bot]" })).toEqual({ login: "dependabot[bot]", kind: "bot" });
    expect(normalizeActor({ __typename: "User", login: "pelikhan" })).toEqual({ login: "pelikhan", kind: "human" });
    expect(normalizeActor(null)).toEqual({ login: "ghost", kind: "human" });
  });

  it("review states map one to one; PENDING is dropped; sorted by time", () => {
    const r = normalizeReviews([
      { state: "APPROVED", submittedAt: "2026-08-01T10:00:05Z", author: { __typename: "User", login: "a" } },
      { state: "PENDING", submittedAt: null, author: { __typename: "User", login: "b" } },
      { state: "COMMENTED", submittedAt: "2026-08-01T09:00:00.000Z", author: { __typename: "Bot", login: "copilot-pull-request-reviewer" } },
      { state: "DISMISSED", submittedAt: "2026-08-01T11:00:00Z", author: null },
      { state: "CHANGES_REQUESTED", submittedAt: "2026-08-01T12:00:00Z", author: { __typename: "User", login: "c" } },
    ]);
    expect(r.map((x) => x.state)).toEqual(["COMMENTED", "APPROVED", "DISMISSED", "CHANGES_REQUESTED"]);
    expect(r[0]).toEqual({ author: { login: "copilot-pull-request-reviewer[bot]", kind: "bot" }, state: "COMMENTED", submittedAt: "2026-08-01T09:00:00Z" });
  });

  it("commit authors without a linked account", () => {
    const base = { oid: "a".repeat(40), url: "", committedDate: "2026-08-01T00:00:00Z", additions: 0, deletions: 0, parents: { nodes: [] }, associatedPullRequests: { nodes: [] } };
    expect(normalizeCommitAuthor({ ...base, author: { name: "github-actions[bot]", email: "x", user: null } })).toEqual({ login: "github-actions[bot]", kind: "bot" });
    expect(normalizeCommitAuthor({ ...base, author: { name: "Jo", email: "jo@example.com", user: null } })).toEqual({ login: "git:jo@example.com", kind: "human" });
  });

  it("GraphQL PR batches use aliases, 40 per query by default", () => {
    expect(prBatchQuery([1, 2]).match(/pullRequest\(number:/g)).toHaveLength(2);
    expect(github.providerApiVersion).toBe(1);
  });
});
