import {
  NO_COMMIT,
  PROVIDER_API_VERSION,
  RepoEmptyError,
  RepoUnavailableError,
  defineProvider,
  type Actor,
  type ChangeDescription,
  type ChangeRecord,
  type ListChangesRequest,
  type ListChangesResult,
  type ProviderContext,
  type FirstParentCommit,
  type PushLog,
  type PushLogEvent,
  type PushLogRequest,
  type RepoRef,
  type RepoSetRule,
  type RepoVisibility,
  type ScmProvider,
  type DescribeChangeOptions,
  type AccountLookup,
} from "../../sdk/provider.js";
import { firstParentChain } from "../first-parent.js";
import { describeGitLabChange } from "./describe.js";
import { attributeCommits } from "../attribution.js";
import { LANDED_VIA_LIMITATION, landedViaMerges } from "../landed-via.js";
import { HttpClient, HttpError, isoUtcSeconds, nextLink } from "../http.js";
import {
  BOT_SUFFIX,
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
import { MORE_APPROVERS_QUERY, MORE_NOTES_QUERY, MORE_REVIEWERS_QUERY, MR_BATCH_QUERY, type GqlMergeRequest, type GqlNotesPage, type GqlUsersPage } from "./queries.js";

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
  "pull_request: review events come from approval and review system notes, read by GitLab's own note tag (systemNoteMetadata.action) and only for an untagged note by its English text; an approval reset still learns WHOSE approvals it reset from the @references in the note body; a reviewer state with no note (older instances) is dated at the review request.",
  "bots: GitLab's bot flag and access-token/service-account usernames; a bot that runs as a regular user account (bot: false) is counted as human.",
];

const enc = (s: string) => encodeURIComponent(s);
const TRANSIENT_GRAPHQL = /timeout|timed out|internal server error|try again|too many requests|rate limit/i;

/** One entry of `GET /projects/:id/events?action=pushed` (push events only carry `push_data`). */
interface GlPushEvent {
  id: number;
  created_at: string;
  push_data?: { action?: string; ref_type?: string; ref?: string | null; commit_from?: string | null; commit_to?: string | null; commit_count?: number } | null;
}

/** At most this many pages of a project's push events (100 each) are read for one push log. */
export const MAX_EVENT_PAGES = 100;

export const GITLAB_PUSH_LOG_LIMITATION =
  "push log: GitLab's project push events (GET /projects/:id/events?action=pushed); GitLab removes project events older than three years, and does not say whether a push was forced. A bulk push (more refs at once than the instance's push event activities limit) is recorded without its refs and commits.";

interface GlProject {
  id: number;
  path_with_namespace: string;
  default_branch?: string | null;
  archived?: boolean;
  forked_from_project?: unknown;
  visibility?: string;
  created_at?: string | null;
}

/** A GitLab project as a RepoRef. */
function projectRef(p: GlProject): RepoRef {
  const created = p.created_at ? Date.parse(p.created_at) : NaN;
  return {
    repo: p.path_with_namespace,
    id: String(p.id),
    defaultBranch: p.default_branch ?? "",
    archived: p.archived === true,
    fork: p.forked_from_project !== undefined && p.forked_from_project !== null,
    visibility: (p.visibility === "public" || p.visibility === "internal" ? p.visibility : "private") satisfies RepoVisibility,
    ...(Number.isFinite(created) ? { createdAt: new Date(created).toISOString().replace(".000Z", "Z") } : {}),
  };
}

export class GitLabProvider implements ScmProvider {
  readonly apiVersion = PROVIDER_API_VERSION;
  readonly name = "gitlab";
  readonly http: HttpClient;
  readonly graphqlUrl: string;
  private readonly pageSize: number;
  private readonly batchSize: number;
  private readonly slackMs: number;
  /** MRs whose size GitLab would not give (diff excluded), and approval-reset notes that named nobody: reported as diagnostics. */
  private unknownSize = 0;
  private unreadableResets = 0;

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

  /**
   * The projects under a group, subgroups included (U8): `GET /groups/:path/projects`. A personal namespace answers
   * 404 there, so the user's own projects are read instead. A GitLab fork carries `forked_from_project`.
   */
  async listRepos(set: RepoSetRule): Promise<RepoRef[]> {
    const q = `per_page=${this.pageSize}&order_by=path&sort=asc`;
    const groups = `/groups/${enc(set.owner)}/projects?include_subgroups=true&with_shared=false&${q}`;
    let projects: GlProject[];
    try {
      projects = await this.paged<GlProject>(groups);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
      projects = await this.paged<GlProject>(`/users/${enc(set.owner)}/projects?${q}`);
    }
    return projects.map(projectRef);
  }

