import { checkpoint, CHECKPOINT_COMMAND, type CheckpointAppended, type CheckpointOptions as ApiCheckpointOptions } from "../api/write/checkpoint.js";
import { EXIT } from "../cli/exit-codes.js";
import type { CommandContext } from "./context.js";
import { reportTimestamps } from "./timestamps.js";

// The checkpoint logic moved to the audit API in U5 (src/api/write/checkpoint.ts).
export { CHECKPOINT_COMMAND } from "../api/write/checkpoint.js";

export type CheckpointOptions = ApiCheckpointOptions;

/**
 * `pr-rla checkpoint [--push]` (FR4.4). Exit codes follow contracts.md §7:
 * 1 preconditions, 4 push stopped, 5 too few timestamps.
 */
export async function checkpointCommand(ctx: CommandContext, opts: CheckpointOptions = {}): Promise<number> {
  let tsCode: number = EXIT.OK;
  const print = (c: CheckpointAppended) => {
    ctx.out(`checkpoint ${c.takenAt} · ledger ${c.ledger} · ${c.count} event(s) · ${c.firstVerdicts} first verdict(s) · eventsSha256 ${c.eventsSha256.slice(0, 12)}…`);
    ctx.out(`  appended to ${c.linesFile} · event list ${c.historyFile}`);
    tsCode = reportTimestamps(ctx, c.evidence, c.outcomes, opts.push ? `${CHECKPOINT_COMMAND} --push` : CHECKPOINT_COMMAND);
  };
  const r = await checkpoint(ctx, opts, { onAppended: print });
  if (!r.push) {
    ctx.out(`  commit it: git add ${r.linesFile} ${r.historyFile} && git commit -m "${r.commitMessage}"   (or run "${CHECKPOINT_COMMAND} --push")`);
    return tsCode;
  }
  if (!r.push.ok) {
    ctx.out(`  not pushed: ${r.push.reason}`);
    ctx.out(`  run again: ${r.push.rerun}`);
    return EXIT.STOPPED;
  }
  ctx.out(`  pushed to ${r.push.remote}/${r.push.branch} (${r.push.head.slice(0, 10)}, attempt ${r.push.attempts} of 3, no force)`);
  return tsCode;
}
