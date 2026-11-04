import type { ManifestRepo, PluginIdentity, RepoSet } from "../core/records.js";
import { assemblePopulation, buildPopulation, checkListed, listRepoChanges, type Population } from "../core/population.js";
import { describeRepoSet, resolveRepoSet, RepoSetError, type ResolvedRepo } from "../core/repo-set.js";
import type { Selector } from "../core/selector.js";
import { RETRIES_EXHAUSTED, TIMED_OUT } from "../sdk/http.js";
import type { AuditWindow, ListChangesResult, ScmProvider } from "../sdk/provider.js";
import { BrokerRetriesExhausted, BrokerTimeout } from "../net/contract.js";
import { differingInputs, FreezeCheckpointStore, freezeRunId, type FreezeRunInputs } from "./freeze-store.js";

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

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/**
 * Whether a listing failure is the kind that waiting out fixes: the broker (or a provider
 * that retries itself) gave up on rate limits, timeouts or 5xx, or the connection dropped.
 * Works across the plugin host, where only `code` and `status` survive.
 */
export function isTransientFailure(e: unknown): boolean {
  if (e instanceof BrokerRetriesExhausted || e instanceof BrokerTimeout) return true;
  const x = e as { code?: unknown; status?: unknown; cause?: { code?: unknown } } | null;
  if (!x || typeof x !== "object") return false;
  if (x.code === RETRIES_EXHAUSTED || x.code === TIMED_OUT) return true;
  // A provider that gave up itself (GitHubHttpError status 0), or reports a server-side status.
  if (x.status === 0 || x.status === 429 || (typeof x.status === "number" && x.status >= 500 && x.status < 600)) return true;
  const code = typeof x.code === "string" ? x.code : typeof x.cause?.code === "string" ? x.cause.code : null;
  return code !== null && NETWORK_CODES.has(code);
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
  /** Present for a real freeze of a list or rule: the run is checkpointed and can resume. Absent: nothing is written. */
  checkpoint?: CheckpointOptions;
}

export interface PooledFreeze {
  population: Population;
  /** For the manifest, sorted by repo. */
  repos: ManifestRepo[];
  /** The as-of time in force: the run's start, kept across a resume. The cutoff reviews were read as of. */
  startedAt: string;
  runId: string | null;
  /** Repos taken from checkpoints, and repos listed by this invocation. */
  resumed: number;
  fetched: number;
  /** Marks the run complete once the manifest is written. */
  finish(): void;
}

const noop = () => {};

/** Lists the repos of a set and builds their pooled population, resuming a stopped run when there is one. */
export async function freezeRepos(o: PooledFreezeOptions): Promise<PooledFreeze> {
  const common = { window: o.window, selector: o.selector, cutoffIso: o.startedAt };
  if (o.set.kind === "repo") {
    // A pool of one: no run to resume, and the provider's own errors reach the caller.
    const resolved = (await resolveRepoSet(o.provider, o.set))[0]!;
    const population = await buildPopulation(o.provider, { repo: resolved.repo, ...common, ...(o.signal ? { signal: o.signal } : {}) });
    const r = population.repos[0]!;
    return { population, repos: [{ repo: r.repo, repoId: null, defaultBranch: r.defaultBranch, headSha: r.headSha }], startedAt: o.startedAt, runId: null, resumed: 0, fetched: 1, finish: noop };
  }

  const resolved = await resolveRepoSet(o.provider, o.set);
  if (resolved.length === 0) throw new RepoSetError(`${describeRepoSet(o.set)} matches no repository the token can see; widen the rule, or check the token's access`);
  const n = resolved.length;

  let store: FreezeCheckpointStore | null = null;
  let startedAt = o.startedAt;
  let runId: string | null = null;
  let resumedRun = false;
  if (o.checkpoint) {
    const c = o.checkpoint;
    const inputs: FreezeRunInputs = { registrationSha256: c.registrationSha256, repos: resolved, prRlaVersion: c.prRlaVersion, provider: c.provider };
    runId = freezeRunId(inputs);
    if (c.resume !== undefined) refuseResume(c, runId, inputs);
    store = new FreezeCheckpointStore(c.base, c.windowName, runId);
    if (c.resume !== undefined && !store.header()) throw new ResumeRefused(`no checkpoint for run ${runId.slice(0, 12)}… in ${store.dir}: nothing was started with these inputs, or it was discarded; run freeze without --resume`);
    const begun = store.begin(inputs, o.startedAt, c.fresh ? { fresh: true } : {});
    startedAt = begun.header.startedAt;
    resumedRun = begun.resumed;
  }
  const done = store ? store.done(resolved.map((r) => r.repo)) : 0;
  o.log(`freeze: ${describeRepoSet(o.set)} → ${n} repo${n === 1 ? "" : "s"}, ${Math.min(o.concurrency, n)} at a time${runId ? ` · run ${runId.slice(0, 12)}…${resumedRun ? ` resuming (${done} of ${n} repos already listed, as of ${startedAt})` : ""}` : ""}`);

  const results = new Array<ListChangesResult | undefined>(n);
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
        let listed = store?.readRepo(repo) ?? null;
        if (listed) {
          o.log(`freeze: [${++finished}/${n}] ${repo}: ${listed.changes.length} changes (from the checkpoint)`);
        } else {
          listed = await listRepoChanges(o.provider, { repo, ...common, ...(o.signal ? { signal: o.signal } : {}) });
          checkListed(o.provider.name, listed, { repo, ...common });
          store?.writeRepo(repo, listed);
          fetched++;
          o.log(`freeze: [${++finished}/${n}] ${repo}: ${listed.changes.length} changes${typeof listed.headSha === "string" ? ` · head ${listed.headSha.slice(0, 12)}` : ""}`);
        }
        results[i] = listed;
      } catch (e) {
        if (isTransientFailure(e)) transient ??= e;
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

  const perRepo = resolved.map((r, i) => ({ repo: r.repo, listed: results[i]! }));
  const population = assemblePopulation(o.provider.name, perRepo, common);
  const repos: ManifestRepo[] = resolved.map((r, i) => ({ repo: r.repo, repoId: r.repoId, defaultBranch: results[i]!.defaultBranch, headSha: typeof results[i]!.headSha === "string" ? results[i]!.headSha! : null }));
  return { population, repos, startedAt, runId, resumed: n - fetched, fetched, finish: () => store?.markComplete() };
}

function refuseResume(c: CheckpointOptions, runId: string, inputs: FreezeRunInputs): void {
  const want = (c.resume ?? "").toLowerCase();
  if (want.length < 8 || !/^[0-9a-f]+$/.test(want)) throw new ResumeRefused(`--resume takes the run id freeze printed (at least 8 hex digits), not "${c.resume}"`);
  if (runId.startsWith(want)) return;
  const known = FreezeCheckpointStore.runs(c.base, c.windowName).filter((r) => r.startsWith(want));
  if (known.length === 0) throw new ResumeRefused(`no checkpoint for run ${want} under .pr-rla/cache/${c.windowName}; a run's id is derived from its inputs, so start it with freeze`);
  const old = new FreezeCheckpointStore(c.base, c.windowName, known[0]!).header();
  const diff = old ? differingInputs(old.inputs, inputs) : ["its header (unreadable)"];
  throw new ResumeRefused(`run ${want.slice(0, 12)}… cannot resume: the inputs now differ in ${diff.join("; ")}. Its checkpoints stay as they are; run freeze without --resume to start a new run`);
}
