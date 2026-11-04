import { pathToFileURL } from "node:url";
import type { AuditContext } from "../api/context.js";
import type { PluginSpec } from "../registry.js";
import { assertLedgerDefinition, LedgerApiVersionError, SUPPORTED_LEDGER_API_VERSIONS, type Ledger, type LedgerDefinition } from "../sdk/ledger.js";
import { assertProviderDefinition, ProviderApiVersionError, SUPPORTED_PROVIDER_API_VERSIONS, type ProviderDefinition, type ScmProvider } from "../sdk/provider.js";
import { PluginError } from "./errors.js";
import { credentialGrants, declaredCredentials, describePlugin, hostedLedger, hostedProvider, isolationLine, startPluginHost, type PluginHost } from "./host.js";
import { placeholderEnv, readGrants, refuseIfBuiltinOnly, verifyLocked, type LockEntry, type ResolvedPlugin } from "./lock.js";

/**
 * How the PluginRegistry opens an external plugin for a command (functional-design.md §U2b):
 *
 * 1. `--plugins builtin-only` refuses before anything is resolved or imported (FR2.6);
 * 2. the plugin must be in pr-rla.lock.json, and its installed files must hash to the locked
 *    treeSha256 (FR2.2, FR2.3);
 * 3. `trust: full` loads it in this process with the real environment, and says so on every
 *    command (FR2.5); otherwise it runs in the plugin host, held to the locked hosts, write
 *    paths and credentials (FR2.4).
 */

export function fullTrustLine(entry: LockEntry): string {
  return `PLUGIN TRUST: full (${entry.name}@${entry.version ?? "unversioned"} runs with your environment and files)`;
}

function secretsFor(ctx: AuditContext, entry: LockEntry): { env: string; value: string }[] {
  return entry.credentials.flatMap((c) => (typeof ctx.env[c.env] === "string" && ctx.env[c.env] ? [{ env: c.env, value: ctx.env[c.env]! }] : []));
}

const within = (asked: readonly string[], granted: readonly string[]) => asked.filter((x) => !granted.includes(x));

/** Starts the host and refuses when the plugin now asks for more than its lock entry grants (options or code changed). */
async function startLockedHost(ctx: AuditContext, kind: "provider" | "ledger", spec: PluginSpec, entry: LockEntry, plugin: ResolvedPlugin): Promise<PluginHost> {
  const host = await startPluginHost({ kind, entry: plugin.entry, readPaths: readGrants(plugin), env: placeholderEnv(entry.credentials, ctx.env), label: spec.use, secrets: secretsFor(ctx, entry) });
  try {
    const lockAgain = `review it, then: pr-rla plugin lock ${spec.use}`;
    if (host.ready.name !== entry.name) throw new PluginError(`plugin ${spec.use} now reports the name ${JSON.stringify(host.ready.name)}; it was locked as ${entry.name}`, "LOCK_MISMATCH", lockAgain);
    const asked = await describePlugin(host, spec.options);
    const extra = [
      ...within(asked.hosts, entry.hosts).map((h) => `host ${h}`),
      ...within(asked.writePaths, entry.writePaths).map((w) => `write path ${w}`),
      ...declaredCredentials(host, spec.options).flatMap((c) => {
        const locked = entry.credentials.find((l) => l.env === c.env);
        return locked ? within(c.hosts, locked.hosts).map((h) => `credential ${c.env} for ${h}`) : [`credential ${c.env}`];
      }),
    ];
    if (extra.length) throw new PluginError(`plugin ${spec.use} asks for ${extra.join(", ")}, which its lock entry does not grant (did its options change?)`, "LOCK_MISMATCH", lockAgain);
    return host;
  } catch (e) {
    host.close();
    throw e;
  }
}

