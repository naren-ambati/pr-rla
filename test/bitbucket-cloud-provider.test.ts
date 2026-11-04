import { describe, expect, it } from "vitest";
import bitbucketCloud, { BitbucketCloudProvider, rebasedCopies } from "../src/providers/bitbucket-cloud/index.js";
import { buildReviews, normalizeCommitAuthor, normalizeUser } from "../src/providers/bitbucket-cloud/normalize.js";
import { loadProviderDefinition } from "../src/registry.js";
import { formatConformanceReport, runProviderConformance, type ConformanceFixture, type ConformanceHarness } from "../src/testing/index.js";
import { fakeBitbucketCloud } from "./helpers/fake-bitbucket-cloud.js";
import { readJsonFixture } from "./helpers/fixtures.js";
import { replayFetch, type Recording } from "./helpers/replay-fetch.js";
import { OID, scenarioExpectations, scmScenario } from "./helpers/scm-scenario.js";
import { applySelector, normalizeSelector } from "../src/core/selector.js";

/** Bitbucket Cloud's 429 carries no rate-limit headers at all (seen live), so only backoff applies. */
const bot = (login: string) => ({ login: `${login}[bot]`, kind: "bot" as const });
const human = (login: string) => ({ login, kind: "human" as const });

describe("Bitbucket Cloud provider on a synthetic repository: every merge strategy", () => {
  const sc = scmScenario();
  const late = scmScenario({ latePush: true });
  const x = scenarioExpectations("bitbucket-cloud");
  const make = (h?: ConformanceHarness, s = sc) => {
    const fake = fakeBitbucketCloud(s, { pageLen: 3 });
    const base = { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch };
    return { fake, provider: new BitbucketCloudProvider({}, { ...(h ? h.context(base) : base), now: () => Date.parse("2026-08-03T00:00:00Z") }) };
  };

  it("passes the conformance kit: squash, merge commit, rebase (original commits listed), fast-forward, direct pushes", async () => {
    let last = make();
    const base: ConformanceFixture = {
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
            actorIds: { bob: "{bob}", "review-bot[bot]": "{review-bot}" },
            reviewGranularity: "first-comment-per-user",
            // Bitbucket drops a withdrawn approval from the activity: it must not come back as APPROVED either.
            revokedApprovals: x.revokedApprovals,
          },
          pagesServed: () => last.fake.served(),
          http: true,
        };
    const pushedLater: ConformanceFixture = { ...base, name: "synthetic bitbucket-cloud, a merge pushed after freeze", expect: { ...base.expect, ids: [...x.all, x.late.id], directPushes: [...x.directPushes, x.late.id] }, pinnedHead: { head: sc.frozenHead, late: [x.late.sha] } };
    const report = await runProviderConformance((f, h) => (last = make(h, f.pinnedHead ? late : sc)).provider, [base, pushedLater], { definition: bitbucketCloud });
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

  it("skips the listing re-scan after a single-page walk (one response is one snapshot), not after a multi-page one", async () => {
    const listings = async (pageLen: number) => {
      const fake = fakeBitbucketCloud(sc, { pageLen });
      let n = 0;
      const f = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/pullrequests?")) n++;
        return fake.fetch(input, init);
      }) as typeof fetch;
      await new BitbucketCloudProvider({}, { cwd: ".", env: {}, log: () => {}, fetch: f }).listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request"] });
      return n;
    };
    expect(await listings(50)).toBe(1);
    expect(await listings(3)).toBeGreaterThan(4);
  });

  it("walks from request.head (FR7.2); account uuids are Actor.id (FR7.3)", async () => {
    const late = scmScenario({ latePush: true });
    const p = new BitbucketCloudProvider({}, { cwd: ".", env: {}, log: () => {}, fetch: fakeBitbucketCloud(late, { pageLen: 3 }).fetch, now: () => Date.parse("2026-08-05T00:00:00Z") });
    const now = await p.listChanges({ repo: late.repo, window: late.window, kinds: ["pull_request", "direct_push"] });
    expect(now.headSha).toBe(OID("LM"));
    expect(now.changes.map((c) => c.id)).toContain(x.late.id);
    const frozen = await p.listChanges({ repo: late.repo, window: late.window, kinds: ["pull_request", "direct_push"], head: late.frozenHead });
    expect(frozen.headSha).toBe(late.frozenHead);
    expect(frozen.changes.map((c) => c.id).sort()).toEqual([...x.all].sort());
    const rebase = frozen.changes.find((c) => c.id === x.ids.rebase)!;
    expect([rebase.author.id, rebase.mergedBy?.id, rebase.reviews[0]!.author.id]).toEqual(["{bob}", "{merge-bot}", "{dave}"]);
  });

  it("is registered as bitbucket-cloud, alias bitbucket", async () => {
    expect((await loadProviderDefinition("bitbucket-cloud", ".")).name).toBe("bitbucket-cloud");
    expect((await loadProviderDefinition("bitbucket", ".")).name).toBe("bitbucket-cloud");
  });
});

