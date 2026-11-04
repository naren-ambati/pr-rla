import { unarmor, type SignOptions, type TestKey } from "./sshsig-signer.js";

/**
 * git-file verdict lines for tests, signed one by one (U9, after review). The signed bytes are
 * written here from the definition in contracts.md §1 ("Per-verdict signatures"), apart from
 * src/core/presence/verdict-payload.ts, so a mistake in one does not hide in the other; the
 * recorded sk-dummy fixture and the oracle check both against ssh-keygen.
 */

export const NAMESPACE = "pr-rla-verdict@v1";

export interface LineFields {
  draw: number;
  changeId: string;
  verdict: "pass" | "fail";
  protocolSha256: string;
  reviewer: string;
  recordedAt: string;
  note?: string;
}

/** The bytes a reviewer signs, as the README's printf recipe writes them. */
export function verdictBytes(registrationSha256: string, f: LineFields): string {
  return `pr-rla-verdict/v1\nregistrationSha256 ${registrationSha256}\nprotocolSha256 ${f.protocolSha256}\ndraw ${f.draw}\nchangeId ${f.changeId}\nverdict ${f.verdict}\nreviewer ${f.reviewer}\nrecordedAt ${f.recordedAt}\n`;
}

/** An unsigned line, as `pr-rla record` without --sign writes it. */
export function unsignedLine(f: LineFields): string {
  return `${JSON.stringify({ schema: "pr-rla/verdict/v1", ...f })}\n`;
}

/**
 * A line carrying its own signature by `key` (the software-emulated authenticator for -sk keys, so
 * `opts.flags` sets or clears the user-presence flag). `bytesFor` signs other bytes than the line's
 * (another registration, a changed field) to make a forgery.
 */
export function signedLine(registrationSha256: string, f: LineFields, key: TestKey, opts: SignOptions & { bytesFor?: { registrationSha256?: string; fields?: Partial<LineFields> }; lineRegistration?: string } = {}): string {
  const signedReg = opts.bytesFor?.registrationSha256 ?? registrationSha256;
  const signedFields = { ...f, ...opts.bytesFor?.fields };
  const sig = key.sign(verdictBytes(signedReg, signedFields), { namespace: NAMESPACE, ...opts });
  return `${JSON.stringify({ schema: "pr-rla/verdict/v1", ...f, registrationSha256: opts.lineRegistration ?? registrationSha256, sshsig: unarmor(sig) })}\n`;
}
