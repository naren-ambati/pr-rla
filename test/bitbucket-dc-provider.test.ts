import { describe, expect, it } from "vitest";
import bitbucketDc, { BitbucketDataCenterProvider } from "../src/providers/bitbucket-data-center/index.js";
import { buildReviews, countDiff, normalizeCommitAuthor, normalizeUser } from "../src/providers/bitbucket-data-center/normalize.js";
import { loadProviderDefinition } from "../src/registry.js";
import { formatConformanceReport, runProviderConformance, type ConformanceFixture, type ConformanceHarness } from "../src/testing/index.js";
import { DC_BASE, fakeBitbucketDc } from "./helpers/fake-bitbucket-dc.js";
import { OID, scenarioExpectations, scmScenario } from "./helpers/scm-scenario.js";

const bot = (login: string) => ({ login: `${login}[bot]`, kind: "bot" as const });
const human = (login: string) => ({ login, kind: "human" as const });

describe("Bitbucket Data Center provider on a fake server built from the documented shapes (unverified against a live server)", () => {
  const sc = scmScenario();
  const late = scmScenario({ latePush: true });
  const repo = "ACME/widgets";
  const x = scenarioExpectations("bitbucket-data-center", repo);
  const make = (h?: ConformanceHarness, s = sc) => {
    const fake = fakeBitbucketDc(s, { limit: 3 });
    const base = { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch };
    return { fake, provider: new BitbucketDataCenterProvider({ base_url: DC_BASE, page_size: 3 }, h ? h.context(base) : base) };
  };

  it("passes the conformance kit: squash, merge commit, rebase (original commits listed), fast-forward, direct pushes", async () => {
    let last = make();
    const base: ConformanceFixture = {
          name: "synthetic bitbucket-data-center ACME/widgets 2026-08-01",
          request: { repo, window: sc.window, kinds: ["pull_request", "direct_push"] },
          expect: {
            ids: x.all,
            pullRequests: x.pullRequests,
            directPushes: x.directPushes,
            prCommits: x.prCommits,
            mergeShas: x.mergeShas,
            changedLines: x.changedLines,
            reviewStates: {
              [x.ids.squash]: ["COMMENTED"],
              [x.ids.rebase]: ["CHANGES_REQUESTED", "DISMISSED"],
              [x.ids.merge]: ["APPROVED"],
              [x.ids.ff]: ["APPROVED"],
              [x.ids.squash5]: [],
              [x.ids.squashMerge]: ["DISMISSED", "APPROVED"],
              [x.ids.atOpen]: [],
            },
            reviewers: { [x.ids.rebase]: [human("dave"), human("erin")], [x.ids.ff]: [bot("review-bot")] },
            actors: {
              [x.ids.squash]: { author: bot("agent-bot"), mergedBy: human("maint") },
              [x.ids.rebase]: { author: human("bob"), mergedBy: bot("merge-bot") },
              [x.ids.alice]: { author: human("alice"), mergedBy: null },
              [x.ids.bot]: { author: bot("deploy-bot"), mergedBy: null },
            },
            bots: ["agent-bot[bot]", "review-bot[bot]", "merge-bot[bot]", "deploy-bot[bot]"],
            humans: ["maint", "bob", "dave", "erin", "carol", "alice"],
            minPages: 25,
            reviewGranularity: "first-comment-per-user",
            revokedApprovals: x.revokedApprovals,
          },
          pagesServed: () => last.fake.served(),
          http: true,
          rateLimitFault: { status: 429, headers: () => ({ "retry-after": "30" }), minWaitMs: 30_000 },
        };
    const pushedLater: ConformanceFixture = { ...base, name: "synthetic bitbucket-data-center, a merge pushed after freeze", expect: { ...base.expect, ids: [...x.all, x.late.id], directPushes: [...x.directPushes, x.late.id] }, pinnedHead: { head: sc.frozenHead, late: [x.late.sha] } };
    const report = await runProviderConformance((f, h) => (last = make(h, f.pinnedHead ? late : sc)).provider, [base, pushedLater], { definition: bitbucketDc });
    expect(report.ok, formatConformanceReport(report)).toBe(true);
    expect(report.results.filter((r) => r.skipped)).toEqual([]);
  });

  it("falls back to /branches/default, reads the merge commit from the MERGED activity, flags a truncated diff", async () => {
    const r = await make().provider.listChanges({ repo, window: sc.window, kinds: ["pull_request", "direct_push"] });
    expect(r.defaultBranch).toBe("main");
    expect(r.changes.find((c) => c.id === x.ids.merge)!.mergeSha).toBe(OID("M3")); // no properties.mergeCommit on PR #3
    expect(r.diagnostics).toEqual([
      { label: "PR diffs truncated by the server (changedLines undercounted)", value: 1 },
      { label: "default-branch commits in window", value: x.inWindowCommits },
      { label: "commits linked to a merged PR", value: 14 },
      { label: "rebased commits linked by author, author time and message", value: 2 },
      { label: "direct pushes that are merge commits", value: 0 },
    ]);
    expect(r.limitations[0]).toMatch(/UNVERIFIED against a live server/);
  });

  it("walks from request.head (FR7.2); user ids are Actor.id (FR7.3)", async () => {
    const late = scmScenario({ latePush: true });
    const p = new BitbucketDataCenterProvider({ base_url: DC_BASE, page_size: 3 }, { cwd: ".", env: {}, log: () => {}, fetch: fakeBitbucketDc(late, { limit: 3 }).fetch });
    const now = await p.listChanges({ repo, window: late.window, kinds: ["direct_push"] });
    expect(now.headSha).toBe(OID("LM"));
    expect(now.changes.map((c) => c.id)).toContain(x.late.id);
    const frozen = await p.listChanges({ repo, window: late.window, kinds: ["pull_request", "direct_push"], head: late.frozenHead });
    expect(frozen.headSha).toBe(late.frozenHead);
    expect(frozen.changes.map((c) => c.id).sort()).toEqual([...x.all].sort());
    const rebase = frozen.changes.find((c) => c.id === x.ids.rebase)!;
    expect([rebase.author, rebase.mergedBy, ...rebase.reviews.map((r) => r.author)].every((a) => a && /^\d+$/.test(a.id ?? ""))).toBe(true);
  });

  it("requires base_url and is registered under its name and the bitbucket-server alias", async () => {
    expect(() => new BitbucketDataCenterProvider({} as never, { cwd: ".", env: {}, log: () => {}, fetch })).toThrow(/needs options.base_url/);
    expect((await loadProviderDefinition("bitbucket-data-center", ".")).name).toBe("bitbucket-data-center");
    expect((await loadProviderDefinition("bitbucket-server", ".")).name).toBe("bitbucket-data-center");
  });
});

