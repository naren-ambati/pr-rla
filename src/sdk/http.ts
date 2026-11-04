/**
 * `pr-rla/http`: the phase-2 HTTP retry policy and the retrying JSON client, in one place.
 * Versioned on its own (`HTTP_HELPER_VERSION`), not by the provider or ledger API version.
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
  /**
   * Optional (P3): a 403 or 429 whose body matches this pattern (a regular expression's source, matched without
   * case) is a rate limit even with no header that says so. GitHub documents its secondary limits that way.
   */
  rateLimitBody?: string;
  /**
   * Optional (P3): the wait after a rate limit that names none (no Retry-After, no exhausted remaining count): this
   * long the first time, doubling each time after, never more than MAX_WAIT_MS. These waits count against
   * `maxBlindRateLimitRetries` only. Absent: such a rate limit gets the error backoff, as before.
   */
  blindRateLimitWaitMs?: number;
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
 * Whether a response the status rules would not retry is a rate limit by its body (`RetryHints.rateLimitBody`, P3):
 * the start of the body when it is (for the give-up message), else null. Reads a clone.
 */
export async function rateLimitedByBody(res: Response, hints: Pick<RetryHints, "rateLimitBody">): Promise<string | null> {
  if (!hints.rateLimitBody || (res.status !== 403 && res.status !== 429)) return null;
  let text: string;
  try {
    text = (await res.clone().text()).slice(0, 4000);
  } catch {
    return null;
  }
  return new RegExp(hints.rateLimitBody, "i").test(text) ? text.replace(/\s+/g, " ").trim().slice(0, 160) : null;
}

/** The wait after the `n`-th rate limit in a row that names no wait (1-based), or null when the caller set no `blindRateLimitWaitMs`. */
export function blindRateLimitWaitMs(hints: Pick<RetryHints, "blindRateLimitWaitMs">, n: number): number | null {
  if (hints.blindRateLimitWaitMs === undefined) return null;
  return Math.min(MAX_WAIT_MS, hints.blindRateLimitWaitMs * 2 ** Math.max(0, n - 1));
}

/**
 * Checks a 2xx JSON body against the caller's rule. Returns a fresh Response with the
 * same body (the original is consumed) and the reason to retry, or null.
 */
/** Statuses whose response has no body by definition; `new Response()` refuses one for them. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

export async function checkJsonBody(res: Response, accept: (body: unknown) => string | null): Promise<{ response: Response; problem: string | null }> {
  // A 204 (Jira answers a PUT with one), 205 or 304 has no body to check: pass it on as it is.
  if (NULL_BODY_STATUSES.has(res.status)) return { response: new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers }), problem: null };
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

/* ---------------------------------------------------------------------------
 * `pr-rla/http` (U3, FR7.5): the phase-2 retrying JSON client, exported for plugins
 * under its own version. The built-in providers use it through src/providers/http.ts,
 * which re-exports it, so their imports did not change.
 * ------------------------------------------------------------------------- */

/**
 * The version of this helper, independent of `providerApiVersion` and `ledgerApiVersion`:
 * bumped only when `createJsonClient` or `JsonClient` changes incompatibly.
 */
export const HTTP_HELPER_VERSION = 1 as const;

/** A broker error (src/net/contract.ts) is final: the broker already retried. Detected by shape, so this module imports nothing. */
function isBrokerError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const x = e as { code?: unknown; host?: unknown; next?: unknown };
  return typeof x.code === "string" && typeof x.host === "string" && typeof x.next === "string";
}

/**
 * JSON over HTTP with the phase-2 retry policy: network errors, 5xx, 429 (and 403 rate limits), and
 * 2xx responses whose body is not valid JSON (a truncated body after a 503 was seen on GitHub). It
 * waits as long as the rate-limit headers say:
 * - `Retry-After` (seconds or an HTTP date);
 * - `RateLimit-Remaining: 0` / `X-RateLimit-Remaining: 0` with `RateLimit-Reset` /
 *   `X-RateLimit-Reset` (epoch seconds when large, otherwise seconds from now);
 * - the IETF structured form `RateLimit: "policy";r=0;t=30` (Forgejo/Codeberg).
 * A success that reports zero remaining requests delays the next request until the reset.
 *
 * Behind pr-rla's fetch broker (a provider's `ctx.fetch`), construct it with `maxRetries: 0`: it then
 * makes one attempt per request and hands its rules to the broker in each request, so the broker is
 * the only retrier (contracts.md §2 step 6). With a plain fetch it retries itself.
 */
