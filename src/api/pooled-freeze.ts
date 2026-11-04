import type { GoneRepo, ManifestRepo, PluginIdentity, RegisteredRepo, RepoListing, RepoSet } from "../core/records.js";
import { assemblePopulation, buildPopulation, checkListed, listRepoChanges, type Population } from "../core/population.js";
import { isTransientFailure, looksUnavailable, probeRepo } from "../core/failures.js";
import { describeRepoSet, resolvePool, RepoSetError, type PoolResolution } from "../core/repo-set.js";
import type { Selector } from "../core/selector.js";
import { isRepoEmpty, type AuditWindow, type ListChangesResult, type ScmProvider } from "../sdk/provider.js";
import { differingInputs, FreezeCheckpointStore, type FreezeRunHeader, type FreezeRunInputs } from "./freeze-store.js";

/** Whether a listing failure is the kind that waiting out fixes (src/core/failures.ts; re-exported for callers of the API). */
export { isTransientFailure };

/**
 * The pooled freeze run (functional-design.md §U8; the draft's algorithm diagram). It resolves the
 * repo set once, lists each repo's changes through the provider (and so the fetch broker's shared
 * per-host budget), `concurrency` at a time, and checkpoints every finished repo so a stopped or
 * killed run resumes.
 *
 * - **All-or-nothing.** A pooled manifest missing a repo would be a pruned population, the attack
 *   check 5 exists to catch, so there is no partial result and no way to skip a repo. A repo the team
 *   cannot read must be excluded in the registered rule, before the seed.
 * - **A single repo is a pool of one**, listed and assembled by the same code. It is not
 *   checkpointed, and its errors reach the caller unchanged, as before U8.
 * - **Stopping.** A transient failure that survived the broker's retries (rate budget exhausted,
 *   timeouts, 5xx) stops scheduling, lets the repos in flight finish, keeps every checkpoint and
 *   throws `FreezeStopped` (exit 4: re-running the printed command finishes it). Anything else
 *   (a 403 or 404 on a repo, a contract violation) throws `FreezeRepoFailed`, naming the repo.
 */

/** Every transient failure the run waits out by stopping. */
export class FreezeStopped extends Error {
  constructor(
    message: string,
    readonly runId: string | null,
    readonly done: number,
    readonly total: number,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "FreezeStopped";
  }
}

/** A repo cannot be listed and retrying will not help. */
export class FreezeRepoFailed extends Error {
  constructor(
    message: string,
    readonly repo: string,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "FreezeRepoFailed";
  }
}

/** `--resume` named a run that does not match the current inputs, or does not exist. */
export class ResumeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeRefused";
  }
}

export interface CheckpointOptions {
  /** The audit repo directory (the cache lives under its `.pr-rla/`). */
  base: string;
  windowName: string;
  registrationSha256: string;
  prRlaVersion: string;
  provider: PluginIdentity;
  /** `--resume <runId>` (a unique prefix is enough): the run must match the current inputs. */
  resume?: string;
  /** Discard what an earlier run of this id cached and start again (`freeze --force`). */
  fresh?: boolean;
}

export interface PooledFreezeOptions {
  provider: ScmProvider;
  set: RepoSet;
  window: AuditWindow;
  selector: Selector;
  /** The command's clock at the start: the as-of time of a new run. */
  startedAt: string;
  /** Repos listed at once. */
  concurrency: number;
  signal?: AbortSignal;
  log: (line: string) => void;
  /** A rule registration's registeredRepos: the freeze includes every one that still exists, whatever its attributes now. */
  registered?: readonly RegisteredRepo[];
  /** The command's clock now (when a probe found a repo gone); default `startedAt`. */
  now?: () => string;
  /** Present for a real freeze of a list or rule: the run is checkpointed and can resume. Absent: nothing is written. */
  checkpoint?: CheckpointOptions;
}

