import { PROVENANCE_LEVELS, classifyVerdicts, type ProvenanceLevel, type ReasonPart, type VerdictEvent } from "../sdk/ledger.js";
import { Foreign, Said, type Line } from "./said.js";
import { evaluateSequence, type SequenceResult, type SprtParams } from "./sprt.js";
import { provenanceLabel } from "./presence/provenance.js";

export interface DrawnChange {
  draw: number;
  index: number;
  changeId: string;
  url: string;
}

export interface IgnoredVerdict {
  event: VerdictEvent;
  /** A line (src/core/said.ts): a reviewer's login, an app's name or a change id the ledger line gave is carried as foreign text (S1). */
  reason: Line;
}

/** A reason in the SDK's parts (ReasonPart), as a line. */
export const reasonLine = (parts: readonly ReasonPart[]): Line => {
  const l = new Said(parts.map((p) => (typeof p === "string" ? p : new Foreign(p.words, p.foreign))));
  return l.pieces.length ? l : l.words;
};

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

/**
 * `VERDICT PROVENANCE: account (12) · presence (user-presence flag verified; key hardware not attested) (24)`,
 * the line every certificate prints (FR3.8, FR9.6, NFR4).
 */
export function provenanceLine(p: StatusReport["provenance"]): string {
  return `VERDICT PROVENANCE: ${p.length ? p.map((x) => `${provenanceLabel(x.level)} (${x.count})`).join(" · ") : "none counted"}`;
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
  /** Why a verdict cannot count under the registration's signing rules (P4: `countedVerdicts(…).ineligible`), or null. */
  ineligible?: (v: VerdictEvent) => Line | null;
}): StatusReport {
  const { N, minPopulation, draws, verdicts, params } = input;
  const refusal = N < minPopulation ? `population ${N} < ${minPopulation}: review all ${N} instead` : null;
  const why = input.ineligible;
  const { first, ignored: classified, relabels } = classifyVerdicts(verdicts, { protocolSha256: input.protocolSha256, draws, reviewers: input.reviewers ?? null, ...(why ? { ineligible: (v: VerdictEvent) => { const l = why(v); return l === null ? null : typeof l === "string" ? l : l.parts; } } : {}) });
  const ignored: IgnoredVerdict[] = classified.map((i) => ({ event: i.event, reason: i.reasonParts ? reasonLine(i.reasonParts) : i.reason }));
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
