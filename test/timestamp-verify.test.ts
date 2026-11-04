import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/core/canonical.js";
import { beaconParams, derivedRoundFor, effectiveTime, type LoggedEntry, type RegistrationRecord, type RegistrationRecordV2, type SignedRecord, type TimestampEvidence } from "../src/core/records.js";
import { SHIPPED_TRUST_BUNDLE, mergeTrust, type TrustBundle } from "../src/timestamp/bundle.js";
import { parseTimeStampResp } from "../src/timestamp/client.js";
import { assessTimestamps, checkToken, isoMs, notTamperProof, readToken, timestampsLine, type TokenCheck } from "../src/timestamp/verify.js";
import { readJsonFixture } from "./helpers/fixtures.js";
import { makeTestAuthority, mintResponse, tokenOf, trustExtra, type MintOptions, type TestAuthority } from "./helpers/test-tsa.js";

/** Rules 1–7 of the token acceptance rule (functional-design.md §U1), each violated once, on synthetic tokens. */

const record = { schema: "test/record", hello: "world" };
const data = new Uint8Array(Buffer.from(canonicalJson(record)));
const digestHex = createHash("sha256").update(data).digest("hex");
const T0 = "2026-11-03T12:00:00Z";
const NONCE = "1122334455667788";
let A: TestAuthority;
let bundle: TrustBundle;
const auth: Record<string, TestAuthority> = {};

async function evidence(a: TestAuthority, o: Partial<MintOptions> = {}, tsa = a.id): Promise<TimestampEvidence> {
  const der = tokenOf(await mintResponse(a, { digestHex, nonceHex: NONCE, genTime: new Date(T0), ...o }));
  const { facts } = readToken(der);
  return { kind: "rfc3161", tsa, url: `http://127.0.0.1:9/tsa/${tsa}`, tokenDer: Buffer.from(der).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce: o.nonceHex ?? NONCE };
}
const check = (ev: TimestampEvidence, over: { signedTimeIso?: string; digestHex?: string; data?: Uint8Array; bundle?: TrustBundle } = {}): Promise<TokenCheck> =>
  checkToken({ evidence: ev, data: over.data ?? data, digestHex: over.digestHex ?? digestHex, signedTimeIso: over.signedTimeIso ?? T0, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle: over.bundle ?? bundle });
const rules = (c: TokenCheck) => [...new Set(c.problems.map((p) => p.split(":")[0]))];

beforeAll(async () => {
  A = await makeTestAuthority({ id: "test-a" });
  auth.rsa = await makeTestAuthority({ id: "test-rsa", alg: "RSA" });
  auth.pss = await makeTestAuthority({ id: "test-pss", alg: "RSA-PSS" });
  auth.p384 = await makeTestAuthority({ id: "test-p384", alg: "ECDSA-P384" });
  auth.sha1 = await makeTestAuthority({ id: "test-sha1", alg: "RSA-SHA1" });
  auth.expired = await makeTestAuthority({ id: "test-expired", signerValidFrom: "2024-01-01T00:00:00Z", signerValidTo: "2025-12-31T00:00:00Z" });
  auth.notCritical = await makeTestAuthority({ id: "test-eku-noncritical", eku: { purposes: ["1.3.6.1.5.5.7.3.8"], critical: false } });
  auth.twoPurposes = await makeTestAuthority({ id: "test-eku-two", eku: { purposes: ["1.3.6.1.5.5.7.3.3", "1.3.6.1.5.5.7.3.8"], critical: true } });
  auth.foreign = await makeTestAuthority({ id: "test-foreign" });
  auth.same1 = await makeTestAuthority({ id: "sectigo-test", operator: "Sectigo (test)" });
  auth.same2 = await makeTestAuthority({ id: "entrust-test", operator: "Sectigo (test)" });
  auth.b = await makeTestAuthority({ id: "test-b", operator: "Operator B" });
  const trusted = [A, auth.rsa, auth.pss, auth.p384, auth.sha1, auth.expired, auth.notCritical, auth.twoPurposes, auth.same1, auth.same2, auth.b];
  bundle = mergeTrust(SHIPPED_TRUST_BUNDLE, [trustExtra(trusted)]);
  // test-foreign is named in the bundle, but with test-a's root: its own root is foreign.
  bundle.authorities["test-foreign"] = { ...bundle.authorities["test-a"]!, operator: "Foreign" };
});

