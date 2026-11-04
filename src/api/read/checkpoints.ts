import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CHECKPOINTS_FILE, HISTORY_DIR, historyFileName, parseCheckpointLines, parseHistoryFile, type CheckpointArtifact } from "../../core/checkpoint.js";
import type { LedgerHistoryEvent } from "../../sdk/ledger.js";

/**
 * Reading ledger checkpoints in the audit repo (FR4.4; contracts.md §5): `audit/<window>/ledger-checkpoints.jsonl`
 * and the event lists under `audit/<window>/ledger-history/`. The writers are in src/api/write/checkpoint.ts.
 */

export const checkpointsPath = (windowDir: string) => join(windowDir, CHECKPOINTS_FILE);
export const historyDirPath = (windowDir: string) => join(windowDir, HISTORY_DIR);

/** Every checkpoint in the window (de-duplicated by identity), with its stored event list. */
export function readCheckpoints(windowDir: string): { checkpoints: CheckpointArtifact[]; problems: string[] } {
  const file = checkpointsPath(windowDir);
  if (!existsSync(file)) return { checkpoints: [], problems: [] };
  const { lines, problems } = parseCheckpointLines(readFileSync(file, "utf8"), CHECKPOINTS_FILE);
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
  return { checkpoints, problems };
}

/** The newest checkpoint's time, or null. */
export function latestCheckpointAt(windowDir: string): string | null {
  const { checkpoints } = readCheckpoints(windowDir);
  return checkpoints.reduce<string | null>((m, c) => (m === null || c.line.takenAt > m ? c.line.takenAt : m), null);
}

/** History files present in the window (for listings and tests). */
export function historyFiles(windowDir: string): string[] {
  const d = historyDirPath(windowDir);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).sort() : [];
}
