import type { GoneRepo, HeadEvidence, ManifestRepo, PluginIdentity, RegisteredRepo, RepoListing, RepoSet } from "../core/records.js";
import { freezeHeadEvidence } from "../core/head-proof.js";
import { assemblePopulation, buildPopulation, checkListed, listRepoChanges, type Population } from "../core/population.js";
import { isTransientFailure, looksUnavailable, probeRepo } from "../core/failures.js";
import { describeRepoSet, resolvePool, RepoSetError, type PoolResolution, type ResolvedRepo } from "../core/repo-set.js";
import type { ReviewHorizon, Selector } from "../core/selector.js";
import { isRepoEmpty, type AuditWindow, type ListChangesResult, type ScmProvider } from "../sdk/provider.js";
import { canonicalJson } from "../core/canonical.js";

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

export const FREEZE_RUN_SCHEMA = "pr-rla/freeze-run/v2";
export const FREEZE_REPO_SCHEMA = "pr-rla/freeze-repo/v2";

/** What decides whether two invocations are the same run (FR5.4): a resume refuses if any of it differs. */
export interface FreezeRunInputs {
  registrationSha256: string;
  /** The pool the set resolved to at the start, sorted. */
  repos: ResolvedRepo[];
  /** The registered repos the resolution found gone, sorted. */
  gone: { repo: string; repoId: string | null }[];
  prRlaVersion: string;
  provider: PluginIdentity;
}

export interface FreezeRunHeader {
  schema: typeof FREEZE_RUN_SCHEMA;
  runId: string;
  inputs: FreezeRunInputs;
  /** ISO 8601 UTC. The manifest's `frozenAt` and the cutoff reviews are read as of. */
  startedAt: string;
  /** A rule's owner listing at the start (null for a list); it is what the manifest records. */
  listing: RepoListing | null;
  /** The gone repos, with the probes' evidence, as found at the start. */
  gone: GoneRepo[];
}

/** One repo's done-marker: its checked listing and the listing's digest, or the probe that found it gone. */
export type FreezeRepoMarker = { schema: typeof FREEZE_REPO_SCHEMA; repo: string; listed: ListChangesResult; sha256: string } | { schema: typeof FREEZE_REPO_SCHEMA; repo: string; gone: GoneRepo };

/** What a done-marker holds, once read and checked. */
export type RepoCheckpoint = { listed: ListChangesResult } | { gone: GoneRepo };

/** Which of two runs' inputs differ, by name, for the refusal a `--resume` gives. */
export function differingInputs(a: FreezeRunInputs, b: FreezeRunInputs): string[] {
  const out: string[] = [];
  if (a.registrationSha256 !== b.registrationSha256) out.push("the registration");
  if (canonicalJson(a.repos) !== canonicalJson(b.repos)) {
    const was = new Set(a.repos.map((r) => r.repo));
    const now = new Set(b.repos.map((r) => r.repo));
    const added = [...now].filter((r) => !was.has(r)).length;
    const removed = [...was].filter((r) => !now.has(r)).length;
    out.push(`the resolved repo list (${added} added, ${removed} removed since that run started)`);
  }
  if (canonicalJson(a.gone ?? []) !== canonicalJson(b.gone ?? [])) out.push("the registered repos found gone");
  if (a.prRlaVersion !== b.prRlaVersion) out.push(`the pr-rla version (${a.prRlaVersion} then, ${b.prRlaVersion} now)`);
  if (canonicalJson(a.provider) !== canonicalJson(b.provider)) out.push("the provider (its version, files or options)");
  return out;
}

/**
 * The checkpoint store as the run uses it (src/api/freeze-store.ts implements it). Only the write side
 * gives one, through `CheckpointOptions.stores` (src/api/pooled-freeze.ts): the run itself never loads
 * the store, so a preview (pr-rla/api/read, the MCP server's freeze_preview) cannot write under
 * `.pr-rla/cache` (wave-2 integration of U5 and U8).
 */
