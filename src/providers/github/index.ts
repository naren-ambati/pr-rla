import {
  PROVIDER_API_VERSION,
  defineProvider,
  type ChangeDescription,
  type ChangeRecord,
  type ListChangesRequest,
  type ListChangesResult,
  type ProviderContext,
  type ScmProvider,
} from "../../sdk/provider.js";
import { LANDED_VIA_LIMITATION, landedViaMerges } from "../landed-via.js";
import { describeGitHubChange } from "./describe.js";
import { classifyHistory, type HistoryNode } from "./history.js";
import { GAVE_UP, GitHubHttp, GitHubHttpError } from "./http.js";
import { normalizeDirectPush, normalizePullRequest, type GqlHistoryCommit, type GqlPullRequest, type GqlReview } from "./normalize.js";
import { HEAD_QUERY, MORE_REVIEWS_QUERY, historyQuery, prBatchQuery } from "./queries.js";

export interface GitHubProviderOptions {
  /** Env var holding the token (default GITHUB_TOKEN, then GH_TOKEN; GH_ENTERPRISE_TOKEN too with base_url). */
  token_env?: string;
  /** GitHub Enterprise Server root, e.g. https://ghe.example.com: REST at /api/v3, GraphQL at /api/graphql. */
  base_url?: string;
  /** REST root (default https://api.github.com, or <base_url>/api/v3). */
  api_url?: string;
  /** GraphQL endpoint (default <api_url>/graphql on github.com; <host>/api/graphql when the REST root ends in /api/v3). */
  graphql_url?: string;
  /** REST page size (max 100). */
  page_size?: number;
  /** PRs per GraphQL query (default 40). */
  batch_size?: number;
  /** Commits per history page (default 50; halved automatically while GitHub returns 5xx). */
  history_page_size?: number;
}

interface RestPull {
  number: number;
  merged_at: string | null;
  updated_at: string;
  merge_commit_sha: string | null;
  base: { ref: string };
}

/**
 * REST and GraphQL endpoints. github.com: api.github.com and api.github.com/graphql.
 * GitHub Enterprise Server: <host>/api/v3 and <host>/api/graphql (NOT /api/v3/graphql).
 */
export function githubEndpoints(opts: Pick<GitHubProviderOptions, "base_url" | "api_url" | "graphql_url">): { apiUrl: string; graphqlUrl: string; enterprise: boolean } {
  const trim = (u: string) => u.replace(/\/+$/, "");
  const base = opts.base_url ? trim(opts.base_url) : null;
  const enterprise = base !== null && !/^https?:\/\/(www\.)?github\.com$/i.test(base);
  const apiUrl = trim(opts.api_url ?? (enterprise ? `${base}/api/v3` : "https://api.github.com"));
  const graphqlUrl = opts.graphql_url ?? (/\/api\/v3$/.test(apiUrl) ? apiUrl.replace(/\/api\/v3$/, "/api/graphql") : `${apiUrl}/graphql`);
  return { apiUrl, graphqlUrl, enterprise: enterprise || /\/api\/v3$/.test(apiUrl) };
}

export const GITHUB_LIMITATIONS = [
  "direct_push: GitHub's commit APIs do not expose the pusher; `author` is the commit author (commit author != pusher) and mergedBy is null.",
  "direct_push: the window is applied to the commit's committedDate, not the push time.",
  "direct_push: every commit reachable from the default branch, dated in the window, that no merged PR into that branch introduced (GitHub's commit->PR link, or the PR's merge commit SHA). A direct-push merge commit's changedLines are GitHub's diff against its first parent.",
  "pull_request: only PRs merged into the default branch count; reviews are as of freeze time.",
];

export class GitHubProvider implements ScmProvider {
  readonly apiVersion = PROVIDER_API_VERSION;
  readonly name = "github";
  readonly http: GitHubHttp;
  private readonly pageSize: number;
  private readonly batchSize: number;
  private readonly historyPageSize: number;

