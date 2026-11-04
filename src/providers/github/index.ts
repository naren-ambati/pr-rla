import {
  PROVIDER_API_VERSION,
  RepoEmptyError,
  RepoUnavailableError,
  defineProvider,
  type ChangeDescription,
  type ChangeRecord,
  type FirstParentCommit,
  type ListChangesRequest,
  type ListChangesResult,
  type ListingVisibility,
  type ProviderContext,
  type PushLog,
  type PushLogEvent,
  type PushLogRequest,
  type RepoRef,
  type RepoSetRule,
  type RepoVisibility,
  type RequestEstimate,
  type ScmProvider,
  type DescribeChangeOptions,
  type AccountLookup,
} from "../../sdk/provider.js";
import { firstParentChain } from "../first-parent.js";
import { LANDED_VIA_LIMITATION, landedViaMerges } from "../landed-via.js";
import { describeGitHubChange } from "./describe.js";
import { classifyHistory, type HistoryNode } from "./history.js";
import { GAVE_UP, GitHubHttp, GitHubHttpError, asGitHubTokenKind } from "./http.js";
import { normalizeDirectPush, normalizePullRequest, type GqlHistoryCommit, type GqlPullRequest, type GqlReview } from "./normalize.js";
import { COMMIT_PARENTS_QUERY, COMMIT_PRS_QUERY, HEAD_QUERY, MORE_LABELS_QUERY, MORE_REVIEWS_QUERY, historyQuery, prBatchQuery } from "./queries.js";

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

/** One `GET /repos/{owner}/{repo}/issues/{n}/events` entry (REST API version 2022-11-28): the fields a label replay reads. */
interface RestIssueEvent {
  id: number | string;
  event: string;
  created_at?: string;
  label?: { name?: string } | null;
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

/** One entry of `GET /repos/{owner}/{repo}/activity` (REST API version 2022-11-28, the version pr-rla requests). */
interface RestActivity {
  id: number | string;
  before?: string;
  after?: string;
  ref?: string;
  timestamp?: string;
  activity_type?: string;
}

const ACTIVITY_KIND: Record<string, PushLogEvent["kind"]> = { push: "fast-forward", pr_merge: "fast-forward", merge_queue_merge: "fast-forward", force_push: "forced", branch_creation: "created", branch_deletion: "deleted" };

/** At most this many pages of a branch's activity (100 updates each) are read for one push log. */
export const MAX_ACTIVITY_PAGES = 100;

export const GITHUB_PUSH_LOG_LIMITATION =
  "push log: GitHub's repository activity (GET /repos/{owner}/{repo}/activity, the activity view's data); GitHub documents no retention. Seen 2026-11-04: github/gh-aw's log starts at its branch's creation (2025-08-12), torvalds/linux's on 2023-03-07, so updates before about March 2023 are not in it.";

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

/** P5: what a labels stratum's manifest says about where its labels come from. */
export const GITHUB_LABELS_LIMITATION =
  "labels: as at landing, replayed from each pull request's issue events (GET /repos/{owner}/{repo}/issues/{n}/events, one request per pull request) up to its merge time; GitHub's REST events keep a label's name as it was when it was applied, so a rename after landing changes nothing. Direct pushes carry no labels.";

export class GitHubProvider implements ScmProvider {
  readonly apiVersion = PROVIDER_API_VERSION;
  readonly name = "github";
  readonly http: GitHubHttp;
  private readonly pageSize: number;
  private readonly batchSize: number;
  private readonly historyPageSize: number;