describe("Bitbucket Data Center normalizers (pure)", () => {
  it("SERVICE users are bots; unmatched commit authors are git identities", () => {
    expect(normalizeUser({ slug: "ci-token", type: "SERVICE" })).toEqual(bot("ci-token"));
    expect(normalizeUser({ slug: "jdoe", name: "jdoe", type: "NORMAL" })).toEqual(human("jdoe"));
    expect(normalizeCommitAuthor({ author: { name: "J Doe", emailAddress: "jdoe@example.com" } })).toEqual(human("git:jdoe@example.com"));
  });

  it("reviews: APPROVED then UNAPPROVED is DISMISSED; REVIEWED (needs work) is CHANGES_REQUESTED; finals fill gaps", () => {
    const u = (slug: string) => ({ slug, type: "NORMAL" });
    const t = (h: number) => Date.parse(`2026-08-01T0${h}:00:00Z`);
    const r = buildReviews({
      author: u("author"),
      activities: [
        { createdDate: t(5), user: u("a"), action: "UNAPPROVED" },
        { createdDate: t(4), user: u("a"), action: "APPROVED" },
        { createdDate: t(3), user: u("b"), action: "REVIEWED" },
        { createdDate: t(2), user: u("author"), action: "COMMENTED", commentAction: "ADDED" },
        { createdDate: t(1), user: u("c"), action: "COMMENTED", commentAction: "ADDED" },
      ],
      finals: [{ user: u("d"), status: "APPROVED" }, { user: u("b"), status: "NEEDS_WORK" }],
      mergedAtMs: t(6),
    });
    expect(r.map((x) => `${x.author.login} ${x.state}`)).toEqual(["c COMMENTED", "b CHANGES_REQUESTED", "a DISMISSED", "d APPROVED"]);
    expect(countDiff({ diffs: [{ hunks: [{ segments: [{ type: "ADDED", lines: [1, 2] }, { type: "CONTEXT", lines: [1] }, { type: "REMOVED", lines: [1] }] }] }] })).toEqual({ lines: 3, truncated: false });
  });
});
