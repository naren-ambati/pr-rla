import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../src/cli.js";
import type { CommandContext } from "../src/commands/context.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { initCommand } from "../src/commands/init.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import { canonicalJson, sha256Hex } from "../src/core/canonical.js";
import type { CommitmentRecordV2, DrawsFile, LoggedEntry, RegistrationRecordV2, SignedRecord, TimestampEvidence } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { trustFor } from "../src/commands/context.js";
import { obtainTimestamps } from "../src/commands/timestamps.js";
import { TSA_RETRY_DEADLINE_MS } from "../src/net/contract.js";
import { roundPublishTime } from "../src/core/seed.js";
import { loadConfig } from "../src/config.js";
import { SHIPPED_TRUST_BUNDLE } from "../src/timestamp/bundle.js";
import { assessTimestamps, isoMs, readToken, timestampsLine } from "../src/timestamp/verify.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FIXTURES, readJsonFixture } from "./helpers/fixtures.js";
import { RECORDING, installRecordedRegistration, recordedRegistration } from "./helpers/recorded-registration.js";
import { MockTsaServer, makeTestAuthority, mintResponse, tokenOf, type TestAuthority } from "./helpers/test-tsa.js";

const W = "audit/2026-q3";
let tsa: MockTsaServer;
let foreign: TestAuthority;
let expired: TestAuthority;
let unregistered: TestAuthority;

const readJ = <T>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as T;
const writeJ = (s: Scenario, p: string, v: unknown) => writeFileSync(join(s.dir, p), `${JSON.stringify(v, null, 2)}\n`);
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};
const scenario = (ids = ["test-a", "test-b"], k = 2, changes = 400) => setupAuditRepo({ changes: makeChanges(changes), tsa: { ids, k, server: tsa } });
const requestsTo = (id: string) => tsa.requests.filter((r) => r.id === id).length;
const reset = () => {
  for (const k of Object.keys(tsa.behaviour)) delete tsa.behaviour[k];
};

beforeAll(async () => {
  foreign = await makeTestAuthority({ id: "test-b" }); // same id, a root nobody trusts
  const testB = await makeTestAuthority({ id: "test-b", alg: "RSA" });
  // test-b's own root, with a signer certificate that expired before the audit: tamper fixture 4 needs a registered
  // authority's token (a token from an authority the registration does not name is ignored, not failed).
  expired = await makeTestAuthority({ id: "test-b", under: testB, signerValidFrom: "2025-01-01T00:00:00Z", signerValidTo: "2026-01-01T00:00:00Z" });
  // test-d: a trusted authority of its own operator that the scenarios' registrations do not name (review finding 5).
  unregistered = await makeTestAuthority({ id: "test-d", operator: "Operator D" });
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), testB, await makeTestAuthority({ id: "test-c", alg: "RSA-PSS", operator: "Test operator test-a" }), unregistered]).start();
});
afterAll(async () => tsa.stop());

