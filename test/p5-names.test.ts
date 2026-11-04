import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import { sampleCommand } from "../src/commands/sample.js";
import { obtainTimestamps } from "../src/api/write/timestamps.js";
import { trustFor } from "../src/api/session.js";
import { compareChangeIds, manifestSha256, type CommitmentRecordV2, type DrawsFile, type ManifestV2, type RegistrationRecordV2, type SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { fakeOrg, orgSpec, ORG } from "./helpers/fake-org.js";
import { setupPoolAudit, type PoolScenario } from "./helpers/pool-scenario.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * P5, "draws that cannot be steered", finding 1 (the second review's `rvp2-rename-grind`, `rvp2-name-grind` and
 * `rvp2-name-certify`, synthetic: U8's fake org, mock authorities, the recorded beacon). Before, a pooled manifest's repo
 * names set the canonical order the draws index, so renaming a repository between freezes, or respelling it in a
 * hand-made manifest (case included), gave another sample from one registration; every one verified. Now the order is by
 * draw key (contracts.md §5): a rule pool's repositories by stable id, a repo's or a list's by the registered path. And
 * check 2 FAILs a name the auditee picked: a list or repo name not byte-equal to the registered one, a rule repo named
 * neither as registered nor as the SCM names it now (a former name the SCM still resolves to it is noted).
 */
const W = "audit/2026-q3";
const MANIFEST = `${W}.manifest.json`;
const CM = `${W}/manifest-commitment.json`;
const REG = `${W}/registration.json`;
const DRAWS = `${W}/draws.json`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

let tsa: MockTsaServer;
beforeAll(async () => {
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
});
afterAll(async () => tsa.stop());

const read = <T>(s: PoolScenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as T;
const at = (s: PoolScenario) => (tsa.nowMs = s.clock.now());

/** A pooled audit on U8's fake org, both mock authorities registered (every time PROVEN), routed to the org. */
function poolAudit(o: { eligible: number; scale: number; repos?: string }) {
  const org = fakeOrg(orgSpec({ eligible: o.eligible, scale: o.scale }));
  const s = setupPoolAudit(org, { ...(o.repos ? { repos: o.repos } : {}), tsa: { ids: ["test-a", "test-b"], server: tsa }, timestamping: "{ authorities: [test-a, test-b], min_tokens: 2 }" });
  // GitHub to the org, everything else (the mock authorities) to the network stack.
  s.ctx = s.ctxFor((async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).hostname === "api.github.com" ? org.fetch(input, init) : globalThis.fetch(input, init);
  }) as typeof fetch);
  return { org, s };
}

/** GitHub resolves owner/name case-insensitively (REST paths and GraphQL owner/name); the fake does not, so fold it, as the reviewer's reproduction did. */
const caseFolding = (org: ReturnType<typeof fakeOrg>, names: string[]) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.github.com") return globalThis.fetch(input, init);
    for (const n of names) url.pathname = url.pathname.replace(new RegExp(n.replace("/", "\\/"), "i"), n);
    let body = init?.body;
    if (typeof body === "string" && url.pathname === "/graphql") {
      const j = JSON.parse(body) as { variables?: Record<string, unknown> };
      for (const k of ["owner", "name"]) if (typeof j.variables?.[k] === "string") j.variables[k] = (j.variables[k] as string).toLowerCase();
      body = JSON.stringify(j);
    }
    return org.fetch(url.href, { ...init, ...(body !== undefined ? { body } : {}) });
  }) as typeof fetch;

/**
 * The auditee's rewrite of a frozen manifest: repos renamed in `repos`, `changes`, `headEvidence` and the listing.
 * `order`: "kept" leaves the changes where they are (a rule pool's canonical order does not depend on names), "by id"
 * re-sorts them by change id as the old canonical order wanted.
 */
function respell(m: ManifestV2, names: Map<string, string>, order: "kept" | "by id"): ManifestV2 {
  const sub = (s: string) => names.get(s) ?? s;
  const subId = (id: string) => {
    for (const [f, t] of names) if (id.includes(`:${f}#`) || id.includes(`:${f}@`)) return id.replace(`:${f}`, `:${t}`);
    return id;
  };
  const changes = m.changes.map((c) => ({ ...c, repo: sub(c.repo), id: subId(c.id) }));
  const body: Record<string, unknown> = {
    ...m,
    repos: m.repos.map((r) => ({ ...r, repo: sub(r.repo) })).sort((a, b) => cmp(a.repo, b.repo)),
    changes: order === "kept" ? changes : changes.sort((a, b) => compareChangeIds(a.id, b.id)),
    ...(m.headEvidence ? { headEvidence: m.headEvidence.map((e) => ({ ...e, repo: sub(e.repo) })).sort((a, b) => cmp(a.repo, b.repo)) } : {}),
    ...(m.repoListing ? { repoListing: { ...m.repoListing, repos: m.repoListing.repos.map((r) => ({ ...r, repo: sub(r.repo) })).sort((a, b) => cmp(a.repo, b.repo)) } } : {}),
  };
  delete body.sha256;
  return { ...(body as unknown as ManifestV2), sha256: manifestSha256(body as unknown as ManifestV2) };
}

