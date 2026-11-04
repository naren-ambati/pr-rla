import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readTextConfined } from "../../io/confine.js";
import { CHECKPOINTS_FILE, HISTORY_DIR, chainTip, historyFileName, parseCheckpointLines, parseHistoryFile, type CheckpointArtifact } from "../../core/checkpoint.js";
import type { LedgerHistoryEvent } from "../../sdk/ledger.js";

/**
 * Reading ledger checkpoints in the audit repo (FR4.4; contracts.md §5): `audit/<window>/ledger-checkpoints.jsonl`
 * and the event lists under `audit/<window>/ledger-history/`. The writers are in src/api/write/checkpoint.ts.
 */

export const checkpointsPath = (windowDir: string) => join(windowDir, CHECKPOINTS_FILE);
export const historyDirPath = (windowDir: string) => join(windowDir, HISTORY_DIR);

/** Every checkpoint in the window (de-duplicated by identity), with its stored event list. */
export function readCheckpoints(windowDir: string): { checkpoints: CheckpointArtifact[]; problems: string[]; unchained: number } {
  const file = checkpointsPath(windowDir);
  if (!existsSync(file)) return { checkpoints: [], problems: [], unchained: 0 };
  const { lines, problems, unchained } = parseCheckpointLines(readTextConfined(file, CHECKPOINTS_FILE), CHECKPOINTS_FILE);
  const checkpoints = lines.map((line) => {
    const rel = `${HISTORY_DIR}/${historyFileName(line.takenAt, line.eventsSha256)}`;
    let events: LedgerHistoryEvent[] | null = null;
    try {
      events = parseHistoryFile(readTextConfined(join(windowDir, rel), "a ledger-history file"));
    } catch (e) {
      // A history file outside the roots is refused, not read; one that is missing or malformed is reported by verify.
      if ((e as { code?: unknown }).code === "ROOT_ESCAPE") throw e;
      events = null;
    }
    return { line, events, file: rel };
  });
  return { checkpoints, problems, unchained };
}

/** The hash the next line of this window's `ledger-checkpoints.jsonl` carries as `prevLineSha256` (null before the first). */
export function checkpointChainTip(windowDir: string): string | null {
  const file = checkpointsPath(windowDir);
  return chainTip(existsSync(file) ? readTextConfined(file, CHECKPOINTS_FILE) : "");
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