describe("Bitbucket Cloud normalizers (pure)", () => {
  it("rebased copies: only the merge commit's chain, never a look-alike elsewhere (the bamboo-specs release-plugin case)", () => {
    const sha = (t: string) => t.repeat(40).slice(0, 40);
    const commit = (t: string, parents: string[], message = `msg ${t}`, raw = "Dev <dev@example.com>") => ({ hash: sha(t), date: "2026-10-29T00:00:00+00:00", parents: parents.map((p) => ({ hash: sha(p) })), message, author: { raw } });
    const plugin = "[maven-release-plugin] prepare for next development iteration";
    const agent = "bambooagent <build-agent@atlassian.com>";
    // master: p (a direct push by the release plugin) <- m, a PR merge commit whose second parent b is the PR's
    // branch, which carries b2: the same author and message as p, on the release branch.
    const hist = [commit("m", ["p", "b"]), commit("p", ["0"], plugin, agent), commit("b", ["b2"]), commit("b2", ["0"], plugin, agent)];
    const short = new Map(hist.map((c) => [c.hash.slice(0, 12), c]));
    const full = new Map(hist.map((c) => [c.hash, c]));
    const pr = { id: 738, updated_on: "", destination: { branch: { name: "master" } }, merge_commit: { hash: sha("m").slice(0, 12) }, source: { commit: { hash: sha("b").slice(0, 12) } }, author: null };
    expect(rebasedCopies(pr, [hist[2]!, hist[3]!], short, full)).toEqual([]); // a plain merge rewrites nothing
    // Rebase + fast-forward: copies r1, r2 of o1, o2 sit on the chain from the merge commit r2.
    const ff = [commit("r", ["q"], "work b"), commit("q", ["p"], "work a")];
    const ffShort = new Map([...ff, ...hist].map((c) => [c.hash.slice(0, 12), c]));
    const ffFull = new Map([...ff, ...hist].map((c) => [c.hash, c]));
    const listed = [commit("o", ["0"], "work a"), commit("n", ["o"], "work b")];
    const ffPr = { ...pr, merge_commit: { hash: sha("r").slice(0, 12) }, source: { commit: { hash: sha("n").slice(0, 12) } } };
    expect(rebasedCopies(ffPr, listed, ffShort, ffFull).map((c) => c.hash)).toEqual([sha("r"), sha("q")]);
  });

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

describe("Bitbucket Cloud provider on recorded responses: atlassian/bamboo-specs, 2026-10-27..31 (recorded during the live dry run)", () => {
  type Rec = Recording & { options: Record<string, unknown>; repo: string; window: { opensAt: string; closesAt: string }; expected: { ids: string[]; diagnostics: unknown[] } };
  const rec = readJsonFixture<Rec>("bitbucket-cloud", "bamboo-specs-2026-10-27.json");
  const id = (n: number) => `bitbucket-cloud:atlassian/bamboo-specs#${n}`;
  const push = (sha: string) => `bitbucket-cloud:atlassian/bamboo-specs@${sha}`;
  // Expected from a git clone of master, independently of the API: 14 commits in the window = 4 PR merge
  // commits + 6 commits PR #738 (merge_130_to_master) brought in + 4 maven-release-plugin pushes.
  const pushes = ["71f90c5c33c7d527f715a2ec9c620ab1ed3ee7ac", "7748da302acddf0542b958006b429c040c431e58", "0912c19f1530edcc5cd10ff1b1a7cf175843f1af", "4ca76a3792ab5661cd194e12924b5747edd50525"];
  const pr738 = ["6e3b780a3c2593924a5653a6915f8f27fff4e9a9", "dc124f98defe2a5dc3a18298fbb56e3df86cf7f0", "5a4688aaec3463d6000e9e7ac5ef7b77f47b6b27", "85f9fd3d8104fb7604ef7598cde364891764b3e3", "f5410698a1973004bdebc8385c0d9d138244dd13", "c4f2190e302f480fe40940a951443cc830d5d86e", "821a7d32ffee6ed86311f2684833b174c4ef0c55", "efb922309aa75b3d829862af376e9ecd226b0d8e"];
  let last = replayFetch(rec);
  const make = (h?: ConformanceHarness) => {
    last = replayFetch(rec);
    const base = { cwd: ".", env: {}, log: () => {}, fetch: last as typeof fetch };
    return new BitbucketCloudProvider(rec.options, { ...(h ? h.context(base) : base), now: () => Date.parse(rec.recordedAt) });
  };

  it("passes the conformance kit on real data: the 4 PRs and 4 direct pushes git shows", async () => {
    const report = await runProviderConformance((_f, h) => make(h), [
      {
        name: "atlassian/bamboo-specs 2026-10-27..31",
        request: { repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] },
        expect: {
          ids: [...[738, 739, 740, 741].map(id), ...pushes.map(push)],
          directPushes: pushes.map(push),
          prCommits: { [id(738)]: ["aff17cc641d12ccc03525f0f2235034b42a31f67", ...pr738] },
          mergeShas: { [id(738)]: "aff17cc641d12ccc03525f0f2235034b42a31f67", [id(741)]: "8935e1d909ea1846e6bf0f3b73a09f556380ecd0" },
          changedLines: Object.fromEntries(pushes.map((s) => [push(s), 24])),
          bots: ["atlassian-renovate-bot[bot]"],
          minPages: 15,
          reviewGranularity: "first-comment-per-user",
        },
        pagesServed: () => last.served(),
        http: true,
      },
    ], { definition: bitbucketCloud });
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });

  it("14 commits in the window, 10 linked to PRs; the PRs merged after the window were read for attribution only", async () => {
    const r = await make().listChanges({ repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] });
    expect(r.diagnostics).toEqual(rec.expected.diagnostics);
    expect(r.diagnostics).toContainEqual({ label: "default-branch commits in window", value: 14 });
    expect(r.diagnostics).toContainEqual({ label: "commits linked to a merged PR", value: 10 });
  });
});

