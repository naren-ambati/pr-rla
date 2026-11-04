import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CHECKPOINTS_FILE,
  chainTip,
  HISTORY_DIR,
  eventsSha256,
  firstVerdictsForCheckpoint,
  historyFileName,
  parseCheckpointLines,
  parseHistoryFile,
  type CheckpointArtifact,
  type LedgerCheckpointLine,
  type LedgerCheckpointRecord,
  type LedgerHistoryFile,
} from "../core/checkpoint.js";
import type { PluginIdentity } from "../core/records.js";
import { writeFileAtomic } from "../io/atomic.js";
import { canonicalHistory, type Ledger, type LedgerHistoryEvent, type VerdictEvent } from "../sdk/ledger.js";
import { canonicalJson } from "../core/canonical.js";
import { requireReadWrite, type AuditContext } from "./context.js";

/**
 * Ledger checkpoints in the audit repo (FR4.4; functional-design.md §U4; contracts.md §5):
 * `audit/<window>/ledger-checkpoints.jsonl`, one line per checkpoint, and the canonical event
 * list each one hashed under `audit/<window>/ledger-history/`. Writing is read-write only;
 * the MCP server (read-only) never reaches it.
 */

export const checkpointsPath = (windowDir: string) => join(windowDir, CHECKPOINTS_FILE);
export const historyDirPath = (windowDir: string) => join(windowDir, HISTORY_DIR);

/** Every checkpoint in the window (de-duplicated by identity), with its stored event list. */
export function readCheckpoints(windowDir: string): { checkpoints: CheckpointArtifact[]; problems: string[]; unchained: number } {
  const file = checkpointsPath(windowDir);
  if (!existsSync(file)) return { checkpoints: [], problems: [], unchained: 0 };
  const { lines, problems, unchained } = parseCheckpointLines(readFileSync(file, "utf8"), CHECKPOINTS_FILE);
  const checkpoints = lines.map((line) => {
    const rel = `${HISTORY_DIR}/${historyFileName(line.takenAt, line.eventsSha256)}`;
    let events: LedgerHistoryEvent[] | null = null;
    try {
      events = parseHistoryFile(readFileSync(join(windowDir, rel), "utf8"));
    } catch {
      events = null;
    }
    return { line, events, file: rel };
  });
  return { checkpoints, problems, unchained };
}

/** The hash the next line of this window's `ledger-checkpoints.jsonl` carries as `prevLineSha256` (null before the first). */
export function checkpointChainTip(windowDir: string): string | null {
  const file = checkpointsPath(windowDir);
  return chainTip(existsSync(file) ? readFileSync(file, "utf8") : "");
}

/** The newest checkpoint's time, or null. */
export function latestCheckpointAt(windowDir: string): string | null {
  const { checkpoints } = readCheckpoints(windowDir);
  return checkpoints.reduce<string | null>((m, c) => (m === null || c.line.takenAt > m ? c.line.takenAt : m), null);
}

/** The record a checkpoint signs nothing over but time-stamps: what the ledger's history is now. */
export async function buildCheckpoint(ctx: AuditContext, input: { ledger: Ledger; identity: PluginIdentity; window: string; firstVerdicts: readonly VerdictEvent[]; takenAt: string; prevLineSha256?: string | null; ledgerIndexSha256?: string | null }): Promise<{ record: LedgerCheckpointRecord; events: LedgerHistoryEvent[] }> {
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
      ...(input.prevLineSha256 !== undefined ? { prevLineSha256: input.prevLineSha256 } : {}),
      ...(input.ledgerIndexSha256 ? { ledgerIndexSha256: input.ledgerIndexSha256 } : {}),
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

/** History files present in the window (for listings and tests). */
export function historyFiles(windowDir: string): string[] {
  const d = historyDirPath(windowDir);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).sort() : [];
}
