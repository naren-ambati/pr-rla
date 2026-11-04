import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/core/canonical.js";
import type { TimestampEvidence } from "../src/core/records.js";
import { SHIPPED_TRUST_BUNDLE, mergeTrust } from "../src/timestamp/bundle.js";
import { checkToken, isoMs, readToken } from "../src/timestamp/verify.js";
import { RECORDED, RECORDED_IDS, forgeToken, recordedToken, tokenCerts, twinOf, withCertificates, type ForgeOptions } from "./helpers/forge-tsa.js";
import { makeTestAuthority, mintResponse, pemOf, tokenOf, trustExtra } from "./helpers/test-tsa.js";

/**
 * A negative differential test against `openssl ts -verify` (OpenSSL 3.6.4 here; local, offline):
 * every token OpenSSL rejects for a signer-identity reason, pr-rla must reject too (review finding 1:
 * the old oracle only checked that OpenSSL accepts the real tokens). The corpus is every bundled
 * authority's recorded token, mutated in who signed it or which certificates it carries, plus
 * attacker-signed forgeries with a twin of the real signer certificate. All of it is synthetic.
 */

const hasOpensslTs = spawnSync("openssl", ["ts", "-help"], { encoding: "utf8" }).status === 0;
const dir = mkdtempSync(join(tmpdir(), "prrla-differential-"));
const NONCE = "0102030405060708";
const forgedRecord = { forged: true, registeredAt: "2026-09-20T00:00:00Z" };
const forgedData = new Uint8Array(Buffer.from(canonicalJson(forgedRecord)));
const forgedDigest = createHash("sha256").update(forgedData).digest("hex");
const recData = new Uint8Array(Buffer.from(canonicalJson(RECORDED.record)));

/** The bundle's anchors and intermediates for an authority, as OpenSSL takes them (the existing oracle's setup). */
function opensslArgs(id: string, tokenFile: string, digest: string): string[] {
  const a = SHIPPED_TRUST_BUNDLE.authorities[id]!;
  // Sectigo's ESSCertID list names its cross-signed chain up to USERTrust RSA: OpenSSL needs that root (see timestamp-verify.test.ts).
  const anchors = id === "sectigo" ? [new X509Certificate(rootCertificates.find((p) => new X509Certificate(p).subject.includes("USERTrust RSA Certification Authority"))!).toString()] : a.anchors.map((c) => c.pem);
  writeFileSync(join(dir, `${id}-ca.pem`), anchors.join(""));
  writeFileSync(join(dir, `${id}-untrusted.pem`), [...a.intermediates, ...a.anchors].map((c) => c.pem).join(""));
  const args = ["ts", "-verify", "-digest", digest, "-in", tokenFile, "-token_in", "-CAfile", join(dir, `${id}-ca.pem`), "-untrusted", join(dir, `${id}-untrusted.pem`)];
  if (a.anchors.every((c) => c.independent === false && !/Root/.test(c.subject))) args.push("-partial_chain"); // Microsoft: pinned at its intermediate
  return args;
}

