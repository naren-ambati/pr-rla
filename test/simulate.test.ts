import { describe, expect, it } from "vitest";
import { SIMULATE_HANDOFF_SECONDS, SIMULATE_MAX_DRAWS, SIMULATE_MEASURED_DRAWS_PER_SECOND, SIMULATE_SAFETY_FACTOR, simulateBounded } from "../src/api/read/simulate.js";
import { Simulation, makeRng, simulate, simulationWork } from "../src/core/simulate.js";
import { effectiveCap, evaluateSequence } from "../src/core/sprt.js";

const D = { p0: 0.1, p1: 0.02, alpha: 0.05 };

describe("simulation (spec table, claim D column, N = 400, 20,000 audits per row)", () => {
  it("at exactly the tolerance (10%): false-certify rate <= alpha", () => {
    const r = simulate({ population: 400, defects: 40, runs: 20_000, seed: 1, params: D });
    // Spec: 4.53%. Ville's inequality bounds it by 5%.
    expect(r.certifiedRate).toBeLessThanOrEqual(0.05);
    expect(r.certifiedRate).toBeGreaterThan(0.035);
  });

  it("at the tolerance, across seeds and population sizes, stays <= alpha", () => {
    for (const [N, K, seed] of [[400, 40, 2], [1590, 159, 3], [1000, 100, 4]] as const) {
      const r = simulate({ population: N, defects: K, runs: 20_000, seed, params: D });
      expect(r.certifiedRate).toBeLessThanOrEqual(0.05);
    }
  });

  it("above the tolerance (15%) certifies far less than alpha", () => {
    const r = simulate({ population: 400, defects: 60, runs: 20_000, seed: 5, params: D });
    expect(r.certifiedRate).toBeLessThan(0.01);
  });

  it("1%: ~99.86% certified, ~42 distinct reviews", () => {
    const r = simulate({ population: 400, defects: 4, runs: 20_000, seed: 6, params: D });
    expect(r.certifiedRate).toBeGreaterThan(0.995);
    expect(r.meanDistinctReviews).toBeGreaterThan(38);
    expect(r.meanDistinctReviews).toBeLessThan(46);
  });

  it("2%: ~96.5% certified, ~51 distinct", () => {
    const r = simulate({ population: 400, defects: 8, runs: 20_000, seed: 7, params: D });
    expect(r.certifiedRate).toBeGreaterThan(0.95);
    expect(r.certifiedRate).toBeLessThan(0.98);
    expect(r.meanDistinctReviews).toBeGreaterThan(46);
    expect(r.meanDistinctReviews).toBeLessThan(56);
  });

  it("5%: ~48% certified", () => {
    const r = simulate({ population: 400, defects: 20, runs: 20_000, seed: 8, params: D });
    expect(r.certifiedRate).toBeGreaterThan(0.44);
    expect(r.certifiedRate).toBeLessThan(0.53);
  });

  it("is deterministic for a seed", () => {
    const a = simulate({ population: 400, defects: 40, runs: 2_000, seed: 42, params: D });
    expect(simulate({ population: 400, defects: 40, runs: 2_000, seed: 42, params: D })).toEqual(a);
  });
});

describe("each run stops at the SPRT's decision (U5 fix round, H1)", () => {
  /** The old algorithm, for one run: draw the whole cap, then evaluate the sequence. */
  function fullRun(N: number, K: number, seed: number, params: typeof D & { cap?: number | null }) {
    const rng = makeRng(seed);
    const cap = effectiveCap(params);
    const verdictOf = new Map<number, "pass" | "fail">();
    const seq: ("pass" | "fail")[] = [];
    const order: number[] = [];
    for (let k = 0; k < cap; k++) {
      const idx = Math.floor(rng() * N);
      order.push(idx);
      let v = verdictOf.get(idx);
      if (!v) {
        v = idx < K && rng() < 1 ? "fail" : "pass";
        verdictOf.set(idx, v);
      }
      seq.push(v);
    }
    const r = evaluateSequence(seq, params);
    return { certified: r.state === "CERTIFIED", draws: r.draws, distinct: new Set(order.slice(0, r.draws)).size };
  }

  it("a run decides exactly as evaluateSequence does on the same draws (one run per seed, both representations)", () => {
    for (const [N, K, p] of [[400, 40, D], [400, 4, D], [10_000_000, 900_000, D], [1000, 30, { p0: 0.05, p1: 0.01, alpha: 0.05 }], [50, 5, { ...D, cap: 20 }]] as const)
      for (let seed = 1; seed <= 40; seed++) {
        const r = simulate({ population: N, defects: K, runs: 1, seed, params: p });
        const f = fullRun(N, K, seed, p);
        expect([r.certified === 1, r.meanDraws, r.meanDistinctReviews]).toEqual([f.certified, f.draws, f.distinct]);
      }
  });

  it("makes no array of the cap's length: p0 1e-6 (a cap of 13,314,360) with one run uses the population's memory, not the cap's", () => {
    const params = { p0: 1e-6, p1: 2e-7, alpha: 0.05 };
    expect(effectiveCap(params)).toBeGreaterThan(13_000_000);
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    // Every draw passes (no defects), so the run certifies at the zero-failure stop, a quarter of the cap.
    const r = simulate({ population: 1000, defects: 0, runs: 1, seed: 1, params });
    expect(r.certified).toBe(1);
    expect(r.meanDraws).toBe(effectiveCap(params) / 4);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
    expect(performance.now() - t0).toBeLessThan(20_000);
  });

  it("counts the worst case as runs × cap", () => {
    expect(simulationWork(D, 20_000)).toBe(20_000 * 144);
    expect(simulationWork({ ...D, cap: 10 }, 3)).toBe(30);
  });

  it("steps in slices: a stepped simulation equals a whole one", () => {
    const whole = simulate({ population: 400, defects: 20, runs: 300, seed: 9, params: D });
    const s = new Simulation({ population: 400, defects: 20, runs: 300, seed: 9, params: D });
    let steps = 0;
    while (!s.step(97)) steps++;
    expect(steps).toBeGreaterThan(10);
    expect(s.result()).toEqual(whole);
  });
});