describe("Bitbucket Cloud provider on recorded responses: atlassian/bamboo-specs, 2026-10-06 (a release branch merged by a push, FR7.6)", () => {
  type Rec = Recording & { options: Record<string, unknown>; repo: string; window: { opensAt: string; closesAt: string }; expected: { ids: string[]; diagnostics: unknown[] } };
  const rec = readJsonFixture<Rec>("bitbucket-cloud", "bamboo-specs-2026-10-06.json");
  const push = (sha: string) => `bitbucket-cloud:atlassian/bamboo-specs@${sha}`;
  // "[bamboo] Automated branch merge (from atlassian_bamboo_13_0_branch …)": Tardigrade's merge, pushed to master.
  const merge = "a9f178ae03b65a3190e4eb98f9454c7fcad71c91";
  // What its second parent brought in that day: #730's merge into the 13.0 branch, #729's into 12.1, and their branch merges.
  const release = ["735553ca0c7a85165fc2b75e16e629c59f0023bf", "78611696c1bbd7fa102093499a515b3b09d6180c", "4f1f0c51735660b85d93d431c2fa859911972895", "9470b7304f0e9739e42461ad6435afb336bcb869"];
  const make = (h?: ConformanceHarness) => {
    const base = { cwd: ".", env: {}, log: () => {}, fetch: replayFetch(rec) as typeof fetch };
    return new BitbucketCloudProvider(rec.options, { ...(h ? h.context(base) : base), now: () => Date.parse(rec.recordedAt) });
  };

  it("passes the extended conformance kit on the recorded release merge", async () => {
    let last = replayFetch(rec);
    const report = await runProviderConformance(
      (_f, h) => new BitbucketCloudProvider(rec.options, { ...h.context({ fetch: (last = replayFetch(rec)) as typeof fetch }), now: () => Date.parse(rec.recordedAt) }),
      [{ name: "atlassian/bamboo-specs 2026-10-06", request: { repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] }, expect: { ids: [merge, ...release].map(push), directPushes: [merge, ...release].map(push), reviewGranularity: "first-comment-per-user", minPages: 30 }, pagesServed: () => last.served(), http: true }],
      { definition: bitbucketCloud },
    );
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });

  it("5 direct pushes: the pushed merge, and 4 release-branch commits whose landedVia is that merge", async () => {
    const r = await make().listChanges({ repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] });
    expect(r.diagnostics).toEqual(rec.expected.diagnostics);
    expect(Object.fromEntries(r.changes.map((c) => [c.mergeSha, c.landedVia ?? null]))).toEqual({ [merge]: null, ...Object.fromEntries(release.map((s) => [s, merge])) });
    expect(r.limitations.join(" ")).toMatch(/landedVia names the pushed merge commit/);
  });

  it("direct_push_via_merge: exclude removes the release-branch commits from the stratum; include (the default) keeps them", async () => {
    const r = await make().listChanges({ repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] });
    const sel = (direct_push_via_merge: "include" | "exclude") => applySelector(r.changes, normalizeSelector({ unreviewed: "no-human-review", direct_push_via_merge }), rec.recordedAt);
    expect(sel("include").selected.map((c) => c.id).sort()).toEqual([merge, ...release].map(push).sort());
    expect(sel("exclude").selected.map((c) => c.id)).toEqual([push(merge)]);
    expect(sel("exclude").funnel.find((s) => s.step === "excluding pushes via a pushed merge")).toEqual({ step: "excluding pushes via a pushed merge", count: 1 });
  });
});
