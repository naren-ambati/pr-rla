import {
  PROVIDER_API_VERSION,
  defineProvider,
  type ChangeRecord,
  type ListChangesRequest,
  type ListChangesResult,
  type ProviderContext,
  type RepoRef,
  type RepoSetRule,
  type ScmProvider,
} from "../../sdk/provider.js";
import { attributeCommits } from "../attribution.js";
import { LANDED_VIA_LIMITATION, landedViaMerges } from "../landed-via.js";
import { HttpClient, HttpError } from "../http.js";
import {
  buildReviews,
  countDiff,
  normalizeDirectPush,
  normalizePullRequest,
  rebaseKey,
  type DcActivity,
  type DcCommit,
  type DcDiff,
  type DcPullRequest,
  type DcUser,
} from "./normalize.js";

export interface BitbucketDataCenterOptions {
  /** The server root, e.g. https://bitbucket.example.com (required). */
  base_url: string;
  /** Env var holding an HTTP access token with repository read permission (default BITBUCKET_DC_TOKEN). */
  token_env?: string;
  /** Page size (`limit`, default 100). */
  page_size?: number;
}

export const BITBUCKET_DC_LIMITATIONS = [
  "bitbucket-data-center: UNVERIFIED against a live server; built and tested from Atlassian's documented REST 1.0 response shapes.",
  "direct_push: Bitbucket's commit API does not expose the pusher; `author` is the commit author (commit author != pusher) and mergedBy is null.",
  "direct_push: the window is applied to the committer timestamp, not the push time.",
  "direct_push: every commit reachable from the default branch, dated in the window, that no merged PR into that branch brought in (its merge commit, its listed commits, or a rebased copy with the same author, author time and message).",
  "pull_request: changedLines count the ADDED and REMOVED lines of the PR diff; Bitbucket truncates very large diffs (counted as a diagnostic).",
  "pull_request: every merged PR into the default branch is listed (no date filter exists), then filtered by closedDate.",
  "bots: SERVICE users are bots; a bot running on a NORMAL account is counted as human.",
];

interface DcPage<T> {
  values: T[];
  isLastPage: boolean;
  nextPageStart?: number;
}

export class BitbucketDataCenterProvider implements ScmProvider {
  readonly apiVersion = PROVIDER_API_VERSION;
  readonly name = "bitbucket-data-center";
  readonly http: HttpClient;
  private readonly root: string;
  private readonly limit: number;

  constructor(opts: BitbucketDataCenterOptions, ctx: ProviderContext) {
    if (!opts?.base_url) throw new Error("bitbucket-data-center needs options.base_url (the server root, e.g. https://bitbucket.example.com)");
    this.root = opts.base_url.replace(/\/+$/, "").replace(/\/rest\/api\/1\.0$/, "");
    const token = ctx.env[opts.token_env ?? "BITBUCKET_DC_TOKEN"];
    this.http = new HttpClient({
      provider: "bitbucket-data-center",
      baseUrl: `${this.root}/rest/api/1.0`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      fetch: ctx.fetch,
      log: ctx.log,
      maxRetries: 0, // ctx.fetch is the fetch broker, the only retrier (contracts.md §2)
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      rateLimitHint: `The server is rate limiting this client; use ${opts.token_env ?? "BITBUCKET_DC_TOKEN"} with a token whose user is exempt, or retry later.`,
    });
    this.limit = opts.page_size ?? 100;
  }

