import { delimiter } from "node:path";
import { gitCeilingDirectories } from "./confine.js";

/**
 * How pr-rla runs git when it only reads (U5 fix round): the one place the read-path guard lives,
 * so every read-only git call (the git-file ledger's integrity walk; U9's hardening merges here)
 * gets the same environment.
 *
 * - The caller's GIT_* variables are dropped (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_* and the rest
 *   would point git elsewhere).
 * - GIT_NO_LAZY_FETCH=1: on a partial clone (`--filter=blob:none`), a missing object is an error,
 *   not a fetch through the user's credentials and outside pr-rla's broker, writing a pack under .git.
 * - GIT_OPTIONAL_LOCKS=0: no index refresh or other optional write.
 * - `-c gc.auto=0 -c maintenance.auto=false`: no automatic housekeeping that writes under .git.
 * - GIT_CEILING_DIRECTORIES: in a confined call (the MCP server), git never looks for a repository
 *   above the roots.
 * - GIT_TERMINAL_PROMPT=0: never ask for a password.
 */
export const GIT_READ_CONFIG: readonly string[] = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];

export function gitReadEnv(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  const ceilings = gitCeilingDirectories();
  if (ceilings.length) env.GIT_CEILING_DIRECTORIES = ceilings.join(delimiter);
  return env;
}
