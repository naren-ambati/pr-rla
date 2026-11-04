import { AuditError } from "../api/errors.js";
import { status, statusExitCode, type StatusOptions as ApiStatusOptions, type StatusResult } from "../api/read/status.js";
import { checkpoint } from "../api/write/checkpoint.js";
import { perRepoLines } from "../core/pooled-report.js";
import { provenanceLabel } from "../core/presence/index.js";
import { provenanceLine } from "../core/status.js";
import { checkpointCommand, checkpointExitCode } from "./checkpoint.js";
import type { CommandContext } from "./context.js";

// The status logic moved to the audit API in U5 (src/api/read/status.ts); re-exported for callers.
export { statusExitCode, statusLine, stratumChoices, timeStanding } from "../api/read/status.js";

export interface StatusOptions {
  json?: boolean;
  offline?: boolean;
  /** Also append a ledger checkpoint (FR4.4); plain status never does. */
  checkpoint?: boolean;
}

export async function statusCommand(ctx: CommandContext, opts: StatusOptions): Promise<number> {
  if (opts.json && opts.checkpoint) return statusJsonWithCheckpoint(ctx, opts);
  const code = await statusOnly(ctx, opts);
  if (!opts.checkpoint) return code;
  const cp = await checkpointCommand(ctx, {});
  return code !== 0 ? code : cp;
}

/**
 * `status --json --checkpoint`: one JSON document on stdout, always (contracts.md §7): the status
 * result with the checkpoint's result as `checkpoint`, or `checkpoint: { error }` when it failed.
 * The exit code is status's, else the checkpoint's; a failed checkpoint's own (as without --json).
 */
async function statusJsonWithCheckpoint(ctx: CommandContext, opts: StatusOptions): Promise<number> {
  const r = await status(ctx, { offline: !!opts.offline } satisfies ApiStatusOptions);
  const code = statusExitCode(r);
  try {
    const cp = await checkpoint(ctx, {});
    ctx.out(JSON.stringify({ ...r, checkpoint: cp }, null, 2));
    return code !== 0 ? code : checkpointExitCode(cp);
  } catch (e) {
    const { code: c, host, next } = e as { code?: unknown; host?: unknown; next?: unknown };
    ctx.out(JSON.stringify({ ...r, checkpoint: { error: { code: typeof c === "string" ? c : "FAILED", message: (e as Error).message, ...(typeof host === "string" ? { host } : {}), ...(typeof next === "string" && next ? { next } : {}) } } }, null, 2));
    // As without --json, a failed checkpoint decides the exit code.
    return e instanceof AuditError ? e.exitCode : 1;
  }
}

async function statusOnly(ctx: CommandContext, opts: StatusOptions): Promise<number> {
  const r = await status(ctx, { offline: !!opts.offline } satisfies ApiStatusOptions);
  if (opts.json) {
    ctx.out(JSON.stringify(r, null, 2));
    return statusExitCode(r);
  }
  printStatus(ctx, r);
  return statusExitCode(r);
}

/** The text form of a status result. */
export function printStatus(ctx: Pick<CommandContext, "out">, r: StatusResult): void {
  ctx.out(r.line);
  const refused = r.phase === "sampled" && r.verdictsRead && !!r.refusal;
  if (r.phase !== "unregistered" && !refused && r.timestampAnchors.length) ctx.out(`  timestamp anchors: ${r.timestampAnchors.join(" · ")}`);
  if (r.phase !== "sampled" || !r.verdictsRead || r.refusal) return;
  if (r.blockingDraw) ctx.out(`  blocking draw: #${r.blockingDraw.draw} ${r.blockingDraw.changeId} ${r.blockingDraw.url}`);
  ctx.out(`  distinct changes reviewed: ${r.distinctReviewed} · draws counted: ${r.sequence.draws}${r.beyondStop ? ` · ${r.beyondStop} labelled draw(s) after the stop are not counted` : ""}`);
  for (const i of r.ignored) ctx.out(`  ignored verdict on draw #${i.event.draw} (${i.event.changeId}): ${i.reason}`);
  for (const x of r.relabels) ctx.out(`  relabel: ${x.changeId} first ${x.first.verdict} (counts), later ${x.later.verdict}`);
  ctx.out(`  ${provenanceLine(r.provenance)} · registered minimum ${provenanceLabel(r.minProvenance)}${r.requireSigned ? " · signed verdicts required (require_signed)" : ""}`);
  for (const note of r.verdictNotes) ctx.out(`  ${note}`);
  if (r.belowMinimum.length) ctx.out(`  ${r.belowMinimum.length} counted verdict(s) are below the registered ${provenanceLabel(r.minProvenance)} provenance; verify check 7 will FAIL them (draws ${r.belowMinimum.map((d) => `#${d}`).join(", ")})`);
  if (r.unsigned.length) ctx.out(`  ${r.unsigned.length} counted verdict(s) carry no valid signature by the registered key of the reviewer they name; verify check 7 will FAIL them under require_signed (draws ${r.unsigned.map((d) => `#${d}`).join(", ")})`);
  for (const w of r.certificate.withheld) ctx.out(`  ${r.certificate.state === "INCOMPLETE" ? "not established" : "certificate withheld"} (${w.verdict}): ${w.reason}`);
  if (r.checkpointAdvised) ctx.out(`  ${r.certificate.state === "CERTIFIED" ? "CERTIFIED" : "target reached"}: run "pr-rla checkpoint" and commit it to anchor the verdict history`);
  if (r.perRepo) for (const l of perRepoLines(r.perRepo)) ctx.out(l);
  ctx.out("  assumptions: claim D is about detection under the registered protocol by these reviewers, not the true defect rate; draws are with replacement.");
}
