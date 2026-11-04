import { describe, expect, it } from "vitest";
import { analyzeDrawHistory, canonicalHistory, compareByTimeThenId, compareEventIds, type LedgerHistoryEvent, type VerdictLabelEvent } from "../src/sdk/ledger.js";

// Finding 6 of the master review: "the first eligible event counts" broke same-second ties by
// lexical id order, so id "100" came before "99". Numeric ids compare as BigInt.
const at = "2026-01-01T00:00:00Z";
const add = (id: string, verdict: "pass" | "fail"): VerdictLabelEvent => ({ id, at, action: "add", verdict, reviewer: "alice", provenance: { level: "account", source: "x", actorId: "1" } });
const labelOf = (v: string) => v;

describe("event id order (finding 6)", () => {
  it("counts the lower numeric id of two same-second adds (the reproduction: pass 100, fail 99)", () => {
    const a = analyzeDrawHistory(1, [add("100", "pass"), add("99", "fail")], { reviewers: null, labelOf });
    expect(a.counted?.verdict).toBe("fail");
    expect(analyzeDrawHistory(1, [add("99", "fail"), add("100", "pass")], { reviewers: null, labelOf }).counted?.verdict).toBe("fail");
  });

  it("compares ids past 2^53 exactly, and a longer number is a larger one", () => {
    expect(compareEventIds("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareEventIds("9007199254740992", "9007199254740993")).toBe(-1);
    expect(compareEventIds("99", "100")).toBe(-1);
    expect(compareEventIds("5", "5")).toBe(0);
  });

  it("compares colon-separated ids part by part (Jira's <history id>:<item>:<action>), so history 99 comes before history 100", () => {
    expect(compareEventIds("99:0:add", "100:0:add")).toBe(-1);
    expect(compareEventIds("100:0:remove", "100:0:add")).toBe(1); // 'remove' > 'add' by code unit: same history, same item
    expect(compareEventIds("100:1:add", "100:0:remove")).toBe(1);
    expect(compareEventIds("100:0", "100:0:add")).toBe(-1);
    expect(compareEventIds("9", "10:0:add")).toBe(-1);
  });

  it("is a total order: numbers first, then other ids by code unit; equal numbers written differently still differ", () => {
    const ids = ["b:1", "10", "9", "a:2", "007", "7", "10001:0:add", "999:0:add", "10001:0", "", "x"];
    const sorted = [...ids].sort(compareEventIds);
    expect(sorted).toEqual(["007", "7", "9", "10", "999:0:add", "10001:0", "10001:0:add", "", "a:2", "b:1", "x"]);
    for (const x of ids) for (const y of ids) for (const z of ids) if (compareEventIds(x, y) <= 0 && compareEventIds(y, z) <= 0) expect(compareEventIds(x, z)).toBeLessThanOrEqual(0);
    for (const x of ids) for (const y of ids) expect(Math.sign(compareEventIds(x, y)) + Math.sign(compareEventIds(y, x))).toBe(0);
  });

  it("orders by time first, then id", () => {
    expect(compareByTimeThenId({ at: "2026-01-01T00:00:00Z", id: "9" }, { at: "2026-01-01T00:00:01Z", id: "10" })).toBe(-1);
    expect(compareByTimeThenId({ at, id: "9" }, { at, id: "10" })).toBe(-1);
  });

  it("canonicalHistory (what a checkpoint hashes) uses the same order", () => {
    const ev = (id: string): LedgerHistoryEvent => ({ id, at, actor: { login: "a", kind: "human" }, action: "add", label: "pass", draw: 1 });
    expect(canonicalHistory([ev("100"), ev("99"), ev("1000")]).map((e) => e.id)).toEqual(["99", "100", "1000"]);
  });
});
