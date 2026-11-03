/**
 * The phase-2 HTTP retry policy, in one place.
 *
 * The fetch broker (src/net/broker.ts) applies it to every request that is wired
 * to it; the built-in clients pass it their per-request rules; the conformance
 * kit's broker-shaped harness applies it in tests. Pure: no I/O and no imports,
 * so the public SDK subpaths stay self-contained.
 *
 * What is retried: 5xx, 429, a 403 that carries a rate-limit signal, network
 * errors and timeouts, and (when the caller says the body is JSON) a 2xx body
 * that does not parse or that the caller rejects (a transient GraphQL error).
 */

/** Per-request retry rules a caller hands the broker in `BrokerInit.retry`. */
export interface RetryHints {
  /** Retries after the first attempt for errors (5xx, network, timeout, bad body). Default 6, so at most 7 attempts. */
  maxRetries?: number;
  /**
   * Give up after this many retries of a 429 that says nothing about when to come back.
   * Bitbucket Cloud's anonymous limit is hourly and its 429 carries no header, so a minute
   * of backoff only burns requests. Default: maxRetries.
   */
  maxBlindRateLimitRetries?: number;
  /**
   * The 2xx body is JSON. A body that does not parse is retried as truncated; otherwise this
   * returns a reason to retry the parsed body (a transient GraphQL error), or null to accept it.
   */
  acceptJson?: (body: unknown) => string | null;
}

/** Phase-2 default: 6 retries, so 7 attempts (contracts.md §2: SCM, drand and Rekor allow at most 7). */
export const DEFAULT_MAX_RETRIES = 6;
/** No single wait is longer than this, whatever a header says. */
export const MAX_WAIT_MS = 15 * 60 * 1000;
/** Backoff without a header: 1 s, 2 s, 4 s … capped here, times a jitter factor in [0.5, 1). */
export const MAX_BACKOFF_MS = 60_000;

/** True for a request init that speaks the broker contract (it names a `destination`). */
export function isBrokerInit(init: unknown): init is { destination: string; retry?: RetryHints | false } {
  return !!init && typeof init === "object" && typeof (init as { destination?: unknown }).destination === "string";
}

/** What a response's rate-limit headers say. Times are absolute milliseconds. */
export interface RateLimitHeaders {
  /** `Retry-After`, as a wait in milliseconds. */
  retryAfterMs: number | null;
  limit: number | null;
  remaining: number | null;
  /** When the window resets (epoch-seconds headers get one second of margin, as in phase 2). */
  resetAtMs: number | null;
  /** GitHub's `x-ratelimit-resource` (core, graphql, search …). */
  resource: string | null;
}

const num = (v: string | null): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Reads every rate-limit header form pr-rla has met:
 * - `Retry-After` (seconds or an HTTP date);
 * - `X-RateLimit-*` (GitHub, Bitbucket) and `RateLimit-*` (GitLab), where a reset is epoch
 *   seconds when large and seconds from now otherwise;
 * - the IETF structured form `RateLimit: "policy";r=0;t=30` with `RateLimit-Policy: …;q=2000`
 *   (Forgejo, Codeberg).
 */
