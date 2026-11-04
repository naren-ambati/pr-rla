import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCheckpoint, buildCheckpoint, readCheckpoints } from "../src/api/checkpoint.js";
import { createAuditContext } from "../src/api/context.js";
import { compareWithCheckpoint, eventsSha256, historyFileName, parseCheckpointLines, unionCheckpointLines, type LedgerCheckpointLine } from "../src/core/checkpoint.js";
import type { Ledger, LedgerHistoryEvent, VerdictEvent } from "../src/sdk/ledger.js";

/** The pure checkpoint record (contracts.md §5, pr-rla/ledger-checkpoint/v1) and its file I/O. In-memory data: synthetic. */
const ev = (id: string, at: string, action: "add" | "remove" = "add", raw?: unknown): LedgerHistoryEvent => ({ id, at, actor: { login: "alice", kind: "human", id: "11" }, action, label: "pr-rla:pass", draw: 1, ...(raw !== undefined ? { raw } : {}) });
const HIST = [ev("e2", "2026-10-21T03:00:00Z", "remove"), ev("e1", "2026-10-21T02:00:00Z", "add", { html: "ignored" })];
const ledger = (history: LedgerHistoryEvent[]): Ledger => ({ apiVersion: 1, name: "memory", readVerdicts: async () => [], appendVerdict: async () => {}, readHistory: async () => history });
const identity = { name: "memory", source: "path" as const, version: null, integrity: null, optionsSha256: "0".repeat(64), populationOptionsSha256: "0".repeat(64), trust: "full" as const };
const line = (takenAt: string, sha = eventsSha256(HIST)): LedgerCheckpointLine => ({ schema: "pr-rla/ledger-checkpoint/v1", window: "w", ledger: identity, eventsSha256: sha, count: 2, perDrawFirstVerdict: [], takenAt, timestamps: [] });
const first: VerdictEvent = { draw: 1, changeId: "json:a/b#1", verdict: "pass", protocolSha256: "ab".repeat(32), reviewer: "alice", recordedAt: "2026-10-21T02:00:00Z", provenance: { level: "account", source: "scm-label-event", eventId: "e1" } };

describe("the checkpoint record", () => {
  it("hashes the canonical event list: order and raw do not matter, content does", () => {
    expect(eventsSha256(HIST)).toBe(eventsSha256([...HIST].reverse().map(({ raw: _r, ...e }) => e)));
    expect(eventsSha256(HIST)).not.toBe(eventsSha256([HIST[0]!, { ...HIST[1]!, actor: { login: "mallory", kind: "human" } }]));
  });

  it("names the event list without colons and with the hash, so two clones in one second never collide", () => {
    expect(historyFileName("2026-10-21T03:00:00Z", "ab".repeat(32))).toBe("20261021T030000Z-abababababab.json");
  });

  it("reads lines with the same (takenAt, eventsSha256) once, and reports a line that is not a checkpoint", () => {
    const a = JSON.stringify(line("2026-10-21T03:00:00Z"));
    const b = JSON.stringify({ ...line("2026-10-21T03:00:00Z"), timestamps: [{ tsa: "other" }] });
    const r = parseCheckpointLines(`${a}\n${b}\n{"x":1}\nnot json\n${JSON.stringify(line("2026-10-21T04:00:00Z"))}\n`, "f.jsonl");
    expect(r.lines.map((l) => l.takenAt)).toEqual(["2026-10-21T03:00:00Z", "2026-10-21T04:00:00Z"]);
    expect(r.problems).toEqual(["f.jsonl:3: not a pr-rla/ledger-checkpoint/v1 line", "f.jsonl:4: not JSON"]);
  });

  it("unions two versions of the file: the remote's lines, then ours that are new", () => {
    const l1 = JSON.stringify(line("2026-10-21T03:00:00Z"));
    const l2 = JSON.stringify(line("2026-10-21T03:00:01Z"));
    const l3 = JSON.stringify(line("2026-10-21T03:00:02Z"));
    expect(unionCheckpointLines(`${l1}\n${l2}\n`, `${l1}\n${l3}\n`)).toBe(`${l1}\n${l2}\n${l3}\n`);
    expect(unionCheckpointLines("", "")).toBe("");
  });

  it("compares a checkpoint with the history now: vanished and altered events, a changed first verdict, a tampered list", () => {
    const cp = { line: { ...line("2026-10-21T04:00:00Z"), perDrawFirstVerdict: [{ draw: 1, changeId: "json:a/b#1", verdict: "pass" as const, reviewer: "alice", recordedAt: "2026-10-21T02:00:00Z", eventId: "e1" }] }, events: HIST, file: "ledger-history/x.json" };
    expect(compareWithCheckpoint(cp, HIST, [first])).toEqual([]);
    expect(compareWithCheckpoint(cp, [HIST[0]!, ev("e3", "2026-10-21T05:00:00Z")], [first])).toEqual(["history rewritten after checkpoint 2026-10-21T04:00:00Z: 1 event(s) missing (e1), 0 changed"]);
    expect(compareWithCheckpoint(cp, [HIST[0]!, { ...HIST[1]!, at: "2026-10-21T02:30:00Z" }], [first])[0]).toMatch(/0 event\(s\) missing, 1 changed \(e1\)/);
    expect(compareWithCheckpoint(cp, HIST, [])).toEqual(["checkpoint 2026-10-21T04:00:00Z: draw #1 had first verdict pass (2026-10-21T02:00:00Z); now none"]);
    expect(compareWithCheckpoint({ ...cp, events: [HIST[0]!] }, HIST, [first])).toEqual(["checkpoint 2026-10-21T04:00:00Z: its event list ledger-history/x.json does not match the line's eventsSha256"]);
    expect(compareWithCheckpoint({ ...cp, events: null }, HIST, [first])).toEqual(["checkpoint 2026-10-21T04:00:00Z: its event list ledger-history/x.json is missing or unreadable"]);
  });
});

