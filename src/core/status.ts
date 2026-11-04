import { PROVENANCE_LEVELS, verdictIneligibility, type ProvenanceLevel, type VerdictEvent } from "../sdk/ledger.js";
import { evaluateSequence, type SequenceResult, type SprtParams } from "./sprt.js";

export interface DrawnChange {
  draw: number;
  index: number;
  changeId: string;
  url: string;
}

export interface IgnoredVerdict {
  event: VerdictEvent;
  reason: string;
}

export interface StatusReport {
  N: number;
  minPopulation: number;
  /** Set when N < minPopulation: the audit refuses to sample. */
  refusal: string | null;
  drawsIssued: number;
  /** Length of the longest fully labelled prefix of draws (capped at the cap). */
  labelledPrefix: number;
  blockingDraw: DrawnChange | null;
  /** Distinct changes reviewed within the counted prefix. */
  distinctReviewed: number;
  sequence: SequenceResult;
  /** Labelled draws after the test already stopped (not counted). */
  beyondStop: number;
  ignored: IgnoredVerdict[];
  /** Later verdicts on a change that disagree with its first verdict (first one counts). */
  relabels: { changeId: string; first: VerdictEvent; later: VerdictEvent }[];
  /** The first eligible verdict of every drawn change that has one, in draw order of the change's first draw. */
  firstVerdicts: VerdictEvent[];
  /** Provenance of the counted verdicts (the first `sequence.draws` draws), lowest level first. */
  provenance: { level: ProvenanceLevel; count: number }[];
}

/** A verdict's provenance level; a ledger that says nothing is `self-asserted`. */
export const provenanceOf = (v: VerdictEvent): ProvenanceLevel => v.provenance?.level ?? "self-asserted";

/** `VERDICT PROVENANCE: account (12) · presence (24)`, the line every certificate prints (FR3.8, NFR4). */
export function provenanceLine(p: StatusReport["provenance"]): string {
  return `VERDICT PROVENANCE: ${p.length ? p.map((x) => `${x.level} (${x.count})`).join(" · ") : "none counted"}`;
}

/**
 * The longest-fully-labelled-prefix rule: walk draws in order; the first draw
 * whose change has no eligible verdict blocks everything after it, so
 * reviewers cannot improve the result by labelling easy draws first.
 * Only the FIRST eligible verdict per change counts; duplicates reuse it.
 */
export function computeStatus(input: {
  N: number;
  minPopulation: number;
  draws: readonly DrawnChange[];
  drawsIssued: number;
  verdicts: readonly VerdictEvent[];
  protocolSha256: string;
  params: SprtParams;
  /** The registration's `verdicts.reviewers`: only their verdicts count. null/absent: any account that is not a bot or an app. */
  reviewers?: readonly string[] | null;
}): StatusReport {
  const { N, minPopulation, draws, verdicts, params } = input;
  const refusal = N < minPopulation ? `population ${N} < ${minPopulation}: review all ${N} instead` : null;
  const drawByNumber = new Map(draws.map((d) => [d.draw, d]));
  const drawnIds = new Set(draws.map((d) => d.changeId));
  const ignored: IgnoredVerdict[] = [];
  const first = new Map<string, VerdictEvent>();
  const relabels: StatusReport["relabels"] = [];
  for (const ev of verdicts) {
    if (ev.protocolSha256 !== input.protocolSha256) {
      ignored.push({ event: ev, reason: `protocol ${ev.protocolSha256.slice(0, 8)}… is not the registered protocol ${input.protocolSha256.slice(0, 8)}…` });
      continue;
    }
    if (!drawnIds.has(ev.changeId)) {
      ignored.push({ event: ev, reason: "change was not drawn" });
      continue;
    }
    const d = drawByNumber.get(ev.draw);
    if (!d || d.changeId !== ev.changeId) {
      ignored.push({ event: ev, reason: `draw #${ev.draw} is not ${ev.changeId}` });
      continue;
    }
    const ineligible = verdictIneligibility(ev, input.reviewers);
    if (ineligible) {
      ignored.push({ event: ev, reason: ineligible });
      continue;
    }
    const prior = first.get(ev.changeId);
    if (!prior) first.set(ev.changeId, ev);
    else if (prior.verdict !== ev.verdict) relabels.push({ changeId: ev.changeId, first: prior, later: ev });
  }
  const seq: ("pass" | "fail")[] = [];
  let blockingDraw: DrawnChange | null = null;
  const ordered = [...draws].sort((a, b) => a.draw - b.draw);
  for (const d of ordered.slice(0, input.drawsIssued)) {
    const v = first.get(d.changeId);
    if (!v) {
      blockingDraw = d;
      break;
    }
    seq.push(v.verdict);
  }
  if (!blockingDraw && input.drawsIssued < ordered.length) blockingDraw = ordered[input.drawsIssued] ?? null;
  const sequence = evaluateSequence(seq, params);
  const counted = ordered.slice(0, sequence.draws);
  const levels = new Map<ProvenanceLevel, number>();
  for (const id of new Set(counted.map((d) => d.changeId))) {
    const v = first.get(id);
    if (v) levels.set(provenanceOf(v), (levels.get(provenanceOf(v)) ?? 0) + 1);
  }
  const firstDrawOf = new Map<string, number>();
  for (const d of ordered) if (!firstDrawOf.has(d.changeId)) firstDrawOf.set(d.changeId, d.draw);
  return {
    N,
    minPopulation,
    refusal,
    drawsIssued: input.drawsIssued,
    labelledPrefix: seq.length,
    blockingDraw: sequence.state === "CONTINUE" ? blockingDraw : null,
    distinctReviewed: new Set(counted.map((d) => d.changeId)).size,
    sequence,
    beyondStop: Math.max(0, seq.length - sequence.draws),
    ignored,
    relabels,
    firstVerdicts: [...first.values()].sort((a, b) => (firstDrawOf.get(a.changeId) ?? 0) - (firstDrawOf.get(b.changeId) ?? 0)),
    provenance: PROVENANCE_LEVELS.filter((l) => levels.has(l)).map((level) => ({ level, count: levels.get(level)! })),
  };
}
