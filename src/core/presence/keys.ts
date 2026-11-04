import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { SshFormatError, SshReader, fixedWidth } from "./wire.js";

/** The OpenSSH public-key types pr-rla verifies SSHSIG signatures for. */
export const SSH_KEY_TYPES = [
  "ssh-ed25519",
  "sk-ssh-ed25519@openssh.com",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ecdsa-sha2-nistp256@openssh.com",
  "ssh-rsa",
] as const;
export type SshKeyType = (typeof SSH_KEY_TYPES)[number];

/** FIDO security-key types (OpenSSH PROTOCOL.u2f): their signatures carry a flags byte and a counter. */
export const SECURITY_KEY_TYPES: readonly SshKeyType[] = ["sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"];

export const isSshKeyType = (t: string): t is SshKeyType => (SSH_KEY_TYPES as readonly string[]).includes(t);

/** RSA keys below this size are refused (OpenSSH itself accepts 1024 bits for verification). */
export const MIN_RSA_BITS = 2048;

export interface EcCurve {
  name: "nistp256" | "nistp384" | "nistp521";
  jwk: "P-256" | "P-384" | "P-521";
  /** Bytes per coordinate. */
  size: number;
  /** The hash RFC 5656 pairs with the curve. */
  hash: "sha256" | "sha384" | "sha512";
}

const CURVES: Record<EcCurve["name"], EcCurve> = {
  nistp256: { name: "nistp256", jwk: "P-256", size: 32, hash: "sha256" },
  nistp384: { name: "nistp384", jwk: "P-384", size: 48, hash: "sha384" },
  nistp521: { name: "nistp521", jwk: "P-521", size: 66, hash: "sha512" },
};

