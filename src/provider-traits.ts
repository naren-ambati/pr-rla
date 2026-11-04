import { loadProviderDefinition, type PluginSpec } from "./registry.js";
import { DEFAULT_REVIEW_GRANULARITY, type ReviewGranularity } from "./sdk/provider.js";

/** What a provider definition declares about the population it builds (the U3 definition fields). */
export interface ProviderTraits {
  name: string;
  /** Recorded in the manifest; absent in the definition means "submission". */
  reviewGranularity: ReviewGranularity;
  /** Whether the provider sets ChangeRecord.landedVia (else `direct_push_via_merge: exclude` has no effect). */
  reportsLandedVia: boolean;
  /** Option keys whose values `populationOptionsSha256` hashes. */
  populationOptions: string[];
}

/** Reads the U3 traits from the configured provider's definition (in-process). */
export async function providerTraits(spec: PluginSpec, baseDir: string): Promise<ProviderTraits> {
  const def = await loadProviderDefinition(spec.use, baseDir);
  return {
    name: def.name,
    reviewGranularity: def.reviewGranularity ?? DEFAULT_REVIEW_GRANULARITY,
    reportsLandedVia: def.reportsLandedVia === true,
    populationOptions: [...(def.populationOptions ?? [])],
  };
}