  constructor(opts: GitHubProviderOptions, private readonly ctx: ProviderContext & { now?: () => number }) {
    const urls = githubEndpoints(opts);
    const names = [...(opts.token_env ? [opts.token_env] : []), "GITHUB_TOKEN", "GH_TOKEN", ...(urls.enterprise ? ["GH_ENTERPRISE_TOKEN"] : [])];
    const from = names.find((n) => ctx.env[n] !== undefined);
    const token = from === undefined ? undefined : ctx.env[from];
    // In read-only mode the token is a placeholder: its kind is what pr-rla derived from the real value (S1).
    const tokenKind = from === undefined ? undefined : asGitHubTokenKind(ctx.credentialKinds?.[from]);
    // maxRetries 0: ctx.fetch is the fetch broker, the only retrier (contracts.md §2).
    this.http = new GitHubHttp({ token, ...(tokenKind ? { tokenKind } : {}), apiUrl: urls.apiUrl, graphqlUrl: urls.graphqlUrl, fetch: ctx.fetch, log: ctx.log, maxRetries: 0, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) });
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
    const atLanding = req.labelsAt === "landing";
    if (req.kinds.includes("pull_request")) {
      diagnostics.push({ label: "PRs merged into other branches in window (excluded)", value: listed.otherBase });
      const prs = await this.fetchPullRequests(owner, name, listed.intoDefault);
      // P5: a labels stratum reads each PR's labels as they were when it merged, from its issue events.
      if (atLanding) for (const pr of prs) pr.labels = await this.labelsAtLanding(owner, name, pr, req.signal);
      for (const pr of prs) changes.push(pr);
    }
    let viaMerge = false;
    let unreachable: string[] | undefined;
    if (req.kinds.includes("direct_push")) {
      const { directPushes, linkedPrs, inWindow, merges, landedVia, visited } = await this.walkHistory(owner, name, req, ref.name, headSha, listed.mergeCommits);
      changes.push(...directPushes.map((c) => normalizeDirectPush(req.repo, c, landedVia.get(c.oid)?.toLowerCase())));
      viaMerge = landedVia.size > 0;
      diagnostics.push({ label: "default-branch commits in window", value: inWindow });
      diagnostics.push({ label: "commits linked to a merged PR", value: linkedPrs });
      diagnostics.push({ label: "direct pushes that are merge commits", value: merges });
      // P3: a pull request merged in the window whose merge commit the walk from the head did not reach.
      if (req.kinds.includes("pull_request")) unreachable = await this.unreachablePulls(req, headSha, changes.filter((c) => c.kind === "pull_request" && !visited.has(c.mergeSha)));
    }
    const limitations = [...GITHUB_LIMITATIONS, ...(viaMerge ? [LANDED_VIA_LIMITATION] : []), ...(atLanding ? [GITHUB_LABELS_LIMITATION] : [])];
    return { changes, defaultBranch: ref.name, limitations, diagnostics, headSha, ...(unreachable ? { unreachable } : {}), ...(atLanding ? { labelsAt: "landing" as const } : {}) };
  }

  /**
   * A pull request's labels when it merged (P5): its issue events (`GET /repos/{owner}/{repo}/issues/{n}/events`, paged,
   * oldest first), `labeled` and `unlabeled` at or before `mergedAt` replayed in order. GitHub's REST events keep each
   * label's name as it was when it was applied (recorded 2026-11-04: rust-lang/rust #30003 and #30010, where GraphQL shows
   * the renamed label's current name), so a rename after landing changes nothing, and nothing done after landing does.
   * A label event that names no label is refused, never guessed.
   */
  async labelsAtLanding(owner: string, name: string, pr: ChangeRecord, signal?: AbortSignal): Promise<string[]> {
    const number = Number(pr.id.slice(pr.id.lastIndexOf("#") + 1));
    const merged = Date.parse(pr.mergedAt);
    let url: string | null = `/repos/${owner}/${name}/issues/${number}/events?per_page=${this.pageSize}`;
    const events: { at: number; id: number; add: boolean; name: string }[] = [];
    while (url) {
      signal?.throwIfAborted();
      const page: { data: RestIssueEvent[]; next: string | null } = await this.http.rest<RestIssueEvent[]>(url);
      if (!Array.isArray(page.data)) throw new GitHubHttpError(`GitHub GET /repos/${owner}/${name}/issues/${number}/events: not a list`, 200);
      for (const e of page.data) {
        if (e.event !== "labeled" && e.event !== "unlabeled") continue;
        const at = Date.parse(e.created_at ?? "");
        if (typeof e.label?.name !== "string" || !Number.isFinite(at)) throw new Error(`github: ${pr.id}: issue event ${String(e.id)} (${e.event}) names no label or no time; its labels at landing cannot be read`);
        events.push({ at, id: Number(e.id), add: e.event === "labeled", name: e.label.name });
      }
      url = page.next;
    }
    const labels = new Set<string>();
    for (const e of events.sort((a, b) => a.at - b.at || a.id - b.id)) {
      if (Math.floor(e.at / 1000) * 1000 > merged) break;
      if (e.add) labels.add(e.name);
      else labels.delete(e.name);
    }
    return [...labels].sort();
  }

