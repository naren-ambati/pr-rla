import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE, loadConfig, type PrRlaConfig } from "../config.js";
import { builtinLedgerName, builtinProviderName } from "../registry.js";
import { formatConformanceReport } from "../testing/conformance.js";
import { CORRECTNESS_NOT_SAFETY, fixtureName, hostedLedgerConformance, hostedProviderConformance, readRecordedFixture, readRecordedLedgerFixture } from "../plugins/check.js";
import { formatLedgerConformanceReport } from "../testing/ledger-conformance.js";
import { inspectPlugin as inspect, lockEntryFor as entryFor } from "../plugins/entry.js";
import { NETWORK_DENIED_FROM_NODE } from "../plugins/host.js";
import { installScripts, lockPath, readLock, refuseIfBuiltinOnly, resolvePlugin, verifyLocked, writeLock, type LockedCredential, type LockEntry, type PluginTrust, type ResolvedPlugin } from "../plugins/lock.js";
import { planBuiltinApproval, planBuiltinPairApproval, planPluginApproval, recordLockApproval } from "../plugins/approve.js";
import { auditContextFor, CommandError, isoNow, type CommandContext } from "./context.js";

/**
 * `pr-rla plugin add | lock | check` (functional-design.md §U2b; FR2.2, FR2.3, FR2.7).
 *
 * `add` and `lock` are the only writers of pr-rla.lock.json. Both print everything they are
 * about to trust and ask first (or take --yes), and record your approval on this machine
 * (src/plugins/approvals.ts). `approve` records an approval for a plugin someone else locked.
 * `check` writes nothing.
 */

type Kind = "provider" | "ledger";

export interface PluginAddOptions {
  yes?: boolean;
  /** "isolated" (default) or "full" (in process, with your environment and files). */
  trust?: string;
}

export interface PluginCheckOptions {
  /** Recorded fixtures to run the kit on, besides those the plugin's package.json lists. */
  fixture?: string[];
  /** Skip `npm audit signatures` (it asks the npm registry). */
  offline?: boolean;
  /** For a plugin not named in .pr-rla.yml. */
  kind?: string;
}

function configIn(ctx: CommandContext): PrRlaConfig | null {
  const path = ctx.configPath ? resolve(ctx.cwd, ctx.configPath) : join(ctx.cwd, CONFIG_FILE);
  return existsSync(path) ? loadConfig(path) : null;
}

/** Where `use` appears in .pr-rla.yml: the kind, and the options its hosts are computed with. */
function configured(config: PrRlaConfig | null, use: string): { kind: Kind; options: Record<string, unknown> } | null {
  if (config?.provider.use === use) return { kind: "provider", options: config.provider.options };
  if (config?.ledger.use === use) return { kind: "ledger", options: config.ledger.options };
  return null;
}

function trustOf(v: string | undefined, fallback: PluginTrust): PluginTrust {
  if (v === undefined) return fallback;
  if (v !== "isolated" && v !== "full") throw new CommandError(`--trust ${v}: use isolated (the default) or full`);
  return v;
}

function trustText(trust: PluginTrust, nodeMajor: number): string {
  if (trust === "full") return "full: IN THIS PROCESS, with your environment and files (every command prints PLUGIN TRUST: full)";
  const net = nodeMajor >= NETWORK_DENIED_FROM_NODE ? "no network" : `Node ${nodeMajor} cannot block its network access`;
  return `isolated: out of process, placeholder credentials, read-only access to its own files; ${net}`;
}

/** `GITEA_TOKEN -> gitea.example.com (the host of option base_url)`. */
function credentialText(c: LockedCredential): string {
  const from = c.hostFromOption === undefined ? "" : c.hosts.length ? ` (the host of option ${c.hostFromOption})` : ` (option ${c.hostFromOption} is not an https:// URL)`;
  return `${c.env} -> ${c.hosts.join(", ") || "none"}${from}`;
}

