import { Simulation, simulate as runSimulation, simulationWork, type SimulationResult } from "../../core/simulate.js";
import { effectiveCap } from "../../core/sprt.js";
import { AuditError } from "../errors.js";

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

/**
 * The most draws one read-only `simulate` call may make in the worst case (`runs` × the cap), derived
 * from a measurement rather than picked (BUILD-NOTES, "U5 fix round", 2026-11-04):
 * - the slowest worst-case rate measured on this machine (Apple M5) was 2.8 million draws a second
 *   (Node 22.23.2, 24.20.0 and 26.8.2; both of the simulation's representations; a population of
 *   10,000,000, the most the MCP tool accepts; other work running);
 * - the MCP server hands a call off as a job at 25 s, so one call does 2.8e6 × 25 = 70 million draws
 *   in that window;
 * - divided by 8: the at most 4 long calls the server runs share its one thread (4×), and 2× for a
 *   slower machine, garbage collection and the measurement's own spread (2–3× between runs).
 * At 8,750,000 draws a lone call ends in about 3 s here, and four at once inside the 25 s.
 */
export const SIMULATE_MEASURED_DRAWS_PER_SECOND = 2_800_000;
export const SIMULATE_HANDOFF_SECONDS = 25;
export const SIMULATE_SAFETY_FACTOR = 8;
export const SIMULATE_MAX_DRAWS = (SIMULATE_MEASURED_DRAWS_PER_SECOND * SIMULATE_HANDOFF_SECONDS) / SIMULATE_SAFETY_FACTOR;
/** Draws per slice of an asynchronous simulation: about 20 ms at the slowest measured rate, so other calls are never held up longer. */
const SLICE_DRAWS = 50_000;

function prepare(input: SimulateInput) {
  const p0 = input.p0 ?? 0.1;
  const params = { p0, p1: input.p1 ?? p0 / 5, alpha: input.alpha ?? 0.05, cap: input.cap ?? null };
  const seed = input.seed ?? 1;
  const runs = input.runs ?? 20_000;
  const sim = { population: input.population, defects: input.defects, runs, seed, params };
  return { params, seed, runs, sim };
}

const report = (input: SimulateInput, p: ReturnType<typeof prepare>, r: SimulationResult): SimulateReport => ({ population: input.population, defects: input.defects, params: { ...p.params, cap: effectiveCap(p.params) }, ...r, seed: p.seed });

/** The CLI's `simulate`: runs in full, synchronously (a person's own command, with no tool budget). */
export function simulate(input: SimulateInput): SimulateReport {
  const p = prepare(input);
  return report(input, p, runSimulation(p.sim));
}

/**
 * `simulate` for read-only callers (the MCP tool): refuses an input whose worst case exceeds
 * SIMULATE_MAX_DRAWS before it starts (TOO_MUCH_WORK), runs in slices that yield to the event loop,
 * stops when `signal` aborts, and reports progress by runs.
 */
export async function simulateBounded(input: SimulateInput, o: { signal?: AbortSignal; onProgress?: (p: { done: number; total?: number; message: string }) => void; maxDraws?: number } = {}): Promise<SimulateReport> {
  const p = prepare(input);
  let work: number;
  try {
    work = simulationWork(p.params, p.runs);
  } catch (e) {
    throw new AuditError(`simulate: ${(e as Error).message}`);
  }
  const max = o.maxDraws ?? SIMULATE_MAX_DRAWS;
  if (!(work <= max))
    throw new AuditError(
      `simulate: ${p.runs.toLocaleString("en-US")} runs × a cap of ${effectiveCap(p.params).toLocaleString("en-US")} draws is ${work.toLocaleString("en-US")} draws in the worst case, over the ${max.toLocaleString("en-US")} one read-only call may make`,
      1,
      "TOO_MUCH_WORK",
      `lower runs (at most ${Math.max(1, Math.floor(max / effectiveCap(p.params))).toLocaleString("en-US")} at this cap), or run "pr-rla simulate" from the CLI`,
    );
  const s = new Simulation(p.sim);
  let last = 0;
  for (;;) {
    o.signal?.throwIfAborted();
    if (s.step(SLICE_DRAWS)) break;
    const t = Date.now();
    if (o.onProgress && t - last >= 250) {
      last = t;
      o.onProgress({ done: s.runsDone, total: p.runs, message: `${s.runsDone.toLocaleString("en-US")} of ${p.runs.toLocaleString("en-US")} simulated audits` });
    }
    await new Promise<void>((r) => setImmediate(r));
  }
  return report(input, p, s.result());
}