  /**
   * Of the pull requests merged in the window whose merge commit the history walk from `head` did not visit, the ones
   * GitHub confirms are not ancestors of `head` (P3, the stopgap): `GET /repos/{repo}/compare/{merge}...{head}` says
   * `ahead` or `identical` when the merge commit is reachable. The walk visits every commit reachable from `head` dated
   * since the window opened, and GitHub dates a merge, squash or rebase-merge commit at its merge, so an unvisited one
   * is rare in an honest history (a pull request merged by pushing its own older commit). At most 10 are asked, and
   * asking stops at the third unreachable one: one is enough to fail the frozen head.
   */
  async unreachablePulls(req: ListChangesRequest, head: string, candidates: readonly ChangeRecord[]): Promise<string[]> {
    const out: string[] = [];
    for (const c of [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 10)) {
      req.signal?.throwIfAborted();
      let status: string;
      try {
        status = (await this.http.rest<{ status: string }>(`/repos/${req.repo}/compare/${c.mergeSha}...${head}?per_page=1`)).data.status;
      } catch (e) {
        if (e instanceof GitHubHttpError && (e.status === 404 || e.status === 422)) continue; // GitHub cannot compare them: unknown, so not reported
        throw e;
      }
      if (status === "behind" || status === "diverged") out.push(c.id);
      if (out.length >= 3) break;
    }
    return out;
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
        // A PR with more than 50 labels: read the rest. A cap that dropped a label would change who the selector matches.
        const labels = [...pr.labels.nodes];
        let lp = pr.labels.pageInfo;
        while (lp?.hasNextPage) {
          const more = await this.http.graphql<{ repository: { pullRequest: { labels: { pageInfo: NonNullable<typeof lp>; nodes: { name: string }[] } } } }>(MORE_LABELS_QUERY, { owner, name, number: n, after: lp.endCursor });
          labels.push(...more.repository.pullRequest.labels.nodes);
          lp = more.repository.pullRequest.labels.pageInfo;
        }
        out.push(normalizePullRequest(`${owner}/${name}`, labels.length === pr.labels.nodes.length ? pr : { ...pr, labels: { ...pr.labels, nodes: labels } }, extra));
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
    // The history page caps each commit at two parents and five PRs; read the rest of any commit that has more.
    for (const c of nodes.values()) await this.completeCommit(owner, name, c);
    const toNode = (c: GqlHistoryCommit): HistoryNode => ({
      oid: c.oid,
      committedDate: c.committedDate,
      parents: c.parents.nodes.map((p) => p.oid),
      associatedPullRequests: c.associatedPullRequests.nodes,
    });
    const result = classifyHistory([...nodes.values()].map(toNode), req.window, defaultBranch, mergeCommits);
    const parents = new Map([...nodes.values()].map((c) => [c.oid, c.parents.nodes.map((p) => p.oid)]));
    return {
      /** Every commit the walk reached (reachable from the head, dated since the window opened), lowercase. */
      visited: new Set([...nodes.keys()].map((o) => o.toLowerCase())),
      landedVia: landedViaMerges(parents, result.directPushes),
      directPushes: result.directPushes.map((oid) => nodes.get(oid)!),
      linkedPrs: [...result.prCommits.values()].reduce((a, v) => a + v.length, 0),
      inWindow: result.inWindow,
      merges: result.directPushMerges.length,
    };
  }

  /**
   * Fills in a commit whose parents or associated PRs the history page truncated. More than 100
   * parents is refused (git allows it; no real history has it): an unread parent could make a
   * commit look like a direct push or hide a merge's second side.
   */
  async completeCommit(owner: string, name: string, c: GqlHistoryCommit): Promise<void> {
    const total = c.parents.totalCount;
    if (total !== undefined && total > c.parents.nodes.length) {
      if (total > 100) throw new Error(`github: commit ${c.oid} has ${total} parents; pr-rla reads at most 100 and will not classify it from a truncated list`);
      const r = await this.http.graphql<{ repository: { object: { parents: { totalCount: number; nodes: { oid: string }[] } } | null } }>(COMMIT_PARENTS_QUERY, { owner, name, oid: c.oid });
      const full = r.repository.object?.parents;
      if (!full || full.nodes.length < total) throw new Error(`github: could not read all ${total} parents of commit ${c.oid}`);
      c.parents = { totalCount: full.totalCount, nodes: full.nodes };
    }
    type PrNode = { number: number; merged: boolean; baseRefName: string };
    type More = { repository: { object: { associatedPullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: PrNode[] } } | null } };
    let page = c.associatedPullRequests.pageInfo;
    if (page?.hasNextPage) {
      const all = [...c.associatedPullRequests.nodes];
      while (page?.hasNextPage) {
        const r: More = await this.http.graphql<More>(COMMIT_PRS_QUERY, { owner, name, oid: c.oid, after: page.endCursor });
        const more = r.repository.object?.associatedPullRequests;
        if (!more) throw new Error(`github: could not read the PRs of commit ${c.oid}`);
        all.push(...more.nodes);
        page = more.pageInfo;
      }
      c.associatedPullRequests = { ...c.associatedPullRequests, nodes: all, pageInfo: { hasNextPage: false, endCursor: null } };
    }
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

