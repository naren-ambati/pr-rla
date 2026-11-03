/**
 * JSON-over-HTTP transport shared by the built-in GitLab and Bitbucket
 * providers. Retries network errors, 5xx, 429 (and 403 rate limits), and 2xx
 * responses whose body is not valid JSON (a truncated body after a 503 was seen
 * on GitHub). Waits as long as the rate-limit headers say:
 * - `Retry-After` (seconds or an HTTP date);
 * - `RateLimit-Remaining: 0` / `X-RateLimit-Remaining: 0` with `RateLimit-Reset` /
 *   `X-RateLimit-Reset` (epoch seconds when large, otherwise seconds from now);
 * - the IETF structured form `RateLimit: "policy";r=0;t=30` (Forgejo/Codeberg).
 * A success that reports zero remaining requests delays the next request until
 * the reset, so a long walk does not run into the limit.
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
  /** Retries per request (default 6). */
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
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Status on the error thrown when retries are exhausted. */
export const GAVE_UP = 0;
const MAX_WAIT_MS = 15 * 60 * 1000;

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Returns a reason to retry a parsed 2xx body (e.g. a transient GraphQL error), or null to accept it. */
  accept?: (body: unknown) => string | null;
}

/** Milliseconds the response's rate-limit headers ask the client to wait, or null if they say nothing. */
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

const isRateLimited = (res: Response) => {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const remaining = res.headers.get("ratelimit-remaining") ?? res.headers.get("x-ratelimit-remaining");
  return res.headers.get("retry-after") !== null || remaining === "0";
};

export class HttpClient {
  requestCount = 0;
  private notBefore = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly baseUrl: string;

  constructor(private readonly o: HttpClientOptions) {
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
    const max = this.o.maxRetries ?? 6;
    const init: RequestInit = {
      method,
      headers: { accept: "application/json", "user-agent": "pr-rla/0.2", ...this.o.headers, ...opts.headers, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
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