  /**
   * One project's metadata (U8): `GET /projects/:id` by its numeric id where known (it survives a rename or a
   * transfer), else by its path. GitLab answers 404 for a project that does not exist and for a private one the token
   * cannot see; that is a RepoUnavailableError(404).
   */
  /**
   * P5: each login's stable user id, `GET /users?username=<login>` (`id`, as `Actor.id` carries it); a bot's `[bot]`
   * suffix, which pr-rla adds, is dropped for the lookup. No user of that username: null.
   */
  async resolveAccounts(logins: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<AccountLookup[]> {
    const out: AccountLookup[] = [];
    for (const login of logins) {
      const name = login.endsWith(BOT_SUFFIX) ? login.slice(0, -BOT_SUFFIX.length) : login;
      const { data } = await this.http.get<{ id?: unknown; username?: string }[]>(`/users?username=${encodeURIComponent(name)}`, opts.signal);
      const u = Array.isArray(data) ? data.find((x) => typeof x?.username === "string" && x.username.toLowerCase() === name.toLowerCase()) : undefined;
      const id = u ? userId({ id: u.id as GlUser["id"] }) : undefined;
      out.push(id !== undefined ? { login, id } : { login, id: null, detail: `GitLab has no user ${name} (GET /users?username=${name} listed none)` });
    }
    return out;
  }

  async describeRepo(ref: { repo: string; id?: string }): Promise<RepoRef> {
    try {
      return projectRef((await this.http.get<GlProject>(`/projects/${ref.id ? enc(ref.id) : enc(ref.repo)}`)).data);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new RepoUnavailableError(ref.repo, 404, e.message);
      throw e;
    }
  }

  /**
   * The default branch's first-parent commits from `head` back to `base` (U8): `GET /projects/:id/repository/commits`
   * with the revision range `base..head` and `first_parent=true`, newest first. Null when `base` is not on the chain.
   */
  async firstParentPath(req: { repo: string; base: string; head: string; signal?: AbortSignal }): Promise<FirstParentCommit[] | null> {
    if (req.base.toLowerCase() === req.head.toLowerCase()) return [];
    const commits = await this.paged<GlCommit>(`/projects/${enc(req.repo)}/repository/commits?ref_name=${enc(`${req.base}..${req.head}`)}&first_parent=true&per_page=${this.pageSize}`, req.signal);
    return firstParentChain(commits.map((c) => ({ sha: c.id, parents: c.parent_ids, committedAt: c.committed_date })), req.base, req.head);
  }

  /** What a reviewer reads for one drawn change (U5): see ./describe.ts. */
  describeChange(change: ChangeRecord, opts?: DescribeChangeOptions): Promise<ChangeDescription> {
    return describeGitLabChange(this.http, change, opts);
  }

  async listChanges(req: ListChangesRequest): Promise<ListChangesResult> {
    const { data: project } = await this.http.get<{ id: number; default_branch: string | null }>(`/projects/${enc(req.repo)}`, req.signal);
    const branch = project.default_branch;
    if (!branch) throw new RepoEmptyError(req.repo, `gitlab: ${req.repo} has no default branch`);
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
    this.unknownSize = 0;
    this.unreadableResets = 0;
    if (req.kinds.includes("pull_request")) {
      diagnostics.push({ label: "MRs merged into other branches in window (excluded)", value: otherBase });
      changes.push(...(await this.mergeRequestRecords(pid, req.repo, inWindow, req.signal)));
      if (this.unknownSize) diagnostics.push({ label: "MRs whose diff GitLab excluded (changedLinesUnknown: size unknown)", value: this.unknownSize });
      if (this.unreadableResets) diagnostics.push({ label: "approval-reset notes that name no approver (every approval before each was reset)", value: this.unreadableResets });
    }
    let headSha = req.head?.toLowerCase();
    let viaMerge = false;
    let unreachable: string[] | undefined;
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
      // P3: an MR merged in the window whose landing commit the walk from the head did not reach.
      if (req.kinds.includes("pull_request")) unreachable = await this.unreachableMrs(pid, walk.head, changes.filter((c) => c.kind === "pull_request" && !walk.visited.has(c.mergeSha)), req.signal);
    }
    return { changes, defaultBranch: branch, limitations: viaMerge ? [...GITLAB_LIMITATIONS, LANDED_VIA_LIMITATION] : GITLAB_LIMITATIONS, diagnostics, ...(headSha ? { headSha } : {}), ...(unreachable ? { unreachable } : {}) };
  }

  /**
   * Of the MRs merged in the window whose landing commit the walk from `head` (every commit reachable from it dated in
   * the window) did not visit, the ones GitLab confirms are not ancestors of `head` (P3, the stopgap):
   * `GET /projects/:id/repository/merge_base?refs[]=<commit>&refs[]=<head>` is the commit itself when it is one. GitLab
   * dates a merge or squash commit at its merge, so an unvisited one is rare (a fast-forward merge of commits dated
   * before the window). At most 10 are asked; asking stops at the third unreachable one.
   */
  async unreachableMrs(pid: number, head: string, candidates: readonly ChangeRecord[], signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    for (const c of [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 10)) {
      let base: string;
      try {
        base = (await this.http.get<{ id: string }>(`/projects/${pid}/repository/merge_base?refs%5B%5D=${c.mergeSha}&refs%5B%5D=${head}`, signal)).data.id.toLowerCase();
      } catch (e) {
        if (e instanceof HttpError && (e.status === 400 || e.status === 404)) continue; // GitLab cannot say: unknown, so not reported
        throw e;
      }
      if (base !== c.mergeSha) out.push(c.id);
      if (out.length >= 3) break;
    }
    return out;
  }

