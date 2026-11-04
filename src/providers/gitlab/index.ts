import {
  PROVIDER_API_VERSION,
  defineProvider,
  type Actor,
  type ChangeDescription,
  type ChangeRecord,
  type ListChangesRequest,
  type ListChangesResult,
  type ProviderContext,
  type ScmProvider,
  type DescribeChangeOptions,
} from "../../sdk/provider.js";
import { describeGitLabChange } from "./describe.js";
import { attributeCommits } from "../attribution.js";
import { LANDED_VIA_LIMITATION, landedViaMerges } from "../landed-via.js";
import { HttpClient, HttpError, isoUtcSeconds, nextLink } from "../http.js";
import {
  buildReviews,
  countDiffLines,
  normalizeDirectPush,
  normalizeMergeRequest,
  normalizeUser,
  userId,
  type GlApprovals,
  type GlCommit,
  type GlMergeRequest,
  type GlNote,
  type GlReviewer,
  type GlUser,
} from "./normalize.js";
import { MORE_NOTES_QUERY, MR_BATCH_QUERY, type GqlMergeRequest, type GqlNotesPage } from "./queries.js";

export interface GitLabProviderOptions {
  /** Instance root for self-managed GitLab, e.g. `https://gitlab.example.com` (default `https://gitlab.com`). */
  base_url?: string;
  /** Env var holding a token with read_api (default GITLAB_TOKEN). Public projects need none. */
  token_env?: string;
  /** REST page size (max 100). */
  page_size?: number;
  /** MRs per GraphQL query (default 20). */
  batch_size?: number;
  /**
   * Hours before the window opens to start listing MRs by update time (default 24).
   * GitLab can stamp `merged_at` a few seconds after `updated_at` (seen on gitlab-org/cli !4285).
   */
  listing_slack_hours?: number;
}

export const GITLAB_LIMITATIONS = [
  "direct_push: GitLab's commit API does not link commits to accounts or expose the pusher; `author` is the git author (commit author != pusher) and mergedBy is null.",
  "direct_push: the window is applied to the commit's committed_date, not the push time.",
  "direct_push: every commit reachable from the default branch (all parents), dated in the window, that no merged MR into that branch brought in (its merge or squash commit, its listed commits, or GitLab's commit->MR link). A direct-push merge commit's changedLines are GitLab's stats against its first parent.",
  "pull_request: only MRs merged into the default branch count; changedLines are GitLab's MR diff stats (additions + deletions), not changes_count (which counts files).",
  "pull_request: review events come from approval and review system notes; a reviewer state with no note (older instances) is dated at the review request.",
  "bots: GitLab's bot flag and access-token/service-account usernames; a bot that runs as a regular user account (bot: false) is counted as human.",
];

const enc = (s: string) => encodeURIComponent(s);
const TRANSIENT_GRAPHQL = /timeout|timed out|internal server error|try again|too many requests|rate limit/i;

export class GitLabProvider implements ScmProvider {
  readonly apiVersion = PROVIDER_API_VERSION;
  readonly name = "gitlab";
  readonly http: HttpClient;
  readonly graphqlUrl: string;
  private readonly pageSize: number;
  private readonly batchSize: number;
  private readonly slackMs: number;

