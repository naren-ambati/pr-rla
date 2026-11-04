import {
  PROVIDER_API_VERSION,
  defineProvider,
  type ChangeRecord,
  type ListChangesRequest,
  type ListChangesResult,
  type ProviderContext,
  type ScmProvider,
} from "../../sdk/provider.js";
import { attributeCommits } from "../attribution.js";
import { LANDED_VIA_LIMITATION, landedViaMerges } from "../landed-via.js";
import { HttpClient, isoUtcSeconds } from "../http.js";
import {
  buildReviews,
  mergeEvent,
  normalizeDirectPush,
  normalizePullRequest,
  rebaseKey,
  type BbActivity,
  type BbCommit,
  type BbPullRequest,
} from "./normalize.js";

export interface BitbucketCloudOptions {
  /** API root (default https://api.bitbucket.org/2.0). */
  api_url?: string;
  /** Env var with an access token or OAuth token, sent as Bearer (default BITBUCKET_TOKEN). */
  token_env?: string;
  /** Env var with the Atlassian account e-mail; when set, the token is an API token sent with Basic auth (default BITBUCKET_USERNAME). */
  username_env?: string;
  /** Hours before the window opens to start listing PRs by update time (default 24). */
  listing_slack_hours?: number;
}

export const BITBUCKET_CLOUD_LIMITATIONS = [
  "direct_push: Bitbucket's commit API does not expose the pusher; `author` is the commit author (commit author != pusher) and mergedBy is null.",
  "direct_push: the window is applied to the commit date Bitbucket reports (the committer date), not the push time.",
  "direct_push: every commit reachable from the main branch (all parents), dated in the window, that no merged PR into that branch brought in (its merge commit or its listed commits, or a rebased copy of one with the same author and message).",
  "pull_request: merge time and merger come from the PR's MERGED activity (Bitbucket leaves closed_on empty on merged PRs); changedLines are the PR diffstat (lines added + removed).",
  "pull_request: a withdrawn approval disappears from Bitbucket's activity, so it is not reported as DISMISSED.",
  "bots: app_user and team accounts (access tokens, apps) are bots; a bot running on a regular user account is counted as human.",
];

const RATE_HINT = "Unauthenticated Bitbucket Cloud API access allows only about 50-60 requests an hour; set BITBUCKET_TOKEN (an access token with repository and pull request read scopes), or retry in an hour.";
const USER_FIELDS = "type,uuid,account_id,nickname,display_name";
const PR_FIELDS = [
  "next",
  "values.id",
  "values.updated_on",
  "values.destination.branch.name",
  "values.source.commit.hash",
  "values.merge_commit.hash",
  "values.links.html.href",
  ...USER_FIELDS.split(",").map((f) => `values.author.${f}`),
  ...USER_FIELDS.split(",").map((f) => `values.closed_by.${f}`),
  "values.participants.role",
  "values.participants.approved",
  "values.participants.state",
  "values.participants.participated_on",
  ...USER_FIELDS.split(",").map((f) => `values.participants.user.${f}`),
].join(",");
const COMMIT_FIELDS = ["next", "values.hash", "values.date", "values.parents.hash", "values.message", "values.links.html.href", "values.author.raw", ...USER_FIELDS.split(",").map((f) => `values.author.user.${f}`)].join(",");

interface Page<T> {
  values: T[];
  next?: string;
}

/**
 * The rebased copies a PR brought in, when its merge rewrote SHAs ("Rebase, fast forward" or "Rebase,
 * merge") and Bitbucket lists the PR's original commits. Copies can only be the first-parent chain from
 * the merge commit (rebase + fast-forward: one parent, and not the source head) or from its second parent
 * (rebase + merge commit, when that parent is not a listed commit), at most as long as the PR's commit
 * list, and each must keep a listed commit's author and message. Matching on author + message alone
 * claimed two direct pushes on atlassian/bamboo-specs: the Maven release plugin writes identical
 * "prepare for next development iteration" commits on master and on the release branch PR #738 merged.
 */
