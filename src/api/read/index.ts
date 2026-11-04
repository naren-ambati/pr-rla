import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { createAuditContext, type AuditContext } from "../context.js";
import { auditContextFor, bindAuditContext, type ApiContext } from "../session.js";
import { pluginPolicy } from "../../plugins/lock.js";
import { auditList as auditListApi, type AuditWindowSummary } from "./audit-list.js";
import { drawContext as drawContextApi, type DrawContext } from "./draw-context.js";
import { draws as drawsApi, type DrawsView } from "./draws.js";
import { freezePreview as freezePreviewApi, freezePreviewKey, type FreezePreview } from "./freeze-preview.js";
import { simulate as simulateApi, type SimulateInput, type SimulateReport } from "./simulate.js";
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
export type { FreezePreview } from "./freeze-preview.js";
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
  /** Aborts the call's provider requests. */
  signal?: AbortSignal;
  /** Refuses a file or directory the call may not open (the MCP server's roots); throw to refuse. */
  confine?: (path: string, what: string) => void;
  /** `builtin-only` refuses every external plugin (as PR_RLA_PLUGINS=builtin-only in `env` does). */
  plugins?: "builtin-only";
  /** Calls passing the same object share one fetch broker per audit directory, and its per-host budgets. */
  session?: object;
  /**
   * freezePreview only: finished previews by key (window, registration digest, estimate), kept by
   * the caller. A preview younger than `previewTtlMs` (default 600 s) is returned from it.
   */
  previewCache?: Map<string, { at: number; value: FreezePreview }>;
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

function readContext(input: AuditInput, o: ReadOptions): ApiContext {
  const cwd = resolve(input.dir);
  const ctx: ApiContext = {
    cwd,
    ...(input.config ? { configPath: resolve(cwd, input.config) } : {}),
    env: o.env ?? {},
    nowMs: o.nowMs ?? Date.now,
    fetch: o.fetch ?? globalThis.fetch,
    err: (l) => o.log?.(l),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.plugins ? { plugins: o.plugins } : {}),
    ...(o.confine ? { confine: o.confine } : {}),
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
        sleep: (ms) => (o.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms),
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

const run = <T>(o: ReadOptions, fn: () => Promise<T>): Promise<T> => current.run(o, fn);

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

/** The population a freeze would write now, built in memory; never written anywhere. */
export function freezePreview(input: AuditInput & { window?: string; estimate?: boolean }, options: ReadOptions = {}): Promise<FreezePreview & { cached?: true }> {
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
    const value = await freezePreviewApi(ctx, opts);
    if (cache && key) cache.set(key, { at: ctx.nowMs(), value });
    return value;
  });
}

/** The scoring code against an oracle population. Pure. */
export function simulate(input: SimulateInput): SimulateReport {
  return simulateApi(input);
}
