import { REPO_VISIBILITIES, type RepoRef, type RepoSetRule, type RepoVisibility, type ScmProvider } from "../sdk/provider.js";
import { probeRepo } from "./failures.js";
import type { GoneRepo, ListedRepo, RegisteredRepo, RepoListing, RepoSet } from "./records.js";

/**
 * Repo sets (U8, FR5.1/FR5.6/FR5.7): what an audit covers, how a rule resolves, and the population
 * rules that hold for every caller (`validateRepoSet`, `resolveRepoSet`). A single repository is a pool
 * of one: `{ kind: "repo" }` resolves to one entry through the same code.
 *
 * Pure apart from the one `provider.listRepos` call a `rule` makes; no I/O of its own.
 */

/** The repo set cannot be used: a malformed registration, or a rule the provider cannot resolve. */
export class RepoSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoSetError";
  }
}

/** One repository of a resolved set, sorted by `repo` (UTF-16 order). `repoId` is null unless `listRepos` supplied it. */
export interface ResolvedRepo {
  repo: string;
  repoId: string | null;
}

export const DEFAULT_INCLUDE: readonly string[] = ["*"];
const REPO_PATH = /^[^\s/:]+(?:\/[^\s/]+)+$/;
const SCHEME = /^([a-z0-9][a-z0-9-]*):(.+)$/;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const lower = (s: string) => s.toLowerCase();

// ---------------------------------------------------------------------------
// Globs over the repo path
// ---------------------------------------------------------------------------

/** `*` within a path segment, `**` across segments, `?` one character. Case-insensitive (SCMs treat repo names so). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** A pattern with a `/` matches the whole repo path; one without matches the path's last segment. */
export function globMatches(pattern: string, repoPath: string): boolean {
  const subject = pattern.includes("/") ? repoPath : (repoPath.split("/").at(-1) ?? repoPath);
  return globToRegExp(pattern).test(subject);
}

const underOwner = (owner: string, repo: string) => lower(repo).startsWith(`${lower(owner)}/`);

/** Whether a repository path is inside the rule: under its owner, matching an include glob and no exclude glob. Flags need a RepoRef; see `applyRule`. */
export function repoMatchesRule(rule: RepoSetRule, repo: string): boolean {
  return underOwner(rule.owner, repo) && rule.include.some((g) => globMatches(g, repo)) && !rule.exclude.some((g) => globMatches(g, repo));
}

/**
 * Every clause of the rule that excludes a repository, in rule order (empty: the rule matches it): `owner` (not under
 * the rule's owner), `include` (no include glob matches its path), `exclude:<glob>`, `archived`, `fork`,
 * `visibility:<v>`. All but `owner` and `fork` are attributes the repo's owners can change at any time (its name, its
 * archive state, its visibility): see `isMutableExclusion`.
 */
export function ruleExclusions(rule: RepoSetRule, ref: Pick<RepoRef, "repo" | "archived" | "fork" | "visibility">): string[] {
  const out: string[] = [];
  if (!underOwner(rule.owner, ref.repo)) out.push("owner");
  if (!rule.include.some((g) => globMatches(g, ref.repo))) out.push("include");
  const ex = rule.exclude.find((g) => globMatches(g, ref.repo));
  if (ex !== undefined) out.push(`exclude:${ex}`);
  if (ref.archived && !rule.archived) out.push("archived");
  if (ref.fork && !rule.forks) out.push("fork");
  if (!rule.visibility.includes(ref.visibility)) out.push(`visibility:${ref.visibility}`);
  return out;
}

/** A clause the repo's owners can change after registration: its name (include, exclude), archive state or visibility. */
export function isMutableExclusion(clause: string): boolean {
  return clause === "include" || clause === "archived" || clause.startsWith("exclude:") || clause.startsWith("visibility:");
}

