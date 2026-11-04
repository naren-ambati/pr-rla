import { canonicalHistory, historyDiff, historyEventProblems, type CanonicalHistoryEvent, type LedgerHistoryEvent, type VerdictEvent } from "../sdk/ledger.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { PluginIdentity, TimestampEvidence } from "./records.js";
import { ident, isoOrForeign, joinLines, said, type Line } from "./said.js";

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
  /**
   * Added after v1's first lines (optional, same schema): SHA-256 of the text of the line before this
   * one in `ledger-checkpoints.jsonl` (null for the first), so a deleted or edited line breaks the
   * chain `verify` walks. Lines written before it have no such field and stay readable.
   */
  prevLineSha256?: string | null;
  /** Added likewise: `ledgerIndexSha256` of the window's ledger index when the checkpoint was taken, so the time-stamp covers the draw → issue mapping. */
  ledgerIndexSha256?: string;
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

/** The text of one stored line as its successor hashes it: without the line break (and a carriage return a Windows checkout may add). */
export const lineText = (raw: string) => raw.replace(/\r$/, "");
export const lineSha256 = (raw: string) => sha256Hex(lineText(raw));

/** What the lines of one checkpoint agree on: everything but the tokens and the chain link, which differ between copies of the same checkpoint. */
const agreement = (l: LedgerCheckpointLine) => canonicalJson({ ...checkpointRecord(l), prevLineSha256: undefined });

/**
 * Reads `ledger-checkpoints.jsonl`. Lines with the same (takenAt, eventsSha256) are one checkpoint
 * (a line repeated by a cross-clone union reads once, and the copy with the most time-stamp tokens is
 * the one kept, so a weaker copy never shadows a stronger one); a line that is not a checkpoint is a
 * problem, and so are two lines of one checkpoint that disagree about anything but their tokens.
 *
 * The chain (`prevLineSha256`): a line that names a previous line must name one that appears
 * earlier in the file. Deleting or editing a line in the middle breaks the next line's link;
 * lines of two clones joined by the union each link to the line their clone had before. Lines
 * without the field (written before it existed) are not checked.
 */
export function parseCheckpointLines(text: string, where: string): { lines: LedgerCheckpointLine[]; problems: string[]; unchained: number } {
  const byIdentity = new Map<string, LedgerCheckpointLine>();
  const problems: string[] = [];
  const earlier = new Set<string>();
  let unchained = 0;
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
    if (v.prevLineSha256 !== undefined && v.prevLineSha256 !== null && !(typeof v.prevLineSha256 === "string" && /^[0-9a-f]{64}$/.test(v.prevLineSha256))) {
      problems.push(`${where}:${i + 1}: prevLineSha256 is neither null nor 64 hex characters`);
      return;
    }
    const line = { ...v, timestamps: Array.isArray(v.timestamps) ? v.timestamps : [] } as LedgerCheckpointLine;
    if (line.prevLineSha256 === undefined) unchained++;
    else if (line.prevLineSha256 !== null && !earlier.has(line.prevLineSha256))
      problems.push(`${where}:${i + 1}: the chain is broken: this line follows a line (${line.prevLineSha256.slice(0, 12)}…) that is not earlier in the file; a checkpoint line was deleted or edited`);
    earlier.add(lineSha256(raw));
    const key = identity(line);
    const prior = byIdentity.get(key);
    if (!prior) byIdentity.set(key, line);
    else {
      if (agreement(prior) !== agreement(line)) problems.push(`${where}:${i + 1}: two lines for checkpoint ${line.takenAt} (${line.eventsSha256.slice(0, 12)}…) disagree about more than their time-stamp tokens`);
      if (line.timestamps.length > prior.timestamps.length) byIdentity.set(key, line);
    }
  });
  return { lines: [...byIdentity.values()], problems, unchained };
}

/** The hash a new line must carry as `prevLineSha256`: of the file's last line, null for an empty file. */
export function chainTip(text: string): string | null {
  const last = text.split("\n").filter((l) => l.trim()).at(-1);
  return last === undefined ? null : lineSha256(last);
}

/**
 * The union of two versions of `ledger-checkpoints.jsonl` (the git transport's only conflict
 * resolution, contracts.md §6): every line of `theirs` (the remote) in order, then each line of
 * `ours` that is not already there. Lines are the same only if their whole text is: two copies of one
 * checkpoint with different tokens both stay, and reading keeps the stronger. Unparseable lines are kept verbatim, once.
 */
export function unionCheckpointLines(theirs: string, ours: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...theirs.split("\n"), ...ours.split("\n")]) {
    if (!raw.trim()) continue;
    const key = lineText(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lineText(raw));
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
export function compareWithCheckpoint(cp: CheckpointArtifact, current: readonly LedgerHistoryEvent[], firstVerdicts: readonly VerdictEvent[]): Line[] {
  const at = cp.line.takenAt;
  if (!cp.events) return [`checkpoint ${at}: its event list ${cp.file} is missing or unreadable`];
  if (eventsSha256(cp.events) !== cp.line.eventsSha256) return [`checkpoint ${at}: its event list ${cp.file} does not match the line's eventsSha256`];
  const problems: Line[] = [];
  const d = historyDiff(cp.events, current);
  // Event ids, verdicts and times come from the ledger's history now: shown as identifiers, else as foreign text (S1).
  const ids = (xs: readonly string[]) => joinLines(xs.slice(0, 5).map((x) => ident("an event id the ledger gives", x)), ", ");
  if (d.missing.length || d.changed.length)
    problems.push(said`history rewritten after checkpoint ${at}: ${d.missing.length} event(s) missing${d.missing.length ? said` (${ids(d.missing)})` : ""}, ${d.changed.length} changed${d.changed.length ? said` (${ids(d.changed)})` : ""}`);
  const now = new Map(firstVerdicts.map((v) => [v.changeId, v]));
  for (const f of cp.line.perDrawFirstVerdict) {
    const v = now.get(f.changeId);
    const same = v && v.verdict === f.verdict && (f.eventId === null || v.provenance?.eventId === f.eventId) && v.recordedAt === f.recordedAt;
    if (!same) problems.push(said`checkpoint ${at}: draw #${f.draw} had first verdict ${f.verdict} (${f.recordedAt}); now ${v ? said`${ident("the verdict the ledger gives", v.verdict)} (${isoOrForeign("the time the ledger line gives", v.recordedAt)})` : "none"}`);
  }
  return problems;
}