export interface SshPublicKey {
  type: SshKeyType;
  /** The key's SSH wire encoding: what OpenSSH base64-encodes in a .pub file and compares. */
  blob: Uint8Array;
  /** `SHA256:<base64>`, as `ssh-keygen -l` prints it. */
  fingerprint: string;
  /** True for the FIDO security-key types. */
  securityKey: boolean;
  /** Security keys: the FIDO application string (usually `ssh:`). */
  application?: string;
  /** ECDSA keys: the curve. */
  curve?: EcCurve;
  /** RSA keys: the modulus size in bits. */
  bits?: number;
  /** The key for node:crypto. */
  keyObject: KeyObject;
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/**
 * Ed25519 public keys of small order (the identity, the points of order 2, 4 and 8, and the
 * non-canonical encodings of the same values: p-1, p and p+1), as libsodium's blocklist lists them.
 * A signature by such a key can verify for many messages, so pr-rla refuses the key. The sign bit
 * (the top bit of the last byte) is ignored, as libsodium does.
 */
const ED25519_SMALL_ORDER = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map((h) => Uint8Array.from(Buffer.from(h, "hex")));

/** True for an Ed25519 public key of small order (see ED25519_SMALL_ORDER). */
export function isSmallOrderEd25519(pk: Uint8Array): boolean {
  if (pk.length !== 32) return false;
  return ED25519_SMALL_ORDER.some((bad) => bad.every((b, i) => (i === 31 ? (pk[i]! & 0x7f) === b : pk[i] === b)));
}

/** FIDO application strings OpenSSH makes start with `ssh:`; another origin is a WebAuthn credential, not an SSH key. */
export const SK_APPLICATION_PREFIX = "ssh:";

function skApplication(r: SshReader, type: string): string {
  const application = r.text();
  if (!application.startsWith(SK_APPLICATION_PREFIX)) throw new SshFormatError(`the ${type} key's application ${JSON.stringify(application)} does not start with "${SK_APPLICATION_PREFIX}"`);
  return application;
}

/** `SHA256:` and the unpadded base64 of the blob's SHA-256, as OpenSSH prints fingerprints. */
export function sshFingerprint(blob: Uint8Array): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function ecPoint(q: Uint8Array, curve: EcCurve): { x: Uint8Array; y: Uint8Array } {
  if (q.length !== 1 + 2 * curve.size || q[0] !== 0x04) throw new SshFormatError(`the ${curve.name} public point is not an uncompressed point`);
  return { x: q.subarray(1, 1 + curve.size), y: q.subarray(1 + curve.size) };
}

function keyObject(jwk: Record<string, string>, type: string): KeyObject {
  try {
    return createPublicKey({ key: jwk as never, format: "jwk" });
  } catch (e) {
    throw new SshFormatError(`the ${type} public key is not a valid key (${(e as Error).message})`);
  }
}

/** Parses an OpenSSH public-key blob (RFC 4253 §6.6, RFC 5656, RFC 8709, PROTOCOL.u2f). Throws SshFormatError. */
export function parsePublicKeyBlob(blob: Uint8Array): SshPublicKey {
  const r = new SshReader(blob, "public key");
  const type = r.text();
  if (!isSshKeyType(type)) throw new SshFormatError(`key type ${JSON.stringify(type)} is not supported (supported: ${SSH_KEY_TYPES.join(", ")})`);
  const base = { type, blob, fingerprint: sshFingerprint(blob), securityKey: SECURITY_KEY_TYPES.includes(type) };
  switch (type) {
    case "ssh-ed25519":
    case "sk-ssh-ed25519@openssh.com": {
      const pk = r.string();
      if (pk.length !== 32) throw new SshFormatError(`the ${type} public key is ${pk.length} bytes, not 32`);
      if (isSmallOrderEd25519(pk)) throw new SshFormatError(`the ${type} public key is a point of small order`);
      const application = type === "sk-ssh-ed25519@openssh.com" ? skApplication(r, type) : undefined;
      r.end();
      return { ...base, ...(application !== undefined ? { application } : {}), keyObject: keyObject({ kty: "OKP", crv: "Ed25519", x: b64url(pk) }, type) };
    }
    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521":
    case "sk-ecdsa-sha2-nistp256@openssh.com": {
      const expected = type === "sk-ecdsa-sha2-nistp256@openssh.com" ? "nistp256" : (type.slice("ecdsa-sha2-".length) as EcCurve["name"]);
      const curveName = r.text();
      if (curveName !== expected) throw new SshFormatError(`a ${type} key names curve ${JSON.stringify(curveName)}`);
      const curve = CURVES[expected];
      const { x, y } = ecPoint(r.string(), curve);
      const application = type === "sk-ecdsa-sha2-nistp256@openssh.com" ? skApplication(r, type) : undefined;
      r.end();
      return { ...base, curve, ...(application !== undefined ? { application } : {}), keyObject: keyObject({ kty: "EC", crv: curve.jwk, x: b64url(x), y: b64url(y) }, type) };
    }
    case "ssh-rsa": {
      const e = r.unsignedMpint();
      const n = r.unsignedMpint();
      r.end();
      const bits = n.length === 0 ? 0 : (n.length - 1) * 8 + (32 - Math.clz32(n[0]!));
      if (bits < MIN_RSA_BITS) throw new SshFormatError(`the ssh-rsa key has ${bits} bits; pr-rla accepts ${MIN_RSA_BITS} or more`);
      // e = 1 makes every message its own signature; an even e is not a valid RSA exponent.
      if (e.length === 0 || (e.length === 1 && e[0]! <= 1) || (e[e.length - 1]! & 1) === 0) throw new SshFormatError("the ssh-rsa key's public exponent is 1 or even");
      return { ...base, bits, keyObject: keyObject({ kty: "RSA", n: b64url(n), e: b64url(e) }, type) };
    }
  }
}

/** Parses `<type> <base64>` as written in a .pub or allowed-signers file, and checks the blob says the same type. */
export function parsePublicKeyText(type: string, base64: string): SshPublicKey {
  if (!isSshKeyType(type)) throw new SshFormatError(`key type ${JSON.stringify(type)} is not supported (supported: ${SSH_KEY_TYPES.join(", ")})`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new SshFormatError(`the ${type} key is not base64`);
  const key = parsePublicKeyBlob(new Uint8Array(Buffer.from(base64, "base64")));
  if (key.type !== type) throw new SshFormatError(`the key text says ${type} but its blob is ${key.type}`);
  return key;
}

/** Exactly `size` bytes for an ECDSA signature component (r or s). */
export function ecdsaComponent(magnitude: Uint8Array, curve: EcCurve): Uint8Array {
  return fixedWidth(magnitude, curve.size, `an ECDSA ${curve.name} signature component`);
}
