import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditError } from "../src/api/errors.js";
import { readManifest } from "../src/commands/context.js";
import { buildPopulation } from "../src/core/population.js";
import { applySelector, DEFAULT_SELECTOR, normalizeSelector, UNKNOWN_SIZE_STEP } from "../src/core/selector.js";
import { BitbucketDataCenterProvider } from "../src/providers/bitbucket-data-center/index.js";
import { GitHubProvider } from "../src/providers/github/index.js";
import { GitLabProvider } from "../src/providers/gitlab/index.js";
import { buildReviews } from "../src/providers/gitlab/normalize.js";
import { changeRecordProblems, type ChangeRecord } from "../src/sdk/provider.js";
import { DC_BASE, fakeBitbucketDc } from "./helpers/fake-bitbucket-dc.js";
import { fakeGitHub, OID, type FakeCommit, type FakePr } from "./helpers/fake-github.js";
import { fakeGitLab, GL_BASE } from "./helpers/fake-gitlab.js";
import { scenarioExpectations, scmScenario } from "./helpers/scm-scenario.js";

// Finding 10 of the master review: GraphQL caps are paged or refused, never truncated silently;
// a diff the SCM truncated is a size we do not know; GitLab's approval resets are read by its own
// note tag; the pinned head is a commit id and is escaped in URLs.
const WINDOW = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };
const REPO = "acme/widgets";
const author = { __typename: "User", login: "bob" };
const pr = (number: number, o: Partial<FakePr> = {}): FakePr => ({ number, base: "main", mergedAt: "2026-08-01T12:00:00Z", updatedAt: "2026-08-01T12:00:01Z", mergeCommit: null, author, mergedBy: { __typename: "User", login: "maint" }, reviews: [], additions: 1, deletions: 1, ...o });
const commit = (tag: string, date: string, parents: string[], extra: Partial<FakeCommit> = {}): FakeCommit => ({ oid: OID(tag), date, parents: parents.map(OID), author: { name: "Alice", email: "alice@example.com", login: "alice" }, ...extra });
const github = (commits: FakeCommit[], prs: FakePr[], head: string) => {
  const fake = fakeGitHub(REPO, OID(head), commits, prs, { pageSize: 50 });
  return new GitHubProvider({ page_size: 50, batch_size: 10, history_page_size: 50 }, { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch, now: () => Date.parse("2026-08-03T00:00:00Z") });
};

describe("GitHub: caps are paged or refused (finding 10)", () => {
  it("a commit in 7 PRs, the merged-into-main one last, is linked to it, not reported as a direct push", async () => {
    const unmerged = Array.from({ length: 6 }, (_, i) => ({ number: 200 + i, merged: false, baseRefName: "main" }));
    const commits = [commit("X", "2026-08-01T10:00:00Z", ["B"], { prs: [...unmerged, { number: 99, merged: true, baseRefName: "main" }] }), commit("B", "2026-07-31T10:00:00Z", [])];
    const r = await github(commits, [pr(99, { mergeCommit: OID("Y") })], "X").listChanges({ repo: REPO, window: WINDOW, kinds: ["direct_push"] });
    expect(r.changes.map((c) => c.id)).toEqual([]);
    expect(r.diagnostics).toContainEqual({ label: "commits linked to a merged PR", value: 1 });
  });

  it("a PR with 120 labels keeps all of them (the selector filters on labels)", async () => {
    const labels = Array.from({ length: 120 }, (_, i) => `label-${String(i).padStart(3, "0")}`);
    const r = await github([commit("H", "2026-08-01T10:00:00Z", [])], [pr(7, { labels, mergeCommit: OID("H") })], "H").listChanges({ repo: REPO, window: WINDOW, kinds: ["pull_request"] });
    expect(r.changes[0]!.labels).toEqual(labels);
  });

  it("an octopus merge keeps its third parent: the commit only it reaches is landedVia the merge", async () => {
    const commits = [
      commit("O", "2026-08-01T20:00:00Z", ["P1", "P2", "P3"]),
      commit("P1", "2026-08-01T10:00:00Z", ["B"]),
      commit("P2", "2026-08-01T11:00:00Z", ["B"]),
      commit("P3", "2026-08-01T12:00:00Z", ["B"]),
      commit("B", "2026-07-31T10:00:00Z", []),
    ];
    const r = await github(commits, [], "O").listChanges({ repo: REPO, window: WINDOW, kinds: ["direct_push"] });
    const p3 = r.changes.find((c) => c.id === `github:${REPO}@${OID("P3")}`)!;
    expect(p3.landedVia).toBe(OID("O"));
  });

  it("a commit with more than 100 parents is refused, not classified from a truncated list", async () => {
    const parents = Array.from({ length: 101 }, (_, i) => `PP${i}`);
    const commits = [commit("O", "2026-08-01T20:00:00Z", parents), ...parents.map((p) => commit(p, "2026-08-01T10:00:00Z", []))];
    await expect(github(commits, [], "O").listChanges({ repo: REPO, window: WINDOW, kinds: ["direct_push"] })).rejects.toThrow(/has 101 parents; pr-rla reads at most 100/);
  });
});

