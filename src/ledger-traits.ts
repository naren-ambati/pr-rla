import { externalPluginInfo } from "./plugins/identity.js";
import type { PluginPolicy, PluginRules } from "./plugins/lock.js";
import { builtinLedgerName, loadLedgerDefinition, type PluginSpec } from "./registry.js";
import type { ProvenanceLevel } from "./sdk/ledger.js";

/** What a ledger definition declares, as the commands need it before opening the ledger (U4). */
export interface LedgerTraits {
  name: string;
  /** The provenance its verdicts carry; absent in the definition means "self-asserted". */
  provenance: ProvenanceLevel;
  /** The hosts it contacts with these options (none: a local ledger such as git-file). */
  hosts: string[];
}

/**
 * Reads a ledger's traits. A built-in is read in process; an external ledger only after its lock
 * entry and files check out: its hosts are the locked ones, and an isolated ledger's provenance
 * comes through its host's `describe` (pr-rla/ipc), never by importing it here. `builtin-only`
 * refuses an external ledger before anything is resolved.
 */
export async function ledgerTraits(spec: PluginSpec, baseDir: string, policy: PluginPolicy | PluginRules = "locked"): Promise<LedgerTraits> {
  if (!builtinLedgerName(spec.use)) {
    const { entry, provenance } = await externalPluginInfo(spec.use, "ledger", baseDir, policy, spec.options);
    return { name: entry.name, provenance: provenance ?? "self-asserted", hosts: [...entry.hosts] };
  }
  const def = await loadLedgerDefinition(spec.use, baseDir);
  return { name: def.name, provenance: def.provenance ?? "self-asserted", hosts: def.hosts?.(spec.options as never) ?? [] };
}
