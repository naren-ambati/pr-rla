import { describe, expect, it } from "vitest";
import { effectiveCap, evaluateSequence, scores, stoppingTable, zeroFailureStop } from "../src/core/sprt.js";

const D = { p0: 0.1, p1: 0.02, alpha: 0.05 };

describe("claim D stopping rule (spec table)", () => {
  it("scores: pass +0.0852, fail -1.609, target 2.996", () => {
    const s = scores(D);
    expect(s.pass).toBeCloseTo(0.0852, 4);
    expect(s.fail).toBeCloseTo(-1.609, 3);
    expect(s.target).toBeCloseTo(2.996, 3);
  });

  it("p0=10%, p1=2%, alpha=5% certifies after 36 / 56 / 75 draws with 0 / 1 / 2 failures", () => {
    expect(stoppingTable(D).map((r) => r.draws)).toEqual([36, 56, 75]);
  });

  it("p0=5%, p1=1%, alpha=5% certifies after 73 / 113 / 153", () => {
    expect(stoppingTable({ p0: 0.05, p1: 0.01, alpha: 0.05 }).map((r) => r.draws)).toEqual([73, 113, 153]);
  });

  it("cap is 4x the zero-failure stopping point", () => {
    expect(zeroFailureStop(D)).toBe(36);
    expect(effectiveCap(D)).toBe(144);
    expect(effectiveCap({ ...D, cap: 60 })).toBe(60);
  });

  it("36 passes certify at LLR 3.066; 35 do not", () => {
    const r36 = evaluateSequence(Array(36).fill("pass"), D);
    expect(r36.state).toBe("CERTIFIED");
    expect(r36.llr).toBeCloseTo(3.066, 3);
    const r35 = evaluateSequence(Array(35).fill("pass"), D);
    expect(r35.state).toBe("CONTINUE");
    expect(r35.morePassesNeeded).toBe(1);
  });

  it("one failure in 36 draws: 20 more passing draws needed (56 total)", () => {
    const seq = [...Array(20).fill("pass"), "fail", ...Array(15).fill("pass")] as ("pass" | "fail")[];
    const r = evaluateSequence(seq, D);
    expect(r.state).toBe("CONTINUE");
    expect(r.morePassesNeeded).toBe(20);
    expect(r.draws + (r.morePassesNeeded ?? 0)).toBe(56);
  });

  it("a failure anywhere before draw 36 moves the stop to 56", () => {
    for (const at of [0, 17, 35]) {
      const seq = Array.from({ length: 80 }, (_, i) => (i === at ? "fail" : "pass")) as ("pass" | "fail")[];
      expect(evaluateSequence(seq, D)).toMatchObject({ state: "CERTIFIED", draws: 56, fails: 1 });
    }
  });

  it("stops at the first crossing: a failure after draw 36 is never reached", () => {
    const seq = [...Array(55).fill("pass"), "fail"] as ("pass" | "fail")[];
    expect(evaluateSequence(seq, D)).toMatchObject({ state: "CERTIFIED", draws: 36, fails: 0 });
  });

  it("escalates once the target is out of reach within the cap", () => {
    // With cap 144, after f fails the best case is (144-f)*0.0852 - 1.609f: 5 fails can still certify, 6 cannot.
    expect(evaluateSequence(Array(5).fill("fail"), D).state).toBe("CONTINUE");
    const r = evaluateSequence(Array(6).fill("fail"), D);
    expect(r.state).toBe("ESCALATE");
    expect(r.escalateReason).toBe("target-unreachable");
  });

  it("escalates at the cap", () => {
    const seq = Array.from({ length: 200 }, (_, i) => (i % 15 === 7 ? "fail" : "pass")) as ("pass" | "fail")[];
    const r = evaluateSequence(seq, { ...D, cap: 60 });
    expect(r.state).toBe("ESCALATE");
    expect(r.draws).toBeLessThanOrEqual(60);
  });

  it("rejects invalid parameters", () => {
    expect(() => scores({ p0: 0.02, p1: 0.1, alpha: 0.05 })).toThrow(/below p0/);
    expect(() => scores({ p0: 0.1, p1: 0.02, alpha: 1.5 })).toThrow();
  });
});