  constructor(opts: GitHubProviderOptions, private readonly ctx: ProviderContext & { now?: () => number }) {
    const urls = githubEndpoints(opts);
    const token = (opts.token_env ? ctx.env[opts.token_env] : undefined) ?? ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN ?? (urls.enterprise ? ctx.env.GH_ENTERPRISE_TOKEN : undefined);
    // maxRetries 0: ctx.fetch is the fetch broker, the only retrier (contracts.md §2).
    this.http = new GitHubHttp({ token, apiUrl: urls.apiUrl, graphqlUrl: urls.graphqlUrl, fetch: ctx.fetch, log: ctx.log, maxRetries: 0, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) });
    this.pageSize = Math.min(100, opts.page_size ?? 100);
    this.batchSize = opts.batch_size ?? 40;
    this.historyPageSize = opts.history_page_size ?? 50;
  }

  private split(repo: string): { owner: string; name: string } {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
    if (!m) throw new Error(`github repo must be "owner/name" (got "${repo}")`);
    return { owner: m[1]!, name: m[2]! };
  }

  async listChanges(req: ListChangesRequest): Promise<ListChangesResult> {
    const { owner, name } = this.split(req.repo);
    const head = await this.http.graphql<{ repository: { defaultBranchRef: { name: string; target: { oid: string } } | null } }>(HEAD_QUERY, { owner, name });
    const ref = head.repository.defaultBranchRef;
    if (!ref) throw new Error(`${req.repo} has no default branch`);
    // The pinned head (U3): verify walks the history freeze walked, from the manifest's headSha.
    const headSha = (req.head ?? ref.target.oid).toLowerCase();
    const changes: ChangeRecord[] = [];
    const diagnostics: { label: string; value: number }[] = [];
    // The PR listing is needed for direct pushes too: a PR's merge commit is never a direct push.
    const listed = await this.listMergedPullNumbers(req, ref.name);
    if (req.kinds.includes("pull_request")) {
      diagnostics.push({ label: "PRs merged into other branches in window (excluded)", value: listed.otherBase });
      const prs = await this.fetchPullRequests(owner, name, listed.intoDefault);
      for (const pr of prs) changes.push(pr);
    }
    let viaMerge = false;
    if (req.kinds.includes("direct_push")) {
      const { directPushes, linkedPrs, inWindow, merges, landedVia } = await this.walkHistory(owner, name, req, ref.name, headSha, listed.mergeCommits);
      changes.push(...directPushes.map((c) => normalizeDirectPush(req.repo, c, landedVia.get(c.oid)?.toLowerCase())));
      viaMerge = landedVia.size > 0;
      diagnostics.push({ label: "default-branch commits in window", value: inWindow });
      diagnostics.push({ label: "commits linked to a merged PR", value: linkedPrs });
      diagnostics.push({ label: "direct pushes that are merge commits", value: merges });
    }
    return { changes, defaultBranch: ref.name, limitations: viaMerge ? [...GITHUB_LIMITATIONS, LANDED_VIA_LIMITATION] : GITHUB_LIMITATIONS, diagnostics, headSha };
  }

  /** REST pulls (state=closed, sort=updated desc), filtered by merged_at, plus a re-scan for PRs updated during the walk. */
  async listMergedPullNumbers(req: ListChangesRequest, defaultBranch: string): Promise<{ intoDefault: number[]; otherBase: number; mergeCommits: Map<string, number> }> {
    const opens = Date.parse(req.window.opensAt);
    const closes = Date.parse(req.window.closesAt);
    const now = this.ctx.now ?? Date.now;
    const into = new Set<number>();
    const other = new Set<number>();
    const mergeCommits = new Map<string, number>();
    const consider = (p: RestPull) => {
      if (!p.merged_at) return;
      if (p.base.ref === defaultBranch && p.merge_commit_sha) mergeCommits.set(p.merge_commit_sha.toLowerCase(), p.number);
      const t = Date.parse(p.merged_at);
      if (t < opens || t >= closes) return;
      (p.base.ref === defaultBranch ? into : other).add(p.number);
    };
    const first = `/repos/${req.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${this.pageSize}`;
    const walk = async (stopBefore: number) => {
      let url: string | null = first;
      let pages = 0;
      while (url) {
        req.signal?.throwIfAborted();
        const { data, next }: { data: RestPull[]; next: string | null } = await this.http.rest<RestPull[]>(url);
        pages++;
        if (pages % 20 === 0) this.ctx.log(`github: listed ${pages} pages of closed PRs`);
        data.forEach(consider);
        const last = data[data.length - 1];
        if (!last || Date.parse(last.updated_at) < stopBefore) break;
        url = next;
      }
    };
    const walkStart = now();
    await walk(opens);
    // Pagination is by page number over a list sorted by updated_at: a PR updated
    // mid-walk jumps to page 1 and could be skipped. Re-read the head of the list.
    await walk(walkStart - 60_000);
    return { intoDefault: [...into].sort((a, b) => a - b), otherBase: other.size, mergeCommits };
  }

  async fetchPullRequests(owner: string, name: string, numbers: readonly number[]): Promise<ChangeRecord[]> {
    const out: ChangeRecord[] = [];
    for (let i = 0; i < numbers.length; i += this.batchSize) {
      const batch = numbers.slice(i, i + this.batchSize);
      const data = await this.http.graphql<{ repository: Record<string, GqlPullRequest | null> }>(prBatchQuery(batch), { owner, name });
      for (const n of batch) {
        const pr = data.repository[`p${n}`];
        if (!pr) throw new Error(`github: PR #${n} missing from GraphQL response`);
        const extra: GqlReview[] = [];
        let page = pr.reviews.pageInfo;
        while (page.hasNextPage) {
          const more = await this.http.graphql<{ repository: { pullRequest: { reviews: { pageInfo: typeof page; nodes: GqlReview[] } } } }>(MORE_REVIEWS_QUERY, { owner, name, number: n, after: page.endCursor });
          extra.push(...more.repository.pullRequest.reviews.nodes);
          page = more.repository.pullRequest.reviews.pageInfo;
        }
        out.push(normalizePullRequest(`${owner}/${name}`, pr, extra));
      }
      if ((i / this.batchSize) % 10 === 9) this.ctx.log(`github: read reviews for ${Math.min(i + this.batchSize, numbers.length)}/${numbers.length} PRs`);
    }
    return out;
  }

  async walkHistory(owner: string, name: string, req: ListChangesRequest, defaultBranch: string, headOid: string, mergeCommits: ReadonlyMap<string, number>) {
    const nodes = new Map<string, GqlHistoryCommit>();
    let after: string | null = null;
    let size = this.historyPageSize;
    let pages = 0;
    for (;;) {
      req.signal?.throwIfAborted();
      type Page = { repository: { object: { history: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlHistoryCommit[] } } | null } };
      let data: Page;
      try {
        // Few retries per size: GitHub 502s on heavy history pages; a smaller page from the same cursor usually succeeds.
        data = await this.http.graphql<Page>(historyQuery(size), { owner, name, head: headOid, since: req.window.opensAt, after }, { maxRetries: size > 10 ? 2 : undefined });
      } catch (e) {
        if (e instanceof GitHubHttpError && e.status === GAVE_UP && size > 10) {
          size = Math.ceil(size / 2);
          this.ctx.log(`github: history page failed repeatedly; continuing with ${size} commits per page`);
          continue;
        }
        throw e;
      }
      const h = data.repository.object?.history;
      if (!h) throw new Error(`github: cannot read history of ${headOid}`);
      for (const c of h.nodes) nodes.set(c.oid, c);
      pages++;
      if (pages % 10 === 0) this.ctx.log(`github: walked ${nodes.size} commits of ${defaultBranch}`);
      if (!h.pageInfo.hasNextPage) break;
      after = h.pageInfo.endCursor;
    }
    const toNode = (c: GqlHistoryCommit): HistoryNode => ({
      oid: c.oid,
      committedDate: c.committedDate,
      parents: c.parents.nodes.map((p) => p.oid),
      associatedPullRequests: c.associatedPullRequests.nodes,
    });
    const result = classifyHistory([...nodes.values()].map(toNode), req.window, defaultBranch, mergeCommits);
    const parents = new Map([...nodes.values()].map((c) => [c.oid, c.parents.nodes.map((p) => p.oid)]));
    return {
      landedVia: landedViaMerges(parents, result.directPushes),
      directPushes: result.directPushes.map((oid) => nodes.get(oid)!),
      linkedPrs: [...result.prCommits.values()].reduce((a, v) => a + v.length, 0),
      inWindow: result.inWindow,
      merges: result.directPushMerges.length,
    };
  }

  /** What a reviewer reads for one drawn change (U5): see ./describe.ts. */
  describeChange(change: ChangeRecord): Promise<ChangeDescription> {
    return describeGitHubChange(this.http, change);
  }

  /** GitHub search's own figures for the same author/window, printed next to pr-rla's population. */
  async nativeCounts(req: ListChangesRequest, selector: Readonly<Record<string, unknown>>): Promise<{ label: string; value: number }[]> {
    const day = (iso: string, deltaDays = 0) => new Date(Date.parse(iso) + deltaDays * 86_400_000).toISOString().slice(0, 10);
    const range = `${day(req.window.opensAt)}..${day(req.window.closesAt, -1)}`;
    const authors = Array.isArray(selector.authors) ? (selector.authors as string[]) : [null];
    let merged = 0;
    let none = 0;
    for (const a of authors) {
      const who = a === null ? "" : a.endsWith("[bot]") ? ` author:app/${a.slice(0, -5)}` : ` author:${a}`;
      const base = `repo:${req.repo} is:pr is:merged${who} merged:${range}`;
      const q = async (s: string) => (await this.http.rest<{ total_count: number }>(`/search/issues?per_page=1&q=${encodeURIComponent(s)}`)).data.total_count;
      merged += await q(base);
      none += await q(`${base} review:none`);
    }
    return [
      { label: "GitHub search: merged PRs (author, window)", value: merged },
      { label: "GitHub search: review:none", value: none },
    ];
  }
}

export default defineProvider<GitHubProviderOptions>({
  providerApiVersion: PROVIDER_API_VERSION,
  name: "github",
  description: "GitHub.com and GitHub Enterprise Server (base_url): REST pulls + GraphQL reviews (batches of 40) + default-branch history for direct pushes",
  hosts: (options) => {
    const urls = githubEndpoints(options ?? {});
    return [...new Set([new URL(urls.apiUrl).host, new URL(urls.graphqlUrl).host])];
  },
  reviewGranularity: "submission",
  populationOptions: ["base_url", "api_url", "graphql_url"],
  reportsLandedVia: true,
  create: (options, ctx) => new GitHubProvider(options ?? {}, ctx),
});
