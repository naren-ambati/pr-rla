import type { BrokerInit } from "../net/contract.js";
import { exhaustion } from "../sdk/http.js";

/**
 * The issue ledgers' JSON client. One attempt per call: requests speak the broker contract
 * (`destination: "scm"`), so the fetch broker is the only retrier (contracts.md §2 step 6).
 * Reads are idempotent and retried there on 5xx, 429 and truncated bodies; writes are sent with
 * `idempotent: false`, so the broker retries them only before send and on 429, never after a 5xx
 * (a lost response could mean the issue exists: `publishDraws` then finds it by its marker).
 */

export interface LedgerResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  /** The final URL, after any redirect the broker followed. */
  url: string;
}

export class LedgerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "LedgerHttpError";
  }
}

export interface LedgerHttpOptions {
  /** Ledger name, for messages. */
  ledger: string;
  /** API root, e.g. `https://api.github.com`; relative paths are appended to it. */
  baseUrl: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  /** Added to an error on 401/403, e.g. "set GITHUB_TOKEN to a token with Issues: write on acme/audit". */
  authHint?: string;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH";

export class LedgerHttp {
  readonly baseUrl: string;
  requests = 0;
  constructor(private readonly o: LedgerHttpOptions) {
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
  }

  url(pathOrUrl: string): string {
    if (!/^https?:\/\//.test(pathOrUrl)) return `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    // A rel="next" link is the server's word, and these headers carry the credential: another origin than the API root's is refused.
    const root = new URL(this.baseUrl).origin;
    if (new URL(pathOrUrl).origin !== root) throw new LedgerHttpError(`${this.o.ledger}: refusing ${pathOrUrl}: it is not on the API origin ${root}, and the request would carry the credential there`, 400, pathOrUrl);
    return pathOrUrl;
  }

  /** One JSON request. Statuses in `accept` (e.g. 404, 410) come back to the caller; any other non-2xx throws. */
  async request<T>(method: Method, pathOrUrl: string, opts: { body?: unknown; accept?: readonly number[] } = {}): Promise<LedgerResponse<T>> {
    const url = this.url(pathOrUrl);
    const write = method !== "GET";
    const init: RequestInit & Pick<BrokerInit, "destination" | "idempotent" | "retry"> = {
      method,
      headers: { accept: "application/json", "user-agent": "pr-rla/0.1", ...this.o.headers, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      destination: "scm",
      idempotent: !write,
      // Reads: a truncated body is retried. Writes are never retried after a response, and may answer 204 with no body.
      retry: write ? {} : { acceptJson: () => null },
    };
    this.requests++;
    let res: Response;
    try {
      res = await this.o.fetch(url, init);
    } catch (e) {
      const gaveUp = exhaustion(e);
      if (gaveUp) throw new LedgerHttpError(`${this.o.ledger} ${method} ${url}: gave up after ${gaveUp.attempts} attempts (${gaveUp.problem})`, 0, url);
      throw e;
    }
    const text = await res.text();
    if (!res.ok && !opts.accept?.includes(res.status)) {
      const hint = (res.status === 401 || res.status === 403) && this.o.authHint ? ` ${this.o.authHint}` : "";
      throw new LedgerHttpError(`${this.o.ledger} ${method} ${url}: HTTP ${res.status} ${text.slice(0, 200)}${hint}`, res.status, url);
    }
    let data: unknown = null;
    if (text.length) {
      try {
        data = JSON.parse(text);
      } catch {
        if (res.ok) throw new LedgerHttpError(`${this.o.ledger} ${method} ${url}: the response is not JSON (${text.length} bytes)`, res.status, url);
      }
    }
    return { status: res.status, data: data as T, headers: res.headers, url: res.url || url };
  }

  get<T>(pathOrUrl: string, accept?: readonly number[]): Promise<LedgerResponse<T>> {
    return this.request<T>("GET", pathOrUrl, accept ? { accept } : {});
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

/** Normalizes an ISO-8601 time with any offset or fraction to `YYYY-MM-DDTHH:MM:SS[.fff]Z`, keeping milliseconds when present. */
export function isoUtc(value: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`invalid timestamp ${value}`);
  const iso = new Date(t).toISOString();
  return iso.endsWith(".000Z") ? iso.replace(".000Z", "Z") : iso;
}

/** Runs `fn` over `items` with at most `n` in flight, keeping the input order in the result. */
export async function mapLimit<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
