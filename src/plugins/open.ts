import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuditContext } from "../api/context.js";
import { writeFileAtomic } from "../io/atomic.js";
import { INDEX_FILE } from "../ledgers/issue-index.js";
import type { PluginSpec } from "../registry.js";
import { assertLedgerDefinition, LedgerApiVersionError, SUPPORTED_LEDGER_API_VERSIONS, type Ledger, type LedgerDefinition, type LedgerIndexStore, type ProvenanceLevel } from "../sdk/ledger.js";
import { assertProviderDefinition, ProviderApiVersionError, SUPPORTED_PROVIDER_API_VERSIONS, type ProviderDefinition, type ScmProvider } from "../sdk/provider.js";
import { approveCommand, grantsOf, grantText, refuseFullTrustUnapproved, type ConsentSource } from "./approvals.js";
import { PluginError } from "./errors.js";
import { credentialGrants, declaredCredentials, describePlugin, hostedLedger, hostedProvider, isolationLine, startPluginHost, type PluginHost } from "./host.js";
import { assertLinksRunningPrRla, placeholderEnv, readGrants, refuseIfBuiltinOnly, verifyLocked, type LockEntry, type ResolvedPlugin } from "./lock.js";

/**
 * How the PluginRegistry opens an external plugin for a command (functional-design.md §U2b):
 *
 * 1. `--plugins builtin-only` refuses before anything is resolved or imported (FR2.6);
 * 2. the plugin must be in pr-rla.lock.json, and its installed files must hash to the locked
 *    treeSha256 (FR2.2, FR2.3);
 * 3. `trust: full` loads it in this process with the real environment, and says so on every
 *    command (FR2.5); otherwise it runs in the plugin host, held to the locked hosts, write
 *    paths and credentials (FR2.4).
 *
 * The lock is the repo's; what it lets a plugin send is yours (./approvals.ts). Without your
 * approval of this plugin, as locked, a `trust: full` plugin is refused before it is imported, and
 * an isolated one runs with its credentials withheld: no placeholder reaches it and the broker
 * swaps none (CREDENTIAL_NOT_APPROVED), so it works anonymously. One line names the command.
 */

export function fullTrustLine(entry: LockEntry): string {
  return `PLUGIN TRUST: full (${entry.name}@${entry.version ?? "unversioned"} runs with your environment and files)`;
}

function secretsFor(ctx: AuditContext, entry: LockEntry): { env: string; value: string; secret: boolean }[] {
  return entry.credentials.flatMap((c) => (typeof ctx.env[c.env] === "string" && ctx.env[c.env] ? [{ env: c.env, value: ctx.env[c.env]!, secret: c.secret !== false }] : []));
}

/** The credentials a lock entry grants that are set in this environment: what consent decides. */
const setCredentials = (ctx: Pick<AuditContext, "env">, entry: LockEntry) => entry.credentials.filter((c) => !!ctx.env[c.env]);

/**
 * Your consent to `use` as `entry` locks it, from the approvals file or `--accept-lock-grants`, and
 * the one line a command prints when it matters: credentials withheld, or the repo's grants accepted.
 */
export function pluginConsent(ctx: Pick<AuditContext, "consent" | "env" | "log">, use: string, entry: LockEntry): ConsentSource | null {
  const consent = ctx.consent.plugin(use, entry);
  const set = setCredentials(ctx, entry);
  if (entry.trust === "isolated" && set.length === 0) return consent;
  const what = [...(entry.trust === "full" ? ["trust: full"] : []), ...grantsOf(set).map(grantText)].join("; ");
  if (consent === null && entry.trust === "isolated") ctx.log(`plugin ${use}: not approved on this machine, so its credentials are withheld (${what}) and it runs without them; to grant them: ${approveCommand(use)}`);
  if (consent === "accepted") ctx.log(`plugin ${use}: accepting its lock's grants for this run, not approved on this machine (${what}); --accept-lock-grants is only for a repo you control`);
  return consent;
}

const within = (asked: readonly string[], granted: readonly string[]) => asked.filter((x) => !granted.includes(x));

