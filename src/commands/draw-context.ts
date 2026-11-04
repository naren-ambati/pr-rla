import { drawContext } from "../api/read/draw-context.js";
import { CommandError, type CommandContext } from "./context.js";

export interface DrawContextCommandOptions {
  json?: boolean;
  /** Bytes of patches to show in all (default 200 KiB, at most 1 MiB). */
  maxPatchBytes?: string;
}

/**
 * `pr-rla draw-context <n>` (FR3.4): what a reviewer reads for issued draw n, with the change's own
 * text inside the untrusted-content fence (FR3.9). Reads only; the verdict is recorded by a person.
 */
export async function drawContextCommand(ctx: CommandContext, drawArg: string, opts: DrawContextCommandOptions): Promise<number> {
  const draw = Number(drawArg);
  if (!Number.isInteger(draw) || draw < 1) throw new CommandError(`draw must be a positive integer (got ${drawArg})`);
  const maxPatchBytes = opts.maxPatchBytes === undefined ? undefined : Number(opts.maxPatchBytes);
  const c = await drawContext(ctx, { draw, ...(maxPatchBytes !== undefined ? { maxPatchBytes } : {}) });
  ctx.out(opts.json ? JSON.stringify(c, null, 2) : c.text);
  return 0;
}
