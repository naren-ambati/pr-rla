// pr-rla-provider-gitea: a bring-your-own pr-rla provider for Gitea and Forgejo (Codeberg included).
//
// It is a standalone package that imports only the public SDK (pr-rla/provider); the conformance
// kit (pr-rla/testing) is used by its tests. docs/writing-a-provider.md walks through this file.
//
//   provider:
//     use: ./examples/providers/gitea/index.mjs        # or the package name: pr-rla-provider-gitea
//     options: { base_url: https://codeberg.org, bots: [renovate-bot] }
//   repo: forgejo/docs
import { defineProvider } from "pr-rla/provider";

const NAME = "gitea";
const BOT_SUFFIX = "[bot]";

// ---------------------------------------------------------------------------
// 1. HTTP: retry 5xx, 429 and truncated bodies; wait as long as the server says.
// ---------------------------------------------------------------------------

/** Milliseconds to wait before retrying: Retry-After, Codeberg's `RateLimit: "…";r=0;t=<s>`, or X-RateLimit-Reset. */
export function retryWait(headers, attempt, nowMs = Date.now()) {
  const waits = [Math.min(60_000, 1000 * 2 ** attempt)];
  const ra = headers.get("retry-after");
  if (ra !== null) waits[0] = Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Math.max(0, Date.parse(ra) - nowMs);
  const structured = headers.get("ratelimit");
  const r = structured && /(?:^|[;,\s])r=(\d+)/.exec(structured);
  const t = structured && /(?:^|[;,\s])t=(\d+)/.exec(structured);
  if (r && t && Number(r[1]) === 0) waits.push(Number(t[1]) * 1000);
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-remaining") === "0" && reset > 0) waits.push(reset > 1e9 ? reset * 1000 - nowMs + 1000 : reset * 1000);
  return Math.min(Math.max(...waits), 15 * 60_000);
}

function nextLink(headers) {
  const m = /<([^>]+)>\s*;\s*rel="next"/.exec(headers.get("link") ?? "");
  return m ? m[1] : null;
}

class Http {
  constructor({ base, token, fetch, sleep, log, maxRetries = 6 }) {
    Object.assign(this, { base, fetch, log, maxRetries });
    this.sleep = sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    this.headers = { accept: "application/json", "user-agent": "pr-rla-provider-gitea/0.1", ...(token ? { authorization: `token ${token}` } : {}) };
  }

