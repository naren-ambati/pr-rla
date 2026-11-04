import { pathToFileURL } from "node:url";
import { PluginError } from "./errors.js";
import { definitionTraits, describePlugin, startPluginHost, type DefinitionTraits } from "./host.js";
import { readGrants, refuseIfBuiltinOnly, verifyLocked, type LockEntry, type PluginPolicy, type ResolvedPlugin } from "./lock.js";

/**
 * What a registration or manifest records about an external plugin (FR2.1), from its lock
 * entry after the installed files are re-hashed. An isolated plugin is never imported in
 * this process: its definition's traits (`populationOptions`, `reviewGranularity`,
 * `reportsLandedVia`) are read through `describe` in a host child, which is stopped straight away.
 */
export interface ExternalPluginInfo {
  entry: LockEntry;
  plugin: ResolvedPlugin;
  traits: DefinitionTraits;
}

const memo = new Map<string, DefinitionTraits>();

export async function externalPluginInfo(use: string, kind: "provider" | "ledger", auditDir: string, policy: PluginPolicy, options: Record<string, unknown> = {}): Promise<ExternalPluginInfo> {
  refuseIfBuiltinOnly(policy, kind, use);
  const { entry, plugin } = verifyLocked(use, auditDir);
  const key = `${kind}\u0000${plugin.entry}\u0000${entry.treeSha256}\u0000${entry.trust}`;
  let traits = memo.get(key);
  if (!traits) {
    if (entry.trust === "full") {
      const mod = (await import(pathToFileURL(plugin.entry).href)) as Record<string, unknown>;
      traits = definitionTraits(((mod.default ?? mod[kind]) as Record<string, unknown> | undefined) ?? {}, use);
    } else {
      const host = await startPluginHost({ kind, entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: use });
      try {
        if (host.ready.name !== entry.name) throw new PluginError(`plugin ${use} now reports the name ${JSON.stringify(host.ready.name)}; it was locked as ${entry.name}`, "LOCK_MISMATCH", `review it, then: pr-rla plugin lock ${use}`);
        traits = (await describePlugin(host, options)).traits;
      } finally {
        host.close();
      }
    }
    memo.set(key, traits);
  }
  return { entry, plugin, traits };
}
