import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fixtureName, hostedProviderConformance, readRecordedFixture } from "../plugins/check.js";
import { inspectPlugin as inspect } from "../plugins/entry.js";
import { refuseIfBuiltinOnly, resolvePlugin, verifyLocked, type LockedCredential, type PluginTrust, type ResolvedPlugin } from "../plugins/lock.js";
import { builtinLedgerName, builtinProviderName } from "../registry.js";
import type { ConformanceReport } from "../testing/conformance.js";
import { AuditError } from "./errors.js";
import { auditContextFor, type ApiContext } from "./session.js";
import { configIn, configuredPlugin, installScriptWarnings, type PluginKind } from "./write/plugin.js";

export interface PluginCheckOptions {
  /** Recorded fixtures to run the kit on, besides those the plugin's package.json lists. */
  fixture?: string[];
  /** Skip `npm audit signatures` (it asks the npm registry). */
  offline?: boolean;
  /** For a plugin not named in .pr-rla.yml. */
  kind?: string;
}

/** What `plugin check` found (FR2.7): correctness, not safety. It writes nothing. */
export interface PluginCheckResult {
  use: string;
  kind: PluginKind;
  name: string;
  version: string | null;
  source: ResolvedPlugin["source"];
  /** The lock's verdict, as one line. */
  lock: string;
  lockTrust: PluginTrust | null;
  npmSignatures: string;
  hosts: string[];
  /** The plugin is not named in .pr-rla.yml, so its hosts were computed with no options. */
  withoutOptions: boolean;
  credentials: LockedCredential[];
  installScriptWarnings: string[];
  conformance: { run: false; reason: string } | { run: true; fixtures: number; report: ConformanceReport };
  ok: boolean;
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

/**
 * Where `plugin check` has got to, for a caller that prints as it goes (the CLI): what the plugin
 * is and its lock (before `npm audit signatures`, which can take two minutes), the signatures, and
 * the start of the conformance kit (before it runs, so a kit that fails still leaves the report so far).
 */
export interface PluginCheckHooks {
  onInspected?: (r: Omit<PluginCheckResult, "npmSignatures" | "conformance" | "ok">) => void;
  onSignatures?: (line: string) => void;
  onConformanceStart?: (fixtures: number) => void;
}

/** `plugin check`: lock status, npm signatures, hosts and credentials, and the conformance kit through the plugin host. */
export async function checkPlugin(ctx: ApiContext, use: string, opts: PluginCheckOptions = {}, hooks: PluginCheckHooks = {}): Promise<PluginCheckResult> {
  const config = configIn(ctx);
  const c = configuredPlugin(config, use);
  const kind: PluginKind = c?.kind ?? (opts.kind === "ledger" ? "ledger" : "provider");
  if (opts.kind !== undefined && opts.kind !== "provider" && opts.kind !== "ledger") throw new AuditError(`--kind ${opts.kind}: use provider or ledger`);
  if ((kind === "provider" ? builtinProviderName(use) : builtinLedgerName(use)) !== null) throw new AuditError(`${use} is built in; "plugin check" is for external plugins`);
  refuseIfBuiltinOnly(auditContextFor(ctx).plugins, kind, use);
  const dir = config?.dir ?? ctx.cwd;
  const plugin = resolvePlugin(use, dir);
  let lock: string;
  let lockTrust: PluginTrust | null = null;
  try {
    const { entry } = verifyLocked(use, dir);
    lock = `locked, files match (treeSha256 ${entry.treeSha256.slice(0, 12)}…, trust ${entry.trust})`;
    lockTrust = entry.trust;
  } catch (e) {
    const code = (e as { code?: string }).code;
    lock = code === "NOT_LOCKED" ? `not locked: run "pr-rla plugin add ${use}" to trust it` : code === "LOCK_MISMATCH" ? `CHANGED since it was locked: ${(e as Error).message}` : `cannot check: ${(e as Error).message}`;
  }
  const x = await inspect(kind, use, plugin, c?.options ?? {});
  const inspected = {
    use,
    kind,
    name: x.name,
    version: plugin.version ?? null,
    source: plugin.source,
    lock,
    lockTrust,
    hosts: x.hosts,
    withoutOptions: !c,
    credentials: x.credentials,
    installScriptWarnings: installScriptWarnings(plugin),
  };
  hooks.onInspected?.(inspected);
  const signatures = npmSignatures(plugin, opts.offline);
  hooks.onSignatures?.(signatures);
  const base = { ...inspected, npmSignatures: signatures };
  // The ledger kit's fixtures are built by code (fake trackers, published issues), not recorded data a check can replay.
  if (kind === "ledger") return { ...base, conformance: { run: false, reason: "plugin check replays recorded provider fixtures only; run your ledger's own runLedgerConformance test" }, ok: false };
  const declared = plugin.pkg?.["pr-rla"] && typeof plugin.pkg["pr-rla"] === "object" ? (plugin.pkg["pr-rla"] as { conformance?: unknown }).conformance : undefined;
  const files = [...(Array.isArray(declared) ? declared.filter((f): f is string => typeof f === "string").map((f) => resolve(plugin.rootIsFile ? dirname(plugin.root) : plugin.root, f)) : []), ...(opts.fixture ?? []).map((f) => resolve(ctx.cwd, f))];
  if (!files.length) return { ...base, conformance: { run: false, reason: 'no fixtures (list recorded fixtures in the plugin\'s package.json as "pr-rla": { "conformance": [...] }, or pass --fixture <file>)' }, ok: false };
  hooks.onConformanceStart?.(files.length);
  const report = await hostedProviderConformance(plugin, use, files.map((f) => ({ name: fixtureName(f), rec: readRecordedFixture(f) })));
  return { ...base, conformance: { run: true, fixtures: files.length, report }, ok: report.ok };
}
