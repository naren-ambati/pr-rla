import { definitionTraits, type DefinitionTraits } from "./plugins/host.js";
import { externalPluginInfo } from "./plugins/identity.js";
import type { PluginPolicy, PluginRules } from "./plugins/lock.js";
import { builtinProviderName, loadProviderDefinition, type PluginSpec } from "./registry.js";

/** What a provider definition declares about the population it builds (the U3 definition fields). */
export interface ProviderTraits extends DefinitionTraits {
  name: string;
}

/**
 * Reads the U3 traits from the configured provider's definition. A built-in is read in process;
 * an external plugin only after its lock entry and files check out, and an isolated one through
 * its host's `describe` (pr-rla/ipc), never by importing it here. `builtin-only` refuses an
 * external plugin before anything is resolved.
 */
export async function providerTraits(spec: PluginSpec, baseDir: string, policy: PluginPolicy | PluginRules = "locked"): Promise<ProviderTraits> {
  if (!builtinProviderName(spec.use)) {
    const { entry, traits } = await externalPluginInfo(spec.use, "provider", baseDir, policy, spec.options);
    return { name: entry.name, ...traits };
  }
  const def = await loadProviderDefinition(spec.use, baseDir);
  return { name: def.name, ...definitionTraits(def, spec.use) };
}
