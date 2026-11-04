import { beforeAll, describe, expect, it } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { CommandContext } from "../src/commands/context.js";
import { registerCommand } from "../src/commands/register.js";
import { statusCommand } from "../src/commands/status.js";
import { verifyCommand } from "../src/commands/verify.js";
import { canonicalJson } from "../src/core/canonical.js";
import type { TimestampEvidence } from "../src/core/records.js";
import { SHIPPED_TRUST_BUNDLE, mergeTrust, type TrustBundle } from "../src/timestamp/bundle.js";
import { anchorLine, checkToken, isoMs, readToken, type TokenCheck } from "../src/timestamp/verify.js";
import { T } from "./helpers/audit-scenario.js";
import { FIXTURES } from "./helpers/fixtures.js";
import { RECORDED, RECORDED_IDS, recordedToken } from "./helpers/forge-tsa.js";
import { bundleCert, mintResponse, tokenOf, type TestAuthority } from "./helpers/test-tsa.js";

/**
 * Review finding 8: the trust bundle. Each counted authority's anchor kind and independence is printed
 * (NFR4); intermediates must be CAs allowed to issue (basicConstraints, path length, keyCertSign, and an
 * EKU that allows timestamping); under DigiCert's and GlobalSign's general-purpose roots (and SwissSign's
 * and GitHub's), only the operator's pinned TSA issuing CA may issue the signer. Real chains come from the
 * recorded tokens of 2026-11-03; the constraint fixtures are synthetic.
 */

const recData = new Uint8Array(Buffer.from(canonicalJson(RECORDED.record)));
const evidenceOf = (tsa: string, der: Uint8Array, nonce: string): TimestampEvidence => {
  const { facts } = readToken(der);
  return { kind: "rfc3161", tsa, url: "x", tokenDer: Buffer.from(der).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce };
};
const recorded = (id: string, bundle: TrustBundle = SHIPPED_TRUST_BUNDLE): Promise<TokenCheck> =>
  checkToken({ evidence: evidenceOf(id, recordedToken(id), RECORDED.nonces[id]!), data: recData, digestHex: RECORDED.digest, signedTimeIso: RECORDED.registeredAt, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle });

describe("anchors of the eight recorded chains, as verify reports them", () => {
  it.each([
    ["sigstore", "root", "sigstore-tsa-selfsigned", true, null],
    ["digicert", "root", "DigiCert Trusted Root G4", true, "DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1"],
    ["globalsign", "root", "GlobalSign", true, "GlobalSign Offline R45 Timestamping CA 2025"],
    ["microsoft", "intermediate", "Microsoft Public RSA Timestamping CA 2020", false, null],
    ["github", "root", "Internal Services Root", true, "TSA intermediate"],
    ["swisssign", "root", "SwissSign Signature Services Root 2020 - 2", false, "SwissSign Qualified TSA ICA 2021 - 1"],
    ["sectigo", "root", "Sectigo Public Time Stamping Root R46", true, null],
    ["freetsa", "root", "www.freetsa.org", false, null],
  ] as const)("%s: %s %s, independent: %s, TSA issuing CA %s", async (id, kind, subject, independent, issuingCA) => {
    const c = await recorded(id);
    expect(c.problems).toEqual([]);
    expect(c.anchor).toMatchObject({ kind, subject, independent, issuingCA });
  });

  it("the printed line names the kind and the independence (NFR4)", async () => {
    expect(anchorLine(await recorded("microsoft"))).toBe("microsoft: anchor pinned on first use (intermediate Microsoft Public RSA Timestamping CA 2020, independent: false)");
    expect(anchorLine(await recorded("digicert"))).toBe("digicert: anchor confirmed independently (root DigiCert Trusted Root G4, independent: true) · TSA issuing CA pinned (DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1)");
    expect(anchorLine(await recorded("swisssign"))).toBe("swisssign: anchor pinned on first use (root SwissSign Signature Services Root 2020 - 2, independent: false) · TSA issuing CA pinned (SwissSign Qualified TSA ICA 2021 - 1)");
  });

  it("the bundle pins the TSA issuing CAs under the general-purpose roots, and only there", () => {
    const pinned = Object.fromEntries(Object.entries(SHIPPED_TRUST_BUNDLE.authorities).map(([id, a]) => [id, (a.issuingCAs ?? []).map((i) => i.sha256.slice(0, 12))]));
    expect(pinned).toEqual({ sigstore: [], digicert: ["ca0b1554ecd9"], globalsign: ["52373a21b95b"], microsoft: [], github: ["4e0f064a5faf"], swisssign: ["715dbaf62f04"], sectigo: [], freetsa: [] });
    // Every pinned issuing CA is one of that authority's bundled intermediates.
    for (const a of Object.values(SHIPPED_TRUST_BUNDLE.authorities)) for (const i of a.issuingCAs ?? []) expect(a.intermediates.map((c) => c.sha256)).toContain(i.sha256);
  });

  it("a real DigiCert token whose issuing CA is not the pinned one is refused", async () => {
    const other = { ...SHIPPED_TRUST_BUNDLE, authorities: { ...SHIPPED_TRUST_BUNDLE.authorities, digicert: { ...SHIPPED_TRUST_BUNDLE.authorities.digicert!, issuingCAs: [{ subject: "CN=Some Other TSA CA", sha256: "00".repeat(32), source: "test" }] } } };
    const c = await recorded("digicert", other);
    expect(c.accepted).toBe(false);
    expect(c.problems).toEqual(["rule 6: the signer was issued by DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1, not by a TSA issuing CA pinned for digicert (Some Other TSA CA)"]);
  });
});