/** Starts the host and refuses when the plugin now asks for more than its lock entry grants (options or code changed). */
async function startLockedHost(ctx: AuditContext, kind: "provider" | "ledger", spec: PluginSpec, entry: LockEntry, plugin: ResolvedPlugin, granted: boolean): Promise<PluginHost> {
  // Withheld credentials never reach the child, not even as placeholders: it runs as if they were unset.
  const host = await startPluginHost({ kind, entry: plugin.entry, readPaths: readGrants(plugin), env: placeholderEnv(granted ? entry.credentials : [], ctx.env), label: spec.use, secrets: granted ? secretsFor(ctx, entry) : [] });
  try {
    const lockAgain = `review it, then: pr-rla plugin lock ${spec.use}`;
    if (host.ready.name !== entry.name) throw new PluginError(`plugin ${spec.use} now reports the name ${JSON.stringify(host.ready.name)}; it was locked as ${entry.name}`, "LOCK_MISMATCH", lockAgain);
    const asked = await describePlugin(host, spec.options);
    const extra = [
      ...within(asked.hosts, entry.hosts).map((h) => `host ${h}`),
      ...within(asked.writePaths, entry.writePaths).map((w) => `write path ${w}`),
      ...declaredCredentials(host, spec.options).flatMap((c) => {
        const locked = entry.credentials.find((l) => l.env === c.env);
        if (!locked) return [`credential ${c.env}`];
        return [
          ...within(c.hosts, locked.hosts).map((h) => `credential ${c.env} for ${h}`),
          ...within(c.headers ?? [], locked.headers ?? []).map((h) => `credential ${c.env} in header ${h}`),
          ...(c.secret === false && locked.secret !== false ? [`credential ${c.env} as an identity (secret: false, not scrubbed)`] : []),
        ];
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
  assertLinksRunningPrRla(plugin);
  const mod = (await import(pathToFileURL(plugin.entry).href)) as Record<string, unknown>;
  const def = mod.default ?? mod[kind];
  if (kind === "provider") assertProviderDefinition(def, `provider "${spec.use}"`);
  else assertLedgerDefinition(def, `ledger "${spec.use}"`);
  if ((def as { name: string }).name !== entry.name) throw new PluginError(`plugin ${spec.use} now reports the name ${(def as { name: string }).name}; it was locked as ${entry.name}`, "LOCK_MISMATCH", `review it, then: pr-rla plugin lock ${spec.use}`);
  return def;
}

/** The locked credentials as the broker holds them: withheld (CREDENTIAL_NOT_APPROVED) without your consent. */
const brokerCredentials = (use: string, entry: LockEntry, granted: boolean) => (granted ? entry.credentials : entry.credentials.map((c) => ({ ...c, withheld: { approve: approveCommand(use) } })));

export async function openExternalProvider(ctx: AuditContext, spec: PluginSpec, cwd: string): Promise<ScmProvider> {
  refuseIfBuiltinOnly(ctx.plugins, "provider", spec.use);
  const { entry, plugin } = verifyLocked(spec.use, cwd);
  const id = `provider:${entry.name}`;
  const consent = pluginConsent(ctx, spec.use, entry);
  if (entry.trust === "full") {
    refuseFullTrustUnapproved(spec.use, entry, consent);
    ctx.log(fullTrustLine(entry));
    const def = (await importInProcess("provider", spec, entry, plugin)) as ProviderDefinition;
    ctx.grant(id, { trust: "full", hosts: def.hosts?.(spec.options) ?? [], credentials: credentialGrants(def.credentials ?? [], spec.options) });
    const p = await def.create(spec.options, { cwd, env: ctx.env, log: ctx.log, fetch: ctx.broker.bind(id), sleep: ctx.sleep });
    if (!SUPPORTED_PROVIDER_API_VERSIONS.includes(p.apiVersion)) throw new ProviderApiVersionError(def.name, p.apiVersion);
    if (typeof p.listChanges !== "function") throw new PluginError(`provider "${def.name}" returned an object without listChanges()`, "PLUGIN_INVALID");
    return p;
  }
  ctx.grant(id, { trust: "isolated", hosts: entry.hosts, credentials: brokerCredentials(spec.use, entry, consent !== null) });
  const host = await startLockedHost(ctx, "provider", spec, entry, plugin, consent !== null);
  try {
    const p = await hostedProvider(host, spec.options, { cwd, fetch: ctx.broker.bind(id), sleep: ctx.sleep, log: ctx.log });
    ctx.log(isolationLine(host, entry.name, entry.version));
    return p;
  } catch (e) {
    host.close();
    throw e;
  }
}

/**
 * LedgerContext.index for an external ledger: `<windowDir>/ledger-index.json`, read and written by
 * pr-rla (atomically) so that a ledger in the plugin host, which cannot write files, keeps its
 * state. In a read-only context the ledger's writes are refused before they reach it, and so is this.
 */
export function ledgerIndexStore(ctx: Pick<AuditContext, "mode">, windowDir: string): LedgerIndexStore {
  const path = join(windowDir, INDEX_FILE);
  return {
    read: async () => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : null),
    write: async (value) => {
      if (ctx.mode === "read-only") throw Object.assign(new Error(`${path}: this audit context is read-only`), { code: "READ_ONLY_VIOLATION" });
      if (!value || typeof value !== "object") throw new PluginError(`${path}: a ledger index must be a JSON object`, "PLUGIN_INVALID");
      writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

export async function openExternalLedger(ctx: AuditContext, spec: PluginSpec, cwd: string, windowDir: string, opts: { reviewers?: readonly string[] | null } = {}): Promise<Ledger> {
  const reviewers = opts.reviewers !== undefined ? { reviewers: opts.reviewers } : {};
  const index = ledgerIndexStore(ctx, windowDir);
  refuseIfBuiltinOnly(ctx.plugins, "ledger", spec.use);
  const { entry, plugin } = verifyLocked(spec.use, cwd);
  const id = `ledger:${entry.name}`;
  const consent = pluginConsent(ctx, spec.use, entry);
  if (entry.trust === "full") {
    refuseFullTrustUnapproved(spec.use, entry, consent);
    ctx.log(fullTrustLine(entry));
    const def = (await importInProcess("ledger", spec, entry, plugin)) as LedgerDefinition;
    ctx.grant(id, { trust: "full", hosts: def.hosts?.(spec.options) ?? [], writePaths: def.writePaths?.(spec.options) ?? [], credentials: credentialGrants(def.credentials ?? [], spec.options) });
    const l = await def.create(spec.options, { cwd, windowDir, env: ctx.env, log: ctx.log, fetch: ctx.broker.bind(id), sleep: ctx.sleep, index, ...reviewers });
    if (!SUPPORTED_LEDGER_API_VERSIONS.includes(l.apiVersion)) throw new LedgerApiVersionError(def.name, l.apiVersion);
    for (const m of ["readVerdicts", "appendVerdict"] as const) if (typeof l[m] !== "function") throw new PluginError(`ledger "${def.name}" has no ${m}()`, "PLUGIN_INVALID");
    return l;
  }
  ctx.grant(id, { trust: "isolated", hosts: entry.hosts, writePaths: entry.writePaths, credentials: brokerCredentials(spec.use, entry, consent !== null) });
  const host = await startLockedHost(ctx, "ledger", spec, entry, plugin, consent !== null);
  try {
    const l = await hostedLedger(host, spec.options, { cwd, windowDir, fetch: ctx.broker.bind(id), sleep: ctx.sleep, log: ctx.log, index, ...reviewers });
    ctx.log(isolationLine(host, entry.name, entry.version));
    return l;
  } catch (e) {
    host.close();
    throw e;
  }
}

/**
 * register's preflight for an external ledger (U4): the lock entry and files check out, its options
 * are accepted (`hosts`, `writePaths` and `create()` all see them), and nothing is contacted:
 * `create()` gets `refuse` as its fetch. An isolated ledger does all of this in its host, which is
 * stopped straight away; its provenance comes from `describe`. A plugin refusal (not locked,
 * changed, builtin-only) is thrown as it is; anything the ledger throws is returned as `problem`.
 */
export async function preflightExternalLedger(ctx: AuditContext, spec: PluginSpec, cwd: string, windowDir: string, refuse: typeof fetch): Promise<{ name: string; provenance: ProvenanceLevel; problem: string | null }> {
  refuseIfBuiltinOnly(ctx.plugins, "ledger", spec.use);
  const { entry, plugin } = verifyLocked(spec.use, cwd);
  const base = { cwd, windowDir, log: () => {}, fetch: refuse, index: ledgerIndexStore({ mode: "read-only" }, windowDir) };
  const consent = ctx.consent.plugin(spec.use, entry);
  if (entry.trust === "full") {
    refuseFullTrustUnapproved(spec.use, entry, consent);
    const def = (await importInProcess("ledger", spec, entry, plugin)) as LedgerDefinition;
    const provenance = def.provenance ?? "self-asserted";
    try {
      def.hosts?.(spec.options);
      def.writePaths?.(spec.options);
      await def.create(spec.options, { ...base, env: ctx.env });
      return { name: def.name, provenance, problem: null };
    } catch (e) {
      return { name: def.name, provenance, problem: (e as Error).message };
    }
  }
  let host: PluginHost;
  try {
    // The preflight's fetch refuses everything, so placeholders are safe here; withheld ones still never reach it.
    host = await startLockedHost(ctx, "ledger", spec, entry, plugin, consent !== null);
  } catch (e) {
    // pr-rla's refusals (the lock, the definition) stay what they are; what hosts() or writePaths() threw is the ledger's.
    if (e instanceof PluginError) throw e;
    return { name: entry.name, provenance: "self-asserted", problem: (e as Error).message };
  }
  try {
    const { provenance } = await describePlugin(host, spec.options);
    try {
      await hostedLedger(host, spec.options, base);
      return { name: entry.name, provenance: provenance ?? "self-asserted", problem: null };
    } catch (e) {
      return { name: entry.name, provenance: provenance ?? "self-asserted", problem: (e as Error).message };
    }
  } finally {
    host.close();
  }
}