  /** True when `owner` is the account the token belongs to (`GET /user`); false without a token, or for a token that cannot read /user. */
  private async ownAccount(owner: string): Promise<boolean> {
    if (!this.http.authenticated) return false;
    try {
      const { data } = await this.http.rest<{ login: string }>("/user");
      return data.login.toLowerCase() === owner.toLowerCase();
    } catch (e) {
      // A GitHub App installation token (GITHUB_TOKEN in Actions) is not a user: it cannot read /user.
      if (e instanceof GitHubHttpError && (e.status === 401 || e.status === 403 || e.status === 404)) return false;
      throw e;
    }
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
    if (this.http.tokenKind === "unknown") return none("pr-rla holds only a placeholder for the token and was not told its kind (classic, OAuth App, fine-grained), which decides what its listing can prove");
    let user: { data: { login: string }; headers: Headers };
    try {
      user = await this.http.rest<{ login: string }>("/user");
    } catch (e) {
      if (e instanceof GitHubHttpError && (e.status === 401 || e.status === 403 || e.status === 404)) {
        // A GitHub App installation token (GITHUB_TOKEN in Actions) is not a user (P3): it proves itself by its installation.
        const app = await this.installationProof(set);
        if (app) return { identity: app.identity, visibilities: { public: publicProof, private: app.proof, internal: app.proof } };
        return none(`the token cannot read /user (HTTP ${e.status}), as a GitHub App installation token (GITHUB_TOKEN in Actions) cannot, and GitHub does not say it was installed on every repository of ${set.owner} (GET /installation/repositories: repository_selection "all"): it sees only the repositories it was granted`);
      }
      throw e;
    }
    identity = user.data.login;
    const scopes = user.headers.get("x-oauth-scopes");
    if (scopes === null) return none("the token sends no X-OAuth-Scopes header, so it is a fine-grained personal access token or a GitHub App token: it shows only the repositories it was granted, and GitHub has no API that says it was granted all of them");
    const list = scopes.split(",").map((x) => x.trim()).filter(Boolean);
    if (!list.includes("repo")) return none(`the classic token's scopes (${list.join(", ") || "none"}) do not include repo, so GitHub shows it no private repository`);
    let isOrg = true;
    let org: { total_private_repos?: unknown } = {};
    try {
      org = (await this.http.rest<{ total_private_repos?: unknown }>(`/orgs/${encodeURIComponent(set.owner)}`)).data ?? {};
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
      // P3: the org's own count of its private repositories (GitHub sends it to an owner whose token has admin:org),
      // which the core holds the listing to. An OAuth App token (gho_, as the gh CLI's) is subject to the org's OAuth
      // App access restrictions, which hide private repositories with no response saying so: it needs the count.
      const total = typeof org.total_private_repos === "number" && Number.isFinite(org.total_private_repos) ? org.total_private_repos : null;
      const expected = total === null ? undefined : [{ visibilities: ["private", "internal"] as RepoVisibility[], count: total, source: `GitHub's total_private_repos for ${set.owner}` }];
      if (this.http.tokenKind === "oauth-app" && total === null)
        return none(`${identity} is an owner of ${set.owner}, but the token is an OAuth App token (gho_), which the org's OAuth App access restrictions can limit to public repositories with no response saying so, and GitHub did not send the org's total_private_repos to check the listing against (it needs the admin:org scope); use a classic token, or add admin:org`);
      const owner = { complete: true, reason: `${identity} is an owner (admin) of ${set.owner}, with a ${this.http.tokenKind === "oauth-app" ? "OAuth App" : "classic"} token holding the repo scope: GitHub shows org owners every repository of the org${total === null ? "" : `, and the listing is held to the org's total_private_repos (${total})`}` };
      return { identity, visibilities: { public: publicProof, private: owner, internal: owner }, ...(expected ? { expected } : {}) };
    }
    return none(`${identity} is ${m.state === "active" ? `a ${m.role ?? "member"}` : `a ${m.state ?? "non-active"} member`} of ${set.owner}, not an owner: GitHub shows a member only the private repositories they were granted, so only an owner's listing is complete`);
  }

  /**
   * A GitHub App installation token's proof (P3): `GET /installation/repositories` says `repository_selection: "all"`
   * (the app was installed on every repository of its account, present and future) and its repositories are the
   * owner's. Null when it says anything else, or cannot be read.
   */
  private async installationProof(set: RepoSetRule): Promise<{ identity: string; proof: { complete: true; reason: string } } | null> {
    let data: { total_count?: number; repository_selection?: string; repositories?: { owner?: { login?: string } }[] };
    try {
      data = (await this.http.rest<typeof data>("/installation/repositories?per_page=1")).data;
    } catch (e) {
      if (e instanceof GitHubHttpError && e.status !== GAVE_UP) return null;
      throw e;
    }
    const account = data.repositories?.[0]?.owner?.login;
    if (data.repository_selection !== "all") return null;
    if ((data.total_count ?? 0) > 0 && (typeof account !== "string" || account.toLowerCase() !== set.owner.toLowerCase())) return null;
    return { identity: `github-app-installation@${set.owner}`, proof: { complete: true, reason: `a GitHub App installation on ${set.owner} with access to all of its repositories (GET /installation/repositories: repository_selection "all")` } };
  }

  /**
   * The default branch's push log (P3): `GET /repos/{owner}/{repo}/activity?ref=refs/heads/<branch>`, newest first,
   * paged by the Link header, until an update at or before `since` (at most MAX_ACTIVITY_PAGES pages). API version
   * 2022-11-28 gives `id`, `before`, `after`, `ref`, `timestamp` and `activity_type` (push, force_push,
   * branch_creation, branch_deletion, pr_merge, merge_queue_merge); GitHub records each update when it happens. Works
   * without a token on a public repository; a fine-grained token needs Contents read.
   */
  async pushLog(req: PushLogRequest): Promise<PushLog> {
    const since = Date.parse(req.since);
    const want = `refs/heads/${req.branch}`;
    let url: string | null = `/repos/${req.repo}/activity?ref=${encodeURIComponent(want)}&direction=desc&per_page=${this.pageSize}`;
    const events: PushLogEvent[] = [];
    for (let pages = 0; url && pages < MAX_ACTIVITY_PAGES; pages++) {
      req.signal?.throwIfAborted();
      const page: { data: RestActivity[]; next: string | null } = await this.http.rest<RestActivity[]>(url);
      if (!Array.isArray(page.data)) throw new GitHubHttpError(`GitHub GET /repos/${req.repo}/activity: not a list`, 200);
      let reached = false;
      for (const a of page.data) {
        if (a.ref !== undefined && a.ref !== want) continue;
        const t = Date.parse(a.timestamp ?? "");
        events.push({
          id: String(a.id),
          before: (a.before ?? "").toLowerCase(),
          after: (a.after ?? "").toLowerCase(),
          at: Number.isFinite(t) ? new Date(t).toISOString().replace(".000Z", "Z") : String(a.timestamp),
          kind: ACTIVITY_KIND[a.activity_type ?? ""] ?? "unknown",
        });
        if (Number.isFinite(t) && t <= since) reached = true;
      }
      if (reached) break;
      url = page.next;
    }
    return { events, limitations: [GITHUB_PUSH_LOG_LIMITATION] };
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
    // The pages are a server's answer (with base_url, any server's), so every figure taken from them is bounded (S1):
    // an entry whose time does not parse is not used, and a page's density is at most one page per second, since
    // GitHub's times count to the second (a page whose times spanned 0 ms was projected at 100 per millisecond across
    // the whole window); a figure that is still not finite is not used.
    const url = (page: number) => `/repos/${req.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${this.pageSize}${page > 1 ? `&page=${page}` : ""}`;
    const pulls = (data: unknown): RestPull[] => (Array.isArray(data) ? data.filter((x): x is RestPull => !!x && typeof x === "object" && Number.isFinite(Date.parse((x as RestPull).updated_at))) : []);
    const a = await this.http.rest<RestPull[]>(url(1));
    const first = pulls(a.data);
    probed++;
    const span = (p: RestPull[]) => Math.max(1000, Date.parse(p[0]!.updated_at) - Date.parse(p.at(-1)!.updated_at));
    const intoWindow = (p: readonly RestPull[]) => p.filter((x) => x.merged_at && x.base?.ref === ref.name && Date.parse(x.merged_at) >= opens && Date.parse(x.merged_at) < closes).length;
    const atMost = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : first.length);
    let updatedSinceOpens: number;
    let merged: number;
    let pullPages: number | null = null;
    if (first.length === 0 || !a.next || Date.parse(first.at(-1)!.updated_at) < opens) {
      // The whole list since the window opened is on this page: exact.
      updatedSinceOpens = first.filter((x) => Date.parse(x.updated_at) >= opens).length;
      merged = intoWindow(first);
      pullPages = 1;
    } else {
      // Density from the newest page projects the length; a page from the middle gives the density there and what share merged in the window.
      const dA = first.length / span(first);
      const firstProjection = atMost(first.length + dA * (Date.parse(first.at(-1)!.updated_at) - opens));
      const middle = Math.floor(firstProjection / this.pageSize / 2) + 1;
      let b: RestPull[] | null = null;
      if (middle > 1) {
        b = pulls((await this.http.rest<RestPull[]>(url(middle))).data);
        probed++;
      }
      if (b && b.length > 0) {
        const dB = b.length / span(b);
        updatedSinceOpens = atMost(first.length + dB * Math.max(0, Date.parse(first.at(-1)!.updated_at) - opens));
        merged = updatedSinceOpens * (intoWindow(b) / b.length);
      } else {
        updatedSinceOpens = firstProjection;
        merged = updatedSinceOpens * (intoWindow(first) / first.length);
      }
    }
    // The newest page is read once more (the re-scan for PRs updated during the walk).
    const restPages = (pullPages ?? Math.max(2, Math.ceil(updatedSinceOpens / this.pageSize))) + 1;
    let graphql = 1;
    graphql += wantPrs ? Math.ceil(merged / this.batchSize) : 0;
    // P5: a labels stratum reads one page of issue events per pull request.
    const labelPages = wantPrs && req.labelsAt === "landing" ? Math.round(merged) : 0;

    if (wantPushes) {
      type Page = { repository: { object: { history: { pageInfo: { hasNextPage: boolean }; nodes: { committedDate: string }[] } } | null } };
      const h = await this.http.graphql<Page>(historyQuery(this.historyPageSize), { owner, name, head: headOid, since: req.window.opensAt, after: null });
      probed++;
      const nodes = Array.isArray(h.repository?.object?.history?.nodes) ? h.repository.object!.history.nodes : [];
      let commits = nodes.length;
      // Commit times count to the second (GitHub's committedDate has no fractions): a page's density is at most one
      // page per second, whatever times a server sends.
      const dates = nodes.map((x) => Date.parse(x?.committedDate)).filter((t) => Number.isFinite(t)).sort((x, y) => y - x);
      if (h.repository?.object?.history?.pageInfo?.hasNextPage && dates.length > 1) {
        const density = dates.length / Math.max(1000, dates[0]! - dates.at(-1)!);
        commits = nodes.length + density * Math.max(0, dates.at(-1)! - opens);
      }
      graphql += Math.max(1, Math.ceil(commits / this.historyPageSize));
    }
    return { requests: Math.round(restPages + labelPages + graphql), graphql: Math.round(graphql), probed };
  }

