import { record } from "../api/write/record.js";
import type { CommandContext } from "./context.js";

export async function recordCommand(ctx: CommandContext, drawArg: string, verdictArg: string, opts: { reviewer?: string; note?: string; force?: boolean; sign?: string }): Promise<number> {
  const r = await record(ctx, { draw: drawArg, verdict: verdictArg, ...opts });
  ctx.out(`recorded draw #${r.draw} ${r.changeId}: ${r.verdict} (per protocol ${r.protocolSha256.slice(0, 8)}…) in ledger ${r.ledger}`);
  if (r.signedLine) ctx.out(r.signedLine);
  if (r.ledger === "git-file") ctx.out("commit the ledger file now: git history is the tamper trail");
  if (r.signHint) ctx.out(r.signHint);
  else if (r.recordsActor) ctx.out(`the tracker records the account that applied the label, and when; that, not --reviewer, is the verdict's reviewer`);
  return 0;
}
