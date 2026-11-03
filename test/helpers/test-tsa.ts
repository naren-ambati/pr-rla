import { createHash, webcrypto, X509Certificate } from "node:crypto";
type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
type KeyUsage = webcrypto.KeyUsage;
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { BundleCert, TrustBundleExtra } from "../../src/timestamp/bundle.js";

/**
 * Synthetic RFC 3161 authorities for tests: a test root, a timestamping signer
 * certificate and tokens minted with pkijs, plus a local mock TSA server on
 * 127.0.0.1. Every token they make is marked synthetic; none comes from a real
 * authority. Recorded real tokens live in test/fixtures/tsa/.
 */

const crypto = webcrypto as unknown as ConstructorParameters<typeof pkijs.CryptoEngine>[0]["crypto"];
pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto }));
const subtle = webcrypto.subtle;

export type TestAlg = "ECDSA-P256" | "ECDSA-P384" | "RSA" | "RSA-PSS" | "RSA-SHA1";
const ALGS: Record<TestAlg, { gen: webcrypto.EcKeyGenParams | webcrypto.RsaHashedKeyGenParams; hash: string }> = {
  "ECDSA-P256": { gen: { name: "ECDSA", namedCurve: "P-256" }, hash: "SHA-256" },
  "ECDSA-P384": { gen: { name: "ECDSA", namedCurve: "P-384" }, hash: "SHA-384" },
  RSA: { gen: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, hash: "SHA-256" },
  "RSA-PSS": { gen: { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, hash: "SHA-256" },
  "RSA-SHA1": { gen: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" }, hash: "SHA-1" },
};

const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const dn = (cn: string) => new pkijs.RelativeDistinguishedNames({ typesAndValues: [new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: cn }) })] });
let serialCounter = 100;

async function makeCert(o: { subject: string; issuer: string; publicKey: CryptoKey; issuerKey: CryptoKey; notBefore: Date; notAfter: Date; ca: boolean; eku?: { purposes: string[]; critical: boolean } | null; hash: string }): Promise<pkijs.Certificate> {
  const c = new pkijs.Certificate();
  c.version = 2;
  c.serialNumber = new asn1js.Integer({ value: serialCounter++ });
  c.subject = dn(o.subject);
  c.issuer = dn(o.issuer);
  c.notBefore.value = o.notBefore;
  c.notAfter.value = o.notAfter;
  const bc = new pkijs.BasicConstraints({ cA: o.ca });
  c.extensions = [new pkijs.Extension({ extnID: "2.5.29.19", critical: true, extnValue: bc.toSchema().toBER(false), parsedValue: bc })];
  if (o.eku) c.extensions.push(new pkijs.Extension({ extnID: "2.5.29.37", critical: o.eku.critical, extnValue: new pkijs.ExtKeyUsage({ keyPurposes: o.eku.purposes }).toSchema().toBER(false) }));
  await c.subjectPublicKeyInfo.importKey(o.publicKey);
  await c.sign(o.issuerKey, o.hash);
  return c;
}

export interface TestAuthority {
  id: string;
  operator: string;
  alg: TestAlg;
  root: pkijs.Certificate;
  signer: pkijs.Certificate;
  signerKey: CryptoKey;
  hash: string;
}

export const derOf = (c: pkijs.Certificate) => new Uint8Array(c.toSchema().toBER(false));
export const pemOf = (c: pkijs.Certificate) => new X509Certificate(Buffer.from(derOf(c))).toString();

