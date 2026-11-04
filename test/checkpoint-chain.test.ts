import { describe, expect, it } from "vitest";
import { chainTip, eventsSha256, lineSha256, parseCheckpointLines, unionCheckpointLines, type LedgerCheckpointLine } from "../src/core/checkpoint.js";
import { checkpointCoverage, indexBindingFindings } from "../src/core/ledger-anchor.js";
import type { DrawsFile } from "../src/core/records.js";
import type { LedgerHistoryEvent } from "../src/sdk/ledger.js";

// Finding 9 and the union item of finding 10: checkpoint lines are chained, the union dedupes on the
// whole line, and a weaker copy of a checkpoint never shadows a stronger one. Synthetic, in memory.
const HIST: LedgerHistoryEvent[] = [{ id: "e1", at: "2026-10-21T02:00:00Z", actor: { login: "alice", kind: "human", id: "11" }, action: "add", label: "pr-rla:pass", draw: 1 }];
const identity = { name: "memory", source: "path" as const, version: null, integrity: null, optionsSha256: "0".repeat(64), populationOptionsSha256: "0".repeat(64), trust: "full" as const };
const tok = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "rfc3161" as const, tsa: `t${i}`, url: "u", tokenDer: "AA", genTime: "2026-10-21T03:00:00Z", accuracySeconds: 1, serial: String(i), nonce: "00" }));
const line = (takenAt: string, o: Partial<LedgerCheckpointLine> = {}): LedgerCheckpointLine => ({ schema: "pr-rla/ledger-checkpoint/v1", window: "w", ledger: identity, eventsSha256: eventsSha256(HIST), count: 1, perDrawFirstVerdict: [], takenAt, timestamps: [], ...o });
const text = (...ls: LedgerCheckpointLine[]) => `${ls.map((l) => JSON.stringify(l)).join("\n")}\n`;
const chained = (...times: string[]) => {
  const out: string[] = [];
  for (const t of times) out.push(JSON.stringify(line(t, { prevLineSha256: out.length ? lineSha256(out.at(-1)!) : null, timestamps: tok(2) })));
  return out;
};

describe("the checkpoint chain", () => {
  it("accepts a chain, names the tip, and tolerates a CRLF checkout", () => {
    const c = chained("2026-10-21T03:00:00Z", "2026-10-21T04:00:00Z", "2026-10-21T05:00:00Z");
    const r = parseCheckpointLines(`${c.join("\n")}\n`, "f");
    expect(r.problems).toEqual([]);
    expect(r.unchained).toBe(0);
    expect(chainTip(`${c.join("\n")}\n`)).toBe(lineSha256(c[2]!));
    expect(parseCheckpointLines(`${c.join("\r\n")}\r\n`, "f").problems).toEqual([]);
    expect(chainTip("")).toBeNull();
  });

  it("reports the line after a deleted or edited one", () => {
    const c = chained("2026-10-21T03:00:00Z", "2026-10-21T04:00:00Z", "2026-10-21T05:00:00Z");
    expect(parseCheckpointLines(`${[c[0], c[2]].join("\n")}\n`, "f").problems).toEqual([expect.stringMatching(/^f:2: the chain is broken/)]);
    expect(parseCheckpointLines(`${[c[1], c[2]].join("\n")}\n`, "f").problems).toEqual([expect.stringMatching(/^f:1: the chain is broken/)]);
    const edited = JSON.stringify({ ...JSON.parse(c[1]!), count: 9 });
    expect(parseCheckpointLines(`${[c[0], edited, c[2]].join("\n")}\n`, "f").problems).toEqual([expect.stringMatching(/^f:3: the chain is broken/)]);
  });

  it("lines without the field are legacy: read, counted, never a break; a malformed link is a problem", () => {
    const r = parseCheckpointLines(text(line("2026-10-21T03:00:00Z"), line("2026-10-21T04:00:00Z")), "f");
    expect(r.problems).toEqual([]);
    expect(r.unchained).toBe(2);
    expect(parseCheckpointLines(text(line("2026-10-21T03:00:00Z", { prevLineSha256: "nope" })), "f").problems).toEqual(["f:1: prevLineSha256 is neither null nor 64 hex characters"]);
  });

  it("two clones' lines joined by the union each link to a line that is earlier in the file", () => {
    const base = chained("2026-10-21T03:00:00Z");
    const a = JSON.stringify(line("2026-10-21T04:00:00Z", { prevLineSha256: lineSha256(base[0]!), timestamps: tok(2) }));
    const b = JSON.stringify(line("2026-10-21T04:00:05Z", { prevLineSha256: lineSha256(base[0]!), timestamps: tok(2) }));
    const merged = unionCheckpointLines(`${base[0]}\n${a}\n`, `${base[0]}\n${b}\n`);
    expect(merged).toBe(`${base[0]}\n${a}\n${b}\n`);
    const r = parseCheckpointLines(merged, "f");
    expect(r.problems).toEqual([]);
    expect(r.lines).toHaveLength(3);
  });
});

