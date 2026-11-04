import { describe, expect, it } from "vitest";
import { applySelector, normalizeSelector } from "../src/core/selector.js";
import github, { GitHubProvider, githubEndpoints } from "../src/providers/github/index.js";
import { classifyHistory, type HistoryNode } from "../src/providers/github/history.js";
import { normalizeActor, normalizeCommitAuthor, normalizeReviews } from "../src/providers/github/normalize.js";
import { prBatchQuery } from "../src/providers/github/queries.js";
import type { ProviderContext } from "../src/sdk/provider.js";
import { runProviderConformance, formatConformanceReport, type ConformanceFixture, type ConformanceHarness } from "../src/testing/index.js";
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
const ctx = (f: typeof fetch, h?: ConformanceHarness): ProviderContext & { now: () => number } => ({ ...(h ? h.context({ fetch: f }) : { cwd: ".", env: {}, log: () => {}, fetch: f }), now: () => Date.parse(rec.recordedAt) });
const recordedProvider = (f = replayFetch(rec), h?: ConformanceHarness) => new GitHubProvider(rec.options as never, ctx(f, h));
/** GitHub's primary rate limit: 403 with x-ratelimit-remaining: 0 and a reset time (epoch seconds). */
const GITHUB_RATE_LIMIT = { status: 403, headers: (now: number) => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now + 30) }), minWaitMs: 29_000 };

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
        bots: ["copilot-swe-agent[bot]"],
        humans: ["SivaKesava1", "pelikhan"],
        prCommits: { "github:github/gh-aw#73884": ["a1f805b04e2ff9328a8a578fab5f8ab0b7b7fcaf"] },
        mergeShas: { "github:github/gh-aw#73884": "a1f805b04e2ff9328a8a578fab5f8ab0b7b7fcaf" },
      },
      pagesServed: () => last.served(),
      http: true,
      rateLimitFault: GITHUB_RATE_LIMIT,
    };
    const report = await runProviderConformance((_f, h) => recordedProvider((last = replayFetch(rec)), h), [fixture]);
    expect(report.ok, formatConformanceReport(report)).toBe(true);
    expect(report.results.filter((r) => r.skipped)).toEqual([]);
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
  const make = (h?: ConformanceHarness) => {
    const fake = fakeGitHub(sc.repo, sc.head, sc.commits, sc.prs, { pageSize: 2 });
    const base = { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch };
    return { fake, provider: new GitHubProvider({ page_size: 2, batch_size: 3, history_page_size: 2 }, { ...(h ? h.context(base) : base), now: () => Date.parse("2026-08-03T00:00:00Z") }) };
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
      (_f, h) => (last = make(h)).provider,
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
            reviewers: { [ids.rebase]: [{ login: "dave", kind: "human" }, { login: "erin", kind: "human" }], [ids.squash]: Array.from({ length: 150 }, () => ({ login: "copilot-pull-request-reviewer[bot]", kind: "bot" as const })) },
            prCommits: { [ids.rebase]: [OID("R2a"), OID("R2b"), OID("R2c")], [ids.merge]: [OID("M3"), OID("F3b")], [ids.squash]: [OID("S1")], [ids.unlinked]: [OID("S5")] },
            mergeShas: { [ids.rebase]: OID("R2c"), [ids.merge]: OID("M3"), [ids.squash]: OID("S1"), [ids.alice]: OID("D2") },
            bots: ["copilot-swe-agent[bot]", "github-merge-queue[bot]", "github-actions[bot]", "copilot-pull-request-reviewer[bot]"],
            humans: ["alice", "maint", "dave", "carol"],
          },
          pagesServed: () => last.fake.served(),
          http: true,
          rateLimitFault: GITHUB_RATE_LIMIT,
        },
      ],
    );
    expect(report.ok, formatConformanceReport(report)).toBe(true);
    expect(report.results.filter((r) => r.skipped)).toEqual([]);
  });

  it("a release branch merged by a push: its commits are direct pushes with landedVia; the merge itself has none (FR7.6)", async () => {
    const c = (tag: string, date: string, parents: string[]) => ({ oid: OID(tag), date: `2026-08-01T${date}:00Z`, parents: parents.map(OID), author: { name: "Rel", email: "rel@example.com", login: "releaser" } });
    const commits = [c("X", "12:00", ["B", "R2"]), c("R2", "11:00", ["R1"]), c("R1", "10:00", ["B"]), c("B", "09:00", [])];
    const fake = fakeGitHub(sc.repo, OID("X"), commits, [], { pageSize: 2 });
    const r = await new GitHubProvider({ page_size: 2, history_page_size: 2 }, { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch, now: () => Date.parse("2026-08-03T00:00:00Z") }).listChanges({ repo: sc.repo, window: sc.window, kinds: ["direct_push"] });
    const via = Object.fromEntries(r.changes.map((x) => [x.mergeSha, x.landedVia ?? null]));
    expect(via).toEqual({ [OID("X")]: null, [OID("R2")]: OID("X"), [OID("R1")]: OID("X"), [OID("B")]: null });
    expect(r.headSha).toBe(OID("X"));
    expect(r.limitations.join(" ")).toMatch(/landedVia names the pushed merge commit/);
  });

  it("walks from request.head: a merge pushed after freeze brings in nothing from the frozen head (FR7.2)", async () => {
    const late = classificationScenario({ latePush: true });
    const fake = fakeGitHub(late.repo, late.head, late.commits, late.prs, { pageSize: 2 });
    const p = new GitHubProvider({ page_size: 2, batch_size: 3, history_page_size: 2 }, { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch, now: () => Date.parse("2026-08-05T00:00:00Z") });
    const lc = `github:${late.repo}@${OID("LC")}`;
    const now = await p.listChanges({ repo: late.repo, window: late.window, kinds: ["direct_push"] });
    expect(now.headSha).toBe(OID("LM"));
    expect(now.changes.map((c) => c.id)).toContain(lc);
    const frozen = await p.listChanges({ repo: late.repo, window: late.window, kinds: ["direct_push"], head: late.frozenHead });
    expect(frozen.headSha).toBe(late.frozenHead);
    expect(frozen.changes.map((c) => c.id).sort()).toEqual([ids.alice, ids.bot].sort());
  });

  it("halves the history page size while GitHub 502s on heavy pages, without losing commits", async () => {
    const fake = fakeGitHub(sc.repo, sc.head, sc.commits, sc.prs, { pageSize: 2, failHistoryAbove: 13 });
    const logs: string[] = [];
    const p = new GitHubProvider({ page_size: 2, batch_size: 3, history_page_size: 50 }, { cwd: ".", env: {}, log: (m) => logs.push(m), fetch: fake.fetch, now: () => Date.parse("2026-08-03T00:00:00Z") });
    (p.http as unknown as { o: { sleep: () => Promise<void> } }).o.sleep = async () => {};
    const r = await p.listChanges({ repo: sc.repo, window: sc.window, kinds: ["direct_push"] });
    expect(r.changes.map((c) => c.id).sort()).toEqual([ids.alice, ids.bot].sort());
    expect(logs.filter((l) => /continuing with/.test(l))).toEqual(["github: history page failed repeatedly; continuing with 25 commits per page", "github: history page failed repeatedly; continuing with 13 commits per page"]);
  });

  it("follows review pagination past 100 (PR #1 has 150 reviews)", async () => {
    const r = await make().provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request"] });
    expect(r.changes.find((c) => c.id === ids.squash)!.reviews).toHaveLength(150);
  });

  it("a rebase merge's three commits map to one PR; a merge-commit PR's branch commits belong to it", async () => {
    const r = await make().provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["direct_push"] });
    expect(r.changes.map((c) => c.id).sort()).toEqual([ids.alice, ids.bot].sort());
    expect(r.diagnostics).toContainEqual({ label: "default-branch commits in window", value: 9 });
    expect(r.diagnostics).toContainEqual({ label: "commits linked to a merged PR", value: 7 });
    expect(r.diagnostics).toContainEqual({ label: "direct pushes that are merge commits", value: 0 });
  });
});