describe("checkpoint files in the audit repo", () => {
  it("appends the event list and the line atomically, and reads them back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-cp-"));
    const ctx = createAuditContext({ mode: "read-write" });
    const { record, events } = await buildCheckpoint(ctx, { ledger: ledger(HIST), identity, window: "w", firstVerdicts: [first], takenAt: "2026-10-21T04:00:00Z" });
    expect(record).toMatchObject({ count: 2, perDrawFirstVerdict: [{ draw: 1, verdict: "pass", eventId: "e1" }], eventsSha256: eventsSha256(HIST) });
    const files = appendCheckpoint(ctx, dir, { ...record, timestamps: [] }, events);
    appendCheckpoint(ctx, dir, { ...record, takenAt: "2026-10-21T05:00:00Z", timestamps: [] }, events);
    expect(readFileSync(files.linesFile, "utf8").trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(readFileSync(files.historyFile, "utf8"))).toMatchObject({ schema: "pr-rla/ledger-history/v1", events: [{ id: "e1" }, { id: "e2" }] });
    const read = readCheckpoints(dir);
    expect(read.problems).toEqual([]);
    expect(read.checkpoints.map((c) => [c.line.takenAt, c.events?.length])).toEqual([["2026-10-21T04:00:00Z", 2], ["2026-10-21T05:00:00Z", 2]]);
    // A deleted event list reads as missing, which check 7 FAILs.
    writeFileSync(files.historyFile, "{");
    expect(readCheckpoints(dir).checkpoints[0]!.events).toBeNull();
  });

  it("refuses in read-only mode (the MCP server's), and refuses a ledger without readHistory", async () => {
    const ro = createAuditContext({ mode: "read-only" });
    await expect(buildCheckpoint(ro, { ledger: ledger(HIST), identity, window: "w", firstVerdicts: [], takenAt: "2026-10-21T04:00:00Z" })).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    expect(() => appendCheckpoint(ro, mkdtempSync(join(tmpdir(), "prrla-cp-")), line("2026-10-21T04:00:00Z"), HIST)).toThrow(/checkpoint writes, and this audit context is read-only/);
    const { readHistory: _r, ...noHistory } = ledger(HIST);
    await expect(buildCheckpoint(createAuditContext({ mode: "read-write" }), { ledger: noHistory, identity, window: "w", firstVerdicts: [], takenAt: "2026-10-21T04:00:00Z" })).rejects.toThrow(/has no readHistory, so it cannot be checkpointed/);
  });
});