/** How an exclusion reads in output: `archived`, `visibility private`, `no include glob matches`, `exclude glob *-sandbox`. */
export function describeExclusions(clauses: readonly string[]): string {
  return clauses.map((c) => (c === "include" ? "no include glob matches its name" : c.startsWith("exclude:") ? `exclude glob ${c.slice(8)}` : c.startsWith("visibility:") ? `visibility ${c.slice(11)}` : c === "owner" ? "not under the owner" : c)).join(", ");
}

/** The repositories a rule keeps: globs and the archived, fork and visibility flags (FR5.7: archived and forks are out unless the rule says so). */
export function applyRule(rule: RepoSetRule, refs: readonly RepoRef[]): RepoRef[] {
  return refs.filter((r) => ruleExclusions(rule, r).length === 0);
}

/**
 * The entry of `items` that is the same repository as `key`: by stable id first, then by path (case-insensitive) where
 * either id is unknown. Two known, different ids are two repositories even under one path (deleted and created again).
 */
export function matchRepo<T extends { repo: string; repoId?: string | null }>(items: readonly T[], key: { repo: string; repoId?: string | null }): T | undefined {
  if (key.repoId) {
    const byId = items.find((x) => x.repoId === key.repoId);
    if (byId) return byId;
  }
  const name = lower(key.repo);
  return items.find((x) => lower(x.repo) === name && (!key.repoId || !x.repoId));
}

// ---------------------------------------------------------------------------
// Parsing and normalising what .pr-rla.yml says
// ---------------------------------------------------------------------------

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) throw new RepoSetError(`${what} must be a list of non-empty strings`);
  return v.map((x: string) => x.trim());
}

/** The strings of a list, as a sorted set (UTF-16 order), so two spellings of one rule sign the same bytes. */
const sortedUnique = (xs: readonly string[]) => [...new Set(xs)].sort(cmp);

/**
 * The repo set a config's `repo:` / `repos:` keys describe. `repo: o/r` is a pool of one. `repos:` is
 * either a list of `owner/name` or a rule `{ owner, include?, exclude?, archived?, forks?, visibility? }`.
 * Defaults (FR5.7): archived repos and forks excluded, every visibility the token can see included.
 */
export function normalizeRepoSet(raw: { repo?: unknown; repos?: unknown }): RepoSet {
  if (raw.repos === undefined || raw.repos === null) {
    if (typeof raw.repo !== "string" || raw.repo.length === 0) throw new RepoSetError('"repo" is required (e.g. github/gh-aw)');
    return { kind: "repo", repo: raw.repo };
  }
  if (raw.repo !== undefined && raw.repo !== null) throw new RepoSetError('set either "repo" (one repository) or "repos" (a list or a rule), not both');
  if (Array.isArray(raw.repos)) {
    const repos = sortedUnique(strings(raw.repos, "repos"));
    if (repos.length === 0) throw new RepoSetError("repos is empty; list the repositories, or give a rule { owner: <org> }");
    return { kind: "list", repos };
  }
  if (!isMap(raw.repos)) throw new RepoSetError('repos must be a list of "owner/name", or a rule such as { owner: my-org, exclude: ["*-archive"] }');
  const r = raw.repos;
  for (const k of Object.keys(r)) if (!["owner", "include", "exclude", "archived", "forks", "visibility"].includes(k)) throw new RepoSetError(`repos.${k} is not a setting (a rule takes owner, include, exclude, archived, forks, visibility)`);
  if (typeof r.owner !== "string" || r.owner.trim() === "" || /\s/.test(r.owner) || r.owner.startsWith("/") || r.owner.endsWith("/")) throw new RepoSetError("repos.owner must be the org, group or workspace name (for example my-org)");
  const flag = (v: unknown, name: string): boolean => {
    if (v === undefined || v === null) return false;
    if (typeof v !== "boolean") throw new RepoSetError(`repos.${name} must be true or false`);
    return v;
  };
  let visibility: RepoVisibility[] = [...REPO_VISIBILITIES];
  if (r.visibility !== undefined && r.visibility !== null) {
    const v = strings(r.visibility, "repos.visibility");
    const bad = v.find((x) => !REPO_VISIBILITIES.includes(x as RepoVisibility));
    if (bad !== undefined) throw new RepoSetError(`repos.visibility: "${bad}" is not one of ${REPO_VISIBILITIES.join(", ")}`);
    visibility = sortedUnique(v) as RepoVisibility[];
    if (visibility.length === 0) throw new RepoSetError("repos.visibility is empty, so no repository could match");
  }
  const include = r.include === undefined || r.include === null ? [...DEFAULT_INCLUDE] : sortedUnique(strings(r.include, "repos.include"));
  if (include.length === 0) throw new RepoSetError('repos.include is empty, so no repository could match; leave it out for "*"');
  return {
    kind: "rule",
    owner: r.owner.trim(),
    include,
    exclude: r.exclude === undefined || r.exclude === null ? [] : sortedUnique(strings(r.exclude, "repos.exclude")),
    archived: flag(r.archived, "archived"),
    forks: flag(r.forks, "forks"),
    visibility: visibility.sort(cmp),
  };
}