describe("register: the outcome table (functional-design.md §U1 item 3, FR1.11)", () => {
  it("k or more operators accepted: PROVEN, exit 0", async () => {
    reset();
    const s = scenario();
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(s.out).toContain("  timestamps: 2 of 2 TSAs (test-a, test-b) · k = 2 · PROVEN");
    expect(readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`).timestamps).toHaveLength(2);
  });

  it("1 of k: the record is written, both lines print, exit 5; the failing authority was retried for at most 5 minutes", async () => {
    reset();
    tsa.behaviour["test-b"] = { fail: 1_000 };
    const s = scenario();
    at(s, "2026-10-20T00:00:00Z");
    const before = tsa.requests.length;
    expect(await registerCommand(s.ctx, {})).toBe(5);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
    expect(reg.timestamps!.map((t) => t.tsa)).toEqual(["test-a"]);
    expect(s.out).toContain("  TIMESTAMP NOT TAMPER-PROOF (1 of 2)");
    expect(s.out).toContain("  to make it tamper-proof, register again before anything is shown to anyone: pr-rla register --force");
    const bReqs = tsa.requests.slice(before).filter((r) => r.id === "test-b");
    expect(bReqs.length).toBeGreaterThan(5);
    expect(bReqs.at(-1)!.atMs - T("2026-10-20T00:00:00Z")).toBeLessThanOrEqual(300_000);
  });

  it("0 of k (every authority unreachable): the record is written, (0 of 2), exit 5", async () => {
    reset();
    tsa.behaviour["test-a"] = { fail: 1_000 };
    tsa.behaviour["test-b"] = { status: 2 }; // rejection: an answer, not retried
    const s = scenario();
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(5);
    expect(readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`).timestamps).toEqual([]);
    expect(s.out).toContain("  timestamps: 0 of 2 TSAs · k = 2 · TIMESTAMP NOT TAMPER-PROOF (0 of 2)");
    expect(s.out.join("\n")).toMatch(/test-b: no accepted token \(the authority answered rejection\)/);
  });

  it("no authority configured: no request at all, TIMESTAMP NOT TAMPER-PROOF, exit 0", async () => {
    reset();
    const s = scenario([]);
    const before = tsa.requests.length;
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(tsa.requests.length).toBe(before);
    expect(s.out).toContain("  timestamps: no authority configured · TIMESTAMP NOT TAMPER-PROOF");
  });

  it("FR1.8: a local clock 10 min 1 s off the authorities' median is refused (exit 1, nothing written); 9 min 59 s is accepted", async () => {
    reset();
    tsa.behaviour["test-a"] = { skewSeconds: 601 };
    tsa.behaviour["test-b"] = { skewSeconds: 601 };
    const s = scenario();
    at(s, "2026-10-20T00:00:00Z");
    let code = -1;
    await buildProgram(() => s.ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", "register"]);
    expect(code).toBe(1);
    expect(s.out.join("\n")).toMatch(/local clock differs from timestamp authority time by 601 s .*fix the clock and run again/);
    expect(existsSync(join(s.dir, W, "registration.json"))).toBe(false);
    tsa.behaviour["test-a"] = { skewSeconds: 599 };
    tsa.behaviour["test-b"] = { skewSeconds: -599 };
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(s.out).toContain("  timestamps: 2 of 2 TSAs (test-a, test-b) · k = 2 · PROVEN");
  });

  it("skew is judged on the median with no accuracy term: one far-off authority is dropped, not refused", async () => {
    reset();
    tsa.behaviour["test-b"] = { skewSeconds: 3600 };
    const s = scenario(["test-a", "test-b", "test-c"], 2);
    at(s, "2026-10-20T00:00:00Z");
    // test-a and test-c share an operator, so only one of them counts: 1 of 2.
    expect(await registerCommand(s.ctx, {})).toBe(5);
    expect(s.out.join("\n")).toMatch(/test-b: no accepted token \(rule 7: genTime .* is 3600 s from the signed time/);
  });

  it("a dry run asks no authority", async () => {
    reset();
    const s = scenario();
    const before = tsa.requests.length;
    expect(await registerCommand(s.ctx, { dryRun: true })).toBe(0);
    expect(tsa.requests.length).toBe(before);
    expect(s.out.at(-1)).toBe("  timestamps: not requested (dry run) · authorities test-a, test-b · k = 2");
  });

  it("refuses authorities the trust bundle does not know, and a k larger than the distinct operators", async () => {
    const s = scenario(["test-a", "nope"]);
    await expect(registerCommand(s.ctx, {})).rejects.toThrow(/timestamping\.authorities: nope is not in the trust bundle 2026-11/);
    const t = scenario(["test-a", "test-c"], 2); // one operator
    await expect(registerCommand(t.ctx, {})).rejects.toThrow(/min_tokens is 2, but the configured authorities belong to 1 distinct operator/);
  });
});

describe("freeze: the same table, with pr-rla freeze --force", () => {
  it("1 of k at freeze writes manifest and commitment, exit 5; re-freezing needs --force", async () => {
    reset();
    const s = scenario();
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    tsa.behaviour["test-a"] = { fail: 1_000 };
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(5);
    expect(existsSync(join(s.dir, `${W}.manifest.json`))).toBe(true);
    expect(s.out).toContain("  to make it tamper-proof, freeze again before anything is shown to anyone: pr-rla freeze --force");
    reset();
    await expect(freezeCommand(s.ctx, {})).rejects.toThrow(/this window is frozen\. Use --force only if/);
    at(s, "2026-10-20T13:00:00Z");
    expect(await freezeCommand(s.ctx, { force: true })).toBe(0);
    expect(s.out.join("\n")).toMatch(/manifest commitment existed by 2026-10-20T13:00:01Z \(U_k\), before R/);
  });
});

describe("U_k at the ±1 s boundaries", () => {
  it("PROSPECTIVE iff U_k < window.opensAt", async () => {
    reset();
    const prospective = scenario();
    at(prospective, "2026-06-30T23:59:58Z"); // genTime = clock, accuracy 1 s → U = 23:59:59
    expect(await registerCommand(prospective.ctx, {})).toBe(0);
    expect((await runVerify(prospective.ctx, { offline: true })).mode).toBe("PROSPECTIVE");
    const retro = scenario();
    at(retro, "2026-06-30T23:59:59Z"); // U = 2026-07-01T00:00:00Z = opensAt
    expect(await registerCommand(retro.ctx, {})).toBe(0);
    const r = await runVerify(retro.ctx, { offline: true });
    expect(r.mode).toBe("RETROSPECTIVE");
    // The signed registeredAt is before opensAt; the proven bound is not.
    expect(r.checks[0]!.summary).toMatch(/^registration after window opened → RETROSPECTIVE/);
  });

  it("check 2 FAILs when U_k ≥ publishTime(R), even with frozenAt before it", async () => {
    reset();
    const s = scenario();
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    const R = 33245812;
    const pub = roundPublishTime(R);
    const deadline = TSA_RETRY_DEADLINE_MS / 1000;
    // U8 fix round (finding 10): freeze no longer starts when its tokens could be issued after R, i.e. within the
    // authorities' retry deadline of it. Just outside that, it freezes and U = clock + 1 s passes check 2.
    const ok = cloneScenario(s);
    at(ok, new Date((pub - deadline - 2) * 1000).toISOString());
    expect(await freezeCommand(ok.ctx, {})).toBe(0);
    expect((await runVerify(ok.ctx, { offline: true })).checks[1]!.status).toBe("PASS");
    const near = cloneScenario(s);
    at(near, new Date((pub - deadline) * 1000).toISOString());
    await expect(freezeCommand(near.ctx, {})).rejects.toThrow(/within the timestamp authorities' 5-minute retry deadline/);
    expect(existsSync(join(near.dir, `${W}/manifest-commitment.json`))).toBe(false);
    // A commitment signed before R whose tokens say U = publishTime(R) still FAILs check 2 (another tool could write one).
    const late = cloneScenario(ok);
    const cmPath = `${W}/manifest-commitment.json`;
    const cm = readJ<SignedRecord<CommitmentRecordV2>>(late, cmPath);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(late, `${W}/registration.json`);
    at(late, new Date((pub - 1) * 1000).toISOString()); // genTime = clock, accuracy 1 s → U = pub
    const signed = signRecord({ ...cm.record, frozenAt: new Date((pub - 1) * 1000).toISOString().replace(".000Z", "Z") }, loadOrCreateKey(join(late.dir, ".pr-rla/signing-key.pem")));
    const got = await obtainTimestamps(late.ctx, signed, signed.record.frozenAt, reg.record.timestamping, trustFor(late.ctx));
    writeJ(late, cmPath, { ...signed, timestamps: got.timestamps });
    const c2 = (await runVerify(late.ctx, { offline: true })).checks[1]!;
    expect(c2.status).toBe("FAIL");
    expect(c2.summary).toBe("manifest logged after the seed was public");
  });
});

describe("an honest v2 audit and six tamper fixtures on its registration's tokens", () => {
  let honest: Scenario;
  const regPath = `${W}/registration.json`;
  const tamper = async (fn: (reg: SignedRecord<RegistrationRecordV2>) => Promise<void> | void) => {
    const s = cloneScenario(honest);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, regPath);
    await fn(reg);
    writeJ(s, regPath, reg);
    return runVerify(s.ctx, {});
  };
  const evidenceFrom = (a: TestAuthority, der: Uint8Array, nonce: string, tsaId = a.id): TimestampEvidence => {
    const { facts } = readToken(der);
    return { kind: "rfc3161", tsa: tsaId, url: tsa.urlFor(tsaId), tokenDer: Buffer.from(der).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce };
  };

  beforeAll(async () => {
    reset();
    honest = scenario();
    at(honest, "2026-10-20T00:00:00Z");
    expect(await registerCommand(honest.ctx, {})).toBe(0);
    at(honest, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(honest.ctx, {})).toBe(0);
    at(honest, "2026-10-21T01:00:00Z");
    expect(await sampleCommand(honest.ctx, {})).toBe(0);
    at(honest, "2026-10-21T03:00:00Z");
    for (const d of readJ<DrawsFile>(honest, `${W}/draws.json`).draws.slice(0, 36)) if (d.firstOccurrence) await recordCommand(honest.ctx, String(d.draw), "pass", { reviewer: "outside-reviewer" });
    honest.git("add", "-A");
    honest.git("commit", "-qm", "verdicts");
  });

  it("verifies 7/7 with both records PROVEN, and status prints no warning", async () => {
    const r = await runVerify(cloneScenario(honest).ctx, {});
    expect(r.checks.map((c) => c.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    expect(r.timestampTamperProof).toBe(true);
    expect(r.timestamps.registration!.proven).toBe(true);
    expect(r.timestamps.commitment!.proven).toBe(true);
    expect(r.versions).toEqual({ registered: "0.1.0", frozen: "0.1.0" });
    const s = cloneScenario(honest);
    // Both times proven, and no TIMESTAMP warning; the certificate is withheld only because status never rebuilds the population.
    expect(await statusCommand(s.ctx, {})).toBe(6);
    expect(s.out[0]).toMatch(/target reached · CERTIFICATE WITHHELD \(population not verified: run `pr-rla verify`\) · RETROSPECTIVE$/);
    expect(s.out[0]).not.toMatch(/TIMESTAMP NOT TAMPER-PROOF/);
  });

  it("(1) an edited genTime: check 1 FAIL (rule 3), and only check 1", async () => {
    const r = await tamper((reg) => {
      const t = reg.timestamps![0]!;
      const der = Buffer.from(t.tokenDer, "base64");
      Buffer.from("20251020000000").copy(der, der.indexOf(Buffer.from("20261020000000")));
      t.tokenDer = der.toString("base64");
      t.genTime = "2025-10-20T00:00:00Z";
    });
    expect(r.checks.filter((c) => c.status === "FAIL").map((c) => c.n)).toEqual([1]);
    expect(r.checks[0]!.details.join("\n")).toMatch(/FAIL registration token from test-a: rule 3: .*Message digest doesn't match/);
  });

  it("(2) a wrong imprint (a token over another record): check 1 FAIL (rule 2)", async () => {
    const r = await tamper(async (reg) => {
      const a = tsa.authorities.find((x) => x.id === "test-a")!;
      const der = tokenOf(await mintResponse(a, { digestHex: sha256Hex("another registration"), nonceHex: "0102030405060708", genTime: new Date(reg.record.registeredAt) }));
      reg.timestamps![0] = evidenceFrom(a, der, "0102030405060708");
    });
    expect(r.checks.filter((c) => c.status === "FAIL").map((c) => c.n)).toEqual([1]);
    expect(r.checks[0]!.details.join("\n")).toMatch(/token from test-a: rule 2: message imprint .* is not the record digest/);
  });

  it("(3) a foreign root: check 1 FAIL (rule 6)", async () => {
    const r = await tamper(async (reg) => {
      const digest = sha256Hex(canonicalJson(reg.record));
      const der = tokenOf(await mintResponse(foreign, { digestHex: digest, nonceHex: "0a0b0c0d0e0f1011", genTime: new Date(reg.record.registeredAt) }));
      reg.timestamps![1] = evidenceFrom(foreign, der, "0a0b0c0d0e0f1011");
    });
    expect(r.checks[0]!.status).toBe("FAIL");
    expect(r.checks[0]!.details.join("\n")).toMatch(/token from test-b: rule 6: chain test-b test TSA does not reach an anchor pinned for test-b/);
  });

  it("(4) an expired signer: check 1 FAIL (rule 6)", async () => {
    const r = await tamper(async (reg) => {
      const digest = sha256Hex(canonicalJson(reg.record));
      const der = tokenOf(await mintResponse(expired, { digestHex: digest, nonceHex: "1112131415161718", genTime: new Date(reg.record.registeredAt) }));
      reg.timestamps![1] = evidenceFrom(expired, der, "1112131415161718");
    });
    expect(r.checks[0]!.status).toBe("FAIL");
    expect(r.checks[0]!.details.join("\n")).toMatch(/token from test-b: rule 6: test-b test TSA is not valid at genTime 2026-10-20T00:00:00Z \(valid 2025-01-01T00:00:00Z\.\.2026-01-01T00:00:00Z\)/);
  });

  it("(5) a token 10 min 61 s from the signed time with no stated accuracy: check 1 FAIL (rule 7)", async () => {
    const r = await tamper(async (reg) => {
      const a = tsa.authorities.find((x) => x.id === "test-a")!;
      const digest = sha256Hex(canonicalJson(reg.record));
      const der = tokenOf(await mintResponse(a, { digestHex: digest, nonceHex: "2122232425262728", genTime: new Date(T(reg.record.registeredAt) + 661_000), accuracySeconds: null }));
      reg.timestamps![0] = evidenceFrom(a, der, "2122232425262728");
    });
    expect(r.checks[0]!.status).toBe("FAIL");
    expect(r.checks[0]!.details.join("\n")).toMatch(/token from test-a: rule 7: genTime 2026-10-20T00:11:01Z is 661 s from the signed time 2026-10-20T00:00:00Z \(limit 660 s/);
  });

  it("(6) too few tokens for k: TIMESTAMP NOT TAMPER-PROOF (1 of 2) in verify and status", async () => {
    const s = cloneScenario(honest);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, regPath);
    reg.timestamps = reg.timestamps!.slice(0, 1);
    writeJ(s, regPath, reg);
    const r = await runVerify(s.ctx, {});
    // Time round B: an unproven registration time is not established (it WARNed, ok, before), and neither is R.
    expect(r.checks[0]!.status).toBe("INCOMPLETE");
    expect(r.checks[2]!.status).toBe("INCOMPLETE");
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.timestampTamperProof).toBe(false);
    expect(r.checks[0]!.details).toContain("TIMESTAMP NOT TAMPER-PROOF (1 of 2): the registration's time is the signer's own clock, bounded by 1 operator(s) where 2 are required");
    expect(await verifyCommand(s.ctx, {})).toBe(6);
    expect(s.out.join("\n")).toMatch(/TIMESTAMP NOT TAMPER-PROOF \(1 of 2\): registration and\/or manifest times are self-asserted/);
    expect(s.out.join("\n")).not.toMatch(/CERTIFIED \(risk/);
    s.out.length = 0;
    expect(await statusCommand(s.ctx, {})).toBe(6);
    expect(s.out[0]).toMatch(/· target reached · CERTIFICATE WITHHELD \(registration time unproven \(TIMESTAMP NOT TAMPER-PROOF \(1 of 2\)\); population not verified: run `pr-rla verify`\) · RETROSPECTIVE · TIMESTAMP NOT TAMPER-PROOF \(1 of 2\)$/);
  });

  // A log entry 5 min after the signed time: if it were the time, R would move from 33,245,812 to 33,245,912.
  const lateLog: LoggedEntry = { logUrl: "http://127.0.0.1:9", uuid: "u", logIndex: 0, integratedTime: T("2026-10-20T00:05:00Z") / 1000, logID: "l", body: "", verification: { signedEntryTimestamp: "" } };

  it("review finding 4: the `timestamps` field dropped from the registration's envelope FAILs check 1 and does not move R to the log's time", async () => {
    const s = cloneScenario(honest);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, regPath);
    delete (reg as { timestamps?: unknown }).timestamps;
    reg.log = lateLog;
    writeJ(s, regPath, reg);
    const r = await runVerify(s.ctx, { offline: true });
    expect(r.derivedRound).toBe(33245812);
    expect(r.checks[0]!.status).toBe("FAIL");
    expect(r.checks[0]!.details).toContain("FAIL registration: a schema-v2 record has no timestamps field (writers always store one); its time evidence was removed");
    // The commitment still names the honest R (no FAIL), but the registration time R rests on is now unproven (time round B).
    expect(r.checks[2]!.status).toBe("INCOMPLETE");
    expect(r.checks[2]!.summary).toBe("R = 33,245,812: first round ≥ 24 h after registration, but the registration time it rests on is unproven");
  });

  it("review finding 4: the same for the commitment: check 2 FAILs", async () => {
    const s = cloneScenario(honest);
    const p = `${W}/manifest-commitment.json`;
    const cm = readJ<SignedRecord<CommitmentRecordV2>>(s, p);
    delete (cm as { timestamps?: unknown }).timestamps;
    cm.log = lateLog;
    writeJ(s, p, cm);
    const c2 = (await runVerify(s.ctx, { offline: true })).checks[1]!;
    expect(c2.status).toBe("FAIL");
    expect(c2.details).toContain("a schema-v2 commitment has no timestamps field (writers always store one); its time evidence was removed");
  });

  it("review finding 5: a token from an authority the registration does not name is ignored (not registered) and does not count toward k", async () => {
    const s = cloneScenario(honest);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, regPath);
    reg.timestamps = reg.timestamps!.slice(0, 1); // test-a only: 1 of 2
    const der = tokenOf(await mintResponse(unregistered, { digestHex: sha256Hex(canonicalJson(reg.record)), nonceHex: "3132333435363738", genTime: new Date(reg.record.registeredAt) }));
    reg.timestamps.push(evidenceFrom(unregistered, der, "3132333435363738"));
    writeJ(s, regPath, reg);
    const r = await runVerify(s.ctx, {});
    expect(r.timestamps.registration!.proven).toBe(false);
    expect(r.timestamps.registration!.operators.map((o) => o.via)).toEqual(["test-a"]);
    expect(r.checks[0]!.status).toBe("INCOMPLETE");
    expect(r.checks[0]!.details).toContain("registration token from test-d ignored (not registered: the registration names test-a, test-b)");
    expect(r.checks[0]!.details.join("\n")).toMatch(/registration timestamps: 1 of 2 TSAs \(test-a\) · k = 2 · TIMESTAMP NOT TAMPER-PROOF \(1 of 2\) · ignored \(not registered\): test-d/);
  });
});

describe("FR1.6: a zero-token audit says TIMESTAMP NOT TAMPER-PROOF in status, verify and the certificate", () => {
  it("every configured authority unreachable at register and freeze", async () => {
    reset();
    tsa.behaviour["test-a"] = { fail: 100_000 };
    tsa.behaviour["test-b"] = { fail: 100_000 };
    const s = scenario();
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(5);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(5);
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out[0]).toBe("RETROSPECTIVE · frozen N 400 · seed round 33245812 publishes 2026-10-21T00:00:00Z · TIMESTAMP NOT TAMPER-PROOF (0 of 2)");
    at(s, "2026-10-21T01:00:00Z");
    await sampleCommand(s.ctx, {});
    for (const d of readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, 36)) if (d.firstOccurrence) await recordCommand(s.ctx, String(d.draw), "pass", { reviewer: "r" });
    s.git("add", "-A");
    s.git("commit", "-qm", "v");
    s.out.length = 0;
    // Time round B: the certificate is withheld while the times are unproven (status exit 6), and verify is INCOMPLETE.
    expect(await statusCommand(s.ctx, {})).toBe(6);
    expect(s.out[0]).toMatch(/· target reached · CERTIFICATE WITHHELD \(registration time unproven \(TIMESTAMP NOT TAMPER-PROOF \(0 of 2\)\); manifest commitment time unproven \(TIMESTAMP NOT TAMPER-PROOF \(0 of 2\)\); population not verified: run `pr-rla verify`\) · RETROSPECTIVE · TIMESTAMP NOT TAMPER-PROOF \(0 of 2\)$/);
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, {})).toBe(6);
    const text = s.out.join("\n");
    expect(text).toMatch(/1\. INCOMPLETE registration/);
    expect(text).toMatch(/TIMESTAMP NOT TAMPER-PROOF \(0 of 2\): registration and\/or manifest times are self-asserted/);
    expect(text).toMatch(/· target reached · CERTIFICATE WITHHELD \(verify check 1 \(registration\) incomplete; verify check 2 \(manifest before seed\) incomplete; verify check 3 \(seed round\) incomplete\) · RETROSPECTIVE\nINCOMPLETE: /);
    expect(text).not.toMatch(/CERTIFIED \(risk|\nVERIFIED$/);
  });

  it("no authority configured: the plain line, everywhere", async () => {
    const s = scenario([]);
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.out.length = 0;
    await statusCommand(s.ctx, { offline: true });
    expect(s.out[0]).toMatch(/· TIMESTAMP NOT TAMPER-PROOF$/);
    s.out.length = 0;
    await verifyCommand(s.ctx, { offline: true });
    expect(s.out.join("\n")).toMatch(/timestamps: no authority configured · TIMESTAMP NOT TAMPER-PROOF/);
  });
});