export interface HttpClientOptions {
  /** Provider name, used in messages. */
  provider: string;
  /** API root, e.g. `https://gitlab.com/api/v4`. Relative paths are appended to it. */
  baseUrl: string;
  headers?: Record<string, string>;
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** Retries per request (default 6). The built-ins pass 0: the broker retries. */
  maxRetries?: number;
  /** Appended to the error when retries run out on a rate limit, e.g. "set GITLAB_TOKEN". */
  rateLimitHint?: string;
  /**
   * Retries for a 429 that says nothing about when to come back (no Retry-After or reset header).
   * Bitbucket Cloud's anonymous limit is hourly: a minute of backoff cannot outlast it and only burns
   * requests, so it gives up early with the hint. Default: maxRetries.
   */
  maxBlindRateLimitRetries?: number;
}

export class HttpError extends Error {
  // Declared and assigned, not parameter properties: src/sdk is erasable TypeScript (tsconfig.sdk.json), because a
  // plugin's `pr-rla/http` runs under Node's type stripping in the plugin host.
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

/** Status on the error thrown when retries are exhausted. */
export const GAVE_UP = 0;

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Returns a reason to retry a parsed 2xx body (e.g. a transient GraphQL error), or null to accept it. */
  accept?: (body: unknown) => string | null;
  /** Retries for this request, when fewer than the client's. */
  maxRetries?: number;
}

export class HttpClient {
  requestCount = 0;
  private notBefore = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly baseUrl: string;
  private readonly o: HttpClientOptions;