  /**
   * P5: each login's stable account id, `GET /users/{login}` (`id`; GraphQL's `databaseId` for the same account, which
   * `Actor.id` carries). A bot is looked up by its `[bot]` login, as GitHub names bot users. 404: no such account.
   */
  async resolveAccounts(logins: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<AccountLookup[]> {
    const out: AccountLookup[] = [];
    for (const login of logins) {
      opts.signal?.throwIfAborted();
      try {
        const { data } = await this.http.rest<{ login?: string; id?: unknown }>(`/users/${encodeURIComponent(login)}`);
        out.push(typeof data?.id === "number" && Number.isSafeInteger(data.id) ? { login, id: String(data.id) } : { login, id: null, detail: `GitHub's /users/${login} sent no account id` });
      } catch (e) {
        if (e instanceof GitHubHttpError && e.status === 404) out.push({ login, id: null, detail: `GitHub has no account ${login} (HTTP 404 on /users/${login})` });
        else throw e;
      }
    }
    return out;
  }

  /** What a reviewer reads for one drawn change (U5): see ./describe.ts. */
  describeChange(change: ChangeRecord, opts?: DescribeChangeOptions): Promise<ChangeDescription> {
    return describeGitHubChange(this.http, change, opts);
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
  labelHistory: true,
  create: (options, ctx) => new GitHubProvider(options ?? {}, ctx),
});
