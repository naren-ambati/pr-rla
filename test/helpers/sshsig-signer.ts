import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/**
 * A software SSHSIG signer for tests (D7: software keys only), written apart from the verifier in
 * src/core/presence so that a layout mistake in one does not hide in the other. Its output is
 * cross-checked against OpenSSH's `ssh-keygen -Y verify` (test/presence-oracle.test.ts).
 *
 * For the FIDO types it is a software-emulated authenticator: it signs exactly what an
 * authenticator signs (OpenSSH PROTOCOL.u2f, "SSH U2F signatures") with a software key, so the test
 * chooses the flags byte (user presence, UP = 0x01) and the counter. That is threat T16 in
 * miniature: nothing in a signature tells a software authenticator from hardware.
 *
 * Layouts: PROTOCOL.sshsig (blob, signed data, armor) and PROTOCOL.u2f (keys and signatures),
 * OpenSSH 10.3p1.
 */

export type TestKeyType =
  | "ssh-ed25519"
  | "sk-ssh-ed25519@openssh.com"
  | "ecdsa-sha2-nistp256"
  | "ecdsa-sha2-nistp384"
  | "ecdsa-sha2-nistp521"
  | "sk-ecdsa-sha2-nistp256@openssh.com"
  | "ssh-rsa";

export interface SignOptions {
  namespace?: string;
  hash?: "sha256" | "sha512" | string;
  /** FIDO types: the authenticator flags byte (default 0x01, user present). */
  flags?: number;
  /** FIDO types: the signature counter (default 1). */
  counter?: number;
  /** RSA: the signature algorithm (default rsa-sha2-512). */
  rsaAlgorithm?: "rsa-sha2-512" | "rsa-sha2-256" | "ssh-rsa";
  /** The SSHSIG version field (default 1). */
  version?: number;
  /** Sign with this key but put another key's blob in the SSHSIG (a forged signer). */
  claimKey?: TestKey;
}

export interface TestKey {
  type: TestKeyType;
  /** The public key's SSH wire encoding. */
  blob: Uint8Array;
  /** `<type> <base64>`, as in a .pub file. */
  publicText: string;
  /** An allowed-signers line for this key. */
  allowedSigner(principal: string, options?: string): string;
  /** An armored SSHSIG over `message`. */
  sign(message: Uint8Array | string, opts?: SignOptions): string;
}

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const str = (b: Uint8Array | string) => {
  const x = typeof b === "string" ? enc(b) : b;
  return cat(u32(x.length), x);
};
/** RFC 4251 mpint of a non-negative big-endian magnitude. */
const mpint = (mag: Uint8Array) => {
  let i = 0;
  while (i < mag.length && mag[i] === 0) i++;
  const m = mag.subarray(i);
  return str(m.length && (m[0]! & 0x80) ? cat(Uint8Array.of(0), m) : m);
};
const sha = (alg: string, b: Uint8Array) => new Uint8Array(createHash(alg).update(b).digest());
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

const CURVES = {
  "ecdsa-sha2-nistp256": { node: "prime256v1", ssh: "nistp256", hash: "sha256", size: 32 },
  "ecdsa-sha2-nistp384": { node: "secp384r1", ssh: "nistp384", hash: "sha384", size: 48 },
  "ecdsa-sha2-nistp521": { node: "secp521r1", ssh: "nistp521", hash: "sha512", size: 66 },
  "sk-ecdsa-sha2-nistp256@openssh.com": { node: "prime256v1", ssh: "nistp256", hash: "sha256", size: 32 },
} as const;

