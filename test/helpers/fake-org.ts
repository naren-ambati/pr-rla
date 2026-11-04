import { createHash } from "node:crypto";
import { makeRng } from "../../src/core/simulate.js";
import { fakeGitHub, type FakeCommit, type FakePr } from "./fake-github.js";

/**
 * A SYNTHETIC GitHub org (fixture kind: synthetic, test-design.md §U8; nothing here was recorded): `eligible`
 * ordinary repos with heavy-tailed activity in Q3 2026, plus archived repos and forks the default rule must leave
 * out, served by one mock that routes REST and GraphQL to a per-repo fakeGitHub. It can inject 429s, make a repo
 * answer 429 forever, hang after N requests (a killed process), and add or delete repos after the fact.
 *
 * P3: it serves GitHub's push log (`GET /repos/{o}/{r}/activity`, API 2022-11-28 shape) for every repo: the branch is
 * created at its base commit, each generated commit is pushed (or merged, for a PR's merge commit) when it is dated,
 * and every later update (`pushCommits`, `forcePush`) is recorded at the time the test gives, which is what the SCM
 * records and the pusher cannot set. `control.pushLog` withholds it (403/404) or drops old updates (retention).
 */

export const ORG = "acme-org";
export const WINDOW = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" };
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const oid = (tag: string) => createHash("sha1").update(tag).digest("hex");
const U = (login: string) => ({ __typename: "User", login });
const B = (login: string) => ({ __typename: "Bot", login });

export interface RepoSpec {
  name: string;
  /** The name its history was generated under (kept across a rename, so the history and its SHAs stay the same). */
  seedName?: string;
  /** GitHub's `created_at` (default 2020-01-01: before any window); null leaves it out, as a provider that does not say. */
  createdAt?: string | null;
  archived?: boolean;
  fork?: boolean;
  visibility?: "public" | "private" | "internal";
  /** PRs merged into main in the window, and direct pushes in the window. */
  prs: number;
  pushes: number;
  /** A repo with no commits at all. */
  empty?: boolean;
  /** Activity after the window closed (PRs merged and updated Oct 2026). */
  after?: number;
  /** The repo's first activity is after the window (it has nothing in it). */
  createdAfterWindow?: boolean;
  /**
   * P3: updates of the default branch after the generated history, in order, each recorded in the push log at `at`:
   * `head` is the branch's new tip (`commits` are new objects). Set by `pushCommits` and `forcePush`.
   */
  updates?: { at: string; head: string; commits: FakeCommit[] }[];
  /** A different owner it now lives under (a transfer): its path is `<transferredTo>/<name>`. */
  transferredTo?: string;
}

export interface OrgSpec {
  owner: string;
  repos: RepoSpec[];
  seed: number;
}

/** `eligible` ordinary repos with heavy-tailed sizes, plus `archived` archived ones and `forks` forks. */
export function orgSpec(o: { eligible: number; archived?: number; forks?: number; seed?: number; scale?: number; owner?: string }): OrgSpec {
  const rng = makeRng(o.seed ?? 11);
  const scale = o.scale ?? 1;
  const size = () => {
    const u = rng();
    const prs = Math.max(2, Math.round((3 + u ** 2.5 * 260) * scale));
    return { prs, pushes: Math.floor(rng() * prs * 0.3), after: Math.floor(rng() * 6) };
  };
  const repos: RepoSpec[] = [];
  for (let i = 0; i < o.eligible; i++) repos.push({ name: `svc-${String(i).padStart(2, "0")}`, visibility: i % 7 === 3 ? "private" : i % 11 === 5 ? "internal" : "public", ...size() });
  // Archived repos were archived before the window: they hold no change in it (an archived repository is read-only).
  for (let i = 0; i < (o.archived ?? 0); i++) repos.push({ name: `old-${i}`, archived: true, ...size(), prs: 0, pushes: 0, after: 0 });
  for (let i = 0; i < (o.forks ?? 0); i++) repos.push({ name: `fork-${i}`, fork: true, ...size() });
  return { owner: o.owner ?? ORG, repos, seed: o.seed ?? 11 };
}

interface Generated {
  head: string;
  commits: FakeCommit[];
  prs: FakePr[];
}

