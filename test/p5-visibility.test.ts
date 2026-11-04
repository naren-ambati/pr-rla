import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import { sampleCommand } from "../src/commands/sample.js";
import { obtainTimestamps } from "../src/api/write/timestamps.js";
import { trustFor } from "../src/api/session.js";
import { manifestSha256, type CommitmentRecordV2, type ManifestV2, type RegistrationRecordV2, type SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { fakeOrg, orgSpec, ORG } from "./helpers/fake-org.js";
import { setupPoolAudit } from "./helpers/pool-scenario.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * P5, "draws that cannot be steered", finding 5 (the second review's `rvp2-visibility-choice`, synthetic: U8's fake org,
 * mock authorities, the recorded beacon). A repo private at registration (so not registered under a `visibility: [public]`
 * rule) and public before the freeze: the honest freeze pools it; a manifest whose listing says it was still private at
 * freeze leaves it out. Before, both verified (the second with check 5's WARN), so N was the auditee's choice. Now a repo
 * the rule matches now, not in the pool and not registered, makes check 5 INCOMPLETE: only the manifest that pools it
 * verifies.
 */
const W = "audit/2026-q3";
const MANIFEST = `${W}.manifest.json`;
const CM = `${W}/manifest-commitment.json`;
const REG = `${W}/registration.json`;
const DRAWS = `${W}/draws.json`;
let tsa: MockTsaServer;
beforeAll(async () => {
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
});
afterAll(async () => tsa.stop());

describe("P5 finding 5: a rule pool's visibility (or name) exclusion is not N's choice", () => {
  it("rvp2-visibility-choice: the manifest that pools the repo VERIFIES; the one whose listing calls it private is INCOMPLETE in check 5", async () => {
    const org = fakeOrg(orgSpec({ eligible: 6, scale: 2 }));
    const route = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new URL(url).hostname === "api.github.com" ? org.fetch(input, init) : globalThis.fetch(input, init);
    }) as typeof fetch;
    const s = setupPoolAudit(org, { repos: `{ owner: ${ORG}, visibility: [public] }`, tsa: { ids: ["test-a", "test-b"], server: tsa }, timestamping: "{ authorities: [test-a, test-b], min_tokens: 2 }" });
    const ctx = s.ctxFor(route);
    const at = () => (tsa.nowMs = s.clock.now());
    at();
    expect(await s.clock.run(registerCommand(ctx, {}))).toBe(0);
    const reg = JSON.parse(readFileSync(join(s.dir, REG), "utf8")) as SignedRecord<RegistrationRecordV2>;
    const victim = `${ORG}/svc-03`;
    expect(reg.record.registeredRepos!.map((r) => r.repo)).not.toContain(victim); // private at registration
    org.updateRepo("svc-03", { visibility: "public" }); // public before the freeze
    await s.advance(12 * 3600_000);
    at();
    expect(await s.clock.run(freezeCommand(ctx, {}))).toBe(0);
    const A = JSON.parse(readFileSync(join(s.dir, MANIFEST), "utf8")) as ManifestV2;
    const cmA = readFileSync(join(s.dir, CM), "utf8");
    expect(A.repos.map((r) => r.repo)).toContain(victim);
    // B: the same freeze without svc-03, its listing entry saying private (the reviewer's construction).
    const listing = A.repoListing!;
    const repos = listing.repos.map((r) => (r.repo === victim ? { ...r, visibility: "private" as const, excludedBy: ["visibility:private"] } : r));
    const vis = { ...listing.visibility, public: { ...listing.visibility.public, listed: repos.filter((r) => r.visibility === "public").length }, private: { ...listing.visibility.private, listed: repos.filter((r) => r.visibility === "private").length } };
    const changes = A.changes.filter((c) => c.repo !== victim);
    const { sha256: _o, ...a } = A;
    const body = { ...a, repos: A.repos.filter((r) => r.repo !== victim), changes, N: changes.length, headEvidence: A.headEvidence?.filter((e) => e.repo !== victim), repoListing: { ...listing, repos, visibility: vis } };
    const B = { ...body, sha256: manifestSha256(body as never) } as ManifestV2;
    const cm0 = JSON.parse(cmA) as SignedRecord<CommitmentRecordV2>;
    await s.advance(60_000);
    at();
    const frozenAt = new Date(s.clock.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
    let signed = signRecord({ ...cm0.record, manifestSha256: B.sha256, N: B.N, frozenAt } as CommitmentRecordV2, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem")));
    signed = { ...signed, timestamps: (await s.clock.run(obtainTimestamps(ctx, signed, frozenAt, reg.record.timestamping, trustFor(ctx)))).timestamps };
    await s.advance(13 * 3600_000);
    at();
    const results: Record<string, Awaited<ReturnType<typeof runVerify>>> = {};
    for (const [label, m, cm] of [["A (in)", JSON.stringify(A, null, 2), cmA], ["B (out)", JSON.stringify(B, null, 2), JSON.stringify(signed, null, 2)]] as const) {
      writeFileSync(join(s.dir, MANIFEST), m);
      writeFileSync(join(s.dir, CM), cm);
      if (existsSync(join(s.dir, DRAWS))) rmSync(join(s.dir, DRAWS));
      expect(await s.clock.run(sampleCommand(ctx, {}))).toBe(0);
      results[label] = await s.clock.run(runVerify(ctx, { offline: false }));
    }
    // A: VERIFIED. Its check 5 WARNs only about svc-05, internal then and now (a retrospective audit cannot date that).
    const a5 = results["A (in)"]!.checks[4]!;
    expect(results["A (in)"]!.checks.map((c) => `${c.n}:${c.status}`).filter((c) => c !== "5:WARN" && c !== "7:WARN")).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "6:PASS"]);
    expect(a5.verbose).toEqual([expect.stringMatching(new RegExp(`^WARN repo ${ORG}/svc-05 is excluded by visibility internal now`))]);
    expect(results["A (in)"]!.verdict).toBe("VERIFIED");
    const c5 = results["B (out)"]!.checks[4]!;
    expect(c5.status).toBe("INCOMPLETE");
    expect(c5.details.some((d) => d.startsWith(`INCOMPLETE repo ${victim} matches the registered rule now but is not in the pool, and was not registered; the freeze's listing excluded it (visibility private), an attribute its owners can change, which nothing can check now, and `))).toBe(true);
    expect(results["B (out)"]!.verdict).toBe("INCOMPLETE");
    expect(results["B (out)"]!.ok).toBe(false);
  }, 300_000);
});
