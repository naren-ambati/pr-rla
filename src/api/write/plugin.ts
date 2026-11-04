import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE, loadConfig, type PrRlaConfig } from "../../config.js";
import { inspectPlugin as inspect, lockEntryFor as entryFor } from "../../plugins/entry.js";
import { installScripts, lockPath, readLock, refuseIfBuiltinOnly, resolvePlugin, writeLock, type LockEntry, type LockFile, type PluginTrust, type ResolvedPlugin } from "../../plugins/lock.js";
import { builtinLedgerName, builtinProviderName } from "../../registry.js";
import { AuditError } from "../errors.js";
import { auditContextFor, requireWritable, type ApiContext } from "../session.js";

/**
 * `plugin add` and `plugin lock` (functional-design.md §U2b; FR2.2, FR2.3), the only writers of
 * pr-rla.lock.json. Each is prepared first (what would be trusted, for a person to review), then
 * committed. CLI only; refused in a read-only context.
 */

export type PluginKind = "provider" | "ledger";

/** Where `use` appears in .pr-rla.yml: the kind, and the options its hosts are computed with. */
export function configuredPlugin(config: PrRlaConfig | null, use: string): { kind: PluginKind; options: Record<string, unknown> } | null {
  if (config?.provider.use === use) return { kind: "provider", options: config.provider.options };
  if (config?.ledger.use === use) return { kind: "ledger", options: config.ledger.options };
  return null;
}

/** The audit's .pr-rla.yml, or null when there is none. */
export function configIn(ctx: ApiContext): PrRlaConfig | null {
  const path = ctx.configPath ? resolve(ctx.cwd, ctx.configPath) : join(ctx.cwd, CONFIG_FILE);
  return existsSync(path) ? loadConfig(path) : null;
}

function trustOf(v: string | undefined, fallback: PluginTrust): PluginTrust {
  if (v === undefined) return fallback;
  if (v !== "isolated" && v !== "full") throw new AuditError(`--trust ${v}: use isolated (the default) or full`);
  return v;
}

/** Warnings for install scripts in the plugin's package tree (FR2.3: printed, not refused). */
export function installScriptWarnings(plugin: ResolvedPlugin): string[] {
  return installScripts(plugin).map((w) => `warning: ${w.pkg} declares install scripts (${w.scripts.join(", ")}); pr-rla plugins need none. Install plugins with "npm ci --ignore-scripts".`);
}

function resolveForLock(ctx: ApiContext, kind: PluginKind, use: string, config: PrRlaConfig): ResolvedPlugin {
  refuseIfBuiltinOnly(auditContextFor(ctx).plugins, kind, use);
  const plugin = resolvePlugin(use, config.dir);
  if (plugin.source === "package" && !plugin.npm)
    throw new AuditError(`package ${use} has no entry in the audit repo's package-lock.json, so its npm integrity cannot be recorded. Install it with npm (npm install --save-exact ${use} --ignore-scripts), or use it by path`);
  return plugin;
}

function requireConfigured(ctx: ApiContext, use: string, command: string): { config: PrRlaConfig; kind: PluginKind; options: Record<string, unknown> } {
  const config = configIn(ctx);
  if (!config) throw new AuditError(`no ${CONFIG_FILE} in ${ctx.cwd}: "pr-rla ${command}" locks the plugins an audit configures`);
  const c = configuredPlugin(config, use);
  if (!c) throw new AuditError(`${use} is not the provider or the ledger in ${config.configPath}; configure it there first (its options decide the hosts it may contact)`);
  if ((c.kind === "provider" ? builtinProviderName(use) : builtinLedgerName(use)) !== null) throw new AuditError(`${use} is built in; built-in plugins need no lock`);
  return { config, ...c };
}

/** What `plugin add` or `plugin lock` would write, for review before it is committed. */
export interface PluginLockPlan {
  use: string;
  kind: PluginKind;
  auditDir: string;
  lockFile: string;
  entry: LockEntry;
  /** The entry being replaced (`plugin lock`), or null (`plugin add`). */
  previous: LockEntry | null;
  /** Fields that differ from `previous` (empty for `plugin add`, and for an unchanged `plugin lock`). */
  changes: (keyof LockEntry)[];
  nodeMajor: number;
  installScriptWarnings: string[];
  /** The lock as read, to which the entry is added. */
  lock: LockFile;
}

export async function preparePluginAdd(ctx: ApiContext, use: string, opts: { trust?: string } = {}): Promise<PluginLockPlan> {
  requireWritable(ctx, "plugin add");
  const { config, kind, options } = requireConfigured(ctx, use, "plugin add");
  const lock = readLock(config.dir);
  if (Object.hasOwn(lock.plugins, use)) throw new AuditError(`${use} is already in ${lockPath(config.dir)}; to trust a reviewed change, run "pr-rla plugin lock ${use}"`);
  const plugin = resolveForLock(ctx, kind, use, config);
  const x = await inspect(kind, use, plugin, options);
  const entry = entryFor(plugin, x, trustOf(opts.trust, "isolated"));
  return { use, kind, auditDir: config.dir, lockFile: lockPath(config.dir), entry, previous: null, changes: [], nodeMajor: x.nodeMajor, installScriptWarnings: installScriptWarnings(plugin), lock };
}

export async function preparePluginLock(ctx: ApiContext, use: string, opts: { trust?: string } = {}): Promise<PluginLockPlan> {
  requireWritable(ctx, "plugin lock");
  const { config, kind, options } = requireConfigured(ctx, use, "plugin lock");
  const lock = readLock(config.dir);
  const old = Object.hasOwn(lock.plugins, use) ? lock.plugins[use] : undefined;
  if (!old) throw new AuditError(`plugin ${use} is not locked; review it and run "pr-rla plugin add ${use}"`);
  const plugin = resolveForLock(ctx, kind, use, config);
  const x = await inspect(kind, use, plugin, options);
  const entry = entryFor(plugin, x, trustOf(opts.trust, old.trust));
  const changes = (Object.keys(entry) as (keyof LockEntry)[]).filter((k) => JSON.stringify(old[k]) !== JSON.stringify(entry[k]));
  return { use, kind, auditDir: config.dir, lockFile: lockPath(config.dir), entry, previous: old, changes, nodeMajor: x.nodeMajor, installScriptWarnings: installScriptWarnings(plugin), lock };
}

/** Writes the reviewed entry into pr-rla.lock.json. */
export function commitPluginLock(ctx: ApiContext, plan: PluginLockPlan): void {
  requireWritable(ctx, plan.previous ? "plugin lock" : "plugin add");
  writeLock(plan.auditDir, { ...plan.lock, plugins: { ...plan.lock.plugins, [plan.use]: plan.entry } });
}
