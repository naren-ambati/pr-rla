/**
 * Wald SPRT / BRAVO-style ballot-polling test over draws with replacement.
 *
 * H0: rate >= p0. Planning alternative p1 < p0.
 * A pass adds ln((1-p1)/(1-p0)); a fail adds ln(p1/p0).
 * Certify when the running sum reaches ln(1/alpha). By Ville's inequality the
 * chance of ever certifying when the true rate is >= p0 is <= alpha.
 * Escalate at the cap (default 4x the zero-failure stopping point), or earlier
 * once the target is out of reach within the cap.
 */

export interface SprtParams {
  p0: number;
  p1: number;
  alpha: number;
  /** Maximum number of draws before ESCALATE. Defaults to 4 x zero-failure stop. */
  cap?: number | null;
}

export interface Scores {
  pass: number;
  fail: number;
  target: number;
}

export function validateParams(p: SprtParams): void {
  const ok = (x: number) => Number.isFinite(x) && x > 0 && x < 1;
  if (!ok(p.p0) || !ok(p.p1) || !ok(p.alpha)) throw new Error("p0, p1 and alpha must each be in (0, 1)");
  if (!(p.p1 < p.p0)) throw new Error(`p1 (${p.p1}) must be below p0 (${p.p0})`);
  if (p.cap != null && (!Number.isInteger(p.cap) || p.cap < 1)) throw new Error("cap must be a positive integer");
}

export function scores(p: SprtParams): Scores {
  validateParams(p);
  return {
    pass: Math.log((1 - p.p1) / (1 - p.p0)),
    fail: Math.log(p.p1 / p.p0),
    target: Math.log(1 / p.alpha),
  };
}

/** Smallest total number of draws that certifies with exactly `failures` fails (all fails first is worst case; order does not matter for the sum). */
export function stoppingPoint(p: SprtParams, failures: number): number {
  const s = scores(p);
  const need = s.target - failures * s.fail;
  let passes = Math.ceil(need / s.pass);
  // Guard against floating-point rounding at the boundary.
  while (passes > 0 && (passes - 1) * s.pass + failures * s.fail >= s.target) passes--;
  while (passes * s.pass + failures * s.fail < s.target) passes++;
  return failures + passes;
}

export function zeroFailureStop(p: SprtParams): number {
  return stoppingPoint(p, 0);
}

export function effectiveCap(p: SprtParams): number {
  return p.cap ?? 4 * zeroFailureStop(p);
}

export type SprtState = "CERTIFIED" | "CONTINUE" | "ESCALATE";

export interface SequenceResult {
  state: SprtState;
  /** Draws consumed by the test (stops at the certifying or escalating draw). */
  draws: number;
  passes: number;
  fails: number;
  llr: number;
  target: number;
  cap: number;
  /** For CONTINUE: passing draws still needed if every next draw passes. */
  morePassesNeeded?: number;
  /** Why ESCALATE fired. */
  escalateReason?: "cap-reached" | "target-unreachable";
}

/**
 * Runs the sequential test over verdicts in draw order. Stops at the first
 * crossing of the target (CERTIFIED), at the cap, or as soon as the target
 * can no longer be reached within the cap (ESCALATE).
 */
export function evaluateSequence(verdicts: readonly ("pass" | "fail")[], p: SprtParams): SequenceResult {
  const s = scores(p);
  const cap = effectiveCap(p);
  let llr = 0;
  let passes = 0;
  let fails = 0;
  let n = 0;
  const unreachable = () => llr + (cap - n) * s.pass < s.target;
  if (unreachable()) return { state: "ESCALATE", draws: 0, passes, fails, llr, target: s.target, cap, escalateReason: "target-unreachable" };
  for (const v of verdicts) {
    if (n >= cap) break;
    n++;
    if (v === "pass") {
      passes++;
      llr += s.pass;
    } else {
      fails++;
      llr += s.fail;
    }
    if (llr >= s.target) return { state: "CERTIFIED", draws: n, passes, fails, llr, target: s.target, cap };
    if (n >= cap) return { state: "ESCALATE", draws: n, passes, fails, llr, target: s.target, cap, escalateReason: "cap-reached" };
    if (unreachable()) return { state: "ESCALATE", draws: n, passes, fails, llr, target: s.target, cap, escalateReason: "target-unreachable" };
  }
  const morePassesNeeded = Math.max(1, Math.ceil((s.target - llr) / s.pass - 1e-12));
  return { state: "CONTINUE", draws: n, passes, fails, llr, target: s.target, cap, morePassesNeeded };
}

export interface StoppingRow {
  failures: number;
  draws: number;
}

/** The "certify after this many draws with 0/1/2 failures" table. */
export function stoppingTable(p: SprtParams, maxFailures = 2): StoppingRow[] {
  return Array.from({ length: maxFailures + 1 }, (_, f) => ({ failures: f, draws: stoppingPoint(p, f) }));
}
