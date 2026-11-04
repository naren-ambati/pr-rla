import { assertChangeRecord, isCommitId, type AuditWindow, type ChangeRecord, type ListChangesResult, type ScmProvider } from "../sdk/provider.js";
import { sortChanges, type ManifestEntry } from "./records.js";
import { applySelector, reviewsAsOf, type ActorAliases, type SelectionResult, type Selector } from "./selector.js";
import { inWindow } from "./window.js";

/** Added to every manifest whose selector includes direct pushes, whatever the provider says. */
export const DIRECT_PUSH_LIMITATION =
  "direct_push: `author` is the commit author, which is not necessarily who pushed it (commit author != pusher); mergedBy is null because SCM commit APIs do not expose the pusher.";

export interface PopulationRepo {
  repo: string;
  /** The default branch the provider walked. */
  defaultBranch: string;
  /** The head the provider walked from, or null if it does not pin history. */
  headSha: string | null;
  /** Changes the provider listed for this repo in the window (before the selector). */
  listed: number;
}

export interface Population {
  /** Provider limitations plus core ones, de-duplicated. */
  limitations: string[];
  /** The provider's listing; for a pool the repos' listings merged (changes concatenated in repo order, diagnostics summed by label). */
  listed: ListChangesResult;
  selection: SelectionResult;
  /** Sorted by id; reviews trimmed to the cutoff. */
  entries: ManifestEntry[];
  byKind: Record<ChangeRecord["kind"], number>;
  /** The default-branch head the provider walked from (`ListChangesResult.headSha`), or null if it does not pin history. A pool has one per repo: see `repos`. */
  headSha: string | null;
  /** Direct pushes that arrived through a pushed merge, per merge commit (from `landedVia`), most first. */
  viaMerge: { merge: string; count: number }[];
  /** One entry per repo of the pool, sorted by repo. A single repo is a pool of one. */
  repos: PopulationRepo[];
}

export interface PopulationArgs {
  repo: string;
  window: AuditWindow;
  selector: Selector;
  cutoffIso: string;
  signal?: AbortSignal;
  /** Walk history from this default-branch commit (verify passes the manifest's headSha). */
  head?: string;
  /** Account id -> login at freeze, so renamed accounts still match the selector (verify). */
  aliases?: ActorAliases;
}

/** What listing one repository needs from a pooled build (the rest is shared). */
export type PoolArgs = Omit<PopulationArgs, "repo" | "head">;

/** Lists one repo's changes in the window. The listing is checked by `checkListed` before it is used. */
export async function listRepoChanges(provider: ScmProvider, args: Pick<PopulationArgs, "repo" | "window" | "selector" | "signal" | "head">): Promise<ListChangesResult> {
  if (args.head !== undefined && !isCommitId(args.head)) throw new Error(`the pinned default-branch head ${JSON.stringify(args.head)} is not a commit id (40 to 64 lowercase hex characters); the manifest was edited or is not from this pr-rla`);
  const req = { repo: args.repo, window: { opensAt: args.window.opensAt, closesAt: args.window.closesAt }, kinds: args.selector.kinds, ...(args.signal ? { signal: args.signal } : {}), ...(args.head !== undefined ? { head: args.head } : {}) };
  return provider.listChanges(req);
}

/**
 * Checks the provider contract for one repo's listing: well-formed records, unique ids, no SHA claimed
 * twice, all inside the window, only requested kinds, all from this repo. Whatever a provider (or an
 * isolated plugin) returned, the core re-validates it (contracts.md §3).
 */
export function checkListed(providerName: string, listed: ListChangesResult, args: Pick<PopulationArgs, "repo" | "window" | "selector">): void {
  const ids = new Set<string>();
  const shas = new Map<string, string>();
  for (const c of listed.changes) {
    assertChangeRecord(c, `provider ${providerName}`);
    if (ids.has(c.id)) throw new Error(`provider ${providerName} returned ${c.id} twice`);
    ids.add(c.id);
    const other = shas.get(c.mergeSha);
    if (other) throw new Error(`provider ${providerName} counted commit ${c.mergeSha} twice (${other} and ${c.id})`);
    shas.set(c.mergeSha, c.id);
    if (!inWindow(c.mergedAt, args.window)) throw new Error(`provider ${providerName} returned ${c.id} landed ${c.mergedAt}, outside the window`);
    if (!args.selector.kinds.includes(c.kind)) throw new Error(`provider ${providerName} returned ${c.id} of kind ${c.kind}, which was not requested`);
    if (c.repo !== args.repo) throw new Error(`provider ${providerName} returned ${c.id} from repo ${c.repo}, not ${args.repo}`);
  }
  // P3: `unreachable` names pull requests of this listing.
  if (listed.unreachable !== undefined) {
    if (!Array.isArray(listed.unreachable)) throw new Error(`provider ${providerName}: unreachable must be a list of change ids`);
    const prs = new Set(listed.changes.filter((c) => c.kind === "pull_request").map((c) => c.id));
    for (const id of listed.unreachable) if (!prs.has(id)) throw new Error(`provider ${providerName} says ${JSON.stringify(id)} is unreachable from the head, but it is not a pull request of the listing`);
  }
}

const schemeOf = (id: string) => id.slice(0, id.indexOf(":"));

/**
 * The union of per-repo populations under one selector (FR5.2): the repos' checked listings merged,
 * the selector applied once over all of them, entries sorted by id. Change ids are repo-qualified, so
 * the sort, the draw formula and N need nothing else. One provider per pool (FR5.6): a pool whose
 * changes carry two id schemes is refused here, for every caller.
 */