  private split(repo: string) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
    if (!m) throw new Error(`bitbucket-data-center repo must be "PROJECT/repo-slug" (got "${repo}")`);
    return { path: `/projects/${encodeURIComponent(m[1]!)}/repos/${encodeURIComponent(m[2]!)}`, web: `${this.root}/projects/${encodeURIComponent(m[1]!)}/repos/${encodeURIComponent(m[2]!)}` };
  }

  /** Follows `start`/`nextPageStart` paging; `each` returns false to stop early. */
  private async paged<T>(path: string, signal?: AbortSignal, each?: (page: T[]) => boolean | void): Promise<T[]> {
    const out: T[] = [];
    let start = 0;
    for (;;) {
      signal?.throwIfAborted();
      const sep = path.includes("?") ? "&" : "?";
      const { data } = await this.http.get<DcPage<T>>(`${path}${sep}limit=${this.limit}&start=${start}`, signal);
      out.push(...data.values);
      if (each?.(data.values) === false || data.isLastPage || data.nextPageStart === undefined) break;
      start = data.nextPageStart;
    }
    return out;
  }

  private async defaultBranch(path: string, signal?: AbortSignal): Promise<{ id: string; displayId: string; latestCommit: string }> {
    try {
      return (await this.http.get<{ id: string; displayId: string; latestCommit: string }>(`${path}/default-branch`, signal)).data;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
      return (await this.http.get<{ id: string; displayId: string; latestCommit: string }>(`${path}/branches/default`, signal)).data; // before 7.6
    }
  }

  /**
   * The repositories of a project (U8): `GET /projects/{KEY}/repos`, paged by `start`. `origin` marks a fork. The list
   * does not carry the default branch (one more request per repository), so it is left empty: `freeze` records the
   * branch `listChanges` walked.
   */
  async listRepos(set: RepoSetRule): Promise<RepoRef[]> {
    interface DcRepo {
      id: number;
      slug: string;
      project?: { key?: string };
      public?: boolean;
      archived?: boolean;
      origin?: unknown;
    }
    const repos = await this.paged<DcRepo>(`/projects/${encodeURIComponent(set.owner)}/repos`);
    return repos.map((r) => ({
      repo: `${r.project?.key ?? set.owner}/${r.slug}`,
      id: String(r.id),
      defaultBranch: "",
      archived: r.archived === true,
      fork: r.origin !== undefined && r.origin !== null,
      visibility: r.public === true ? "public" : "private",
    }));
  }

  async listChanges(req: ListChangesRequest): Promise<ListChangesResult> {
    const { path, web } = this.split(req.repo);
    const branch = await this.defaultBranch(path, req.signal);
    const opens = Date.parse(req.window.opensAt);
    const closes = Date.parse(req.window.closesAt);

    const prs = await this.paged<DcPullRequest>(`${path}/pull-requests?state=MERGED&at=${encodeURIComponent(branch.id)}&order=NEWEST&withAttributes=false&withProperties=true`, req.signal);
    const since = prs.filter((p) => p.toRef.id === branch.id && (p.closedDate ?? p.updatedDate) >= opens).sort((a, b) => a.id - b.id);
    const inWindow = since.filter((p) => (p.closedDate ?? p.updatedDate) < closes);

    const changes: ChangeRecord[] = [];
    const diagnostics: { label: string; value: number }[] = [];
    const activities = new Map<number, DcActivity[]>();
    const acts = async (id: number) => {
      if (!activities.has(id)) activities.set(id, await this.paged<DcActivity>(`${path}/pull-requests/${id}/activities`, req.signal));
      return activities.get(id)!;
    };
    const mergeShaOf = async (p: DcPullRequest) => p.properties?.mergeCommit?.id ?? (await acts(p.id)).find((a) => a.action === "MERGED")?.commit?.id ?? null;

    if (req.kinds.includes("pull_request")) {
      let truncated = 0;
      for (const p of inWindow) {
        const a = await acts(p.id);
        const sha = await mergeShaOf(p);
        if (!sha) throw new Error(`bitbucket-data-center: merged PR #${p.id} has no merge commit (properties.mergeCommit or a MERGED activity)`);
        const merged = a.find((x) => x.action === "MERGED");
        const mergedAtMs = p.closedDate ?? merged?.createdDate ?? p.updatedDate;
        const { data: diff } = await this.http.get<DcDiff>(`${path}/pull-requests/${p.id}/diff?contextLines=0&withComments=false`, req.signal);
        const d = countDiff(diff);
        if (d.truncated) truncated++;
        const reviews = buildReviews({ author: p.author.user, activities: a, finals: [...(p.reviewers ?? []), ...(p.participants ?? [])], mergedAtMs });
        changes.push(normalizePullRequest(req.repo, p, { mergeSha: sha, mergedAtMs, mergedBy: (merged?.user as DcUser | undefined) ?? null, reviews, changedLines: d.lines, webBase: web }));
      }
      diagnostics.push({ label: "PR diffs truncated by the server (changedLines undercounted)", value: truncated });
    }

    // The pinned head (U3): verify passes the frozen head; freeze walks from the branch's latest commit.
    const head = (req.head ?? branch.latestCommit).toLowerCase();
    let landedVia = new Map<string, string>();
    if (req.kinds.includes("direct_push")) {
      // Merge commits are claimed from the listing (or the MERGED activity); PR commit lists are read only while commits are unclaimed.
      const known = new Map<string, number>();
      for (const p of since) {
        const sha = await mergeShaOf(p);
        if (sha && !known.has(sha.toLowerCase())) known.set(sha.toLowerCase(), p.id);
      }
      // Newest first in git's date order, from the pinned head, until a whole page is older than the window.
      const history = await this.paged<DcCommit>(`${path}/commits?until=${head}`, req.signal, (page) => page.some((c) => c.committerTimestamp >= opens));
      const seen = new Set<string>();
      const inWin = history.filter((c) => {
        if (seen.has(c.id) || c.committerTimestamp < opens || c.committerTimestamp >= closes) return false;
        seen.add(c.id);
        return true;
      });
      const order = [...since].sort((a, b) => (a.closedDate ?? a.updatedDate) - (b.closedDate ?? b.updatedDate) || a.id - b.id).map((p) => p.id);
      const res = await attributeCommits({
        commits: inWin,
        sha: (c) => c.id,
        known,
        prs: order,
        readCommits: async (id) => (await this.paged<DcCommit>(`${path}/pull-requests/${id}/commits`, req.signal)).map((c) => ({ sha: c.id, key: rebaseKey(c) })),
        rebaseKey,
      });
      landedVia = landedViaMerges(new Map(history.map((c) => [c.id, c.parents.map((p) => p.id)])), res.pushes.map((c) => c.id));
      for (const c of res.pushes) {
        const { data: diff } = await this.http.get<DcDiff>(`${path}/commits/${c.id}/diff?contextLines=0`, req.signal);
        changes.push(normalizeDirectPush(req.repo, c, countDiff(diff).lines, web, landedVia.get(c.id)?.toLowerCase()));
      }
      diagnostics.push(
        { label: "default-branch commits in window", value: inWin.length },
        { label: "commits linked to a merged PR", value: res.linked },
        { label: "rebased commits linked by author, author time and message", value: res.byRebase },
        { label: "direct pushes that are merge commits", value: res.pushes.filter((c) => c.parents.length > 1).length },
      );
    }
    return { changes, defaultBranch: branch.displayId, limitations: landedVia.size ? [...BITBUCKET_DC_LIMITATIONS, LANDED_VIA_LIMITATION] : BITBUCKET_DC_LIMITATIONS, diagnostics, headSha: head };
  }
}

export default defineProvider<BitbucketDataCenterOptions>({
  providerApiVersion: PROVIDER_API_VERSION,
  name: "bitbucket-data-center",
  description: "Bitbucket Data Center / Server REST 1.0 (unverified against a live server): merged PRs, activities, reviewers, diffs and default-branch commits",
  hosts: (options) => (options?.base_url ? [new URL(options.base_url).host] : []),
  // Comments become one COMMENTED per non-author user, at their first comment.
  reviewGranularity: "first-comment-per-user",
  populationOptions: ["base_url"],
  reportsLandedVia: true,
  create: (options, ctx) => new BitbucketDataCenterProvider(options, ctx),
});
