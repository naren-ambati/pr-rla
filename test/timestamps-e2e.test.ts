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
import type { CommitmentRecordV2, DrawsFile, RegistrationRecordV2, SignedRecord, TimestampEvidence } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { trustFor } from "../src/commands/context.js";
import { obtainTimestamps } from "../src/commands/timestamps.js";
import { TSA_RETRY_DEADLINE_MS } from "../src/net/contract.js";
import { roundPublishTime } from "../src/core/seed.js";
import { loadConfig } from "../src/config.js";
import { isoMs, readToken } from "../src/timestamp/verify.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FIXTURES, readJsonFixture } from "./helpers/fixtures.js";
import { MockTsaServer, makeTestAuthority, mintResponse, tokenOf, type TestAuthority } from "./helpers/test-tsa.js";

const W = "audit/2026-q3";
let tsa: MockTsaServer;
let foreign: TestAuthority;
let expired: TestAuthority;

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
  expired = await makeTestAuthority({ id: "test-exp", signerValidFrom: "2025-01-01T00:00:00Z", signerValidTo: "2026-01-01T00:00:00Z" });
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" }), await makeTestAuthority({ id: "test-c", alg: "RSA-PSS", operator: "Test operator test-a" }), expired]).start();
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
    expect(await statusCommand(s.ctx, {})).toBe(0);
    expect(s.out[0]).toMatch(/CERTIFIED \(risk 5%\) · RETROSPECTIVE$/);
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
      reg.timestamps!.push(evidenceFrom(expired, der, "1112131415161718"));
    });
    expect(r.checks[0]!.status).toBe("FAIL");
    expect(r.checks[0]!.details.join("\n")).toMatch(/token from test-exp: rule 6: test-exp test TSA is not valid at genTime 2026-10-20T00:00:00Z \(valid 2025-01-01T00:00:00Z\.\.2026-01-01T00:00:00Z\)/);
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
    expect(r.checks[0]!.status).toBe("WARN");
    expect(r.ok).toBe(true);
    expect(r.timestampTamperProof).toBe(false);
    expect(r.checks[0]!.details).toContain("TIMESTAMP NOT TAMPER-PROOF (1 of 2): the registration's time is the signer's own clock, bounded by 1 operator(s) where 2 are required");
    expect(await verifyCommand(s.ctx, {})).toBe(0);
    expect(s.out.join("\n")).toMatch(/TIMESTAMP NOT TAMPER-PROOF \(1 of 2\): registration and\/or manifest times are self-asserted/);
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out[0]).toMatch(/CERTIFIED \(risk 5%\) · RETROSPECTIVE · TIMESTAMP NOT TAMPER-PROOF \(1 of 2\)$/);
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
    await statusCommand(s.ctx, {});
    expect(s.out[0]).toMatch(/· CERTIFIED \(risk 5%\) · RETROSPECTIVE · TIMESTAMP NOT TAMPER-PROOF \(0 of 2\)$/);
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, {})).toBe(0);
    const text = s.out.join("\n");
    expect(text).toMatch(/1\. WARN registration/);
    expect(text).toMatch(/TIMESTAMP NOT TAMPER-PROOF \(0 of 2\): registration and\/or manifest times are self-asserted/);
    expect(text).toMatch(/CERTIFIED \(risk 5%\) · RETROSPECTIVE\nVERIFIED$/);
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
  type Rec = { registeredAt: string; digest: string; nonces: Record<string, string>; authorities: Record<string, { url: string; request: string; status: number; contentType: string; response: string }>; demo: { register: string[] } };
  const rec = readJsonFixture<Rec>("tsa", "recorded-2026-11-03.json");
  let dir: string;
  let ctx: CommandContext;
  const out: string[] = [];
  const replay = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input)).href;
    const [id, ex] = Object.entries(rec.authorities).find(([, e]) => new URL(e.url).href === url) ?? [];
    if (!ex) throw new Error(`no recorded exchange for ${url}`);
    expect(Buffer.from(init!.body as ArrayBuffer).toString("base64"), `request to ${id}`).toBe(ex.request);
    return new Response(Buffer.from(ex.response, "base64"), { status: ex.status, headers: { "content-type": ex.contentType } });
  }) as typeof fetch;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "prrla-demo-"));
    cpSync(join(FIXTURES, "audits", "tsa-demo"), dir, { recursive: true });
    ctx = { cwd: dir, env: {}, nowMs: () => T(rec.registeredAt), fetch: replay, nonceFor: (id) => new Uint8Array(Buffer.from(rec.nonces[id]!, "hex")), out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) };
  });

  it("register prints `timestamps: 4 of 4 … k = 2 · PROVEN` (the same digest, offline)", async () => {
    expect(await registerCommand(ctx, {})).toBe(0);
    expect(out).toContain("  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN");
    expect(out).toContain("  PROSPECTIVE · registration existed by 2026-11-03T22:32:28Z (U_k)");
    const reg = JSON.parse(readFileSync(join(dir, "audit/demo-2026-q4/registration.json"), "utf8")) as SignedRecord<RegistrationRecordV2>;
    expect(reg.sha256).toBe(rec.digest);
    expect(rec.demo.register).toContain("  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN");
  });

  it("verify check 1 PASSes offline on the real tokens; a forged token makes it FAIL", async () => {
    const good = await runVerify(ctx, { offline: true });
    expect(good.checks[0]!.status).toBe("PASS");
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
