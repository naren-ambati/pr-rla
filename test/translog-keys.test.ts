import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCommand } from "../src/commands/register.js";
import { statusCommand } from "../src/commands/status.js";
import { logPublicKey } from "../src/commands/translog.js";
import { runVerify } from "../src/commands/verify.js";
import { configFor } from "../src/commands/context.js";
import type { LoggedEntry, RegistrationRecordV2, SignedRecord } from "../src/core/records.js";
import { PINNED_LOG_KEYS, keySha256, neutralLogOperator, parseLogKeyArgs, pinnedLogKey, trustedLogKey } from "../src/translog/keys.js";
import { RekorClient, buildHashedRekord } from "../src/translog/rekor.js";
import { noteKeyId } from "../src/translog/rekor-v2.js";
import { makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { MockRekor } from "./helpers/mock-rekor.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * Review finding 3: a transparency-log key comes only from the package (Sigstore's production logs,
 * pinned from Sigstore's TUF trusted_root.json) or from the verifier's --log-key. Never from the audit
 * repo's .pr-rla.yml, a file in the audit repo, or the URL in a record's unsigned envelope. An entry
 * under any other key is unverified: no time evidence, no operator.
 */

describe("pinned log keys (src/translog/keys.ts)", () => {
  it("match the log ids in Sigstore's TUF trusted_root.json (read 2026-11-03 from npm's @sigstore/tuf seeds and gh's TUF cache)", () => {
    const v1 = PINNED_LOG_KEYS.find((k) => k.api === "v1")!;
    expect(v1.url).toBe("https://rekor.sigstore.dev");
    expect(keySha256(v1.publicKeyPem)).toBe(v1.logId); // a Rekor v1 logID is SHA-256 of the DER key
    const v2 = PINNED_LOG_KEYS.find((k) => k.api === "v2")!;
    expect(v2.url).toBe("https://log2025-1.rekor.sigstore.dev");
    const raw = createPublicKey(v2.publicKeyPem).export({ type: "spki", format: "der" }).subarray(-32);
    const origin = "log2025-1.rekor.sigstore.dev";
    // TUF's v2 logId is the full C2SP signed-note key hash; the checkpoint key id pr-rla checks is its first 4 bytes.
    expect(createHash("sha256").update(Buffer.concat([Buffer.from(`${origin}\n`), Buffer.of(0x01), raw])).digest("hex")).toBe(v2.logId);
    expect(Buffer.from(noteKeyId(origin, v2.publicKeyPem)).toString("hex")).toBe(v2.logId.slice(0, 8));
  });

  it("pass-2 review #6: the pinned key always wins for a pinned log; a verifier's key counts only for its own log, under a neutral operator", () => {
    const mine = new MockRekor().publicKeyPem;
    const keys = new Map([["https://rekor.example.org", { url: "https://rekor.example.org", publicKeyPem: mine }]]);
    // Before the fix one --log-key replaced the pinned key for every URL: a genuine Sigstore entry then FAILed, and anything verified was "Sigstore".
    for (const u of ["https://rekor.sigstore.dev", "https://rekor.sigstore.dev/", "HTTPS://Rekor.Sigstore.dev//"]) expect(trustedLogKey(u, keys)).toEqual({ publicKeyPem: PINNED_LOG_KEYS[0]!.publicKeyPem, source: "pinned", operator: "Sigstore", url: "https://rekor.sigstore.dev" });
    expect(trustedLogKey("https://rekor.example.org/", keys)).toEqual({ publicKeyPem: mine, source: "verifier", operator: "log at rekor.example.org", url: "https://rekor.example.org" });
    expect(trustedLogKey("https://other.example.org", keys)).toBeNull(); // scoped: no other log is vouched for
    expect(pinnedLogKey("https://rekor.sigstage.dev")).toBeNull();
    expect(trustedLogKey("http://127.0.0.1:61085")).toBeNull();
    expect(neutralLogOperator("http://127.0.0.1:61085")).toBe("log at 127.0.0.1:61085");
  });

  it("--log-key takes <log url>=<pem file>, repeatable: malformed values, non-keys and two keys for one log are refused; a key for a pinned log is ignored and said so", () => {
    const a = new MockRekor().publicKeyPem;
    const b = new MockRekor().publicKeyPem;
    const files: Record<string, string> = { "a.pub": a, "b.pub": b, "junk.pub": "not a key" };
    const read = (f: string) => files[f]!;
    const r = parseLogKeyArgs(["https://one.example=a.pub", "http://127.0.0.1:9/=b.pub", "https://rekor.sigstore.dev=a.pub"], read);
    expect([...r.keys.keys()]).toEqual(["https://one.example", "http://127.0.0.1:9"]);
    expect(r.ignored).toEqual(["--log-key for https://rekor.sigstore.dev is not used: pr-rla pins that log's key, and the pinned key always wins"]);
    expect(parseLogKeyArgs(["https://one.example=a.pub", "https://one.example/=a.pub"], read).keys.size).toBe(1); // the same key twice is one
    for (const bad of ["a.pub", "=a.pub", "https://one.example=", "ftp://one.example=a.pub", "one.example=a.pub"]) expect(() => parseLogKeyArgs([bad], read)).toThrow(/--log-key takes <log url>=<pem file>/);
    expect(() => parseLogKeyArgs(["https://one.example=junk.pub"], read)).toThrow(/junk\.pub is not a public key/);
    expect(() => parseLogKeyArgs(["https://one.example=a.pub", "https://one.example=b.pub"], read)).toThrow(/two different keys for https:\/\/one\.example/);
  });
});

describe("logPublicKey reads no key from the audit repo and fetches none", () => {
  it("ignores transparency_log.public_key_file and the log's /publicKey; takes --log-key or a pinned key", async () => {
    const log = new MockRekor();
    const s = setupAuditRepo({ changes: makeChanges(10) });
    writeFileSync(join(s.dir, "rekor.pub"), log.publicKeyPem);
    writeFileSync(join(s.dir, ".pr-rla.yml"), `${readFileSync(join(s.dir, ".pr-rla.yml"), "utf8")}transparency_log: { url: "http://127.0.0.1:9", public_key_file: rekor.pub }\n`);
    const fetched: string[] = [];
    const ctx = { ...s.ctx, fetch: (async (u: string) => void fetched.push(String(u))) as unknown as typeof fetch };
    const { config } = configFor(ctx);
    expect(config.transparencyLog.publicKeyFile).toBe("rekor.pub");
    expect(await logPublicKey(ctx, config, "http://127.0.0.1:9", undefined, false)).toBeNull();
    expect((await logPublicKey(ctx, config, "https://rekor.sigstore.dev", undefined, false))?.publicKeyPem).toBe(PINNED_LOG_KEYS[0]!.publicKeyPem);
    const mine = join(mkdtempSync(join(tmpdir(), "prrla-verifier-")), "log.pub");
    writeFileSync(mine, log.publicKeyPem);
    expect(await logPublicKey(ctx, config, "http://127.0.0.1:9", [`http://127.0.0.1:9=${mine}`], true)).toMatchObject({ publicKeyPem: log.publicKeyPem, source: "verifier", operator: "log at 127.0.0.1:9" });
    expect(await logPublicKey(ctx, config, "http://127.0.0.1:10", [`http://127.0.0.1:9=${mine}`], true)).toBeNull();
    expect(fetched).toEqual([]);
  });
});

describe("review finding 3: a log run by the auditee is not an operator", () => {
  const W = "audit/2026-q3";
  let tsa: MockTsaServer;
  const evil = new MockRekor(); // the auditee's own "Rekor"
  beforeAll(async () => {
    tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b" })]).start();
    await evil.start();
  });
  afterAll(async () => {
    await tsa.stop();
    await evil.stop();
  });

  /** One genuine token of k = 2, plus an entry in the auditee's log, whose key the audit repo names in .pr-rla.yml. */
  async function auditeeLogged(): Promise<Scenario> {
    tsa.behaviour["test-b"] = { fail: 1_000_000 };
    const s = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
    s.clock.now = T("2026-10-20T00:00:00Z");
    tsa.nowMs = s.clock.now;
    expect(await registerCommand(s.ctx, {})).toBe(5); // 1 of 2
    writeFileSync(join(s.dir, "rekor.pub"), evil.publicKeyPem);
    writeFileSync(join(s.dir, ".pr-rla.yml"), `${readFileSync(join(s.dir, ".pr-rla.yml"), "utf8")}transparency_log: { url: "${evil.url}", public_key_file: rekor.pub }\n`);
    const p = join(s.dir, W, "registration.json");
    const reg = JSON.parse(readFileSync(p, "utf8")) as SignedRecord<RegistrationRecordV2>;
    evil.now = Math.floor(s.clock.now / 1000);
    reg.log = await new RekorClient(evil.url).submit(buildHashedRekord(reg)); // the envelope's log entry is unsigned
    writeFileSync(p, JSON.stringify(reg, null, 2));
    return s;
  }

  it("verify (online, no --log-key): the entry is unverified, gives no bound, and k is not met", async () => {
    const s = await auditeeLogged();
    const r = await runVerify(s.ctx, {});
    const reg = r.timestamps.registration!;
    expect(reg.logCounted).toBe(false);
    expect(reg.proven).toBe(false);
    expect(reg.operators.map((o) => o.via)).toEqual(["test-a"]);
    // Time round B: 1 of 2 is not proven, so check 1 is INCOMPLETE (it WARNed before).
    expect(r.checks[0]!.status).toBe("INCOMPLETE");
    expect(r.checks[0]!.details.join("\n")).toMatch(/registration log entry unverified: no trusted key for http:\/\/127\.0\.0\.1:\d+ /);
    expect(r.checks[0]!.details.join("\n")).toMatch(/registration timestamps: 1 of 2 TSAs \(test-a\) · k = 2 · TIMESTAMP NOT TAMPER-PROOF \(1 of 2\)/);
    expect(evil.requests.filter((q) => q.path === "/api/v1/log/publicKey")).toEqual([]); // the envelope's URL is never asked for a key
  });

  it("status: the audit repo's key does not make the registration tamper-proof", async () => {
    const s = await auditeeLogged();
    s.out.length = 0;
    expect(await statusCommand(s.ctx, { offline: true })).toBe(0);
    expect(s.out[0]).toMatch(/· TIMESTAMP NOT TAMPER-PROOF \(1 of 2\)$/);
  });

  it("a verifier who trusts that log says so with --log-key, and only then it counts", async () => {
    const s = await auditeeLogged();
    const key = join(mkdtempSync(join(tmpdir(), "prrla-verifier-")), "their-log.pub");
    writeFileSync(key, evil.publicKeyPem);
    const r = await runVerify(s.ctx, { logKey: [`${evil.url}=${key}`] });
    expect(r.timestamps.registration!.logCounted).toBe(true);
    // pass-2 review #6: counted as its own operator, never as Sigstore.
    expect(r.timestamps.registration!.operators.map((o) => o.operator)).toEqual(expect.arrayContaining([`log at ${new URL(evil.url).host}`]));
    expect(r.timestamps.registration!.operators.map((o) => o.operator)).not.toContain("Sigstore");
    expect(r.checks[0]!.details.join("\n")).toMatch(/SET and inclusion proof verified under the verifier's --log-key for http:\/\/127\.0\.0\.1:\d+; operator log at 127\.0\.0\.1:\d+/);
    // A key the verifier gave for another log vouches for nothing here.
    const other = await runVerify(s.ctx, { logKey: [`https://rekor.example.org=${key}`] });
    expect(other.timestamps.registration!.logCounted).toBe(false);
  });

  it("an entry that claims Sigstore's URL is checked under the pinned key, so a self-signed SET FAILs", async () => {
    const s = await auditeeLogged();
    const p = join(s.dir, W, "registration.json");
    const reg = JSON.parse(readFileSync(p, "utf8")) as SignedRecord<RegistrationRecordV2> & { log: LoggedEntry };
    reg.log = { ...reg.log, logUrl: "https://rekor.sigstore.dev" };
    writeFileSync(p, JSON.stringify(reg, null, 2));
    const r = await runVerify(s.ctx, { offline: true });
    expect(r.checks[0]!.status).toBe("FAIL");
    expect(r.checks[0]!.details.join("\n")).toMatch(/registration log entry: signedEntryTimestamp does not verify under the log key/);
    expect(r.timestamps.registration!.logCounted).toBe(false);
  });
});
