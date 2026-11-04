import { canonicalHistory, historyDiff, historyEventProblems, type CanonicalHistoryEvent, type LedgerHistoryEvent, type VerdictEvent } from "../sdk/ledger.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { PluginIdentity, TimestampEvidence } from "./records.js";

/**
 * Ledger checkpoints (FR4.4; contracts.md §5 `pr-rla/ledger-checkpoint/v1`): the defence against
 * an admin deleting tracker history. A checkpoint hashes the canonical list of `readHistory()`
 * events, is time-stamped by the registered authorities, and is committed to the audit repo with
 * the event list itself, so a later verifier sees what vanished, not only that something did.
 * Pure: the command reads and writes the files (src/api/checkpoint.ts).
 */

export const CHECKPOINTS_FILE = "ledger-checkpoints.jsonl";
export const HISTORY_DIR = "ledger-history";

export interface CheckpointFirstVerdict {
  draw: number;
  changeId: string;
  verdict: "pass" | "fail";
  reviewer: string;
  recordedAt: string;
  eventId: string | null;
}

/** What the timestamp tokens cover: the line without `timestamps`. */
export interface LedgerCheckpointRecord {
  schema: "pr-rla/ledger-checkpoint/v1";
  window: string;
  ledger: PluginIdentity;
  eventsSha256: string;
  count: number;
  perDrawFirstVerdict: CheckpointFirstVerdict[];
  takenAt: string;
}

export interface LedgerCheckpointLine extends LedgerCheckpointRecord {
  timestamps: TimestampEvidence[];
}

/** `ledger-history/<…>.json`: the event list a checkpoint hashed. */
export interface LedgerHistoryFile {
  schema: "pr-rla/ledger-history/v1";
  takenAt: string;
  eventsSha256: string;
  events: CanonicalHistoryEvent[];
}

/** A checkpoint as verify sees it: the line and the stored event list (null when the file is missing or unreadable). */
export interface CheckpointArtifact {
  line: LedgerCheckpointLine;
  events: LedgerHistoryEvent[] | null;
  /** The event-list file, relative to the window directory. */
  file: string;
}

export function eventsSha256(events: readonly LedgerHistoryEvent[]): string {
  return sha256Hex(canonicalJson(canonicalHistory(events)));
}

/** The line minus its tokens: what the authorities time-stamp. */
export function checkpointRecord(line: LedgerCheckpointLine | LedgerCheckpointRecord): LedgerCheckpointRecord {
  const { timestamps: _t, ...record } = line as LedgerCheckpointLine;
  return record;
}

/** The event list's file name. ISO basic time (no colons, which some file systems refuse) plus the hash, so two clones checkpointing in the same second never collide. */
export function historyFileName(takenAt: string, sha: string): string {
  return `${takenAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${sha.slice(0, 12)}.json`;
}

export function firstVerdictsForCheckpoint(firstVerdicts: readonly VerdictEvent[]): CheckpointFirstVerdict[] {
  return firstVerdicts
    .map((v) => ({ draw: v.draw, changeId: v.changeId, verdict: v.verdict, reviewer: v.reviewer, recordedAt: v.recordedAt, eventId: v.provenance?.eventId ?? null }))
    .sort((a, b) => a.draw - b.draw);
}

const identity = (l: Pick<LedgerCheckpointRecord, "takenAt" | "eventsSha256">) => `${l.takenAt}|${l.eventsSha256}`;

/**
 * Reads `ledger-checkpoints.jsonl`. Lines with the same (takenAt, eventsSha256) are one checkpoint
 * (a line repeated by a cross-clone union reads once); a line that is not a checkpoint is a problem.
 */
