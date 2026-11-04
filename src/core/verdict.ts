import type { SprtState } from "./sprt.js";

/**
 * The one verdict model (time round B). Every surface that says whether an audit stands uses it:
 * verify's checks, its text and `--json`, the audit API and the MCP `verify` tool, and status's
 * certificate line and exit code. Nothing else decides "VERIFIED" or prints a certificate.
 *
 * - **A check** is PASS, WARN (a note that changes nothing), FAIL (something is shown false),
 *   INCOMPLETE (part of what it covers could not be established: a repo not rebuilt, a time not proven
 *   by k operators, a seed round that rests on such a time) or SKIP (it did not run: offline, before
 *   `sample`, the ledger not read).
 * - **The audit verdict** (`auditVerdict`): FAILED if any check FAILed; else INCOMPLETE if any check is
 *   INCOMPLETE or SKIPped, since a check that did not run verified nothing; else VERIFIED.
 * - **The exit code** (`verdictExitCode`, contracts.md §7): VERIFIED 0, INCOMPLETE 6, FAILED 1.
 * - **The certificate** (`certificateState`): the SPRT's CERTIFIED is printed only when nothing withholds
 *   it. A withholding is INCOMPLETE (the audit could not be shown sound) or FAILED (it was shown unsound).
 *   verify withholds whenever its verdict is not VERIFIED; status withholds for what it can establish
 *   offline (the registration's and commitment's times) and for what a later round adds to it.
 */

/** One check's outcome. INCOMPLETE added in the U8 fix round; SKIP counts as not verified (time round B). */
export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP" | "INCOMPLETE";

/** VERIFIED: no check FAILed, none is INCOMPLETE and none was skipped. INCOMPLETE: none FAILed, but not all was established. */
export type AuditVerdict = "VERIFIED" | "INCOMPLETE" | "FAILED";

/** The exit code of each verdict (contracts.md §7). Existing codes never change meaning. */
export const VERDICT_EXIT_CODES = { VERIFIED: 0, INCOMPLETE: 6, FAILED: 1 } as const;

export type VerdictExitCode = (typeof VERDICT_EXIT_CODES)[AuditVerdict];

export function verdictExitCode(verdict: AuditVerdict): VerdictExitCode {
  return VERDICT_EXIT_CODES[verdict];
}

/** The audit verdict of a set of checks: any FAIL → FAILED; any INCOMPLETE or SKIP → INCOMPLETE; else VERIFIED. */
export function auditVerdict(checks: readonly { status: CheckStatus }[]): AuditVerdict {
  if (checks.some((c) => c.status === "FAIL")) return "FAILED";
  if (checks.some((c) => c.status === "INCOMPLETE" || c.status === "SKIP")) return "INCOMPLETE";
  return "VERIFIED";
}

const RANK: Record<Exclude<CheckStatus, "SKIP">, number> = { PASS: 0, WARN: 1, INCOMPLETE: 2, FAIL: 3 };

/** A check's status raised to at least `to` (FAIL > INCOMPLETE > WARN > PASS); a SKIP is replaced. */
export function raiseStatus(current: CheckStatus, to: "WARN" | "INCOMPLETE" | "FAIL"): CheckStatus {
  if (current === "SKIP") return to;
  return RANK[to] > RANK[current] ? to : current;
}

/** Why a certificate is not issued. INCOMPLETE: what it rests on could not be established; FAILED: it was shown false. */
export interface Withholding {
  verdict: "INCOMPLETE" | "FAILED";
  reason: string;
}

/** The worst verdict among the withholdings (VERIFIED when there are none). */
export function withheldVerdict(withheld: readonly Withholding[]): AuditVerdict {
  return withheld.some((w) => w.verdict === "FAILED") ? "FAILED" : withheld.length ? "INCOMPLETE" : "VERIFIED";
}

/**
 * What the certificate line says. CERTIFIED only when the SPRT certified, the population is not below the
 * registered minimum, and nothing withholds it; WITHHELD when the SPRT certified but something does; REFUSED
 * below the minimum population (review all N instead), whatever the SPRT says; INCOMPLETE when what the SPRT ran
 * on could not be read as it is (a read refused to a plugin running without its credential: src/api/access.ts), so
 * even its state is not established.
 */
export type CertificateState = "CERTIFIED" | "WITHHELD" | "NOT CERTIFIED" | "ESCALATE" | "REFUSED" | "INCOMPLETE";

export interface Certificate {
  state: CertificateState;
  /** Why a certificate is not issued, or the state not established (empty unless `state` is WITHHELD or INCOMPLETE). */
  withheld: Withholding[];
}

/**
 * The certificate for an SPRT state. `withheld` withholds a CERTIFIED (it changes nothing else); `unread` makes any state
 * INCOMPLETE, since the verdicts or the population it rests on were not read (a refusal still stands: N comes from the
 * manifest).
 */
export function certificateFor(sprt: SprtState, refusal: string | null, withheld: readonly Withholding[], unread: readonly Withholding[] = []): Certificate {
  if (refusal !== null) return { state: "REFUSED", withheld: [] };
  if (unread.length) return { state: "INCOMPLETE", withheld: [...unread, ...withheld] };
  if (sprt === "ESCALATE") return { state: "ESCALATE", withheld: [] };
  if (sprt === "CONTINUE") return { state: "NOT CERTIFIED", withheld: [] };
  return withheld.length ? { state: "WITHHELD", withheld: [...withheld] } : { state: "CERTIFIED", withheld: [] };
}

/**
 * The one display decision (seam review, 2026-11-04): whether anything may show or report the audit as CERTIFIED. Every
 * surface asks it: status's line and `certified`, verify's certificate line and `certified`, `audit_list`'s `certified`,
 * the MCP tools and `--json`. `StatusReport.sequence.state` stays the SPRT's raw state (it can be CERTIFIED while the
 * certificate is withheld), so clients read `certified` or `certificate.state`, never `sequence.state`, for the claim.
 */
export function isCertified(c: Certificate | null | undefined): boolean {
  return c?.state === "CERTIFIED";
}

/** Reasons a check would FAIL (P4's status-side ledger gate, P1's check-7 local gate), as withholdings: each makes the result FAILED. */
export function failedWithholdings(reasons: readonly string[]): Withholding[] {
  return reasons.map((reason) => ({ verdict: "FAILED", reason }));
}

/** The withholdings a verify verdict implies: one per check that did not pass as needed (none for VERIFIED). */
export function verdictWithholdings(checks: readonly { n: number; name: string; status: CheckStatus }[]): Withholding[] {
  const verdict = auditVerdict(checks);
  if (verdict === "VERIFIED") return [];
  const failed = checks.filter((c) => c.status === "FAIL");
  if (failed.length) return failed.map((c) => ({ verdict: "FAILED", reason: `verify check ${c.n} (${c.name}) FAILED` }));
  return checks.filter((c) => c.status === "INCOMPLETE" || c.status === "SKIP").map((c) => ({ verdict: "INCOMPLETE", reason: `verify check ${c.n} (${c.name}) ${c.status === "SKIP" ? "skipped" : "incomplete"}` }));
}