export interface RunStore {
  readonly runId: string;
  header(): FreezeRunHeader | null;
  present(repos: readonly string[]): number;
  readRepo(repo: string): RepoCheckpoint | null;
  writeRepo(repo: string, listed: ListChangesResult): void;
  writeGone(repo: string, gone: GoneRepo): void;
}

export interface RunStores {
  find(base: string, window: string, inputs: FreezeRunInputs): RunStore | null;
  begin(base: string, window: string, h: Omit<FreezeRunHeader, "schema" | "runId">, opts?: { fresh?: boolean }): RunStore;
  runs(base: string, window: string): string[];
  open(base: string, window: string, runId: string): RunStore;
}

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
  /** The store (src/api/freeze-store.ts), from the write side. */
  stores: RunStores;
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
  /** Which reviews `no-review` sees (`reviewHorizonFor(registration)`): `landing` (v2, the default) or `cutoff` (v1). */
  horizon?: ReviewHorizon;
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
  /** Lines the command prints (what the listing could not prove it saw, and what the push log could not show). */
  notes: string[];
  /** P3: what each pinned head's push log showed (null: the provider has no push log); the manifest records it. */
  headEvidence: HeadEvidence[] | null;
}

/** The listing of an empty repository: nothing landed in it in any window. */
const EMPTY: ListChangesResult = { changes: [], defaultBranch: "", limitations: [] };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Lists the repos of a set and builds their pooled population, resuming a stopped run when there is one. */
export async function listPool(o: PooledFreezeOptions): Promise<PooledFreeze> {
  const common = { window: o.window, selector: o.selector, cutoffIso: o.startedAt, ...(o.horizon ? { horizon: o.horizon } : {}) };
  const now = o.now ?? (() => o.startedAt);
  if (o.set.kind === "repo") {
    // A pool of one: no run to resume, and the provider's own errors reach the caller (an empty repo stops it, as before U8).
    const population = await buildPopulation(o.provider, { repo: o.set.repo, ...common, ...(o.signal ? { signal: o.signal } : {}) });
    const r = population.repos[0]!;
    const repos: ManifestRepo[] = [{ repo: r.repo, repoId: null, defaultBranch: r.defaultBranch, headSha: r.headSha }];
    const ev = await freezeHeadEvidence(o.provider, repos, { window: o.window, from: o.startedAt, until: now(), concurrency: 1, ...(o.signal ? { signal: o.signal } : {}) });
    return { population, repos, listing: null, gone: [], startedAt: o.startedAt, runId: null, resumed: 0, fetched: 1, notes: [...unreachableNotes([{ repo: r.repo, listed: population.listed }]), ...(ev?.notes ?? [])], headEvidence: ev?.evidence ?? null };
  }

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

  let store: RunStore | null = null;
  let header: Pick<FreezeRunHeader, "startedAt" | "listing" | "gone"> = { startedAt: o.startedAt, listing: resolution.listing, gone: resolution.gone };
  let runId: string | null = null;
  let resumedRun = false;
  if (o.checkpoint) {
    const c = o.checkpoint;
    const inputs: FreezeRunInputs = { registrationSha256: c.registrationSha256, repos: resolved, gone: resolution.gone.map((g) => ({ repo: g.repo, repoId: g.repoId })), prRlaVersion: c.prRlaVersion, provider: c.provider };
    if (c.resume !== undefined) store = refuseResume(c, inputs);
    else if (!c.fresh) store = c.stores.find(c.base, c.windowName, inputs);
    if (store) {
      header = store.header()!;
      resumedRun = true;
    } else store = c.stores.begin(c.base, c.windowName, { inputs, startedAt: o.startedAt, listing: resolution.listing, gone: resolution.gone }, c.fresh ? { fresh: true } : {});
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
        let cached = store?.readRepo(repo) ?? null;
        if (cached && "gone" in cached) {
          // P3 (pass 2, #8): a gone marker is probed again on resume; it is never signed on its own word.
          const p = await probeRepo(o.provider, { repo });
          if (p.kind === "transient") throw p.error;
          if (p.kind === "gone") {
            listGone.push(cached.gone);
            results[i] = null;
            o.log(`freeze: [${++finished}/${n}] ${repo}: gone (from the checkpoint, and probed again: HTTP ${p.status})`);
            continue;
          }
          if (p.kind !== "exists") throw new Error(`${repo}: its checkpoint says it is gone, and probing it again says ${p.kind === "unsupported" ? `nothing (provider ${o.provider.name} has no describeRepo)` : p.detail}; nothing is skipped`);
          o.log(`freeze: the checkpoint says ${repo} is gone, but it exists; listing it`);
          cached = null;
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
  // P3: the push log of every pinned head, read once the listings are done (a stop here resumes with every listing kept).
  let ev: Awaited<ReturnType<typeof freezeHeadEvidence>>;
  try {
    ev = await freezeHeadEvidence(o.provider, repos, { window: o.window, from: startedAt, until: now(), concurrency: o.concurrency, ...(o.signal ? { signal: o.signal } : {}) });
  } catch (e) {
    if (o.signal?.aborted || isTransientFailure(e)) throw new FreezeStopped(`stopped after all ${n} repos were listed, while reading their push logs: ${(e as Error).message}`, runId, n, n, e);
    throw e;
  }
  const notes = [...visibilityNotes(o.set, header.listing), ...unreachableNotes(kept.map((x) => ({ repo: x.r.repo, listed: x.listed }))), ...(ev?.notes ?? [])];
  return { population, repos, listing: header.listing, gone, startedAt, runId, resumed: n - fetched, fetched, notes, headEvidence: ev?.evidence ?? null };
}

/** P3: the pull requests a listing says the head does not reach (the stopgap): verify will FAIL check 5 on them. */
function unreachableNotes(listings: readonly { repo: string; listed: ListChangesResult }[]): string[] {
  const hit = listings.filter((l) => l.listed.unreachable?.length);
  if (!hit.length) return [];
  return [`warning: in ${hit.length} repo(s) (${hit.slice(0, 3).map((l) => `${l.repo}: ${l.listed.unreachable!.slice(0, 2).join(", ")}`).join("; ")}) a pull request merged in the window is not reachable from the default branch's head: the branch was rewritten after it merged, and verify will FAIL check 5`];
}

/** One repo's checked listing; null when it answers 404/403 and the set is a registered list (the caller probes it). */
async function listOne(o: PooledFreezeOptions, repo: string, at: { window: AuditWindow; selector: Selector; cutoffIso: string; horizon?: ReviewHorizon }): Promise<ListChangesResult | null> {
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
function refuseResume(c: CheckpointOptions, inputs: FreezeRunInputs): RunStore {
  const want = (c.resume ?? "").toLowerCase();
  if (want.length < 8 || !/^[0-9a-f]+$/.test(want)) throw new ResumeRefused(`--resume takes the run id freeze printed (at least 8 hex digits), not "${c.resume}"`);
  const known = c.stores.runs(c.base, c.windowName).filter((r) => r.startsWith(want));
  if (known.length === 0) throw new ResumeRefused(`no checkpoint for run ${want} under .pr-rla/cache/${c.windowName}; a run's id is derived from its inputs and start, so start it with freeze`);
  const store = c.stores.open(c.base, c.windowName, known[0]!);
  const old = store.header();
  if (!old) throw new ResumeRefused(`run ${want.slice(0, 12)}… cannot resume: its header is damaged or was edited (it no longer hashes to the run id). Its checkpoints stay as they are; run freeze without --resume to start a new run`);
  const diff = differingInputs(old.inputs, inputs);
  if (diff.length) throw new ResumeRefused(`run ${want.slice(0, 12)}… cannot resume: the inputs now differ in ${diff.join("; ")}. Its checkpoints stay as they are; run freeze without --resume to start a new run`);
  return store;
}