function generate(owner: string, spec: RepoSpec, seed: number): Generated {
  const full = `${owner}/${spec.seedName ?? spec.name}`;
  const rng = makeRng(seed ^ [...full].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  const opens = Date.parse(WINDOW.opensAt);
  const span = Date.parse(WINDOW.closesAt) - opens;
  const base: FakeCommit = { oid: oid(`${full}:base`), date: "2026-06-15T09:00:00Z", parents: [] };
  if (spec.empty || spec.createdAfterWindow) {
    if (spec.empty) return { head: "", commits: [], prs: [] };
    const later: FakeCommit = { oid: oid(`${full}:first`), date: "2026-10-09T09:00:00Z", parents: [] };
    return { head: later.oid, commits: [later], prs: [] };
  }
  const items: { t: number; kind: "pr" | "push" }[] = [];
  for (let i = 0; i < spec.prs; i++) items.push({ t: opens + Math.floor((rng() * span) / 1000) * 1000, kind: "pr" });
  for (let i = 0; i < spec.pushes; i++) items.push({ t: opens + Math.floor((rng() * span) / 1000) * 1000, kind: "push" });
  items.sort((a, b) => a.t - b.t);
  const commits: FakeCommit[] = [base];
  const prs: FakePr[] = [];
  let prev = base.oid;
  let n = 0;
  // Every second counts: two commits never share a second, so the history order is unambiguous.
  let last = opens - 1000;
  for (const it of items) {
    const t = Math.max(it.t, last + 1000);
    last = t;
    if (it.kind === "pr") {
      n++;
      const mergeSha = oid(`${full}:pr${n}`);
      const reviewed = rng() < 0.35;
      prs.push({
        number: n,
        base: "main",
        mergedAt: iso(t),
        updatedAt: iso(t + 2000),
        mergeCommit: mergeSha,
        author: n % 3 === 0 ? B("copilot-swe-agent") : U("bob"),
        mergedBy: U("maint"),
        reviews: reviewed
          ? [{ state: "APPROVED", submittedAt: iso(t - 3_600_000), author: U("carol") }]
          : [{ state: "COMMENTED", submittedAt: iso(t - 1_800_000), author: B("copilot-pull-request-reviewer") }],
        additions: 1 + Math.floor(rng() * 200),
        deletions: Math.floor(rng() * 50),
      });
      commits.push({ oid: mergeSha, date: iso(t), parents: [prev], prs: [{ number: n, merged: true, baseRefName: "main" }], lines: 10 });
      prev = mergeSha;
    } else {
      const sha = oid(`${full}:push${t}`);
      commits.push({ oid: sha, date: iso(t), parents: [prev], author: { name: "Dev", email: "dev@example.invalid", login: "maint" }, lines: 3 });
      prev = sha;
    }
  }
  // Noise the REST list carries: a PR merged into another branch, a closed unmerged PR.
  prs.push({ number: 9000, base: "release", mergedAt: iso(opens + span / 2), updatedAt: iso(opens + span / 2 + 1000), mergeCommit: oid(`${full}:rel`), author: U("bob"), mergedBy: U("maint"), reviews: [], additions: 1, deletions: 0 });
  prs.push({ number: 9001, base: "main", mergedAt: null, updatedAt: iso(opens + span / 3), mergeCommit: null, author: U("bob"), mergedBy: null, reviews: [], additions: 1, deletions: 0 });
  // Activity after the window closed.
  for (let i = 0; i < (spec.after ?? 0); i++) {
    n++;
    const t = Date.parse("2026-10-02T00:00:00Z") + i * 86_400_000;
    const sha = oid(`${full}:late${n}`);
    prs.push({ number: n, base: "main", mergedAt: iso(t), updatedAt: iso(t + 2000), mergeCommit: sha, author: U("bob"), mergedBy: U("maint"), reviews: [], additions: 2, deletions: 1 });
    commits.push({ oid: sha, date: iso(t), parents: [prev], prs: [{ number: n, merged: true, baseRefName: "main" }], lines: 2 });
    prev = sha;
  }
  if (spec.updates?.length) return { head: spec.updates.at(-1)!.head, commits: [...commits, ...spec.updates.flatMap((u) => u.commits)], prs };
  return { head: prev, commits, prs };
}

/** One GitHub activity entry (REST API 2022-11-28), as the fake serves it. */
interface FakeActivity {
  id: number;
  node_id: string;
  before: string;
  after: string;
  ref: string;
  timestamp: string;
  activity_type: string;
  actor: { login: string };
}

/**
 * The default branch's push log for a generated repo (P3), oldest first: created at its base, then each commit of the
 * generated (linear) history pushed or merged when it is dated, then every recorded update at its own time.
 */
function activityOf(owner: string, spec: RepoSpec, seed: number): FakeActivity[] {
  if (spec.empty) return [];
  const g = generate(owner, { ...spec, updates: [] }, seed);
  const byOid = new Map(g.commits.map((c) => [c.oid, c]));
  const chain: FakeCommit[] = [];
  for (let c = byOid.get(g.head); c; c = c.parents[0] ? byOid.get(c.parents[0]) : undefined) chain.unshift(c);
  const out: FakeActivity[] = [];
  const all = new Map(byOid);
  for (const u of spec.updates ?? []) for (const c of u.commits) all.set(c.oid, c);
  const reaches = (from: string, target: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const o = stack.pop()!;
      if (o === target) return true;
      if (seen.has(o) || !all.has(o)) continue;
      seen.add(o);
      stack.push(...all.get(o)!.parents);
    }
    return false;
  };
  const push = (before: string, after: string, at: string, type: string) => out.push({ id: 7_000_000 + out.length, node_id: `A_${out.length}`, before, after, ref: "refs/heads/main", timestamp: at, activity_type: type, actor: { login: "maint" } });
  let tip = "0".repeat(40);
  for (const c of chain) {
    push(tip, c.oid, c.date, tip === "0".repeat(40) ? "branch_creation" : c.prs?.length ? "pr_merge" : "push");
    tip = c.oid;
  }
  for (const u of spec.updates ?? []) {
    push(tip, u.head, u.at, reaches(u.head, tip) ? "push" : "force_push");
    tip = u.head;
  }
  return out;
}

