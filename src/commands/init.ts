import { initAudit } from "../api/write/init.js";
import { CONFIG_FILE } from "../config.js";
import type { CommandContext } from "./context.js";

export async function initCommand(ctx: CommandContext, opts: { repo?: string; provider?: string; force?: boolean }): Promise<number> {
  await initAudit(ctx, opts);
  ctx.out(`wrote ${CONFIG_FILE}, review-protocol.md, audit/`);
  ctx.out("next: edit the selector and window, finalize review-protocol.md, then `pr-rla register --dry-run`");
  return 0;
}
