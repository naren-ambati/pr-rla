import { EXIT } from "../cli/exit-codes.js";
import type { AuthorityOutcome } from "../timestamp/client.js";
import { notTamperProof, timestampsLine, type TimeEvidenceSummary } from "../timestamp/verify.js";
import type { CommandContext } from "./context.js";

// Moved to the audit API in U5; re-exported for the commands.
export { MAX_CLOCK_SKEW_SECONDS, assessRecord, timestampingFor } from "../api/timestamps.js";
export { obtainTimestamps } from "../api/write/timestamps.js";

/** The exit code reportTimestamps returns, without printing (for --json): 5 when configured authorities fell short. */
export function timestampsExitCode(summary: TimeEvidenceSummary): number {
  return !summary.configured.length || summary.proven ? EXIT.OK : EXIT.TIMESTAMPS_SHORT;
}

/**
 * Prints the outcome table of functional-design.md §U1 item 3 and returns the exit code:
 * PROVEN → 0; 1..k-1 or 0 of k accepted → 5 with the re-run command; none configured → 0 with the warning.
 */
export function reportTimestamps(ctx: CommandContext, summary: TimeEvidenceSummary, outcomes: readonly AuthorityOutcome[], rerun: string): number {
  ctx.out(`  ${timestampsLine(summary)}`);
  for (const o of outcomes) {
    if (o.check?.accepted) continue;
    const why = o.error ?? o.check?.problems.join("; ") ?? "no token";
    ctx.out(`    ${o.tsa}: no accepted token (${why})`);
  }
  if (!summary.configured.length) return EXIT.OK;
  if (summary.proven) return EXIT.OK;
  ctx.out(`  ${notTamperProof(summary)}`);
  if (rerun.startsWith("pr-rla checkpoint")) ctx.out(`  to make it tamper-proof, take another checkpoint (lines are only ever added): ${rerun}`);
  else ctx.out(`  to make it tamper-proof, ${rerun.startsWith("pr-rla register") ? "register" : "freeze"} again before anything is shown to anyone: ${rerun}`);
  return EXIT.TIMESTAMPS_SHORT;
}
