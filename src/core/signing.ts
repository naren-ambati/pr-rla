import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "./canonical.js";
import { recordSha256, type SignedRecord } from "./records.js";

export interface SigningKey {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Loads an ECDSA P-256 key (PEM, PKCS#8) or creates one with mode 0600. */
export function loadOrCreateKey(path: string): SigningKey {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const priv = createPrivateKey(readFileSync(path, "utf8"));
  return {
    privateKeyPem: priv.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: createPublicKey(priv).export({ type: "spki", format: "pem" }).toString(),
  };
}

/** An unsaved key, for dry runs. */
export function ephemeralKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

/** Signs a record. A schema-v2 record gets an empty `timestamps` list for its RFC 3161 tokens; v1 records keep the v1 envelope. */
export function signRecord<T>(record: T, key: SigningKey): SignedRecord<T> {
  const bytes = Buffer.from(canonicalJson(record));
  const signature = sign("sha256", bytes, createPrivateKey(key.privateKeyPem)).toString("base64");
  const v2 = /\/v2$/.test(String((record as { schema?: unknown }).schema ?? ""));
  return { record, sha256: recordSha256(record), signature, publicKeyPem: key.publicKeyPem, log: null, ...(v2 ? { timestamps: [] } : {}) };
}

export function verifySignedRecord(signed: SignedRecord<unknown>): { ok: boolean; reason?: string } {
  const digest = recordSha256(signed.record);
  if (digest !== signed.sha256) return { ok: false, reason: `record hash ${digest.slice(0, 12)}… does not match stated ${signed.sha256.slice(0, 12)}…` };
  try {
    const ok = verify("sha256", Buffer.from(canonicalJson(signed.record)), createPublicKey(signed.publicKeyPem), Buffer.from(signed.signature, "base64"));
    return ok ? { ok } : { ok, reason: "signature does not verify against the record's public key" };
  } catch (e) {
    return { ok: false, reason: `signature check failed: ${(e as Error).message}` };
  }
}
