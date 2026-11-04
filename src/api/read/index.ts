import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withConfinement, type Confinement } from "../../io/confine.js";
import { abortReason, sleepFor } from "../../net/abort.js";
import { DESTINATION_TIMEOUT_MS } from "../../net/contract.js";
import { BUDGET_FAMILIES } from "../../net/rate-limits.js";
import { withPluginHostScope } from "../../plugins/host.js";
import { pluginPolicy } from "../../plugins/lock.js";
import { createAuditContext, type AuditContext } from "../context.js";
import { AuditError } from "../errors.js";
import { auditContextFor, bindAuditContext, type ApiContext } from "../session.js";
import { readError } from "./errors.js";
import { auditList as auditListApi, type AuditWindowSummary } from "./audit-list.js";
import { drawContext as drawContextApi, type DrawContext } from "./draw-context.js";
import { draws as drawsApi, type DrawsView } from "./draws.js";
import { freezeEstimate as freezeEstimateApi, freezePreview as freezePreviewApi, freezePreviewKey, type FreezeEstimateResult, type FreezePreview } from "./freeze-preview.js";
import { simulateBounded, type SimulateInput, type SimulateReport } from "./simulate.js";
export { SIMULATE_MAX_DRAWS } from "./simulate.js";
import { status as statusApi, type StatusResult } from "./status.js";
import { verify as verifyApi, type VerifyResult } from "./verify.js";

/**
 * `pr-rla/api/read` (contracts.md §1a; functional-design.md §U5): the read functions of the audit
 * API, fixed to read-only mode. It is the only part of pr-rla the MCP server imports.
 *
 * Every call runs on its own read-only context: the fetch broker refuses any request that is not
 * a read (ReadOnlyViolation), records nothing, and opens ledgers with their read methods only. No
 * write function is reachable from here: `src/api/write/` is never imported (a test checks the
 * import graph), and there is no option that turns the mode off.
 */

export type { AuditWindowSummary } from "./audit-list.js";
export type { DrawContext, DrawContextFile, DrawVerdictState } from "../../core/draw-context.js";
export type { DrawsView, DrawView } from "./draws.js";
export type { FreezeEstimateResult, FreezePreview } from "./freeze-preview.js";
export type { SimulateInput, SimulateReport } from "./simulate.js";
export type { StatusResult } from "./status.js";
export type { VerifyResult } from "./verify.js";
export type { AuditErrorCode } from "../errors.js";

/** How a read call reaches the outside world. Everything is optional. */
export interface ReadOptions {
  /** The environment tokens are read from (default: none, so every request is anonymous). */
  env?: Readonly<Record<string, string | undefined>>;
  /** The transport under the read-only broker (default global fetch). */
  fetch?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Notes and provider progress lines for a person (default: dropped). */
  log?: (line: string) => void;
  /** Progress of a long call (a freeze preview, an online verify). */
  onProgress?: (p: { done: number; total?: number; message: string }) => void;
  /** Stops the call: every request, wait and plugin call it makes (U5 fix round). */
  signal?: AbortSignal;
  /** Refuses a file or directory the call may not open (the MCP server's roots); throw to refuse. Every file is checked by its real path as it is opened. */
  confine?: (path: string, what: string) => void;
  /** The directories the call may open: git never looks for a repository above them (GIT_CEILING_DIRECTORIES). */
  roots?: readonly string[];
  /** `builtin-only` refuses every external plugin (as PR_RLA_PLUGINS=builtin-only in `env` does). */
  plugins?: "builtin-only";
  /** Calls passing the same object share one fetch broker per audit directory, and its per-host budgets. */
  session?: object;
  /**
   * freezePreview only: finished previews by key (window, registration digest, estimate), kept by
   * the caller. A preview younger than `previewTtlMs` (default 600 s) is returned from it.
   */
  previewCache?: Map<string, { at: number; value: FreezePreview | FreezeEstimateResult }>;
  previewTtlMs?: number;
}

export interface AuditInput {
  /** The audit repo: the directory holding .pr-rla.yml. */
  dir: string;
  /** Another config file than <dir>/.pr-rla.yml. */
  config?: string;
}

/** The current call's options, so a broker shared by a session reports each call's notes to that call. */
const current = new AsyncLocalStorage<ReadOptions>();
const sessions = new WeakMap<object, Map<string, AuditContext>>();