/** `github:acme/app` -> { scheme: "github", path: "acme/app" }; a bare `acme/app` has no scheme. */
export function splitScheme(entry: string): { scheme: string | null; path: string } {
  const m = SCHEME.exec(entry);
  return m && !m[2]!.startsWith("/") ? { scheme: m[1]!, path: m[2]! } : { scheme: null, path: entry };
}

// ---------------------------------------------------------------------------
// The population rules (AuditCore): every caller gets them
// ---------------------------------------------------------------------------

/**
 * The problems that make a repo set unusable with this provider; empty means usable. These are
 * population rules, not API checks (functional-design.md §U8; domain design finding R-03):
 * - one provider per pooled registration (FR5.6): a list that names repos on two providers, or on
 *   one that is not the configured provider, is refused;
 * - a `rule` needs `provider.listRepos`; without it `register` refuses and names the provider.
 */
export function repoSetProblems(set: RepoSet, provider: Pick<ScmProvider, "name" | "listRepos">): string[] {
  const p: string[] = [];
  switch (set.kind) {
    case "repo":
      break; // the provider reports a malformed repo itself, as it always has
    case "list": {
      if (set.repos.length === 0) p.push("the repo list is empty");
      const schemes = new Set<string>();
      const seen = new Map<string, string>();
      for (const entry of set.repos) {
        const { scheme, path } = splitScheme(entry);
        if (scheme) schemes.add(scheme);
        if (!REPO_PATH.test(path)) p.push(`"${entry}" must look like owner/name`);
        const k = lower(path);
        if (seen.has(k)) p.push(`${path} is listed twice (${seen.get(k)} and ${entry})`);
        else seen.set(k, entry);
      }
      if (schemes.size > 1) p.push(`one provider per pooled registration: the repo list names repositories on ${[...schemes].sort().join(" and ")}; register one audit per provider`);
      else if (schemes.size === 1 && !schemes.has(provider.name)) p.push(`one provider per pooled registration: the repo list names ${[...schemes][0]} repositories, but the provider is ${provider.name}`);
      break;
    }
    case "rule": {
      if (typeof provider.listRepos !== "function") p.push(`provider ${provider.name} cannot list an owner's repositories (it has no listRepos), so a repos rule cannot be resolved; name the repositories in a list, or use a provider that implements listRepos`);
      if (set.include.length === 0) p.push("the rule's include list is empty");
      if (set.visibility.length === 0) p.push("the rule's visibility list is empty");
      break;
    }
  }
  return p;
}

/** Throws RepoSetError with every problem `repoSetProblems` finds. */
export function validateRepoSet(set: RepoSet, provider: Pick<ScmProvider, "name" | "listRepos">): void {
  const problems = repoSetProblems(set, provider);
  if (problems.length) throw new RepoSetError(problems.join("; "));
}