describe("init", () => {
  it("writes the four default authorities with k = 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-init-"));
    const out: string[] = [];
    await initCommand({ cwd: dir, env: {}, nowMs: Date.now, fetch, out: (l) => out.push(l), err: () => {} }, { repo: "github/gh-aw" });
    const text = readFileSync(join(dir, ".pr-rla.yml"), "utf8");
    expect(text).toMatch(/authorities: \[sigstore, digicert, globalsign, microsoft\]/);
    expect(loadConfig(join(dir, ".pr-rla.yml")).timestamping).toEqual({ authorities: ["sigstore", "digicert", "globalsign", "microsoft"], minTokens: 2 });
  });
});

describe("the bolt-1 demo, replayed from the live recording of 2026-11-03", () => {
  // Time round B: a registration names its signing key inside its signed bytes, so `register` cannot reproduce the
  // recorded digest any more (the recorded record names no key). The recording is replayed as stored: the recorded
  // record and its four default authorities' real tokens (test/helpers/recorded-registration.ts).
  let dir: string;
  let ctx: CommandContext;
  const out: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "prrla-demo-"));
    cpSync(join(FIXTURES, "audits", "tsa-demo"), dir, { recursive: true });
    installRecordedRegistration(dir);
    ctx = { cwd: dir, env: {}, nowMs: () => T(RECORDING.registeredAt), fetch: (async () => { throw new Error("the replay sends nothing"); }) as unknown as typeof fetch, out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) };
  });

  it("the recorded tokens still give `timestamps: 4 of 4 … k = 2 · PROVEN` over the recorded digest, offline, as register printed it", async () => {
    const reg = recordedRegistration();
    expect(reg.sha256).toBe(RECORDING.digest);
    const data = new Uint8Array(Buffer.from(canonicalJson(reg.record)));
    const summary = await assessTimestamps({ timestamps: reg.timestamps!, data, digestHex: reg.sha256, signedTimeIso: reg.record.registeredAt, timestamping: reg.record.timestamping, bundle: SHIPPED_TRUST_BUNDLE });
    expect(`  ${timestampsLine(summary)}`).toBe("  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN");
    expect(isoMs(summary.ukMs!)).toBe("2026-11-03T22:32:28Z"); // register printed "PROSPECTIVE · registration existed by 2026-11-03T22:32:28Z (U_k)"
    expect(RECORDING.demo.register).toContain("  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN");
    expect(RECORDING.demo.register).toContain("  PROSPECTIVE · registration existed by 2026-11-03T22:32:28Z (U_k)");
  });

  it("a registration made now names its key, so its digest is not the recorded one (and the recorded tokens could not count for it)", async () => {
    out.length = 0;
    const fresh = mkdtempSync(join(tmpdir(), "prrla-demo-new-"));
    cpSync(join(FIXTURES, "audits", "tsa-demo"), fresh, { recursive: true });
    expect(await registerCommand({ ...ctx, cwd: fresh }, { dryRun: true })).toBe(0);
    expect(out.join("\n")).toMatch(/^\[dry run\] registration [0-9a-f]{12}…/m);
    expect(out.join("\n")).not.toContain(`registration ${RECORDING.digest.slice(0, 12)}…`);
  });

  it("verify check 1 on the real tokens: all four verify, PROVEN, and check 1 FAILs only that the record names no key (P5; it WARNed); a forged token FAILs it too", async () => {
    // The recording predates registrations naming their key, and cannot be regenerated without asking the authorities
    // again (its tokens are over its digest). Since P5 (finding 10) the missing key FAILs check 1; the tokens still verify.
    const good = await runVerify(ctx, { offline: true });
    expect(good.checks[0]!.status).toBe("FAIL");
    expect(good.checks[0]!.details.filter((d) => d.startsWith("FAIL "))).toEqual(["FAIL the registration does not name its signing key (publicKeyPem, inside the signed and time-stamped bytes): anyone can re-sign it under another key, and the commitment's key is then checked only against this envelope"]);
    expect(good.timestamps.registration!.proven).toBe(true);
    expect(good.mode).toBe("PROSPECTIVE");
    const path = join(dir, "audit/demo-2026-q4/registration.json");
    const reg = JSON.parse(readFileSync(path, "utf8")) as SignedRecord<RegistrationRecordV2>;
    const t = reg.timestamps![1]!; // digicert
    const der = Buffer.from(t.tokenDer, "base64");
    Buffer.from("20261103220000").copy(der, der.indexOf(Buffer.from(t.genTime.replace(/[-:T]/g, "").replace(/\.\d+Z$|Z$/, ""))));
    t.tokenDer = der.toString("base64");
    t.genTime = "2026-11-03T22:00:00Z";
    writeFileSync(path, JSON.stringify(reg));
    const bad = await runVerify(ctx, { offline: true });
    expect(bad.checks[0]!.status).toBe("FAIL");
    expect(bad.checks[0]!.details.join("\n")).toMatch(/FAIL registration token from digicert: rule 3: .*Message digest doesn't match/);
    out.length = 0;
    expect(await verifyCommand(ctx, { offline: true })).toBe(1);
    expect(out.join("\n")).toMatch(/1\. FAIL registration/);
  });
});