  /** GET with retries. Returns the parsed body and the rel="next" URL (Link header), if any. */
  async get(pathOrUrl, signal) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let reason;
      let wait = Math.min(60_000, 1000 * 2 ** attempt);
      try {
        const res = await this.fetch(url, { headers: this.headers, ...(signal ? { signal } : {}) });
        if (res.ok) {
          const text = await res.text();
          try {
            return { data: JSON.parse(text), next: nextLink(res.headers) };
          } catch {
            reason = `truncated or non-JSON body (${text.length} bytes)`;
          }
        } else if (res.status >= 500 || res.status === 429) {
          reason = `HTTP ${res.status}`;
          wait = retryWait(res.headers, attempt);
        } else {
          throw Object.assign(new Error(`gitea GET ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`), { fatal: true });
        }
      } catch (e) {
        if (e.fatal || e.name === "AbortError") throw e;
        reason ??= e.message;
      }
      if (attempt >= this.maxRetries) throw new Error(`gitea GET ${url}: gave up after ${attempt + 1} attempts (${reason})`);
      this.log?.(`gitea: ${reason} on ${url}; retrying in ${Math.round(wait / 1000)}s`);
      await this.sleep(wait);
    }
  }

  /** Every page, following Link rel="next"; `each(page)` may return false to stop. */
  async all(path, signal, each) {
    const out = [];
    for (let url = path; url; ) {
      const { data, next } = await this.get(url, signal);
      out.push(...data);
      if (each?.(data) === false) break;
      url = next;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 2. Normalization into the SDK's types (pure functions, unit-testable).
// ---------------------------------------------------------------------------

const iso = (v) => new Date(Math.floor(Date.parse(v) / 1000) * 1000).toISOString().replace(".000Z", "Z");

/**
 * Gitea has no bot flag. A user is a bot when it is the built-in Actions user (id -2:
 * gitea-actions / forgejo-actions), its login ends in [bot], or it is listed in options.bots.
 * Deleted users (null, or the ghost user id -1) are `ghost`, human.
 */
export function actor(user, bots) {
  if (!user || user.id === -1) return { login: "ghost", kind: "human" };
  const login = user.login.endsWith(BOT_SUFFIX) ? user.login.slice(0, -BOT_SUFFIX.length) : user.login;
  const bot = user.id <= -2 || user.login.endsWith(BOT_SUFFIX) || bots.has(login.toLowerCase());
  return bot ? { login: `${login}${BOT_SUFFIX}`, kind: "bot" } : { login, kind: "human" };
}

/** `actor` plus the account's stable id (Actor.id): Gitea user ids survive renames. Deleted users (ghost) have none. */
export function account(user, bots) {
  const a = actor(user, bots);
  return user && user.id !== -1 && user.id !== undefined ? { ...a, id: String(user.id) } : a;
}

/** A commit's author: the Gitea account linked by e-mail if any, else the git identity. */
export function commitAuthor(c, bots) {
  if (c.author) return account(c.author, bots);
  const { name = "", email = "" } = c.commit.author ?? {};
  if (name.endsWith(BOT_SUFFIX) || bots.has(name.toLowerCase())) return { login: name.endsWith(BOT_SUFFIX) ? name : `${name}${BOT_SUFFIX}`, kind: "bot" };
  return { login: `git:${email || name || "unknown"}`, kind: "human" };
}

const STATES = { APPROVED: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" };

/** Gitea review states -> SDK states. A dismissed review is DISMISSED; PENDING and REQUEST_REVIEW (no review yet) are dropped. */
export function reviews(list, bots) {
  return list
    .filter((r) => r.submitted_at && (r.dismissed || STATES[r.state]))
    .map((r) => ({ author: account(r.user, bots), state: r.dismissed ? "DISMISSED" : STATES[r.state], submittedAt: iso(r.submitted_at) }))
    .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
}

/** A rebase merge re-creates commits with new SHAs but keeps author, author date and message. */
export const rebaseKey = (c) => `${c.commit.author?.email ?? ""}\u0000${c.commit.author?.date ? iso(c.commit.author.date) : ""}\u0000${(c.commit.message ?? "").split("\n")[0].trim()}`;

// ---------------------------------------------------------------------------
// 3. The provider.
// ---------------------------------------------------------------------------

export const LIMITATIONS = [
  "gitea: an example plugin (pr-rla-provider-gitea), not part of pr-rla's core.",
  "direct_push: Gitea's commit API does not expose the pusher; `author` is the commit author (commit author != pusher) and mergedBy is null.",
  "direct_push: the window is applied to the committer date, not the push time.",
  "direct_push: every default-branch commit (all parents) dated in the window that no merged PR into that branch brought in: its merge_commit_sha, its listed commits, or a rebased copy with the same author, author date and message.",
  "bots: Gitea has no bot flag; only the Actions user, [bot] logins and options.bots are bots.",
];

class GiteaProvider {
  apiVersion = 1;
  name = NAME;

  constructor(options, ctx) {
    this.ctx = ctx;
    const base = (options.base_url ?? "https://codeberg.org").replace(/\/+$/, "");
    this.http = new Http({ base: `${base}/api/v1`, token: ctx.env[options.token_env ?? "GITEA_TOKEN"], fetch: ctx.fetch, sleep: ctx.sleep, log: ctx.log });
    this.bots = new Set((options.bots ?? []).map((b) => String(b).toLowerCase().replace(/\[bot\]$/, "")));
    this.limit = options.page_size ?? 50;
    this.slackMs = (options.listing_slack_hours ?? 24) * 3_600_000;
  }

  async listChanges(req) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(req.repo);
    if (!m) throw new Error(`gitea repo must be "owner/name" (got "${req.repo}")`);
    const repoPath = `/repos/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`;
    const { signal } = req;
    const { data: repo } = await this.http.get(repoPath, signal);
    const branch = repo.default_branch;
    const opens = Date.parse(req.window.opensAt);
    const closes = Date.parse(req.window.closesAt);
    const mergedAt = (p) => Date.parse(p.merged_at);

    // (a) Closed PRs, most recently updated first, back to a day before the window; then the head
    //     of the list again, because a PR updated mid-walk jumps to page 1 and could be skipped.
    const now = this.ctx.now ?? Date.now;
    const byNumber = new Map();
    const first = `${repoPath}/pulls?state=closed&sort=recentupdate&limit=${this.limit}`;
    const walkStart = now();
    for (const stopBefore of [opens - this.slackMs, walkStart - 60_000]) {
      await this.http.all(first, signal, (page) => {
        for (const p of page) byNumber.set(p.number, p);
        const last = page[page.length - 1];
        return !!last && Date.parse(last.updated_at) >= stopBefore;
      });
    }
    // Every PR merged into the default branch since the window opened (after it closed too: such a PR
    // can bring in commits dated inside the window, and those are not direct pushes).
    const since = [...byNumber.values()].filter((p) => p.merged && p.base.ref === branch && mergedAt(p) >= opens).sort((a, b) => mergedAt(a) - mergedAt(b) || a.number - b.number);
    const inWindow = since.filter((p) => mergedAt(p) < closes);
    const otherBase = [...byNumber.values()].filter((p) => p.merged && p.base.ref !== branch && mergedAt(p) >= opens && mergedAt(p) < closes).length;

    const changes = [];
    const diagnostics = [];
    let headSha = req.head;
    if (req.kinds.includes("pull_request")) {
      diagnostics.push({ label: "PRs merged into other branches in window (excluded)", value: otherBase });
      for (const p of inWindow.sort((a, b) => a.number - b.number)) {
        // The list endpoint returns merged_by: null on Forgejo (seen on Codeberg); the single PR has it.
        const { data: full } = await this.http.get(`${repoPath}/pulls/${p.number}`, signal);
        if (!full.merge_commit_sha) throw new Error(`gitea: merged PR #${p.number} has no merge_commit_sha`);
        const revs = await this.http.all(`${repoPath}/pulls/${p.number}/reviews?limit=${this.limit}`, signal);
        // Forgejo reports additions = deletions = changed_files = 0 on some merged PRs (forgejo/docs #2219
        // and #2221 on Codeberg, whose files list 7+3 and 4+6 lines); count the files' lines instead.
        let changedLines = (full.additions ?? 0) + (full.deletions ?? 0);
        if (!full.changed_files) {
          const files = await this.http.all(`${repoPath}/pulls/${p.number}/files?limit=${this.limit}`, signal);
          changedLines = files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
        }
        changes.push({
          id: `${NAME}:${req.repo}#${p.number}`,
          kind: "pull_request",
          repo: req.repo,
          url: full.html_url,
          mergeSha: full.merge_commit_sha.toLowerCase(),
          mergedAt: iso(full.merged_at),
          author: account(full.user, this.bots),
          mergedBy: full.merged_by ? account(full.merged_by, this.bots) : null,
          reviews: reviews(revs, this.bots),
          changedLines,
          labels: (full.labels ?? []).map((l) => l.name).sort(),
        });
      }
    }

    if (req.kinds.includes("direct_push")) {
      // (b) Default-branch history from a pinned head, newest first (git's date order), until a whole
      //     page is older than the window. Forgejo ignores since/until here, so they are not sent.
      //     `req.head` (the frozen head, when verify passes it) is walked instead of the branch's tip.
      headSha = req.head ?? (await this.http.get(`${repoPath}/branches/${encodeURIComponent(branch)}`, signal)).data.commit.id;
      const history = await this.http.all(`${repoPath}/commits?sha=${headSha}&limit=${this.limit}&stat=true&verification=false&files=false`, signal, (page) =>
        page.some((c) => Date.parse(c.commit.committer.date) >= opens),
      );
      const seen = new Set();
      let open = history.filter((c) => {
        const t = Date.parse(c.commit.committer.date);
        if (seen.has(c.sha) || t < opens || t >= closes) return false;
        seen.add(c.sha);
        return true;
      });
      const inWin = open.length;
      // (c) Claim commits: merge_commit_sha first (no request), then each PR's commit list, read only
      //     while something is unclaimed. A rebase merge rewrites SHAs, so also match by rebaseKey.
      const known = new Set(since.map((p) => p.merge_commit_sha?.toLowerCase()).filter(Boolean));
      open = open.filter((c) => !known.has(c.sha.toLowerCase()));
      let byRebase = 0;
      for (const p of since) {
        if (open.length === 0) break;
        const listed = await this.http.all(`${repoPath}/pulls/${p.number}/commits?limit=${this.limit}&stat=false&verification=false&files=false`, signal);
        const shas = new Set(listed.map((c) => c.sha.toLowerCase()));
        const keys = new Set(listed.map(rebaseKey));
        open = open.filter((c) => {
          if (shas.has(c.sha.toLowerCase())) return false;
          if (!keys.has(rebaseKey(c))) return true;
          byRebase++;
          return false;
        });
      }
      for (const c of open) {
        changes.push({
          id: `${NAME}:${req.repo}@${c.sha.toLowerCase()}`,
          kind: "direct_push",
          repo: req.repo,
          url: c.html_url,
          mergeSha: c.sha.toLowerCase(),
          mergedAt: iso(c.commit.committer.date),
          author: commitAuthor(c, this.bots),
          mergedBy: null,
          reviews: [],
          changedLines: (c.stats?.additions ?? 0) + (c.stats?.deletions ?? 0),
          labels: [],
        });
      }
      diagnostics.push(
        { label: "default-branch commits in window", value: inWin },
        { label: "commits linked to a merged PR", value: inWin - open.length },
        { label: "rebased commits linked by author, author date and message", value: byRebase },
        { label: "direct pushes that are merge commits", value: open.filter((c) => (c.parents ?? []).length > 1).length },
      );
    }
    return { changes, defaultBranch: branch, limitations: LIMITATIONS, diagnostics, ...(headSha ? { headSha: headSha.toLowerCase() } : {}) };
  }
}

export default defineProvider({
  // The provider API version this plugin was WRITTEN for. Do not import PROVIDER_API_VERSION here:
  // a newer pr-rla would then make an old plugin claim a version it has never been checked against.
  providerApiVersion: 1,
  name: NAME,
  description: "Gitea / Forgejo (Codeberg): merged PRs, reviews and default-branch history (example plugin)",
  // Optional fields of the same API version: one review object per submitted review; the options that
  // change the population (hashed into the registration).
  reviewGranularity: "submission",
  populationOptions: ["base_url", "bots"],
  create(options, ctx) {
    return new GiteaProvider(options ?? {}, ctx);
  },
});
