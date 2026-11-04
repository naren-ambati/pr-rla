import {
  PROVIDER_API_VERSION,
  RepoEmptyError,
  RepoUnavailableError,
  defineProvider,
  type ChangeRecord,
  type FirstParentCommit,
  type ListChangesRequest,
  type ListChangesResult,
  type ListingVisibility,
  type ProviderContext,
  type RepoRef,
  type RepoSetRule,
  type RepoVisibility,
  type RequestEstimate,
  type ScmProvider,
} from "../../sdk/provider.js";
import { firstParentChain } from "../first-parent.js";
import { LANDED_VIA_LIMITATION, landedViaMerges } from "../landed-via.js";
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

interface RestRepo {
  full_name: string;
  id: number;
  default_branch?: string | null;
  archived?: boolean;
  fork?: boolean;
  private?: boolean;
  visibility?: string;
  created_at?: string | null;
}

/** A REST repository as a RepoRef: `visibility` when GitHub sends it (internal included), else from `private`. */
function repoRef(r: RestRepo): RepoRef {
  const visibility: RepoVisibility = r.visibility === "public" || r.visibility === "private" || r.visibility === "internal" ? r.visibility : r.private ? "private" : "public";
  const created = r.created_at ? Date.parse(r.created_at) : NaN;
  return { repo: r.full_name, id: String(r.id), defaultBranch: r.default_branch ?? "", archived: r.archived === true, fork: r.fork === true, visibility, ...(Number.isFinite(created) ? { createdAt: new Date(created).toISOString().replace(".000Z", "Z") } : {}) };
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
    // An empty repository (no commits) has no default branch. A single-repo audit stops here, as it always has; a pool
    // counts the repo as empty (the core catches the code).
    if (!ref) throw new RepoEmptyError(req.repo);
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
      // A head the repository does not have (GitHub answers object: null): a 404 on a commit, not on the repository.
      if (!h) throw new GitHubHttpError(`github: commit ${headOid} not found in ${owner}/${name} (cannot read its history)`, 404);
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

  /**
   * The repositories under an org, or under a user account, with the stable id, default branch, archived and fork flags,
   * visibility and creation time the core filters on (U8). `GET /orgs/{owner}/repos?type=all` shows every repository of
   * the org the token can see. A user account answers 404 there: when it is the token's own account,
   * `GET /user/repos?affiliation=owner` lists its private repositories too; for another user GitHub lists only the public
   * ones (`/users/{owner}/repos`), and `listingVisibility` says so.
   */
  async listRepos(set: RepoSetRule): Promise<RepoRef[]> {
    const owner = encodeURIComponent(set.owner);
    let url: string | null = `/orgs/${owner}/repos?type=all&per_page=${this.pageSize}`;
    const out: RepoRef[] = [];
    let pages = 0;
    let fellBack = false;
    while (url) {
      let page: { data: RestRepo[]; next: string | null };
      try {
        page = await this.http.rest<RestRepo[]>(url);
      } catch (e) {
        if (!fellBack && pages === 0 && e instanceof GitHubHttpError && e.status === 404) {
          fellBack = true;
          url = (await this.ownAccount(set.owner)) ? `/user/repos?affiliation=owner&per_page=${this.pageSize}` : `/users/${owner}/repos?type=owner&per_page=${this.pageSize}`;
          continue;
        }
        throw e;
      }
      pages++;
      if (pages % 20 === 0) this.ctx.log(`github: listed ${pages} pages of ${set.owner} repositories`);
      for (const r of page.data) out.push(repoRef(r));
      url = page.next;
    }
    return out;
  }

  /** True when `owner` is the account the token belongs to (`GET /user`); false without a token. */
  private async ownAccount(owner: string): Promise<boolean> {
    if (!this.http.authenticated) return false;
    const { data } = await this.http.rest<{ login: string }>("/user");
    return data.login.toLowerCase() === owner.toLowerCase();
  }

  /**
   * One repository's metadata (U8): `GET /repositories/{id}` by its stable id (GitHub resolves a renamed or transferred
   * repository by id), else `GET /repos/{owner}/{name}`. GitHub answers 404 both for a repository that does not exist
   * and for a private one the token cannot see ("to prevent the accidental leakage of private repositories"); that is
   * a RepoUnavailableError(404). A 403 (SSO not authorised, an IP allow list) is an access problem and is thrown as it is.
   */
  async describeRepo(ref: { repo: string; id?: string }): Promise<RepoRef> {
    try {
      const { data } = await this.http.rest<RestRepo>(ref.id ? `/repositories/${encodeURIComponent(ref.id)}` : `/repos/${ref.repo}`);
      return repoRef(data);
    } catch (e) {
      if (e instanceof GitHubHttpError && e.status === 404) throw new RepoUnavailableError(ref.repo, 404, e.message);
      throw e;
    }
  }

  /**
   * What the token sees under an owner (U8; finding 2 of the U8 review). GitHub lists public repositories to anyone. For
   * private and internal repositories pr-rla accepts a listing as complete only when all of these hold, each from a
   * documented response:
   * - the token is a classic personal access token or an OAuth token: its responses carry `X-OAuth-Scopes` (fine-grained
   *   and GitHub App tokens carry none, and can be limited to selected repositories with no API that says so);
   * - its scopes include `repo` (without it GitHub shows the token no private repository);
   * - for an org, `GET /user/memberships/orgs/{org}` says `state: active`, `role: admin`: an org owner can see every
   *   repository of the org, whereas a member sees only the private repositories they were granted. For a user account,
   *   it is the token's own account (`GET /user`), listed through `/user/repos`.
   */
  async listingVisibility(set: RepoSetRule): Promise<ListingVisibility> {
    let identity: string | null = null;
    const publicProof = { complete: true, reason: "GitHub lists every public repository to anyone" };
    const none = (reason: string): ListingVisibility => ({ identity, visibilities: { public: publicProof, private: { complete: false, reason }, internal: { complete: false, reason } } });
    if (!this.http.authenticated) return none("no token: GitHub shows only public repositories");
    const user = await this.http.rest<{ login: string }>("/user");
    identity = user.data.login;
    const scopes = user.headers.get("x-oauth-scopes");
    if (scopes === null) return none("the token sends no X-OAuth-Scopes header, so it is a fine-grained personal access token or a GitHub App token: it shows only the repositories it was granted, and GitHub has no API that says it was granted all of them");
    const list = scopes.split(",").map((x) => x.trim()).filter(Boolean);
    if (!list.includes("repo")) return none(`the classic token's scopes (${list.join(", ") || "none"}) do not include repo, so GitHub shows it no private repository`);
    let isOrg = true;
    try {
      await this.http.rest(`/orgs/${encodeURIComponent(set.owner)}`);
    } catch (e) {
      if (!(e instanceof GitHubHttpError && e.status === 404)) throw e;
      isOrg = false;
    }
    if (!isOrg) {
      if (identity.toLowerCase() !== set.owner.toLowerCase()) return none(`${set.owner} is another user's account: GitHub lists only its public repositories`);
      const own = { complete: true, reason: `${set.owner} is the token's own account, listed through /user/repos with the repo scope` };
      return { identity, visibilities: { public: publicProof, private: own, internal: { complete: true, reason: "a user account has no internal repositories" } } };
    }
    let m: { state?: string; role?: string };
    try {
      m = (await this.http.rest<{ state?: string; role?: string }>(`/user/memberships/orgs/${encodeURIComponent(set.owner)}`)).data;
    } catch (e) {
      if (e instanceof GitHubHttpError && (e.status === 404 || e.status === 403)) return none(`${identity} is not a member of ${set.owner} (or the token lacks read:org): HTTP ${e.status} on /user/memberships/orgs/${set.owner}`);
      throw e;
    }
    if (m.state === "active" && m.role === "admin") {
      const owner = { complete: true, reason: `${identity} is an owner (admin) of ${set.owner}, with a classic token holding the repo scope: GitHub shows org owners every repository of the org` };
      return { identity, visibilities: { public: publicProof, private: owner, internal: owner } };
    }
    return none(`${identity} is ${m.state === "active" ? `a ${m.role ?? "member"}` : `a ${m.state ?? "non-active"} member`} of ${set.owner}, not an owner: GitHub shows a member only the private repositories they were granted, so only an owner's listing is complete`);
  }

  /**
   * The default branch's first-parent commits from `head` back to `base` (U8), from the compare API
   * (`GET /repos/{owner}/{name}/compare/{base}...{head}`, paged): `status: ahead` means `base` is an ancestor of `head`,
   * and `commits` are those reachable from `head` and not from `base`, each with its parents. Null when `base` is not
   * an ancestor, or not on the first-parent chain.
   */
  async firstParentPath(req: { repo: string; base: string; head: string; signal?: AbortSignal }): Promise<FirstParentCommit[] | null> {
    if (req.base.toLowerCase() === req.head.toLowerCase()) return [];
    interface Compare {
      status: "ahead" | "behind" | "diverged" | "identical";
      total_commits: number;
      commits: { sha: string; parents: { sha: string }[]; commit: { committer: { date: string } | null } }[];
    }
    const byOid = new Map<string, Compare["commits"][number]>();
    let status: Compare["status"] = "identical";
    for (let page = 1; ; page++) {
      req.signal?.throwIfAborted();
      const { data } = await this.http.rest<Compare>(`/repos/${req.repo}/compare/${req.base}...${req.head}?per_page=100&page=${page}`);
      status = data.status;
      if (status !== "ahead") break;
      for (const c of data.commits) byOid.set(c.sha.toLowerCase(), c);
      if (data.commits.length === 0 || byOid.size >= data.total_commits) break;
    }
    if (status === "identical") return [];
    if (status !== "ahead") return null;
    return firstParentChain([...byOid.values()].map((c) => ({ sha: c.sha, parents: c.parents.map((x) => x.sha), committedAt: c.commit.committer?.date ?? "" })), req.base, req.head);
  }

  /**
   * What `listChanges` would ask for, from a probe (U8, `freeze --dry-run --estimate`): the default-branch head, the
   * newest page of closed PRs (and, when the list is longer, a page from its middle for the density and the share merged
   * in the window), and one page of history. Everything else is arithmetic on those pages.
   */
  async estimateRequests(req: ListChangesRequest): Promise<RequestEstimate> {
    const { owner, name } = this.split(req.repo);
    const opens = Date.parse(req.window.opensAt);
    const closes = Date.parse(req.window.closesAt);
    const wantPrs = req.kinds.includes("pull_request");
    const wantPushes = req.kinds.includes("direct_push");
    let probed = 1;
    const head = await this.http.graphql<{ repository: { defaultBranchRef: { name: string; target: { oid: string } } | null } }>(HEAD_QUERY, { owner, name });
    const ref = head.repository.defaultBranchRef;
    if (!ref) return { requests: 1, graphql: 1, probed };
    const headOid = (req.head ?? ref.target.oid).toLowerCase();

    // Closed PRs, newest update first: pages until one ends before the window opened (listMergedPullNumbers), and the shares in the window.
    const url = (page: number) => `/repos/${req.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${this.pageSize}${page > 1 ? `&page=${page}` : ""}`;
    const a = await this.http.rest<RestPull[]>(url(1));
    probed++;
    const span = (p: RestPull[]) => Math.max(1, Date.parse(p[0]!.updated_at) - Date.parse(p.at(-1)!.updated_at));
    const intoWindow = (p: readonly RestPull[]) => p.filter((x) => x.merged_at && x.base.ref === ref.name && Date.parse(x.merged_at) >= opens && Date.parse(x.merged_at) < closes).length;
    let updatedSinceOpens: number;
    let merged: number;
    let pullPages: number | null = null;
    if (a.data.length === 0 || !a.next || Date.parse(a.data.at(-1)!.updated_at) < opens) {
      // The whole list since the window opened is on this page: exact.
      updatedSinceOpens = a.data.filter((x) => Date.parse(x.updated_at) >= opens).length;
      merged = intoWindow(a.data);
      pullPages = 1;
    } else {
      // Density from the newest page projects the length; a page from the middle gives the density there and what share merged in the window.
      const dA = a.data.length / span(a.data);
      const firstProjection = a.data.length + dA * (Date.parse(a.data.at(-1)!.updated_at) - opens);
      const middle = Math.floor(firstProjection / this.pageSize / 2) + 1;
      let b: RestPull[] | null = null;
      if (middle > 1) {
        b = (await this.http.rest<RestPull[]>(url(middle))).data;
        probed++;
      }
      if (b && b.length > 0) {
        const dB = b.length / span(b);
        updatedSinceOpens = a.data.length + dB * Math.max(0, Date.parse(a.data.at(-1)!.updated_at) - opens);
        merged = updatedSinceOpens * (intoWindow(b) / b.length);
      } else {
        updatedSinceOpens = firstProjection;
        merged = updatedSinceOpens * (intoWindow(a.data) / a.data.length);
      }
    }
    // The newest page is read once more (the re-scan for PRs updated during the walk).
    const restPages = (pullPages ?? Math.max(2, Math.ceil(updatedSinceOpens / this.pageSize))) + 1;
    let graphql = 1;
    graphql += wantPrs ? Math.ceil(merged / this.batchSize) : 0;

    if (wantPushes) {
      type Page = { repository: { object: { history: { pageInfo: { hasNextPage: boolean }; nodes: { committedDate: string }[] } } | null } };
      const h = await this.http.graphql<Page>(historyQuery(this.historyPageSize), { owner, name, head: headOid, since: req.window.opensAt, after: null });
      probed++;
      const nodes = h.repository.object?.history.nodes ?? [];
      let commits = nodes.length;
      if (h.repository.object?.history.pageInfo.hasNextPage && nodes.length > 1) {
        const dates = nodes.map((n) => Date.parse(n.committedDate)).sort((x, y) => y - x);
        const density = nodes.length / Math.max(1, dates[0]! - dates.at(-1)!);
        commits = nodes.length + density * Math.max(0, dates.at(-1)! - opens);
      }
      graphql += Math.max(1, Math.ceil(commits / this.historyPageSize));
    }
    return { requests: Math.round(restPages + graphql), graphql: Math.round(graphql), probed };
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
