import { createHash } from "node:crypto";
import { makeRng } from "../../src/core/simulate.js";
import { fakeGitHub, type FakeCommit, type FakePr } from "./fake-github.js";

/**
 * A SYNTHETIC GitHub org (fixture kind: synthetic, test-design.md §U8; nothing here was recorded): `eligible`
 * ordinary repos with heavy-tailed activity in Q3 2026, plus archived repos and forks the default rule must leave
 * out, served by one mock that routes REST and GraphQL to a per-repo fakeGitHub. It can inject 429s, make a repo
 * answer 429 forever, hang after N requests (a killed process), and add or delete repos after the fact.
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
  /** GitHub's `created_at` (default 2020-01-01: before any window). */
  createdAt?: string;
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
  /** Commits pushed later on top of the generated history (the last one is the new head), e.g. after freeze. */
  pushed?: FakeCommit[];
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
  if (spec.pushed?.length) return { head: spec.pushed.at(-1)!.oid, commits: [...commits, ...spec.pushed], prs };
  return { head: prev, commits, prs };
}

/** The generated head and commits of a repo spec (for tests that push on top of it). */
export function generatedHistory(owner: string, spec: RepoSpec, seed: number): { head: string; commits: FakeCommit[] } {
  const g = generate(owner, spec, seed);
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
  viewer: { login: string; scopes: string | null; role: "admin" | "member" | null };
}

export function fakeOrg(spec: OrgSpec) {
  const control: OrgControl = { hangAfter: null, latency: null, every429: null, stuck: new Set(), gone: new Map(), invisible: new Set(), viewer: { login: "auditor", scopes: "read:org, repo", role: "admin" } };
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
    return { full_name: name, id: idOf(name), default_branch: "main", archived: s.archived === true, fork: s.fork === true, private: visibility !== "public", visibility, created_at: s.createdAt ?? "2020-01-01T00:00:00Z" };
  };
  const inner = new Map<string, ReturnType<typeof fakeGitHub>>();
  const get = (full: string) => {
    let f = inner.get(full);
    const s = specs.get(full);
    if (!f && s) {
      const g = generate(spec.owner, s, spec.seed);
      f = fakeGitHub(full, g.head, g.commits, g.prs, { pageSize: 100 });
      inner.set(full, f);
    }
    return f;
  };
  let total = 0;
  const perRepo = new Map<string, number>();
  const active = new Map<string, number>();
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
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(?:pulls|compare\/.*)$/.exec(url.pathname);
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
    // The token's identity and its org membership (U8, listingVisibility).
    const scopeHeaders: Record<string, string> = control.viewer.scopes === null ? {} : { "x-oauth-scopes": control.viewer.scopes };
    if (url.pathname === "/user") return json({ login: control.viewer.login }, 200, scopeHeaders);
    if (url.pathname === `/orgs/${spec.owner}`) return json({ login: spec.owner }, 200, scopeHeaders);
    if (url.pathname === `/user/memberships/orgs/${spec.owner}`) return control.viewer.role ? json({ state: "active", role: control.viewer.role }, 200, scopeHeaders) : json({ message: "Not Found" }, 404);
    if (/^\/users\/|^\/orgs\//.test(url.pathname)) return json({ message: "Not Found" }, 404);
    if (full && specs.get(full)?.empty && url.pathname === "/graphql" && body.includes("defaultBranchRef")) return json({ data: { repository: { defaultBranchRef: null } } });
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
    /** Pushes commits on top of a repo's history (the last becomes its head), e.g. after freeze. */
    pushCommits(name: string, pushed: FakeCommit[]) {
      const full = `${spec.owner}/${name}`;
      const s = specs.get(full)!;
      specs.set(full, { ...s, pushed: [...(s.pushed ?? []), ...pushed] });
      inner.delete(full);
    },
    /** A repo's head and commits now. */
    history(name: string) {
      const s = specs.get(`${spec.owner}/${name}`)!;
      return generatedHistory(spec.owner, s, spec.seed);
    },
    /** The repo's stable id (as listings show it). */
    idOf: (name: string) => String(idOf(`${spec.owner}/${name}`)),
    spec,
  };
}

export type FakeOrg = ReturnType<typeof fakeOrg>;