function describeEntry(e: LockEntry, nodeMajor: number): string[] {
  const list = (a: string[]) => (a.length ? a.join(", ") : "none");
  const integrity = e.npmIntegrity ?? (e.source === "path" ? "none (a path plugin: the tree hash and the audit repo's git history pin it)" : "none (npm installed it from a local path: the tree hash pins it)");
  return [
    `  source        ${e.source}`,
    `  version       ${e.version ?? "none"}`,
    `  resolved      ${e.resolved ?? "none"}`,
    `  npmIntegrity  ${integrity}`,
    `  treeSha256    ${e.treeSha256}`,
    `  trust         ${trustText(e.trust, nodeMajor)}`,
    `  hosts         ${list(e.hosts)}`,
    `  writePaths    ${list(e.writePaths)}`,
    `  credentials   ${e.credentials.length ? e.credentials.map(credentialText).join("; ") : "none"}`,
  ];
}

function warnInstallScripts(ctx: CommandContext, plugin: ResolvedPlugin): void {
  for (const w of installScripts(plugin)) ctx.err(`warning: ${w.pkg} declares install scripts (${w.scripts.join(", ")}); pr-rla plugins need none. Install plugins with "npm ci --ignore-scripts".`);
}

async function confirm(ctx: CommandContext, yes: boolean | undefined, question: string, command: string): Promise<boolean> {
  if (yes) return true;
  if (!ctx.confirm) throw new CommandError(`${command} needs your confirmation: review the lines above, then run it again with --yes`);
  return ctx.confirm(question);
}

function resolveForLock(ctx: CommandContext, kind: Kind, use: string, config: PrRlaConfig): ResolvedPlugin {
  refuseIfBuiltinOnly(auditContextFor(ctx).plugins, kind, use);
  const plugin = resolvePlugin(use, config.dir);
  if (plugin.source === "package" && !plugin.npm)
    throw new CommandError(`package ${use} has no entry in the audit repo's package-lock.json, so its npm integrity cannot be recorded. Install it with npm (npm install --save-exact ${use} --ignore-scripts), or use it by path`);
  return plugin;
}

function requireConfigured(ctx: CommandContext, use: string, command: string): { config: PrRlaConfig; kind: Kind; options: Record<string, unknown> } {
  const config = configIn(ctx);
  if (!config) throw new CommandError(`no ${CONFIG_FILE} in ${ctx.cwd}: "pr-rla ${command}" locks the plugins an audit configures`);
  const c = configured(config, use);
  if (!c) throw new CommandError(`${use} is not the provider or the ledger in ${config.configPath}; configure it there first (its options decide the hosts it may contact)`);
  if ((c.kind === "provider" ? builtinProviderName(use) : builtinLedgerName(use)) !== null) throw new CommandError(`${use} is built in; built-in plugins need no lock`);
  return { config, ...c };
}

export async function pluginAddCommand(ctx: CommandContext, use: string, opts: PluginAddOptions): Promise<number> {
  const { config, kind, options } = requireConfigured(ctx, use, "plugin add");
  const lock = readLock(config.dir);
  if (Object.hasOwn(lock.plugins, use)) throw new CommandError(`${use} is already in ${lockPath(config.dir)}; to trust a reviewed change, run "pr-rla plugin lock ${use}"`);
  const plugin = resolveForLock(ctx, kind, use, config);
  const x = await inspect(kind, use, plugin, options);
  const entry = entryFor(plugin, x, trustOf(opts.trust, "isolated"));
  ctx.out(`plugin add ${use}: ${kind} ${entry.name}`);
  for (const l of describeEntry(entry, x.nodeMajor)) ctx.out(l);
  warnInstallScripts(ctx, plugin);
  if (!(await confirm(ctx, opts.yes, `Trust ${use} as shown and add it to ${lockPath(config.dir)}?`, "plugin add"))) {
    ctx.out("not added");
    return 1;
  }
  writeLock(config.dir, { ...lock, plugins: { ...lock.plugins, [use]: entry } });
  ctx.out(`added ${use} to ${lockPath(config.dir)}; commit it with the audit`);
  ctx.out(recordLockApproval(auditContextFor(ctx).consent, use, entry, isoNow(ctx)));
  return 0;
}

