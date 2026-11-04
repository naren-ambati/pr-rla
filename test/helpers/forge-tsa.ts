import { createHash, webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { parseTimeStampResp } from "../../src/timestamp/client.js";
import { readToken } from "../../src/timestamp/verify.js";
import { readJsonFixture } from "./fixtures.js";

/**
 * Synthetic forgeries of real authorities' tokens, for the signer-identity regression tests (review
 * finding 1). Nothing here touches an authority: the real certificates are copied from the recorded
 * responses in test/fixtures/tsa/recorded-2026-11-03.json, and every forged token is signed with a
 * key generated in the test. Every token this module makes is synthetic.
 */

const subtle = webcrypto.subtle;
pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as unknown as ConstructorParameters<typeof pkijs.CryptoEngine>[0]["crypto"] }));
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export type Recorded = { record: unknown; digest: string; registeredAt: string; nonces: Record<string, string>; authorities: Record<string, { url: string; response: string }> };
export const RECORDED = readJsonFixture<Recorded>("tsa", "recorded-2026-11-03.json");
export const RECORDED_IDS = Object.keys(RECORDED.authorities);

/** The recorded real token (DER) of an authority. */
export function recordedToken(id: string): Uint8Array {
  return parseTimeStampResp(new Uint8Array(Buffer.from(RECORDED.authorities[id]!.response, "base64"))).token!;
}

/** The DER certificates a token carries, in order, and the index of its real signer (issuerAndSerialNumber sid). */
export function tokenCerts(token: Uint8Array): { all: Uint8Array[]; signer: number } {
  const { signedData, signedDataSchema } = readToken(token);
  const field = (signedDataSchema as asn1js.Sequence).valueBlock.value.find((v) => v.idBlock.tagClass === 3 && v.idBlock.tagNumber === 0) as asn1js.Constructed | undefined;
  const all = (field?.valueBlock.value ?? []).map((c) => new Uint8Array(c.valueBeforeDecodeView));
  const sid = signedData.signerInfos[0]!.sid as pkijs.IssuerAndSerialNumber;
  const signer = all.findIndex((r) => {
    const c = pkijs.Certificate.fromBER(ab(r));
    return c.serialNumber.isEqual(sid.serialNumber) && c.issuer.isEqual(sid.issuer);
  });
  return { all, signer };
}