export async function makeTestAuthority(o: {
  id: string;
  operator?: string;
  alg?: TestAlg;
  validFrom?: string;
  validTo?: string;
  signerValidFrom?: string;
  signerValidTo?: string;
  eku?: { purposes: string[]; critical: boolean } | null;
}): Promise<TestAuthority> {
  const alg = o.alg ?? "ECDSA-P256";
  const a = ALGS[alg];
  const usage: KeyUsage[] = ["sign", "verify"];
  const rootKeys = (await subtle.generateKey(a.gen, true, usage)) as CryptoKeyPair;
  const signerKeys = (await subtle.generateKey(a.gen, true, usage)) as CryptoKeyPair;
  // Certificates are signed with SHA-256 whatever the token uses, so only the token's own signature varies.
  const certHash = alg === "RSA-SHA1" ? "SHA-256" : a.hash;
  const certIssuerKey = alg === "RSA-SHA1" ? ((await subtle.generateKey(ALGS.RSA.gen, true, usage)) as CryptoKeyPair) : rootKeys;
  const root = await makeCert({ subject: `${o.id} test root`, issuer: `${o.id} test root`, publicKey: certIssuerKey.publicKey, issuerKey: certIssuerKey.privateKey, notBefore: new Date(o.validFrom ?? "2020-01-01T00:00:00Z"), notAfter: new Date(o.validTo ?? "2040-01-01T00:00:00Z"), ca: true, hash: certHash });
  const signer = await makeCert({
    subject: `${o.id} test TSA`,
    issuer: `${o.id} test root`,
    publicKey: signerKeys.publicKey,
    issuerKey: certIssuerKey.privateKey,
    notBefore: new Date(o.signerValidFrom ?? "2020-01-01T00:00:00Z"),
    notAfter: new Date(o.signerValidTo ?? "2040-01-01T00:00:00Z"),
    ca: false,
    eku: o.eku === undefined ? { purposes: ["1.3.6.1.5.5.7.3.8"], critical: true } : o.eku,
    hash: certHash,
  });
  return { id: o.id, operator: o.operator ?? `Test operator ${o.id}`, alg, root, signer, signerKey: signerKeys.privateKey, hash: a.hash };
}

export interface MintOptions {
  digestHex: string;
  nonceHex: string;
  genTime: Date;
  /** Seconds; null states no accuracy (rule 7 then uses the 60 s default). */
  accuracySeconds?: number | null;
  serial?: number;
  essV2?: boolean;
  essV1?: boolean;
  includeCerts?: boolean;
  status?: number;
  /** Name this certificate in ESSCertIDv2 instead of the signer (a mismatch fixture). */
  essFor?: pkijs.Certificate;
}

/** A DER TimeStampResp over `digestHex`, signed by the authority's test signer. */
export async function mintResponse(a: TestAuthority, o: MintOptions): Promise<Uint8Array> {
  if (o.status !== undefined && o.status !== 0 && o.status !== 1) {
    return new Uint8Array(new pkijs.TimeStampResp({ status: new pkijs.PKIStatusInfo({ status: o.status }) }).toSchema().toBER(false));
  }
  const acc = o.accuracySeconds === undefined ? 1 : o.accuracySeconds;
  const tst = new pkijs.TSTInfo({
    version: 1,
    policy: "1.3.6.1.4.1.99999.1",
    messageImprint: new pkijs.MessageImprint({ hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: "2.16.840.1.101.3.4.2.1" }), hashedMessage: new asn1js.OctetString({ valueHex: ab(new Uint8Array(Buffer.from(o.digestHex, "hex"))) }) }),
    serialNumber: new asn1js.Integer({ value: o.serial ?? serialCounter++ }),
    genTime: o.genTime,
    nonce: new asn1js.Integer({ valueHex: ab(new Uint8Array(Buffer.from(o.nonceHex.length % 2 ? `0${o.nonceHex}` : o.nonceHex, "hex"))) }),
    ...(acc === null ? {} : { accuracy: new pkijs.Accuracy({ seconds: Math.floor(acc), ...(acc % 1 ? { millis: Math.round((acc % 1) * 1000) } : {}) }) }),
  });
  const tstDer = new Uint8Array(tst.toSchema().toBER(false));
  const signerDer = derOf(a.signer);
  const attrs = [
    new pkijs.Attribute({ type: "1.2.840.113549.1.9.3", values: [new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.9.16.1.4" })] }),
    new pkijs.Attribute({ type: "1.2.840.113549.1.9.4", values: [new asn1js.OctetString({ valueHex: await subtle.digest(a.hash, ab(tstDer)) })] }),
  ];
  if (o.essV2 !== false) {
    const certHash = createHash("sha256").update(o.essFor ? derOf(o.essFor) : signerDer).digest();
    attrs.push(new pkijs.Attribute({ type: "1.2.840.113549.1.9.16.2.47", values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: ab(new Uint8Array(certHash)) })] })] })] })] }));
  }
  if (o.essV1) {
    const certHash = createHash("sha1").update(signerDer).digest();
    attrs.push(new pkijs.Attribute({ type: "1.2.840.113549.1.9.16.2.12", values: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: ab(new Uint8Array(certHash)) })] })] })] })] }));
  }
  const sd = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.9.16.1.4", eContent: new asn1js.OctetString({ valueHex: ab(tstDer) }) }),
    signerInfos: [new pkijs.SignerInfo({ version: 1, sid: new pkijs.IssuerAndSerialNumber({ issuer: a.signer.issuer, serialNumber: a.signer.serialNumber }), signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: attrs }) })],
    ...(o.includeCerts === false ? {} : { certificates: [a.signer] }),
  });
  await sd.sign(a.signerKey, 0, a.hash);
  const token = new pkijs.ContentInfo({ contentType: "1.2.840.113549.1.7.2", content: sd.toSchema(true) });
  return new Uint8Array(new pkijs.TimeStampResp({ status: new pkijs.PKIStatusInfo({ status: o.status ?? 0 }), timeStampToken: token }).toSchema().toBER(false));
}