/** The short name outputs and the config's `repo` field use for a set: the repo, `owner/*` for a rule, `n repos` for a list. */
export function repoSetLabel(set: RepoSet): string {
  return set.kind === "repo" ? set.repo : set.kind === "rule" ? `${set.owner}/*` : `${set.repos.length} repos`;
}

/** A one-line description for register and freeze output. */
export function describeRepoSet(set: RepoSet): string {
  switch (set.kind) {
    case "repo":
      return set.repo;
    case "list":
      return `list of ${set.repos.length} repositories`;
    case "rule":
      return `rule ${set.owner}: include ${set.include.join(", ")}${set.exclude.length ? ` · exclude ${set.exclude.join(", ")}` : ""} · archived ${set.archived ? "included" : "excluded"} · forks ${set.forks ? "included" : "excluded"} · visibility ${set.visibility.join(", ")}`;
  }
}

function refProblems(ref: unknown, owner: string): string | null {
  if (!ref || typeof ref !== "object") return "is not an object";
  const r = ref as Partial<RepoRef>;
  if (typeof r.repo !== "string" || !REPO_PATH.test(r.repo)) return `has no usable repo path (${JSON.stringify(r.repo)})`;
  if (!underOwner(owner, r.repo)) return `${r.repo} is not under ${owner}`;
  if (typeof r.id !== "string" || r.id === "") return `${r.repo} has no id`;
  if (typeof r.defaultBranch !== "string") return `${r.repo} has no defaultBranch`;
  if (typeof r.archived !== "boolean" || typeof r.fork !== "boolean") return `${r.repo} must say archived and fork as true or false`;
  if (!REPO_VISIBILITIES.includes(r.visibility as RepoVisibility)) return `${r.repo} has visibility ${JSON.stringify(r.visibility)}, not one of ${REPO_VISIBILITIES.join(", ")}`;
  return null;
}

/**
 * The repositories a set covers, resolved now, sorted by `repo`. A `rule` is resolved through
 * `provider.listRepos` and the core applies its globs and flags to what comes back (so providers
 * behave alike), re-validating every entry whatever the provider returned. A `list` or `repo` set
 * resolves to itself with `repoId: null`.
 */
export async function resolveRepoSet(provider: Pick<ScmProvider, "name" | "listRepos">, set: RepoSet): Promise<ResolvedRepo[]> {
  validateRepoSet(set, provider);
  if (set.kind === "repo") return [{ repo: set.repo, repoId: null }];
  if (set.kind === "list") return sortedUnique(set.repos.map((e) => splitScheme(e).path)).map((repo) => ({ repo, repoId: null }));
  const refs = await provider.listRepos!(set);
  if (!Array.isArray(refs)) throw new RepoSetError(`provider ${provider.name}: listRepos returned ${typeof refs}, not a list`);
  const seen = new Set<string>();
  for (const [i, ref] of refs.entries()) {
    const why = refProblems(ref, set.owner);
    if (why) throw new RepoSetError(`provider ${provider.name}: listRepos entry ${i} ${why}`);
    const k = lower(ref.repo);
    if (seen.has(k)) throw new RepoSetError(`provider ${provider.name}: listRepos returned ${ref.repo} twice`);
    seen.add(k);
  }
  return applyRule(set, refs)
    .map((r) => ({ repo: r.repo, repoId: r.id }))
    .sort((a, b) => cmp(a.repo, b.repo));
}

/** `listRepos` for a rule, every entry re-validated (well formed, under the owner, listed once). */
export async function listOwner(provider: Pick<ScmProvider, "name" | "listRepos">, set: RepoSetRule): Promise<RepoRef[]> {
  const refs = await provider.listRepos!(set);
  if (!Array.isArray(refs)) throw new RepoSetError(`provider ${provider.name}: listRepos returned ${typeof refs}, not a list`);
  const seen = new Set<string>();
  for (const [i, ref] of refs.entries()) {
    const why = refProblems(ref, set.owner);
    if (why) throw new RepoSetError(`provider ${provider.name}: listRepos entry ${i} ${why}`);
    const k = lower(ref.repo);
    if (seen.has(k)) throw new RepoSetError(`provider ${provider.name}: listRepos returned ${ref.repo} twice`);
    seen.add(k);
  }
  return refs;
}