  constructor(opts: GitLabProviderOptions, private readonly ctx: ProviderContext & { now?: () => number }) {
    const base = (opts.base_url ?? "https://gitlab.com").replace(/\/+$/, "").replace(/\/api\/v4$/, "");
    const token = ctx.env[opts.token_env ?? "GITLAB_TOKEN"];
    this.http = new HttpClient({
      provider: "gitlab",
      baseUrl: `${base}/api/v4`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      fetch: ctx.fetch,
      log: ctx.log,
      maxRetries: 0, // ctx.fetch is the fetch broker, the only retrier (contracts.md §2)
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      rateLimitHint: `Unauthenticated gitlab.com API access is limited per IP; set ${opts.token_env ?? "GITLAB_TOKEN"} to a token with read_api.`,
    });
    this.graphqlUrl = `${base}/api/graphql`;
    this.pageSize = Math.min(100, opts.page_size ?? 100);
    this.batchSize = opts.batch_size ?? 20;
    this.slackMs = (opts.listing_slack_hours ?? 24) * 3_600_000;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    type G = { data?: T; errors?: { message: string }[] };
    const { data } = await this.http.request<G>(this.graphqlUrl, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
      ...(signal ? { signal } : {}),
      accept: (b) => {
        const errs = (b as G).errors ?? [];
        return errs.length && errs.every((e) => TRANSIENT_GRAPHQL.test(e.message)) ? `GraphQL: ${errs[0]!.message}` : null;
      },
    });
    if (data.errors?.length) throw new HttpError(`gitlab GraphQL: ${data.errors.map((e) => e.message).join("; ")}`, 200, this.graphqlUrl);
    if (!data.data) throw new HttpError("gitlab GraphQL: empty response", 200, this.graphqlUrl);
    return data.data;
  }

  private async paged<T>(first: string, signal?: AbortSignal, each?: (page: T[]) => boolean | void): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = first;
    while (url) {
      signal?.throwIfAborted();
      const { data, headers }: { data: T[]; headers: Headers } = await this.http.get<T[]>(url, signal);
      out.push(...data);
      if (each?.(data) === false) break;
      url = nextLink(headers);
    }
    return out;
  }

  /** What a reviewer reads for one drawn change (U5): see ./describe.ts. */
  describeChange(change: ChangeRecord, opts?: DescribeChangeOptions): Promise<ChangeDescription> {
    return describeGitLabChange(this.http, change, opts);
  }

  async listChanges(req: ListChangesRequest): Promise<ListChangesResult> {
    const { data: project } = await this.http.get<{ id: number; default_branch: string | null }>(`/projects/${enc(req.repo)}`, req.signal);
    const branch = project.default_branch;
    if (!branch) throw new Error(`gitlab: ${req.repo} has no default branch`);
    const pid = project.id;
    const opens = Date.parse(req.window.opensAt);
    const closes = Date.parse(req.window.closesAt);
    const listed = await this.listMergedMrs(pid, opens, req.signal);
    // MRs into the default branch merged since the window opened, including after it closed: their commits can be dated inside it.
    const intoDefault = [...listed.values()].filter((m) => m.target_branch === branch && m.merged_at && Date.parse(m.merged_at) >= opens).sort((a, b) => a.iid - b.iid);
    const inWindow = intoDefault.filter((m) => Date.parse(m.merged_at!) < closes);
    const otherBase = [...listed.values()].filter((m) => m.target_branch !== branch && m.merged_at && Date.parse(m.merged_at) >= opens && Date.parse(m.merged_at) < closes).length;

    const changes: ChangeRecord[] = [];
    const diagnostics: { label: string; value: number }[] = [];
    if (req.kinds.includes("pull_request")) {
      diagnostics.push({ label: "MRs merged into other branches in window (excluded)", value: otherBase });
      changes.push(...(await this.mergeRequestRecords(pid, req.repo, inWindow, req.signal)));
    }
    let headSha = req.head?.toLowerCase();
    let viaMerge = false;
    if (req.kinds.includes("direct_push")) {
      const walk = await this.directPushes(pid, req, branch, intoDefault);
      headSha = walk.head;
      viaMerge = walk.landedVia.size > 0;
      changes.push(...walk.pushes.map((c) => normalizeDirectPush(req.repo, c, walk.landedVia.get(c.id)?.toLowerCase())));
      diagnostics.push(
        { label: "default-branch commits in window", value: walk.inWindow },
        { label: "commits linked to a merged MR", value: walk.linked },
        { label: "commits linked only through GitLab's commit->MR lookup", value: walk.linkedByLookup },
        { label: "direct pushes that are merge commits", value: walk.pushes.filter((c) => c.parent_ids.length > 1).length },
      );
    }
    return { changes, defaultBranch: branch, limitations: viaMerge ? [...GITLAB_LIMITATIONS, LANDED_VIA_LIMITATION] : GITLAB_LIMITATIONS, diagnostics, ...(headSha ? { headSha } : {}) };
  }

  /**
   * Merged MRs updated since (window open - slack), newest update first, then the
   * head of the list again: offset pages over a list sorted by update time can
   * skip an MR updated mid-walk, and such an MR jumps to the head.
   */
  async listMergedMrs(pid: number, opens: number, signal?: AbortSignal): Promise<Map<number, GlMergeRequest>> {
    const now = this.ctx.now ?? Date.now;
    const byIid = new Map<number, GlMergeRequest>();
    const walk = async (updatedAfterMs: number) => {
      const first = `/projects/${pid}/merge_requests?state=merged&scope=all&order_by=updated_at&sort=desc&per_page=${this.pageSize}&updated_after=${enc(isoUtcSeconds(updatedAfterMs))}`;
      let pages = 0;
      await this.paged<GlMergeRequest>(first, signal, (page) => {
        for (const mr of page) byIid.set(mr.iid, mr);
        if (++pages % 20 === 0) this.ctx.log(`gitlab: listed ${pages} pages of merged MRs`);
        const last = page[page.length - 1];
        return !!last && Date.parse(last.updated_at) >= updatedAfterMs;
      });
    };
    const walkStart = now();
    await walk(opens - this.slackMs);
    await walk(walkStart - 60_000);
    return byIid;
  }

  async mergeRequestRecords(pid: number, repo: string, mrs: readonly GlMergeRequest[], signal?: AbortSignal): Promise<ChangeRecord[]> {
    const details = new Map<string, GqlMergeRequest>();
    for (let i = 0; i < mrs.length; i += this.batchSize) {
      const iids = mrs.slice(i, i + this.batchSize).map((m) => String(m.iid));
      const data = await this.graphql<{ project: { mergeRequests: { nodes: GqlMergeRequest[] } } | null }>(MR_BATCH_QUERY, { path: repo, iids, first: iids.length }, signal);
      for (const n of data.project?.mergeRequests.nodes ?? []) {
        let page = n.notes.pageInfo;
        while (page.hasNextPage) {
          const more = await this.graphql<{ project: { mergeRequest: { notes: GqlNotesPage } } }>(MORE_NOTES_QUERY, { path: repo, iid: n.iid, after: page.endCursor }, signal);
          n.notes.nodes.push(...more.project.mergeRequest.notes.nodes);
          page = more.project.mergeRequest.notes.pageInfo;
        }
        details.set(n.iid, n);
      }
      if ((i / this.batchSize) % 10 === 9) this.ctx.log(`gitlab: read ${Math.min(i + this.batchSize, mrs.length)}/${mrs.length} MRs`);
    }
    const out: ChangeRecord[] = [];
    for (const mr of mrs) {
      const d = details.get(String(mr.iid));
      if (!d) throw new Error(`gitlab: MR !${mr.iid} missing from the GraphQL response`);
      const { data: approvals } = await this.http.get<GlApprovals>(`/projects/${pid}/merge_requests/${mr.iid}/approvals`, signal);
      const { data: reviewers } = await this.http.get<GlReviewer[]>(`/projects/${pid}/merge_requests/${mr.iid}/reviewers`, signal);
      const bots = new Map<string, boolean>();
      const ids = new Map<string, string>();
      const note = (u: { username: string; bot: boolean } | null) => u && bots.set(u.username, bots.get(u.username) === true || u.bot);
      [d.author, d.mergeUser, ...d.approvedBy.nodes, ...d.reviewers.nodes, ...d.notes.nodes.map((x) => x.author)].forEach(note);
      // Account ids (Actor.id, U3): GraphQL has one on every user, REST on its user objects.
      for (const u of [d.author, d.mergeUser, ...d.approvedBy.nodes, ...d.reviewers.nodes, ...d.notes.nodes.map((x) => x.author), mr.author, mr.merge_user, mr.merged_by, ...approvals.approved_by.map((a) => a.user), ...reviewers.map((r) => r.user)]) {
        const id = userId(u);
        if (u && id !== undefined && !ids.has(u.username)) ids.set(u.username, id);
      }
      const actor = (u: GlUser | null): Actor => normalizeUser(u, bots, ids);
      const reviews = buildReviews({ mrAuthor: mr.author?.username ?? null, notes: d.notes.nodes as GlNote[], approvals, reviewers, mergedAt: mr.merged_at!, actor });
      const lines = d.diffStatsSummary ? d.diffStatsSummary.additions + d.diffStatsSummary.deletions : await this.diffLines(pid, mr.iid, signal);
      out.push(normalizeMergeRequest(repo, mr, reviews, lines, actor));
    }
    return out;
  }

  /** Fallback when GraphQL has no diff stats: count +/- lines of the MR's diffs. */
  private async diffLines(pid: number, iid: number, signal?: AbortSignal): Promise<number> {
    const diffs = await this.paged<{ diff: string }>(`/projects/${pid}/merge_requests/${iid}/diffs?per_page=${this.pageSize}`, signal);
    return diffs.reduce((n, d) => n + countDiffLines(d.diff), 0);
  }

  async directPushes(pid: number, req: ListChangesRequest, branch: string, intoDefault: readonly GlMergeRequest[]) {
    // Merge and squash commits are claimed from the listing; a commit list is read only for unsquashed MRs
    // (merge commit, fast-forward, rebase: the MR's own commits land), and only while commits are unclaimed.
    const known = new Map<string, number>();
    for (const mr of intoDefault) {
      for (const s of [mr.merge_commit_sha, mr.squash_commit_sha, mr.squash_commit_sha ? null : mr.sha]) if (s && !known.has(s.toLowerCase())) known.set(s.toLowerCase(), mr.iid);
    }
    // Pin the head so pushes during the walk cannot shift the pages; verify passes the frozen head (U3).
    const headSha = req.head ?? (await this.http.get<{ commit: { id: string } }>(`/projects/${pid}/repository/branches/${enc(branch)}`, req.signal)).data.commit.id;
    const opens = Date.parse(req.window.opensAt);
    const closes = Date.parse(req.window.closesAt);
    const history = await this.paged<GlCommit>(
      `/projects/${pid}/repository/commits?ref_name=${headSha}&since=${enc(req.window.opensAt)}&until=${enc(req.window.closesAt)}&with_stats=true&per_page=${this.pageSize}`,
      req.signal,
    );
    const seen = new Set<string>();
    const inWindow = history.filter((c) => {
      const t = Date.parse(c.committed_date);
      if (seen.has(c.id) || t < opens || t >= closes) return false;
      seen.add(c.id);
      return true;
    });
    const unsquashed = intoDefault.filter((m) => !m.squash_commit_sha).sort((a, b) => Date.parse(a.merged_at!) - Date.parse(b.merged_at!) || a.iid - b.iid);
    const res = await attributeCommits({
      commits: inWindow,
      sha: (c) => c.id,
      known,
      prs: unsquashed.map((m) => m.iid),
      readCommits: async (iid) => (await this.paged<{ id: string }>(`/projects/${pid}/merge_requests/${iid}/commits?per_page=${this.pageSize}`, req.signal)).map((c) => ({ sha: c.id })),
    });
    // Last resort: GitLab's own commit -> MR index.
    const pushes: GlCommit[] = [];
    let linkedByLookup = 0;
    for (const c of res.pushes) {
      const { data: mrs } = await this.http.get<{ iid: number; state: string; target_branch: string }[]>(`/projects/${pid}/repository/commits/${c.id}/merge_requests`, req.signal);
      if (mrs.some((m) => m.state === "merged" && m.target_branch === branch)) linkedByLookup++;
      else pushes.push(c);
    }
    const landedVia = landedViaMerges(new Map(history.map((c) => [c.id, c.parent_ids])), pushes.map((c) => c.id));
    return { pushes, inWindow: inWindow.length, linked: res.linked + linkedByLookup, linkedByLookup, head: headSha.toLowerCase(), landedVia };
  }
}

export default defineProvider<GitLabProviderOptions>({
  providerApiVersion: PROVIDER_API_VERSION,
  name: "gitlab",
  description: "gitlab.com / self-managed GitLab: REST merge requests, approvals and commits + GraphQL review notes, bot flags and diff stats",
  hosts: (options) => [new URL((options?.base_url ?? "https://gitlab.com").replace(/\/+$/, "")).host],
  // Comments become one COMMENTED per non-author user, at their first note; approvals are events.
  reviewGranularity: "first-comment-per-user",
  populationOptions: ["base_url", "listing_slack_hours"],
  reportsLandedVia: true,
  create: (options, ctx) => new GitLabProvider(options ?? {}, ctx),
});