/**
 * The repo as the SCM shows it at `nowMs` (P3, `OrgControl.now`): its generated commits are pushed when they are
 * dated and its updates when the test says, so neither is there before that; a pull request is merged at its merge
 * time. Null: everything, whenever asked (the fake's default, as before P3).
 */
function generateAt(owner: string, spec: RepoSpec, seed: number, nowMs: number | null): Generated {
  if (nowMs === null) return generate(owner, spec, seed);
  const g0 = generate(owner, { ...spec, updates: [] }, seed);
  const commits0 = g0.commits.filter((c) => Date.parse(c.date) <= nowMs);
  const ups = (spec.updates ?? []).filter((u) => Date.parse(u.at) <= nowMs);
  const prs = g0.prs.filter((p) => (p.mergedAt === null ? Date.parse(p.updatedAt) <= nowMs : Date.parse(p.mergedAt) <= nowMs));
  return { head: ups.length ? ups.at(-1)!.head : (commits0.at(-1)?.oid ?? ""), commits: [...commits0, ...ups.flatMap((u) => u.commits)], prs };
}

/** The generated head and commits of a repo spec (for tests that push on top of it). */
export function generatedHistory(owner: string, spec: RepoSpec, seed: number, nowMs: number | null = null): { head: string; commits: FakeCommit[] } {
  const g = generateAt(owner, spec, seed, nowMs);
  return { head: g.head, commits: g.commits };
}

export interface OrgControl {
  /** After this many requests every request hangs forever (a killed process). Null: never. */
  hangAfter: number | null;
  /** Called once, the first time a request hangs. */
  onHang?: () => void;
  /** Every request takes this long on the given clock (the test's fake clock), as a slow server would. Null: none. */
  latency: { ms: number; sleep: (ms: number) => Promise<void> } | null;
  /** Every Nth request (counting all) is answered 429 with Retry-After: 1. Null: none. */
  every429: number | null;
  /** Repos whose every request is answered 429 (Retry-After: 1) until removed from the set. */
  stuck: Set<string>;
  /** Repos answered 404 (deleted) or 403 (not visible), REST and GraphQL, metadata included; still in the org listing. */
  gone: Map<string, 403 | 404>;
  /**
   * Repos the token cannot see, as GitHub treats a private repo for a token without access: left out of the org listing,
   * and 404 on every endpoint (REST, GraphQL NOT_FOUND, metadata).
   */
  invisible: Set<string>;
  /**
   * The token's identity: its login, the X-OAuth-Scopes header it sends (null: a fine-grained or app token, no header),
   * and its role in the org (null: not a member).
   */
  viewer: { login: string; scopes: string | null; role: "admin" | "member" | null; installation?: { selection: "all" | "selected" } };
  /**
   * P3: the push log per repo (`*` for every repo): 403 or 404 for the activity endpoint, or `{ keepAfter }` to keep
   * only updates after that instant (a retention limit). Absent: the whole log is served.
   */
  pushLog: Map<string, 403 | 404 | { keepAfter: string }>;
  /** P3: GitHub's `total_private_repos` on `GET /orgs/{owner}`: "auto" counts the private and internal repos, a number is sent as is, null leaves it out (a token without admin:org). */
  orgTotalPrivate: number | "auto" | null;
  /** P3: the SCM's clock (the test's): commits, merges and updates appear when they happen. Null: everything is there from the start. */
  now: (() => number) | null;
}

