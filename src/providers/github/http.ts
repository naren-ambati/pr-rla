import { BrokerError, type BrokerInit } from "../../net/contract.js";
import { DEFAULT_MAX_RETRIES, exhaustion, type RetryHints } from "../../sdk/http.js";

/**
 * Minimal GitHub REST + GraphQL transport over fetch, with retries for 5xx, secondary rate limits,
 * truncated bodies and GraphQL timeouts. Behind the fetch broker the provider constructs it with
 * `maxRetries: 0` and each request hands its rules to the broker (`retry`), so the broker is the
 * only retrier; constructed with retries and a plain fetch, it retries itself as in phase 2.
 */

export interface GitHubHttpOptions {
  token?: string;
  apiUrl?: string;
  graphqlUrl?: string;
  fetch: typeof fetch;
  log?: (msg: string) => void;
  maxRetries?: number;
  /** Injected for tests; real runs sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export class GitHubHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GitHubHttpError";
  }
}

/** Status carried by the error thrown when retries are exhausted on a transient failure. */
export const GAVE_UP = 0;

/** GraphQL errors GitHub documents as transient (timeouts, internal errors, rate limits). */
const TRANSIENT_GRAPHQL = /something went wrong|timeout|timed out|rate limit|abuse|secondary|try again/i;

/** A 403 body that says the request was rate limited (primary or secondary limit, or the older abuse-detection wording). */
export const RATE_LIMIT_BODY = /rate limit|abuse detection/i;

/**
 * GitHub's guidance for a secondary rate limit that names no wait (P3, finding 9): "wait for at least one minute
 * before retrying", then "an exponentially increasing amount of time between retries", and "throw an error after a
 * specific number of retries". Behind the broker these are the request's retry hints: 1, 2, 4, 8, 15 minutes, then a
 * give-up the freeze stops on (exit 4, resumable).
 */
export const SECONDARY_LIMIT_WAIT_MS = 60_000;
export const SECONDARY_LIMIT_RETRIES = 5;

/** What kind of token a GitHub token is, by its documented prefix (never logged): it decides what its listing can prove. */
export type GitHubTokenKind = "classic" | "oauth-app" | "fine-grained" | "installation" | "app-user" | "other";
export function githubTokenKind(token: string): GitHubTokenKind {
  return token.startsWith("ghp_") ? "classic" : token.startsWith("gho_") ? "oauth-app" : token.startsWith("github_pat_") ? "fine-grained" : token.startsWith("ghs_") ? "installation" : token.startsWith("ghu_") ? "app-user" : "other";
}

export class GitHubHttp {
  readonly apiUrl: string;
  readonly graphqlUrl: string;
  requestCount = 0;
  constructor(private readonly o: GitHubHttpOptions) {
    this.apiUrl = (o.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.graphqlUrl = o.graphqlUrl ?? `${this.apiUrl}/graphql`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "pr-rla/0.1", ...extra };
    if (this.o.token) h.authorization = `Bearer ${this.o.token}`;
    return h;
  }

