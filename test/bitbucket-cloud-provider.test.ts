import { describe, expect, it } from "vitest";
import { BitbucketCloudProvider } from "../src/providers/bitbucket-cloud/index.js";
import { buildReviews, normalizeCommitAuthor, normalizeUser } from "../src/providers/bitbucket-cloud/normalize.js";
import { loadProviderDefinition } from "../src/registry.js";
import { formatConformanceReport, runProviderConformance, type ConformanceHarness } from "../src/testing/index.js";
import { fakeBitbucketCloud } from "./helpers/fake-bitbucket-cloud.js";
import { OID, scenarioExpectations, scmScenario } from "./helpers/scm-scenario.js";

/** Bitbucket Cloud's 429 carries no rate-limit headers at all (seen live), so only backoff applies. */
const bot = (login: string) => ({ login: `${login}[bot]`, kind: "bot" as const });
const human = (login: string) => ({ login, kind: "human" as const });

describe("Bitbucket Cloud provider on a synthetic repository: every merge strategy", () => {
  const sc = scmScenario();
  const x = scenarioExpectations("bitbucket-cloud");
  const make = (h?: ConformanceHarness) => {
    const fake = fakeBitbucketCloud(sc, { pageLen: 3 });
    const base = { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch };
    return { fake, provider: new BitbucketCloudProvider({}, { ...(h ? h.context(base) : base), now: () => Date.parse("2026-08-03T00:00:00Z") }) };
  };

  it("passes the conformance kit: squash, merge commit, rebase (original commits listed), fast-forward, direct pushes", async () => {
    let last = make();
    const report = await runProviderConformance(
      (_f, h) => (last = make(h)).provider,
      [
        {
          name: "synthetic bitbucket-cloud acme/widgets 2026-08-01",
          request: { repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] },
          expect: {
            ids: x.all,
            pullRequests: x.pullRequests,
            directPushes: x.directPushes,
            prCommits: x.prCommits,
            mergeShas: x.mergeShas,
            changedLines: x.changedLines,
            reviewStates: {
              [x.ids.squash]: ["COMMENTED"],
              [x.ids.rebase]: ["CHANGES_REQUESTED"],
              [x.ids.merge]: ["APPROVED"],
              [x.ids.ff]: ["APPROVED"],
              [x.ids.squash5]: [],
              [x.ids.squashMerge]: ["APPROVED"],
              [x.ids.atOpen]: [],
            },
            reviewers: { [x.ids.rebase]: [human("dave")], [x.ids.ff]: [bot("review-bot")], [x.ids.squashMerge]: [bot("review-bot")] },
            actors: {
              [x.ids.squash]: { author: bot("agent-bot"), mergedBy: human("maint") },
              [x.ids.rebase]: { author: human("bob"), mergedBy: bot("merge-bot") },
              [x.ids.alice]: { author: human("alice"), mergedBy: null },
              [x.ids.bot]: { author: bot("deploy-bot"), mergedBy: null },
            },
            bots: ["agent-bot[bot]", "review-bot[bot]", "merge-bot[bot]", "deploy-bot[bot]"],
            humans: ["maint", "bob", "dave", "carol", "alice"],
            minPages: 25,
          },
          pagesServed: () => last.fake.served(),
          http: true,
        },
      ],
    );
    expect(report.ok, formatConformanceReport(report)).toBe(true);
    expect(report.results.filter((r) => r.skipped)).toEqual([]);
  });

  it("links the rebased copies by author + message, and counts the excluded PR into another branch", async () => {
    const r = await make().provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] });
    expect(r.diagnostics).toEqual([
      { label: "PRs into other branches updated in window (excluded)", value: 1 },
      { label: "default-branch commits in window", value: x.inWindowCommits },
      { label: "commits linked to a merged PR", value: 14 },
      { label: "rebased commits linked by author and message", value: 2 },
      { label: "direct pushes that are merge commits", value: 0 },
    ]);
    expect(r.changes.map((c) => c.id)).not.toContain(`bitbucket-cloud:${sc.repo}@${OID("P9b")}`);
    expect(r.changes.find((c) => c.id === x.ids.atOpen)?.mergedAt).toBe("2026-08-01T00:00:02Z");
  });

  it("is registered as bitbucket-cloud, alias bitbucket", async () => {
    expect((await loadProviderDefinition("bitbucket-cloud", ".")).name).toBe("bitbucket-cloud");
    expect((await loadProviderDefinition("bitbucket", ".")).name).toBe("bitbucket-cloud");
  });
});

describe("Bitbucket Cloud normalizers (pure)", () => {
  it("bot detection: app_user and team are bots; users are human under their nickname", () => {
    expect(normalizeUser({ type: "app_user", display_name: "atlassian-renovate-bot", uuid: "{u}" })).toEqual(bot("atlassian-renovate-bot"));
    expect(normalizeUser({ type: "team", display_name: "Acme", uuid: "{t}" })).toEqual(bot("Acme"));
    expect(normalizeUser({ type: "user", nickname: "Alexey Chystoprudov", display_name: "Alexey Chystoprudov" })).toEqual(human("Alexey Chystoprudov"));
    expect(normalizeUser(null)).toEqual(human("ghost"));
    expect(normalizeCommitAuthor({ author: { raw: "atlassian-renovate-bot <k0pte9d0wzf0w9uc84anlhxqzkygni@bots.bitbucket.org>" } })).toEqual(bot("atlassian-renovate-bot"));
    expect(normalizeCommitAuthor({ author: { raw: "bambooagent <build-agent@atlassian.com>", user: { type: "user", nickname: "bambooagent" } } })).toEqual(human("bambooagent"));
    expect(normalizeCommitAuthor({ author: { raw: "Tardigrade <tardigrade@atlassian.com>" } })).toEqual(human("git:tardigrade@atlassian.com"));
  });

  it("reviews: activity events, the first comment per user, participants fill gaps", () => {
    const u = (n: string) => ({ type: "user", uuid: `{${n}}`, nickname: n });
    const reviews = buildReviews({
      author: u("author"),
      activity: [
        { update: { state: "MERGED", date: "2026-11-03T12:00:46.202450+00:00", author: u("alexey") } },
        { approval: { date: "2026-11-03T12:00:20.671376+00:00", user: u("alexey") } },
        { comment: { created_on: "2026-11-03T11:00:00+00:00", user: u("filip") } },
        { comment: { created_on: "2026-11-03T10:00:00+00:00", user: u("filip") } },
        { comment: { created_on: "2026-11-03T09:00:00+00:00", user: u("author") } },
        { changes_requested: { date: "2026-11-03T08:00:00+00:00", user: u("filip") } },
      ],
      participants: [{ user: u("silent"), approved: true, state: "approved", participated_on: "2026-11-03T07:00:00+00:00" }, { user: u("alexey"), approved: true, state: "approved", participated_on: "2026-11-03T12:00:20+00:00" }],
      mergedAt: "2026-11-03T12:00:46Z",
    });
    expect(reviews.map((r) => `${r.author.login} ${r.state} ${r.submittedAt}`)).toEqual([
      "silent APPROVED 2026-11-03T07:00:00Z",
      "filip CHANGES_REQUESTED 2026-11-03T08:00:00Z",
      "filip COMMENTED 2026-11-03T10:00:00Z",
      "alexey APPROVED 2026-11-03T12:00:20Z",
    ]);
  });
});