export function rebasedCopies(pr: BbPullRequest, listed: readonly BbCommit[], byShortSha: ReadonlyMap<string, BbCommit>, byFullSha: ReadonlyMap<string, BbCommit>): BbCommit[] {
  const merge = pr.merge_commit?.hash ? byShortSha.get(pr.merge_commit.hash.slice(0, 12)) : undefined;
  if (!merge || listed.length === 0) return [];
  const listedShas = new Set(listed.map((c) => c.hash));
  let start: BbCommit | undefined;
  if (merge.parents.length === 1 && pr.source?.commit?.hash && !merge.hash.startsWith(pr.source.commit.hash.slice(0, 12))) start = merge;
  else if (merge.parents.length === 2 && !listedShas.has(merge.parents[1]!.hash)) start = byFullSha.get(merge.parents[1]!.hash);
  const keys = new Set(listed.map(rebaseKey));
  const out: BbCommit[] = [];
  for (let c = start, n = 0; c && n < listed.length; c = c.parents[0] ? byFullSha.get(c.parents[0].hash) : undefined, n++) {
    if (!listedShas.has(c.hash) && keys.has(rebaseKey(c))) out.push(c);
  }
  return out;
}

export class BitbucketCloudProvider implements ScmProvider {
  readonly apiVersion = PROVIDER_API_VERSION;
  readonly name = "bitbucket-cloud";
  readonly http: HttpClient;
  private readonly slackMs: number;
  private readonly webBase = "https://bitbucket.org";

  constructor(opts: BitbucketCloudOptions, private readonly ctx: ProviderContext & { now?: () => number }) {
    const token = ctx.env[opts.token_env ?? "BITBUCKET_TOKEN"];
    const user = ctx.env[opts.username_env ?? "BITBUCKET_USERNAME"];
    const auth = token ? (user ? `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` : `Bearer ${token}`) : undefined;
    this.http = new HttpClient({
      provider: "bitbucket-cloud",
      baseUrl: opts.api_url ?? "https://api.bitbucket.org/2.0",
      headers: auth ? { authorization: auth } : {},
      fetch: ctx.fetch,
      log: ctx.log,
      maxRetries: 0, // ctx.fetch is the fetch broker, the only retrier (contracts.md §2)
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
      rateLimitHint: RATE_HINT,
      maxBlindRateLimitRetries: 2,
    });
    this.slackMs = (opts.listing_slack_hours ?? 24) * 3_600_000;
  }