/** A commitment for `m`, signed with the audit's key and stamped by both authorities now (before R), as the auditee could. */
async function stamp(s: PoolScenario, m: ManifestV2): Promise<SignedRecord<CommitmentRecordV2>> {
  const cm0 = read<SignedRecord<CommitmentRecordV2>>(s, CM);
  const reg = read<SignedRecord<RegistrationRecordV2>>(s, REG);
  const frozenAt = new Date(s.clock.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const signed = signRecord({ ...cm0.record, manifestSha256: m.sha256, N: m.N, frozenAt } as CommitmentRecordV2, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem")));
  return { ...signed, timestamps: (await s.clock.run(obtainTimestamps(s.ctx, signed, frozenAt, reg.record.timestamping, trustFor(s.ctx)))).timestamps };
}

/** Installs a candidate (manifest and commitment), samples it after R, and verifies it online. */
async function sampleAndVerify(s: PoolScenario, ctx: PoolScenario["ctx"], c: { manifest: string; commitment: string }) {
  writeFileSync(join(s.dir, MANIFEST), c.manifest);
  writeFileSync(join(s.dir, CM), c.commitment);
  if (existsSync(join(s.dir, DRAWS))) rmSync(join(s.dir, DRAWS));
  const sampled = await s.clock.run(sampleCommand(ctx, {}).catch((e: Error) => e));
  const draws = existsSync(join(s.dir, DRAWS)) ? read<DrawsFile>(s, DRAWS) : null;
  const r = await s.clock.run(runVerify(ctx, { offline: false }));
  return { sampled, draws, r, first36: draws ? draws.draws.slice(0, 36).map((x) => x.mergeSha).join(" ") : null };
}

describe("P5 finding 1: a pooled manifest's repo names do not choose the draws", () => {
  it("rvp2-rename-grind: three PROVEN freezes of one rule registration, a repo renamed before the second and the third: one sample, each VERIFIED", async () => {
    const { org, s } = poolAudit({ eligible: 8, scale: 2 });
    at(s);
    expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
    const candidates: { label: string; manifest: string; commitment: string }[] = [];
    const save = (label: string) => candidates.push({ label, manifest: readFileSync(join(s.dir, MANIFEST), "utf8"), commitment: readFileSync(join(s.dir, CM), "utf8") });
    await s.advance(12 * 3600_000);
    at(s);
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    save("as named");
    org.renameRepo("svc-03", "aaa-svc-03");
    await s.advance(600_000);
    at(s);
    expect(await s.clock.run(freezeCommand(s.ctx, { force: true }))).toBe(0);
    save("renamed aaa-svc-03");
    org.renameRepo("aaa-svc-03", "zzz-svc-03");
    await s.advance(600_000);
    at(s);
    expect(await s.clock.run(freezeCommand(s.ctx, { force: true }))).toBe(0);
    save("renamed zzz-svc-03");
    // The three manifests differ (their names, ids and order of change ids), but not in what draws read.
    expect(new Set(candidates.map((c) => (JSON.parse(c.manifest) as ManifestV2).sha256)).size).toBe(3);
    await s.advance(14 * 3600_000); // R has published; the SCM keeps the last name
    at(s);
    const results = [];
    for (const c of candidates) results.push({ label: c.label, ...(await sampleAndVerify(s, s.ctx, c)) });
    for (const r of results) expect(r.r.verdict, r.label).toBe("VERIFIED");
    expect(new Set(results.map((r) => r.first36)).size).toBe(1);
    // The middle manifest names the repo by a former name the SCM still resolves to it: noted in check 2, not failed.
    expect(results[1]!.r.checks[1]!.details).toContain(`${ORG}/aaa-svc-03 (repo id ${org.idOf("zzz-svc-03")}) is a former name: github resolves it to the same repository, named ${ORG}/zzz-svc-03 now (registered as ${ORG}/svc-03)`);
  }, 300_000);

  for (const kind of ["rule", "list"] as const) {
    it(`rvp2-name-grind (${kind}): respelled manifests stamped before R: never another sample, and check 2 FAILs each spelling`, async () => {
      const names = Array.from({ length: 6 }, (_, i) => `${ORG}/svc-${String(i).padStart(2, "0")}`);
      const { org, s } = poolAudit({ eligible: 6, scale: 2, ...(kind === "list" ? { repos: `[${names.join(", ")}]` } : {}) });
      const ctx = s.ctxFor(caseFolding(org, names));
      at(s);
      expect(await s.clock.run(registerCommand(ctx, {}))).toBe(0);
      await s.advance(12 * 3600_000);
      at(s);
      expect(await s.clock.run(freezeCommand(ctx, {}))).toBe(0);
      const honest = read<ManifestV2>(s, MANIFEST);
      const victim = `${ORG}/svc-03`;
      const spellings = kind === "rule" ? [`${ORG}/000-svc-03`, `${ORG}/zzz-svc-03`, `${ORG}/SVC-03`] : [victim.toUpperCase(), `${ORG}/SVC-03`];
      const candidates: { label: string; manifest: string; commitment: string }[] = [{ label: victim, manifest: JSON.stringify(honest, null, 2), commitment: readFileSync(join(s.dir, CM), "utf8") }];
      for (const sp of spellings) {
        for (const order of kind === "rule" ? (["kept", "by id"] as const) : (["by id"] as const)) {
          await s.advance(60_000);
          at(s);
          const m = respell(honest, new Map([[victim, sp]]), order);
          candidates.push({ label: `${sp} (${order})`, manifest: JSON.stringify(m, null, 2), commitment: JSON.stringify(await stamp(s, m), null, 2) });
        }
      }
      await s.advance(14 * 3600_000);
      at(s);
      const [first, ...rest] = await (async () => {
        const out = [];
        for (const c of candidates) out.push({ label: c.label, ...(await sampleAndVerify(s, ctx, c)) });
        return out;
      })();
      expect(first!.r.verdict).toBe("VERIFIED");
      for (const r of rest) {
        expect(r.r.verdict, r.label).toBe("FAILED");
        expect(r.r.checks[1]!.status, r.label).toBe("FAIL");
        if (r.draws) expect(r.first36, r.label).toBe(first!.first36); // a manifest sample takes at all draws the honest sample
        else expect(String(r.sampled), r.label).toMatch(/the draws cannot be taken from this manifest|not in canonical order/);
      }
      if (kind === "rule") {
        // Stored in canonical order, a respelled rule pool samples, and draws exactly the honest draws: the names chose nothing.
        expect(rest.filter((r) => r.label.endsWith("(kept)")).every((r) => r.draws !== null)).toBe(true);
        const c2 = rest.find((r) => r.label === `${ORG}/000-svc-03 (kept)`)!.r.checks[1]!;
        expect(c2.details).toContain(`FAIL manifest names repo id ${org.idOf("svc-03")} "${ORG}/000-svc-03", which is neither its registered name "${victim}" nor its name on github now "${victim}", nor a former name the SCM resolves to it: a manifest names its repositories as the registration or the SCM does, never another way`);
        expect(rest.find((r) => r.label === `${ORG}/SVC-03 (kept)`)!.r.checks[1]!.details.some((d) => d.includes("but another spelling of one"))).toBe(true);
        // Left in the old (change-id) order, the manifest is not in canonical order: sample refuses it and check 2 FAILs it.
        expect(rest.find((r) => r.label === `${ORG}/000-svc-03 (by id)`)!.r.checks[1]!.details).toContain("manifest changes are not in canonical order (by draw key, contracts.md §5)");
      } else {
        for (const r of rest) {
          expect(r.draws, r.label).toBeNull();
          expect(r.r.checks[1]!.details.some((d) => /not spelled byte for byte as the registered list does/.test(d)), r.label).toBe(true);
        }
      }
    }, 300_000);
  }

  it("rvp2-name-certify: a rule pool with 12.5% bad changes, 24 respelled manifests stamped before R: every one draws the honest sample", async () => {
    const { org: _org, s } = poolAudit({ eligible: 24, scale: 1 });
    at(s);
    expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
    await s.advance(12 * 3600_000);
    at(s);
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    const honest = read<ManifestV2>(s, MANIFEST);
    const h8 = (sha: string) => parseInt(createHash("sha256").update(sha).digest("hex").slice(0, 8), 16);
    const bad = new Set(honest.changes.filter((c) => h8(c.mergeSha) % 8 === 4).map((c) => c.mergeSha));
    const repos = honest.repos.map((r) => r.repo);
    const candidates: { label: string; manifest: string; commitment: string }[] = [{ label: "honest", manifest: JSON.stringify(honest, null, 2), commitment: readFileSync(join(s.dir, CM), "utf8") }];
    for (let c = 1; c <= 24; c++) {
      const names = new Map(repos.map((r, i) => [r, `${ORG}/${createHash("sha256").update(`${c}:${i}`).digest("hex").slice(0, 3)}-${r.slice(ORG.length + 1)}`]));
      // Either order: the old one (by change id, which the reviewer's grind used) or the canonical one.
      const m = respell(honest, names, c % 2 ? "by id" : "kept");
      await s.advance(30_000);
      at(s);
      candidates.push({ label: `respelling ${c}`, manifest: JSON.stringify(m, null, 2), commitment: JSON.stringify(await stamp(s, m), null, 2) });
    }
    await s.advance(13 * 3600_000);
    at(s);
    const badIn36 = new Set<number>();
    let honestFirst36 = "";
    for (const c of candidates) {
      writeFileSync(join(s.dir, MANIFEST), c.manifest);
      writeFileSync(join(s.dir, CM), c.commitment);
      if (existsSync(join(s.dir, DRAWS))) rmSync(join(s.dir, DRAWS));
      const code = await s.clock.run(sampleCommand(s.ctx, {}).catch(() => 1));
      if (code !== 0) continue; // left in change-id order: refused, no sample to keep
      const d = read<DrawsFile>(s, DRAWS);
      const first36 = d.draws.slice(0, 36).map((x) => x.mergeSha).join(" ");
      if (c.label === "honest") honestFirst36 = first36;
      else expect(first36, c.label).toBe(honestFirst36);
      badIn36.add(d.draws.slice(0, 36).filter((x) => bad.has(x.mergeSha)).length);
    }
    expect(badIn36.size).toBe(1); // nothing to choose from: the grind keeps the honest sample or none
    // The honest sample, reviewed honestly, then verifies; a respelled candidate never does.
    writeFileSync(join(s.dir, MANIFEST), candidates[0]!.manifest);
    writeFileSync(join(s.dir, CM), candidates[0]!.commitment);
    rmSync(join(s.dir, DRAWS));
    expect(await s.clock.run(sampleCommand(s.ctx, {}))).toBe(0);
    const d = read<DrawsFile>(s, DRAWS);
    for (const x of d.draws.slice(0, 36)) if (x.firstOccurrence) await s.clock.run(recordCommand(s.ctx, String(x.draw), bad.has(x.mergeSha) ? "fail" : "pass", { reviewer: "r" }));
    s.git("add", "-A");
    s.git("commit", "-qm", "verdicts");
    const r = await s.clock.run(runVerify(s.ctx, { offline: false }));
    expect(r.checks.filter((c) => c.n !== 7).map((c) => `${c.n}:${c.status}`)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:PASS", "6:PASS"]);
    expect(r.certified).toBe(false); // 12.5% bad, above p0: the honest sample does not certify
  }, 600_000);

  it("a pooled rule audit frozen twelve times, with renames between the freezes and two hand respellings: one set of draws", async () => {
    const { org, s } = poolAudit({ eligible: 8, scale: 1 });
    at(s);
    expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
    await s.advance(12 * 3600_000);
    const renames: [string, string][] = [["svc-01", "svc-01-renamed"], ["svc-05", "a-svc-05"], ["svc-01-renamed", "z-svc-01"], ["svc-07", "SVC-07"], ["svc-02", "svc-02-x"]];
    const candidates: { label: string; manifest: string; commitment: string }[] = [];
    for (let i = 0; i < 12; i++) {
      if (i % 2 === 1 && renames.length) {
        const [from, to] = renames.shift()!;
        org.renameRepo(from, to);
      }
      await s.advance(20 * 60_000);
      at(s);
      expect(await s.clock.run(freezeCommand(s.ctx, i ? { force: true } : {}))).toBe(0);
      candidates.push({ label: `freeze ${i + 1}`, manifest: readFileSync(join(s.dir, MANIFEST), "utf8"), commitment: readFileSync(join(s.dir, CM), "utf8") });
    }
    // Two respellings of the last freeze, kept in canonical order and stamped before R.
    const last = JSON.parse(candidates.at(-1)!.manifest) as ManifestV2;
    for (const [from, to] of [[`${ORG}/svc-04`, `${ORG}/0-svc-04`], [`${ORG}/svc-06`, `${ORG}/SVC-06`]] as const) {
      await s.advance(60_000);
      at(s);
      const m = respell(last, new Map([[from, to]]), "kept");
      candidates.push({ label: `respelled ${to}`, manifest: JSON.stringify(m, null, 2), commitment: JSON.stringify(await stamp(s, m), null, 2) });
    }
    expect(new Set(candidates.map((c) => (JSON.parse(c.manifest) as ManifestV2).sha256)).size).toBe(14);
    await s.advance(14 * 3600_000);
    at(s);
    const results = [];
    for (const c of candidates) results.push({ label: c.label, ...(await sampleAndVerify(s, s.ctx, c)) });
    expect(new Set(results.map((r) => r.first36)).size).toBe(1);
    for (const r of results.slice(0, 12)) expect(r.r.verdict, r.label).toBe("VERIFIED");
    for (const r of results.slice(12)) {
      expect(r.r.verdict, r.label).toBe("FAILED");
      expect(r.r.checks.filter((c) => c.status === "FAIL").map((c) => c.n), r.label).toEqual([2]);
    }
  }, 600_000);
});
