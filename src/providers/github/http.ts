/** Minimal GitHub REST + GraphQL transport over fetch, with retries for 5xx, secondary rate limits, truncated bodies and GraphQL timeouts. */

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
  private async request<T>(url: string, init: RequestInit, accept: (body: unknown) => string | null = () => null, maxRetries?: number): Promise<{ body: T; res: Response }> {
    const max = maxRetries ?? this.o.maxRetries ?? 6;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const short = url.replace(this.apiUrl, "");
    for (let attempt = 0; ; attempt++) {
      this.requestCount++;
      let wait = 1000 * 2 ** attempt;
      let reason: string;
      try {
        const res = await this.o.fetch(url, init);
        const retryable = res.status >= 500 || res.status === 429 || (res.status === 403 && (res.headers.get("retry-after") !== null || res.headers.get("x-ratelimit-remaining") === "0"));
        if (!res.ok && !retryable) throw new GitHubHttpError(`GitHub ${init.method ?? "GET"} ${short}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
        if (retryable) {
          reason = `HTTP ${res.status}`;
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
        reason = (e as Error).message;
      }
      if (attempt >= max) throw new GitHubHttpError(`GitHub ${init.method ?? "GET"} ${short}: gave up after ${attempt + 1} attempts (${reason})`, GAVE_UP);
      this.o.log?.(`github: ${reason} on ${short}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(Math.min(wait, 15 * 60 * 1000));
    }
  }

  /** GET a REST path (or absolute URL). Returns parsed JSON and the rel="next" link if any. */
  async rest<T>(pathOrUrl: string): Promise<{ data: T; next: string | null }> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`;
    const { body, res } = await this.request<T>(url, { headers: this.headers() });
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
    return { data: body, next };
  }

  async graphql<T>(query: string, variables: Record<string, unknown>, opts: { maxRetries?: number } = {}): Promise<T> {
    type G = { data?: T; errors?: { message: string; type?: string }[] };
    const { body } = await this.request<G>(this.graphqlUrl, { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify({ query, variables }) }, (b) => {
      const errs = (b as G).errors ?? [];
      if (errs.length && errs.every((e) => TRANSIENT_GRAPHQL.test(e.message) || e.type === "RATE_LIMITED")) return `GraphQL: ${errs[0]!.message}`;
      return null;
    }, opts.maxRetries);
    if (body.errors?.length) throw new GitHubHttpError(`GitHub GraphQL: ${body.errors.map((e) => e.message).join("; ")}`, 200);
    if (!body.data) throw new GitHubHttpError("GitHub GraphQL: empty response", 200);
    return body.data;
  }
}
