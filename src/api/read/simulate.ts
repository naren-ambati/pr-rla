import { simulate as runSimulation, type SimulationResult } from "../../core/simulate.js";
import { effectiveCap } from "../../core/sprt.js";

/** `simulate` (FR3.1): the scoring code against an oracle population. Pure: no files, no network. */
export interface SimulateInput {
  population: number;
  defects: number;
  /** Simulated audits (default 20,000). */
  runs?: number;
  /** PRNG seed (default 1). */
  seed?: number;
  /** Tolerance (default 0.1). */
  p0?: number;
  /** Planning alternative (default p0/5). */
  p1?: number;
  /** Risk limit (default 0.05). */
  alpha?: number;
  /** Draw cap (default 4x the zero-failure stop). */
  cap?: number | null;
}

/** The `simulate --json` object (contracts.md §7). */
export interface SimulateReport extends SimulationResult {
  population: number;
  defects: number;
  seed: number;
  params: { p0: number; p1: number; alpha: number; cap: number };
}

export function simulate(input: SimulateInput): SimulateReport {
  const p0 = input.p0 ?? 0.1;
  const params = { p0, p1: input.p1 ?? p0 / 5, alpha: input.alpha ?? 0.05, cap: input.cap ?? null };
  const seed = input.seed ?? 1;
  const r = runSimulation({ population: input.population, defects: input.defects, runs: input.runs ?? 20_000, seed, params });
  return { population: input.population, defects: input.defects, params: { ...params, cap: effectiveCap(params) }, ...r, seed };
}
