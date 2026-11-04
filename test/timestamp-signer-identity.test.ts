import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { verifyCommand } from "../src/commands/verify.js";
import { canonicalJson, sha256Hex } from "../src/core/canonical.js";
import type { DrawsFile, SignedRecord, TimestampEvidence } from "../src/core/records.js";
import { SHIPPED_TRUST_BUNDLE, mergeTrust, type TrustBundle } from "../src/timestamp/bundle.js";
import { assessTimestamps, checkToken, isoMs, readToken, type TokenCheck } from "../src/timestamp/verify.js";
import { makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { RECORDED, RECORDED_IDS, forgeToken, recordedToken, tokenCerts, twinOf, withCertificates } from "./helpers/forge-tsa.js";
import { makeTestAuthority, mintResponse, tokenOf, trustExtra, type TestAuthority } from "./helpers/test-tsa.js";

/**
 * Review finding 1 (critical): the certificate that verifies the CMS signature must be the one that
 * ESSCertID, the EKU check and the chain judge. Before the fix, pkijs picked the signer by the sid
 * (a SubjectKeyIdentifier could name an attacker's twin certificate) while pr-rla judged rules 4 and 6
 * on the first certificate with the signer's issuer and serial (the real one): anyone could forge a
 * token from any bundled authority. All forged tokens here are synthetic (test/helpers/forge-tsa.ts).
 */

const evidenceOf = (tsa: string, der: Uint8Array, nonce: string): TimestampEvidence => {
  const { facts } = readToken(der);
  return { kind: "rfc3161", tsa, url: "x", tokenDer: Buffer.from(der).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce };
};
const record = { anything: "the attacker wants", registeredAt: "2026-09-20T00:00:00Z" };
const data = new Uint8Array(Buffer.from(canonicalJson(record)));
const digestHex = createHash("sha256").update(data).digest("hex");
const T0 = "2026-09-20T00:00:00Z";
const forgedCheck = async (id: string, o?: Parameters<typeof forgeToken>[4]): Promise<TokenCheck> =>
  checkToken({ evidence: evidenceOf(id, await forgeToken(id, digestHex, "0102030405060708", new Date(T0), o), "0102030405060708"), data, digestHex, signedTimeIso: T0, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle: SHIPPED_TRUST_BUNDLE });
const recData = new Uint8Array(Buffer.from(canonicalJson(RECORDED.record)));
const recordedCheck = (id: string, token: Uint8Array, bundle: TrustBundle = SHIPPED_TRUST_BUNDLE): Promise<TokenCheck> =>
  checkToken({ evidence: evidenceOf(id, token, RECORDED.nonces[id]!), data: recData, digestHex: RECORDED.digest, signedTimeIso: RECORDED.registeredAt, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle });
/** The real signer's serial as pr-rla prints it: lower-case hex, no leading zeros. */
const serialOf = (id: string) => {
  const { all, signer } = tokenCerts(recordedToken(id));
  return new X509Certificate(Buffer.from(all[signer]!)).serialNumber.toLowerCase().replace(/^0+(?=.)/, "");
};

describe("review finding 1: forged tokens 'from' every bundled authority are refused (shipped trust bundle)", () => {
  it.each(RECORDED_IDS)("%s: the review's attack (SubjectKeyIdentifier sid → a twin certificate, ESSCertIDv2 → the real one) is refused", async (id) => {
    const c = await forgedCheck(id, { sid: "ski", twinAt: "last", essFor: "real" });
    expect(c.accepted).toBe(false);
    expect(c.genuine).toBe(false);
    expect(c.problems).toContain(`rule 4: 2 certificates in the token carry the signer's issuer and serial number ${serialOf(id)}; exactly one may`);
  });

  it.each(RECORDED_IDS)("%s: a twin named by issuer and serial and placed first (the certificate pkijs picks) is refused", async (id) => {
    const c = await forgedCheck(id, { sid: "issuerSerial", twinAt: "first", essFor: "real" });
    expect(c.accepted).toBe(false);
    expect(c.problems).toContain(`rule 4: 2 certificates in the token match the signer identifier (issuer and serial number ${serialOf(id)}); exactly one may`);
  });

  it("two forged operators no longer make a backdated registration PROVEN (k = 2)", async () => {
    const ev = async (tsa: string) => evidenceOf(tsa, await forgeToken(tsa, digestHex, "0a0b", new Date(T0)), "0a0b");
    const s = await assessTimestamps({ timestamps: [await ev("digicert"), await ev("globalsign")], data, digestHex, signedTimeIso: T0, timestamping: { authorities: ["sigstore", "digicert", "globalsign", "microsoft"], minTokens: 2, toleranceSeconds: 600, defaultAccuracySeconds: 60 }, bundle: SHIPPED_TRUST_BUNDLE });
    expect(s.proven).toBe(false);
    expect(s.operators).toEqual([]);
    expect(s.failed.map((f) => f.tsa)).toEqual(["digicert", "globalsign"]);
  });
});

describe("pass-2 review: a twin with its own, distinct serial (beyond the twin rule) cannot sign for an authority either", () => {
  // The twin-count rule catches a same-serial twin first; these sixteen take it out of play (the reviewer's
  // rv2-forge-variants). The twin is the only certificate the signer identifier names, so the signature verifies under
  // the attacker's key; what refuses them is that the twin chains to no pinned anchor (rule 6), and for ESS → real, rule 4.
  const variants: [string, NonNullable<Parameters<typeof forgeToken>[4]>, string[]][] = [
    ["SubjectKeyIdentifier sid, distinct serial, ESSCertID → the real signer", { sid: "ski", twinAt: "last", essFor: "real", twinSerial: 777001 }, ["rule 4: ESSCertIDv2 does not match the signer certificate"]],
    ["SubjectKeyIdentifier sid, distinct serial, ESSCertID → the twin", { sid: "ski", twinAt: "last", essFor: "twin", twinSerial: 777002 }, []],
    ["issuer-and-serial sid naming the twin, distinct serial, ESSCertID → the twin", { sid: "twinIssuerSerial", twinAt: "last", essFor: "twin", twinSerial: 777003 }, []],
    ["the same, with the real signer certificate left out", { sid: "twinIssuerSerial", twinAt: "last", essFor: "twin", twinSerial: 777004, dropReal: true }, []],
  ];
  for (const id of ["digicert", "globalsign", "microsoft", "sigstore"])
    for (const [name, o, rule4] of variants)
      it(`${id}: ${name}`, async () => {
        const c = await forgedCheck(id, o);
        expect(c.accepted).toBe(false);
        expect(c.genuine).toBe(false);
        expect(c.problems.filter((p) => p.startsWith("rule 3"))).toEqual([]); // the signature itself verifies, under the twin's key
        expect(c.problems.filter((p) => p.startsWith("rule 4"))).toEqual(rule4);
        expect(c.problems.some((p) => /^rule 6: chain .* does not reach an anchor pinned for /.test(p))).toBe(true);
      });
});

describe("review finding 1: the certificate set of a real token (unsigned) cannot smuggle in a second signer", () => {
  it.each(RECORDED_IDS)("%s: a twin appended after the real signer certificate is refused, though the signature still verifies under the real key", async (id) => {
    const token = recordedToken(id);
    const { all, signer } = tokenCerts(token);
    const twin = await twinOf(all[signer]!);
    const c = await recordedCheck(id, withCertificates(token, [...all, twin.der]));
    expect(c.accepted).toBe(false);
    expect(c.problems).toEqual([`rule 4: 2 certificates in the token match the signer identifier (issuer and serial number ${serialOf(id)}); exactly one may`]);
  });

  it.each(RECORDED_IDS)("%s: the same signer certificate carried twice is refused", async (id) => {
    const token = recordedToken(id);
    const { all, signer } = tokenCerts(token);
    const c = await recordedCheck(id, withCertificates(token, [...all, all[signer]!]));
    expect(c.accepted).toBe(false);
    expect(c.problems[0]).toMatch(/^rule 4: 2 certificates in the token match the signer identifier/);
  });

  it.each(RECORDED_IDS)("%s: the token re-assembled with its own certificates still verifies (the surgery itself changes nothing)", async (id) => {
    const token = recordedToken(id);
    const c = await recordedCheck(id, withCertificates(token, tokenCerts(token).all));
    expect(c.problems).toEqual([]);
    expect(c.accepted).toBe(true);
  });
});

describe("review finding 1: SubjectKeyIdentifier signer identifiers (RFC 5652 §5.3)", () => {
  let A: TestAuthority;
  let B: TestAuthority;
  let bundle: TrustBundle;
  beforeAll(async () => {
    A = await makeTestAuthority({ id: "test-a" });
    B = await makeTestAuthority({ id: "test-b" });
    bundle = mergeTrust(SHIPPED_TRUST_BUNDLE, [trustExtra([A, B])]);
  });
  const syn = (a: TestAuthority, der: Uint8Array) =>
    checkToken({ evidence: evidenceOf(a.id, der, "0102"), data, digestHex, signedTimeIso: T0, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle });

  it("a SubjectKeyIdentifier sid naming exactly one certificate, the one ESSCertID names, is accepted", async () => {
    const c = await syn(A, tokenOf(await mintResponse(A, { digestHex, nonceHex: "0102", genTime: new Date(T0), sidSki: true })));
    expect(c.problems).toEqual([]);
    expect(c.accepted).toBe(true);
  });

  it("a SubjectKeyIdentifier sid that resolves to a certificate other than the one ESSCertID names is refused", async () => {
    const c = await syn(A, tokenOf(await mintResponse(A, { digestHex, nonceHex: "0102", genTime: new Date(T0), sidSki: true, essFor: B.signer, extraCerts: [B.signer] })));
    expect(c.accepted).toBe(false);
    expect(c.problems).toEqual(["rule 4: ESSCertIDv2 does not match the signer certificate"]);
  });

  it("a SubjectKeyIdentifier sid matching no certificate in the token is refused", async () => {
    const der = tokenOf(await mintResponse(A, { digestHex, nonceHex: "0102", genTime: new Date(T0), sidSki: true }));
    const c = await syn(A, withCertificates(der, [new Uint8Array(B.signer.toSchema().toBER(false))]));
    expect(c.accepted).toBe(false);
    expect(c.problems).toContain(`rule 4: no certificate in the token matches the signer identifier (subject key identifier ${createHash("sha1").update(A.signer.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView).digest("hex")})`);
  });
});

describe("rule 3's own cross-check fires when the CMS library verified with another certificate (pass-2 review: it never could)", () => {
  // pr-rla resolves the signer itself, so a pkijs that agrees with it never trips this check: the only way to reach it
  // is a library that picked another certificate, simulated here by replacing pkijs's SignedData.verify (synthetic).
  let A: TestAuthority;
  let bundle: TrustBundle;
  beforeAll(async () => {
    A = await makeTestAuthority({ id: "test-a" });
    bundle = mergeTrust(SHIPPED_TRUST_BUNDLE, [trustExtra([A])]);
  });
  afterEach(() => vi.restoreAllMocks());
  const check = (der: Uint8Array) => checkToken({ evidence: evidenceOf(A.id, der, "0102"), data, digestHex, signedTimeIso: T0, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle });
  /** pkijs reports that it verified with the token's certificate `k` (or with `other`, outside the token). */
  const pkijsUses = (k: number | null, other?: pkijs.Certificate) =>
    vi.spyOn(pkijs.SignedData.prototype, "verify").mockImplementation(async function (this: pkijs.SignedData) {
      return { signatureVerified: true, signerCertificate: k === null ? other! : this.certificates![k] as pkijs.Certificate } as never;
    });
  /** A second certificate for the signer's own key (same subject and issuer, another serial), as a re-issue would carry. */
  async function sameKeyCert(): Promise<pkijs.Certificate> {
    const c = new pkijs.Certificate();
    c.version = 2;
    c.serialNumber = new asn1js.Integer({ value: 990011 });
    c.issuer = A.signer.issuer;
    c.subject = A.signer.subject;
    c.notBefore.value = new Date("2020-01-01T00:00:00Z");
    c.notAfter.value = new Date("2040-01-01T00:00:00Z");
    c.subjectPublicKeyInfo = A.signer.subjectPublicKeyInfo;
    c.extensions = A.signer.extensions;
    await c.sign(A.rootKey, "SHA-256");
    return c;
  }

  it("control: with pkijs untouched, the same token passes rule 3", async () => {
    const der = tokenOf(await mintResponse(A, { digestHex, nonceHex: "0102", genTime: new Date(T0), extraCerts: [A.root] }));
    expect((await check(der)).problems).toEqual([]);
  });

  it("another certificate of the token, with another key: both the index and the key-equality findings", async () => {
    const der = tokenOf(await mintResponse(A, { digestHex, nonceHex: "0102", genTime: new Date(T0), extraCerts: [A.root] }));
    pkijsUses(1); // the root, carried second
    const c = await check(der);
    expect(c.accepted).toBe(false);
    expect(c.problems).toEqual(["rule 3: the signature was checked with certificate 2 of the token, not the signer certificate (1)", "rule 3: the key that verified the signature is not the signer certificate's key"]);
  });

  it("another certificate of the token for the same key: the index finding alone (the keys are byte-equal)", async () => {
    const der = tokenOf(await mintResponse(A, { digestHex, nonceHex: "0102", genTime: new Date(T0), extraCerts: [await sameKeyCert()] }));
    pkijsUses(1);
    const c = await check(der);
    expect(c.accepted).toBe(false);
    expect(c.problems).toEqual(["rule 3: the signature was checked with certificate 2 of the token, not the signer certificate (1)"]);
  });

  it("a certificate that is not in the token at all", async () => {
    const der = tokenOf(await mintResponse(A, { digestHex, nonceHex: "0102", genTime: new Date(T0) }));
    pkijsUses(null, A.root);
    const c = await check(der);
    expect(c.problems).toEqual(["rule 3: the signature was checked with a certificate that is not in the token, not the signer certificate (1)", "rule 3: the key that verified the signature is not the signer certificate's key"]);
  });
});

describe("review finding 1, end to end: the review's forged audit (every authority unreachable, forged sigstore and globalsign tokens)", () => {
  const W = "audit/2026-q3";
  const readJ = <V>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as V;
  const unreachable = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
  async function addForged(s: Scenario, path: string, timeField: "registeredAt" | "frozenAt") {
    const signed = readJ<SignedRecord<Record<string, string>>>(s, path);
    const digest = sha256Hex(canonicalJson(signed.record));
    const t = signed.record[timeField]!;
    signed.timestamps = [];
    for (const tsa of ["sigstore", "globalsign"]) signed.timestamps.push(evidenceOf(tsa, await forgeToken(tsa, digest, "0a0b0c0d", new Date(t)), "0a0b0c0d"));
    writeFileSync(join(s.dir, path), `${JSON.stringify(signed, null, 2)}\n`);
  }

  it("a registration actually made after the window opened no longer verifies as PROSPECTIVE: check 1 and check 2 FAIL, exit 1", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400), fetch: unreachable, tsa: { ids: ["sigstore", "digicert", "globalsign", "microsoft"], k: 2 } });
    s.clock.now = T("2026-06-20T00:00:00Z"); // the attacker's own clock, set back
    expect(await registerCommand(s.ctx, {})).toBe(5);
    await addForged(s, `${W}/registration.json`, "registeredAt");
    s.clock.now = T("2026-10-01T06:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(5);
    await addForged(s, `${W}/manifest-commitment.json`, "frozenAt");
    s.clock.now = T("2026-10-02T06:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-02T08:00:00Z");
    for (const d of readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, 36)) if (d.firstOccurrence) await recordCommand(s.ctx, String(d.draw), "pass", { reviewer: "outside-reviewer" });
    s.git("add", "-A");
    s.git("commit", "-qm", "verdicts");
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, {})).toBe(1);
    const text = s.out.join("\n");
    expect(text).toMatch(/^1\. FAIL registration: .*PROSPECTIVE \(unproven: too few timestamps\)$/m);
    expect(text).toMatch(/FAIL registration token from sigstore: rule 4: 2 certificates in the token carry the signer's issuer and serial number/);
    expect(text).toMatch(/FAIL registration token from globalsign: rule 4: 2 certificates in the token carry the signer's issuer and serial number/);
    expect(text).toMatch(/^2\. FAIL manifest before seed/m);
    expect(text).toMatch(/registration timestamps: 0 of 4 TSAs · k = 2 · TIMESTAMP NOT TAMPER-PROOF \(0 of 2\)/);
    expect(s.out.at(-1)).toBe("FAILED: check 1 (registration), check 2 (manifest before seed)");
  });
});
