import { pathToFileURL } from "node:url";
import { PluginError } from "./errors.js";
import { startPluginHost } from "./host.js";
import { readGrants, refuseIfBuiltinOnly, verifyLocked, type LockEntry, type PluginPolicy, type ResolvedPlugin } from "./lock.js";

/**
 * What a registration or manifest records about an external plugin (FR2.1), from its lock
 * entry after the installed files are re-hashed. An isolated plugin is never imported in
 * this process: the option keys its definition lists in `populationOptions` are read in a
 * host child, which is stopped straight away.
 */
export interface ExternalPluginInfo {
  entry: LockEntry;
  plugin: ResolvedPlugin;
  populationOptions: string[];
}

const memo = new Map<string, string[]>();

const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);

export async function externalPluginInfo(use: string, kind: "provider" | "ledger", auditDir: string, policy: PluginPolicy): Promise<ExternalPluginInfo> {
  refuseIfBuiltinOnly(policy, kind, use);
  const { entry, plugin } = verifyLocked(use, auditDir);
  const key = `${kind}\u0000${plugin.entry}\u0000${entry.treeSha256}\u0000${entry.trust}`;
  let populationOptions = memo.get(key);
  if (!populationOptions) {
    if (entry.trust === "full") {
      const mod = (await import(pathToFileURL(plugin.entry).href)) as Record<string, unknown>;
      populationOptions = keysOf(((mod.default ?? mod[kind]) as { populationOptions?: unknown } | undefined)?.populationOptions);
    } else {
      const host = await startPluginHost({ kind, entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: use });
      try {
        if (host.ready.name !== entry.name) throw new PluginError(`plugin ${use} now reports the name ${JSON.stringify(host.ready.name)}; it was locked as ${entry.name}`, "LOCK_MISMATCH", `review it, then: pr-rla plugin lock ${use}`);
        populationOptions = keysOf(host.ready.populationOptions);
      } finally {
        host.close();
      }
    }
    memo.set(key, populationOptions);
  }
  return { entry, plugin, populationOptions };
}