/** A RepoRef as a manifest listing entry, with the rule's clauses that exclude it. */
export function listedRepo(rule: RepoSetRule, r: RepoRef): ListedRepo {
  return { repo: r.repo, repoId: r.id, defaultBranch: r.defaultBranch, archived: r.archived, fork: r.fork, visibility: r.visibility, createdAt: typeof r.createdAt === "string" ? r.createdAt : null, excludedBy: ruleExclusions(rule, r) };
}

/** The unfiltered listing of a rule's owner, as a manifest records it (sorted by repo), with what the token could see. */
export async function ownerListing(provider: Pick<ScmProvider, "name" | "listRepos" | "listingVisibility">, set: RepoSetRule, refs?: readonly RepoRef[]): Promise<RepoListing> {
  const all = refs ?? (await listOwner(provider, set));
  const repos = all.map((r) => listedRepo(set, r)).sort((a, b) => cmp(a.repo, b.repo));
  const seen = typeof provider.listingVisibility === "function" ? await provider.listingVisibility(set) : null;
  const visibility = Object.fromEntries(
    REPO_VISIBILITIES.map((v) => {
      const proof = seen?.visibilities?.[v];
      const listed = repos.filter((r) => r.visibility === v).length;
      return [v, proof ? { listed, complete: proof.complete === true, reason: String(proof.reason) } : { listed, complete: null, reason: `provider ${provider.name} cannot say what its token sees (it has no listingVisibility)` }];
    }),
  ) as RepoListing["visibility"];
  return { owner: set.owner, identity: seen?.identity ?? null, visibility, repos };
}

/** What a pooled freeze lists: the pool, a rule's owner listing, and the registered repos that are gone. */
export interface PoolResolution {
  /** Sorted by repo, under each repo's path now. */
  pool: ResolvedRepo[];
  /** A rule's unfiltered owner listing; null for a repo or a list. */
  listing: RepoListing | null;
  /** Registered repos the owner's listing no longer holds and a repo-level probe found gone (404, or a documented hidden 403). */
  gone: GoneRepo[];
}

/**
 * The pool a freeze lists (U8; the review's findings 1 and 8): for a `rule`, the repos it matches now plus every
 * registered repo that still exists, whatever its archive state, visibility or name now, matched by id first. A
 * registered repo the listing no longer holds is probed once, by id: found (renamed, or transferred out of the owner),
 * it is in the pool under its path now; gone (404, or a documented hidden 403), it is recorded as gone with the
 * probe's evidence. Any other probe failure stops the freeze: nothing is skipped. A `list` or `repo` set is itself.
 */
