import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import { manifestSha256, type CommitmentRecordV2, type ManifestV2, type SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { fakeOrg, orgSpec, ORG, type FakeOrg } from "./helpers/fake-org.js";
import { setupPoolAudit, type PoolScenario } from "./helpers/pool-scenario.js";

/**
 * U8 at verify, status and sample, on the synthetic org (fixture kind: synthetic): check 5 re-lists the owner, rebuilds
 * each repo from its pinned head and holds the pool to the rule and the registered repos. A repo created after freeze
 * makes it FAIL; a repo that is gone, or that this token cannot read, makes it INCOMPLETE with a count (the U8 fix
 * round; draft 05 §U8 had a WARN). Check 2 holds the manifest to the registered repo set. Every command runs on the
 * scenario's fake clock (test/helpers/fake-clock.ts), which gives real I/O real time.
 */
const MANIFEST = "audit/2026-q3.manifest.json";
const readManifest = (s: PoolScenario) => JSON.parse(readFileSync(join(s.dir, MANIFEST), "utf8")) as ManifestV2;
const org30 = () => fakeOrg(orgSpec({ eligible: 30, archived: 2, forks: 1, scale: 2 }));

async function frozen(org: FakeOrg, o: Parameters<typeof setupPoolAudit>[1] = {}) {
  const s = setupPoolAudit(org, o);
  expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
  await s.advance(12 * 3600_000);
  expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
  return s;
}
const check = async (s: PoolScenario, n: number, ctx = s.ctx) => {
  const r = await s.clock.run(runVerify(ctx, { offline: false }));
  return { report: r, check: r.checks.find((c) => c.n === n)! };
};

describe("verify on an untouched pooled freeze", () => {
  it("passes check 2 and check 5: every repo rebuilt from its pinned head, the rule re-resolved to the same repos", async () => {
    const s = await frozen(org30());
    const { report, check: c5 } = await check(s, 5);
    const m = readManifest(s);
    expect(c5.status).toBe("PASS");
    const f = (n: number) => n.toLocaleString("en-US");
    expect(c5.summary).toBe(`population ${f(m.N)}/${f(m.N)} match`);
    expect(c5.details).toContain("history walked from the frozen heads of 30 repo(s)");
    expect(report.checks.find((c) => c.n === 2)!.status).not.toBe("FAIL");
    expect(report.checks.find((c) => c.n === 2)!.details.join("\n")).toMatch(/commitment|frozen with pr-rla/);
    // Nothing fails. Frozen but not sampled, on self-asserted times: INCOMPLETE, not ok (time round B; U8 asserted ok here).
    expect(report.checks.filter((c) => c.status === "FAIL")).toEqual([]);
    expect(report.checks.find((c) => c.n === 6)!.status).toBe("SKIP");
    expect(report.verdict).toBe("INCOMPLETE");
    expect(report.ok).toBe(false);
  });

  it("offline, check 5 is skipped and the rest still run", async () => {
    const s = await frozen(org30());
    const r = await s.clock.run(runVerify(s.ctx, { offline: true }));
    expect(r.checks.find((c) => c.n === 5)!.status).toBe("SKIP");
    expect(r.checks.find((c) => c.n === 2)!.status).not.toBe("FAIL");
  });
});

describe("a repo created after freeze (FR5.2; test-design U8)", () => {
  it("makes check 5 FAIL when it holds changes in the window, naming the repo and the count", async () => {
    const org = org30();
    const s = await frozen(org);
    org.addRepo({ name: "svc-late", prs: 12, pushes: 2 });
    const { report, check: c5 } = await check(s, 5);
    expect(c5.status).toBe("FAIL");
    expect(c5.summary).toMatch(/^repo acme-org\/svc-late matches the registered rule but is not in the manifest \(\d+ changes landed in the window\)$/);
    expect(report.ok).toBe(false);
  });

  it("does not, when the SCM says it was created after the window closed (it cannot hold a window landing)", async () => {
    const org = org30();
    const s = await frozen(org);
    org.addRepo({ name: "svc-newer", prs: 0, pushes: 0, createdAfterWindow: true, createdAt: "2026-10-09T08:00:00Z" });
    const { check: c5 } = await check(s, 5);
    expect(c5.status).toBe("PASS");
    expect(c5.details).toContain("repo acme-org/svc-newer matches the registered rule but is not in the manifest; it was created 2026-10-09T08:00:00Z, after the window closed, so it cannot hold a window landing");
  });

  it("nor when the SCM gives no creation time but the repo lists no change in the window", async () => {
    const org = org30();
    const s = await frozen(org);
    org.addRepo({ name: "svc-quiet", prs: 0, pushes: 0, createdAfterWindow: true });
    const { check: c5 } = await check(s, 5);
    expect(c5.status).toBe("PASS");
    expect(c5.details).toContain("repo acme-org/svc-quiet matches the registered rule but is not in the manifest; it lists no change in the window, so it cannot change the population");
  });

  it("an empty repo created after freeze is the same", async () => {
    const org = org30();
    const s = await frozen(org);
    org.addRepo({ name: "svc-empty", prs: 0, pushes: 0, empty: true });
    expect((await check(s, 5)).check.status).toBe("PASS");
  });
});

describe("a repo that is gone or unreadable (FR5.2): INCOMPLETE with a count, never a silent pass", () => {
  it("deleted: check 5 is INCOMPLETE, names the repo and how many of its changes were not rebuilt; verify exits 6", async () => {
    const org = org30();
    const s = await frozen(org);
    const m = readManifest(s);
    const gone = `${ORG}/svc-05`;
    const n = m.changes.filter((c) => c.repo === gone).length;
    expect(n).toBeGreaterThan(0);
    org.removeRepo("svc-05");
    const { report, check: c5 } = await check(s, 5);
    expect(c5.status).toBe("INCOMPLETE");
    expect(c5.details).toContain(`INCOMPLETE ${gone}: gone: not in acme-org's listing, and its repo-level metadata answers HTTP 404 (deleted, or hidden from this token): its ${n} changes in the manifest were not rebuilt`);
    expect(c5.summary).toBe(`population ${(m.N - n).toLocaleString("en-US")}/${(m.N - n).toLocaleString("en-US")} match · ${n} changes in 1 repo(s) could not be rebuilt`);
    expect(report).toMatchObject({ ok: false, verdict: "INCOMPLETE" });
    expect(await s.clock.run(verifyCommand(s.ctx, {}))).toBe(6);
  });

  it("listed but unreadable by the verifier's token (403 on its metadata): no access, said differently from gone; the other repos still match", async () => {
    const org = org30();
    const s = await frozen(org);
    const m = readManifest(s);
    org.control.gone.set(`${ORG}/svc-09`, 403);
    org.control.gone.set(`${ORG}/svc-11`, 403);
    const n = m.changes.filter((c) => c.repo === `${ORG}/svc-09` || c.repo === `${ORG}/svc-11`).length;
    const { check: c5 } = await check(s, 5);
    expect(c5.status).toBe("INCOMPLETE");
    expect(c5.details.filter((d) => /^INCOMPLETE acme-org\/svc-(09|11): no access: its repo-level metadata answers HTTP 403/.test(d))).toHaveLength(2);
    expect(c5.summary).toMatch(new RegExp(`${n} changes in 2 repo\\(s\\) could not be rebuilt$`));
  });

  it("not visible to the verifier's token at all, as GitHub hides a private repo (left out of the listing, 404 everywhere): INCOMPLETE, and why", async () => {
    const org = org30();
    const s = await frozen(org);
    org.control.invisible.add(`${ORG}/svc-03`); // private
    org.control.viewer.role = "member";
    const { report, check: c5 } = await check(s, 5);
    expect(c5.status).toBe("INCOMPLETE");
    expect(c5.details.join("\n")).toMatch(/INCOMPLETE acme-org\/svc-03: gone: not in acme-org's listing, and its repo-level metadata answers HTTP 404 \(deleted, or hidden from this token\)/);
    expect(c5.details.join("\n")).toMatch(/INCOMPLETE cannot establish that this token sees every private repository under acme-org: auditor is a member of acme-org, not an owner/);
    expect(report.verdict).toBe("INCOMPLETE");
  });

  it("a gone repo does not hide a real difference in the others", async () => {
    const org = org30();
    const s = await frozen(org);
    org.removeRepo("svc-05");
    const m = readManifest(s);
    // Drop one change of svc-01 from the manifest.
    const victim = m.changes.find((c) => c.repo === `${ORG}/svc-01`)!;
    const body = { ...m, changes: m.changes.filter((c) => c.id !== victim.id), N: m.N - 1 } as Omit<ManifestV2, "sha256"> & { sha256?: string };
    delete body.sha256;
    writeFileSync(join(s.dir, MANIFEST), JSON.stringify({ ...body, sha256: manifestSha256(body as never) }, null, 2));
    const { check: c5 } = await check(s, 5);
    expect(c5.status).toBe("FAIL");
    expect(c5.summary).toMatch(/1 changes on github are missing from the manifest/);
  });
});

describe("a rule the verifier cannot re-list", () => {
  it("is INCOMPLETE: repos added or excluded since freeze would not be seen; every manifest repo is still rebuilt", async () => {
    const org = org30();
    const s = await frozen(org);
    const noListing = ((input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).pathname === `/orgs/${ORG}/repos` ? Promise.resolve(new Response('{"message":"Forbidden"}', { status: 403 })) : org.fetch(input, init))) as typeof fetch;
    const { check: c5 } = await check(s, 5, s.ctxFor(noListing));
    expect(c5.status).toBe("INCOMPLETE");
    expect(c5.details.join("\n")).toMatch(/INCOMPLETE cannot re-list the repositories under acme-org \(.*HTTP 403.*\): repos added, renamed or excluded since freeze would not be seen/);
    expect(c5.summary).toMatch(/^population [\d,]+\/[\d,]+ match · completeness not established \(1 reason\(s\) below\)$/);
  });
});

describe("the manifest is held to the registered repo set (check 2, and check 5 against pruning)", () => {
  const rewrite = (s: PoolScenario, edit: (m: ManifestV2) => ManifestV2) => {
    const m = edit(readManifest(s));
    const { sha256: _o, ...body } = m;
    writeFileSync(join(s.dir, MANIFEST), JSON.stringify({ ...body, sha256: manifestSha256(body as never) }, null, 2));
  };

  it("pruning: a repo dropped from the manifest (with its changes) is found by check 5, even if the manifest is re-hashed", async () => {
    const org = org30();
    const s = await frozen(org);
    const dropped = `${ORG}/svc-12`;
    rewrite(s, (m) => {
      const changes = m.changes.filter((c) => c.repo !== dropped);
      return { ...m, repos: m.repos.filter((r) => r.repo !== dropped), changes, N: changes.length };
    });
    const { report, check: c5 } = await check(s, 5);
    expect(c5.status).toBe("FAIL");
    expect(c5.summary).toMatch(/^registered repo acme-org\/svc-12 is not in the manifest \(\d+ changes landed in the window\)$/);
    // Check 2 FAILs too: the commitment still names the original manifest, and the manifest drops a registered repo.
    const c2 = report.checks.find((c) => c.n === 2)!;
    expect(c2.status).toBe("FAIL");
    expect(c2.details.join("\n")).toMatch(/manifest drops 1 registered repo\(s\) \(e\.g\. acme-org\/svc-12\)/);
  });

  it("padding: a repo outside the registered rule is refused by check 2, with no network", async () => {
    const s = await frozen(org30());
    rewrite(s, (m) => ({ ...m, repos: [...m.repos, { repo: "elsewhere/other", repoId: null, defaultBranch: "main", headSha: null }].sort((a, b) => (a.repo < b.repo ? -1 : 1)) }));
    const r = await s.clock.run(runVerify(s.ctx, { offline: true }));
    const c2 = r.checks.find((c) => c.n === 2)!;
    expect(c2.status).toBe("FAIL");
    expect(c2.details.join("\n")).toMatch(/manifest lists 1 repo\(s\) outside the registered rule \(e\.g\. elsewhere\/other\)/);
  });

  it("a change from a repo the manifest does not list is refused by check 2", async () => {
    const s = await frozen(org30());
    rewrite(s, (m) => ({ ...m, changes: m.changes.map((c, i) => (i === 0 ? { ...c, repo: `${ORG}/svc-unlisted` } : c)) }));
    const r = await s.clock.run(runVerify(s.ctx, { offline: true }));
    expect(r.checks.find((c) => c.n === 2)!.details.join("\n")).toMatch(/manifest has changes from 1 repo\(s\) it does not list \(e\.g\. acme-org\/svc-unlisted\)/);
  });

  it("a list registration: dropping one of the registered repos FAILs check 2", async () => {
    const org = org30();
    const s = await frozen(org, { repos: `[${ORG}/svc-01, ${ORG}/svc-02, ${ORG}/svc-03]` });
    expect((await check(s, 5)).check.status).toBe("PASS");
    rewrite(s, (m) => ({ ...m, repos: m.repos.filter((r) => r.repo !== `${ORG}/svc-03`), changes: m.changes.filter((c) => c.repo !== `${ORG}/svc-03`), N: m.changes.filter((c) => c.repo !== `${ORG}/svc-03`).length }));
    const r = await s.clock.run(runVerify(s.ctx, { offline: true }));
    expect(r.checks.find((c) => c.n === 2)!.details.join("\n")).toMatch(/manifest repos differ from the registered list: 1 registered repo\(s\) missing \(e\.g\. acme-org\/svc-03\)/);
  });
});

describe("a pooled commitment is signed after its manifest's as-of time, never before it (check 2)", () => {
  it("a commitment dated before the manifest's as-of time FAILs, even correctly signed by the audit's own key", async () => {
    const s = await frozen(org30());
    const path = join(s.dir, "audit/2026-q3/manifest-commitment.json");
    const cm = JSON.parse(readFileSync(path, "utf8")) as SignedRecord<CommitmentRecordV2>;
    const m = readManifest(s);
    expect(Date.parse(cm.record.frozenAt)).toBeGreaterThanOrEqual(Date.parse(m.frozenAt));
    // The honest file passes the rule; one dated an hour before the as-of time (still after the window closed) does not.
    expect((await check(s, 2)).check.details.join("\n")).not.toMatch(/before the manifest's as-of time/);
    const earlier = new Date(Date.parse(m.frozenAt) - 3600_000).toISOString().replace(".000Z", "Z");
    writeFileSync(path, JSON.stringify(signRecord({ ...cm.record, frozenAt: earlier }, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem"))), null, 2));
    const c2 = (await check(s, 2)).check;
    expect(c2.status).toBe("FAIL");
    expect(c2.details.join("\n")).toContain(`commitment dated ${earlier}, before the manifest's as-of time ${m.frozenAt}`);
  });
});

describe("FR5.3: one certificate for the pool; per-repo counts are descriptive", () => {
  it("sample draws from the pooled manifest and labels the pool; status prints the per-repo table with the pool-level note", async () => {
    const org = org30();
    const s = await frozen(org);
    await s.advance(13 * 3600_000); // 2026-10-21T01:00Z: R has published
    expect(await s.clock.run(sampleCommand(s.ctx, { through: 40 }))).toBe(0);
    const draws = JSON.parse(readFileSync(join(s.dir, "audit/2026-q3/draws.json"), "utf8")) as { repo: string; draws: { draw: number; changeId: string }[] };
    expect(draws.repo).toBe("acme-org (30 repos)");
    for (const d of draws.draws.slice(0, 12)) expect(await s.clock.run(recordCommand(s.ctx, String(d.draw), "pass", { reviewer: "alice" }))).toBe(0);
    s.out.length = 0;
    expect(await s.clock.run(statusCommand(s.ctx, {}))).toBe(0);
    const text = s.out.join("\n");
    expect(text).toMatch(/per-repo counts are descriptive; the risk limit applies to the pool/);
    expect(text).toMatch(/\n {2}repo +N +draws +fails\n/);
    expect(text).toMatch(/acme-org\/svc-\d\d +\d+ +\d+ +0/);
    s.out.length = 0;
    await s.clock.run(statusCommand(s.ctx, { json: true }));
    const json = JSON.parse(s.out.join("\n")) as { perRepo: { repo: string; N: number; draws: number; fails: number }[] };
    const m = readManifest(s);
    expect(json.perRepo.length).toBe(30);
    expect(json.perRepo.reduce((n, r) => n + r.N, 0)).toBe(m.N);
    expect(json.perRepo.reduce((n, r) => n + r.draws, 0)).toBe(12);
    // And the whole audit still verifies.
    const r = await s.clock.run(runVerify(s.ctx, { offline: false }));
    expect(r.checks.find((c) => c.n === 5)!.status).toBe("PASS");
    expect(r.checks.find((c) => c.n === 6)!.status).toBe("PASS");
  });

  it("status before the freeze does not list a pool (that costs about what the freeze does); it says how to get N", async () => {
    const org = org30();
    const s = setupPoolAudit(org);
    await s.clock.run(registerCommand(s.ctx, {}));
    await s.advance(1000);
    s.out.length = 0;
    const before = org.requests();
    await s.clock.run(statusCommand(s.ctx, {}));
    expect(org.requests()).toBe(before);
    expect(s.out.join("\n")).toMatch(/window closed, not frozen · N so far: not computed for a pool .*"pr-rla freeze --dry-run --estimate" predicts them and "pr-rla freeze --dry-run" counts N/);
  });
});
