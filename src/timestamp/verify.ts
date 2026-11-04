import { X509Certificate, createHash, webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { TimestampEvidence } from "../core/records.js";
import type { TrustBundle } from "./bundle.js";

/**
 * Offline RFC 3161 token verification (functional-design.md §U1, rules 1–7).
 * Pure: no network. pkijs + asn1js parse the CMS structures and pkijs checks
 * the signature over the DER signed attributes (rule 1 and the signature part
 * of rule 3, as the design allows). pr-rla enforces rules 2, 4, 5, 6 and 7
 * itself on the parsed structures, because the library does not check them.
 *
 * One certificate for every rule: pr-rla itself finds the single certificate in
 * the token that the signer identifier names (RFC 5652 §5.3, either form) and
 * judges the signature key, ESSCertID, EKU and chain on that one certificate.
 * A token naming two candidates, carrying two certificates with the signer's
 * issuer and serial, or verified by pkijs under any other key, is refused.
 */

pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as unknown as ConstructorParameters<typeof pkijs.CryptoEngine>[0]["crypto"] }));

export const OID = {
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentTypeAttr: "1.2.840.113549.1.9.3",
  messageDigestAttr: "1.2.840.113549.1.9.4",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  extKeyUsage: "2.5.29.37",
  subjectKeyIdentifier: "2.5.29.14",
  timeStamping: "1.3.6.1.5.5.7.3.8",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  rsaPss: "1.2.840.113549.1.1.10",
} as const;

