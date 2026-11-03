import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import type { RegistrationRecordV2, RekorV2Entry, SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { createMinimalBroker } from "../src/net/minimal-adapter.js";
import { REKOR_V2_WARNING, RekorV2Client, buildHashedRekordV002, parseCheckpoint, verifyRekorV2Entry } from "../src/translog/rekor-v2.js";
import { makeChanges, setupAuditRepo, T } from "./helpers/audit-scenario.js";
import { MockRekorV2 } from "./helpers/mock-rekor-v2.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/** The Rekor v2 client, against a local mock log only (D3: no write to any real log, staging or production). */

describe.each(["ec", "ed25519"] as const)("Rekor v2 client against a mock log (%s checkpoint key)", (keyType) => {
  const log = new MockRekorV2(keyType);
  const key = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "prrla-")), "k.pem"));
  beforeAll(async () => void (await log.start()));
  afterAll(async () => log.stop());

  it("submits, then verifies the body, the inclusion proof and the signed checkpoint", async () => {
    const client = new RekorV2Client(log.url, createMinimalBroker());
    const first = signRecord({ schema: "x/v2", n: 1 }, key);
    const e1 = await client.submit(buildHashedRekordV002(first));
    expect(e1.apiVersion).toBe("v2");
    expect(verifyRekorV2Entry(e1, first, log.publicKeyPem)).toEqual({ ok: true, problems: [] });
    const second = signRecord({ schema: "x/v2", n: 2 }, key);
    const e2 = await client.submit(buildHashedRekordV002(second));
    expect(e2.inclusionProof.treeSize).toBe(2);
    expect(verifyRekorV2Entry(e2, second, log.publicKeyPem).ok).toBe(true);
    expect(parseCheckpoint(e2.inclusionProof.checkpoint.envelope)).toMatchObject({ origin: log.origin, treeSize: 2 });
    expect(log.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/v2/log/entries", "POST /api/v2/log/entries"]);
  });

  it("detects a swapped record, an edited checkpoint, a foreign log key and a broken proof", async () => {
    const client = new RekorV2Client(log.url, createMinimalBroker());
    const signed = signRecord({ schema: "x/v2", n: 3 }, key);
    const e = await client.submit(buildHashedRekordV002(signed));
    expect(verifyRekorV2Entry(e, signRecord({ schema: "x/v2", n: 4 }, key), log.publicKeyPem).problems).toContain("log entry names a different record digest");
    const edited: RekorV2Entry = { ...e, inclusionProof: { ...e.inclusionProof, checkpoint: { envelope: e.inclusionProof.checkpoint.envelope.replace(/\n\d+\n/, "\n99\n") } } };
    expect(verifyRekorV2Entry(edited, signed, log.publicKeyPem).problems).toEqual(expect.arrayContaining(["checkpoint names a different tree than the inclusion proof", "checkpoint signature does not verify under the log key"]));
    expect(verifyRekorV2Entry(e, signed, new MockRekorV2(keyType).publicKeyPem).problems).toEqual(["checkpoint signature does not verify under the log key"]);
    const broken: RekorV2Entry = { ...e, inclusionProof: { ...e.inclusionProof, logIndex: e.inclusionProof.logIndex + 1 } };
    expect(verifyRekorV2Entry(broken, signed, log.publicKeyPem).problems).toContain("inclusion proof does not reach the stated root");
  });
});

describe("register --submit --rekor-api v2", () => {
  let tsa: MockTsaServer;
  const log = new MockRekorV2();
  beforeAll(async () => {
    await log.start();
    tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  });
  afterAll(async () => {
    await log.stop();
    await tsa.stop();
  });
  const scenario = () => {
    const s = setupAuditRepo({ changes: makeChanges(400), tsa: { ids: ["test-a", "test-b"], server: tsa } });
    writeFileSync(join(s.dir, "rekor-v2.pub"), log.publicKeyPem);
    writeFileSync(join(s.dir, ".pr-rla.yml"), `${readFileSync(join(s.dir, ".pr-rla.yml"), "utf8")}transparency_log: { url: "${log.url}", public_key_file: rekor-v2.pub }\n`);
    s.clock.now = T("2026-10-20T00:00:00Z");
    tsa.nowMs = s.clock.now;
    return s;
  };

  it("prints the v2 warning before any network call, and without --yes submits nothing", async () => {
    const s = scenario();
    const tsaBefore = tsa.requests.length;
    await expect(registerCommand(s.ctx, { submit: true, rekorApi: "v2" })).rejects.toThrow(/not submitted: pass --yes to confirm a public, permanent Rekor v2 entry/);
    expect(s.out).toEqual([REKOR_V2_WARNING]);
    expect(REKOR_V2_WARNING).toBe("Rekor v2 client: tested against the published API and a mock log only, not the production log. This entry will be public and permanent.");
    expect(log.requests).toHaveLength(0);
    expect(tsa.requests.length).toBe(tsaBefore);
  });

  it("an interactive no is a refusal too; --yes submits, and verify checks the entry but takes no time from it", async () => {
    const s = scenario();
    await expect(registerCommand({ ...s.ctx, confirm: async () => false }, { submit: true, rekorApi: "v2" })).rejects.toThrow(/not submitted/);
    expect(await registerCommand(s.ctx, { submit: true, rekorApi: "v2", yes: true })).toBe(0);
    expect(s.out[0]).toBe(REKOR_V2_WARNING);
    expect(log.requests).toHaveLength(1);
    const reg = JSON.parse(readFileSync(join(s.dir, "audit/2026-q3/registration.json"), "utf8")) as SignedRecord<RegistrationRecordV2>;
    expect(reg.log).toMatchObject({ apiVersion: "v2", logIndex: 0 });
    expect(s.out.join("\n")).toMatch(/in Rekor v2 log .* \(v2 entries carry no time; unverified against the production log\)/);
    const c1 = (await runVerify(s.ctx, { offline: true })).checks[0]!;
    expect(c1.status).toBe("PASS");
    expect(c1.details.join("\n")).toMatch(/registration in Rekor v2 log .* index 0 \(inclusion proof and signed checkpoint verified; v2 entries carry no time/);
    expect(c1.details.join("\n")).toMatch(/registration timestamps: 2 of 2 TSAs \(test-a, test-b\) · k = 2 · PROVEN/);
  });

  it("there is no default log: --submit needs a URL", async () => {
    const s = setupAuditRepo({ changes: makeChanges(10) });
    await expect(registerCommand(s.ctx, { submit: true, rekorApi: "v2", yes: true })).rejects.toThrow(/--submit needs --rekor-url/);
  });
});
