import { describe, expect, it } from "vitest";
import gitlab, { GitLabProvider } from "../src/providers/gitlab/index.js";
import { buildReviews, normalizeCommitAuthor, normalizeUser } from "../src/providers/gitlab/normalize.js";
import { loadProviderDefinition } from "../src/registry.js";
import { formatConformanceReport, runProviderConformance, type ConformanceHarness } from "../src/testing/index.js";
import { applySelector, normalizeSelector } from "../src/core/selector.js";
import { fakeGitLab, GL_BASE } from "./helpers/fake-gitlab.js";
import { readJsonFixture } from "./helpers/fixtures.js";
import { replayFetch, type Recording } from "./helpers/replay-fetch.js";
import { OID, scenarioExpectations, scmScenario } from "./helpers/scm-scenario.js";

/** gitlab.com's 429: Retry-After plus RateLimit-Reset in epoch seconds. */
const GITLAB_RATE_LIMIT = { status: 429, headers: (now: number) => ({ "retry-after": "20", "ratelimit-remaining": "0", "ratelimit-reset": String(now + 20) }), minWaitMs: 20_000 };

const bot = (login: string) => ({ login: `${login}[bot]`, kind: "bot" as const });
const human = (login: string) => ({ login, kind: "human" as const });

describe("GitLab provider on a synthetic self-managed instance: every merge strategy", () => {
  const sc = scmScenario();
  const x = scenarioExpectations("gitlab");
  const make = (h?: ConformanceHarness) => {
    const fake = fakeGitLab(sc, { pageSize: 3 });
    const base = { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch };
    return { fake, provider: new GitLabProvider({ base_url: GL_BASE, page_size: 3, batch_size: 4 }, { ...(h ? h.context(base) : base), now: () => Date.parse("2026-08-03T00:00:00Z") }) };
  };
  it("passes the conformance kit: squash, squash + merge commit, merge commit, rebase, fast-forward, direct pushes", async () => {
    let last = make();
    const report = await runProviderConformance(
      (_f, h) => (last = make(h)).provider,
      [
        {
          name: "synthetic gitlab acme/widgets 2026-08-01",
          request: { repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] },
          expect: {
            ids: x.all,
            pullRequests: x.pullRequests,
            directPushes: x.directPushes,
            prCommits: x.prCommits,
            mergeShas: x.mergeShas,
            changedLines: { ...x.changedLines, [x.ids.squash5]: 10 },
            reviewStates: {
              [x.ids.squash]: ["COMMENTED"],
              [x.ids.rebase]: ["CHANGES_REQUESTED", "DISMISSED"],
              [x.ids.merge]: ["APPROVED"],
              [x.ids.ff]: ["APPROVED"],
              [x.ids.squash5]: [],
              [x.ids.squashMerge]: ["DISMISSED", "APPROVED"],
              [x.ids.atOpen]: [],
            },
            reviewers: { [x.ids.rebase]: [human("dave"), human("erin")], [x.ids.ff]: [bot("review-bot")], [x.ids.squashMerge]: [human("carol"), bot("review-bot")] },
            actors: {
              [x.ids.squash]: { author: bot("agent-bot"), mergedBy: human("maint") },
              [x.ids.rebase]: { author: human("bob"), mergedBy: bot("merge-bot") },
              [x.ids.alice]: { author: { login: "git:alice@example.com", kind: "human" }, mergedBy: null },
              [x.ids.bot]: { author: bot("project_42_bot_0a1b2c"), mergedBy: null },
            },
            bots: ["agent-bot[bot]", "review-bot[bot]", "merge-bot[bot]", "project_42_bot_0a1b2c[bot]"],
            humans: ["maint", "bob", "dave", "erin", "carol"],
            minPages: 20,
          },
          pagesServed: () => last.fake.served(),
          http: true,
          rateLimitFault: GITLAB_RATE_LIMIT,
        },
      ],
    );
    expect(report.ok, formatConformanceReport(report)).toBe(true);
    expect(report.results.filter((r) => r.skipped)).toEqual([]);
  });

  it("counts in-window commits, the MR merged after the window, and the MR into another branch", async () => {
    const r = await make().provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] });
    expect(r.defaultBranch).toBe("main");
    expect(r.diagnostics).toEqual([
      { label: "MRs merged into other branches in window (excluded)", value: 1 },
      { label: "default-branch commits in window", value: x.inWindowCommits },
      { label: "commits linked to a merged MR", value: 14 },
      { label: "commits linked only through GitLab's commit->MR lookup", value: 0 },
      { label: "direct pushes that are merge commits", value: 0 },
    ]);
    expect(r.changes.map((c) => c.id)).not.toContain(`gitlab:${sc.repo}@${OID("P9a")}`); // PR 9 fast-forwarded after the window
    expect(r.changes.find((c) => c.id === x.ids.atOpen)?.mergedAt).toBe("2026-08-01T00:00:02Z"); // merged_at after updated_at, across the window edge
    expect(r.limitations.join(" ")).toMatch(/commit author != pusher/);
  });

  it("follows note pagination past 100 (MR !1 has 150 bot comments) and keeps one COMMENTED per reviewer", async () => {
    const { provider, fake } = make();
    const before = fake.served();
    const r = await provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request"] });
    expect(r.changes.find((c) => c.id === x.ids.squash)!.reviews).toEqual([{ author: bot("review-bot"), state: "COMMENTED", submittedAt: "2026-08-01T11:00:00Z" }]);
    expect(fake.served() - before).toBeGreaterThan(10);
  });

  it("is registered as a built-in", async () => {
    expect((await loadProviderDefinition("gitlab", ".")).name).toBe("gitlab");
    expect(gitlab.providerApiVersion).toBe(1);
  });
});