const HASH_NAMES: Record<string, string> = { [OID.sha1]: "sha1", [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512" };
const SHA1_SIGNATURES = new Set(["1.2.840.113549.1.1.5", "1.2.840.10045.4.1", "1.2.840.10040.4.3", "1.3.14.3.2.29"]);
const SIGNATURE_NAMES: Record<string, string> = {
  "1.2.840.113549.1.1.1": "RSA PKCS#1 v1.5",
  "1.2.840.113549.1.1.11": "RSA PKCS#1 v1.5",
  "1.2.840.113549.1.1.12": "RSA PKCS#1 v1.5",
  "1.2.840.113549.1.1.13": "RSA PKCS#1 v1.5",
  [OID.rsaPss]: "RSA-PSS",
  "1.2.840.10045.4.3.2": "ECDSA",
  "1.2.840.10045.4.3.3": "ECDSA",
  "1.2.840.10045.4.3.4": "ECDSA",
};

export interface TokenFacts {
  genTimeMs: number;
  /** Stated accuracy in seconds, or null if the token states none. */
  accuracySeconds: number | null;
  serial: string;
  nonce: string | null;
  policy: string;
  imprintAlgorithm: string;
  imprintHex: string;
}

export interface TokenCheck {
  tsa: string;
  operator: string | null;
  /** Rules 1–6: a well-formed token over this digest and nonce, signed by a key that chains to an anchor pinned for this authority. */
  genuine: boolean;
  /** Rule 7: genTime agrees with the record's signed time within the tolerance plus the accuracy. */
  agrees: boolean;
  accepted: boolean;
  /** Each problem names the rule it breaks, e.g. "rule 6: chain does not reach …". */
  problems: string[];
  facts: TokenFacts | null;
  /** The accuracy rule 7 used: the token's, or the default when it states none. */
  accuracySeconds: number;
  /** U = genTime + accuracy: the record existed no later than this (ms since the epoch). */
  upperBoundMs: number | null;
  signatureAlgorithm: string | null;
  /** Subjects from the signer up to the anchor that was reached. */
  chain: string[];
}

export interface TokenCheckInput {
  evidence: TimestampEvidence;
  /** canonicalJson(record) as bytes: the data whose SHA-256 is the record digest. */
  data: Uint8Array;
  /** The record digest the token must bind (signed.sha256). */
  digestHex: string;
  /** registeredAt or frozenAt. */
  signedTimeIso: string;
  toleranceSeconds: number;
  defaultAccuracySeconds: number;
  bundle: TrustBundle;
}

const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("hex");
/** Hex of a non-negative integer with no leading zeros ("0" for zero), so nonces and serials compare by value. */
export const normHex = (h: string) => h.toLowerCase().replace(/^0+(?=.)/, "");
const intHex = (i: asn1js.Integer) => normHex(hex(i.valueBlock.valueHexView));

function asBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

function parseBer(bytes: Uint8Array, what: string): asn1js.AsnType {
  const r = asn1js.fromBER(asBuffer(bytes));
  if (r.offset === -1) throw new Error(`${what} is not valid BER/DER`);
  if (r.offset !== bytes.byteLength) throw new Error(`${what} has ${bytes.byteLength - r.offset} trailing byte(s)`);
  return r.result;
}

/** The certificates [0] IMPLICIT field of a SignedData, as raw DER (pkijs re-encodes; hashes need the original bytes). */
function rawCertificates(signedDataSchema: asn1js.AsnType): Uint8Array[] {
  const seq = signedDataSchema as asn1js.Sequence;
  const field = seq.valueBlock.value.find((v) => v.idBlock.tagClass === 3 && v.idBlock.tagNumber === 0);
  if (!field) return [];
  return (field as asn1js.Constructed).valueBlock.value.map((c) => new Uint8Array(c.valueBeforeDecodeView));
}

function attribute(si: pkijs.SignerInfo, type: string): pkijs.Attribute | undefined {
  return si.signedAttrs?.attributes.find((a) => a.type === type);
}

interface EssCertId {
  hashAlgorithm: string;
  certHash: string;
  serial: string | null;
}

/** ESSCertIDv2 (RFC 5035) or ESSCertID (RFC 2634) entries of a signing-certificate attribute. */
function essCertIds(attr: pkijs.Attribute, v2: boolean): EssCertId[] {
  const value = attr.values[0] as asn1js.Sequence | undefined;
  const certs = value?.valueBlock.value[0] as asn1js.Sequence | undefined;
  if (!certs) throw new Error("empty signing-certificate attribute");
  return certs.valueBlock.value.map((entry) => {
    const parts = (entry as asn1js.Sequence).valueBlock.value;
    let i = 0;
    let hashAlgorithm: string = v2 ? OID.sha256 : OID.sha1;
    if (v2 && parts[0] instanceof asn1js.Sequence) {
      hashAlgorithm = new pkijs.AlgorithmIdentifier({ schema: parts[0] }).algorithmId;
      i = 1;
    }
    const certHash = parts[i];
    if (!(certHash instanceof asn1js.OctetString)) throw new Error("ESSCertID has no certHash");
    const issuerSerial = parts[i + 1] as asn1js.Sequence | undefined;
    const serialBlock = issuerSerial?.valueBlock.value[1];
    return { hashAlgorithm, certHash: hex(certHash.valueBlock.valueHexView), serial: serialBlock instanceof asn1js.Integer ? intHex(serialBlock) : null };
  });
}

function certTime(c: pkijs.Certificate): { notBefore: number; notAfter: number } {
  return { notBefore: c.notBefore.value.getTime(), notAfter: c.notAfter.value.getTime() };
}

function subjectOf(x: X509Certificate): string {
  const cn = /CN=([^\n]+)/.exec(x.subject)?.[1];
  return cn ?? x.subject.replace(/\n/g, ", ");
}

function verifiesUnder(cert: X509Certificate, issuer: X509Certificate): boolean {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/** One entry of the token's `certificates` field: its original DER, and the certificate (null if it is not an X.509 certificate). */
interface TokenCert {
  der: Uint8Array;
  cert: pkijs.Certificate | null;
}

function tokenCertificates(signedDataSchema: asn1js.AsnType): TokenCert[] {
  return rawCertificates(signedDataSchema).map((der) => {
    try {
      return { der, cert: pkijs.Certificate.fromBER(asBuffer(der)) };
    } catch {
      return { der, cert: null };
    }
  });
}

/** A certificate's subjectPublicKeyInfo exactly as encoded, for a byte comparison of keys. */
function spkiBytes(der: Uint8Array): Buffer {
  const tbs = (parseBer(der, "certificate") as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
  const fields = tbs.valueBlock.value;
  const versioned = fields[0]?.idBlock.tagClass === 3 && fields[0].idBlock.tagNumber === 0;
  return Buffer.from(fields[versioned ? 6 : 5]!.valueBeforeDecodeView);
}

/** An extension's value, decoded from its DER (null if absent or not DER). */
function extensionOf(c: pkijs.Certificate, oid: string): { critical: boolean; value: asn1js.AsnType | null } | null {
  const e = c.extensions?.find((x) => x.extnID === oid);
  if (!e) return null;
  const r = asn1js.fromBER(asBuffer(new Uint8Array(e.extnValue.valueBlock.valueHexView)));
  return { critical: e.critical, value: r.offset === -1 ? null : r.result };
}

const sameIssuerSerial = (a: pkijs.Certificate, b: pkijs.Certificate) => a.issuer.isEqual(b.issuer) && a.serialNumber.isEqual(b.serialNumber);

/** True if a SubjectKeyIdentifier sid names this certificate: by its SKI extension, or by the SHA-1 of its key (as pkijs resolves it). */
function keyIdNames(c: pkijs.Certificate, keyId: Buffer): boolean {
  const ski = extensionOf(c, OID.subjectKeyIdentifier)?.value;
  if (ski instanceof asn1js.OctetString && Buffer.from(ski.valueBlock.valueHexView).equals(keyId)) return true;
  return createHash("sha1").update(c.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView).digest().equals(keyId);
}

/**
 * The index of the one certificate in the token the signer identifier names (RFC 5652 §5.3), or the
 * reasons there is none: no certificate matches, several do, or several carry the signer's issuer and serial.
 */
function resolveSigner(si: pkijs.SignerInfo, certs: readonly TokenCert[]): { index: number | null; problems: string[] } {
  const all = certs.flatMap((c, i) => (c.cert ? [{ i, cert: c.cert }] : []));
  let form: string;
  let matches: number[];
  if (si.sid instanceof pkijs.IssuerAndSerialNumber) {
    const sid = si.sid;
    form = `issuer and serial number ${intHex(sid.serialNumber)}`;
    matches = all.filter((c) => c.cert.issuer.isEqual(sid.issuer) && c.cert.serialNumber.isEqual(sid.serialNumber)).map((c) => c.i);
  } else {
    // [0] SubjectKeyIdentifier: an IMPLICIT OCTET STRING (pkijs also reads a constructed [0]).
    const sid = si.sid as asn1js.BaseBlock & { valueBlock: { valueHexView?: Uint8Array; value?: asn1js.BaseBlock[] } };
    const inner = sid.idBlock.isConstructed ? (sid.valueBlock.value?.[0] as (asn1js.BaseBlock & { valueBlock: { valueHexView?: Uint8Array } }) | undefined) : sid;
    const keyId = Buffer.from(inner?.valueBlock.valueHexView ?? new Uint8Array());
    form = `subject key identifier ${keyId.toString("hex")}`;
    matches = keyId.length ? all.filter((c) => keyIdNames(c.cert, keyId)).map((c) => c.i) : [];
  }
  if (!matches.length) return { index: null, problems: [`rule 4: no certificate in the token matches the signer identifier (${form})`] };
  if (matches.length > 1) return { index: null, problems: [`rule 4: ${matches.length} certificates in the token match the signer identifier (${form}); exactly one may`] };
  const signer = certs[matches[0]!]!.cert!;
  const twins = all.filter((c) => sameIssuerSerial(c.cert, signer)).length;
  if (twins > 1) return { index: null, problems: [`rule 4: ${twins} certificates in the token carry the signer's issuer and serial number ${intHex(signer.serialNumber)}; exactly one may`] };
  return { index: matches[0]!, problems: [] };
}

/** Reads the facts of a token without judging them (rule 1 failures throw). */
export function readToken(tokenDer: Uint8Array): { facts: TokenFacts; signedData: pkijs.SignedData; signedDataSchema: asn1js.AsnType } {
  const ci = new pkijs.ContentInfo({ schema: parseBer(tokenDer, "token") });
  if (ci.contentType !== OID.signedData) throw new Error(`token content type ${ci.contentType} is not CMS SignedData`);
  const signedData = new pkijs.SignedData({ schema: ci.content });
  if (signedData.encapContentInfo.eContentType !== OID.tstInfo) throw new Error(`eContentType ${signedData.encapContentInfo.eContentType} is not TSTInfo`);
  const econtent = signedData.encapContentInfo.eContent;
  if (!econtent) throw new Error("token has no TSTInfo content");
  const tst = pkijs.TSTInfo.fromBER(econtent.getValue());
  const acc = tst.accuracy;
  const accuracySeconds = acc ? (acc.seconds ?? 0) + (acc.millis ?? 0) / 1000 + (acc.micros ?? 0) / 1e6 : null;
  return {
    signedData,
    signedDataSchema: ci.content,
    facts: {
      genTimeMs: tst.genTime.getTime(),
      accuracySeconds,
      serial: intHex(tst.serialNumber),
      nonce: tst.nonce ? intHex(tst.nonce) : null,
      policy: tst.policy,
      imprintAlgorithm: tst.messageImprint.hashAlgorithm.algorithmId,
      imprintHex: hex(tst.messageImprint.hashedMessage.valueBlock.valueHexView),
    },
  };
}

export const isoMs = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** Checks one token against rules 1–7. Never throws: every failure is a problem line. */
export async function checkToken(input: TokenCheckInput): Promise<TokenCheck> {
  const { evidence: ev, bundle } = input;
  const authority = bundle.authorities[ev.tsa];
  const out: TokenCheck = {
    tsa: ev.tsa,
    operator: authority?.operator ?? null,
    genuine: false,
    agrees: false,
    accepted: false,
    problems: [],
    facts: null,
    accuracySeconds: input.defaultAccuracySeconds,
    upperBoundMs: null,
    signatureAlgorithm: null,
    chain: [],
  };
  const p = out.problems;

  // Rule 1: a CMS SignedData token with TSTInfo content.
  let parsed: ReturnType<typeof readToken>;
  try {
    parsed = readToken(new Uint8Array(Buffer.from(ev.tokenDer, "base64")));
  } catch (e) {
    p.push(`rule 1: ${(e as Error).message}`);
    return out;
  }
  const { facts, signedData } = parsed;
  out.facts = facts;
  out.accuracySeconds = facts.accuracySeconds ?? input.defaultAccuracySeconds;
  out.upperBoundMs = facts.genTimeMs + out.accuracySeconds * 1000;

  // The copy in the record must say what the token says.
  if (ev.genTime !== isoMs(facts.genTimeMs)) p.push(`record: genTime ${ev.genTime} does not match the token's ${isoMs(facts.genTimeMs)}`);
  if (normHex(ev.serial) !== facts.serial) p.push(`record: serial ${ev.serial} does not match the token's ${facts.serial}`);
  if (ev.accuracySeconds !== facts.accuracySeconds) p.push(`record: accuracy ${ev.accuracySeconds} does not match the token's ${facts.accuracySeconds}`);

  // Rule 2: the imprint is SHA-256 over the record (that is, the record digest), and the nonce is ours.
  let imprintOk = true;
  if (facts.imprintAlgorithm !== OID.sha256) {
    p.push(`rule 2: message imprint uses ${facts.imprintAlgorithm}, not SHA-256`);
    imprintOk = false;
  } else if (facts.imprintHex !== input.digestHex.toLowerCase()) {
    p.push(`rule 2: message imprint ${facts.imprintHex.slice(0, 12)}… is not the record digest ${input.digestHex.slice(0, 12)}…`);
    imprintOk = false;
  }
  if (facts.nonce === null) p.push("rule 2: token carries no nonce");
  else if (facts.nonce !== normHex(ev.nonce)) p.push(`rule 2: token nonce ${facts.nonce} is not the request nonce ${normHex(ev.nonce)}`);

  // The signer certificate: the one certificate in the token the signer identifier names. Rules 3–6 all judge it.
  const certs = tokenCertificates(parsed.signedDataSchema);
  certs.forEach((c, i) => {
    if (!c.cert) p.push(`rule 4: entry ${i + 1} of the token's certificates is not an X.509 certificate`);
  });
  const si = signedData.signerInfos.length === 1 ? signedData.signerInfos[0] : undefined;
  let signerIndex: number | null = null;
  if (!si) p.push(`rule 3: token has ${signedData.signerInfos.length} signers, expected 1`);
  else {
    const r = resolveSigner(si, certs);
    signerIndex = r.index;
    p.push(...r.problems);
  }
  const signer = signerIndex !== null ? { der: certs[signerIndex]!.der, cert: certs[signerIndex]!.cert! } : null;

  // Rule 3: messageDigest over the TSTInfo, and the signature over the DER signedAttrs, under the signer certificate's key. No SHA-1 signature.
  if (si) {
    const sigAlg = si.signatureAlgorithm.algorithmId;
    let hashAlg = si.digestAlgorithm.algorithmId;
    if (sigAlg === OID.rsaPss) {
      try {
        hashAlg = new pkijs.RSASSAPSSParams({ schema: si.signatureAlgorithm.algorithmParams }).hashAlgorithm.algorithmId;
      } catch {
        hashAlg = OID.sha1; // RSASSA-PSS-params default
      }
    }
    if (si.digestAlgorithm.algorithmId === OID.sha1 || hashAlg === OID.sha1 || SHA1_SIGNATURES.has(sigAlg)) p.push("rule 3: SHA-1 signature rejected");
    if (!si.signedAttrs) p.push("rule 3: token has no signed attributes");
    else {
      const ct = attribute(si, OID.contentTypeAttr)?.values[0];
      if (!(ct instanceof asn1js.ObjectIdentifier) || ct.getValue() !== OID.tstInfo) p.push("rule 3: content-type attribute is not TSTInfo");
    }
    if (imprintOk) {
      let used: pkijs.Certificate | null = null;
      try {
        const r = await signedData.verify({ signer: 0, data: asBuffer(input.data), checkChain: false, extendedMode: true });
        used = r.signerCertificate ?? null;
        if (r.signatureVerified !== true) p.push("rule 3: signature over the signed attributes does not verify");
      } catch (e) {
        const err = e as pkijs.SignedDataVerifyError;
        used = err.signerCertificate ?? null;
        p.push(`rule 3: ${err.message}`);
      }
      // pkijs picks its own certificate for the signature: it must be the signer certificate, and its key byte-equal.
      if (used && signer) {
        const at = signedData.certificates?.indexOf(used) ?? -1;
        const usedDer = at >= 0 ? certs[at]?.der : undefined;
        if (at !== signerIndex) p.push(`rule 3: the signature was checked with certificate ${at + 1} of the token, not the signer certificate (${signerIndex! + 1})`);
        let sameKey = false;
        try {
          sameKey = !!usedDer && spkiBytes(usedDer).equals(spkiBytes(signer.der));
        } catch {
          sameKey = false;
        }
        if (!sameKey) p.push("rule 3: the key that verified the signature is not the signer certificate's key");
      }
    } else p.push("rule 3: signature not checked (the token is not over this record)");
    const key = signer ? new X509Certificate(Buffer.from(signer.der)).publicKey.asymmetricKeyDetails : undefined;
    const keyDesc = key?.namedCurve ? ({ prime256v1: "P-256", secp384r1: "P-384", secp521r1: "P-521" } as Record<string, string>)[key.namedCurve] ?? key.namedCurve : key?.modulusLength ? `${key.modulusLength}` : "";
    out.signatureAlgorithm = `${SIGNATURE_NAMES[sigAlg] ?? sigAlg}${keyDesc ? ` ${keyDesc}` : ""} / ${(HASH_NAMES[hashAlg] ?? hashAlg).toUpperCase().replace("SHA", "SHA-")}`;
  }

  // Rule 4: ESSCertIDv2 (or v1 as an identifier) names the signer certificate.
  if (si && signer) {
    const v2 = attribute(si, OID.signingCertificateV2);
    const v1 = attribute(si, OID.signingCertificate);
    if (!v2 && !v1) p.push("rule 4: no ESSCertID (signing-certificate attribute)");
    for (const [attr, isV2] of [[v2, true], [v1, false]] as const) {
      if (!attr) continue;
      try {
        const ids = essCertIds(attr, isV2);
        const first = ids[0];
        const alg = first ? HASH_NAMES[first.hashAlgorithm] : undefined;
        if (!first || !alg) p.push(`rule 4: ESSCertID${isV2 ? "v2" : ""} uses an unknown hash`);
        else {
          if (createHash(alg).update(signer.der).digest("hex") !== first.certHash) p.push(`rule 4: ESSCertID${isV2 ? "v2" : ""} does not match the signer certificate`);
          if (first.serial !== null && first.serial !== intHex(signer.cert.serialNumber)) p.push(`rule 4: ESSCertID${isV2 ? "v2" : ""} names serial ${first.serial}, not the signer's`);
        }
      } catch (e) {
        p.push(`rule 4: ${(e as Error).message}`);
      }
    }
  }

  // Rule 5: EKU is exactly id-kp-timeStamping, and critical.
  if (signer) {
    const eku = signer.cert.extensions?.find((e) => e.extnID === OID.extKeyUsage);
    const purposes = (eku?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? [];
    if (!eku) p.push("rule 5: signer certificate has no extended key usage");
    else {
      if (!eku.critical) p.push("rule 5: the extended key usage is not critical");
      if (purposes.length !== 1 || purposes[0] !== OID.timeStamping) p.push(`rule 5: extended key usage is ${purposes.join(", ") || "empty"}, not exactly timeStamping`);
    }
  }

  // Rule 6: the chain reaches an anchor pinned for this authority; every certificate on it is valid at genTime.
  if (!authority) p.push(`rule 6: authority "${ev.tsa}" is not in the trust bundle${bundle.version ? ` ${bundle.version}` : ""} (a verifier who trusts it can pass --tsa-trust <file>)`);
  else if (signer) {
    const anchors = authority.anchors.map((a) => new X509Certificate(a.pem));
    const pool = [...certs.flatMap((c) => (c.cert ? [new X509Certificate(Buffer.from(c.der))] : [])), ...authority.intermediates.map((c) => new X509Certificate(c.pem))];
    const path: X509Certificate[] = [new X509Certificate(Buffer.from(signer.der))];
    let reached: X509Certificate | null = null;
    for (let depth = 0; depth < 8 && !reached; depth++) {
      const cur = path[path.length - 1]!;
      const pinned = anchors.find((a) => a.fingerprint256 === cur.fingerprint256);
      if (pinned) {
        reached = pinned;
        break;
      }
      const anchor = anchors.find((a) => a.ca && verifiesUnder(cur, a));
      if (anchor) {
        reached = anchor;
        path.push(anchor);
        break;
      }
      const next = pool.find((c) => c.ca && !path.some((x) => x.fingerprint256 === c.fingerprint256) && verifiesUnder(cur, c));
      if (!next) break;
      path.push(next);
    }
    out.chain = path.map(subjectOf);
    if (!reached) p.push(`rule 6: chain ${out.chain.join(" ← ")} does not reach an anchor pinned for ${ev.tsa}`);
    else {
      for (const x of path) {
        const c = pkijs.Certificate.fromBER(asBuffer(new Uint8Array(x.raw)));
        const t = certTime(c);
        if (facts.genTimeMs < t.notBefore || facts.genTimeMs > t.notAfter) p.push(`rule 6: ${subjectOf(x)} is not valid at genTime ${isoMs(facts.genTimeMs)} (valid ${isoMs(t.notBefore)}..${isoMs(t.notAfter)})`);
        if (x !== reached && SHA1_SIGNATURES.has(c.signatureAlgorithm.algorithmId)) p.push(`rule 6: ${subjectOf(x)} is signed with SHA-1`);
      }
    }
  }
  out.genuine = p.length === 0;

  // Rule 7: |genTime − t| ≤ tolerance + accuracy (symmetric).
  const t = Date.parse(input.signedTimeIso);
  const diff = Math.abs(facts.genTimeMs - t) / 1000;
  const limit = input.toleranceSeconds + out.accuracySeconds;
  out.agrees = diff <= limit;
  if (!out.agrees) p.push(`rule 7: genTime ${isoMs(facts.genTimeMs)} is ${diff.toFixed(3).replace(/\.?0+$/, "")} s from the signed time ${input.signedTimeIso} (limit ${limit} s = ${input.toleranceSeconds} s tolerance + ${out.accuracySeconds} s accuracy${facts.accuracySeconds === null ? ", the default: the token states none" : ""})`);
  out.accepted = out.genuine && out.agrees;
  return out;
}

/** Time evidence from a Rekor v1 entry whose SET verified: one more bound, from operator Sigstore. */
export interface LogTimeEvidence {
  operator: string;
  integratedTime: number;
}

export interface OperatorBound {
  operator: string;
  /** The smallest upper bound among this operator's accepted evidence (ms). */
  upperBoundMs: number;
  via: string;
}

export interface TimeEvidenceSummary {
  configured: string[];
  k: number;
  checks: TokenCheck[];
  /** Accepted evidence, one bound per operator, ascending. */
  operators: OperatorBound[];
  /** Accepted tokens from registered authorities: the ones that count. */
  counted: TokenCheck[];
  /** Tokens from authorities the registration does not name: never counted, never a FAIL (review finding 5). */
  ignored: TokenCheck[];
  /** Configured authorities whose token was accepted, in configured order. */
  acceptedAuthorities: string[];
  logCounted: boolean;
  proven: boolean;
  /** U_k: the k-th smallest bound across distinct operators (ms), when proven. */
  ukMs: number | null;
  /** Tokens from registered authorities failing any of rules 1–7 (a verify FAIL). */
  failed: TokenCheck[];
  logProblem: string | null;
}

export interface AssessInput {
  timestamps: readonly TimestampEvidence[];
  data: Uint8Array;
  digestHex: string;
  signedTimeIso: string;
  timestamping: { authorities: readonly string[]; minTokens: number; toleranceSeconds: number; defaultAccuracySeconds: number };
  bundle: TrustBundle;
  log?: LogTimeEvidence | null;
}

/**
 * Rule-checks every token and counts accepted evidence by operator (k-of-n). Only tokens from the
 * authorities the registration names (`timestamping.authorities`) count toward k; the others are ignored.
 */
export async function assessTimestamps(input: AssessInput): Promise<TimeEvidenceSummary> {
  const checks: TokenCheck[] = [];
  for (const evidence of input.timestamps) checks.push(await checkToken({ evidence, data: input.data, digestHex: input.digestHex, signedTimeIso: input.signedTimeIso, toleranceSeconds: input.timestamping.toleranceSeconds, defaultAccuracySeconds: input.timestamping.defaultAccuracySeconds, bundle: input.bundle }));
  const registered = (c: TokenCheck) => input.timestamping.authorities.includes(c.tsa);
  const counted = checks.filter((c) => registered(c) && c.accepted && c.operator !== null && c.upperBoundMs !== null);
  const byOperator = new Map<string, OperatorBound>();
  const add = (operator: string, upperBoundMs: number, via: string) => {
    const cur = byOperator.get(operator);
    if (!cur || upperBoundMs < cur.upperBoundMs) byOperator.set(operator, { operator, upperBoundMs, via });
  };
  for (const c of counted) add(c.operator!, c.upperBoundMs!, c.tsa);
  let logCounted = false;
  let logProblem: string | null = null;
  if (input.log) {
    const diff = Math.abs(input.log.integratedTime * 1000 - Date.parse(input.signedTimeIso)) / 1000;
    if (diff > input.timestamping.toleranceSeconds + 1) logProblem = `log integratedTime is ${diff} s from the signed time ${input.signedTimeIso} (limit ${input.timestamping.toleranceSeconds + 1} s)`;
    else {
      add(input.log.operator, (input.log.integratedTime + 1) * 1000, "transparency log");
      logCounted = true;
    }
  }
  const operators = [...byOperator.values()].sort((a, b) => a.upperBoundMs - b.upperBoundMs);
  const configured = [...input.timestamping.authorities];
  const k = input.timestamping.minTokens;
  const proven = configured.length > 0 && k >= 1 && operators.length >= k;
  return {
    configured,
    k,
    checks,
    operators,
    counted,
    ignored: checks.filter((c) => !registered(c)),
    acceptedAuthorities: configured.filter((id) => counted.some((c) => c.tsa === id)),
    logCounted,
    proven,
    ukMs: proven ? operators[k - 1]!.upperBoundMs : null,
    failed: checks.filter((c) => registered(c) && !c.accepted),
    logProblem,
  };
}

/** `TIMESTAMP NOT TAMPER-PROOF`, with `(n of k)` when authorities are configured. */
export function notTamperProof(s: TimeEvidenceSummary): string {
  return s.configured.length ? `TIMESTAMP NOT TAMPER-PROOF (${s.operators.length} of ${s.k})` : "TIMESTAMP NOT TAMPER-PROOF";
}

/** e.g. `timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN`, plus `· ignored (not registered): freetsa` when a token's authority is not registered. */
export function timestampsLine(s: TimeEvidenceSummary): string {
  const ignored = s.ignored.length ? ` · ignored (not registered): ${[...new Set(s.ignored.map((c) => c.tsa))].join(", ")}` : "";
  if (!s.configured.length) return `timestamps: no authority configured${s.logCounted ? " (transparency log only)" : ""} · TIMESTAMP NOT TAMPER-PROOF${ignored}`;
  const ids = s.acceptedAuthorities.length ? ` (${s.acceptedAuthorities.join(", ")})` : "";
  const log = s.logCounted ? " + transparency log" : "";
  return `timestamps: ${s.acceptedAuthorities.length} of ${s.configured.length} TSAs${ids}${log} · k = ${s.k} · ${s.proven ? "PROVEN" : notTamperProof(s)}${ignored}`;
}

/** Median genTime of tokens that are genuine (rules 1–6), for the clock-skew refusal (FR1.8). */
export function medianGenTimeMs(checks: readonly TokenCheck[]): number | null {
  const ts = checks.filter((c) => c.genuine && c.facts).map((c) => c.facts!.genTimeMs).sort((a, b) => a - b);
  if (!ts.length) return null;
  const mid = Math.floor(ts.length / 2);
  return ts.length % 2 ? ts[mid]! : (ts[mid - 1]! + ts[mid]!) / 2;
}
