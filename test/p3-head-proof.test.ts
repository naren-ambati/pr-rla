import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { analysePushLog } from "../src/core/head-proof.js";
import { checkListed } from "../src/core/population.js";
import { normalizeSelector } from "../src/core/selector.js";
import github, { GitHubProvider } from "../src/providers/github/index.js";
import { GitLabProvider } from "../src/providers/gitlab/index.js";
import { NO_COMMIT, type ChangeRecord, type PushLogEvent } from "../src/sdk/provider.js";
import { runProviderConformance, type ConformanceFixture } from "../src/testing/index.js";
import { fakeGitLab, GL_BASE } from "./helpers/fake-gitlab.js";
import { fakeOrg, orgSpec, ORG, type FakeOrg } from "./helpers/fake-org.js";
import { OID, scmScenario } from "./helpers/scm-scenario.js";

/**
 * Round P3's new pieces on their own (fixture kind: synthetic): the push log analysis (src/core/head-proof.ts), the
 * built-ins' push logs and reachability stopgap at the provider level, the listing contract for `unreachable`, and the
 * kit's opt-in `push-log` check. The end-to-end reproductions are in p3-pool-head.test.ts.
 */
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const base = (repo: string) => sha1(`${repo}:base`);

describe("the built-ins' push logs and reachability (provider level)", () => {
  it("GitHub: the push log pages back to the window's close, newest first, kinds mapped, the branch's own updates only", async () => {
    const org = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 120, pushes: 25, after: 3 }] });
    const p = new GitHubProvider({ page_size: 50 }, { cwd: ".", env: {}, log: () => {}, fetch: org.fetch });
    const log = await p.pushLog({ repo: "acme/widgets", branch: "main", since: "2026-10-01T00:00:00Z" });
    expect(log.events[0]).toMatchObject({ after: org.history("widgets").head, kind: "fast-forward" });
    expect(Date.parse(log.events.at(-1)!.at)).toBeLessThanOrEqual(Date.parse("2026-10-01T00:00:00Z"));
    expect(log.events.length).toBeLessThan(org.activity("widgets").length); // it stopped once it reached the close
    expect(log.limitations![0]).toMatch(/GitHub documents no retention/);
    const all = await p.pushLog({ repo: "acme/widgets", branch: "main", since: "2000-01-01T00:00:00Z" });
    expect(all.events.at(-1)).toMatchObject({ before: NO_COMMIT, kind: "created" });
    expect(all.events.map((e) => e.kind).filter((k) => k === "fast-forward")).toHaveLength(all.events.length - 1);
    expect(await p.pushLog({ repo: "acme/widgets", branch: "release", since: "2000-01-01T00:00:00Z" })).toMatchObject({ events: [] });
  });

  it("GitHub: from a head older than the window's merges, listChanges names the merges it cannot reach (confirmed by compare); from the real head, none", async () => {
    const org = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 120, pushes: 25, after: 3 }] });
    const p = new GitHubProvider({}, { cwd: ".", env: {}, log: () => {}, fetch: org.fetch });
    const req = { repo: "acme/widgets", window: { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" }, kinds: ["pull_request", "direct_push"] as ("pull_request" | "direct_push")[] };
    expect((await p.listChanges(req)).unreachable).toEqual([]);
    const old = await p.listChanges({ ...req, head: base("acme/widgets") });
    expect(old.unreachable).toHaveLength(3);
    for (const id of old.unreachable!) expect(old.changes.find((c) => c.id === id)!.kind).toBe("pull_request");
    // PRs only: no history walk, so nothing is claimed either way.
    expect((await p.listChanges({ ...req, kinds: ["pull_request"], head: base("acme/widgets") })).unreachable).toBeUndefined();
  });

  it("GitLab: the push log from project events, the default branch's only, of unknown kind; a bulk push is a gap; MRs a head cannot reach", async () => {
    const sc = scmScenario();
    const fake = fakeGitLab(sc, { pageSize: 100 });
    const p = new GitLabProvider({ base_url: GL_BASE }, { cwd: ".", env: {}, log: () => {}, fetch: fake.fetch });
    const log = await p.pushLog({ repo: "acme/widgets", branch: "main", since: "2026-08-02T00:00:00Z" });
    expect(log.events[0]).toMatchObject({ after: sc.head, kind: "unknown" });
    expect(log.limitations![0]).toMatch(/GitLab removes project events older than three years/);
    const proof = analysePushLog(log, { head: sc.head, window: { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" }, from: "2026-08-03T00:00:00Z", until: "2026-08-04T00:00:00Z" });
    expect(proof).toMatchObject({ kind: "proven" });
    const bulk = fakeGitLab(sc, { pageSize: 100, updates: [{ at: "2026-07-31T23:00:00Z", before: NO_COMMIT, after: OID("B0"), action: "created" }, { at: "2026-08-01T12:00:00Z", before: "", after: "" }, { at: "2026-08-02T10:00:00Z", before: OID("P9b"), after: sc.head }] });
    // A bulk push event names no ref or commits; the fake renders an empty before/after as GitLab's nulls.
    const p2 = new GitLabProvider({ base_url: GL_BASE }, { cwd: ".", env: {}, log: () => {}, fetch: bulk.fetch });
    const withGap = await p2.pushLog({ repo: "acme/widgets", branch: "main", since: "2026-08-01T00:00:00Z" });
    expect(analysePushLog(withGap, { head: sc.head, window: { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" }, from: "2026-08-03T00:00:00Z", until: "2026-08-04T00:00:00Z" })).toMatchObject({ kind: "none", reason: expect.stringMatching(/the push log has a gap/) });
    const req = { repo: "acme/widgets", window: { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" }, kinds: ["pull_request", "direct_push"] as ("pull_request" | "direct_push")[] };
    expect((await p.listChanges(req)).unreachable).toEqual([]);
    expect((await p.listChanges({ ...req, head: OID("S12") })).unreachable!.length).toBeGreaterThan(0);
  });
});

describe("the push log, analysed (src/core/head-proof.ts)", () => {
  const WIN = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" };
  const span = { from: "2026-10-20T12:00:00Z", until: "2026-10-21T00:00:00Z" };
  const h = (t: string) => sha1(t);
  const e = (id: string, at: string, before: string, after: string, kind: PushLogEvent["kind"] = "fast-forward"): PushLogEvent => ({ id, at, before, after, kind });
  /** created at a, then b in the window, c after it (before freeze), and d after freeze: newest first. */
  const log = [e("4", "2026-10-25T00:00:00Z", h("c"), h("d")), e("3", "2026-10-05T00:00:00Z", h("b"), h("c")), e("2", "2026-08-01T00:00:00Z", h("a"), h("b")), e("1", "2026-06-01T00:00:00Z", NO_COMMIT, h("a"), "created")];

  it("proven: the tip at the freeze; the tip when the window closed; what came after", () => {
    const p = analysePushLog({ events: log }, { head: h("c"), window: WIN, ...span });
    expect(p).toMatchObject({ kind: "proven", since: "2026-10-05T00:00:00Z", event: { id: "3" }, tipAtClose: h("b"), rewrites: [], after: [{ id: "4" }], forcedInWindow: [] });
    // A head that became the tip during the freeze span (a pooled freeze lists its repos over hours) is proven too.
    expect(analysePushLog({ events: log }, { head: h("d"), window: WIN, from: span.from, until: "2026-10-26T00:00:00Z" })).toMatchObject({ kind: "proven", since: "2026-10-25T00:00:00Z" });
  });

  it("disproven: a head the branch had only before, or never", () => {
    expect(analysePushLog({ events: log }, { head: h("b"), window: WIN, ...span })).toMatchObject({ kind: "disproven", reason: expect.stringMatching(/the tip was [0-9a-f]{12}… \(since 2026-10-05T00:00:00Z, update 3\).*the log shows it as the tip only from 2026-08-01T00:00:00Z, outside the freeze/) });
    expect(analysePushLog({ events: log }, { head: h("x"), window: WIN, ...span })).toMatchObject({ kind: "disproven", reason: expect.stringMatching(/the log never shows it as the branch's tip/) });
  });

  it("a force push after the close is a rewrite the caller must check; one inside the window is reported", () => {
    const forced = [e("5", "2026-10-06T00:00:00Z", h("c"), h("z"), "forced"), ...log.slice(1)];
    expect(analysePushLog({ events: forced }, { head: h("z"), window: WIN, ...span })).toMatchObject({ kind: "proven", tipAtClose: h("b"), rewrites: [{ id: "5", kind: "forced" }] });
    const inWindow = [e("3", "2026-10-05T00:00:00Z", h("y"), h("c")), e("2b", "2026-08-02T00:00:00Z", h("b"), h("y"), "forced"), ...log.slice(2)];
    expect(analysePushLog({ events: inWindow }, { head: h("c"), window: WIN, ...span })).toMatchObject({ kind: "proven", forcedInWindow: [{ id: "2b" }] });
  });

  it("none: a log that does not reach the close, one with a gap, a malformed one; a branch created after the close has no tip then", () => {
    expect(analysePushLog({ events: log.slice(0, 2) }, { head: h("c"), window: WIN, ...span })).toMatchObject({ kind: "none", reason: expect.stringMatching(/does not reach back to the window's close \(2026-10-01T00:00:00Z\): its oldest update is from 2026-10-05T00:00:00Z/) });
    expect(analysePushLog({ events: [] }, { head: h("c"), window: WIN, ...span })).toMatchObject({ kind: "none" });
    const gap = [log[0]!, e("3", "2026-10-05T00:00:00Z", h("q"), h("c")), ...log.slice(2)];
    expect(analysePushLog({ events: gap }, { head: h("c"), window: WIN, ...span })).toMatchObject({ kind: "none", reason: expect.stringMatching(/the push log has a gap: update 3 at 2026-10-05T00:00:00Z starts from [0-9a-f]{12}…, but the tip before it was/) });
    expect(analysePushLog({ events: [{ ...log[0]!, at: "yesterday" }] }, { head: h("c"), window: WIN, ...span })).toMatchObject({ kind: "none", reason: expect.stringMatching(/malformed/) });
    const late = [e("2", "2026-10-15T00:00:00Z", h("m"), h("n")), e("1", "2026-10-10T00:00:00Z", NO_COMMIT, h("m"), "created")];
    expect(analysePushLog({ events: late }, { head: h("n"), window: WIN, ...span })).toMatchObject({ kind: "proven", tipAtClose: null });
  });

  it("the listing contract: `unreachable` may name only pull requests of the listing", () => {
    const pr: ChangeRecord = { id: "github:acme/a#1", kind: "pull_request", repo: "acme/a", url: "u", mergeSha: h("m1"), mergedAt: "2026-08-01T00:00:00Z", author: { login: "bob", kind: "human" }, mergedBy: { login: "m", kind: "human" }, reviews: [], changedLines: 1, labels: [] };
    const args = { repo: "acme/a", window: WIN, selector: normalizeSelector({ kinds: ["pull_request", "direct_push"], unreviewed: "any" }) };
    expect(() => checkListed("github", { changes: [pr], defaultBranch: "main", limitations: [], unreachable: ["github:acme/a#1"] }, args)).not.toThrow();
    expect(() => checkListed("github", { changes: [pr], defaultBranch: "main", limitations: [], unreachable: ["github:acme/a#2"] }, args)).toThrow(/says "github:acme\/a#2" is unreachable from the head, but it is not a pull request of the listing/);
  });
});

describe("kit: push-log is an opt-in check (P3)", () => {
  const WIN = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" };
  const only = (r: Awaited<ReturnType<typeof runProviderConformance>>) => r.results.filter((x) => x.check === "push-log");
  const fixture = (org: FakeOrg, over: Partial<ConformanceFixture> = {}): ConformanceFixture => ({ name: "synthetic org", request: { repo: `${ORG}/svc-00`, window: WIN, kinds: ["pull_request", "direct_push"] }, expect: {}, pushLog: { branch: "main", since: WIN.closesAt, head: org.history("svc-00").head }, ...over });

  it("the GitHub and GitLab built-ins pass it; a fixture without it adds no result", async () => {
    const org = fakeOrg(orgSpec({ eligible: 2 }));
    expect(only(await runProviderConformance((_f, h) => github.create({}, h.context({ fetch: org.fetch, env: { GITHUB_TOKEN: "x" } })) as never, [fixture(org)]))).toEqual([{ fixture: "synthetic org", check: "push-log", ok: true }]);
    expect(only(await runProviderConformance((_f, h) => github.create({}, h.context({ fetch: org.fetch })) as never, [{ ...fixture(org), pushLog: undefined } as ConformanceFixture]))).toEqual([]);
    const sc = scmScenario();
    const gl = { name: "gitlab scenario", request: { repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] as ("pull_request" | "direct_push")[] }, expect: {}, pushLog: { branch: "main", since: sc.window.closesAt, head: sc.head } };
    expect(only(await runProviderConformance((_f, h) => new GitLabProvider({ base_url: GL_BASE }, h.context({ fetch: fakeGitLab(sc, { pageSize: 100 }).fetch })), [gl]))).toEqual([{ fixture: "gitlab scenario", check: "push-log", ok: true }]);
  });

  it("fails a provider without pushLog, one whose log is out of order or does not reach `since`, and one that returns an empty log for a 403", async () => {
    const org = fakeOrg(orgSpec({ eligible: 2 }));
    const head = org.history("svc-00").head;
    const stub = (pushLog?: () => Promise<unknown>) => ({ apiVersion: 1, name: "stub", listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }), ...(pushLog ? { pushLog } : {}) }) as never;
    expect(only(await runProviderConformance(stub(), [fixture(org)]))[0]).toMatchObject({ ok: false, message: "the fixture expects pushLog, but the provider implements none" });
    const shuffled = [{ id: "1", at: "2026-06-01T00:00:00Z", before: NO_COMMIT, after: head, kind: "created" }, { id: "2", at: "2026-10-05T00:00:00Z", before: head, after: head, kind: "fast-forward" }];
    expect(only(await runProviderConformance(stub(async () => ({ events: shuffled })), [fixture(org)]))[0]!.message).toMatch(/updates are not newest first/);
    expect(only(await runProviderConformance(stub(async () => ({ events: [{ id: "9", at: "2026-10-15T00:00:00Z", before: sha1("x"), after: head, kind: "fast-forward" }] })), [fixture(org)]))[0]!.message).toMatch(/the log does not reach back to 2026-10-01T00:00:00Z/);
    const swallow = (_f: unknown, h: { context: (b: { fetch: typeof fetch }) => { fetch: typeof fetch } }) => {
      const ctx = h.context({ fetch: org.fetch });
      return { apiVersion: 1, name: "swallow", listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }), pushLog: async () => ((await ctx.fetch(`https://api.github.com/repos/${ORG}/svc-00/activity`)).ok ? { events: org.activity("svc-00").reverse().map((a) => ({ id: String(a.id), at: a.timestamp, before: a.before, after: a.after, kind: a.activity_type === "branch_creation" ? "created" : "fast-forward" })) } : { events: [] }) };
    };
    expect(only(await runProviderConformance(swallow as never, [fixture(org)]))[0]!.message).toMatch(/with every request answered 403, pushLog returned 0 update\(s\) instead of throwing/);
  });
});

describe("checkPool: an exclusion by what a repo is that no longer holds", () => {
  it("recorded as a fork at freeze but not one now, with window changes: INCOMPLETE; still a fork: nothing", async () => {
    const { checkPool } = await import("../src/core/rebuild.js");
    const WIN = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" };
    const sel = normalizeSelector({ kinds: ["pull_request", "direct_push"], unreviewed: "any" });
    const ref = (repo: string, fork: boolean) => ({ repo, id: `id-${repo}`, defaultBranch: "main", archived: false, fork, visibility: "public" as const, createdAt: "2020-01-01T00:00:00Z" });
    const pr = (repo: string): ChangeRecord => ({ id: `x:${repo}#1`, kind: "pull_request", repo, url: "u", mergeSha: sha1(repo), mergedAt: "2026-08-01T00:00:00Z", author: { login: "bob", kind: "human" }, mergedBy: { login: "m", kind: "human" }, reviews: [], changedLines: 1, labels: [] });
    const provider = (forkNow: boolean) => ({ apiVersion: 1, name: "stub", listRepos: async () => [ref("acme/a", false), ref("acme/x", forkNow)], listChanges: async (req: { repo: string }) => ({ changes: [pr(req.repo)], defaultBranch: "main", limitations: [] }) });
    const listing = { owner: "acme", identity: null, visibility: { public: { listed: 2, complete: true, reason: "" }, private: { listed: 0, complete: null, reason: "" }, internal: { listed: 0, complete: null, reason: "" } }, repos: [{ repo: "acme/a", repoId: "id-acme/a", defaultBranch: "main", archived: false, fork: false, visibility: "public" as const, createdAt: null, excludedBy: [] }, { repo: "acme/x", repoId: "id-acme/x", defaultBranch: "main", archived: false, fork: true, visibility: "public" as const, createdAt: null, excludedBy: ["fork"] }] };
    const input = { set: { kind: "rule" as const, owner: "acme", include: ["*"], exclude: [], archived: false, forks: false, visibility: ["public" as const] }, registered: [{ repo: "acme/a", repoId: "id-acme/a" }], mode: "RETROSPECTIVE" as const, repos: [{ repo: "acme/a", repoId: "id-acme/a", defaultBranch: "main", headSha: null }], listing, gone: [], window: WIN, selector: sel };
    expect((await checkPool(provider(false) as never, input)).lines.join("\n")).toMatch(/INCOMPLETE repo acme\/x was excluded at freeze as fork \(the manifest's listing records it so\), which it is not now, and 1 of its changes landed in the window/);
    expect((await checkPool(provider(true) as never, input)).lines.join("\n")).not.toMatch(/acme\/x/);
  });
});