function openssl(args: string[]): { ok: boolean; why: string } {
  const r = spawnSync("openssl", args, { encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  const why = out.split("\n").filter((l) => /error:|Verification:/.test(l)).map((l) => l.replace(/^[0-9A-F]+:error:[0-9A-F]+:/, "").trim()).join(" | ");
  return { ok: r.status === 0 && /Verification: OK/.test(out), why };
}

interface Case {
  id: string;
  mutation: string;
  token: Uint8Array;
  digest: string;
  data: Uint8Array;
  signedTimeIso: string;
  nonce: string;
}

const FORGERIES: Record<string, ForgeOptions> = {
  "forged: twin by SubjectKeyIdentifier, ESSCertID names the real certificate (the review's attack)": { sid: "ski", twinAt: "last", essFor: "real" },
  "forged: twin first by issuer and serial, ESSCertID names the real certificate": { sid: "issuerSerial", twinAt: "first", essFor: "real" },
  "forged: twin first by issuer and serial, ESSCertID names the twin": { sid: "issuerSerial", twinAt: "first", essFor: "twin" },
  "forged: twin last by issuer and serial, ESSCertID names the real certificate": { sid: "issuerSerial", twinAt: "last", essFor: "real" },
};

async function corpus(): Promise<Case[]> {
  const cases: Case[] = [];
  for (const [i, id] of RECORDED_IDS.entries()) {
    for (const [mutation, o] of Object.entries(FORGERIES))
      cases.push({ id, mutation, token: await forgeToken(id, forgedDigest, NONCE, new Date(forgedRecord.registeredAt), o), digest: forgedDigest, data: forgedData, signedTimeIso: forgedRecord.registeredAt, nonce: NONCE });
    const token = recordedToken(id);
    const { all, signer } = tokenCerts(token);
    const twin = (await twinOf(all[signer]!)).der;
    const others = all.filter((_, j) => j !== signer);
    const foreignSigner = (() => {
      const other = tokenCerts(recordedToken(RECORDED_IDS[(i + 1) % RECORDED_IDS.length]!));
      return other.all[other.signer]!;
    })();
    const real: Record<string, Uint8Array[] | null> = {
      "real token: a twin of the signer inserted before it": [...all.slice(0, signer), twin, ...all.slice(signer)],
      "real token: a twin of the signer appended after it": [...all, twin],
      "real token: the signer certificate carried twice": [...all, all[signer]!],
      "real token: the signer certificate removed": others.length ? others : null,
      "real token: the signer certificate replaced by another authority's signer": [...all.slice(0, signer), foreignSigner, ...all.slice(signer + 1)],
      "real token: the signer certificate replaced by its twin": [...all.slice(0, signer), twin, ...all.slice(signer + 1)],
    };
    for (const [mutation, certs] of Object.entries(real)) cases.push({ id, mutation, token: withCertificates(token, certs), digest: RECORDED.digest, data: recData, signedTimeIso: RECORDED.registeredAt, nonce: RECORDED.nonces[id]! });
  }
  return cases;
}

async function prrlaAccepts(c: Case): Promise<{ accepted: boolean; problems: string[] }> {
  const { facts } = readToken(c.token);
  const evidence: TimestampEvidence = { kind: "rfc3161", tsa: c.id, url: "x", tokenDer: Buffer.from(c.token).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce: c.nonce };
  const r = await checkToken({ evidence, data: c.data, digestHex: c.digest, signedTimeIso: c.signedTimeIso, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle: SHIPPED_TRUST_BUNDLE });
  return { accepted: r.accepted, problems: r.problems };
}

describe.skipIf(!hasOpensslTs)("negative differential against `openssl ts -verify` (review finding 1)", () => {
  let rows: (Case & { openssl: { ok: boolean; why: string }; prrla: { accepted: boolean; problems: string[] } })[] = [];
  beforeAll(async () => {
    for (const c of await corpus()) {
      const file = join(dir, `${c.id}-${rows.length}.tst`);
      writeFileSync(file, c.token);
      rows.push({ ...c, openssl: openssl(opensslArgs(c.id, file, c.digest)), prrla: await prrlaAccepts(c) });
    }
  }, 180_000); // 80 tokens forged or rebuilt, each checked by OpenSSL and by pr-rla

  it("the corpus is 10 signer-identity mutations of each of the 8 bundled authorities", () => {
    expect(rows).toHaveLength(80);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(RECORDED_IDS));
  });

  it("the unmutated recorded tokens pass both (the oracle setup is right)", async () => {
    for (const id of RECORDED_IDS) {
      const file = join(dir, `${id}-clean.tst`);
      writeFileSync(file, recordedToken(id));
      expect(openssl(opensslArgs(id, file, RECORDED.digest)), id).toEqual({ ok: true, why: "Verification: OK" });
      expect((await prrlaAccepts({ id, mutation: "none", token: recordedToken(id), digest: RECORDED.digest, data: recData, signedTimeIso: RECORDED.registeredAt, nonce: RECORDED.nonces[id]! })).accepted, id).toBe(true);
    }
  });

  it("every token OpenSSL rejects, pr-rla rejects too", () => {
    const rejectedByOpenssl = rows.filter((r) => !r.openssl.ok);
    const missed = rejectedByOpenssl.filter((r) => r.prrla.accepted).map((r) => `${r.id} · ${r.mutation} · openssl: ${r.openssl.why}`);
    expect(missed).toEqual([]);
    // Not vacuous: OpenSSL rejects every forgery and most real-token mutations, the review's attack included (64 of 80 with OpenSSL 3.6.4).
    expect(rejectedByOpenssl.length).toBeGreaterThanOrEqual(64);
    for (const id of RECORDED_IDS) expect(rows.find((r) => r.id === id && r.mutation.includes("the review's attack"))!.openssl.ok, id).toBe(false);
  });

  it("pr-rla rejects every mutation, including the ones OpenSSL accepts (a duplicate or a twin after the real signer)", () => {
    expect(rows.filter((r) => r.prrla.accepted).map((r) => `${r.id} · ${r.mutation}`)).toEqual([]);
    const opensslAccepted = rows.filter((r) => r.openssl.ok).map((r) => r.mutation);
    for (const m of new Set(opensslAccepted)) expect(m).toMatch(/^real token: (a twin of the signer appended after it|the signer certificate carried twice)$/);
  });

  it("known divergence, recorded: OpenSSL cannot decode a SubjectKeyIdentifier signer identifier at all; pr-rla accepts a consistent one (RFC 5652 §5.3)", async () => {
    const a = await makeTestAuthority({ id: "test-ski" });
    const der = tokenOf(await mintResponse(a, { digestHex: forgedDigest, nonceHex: NONCE, genTime: new Date(forgedRecord.registeredAt), sidSki: true }));
    const file = join(dir, "ski.tst");
    writeFileSync(file, der);
    writeFileSync(join(dir, "ski-ca.pem"), pemOf(a.root));
    const o = openssl(["ts", "-verify", "-digest", forgedDigest, "-in", file, "-token_in", "-CAfile", join(dir, "ski-ca.pem")]);
    expect(o.ok).toBe(false);
    expect(o.why).toMatch(/PKCS7_ISSUER_AND_SERIAL/);
    const { facts } = readToken(der);
    const c = await checkToken({ evidence: { kind: "rfc3161", tsa: a.id, url: "x", tokenDer: Buffer.from(der).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce: NONCE }, data: forgedData, digestHex: forgedDigest, signedTimeIso: forgedRecord.registeredAt, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle: mergeTrust(SHIPPED_TRUST_BUNDLE, [trustExtra([a])]) });
    expect(c.problems).toEqual([]);
    // No bundled authority uses this form: all eight recorded tokens identify the signer by issuer and serial.
    for (const id of RECORDED_IDS) expect(readToken(recordedToken(id)).signedData.signerInfos[0]!.sid.constructor.name, id).toBe("IssuerAndSerialNumber");
  });
});
