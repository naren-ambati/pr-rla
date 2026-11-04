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
  /** Timestamp-authority anchors you trust beyond the shipped bundle (files), as verify's; the checkpoint's tokens use them too. */
  tsaTrust?: string[];
  /** P5: `--log-key <log url>=<pem file>`, repeatable, as verify's. */
  logKey?: string[];
  /** P5 (T14): `--registration <sha256>`, the registration you were handed, as verify's. */
  registration?: string;
}

const apiOptions = (opts: StatusOptions): ApiStatusOptions => ({ offline: !!opts.offline, ...(opts.tsaTrust?.length ? { tsaTrust: opts.tsaTrust } : {}), ...(opts.logKey?.length ? { logKey: opts.logKey } : {}), ...(opts.registration !== undefined ? { registration: opts.registration } : {}) });
const checkpointOptions = (opts: StatusOptions) => (opts.tsaTrust?.length ? { tsaTrust: opts.tsaTrust } : {});

/**
 * The exit code of `status --checkpoint` (P5, contracts.md §7): a FAIL first (status's 1, or the checkpoint's own 1);
 * then the checkpoint's 4 (stopped; re-run it) or 5 (too few timestamps), which say what to do now; then status's 2, 3
 * or 6; else the checkpoint's. Status's 6 no longer hides the checkpoint's 4 or 5. A checkpoint that cannot run at all
 * (an error) exits with its error's code, as before.
 */
export function statusCheckpointExitCode(status: number, checkpoint: number): number {
  if (status === 1 || checkpoint === 1) return 1;
  if (checkpoint === 4 || checkpoint === 5) return checkpoint;
  return status !== 0 ? status : checkpoint;
}

export async function statusCommand(ctx: CommandContext, opts: StatusOptions): Promise<number> {
  if (opts.json && opts.checkpoint) return statusJsonWithCheckpoint(ctx, opts);
  const code = await statusOnly(ctx, opts);
  if (!opts.checkpoint) return code;
  // A checkpoint that cannot run throws, and its error decides the exit code (as before); one that ran returns its code.
  return statusCheckpointExitCode(code, await checkpointCommand(ctx, checkpointOptions(opts)));
}

/**
 * `status --json --checkpoint`: one JSON document on stdout, always (contracts.md §7): the status
 * result with the checkpoint's result as `checkpoint`, or `checkpoint: { error }` when it failed.
 * The exit code is status's, else the checkpoint's; a failed checkpoint's own (as without --json).
 */
async function statusJsonWithCheckpoint(ctx: CommandContext, opts: StatusOptions): Promise<number> {
  const r = await status(ctx, apiOptions(opts));
  const code = statusExitCode(r);
  try {
    const cp = await checkpoint(ctx, checkpointOptions(opts));
    ctx.out(JSON.stringify({ ...r, checkpoint: cp }, null, 2));
    return statusCheckpointExitCode(code, checkpointExitCode(cp));
  } catch (e) {
    const { code: c, host, next } = e as { code?: unknown; host?: unknown; next?: unknown };
    ctx.out(JSON.stringify({ ...r, checkpoint: { error: { code: typeof c === "string" ? c : "FAILED", message: (e as Error).message, ...(typeof host === "string" ? { host } : {}), ...(typeof next === "string" && next ? { next } : {}) } } }, null, 2));
    // As without --json, a checkpoint that failed decides the exit code, unless status itself FAILed (P5's precedence).
    return statusCheckpointExitCode(code === 1 ? 1 : 0, e instanceof AuditError ? e.exitCode : 1);
  }
}

async function statusOnly(ctx: CommandContext, opts: StatusOptions): Promise<number> {
  const r = await status(ctx, apiOptions(opts));
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
  // Verdicts not read: what verify's offline checks and check 7's local rules would FAIL still shows, and status exits 1 on it.
  if (r.phase === "sampled" && !r.verdictsRead) {
    for (const f of r.offlineFails) ctx.out(`  ${f}`);
    for (const f of r.ledgerGate.fails) ctx.out(`  FAIL ${f}`);
    return;
  }
  if (r.phase !== "sampled" || !r.verdictsRead || r.refusal) return;
  for (const f of r.ledgerIntegrity?.fails ?? []) ctx.out(`  ledger integrity FAILs: ${f}`);
  for (const w of r.ledgerIntegrity?.warnings ?? []) ctx.out(`  WARN ${w}`);
  // P1: the rest of check 7's gate, as verify prints it (the index binding, its publication, the checkpoints and their coverage).
  for (const l of r.ledgerGate.shown) ctx.out(`  ${l}`);
  if (r.blockingDraw) ctx.out(`  blocking draw: #${r.blockingDraw.draw} ${r.blockingDraw.changeId} ${r.blockingDraw.url}`);
  ctx.out(`  distinct changes reviewed: ${r.distinctReviewed} · draws counted: ${r.sequence.draws}${r.beyondStop ? ` · ${r.beyondStop} labelled draw(s) after the stop are not counted` : ""}`);
  for (const i of r.ignored) ctx.out(`  ignored verdict on draw #${i.event.draw} (${i.event.changeId}): ${i.reason}`);
  for (const x of r.relabels) ctx.out(`  relabel: ${x.changeId} first ${x.first.verdict} (counts), later ${x.later.verdict}`);
  ctx.out(`  ${provenanceLine(r.provenance)} · registered minimum ${provenanceLabel(r.minProvenance)}${r.requireSigned ? " · signed verdicts required (require_signed)" : ""}`);
  for (const note of r.verdictNotes) ctx.out(`  ${note}`);
  if (r.belowMinimum.length) ctx.out(`  ${r.belowMinimum.length} counted verdict(s) are below the registered ${provenanceLabel(r.minProvenance)} provenance; verify check 7 will FAIL them (draws ${r.belowMinimum.map((d) => `#${d}`).join(", ")})`);
  if (r.unsigned.length) ctx.out(`  ${r.unsigned.length} counted verdict(s) carry no valid signature by the registered key of the reviewer they name; verify check 7 will FAIL them under require_signed (draws ${r.unsigned.map((d) => `#${d}`).join(", ")})`);
  for (const w of r.certificate.withheld) ctx.out(`  ${r.certificate.state === "INCOMPLETE" ? "not established" : "certificate withheld"} (${w.verdict}): ${w.reason}`);
  // P5: what verify would FAIL on these records, whatever the sequence's state (status exits 1).
  for (const f of r.offlineFails) if (!r.certificate.withheld.some((w) => w.reason === f)) ctx.out(`  ${f}`);
  if (r.checkpointAdvised) ctx.out(`  ${r.certificate.state === "CERTIFIED" ? "CERTIFIED" : "target reached"}: run "pr-rla checkpoint" and commit it to anchor the verdict history`);
  if (r.perRepo) for (const l of perRepoLines(r.perRepo)) ctx.out(l);
  ctx.out("  assumptions: claim D is about detection under the registered protocol by these reviewers, not the true defect rate; draws are with replacement.");
}