describe("GitLab normalizers (pure)", () => {
  it("bot detection: the bot flag, access-token users, service accounts; ghost is human", () => {
    expect(normalizeUser({ username: "GitLabDuo" }, new Map([["GitLabDuo", true]]))).toEqual({ login: "GitLabDuo[bot]", kind: "bot" });
    expect(normalizeUser({ username: "renovate", bot: true })).toEqual({ login: "renovate[bot]", kind: "bot" });
    expect(normalizeUser({ username: "project_278964_bot_e2b3c4d5" })).toEqual({ login: "project_278964_bot_e2b3c4d5[bot]", kind: "bot" });
    expect(normalizeUser({ username: "group_99_bot_1f2e" })).toEqual({ login: "group_99_bot_1f2e[bot]", kind: "bot" });
    expect(normalizeUser({ username: "service_account_group_7_ab12" })).toEqual({ login: "service_account_group_7_ab12[bot]", kind: "bot" });
    expect(normalizeUser({ username: "gitlab-dependency-update-bot", bot: false })).toEqual({ login: "gitlab-dependency-update-bot", kind: "human" }); // a regular account: GitLab says not a bot
    expect(normalizeUser(null)).toEqual({ login: "ghost", kind: "human" });
    expect(normalizeCommitAuthor({ author_name: "deploy", author_email: "project_42_bot_0a1b2c@noreply.gitlab.com" })).toEqual({ login: "project_42_bot_0a1b2c[bot]", kind: "bot" });
    expect(normalizeCommitAuthor({ author_name: "Jo", author_email: "jo@example.com" })).toEqual({ login: "git:jo@example.com", kind: "human" });
  });

  it("reviews: notes give the history; REST approvals and reviewer states fill gaps", () => {
    const u = (username: string) => ({ username });
    const n = (system: boolean, body: string, at: string, who: string) => ({ system, body, createdAt: `2026-11-03T${at}Z`, author: u(who) });
    const reviews = buildReviews({
      mrAuthor: "arpit",
      notes: [
        n(false, "my own MR", "06:00:00", "arpit"),
        n(true, "requested changes", "12:39:40", "viktomas"),
        n(false, "please drop PROXY", "12:39:29", "viktomas"),
        n(true, "approved this merge request", "13:27:20", "GitLabDuo"),
        n(true, "approved this merge request", "14:01:23", "viktomas"),
        n(true, "approved this merge request", "09:00:00", "old"),
        n(true, "reset approvals from @old and @nobody by pushing to the branch", "10:00:00", "arpit"),
      ],
      approvals: { approved_by: [{ user: u("viktomas"), approved_at: "2026-11-03T14:01:22.844Z" }, { user: u("silent"), approved_at: "2026-11-03T14:05:00Z" }] },
      reviewers: [{ user: u("late"), state: "requested_changes", created_at: "2026-11-03T08:00:00Z" }],
      mergedAt: "2026-11-03T14:24:19.170Z",
      actor: (x) => normalizeUser(x, new Map([["GitLabDuo", true]])),
    });
    expect(reviews.map((r) => `${r.author.login} ${r.state} ${r.submittedAt}`)).toEqual([
      "late CHANGES_REQUESTED 2026-11-03T08:00:00Z",
      "old DISMISSED 2026-11-03T09:00:00Z",
      "viktomas COMMENTED 2026-11-03T12:39:29Z",
      "viktomas CHANGES_REQUESTED 2026-11-03T12:39:40Z",
      "GitLabDuo[bot] APPROVED 2026-11-03T13:27:20Z",
      "viktomas APPROVED 2026-11-03T14:01:23Z",
      "silent APPROVED 2026-11-03T14:05:00Z",
    ]);
  });
});

