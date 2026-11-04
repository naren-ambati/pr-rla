/**
 * A git commit object split into what was signed and the signature, as `git verify-commit` does
 * (git's `parse_buffer_signed_by_header`): the signature is the `gpgsig` header (`gpgsig-sha256`
 * in a SHA-256 repository) with its continuation lines, each without its leading space; the
 * payload is the object with that header, and any other `gpgsig*` header, removed. Pure.
 */

export interface CommitSignatureParts {
  /** The bytes the signer signed. */
  payload: Uint8Array;
  /** The armored signature text, or null for an unsigned commit. */
  signature: string | null;
}

export type SignatureFormat = "ssh" | "openpgp" | "x509" | "unknown";

const NL = 0x0a;
const SP = 0x20;
const ascii = (s: string) => new TextEncoder().encode(s);

function startsWithBytes(buf: Uint8Array, at: number, prefix: Uint8Array): boolean {
  if (at + prefix.length > buf.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[at + i] !== prefix[i]) return false;
  return true;
}

/** Splits a raw commit object (`git cat-file commit <sha>`). */
export function splitCommitSignature(raw: Uint8Array): CommitSignatureParts {
  // A SHA-256 repository names 64-hex trees and signs under gpgsig-sha256.
  const sha256Repo = /^tree [0-9a-f]{64}\n/.test(new TextDecoder("latin1").decode(raw.subarray(0, 70)));
  const header = ascii(sha256Repo ? "gpgsig-sha256" : "gpgsig");
  const anySig = ascii("gpgsig");
  const payload: number[] = [];
  const sig: number[] = [];
  let inSignature = false;
  let otherSignature = false;
  let saw = false;
  let line = 0;
  while (line < raw.length) {
    let next = raw.indexOf(NL, line);
    next = next === -1 ? raw.length : next + 1;
    let sigStart = -1;
    if (inSignature && raw[line] === SP) sigStart = line + 1;
    else if (startsWithBytes(raw, line, header) && raw[line + header.length] === SP) {
      sigStart = line + header.length + 1;
      otherSignature = false;
    } else if (startsWithBytes(raw, line, anySig)) otherSignature = true;
    else if (otherSignature && raw[line] !== SP) otherSignature = false;
    if (sigStart >= 0) {
      for (let i = sigStart; i < next; i++) sig.push(raw[i]!);
      saw = true;
      inSignature = true;
    } else {
      // The blank line ends the headers: the rest is the message, signed as is.
      if (raw[line] === NL) next = raw.length;
      if (!otherSignature) for (let i = line; i < next; i++) payload.push(raw[i]!);
      inSignature = false;
    }
    line = next;
  }
  return { payload: Uint8Array.from(payload), signature: saw ? new TextDecoder().decode(Uint8Array.from(sig)) : null };
}

/** The signature format, by its armor (as git's gpg-interface tells them apart). */
export function signatureFormat(signature: string): SignatureFormat {
  const first = signature.trimStart();
  if (first.startsWith("-----BEGIN SSH SIGNATURE-----")) return "ssh";
  if (first.startsWith("-----BEGIN PGP SIGNATURE-----") || first.startsWith("-----BEGIN PGP MESSAGE-----")) return "openpgp";
  if (first.startsWith("-----BEGIN SIGNED MESSAGE-----")) return "x509";
  return "unknown";
}