export function parseCheckpointLines(text: string, where: string): { lines: LedgerCheckpointLine[]; problems: string[] } {
  const lines: LedgerCheckpointLine[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    let v: Partial<LedgerCheckpointLine>;
    try {
      v = JSON.parse(raw) as Partial<LedgerCheckpointLine>;
    } catch {
      problems.push(`${where}:${i + 1}: not JSON`);
      return;
    }
    if (v.schema !== "pr-rla/ledger-checkpoint/v1" || typeof v.takenAt !== "string" || typeof v.eventsSha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.eventsSha256) || typeof v.count !== "number" || !Array.isArray(v.perDrawFirstVerdict)) {
      problems.push(`${where}:${i + 1}: not a pr-rla/ledger-checkpoint/v1 line`);
      return;
    }
    const line = { ...v, timestamps: Array.isArray(v.timestamps) ? v.timestamps : [] } as LedgerCheckpointLine;
    if (seen.has(identity(line))) return;
    seen.add(identity(line));
    lines.push(line);
  });
  return { lines, problems };
}

/**
 * The union of two versions of `ledger-checkpoints.jsonl` (the git transport's only conflict
 * resolution, contracts.md §6): every line of `theirs` (the remote) in order, then each line of
 * `ours` whose identity is new. Unparseable lines are kept verbatim, once.
 */
export function unionCheckpointLines(theirs: string, ours: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...theirs.split("\n"), ...ours.split("\n")]) {
    if (!raw.trim()) continue;
    let key = `raw|${raw}`;
    try {
      const v = JSON.parse(raw) as Partial<LedgerCheckpointLine>;
      if (typeof v.takenAt === "string" && typeof v.eventsSha256 === "string") key = identity(v as LedgerCheckpointLine);
    } catch {
      /* kept verbatim */
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

export function parseHistoryFile(text: string): LedgerHistoryEvent[] {
  const v = JSON.parse(text) as Partial<LedgerHistoryFile>;
  if (v.schema !== "pr-rla/ledger-history/v1" || !Array.isArray(v.events)) throw new Error("not a pr-rla/ledger-history/v1 file");
  for (const e of v.events) {
    const p = historyEventProblems(e);
    if (p.length) throw new Error(`event ${JSON.stringify((e as { id?: unknown })?.id)}: ${p.join("; ")}`);
  }
  return v.events as LedgerHistoryEvent[];
}

/**
 * What check 7 reports for one checkpoint against the ledger's history now (FR4.4):
 * a missing or altered event list, an event that vanished or changed, and a draw whose first
 * verdict is no longer the one the checkpoint recorded.
 */
export function compareWithCheckpoint(cp: CheckpointArtifact, current: readonly LedgerHistoryEvent[], firstVerdicts: readonly VerdictEvent[]): string[] {
  const at = cp.line.takenAt;
  if (!cp.events) return [`checkpoint ${at}: its event list ${cp.file} is missing or unreadable`];
  if (eventsSha256(cp.events) !== cp.line.eventsSha256) return [`checkpoint ${at}: its event list ${cp.file} does not match the line's eventsSha256`];
  const problems: string[] = [];
  const d = historyDiff(cp.events, current);
  if (d.missing.length || d.changed.length)
    problems.push(`history rewritten after checkpoint ${at}: ${d.missing.length} event(s) missing${d.missing.length ? ` (${d.missing.slice(0, 5).join(", ")})` : ""}, ${d.changed.length} changed${d.changed.length ? ` (${d.changed.slice(0, 5).join(", ")})` : ""}`);
  const now = new Map(firstVerdicts.map((v) => [v.changeId, v]));
  for (const f of cp.line.perDrawFirstVerdict) {
    const v = now.get(f.changeId);
    const same = v && v.verdict === f.verdict && (f.eventId === null || v.provenance?.eventId === f.eventId) && v.recordedAt === f.recordedAt;
    if (!same) problems.push(`checkpoint ${at}: draw #${f.draw} had first verdict ${f.verdict} (${f.recordedAt}); now ${v ? `${v.verdict} (${v.recordedAt})` : "none"}`);
  }
  return problems;
}