type Rec = Recording & { options: Record<string, string>; window: { opensAt: string; closesAt: string }; repo: string; expected: { ids: string[]; directPushes: string[]; diagnostics: { label: string; value: number }[] } };
const recorded = (name: string) => {
  const rec = readJsonFixture<Rec>("gitlab", name);
  let last = replayFetch(rec);
  const make = (h?: ConformanceHarness) => {
    last = replayFetch(rec);
    const base = { cwd: ".", env: {}, log: () => {}, fetch: last as typeof fetch };
    return new GitLabProvider(rec.options, { ...(h ? h.context(base) : base), now: () => Date.parse(rec.recordedAt) });
  };
  return { rec, make, served: () => last.served(), request: { repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] as ("pull_request" | "direct_push")[] } };
};

describe("GitLab provider on recorded gitlab.com responses: gitlab-org/cli, 2026-11-02 (squash + merge commit)", () => {
  const r = recorded("gitlab-org-cli-2026-11-02.json");
  const id = (n: number) => `gitlab:gitlab-org/cli#${n}`;

  it("passes the conformance kit on real data", async () => {
    const report = await runProviderConformance((_f, h) => r.make(h), [
      {
        name: "gitlab-org/cli 2026-11-02",
        request: r.request,
        expect: {
          ids: r.rec.expected.ids,
          directPushes: [],
          // Squash + merge commit: both the merge commit and the squash commit belong to the MR.
          prCommits: { [id(4290)]: ["9377b78998060f3d59b74b95cf7f624c55eccd1d", "ca3e4aea1127d506621b27efafad9dd3fd08e3cd"] },
          mergeShas: { [id(4290)]: "9377b78998060f3d59b74b95cf7f624c55eccd1d" },
          reviewStates: {
            // gitlab-bot approved, then unapproved 73 min later (system notes, checked against GraphQL by hand).
            [id(4290)]: ["COMMENTED", "APPROVED", "DISMISSED", "COMMENTED", "APPROVED"],
            [id(4275)]: ["COMMENTED", "CHANGES_REQUESTED", "APPROVED", "APPROVED", "COMMENTED"],
          },
          reviewers: { [id(4290)]: [bot("GitLabDuo"), bot("GitLabDuo"), human("gitlab-bot"), human("gitlab-bot"), human("viktomas")] },
          actors: { [id(4273)]: { author: human("gitlab-dependency-update-bot"), mergedBy: human("jay_mccure") } },
          changedLines: { [id(4290)]: 50, [id(4155)]: 269 },
          bots: ["GitLabDuo[bot]"],
          // GitLab reports these service accounts as bot: false, so pr-rla counts them as human (documented limitation).
          humans: ["gitlab-bot", "gitlab-dependency-update-bot", "viktomas"],
          minPages: 20,
        },
        pagesServed: r.served,
        http: true,
        rateLimitFault: GITLAB_RATE_LIMIT,
      },
    ]);
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });

  it("9 MRs, 18 commits (9 merge + 9 squash), no direct pushes; 0 MRs without a human decision because gitlab-bot counts as human", async () => {
    const out = await r.make().listChanges(r.request);
    expect(out.diagnostics).toEqual(r.rec.expected.diagnostics);
    expect(out.diagnostics).toContainEqual({ label: "default-branch commits in window", value: 18 });
    const sel = applySelector(out.changes, normalizeSelector({ kinds: ["pull_request"], unreviewed: "no-human-review" }), r.rec.recordedAt);
    expect(sel.funnel.at(-1)!.count).toBe(0);
    // Were gitlab-bot a bot, !4275 and !4287 (approved only by GitLabDuo and gitlab-bot) would have no human decision.
    const asBot = out.changes.map((c) => ({ ...c, reviews: c.reviews.map((rv) => (rv.author.login === "gitlab-bot" ? { ...rv, author: { login: "gitlab-bot[bot]", kind: "bot" as const } } : rv)) }));
    expect(applySelector(asBot, normalizeSelector({ kinds: ["pull_request"], unreviewed: "no-human-review" }), r.rec.recordedAt).selected.map((c) => c.id)).toEqual([id(4275), id(4287)]);
  });
});

