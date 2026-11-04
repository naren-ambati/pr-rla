import { existsSync } from "node:fs";
import { relative } from "node:path";
import { appendCheckpoint, buildCheckpoint, checkpointChainTip } from "../api/checkpoint.js";
import { requireReadWrite } from "../api/context.js";
import type { LedgerCheckpointLine } from "../core/checkpoint.js";
import { isRegistrationV2, type SignedRecord } from "../core/records.js";
import { computeStatus, type StatusReport } from "../core/status.js";
import { EXIT } from "../cli/exit-codes.js";
import type { PrRlaConfig, WindowPaths } from "../config.js";
import { checkPreconditions, commitAndPush, nodeGit, type GitRunner } from "../io/git-transport.js";
import { readIndexDocument } from "../ledgers/issue-index.js";
import { pluginIdentity } from "../registry.js";
import type { Ledger } from "../sdk/ledger.js";
import { CommandError, auditContextFor, configFor, isoNow, ledgerFor, readDraws, readManifest, readRegistration, trustFor, type CommandContext } from "./context.js";
import { assessRecord, obtainTimestamps, reportTimestamps, timestampingFor } from "./timestamps.js";

export const CHECKPOINT_COMMAND = "pr-rla checkpoint";

export interface CheckpointOptions {
  /** Commit the checkpoint and push it through the git transport (contracts.md §6). */
  push?: boolean;
  remote?: string;
  branch?: string;
  tsaTrust?: string[];
  /** Tests inject a git runner that races the remote; the CLI uses real git. */
  git?: GitRunner;
}

/** The status of the audit's draws against a ledger's verdicts, when draws exist. */
export async function ledgerStatus(config: PrRlaConfig, paths: WindowPaths, ledger: Ledger, reg = readRegistration(paths)): Promise<StatusReport | null> {
  if (!existsSync(paths.manifest) || !existsSync(paths.draws)) return null;
  const manifest = readManifest(paths);
  const draws = readDraws(paths);
  return computeStatus({
    N: manifest.N,
    minPopulation: reg.record.parameters.minPopulation,
    draws: draws.draws,
    drawsIssued: draws.issued,
    verdicts: await ledger.readVerdicts(),
    protocolSha256: reg.record.protocolSha256,
    params: reg.record.parameters,
    reviewers: isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null,
  });
}

/**
 * `pr-rla checkpoint [--push]` (FR4.4): hashes the ledger's verdict-event history, time-stamps it
 * with the registered authorities, and appends it with its event list to the audit repo. With
 * --push it commits and pushes through the git transport. Exit codes follow contracts.md §7:
 * 1 preconditions, 4 push stopped, 5 too few timestamps.
 */
export async function checkpointCommand(ctx: CommandContext, opts: CheckpointOptions = {}): Promise<number> {
  const { config, paths } = configFor(ctx);
  requireReadWrite(auditContextFor(ctx), "checkpoint");
  const reg = readRegistration(paths);
  const git = opts.git ?? nodeGit(config.dir);
  let pre: Awaited<ReturnType<typeof checkPreconditions>> | null = null;
  if (opts.push) {
    pre = await checkPreconditions(git, { ...(opts.remote ? { remote: opts.remote } : {}), ...(opts.branch ? { branch: opts.branch } : {}) });
    if (!pre.ok) throw new CommandError(`checkpoint --push refused: ${pre.reason}`, EXIT.FAIL);
  }
  const ledger = await ledgerFor(ctx, config, paths);
  if (!ledger.readHistory) throw new CommandError(`ledger ${ledger.name} has no readHistory, so it cannot be checkpointed (git-file's tamper trail is git history itself)`, EXIT.FAIL);
  const status = await ledgerStatus(config, paths, ledger, reg);
  const takenAt = isoNow(ctx);
  const { record, events } = await buildCheckpoint(auditContextFor(ctx), { ledger, identity: await pluginIdentity(config.ledger, "ledger", config.dir, auditContextFor(ctx).plugins), window: config.window.name, firstVerdicts: status?.firstVerdicts ?? [], takenAt, prevLineSha256: checkpointChainTip(paths.windowDir), ledgerIndexSha256: readIndexDocument(paths.windowDir)?.sha256 ?? null });
  const bundle = trustFor(ctx, opts.tsaTrust);
  const timestamping = isRegistrationV2(reg) ? reg.record.timestamping : timestampingFor(config, bundle);
  // Skew over 10 minutes refuses here, before anything is written (FR1.8).
  const got = await obtainTimestamps(ctx, { record } as SignedRecord<unknown>, takenAt, timestamping, bundle);
  const line: LedgerCheckpointLine = { ...record, timestamps: got.timestamps };
  const files = appendCheckpoint(auditContextFor(ctx), paths.windowDir, line, events);
  const rel = (p: string) => relative(config.dir, p) || p;
  ctx.out(`checkpoint ${takenAt} · ledger ${ledger.name} · ${record.count} event(s) · ${record.perDrawFirstVerdict.length} first verdict(s) · eventsSha256 ${record.eventsSha256.slice(0, 12)}…`);
  ctx.out(`  appended to ${rel(files.linesFile)} · event list ${rel(files.historyFile)}`);
  const summary = await assessRecord(ctx, config, { record, timestamps: got.timestamps } as SignedRecord<unknown>, takenAt, timestamping, bundle);
  const tsCode = reportTimestamps(ctx, summary, got.outcomes, opts.push ? `${CHECKPOINT_COMMAND} --push` : CHECKPOINT_COMMAND);
  const message = `pr-rla checkpoint ${config.window.name} ${takenAt}`;
  if (!opts.push || !pre?.ok) {
    ctx.out(`  commit it: git add ${rel(files.linesFile)} ${rel(files.historyFile)} && git commit -m "${message}"   (or run "${CHECKPOINT_COMMAND} --push")`);
    return tsCode;
  }
  // Conflict paths are relative to the repo's top level, so the transport runs there.
  const pushed = await commitAndPush(opts.git ?? nodeGit(pre.top), { top: pre.top, files: [files.linesFile, files.historyFile], message, target: pre.target, log: (l) => ctx.err(l) });
  if (!pushed.ok) {
    ctx.out(`  not pushed: ${pushed.reason}`);
    ctx.out(`  run again: ${CHECKPOINT_COMMAND} --push${opts.remote ? ` --remote ${opts.remote} --branch ${opts.branch}` : ""}`);
    return EXIT.STOPPED;
  }
  ctx.out(`  pushed to ${pre.target.remote}/${pre.target.branch} (${pushed.head.slice(0, 10)}, attempt ${pushed.attempts} of 3, no force)`);
  return tsCode;
}