describe("simulate for read-only callers: a measured budget, slices, cancellation (H1)", () => {
  it("the budget is the measurement's: 2.8 million draws a second × the 25 s hand-off ÷ 8 (4 calls on one thread, 2× headroom)", () => {
    expect(SIMULATE_MAX_DRAWS).toBe((SIMULATE_MEASURED_DRAWS_PER_SECOND * SIMULATE_HANDOFF_SECONDS) / SIMULATE_SAFETY_FACTOR);
    expect(SIMULATE_MAX_DRAWS).toBe(8_750_000);
  });

  it("refuses an input over the budget before it starts (TOO_MUCH_WORK), with the most runs that would fit", async () => {
    // The review's inputs: p0 1e-6 (cap 13,314,360) and p0 1e-9 (cap 13,314,364,568, an OOM before the fix).
    for (const p of [{ p0: 1e-6, p1: 1e-7 }, { p0: 1e-9, p1: 1e-10 }]) {
      const t0 = performance.now();
      await expect(simulateBounded({ population: 100, defects: 0, runs: 1, ...p })).rejects.toMatchObject({ code: "TOO_MUCH_WORK", next: expect.stringMatching(/lower runs|CLI/) });
      // Refused from the inputs alone: no run is made (the work would take 12 s, or run out of memory).
      expect(performance.now() - t0).toBeLessThan(1000);
    }
    await expect(simulateBounded({ population: 100, defects: 0, runs: 20_000, p0: 0.01 })).rejects.toMatchObject({ code: "TOO_MUCH_WORK", next: expect.stringMatching(/at most 5,864 at this cap/) });
    await expect(simulateBounded({ population: 100, defects: 0, runs: 5864, p0: 0.01 })).resolves.toMatchObject({ runs: 5864 });
  });

  it("a call at the budget's worst case ends well inside the 25 s hand-off here", async () => {
    // Defects just under p0 at N = 10,000,000 (the tool's largest): runs wander towards the cap.
    const runs = Math.floor(SIMULATE_MAX_DRAWS / 144);
    const t0 = performance.now();
    const r = await simulateBounded({ population: 10_000_000, defects: 900_000, runs });
    const ms = performance.now() - t0;
    expect(r.runs).toBe(runs);
    expect(ms).toBeLessThan(12_500);
  }, 30_000);

  it("yields between slices, so other work runs while it does, and stops when its signal aborts", async () => {
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(performance.now()), 1);
    const ac = new AbortController();
    const p = simulateBounded({ population: 10_000_000, defects: 900_000, runs: 60_000 }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 400));
    ac.abort(new Error("stopped"));
    await expect(p).rejects.toThrow("stopped");
    clearInterval(timer);
    // A timer kept firing while it ran: no slice held the event loop for long.
    expect(ticks.length).toBeGreaterThan(5);
    const gaps = ticks.slice(1).map((t, k) => t - ticks[k]!);
    expect(Math.max(...gaps)).toBeLessThan(200);
  });

  it("reports progress by runs", async () => {
    const seen: { done: number; total?: number }[] = [];
    await simulateBounded({ population: 10_000_000, defects: 900_000, runs: 40_000 }, { onProgress: (p) => seen.push(p) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.total === 40_000 && p.done <= 40_000)).toBe(true);
  });
});