/**
 * How long one long read call may run in all (the MCP server's per-job deadline), derived from the
 * broker's budgets rather than picked: the longest default budget window of any host (GitHub's
 * and Bitbucket Cloud's hourly budgets: 1 h), so a call can wait out one full refill of its host's
 * budget, plus one SCM request's timeout (30 s), so a request sent just before then can finish.
 * The measured gh-aw Q3 freeze (about 22 min, nfr-design.md §3) fits. A call that needs more has
 * exhausted a budget and is waiting on the next one: the CLI, which keeps checkpoints and resumes,
 * is the place for it.
 */
export const LONG_CALL_DEADLINE_MS = Math.max(...Object.values(BUDGET_FAMILIES).flatMap((f) => f.rules.map((r) => r.perMs))) + DESTINATION_TIMEOUT_MS.scm;

/** The real path of `p`, or for a path that does not exist, of its nearest existing ancestor plus the rest. */
function realOrNearest(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return resolve(p);
    rest.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...rest);
}

/** The caller's `confine`, its refusals as ROOT_ESCAPE in pr-rla's error. */
function confinement(o: ReadOptions): Confinement | undefined {
  if (!o.confine && !o.roots) return undefined;
  const roots = (o.roots ?? []).map((r) => realpathSync(r));
  const inside = (real: string) => roots.some((r) => {
    const rel = relative(r, real);
    return rel === "" || (rel.split(sep)[0] !== ".." && !isAbsolute(rel));
  });
  const confine = (path: string, what: string) => {
    if (!o.confine) {
      if (!inside(realOrNearest(path))) throw new AuditError(`${what} resolves outside the roots this call may open`, 1, "ROOT_ESCAPE");
      return;
    }
    try {
      o.confine(path, what);
    } catch (e) {
      if (e instanceof AuditError) throw e;
      const x = e as { message?: unknown; next?: unknown };
      throw new AuditError(typeof x?.message === "string" ? x.message : `${what} is outside the roots`, 1, "ROOT_ESCAPE", typeof x?.next === "string" ? x.next : undefined);
    }
  };
  return { confine, gitCeilings: roots };
}

function readContext(input: AuditInput, o: ReadOptions): ApiContext {
  const cwd = resolve(input.dir);
  const c = confinement(o);
  const ctx: ApiContext = {
    cwd,
    ...(input.config ? { configPath: resolve(cwd, input.config) } : {}),
    env: o.env ?? {},
    nowMs: o.nowMs ?? Date.now,
    fetch: o.fetch ?? globalThis.fetch,
    err: (l) => o.log?.(l),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.plugins ? { plugins: o.plugins } : {}),
    ...(c ? { confine: c.confine } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    mode: "read-only",
  };
  if (o.session) {
    let byDir = sessions.get(o.session);
    if (!byDir) sessions.set(o.session, (byDir = new Map()));
    const key = `${cwd}\u0000${input.config ?? ""}`;
    let actx = byDir.get(key);
    if (!actx) {
      actx = createAuditContext({
        mode: "read-only",
        env: ctx.env,
        nowMs: () => ctx.nowMs(),
        sleep: (ms, signal) => (o.sleep ? o.sleep(ms) : sleepFor(ms, signal)),
        log: (l) => (current.getStore() ?? o).log?.(l),
        fetch: ((i, init) => (o.fetch ?? globalThis.fetch)(i, init)) as typeof fetch,
        plugins: pluginPolicy(o.plugins, ctx.env),
      });
      byDir.set(key, actx);
    }
    bindAuditContext(ctx, actx);
  } else auditContextFor(ctx);
  return ctx;
}

/**
 * Runs one read call: its notes go to its own options, every file it opens is confined to the
 * caller's roots, the plugin hosts it started stop when it ends, and what it throws is pr-rla's
 * error, with anything pr-rla did not write in `untrusted` (./errors.ts).
 */
const run = <T>(o: ReadOptions, fn: () => Promise<T>): Promise<T> =>
  current.run(o, () =>
    withConfinement(confinement(o), () =>
      withPluginHostScope(async () => {
        try {
          return await fn();
        } catch (e) {
          // A stopped call: the stop is the error, whatever the work threw on its way out.
          if (o.signal?.aborted) throw abortReason(o.signal);
          throw readError(e);
        }
      }),
    ),
  );