/** Armor as ssh-keygen writes it: 70 base64 characters per line. */
export function armor(blob: Uint8Array): string {
  const b64 = Buffer.from(blob).toString("base64");
  return `-----BEGIN SSH SIGNATURE-----\n${b64.match(/.{1,70}/g)!.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

export function makeTestKey(type: TestKeyType, opts: { application?: string; rsaBits?: number } = {}): TestKey {
  const application = opts.application ?? "ssh:";
  const fido = type.startsWith("sk-");
  let priv: KeyObject;
  let blob: Uint8Array;
  if (type === "ssh-ed25519" || type === "sk-ssh-ed25519@openssh.com") {
    const kp = generateKeyPairSync("ed25519");
    priv = kp.privateKey;
    const pk = fromB64url(kp.publicKey.export({ format: "jwk" }).x!);
    blob = cat(str(type), str(pk), ...(fido ? [str(application)] : []));
  } else if (type === "ssh-rsa") {
    const kp = generateKeyPairSync("rsa", { modulusLength: opts.rsaBits ?? 2048 });
    priv = kp.privateKey;
    const jwk = kp.publicKey.export({ format: "jwk" });
    blob = cat(str("ssh-rsa"), mpint(fromB64url(jwk.e!)), mpint(fromB64url(jwk.n!)));
  } else {
    const c = CURVES[type];
    const kp = generateKeyPairSync("ec", { namedCurve: c.node });
    priv = kp.privateKey;
    const jwk = kp.publicKey.export({ format: "jwk" });
    blob = cat(str(type), str(c.ssh), str(cat(Uint8Array.of(4), fromB64url(jwk.x!), fromB64url(jwk.y!))), ...(fido ? [str(application)] : []));
  }
  const publicText = `${type} ${Buffer.from(blob).toString("base64")}`;

  /** The SSH signature blob over `data`. */
  const signatureBlob = (data: Uint8Array, o: SignOptions): Uint8Array => {
    if (type === "ssh-ed25519") return cat(str(type), str(new Uint8Array(sign(null, data, priv))));
    if (type === "ssh-rsa") {
      const alg = o.rsaAlgorithm ?? "rsa-sha2-512";
      const h = alg === "rsa-sha2-512" ? "sha512" : alg === "rsa-sha2-256" ? "sha256" : "sha1";
      return cat(str(alg), str(new Uint8Array(sign(h, data, priv))));
    }
    const flags = o.flags ?? 0x01;
    const counter = o.counter ?? 1;
    // PROTOCOL.u2f: the authenticator signs SHA256(application) ‖ flags ‖ counter ‖ SHA256(message).
    const signed = fido ? cat(sha("sha256", enc(application)), Uint8Array.of(flags), u32(counter), sha("sha256", data)) : data;
    if (type === "sk-ssh-ed25519@openssh.com") return cat(str(type), str(new Uint8Array(sign(null, signed, priv))), Uint8Array.of(flags), u32(counter));
    const c = CURVES[type];
    const rs = new Uint8Array(sign(c.hash, signed, { key: priv, dsaEncoding: "ieee-p1363" }));
    const ecdsa = str(cat(mpint(rs.subarray(0, c.size)), mpint(rs.subarray(c.size))));
    return fido ? cat(str(type), ecdsa, Uint8Array.of(flags), u32(counter)) : cat(str(type), ecdsa);
  };

  const key: TestKey = {
    type,
    blob,
    publicText,
    allowedSigner: (principal, options) => `${principal} ${options ? `${options} ` : ""}${publicText}`,
    sign(message, o = {}) {
      const ns = o.namespace ?? "git";
      const hash = o.hash ?? "sha512";
      const m = typeof message === "string" ? enc(message) : message;
      const digest = hash === "sha256" || hash === "sha512" ? sha(hash, m) : sha("sha512", m);
      // PROTOCOL.sshsig §3: "SSHSIG" ‖ string namespace ‖ string reserved ‖ string hash_algorithm ‖ string H(message).
      const signedData = cat(enc("SSHSIG"), str(ns), str(""), str(hash), str(digest));
      // PROTOCOL.sshsig §2: "SSHSIG" ‖ uint32 version ‖ string publickey ‖ string namespace ‖ string reserved ‖ string hash_algorithm ‖ string signature.
      return armor(cat(enc("SSHSIG"), u32(o.version ?? 1), str(o.claimKey?.blob ?? blob), str(ns), str(""), str(hash), str(signatureBlob(signedData, o))));
    },
  };
  return key;
}

/** Flips one bit of the decoded SSHSIG blob at `offsetFromEnd` bytes before its end (the signature bytes). */
export function tamperArmor(armored: string, offsetFromEnd = 10): string {
  const b64 = armored.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
  const blob = new Uint8Array(Buffer.from(b64, "base64"));
  blob[blob.length - offsetFromEnd]! ^= 0x01;
  return armor(blob);
}