describe("history classifier (pure)", () => {
  const W = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };
  const n = (oid: string, date: string, parents: string[], prs: HistoryNode["associatedPullRequests"] = []): HistoryNode => ({ oid, committedDate: `2026-08-01T${date}:00Z`, parents, associatedPullRequests: prs });
  const merged = (number: number, baseRefName = "main") => ({ number, merged: true, baseRefName });
  const run = (nodes: HistoryNode[], m?: Map<string, number>) => classifyHistory(nodes, W, "main", m);

  it("squash merge: one commit, one PR", () => {
    const r = run([n("s", "10:00", ["x"], [merged(1)])]);
    expect([...r.prCommits]).toEqual([[1, ["s"]]]);
    expect(r.directPushes).toEqual([]);
  });

  it("merge commit: the merge commit and the PR's branch commits all belong to the PR", () => {
    const r = run([n("m", "10:00", ["base", "f2"], [merged(2)]), n("f2", "09:00", ["f1"], [merged(2)]), n("f1", "08:00", ["base"], [merged(2)]), n("base", "07:00", [])]);
    expect([...r.prCommits]).toEqual([[2, ["m", "f2", "f1"]]]);
    expect(r.directPushes).toEqual(["base"]);
  });

  it("rebase merge: every rebased commit maps to the same PR", () => {
    const r = run([n("r3", "10:03", ["r2"], [merged(3)]), n("r2", "10:02", ["r1"], [merged(3)]), n("r1", "10:01", [], [merged(3)])]);
    expect([...r.prCommits]).toEqual([[3, ["r3", "r2", "r1"]]]);
    expect(r.directPushes).toEqual([]);
  });

  it("direct push: no merged PR into the default branch (open PRs and other bases do not count)", () => {
    const r = run([n("a", "10:00", ["b"], [{ number: 4, merged: false, baseRefName: "main" }]), n("b", "09:00", [], [merged(5, "release")])]);
    expect(r.directPushes).toEqual(["a", "b"]);
  });

  it("merge-commit-sha fallback when GitHub has no association", () => {
    const r = run([n("s", "10:00", [])], new Map([["s", 9]]));
    expect([...r.prCommits]).toEqual([[9, ["s"]]]);
    expect(r.directPushes).toEqual([]);
  });

  it("foxtrot merge (a `git pull` merge pushed to main, as on gh-aw): nothing on the real mainline is missed", () => {
    // M = "Merge branch 'main' of …": first parent L is local work, second parent O is the real main.
    const r = run([
      n("M", "12:00", ["L", "O"]),
      n("L", "11:59", ["B"]),
      n("O", "11:00", ["X"], [merged(9)]),
      n("X", "10:00", ["B"]), // someone else's direct push on the mainline: a first-parent walk from M would skip it
      n("B", "09:00", [], [merged(8)]),
    ]);
    expect(r.directPushes).toEqual(["M", "L", "X"]);
    expect(r.directPushMerges).toEqual(["M"]);
    expect([...r.prCommits.keys()].sort()).toEqual([8, 9]);
  });

  it("only commits dated inside the window count", () => {
    const r = run([{ oid: "late", committedDate: "2026-08-02T01:00:00Z", parents: ["in"], associatedPullRequests: [] }, n("in", "05:00", ["old"]), { oid: "old", committedDate: "2026-07-31T23:00:00Z", parents: [], associatedPullRequests: [] }]);
    expect(r.directPushes).toEqual(["in"]);
    expect(r.inWindow).toBe(1);
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

describe("GitHub Enterprise Server (base_url)", () => {
  it("derives REST /api/v3 and GraphQL /api/graphql (not /api/v3/graphql)", () => {
    expect(githubEndpoints({})).toEqual({ apiUrl: "https://api.github.com", graphqlUrl: "https://api.github.com/graphql", enterprise: false });
    expect(githubEndpoints({ base_url: "https://github.com/" })).toEqual({ apiUrl: "https://api.github.com", graphqlUrl: "https://api.github.com/graphql", enterprise: false });
    expect(githubEndpoints({ base_url: "https://ghe.example.com/" })).toEqual({ apiUrl: "https://ghe.example.com/api/v3", graphqlUrl: "https://ghe.example.com/api/graphql", enterprise: true });
    expect(githubEndpoints({ api_url: "https://ghe.example.com/api/v3" })).toEqual({ apiUrl: "https://ghe.example.com/api/v3", graphqlUrl: "https://ghe.example.com/api/graphql", enterprise: true });
    expect(githubEndpoints({ api_url: "https://ghe.example.com/api/v3", graphql_url: "https://gql.example.com/q" }).graphqlUrl).toBe("https://gql.example.com/q");
  });

  it("passes the conformance kit against a fake GHES host", async () => {
    const sc = classificationScenario();
    let fake = fakeGitHub(sc.repo, sc.head, sc.commits, sc.prs, { pageSize: 2, restBase: "https://ghe.example.com/api/v3" });
    const make = (_f: ConformanceFixture, h: ConformanceHarness) => {
      fake = fakeGitHub(sc.repo, sc.head, sc.commits, sc.prs, { pageSize: 2, restBase: "https://ghe.example.com/api/v3" });
      return new GitHubProvider({ base_url: "https://ghe.example.com", page_size: 2, batch_size: 3, history_page_size: 2 }, { ...h.context({ fetch: fake.fetch, env: { GH_ENTERPRISE_TOKEN: "t" } }), now: () => Date.parse("2026-08-03T00:00:00Z") });
    };
    const report = await runProviderConformance(make, [
      {
        name: "synthetic GHES",
        request: { repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] },
        expect: { pullRequests: [1, 2, 3, 5].map((n) => `github:${sc.repo}#${n}`), directPushes: [OID("D2"), OID("D1")].map((o) => `github:${sc.repo}@${o}`), minPages: 12 },
        pagesServed: () => fake.served(),
        http: true,
        rateLimitFault: GITHUB_RATE_LIMIT,
      },
    ]);
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });
});
