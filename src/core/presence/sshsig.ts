import { constants, createHash, verify } from "node:crypto";
import { ecdsaComponent, parsePublicKeyBlob, type SshPublicKey } from "./keys.js";
import { SshFormatError, SshReader, concatBytes, fixedWidth, sshString, u32be } from "./wire.js";

/**
 * SSHSIG (OpenSSH PROTOCOL.sshsig) verification in TypeScript over node:crypto, with no
 * ssh-keygen dependency (FR9.2). For FIDO security keys it rebuilds what the authenticator
 * signed (OpenSSH PROTOCOL.u2f): SHA256(application) ‖ flags ‖ counter ‖ SHA256(signed data),
 * and returns the flags byte, so the caller can check the user-presence (UP) flag itself:
 * OpenSSH's `ssh-keygen -Y verify` accepts a signature whether or not UP is set.
 *
 * Where pr-rla is deliberately stricter than ssh-keygen (test/presence-oracle.test.ts shows each):
 * a non-empty reserved field, RSA keys under 2048 bits or with a public exponent of 1 or an even
 * one, small-order Ed25519 keys, security keys whose application does not start with `ssh:`, and
 * `webauthn-sk-*` signatures are refused.
 */

export const SSHSIG_BEGIN = "-----BEGIN SSH SIGNATURE-----";
export const SSHSIG_END = "-----END SSH SIGNATURE-----";
const MAGIC = new TextEncoder().encode("SSHSIG");
export const SSHSIG_VERSION = 1;
const HASHES = ["sha256", "sha512"] as const;

/** FIDO flags (sk-api.h): bit 0 user present (UP), bit 2 user verified (UV). */
export const SK_FLAG_USER_PRESENT = 0x01;
export const SK_FLAG_USER_VERIFIED = 0x04;

export interface SecurityKeySignature {
  /** The authenticator's flags byte, as signed. */
  flags: number;
  /** The authenticator's signature counter, as signed. */
  counter: number;
  /** UP: the authenticator set its user-presence flag (after a touch, on a hardware key; a software-emulated authenticator sets it at will, T16). */
  userPresent: boolean;
  /** UV: the flags say the user was verified (PIN or biometric). */
  userVerified: boolean;
}

export interface ParsedSshsig {
  publicKey: SshPublicKey;
  namespace: string;
  reserved: Uint8Array;
  hashAlgorithm: string;
  /** The SSH signature blob (`string alg, string sig[, byte flags, uint32 counter]`). */
  signature: Uint8Array;
}

export interface SshsigCheck {
  ok: boolean;
  /** Why the signature does not verify (ok false). */
  problem?: string;
  /** The key the signature names (present once the blob parses). */
  key?: SshPublicKey;
  namespace?: string;
  hashAlgorithm?: string;
  /** Security-key signatures: the signed flags and counter. */
  sk?: SecurityKeySignature;
}

/** The binary SSHSIG blob inside an armored signature. Throws SshFormatError. */
export function dearmorSshsig(text: string): Uint8Array {
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines[0] !== SSHSIG_BEGIN) throw new SshFormatError(`the signature does not start with ${SSHSIG_BEGIN}`);
  if (lines.length < 3 || lines[lines.length - 1] !== SSHSIG_END) throw new SshFormatError(`the signature does not end with ${SSHSIG_END}`);
  const body = lines.slice(1, -1).join("");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new SshFormatError("the armored signature is not base64");
  return new Uint8Array(Buffer.from(body, "base64"));
}