export interface PooledFreeze {
  population: Population;
  /** For the manifest, sorted by repo. */
  repos: ManifestRepo[];
  /** A rule's unfiltered owner listing at the run's start (null for a repo or list): the manifest records it. */
  listing: RepoListing | null;
  /** Registered repos found gone (by a repo-level probe), sorted: the manifest records them. */
  gone: GoneRepo[];
  /** The as-of time in force: the run's start, kept across a resume. The cutoff reviews were read as of. */
  startedAt: string;
  runId: string | null;
  /** Repos taken from checkpoints, and repos listed by this invocation. */
  resumed: number;
  fetched: number;
  /** Lines the command prints (what the listing could not prove it saw). */
  notes: string[];
}

/** The listing of an empty repository: nothing landed in it in any window. */
const EMPTY: ListChangesResult = { changes: [], defaultBranch: "", limitations: [] };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Lists the repos of a set and builds their pooled population, resuming a stopped run when there is one. */
export async function freezeRepos(o: PooledFreezeOptions): Promise<PooledFreeze> {
  const common = { window: o.window, selector: o.selector, cutoffIso: o.startedAt };
  if (o.set.kind === "repo") {
    // A pool of one: no run to resume, and the provider's own errors reach the caller (an empty repo stops it, as before U8).
    const population = await buildPopulation(o.provider, { repo: o.set.repo, ...common, ...(o.signal ? { signal: o.signal } : {}) });
    const r = population.repos[0]!;
    return { population, repos: [{ repo: r.repo, repoId: null, defaultBranch: r.defaultBranch, headSha: r.headSha }], listing: null, gone: [], startedAt: o.startedAt, runId: null, resumed: 0, fetched: 1, notes: [] };
  }

  const now = o.now ?? (() => o.startedAt);
  let resolution: PoolResolution;
  try {
    resolution = await resolvePool(o.provider, o.set, { ...(o.registered ? { registered: o.registered } : {}), now });
  } catch (e) {
    if (isTransientFailure(e)) throw new FreezeStopped(`stopped while resolving ${describeRepoSet(o.set)}: ${(e as Error).message}`, null, 0, 0, e);
    throw e;
  }
  const resolved = resolution.pool;
  if (resolved.length === 0) throw new RepoSetError(`${describeRepoSet(o.set)} matches no repository the token can see${resolution.gone.length ? ` (${resolution.gone.length} registered repo(s) are gone)` : ""}; widen the rule, or check the token's access`);
  const n = resolved.length;

  let store: FreezeCheckpointStore | null = null;
  let header: Pick<FreezeRunHeader, "startedAt" | "listing" | "gone"> = { startedAt: o.startedAt, listing: resolution.listing, gone: resolution.gone };
  let runId: string | null = null;
  let resumedRun = false;
  if (o.checkpoint) {
    const c = o.checkpoint;
    const inputs: FreezeRunInputs = { registrationSha256: c.registrationSha256, repos: resolved, gone: resolution.gone.map((g) => ({ repo: g.repo, repoId: g.repoId })), prRlaVersion: c.prRlaVersion, provider: c.provider };
    if (c.resume !== undefined) store = refuseResume(c, inputs);
    else if (!c.fresh) store = FreezeCheckpointStore.find(c.base, c.windowName, inputs);
    if (store) {
      header = store.header()!;
      resumedRun = true;
    } else store = FreezeCheckpointStore.begin(c.base, c.windowName, { inputs, startedAt: o.startedAt, listing: resolution.listing, gone: resolution.gone }, c.fresh ? { fresh: true } : {});
    runId = store.runId;
  }
  const startedAt = header.startedAt;
  const at = { ...common, cutoffIso: startedAt };
  const done = store ? store.present(resolved.map((r) => r.repo)) : 0;
  o.log(`freeze: ${describeRepoSet(o.set)} → ${n} repo${n === 1 ? "" : "s"}, ${Math.min(o.concurrency, n)} at a time${runId ? ` · run ${runId.slice(0, 12)}…${resumedRun ? ` resuming (${done} of ${n} repos already listed, as of ${startedAt})` : ""}` : ""}`);
  if (header.gone.length) o.log(`freeze: ${header.gone.length} registered repo(s) are gone (${header.gone.slice(0, 3).map((g) => `${g.repo}: HTTP ${g.status}`).join(", ")}): the manifest records them with the probe's evidence, and verify reports them`);

  const results = new Array<ListChangesResult | null | undefined>(n);
  const listGone: GoneRepo[] = [];
  let next = 0;
  let finished = 0;
  let fetched = 0;
  let transient: unknown = null;
  let fatal: { repo: string; error: unknown } | null = null;
  const stopped = () => transient !== null || fatal !== null || o.signal?.aborted === true;

  const worker = async () => {
    while (!stopped()) {
      const i = next++;
      if (i >= n) return;
      const { repo } = resolved[i]!;
      try {
        const cached = store?.readRepo(repo) ?? null;
        if (cached && "gone" in cached) {
          listGone.push(cached.gone);
          results[i] = null;
          o.log(`freeze: [${++finished}/${n}] ${repo}: gone (from the checkpoint)`);
          continue;
        }
        let listed: ListChangesResult | null = null;
        if (cached) {
          // A checkpoint is re-checked like a fresh listing: one that breaks the provider contract is listed again.
          try {
            checkListed(o.provider.name, cached.listed, { repo, ...at });
            listed = cached.listed;
            o.log(`freeze: [${++finished}/${n}] ${repo}: ${listed.changes.length} changes (from the checkpoint)`);
          } catch (e) {
            o.log(`freeze: the checkpoint for ${repo} is not usable (${(e as Error).message}); listing it again`);
          }
        }
        if (!listed) {
          listed = await listOne(o, repo, at);
          if (listed === null) {
            // A repo of a registered list, found gone by a repo-level probe.
            const p = await probeRepo(o.provider, { repo });
            if (p.kind !== "gone") throw new Error(`${repo} answers 404 or 403, and its repo-level probe says ${p.kind === "exists" ? "it exists (so a part of it is missing)" : p.kind === "unsupported" ? `nothing (provider ${o.provider.name} has no describeRepo)` : p.detail}`);
            const g: GoneRepo = { repo, repoId: null, status: p.status, detail: p.detail, probedAt: now() };
            store?.writeGone(repo, g);
            listGone.push(g);
            results[i] = null;
            fetched++;
            o.log(`freeze: [${++finished}/${n}] ${repo}: gone (HTTP ${p.status} on its metadata)`);
            continue;
          }
          store?.writeRepo(repo, listed);
          fetched++;
          o.log(`freeze: [${++finished}/${n}] ${repo}: ${listed.changes.length} changes${typeof listed.headSha === "string" ? ` · head ${listed.headSha.slice(0, 12)}` : listed.defaultBranch === "" ? " · empty (no default branch)" : ""}`);
        }
        results[i] = listed;
      } catch (e) {
        // A run that was aborted stops, whatever its in-flight listings threw on the way out.
        if (o.signal?.aborted || isTransientFailure(e)) transient ??= e;
        else fatal ??= { repo, error: e };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, o.concurrency), n) }, worker));

  if (fatal) {
    const f = fatal as { repo: string; error: unknown };
    throw new FreezeRepoFailed(`repo ${f.repo}: ${(f.error as Error).message}${runId ? ` (the ${finished} repos listed so far are checkpointed). A repo the token cannot read must be excluded in the registered rule, before the seed; nothing is skipped` : ""}`, f.repo, f.error);
  }
  if (transient !== null) {
    const why = (transient as Error).message;
    throw new FreezeStopped(`stopped after ${finished} of ${n} repos: ${why}`, runId, finished, n, transient);
  }
  if (o.signal?.aborted) throw new FreezeStopped(`stopped after ${finished} of ${n} repos: aborted`, runId, finished, n, o.signal.reason);

  const kept = resolved.map((r, i) => ({ r, listed: results[i] })).filter((x): x is { r: (typeof resolved)[number]; listed: ListChangesResult } => !!x.listed);
  if (kept.length === 0) throw new RepoSetError(`every repo of ${describeRepoSet(o.set)} is gone; there is nothing to freeze`);
  const population = assemblePopulation(o.provider.name, kept.map((x) => ({ repo: x.r.repo, listed: x.listed })), at);
  const repos: ManifestRepo[] = kept.map((x) => ({ repo: x.r.repo, repoId: x.r.repoId, defaultBranch: x.listed.defaultBranch, headSha: typeof x.listed.headSha === "string" ? x.listed.headSha : null }));
  const gone = [...header.gone, ...listGone].sort((a, b) => cmp(a.repo, b.repo));
  return { population, repos, listing: header.listing, gone, startedAt, runId, resumed: n - fetched, fetched, notes: visibilityNotes(o.set, header.listing) };
}