async function importInProcess(kind: "provider" | "ledger", spec: PluginSpec, entry: LockEntry, plugin: ResolvedPlugin): Promise<unknown> {
  const mod = (await import(pathToFileURL(plugin.entry).href)) as Record<string, unknown>;
  const def = mod.default ?? mod[kind];
  if (kind === "provider") assertProviderDefinition(def, `provider "${spec.use}"`);
  else assertLedgerDefinition(def, `ledger "${spec.use}"`);
  if ((def as { name: string }).name !== entry.name) throw new PluginError(`plugin ${spec.use} now reports the name ${(def as { name: string }).name}; it was locked as ${entry.name}`, "LOCK_MISMATCH", `review it, then: pr-rla plugin lock ${spec.use}`);
  return def;
}

export async function openExternalProvider(ctx: AuditContext, spec: PluginSpec, cwd: string): Promise<ScmProvider> {
  refuseIfBuiltinOnly(ctx.plugins, "provider", spec.use);
  const { entry, plugin } = verifyLocked(spec.use, cwd);
  const id = `provider:${entry.name}`;
  if (entry.trust === "full") {
    ctx.log(fullTrustLine(entry));
    const def = (await importInProcess("provider", spec, entry, plugin)) as ProviderDefinition;
    ctx.grant(id, { trust: "full", hosts: def.hosts?.(spec.options) ?? [], credentials: credentialGrants(def.credentials ?? [], spec.options) });
    const p = await def.create(spec.options, { cwd, env: ctx.env, log: ctx.log, fetch: ctx.broker.bind(id), sleep: ctx.sleep });
    if (!SUPPORTED_PROVIDER_API_VERSIONS.includes(p.apiVersion)) throw new ProviderApiVersionError(def.name, p.apiVersion);
    if (typeof p.listChanges !== "function") throw new PluginError(`provider "${def.name}" returned an object without listChanges()`, "PLUGIN_INVALID");
    return p;
  }
  ctx.grant(id, { trust: "isolated", hosts: entry.hosts, credentials: entry.credentials });
  const host = await startLockedHost(ctx, "provider", spec, entry, plugin);
  try {
    const p = await hostedProvider(host, spec.options, { cwd, fetch: ctx.broker.bind(id), sleep: ctx.sleep, log: ctx.log });
    ctx.log(isolationLine(host, entry.name, entry.version));
    return p;
  } catch (e) {
    host.close();
    throw e;
  }
}

export async function openExternalLedger(ctx: AuditContext, spec: PluginSpec, cwd: string, windowDir: string, opts: { reviewers?: readonly string[] | null } = {}): Promise<Ledger> {
  const reviewers = opts.reviewers !== undefined ? { reviewers: opts.reviewers } : {};
  refuseIfBuiltinOnly(ctx.plugins, "ledger", spec.use);
  const { entry, plugin } = verifyLocked(spec.use, cwd);
  const id = `ledger:${entry.name}`;
  if (entry.trust === "full") {
    ctx.log(fullTrustLine(entry));
    const def = (await importInProcess("ledger", spec, entry, plugin)) as LedgerDefinition;
    ctx.grant(id, { trust: "full", hosts: def.hosts?.(spec.options) ?? [], writePaths: def.writePaths?.(spec.options) ?? [], credentials: credentialGrants(def.credentials ?? [], spec.options) });
    const l = await def.create(spec.options, { cwd, windowDir, env: ctx.env, log: ctx.log, fetch: ctx.broker.bind(id), sleep: ctx.sleep, ...reviewers });
    if (!SUPPORTED_LEDGER_API_VERSIONS.includes(l.apiVersion)) throw new LedgerApiVersionError(def.name, l.apiVersion);
    for (const m of ["readVerdicts", "appendVerdict"] as const) if (typeof l[m] !== "function") throw new PluginError(`ledger "${def.name}" has no ${m}()`, "PLUGIN_INVALID");
    return l;
  }
  ctx.grant(id, { trust: "isolated", hosts: entry.hosts, writePaths: entry.writePaths, credentials: entry.credentials });
  const host = await startLockedHost(ctx, "ledger", spec, entry, plugin);
  try {
    const l = await hostedLedger(host, spec.options, { cwd, windowDir, fetch: ctx.broker.bind(id), sleep: ctx.sleep, log: ctx.log, ...reviewers });
    ctx.log(isolationLine(host, entry.name, entry.version));
    return l;
  } catch (e) {
    host.close();
    throw e;
  }
}