export async function resolvePool(provider: Pick<ScmProvider, "name" | "listRepos" | "listingVisibility" | "describeRepo">, set: RepoSet, o: { registered?: readonly RegisteredRepo[]; now: () => string }): Promise<PoolResolution> {
  if (set.kind !== "rule") return { pool: await resolveRepoSet(provider, set), listing: null, gone: [] };
  validateRepoSet(set, provider);
  const refs = await listOwner(provider, set);
  const listing = await ownerListing(provider, set, refs);
  const pool = new Map<string, ResolvedRepo>();
  for (const r of applyRule(set, refs)) pool.set(r.id, { repo: r.repo, repoId: r.id });
  const gone: GoneRepo[] = [];
  const asResolved = refs.map((r) => ({ repo: r.repo, repoId: r.id }));
  for (const reg of o.registered ?? []) {
    const now = matchRepo(asResolved, reg);
    if (now) {
      pool.set(now.repoId, now);
      continue;
    }
    const probed = await probeRepo(provider, { repo: reg.repo, id: reg.repoId });
    switch (probed.kind) {
      case "exists":
        pool.set(probed.ref.id, { repo: probed.ref.repo, repoId: probed.ref.id });
        break;
      case "gone":
        gone.push({ repo: reg.repo, repoId: reg.repoId, status: probed.status, detail: probed.detail, probedAt: o.now() });
        break;
      case "transient":
        throw probed.error; // a rate limit or an outage: the freeze stops (exit 4) and the same command finishes it
      case "unsupported":
        throw new RepoSetError(`registered repo ${reg.repo} (id ${reg.repoId}) is not in ${set.owner}'s listing, and provider ${provider.name} cannot probe a repository (it has no describeRepo) to tell whether it is gone; nothing is skipped`);
      default:
        throw new RepoSetError(`registered repo ${reg.repo} (id ${reg.repoId}) is not in ${set.owner}'s listing, and probing it failed (${probed.kind === "no-access" ? `no access: ${probed.detail}` : probed.detail}); nothing is skipped`);
    }
  }
  return { pool: [...pool.values()].sort((a, b) => cmp(a.repo, b.repo)), listing, gone: gone.sort((a, b) => cmp(a.repo, b.repo)) };
}

/** What a manifest records about its repos, for check 2 (`poolRecordProblems`). */
export interface PoolRecord {
  repos: readonly { repo: string; repoId: string | null }[];
  /** The repos its changes name. */
  changeRepos?: Iterable<string>;
  listing?: RepoListing | null;
  gone?: readonly GoneRepo[];
  /** The registration's `registeredRepos` (empty when it has none). */
  registered?: readonly RegisteredRepo[];
}

/**
 * What is wrong with the repositories a manifest lists, given the registered set (verify check 2; offline): the
 * manifest must cover exactly the registered repo or list (a listed repo may instead be recorded gone), or, for a rule,
 * only repos inside the rule or registered, every registered repo (listed, or recorded gone), and a listing that agrees
 * with itself and with the rule; sorted and unique, and every change from a listed repo. Whether the rule's pool is
 * complete against the SCM is check 5's job (it needs the provider).
 */