export async function pluginLockCommand(ctx: CommandContext, use: string, opts: PluginAddOptions): Promise<number> {
  const { config, kind, options } = requireConfigured(ctx, use, "plugin lock");
  const lock = readLock(config.dir);
  const old = Object.hasOwn(lock.plugins, use) ? lock.plugins[use] : undefined;
  if (!old) throw new CommandError(`plugin ${use} is not locked; review it and run "pr-rla plugin add ${use}"`);
  const plugin = resolveForLock(ctx, kind, use, config);
  const x = await inspect(kind, use, plugin, options);
  const entry = entryFor(plugin, x, trustOf(opts.trust, old.trust));
  const changes = (Object.keys(entry) as (keyof LockEntry)[]).filter((k) => JSON.stringify(old[k]) !== JSON.stringify(entry[k]));
  if (!changes.length) {
    ctx.out(`${use}: unchanged since it was locked (treeSha256 ${entry.treeSha256.slice(0, 12)}…)`);
    return 0;
  }
  ctx.out(`plugin lock ${use}: ${kind} ${entry.name} changed since it was locked`);
  for (const k of changes) ctx.out(`  ${k.padEnd(13)} ${JSON.stringify(old[k])} -> ${JSON.stringify(entry[k])}`);
  ctx.out("now:");
  for (const l of describeEntry(entry, x.nodeMajor)) ctx.out(l);
  warnInstallScripts(ctx, plugin);
  if (!(await confirm(ctx, opts.yes, `Trust the changed ${use} and update ${lockPath(config.dir)}?`, "plugin lock"))) {
    ctx.out("not updated");
    return 1;
  }
  writeLock(config.dir, { ...lock, plugins: { ...lock.plugins, [use]: entry } });
  ctx.out(`updated ${use} in ${lockPath(config.dir)}; commit it with the audit`);
  ctx.out(recordLockApproval(auditContextFor(ctx).consent, use, entry, isoNow(ctx)));
  return 0;
}

export interface PluginApproveOptions {
  yes?: boolean;
  /** With `origin`: approve this credential for built-in providers and ledgers. */
  env?: string;
  origin?: string;
}

/**
 * `pr-rla plugin approve <use>`: shows what the plugin, as the audit's lock pins it, would be granted
 * on this machine (its trust, each credential and the origins it may go to), asks (or takes --yes),
 * and records the approval in your approvals file. Nothing in the audit repo changes.
 */
export async function pluginApproveCommand(ctx: CommandContext, use: string | undefined, opts: PluginApproveOptions): Promise<number> {
  const consent = auditContextFor(ctx).consent;
  if ((opts.env === undefined) !== (opts.origin === undefined)) throw new CommandError("plugin approve: --env and --origin go together (the variable and the https origin built-ins may send it to)");
  if (use !== undefined && opts.env !== undefined) throw new CommandError("plugin approve: give a plugin's use, or --env and --origin, not both");
  if (use === undefined && opts.env === undefined) throw new CommandError("plugin approve needs the plugin's use (as in .pr-rla.yml), or --env <ENV> --origin <https-url> for a built-in's credential");
  const config = configIn(ctx);
  const c = use === undefined ? null : configured(config, use);
  const builtin = c && use !== undefined ? (c.kind === "provider" ? builtinProviderName(use) : builtinLedgerName(use)) : null;
  const plan =
    use === undefined
      ? planBuiltinPairApproval(consent, opts.env!, opts.origin!)
      : builtin && c
        ? planBuiltinApproval(consent, c.kind, builtin, { use, options: c.options }, ctx.env)
        : planPluginApproval(consent, config?.dir ?? ctx.cwd, use);
  for (const l of plan.lines) ctx.out(l);
  if (plan.nothing) {
    ctx.out(plan.nothing);
    return 0;
  }
  if (!(await confirm(ctx, opts.yes, plan.question, "plugin approve"))) {
    ctx.out("not approved");
    return 1;
  }
  ctx.out(plan.record(isoNow(ctx)));
  return 0;
}

/** `npm audit signatures` for a package plugin (it asks the npm registry; the core never verifies Sigstore itself). */
function npmSignatures(plugin: ResolvedPlugin, offline: boolean | undefined): string {
  if (plugin.source === "path") return "not applicable: a path plugin is not from the npm registry";
  if (offline) return "skipped (--offline)";
  const r = spawnSync("npm", ["audit", "signatures"], { cwd: dirname(plugin.npm?.lockfile ?? plugin.root), encoding: "utf8", timeout: 120_000 });
  if (r.error) return `skipped: ${(r.error as NodeJS.ErrnoException).code === "ENOENT" ? "npm is not on PATH" : r.error.message}`;
  const summary = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim()).filter((l) => /signature|attestation|audited/i.test(l));
  return `${r.status === 0 ? "ok" : "FAILED"}: ${summary.join("; ") || "no output"}`;
}