/** The audit directory's windows and the phase of each (offline). */
export function auditList(input: AuditInput, options: ReadOptions = {}): Promise<{ dir: string; windows: AuditWindowSummary[] }> {
  return run(options, () => auditListApi(readContext(input, options)));
}

/**
 * Where a window stands. Offline by default: no provider call and no tracker read (a tracker
 * ledger's verdicts are then not read). Never appends a checkpoint.
 */
export function status(input: AuditInput & { window?: string; offline?: boolean }, options: ReadOptions = {}): Promise<StatusResult> {
  const offline = input.offline ?? true;
  return run(options, () => statusApi(readContext(input, options), { ...(input.window !== undefined ? { window: input.window } : {}), offline, skipTrackerLedger: offline }));
}

/** The issued draws with their verdict state, and the draw that holds the prefix back (no network). */
export function draws(input: AuditInput & { window?: string; from?: number; limit?: number }, options: ReadOptions = {}): Promise<DrawsView> {
  return run(options, () => drawsApi(readContext(input, options), { ...(input.window !== undefined ? { window: input.window } : {}), ...(input.from !== undefined ? { from: input.from } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) }));
}

/** One issued draw as a reviewer needs it, with the untrusted-content fence the core built. */
export function drawContext(input: AuditInput & { window?: string; draw: number; maxPatchBytes?: number }, options: ReadOptions = {}): Promise<DrawContext> {
  return run(options, () => drawContextApi(readContext(input, options), { draw: input.draw, ...(input.window !== undefined ? { window: input.window } : {}), ...(input.maxPatchBytes !== undefined ? { maxPatchBytes: input.maxPatchBytes } : {}) }));
}

/** The seven checks. Offline by default (no population rebuild, no fetch). */
export function verify(input: AuditInput & { window?: string; offline?: boolean }, options: ReadOptions = {}): Promise<VerifyResult> {
  return run(options, () => verifyApi(readContext(input, options), { ...(input.window !== undefined ? { window: input.window } : {}), offline: input.offline ?? true }));
}

/**
 * The population a freeze would write now, built in memory; never written anywhere. With `estimate` (U8): what a
 * pooled freeze would cost instead, from the repo set's resolution and a probe of each repo's first page.
 */
export function freezePreview(input: AuditInput & { window?: string; estimate: true }, options?: ReadOptions): Promise<FreezeEstimateResult & { cached?: true }>;
export function freezePreview(input: AuditInput & { window?: string; estimate?: false }, options?: ReadOptions): Promise<FreezePreview & { cached?: true }>;
export function freezePreview(input: AuditInput & { window?: string; estimate?: boolean }, options?: ReadOptions): Promise<(FreezePreview | FreezeEstimateResult) & { cached?: true }>;
export function freezePreview(input: AuditInput & { window?: string; estimate?: boolean }, options: ReadOptions = {}): Promise<(FreezePreview | FreezeEstimateResult) & { cached?: true }> {
  return run(options, async () => {
    const ctx = readContext(input, options);
    const opts = { ...(input.window !== undefined ? { window: input.window } : {}), ...(input.estimate ? { estimate: true } : {}) };
    const cache = options.previewCache;
    const key = cache ? freezePreviewKey(ctx, opts) : null;
    const now = ctx.nowMs();
    if (cache && key) {
      for (const [k, v] of cache) if (now - v.at >= (options.previewTtlMs ?? 600_000)) cache.delete(k);
      const hit = cache.get(key);
      if (hit) return { ...hit.value, cached: true as const };
    }
    const value = input.estimate ? await freezeEstimateApi(ctx, input.window !== undefined ? { window: input.window } : {}) : await freezePreviewApi(ctx, opts);
    if (cache && key) cache.set(key, { at: ctx.nowMs(), value });
    return value;
  });
}

/**
 * The scoring code against an oracle population. Pure: no file, no network. An input whose worst
 * case is over SIMULATE_MAX_DRAWS (runs × cap) is refused with TOO_MUCH_WORK before it starts; the
 * rest runs in slices that yield to other calls, and stops when `options.signal` aborts.
 */
export function simulate(input: SimulateInput, options: ReadOptions = {}): Promise<SimulateReport> {
  return simulateBounded(input, { ...(options.signal ? { signal: options.signal } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}) });
}