export function poolRecordProblems(set: RepoSet, rec: PoolRecord): string[] {
  const p: string[] = [];
  const manifestRepos = rec.repos.map((r) => r.repo);
  const lowerRepos = manifestRepos.map(lower);
  const gone = rec.gone ?? [];
  const registered = rec.registered ?? [];
  const eg = (xs: readonly string[]) => `(e.g. ${xs.slice(0, 3).join(", ")})`;
  if (manifestRepos.length === 0) p.push("manifest lists no repos");
  if (new Set(lowerRepos).size !== lowerRepos.length) p.push("manifest lists a repo twice");
  else if (manifestRepos.some((r, i) => i > 0 && cmp(manifestRepos[i - 1]!, r) >= 0)) p.push("manifest repos are not sorted by repo");
  if (set.kind === "repo") {
    if (manifestRepos.length !== 1 || manifestRepos[0] !== splitScheme(set.repo).path) p.push("manifest repo differs from the registration");
  } else if (set.kind === "list") {
    const want = new Set(set.repos.map((e) => lower(splitScheme(e).path)));
    const have = new Set([...lowerRepos, ...gone.map((g) => lower(g.repo))]);
    const missing = [...want].filter((r) => !have.has(r)).sort();
    const extra = [...have].filter((r) => !want.has(r)).sort();
    if (missing.length) p.push(`manifest repos differ from the registered list: ${missing.length} registered repo(s) missing ${eg(missing)}`);
    if (extra.length) p.push(`manifest repos differ from the registered list: ${extra.length} repo(s) not registered ${eg(extra)}`);
  } else {
    const regIds = new Set(registered.map((r) => r.repoId));
    const outside = rec.repos.filter((r) => !repoMatchesRule(set, r.repo) && !(r.repoId && regIds.has(r.repoId))).map((r) => r.repo);
    if (outside.length) p.push(`manifest lists ${outside.length} repo(s) outside the registered rule ${eg(outside)}`);
    if (registered.length) {
      const ids = new Set([...rec.repos.map((r) => r.repoId), ...gone.map((g) => g.repoId)]);
      const dropped = registered.filter((r) => !ids.has(r.repoId)).map((r) => r.repo);
      if (dropped.length) p.push(`manifest drops ${dropped.length} registered repo(s) ${eg(dropped)}: each must be in the manifest, or recorded gone with a probe's evidence`);
      const strayGone = gone.filter((g) => !g.repoId || !regIds.has(g.repoId)).map((g) => g.repo);
      if (strayGone.length) p.push(`manifest records ${strayGone.length} repo(s) as gone that were not registered ${eg(strayGone)}`);
    } else if (gone.length) p.push(`manifest records ${gone.length} repo(s) as gone, but the registration names no repos`);
    const goneAndListed = gone.filter((g) => g.repoId && rec.repos.some((r) => r.repoId === g.repoId)).map((g) => g.repo);
    if (goneAndListed.length) p.push(`manifest records ${goneAndListed.length} repo(s) both as listed and as gone ${eg(goneAndListed)}`);
    const l = rec.listing;
    if (l) {
      if (lower(l.owner) !== lower(set.owner)) p.push(`manifest listing is of ${l.owner}, not the registered owner ${set.owner}`);
      const names = l.repos.map((r) => r.repo);
      if (new Set(names.map(lower)).size !== names.length || new Set(l.repos.map((r) => r.repoId)).size !== names.length) p.push("manifest listing shows a repo twice");
      else if (names.some((r, i) => i > 0 && cmp(names[i - 1]!, r) >= 0)) p.push("manifest listing is not sorted by repo");
      const wrong = l.repos.filter((r) => canonical(ruleExclusions(set, r)) !== canonical(r.excludedBy)).map((r) => r.repo);
      if (wrong.length) p.push(`manifest listing gives ${wrong.length} repo(s) an exclusion their recorded attributes do not ${eg(wrong)}`);
      const poolIds = new Set(rec.repos.map((r) => r.repoId));
      // By the attributes the listing records, not the exclusion it claims: a claimed exclusion cannot hide a repo.
      const unlisted = l.repos.filter((r) => ruleExclusions(set, r).length === 0 && !poolIds.has(r.repoId)).map((r) => r.repo);
      if (unlisted.length) p.push(`manifest listing shows ${unlisted.length} repo(s) the rule matches that the manifest does not list ${eg(unlisted)}`);
      const listedIds = new Set(l.repos.map((r) => r.repoId));
      const unseen = rec.repos.filter((r) => !(r.repoId && (listedIds.has(r.repoId) || regIds.has(r.repoId)))).map((r) => r.repo);
      if (unseen.length) p.push(`manifest lists ${unseen.length} repo(s) that are neither in its listing nor registered ${eg(unseen)}`);
      const badCounts = REPO_VISIBILITIES.filter((v) => l.visibility?.[v]?.listed !== l.repos.filter((r) => r.visibility === v).length);
      if (badCounts.length) p.push(`manifest listing's ${badCounts.join(", ")} count(s) do not match its repos`);
    }
  }
  const listed = new Set(lowerRepos);
  const stray = [...new Set(rec.changeRepos ?? [])].filter((r) => !listed.has(lower(r))).sort();
  if (stray.length) p.push(`manifest has changes from ${stray.length} repo(s) it does not list ${eg(stray)}`);
  return p;
}

const canonical = (xs: readonly string[]) => JSON.stringify(xs);

/** `poolRecordProblems` for names only (a manifest without ids, listing or gone repos). */
export function manifestRepoProblems(set: RepoSet, manifestRepos: readonly string[], changeRepos: Iterable<string> = []): string[] {
  return poolRecordProblems(set, { repos: manifestRepos.map((repo) => ({ repo, repoId: null })), changeRepos });
}