/* ---------- synthetic chains: root → intermediate(s) → timestamping leaf ---------- */

const subtle = webcrypto.subtle;
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const dn = (cn: string) => new pkijs.RelativeDistinguishedNames({ typesAndValues: [new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: cn }) })] });
let serial = 5000;
type Keys = webcrypto.CryptoKeyPair;
const newKeys = async () => (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as Keys;

interface CaOptions {
  ca?: boolean;
  critical?: boolean;
  pathLen?: number;
  /** keyUsage bits as the first byte (0x06 = keyCertSign + cRLSign); null leaves keyUsage out. */
  keyUsage?: number | null;
  eku?: string[];
}

async function cert(subject: string, issuer: { name: string; keys: Keys }, keys: Keys, o: CaOptions & { leaf?: boolean } = {}): Promise<pkijs.Certificate> {
  const c = new pkijs.Certificate();
  c.version = 2;
  c.serialNumber = new asn1js.Integer({ value: serial++ });
  c.subject = dn(subject);
  c.issuer = dn(issuer.name);
  c.notBefore.value = new Date("2020-01-01T00:00:00Z");
  c.notAfter.value = new Date("2040-01-01T00:00:00Z");
  c.extensions = [];
  if (o.leaf) {
    c.extensions.push(new pkijs.Extension({ extnID: "2.5.29.37", critical: true, extnValue: new pkijs.ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.8"] }).toSchema().toBER(false) }));
  } else {
    const bc = new pkijs.BasicConstraints({ cA: o.ca ?? true, ...(o.pathLen !== undefined ? { pathLenConstraint: o.pathLen } : {}) });
    c.extensions.push(new pkijs.Extension({ extnID: "2.5.29.19", critical: o.critical ?? true, extnValue: bc.toSchema().toBER(false) }));
    const ku = o.keyUsage === undefined ? 0x06 : o.keyUsage;
    if (ku !== null) c.extensions.push(new pkijs.Extension({ extnID: "2.5.29.15", critical: true, extnValue: new asn1js.BitString({ valueHex: ab(new Uint8Array([ku])), unusedBits: 1 }).toBER(false) }));
    if (o.eku) c.extensions.push(new pkijs.Extension({ extnID: "2.5.29.37", critical: false, extnValue: new pkijs.ExtKeyUsage({ keyPurposes: o.eku }).toSchema().toBER(false) }));
  }
  await c.subjectPublicKeyInfo.importKey(keys.publicKey);
  await c.sign(issuer.keys.privateKey, "SHA-256");
  return c;
}

/** An authority whose signer sits under `chain` (intermediates, top first) below a self-signed root; returns the token and a bundle trusting the root. */
async function chained(id: string, chain: CaOptions[], issuing?: "first" | "none"): Promise<{ check: TokenCheck }> {
  const rootKeys = await newKeys();
  const rootName = `${id} root`;
  const root = await cert(rootName, { name: rootName, keys: rootKeys }, rootKeys, { pathLen: undefined });
  let up = { name: rootName, keys: rootKeys };
  const inters: pkijs.Certificate[] = [];
  for (const [i, o] of chain.entries()) {
    const k = await newKeys();
    const name = `${id} CA ${i + 1}`;
    inters.push(await cert(name, up, k, o));
    up = { name, keys: k };
  }
  const leafKeys = await newKeys();
  const leaf = await cert(`${id} TSA`, up, leafKeys, { leaf: true });
  const a: TestAuthority = { id, operator: `Operator ${id}`, alg: "ECDSA-P256", root, rootKey: rootKeys.privateKey, signer: leaf, signerKey: leafKeys.privateKey, hash: "SHA-256" };
  const data = new Uint8Array(Buffer.from("record"));
  const digestHex = createHash("sha256").update(data).digest("hex");
  const der = tokenOf(await mintResponse(a, { digestHex, nonceHex: "0102", genTime: new Date("2026-11-03T12:00:00Z"), extraCerts: [...inters].reverse() }));
  const issuingCAs = issuing === "first" && inters.length ? [{ subject: `CN=${id} CA 1`, sha256: bundleCert(inters[0]!).sha256, source: "synthetic" }] : undefined;
  const bundle = mergeTrust(SHIPPED_TRUST_BUNDLE, [{ authorities: { [id]: { operator: a.operator, url: "http://127.0.0.1:9", anchors: [bundleCert(root)], intermediates: [], ...(issuingCAs ? { issuingCAs } : {}) } } }]);
  const check = await checkToken({ evidence: evidenceOf(id, der, "0102"), data, digestHex, signedTimeIso: "2026-11-03T12:00:00Z", toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle });
  return { check };
}

describe("intermediate CA constraints (rule 6, synthetic chains)", () => {
  let ok: TokenCheck;
  beforeAll(async () => {
    ok = (await chained("good", [{ pathLen: 0, eku: ["1.3.6.1.5.5.7.3.8"] }])).check;
  });

  it("a well-formed chain is accepted (critical cA, keyCertSign, path length, timestamping EKU)", () => {
    expect(ok.problems).toEqual([]);
    expect(ok.chain).toEqual(["good TSA", "good CA 1", "good root"]);
  });

  it("an intermediate whose basicConstraints is not critical, or not cA, is refused", async () => {
    expect((await chained("nc", [{ critical: false }])).check.problems).toEqual(["rule 6: nc CA 1 is not marked as a CA (basicConstraints must be present, critical and cA)"]);
  });

  it("an intermediate with no keyUsage, or one without keyCertSign, is refused", async () => {
    // No keyUsage at all: OpenSSL's issuer check lets it issue; pr-rla's own check refuses it.
    expect((await chained("noku", [{ keyUsage: null }])).check.problems).toEqual(["rule 6: noku CA 1 may not sign certificates (its keyUsage lacks keyCertSign)"]);
    // A keyUsage without keyCertSign: node's checkIssued (OpenSSL X509_check_issued) already refuses the link, so no chain forms.
    expect((await chained("ku", [{ keyUsage: 0x80 }])).check.problems).toEqual(["rule 6: chain ku TSA does not reach an anchor pinned for ku"]);
  });

  it("a path length constraint is honoured", async () => {
    const c = (await chained("pl", [{ pathLen: 0 }, {}])).check;
    expect(c.chain).toEqual(["pl TSA", "pl CA 2", "pl CA 1", "pl root"]);
    expect(c.problems).toEqual(["rule 6: pl CA 1 allows 0 intermediate CA(s) below it, but the chain to pl's signer has 1"]);
    expect((await chained("pl1", [{ pathLen: 1 }, {}])).check.problems).toEqual([]);
  });

  it("an intermediate that restricts its EKU to something other than timestamping is refused", async () => {
    expect((await chained("eku", [{ eku: ["1.3.6.1.5.5.7.3.3"] }])).check.problems).toEqual(["rule 6: eku CA 1 restricts its extended key usage to 1.3.6.1.5.5.7.3.3, which excludes timeStamping"]);
    expect((await chained("any", [{ eku: ["2.5.29.37.0"] }])).check.problems).toEqual([]);
  });

  it("with a pinned TSA issuing CA, a timestamping leaf issued by any other CA under the same root does not count", async () => {
    expect((await chained("pin", [{}], "first")).check.problems).toEqual([]);
    // Two levels: the pinned CA is CA 1, but the leaf's direct issuer is CA 2.
    expect((await chained("pin2", [{}, {}], "first")).check.problems).toEqual(["rule 6: the signer was issued by pin2 CA 2, not by a TSA issuing CA pinned for pin2 (pin2 CA 1)"]);
  });
});

describe("NFR4: register, verify and status print each counted authority's anchor and independence (the recorded demo, replayed offline)", () => {
  type Rec = { registeredAt: string; nonces: Record<string, string>; authorities: Record<string, { url: string; request: string; status: number; contentType: string; response: string }> };
  const rec = RECORDED as unknown as Rec;
  const replay = (async (input: string | URL) => {
    const url = new URL(String(input)).href;
    const ex = Object.values(rec.authorities).find((e) => new URL(e.url).href === url);
    if (!ex) throw new Error(`no recorded exchange for ${url}`);
    return new Response(Buffer.from(ex.response, "base64"), { status: ex.status, headers: { "content-type": ex.contentType } });
  }) as typeof fetch;
  const out: string[] = [];
  let ctx: CommandContext;
  const LINES = [
    "sigstore: anchor confirmed independently (root sigstore-tsa-selfsigned, independent: true)",
    "digicert: anchor confirmed independently (root DigiCert Trusted Root G4, independent: true) · TSA issuing CA pinned (DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1)",
    "globalsign: anchor confirmed independently (root GlobalSign, independent: true) · TSA issuing CA pinned (GlobalSign Offline R45 Timestamping CA 2025)",
    "microsoft: anchor pinned on first use (intermediate Microsoft Public RSA Timestamping CA 2020, independent: false)",
  ];
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-anchors-"));
    cpSync(join(FIXTURES, "audits", "tsa-demo"), dir, { recursive: true });
    ctx = { cwd: dir, env: {}, nowMs: () => T(rec.registeredAt), fetch: replay, nonceFor: (id) => new Uint8Array(Buffer.from(rec.nonces[id]!, "hex")), out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) };
    expect(await registerCommand(ctx, {})).toBe(0);
  });

  it("register", () => {
    const i = out.indexOf("  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(out.slice(i + 1, i + 5)).toEqual(LINES.map((l) => `    ${l}`));
  });

  it("verify", async () => {
    out.length = 0;
    await verifyCommand(ctx, { offline: true });
    for (const l of LINES) expect(out).toContain(`        registration ${l}`);
  });

  it("status", async () => {
    out.length = 0;
    expect(await statusCommand(ctx, { offline: true })).toBe(0);
    expect(out[0]).toMatch(/^PROSPECTIVE · window not yet open · seed round \d+ not yet published$/);
    expect(out[1]).toBe(`  timestamp anchors: ${LINES.join(" · ")}`);
  });

  it("every one of the eight is covered by the recorded fixture", () => {
    expect(RECORDED_IDS.sort()).toEqual(Object.keys(SHIPPED_TRUST_BUNDLE.authorities).sort());
  });
});