  private split(repo: string) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
    if (!m) throw new Error(`bitbucket-cloud repo must be "workspace/repo_slug" (got "${repo}")`);
    return `/repositories/${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]!)}`;
  }

  /** Follows `next` links; `each` returns false to stop early. */
  private async paged<T>(first: string, signal?: AbortSignal, each?: (page: T[]) => boolean | void): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = first;
    while (url) {
      signal?.throwIfAborted();
      const { data }: { data: Page<T> } = await this.http.get<Page<T>>(url, signal);
      out.push(...data.values);
      if (each?.(data.values) === false) break;
      url = data.next;
    }
    return out;
  }

  async listChanges(req: ListChangesRequest): Promise<ListChangesResult> {
    const base = this.split(req.repo);
    const { data: repo } = await this.http.get<{ mainbranch?: { name: string } | null }>(`${base}?fields=mainbranch.name`, req.signal);
    const branch = repo.mainbranch?.name;
    if (!branch) throw new Error(`bitbucket-cloud: ${req.repo} has no main branch`);
    const opens = Date.parse(req.window.opensAt);
    const closes = Date.parse(req.window.closesAt);

    const listed = await this.listMergedPrs(base, opens, req.signal);
    const candidates = [...listed.values()].filter((p) => p.destination.branch.name === branch).sort((a, b) => a.id - b.id);
    const otherBase = [...listed.values()].filter((p) => p.destination.branch.name !== branch && Date.parse(p.updated_on) >= opens && Date.parse(p.updated_on) < closes).length;

    // Merge time is only in the activity, so read it for every PR merged into the main branch that was updated since the window opened.
    const merged: { pr: BbPullRequest; activity: BbActivity[]; at: string; by: BbPullRequest["closed_by"] }[] = [];
    let noMergeEvent = 0;
    for (const pr of candidates) {
      const activity = await this.paged<BbActivity>(`${base}/pullrequests/${pr.id}/activity?pagelen=50`, req.signal);
      const ev = mergeEvent(activity);
      if (!ev) noMergeEvent++;
      const at = ev?.at ?? pr.updated_on;
      if (Date.parse(at) >= opens) merged.push({ pr, activity, at, by: ev?.by ?? pr.closed_by ?? null });
    }
    const inWindow = merged.filter((m) => Date.parse(m.at) < closes);

    const changes: ChangeRecord[] = [];
    const diagnostics: { label: string; value: number }[] = [];
    const fullSha = new Map<string, string>();
    // Walked for PRs too: merge_commit.hash is abbreviated, and 2-3 history pages resolve every merge
    // commit since the window opened, where one /commit lookup per PR would cost more.
    const { head, commits: history } = await this.history(base, branch, opens, req.signal, req.head);
    for (const c of history) fullSha.set(c.hash.slice(0, 12), c.hash);

    if (req.kinds.includes("pull_request")) {
      diagnostics.push({ label: "PRs into other branches updated in window (excluded)", value: otherBase });
      if (noMergeEvent) diagnostics.push({ label: "merged PRs with no MERGED activity (updated_on used as merge time)", value: noMergeEvent });
      for (const m of inWindow) {
        const short = m.pr.merge_commit?.hash;
        if (!short) throw new Error(`bitbucket-cloud: merged PR #${m.pr.id} has no merge_commit`);
        let sha = short.length >= 40 ? short : fullSha.get(short.slice(0, 12));
        if (!sha) sha = (await this.http.get<{ hash: string }>(`${base}/commit/${short}?fields=hash`, req.signal)).data.hash;
        const stats = await this.paged<{ lines_added: number; lines_removed: number }>(`${base}/pullrequests/${m.pr.id}/diffstat?pagelen=500&fields=next,values.lines_added,values.lines_removed`, req.signal);
        const reviews = buildReviews({ author: m.pr.author, activity: m.activity, participants: m.pr.participants ?? [], mergedAt: m.at });
        changes.push(normalizePullRequest(req.repo, m.pr, { mergeSha: sha, mergedAt: m.at, mergedBy: m.by ?? null, reviews, changedLines: stats.reduce((n, s) => n + (s.lines_added ?? 0) + (s.lines_removed ?? 0), 0), webBase: this.webBase }));
      }
    }

    let landedVia = new Map<string, string>();
    if (req.kinds.includes("direct_push")) {
      // Merge commits (abbreviated to 12) are claimed from the listing; PR commit lists are read only while commits are unclaimed.
      const known = new Map<string, number>();
      for (const m of merged) if (m.pr.merge_commit?.hash && !known.has(m.pr.merge_commit.hash.slice(0, 12))) known.set(m.pr.merge_commit.hash.slice(0, 12), m.pr.id);
      const seen = new Set<string>();
      const inWin = history.filter((c) => {
        const t = Date.parse(c.date);
        if (seen.has(c.hash) || t < opens || t >= closes) return false;
        seen.add(c.hash);
        return true;
      });
      const order = [...merged].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.pr.id - b.pr.id);
      const byShortSha = new Map(history.map((c) => [c.hash.slice(0, 12), c]));
      const byFullSha = new Map(history.map((c) => [c.hash, c]));
      let byRebase = 0;
      const res = await attributeCommits({
        commits: inWin,
        sha: (c) => c.hash,
        known,
        prefixLength: 12,
        prs: order.map((m) => m.pr.id),
        readCommits: async (id) => {
          const listed = await this.paged<BbCommit>(`${base}/pullrequests/${id}/commits?pagelen=100&fields=${COMMIT_FIELDS}`, req.signal);
          const copies = rebasedCopies(order.find((m) => m.pr.id === id)!.pr, listed, byShortSha, byFullSha);
          byRebase += copies.filter((c) => inWin.includes(c) && !known.has(c.hash.slice(0, 12))).length;
          return [...listed, ...copies].map((c) => ({ sha: c.hash }));
        },
      });
      landedVia = landedViaMerges(new Map(history.map((c) => [c.hash, c.parents.map((p) => p.hash)])), res.pushes.map((c) => c.hash));
      for (const c of res.pushes) {
        const stats = await this.paged<{ lines_added: number; lines_removed: number }>(`${base}/diffstat/${c.hash}?pagelen=500&fields=next,values.lines_added,values.lines_removed`, req.signal);
        changes.push(normalizeDirectPush(req.repo, c, stats.reduce((n, s) => n + (s.lines_added ?? 0) + (s.lines_removed ?? 0), 0), this.webBase, landedVia.get(c.hash)?.toLowerCase()));
      }
      diagnostics.push(
        { label: "default-branch commits in window", value: inWin.length },
        { label: "commits linked to a merged PR", value: res.linked },
        { label: "rebased commits linked by author and message", value: byRebase },
        { label: "direct pushes that are merge commits", value: res.pushes.filter((c) => c.parents.length > 1).length },
      );
    }
    return { changes, defaultBranch: branch, limitations: landedVia.size ? [...BITBUCKET_CLOUD_LIMITATIONS, LANDED_VIA_LIMITATION] : BITBUCKET_CLOUD_LIMITATIONS, diagnostics, headSha: head };
  }

  /**
   * Merged PRs updated since (window open - slack), newest update first, then (after a
   * multi-page walk) the first page(s) again for PRs updated during the walk. `state`
   * must sit inside `q`: Bitbucket ignores the `state` parameter when `q` is given.
   */
  async listMergedPrs(base: string, opens: number, signal?: AbortSignal): Promise<Map<number, BbPullRequest>> {
    const now = this.ctx.now ?? Date.now;
    const q = encodeURIComponent(`state="MERGED" AND updated_on >= ${isoUtcSeconds(opens - this.slackMs)}`);
    const first = `${base}/pullrequests?pagelen=50&sort=-updated_on&q=${q}&fields=${PR_FIELDS}`;
    const byId = new Map<number, BbPullRequest>();
    const walkStart = now();
    let pages = 0;
    await this.paged<BbPullRequest>(first, signal, (page) => {
      pages++;
      page.forEach((p) => byId.set(p.id, p));
    });
    // One page is one snapshot: nothing can have moved between pages, so the re-scan (a request out of
    // an anonymous budget of about 60 an hour) is only needed after a multi-page walk.
    if (pages <= 1) return byId;
    await this.paged<BbPullRequest>(first, signal, (page) => {
      page.forEach((p) => byId.set(p.id, p));
      const last = page[page.length - 1];
      return !!last && Date.parse(last.updated_on) >= walkStart - 60_000;
    });
    return byId;
  }

  /**
   * Main-branch history from a pinned head (`head`, the frozen one when verify passes it), newest first
   * (git's date order), until a whole page is older than the window.
   */
  async history(base: string, branch: string, opens: number, signal?: AbortSignal, head?: string): Promise<{ head: string; commits: BbCommit[] }> {
    const tip = head ?? (await this.http.get<{ target: { hash: string } }>(`${base}/refs/branches/${encodeURIComponent(branch)}?fields=target.hash`, signal)).data.target.hash;
    const commits = await this.paged<BbCommit>(`${base}/commits/${tip}?pagelen=100&fields=${COMMIT_FIELDS}`, signal, (page) => page.some((c) => Date.parse(c.date) >= opens));
    return { head: tip.toLowerCase(), commits };
  }
}

export default defineProvider<BitbucketCloudOptions>({
  providerApiVersion: PROVIDER_API_VERSION,
  name: "bitbucket-cloud",
  description: "Bitbucket Cloud: merged PRs, activity, participants and diffstat, plus main-branch history for direct pushes",
  hosts: (options) => [new URL(options?.api_url ?? "https://api.bitbucket.org/2.0").host],
  // Bitbucket has no review objects for comments: one COMMENTED per non-author user, at their first comment.
  reviewGranularity: "first-comment-per-user",
  populationOptions: ["api_url", "listing_slack_hours"],
  reportsLandedVia: true,
  create: (options, ctx) => new BitbucketCloudProvider(options ?? {}, ctx),
});
