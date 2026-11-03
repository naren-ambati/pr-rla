/** Minimal GitHub REST + GraphQL transport over fetch, with retries for 5xx and secondary rate limits. */

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

  private async send(url: string, init: RequestInit): Promise<Response> {
    const max = this.o.maxRetries ?? 6;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      this.requestCount++;
      let res: Response;
      try {
        res = await this.o.fetch(url, init);
      } catch (e) {
        if (attempt >= max) throw e;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const retryable = res.status >= 500 || res.status === 429 || (res.status === 403 && (res.headers.get("retry-after") !== null || res.headers.get("x-ratelimit-remaining") === "0"));
      if (!retryable || attempt >= max) return res;
      const after = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      let wait = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt;
      if (res.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) wait = Math.max(wait, reset * 1000 - Date.now() + 1000);
      this.o.log?.(`github: HTTP ${res.status} on ${url.replace(this.apiUrl, "")}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(Math.min(wait, 15 * 60 * 1000));
    }
  }

  /** GET a REST path (or absolute URL). Returns parsed JSON and the rel="next" link if any. */
  async rest<T>(pathOrUrl: string): Promise<{ data: T; next: string | null }> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`;
    const res = await this.send(url, { headers: this.headers() });
    if (!res.ok) throw new GitHubHttpError(`GitHub GET ${url.replace(this.apiUrl, "")}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
    const link = res.headers.get("link") ?? "";
    const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    return { data: (await res.json()) as T, next };
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.send(this.graphqlUrl, { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify({ query, variables }) });
    if (!res.ok) throw new GitHubHttpError(`GitHub GraphQL: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
    const body = (await res.json()) as { data?: T; errors?: { message: string; type?: string }[] };
    if (body.errors?.length) throw new GitHubHttpError(`GitHub GraphQL: ${body.errors.map((e) => e.message).join("; ")}`, 200);
    if (!body.data) throw new GitHubHttpError("GitHub GraphQL: empty response", 200);
    return body.data;
  }
}
