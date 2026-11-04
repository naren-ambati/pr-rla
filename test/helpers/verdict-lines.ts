import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unarmor, type SignOptions, type TestKey } from "./sshsig-signer.js";

/**
 * git-file verdict lines for tests, signed one by one (U9, after review; v2 bytes since P4). The
 * signed bytes are written here from the definition in contracts.md §1 ("Per-verdict signatures"),
 * apart from src/core/presence/verdict-payload.ts, so a mistake in one does not hide in the other;
 * the recorded sk-dummy fixture and the oracle check both against ssh-keygen.
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

/** The audit a signature is made for: the registration, the frozen manifest and the seed. */
export interface Binding {
  registrationSha256: string;
  manifestSha256: string;
  beaconRound: number;
  beaconRandomness: string;
}

/** The binding of the audit whose window directory is `windowDir`, read from its registration.json and draws.json, as a reviewer signing by hand reads it. */
export function bindingOf(windowDir: string): Binding {
  const reg = JSON.parse(readFileSync(join(windowDir, "registration.json"), "utf8")) as { sha256: string };
  const draws = JSON.parse(readFileSync(join(windowDir, "draws.json"), "utf8")) as { manifestSha256: string; beacon: { round: number; randomness: string } };
  return { registrationSha256: reg.sha256, manifestSha256: draws.manifestSha256, beaconRound: draws.beacon.round, beaconRandomness: draws.beacon.randomness };
}

/** The bytes a reviewer signs, as the README's printf recipe writes them. */
export function verdictBytes(b: Binding, f: LineFields): string {
  return `pr-rla-verdict/v2\nregistrationSha256 ${b.registrationSha256}\nmanifestSha256 ${b.manifestSha256}\nbeaconRound ${b.beaconRound}\nbeaconRandomness ${b.beaconRandomness}\nprotocolSha256 ${f.protocolSha256}\ndraw ${f.draw}\nchangeId ${f.changeId}\nverdict ${f.verdict}\nreviewer ${f.reviewer}\nrecordedAt ${f.recordedAt}\n`;
}

/** The v1 bytes (before P4: no manifest, no seed), whose signatures are refused. */
export function verdictBytesV1(registrationSha256: string, f: LineFields): string {
  return `pr-rla-verdict/v1\nregistrationSha256 ${registrationSha256}\nprotocolSha256 ${f.protocolSha256}\ndraw ${f.draw}\nchangeId ${f.changeId}\nverdict ${f.verdict}\nreviewer ${f.reviewer}\nrecordedAt ${f.recordedAt}\n`;
}

/** An unsigned line, as `pr-rla record` without --sign writes it. */
export function unsignedLine(f: LineFields): string {
  return `${JSON.stringify({ schema: "pr-rla/verdict/v1", ...f })}\n`;
}

/**
 * A line carrying its own signature by `key` (the software-emulated authenticator for -sk keys, so
 * `opts.flags` sets or clears the user-presence flag). `bytesFor` signs other bytes than the line's
 * (another registration, manifest or seed, a changed field) to make a forgery; `v1` signs the v1 bytes.
 */
export function signedLine(
  binding: Binding,
  f: LineFields,
  key: TestKey,
  opts: SignOptions & { bytesFor?: Partial<Binding> & { fields?: Partial<LineFields> }; lineRegistration?: string; v1?: boolean } = {},
): string {
  const signedBinding = { ...binding, ...opts.bytesFor, fields: undefined };
  const signedFields = { ...f, ...opts.bytesFor?.fields };
  const bytes = opts.v1 ? verdictBytesV1(signedBinding.registrationSha256, signedFields) : verdictBytes(signedBinding, signedFields);
  const sig = key.sign(bytes, { namespace: NAMESPACE, ...opts });
  return `${JSON.stringify({ schema: "pr-rla/verdict/v1", ...f, registrationSha256: opts.lineRegistration ?? binding.registrationSha256, sshsig: unarmor(sig) })}\n`;
}
