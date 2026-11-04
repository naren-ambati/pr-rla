import { scores, effectiveCap, type SprtParams } from "./sprt.js";

/** sfc32 seeded through splitmix32: small, fast, deterministic. Not cryptographic (simulation only). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  const splitmix = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = splitmix(), b = splitmix(), c = splitmix(), d = splitmix();
  return () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
}

export interface SimulationInput {
  population: number;
  defects: number;
  runs: number;
  seed: number;
  params: SprtParams;
  /** Chance a deep review flags a defective change (claim D's oracle uses 1.0). Fixed per change, so duplicates reuse the verdict. */
  recall?: number;
}

export interface SimulationResult {
  runs: number;
  certified: number;
  escalated: number;
  certifiedRate: number;
  meanDraws: number;
  meanDistinctReviews: number;
  meanDistinctReviewsWhenCertified: number;
}

/**
 * The most draws a simulation can make: every run may go on to the cap (`runs` × the effective
 * cap). Each draw is O(1) work, so this bounds the time a call can take (src/api/read/simulate.ts
 * refuses inputs above its measured budget).
 */
export function simulationWork(params: SprtParams, runs: number): number {
  scores(params);
  return runs * effectiveCap(params);
}

/**
 * How a run remembers the changes it drew: one typed array over the population (4 bytes a change,
 * reused across runs) when the population is at most 128 times the cap and at most 2^24; otherwise a
 * Map, which never holds more than the cap's number of entries.
 */
const DENSE_MAX = 1 << 24;
const DENSE_PER_CAP = 128;

/**
 * The simulation, one draw at a time so a caller can run it in slices (`step`). Each run stops at
 * the SPRT's decision (the same rule as `evaluateSequence`: CERTIFIED when the LLR reaches the
 * target, ESCALATE at the cap or once the target is out of reach), and keeps only the verdicts of
 * the changes drawn so far: no per-run arrays of the cap's length.
 */
export class Simulation {
  private readonly N: number;
  private readonly K: number;
  private readonly runs: number;
  private readonly recall: number;
  private readonly rng: () => number;
  private readonly pass: number;
  private readonly fail: number;
  private readonly target: number;
  private readonly cap: number;
  /** Dense marks: (run tag << 1) | fail, for the current run; or, for a large population, a Map per run. */
  private readonly dense: Uint32Array | null;
  private sparse = new Map<number, boolean>();
  private tag = 0;
  private run = 0;
  // The current run's state.
  private n = 0;
  private llr = 0;
  private distinct = 0;
  private started = false;
  // Totals.
  private certified = 0;
  private sumDraws = 0;
  private sumDistinct = 0;
  private sumDistinctCert = 0;

  constructor(input: SimulationInput) {
    const { population: N, defects: K, runs } = input;
    if (!Number.isInteger(N) || N < 1) throw new Error("population must be a positive integer");
    if (!Number.isInteger(K) || K < 0 || K > N) throw new Error("defects must be an integer in [0, population]");
    if (!Number.isInteger(runs) || runs < 1) throw new Error("runs must be a positive integer");
    const s = scores(input.params);
    this.N = N;
    this.K = K;
    this.runs = runs;
    this.recall = input.recall ?? 1;
    this.rng = makeRng(input.seed);
    this.pass = s.pass;
    this.fail = s.fail;
    this.target = s.target;
    this.cap = effectiveCap(input.params);
    this.dense = N <= DENSE_MAX && N <= DENSE_PER_CAP * this.cap ? new Uint32Array(N) : null;
  }

  get done(): boolean {
    return this.run >= this.runs;
  }

  /** Runs finished so far. */
  get runsDone(): number {
    return this.run;
  }

  private beginRun(): void {
    this.n = 0;
    this.llr = 0;
    this.distinct = 0;
    this.started = true;
    if (this.dense) {
      if (this.tag >= 0x7fffffff) {
        this.dense.fill(0);
        this.tag = 0;
      }
      this.tag++;
    } else this.sparse = new Map();
  }

  private endRun(certified: boolean): void {
    this.sumDraws += this.n;
    this.sumDistinct += this.distinct;
    if (certified) {
      this.certified++;
      this.sumDistinctCert += this.distinct;
    }
    this.run++;
    this.started = false;
  }

  /** The verdict of drawn change `idx` in this run: its first draw decides it, later draws reuse it. */
  private verdict(idx: number): boolean {
    const d = this.dense;
    if (d) {
      const m = d[idx]!;
      if (m >>> 1 === this.tag) return (m & 1) === 1;
      const fail = idx < this.K && this.rng() < this.recall;
      d[idx] = (this.tag << 1) | (fail ? 1 : 0);
      this.distinct++;
      return fail;
    }
    const v = this.sparse.get(idx);
    if (v !== undefined) return v;
    const fail = idx < this.K && this.rng() < this.recall;
    this.sparse.set(idx, fail);
    this.distinct++;
    return fail;
  }

  /** Makes at most `maxDraws` more draws (finishing runs as they decide); true once every run is done. */
  step(maxDraws: number): boolean {
    let budget = maxDraws;
    while (this.run < this.runs) {
      if (!this.started) {
        this.beginRun();
        // The target out of reach before the first draw (a cap below the zero-failure stop): ESCALATE at 0 draws.
        if (this.cap * this.pass < this.target) {
          this.endRun(false);
          continue;
        }
      }
      while (budget > 0) {
        budget--;
        const idx = Math.floor(this.rng() * this.N);
        this.n++;
        this.llr += this.verdict(idx) ? this.fail : this.pass;
        if (this.llr >= this.target) {
          this.endRun(true);
          break;
        }
        if (this.n >= this.cap || this.llr + (this.cap - this.n) * this.pass < this.target) {
          this.endRun(false);
          break;
        }
      }
      if (budget <= 0 && this.started) return false;
      if (budget <= 0) return this.run >= this.runs;
    }
    return true;
  }

  result(): SimulationResult {
    if (!this.done) throw new Error("the simulation has not finished");
    const runs = this.runs;
    return {
      runs,
      certified: this.certified,
      escalated: runs - this.certified,
      certifiedRate: this.certified / runs,
      meanDraws: this.sumDraws / runs,
      meanDistinctReviews: this.sumDistinct / runs,
      meanDistinctReviewsWhenCertified: this.certified ? this.sumDistinctCert / this.certified : 0,
    };
  }
}

/**
 * Runs the same scoring rule as `status` against an oracle: `defects` of `population` changes are
 * defective; draws are uniform with replacement; a change drawn twice reuses its verdict. Each run
 * stops at its decision.
 */
export function simulate(input: SimulationInput): SimulationResult {
  const s = new Simulation(input);
  while (!s.step(Number.MAX_SAFE_INTEGER));
  return s.result();
}