describe("a weaker copy of a checkpoint cannot shadow a stronger one (finding 10)", () => {
  const strong = JSON.stringify(line("2026-10-21T03:00:00Z", { timestamps: tok(3) }));
  const weak = JSON.stringify(line("2026-10-21T03:00:00Z", { timestamps: tok(1) }));

  it("the union keeps both lines, whichever side is the remote", () => {
    expect(unionCheckpointLines(`${weak}\n`, `${strong}\n`)).toBe(`${weak}\n${strong}\n`);
    expect(unionCheckpointLines(`${strong}\n`, `${weak}\n`)).toBe(`${strong}\n${weak}\n`);
    expect(unionCheckpointLines(`${strong}\n`, `${strong}\n`)).toBe(`${strong}\n`);
  });

  it("reading keeps the copy with the most tokens, in either order", () => {
    for (const t of [`${weak}\n${strong}\n`, `${strong}\n${weak}\n`]) {
      const r = parseCheckpointLines(t, "f");
      expect(r.problems).toEqual([]);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]!.timestamps).toHaveLength(3);
    }
  });

  it("two lines of one checkpoint that disagree about anything but tokens are a problem", () => {
    const liar = JSON.stringify(line("2026-10-21T03:00:00Z", { count: 99, timestamps: tok(1) }));
    expect(parseCheckpointLines(`${strong}\n${liar}\n`, "f").problems).toEqual([expect.stringMatching(/^f:2: two lines for checkpoint 2026-10-21T03:00:00Z .* disagree/)]);
  });
});

describe("checkpoint coverage and the index binding, as pure functions", () => {
  const cp = (takenAt: string, n: number, extra: Partial<LedgerCheckpointLine> = {}) => ({ line: line(takenAt, { timestamps: tok(n), ...extra }), events: HIST, file: "x" });
  const opts = { checkpointable: true, lastCountedAt: "2026-10-21T02:00:00Z", ledgerIndexSha256: null, unchained: 0 };

  it("needs a time-stamped checkpoint at or after the last counted verdict, only for a checkpointable ledger with a counted verdict", () => {
    expect(checkpointCoverage([], opts).warns).toEqual([expect.stringMatching(/there is none/)]);
    expect(checkpointCoverage([cp("2026-10-21T01:00:00Z", 2)], opts).warns).toEqual([expect.stringMatching(/the latest checkpoint is 2026-10-21T01:00:00Z/)]);
    expect(checkpointCoverage([cp("2026-10-21T02:00:00Z", 2)], opts).warns).toEqual([]);
    expect(checkpointCoverage([cp("2026-10-21T05:00:00Z", 0)], opts).warns).toEqual([expect.stringMatching(/carries no time-stamp tokens/), expect.stringMatching(/no time-stamped ledger checkpoint post-dates/)]);
    expect(checkpointCoverage([], { ...opts, checkpointable: false }).warns).toEqual([]);
    expect(checkpointCoverage([], { ...opts, lastCountedAt: null }).warns).toEqual([]);
  });

  const draws = { draws: [{ draw: 1, index: 0, changeId: "a", url: "u", mergeSha: "s", firstOccurrence: true }, { draw: 2, index: 1, changeId: "a", url: "u", mergeSha: "s", firstOccurrence: false }, { draw: 3, index: 2, changeId: "b", url: "u", mergeSha: "t", firstOccurrence: true }], issued: 3, ledgerIndexSha256: "h".repeat(64) } as unknown as DrawsFile;
  const issue = (draw: number, changeId: string) => ({ draw, changeId, number: draw, id: `i${draw}`, url: "u", createdAt: "t" });
  const doc = (value: unknown, sha256 = "h".repeat(64)) => ({ sha256, value });

  it("binds the index to the draws: hash, mapping, missing issues, repeats", () => {
    const ok = doc({ issues: [issue(1, "a"), issue(3, "b")], repeats: [{ draw: 2, changeId: "a", sameAs: 1 }] });
    expect(indexBindingFindings(draws, ok)).toEqual({ fails: [], warns: [], notes: [] });
    expect(indexBindingFindings(draws, doc(ok.value, "x".repeat(64))).fails[0]).toMatch(/is not the index draws\.json bound at sample time/);
    expect(indexBindingFindings(draws, null).fails[0]).toMatch(/is missing/);
    expect(indexBindingFindings({ ...draws, ledgerIndexSha256: undefined } as DrawsFile, ok).warns[0]).toMatch(/does not record the ledger index's hash/);
    expect(indexBindingFindings(draws, doc({ issues: [issue(1, "a"), issue(3, "z")], repeats: [{ draw: 2, changeId: "a", sameAs: 1 }] })).fails[0]).toMatch(/draw #3 is z, but draws\.json draws b there/);
    expect(indexBindingFindings(draws, doc({ issues: [issue(1, "a")], repeats: [{ draw: 2, changeId: "a", sameAs: 1 }] })).fails).toEqual([expect.stringMatching(/draw #3 \(b\) has no issue/)]);
    expect(indexBindingFindings(draws, doc({ issues: [issue(1, "a"), issue(3, "b")], repeats: [] })).fails).toEqual([expect.stringMatching(/draw #2 \(a\) repeats draw #1 but the index does not say so/)]);
    expect(indexBindingFindings(draws, { sha256: "h".repeat(64), value: null, error: "ledger-index.json is not valid JSON: x" }).fails).toEqual(["ledger-index.json is not valid JSON: x"]);
    // P1: foreignIssues is a test-only ledger option now; an audit index that carries it FAILs (it was a WARN).
    expect(indexBindingFindings(draws, doc({ issues: [issue(1, "a"), issue(3, "b")], repeats: [{ draw: 2, changeId: "a", sameAs: 1 }], foreignIssues: true })).fails).toEqual([expect.stringMatching(/^the ledger index carries foreignIssues, which turns off the issues' body-marker check/)]);
  });

  it("an external ledger's index without an issues list gets the hash check only", () => {
    expect(indexBindingFindings(draws, doc({ custom: true })).fails).toEqual([]);
    expect(indexBindingFindings(draws, doc({ custom: true }, "y".repeat(64))).fails).toHaveLength(1);
  });
});
