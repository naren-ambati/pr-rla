import { CHANGE_KINDS, normalizeLogin, type ChangeKind, type ChangeRecord, type Review } from "../sdk/provider.js";

export type Unreviewed = "no-human-review" | "no-review" | "any";
export type MergedBy = "human" | "bot" | "any";

/** The registered stratum. Keys are snake_case because this is exactly what `.pr-rla.yml` and the registration carry. */
export interface Selector {
  kinds: ChangeKind[];
  /** Author logins (bots with `[bot]` suffix), or "any". */
  authors: string[] | "any";
  /** A change must carry every listed label. Labels can change after freeze; avoid them for strata you need to re-verify. */
  labels: string[];
  unreviewed: Unreviewed;
  merged_by: MergedBy;
  max_changed_lines: number | null;
  /** Review scope only: generated files are dropped from what the reviewer reads. Does not change the stratum. */
  exclude_generated: boolean;
}

export const DEFAULT_SELECTOR: Selector = {
  kinds: ["pull_request", "direct_push"],
  authors: "any",
  labels: [],
  unreviewed: "no-human-review",
  merged_by: "any",
  max_changed_lines: null,
  exclude_generated: true,
};

export function normalizeSelector(raw: Partial<Record<keyof Selector, unknown>> | undefined): Selector {
  const r = raw ?? {};
  const kinds = r.kinds === undefined ? DEFAULT_SELECTOR.kinds : r.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => !CHANGE_KINDS.includes(k as ChangeKind)))
    throw new Error(`selector.kinds must be a non-empty list of ${CHANGE_KINDS.join(", ")}`);
  let authors: Selector["authors"];
  if (r.authors === undefined || r.authors === "any") authors = "any";
  else if (Array.isArray(r.authors) && r.authors.length > 0 && r.authors.every((a) => typeof a === "string")) {
    authors = (r.authors as string[]).includes("any") ? "any" : [...(r.authors as string[])].sort();
  } else throw new Error('selector.authors must be "any" or a non-empty list of logins');
  const labels = r.labels === undefined ? [] : r.labels;
  if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string")) throw new Error("selector.labels must be a list of strings");
  const unreviewed = (r.unreviewed ?? DEFAULT_SELECTOR.unreviewed) as Unreviewed;
  if (!["no-human-review", "no-review", "any"].includes(unreviewed)) throw new Error("selector.unreviewed must be no-human-review, no-review or any");
  const merged_by = (r.merged_by ?? DEFAULT_SELECTOR.merged_by) as MergedBy;
  if (!["human", "bot", "any"].includes(merged_by)) throw new Error("selector.merged_by must be human, bot or any");
  const mcl = r.max_changed_lines ?? null;
  if (mcl !== null && (typeof mcl !== "number" || !Number.isInteger(mcl) || mcl < 0)) throw new Error("selector.max_changed_lines must be a non-negative integer or null");
  const eg = r.exclude_generated ?? DEFAULT_SELECTOR.exclude_generated;
  if (typeof eg !== "boolean") throw new Error("selector.exclude_generated must be true or false");
  const orderedKinds = CHANGE_KINDS.filter((k) => (kinds as ChangeKind[]).includes(k));
  return { kinds: orderedKinds, authors, labels: [...(labels as string[])].sort(), unreviewed, merged_by, max_changed_lines: mcl as number | null, exclude_generated: eg };
}

/** Reviews visible as of `cutoffIso` (inclusive). Later reviews are not part of the frozen record. */
export function reviewsAsOf(change: ChangeRecord, cutoffIso: string): Review[] {
  const cutoff = Date.parse(cutoffIso);
  return change.reviews.filter((r) => Date.parse(r.submittedAt) <= cutoff);
}

export function hasHumanDecision(reviews: readonly Review[]): boolean {
  return reviews.some((r) => r.author.kind === "human" && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"));
}

export function matchesUnreviewed(change: ChangeRecord, mode: Unreviewed, cutoffIso: string): boolean {
  if (mode === "any") return true;
  const reviews = reviewsAsOf(change, cutoffIso);
  if (mode === "no-review") return reviews.length === 0;
  return !hasHumanDecision(reviews);
}

export function matchesAuthor(change: ChangeRecord, authors: Selector["authors"]): boolean {
  if (authors === "any") return true;
  const login = normalizeLogin(change.author.login);
  return authors.some((a) => normalizeLogin(a) === login);
}

/** A direct push has no known pusher, so it only matches `merged_by: any`. */
export function matchesMergedBy(change: ChangeRecord, mode: MergedBy): boolean {
  if (mode === "any") return true;
  return change.mergedBy !== null && change.mergedBy.kind === mode;
}

export interface FunnelStep {
  step: string;
  count: number;
}

export interface SelectionResult {
  selected: ChangeRecord[];
  funnel: FunnelStep[];
  /** Among changes passing kinds+authors+unreviewed: who pressed merge. */
  mergedByBreakdown: { human: number; bot: number; unknown: number };
}

/**
 * Applies the selector. Steps are applied in a fixed order so the funnel is
 * reproducible; the final set is the intersection of all filters.
 * `cutoffIso` is the freeze time: reviews submitted after it are ignored.
 */
export function applySelector(changes: readonly ChangeRecord[], sel: Selector, cutoffIso: string): SelectionResult {
  const funnel: FunnelStep[] = [{ step: "landed in window", count: changes.length }];
  let cur = changes.filter((c) => sel.kinds.includes(c.kind));
  funnel.push({ step: `kinds ${sel.kinds.join("+")}`, count: cur.length });
  cur = cur.filter((c) => matchesAuthor(c, sel.authors));
  funnel.push({ step: sel.authors === "any" ? "any author" : `author ${sel.authors.join("|")}`, count: cur.length });
  if (sel.labels.length > 0) {
    cur = cur.filter((c) => sel.labels.every((l) => c.labels.includes(l)));
    funnel.push({ step: `labels ${sel.labels.join("+")}`, count: cur.length });
  }
  cur = cur.filter((c) => matchesUnreviewed(c, sel.unreviewed, cutoffIso));
  funnel.push({ step: sel.unreviewed === "any" ? "any review state" : sel.unreviewed === "no-review" ? "no review object" : "no recorded human review", count: cur.length });
  const mergedByBreakdown = { human: 0, bot: 0, unknown: 0 };
  for (const c of cur) mergedByBreakdown[c.mergedBy ? c.mergedBy.kind : "unknown"]++;
  if (sel.merged_by !== "any") {
    cur = cur.filter((c) => matchesMergedBy(c, sel.merged_by));
    funnel.push({ step: `merged by ${sel.merged_by}`, count: cur.length });
  }
  if (sel.max_changed_lines !== null) {
    const max = sel.max_changed_lines;
    cur = cur.filter((c) => c.changedLines <= max);
    funnel.push({ step: `<= ${max} changed lines`, count: cur.length });
  }
  return { selected: cur, funnel, mergedByBreakdown };
}
