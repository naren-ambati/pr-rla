import { describe, expect, it } from "vitest";
import { simulate } from "../src/core/simulate.js";

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