describe("token acceptance rules 1–7 (synthetic tokens)", () => {
  it.each(["test-a", "test-rsa", "test-pss", "test-p384"])("a well-formed %s token is accepted", async (id) => {
    const a = [A, ...Object.values(auth)].find((x) => x.id === id)!;
    const c = await check(await evidence(a));
    expect(c.problems).toEqual([]);
    expect(c.accepted).toBe(true);
    expect(c.upperBoundMs).toBe(Date.parse(T0) + 1000);
  });

  it("rule 1: bytes that are not a CMS SignedData token fail", async () => {
    const ev = { ...(await evidence(A)), tokenDer: Buffer.from("not a token").toString("base64") };
    expect(rules(await check(ev))).toEqual(["rule 1"]);
  });

  it("rule 2: a wrong message imprint fails (the token is over another record)", async () => {
    const other = createHash("sha256").update("another record").digest("hex");
    const c = await check(await evidence(A, { digestHex: other }));
    expect(c.problems[0]).toMatch(/^rule 2: message imprint .* is not the record digest/);
    expect(c.accepted).toBe(false);
  });

  it("rule 2: a nonce other than the stored request nonce fails", async () => {
    const ev = { ...(await evidence(A)), nonce: "99" };
    expect((await check(ev)).problems).toContain("rule 2: token nonce 1122334455667788 is not the request nonce 99");
  });

  it("rule 3: an edited genTime fails (messageDigest no longer matches the TSTInfo)", async () => {
    const ev = await evidence(A);
    const der = Buffer.from(ev.tokenDer, "base64");
    const at = der.indexOf(Buffer.from("20261103120000"));
    Buffer.from("20261103115900").copy(der, at);
    const forged = { ...ev, tokenDer: der.toString("base64"), genTime: "2026-11-03T11:59:00Z" };
    const c = await check(forged);
    expect(rules(c)).toEqual(["rule 3"]);
    expect(c.problems.join()).toMatch(/Message digest doesn't match/);
  });

  it("rule 3: a SHA-1 signature is rejected", async () => {
    expect((await check(await evidence(auth.sha1!))).problems).toContain("rule 3: SHA-1 signature rejected");
  });

  it("rule 4: no ESSCertID, or one naming another certificate, fails", async () => {
    expect((await check(await evidence(A, { essV2: false }))).problems).toEqual(["rule 4: no ESSCertID (signing-certificate attribute)"]);
    expect((await check(await evidence(A, { essFor: A.root }))).problems).toEqual(["rule 4: ESSCertIDv2 does not match the signer certificate"]);
    // v1 only (a SHA-1 hash used as an identifier, as Sectigo does) is accepted.
    expect((await check(await evidence(A, { essV2: false, essV1: true }))).accepted).toBe(true);
  });

  it("rule 5: the EKU must be exactly timeStamping, and critical", async () => {
    expect((await check(await evidence(auth.notCritical!))).problems).toEqual(["rule 5: the extended key usage is not critical"]);
    expect((await check(await evidence(auth.twoPurposes!))).problems).toEqual(["rule 5: extended key usage is 1.3.6.1.5.5.7.3.3, 1.3.6.1.5.5.7.3.8, not exactly timeStamping"]);
  });

  it("rule 6: a foreign root fails", async () => {
    const c = await check(await evidence(auth.foreign!));
    expect(c.problems).toEqual(["rule 6: chain test-foreign test TSA does not reach an anchor pinned for test-foreign"]);
  });

  it("rule 6: an authority missing from the trust bundle fails", async () => {
    const c = await check(await evidence(A), { bundle: SHIPPED_TRUST_BUNDLE });
    expect(c.problems[0]).toMatch(/^rule 6: authority "test-a" is not in the trust bundle 2026-11 \(a verifier who trusts it can pass --tsa-trust <file>\)/);
  });

  it("rule 6: a signer certificate expired at genTime fails", async () => {
    const c = await check(await evidence(auth.expired!));
    expect(c.problems).toEqual(["rule 6: test-expired test TSA is not valid at genTime 2026-11-03T12:00:00Z (valid 2024-01-01T00:00:00Z..2025-12-31T00:00:00Z)"]);
  });

  it("rule 6 (NFR21): a token stays valid after its signer certificate expires, since validity is judged at genTime", async () => {
    const c = await check(await evidence(auth.expired!, { genTime: new Date("2025-06-01T00:00:00Z") }), { signedTimeIso: "2025-06-01T00:00:00Z" });
    expect(c.accepted).toBe(true);
  });

  it("rule 7: 10 min 61 s from the signed time with no stated accuracy fails; 10 min 59 s passes", async () => {
    const off = (s: number) => new Date(Date.parse(T0) + s * 1000);
    const fail = await check(await evidence(A, { genTime: off(661), accuracySeconds: null }));
    expect(fail.genuine).toBe(true);
    expect(fail.agrees).toBe(false);
    expect(fail.problems).toEqual(["rule 7: genTime 2026-11-03T12:11:01Z is 661 s from the signed time 2026-11-03T12:00:00Z (limit 660 s = 600 s tolerance + 60 s accuracy, the default: the token states none)"]);
    expect((await check(await evidence(A, { genTime: off(659), accuracySeconds: null }))).accepted).toBe(true);
    // Symmetric: a token much earlier than the signed time fails too.
    expect((await check(await evidence(A, { genTime: off(-661), accuracySeconds: null }))).agrees).toBe(false);
    // A stated accuracy replaces the default: 601 s passes with 1 s, 602 s does not.
    expect((await check(await evidence(A, { genTime: off(601), accuracySeconds: 1 }))).accepted).toBe(true);
    expect((await check(await evidence(A, { genTime: off(602), accuracySeconds: 1 }))).accepted).toBe(false);
  });

  it("the record's copy of genTime, serial and accuracy must match the token", async () => {
    const ev = { ...(await evidence(A)), genTime: "2026-11-03T11:00:00Z" };
    expect((await check(ev)).problems).toEqual(["record: genTime 2026-11-03T11:00:00Z does not match the token's 2026-11-03T12:00:00Z"]);
  });
});

describe("k-of-n by operator", () => {
  const ts = { authorities: ["test-a", "sectigo-test", "entrust-test", "test-b"], minTokens: 2, toleranceSeconds: 600, defaultAccuracySeconds: 60 };
  const assess = async (evs: TimestampEvidence[]) => assessTimestamps({ timestamps: evs, data, digestHex, signedTimeIso: T0, timestamping: ts, bundle });

  it("two tokens from one operator count once (Entrust's TSA returns Sectigo-signed tokens)", async () => {
    const s = await assess([await evidence(auth.same1!), await evidence(auth.same2!)]);
    expect(s.operators.map((o) => o.operator)).toEqual(["Sectigo (test)"]);
    expect(s.proven).toBe(false);
    expect(notTamperProof(s)).toBe("TIMESTAMP NOT TAMPER-PROOF (1 of 2)");
    expect(timestampsLine(s)).toBe("timestamps: 2 of 4 TSAs (sectigo-test, entrust-test) · k = 2 · TIMESTAMP NOT TAMPER-PROOF (1 of 2)");
  });

  it("k distinct operators prove it; U_k is the k-th smallest bound", async () => {
    const s = await assess([await evidence(A, { genTime: new Date("2026-11-03T12:00:03Z"), accuracySeconds: 1 }), await evidence(auth.same1!, { accuracySeconds: 2 }), await evidence(auth.b!, { genTime: new Date("2026-11-03T12:00:01Z"), accuracySeconds: null })]);
    expect(s.proven).toBe(true);
    // bounds: Sectigo (test) 12:00:02, test-a 12:00:04, test-b 12:01:01 → U_2 = 12:00:04
    expect(isoMs(s.ukMs!)).toBe("2026-11-03T12:00:04Z");
    expect(timestampsLine(s)).toBe("timestamps: 3 of 4 TSAs (test-a, sectigo-test, test-b) · k = 2 · PROVEN");
  });

  it("a failing token is reported even when k others pass", async () => {
    const bad = { ...(await evidence(A)), nonce: "1" };
    const s = await assess([bad, await evidence(auth.same1!), await evidence(auth.b!)]);
    expect(s.proven).toBe(true);
    expect(s.failed.map((f) => f.tsa)).toEqual(["test-a"]);
  });

  it("with no authority configured nothing is proven, whatever is present", async () => {
    const s = await assessTimestamps({ timestamps: [await evidence(A), await evidence(auth.b!)], data, digestHex, signedTimeIso: T0, timestamping: { ...ts, authorities: [] }, bundle });
    expect(s.proven).toBe(false);
    expect(notTamperProof(s)).toBe("TIMESTAMP NOT TAMPER-PROOF");
  });

  it("FR1.4: tokens with different genTimes, a log entry, or no `timestamps` field at all do not move the seed round", async () => {
    // A log entry whose integratedTime is 5 min after the signed time: it would give round 33245912 if it were used.
    const log = { logUrl: "http://127.0.0.1:9", uuid: "u", logIndex: 0, integratedTime: Math.floor(Date.parse("2026-10-20T00:05:00Z") / 1000), logID: "l", body: "", verification: { signedEntryTimestamp: "" } } satisfies LoggedEntry;
    const reg = (envelope: { timestamps?: TimestampEvidence[]; log?: LoggedEntry | null }): SignedRecord<RegistrationRecordV2> => ({
      record: { schema: "pr-rla/registration/v2", registeredAt: "2026-10-20T00:00:00Z", window: { name: "w", start: "2026-07-01", end: "2026-09-30", opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" }, beacon: beaconParams() } as RegistrationRecordV2,
      sha256: "",
      signature: "",
      publicKeyPem: "",
      log: envelope.log ?? null,
      ...(envelope.timestamps ? { timestamps: envelope.timestamps } : {}),
    });
    const early = await evidence(A, { genTime: new Date("2026-10-20T00:00:01Z") });
    const late = await evidence(auth.b!, { genTime: new Date("2026-10-20T00:09:00Z") });
    expect(derivedRoundFor(reg({ timestamps: [early] })).round).toBe(33245812);
    expect(derivedRoundFor(reg({ timestamps: [late] })).round).toBe(33245812);
    expect(derivedRoundFor(reg({ timestamps: [early, late], log })).round).toBe(33245812);
    // Review finding 4: dropping the unsigned `timestamps` field once handed the time to the log's integratedTime.
    expect(derivedRoundFor(reg({ log })).round).toBe(33245812);
    expect(effectiveTime(reg({ log }), "2026-10-20T00:00:00Z")).toEqual({ unix: Date.parse("2026-10-20T00:00:00Z") / 1000, iso: "2026-10-20T00:00:00Z", source: "signed" });
    // And the reverse: a v1 record keeps its log time even if `timestamps: []` is added to its envelope.
    const v1: SignedRecord<RegistrationRecord> = { ...(reg({ log }) as unknown as SignedRecord<RegistrationRecord>), record: { ...(reg({}).record as unknown as RegistrationRecord), schema: "pr-rla/registration/v1" }, timestamps: [] };
    expect(derivedRoundFor(v1).round).toBe(33245912);
    expect(effectiveTime(v1, v1.record.registeredAt).source).toBe("log");
  });
});

describe("recorded tokens from all eight bundled authorities (live 2026-11-03, hash only)", () => {
  type Rec = { record: unknown; digest: string; registeredAt: string; nonces: Record<string, string>; authorities: Record<string, { url: string; response: string; request: string }> };
  const rec = readJsonFixture<Rec>("tsa", "recorded-2026-11-03.json");
  const recData = new Uint8Array(Buffer.from(canonicalJson(rec.record)));
  const ev = (id: string): TimestampEvidence => {
    const token = parseTimeStampResp(new Uint8Array(Buffer.from(rec.authorities[id]!.response, "base64"))).token!;
    const { facts } = readToken(token);
    return { kind: "rfc3161", tsa: id, url: rec.authorities[id]!.url, tokenDer: Buffer.from(token).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce: rec.nonces[id]! };
  };

  it("the fixture holds all eight and the digest is the record's", () => {
    expect(Object.keys(rec.authorities).sort()).toEqual(Object.keys(SHIPPED_TRUST_BUNDLE.authorities).sort());
    expect(createHash("sha256").update(recData).digest("hex")).toBe(rec.digest);
  });

  it.each([
    ["sigstore", "ECDSA P-384 / SHA-256", ["sigstore-tsa", "sigstore-tsa-selfsigned"]],
    ["digicert", "RSA PKCS#1 v1.5 4096 / SHA-256", ["DigiCert SHA256 RSA4096 Timestamp Responder 2026 1", "DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1", "DigiCert Trusted Root G4"]],
    ["globalsign", "RSA PKCS#1 v1.5 3072 / SHA-384", ["Globalsign R45 TSA for CodeSign 202510", "GlobalSign Offline R45 Timestamping CA 2025", "GlobalSign Timestamping Root R45", "GlobalSign"]],
    ["microsoft", "RSA PKCS#1 v1.5 4096 / SHA-256", ["Microsoft Public RSA Time Stamping Authority", "Microsoft Public RSA Timestamping CA 2020"]],
    ["github", "ECDSA P-384 / SHA-384", ["TSA Timestamping", "TSA intermediate", "Internal Services Root"]],
    ["swisssign", "RSA PKCS#1 v1.5 3072 / SHA-256", ["SwissSign ZertES TSA UNIT A 2024 - 2", "SwissSign Qualified TSA ICA 2021 - 1", "SwissSign Signature Services Root 2020 - 2"]],
    ["sectigo", "RSA PKCS#1 v1.5 4096 / SHA-384", ["Sectigo Public Time Stamping Signer R37", "Sectigo Public Time Stamping CA R41", "Sectigo Public Time Stamping Root R46"]],
    ["freetsa", "ECDSA P-384 / SHA-512", ["www.freetsa.org", "www.freetsa.org"]],
  ])("%s's token verifies offline against the shipped bundle (%s)", async (id, alg, chain) => {
    const c = await checkToken({ evidence: ev(id), data: recData, digestHex: rec.digest, signedTimeIso: rec.registeredAt, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle: SHIPPED_TRUST_BUNDLE });
    expect(c.problems).toEqual([]);
    expect(c.accepted).toBe(true);
    expect(c.signatureAlgorithm).toBe(alg);
    expect(c.chain).toEqual(chain);
  });

  it("all eight belong to eight distinct operators", async () => {
    const ids = Object.keys(rec.authorities);
    const s = await assessTimestamps({ timestamps: ids.map(ev), data: recData, digestHex: rec.digest, signedTimeIso: rec.registeredAt, timestamping: { authorities: ids, minTokens: 8, toleranceSeconds: 600, defaultAccuracySeconds: 60 }, bundle: SHIPPED_TRUST_BUNDLE });
    expect(s.operators).toHaveLength(8);
    expect(s.proven).toBe(true);
  });

  const hasOpensslTs = spawnSync("openssl", ["ts", "-help"], { encoding: "utf8" }).status === 0;
  it.skipIf(!hasOpensslTs).each(Object.keys(SHIPPED_TRUST_BUNDLE.authorities))("oracle: `openssl ts -verify` accepts %s's recorded token with the bundle's anchors", (id) => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-oracle-"));
    const a = SHIPPED_TRUST_BUNDLE.authorities[id]!;
    writeFileSync(join(dir, "r.tsr"), Buffer.from(rec.authorities[id]!.response, "base64"));
    // Sectigo's ESSCertID list names its cross-signed chain up to USERTrust RSA, and OpenSSL requires every
    // listed certificate in the chain it builds; anchored at the self-signed R46 that pr-rla pins, OpenSSL
    // reports "ess cert id not found". pr-rla checks the first ESSCertID (the signer), as RFC 5035 requires.
    const anchors = id === "sectigo" ? [new X509Certificate(rootCertificates.find((p) => new X509Certificate(p).subject.includes("USERTrust RSA Certification Authority"))!).toString()] : a.anchors.map((c) => c.pem);
    writeFileSync(join(dir, "ca.pem"), anchors.join(""));
    writeFileSync(join(dir, "untrusted.pem"), [...a.intermediates, ...a.anchors].map((c) => c.pem).join(""));
    const args = ["ts", "-verify", "-digest", rec.digest, "-in", join(dir, "r.tsr"), "-CAfile", join(dir, "ca.pem"), "-untrusted", join(dir, "untrusted.pem")];
    if (a.anchors.every((c) => c.independent === false && !/Root/.test(c.subject))) args.push("-partial_chain"); // Microsoft: pinned at its intermediate
    expect(execFileSync("openssl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()).toBe("Verification: OK");
  });
});