export function readRateLimitHeaders(headers: Headers, nowMs: number): RateLimitHeaders {
  let retryAfterMs: number | null = null;
  const ra = headers.get("retry-after");
  if (ra !== null) {
    const s = num(ra);
    if (s !== null) retryAfterMs = Math.max(0, s) * 1000;
    else if (!Number.isNaN(Date.parse(ra))) retryAfterMs = Math.max(0, Date.parse(ra) - nowMs);
  }
  let limit = num(headers.get("x-ratelimit-limit") ?? headers.get("ratelimit-limit"));
  let remaining = num(headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining"));
  const reset = num(headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset"));
  let resetAtMs: number | null = reset !== null && reset > 0 ? (reset > 1e9 ? Math.max(reset * 1000, nowMs) + 1000 : nowMs + reset * 1000) : null;
  const structured = headers.get("ratelimit");
  if (structured && remaining === null) {
    const r = /(?:^|[;,\s])r=(\d+)/.exec(structured);
    const t = /(?:^|[;,\s])t=(\d+)/.exec(structured);
    if (r) remaining = Number(r[1]);
    if (t) resetAtMs = nowMs + Number(t[1]) * 1000;
    const q = /(?:^|[;,\s])q=(\d+)/.exec(headers.get("ratelimit-policy") ?? "");
    if (q && limit === null) limit = Number(q[1]);
  }
  return { retryAfterMs, limit, remaining, resetAtMs, resource: headers.get("x-ratelimit-resource") };
}

/** Milliseconds the response's rate-limit headers ask the client to wait, or null if they say nothing (phase 2, unchanged). */
export function waitFromHeaders(headers: Headers, nowMs: number, { onlyIfExhausted = false } = {}): number | null {
  const waits: number[] = [];
  const ra = headers.get("retry-after");
  if (ra !== null && !onlyIfExhausted) {
    const s = Number(ra);
    if (Number.isFinite(s)) waits.push(Math.max(0, s) * 1000);
    else if (!Number.isNaN(Date.parse(ra))) waits.push(Math.max(0, Date.parse(ra) - nowMs));
  }
  const remaining = headers.get("ratelimit-remaining") ?? headers.get("x-ratelimit-remaining");
  const reset = Number(headers.get("ratelimit-reset") ?? headers.get("x-ratelimit-reset"));
  if (remaining !== null && Number(remaining) <= 0 && Number.isFinite(reset) && reset > 0) {
    waits.push(reset > 1e9 ? Math.max(0, reset * 1000 - nowMs) + 1000 : reset * 1000);
  }
  const structured = headers.get("ratelimit");
  if (structured) {
    const r = /(?:^|[;,\s])r=(\d+)/.exec(structured);
    const t = /(?:^|[;,\s])t=(\d+)/.exec(structured);
    if (r && t && Number(r[1]) === 0) waits.push(Number(t[1]) * 1000);
  }
  return waits.length ? Math.max(...waits) : null;
}

/** 429, or a 403 that carries a rate-limit signal (GitHub's secondary limits). */
export function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const remaining = res.headers.get("ratelimit-remaining") ?? res.headers.get("x-ratelimit-remaining");
  return res.headers.get("retry-after") !== null || remaining === "0";
}

export function isRetryableStatus(res: Response): boolean {
  return res.status >= 500 || isRateLimited(res);
}

/** Exponential backoff with jitter. `attempt` is 1-based; `random` is in [0, 1). */
export function backoffMs(attempt: number, random: number, capMs = MAX_BACKOFF_MS): number {
  return Math.min(capMs, 1000 * 2 ** (attempt - 1)) * (0.5 + random / 2);
}

/**
 * Checks a 2xx JSON body against the caller's rule. Returns a fresh Response with the
 * same body (the original is consumed) and the reason to retry, or null.
 */
export async function checkJsonBody(res: Response, accept: (body: unknown) => string | null): Promise<{ response: Response; problem: string | null }> {
  const text = await res.text();
  const response = new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  let body: unknown;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    return { response, problem: `truncated or non-JSON body (${text.length} bytes)` };
  }
  return { response, problem: accept(body) };
}

/** The error codes a broker gives up with, and what a client needs from them to word its own error. */
export const RETRIES_EXHAUSTED = "BROKER_RETRIES_EXHAUSTED";
export const TIMED_OUT = "BROKER_TIMEOUT";

export interface Exhaustion {
  attempts: number;
  problem: string;
  rateLimited: boolean;
}

/** If `e` is the broker (or the kit's harness) giving up after retries, what happened; else null. */
export function exhaustion(e: unknown): Exhaustion | null {
  if (!e || typeof e !== "object") return null;
  const x = e as { code?: unknown; attempts?: unknown; lastProblem?: unknown; message?: unknown; rateLimited?: unknown };
  if ((x.code !== RETRIES_EXHAUSTED && x.code !== TIMED_OUT) || typeof x.attempts !== "number") return null;
  return { attempts: x.attempts, problem: typeof x.lastProblem === "string" ? x.lastProblem : String(x.message), rateLimited: x.rateLimited === true };
}
