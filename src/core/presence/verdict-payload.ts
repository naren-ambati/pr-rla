/**
 * The bytes a reviewer signs for one verdict (contracts.md §1, "Per-verdict signatures"). Pure.
 *
 * A verdict's provenance comes only from an SSHSIG over these bytes, in its own namespace
 * `pr-rla-verdict@v1`, made by `ssh-keygen -Y sign`. They name the registration, the protocol, the
 * draw, the change, the verdict, the reviewer and the time, so one signature (one touch, with a
 * security key) is one verdict on one draw of one registration, and nothing else.
 *
 * The form is text, one `name value` line per field in a fixed order, each ending in LF:
 *
 *     pr-rla-verdict/v1
 *     registrationSha256 <64 lowercase hex>
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
 */

/** The SSHSIG namespace verdict signatures are made in; a key's allowed-signers entry must admit it. */
export const VERDICT_NAMESPACE = "pr-rla-verdict@v1";
/** The first line of the signed bytes: the version of this form. */
export const VERDICT_PAYLOAD_VERSION = "pr-rla-verdict/v1";

/** The fields a verdict signature covers, in the order they are encoded. */
export const VERDICT_PAYLOAD_FIELDS = ["registrationSha256", "protocolSha256", "draw", "changeId", "verdict", "reviewer", "recordedAt"] as const;

export interface VerdictPayloadFields {
  /** The registration's SHA-256 (`sha256` of registration.json). */
  registrationSha256: string;
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

/** Why these fields cannot be signed (empty: they can). */
export function verdictPayloadProblems(f: Partial<Record<(typeof VERDICT_PAYLOAD_FIELDS)[number], unknown>>): string[] {
  const p: string[] = [];
  if (typeof f.registrationSha256 !== "string" || !HEX64.test(f.registrationSha256)) p.push("registrationSha256 must be 64 lowercase hex characters");
  if (typeof f.protocolSha256 !== "string" || !HEX64.test(f.protocolSha256)) p.push("protocolSha256 must be 64 lowercase hex characters");
  if (typeof f.draw !== "number" || !Number.isSafeInteger(f.draw) || f.draw < 1) p.push("draw must be a positive integer");
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