  /**
   * One request with retries. `accept(body)` returns null to accept the parsed
   * body, or a reason string to retry (e.g. a transient GraphQL error).
   */
  private async request<T>(url: string, base: RequestInit, accept: (body: unknown) => string | null = () => null, maxRetries?: number): Promise<{ body: T; res: Response }> {
    const own = this.o.maxRetries ?? DEFAULT_MAX_RETRIES;
    const max = Math.min(own, maxRetries ?? own);
    const retry: RetryHints = { acceptJson: accept, ...(maxRetries !== undefined ? { maxRetries } : {}), rateLimitBody: RATE_LIMIT_BODY.source, blindRateLimitWaitMs: SECONDARY_LIMIT_WAIT_MS, maxBlindRateLimitRetries: SECONDARY_LIMIT_RETRIES };
    // The BrokerInit fields are ignored by a plain fetch and read by the broker.
    const init: RequestInit & Pick<BrokerInit, "destination" | "retry"> = { ...base, destination: "scm", retry };
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const short = url.replace(this.apiUrl, "");
    for (let attempt = 0; ; attempt++) {
      this.requestCount++;
      let wait = 1000 * 2 ** attempt;
      let reason: string;
      try {
        const res = await this.o.fetch(url, init);
        let retryable = res.status >= 500 || res.status === 429 || (res.status === 403 && (res.headers.get("retry-after") !== null || res.headers.get("x-ratelimit-remaining") === "0"));
        let limitBody = false;
        if (!res.ok && !retryable) {
          const text = (await res.text()).slice(0, 300);
          // GitHub documents a secondary rate limit as a 403 (or 429) whose message says so, possibly with neither
          // retry-after nor x-ratelimit-remaining: 0. It is transient, never "the repository is unavailable".
          if (res.status === 403 && RATE_LIMIT_BODY.test(text)) retryable = limitBody = true;
          else throw new GitHubHttpError(`GitHub ${init.method ?? "GET"} ${short}: HTTP ${res.status} ${text}`, res.status);
        }
        if (retryable) {
          reason = limitBody ? `HTTP ${res.status} (secondary rate limit)` : `HTTP ${res.status}`;
          // Without a header, GitHub asks for at least a minute before the next try.
          if (limitBody) wait = Math.max(wait, 60_000);
          const after = Number(res.headers.get("retry-after"));
          const reset = Number(res.headers.get("x-ratelimit-reset"));
          if (Number.isFinite(after) && after > 0) wait = after * 1000;
          if (res.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) wait = Math.max(wait, reset * 1000 - Date.now() + 1000);
        } else {
          const text = await res.text();
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          const why = body === undefined ? `truncated or non-JSON body (${text.length} bytes)` : accept(body);
          if (why === null) return { body: body as T, res };
          reason = why;
        }
      } catch (e) {
        if (e instanceof GitHubHttpError) throw e;
        const gaveUp = exhaustion(e);
        if (gaveUp) throw new GitHubHttpError(`GitHub ${init.method ?? "GET"} ${short}: gave up after ${gaveUp.attempts} attempts (${gaveUp.problem})`, GAVE_UP);
        if (e instanceof BrokerError) throw e;
        reason = (e as Error).message;
      }
      if (attempt >= max) throw new GitHubHttpError(`GitHub ${init.method ?? "GET"} ${short}: gave up after ${attempt + 1} attempts (${reason})`, GAVE_UP);
      this.o.log?.(`github: ${reason} on ${short}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(Math.min(wait, 15 * 60 * 1000));
    }
  }

  /** GET a REST path (or absolute URL). Returns parsed JSON, the rel="next" link if any, and the response headers. */
  async rest<T>(pathOrUrl: string): Promise<{ data: T; next: string | null; headers: Headers }> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`;
    const { body, res } = await this.request<T>(url, { headers: this.headers() });
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    return { data: body, next, headers: res.headers };
  }

  /** Whether requests carry a token. */
  get authenticated(): boolean {
    return !!this.o.token;
  }

  /** The kind of token requests carry (by its prefix), or null without one. */
  get tokenKind(): GitHubTokenKind | null {
    return this.o.token ? githubTokenKind(this.o.token) : null;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>, opts: { maxRetries?: number } = {}): Promise<T> {
    type G = { data?: T; errors?: { message: string; type?: string }[] };
    const { body } = await this.request<G>(this.graphqlUrl, { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify({ query, variables }) }, (b) => {
      const errs = (b as G).errors ?? [];
      if (errs.length && errs.every((e) => TRANSIENT_GRAPHQL.test(e.message) || e.type === "RATE_LIMITED")) return `GraphQL: ${errs[0]!.message}`;
      return null;
    }, opts.maxRetries);
    // A repository that is gone, or that the token cannot see, is a 404 or 403 to the caller (U8: verify reports it as unverifiable, not as a failure).
    const only = (type: string) => body.errors!.every((e) => e.type === type);
    if (body.errors?.length) throw new GitHubHttpError(`GitHub GraphQL: ${body.errors.map((e) => e.message).join("; ")}`, only("NOT_FOUND") ? 404 : only("FORBIDDEN") ? 403 : 200);
    if (!body.data) throw new GitHubHttpError("GitHub GraphQL: empty response", 200);
    return body.data;
  }
}
