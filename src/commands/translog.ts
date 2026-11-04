import { REKOR_V2_WARNING } from "../translog/rekor-v2.js";
import { CommandError, type CommandContext } from "./context.js";

// Moved to the audit API in U5 (read side: logPublicKey; write side: the submissions); re-exported here.
export { logPublicKey } from "../api/translog.js";
export { rekorApi, submitSigned, submitSignedV2, submitUrl, type RekorApi } from "../api/write/translog.js";

/**
 * Before any network call of a `--submit --rekor-api v2` run: prints the v2 warning and
 * requires --yes or an interactive yes. Entries are public and permanent. With `--json` the
 * warning goes to stderr: stdout carries the one JSON document (contracts.md §7).
 */
export async function confirmRekorV2(ctx: CommandContext, yes: boolean | undefined, json = false): Promise<void> {
  (json ? ctx.err : ctx.out)(REKOR_V2_WARNING);
  if (yes) return;
  if (ctx.confirm && (await ctx.confirm("Submit to this Rekor v2 log?"))) return;
  throw new CommandError("not submitted: pass --yes to confirm a public, permanent Rekor v2 entry (nothing was written)");
}
