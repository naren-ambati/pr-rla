import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalJson } from "../../core/canonical.js";
import { eventsSha256, firstVerdictsForCheckpoint, historyFileName, type LedgerCheckpointLine, type LedgerCheckpointRecord, type LedgerHistoryFile } from "../../core/checkpoint.js";
import { isRegistrationV2, type PluginIdentity, type SignedRecord } from "../../core/records.js";
import { EXIT } from "../../cli/exit-codes.js";
import { writeFileAtomic } from "../../io/atomic.js";
import { checkPreconditions, commitAndPush, nodeGit, type GitRunner } from "../../io/git-transport.js";
import { pluginIdentity } from "../../registry.js";
import { canonicalHistory, type Ledger, type LedgerHistoryEvent, type VerdictEvent } from "../../sdk/ledger.js";
import type { AuthorityOutcome } from "../../timestamp/client.js";
import type { TimeEvidenceSummary } from "../../timestamp/verify.js";
import { requireReadWrite, type AuditContext } from "../context.js";
import { AuditError } from "../errors.js";
import { checkpointsPath, historyDirPath } from "../read/checkpoints.js";
import { ledgerStatus } from "../read/status.js";
import { auditContextFor, configFor, isoNow, ledgerFor, readRegistration, trustFor, requireWritable, type ApiContext } from "../session.js";
import { assessRecord, timestampingFor } from "../timestamps.js";
import { obtainTimestamps } from "./timestamps.js";

export const CHECKPOINT_COMMAND = "pr-rla checkpoint";

/** The record a checkpoint signs nothing over but time-stamps: what the ledger's history is now. */
export async function buildCheckpoint(ctx: AuditContext, input: { ledger: Ledger; identity: PluginIdentity; window: string; firstVerdicts: readonly VerdictEvent[]; takenAt: string }): Promise<{ record: LedgerCheckpointRecord; events: LedgerHistoryEvent[] }> {
  requireReadWrite(ctx, "checkpoint");
  if (!input.ledger.readHistory) throw new Error(`ledger ${input.ledger.name} has no readHistory, so it cannot be checkpointed (checkpoints anchor issue-tracker ledgers; git-file's tamper trail is git history itself)`);
  const events = canonicalHistory(await input.ledger.readHistory());
  return {
    record: {
      schema: "pr-rla/ledger-checkpoint/v1",
      window: input.window,
      ledger: input.identity,
      eventsSha256: eventsSha256(events),
      count: events.length,
      perDrawFirstVerdict: firstVerdictsForCheckpoint(input.firstVerdicts),
      takenAt: input.takenAt,
    },
    events,
  };
}

/**
 * Appends a checkpoint: the event list first, then the line, each written atomically (NFR15),
 * so a line never names a list that is not there. Returns both files' paths.
 */
