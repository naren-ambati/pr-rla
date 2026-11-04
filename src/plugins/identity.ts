import { pathToFileURL } from "node:url";
import { PluginError } from "./errors.js";
import { definitionTraits, describePlugin, startPluginHost, type DefinitionTraits } from "./host.js";
import { readGrants, refuseIfBuiltinOnly, verifyLocked, type LockEntry, type PluginPolicy, type PluginRules, type ResolvedPlugin } from "./lock.js";
import { consentOf, refuseFullTrustUnapproved } from "./approvals.js";
import { PROVENANCE_LEVELS, type ProvenanceLevel } from "../sdk/ledger.js";

/**
 * What a registration or manifest records about an external plugin (FR2.1), from its lock
 * entry after the installed files are re-hashed. An isolated plugin is never imported in
 * this process: its definition's traits (`populationOptions`, `reviewGranularity`,
 * `reportsLandedVia`, and a ledger's `provenance`) are read through `describe` in a host child,
 * which is stopped straight away. A `trust: full` plugin is imported only with your local
 * approval (./approvals.ts); `rules` without consent (a bare policy) refuse it.
 */
export interface ExternalPluginInfo {
  entry: LockEntry;
  plugin: ResolvedPlugin;
  traits: DefinitionTraits;
  /** A ledger definition's provenance; null when it declares none. */
  provenance: ProvenanceLevel | null;
}

const memo = new Map<string, { traits: DefinitionTraits; provenance: ProvenanceLevel | null }>();

export async function externalPluginInfo(use: string, kind: "provider" | "ledger", auditDir: string, rules: PluginPolicy | PluginRules, options: Record<string, unknown> = {}): Promise<ExternalPluginInfo> {
  refuseIfBuiltinOnly(rules, kind, use);
  const { entry, plugin } = verifyLocked(use, auditDir);
  if (entry.trust === "full") refuseFullTrustUnapproved(use, entry, consentOf(rules, use, entry));
  const key = `${kind}\u0000${plugin.entry}\u0000${entry.treeSha256}\u0000${entry.trust}`;
  let known = memo.get(key);
  if (!known) {
    if (entry.trust === "full") {
      const mod = (await import(pathToFileURL(plugin.entry).href)) as Record<string, unknown>;
      const def = ((mod.default ?? mod[kind]) as Record<string, unknown> | undefined) ?? {};
      const p = def.provenance;
      if (p !== undefined && !PROVENANCE_LEVELS.includes(p as ProvenanceLevel)) throw new PluginError(`plugin ${use}: provenance must be one of ${PROVENANCE_LEVELS.join(", ")}`, "PLUGIN_INVALID");
      known = { traits: definitionTraits(def, use), provenance: (p as ProvenanceLevel | undefined) ?? null };
    } else {
      const host = await startPluginHost({ kind, entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: use });
      try {
        if (host.ready.name !== entry.name) throw new PluginError(`plugin ${use} now reports the name ${JSON.stringify(host.ready.name)}; it was locked as ${entry.name}`, "LOCK_MISMATCH", `review it, then: pr-rla plugin lock ${use}`);
        const d = await describePlugin(host, options);
        known = { traits: d.traits, provenance: d.provenance };
      } finally {
        host.close();
      }
    }
    memo.set(key, known);
  }
  return { entry, plugin, ...known };
}