/** Parses an SSHSIG blob (PROTOCOL.sshsig §2). Throws SshFormatError. */
export function parseSshsig(blob: Uint8Array): ParsedSshsig {
  const r = new SshReader(blob, "SSHSIG blob");
  const magic = r.bytes(MAGIC.length);
  if (!magic.every((b, i) => b === MAGIC[i])) throw new SshFormatError("not an SSHSIG blob (no SSHSIG preamble)");
  const version = r.u32();
  if (version !== SSHSIG_VERSION) throw new SshFormatError(`SSHSIG version ${version} is not supported (only ${SSHSIG_VERSION})`);
  const publicKey = parsePublicKeyBlob(r.string());
  const namespace = r.text();
  const reserved = r.string();
  // OpenSSH always signs and verifies over an empty reserved field, whatever the blob holds; a blob
  // that carries one is refused, so pr-rla never accepts what ssh-keygen would not.
  if (reserved.length !== 0) throw new SshFormatError(`the SSHSIG reserved field is not empty (${reserved.length} bytes)`);
  const hashAlgorithm = r.text();
  const signature = r.string();
  r.end();
  return { publicKey, namespace, reserved, hashAlgorithm, signature };
}

/** What the key signs (PROTOCOL.sshsig §3): "SSHSIG" ‖ string namespace ‖ string reserved ‖ string hash ‖ string H(message). */
export function sshsigSignedData(namespace: string, reserved: Uint8Array, hashAlgorithm: "sha256" | "sha512", message: Uint8Array): Uint8Array {
  const digest = new Uint8Array(createHash(hashAlgorithm).update(message).digest());
  return concatBytes(MAGIC, sshString(namespace), sshString(reserved), sshString(hashAlgorithm), sshString(digest));
}

/** What a FIDO authenticator signs for `data` (PROTOCOL.u2f, "SSH U2F signatures"; no extensions are defined for SSH). */
export function securityKeySignedData(application: string, flags: number, counter: number, data: Uint8Array): Uint8Array {
  const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
  return concatBytes(sha256(new TextEncoder().encode(application)), Uint8Array.of(flags & 0xff), u32be(counter), sha256(data));
}

/** The signature algorithm names each key type may sign with. RSA must use SHA-2 (PROTOCOL.sshsig: not the legacy SHA-1 "ssh-rsa"). */
const SIGNATURE_ALGORITHMS: Record<SshPublicKey["type"], readonly string[]> = {
  "ssh-ed25519": ["ssh-ed25519"],
  "sk-ssh-ed25519@openssh.com": ["sk-ssh-ed25519@openssh.com"],
  "ecdsa-sha2-nistp256": ["ecdsa-sha2-nistp256"],
  "ecdsa-sha2-nistp384": ["ecdsa-sha2-nistp384"],
  "ecdsa-sha2-nistp521": ["ecdsa-sha2-nistp521"],
  "sk-ecdsa-sha2-nistp256@openssh.com": ["sk-ecdsa-sha2-nistp256@openssh.com"],
  "ssh-rsa": ["rsa-sha2-512", "rsa-sha2-256"],
};

/** ECDSA `mpint r, mpint s` as IEEE P1363 r ‖ s. */
function ecdsaP1363(sig: Uint8Array, key: SshPublicKey): Uint8Array {
  const r = new SshReader(sig, "ECDSA signature");
  const rr = r.unsignedMpint();
  const ss = r.unsignedMpint();
  r.end();
  return concatBytes(ecdsaComponent(rr, key.curve!), ecdsaComponent(ss, key.curve!));
}

/**
 * Verifies an SSH signature blob made by `key` over `data`. Returns the security-key flags and
 * counter for -sk keys. Throws SshFormatError on a malformed blob; returns false on a bad signature.
 */