export function assemblePopulation(providerName: string, unordered: readonly { repo: string; listed: ListChangesResult }[], args: PoolArgs): Population {
  // Sorted by repo, so the order repos were given or finished in cannot change a byte of the result (NFR6).
  const perRepo = [...unordered].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  const only = perRepo.length === 1 ? perRepo[0]!.listed : null;
  const changes = only ? only.changes : perRepo.flatMap((r) => r.listed.changes);
  if (!only) {
    const seen = new Set<string>();
    for (const c of changes) {
      if (seen.has(c.id)) throw new Error(`provider ${providerName} returned ${c.id} twice`);
      seen.add(c.id);
    }
    const schemes = new Set(changes.map((c) => schemeOf(c.id)));
    if (schemes.size > 1) throw new Error(`a pooled audit uses one provider, but provider ${providerName} returned changes of ${[...schemes].sort().join(" and ")}; register one audit per provider`);
  }
  const listed: ListChangesResult = only ?? mergeListings(perRepo.map((r) => r.listed), changes);
  const selection = applySelector(listed.changes, args.selector, args.cutoffIso, args.aliases ? { aliases: args.aliases } : {});
  const entries = sortChanges(selection.selected.map((c) => ({ ...c, reviews: reviewsAsOf(c, args.cutoffIso) })));
  const byKind = { pull_request: 0, direct_push: 0 };
  for (const c of listed.changes) byKind[c.kind]++;
  const limitations = [...new Set([...listed.limitations, ...(args.selector.kinds.includes("direct_push") ? [DIRECT_PUSH_LIMITATION] : [])])];
  const via = new Map<string, number>();
  for (const c of listed.changes) if (c.kind === "direct_push" && c.landedVia) via.set(c.landedVia, (via.get(c.landedVia) ?? 0) + 1);
  const viaMerge = [...via].map(([merge, count]) => ({ merge, count })).sort((a, b) => b.count - a.count || (a.merge < b.merge ? -1 : 1));
  const repos = perRepo.map((r) => ({ repo: r.repo, defaultBranch: r.listed.defaultBranch, headSha: typeof r.listed.headSha === "string" ? r.listed.headSha : null, listed: r.listed.changes.length }));
  return { limitations, listed, selection, entries, byKind, headSha: only && typeof only.headSha === "string" ? only.headSha : null, viaMerge, repos };
}

/** Merges per-repo listings: limitations by first appearance, diagnostics summed by label, one default branch if they agree. */
function mergeListings(parts: readonly ListChangesResult[], changes: ChangeRecord[]): ListChangesResult {
  const branches = new Set(parts.map((p) => p.defaultBranch));
  const diag = new Map<string, number>();
  for (const p of parts) for (const d of p.diagnostics ?? []) diag.set(d.label, (diag.get(d.label) ?? 0) + d.value);
  return {
    changes,
    defaultBranch: branches.size === 1 ? [...branches][0]! : "(varies by repo)",
    limitations: [...new Set(parts.flatMap((p) => p.limitations))],
    ...(diag.size ? { diagnostics: [...diag].map(([label, value]) => ({ label, value })) } : {}),
  };
}

/**
 * Asks the provider for everything that landed in the window, checks the
 * provider contract (well-formed records, unique ids, no SHA claimed twice,
 * all inside the window), then applies the selector as of `cutoffIso`.
 * Depends only on the ScmProvider interface. A single repo is a pool of one.
 */
export async function buildPopulation(provider: ScmProvider, args: PopulationArgs): Promise<Population> {
  const listed = await listRepoChanges(provider, args);
  checkListed(provider.name, listed, args);
  return assemblePopulation(provider.name, [{ repo: args.repo, listed }], args);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, results in item order. After the first
 * failure nothing new starts; the in-flight calls finish, then the first error is thrown.
 */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    for (;;) {
      if (failure) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return out;
}

/**
 * A pooled population built straight from the provider: each repo listed (from its own head when one is given),
 * `concurrency` at a time, then assembled in the order given. Any repo's failure fails the build. `freeze` lists through
 * the checkpointed run in src/api, and `verify` through src/core/rebuild.ts, which tell a gone repo from a broken one.
 */
export async function buildPooledPopulation(provider: ScmProvider, args: PoolArgs & { repos: readonly { repo: string; head?: string }[]; concurrency?: number }): Promise<Population> {
  const perRepo = await mapPool(args.repos, args.concurrency ?? 4, async (r) => {
    const listed = await listRepoChanges(provider, { repo: r.repo, window: args.window, selector: args.selector, ...(args.signal ? { signal: args.signal } : {}), ...(r.head !== undefined ? { head: r.head } : {}) });
    checkListed(provider.name, listed, { repo: r.repo, window: args.window, selector: args.selector });
    return { repo: r.repo, listed };
  });
  return assemblePopulation(provider.name, perRepo, args);
}

/**
 * The login each account id had in a frozen manifest (author, merger, reviews), for `verify`:
 * a renamed account keeps its id, so it still matches the logins the selector names (FR7.3).
 */
export function manifestAliases(changes: readonly ChangeRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of changes) for (const a of [c.author, ...(c.mergedBy ? [c.mergedBy] : []), ...c.reviews.map((r) => r.author)]) if (a.id !== undefined && !out.has(a.id)) out.set(a.id, a.login);
  return out;
}