/** One repo's checked listing; null when it answers 404/403 and the set is a registered list (the caller probes it). */
async function listOne(o: PooledFreezeOptions, repo: string, at: { window: AuditWindow; selector: Selector; cutoffIso: string }): Promise<ListChangesResult | null> {
  let listed: ListChangesResult;
  try {
    listed = await listRepoChanges(o.provider, { repo, ...at, ...(o.signal ? { signal: o.signal } : {}) });
  } catch (e) {
    // An empty repository has no default branch: inside a pool it is a repo with nothing in the window.
    if (isRepoEmpty(e)) return EMPTY;
    if (o.set.kind === "list" && looksUnavailable(e)) return null;
    throw e;
  }
  checkListed(o.provider.name, listed, { repo, ...at });
  return listed;
}

/** What the freezer's listing could not prove it saw, for the rule's private and internal visibilities. */
function visibilityNotes(set: RepoSet, listing: RepoListing | null): string[] {
  if (set.kind !== "rule" || !listing) return [];
  return set.visibility
    .filter((v) => v !== "public" && listing.visibility[v]?.complete !== true)
    .map((v) => `note: this token cannot be shown to see every ${v} repository under ${set.owner} (${listing.visibility[v]?.reason ?? "unknown"}); a ${v} repo it missed would make a verifier who can see it FAIL check 5, and a verifier who cannot is INCOMPLETE`);
}