describe("GitLab: approvers are paged; approval resets are read by GitLab's own tag (finding 10)", () => {
  const sc = scmScenario();
  const x = scenarioExpectations("gitlab");
  const provider = (fake: ReturnType<typeof fakeGitLab>) => new GitLabProvider({ base_url: GL_BASE, page_size: 3, batch_size: 4 }, { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch, now: () => Date.parse("2026-08-03T00:00:00Z") });
  const list = (fake: ReturnType<typeof fakeGitLab>) => provider(fake).listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request"] });

  it("more than 100 approvers and reviewers are all read (a bot among the later ones is still a bot)", async () => {
    const calls: string[] = [];
    const fake = fakeGitLab(sc, { pageSize: 3, extraUsers: { 3: 130 } });
    const f = fake.fetch;
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === "string" && /approvedBy\(first: 100, after|reviewers\(first: 100, after/.test(init.body)) calls.push(/approvedBy\(first: 100, after/.test(init.body) ? "approvedBy" : "reviewers");
      return f(input, init);
    }) as typeof fetch;
    const p = new GitLabProvider({ base_url: GL_BASE, page_size: 3, batch_size: 4 }, { cwd: ".", env: {}, log: () => {}, fetch: spy, now: () => Date.parse("2026-08-03T00:00:00Z") });
    await p.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request"] });
    expect(calls.sort()).toEqual(["approvedBy", "reviewers"]);
  });

  it("an approval reset in another language is still a reset: GitLab's note tag says so, the @reference says whose", async () => {
    const states = async (o: Parameters<typeof fakeGitLab>[1]) => (await list(fakeGitLab(sc, { pageSize: 3, ...o }))).changes.find((c) => c.id === x.ids.squashMerge)!.reviews.map((r) => `${r.author.login}:${r.state}`);
    const english = await states({});
    expect(english).toContain("carol:DISMISSED");
    expect(await states({ french: true })).toEqual(english);
    // An older instance that does not tag its notes is read by their English text, as before.
    expect(await states({ untagged: true })).toEqual(english);
    // ...and cannot read another language: the reset is missed (this is the limit the tag removes).
    expect(await states({ untagged: true, french: true })).not.toEqual(english);
  });

  it("a tagged reset that names nobody is counted in a diagnostic instead of passing quietly", async () => {
    const r = await list(fakeGitLab(sc, { pageSize: 3, anonymousReset: true }));
    expect(r.diagnostics).toContainEqual({ label: "approval-reset notes that name no approver (approvals may be over-counted)", value: 1 });
  });

  it("buildReviews applies a tagged note whatever its text", () => {
    const u = { username: "carol", bot: false };
    const actor = (a: { username: string } | null) => ({ login: a?.username ?? "ghost", kind: "human" as const });
    const notes = [
      { system: true, body: "a approuvé", createdAt: "2026-08-01T10:00:00Z", author: u, systemNoteMetadata: { action: "approved" } },
      { system: true, body: "approbations réinitialisées pour @carol", createdAt: "2026-08-01T11:00:00Z", author: { username: "pusher", bot: false }, systemNoteMetadata: { action: "approvals_reset" } },
    ];
    const r = buildReviews({ mrAuthor: "bob", notes, approvals: null, reviewers: [], mergedAt: "2026-08-01T12:00:00Z", actor });
    expect(r.map((x) => x.state)).toEqual(["DISMISSED"]);
  });

  it("a diff GitLab excluded (too_large) makes the MR's size unknown: it is flagged, counted, and never undercounted", async () => {
    const fake = fakeGitLab(sc, { pageSize: 3, tooLarge: [5] }); // MR !5 has no GraphQL stats: the REST diffs are counted
    const r = await list(fake);
    const mr5 = r.changes.find((c) => c.id === x.ids.squash5)!;
    expect(mr5.changedLinesUnknown).toBe(true);
    expect(r.changes.filter((c) => c.changedLinesUnknown)).toHaveLength(1);
    expect(r.diagnostics).toContainEqual({ label: "MRs whose diff GitLab excluded (changedLinesUnknown: size unknown)", value: 1 });
    expect(changeRecordProblems(mr5)).toEqual([]);
  });
});

describe("Bitbucket Data Center: a truncated diff is a size unknown (finding 10)", () => {
  it("flags the PR whose diff the server truncated instead of undercounting it", async () => {
    const sc = scmScenario();
    const p = new BitbucketDataCenterProvider({ base_url: DC_BASE, page_size: 3 }, { cwd: ".", env: {}, log: () => {}, fetch: fakeBitbucketDc(sc, { limit: 3 }).fetch });
    const r = await p.listChanges({ repo: "ACME/widgets", window: sc.window, kinds: ["pull_request"] });
    const unknown = r.changes.filter((c) => c.changedLinesUnknown);
    expect(unknown.length).toBeGreaterThan(0);
    expect(r.diagnostics).toContainEqual({ label: "PR diffs truncated by the server (changedLinesUnknown: size unknown)", value: unknown.length });
  });
});

