import { evaluateSequence, scores, effectiveCap, type SprtParams } from "./sprt.js";

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
 * Runs the same scoring code as `status` against an oracle: `defects` of
 * `population` changes are defective; draws are uniform with replacement;
 * a change drawn twice reuses its verdict.
 */
export function simulate(input: SimulationInput): SimulationResult {
  const { population: N, defects: K, runs } = input;
  if (!Number.isInteger(N) || N < 1) throw new Error("population must be a positive integer");
  if (!Number.isInteger(K) || K < 0 || K > N) throw new Error("defects must be an integer in [0, population]");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("runs must be a positive integer");
  scores(input.params);
  const cap = effectiveCap(input.params);
  const recall = input.recall ?? 1;
  const rng = makeRng(input.seed);
  let certified = 0, escalated = 0, sumDraws = 0, sumDistinct = 0, sumDistinctCert = 0;
  for (let run = 0; run < runs; run++) {
    const verdictOf = new Map<number, "pass" | "fail">();
    const seq: ("pass" | "fail")[] = [];
    const order: number[] = [];
    for (let k = 0; k < cap; k++) {
      const idx = Math.floor(rng() * N);
      order.push(idx);
      let v = verdictOf.get(idx);
      if (!v) {
        v = idx < K && rng() < recall ? "fail" : "pass";
        verdictOf.set(idx, v);
      }
      seq.push(v);
    }
    const r = evaluateSequence(seq, input.params);
    const distinct = new Set(order.slice(0, r.draws)).size;
    sumDraws += r.draws;
    sumDistinct += distinct;
    if (r.state === "CERTIFIED") {
      certified++;
      sumDistinctCert += distinct;
    } else escalated++;
  }
  return {
    runs,
    certified,
    escalated,
    certifiedRate: certified / runs,
    meanDraws: sumDraws / runs,
    meanDistinctReviews: sumDistinct / runs,
    meanDistinctReviewsWhenCertified: certified ? sumDistinctCert / certified : 0,
  };
}
