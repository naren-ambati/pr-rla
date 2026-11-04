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
  for (let i = 0; i < (o.archived ?? 0); i++) repos.push({ name: `old-${i}`, archived: true, ...size() });
  for (let i = 0; i < (o.forks ?? 0); i++) repos.push({ name: `fork-${i}`, fork: true, ...size() });
  return { owner: o.owner ?? ORG, repos, seed: o.seed ?? 11 };
}

interface Generated {
  head: string;
  commits: FakeCommit[];
  prs: FakePr[];
}

function generate(owner: string, spec: RepoSpec, seed: number): Generated {
  const full = `${owner}/${spec.name}`;
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
  return { head: prev, commits, prs };
}

export interface OrgControl {
  /** After this many requests every request hangs forever (a killed process). Null: never. */
  hangAfter: number | null;
  /** Called once, the first time a request hangs. */
  onHang?: () => void;
  /** Every Nth request (counting all) is answered 429 with Retry-After: 1. Null: none. */
  every429: number | null;
  /** Repos whose every request is answered 429 (Retry-After: 1) until removed from the set. */
  stuck: Set<string>;
  /** Repos answered 404 (deleted) or 403 (not visible), REST and GraphQL. */
  gone: Map<string, 403 | 404>;
}

export function fakeOrg(spec: OrgSpec) {
  const control: OrgControl = { hangAfter: null, every429: null, stuck: new Set(), gone: new Map() };
  const specs = new Map(spec.repos.map((r) => [`${spec.owner}/${r.name}`, r]));
  const ids = new Map<string, number>();
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
    const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname);
    if (m) full = `${m[1]}/${m[2]}`;
    else if (url.pathname === "/graphql") {
      const v = (JSON.parse(body) as { variables: { owner?: string; name?: string } }).variables;
      if (v.owner && v.name) full = `${v.owner}/${v.name}`;
    }
    if (full) perRepo.set(full, (perRepo.get(full) ?? 0) + 1);
    if (control.every429 !== null && total % control.every429 === 0) return json({ message: "secondary rate limit" }, 429, { "retry-after": "1" });
    if (full && control.stuck.has(full)) return json({ message: "secondary rate limit" }, 429, { "retry-after": "1" });
    if (full && control.gone.has(full)) {
      const status = control.gone.get(full)!;
      if (url.pathname === "/graphql") return json({ data: { repository: null }, errors: [{ type: status === 404 ? "NOT_FOUND" : "FORBIDDEN", message: status === 404 ? `Could not resolve to a Repository with the name '${full}'.` : `Resource not accessible: ${full}` }] });
      return json({ message: status === 404 ? "Not Found" : "Forbidden" }, status);
    }
    const list = /^\/orgs\/([^/]+)\/repos$/.exec(url.pathname);
    if (list) {
      if (list[1] !== spec.owner) return json({ message: "Not Found" }, 404);
      const all = [...specs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, s]) => {
        if (!ids.has(name)) ids.set(name, 1000 + ids.size);
        const visibility = s.visibility ?? "public";
        return { full_name: name, id: ids.get(name)!, default_branch: "main", archived: s.archived === true, fork: s.fork === true, private: visibility !== "public", visibility };
      });
      const per = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const next: Record<string, string> = page * per < all.length ? { link: `<https://api.github.com/orgs/${spec.owner}/repos?type=all&per_page=${per}&page=${page + 1}>; rel="next"` } : {};
      return json(all.slice((page - 1) * per, page * per), 200, next);
    }
    if (/^\/users\//.test(url.pathname)) return json({ message: "Not Found" }, 404);
    if (full && specs.get(full)?.empty && url.pathname === "/graphql" && body.includes("defaultBranchRef")) return json({ data: { repository: { defaultBranchRef: null } } });
    const target = full ? get(full) : undefined;
    if (!target) return full ? json({ message: "Not Found" }, 404) : new Response("not found", { status: 404 });
    return target.fetch(input, init);
  }) as typeof fetch;

  return {
    fetch: f,
    control,
    requests: () => total,
    requestsFor: (full: string) => perRepo.get(full) ?? 0,
    /** Adds (or replaces) a repo; it appears in the next listing. */
    addRepo(r: RepoSpec) {
      specs.set(`${spec.owner}/${r.name}`, r);
      inner.delete(`${spec.owner}/${r.name}`);
    },
    spec,
  };
}

export type FakeOrg = ReturnType<typeof fakeOrg>;