/** A twin of a real certificate: the same issuer, serial and subject, the attacker's key, a critical timeStamping EKU; self-signed. */
export async function twinOf(realDer: Uint8Array, serial?: number): Promise<{ der: Uint8Array; cert: pkijs.Certificate; key: webcrypto.CryptoKey }> {
  const real = pkijs.Certificate.fromBER(ab(realDer));
  const keys = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const twin = new pkijs.Certificate();
  twin.version = 2;
  twin.serialNumber = serial !== undefined ? new asn1js.Integer({ value: serial }) : real.serialNumber;
  twin.issuer = real.issuer;
  twin.subject = real.subject;
  twin.notBefore.value = new Date("2020-01-01T00:00:00Z");
  twin.notAfter.value = new Date("2040-01-01T00:00:00Z");
  twin.extensions = [new pkijs.Extension({ extnID: "2.5.29.37", critical: true, extnValue: new pkijs.ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.8"] }).toSchema().toBER(false) })];
  await twin.subjectPublicKeyInfo.importKey(keys.publicKey);
  await twin.sign(keys.privateKey, "SHA-256");
  return { der: new Uint8Array(twin.toSchema().toBER(false)), cert: twin, key: keys.privateKey };
}

export interface ForgeOptions {
  /**
   * The signer identifier: a SubjectKeyIdentifier of the twin's key (pkijs then picks the twin), the real issuer and
   * serial, or the twin's own issuer and serial (`twinIssuerSerial`: with a distinct `twinSerial`, it names the twin alone).
   */
  sid: "ski" | "issuerSerial" | "twinIssuerSerial";
  /** The twin's serial, when it is not the real signer's (pass-2 review: distinct-serial forgeries, beyond the twin rule). */
  twinSerial?: number;
  /** Leave the real signer certificate out of the token. */
  dropReal?: boolean;
  /** Where the twin goes among the copied real certificates. */
  twinAt: "first" | "last";
  /** Which certificate ESSCertIDv2 names. */
  essFor: "real" | "twin";
}

/**
 * A token "from" authority `id`, signed with the attacker's own key: the real certificates copied from a
 * recorded token, plus a twin of the real signer. The review's attack is { sid: "ski", twinAt: "last", essFor: "real" }.
 */
export async function forgeToken(id: string, digestHex: string, nonceHex: string, genTime: Date, o: ForgeOptions = { sid: "ski", twinAt: "last", essFor: "real" }): Promise<Uint8Array> {
  const { all, signer } = tokenCerts(recordedToken(id));
  const realDer = all[signer]!;
  const twin = await twinOf(realDer, o.twinSerial);
  const tst = new pkijs.TSTInfo({
    version: 1,
    policy: "1.3.6.1.4.1.99999.1",
    messageImprint: new pkijs.MessageImprint({ hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: "2.16.840.1.101.3.4.2.1" }), hashedMessage: new asn1js.OctetString({ valueHex: ab(new Uint8Array(Buffer.from(digestHex, "hex"))) }) }),
    serialNumber: new asn1js.Integer({ value: 424242 }),
    genTime,
    nonce: new asn1js.Integer({ valueHex: ab(new Uint8Array(Buffer.from(nonceHex, "hex"))) }),
    accuracy: new pkijs.Accuracy({ seconds: 1 }),
  });
  const tstDer = new Uint8Array(tst.toSchema().toBER(false));
  const essHash = createHash("sha256").update(o.essFor === "real" ? realDer : twin.der).digest();
  const attrs = [
    new pkijs.Attribute({ type: "1.2.840.113549.1.9.3", values: [new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.9.16.1.4" })] }),
    new pkijs.Attribute({ type: "1.2.840.113549.1.9.4", values: [new asn1js.OctetString({ valueHex: await subtle.digest("SHA-256", ab(tstDer)) })] }),
    new pkijs.Attribute({ type: "1.2.840.113549.1.9.16.2.47", values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: ab(new Uint8Array(essHash)) })] })] })] })] }),
  ];
  const ski = createHash("sha1").update(Buffer.from(twin.cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)).digest();
  const real = pkijs.Certificate.fromBER(ab(realDer));
  const sid =
    o.sid === "ski"
      ? new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: ab(new Uint8Array(ski)) })
      : o.sid === "twinIssuerSerial"
        ? new pkijs.IssuerAndSerialNumber({ issuer: twin.cert.issuer, serialNumber: twin.cert.serialNumber })
        : new pkijs.IssuerAndSerialNumber({ issuer: real.issuer, serialNumber: real.serialNumber });
  const copied = all.filter((d) => !(o.dropReal && d === realDer)).map((d) => pkijs.Certificate.fromBER(ab(d)));
  const certs = o.twinAt === "first" ? [twin.cert, ...copied] : [...copied, twin.cert];
  const sd = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.9.16.1.4", eContent: new asn1js.OctetString({ valueHex: ab(tstDer) }) }),
    signerInfos: [new pkijs.SignerInfo({ version: o.sid === "ski" ? 3 : 1, sid, signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: attrs }) })],
    certificates: certs,
  });
  await sd.sign(twin.key, 0, "SHA-256");
  return new Uint8Array(new pkijs.ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: sd.toSchema(true) }).toSchema().toBER(false));
}

/** DER TLV with a definite length. */
function tlv(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return new Uint8Array([tag, ...len, ...content]);
}
const cat = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));

/**
 * A real token with its (unsigned) certificate set replaced, every other byte as the authority signed it.
 * `certs` null drops the field. The signature still verifies under the real signer's key.
 */
export function withCertificates(token: Uint8Array, certs: Uint8Array[] | null): Uint8Array {
  const ci = asn1js.fromBER(ab(token)).result as asn1js.Sequence;
  const [oid, wrapper] = ci.valueBlock.value as [asn1js.AsnType, asn1js.Constructed];
  const sd = wrapper.valueBlock.value[0] as asn1js.Sequence;
  const children = sd.valueBlock.value;
  const isCerts = (v: asn1js.AsnType) => v.idBlock.tagClass === 3 && v.idBlock.tagNumber === 0;
  const parts: Uint8Array[] = [];
  let placed = false;
  for (const c of children) {
    if (isCerts(c)) {
      if (certs) parts.push(tlv(0xa0, cat(certs)));
      placed = true;
      continue;
    }
    // [0] certificates sits after encapContentInfo (the third child) and before crls / signerInfos.
    if (!placed && certs && (c.idBlock.tagClass === 3 || c.idBlock.tagNumber === 17) && parts.length >= 3) {
      parts.push(tlv(0xa0, cat(certs)));
      placed = true;
    }
    parts.push(new Uint8Array(c.valueBeforeDecodeView));
  }
  return tlv(0x30, cat([new Uint8Array(oid.valueBeforeDecodeView), tlv(0xa0, tlv(0x30, cat(parts)))]));
}