  /**
   * The default branch's push log (P3): `GET /projects/:id/events?action=pushed`, newest first and paged, keeping the
   * branch's own updates (`push_data.ref_type` branch, `push_data.ref`), until one at or before `since` (at most
   * MAX_EVENT_PAGES pages). `push_data.action` is pushed, created or removed. GitLab does not say whether a push was
   * forced, so a push is kind "unknown" (verify then shows the window-close tip is an ancestor another way). A bulk push
   * event names no ref, so it is kept with no before or after: verify reads it as a gap.
   */
  async pushLog(req: PushLogRequest): Promise<PushLog> {
    const since = Date.parse(req.since);
    const events: PushLogEvent[] = [];
    let pages = 0;
    await this.paged<GlPushEvent>(`/projects/${enc(req.repo)}/events?action=pushed&sort=desc&per_page=${this.pageSize}`, req.signal, (page) => {
      pages++;
      let reached = false;
      for (const e of page) {
        const pd = e.push_data;
        if (!pd) continue;
        const bulk = pd.ref === null || pd.ref === undefined;
        if (!bulk && (pd.ref_type !== "branch" || pd.ref !== req.branch)) continue;
        const t = Date.parse(e.created_at);
        events.push({
          id: String(e.id),
          before: bulk ? "" : (pd.commit_from ?? NO_COMMIT).toLowerCase(),
          after: bulk ? "" : (pd.commit_to ?? NO_COMMIT).toLowerCase(),
          at: Number.isFinite(t) ? new Date(t).toISOString().replace(".000Z", "Z") : String(e.created_at),
          kind: pd.action === "created" ? "created" : pd.action === "removed" ? "deleted" : "unknown",
        });
        if (!bulk && Number.isFinite(t) && t <= since) reached = true;
      }
      return !reached && pages < MAX_EVENT_PAGES;
    });
    return { events, limitations: [GITLAB_PUSH_LOG_LIMITATION] };
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
        // approvedBy and reviewers are read 100 at a time: page the rest, so no approver or reviewer is missing its bot flag.
        for (const [field, query] of [["approvedBy", MORE_APPROVERS_QUERY], ["reviewers", MORE_REVIEWERS_QUERY]] as const) {
          let up = n[field].pageInfo;
          while (up?.hasNextPage) {
            const more = await this.graphql<{ project: { mergeRequest: Record<string, GqlUsersPage> } }>(query, { path: repo, iid: n.iid, after: up.endCursor }, signal);
            const next = more.project.mergeRequest[field]!;
            n[field].nodes.push(...next.nodes);
            up = next.pageInfo;
          }
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
      const reviews = buildReviews({ mrAuthor: mr.author?.username ?? null, notes: d.notes.nodes as GlNote[], approvals, reviewers, mergedAt: mr.merged_at!, actor, onUnreadableReset: () => this.unreadableResets++ });
      // GitLab's own diff stats first; the REST diffs only when GraphQL has none, and a diff GitLab excluded is a size we do not know.
      const size = d.diffStatsSummary ? { lines: d.diffStatsSummary.additions + d.diffStatsSummary.deletions, unknown: false } : await this.diffLines(pid, mr.iid, signal);
      if (size.unknown) this.unknownSize++;
      out.push({ ...normalizeMergeRequest(repo, mr, reviews, size.lines, actor), ...(size.unknown ? { changedLinesUnknown: true as const } : {}) });
    }
    return out;
  }

  /**
   * Fallback when GraphQL has no diff stats: count +/- lines of the MR's diffs. A file diff GitLab
   * excluded (`too_large`: cannot be retrieved; `collapsed`: left out unless asked for) has no lines to
   * count, so the MR's size is unknown, not the sum of the others (finding 10 of the master review).
   */
  private async diffLines(pid: number, iid: number, signal?: AbortSignal): Promise<{ lines: number; unknown: boolean }> {
    const diffs = await this.paged<{ diff: string; too_large?: boolean; collapsed?: boolean }>(`/projects/${pid}/merge_requests/${iid}/diffs?per_page=${this.pageSize}`, signal);
    return { lines: diffs.reduce((n, d) => n + countDiffLines(d.diff), 0), unknown: diffs.some((d) => d.too_large === true || d.collapsed === true) };
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
      `/projects/${pid}/repository/commits?ref_name=${enc(headSha)}&since=${enc(req.window.opensAt)}&until=${enc(req.window.closesAt)}&with_stats=true&per_page=${this.pageSize}`,
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
    return { pushes, inWindow: inWindow.length, linked: res.linked + linkedByLookup, linkedByLookup, head: headSha.toLowerCase(), landedVia, visited: new Set(history.map((c) => c.id.toLowerCase())) };
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