describe("GitLab provider on recorded self-managed responses: gitlab.freedesktop.org xorg/xserver, 2026-10-05..07 (fast-forward)", () => {
  const r = recorded("freedesktop-xserver-2026-10-05.json");
  const id = (n: number) => `gitlab:xorg/xserver#${n}`;
  const mr2304 = ["effe0ba3cd8d17be151de0d15b6c34a1db5e177f", "6a4fb12019cbe6bcbc5e9c6f1c1964c73f3f8905", "bad7edcab08badcd4524f75b1b3dea529b6d7397"];

  it("passes the conformance kit: merge_commit_sha is null, the 3 + 12 rebased commits belong to their MRs", async () => {
    const report = await runProviderConformance((_f, h) => r.make(h), [
      {
        name: "xorg/xserver 2026-10-05..07",
        request: r.request,
        expect: {
          ids: [id(2304), id(2341)],
          directPushes: [],
          prCommits: { [id(2304)]: mr2304 },
          mergeShas: { [id(2304)]: mr2304[0]!, [id(2341)]: "ad26c26bf795e6464f74c8ef5bb1d41403d877ab" },
          changedLines: { [id(2304)]: 288, [id(2341)]: 2331 },
          reviewStates: { [id(2304)]: ["COMMENTED", "COMMENTED", "APPROVED"], [id(2341)]: [] },
          // marge-bot is a regular account on freedesktop (bot: false): counted as a human merger.
          actors: { [id(2341)]: { author: human("whot"), mergedBy: human("marge-bot") } },
          humans: ["marge-bot", "whot"],
          minPages: 10,
        },
        pagesServed: r.served,
        http: true,
        rateLimitFault: GITLAB_RATE_LIMIT,
      },
    ]);
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });

  it("15 commits in the window, all from the two MRs; 13 backport MRs into release branches excluded", async () => {
    const out = await r.make().listChanges(r.request);
    expect(out.diagnostics).toEqual([
      { label: "MRs merged into other branches in window (excluded)", value: 13 },
      { label: "default-branch commits in window", value: 15 },
      { label: "commits linked to a merged MR", value: 15 },
      { label: "commits linked only through GitLab's commit->MR lookup", value: 0 },
      { label: "direct pushes that are merge commits", value: 0 },
    ]);
  });
});
