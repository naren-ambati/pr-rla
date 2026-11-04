import { REPO_VISIBILITIES, type RepoRef, type RepoSetRule, type RepoVisibility, type ScmProvider } from "../sdk/provider.js";
import type { RepoSet } from "./records.js";

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

/** The repositories a rule keeps: globs and the archived, fork and visibility flags (FR5.7: archived and forks are out unless the rule says so). */
export function applyRule(rule: RepoSetRule, refs: readonly RepoRef[]): RepoRef[] {
  return refs.filter((r) => repoMatchesRule(rule, r.repo) && (rule.archived || !r.archived) && (rule.forks || !r.fork) && rule.visibility.includes(r.visibility));
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

/**
 * What is wrong with the repositories a manifest lists, given the registered set (verify check 2; offline):
 * the manifest must cover exactly the registered repo or list, or only repos inside the registered rule, sorted
 * and unique, and every change must come from a listed repo. A rule's completeness is check 5's job (it
 * needs the provider).
 */
export function manifestRepoProblems(set: RepoSet, manifestRepos: readonly string[], changeRepos: Iterable<string> = []): string[] {
  const p: string[] = [];
  const lowerRepos = manifestRepos.map(lower);
  if (manifestRepos.length === 0) p.push("manifest lists no repos");
  if (new Set(lowerRepos).size !== lowerRepos.length) p.push("manifest lists a repo twice");
  else if (manifestRepos.some((r, i) => i > 0 && cmp(manifestRepos[i - 1]!, r) >= 0)) p.push("manifest repos are not sorted by repo");
  if (set.kind === "repo") {
    if (manifestRepos.length !== 1 || manifestRepos[0] !== splitScheme(set.repo).path) p.push("manifest repo differs from the registration");
  } else if (set.kind === "list") {
    const want = new Set(set.repos.map((e) => lower(splitScheme(e).path)));
    const have = new Set(lowerRepos);
    const missing = [...want].filter((r) => !have.has(r)).sort();
    const extra = [...have].filter((r) => !want.has(r)).sort();
    if (missing.length) p.push(`manifest repos differ from the registered list: ${missing.length} registered repo(s) missing (e.g. ${missing.slice(0, 3).join(", ")})`);
    if (extra.length) p.push(`manifest repos differ from the registered list: ${extra.length} repo(s) not registered (e.g. ${extra.slice(0, 3).join(", ")})`);
  } else {
    const outside = manifestRepos.filter((r) => !repoMatchesRule(set, r));
    if (outside.length) p.push(`manifest lists ${outside.length} repo(s) outside the registered rule (e.g. ${outside.slice(0, 3).join(", ")})`);
  }
  const listed = new Set(lowerRepos);
  const stray = [...new Set(changeRepos)].filter((r) => !listed.has(lower(r))).sort();
  if (stray.length) p.push(`manifest has changes from ${stray.length} repo(s) it does not list (e.g. ${stray.slice(0, 3).join(", ")})`);
  return p;
}