export function fakeOrg(spec: OrgSpec) {
  const control: OrgControl = { hangAfter: null, latency: null, every429: null, stuck: new Set(), gone: new Map(), invisible: new Set(), viewer: { login: "auditor", scopes: "read:org, repo", role: "admin" }, pushLog: new Map(), orgTotalPrivate: null, now: null };
  const specs = new Map(spec.repos.map((r) => [`${spec.owner}/${r.name}`, r]));
  const ids = new Map<string, number>();
  /** The repo's stable id: assigned in name order at the first listing (or first lookup), kept across a rename. */
  const idOf = (full: string) => {
    if (!ids.has(full)) {
      for (const name of [...specs.keys()].sort()) if (!ids.has(name)) ids.set(name, 1000 + ids.size);
      if (!ids.has(full)) ids.set(full, 1000 + ids.size);
    }
    return ids.get(full)!;
  };
  const repoJson = (name: string, s: RepoSpec) => {
    const visibility = s.visibility ?? "public";
    return { full_name: name, id: idOf(name), default_branch: "main", archived: s.archived === true, fork: s.fork === true, private: visibility !== "public", visibility, ...(s.createdAt === null ? {} : { created_at: s.createdAt ?? "2020-01-01T00:00:00Z" }) };
  };
  const inner = new Map<string, { key: string; f: ReturnType<typeof fakeGitHub> }>();
  const at = () => (control.now ? control.now() : null);
  const get = (full: string) => {
    const s = specs.get(full);
    if (!s) return undefined;
    const g = generateAt(spec.owner, s, spec.seed, at());
    // One per-repo fake for each state the repo is in (with `control.now`, the state moves with the clock).
    const key = `${g.head}|${g.commits.length}|${g.prs.length}`;
    let x = inner.get(full);
    if (!x || x.key !== key) {
      x = { key, f: fakeGitHub(full, g.head, g.commits, g.prs, { pageSize: 100 }) };
      inner.set(full, x);
    }
    return x.f;
  };
  let total = 0;
  const perRepo = new Map<string, number>();
  const active = new Map<string, number>();
  const renamed = new Map<string, string>();
  let peakRepos = 0;
  let hung = false;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    total++;
    if (control.hangAfter !== null && total > control.hangAfter) {
      if (!hung) {
        hung = true;
        control.onHang?.();
      }
      return new Promise<Response>(() => {});
    }
    const body = init?.body ? String(init.body) : "";
    let full: string | null = null;
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(?:pulls|activity|compare\/.*)$/.exec(url.pathname);
    if (m) full = `${m[1]}/${m[2]}`;
    else if (url.pathname === "/graphql") {
      const v = (JSON.parse(body) as { variables: { owner?: string; name?: string } }).variables;
      if (v.owner && v.name) full = `${v.owner}/${v.name}`;
    }
    if (full) perRepo.set(full, (perRepo.get(full) ?? 0) + 1);
    // A slow server: the request takes `latency.ms` on the test's clock, and the repos with a request in flight are counted.
    const key = full;
    if (key) {
      active.set(key, (active.get(key) ?? 0) + 1);
      peakRepos = Math.max(peakRepos, [...active.values()].filter((v) => v > 0).length);
    }
    try {
      if (control.latency) await control.latency.sleep(control.latency.ms);
      return await route(url, input, init, body, full);
    } finally {
      if (key) active.set(key, active.get(key)! - 1);
    }
  }) as typeof fetch;

  const route = async (url: URL, input: string | URL | Request, init: RequestInit | undefined, body: string, full: string | null): Promise<Response> => {
    if (control.every429 !== null && total % control.every429 === 0) return json({ message: "secondary rate limit" }, 429, { "retry-after": "1" });
    if (full && control.stuck.has(full)) return json({ message: "secondary rate limit" }, 429, { "retry-after": "1" });
    // Repo metadata (U8, describeRepo): by path, or by the stable id.
    const meta = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const byId = /^\/repositories\/(\d+)$/.exec(url.pathname);
    if (meta) full = `${meta[1]}/${meta[2]}`;
    if (byId) full = [...specs.keys()].find((name) => idOf(name) === Number(byId[1])) ?? `#${byId[1]}`;
    if (full && control.invisible.has(full)) {
      if (url.pathname === "/graphql") return json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${full}'.` }] });
      return json({ message: "Not Found" }, 404);
    }
    if (full && control.gone.has(full)) {
      const status = control.gone.get(full)!;
      if (url.pathname === "/graphql") return json({ data: { repository: null }, errors: [{ type: status === 404 ? "NOT_FOUND" : "FORBIDDEN", message: status === 404 ? `Could not resolve to a Repository with the name '${full}'.` : `Resource not accessible: ${full}` }] });
      return json({ message: status === 404 ? "Not Found" : "Forbidden" }, status);
    }
    if (meta || byId) {
      const s = full ? specs.get(full) : undefined;
      // GitHub redirects a renamed repository's old path to its new one (301), on REST.
      if (!s && full && renamed.has(full)) return new Response(null, { status: 301, headers: { location: `https://api.github.com/repos/${renamed.get(full)}` } });
      return s ? json(repoJson(full!, s)) : json({ message: "Not Found" }, 404);
    }
    const list = /^\/orgs\/([^/]+)\/repos$/.exec(url.pathname);
    if (list) {
      if (list[1] !== spec.owner) return json({ message: "Not Found" }, 404);
      for (const name of [...specs.keys()].sort()) idOf(name);
      const all = [...specs]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .filter(([name]) => !control.invisible.has(name) && name.startsWith(`${spec.owner}/`))
        .map(([name, s]) => repoJson(name, s));
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const next: Record<string, string> = page * per < all.length ? { link: `<https://api.github.com/orgs/${spec.owner}/repos?type=all&per_page=${per}&page=${page + 1}>; rel="next"` } : {};
      return json(all.slice((page - 1) * per, page * per), 200, next);
    }
    // The push log (P3): GitHub's repository activity for the default branch, newest first, paged.
    const act = /^\/repos\/([^/]+)\/([^/]+)\/activity$/.exec(url.pathname);
    if (act) {
      const name = `${act[1]}/${act[2]}`;
      const s = specs.get(name);
      if (!s) return json({ message: "Not Found" }, 404);
      const rule = control.pushLog.get(name) ?? control.pushLog.get("*");
      if (rule === 403 || rule === 404) return json({ message: rule === 403 ? "Resource not accessible by personal access token" : "Not Found" }, rule);
      const ref = url.searchParams.get("ref");
      const nowMs = at();
      let all = ref && ref !== "refs/heads/main" && ref !== "main" ? [] : activityOf(spec.owner, s, spec.seed).filter((e) => nowMs === null || Date.parse(e.timestamp) <= nowMs).reverse();
      if (rule) all = all.filter((e) => Date.parse(e.timestamp) > Date.parse(rule.keepAfter));
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return json(all.slice((page - 1) * per, page * per), 200, page * per < all.length ? { link: `<${next.href}>; rel="next"` } : {});
    }
    // The token's identity and its org membership (U8, listingVisibility).
    const scopeHeaders: Record<string, string> = control.viewer.scopes === null ? {} : { "x-oauth-scopes": control.viewer.scopes };
    if (control.viewer.installation) {
      // A GitHub App installation token (P3): it is not a user.
      if (url.pathname === "/user") return json({ message: "Resource not accessible by integration" }, 403);
      if (url.pathname === "/installation/repositories") {
        const first = [...specs.keys()].sort().find((r) => r.startsWith(`${spec.owner}/`));
        return json({ total_count: specs.size, repository_selection: control.viewer.installation.selection, repositories: first ? [{ full_name: first, owner: { login: spec.owner } }] : [] });
      }
    }
    if (url.pathname === "/user") return json({ login: control.viewer.login }, 200, scopeHeaders);
    if (url.pathname === `/orgs/${spec.owner}`) {
      const total = control.orgTotalPrivate === "auto" ? [...specs.values()].filter((r) => (r.visibility ?? "public") !== "public").length : control.orgTotalPrivate;
      return json({ login: spec.owner, ...(total !== null ? { total_private_repos: total } : {}) }, 200, scopeHeaders);
    }
    if (url.pathname === `/user/memberships/orgs/${spec.owner}`) return control.viewer.role ? json({ state: "active", role: control.viewer.role }, 200, scopeHeaders) : json({ message: "Not Found" }, 404);
    if (/^\/users\/|^\/orgs\//.test(url.pathname)) return json({ message: "Not Found" }, 404);
    if (full && specs.get(full) && (specs.get(full)!.empty || generateAt(spec.owner, specs.get(full)!, spec.seed, at()).head === "") && url.pathname === "/graphql" && body.includes("defaultBranchRef")) return json({ data: { repository: { defaultBranchRef: null } } });
    const target = full ? get(full) : undefined;
    if (!target) return full ? json({ message: "Not Found" }, 404) : new Response("not found", { status: 404 });
    return target.fetch(input, init);
  };

  return {
    fetch: f,
    control,
    requests: () => total,
    requestsFor: (full: string) => perRepo.get(full) ?? 0,
    /** The most repos that had a request in flight at once (meaningful with `control.latency`). */
    peakReposInFlight: () => peakRepos,
    /** Removes a repo, as deleting it would: it leaves the listing and its endpoints answer 404. */
    removeRepo(name: string) {
      specs.delete(`${spec.owner}/${name}`);
      inner.delete(`${spec.owner}/${name}`);
    },
    /** Adds (or replaces) a repo; it appears in the next listing. */
    addRepo(r: RepoSpec) {
      specs.set(`${spec.owner}/${r.name}`, r);
      inner.delete(`${spec.owner}/${r.name}`);
    },
    /** Renames a repo, as GitHub does: the same id and history under the new name; the old name is gone from the listing. */
    renameRepo(from: string, to: string) {
      const old = `${spec.owner}/${from}`;
      const s = specs.get(old)!;
      const id = idOf(old);
      specs.delete(old);
      inner.delete(old);
      specs.set(`${spec.owner}/${to}`, { ...s, name: to, seedName: s.seedName ?? from });
      ids.set(`${spec.owner}/${to}`, id);
      ids.delete(old);
      renamed.set(old, `${spec.owner}/${to}`);
    },
    /** Changes a repo's attributes in place (archive, visibility...), keeping its id and history. */
    updateRepo(name: string, change: Partial<Omit<RepoSpec, "name" | "seedName">>) {
      const full = `${spec.owner}/${name}`;
      specs.set(full, { ...specs.get(full)!, ...change });
      inner.delete(full);
    },
    /** Transfers a repo to another owner, as GitHub does: same id and history, path `<owner>/<name>`, gone from this org's listing. */
    transferRepo(name: string, owner: string) {
      const old = `${spec.owner}/${name}`;
      const s = specs.get(old)!;
      const id = idOf(old);
      specs.delete(old);
      inner.delete(old);
      specs.set(`${owner}/${name}`, { ...s, seedName: s.seedName ?? name, transferredTo: owner });
      ids.set(`${owner}/${name}`, id);
      ids.delete(old);
    },
    /**
     * Pushes commits on top of a repo's history (the last becomes its head), e.g. after freeze. The push log records the
     * update at `at` (default: the last commit's date, as if it was pushed when made).
     */
    pushCommits(name: string, pushed: FakeCommit[], o: { at?: string } = {}) {
      const full = `${spec.owner}/${name}`;
      const s = specs.get(full)!;
      specs.set(full, { ...s, updates: [...(s.updates ?? []), { at: o.at ?? pushed.at(-1)!.date, head: pushed.at(-1)!.oid, commits: pushed }] });
      inner.delete(full);
    },
    /** P3: moves the default branch to `head` (a commit it holds) at `at`; the push log calls it a force push unless it descends from the tip. */
    forcePush(name: string, head: string, at: string) {
      const full = `${spec.owner}/${name}`;
      const s = specs.get(full)!;
      specs.set(full, { ...s, updates: [...(s.updates ?? []), { at, head, commits: [] }] });
      inner.delete(full);
    },
    /** P3: the push log the fake serves for a repo (oldest first). */
    activity: (name: string) => activityOf(spec.owner, specs.get(`${spec.owner}/${name}`)!, spec.seed),
    /** A repo's head and commits now. */
    history(name: string) {
      const s = specs.get(`${spec.owner}/${name}`)!;
      return generatedHistory(spec.owner, s, spec.seed, at());
    },
    /** The repo's stable id (as listings show it). */
    idOf: (name: string) => String(idOf(`${spec.owner}/${name}`)),
    spec,
  };
}

export type FakeOrg = ReturnType<typeof fakeOrg>;
