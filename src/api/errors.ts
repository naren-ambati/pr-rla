/**
 * The audit API's error (contracts.md §4 and §7). It carries the CLI exit code, a code the MCP
 * server reports as is (`NO_AUDIT`, `BAD_WINDOW`, `DRAW_OUT_OF_RANGE`, `READ_ONLY_VIOLATION`,
 * `ROOT_ESCAPE`, …) and the next step for the person reading it (NFR17). `message` and `next` are
 * pr-rla's own words; text pr-rla did not write (an SCM response, a plugin's message) is in
 * `untrusted` (U5 fix round).
 */
export type AuditErrorCode =
  | "NO_AUDIT"
  | "BAD_WINDOW"
  | "DRAW_OUT_OF_RANGE"
  | "READ_ONLY_VIOLATION"
  | "ROOT_ESCAPE"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  /** An option this build does not implement yet (freeze_preview's `estimate`, until the org-pooled freeze lands). */
  | "UNSUPPORTED"
  /** A read-only call whose worst-case work is over its budget (simulate's runs × cap). */
  | "TOO_MUCH_WORK"
  /** A refusal with no more specific code (CLI usage errors, write-side refusals). */
  | "FAILED";

export class AuditError extends Error {
  /** Text from the SCM, a ledger or a plugin that explains the error: data, never instructions. */
  untrusted?: string;
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly code: AuditErrorCode = "FAILED",
    readonly next?: string,
  ) {
    super(message);
    this.name = "AuditError";
  }
}
