import type { PluginIdentity } from "./records.js";

/**
 * The registered plugins are the only ones an audit's commands may run (P1, "identity everywhere"):
 * the provider and the ledger loaded at freeze, verify, status, record, sample and checkpoint must
 * be the registration's `plugins.provider` and `plugins.ledger`. Pure: the API layer loads the
 * identities (src/registry.ts `pluginIdentity`) and refuses, verify's checks 5 and 7 FAIL.
 *
 * Compared: `name`, `source`, `integrity` (the lock's tree hash), `trust`, `optionsSha256` (every
 * option, not only the population ones: there is no escape through `populationOptionsSha256`), and an
 * external plugin's `version`. A built-in's `version` is the pr-rla release that ran it: an audit
 * registered with one release is frozen, sampled and verified with later ones (verify prints the
 * versions), so it is shown, never compared. `populationOptionsSha256` follows from the options and
 * the definition, so it is not compared on its own either.
 */
export const IDENTITY_FIELDS = ["name", "source", "integrity", "trust", "optionsSha256", "version"] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];
/** What P1 compares of a plugin: its identity without `populationOptionsSha256`, readable without running an external plugin (src/registry.ts `bindingIdentity`). */
export type BindingIdentity = Pick<PluginIdentity, IdentityField>;

/** A hash or an absent value, short, as the identity lines print them. */
export const showIdentityValue = (v: string | null | undefined): string => (v === null || v === undefined ? "none" : /^[0-9a-f]{64}$/.test(v) ? `${v.slice(0, 12)}…` : v);

/** The fields that differ, each as `field registered → loaded`. Empty when `loaded` is the registered plugin. */
export function identityDiffs(registered: BindingIdentity, loaded: BindingIdentity): string[] {
  const builtin = registered.source === "builtin" && loaded.source === "builtin";
  return IDENTITY_FIELDS.filter((k) => !(k === "version" && builtin) && (registered[k] ?? null) !== (loaded[k] ?? null)).map((k) => `${k} ${showIdentityValue(registered[k])} → ${showIdentityValue(loaded[k])}`);
}

/** `<name> (<source>…)`: how a refusal names a plugin. */
export const identityLabel = (id: BindingIdentity): string => `${id.name} (${id.source}${id.source !== "builtin" && id.version ? ` ${id.version}` : ""}, trust ${id.trust}, options ${showIdentityValue(id.optionsSha256)})`;

/**
 * The refusal of a command that would run another plugin than the registered one, or null when it is
 * the registered one. `command` names what refuses (e.g. `status`).
 */
export function identityRefusal(kind: "provider" | "ledger", registered: BindingIdentity, loaded: BindingIdentity, command: string): string | null {
  const diffs = identityDiffs(registered, loaded);
  if (!diffs.length) return null;
  return `${command} refused: the ${kind} in .pr-rla.yml is not the registered one (${diffs.join("; ")}). The registration names ${kind} ${identityLabel(registered)}; an audit runs only its registered ${kind}, with the registered options and files`;
}

/** What to do about a refusal: put the registered plugin back, or register a new audit. */
export const identityNext = (kind: "provider" | "ledger"): string => `restore the registered ${kind} and its options in .pr-rla.yml (and, for an external plugin, its locked files: "pr-rla plugin check"), or register a new audit`;