/** The raw TimeStampToken of a response (what a record stores as tokenDer). */
export function tokenOf(resp: Uint8Array): Uint8Array {
  const seq = asn1js.fromBER(ab(resp)).result as asn1js.Sequence;
  return new Uint8Array(seq.valueBlock.value[1]!.valueBeforeDecodeView);
}

export function bundleCert(c: pkijs.Certificate, source = "synthetic test certificate"): BundleCert {
  const x = new X509Certificate(Buffer.from(derOf(c)));
  return { subject: x.subject, sha256: createHash("sha256").update(x.raw).digest("hex"), notBefore: new Date(x.validFrom).toISOString(), notAfter: new Date(x.validTo).toISOString(), pem: x.toString(), source, independent: true };
}

/** A --tsa-trust style extra bundle for test authorities served at `urls`. */
export function trustExtra(authorities: readonly TestAuthority[], urls: Record<string, string> = {}): TrustBundleExtra {
  return {
    authorities: Object.fromEntries(
      authorities.map((a) => [a.id, { operator: a.operator, url: urls[a.id] ?? `http://127.0.0.1:9/tsa/${a.id}`, defaultEnabled: false, notes: "synthetic test authority", anchors: [bundleCert(a.root)], intermediates: [] }]),
    ),
  };
}

export interface MockTsaBehaviour {
  /** Answer HTTP 503 to the first n requests. */
  fail?: number;
  /** Never answer (the broker's timeout must fire). */
  hang?: boolean;
  /** Answer with this PKIStatus (2 = rejection). */
  status?: number;
  /** genTime = clock + skew. */
  skewSeconds?: number;
  accuracySeconds?: number | null;
}

/** A local HTTP timestamp authority for each test authority, on 127.0.0.1. Uses the test's clock for genTime. */
export class MockTsaServer {
  private server: Server | null = null;
  url = "";
  /** ms since the epoch; set it from the scenario clock. */
  nowMs = Date.now();
  readonly behaviour: Record<string, MockTsaBehaviour> = {};
  readonly requests: { id: string; atMs: number; body: Buffer }[] = [];
  private readonly served: Record<string, number> = {};
  private readonly hanging: import("node:http").ServerResponse[] = [];

  constructor(readonly authorities: TestAuthority[]) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const id = req.url?.replace(/^\/tsa\//, "") ?? "";
        const a = this.authorities.find((x) => x.id === id);
        const body = Buffer.concat(chunks);
        this.requests.push({ id, atMs: this.nowMs, body });
        const b = this.behaviour[id] ?? {};
        this.served[id] = (this.served[id] ?? 0) + 1;
        if (!a) return void res.writeHead(404).end();
        if (b.hang) return void this.hanging.push(res);
        if (b.fail && this.served[id]! <= b.fail) return void res.writeHead(503).end("busy");
        try {
          const tsr = pkijs.TimeStampReq.fromBER(ab(new Uint8Array(body)));
          const der = await mintResponse(a, {
            digestHex: Buffer.from(tsr.messageImprint.hashedMessage.valueBlock.valueHexView).toString("hex"),
            nonceHex: Buffer.from(tsr.nonce!.valueBlock.valueHexView).toString("hex"),
            genTime: new Date(this.nowMs + (b.skewSeconds ?? 0) * 1000),
            accuracySeconds: b.accuracySeconds === undefined ? 1 : b.accuracySeconds,
            ...(b.status !== undefined ? { status: b.status } : {}),
          });
          res.writeHead(200, { "content-type": "application/timestamp-reply" }).end(Buffer.from(der));
        } catch (e) {
          res.writeHead(400).end(String(e));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  urlFor(id: string): string {
    return `${this.url}/tsa/${id}`;
  }

  trust(): TrustBundleExtra {
    return trustExtra(this.authorities, Object.fromEntries(this.authorities.map((a) => [a.id, this.urlFor(a.id)])));
  }

  async stop(): Promise<void> {
    for (const r of this.hanging) r.destroy();
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }
}