  constructor(o: HttpClientOptions) {
    this.o = o;
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  url(pathOrUrl: string): string {
    return /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  }

  /** One JSON request with retries; returns the parsed body and the response headers. */
  async request<T>(pathOrUrl: string, opts: RequestOptions = {}): Promise<{ data: T; headers: Headers }> {
    const url = this.url(pathOrUrl);
    const short = url.startsWith(this.baseUrl) ? url.slice(this.baseUrl.length) : url;
    const method = opts.method ?? "GET";
    const own = this.o.maxRetries ?? DEFAULT_MAX_RETRIES;
    const max = Math.min(own, opts.maxRetries ?? own);
    const retry: RetryHints = {
      acceptJson: (b) => opts.accept?.(b) ?? null,
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(this.o.maxBlindRateLimitRetries !== undefined ? { maxBlindRateLimitRetries: this.o.maxBlindRateLimitRetries } : {}),
    };
    // The broker-contract fields are ignored by a plain fetch and read by pr-rla's fetch broker.
    const init: RequestInit & { destination: "scm"; retry: RetryHints } = {
      method,
      headers: { accept: "application/json", "user-agent": "pr-rla/0.2", ...this.o.headers, ...opts.headers, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      destination: "scm",
      retry,
    };
    let rateLimited = false;
    let blind = 0;
    let giveUp = false;
    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      const hold = this.notBefore - Date.now();
      if (hold > 0) {
        this.o.log?.(`${this.o.provider}: rate limit exhausted; waiting ${Math.ceil(hold / 1000)}s before ${short}`);
        await this.sleep(Math.min(hold, MAX_WAIT_MS));
        this.notBefore = 0;
      }
      this.requestCount++;
      let wait = Math.min(60_000, 1000 * 2 ** attempt);
      let reason: string;
      try {
        const res = await this.o.fetch(url, init);
        if (res.ok) {
          const text = await res.text();
          let body: unknown;
          try {
            body = text.length ? JSON.parse(text) : null;
          } catch {
            body = undefined;
          }
          const why = body === undefined ? `truncated or non-JSON body (${text.length} bytes)` : (opts.accept?.(body) ?? null);
          if (why === null) {
            const exhausted = waitFromHeaders(res.headers, Date.now(), { onlyIfExhausted: true });
            if (exhausted !== null && exhausted > 0) this.notBefore = Date.now() + exhausted;
            return { data: body as T, headers: res.headers };
          }
          reason = why;
        } else if (res.status >= 500 || isRateLimited(res)) {
          rateLimited ||= isRateLimited(res);
          reason = `HTTP ${res.status}`;
          const told = waitFromHeaders(res.headers, Date.now());
          if (told !== null) wait = told;
          else if (isRateLimited(res) && ++blind > (this.o.maxBlindRateLimitRetries ?? max)) giveUp = true;
          await res.body?.cancel().catch(() => {});
        } else {
          const text = (await res.text()).slice(0, 300);
          throw new HttpError(`${this.o.provider} ${method} ${short}: HTTP ${res.status} ${text}`, res.status, url);
        }
      } catch (e) {
        if (e instanceof HttpError || (e as Error).name === "AbortError") throw e;
        const gaveUp = exhaustion(e);
        if (gaveUp) {
          const hint = gaveUp.rateLimited && this.o.rateLimitHint ? ` ${this.o.rateLimitHint}` : "";
          throw new HttpError(`${this.o.provider} ${method} ${short}: gave up after ${gaveUp.attempts} attempts (${gaveUp.problem}).${hint}`, GAVE_UP, url);
        }
        if (isBrokerError(e)) throw e;
        reason = (e as Error).message;
      }
      if (attempt >= max || giveUp) {
        const hint = rateLimited && this.o.rateLimitHint ? ` ${this.o.rateLimitHint}` : "";
        throw new HttpError(`${this.o.provider} ${method} ${short}: gave up after ${attempt + 1} attempts (${reason}).${hint}`, GAVE_UP, url);
      }
      this.o.log?.(`${this.o.provider}: ${reason} on ${short}; retrying in ${Math.round(wait / 1000)}s`);
      await this.sleep(Math.min(wait, MAX_WAIT_MS));
    }
  }

  get<T>(pathOrUrl: string, signal?: AbortSignal): Promise<{ data: T; headers: Headers }> {
    return this.request<T>(pathOrUrl, signal ? { signal } : {});
  }
}

/** Options of `createJsonClient` (contracts.md §1, `pr-rla/http`). */
export interface JsonClientOptions {
  /** API root, e.g. `https://codeberg.org/api/v1`. Relative paths are appended to it. */
  base: string;
  headers?: Record<string, string>;
  fetch: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** Retries per request (default 6, so 7 attempts). Pass 0 behind pr-rla's fetch broker. */
  maxRetries?: number;
  /** Name used in messages (default "http"). */
  name?: string;
  /** Appended to the error when retries run out on a rate limit, e.g. "set GITEA_TOKEN". */
  rateLimitHint?: string;
  /** Retries for a 429 that says nothing about when to come back. Default: maxRetries. */
  maxBlindRateLimitRetries?: number;
}

export type JsonClient = HttpClient;

/** The phase-2 retrying, rate-limit-aware JSON client. */
export function createJsonClient(o: JsonClientOptions): JsonClient {
  return new HttpClient({
    provider: o.name ?? "http",
    baseUrl: o.base,
    fetch: o.fetch,
    ...(o.headers ? { headers: o.headers } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...(o.maxRetries !== undefined ? { maxRetries: o.maxRetries } : {}),
    ...(o.rateLimitHint !== undefined ? { rateLimitHint: o.rateLimitHint } : {}),
    ...(o.maxBlindRateLimitRetries !== undefined ? { maxBlindRateLimitRetries: o.maxBlindRateLimitRetries } : {}),
  });
}

/** The `rel="next"` target of an RFC 8288 Link header, if any. */
export function nextLink(headers: Headers): string | null {
  for (const part of (headers.get("link") ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/** Normalizes any ISO-8601 timestamp (with offset or fractional seconds) to `YYYY-MM-DDTHH:MM:SSZ`. */
export function isoUtcSeconds(value: string | number): string {
  const t = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`invalid timestamp ${String(value)}`);
  return new Date(Math.floor(t / 1000) * 1000).toISOString().replace(".000Z", "Z");
}
