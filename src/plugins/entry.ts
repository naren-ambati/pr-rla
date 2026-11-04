import { declaredCredentials, describePlugin, startPluginHost } from "./host.js";
import { readGrants, resolvePlugin, treeSha256, type LockedCredential, type LockEntry, type PluginTrust, type ResolvedPlugin } from "./lock.js";

/**
 * What `plugin add` and `plugin lock` record for a plugin: resolved and hashed here, its
 * definition read in a host child (never imported in this process), with the options the
 * audit configures, since `hosts(options)` and `writePaths(options)` depend on them.
 */
export interface InspectedPlugin {
  name: string;
  hosts: string[];
  writePaths: string[];
  credentials: LockedCredential[];
  /** The Node major version the host ran on. */
  nodeMajor: number;
}

export async function inspectPlugin(kind: "provider" | "ledger", use: string, plugin: ResolvedPlugin, options: Record<string, unknown>): Promise<InspectedPlugin> {
  const host = await startPluginHost({ kind, entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: use });
  try {
    const asked = await describePlugin(host, options);
    return { name: String(host.ready.name), ...asked, credentials: declaredCredentials(host, options), nodeMajor: host.nodeMajor };
  } finally {
    host.close();
  }
}

export function lockEntryFor(plugin: ResolvedPlugin, x: InspectedPlugin, trust: PluginTrust): LockEntry {
  return {
    source: plugin.source,
    name: x.name,
    version: plugin.version,
    resolved: plugin.resolved,
    npmIntegrity: plugin.source === "package" ? (plugin.npm?.integrity ?? null) : null,
    treeSha256: treeSha256(plugin),
    trust,
    hosts: x.hosts,
    writePaths: x.writePaths,
    credentials: x.credentials,
  };
}

/** Resolve, hash and inspect in one step (tests and scripts; the CLI prints between the steps). */
export async function buildLockEntry(kind: "provider" | "ledger", use: string, auditDir: string, options: Record<string, unknown>, trust: PluginTrust = "isolated"): Promise<LockEntry> {
  const plugin = resolvePlugin(use, auditDir);
  return lockEntryFor(plugin, await inspectPlugin(kind, use, plugin, options), trust);
}