export async function pluginCheckCommand(ctx: CommandContext, use: string, opts: PluginCheckOptions): Promise<number> {
  const config = configIn(ctx);
  const c = configured(config, use);
  const kind: Kind = c?.kind ?? (opts.kind === "ledger" ? "ledger" : "provider");
  if (opts.kind !== undefined && opts.kind !== "provider" && opts.kind !== "ledger") throw new CommandError(`--kind ${opts.kind}: use provider or ledger`);
  if ((kind === "provider" ? builtinProviderName(use) : builtinLedgerName(use)) !== null) throw new CommandError(`${use} is built in; "plugin check" is for external plugins`);
  refuseIfBuiltinOnly(auditContextFor(ctx).plugins, kind, use);
  const dir = config?.dir ?? ctx.cwd;
  const plugin = resolvePlugin(use, dir);
  let lockLine: string;
  try {
    const { entry } = verifyLocked(use, dir);
    lockLine = `locked, files match (treeSha256 ${entry.treeSha256.slice(0, 12)}…, trust ${entry.trust})`;
  } catch (e) {
    const code = (e as { code?: string }).code;
    lockLine = code === "NOT_LOCKED" ? `not locked: run "pr-rla plugin add ${use}" to trust it` : code === "LOCK_MISMATCH" ? `CHANGED since it was locked: ${(e as Error).message}` : `cannot check: ${(e as Error).message}`;
  }
  const declared = plugin.pkg?.["pr-rla"] && typeof plugin.pkg["pr-rla"] === "object" ? (plugin.pkg["pr-rla"] as { conformance?: unknown }).conformance : undefined;
  const files = [...(Array.isArray(declared) ? declared.filter((f): f is string => typeof f === "string").map((f) => resolve(plugin.rootIsFile ? dirname(plugin.root) : plugin.root, f)) : []), ...(opts.fixture ?? []).map((f) => resolve(ctx.cwd, f))];
  // A ledger not named in .pr-rla.yml is asked with its first recorded fixture's options (a ledger usually needs its tracker's URL).
  const ledgerRecs = kind === "ledger" ? files.map((f) => ({ name: fixtureName(f), rec: readRecordedLedgerFixture(f) })) : [];
  const asked = c?.options ?? ledgerRecs[0]?.rec.options ?? {};
  const x = await inspect(kind, use, plugin, asked);
  ctx.out(`plugin check ${use}: ${kind} ${x.name}${plugin.version ? `@${plugin.version}` : ""} (${plugin.source})`);
  ctx.out(`  lock            ${lockLine}`);
  ctx.out(`  npm signatures  ${npmSignatures(plugin, opts.offline)}`);
  ctx.out(`  hosts           ${x.hosts.join(", ") || "none"}${c ? "" : ledgerRecs[0]?.rec.options ? ` (with the options of ${ledgerRecs[0].name}: not named in .pr-rla.yml)` : " (with no options: not named in .pr-rla.yml)"}`);
  ctx.out(`  credentials     ${x.credentials.length ? x.credentials.map(credentialText).join("; ") : "none"}`);
  warnInstallScripts(ctx, plugin);
  let ok = false;
  if (!files.length) ctx.out(`  conformance     not run: no fixtures (list recorded ${kind} fixtures in the plugin's package.json as "pr-rla": { "conformance": [...] }, or pass --fixture <file>)`);
  else {
    // A ledger's recorded fixtures run the ledger kit (finding 15), a provider's the provider kit; both through the host.
    ctx.out(`  conformance     the ${kind} kit through the plugin host, on ${files.length} recorded fixture(s)`);
    const report =
      kind === "ledger"
        ? await hostedLedgerConformance(plugin, use, ledgerRecs)
        : await hostedProviderConformance(plugin, use, files.map((f) => ({ name: fixtureName(f), rec: readRecordedFixture(f) })));
    for (const l of (kind === "ledger" ? formatLedgerConformanceReport(report) : formatConformanceReport(report)).split("\n")) ctx.out(`    ${l}`);
    ok = report.ok;
    ctx.out(`  conformance     ${ok ? "PASS" : "FAIL"}`);
  }
  ctx.out(CORRECTNESS_NOT_SAFETY);
  return ok ? 0 : 1;
}