/** The run `--resume` names, if its inputs match; otherwise a refusal that says what differs. */
function refuseResume(c: CheckpointOptions, inputs: FreezeRunInputs): FreezeCheckpointStore {
  const want = (c.resume ?? "").toLowerCase();
  if (want.length < 8 || !/^[0-9a-f]+$/.test(want)) throw new ResumeRefused(`--resume takes the run id freeze printed (at least 8 hex digits), not "${c.resume}"`);
  const known = FreezeCheckpointStore.runs(c.base, c.windowName).filter((r) => r.startsWith(want));
  if (known.length === 0) throw new ResumeRefused(`no checkpoint for run ${want} under .pr-rla/cache/${c.windowName}; a run's id is derived from its inputs and start, so start it with freeze`);
  const store = new FreezeCheckpointStore(c.base, c.windowName, known[0]!);
  const old = store.header();
  if (!old) throw new ResumeRefused(`run ${want.slice(0, 12)}… cannot resume: its header is damaged or was edited (it no longer hashes to the run id). Its checkpoints stay as they are; run freeze without --resume to start a new run`);
  const diff = differingInputs(old.inputs, inputs);
  if (diff.length) throw new ResumeRefused(`run ${want.slice(0, 12)}… cannot resume: the inputs now differ in ${diff.join("; ")}. Its checkpoints stay as they are; run freeze without --resume to start a new run`);
  return store;
}