describe("max_changed_lines keeps a change of unknown size in the stratum and says so", () => {
  const change = (n: number, lines: number, unknown = false): ChangeRecord => ({ id: `x:o/r#${n}`, kind: "pull_request", repo: "o/r", url: "u", mergeSha: String(n).repeat(40).slice(0, 40), mergedAt: "2026-08-01T10:00:00Z", author: { login: "bot", kind: "bot" }, mergedBy: { login: "m", kind: "human" }, reviews: [], changedLines: lines, labels: [], ...(unknown ? { changedLinesUnknown: true as const } : {}) });
  it("a big change drops, a small one stays, an unknown one stays and is reported", () => {
    const sel = normalizeSelector({ ...DEFAULT_SELECTOR, max_changed_lines: 200 });
    const r = applySelector([change(1, 500), change(2, 50), change(3, 0, true), change(4, 10_000, true)], sel, "2026-08-02T00:00:00Z");
    expect(r.selected.map((c) => c.id)).toEqual(["x:o/r#2", "x:o/r#3", "x:o/r#4"]);
    expect(r.funnel.slice(-2)).toEqual([{ step: "<= 200 changed lines", count: 3 }, { step: UNKNOWN_SIZE_STEP, count: 2 }]);
    // No limit, no step; no unknown change, no step.
    expect(applySelector([change(3, 0, true)], DEFAULT_SELECTOR, "2026-08-02T00:00:00Z").funnel.map((f) => f.step)).not.toContain(UNKNOWN_SIZE_STEP);
    expect(applySelector([change(2, 50)], sel, "2026-08-02T00:00:00Z").funnel.map((f) => f.step)).not.toContain(UNKNOWN_SIZE_STEP);
  });
  it("changedLinesUnknown must be true when present", () => {
    expect(changeRecordProblems({ ...change(1, 1), changedLinesUnknown: false })).toContain("changedLinesUnknown must be true when present");
  });
});

describe("the pinned head is a commit id and is escaped (finding 8's hardening, in scope of finding 10)", () => {
  it("buildPopulation refuses a head that is not 40-64 lowercase hex characters", async () => {
    const provider = { apiVersion: 1, name: "x", listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }) };
    const args = { repo: REPO, window: { name: "w", ...WINDOW } as never, selector: DEFAULT_SELECTOR, cutoffIso: WINDOW.closesAt };
    for (const bad of ["main", "abc&x=1", "../etc", "A".repeat(40), "a".repeat(39), "a".repeat(65), ""]) await expect(buildPopulation(provider as never, { ...args, head: bad })).rejects.toThrow(/is not a commit id/);
    await expect(buildPopulation(provider as never, { ...args, head: "a".repeat(40) })).resolves.toBeDefined();
    await expect(buildPopulation(provider as never, { ...args, head: "b".repeat(64) })).resolves.toBeDefined();
  });

  it("readManifest rejects a manifest whose repos[].headSha is not a commit id", () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-head-"));
    const manifest = (headSha: unknown) => JSON.stringify({ schema: "pr-rla/manifest/v2", repos: [{ repo: REPO, repoId: null, defaultBranch: "main", headSha }] });
    const paths = { manifest: join(dir, "m.json") } as never;
    writeFileSync(join(dir, "m.json"), manifest("main&evil=1"));
    // U5 moved readManifest to src/api/session.ts, which throws the API's AuditError (CommandError's base).
    expect(() => readManifest(paths)).toThrow(AuditError);
    writeFileSync(join(dir, "m.json"), manifest("a".repeat(40)));
    expect(() => readManifest(paths)).not.toThrow();
    writeFileSync(join(dir, "m.json"), manifest(null));
    expect(() => readManifest(paths)).not.toThrow();
  });

  it("GitLab escapes the head in the history URL", async () => {
    const urls: string[] = [];
    const sc = scmScenario();
    const f = fakeGitLab(sc, { pageSize: 3 }).fetch;
    const p = new GitLabProvider({ base_url: GL_BASE, page_size: 3 }, { cwd: ".", env: {}, log: () => {}, fetch: (async (i: string | URL | Request, init?: RequestInit) => (urls.push(String(i)), f(i, init))) as typeof fetch, now: () => Date.parse("2026-08-03T00:00:00Z") });
    await p.listChanges({ repo: sc.repo, window: sc.window, kinds: ["direct_push"], head: "a&per_page=1" }).catch(() => undefined);
    const history = urls.find((u) => u.includes("/repository/commits?"))!;
    expect(history).toContain("ref_name=a%26per_page%3D1&");
  });
});
