/**
 * The bytes a reviewer signs for one verdict (contracts.md §1, "Per-verdict signatures"). Pure.
 *
 * A verdict's provenance comes only from an SSHSIG over these bytes, in its own namespace
 * `pr-rla-verdict@v1`, made by `ssh-keygen -Y sign`. They name the registration, the frozen
 * manifest, the seed (the beacon round and its randomness), the protocol, the draw, the change, the
 * verdict, the reviewer and the time, so one signature (one touch, with a security key) is one
 * verdict on one draw of one frozen audit, and cannot have been made before the seed was public.
 *
 * The form is text, one `name value` line per field in a fixed order, each ending in LF:
 *
 *     pr-rla-verdict/v2
 *     registrationSha256 <64 lowercase hex>
 *     manifestSha256 <64 lowercase hex>
 *     beaconRound <decimal, no leading zero>
 *     beaconRandomness <64 lowercase hex>
 *     protocolSha256 <64 lowercase hex>
 *     draw <decimal, no leading zero>
 *     changeId <text>
 *     verdict <pass|fail>
 *     reviewer <text>
 *     recordedAt <YYYY-MM-DDTHH:MM:SS[.fraction]Z>
 *
 * Text is UTF-8 with no control character (U+0000–U+001F, U+007F), so no value can hold a line
 * break and the encoding is unambiguous. A reviewer can type it with printf and sign it with
 * ssh-keygen without running pr-rla (README, "Signed verdicts").
 *
 * v2 (P4, second-pass review finding 5) adds the manifest and the seed to v1's bytes. v1 bound only
 * the registration, so a reviewer's software key could sign every (draw, change) pair before the seed
 * was drawn, with a `recordedAt` of its choosing, and a signature stayed valid for any manifest under
 * the same registration. v1 signatures count for nothing (nothing signed under v1 was released).
 */

/** The SSHSIG namespace verdict signatures are made in; a key's allowed-signers entry must admit it. It names the purpose; the first line of the bytes names their version. */
export const VERDICT_NAMESPACE = "pr-rla-verdict@v1";
/** The first line of the signed bytes: the version of this form. */
export const VERDICT_PAYLOAD_VERSION = "pr-rla-verdict/v2";
/** v1's first line: its signatures are recognised only to say why they are refused. */
export const VERDICT_PAYLOAD_V1 = "pr-rla-verdict/v1";

/** The fields a verdict signature covers, in the order they are encoded. */
export const VERDICT_PAYLOAD_FIELDS = ["registrationSha256", "manifestSha256", "beaconRound", "beaconRandomness", "protocolSha256", "draw", "changeId", "verdict", "reviewer", "recordedAt"] as const;
const V1_FIELDS = ["registrationSha256", "protocolSha256", "draw", "changeId", "verdict", "reviewer", "recordedAt"] as const;

/**
 * The audit a verdict is signed for: what verify has already checked (the registration, the frozen
 * manifest, the beacon round and its randomness), and what status and `record --sign` read from
 * registration.json, manifest.json and draws.json.
 */
export interface VerdictBinding {
  /** The registration's SHA-256 (`sha256` of registration.json). */
  registrationSha256: string;
  /** The frozen manifest's SHA-256 (`sha256` of manifest.json; `manifestSha256` in draws.json). */
  manifestSha256: string;
  /** The beacon round the draws come from, and its randomness (`beacon.round`, `beacon.randomness` in draws.json). */
  beaconRound: number;
  beaconRandomness: string;
}

export interface VerdictPayloadFields extends VerdictBinding {
  protocolSha256: string;
  draw: number;
  changeId: string;
  verdict: "pass" | "fail";
  /** The allowed-signers principal of the key that signs. */
  reviewer: string;
  recordedAt: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const RECORDED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A lone UTF-16 surrogate: not encodable as UTF-8 (TextEncoder would silently replace it). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !LONE_SURROGATE.test(v) && !CONTROL.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** Why these fields cannot be signed (empty: they can). */
export function verdictPayloadProblems(f: Partial<Record<(typeof VERDICT_PAYLOAD_FIELDS)[number], unknown>>): string[] {
  const p: string[] = [];
  if (typeof f.registrationSha256 !== "string" || !HEX64.test(f.registrationSha256)) p.push("registrationSha256 must be 64 lowercase hex characters");
  if (typeof f.manifestSha256 !== "string" || !HEX64.test(f.manifestSha256)) p.push("manifestSha256 must be 64 lowercase hex characters");
  if (!positive(f.beaconRound)) p.push("beaconRound must be a positive integer");
  if (typeof f.beaconRandomness !== "string" || !HEX64.test(f.beaconRandomness)) p.push("beaconRandomness must be 64 lowercase hex characters");
  if (typeof f.protocolSha256 !== "string" || !HEX64.test(f.protocolSha256)) p.push("protocolSha256 must be 64 lowercase hex characters");
  if (!positive(f.draw)) p.push("draw must be a positive integer");
  if (!text(f.changeId)) p.push("changeId must be non-empty text with no control character");
  if (f.verdict !== "pass" && f.verdict !== "fail") p.push('verdict must be "pass" or "fail"');
  if (!text(f.reviewer)) p.push("reviewer must be non-empty text with no control character");
  if (typeof f.recordedAt !== "string" || !RECORDED_AT.test(f.recordedAt)) p.push("recordedAt must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ)");
  return p;
}

/** The signed bytes as text. Throws an Error naming every field that cannot be encoded. */
export function verdictPayloadText(f: VerdictPayloadFields): string {
  const problems = verdictPayloadProblems(f);
  if (problems.length) throw new Error(`the verdict cannot be signed: ${problems.join("; ")}`);
  return `${VERDICT_PAYLOAD_VERSION}\n${VERDICT_PAYLOAD_FIELDS.map((k) => `${k} ${String(f[k])}\n`).join("")}`;
}

/** The signed bytes (UTF-8 of verdictPayloadText). */
export function verdictPayload(f: VerdictPayloadFields): Uint8Array {
  return new TextEncoder().encode(verdictPayloadText(f));
}

/** v1's bytes for the same verdict (no manifest, no seed): only to recognise a v1 signature and say why it is refused. */
export function verdictPayloadV1(f: VerdictPayloadFields): Uint8Array {
  return new TextEncoder().encode(`${VERDICT_PAYLOAD_V1}\n${V1_FIELDS.map((k) => `${k} ${String(f[k])}\n`).join("")}`);
}
