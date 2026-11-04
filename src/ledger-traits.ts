import { externalPluginInfo } from "./plugins/identity.js";
import type { PluginPolicy } from "./plugins/lock.js";
import { builtinLedgerName, loadLedgerDefinition, type PluginSpec } from "./registry.js";
import { provenanceRank, type ProvenanceLevel } from "./sdk/ledger.js";

/** What a ledger definition declares, as the commands need it before opening the ledger (U4). */
export interface LedgerTraits {
  name: string;
  /** The provenance its verdicts carry; absent in the definition means "self-asserted". */
  provenance: ProvenanceLevel;
  /** The hosts it contacts with these options (none: a local ledger such as git-file). */
  hosts: string[];
  /**
   * The most its verdicts can be counted as (U9). `presence` only for a ledger whose verdict
   * signatures pr-rla verifies itself (git-file); the issue ledgers top out at `account`; an
   * external ledger at its declared level, and never above `account`, because pr-rla checks no
   * presence evidence it reports.
   */
  maxProvenance: ProvenanceLevel;
}

/** Built-in ledgers whose verdict signatures the core's PresenceVerifier checks (src/core/presence). */
export const SIGNATURE_LEDGERS: ReadonlySet<string> = new Set(["git-file"]);

/** A ledger's `maxProvenance` from what it is (built in or not), its name and its declared level. */
export function maxProvenanceOf(builtin: boolean, name: string, level: ProvenanceLevel): ProvenanceLevel {
  if (builtin) return SIGNATURE_LEDGERS.has(name) ? "presence" : level;
  return provenanceRank(level) > provenanceRank("account") ? "account" : level;
}

/**
 * Reads a ledger's traits. A built-in is read in process; an external ledger only after its lock
 * entry and files check out: its hosts are the locked ones, and an isolated ledger's provenance
 * comes through its host's `describe` (pr-rla/ipc/v1), never by importing it here. `builtin-only`
 * refuses an external ledger before anything is resolved.
 */
export async function ledgerTraits(spec: PluginSpec, baseDir: string, policy: PluginPolicy = "locked"): Promise<LedgerTraits> {
  if (!builtinLedgerName(spec.use)) {
    const { entry, provenance } = await externalPluginInfo(spec.use, "ledger", baseDir, policy, spec.options);
    return { name: entry.name, provenance: provenance ?? "self-asserted", hosts: [...entry.hosts], maxProvenance: maxProvenanceOf(false, entry.name, provenance ?? "self-asserted") };
  }
  const def = await loadLedgerDefinition(spec.use, baseDir);
  const level = def.provenance ?? "self-asserted";
  return { name: def.name, provenance: level, hosts: def.hosts?.(spec.options as never) ?? [], maxProvenance: maxProvenanceOf(true, def.name, level) };
}