export function verifySshSignature(key: SshPublicKey, sigBlob: Uint8Array, data: Uint8Array): { valid: boolean; problem?: string; sk?: SecurityKeySignature } {
  const r = new SshReader(sigBlob, "signature");
  const alg = r.text();
  if (alg.startsWith("webauthn-")) throw new SshFormatError(`${alg} (web authentication) signatures are not supported`);
  if (!SIGNATURE_ALGORITHMS[key.type].includes(alg)) throw new SshFormatError(`a ${key.type} key cannot make a ${JSON.stringify(alg)} signature${key.type === "ssh-rsa" && alg === "ssh-rsa" ? " (SHA-1 RSA signatures are refused)" : ""}`);
  const sig = r.string();
  let sk: SecurityKeySignature | undefined;
  if (key.securityKey) {
    const flags = r.u8();
    const counter = r.u32();
    sk = { flags, counter, userPresent: (flags & SK_FLAG_USER_PRESENT) !== 0, userVerified: (flags & SK_FLAG_USER_VERIFIED) !== 0 };
  }
  r.end();
  const signed = sk ? securityKeySignedData(key.application!, sk.flags, sk.counter, data) : data;
  let valid: boolean;
  switch (key.type) {
    case "ssh-ed25519":
    case "sk-ssh-ed25519@openssh.com":
      if (sig.length !== 64) throw new SshFormatError(`the Ed25519 signature is ${sig.length} bytes, not 64`);
      valid = verify(null, signed, key.keyObject, sig);
      break;
    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521":
    case "sk-ecdsa-sha2-nistp256@openssh.com":
      valid = verify(key.curve!.hash, signed, { key: key.keyObject, dsaEncoding: "ieee-p1363" }, ecdsaP1363(sig, key));
      break;
    case "ssh-rsa": {
      const modulusBytes = Math.ceil(key.bits! / 8);
      // OpenSSH accepts a signature shorter than the modulus and left-pads it (ssh-rsa.c).
      valid = verify(alg === "rsa-sha2-512" ? "sha512" : "sha256", signed, { key: key.keyObject, padding: constants.RSA_PKCS1_PADDING }, fixedWidth(sig, modulusBytes, "the RSA signature"));
      break;
    }
  }
  return { valid, ...(valid ? {} : { problem: "the signature does not match the signed data" }), ...(sk ? { sk } : {}) };
}

/**
 * Verifies an armored SSHSIG over `message` in `namespace` (pr-rla verdicts: `pr-rla-verdict@v1`).
 * Checks the preamble and version, an empty reserved field, the namespace, a sha256 or sha512
 * message hash, and the signature by the key the blob names. Whether that key is allowed is the
 * caller's question.
 */
export function verifySshsig(armored: string, message: Uint8Array, namespace: string): SshsigCheck {
  let blob: Uint8Array;
  try {
    blob = dearmorSshsig(armored);
  } catch (e) {
    return { ok: false, problem: (e as Error).message };
  }
  return verifySshsigBlob(blob, message, namespace);
}

/** As verifySshsig, for the binary blob (a verdict line carries it base64-encoded, without the armor). */
export function verifySshsigBlob(blob: Uint8Array, message: Uint8Array, namespace: string): SshsigCheck {
  let parsed: ParsedSshsig;
  try {
    parsed = parseSshsig(blob);
  } catch (e) {
    return { ok: false, problem: (e as Error).message };
  }
  const base = { key: parsed.publicKey, namespace: parsed.namespace, hashAlgorithm: parsed.hashAlgorithm };
  if (parsed.namespace !== namespace) return { ...base, ok: false, problem: `the signature is for namespace ${JSON.stringify(parsed.namespace)}, not ${JSON.stringify(namespace)}` };
  if (!(HASHES as readonly string[]).includes(parsed.hashAlgorithm)) return { ...base, ok: false, problem: `message hash ${JSON.stringify(parsed.hashAlgorithm)} is not sha256 or sha512` };
  const data = sshsigSignedData(parsed.namespace, new Uint8Array(0), parsed.hashAlgorithm as "sha256" | "sha512", message);
  try {
    const v = verifySshSignature(parsed.publicKey, parsed.signature, data);
    return { ...base, ok: v.valid, ...(v.problem ? { problem: v.problem } : {}), ...(v.sk ? { sk: v.sk } : {}) };
  } catch (e) {
    return { ...base, ok: false, problem: (e as Error).message };
  }
}
