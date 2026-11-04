import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import { sampleCommand } from "../src/commands/sample.js";
import { buildPopulation } from "../src/core/population.js";
import { manifestSha256, type CommitmentRecordV2, type ManifestV2, type SignedRecord } from "../src/core/records.js";
import { normalizeSelector } from "../src/core/selector.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import github from "../src/providers/github/index.js";
import { setupAuditRepo, T } from "./helpers/audit-scenario.js";
import { DC_BASE, fakeBitbucketDc } from "./helpers/fake-bitbucket-dc.js";
import { fakeBitbucketCloud } from "./helpers/fake-bitbucket-cloud.js";
import { fakeGitLab, GL_BASE } from "./helpers/fake-gitlab.js";
import { fakeOrg, orgSpec, ORG, type FakeOrg } from "./helpers/fake-org.js";
import { setupPoolAudit, type PoolScenario } from "./helpers/pool-scenario.js";
import { buildScenario, OID, scmScenario, type ScCommit, type ScmScenario } from "./helpers/scm-scenario.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * Round P3 (frozen-head and repo-set integrity): every reproduction of the second adversarial review of U8 (its
 * scratch experiments e1-merge-mask, e2-pool, e7-401 and e8-misc, and the findings they back) as a regression test
 * that fails on 66e3f54 (the integration tip this round started from) and passes after it. This file uses only APIs
 * that existed there (the commands, records and fakes), so it runs against that commit's src too; the new modules'
 * own tests are in p3-head-proof.test.ts. Fixture kind: synthetic (test/helpers/fake-org.ts serves a GitHub org with
 * GitHub's push log; nothing here was recorded).
 */
const ZERO = "0".repeat(40);
const W = "audit/2026-q3";
const MANIFEST = `${W}.manifest.json`;
const CM = `${W}/manifest-commitment.json`;
const REG = `${W}/registration.json`;
const readManifest = (s: { dir: string }) => JSON.parse(readFileSync(join(s.dir, MANIFEST), "utf8")) as ManifestV2;
const readReg = (s: { dir: string }) => JSON.parse(readFileSync(join(s.dir, REG), "utf8")) as { record: Record<string, unknown> };
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const base = (repo: string) => sha1(`${repo}:base`);
const org30 = () => fakeOrg(orgSpec({ eligible: 30, archived: 2, forks: 1, scale: 2 }));
/** The 30-repo org plus one repo that only takes direct pushes: no pull request can stand in for its history. */
const orgWithPushRepo = () => {
  const org = org30();
  org.addRepo({ name: "ops-pushes", prs: 0, pushes: 24 });
  return org;
};
const PUSHES = `${ORG}/ops-pushes`;
type Report = Awaited<ReturnType<typeof runVerify>>;
const check = (r: Report, n: number) => r.checks.find((x) => x.n === n)!;
const lines = (r: Report, n: number) => check(r, n).details.join("\n");

async function registered(org: FakeOrg, o: Parameters<typeof setupPoolAudit>[1] = {}, adv = 12 * 3600_000) {
  const s = setupPoolAudit(org, o);
  expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
  await s.advance(adv);
  return s;
}
async function frozen(org: FakeOrg, before?: () => void, o: Parameters<typeof setupPoolAudit>[1] = {}) {
  const s = await registered(org, o);
  before?.();
  expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
  return s;
}
/** Prospective: registered 2026-06-20, before the window opens; frozen 2026-10-01T12:00Z. */
const PRO = { start: "2026-06-20T00:00:00Z" };
const TO_FREEZE = (103 * 24 + 12) * 3600_000;
async function proRegistered(org: FakeOrg, o: Parameters<typeof setupPoolAudit>[1] = {}) {
  const s = setupPoolAudit(org, { ...PRO, ...o });
  // The SCM on the test's clock: at a freeze on 2026-10-01 the commits dated after it are not there yet.
  org.control.now = () => s.clock.now();
  expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
  return s;
}
const verify = (s: PoolScenario, ctx = s.ctx) => s.clock.run(runVerify(ctx, { offline: false }));
/**
 * An honest pool frozen but not sampled, with no timestamp authority: nothing FAILs, and under time round B's one
 * verdict model it is INCOMPLETE, not VERIFIED (checks 1-3: unproven times; 4: R not yet published; 6-7: not sampled),
 * plus check 5 where a window commit is not placed. These tests are about check 5, which keeps its own status.
 */
function honestButUnsampled(r: Report, alsoIncomplete: number[] = []): void {
  expect(r.checks.filter((c) => c.status === "FAIL")).toEqual([]);
  expect(r.verdict).toBe("INCOMPLETE");
  expect(r.checks.filter((c) => c.status === "INCOMPLETE" || c.status === "SKIP").map((c) => c.n)).toEqual([1, 2, 3, 4, ...alsoIncomplete, 6, 7]);
}

/** What an auditee who holds the audit's signing key can do before R: rewrite the manifest and re-sign the commitment. */
function resign(s: { dir: string }, edit: (m: ManifestV2) => ManifestV2) {
  const m = edit(readManifest(s));
  const { sha256: _old, ...body } = m;
  const sha = manifestSha256(body as never);
  writeFileSync(join(s.dir, MANIFEST), JSON.stringify({ ...body, sha256: sha }, null, 2));
  const cm = JSON.parse(readFileSync(join(s.dir, CM), "utf8")) as SignedRecord<CommitmentRecordV2>;
  writeFileSync(join(s.dir, CM), JSON.stringify(signRecord({ ...cm.record, manifestSha256: sha, N: m.N }, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem"))), null, 2));
}
/** ...and, before the window, the registration (its signature and time are the auditee's too). */
function resignReg(s: { dir: string }, edit: (r: Record<string, unknown>) => Record<string, unknown>) {
  writeFileSync(join(s.dir, REG), JSON.stringify(signRecord(edit(readReg(s).record), loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem"))), null, 2));
}
/** The auditee's own record of the push log follows the edit too (a forged claim: verify reads the log itself). */
const forgeEvidence = (m: ManifestV2, victim: string, head: string): Pick<ManifestV2, "headEvidence"> => (m.headEvidence ? { headEvidence: m.headEvidence.map((e) => (e.repo === victim ? { ...e, headSha: head } : e)) } : {});
const rewind = (victim: string, head: string) => (m: ManifestV2): ManifestV2 => {
  const changes = m.changes.filter((x) => !(x.repo === victim && x.kind === "direct_push"));
  return { ...m, repos: m.repos.map((r) => (r.repo === victim ? { ...r, headSha: head } : r)), changes, N: changes.length, ...forgeEvidence(m, victim, head) };
};

describe("pass 2 finding 1: the frozen head is held to GitHub's push log, never to commit dates or the graph's shape", () => {
  it("E1: a rewound head with the window's direct pushes dropped, then a fast-forward merge [base, real tip] pushed after the window: FAIL, where it was PASS and VERIFIED", async () => {
    const org = orgWithPushRepo();
    const s = await frozen(org);
    const realHead = org.history("ops-pushes").head;
    expect(readManifest(s).changes.filter((x) => x.repo === PUSHES).length).toBeGreaterThan(10);
    resign(s, rewind(PUSHES, base(PUSHES)));
    org.pushCommits("ops-pushes", [{ oid: sha1("mask-merge"), date: "2026-10-20T13:00:00Z", parents: [base(PUSHES), realHead] }], { at: "2026-10-20T13:00:00Z" });
    const r = await verify(s);
    expect(check(r, 2).status).not.toBe("FAIL");
    expect(check(r, 5).status).toBe("FAIL");
    expect(lines(r, 5)).toMatch(new RegExp(`FAIL ${PUSHES}: the frozen head ${base(PUSHES).slice(0, 12)}… was not the default branch's tip at freeze: the push log shows that at 2026-10-20T12:00:00Z the tip was ${realHead.slice(0, 12)}…`));
    expect(r.verdict).toBe("FAILED");
    s.out.length = 0;
    expect(await s.clock.run(verifyCommand(s.ctx, {}))).toBe(1);
  });

  it("E1 on a repo with pull requests: the push log and the stopgap (a window merge the frozen head does not reach) both FAIL it", async () => {
    const org = org30();
    const s = await frozen(org);
    const victim = `${ORG}/svc-08`;
    const realHead = org.history("svc-08").head;
    resign(s, rewind(victim, base(victim)));
    org.pushCommits("svc-08", [{ oid: sha1("mask-merge"), date: "2026-10-20T13:00:00Z", parents: [base(victim), realHead] }], { at: "2026-10-20T13:00:00Z" });
    const r = await verify(s);
    expect(lines(r, 5)).toMatch(/FAIL acme-org\/svc-08: \d+ pull request\(s\) merged in the window have a merge commit that is not reachable from the frozen head [0-9a-f]{12}…/);
    expect(lines(r, 5)).toMatch(/FAIL acme-org\/svc-08: the frozen head [0-9a-f]{12}… was not the default branch's tip at freeze/);
    // Without the push log (a token that cannot read it), the stopgap alone still FAILs it.
    org.control.pushLog.set("*", 403);
    const blind = await verify(s);
    expect(check(blind, 5).status).toBe("FAIL");
    expect(lines(blind, 5)).toMatch(/FAIL acme-org\/svc-08: \d+ pull request\(s\) merged in the window have a merge commit that is not reachable/);
    expect(lines(blind, 5)).not.toMatch(/was not the default branch's tip/);
  });

  it("E1 with no push log to read and no pull request to stand in: INCOMPLETE, never PASS", async () => {
    const org = orgWithPushRepo();
    const s = await frozen(org);
    resign(s, rewind(PUSHES, base(PUSHES)));
    org.pushCommits("ops-pushes", [{ oid: sha1("mask-merge"), date: "2026-10-20T13:00:00Z", parents: [base(PUSHES), org.history("ops-pushes").head] }], { at: "2026-10-20T13:00:00Z" });
    org.control.pushLog.set(PUSHES, 403);
    const r = await verify(s);
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE acme-org\/ops-pushes: \d+ direct push\(es\) dated in the window are on the default branch now but not reachable from the frozen head [0-9a-f]{12}… .*, and there is no push-time evidence to place them \(its push log could not be read \(GitHub GET \/repos\/acme-org\/ops-pushes\/activity.*HTTP 403/);
    expect(r.verdict).toBe("INCOMPLETE");
  });

  it("E1 on a single repo: the same rewind and merge FAIL (master trusted the frozen head; U8 called the merge FR7.2)", async () => {
    const org = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 120, pushes: 25, after: 3 }] });
    const s = setupAuditRepo({ changes: [], provider: "github", fetch: org.fetch });
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const realHead = org.history("widgets").head;
    resign(s, rewind("acme/widgets", base("acme/widgets")));
    org.pushCommits("widgets", [{ oid: sha1("mask-merge"), date: "2026-10-20T13:00:00Z", parents: [base("acme/widgets"), realHead] }], { at: "2026-10-20T13:00:00Z" });
    const r = await runVerify(s.ctx, { offline: false });
    expect(check(r, 5).status).toBe("FAIL");
    expect(lines(r, 5)).toMatch(/FAIL the frozen head [0-9a-f]{12}… was not the default branch's tip at freeze: the push log shows that at 2026-10-20T12:00:00Z the tip was/);
    expect(r.verdict).toBe("FAILED");
  });

  it("padding: a crafted frozen head whose window-dated history stands in for the real pushes, merged with the real tip after the window: FAIL", async () => {
    const org = orgWithPushRepo();
    const s = await frozen(org);
    const realHead = org.history("ops-pushes").head;
    // Three crafted commits dated in the window on the pre-window base, and a merge of them with the real tip pushed after.
    const p1 = { oid: sha1("pad-1"), date: "2026-09-02T10:00:00Z", parents: [base(PUSHES)] };
    const p2 = { oid: sha1("pad-2"), date: "2026-09-03T10:00:00Z", parents: [p1.oid] };
    const p3 = { oid: sha1("pad-3"), date: "2026-09-04T10:00:00Z", parents: [p2.oid] };
    const merge = { oid: sha1("pad-merge"), date: "2026-10-20T13:00:00Z", parents: [p3.oid, realHead] };
    org.pushCommits("ops-pushes", [p1, p2, p3, merge], { at: "2026-10-20T13:00:00Z" });
    // The auditee builds the padded entries with pr-rla's own code, so the frozen rebuild matches them exactly.
    const p = await github.create({}, { cwd: ".", env: {}, log: () => {}, fetch: org.fetch });
    const m0 = readManifest(s);
    const padded = await buildPopulation(p, { repo: PUSHES, window: m0.window, selector: normalizeSelector(m0.selector as never), cutoffIso: m0.frozenAt, head: p3.oid });
    expect(padded.entries).toHaveLength(3);
    resign(s, (m) => {
      const changes = [...m.changes.filter((x) => x.repo !== PUSHES), ...padded.entries].sort((a, b) => (a.id < b.id ? -1 : 1));
      return { ...m, repos: m.repos.map((r) => (r.repo === PUSHES ? { ...r, headSha: p3.oid } : r)), changes, N: changes.length, ...forgeEvidence(m, PUSHES, p3.oid) };
    });
    const r = await verify(s);
    expect(check(r, 5).status).toBe("FAIL");
    expect(lines(r, 5)).toMatch(new RegExp(`FAIL ${PUSHES}: the frozen head ${p3.oid.slice(0, 12)}… was not the default branch's tip at freeze: .*the log never shows it as the branch's tip`));
  });

  it("the branch force-pushed back to before the window after it closed, frozen there honestly, and restored after freeze: FAIL (the tip when the window closed)", async () => {
    const org = orgWithPushRepo();
    const realHead = org.history("ops-pushes").head;
    const s = await frozen(org, () => org.forcePush("ops-pushes", base(PUSHES), "2026-10-10T08:00:00Z"));
    expect(readManifest(s).repos.find((r) => r.repo === PUSHES)!.headSha).toBe(base(PUSHES));
    expect(readManifest(s).headEvidence!.find((e) => e.repo === PUSHES)).toMatchObject({ status: "tip", since: "2026-10-10T08:00:00Z" });
    // Left there: the frozen head is the branch's head now, so nothing differs; the push log still shows what was lost.
    const left = await verify(s);
    expect(check(left, 5).status).toBe("FAIL");
    expect(lines(left, 5)).toMatch(new RegExp(`FAIL ${PUSHES}: 24 change\\(s\\) on the default branch when the window closed \\(its tip was ${realHead.slice(0, 12)}…\\) are not reachable from the frozen head ${base(PUSHES).slice(0, 12)}… .*the branch was rewritten after the window closed \\(e\\.g\\. forced update \\d+ at 2026-10-10T08:00:00Z\\)`));
    // Restored after freeze by a fast-forward merge: still FAIL.
    org.pushCommits("ops-pushes", [{ oid: sha1("restore"), date: "2026-10-20T13:00:00Z", parents: [base(PUSHES), realHead] }], { at: "2026-10-20T13:00:00Z" });
    const restored = await verify(s);
    expect(check(restored, 5).status).toBe("FAIL");
    expect(lines(restored, 5)).toMatch(/FAIL acme-org\/ops-pushes: 24 change\(s\) on the default branch when the window closed/);
  });
});

describe("pass 2 finding 3: honest pushes after freeze are FR7.2, as master says, wherever the push log places them", () => {
  /** Each shape the review listed, pushed onto svc-03 after the freeze (12:00Z) and before or after R; all honest. */
  const shapes: Record<string, (org: FakeOrg) => { missing: boolean }> = {
    "commits dated after the window, pushed after freeze": (org) => {
      const h = org.history("svc-03").head;
      org.pushCommits("svc-03", [{ oid: sha1("p1"), date: "2026-10-22T09:00:00Z", parents: [h] }, { oid: sha1("p2"), date: "2026-10-23T09:00:00Z", parents: [sha1("p1")] }], { at: "2026-10-23T09:05:00Z" });
      return { missing: false };
    },
    "a merge pushed after freeze whose second parent is work dated in the window": (org) => {
      const h = org.history("svc-03");
      const ph = h.commits.find((c) => c.oid === h.head)!.parents[0]!;
      org.pushCommits("svc-03", [{ oid: sha1("lc"), date: "2026-09-30T12:00:00Z", parents: [ph] }, { oid: sha1("lm"), date: "2026-10-25T09:00:00Z", parents: [h.head, sha1("lc")] }], { at: "2026-10-25T09:00:00Z" });
      return { missing: true };
    },
    "a commit dated in the window pushed straight onto the frozen head after freeze": (org) => {
      org.pushCommits("svc-03", [{ oid: sha1("bd"), date: "2026-09-30T20:00:00Z", parents: [org.history("svc-03").head] }], { at: "2026-10-20T15:00:00Z" });
      return { missing: true };
    },
    "a git pull merge pushed after freeze (local work dated in the window on the first parent)": (org) => {
      const h = org.history("svc-03");
      const old = h.commits.find((c) => c.oid === h.head)!.parents[0]!;
      const old2 = h.commits.find((c) => c.oid === old)!.parents[0]!;
      org.pushCommits("svc-03", [{ oid: sha1("local"), date: "2026-09-30T21:00:00Z", parents: [old2] }, { oid: sha1("pull"), date: "2026-10-26T09:00:00Z", parents: [sha1("local"), h.head] }], { at: "2026-10-26T09:00:00Z" });
      return { missing: true };
    },
    "a git pull merge pushed after freeze (local work dated after the window)": (org) => {
      const h = org.history("svc-03");
      const old = h.commits.find((c) => c.oid === h.head)!.parents[0]!;
      org.pushCommits("svc-03", [{ oid: sha1("local2"), date: "2026-10-21T21:00:00Z", parents: [old] }, { oid: sha1("pull2"), date: "2026-10-26T09:00:00Z", parents: [sha1("local2"), h.head] }], { at: "2026-10-26T09:00:00Z" });
      return { missing: false };
    },
    "a fast-forward of local work dated in the window, pushed after freeze": (org) => {
      const h = org.history("svc-03").head;
      org.pushCommits("svc-03", [{ oid: sha1("ff1"), date: "2026-09-29T10:00:00Z", parents: [h] }, { oid: sha1("ff2"), date: "2026-09-30T10:00:00Z", parents: [sha1("ff1")] }], { at: "2026-10-27T10:00:00Z" });
      return { missing: true };
    },
  };

  it.each(Object.keys(shapes))("%s: check 5 PASSes, and nothing FAILs", async (name) => {
    const org = org30();
    const s = await frozen(org);
    const { missing } = shapes[name]!(org);
    const r = await verify(s);
    expect(check(r, 5).status).toBe("PASS");
    honestButUnsampled(r);
    if (missing) expect(lines(r, 5)).toMatch(/commit\(s\) dated in the window reached the default branch after the window closed, not through the frozen head .*: the push log shows [0-9a-f]{12}… was the branch's tip at freeze \(it became the default branch's tip at .*\) and that it reaches everything on the branch when the window closed, so they are not in the population \(FR7\.2\)/);
  });

  it.each(Object.keys(shapes))("%s, with no push log to read: INCOMPLETE where a window commit is missing, never FAIL", async (name) => {
    const org = org30();
    const s = await frozen(org);
    const { missing } = shapes[name]!(org);
    org.control.pushLog.set("*", 404);
    const r = await verify(s);
    expect(check(r, 5).status).toBe(missing ? "INCOMPLETE" : "PASS");
    honestButUnsampled(r, missing ? [5] : []);
  });

  it("the push log's retention: a log that no longer reaches the window's close is no evidence (INCOMPLETE), never a FAIL", async () => {
    const org = org30();
    const s = await frozen(org);
    shapes["a commit dated in the window pushed straight onto the frozen head after freeze"]!(org);
    org.control.pushLog.set(`${ORG}/svc-03`, { keepAfter: "2026-10-15T00:00:00Z" });
    const r = await verify(s);
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE acme-org\/svc-03: 1 direct push\(es\) .*no push-time evidence to place them \(the push log does not reach back to the window's close \(2026-10-01T00:00:00Z\): its oldest update is from 2026-10-20T15:00:00Z\)/);
  });
});

describe("pass 2 finding 3, end to end: an honest push after freeze VERIFIES once the times are proven and the draws issued (time round B)", () => {
  let tsa: MockTsaServer;
  beforeAll(async () => {
    tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  });
  afterAll(async () => {
    await tsa.stop();
  });

  it("a commit dated in the window pushed straight onto the frozen head after freeze: check 5 PASSes with the FR7.2 note, and verify says VERIFIED", async () => {
    const org = org30();
    const s = setupPoolAudit(org, { tsa: { ids: ["test-a", "test-b"], server: tsa }, timestamping: "{ authorities: [test-a, test-b], min_tokens: 2 }" });
    // The org's API on api.github.com; the two authorities on their local mock server.
    const ctx = s.ctxFor((async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new URL(url).hostname === "api.github.com" ? org.fetch(input, init) : globalThis.fetch(input, init);
    }) as typeof fetch);
    const at = () => (tsa.nowMs = s.clock.now());
    at();
    expect(await s.clock.run(registerCommand(ctx, {}))).toBe(0);
    await s.advance(12 * 3600_000);
    at();
    expect(await s.clock.run(freezeCommand(ctx, {}))).toBe(0);
    org.pushCommits("svc-03", [{ oid: sha1("bd-e2e"), date: "2026-09-30T20:00:00Z", parents: [org.history("svc-03").head] }], { at: "2026-10-20T15:00:00Z" });
    await s.advance(13 * 3600_000); // 2026-10-21T01:00Z: R has published
    expect(await s.clock.run(sampleCommand(ctx, {}))).toBe(0);
    const r = await s.clock.run(runVerify(ctx, { offline: false }));
    expect(r.checks.filter((c) => c.status === "FAIL" || c.status === "INCOMPLETE" || c.status === "SKIP"), JSON.stringify(r.checks.map((c) => [c.n, c.status, c.summary]))).toEqual([]);
    expect(check(r, 5).status).toBe("PASS");
    expect(lines(r, 5)).toMatch(/commit\(s\) dated in the window reached the default branch after the window closed, not through the frozen head .*\(FR7\.2\)/);
    expect(r.verdict).toBe("VERIFIED");
  }, 180_000);
});

describe("the freeze records the push log's evidence for every pinned head", () => {
  it("each repo with a pinned head: the update that made it the tip; a log it cannot read: unproven, and a note", async () => {
    const org = org30();
    const s = await frozen(org);
    const m = readManifest(s);
    expect(m.headEvidence!.map((e) => e.repo)).toEqual(m.repos.filter((r) => r.headSha).map((r) => r.repo));
    for (const e of m.headEvidence!) expect(e).toMatchObject({ status: "tip", headSha: m.repos.find((r) => r.repo === e.repo)!.headSha });
    expect(m.headEvidence![0]!.detail).toMatch(/^it became the default branch's tip at 20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ \(update \d+, (fast-forward|created)\)$/);
    const org2 = org30();
    org2.control.pushLog.set(`${ORG}/svc-04`, 403);
    const s2 = await frozen(org2);
    expect(readManifest(s2).headEvidence!.find((e) => e.repo === `${ORG}/svc-04`)).toMatchObject({ status: "unproven", detail: expect.stringMatching(/^its push log could not be read \(GitHub GET .*HTTP 403/) });
    expect(s2.out.join("\n")).toMatch(/note: the push log cannot show 1 frozen head\(s\) were the default branch's tip during the freeze \(acme-org\/svc-04: its push log could not be read/);
  });

  it("check 2 holds the record to the manifest: an entry for a head the manifest does not record is inconsistent", async () => {
    const s = await frozen(org30());
    resign(s, (m) => ({ ...m, headEvidence: m.headEvidence!.map((e, i) => (i === 0 ? { ...e, headSha: "f".repeat(40) } : e)) }));
    const r = await verify(s);
    expect(check(r, 2).status).toBe("FAIL");
    expect(lines(r, 2)).toMatch(/manifest headEvidence names 1 repo\(s\) that are not manifest repos with that head/);
  });
});

describe("pass 2 finding 2: a rule registration must record its repos, and what its token could see", () => {
  it("E4a: a rule registration without registeredRepos FAILs check 2 (an archive before freeze was a WARN, VERIFIED)", async () => {
    const org = org30();
    const s = await proRegistered(org);
    resignReg(s, (rec) => {
      const { registeredRepos: _x, ...rest } = rec;
      return rest;
    });
    await s.advance(TO_FREEZE);
    org.updateRepo("svc-07", { archived: true });
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    const r = await verify(s);
    expect(check(r, 2).status).toBe("FAIL");
    expect(lines(r, 2)).toMatch(/the registration records no registeredRepos for its repo rule: every rule registration must/);
    expect(r.verdict).toBe("FAILED");
  });

  it("E4b: a registration that leaves a repo out, archived before freeze: the archive after its window changes FAILs check 5", async () => {
    const org = org30();
    const s = await proRegistered(org);
    resignReg(s, (rec) => ({ ...rec, registeredRepos: (rec.registeredRepos as { repo: string }[]).filter((x) => !x.repo.endsWith("svc-07")) }));
    await s.advance(TO_FREEZE);
    org.updateRepo("svc-07", { archived: true });
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    const r = await verify(s);
    expect(r.mode).toBe("PROSPECTIVE");
    expect(lines(r, 5)).toMatch(/FAIL repo acme-org\/svc-07 was archived at freeze \(the manifest's listing records it so\), yet \d+ of its changes landed in the window, all after the registration: an archived repository is read-only/);
    expect(r.verdict).toBe("FAILED");
  });

  it("E4c: a fine-grained token at register says loudly that private repos may be missing, signs what it could prove, and verify is INCOMPLETE for them", async () => {
    const org = org30();
    const priv = org.spec.repos.filter((x) => x.visibility === "private").map((x) => `${ORG}/${x.name}`);
    for (const p of priv) org.control.invisible.add(p);
    org.control.viewer.scopes = null;
    const s = await proRegistered(org);
    expect(s.out.join("\n")).toMatch(/WARNING: this token cannot be shown to see every private repository under acme-org \(the token sends no X-OAuth-Scopes header.*\): a private repository it does not see is left out of the registered set, and verify will be INCOMPLETE for private repositories/);
    const reg = readReg(s).record as { registeredRepos: { repo: string }[]; registeredVisibility: { visibility: Record<"public" | "private" | "internal", { complete: boolean | null }> } };
    expect(reg.registeredRepos.some((x) => priv.includes(x.repo))).toBe(false);
    expect(reg.registeredVisibility.visibility.private.complete).toBe(false);
    expect(reg.registeredVisibility.visibility.public.complete).toBe(true);
    org.control.invisible.clear();
    org.control.viewer.scopes = "repo";
    await s.advance(TO_FREEZE);
    // Honest freeze: the private repos are in the pool now; the registration still cannot be shown complete for them.
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    const r = await verify(s);
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE the registered repo set cannot be shown to hold every private repository under acme-org: at registration, the token sends no X-OAuth-Scopes header/);
    expect(r.verdict).toBe("INCOMPLETE");
    // The review's case: one of them archived before freeze is a FAIL (it was active in the window).
    const org3 = org30();
    for (const p of priv) org3.control.invisible.add(p);
    org3.control.viewer.scopes = null;
    const s3 = await proRegistered(org3);
    org3.control.invisible.clear();
    org3.control.viewer.scopes = "repo";
    await s3.advance(TO_FREEZE);
    org3.updateRepo(priv[0]!.split("/")[1]!, { archived: true });
    expect(await s3.clock.run(freezeCommand(s3.ctx, {}))).toBe(0);
    const r3 = await verify(s3);
    expect(lines(r3, 5)).toMatch(new RegExp(`FAIL repo ${priv[0]} was archived at freeze`));
    expect(r3.verdict).toBe("FAILED");
  });
});

describe("pass 2 finding 4: a repo created during the window, after registration, cannot be dropped by an attribute", () => {
  async function withNewRepo(change?: (org: FakeOrg) => void, o: Parameters<typeof setupPoolAudit>[1] = {}) {
    const org = org30();
    const s = await proRegistered(org, o);
    org.addRepo({ name: "svc-new", prs: 40, pushes: 15, createdAt: "2026-07-15T00:00:00Z", ...(o.repos ? { visibility: "private" as const } : {}) });
    await s.advance(TO_FREEZE);
    change?.(org);
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    return { org, s };
  }

  it("E3a: archived before freeze: FAIL (an archived repository is read-only, so it was archived after its window changes)", async () => {
    const { s } = await withNewRepo((org) => org.updateRepo("svc-new", { archived: true }));
    expect(readManifest(s).repos.some((r) => r.repo === `${ORG}/svc-new`)).toBe(false);
    const r = await verify(s);
    expect(lines(r, 5)).toMatch(/FAIL repo acme-org\/svc-new was archived at freeze \(the manifest's listing records it so\), yet \d+ of its changes landed in the window, after it was created on 2026-07-15T00:00:00Z, after the registration/);
    expect(r.verdict).toBe("FAILED");
  });

  it("E3b: never archived, and a re-signed manifest that drops it and records it as archived: FAIL", async () => {
    const { s } = await withNewRepo();
    const victim = `${ORG}/svc-new`;
    resign(s, (m) => {
      const changes = m.changes.filter((x) => x.repo !== victim);
      const repoListing = { ...m.repoListing!, repos: m.repoListing!.repos.map((x) => (x.repo === victim ? { ...x, archived: true, excludedBy: ["archived"] } : x)) };
      return { ...m, repos: m.repos.filter((x) => x.repo !== victim), changes, N: changes.length, repoListing, headEvidence: m.headEvidence!.filter((e) => e.repo !== victim) };
    });
    const r = await verify(s);
    expect(check(r, 2).status).not.toBe("FAIL");
    expect(lines(r, 5)).toMatch(/FAIL repo acme-org\/svc-new was archived at freeze \(the manifest's listing records it so\)/);
    expect(r.verdict).toBe("FAILED");
  });

  it("excluded by its visibility instead (a public-only rule, a private repo created after registration): INCOMPLETE", async () => {
    const { s } = await withNewRepo(undefined, { repos: `{ owner: ${ORG}, visibility: [public] }` });
    const r = await verify(s);
    expect(lines(r, 5)).toMatch(/INCOMPLETE repo acme-org\/svc-new was excluded at freeze \(visibility private\), and \d+ of its changes landed in the window, but it was created on 2026-07-15T00:00:00Z, after the registration, so it could not be registered: whether it was excluded when its changes landed is unverified/);
    expect(r.verdict).toBe("INCOMPLETE");
  });
});

describe("pass 2 finding 5: a repo transferred in after freeze", () => {
  it("E8a: not in the freeze's listing, with window changes: INCOMPLETE with a note that it may be a transfer in (was FAIL)", async () => {
    const org = org30();
    const s = await frozen(org);
    org.addRepo({ name: "acquired", prs: 20, pushes: 5 }); // a transfer keeps GitHub's created_at (2020 here)
    const r = await verify(s);
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE repo acme-org\/acquired matches the registered rule but was not in the freeze's listing, and \d+ of its changes landed in the window: it may have been transferred in after freeze, and provider github gives no transfer events/);
    expect(r.verdict).toBe("INCOMPLETE");
  });
});

describe("pass 2 finding 6: the verifier's own access failing is INCOMPLETE, not fraud", () => {
  it("E7: a token GitHub refuses everywhere (401): INCOMPLETE, exit 6 (was FAILED, exit 1)", async () => {
    const s = await frozen(org30());
    const bad = (async () => new Response('{"message":"Bad credentials"}', { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
    const r = await verify(s, s.ctxFor(bad));
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE acme-org\/svc-00: the verifier's token was refused \(HTTP 401: .*Bad credentials.*\): its access, not the audit, is at fault/);
    expect(lines(r, 5)).not.toMatch(/^FAIL /m);
    s.out.length = 0;
    expect(await s.clock.run(verifyCommand(s.ctxFor(bad), {}))).toBe(6);
  });

  it("any failure that also hits the owner listing is the verifier's (INCOMPLETE); a failure on one repo alone still FAILs", async () => {
    const s = await frozen(org30());
    const broken = (async () => new Response('{"message":"Bad Request"}', { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch;
    const r = await verify(s, s.ctxFor(broken));
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE cannot re-list the repositories under acme-org/);
    expect(lines(r, 5)).toMatch(/INCOMPLETE acme-org\/svc-00: listing it failed \(.*HTTP 400.*\) while the verifier's own access is failing too/);
  });
});

describe("pass 2 finding 8: a gone done-marker is probed again on resume", () => {
  it("E8b: an edited marker that calls a listed repo gone is not signed: the resumed run probes it, lists it, and verify PASSes", async () => {
    const org = org30();
    const list = [1, 2, 3, 4, 5, 6].map((i) => `${ORG}/svc-0${i}`);
    const s = await registered(org, { repos: `[${list.join(", ")}]` });
    org.control.stuck.add(`${ORG}/svc-06`);
    let runId = "";
    await s.clock.run(freezeCommand(s.ctx, {})).catch((e) => (runId = /--resume ([0-9a-f]{64})/.exec((e as Error).message)?.[1] ?? ""));
    expect(runId).toMatch(/^[0-9a-f]{64}$/);
    org.control.stuck.clear();
    const dir = join(s.dir, ".pr-rla/cache/2026-q3", runId, "repos");
    let victim = "";
    for (const f of readdirSync(dir)) {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!victim && m.listed) {
        victim = m.repo;
        writeFileSync(join(dir, f), JSON.stringify({ schema: m.schema, repo: m.repo, gone: { repo: m.repo, repoId: null, status: 404, detail: "edited", probedAt: "2026-10-20T12:00:00Z" } }));
      }
    }
    s.out.length = 0;
    expect(await s.clock.run(freezeCommand(s.ctx, { resume: runId }))).toBe(0);
    expect(s.out.join("\n")).toContain(`freeze: the checkpoint says ${victim} is gone, but it exists; listing it`);
    const m = readManifest(s);
    expect(m.goneRepos ?? []).toEqual([]);
    expect(m.repos.map((r) => r.repo)).toContain(victim);
    const r = await verify(s);
    expect(check(r, 5).status).toBe("PASS");
  });

  it("a marker for a repo that really is gone stays (probed again, the same evidence), so the resumed manifest is the same", async () => {
    const org = org30();
    const list = [1, 2, 3, 4, 5, 6].map((i) => `${ORG}/svc-0${i}`);
    const s = await registered(org, { repos: `[${list.join(", ")}]` });
    org.removeRepo("svc-02");
    org.control.stuck.add(`${ORG}/svc-06`);
    let runId = "";
    await s.clock.run(freezeCommand(s.ctx, {})).catch((e) => (runId = /--resume ([0-9a-f]{64})/.exec((e as Error).message)?.[1] ?? ""));
    org.control.stuck.clear();
    s.out.length = 0;
    expect(await s.clock.run(freezeCommand(s.ctx, { resume: runId }))).toBe(0);
    expect(s.out.join("\n")).toMatch(/acme-org\/svc-02: gone \(from the checkpoint, and probed again: HTTP 404\)/);
    expect(readManifest(s).goneRepos).toMatchObject([{ repo: `${ORG}/svc-02`, status: 404 }]);
  });
});

describe("pass 2 finding 9: GitHub's secondary rate limit is waited out, as GitHub documents, through the broker", () => {
  const SECONDARY = JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." });
  /** svc-04's pull listing answers a body-only secondary limit (403, no retry-after, remaining not 0) `times` times. */
  const limitedFor = (org: FakeOrg, times: number) => {
    let left = times;
    return ((input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === `/repos/${ORG}/svc-04/pulls` && left-- > 0
        ? Promise.resolve(new Response(SECONDARY, { status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4000" } }))
        : org.fetch(input, init)) as typeof fetch;
  };

  it("at least a minute before the first retry, then twice as long each time: the freeze finishes", async () => {
    const org = org30();
    const s = await registered(org);
    const t0 = s.clock.now();
    s.out.length = 0;
    expect(await s.clock.run(freezeCommand(s.ctxFor(limitedFor(org, 3)), {}))).toBe(0);
    const waits = s.out.filter((l) => /svc-04\/pulls; retrying in/.test(l)).map((l) => /retrying in (\d+)s/.exec(l)![1]);
    expect(waits).toEqual(["60", "120", "240"]);
    expect(s.clock.now() - t0).toBeGreaterThanOrEqual(420_000);
    expect(readManifest(s).repos.map((r) => r.repo)).toContain(`${ORG}/svc-04`);
  });

  it("a limit that does not lift: five waits (1, 2, 4, 8, 15 minutes), then the freeze stops resumable (exit 4)", async () => {
    const org = org30();
    const s = await registered(org);
    const t0 = s.clock.now();
    s.out.length = 0;
    let err: { exitCode?: number; message?: string } | null = null;
    await s.clock.run(freezeCommand(s.ctxFor(limitedFor(org, 1000)), {})).catch((e) => (err = e));
    expect(err!.exitCode).toBe(4);
    expect(err!.message).toMatch(/secondary rate limit.*Continue with: pr-rla freeze --resume [0-9a-f]{64}$/);
    expect(s.out.filter((l) => /svc-04\/pulls; retrying in/.test(l)).map((l) => /retrying in (\d+)s/.exec(l)![1])).toEqual(["60", "120", "240", "480", "900"]);
    expect(s.clock.now() - t0).toBeGreaterThanOrEqual(1_800_000);
  });
});

describe("pass 2 finding 10: attribute-excluded repos with window changes are one WARN line", () => {
  it("a public-only rule over an org with private and internal repos: one summary line with the counts; every repo with --verbose and in --json", async () => {
    const org = org30();
    const s = await frozen(org, undefined, { repos: `{ owner: ${ORG}, visibility: [public] }` });
    const r = await verify(s);
    const warns = check(r, 5).details.filter((d) => d.startsWith("WARN "));
    const hidden = org.spec.repos.filter((x) => (x.visibility ?? "public") !== "public" && !x.archived && !x.fork).map((x) => `${ORG}/${x.name}`);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(new RegExp(`^WARN ${hidden.length} repo\\(s\\) excluded only by attributes their owners can change \\(name, archive state, visibility\\) have [\\d,]+ changes in the window that are not in the population \\(e\\.g\\. .*\\): the registration came after the window opened, so a change made before it cannot be detected; each is listed with --verbose and in --json$`));
    expect(check(r, 5).verbose!.map((l) => /^WARN repo (\S+)/.exec(l)![1]).sort()).toEqual(hidden.sort());
    s.out.length = 0;
    await s.clock.run(verifyCommand(s.ctx, {}));
    expect(s.out.filter((l) => /^ +WARN repo /.test(l))).toHaveLength(0);
    s.out.length = 0;
    await s.clock.run(verifyCommand(s.ctx, { verbose: true }));
    expect(s.out.filter((l) => /^ +WARN repo /.test(l))).toHaveLength(hidden.length);
    s.out.length = 0;
    await s.clock.run(verifyCommand(s.ctx, { json: true }));
    expect((JSON.parse(s.out.filter((l) => !l.startsWith("ERR ")).join("\n")) as Report).checks.find((c) => c.n === 5)!.verbose).toHaveLength(hidden.length);
  });
});

describe("the GitHub visibility proof: the org's own count, OAuth App tokens, and GitHub App installations", () => {
  it("an owner's listing is held to GitHub's total_private_repos when GitHub sends it: a listing that shows fewer is INCOMPLETE", async () => {
    const org = org30();
    org.control.orgTotalPrivate = "auto";
    const s = await frozen(org);
    expect(check(await verify(s), 5).status).toBe("PASS");
    org.control.orgTotalPrivate = 99;
    const r = await verify(s);
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE cannot establish that this token sees every private repository under acme-org: the listing shows 7 private or internal repositories, but GitHub's total_private_repos for acme-org counts 99, so it is missing some/);
  });

  it("an OAuth App token (gho_, as the gh CLI's), which OAuth App access restrictions can limit to public repos: complete only with the org's count", async () => {
    const org = org30();
    const s = await frozen(org);
    const gho = { ...s.ctx, env: { GITHUB_TOKEN: "gho_synthetic000000000000000000000000000" } };
    const r = await verify(s, gho);
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/the token is an OAuth App token \(gho_\), which the org's OAuth App access restrictions can limit to public repositories with no response saying so, and GitHub did not send the org's total_private_repos/);
    org.control.orgTotalPrivate = "auto";
    expect(check(await verify(s, gho), 5).status).toBe("PASS");
  });

  it("a GitHub App installation token: complete when GitHub says it was installed on all repositories, not when on selected ones", async () => {
    const org = org30();
    const s = await frozen(org);
    org.control.viewer.installation = { selection: "all" };
    const all = await verify(s);
    expect(check(all, 5).status).toBe("PASS");
    expect(lines(all, 5)).toMatch(/private repositories under acme-org: listed completely \(a GitHub App installation on acme-org with access to all of its repositories/);
    org.control.viewer.installation = { selection: "selected" };
    const some = await verify(s);
    expect(check(some, 5).status).toBe("INCOMPLETE");
    expect(lines(some, 5)).toMatch(/GitHub does not say it was installed on every repository of acme-org \(GET \/installation\/repositories: repository_selection "all"\)/);
  });
});

describe("pass 2 finding 1 on every built-in: the merge-mask on a single repo never passes", () => {
  type Fake = { fetch: typeof fetch };
  const firstParents = (sc: ScmScenario) => {
    const chain: ScCommit[] = [];
    for (let c = sc.byOid.get(sc.head); c; c = c.parents[0] ? sc.byOid.get(c.parents[0]) : undefined) chain.unshift(c);
    return chain;
  };
  const cases: [string, string, (sc: ScmScenario, updates?: { at: string; before: string; after: string; action?: "pushed" | "created" }[]) => Fake][] = [
    ["gitlab", `{ use: gitlab, options: { base_url: "${GL_BASE}" } }`, (sc, updates) => fakeGitLab(sc, { pageSize: 100, ...(updates ? { updates } : {}) })],
    ["bitbucket-cloud", "bitbucket-cloud", (sc) => fakeBitbucketCloud(sc, { pageLen: 50 })],
    ["bitbucket-data-center", `{ use: bitbucket-data-center, options: { base_url: "${DC_BASE}" } }`, (sc) => fakeBitbucketDc(sc, { limit: 50 })],
  ];
  it.each(cases)("%s: a head rewound to its first commit, then [that commit, the real tip] pushed after the window: FAIL", async (name, provider, make) => {
    const sc = scmScenario();
    let fake = make(sc);
    const via = ((input: string | URL | Request, init?: RequestInit) => fake.fetch(input, init)) as typeof fetch;
    const s = setupAuditRepo({ changes: [], provider, fetch: via });
    // Data Center names a repo by its project key.
    const repo = name === "bitbucket-data-center" ? "ACME/widgets" : "acme/widgets";
    writeFileSync(join(s.dir, ".pr-rla.yml"), readFileSync(join(s.dir, ".pr-rla.yml"), "utf8").replace("repo: acme/widgets", `repo: ${repo}`));
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    expect(readManifest(s).repos[0]!.headSha).toBe(sc.head);
    const first = OID("B0");
    resign(s, rewind(repo, first));
    const merge: ScCommit = { ...sc.byOid.get(sc.head)!, oid: "5e".repeat(20), date: "2026-10-20T13:00:00Z", authorDate: "2026-10-20T13:00:00Z", parents: [first, sc.head], subject: "merge pushed after the window" };
    const later = buildScenario({ repo: sc.repo, head: merge.oid, window: sc.window, commits: [...sc.commits, merge], prs: sc.prs });
    // The SCM's own record: everything pushed when it was, then the merge (GitLab keeps one; the Bitbuckets do not).
    const chain = firstParents(sc);
    fake = make(later, [...chain.map((c, i) => ({ at: c.date, before: i ? chain[i - 1]!.oid : ZERO, after: c.oid, action: (i ? "pushed" : "created") as "pushed" | "created" })), { at: merge.date, before: sc.head, after: merge.oid }]);
    const r = await runVerify(s.ctx, { offline: false });
    expect(check(r, 5).status).toBe("FAIL");
    expect(lines(r, 5)).toMatch(/FAIL \d+ pull request\(s\) merged in the window have a merge commit that is not reachable from the frozen head/);
    if (name === "gitlab") expect(lines(r, 5)).toMatch(/FAIL the frozen head [0-9a-f]{12}… was not the default branch's tip at freeze/);
    expect(r.verdict).toBe("FAILED");
  });
});

describe("what the round leaves INCOMPLETE rather than PASS", () => {
  it("a rule registration that does not record what its token could see (written before P3): INCOMPLETE for private and internal repos", async () => {
    const org = org30();
    const s = await registered(org);
    resignReg(s, (rec) => {
      const { registeredVisibility: _v, ...rest } = rec;
      return rest;
    });
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    const r = await verify(s);
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE the registration does not record what its token could see \(registeredVisibility\), so the registered repo set cannot be shown to hold every private repository under acme-org/);
  });

  it("a repo excluded by its visibility, with window changes and no creation time from the SCM: INCOMPLETE (whether it existed at registration is unknown)", async () => {
    const org = org30();
    org.addRepo({ name: "svc-nodate", prs: 10, pushes: 3, visibility: "private", createdAt: null });
    const s = await frozen(org, undefined, { repos: `{ owner: ${ORG}, visibility: [public] }` });
    const r = await verify(s);
    expect(lines(r, 5)).toMatch(/INCOMPLETE repo acme-org\/svc-nodate was excluded at freeze \(visibility private\), and \d+ of its changes landed in the window, but provider github gives no creation time, so whether it existed at registration is unknown/);
  });

  it("a branch force-pushed after the window closed, off a pull request merged in it: freeze warns, verify FAILs (the stopgap)", async () => {
    const org = org30();
    const h = org.history("svc-05");
    // Back to the commit before the last pull request's merge (the window's last landings go with it).
    const before = h.commits.find((c) => c.oid === h.commits.filter((x) => x.prs?.length && Date.parse(x.date) < Date.parse("2026-10-01T00:00:00Z")).at(-1)!.oid)!.parents[0]!;
    const s = await frozen(org, () => org.forcePush("svc-05", before, "2026-10-12T00:00:00Z"));
    expect(s.out.join("\n")).toMatch(/warning: in 1 repo\(s\) \(acme-org\/svc-05: github:acme-org\/svc-05#\d+.*\) a pull request merged in the window is not reachable from the default branch's head: the branch was rewritten after it merged, and verify will FAIL check 5/);
    expect(s.out.join("\n")).toMatch(/note: 1 repo\(s\) had their default branch updated after the window closed by an update github does not call a fast-forward \(e\.g\. acme-org\/svc-05\)/);
    const r = await verify(s);
    expect(lines(r, 5)).toMatch(/FAIL acme-org\/svc-05: 1 pull request\(s\) merged in the window have a merge commit that is not reachable from the frozen head/);
    expect(r.verdict).toBe("FAILED");
  });
});
