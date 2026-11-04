import { PLUGIN_REFUSALS, PrRlaError } from "../core/said.js";

/**
 * A refused or failed external plugin: not locked, changed since it was locked, refused by
 * `--plugins builtin-only`, `trust: full` without your local approval, or its host process failed. Exit code 1 (contracts.md §7), and the
 * CLI prints `next` as the step to take (NFR17).
 */
export class PluginError extends PrRlaError {
  readonly exitCode = 1;
  constructor(
    message: string,
    readonly code: "NOT_LOCKED" | "NOT_APPROVED" | "LOCK_MISMATCH" | "BUILTIN_ONLY" | "TREE_ESCAPE" | "PLUGIN_UNRESOLVED" | "PLUGIN_INVALID" | "PLUGIN_HOST_FAILED" | "PLUGIN_HOST_TIMEOUT" | "MESSAGE_TOO_LARGE" | "FULL_TRUST_REFUSED",
    readonly next?: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
  /** pr-rla's refusals are its words; a host's failure quotes the plugin's output (S1, src/core/said.ts). */
  override said(): { own: string } | { words: string; foreign: string } {
    if (PLUGIN_REFUSALS.has(this.code)) return { own: this.message };
    if (this.code === "PLUGIN_HOST_TIMEOUT") return { own: "a plugin stopped answering (PLUGIN_HOST_TIMEOUT)" };
    return { words: `a plugin failed (${this.code})`, foreign: this.message };
  }
}
