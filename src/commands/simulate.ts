import { simulate } from "../api/read/simulate.js";
import { fmt, pct } from "../api/session.js";
import { CommandError, type CommandContext } from "./context.js";

export interface SimulateOptions {
  population: string;
  defects: string;
  runs?: string;
  seed?: string;
  p0?: string;
  p1?: string;
  alpha?: string;
  cap?: string;
  json?: boolean;
}

const int = (v: string | undefined, name: string, dflt?: number): number => {
  if (v === undefined) {
    if (dflt === undefined) throw new CommandError(`--${name} is required`);
    return dflt;
  }
  const x = Number(v);
  if (!Number.isInteger(x)) throw new CommandError(`--${name} must be an integer`);
  return x;
};

export async function simulateCommand(ctx: CommandContext, o: SimulateOptions): Promise<number> {
  const p0 = o.p0 ? Number(o.p0) : 0.1;
  const cap = o.cap ? int(o.cap, "cap") : null;
  const N = int(o.population, "population");
  const K = int(o.defects, "defects");
  const runs = int(o.runs, "runs", 20_000);
  const r = simulate({ population: N, defects: K, runs, seed: int(o.seed, "seed", 1), p0, p1: o.p1 ? Number(o.p1) : p0 / 5, alpha: o.alpha ? Number(o.alpha) : 0.05, cap });
  if (o.json) {
    ctx.out(JSON.stringify(r, null, 2));
    return 0;
  }
  const rate = K / N;
  ctx.out(`population ${fmt(N)}, ${fmt(K)} defective (true rate ${pct(rate, 2)}) · claim D p0 ${pct(r.params.p0)} p1 ${pct(r.params.p1)} risk ${pct(r.params.alpha)} · cap ${r.params.cap} draws · oracle recall 1.0`);
  ctx.out(`certified ${pct(r.certifiedRate, 2)} of ${fmt(runs)} simulated audits · escalated ${pct(r.escalated / runs, 2)}`);
  ctx.out(`mean draws ${r.meanDraws.toFixed(1)} · mean distinct reviews ${r.meanDistinctReviews.toFixed(1)} (when certified ${r.meanDistinctReviewsWhenCertified.toFixed(1)})`);
  if (rate >= r.params.p0) ctx.out(`at or above the tolerance: certifying is a false certificate; the risk limit requires ≤ ${pct(r.params.alpha)} → ${r.certifiedRate <= r.params.alpha ? "holds" : "VIOLATED"}`);
  return 0;
}