export function appendCheckpoint(ctx: AuditContext, windowDir: string, line: LedgerCheckpointLine, events: readonly LedgerHistoryEvent[]): { linesFile: string; historyFile: string } {
  requireReadWrite(ctx, "checkpoint");
  const historyFile = join(historyDirPath(windowDir), historyFileName(line.takenAt, line.eventsSha256));
  const body: LedgerHistoryFile = { schema: "pr-rla/ledger-history/v1", takenAt: line.takenAt, eventsSha256: line.eventsSha256, events: canonicalHistory(events) };
  writeFileAtomic(historyFile, `${JSON.stringify(body, null, 1)}\n`);
  const linesFile = checkpointsPath(windowDir);
  const before = existsSync(linesFile) ? readFileSync(linesFile, "utf8") : "";
  writeFileAtomic(linesFile, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${canonicalJson(line)}\n`);
  return { linesFile, historyFile };
}

export interface CheckpointOptions {
  /** Commit the checkpoint and push it through the git transport (contracts.md §6). */
  push?: boolean;
  remote?: string;
  branch?: string;
  tsaTrust?: string[];
  /** Tests inject a git runner that races the remote; the CLI uses real git. */
  git?: GitRunner;
}

/** The two files a checkpoint wrote, and what they hold: reported as soon as they are written (before the timestamps are assessed). */
export type CheckpointWritten = Omit<CheckpointAppended, "evidence" | "outcomes">;

/** The appended checkpoint, before any push. */
export interface CheckpointAppended {
  takenAt: string;
  ledger: string;
  count: number;
  firstVerdicts: number;
  eventsSha256: string;
  /** The two files, relative to the audit repo. */
  linesFile: string;
  historyFile: string;
  evidence: TimeEvidenceSummary;
  outcomes: AuthorityOutcome[];
  /** The commit message a push uses (and the CLI suggests without --push). */
  commitMessage: string;
}

export interface CheckpointResult extends CheckpointAppended {
  /** null without --push; else what the git transport did. */
  push: null | { ok: true; remote: string; branch: string; head: string; attempts: number } | { ok: false; reason: string; rerun: string };
}

/**
 * `checkpoint [--push]` (FR4.4): hashes the ledger's verdict-event history, time-stamps it with the
 * registered authorities, and appends it with its event list to the audit repo. With --push it
 * commits and pushes through the git transport. CLI only; refused in a read-only context.
 */
export async function checkpoint(ctx: ApiContext, opts: CheckpointOptions = {}, hooks: { onWritten?: (c: CheckpointWritten) => void; onAppended?: (c: CheckpointAppended) => void } = {}): Promise<CheckpointResult> {
  const { config, paths } = configFor(ctx);
  requireWritable(ctx, "checkpoint");
  const reg = readRegistration(paths);
  const git = opts.git ?? nodeGit(config.dir);
  let pre: Awaited<ReturnType<typeof checkPreconditions>> | null = null;
  if (opts.push) {
    pre = await checkPreconditions(git, { ...(opts.remote ? { remote: opts.remote } : {}), ...(opts.branch ? { branch: opts.branch } : {}) });
    if (!pre.ok) throw new AuditError(`checkpoint --push refused: ${pre.reason}`, EXIT.FAIL);
  }
  const ledger = await ledgerFor(ctx, config, paths);
  if (!ledger.readHistory) throw new AuditError(`ledger ${ledger.name} has no readHistory, so it cannot be checkpointed (git-file's tamper trail is git history itself)`, EXIT.FAIL);
  const status = await ledgerStatus(paths, ledger, reg);
  const takenAt = isoNow(ctx);
  const { record, events } = await buildCheckpoint(auditContextFor(ctx), { ledger, identity: await pluginIdentity(config.ledger, "ledger", config.dir, auditContextFor(ctx).plugins), window: config.window.name, firstVerdicts: status?.firstVerdicts ?? [], takenAt });
  const bundle = trustFor(ctx, opts.tsaTrust);
  const timestamping = isRegistrationV2(reg) ? reg.record.timestamping : timestampingFor(config, bundle);
  // Skew over 10 minutes refuses here, before anything is written (FR1.8).
  const got = await obtainTimestamps(ctx, { record } as SignedRecord<unknown>, takenAt, timestamping, bundle);
  const line: LedgerCheckpointLine = { ...record, timestamps: got.timestamps };
  const files = appendCheckpoint(auditContextFor(ctx), paths.windowDir, line, events);
  const rel = (p: string) => relative(config.dir, p) || p;
  const written: CheckpointWritten = {
    takenAt,
    ledger: ledger.name,
    count: record.count,
    firstVerdicts: record.perDrawFirstVerdict.length,
    eventsSha256: record.eventsSha256,
    linesFile: rel(files.linesFile),
    historyFile: rel(files.historyFile),
    commitMessage: `pr-rla checkpoint ${config.window.name} ${takenAt}`,
  };
  // The files are written: say so before anything else can fail.
  hooks.onWritten?.(written);
  const evidence = await assessRecord(ctx, config, { record, timestamps: got.timestamps } as SignedRecord<unknown>, takenAt, timestamping, bundle);
  const appended: CheckpointAppended = { ...written, evidence, outcomes: got.outcomes };
  hooks.onAppended?.(appended);
  if (!opts.push || !pre?.ok) return { ...appended, push: null };
  // Conflict paths are relative to the repo's top level, so the transport runs there.
  const pushed = await commitAndPush(opts.git ?? nodeGit(pre.top), { top: pre.top, files: [files.linesFile, files.historyFile], message: appended.commitMessage, target: pre.target, log: (l) => ctx.err(l) });
  if (!pushed.ok) return { ...appended, push: { ok: false, reason: pushed.reason, rerun: `${CHECKPOINT_COMMAND} --push${opts.remote ? ` --remote ${opts.remote} --branch ${opts.branch}` : ""}` } };
  return { ...appended, push: { ok: true, remote: pre.target.remote, branch: pre.target.branch, head: pushed.head, attempts: pushed.attempts } };
}
