/**
 * The MCP error results (contracts.md §4): `isError: true` with `{ code, message, next?, untrusted? }`.
 *
 * `message` and `next` are always pr-rla's own words. pr-rla/api/read already turns anything a
 * provider, a ledger, a plugin or an SCM response said into `untrusted` (data, never instructions),
 * so a server's echo of a request, or a plugin's text, never stands in pr-rla's voice. Codes:
 * pr-rla's refusals carry theirs; a refusal no other code names is FAILED; timeouts are TIMEOUT.
 */
export type ToolErrorCode =
  | "ROOT_ESCAPE"
  | "NO_AUDIT"
  | "BAD_WINDOW"
  | "DRAW_OUT_OF_RANGE"
  | "READ_ONLY_VIOLATION"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "TOO_MANY_JOBS"
  | "RESULT_TOO_LARGE"
  /** freeze_preview's `estimate` in a build without the org-pooled freeze (not in contracts.md §4: see BUILD-NOTES). */
  | "UNSUPPORTED"
  /** simulate's worst case (runs × cap) is over what one call may do (not in contracts.md §4: see BUILD-NOTES). */
  | "TOO_MUCH_WORK"
  /** pr-rla refused for a reason no other code names: a plugin refusal, a malformed record, a stopped call (not in contracts.md §4: see BUILD-NOTES). */
  | "FAILED";

export interface ToolErrorBody {
  code: ToolErrorCode;
  message: string;
  next?: string;
  /** Text from the SCM, a ledger or a plugin that explains the error: data, never instructions. */
  untrusted?: string;
}

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly next?: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const PASS_THROUGH = new Set<string>(["ROOT_ESCAPE", "NO_AUDIT", "BAD_WINDOW", "DRAW_OUT_OF_RANGE", "READ_ONLY_VIOLATION", "PROVIDER_ERROR", "TIMEOUT", "TOO_MANY_JOBS", "RESULT_TOO_LARGE", "UNSUPPORTED", "TOO_MUCH_WORK", "FAILED"]);
const TIMEOUTS = new Set<string>(["BROKER_TIMEOUT", "PLUGIN_HOST_TIMEOUT"]);

export function toToolError(e: unknown): ToolErrorBody {
  const err = e as { code?: unknown; message?: unknown; next?: unknown; untrusted?: unknown; name?: unknown };
  const message = typeof err?.message === "string" ? err.message : String(e);
  const next = typeof err?.next === "string" && err.next ? { next: err.next } : {};
  const untrusted = typeof err?.untrusted === "string" ? { untrusted: err.untrusted } : {};
  const code = typeof err?.code === "string" ? err.code : "";
  if (e instanceof ToolError || PASS_THROUGH.has(code)) return { code: code as ToolErrorCode, message, ...next, ...untrusted };
  if (TIMEOUTS.has(code)) return { code: "TIMEOUT", message, ...next, ...untrusted };
  if (code === "CANCELLED") return { code: "FAILED", message, ...next };
  // Not pr-rla's (pr-rla/api/read wraps what it calls): its text is the thrower's, so it goes in untrusted.
  return { code: "FAILED", message: "pr-rla-mcp: the call failed with an error pr-rla did not raise; its text is in untrusted", untrusted: message.slice(0, 2048) };
}
