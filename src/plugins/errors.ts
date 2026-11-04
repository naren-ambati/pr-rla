/**
 * A refused or failed external plugin: not locked, changed since it was locked, refused by
 * `--plugins builtin-only`, or its host process failed. Exit code 1 (contracts.md §7), and the
 * CLI prints `next` as the step to take (NFR17).
 */
export class PluginError extends Error {
  readonly exitCode = 1;
  constructor(
    message: string,
    readonly code: "NOT_LOCKED" | "LOCK_MISMATCH" | "BUILTIN_ONLY" | "TREE_ESCAPE" | "PLUGIN_UNRESOLVED" | "PLUGIN_INVALID" | "PLUGIN_HOST_FAILED" | "PLUGIN_HOST_TIMEOUT" | "MESSAGE_TOO_LARGE",
    readonly next?: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}
