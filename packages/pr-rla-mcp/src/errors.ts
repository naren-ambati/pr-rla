/**
 * The MCP error results (contracts.md §4): `isError: true` with `{ code, message, next? }`.
 * pr-rla's own errors carry their code; broker timeouts become TIMEOUT; anything else a provider,
 * a ledger or a plugin throws is PROVIDER_ERROR, with its message.
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
  | "UNSUPPORTED";

export interface ToolErrorBody {
  code: ToolErrorCode;
  message: string;
  next?: string;
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

const PASS_THROUGH = new Set<string>(["ROOT_ESCAPE", "NO_AUDIT", "BAD_WINDOW", "DRAW_OUT_OF_RANGE", "READ_ONLY_VIOLATION", "PROVIDER_ERROR", "TIMEOUT", "TOO_MANY_JOBS", "RESULT_TOO_LARGE", "UNSUPPORTED"]);
const TIMEOUTS = new Set<string>(["BROKER_TIMEOUT", "PLUGIN_HOST_TIMEOUT"]);

export function toToolError(e: unknown): ToolErrorBody {
  const err = e as { code?: unknown; message?: unknown; next?: unknown };
  const message = typeof err?.message === "string" ? err.message : String(e);
  const next = typeof err?.next === "string" && err.next ? { next: err.next } : {};
  const code = typeof err?.code === "string" ? err.code : "";
  if (PASS_THROUGH.has(code)) return { code: code as ToolErrorCode, message, ...next };
  if (TIMEOUTS.has(code)) return { code: "TIMEOUT", message, ...next };
  return { code: "PROVIDER_ERROR", message, ...next };
}
