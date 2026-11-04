import { CHANGE_KINDS, normalizeLogin, type Actor, type ChangeKind, type ChangeRecord, type Review } from "../sdk/provider.js";

export type Unreviewed = "no-human-review" | "no-review" | "any";
export type MergedBy = "human" | "bot" | "any";

/** The registered stratum. Keys are snake_case because this is exactly what `.pr-rla.yml` and the registration carry. */
export interface Selector {
  kinds: ChangeKind[];
  /** Author logins (bots with `[bot]` suffix) or stable account ids (`id:<value>`), or "any". */
  authors: string[] | "any";
  /** A change must carry every listed label. Labels can change after freeze; avoid them for strata you need to re-verify. */
  labels: string[];
  unreviewed: Unreviewed;
  merged_by: MergedBy;
  max_changed_lines: number | null;
  /** Review scope only: generated files are dropped from what the reviewer reads. Does not change the stratum. */
  exclude_generated: boolean;
  /**
   * Schema v2: logins (or `id:<v>`) to treat as bots wherever they appear: author, merger and every
   * review. The core re-labels them before the selector runs, identically on every provider, and
   * `verify` re-applies the registered list (FR7.1). Sorted and de-duplicated. Absent on v1 records.
   */
  bots?: string[];
  /**
   * Schema v2: whether direct pushes that arrived through a pushed merge commit (`landedVia` set, e.g.
   * a release branch merged by a push) count. Default "include" (FR7.6). Absent on v1 records.
   */
  direct_push_via_merge?: "include" | "exclude";
}

export const DEFAULT_SELECTOR: Selector = {
  kinds: ["pull_request", "direct_push"],
  authors: "any",
  labels: [],
  unreviewed: "no-human-review",
  merged_by: "any",
  max_changed_lines: null,
  exclude_generated: true,
  bots: [],
  direct_push_via_merge: "include",
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
  const bots = r.bots ?? [];
  if (!Array.isArray(bots) || bots.some((b) => typeof b !== "string" || b.trim().length === 0 || b.trim() === "id:")) throw new Error('selector.bots must be a list of logins or "id:<account id>" entries');
  const dpvm = r.direct_push_via_merge ?? "include";
  if (dpvm !== "include" && dpvm !== "exclude") throw new Error("selector.direct_push_via_merge must be include or exclude");
  const orderedKinds = CHANGE_KINDS.filter((k) => (kinds as ChangeKind[]).includes(k));
  return { kinds: orderedKinds, authors, labels: [...(labels as string[])].sort(), unreviewed, merged_by, max_changed_lines: mcl as number | null, exclude_generated: eg, bots: normalizeBotList(bots as string[]), direct_push_via_merge: dpvm };
}

/** Trimmed, de-duplicated (logins case-insensitively, ids exactly) and sorted in UTF-16 code-unit order. */
export function normalizeBotList(bots: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const raw of bots) {
    const b = raw.trim();
    const key = b.startsWith("id:") ? b : normalizeLogin(b);
    if (!byKey.has(key)) byKey.set(key, b);
  }
  return [...byKey.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Account ids mapped to the login they had when the manifest was frozen. `verify` passes the
 * manifest's, so an account renamed after freeze still matches a login in the selector (FR7.3).
 */
export type ActorAliases = ReadonlyMap<string, string>;

/**
 * Whether a selector entry names this actor: `id:<v>` matches `Actor.id`; a login matches the
 * actor's login (case-insensitive), or the login its id had at freeze (`aliases`).
 */
export function actorMatches(actor: Actor, entry: string, aliases?: ActorAliases): boolean {
  if (entry.startsWith("id:")) return actor.id !== undefined && actor.id === entry.slice(3);
  const want = normalizeLogin(entry);
  if (normalizeLogin(actor.login) === want) return true;
  const frozen = actor.id !== undefined ? aliases?.get(actor.id) : undefined;
  return frozen !== undefined && normalizeLogin(frozen) === want;
}

/**
 * Re-labels every actor the registered bot list names as `kind: "bot"`: author, merger and every
 * review, on copies. Logins are kept. Returns how many actor entries changed from human to bot.
 */
export function applyBotList(changes: readonly ChangeRecord[], bots: readonly string[], aliases?: ActorAliases): { changes: ChangeRecord[]; relabelled: number } {
  if (bots.length === 0) return { changes: [...changes], relabelled: 0 };
  let relabelled = 0;
  const fix = (a: Actor): Actor => {
    if (a.kind === "bot" || !bots.some((b) => actorMatches(a, b, aliases))) return a;
    relabelled++;
    return { ...a, kind: "bot" };
  };
  const out = changes.map((c) => ({ ...c, author: fix(c.author), mergedBy: c.mergedBy ? fix(c.mergedBy) : null, reviews: c.reviews.map((r) => ({ ...r, author: fix(r.author) })) }));
  return { changes: out, relabelled };
}

/** Funnel step names the selector adds for U3 options (none of them mention reviews). */
export const BOT_LIST_STEP = "actors re-labelled as bot by selector";
export const VIA_MERGE_STEP = "excluding pushes via a pushed merge";
/** Added after the size step when some kept changes have a diff the SCM truncated (`changedLinesUnknown`): kept, because their size cannot be shown to exceed the limit. */
export const UNKNOWN_SIZE_STEP = "of which size unknown (kept in the stratum)";

/** Reviews visible as of `cutoffIso` (inclusive). Later reviews are not part of the frozen record. */
export function reviewsAsOf(change: ChangeRecord, cutoffIso: string): Review[] {
  const cutoff = Date.parse(cutoffIso);
  return change.reviews.filter((r) => Date.parse(r.submittedAt) <= cutoff);
}

/** Whether two accounts are the same one: by `Actor.id` where both have one, by login (case-insensitive) otherwise. */
export function sameAccount(a: Actor, b: Actor): boolean {
  if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
  return normalizeLogin(a.login) === normalizeLogin(b.login);
}

/**
 * Whether a review is a human decision on this change (docs/design/spec.md: "reviewer differs from
 * author; approval precedes merge"). It must be an APPROVED or CHANGES_REQUESTED review that
 *  - a non-bot account submitted,
 *  - was submitted at or before the change landed (`mergedAt`): a later approval is not a review
 *    of what landed, and
 *  - was not submitted by the change's author (compared by `Actor.id` where both have one, by
 *    login otherwise): an author's own approval is not a second pair of eyes.
 * A review that does not count stays in the manifest's record of the change; it just does not hide
 * the change from the population.
 */
export function isHumanDecision(change: Pick<ChangeRecord, "author" | "mergedAt">, review: Review): boolean {
  if (review.author.kind !== "human" || (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED")) return false;
  if (Date.parse(review.submittedAt) > Date.parse(change.mergedAt)) return false;
  return !sameAccount(review.author, change.author);
}

export function hasHumanDecision(change: Pick<ChangeRecord, "author" | "mergedAt">, reviews: readonly Review[]): boolean {
  return reviews.some((r) => isHumanDecision(change, r));
}

export function matchesUnreviewed(change: ChangeRecord, mode: Unreviewed, cutoffIso: string): boolean {
  if (mode === "any") return true;
  const reviews = reviewsAsOf(change, cutoffIso);
  if (mode === "no-review") return reviews.length === 0;
  return !hasHumanDecision(change, reviews);
}

export function matchesAuthor(change: ChangeRecord, authors: Selector["authors"], aliases?: ActorAliases): boolean {
  if (authors === "any") return true;
  return authors.some((a) => actorMatches(change.author, a, aliases));
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
 * The registered bot list is applied first (on copies), and selected changes carry its labels.
 */
export function applySelector(changes: readonly ChangeRecord[], sel: Selector, cutoffIso: string, opts: { aliases?: ActorAliases } = {}): SelectionResult {
  const funnel: FunnelStep[] = [{ step: "landed in window", count: changes.length }];
  const bots = sel.bots ?? [];
  const relabel = applyBotList(changes, bots, opts.aliases);
  if (bots.length > 0) funnel.push({ step: BOT_LIST_STEP, count: relabel.relabelled });
  let cur = relabel.changes.filter((c) => sel.kinds.includes(c.kind));
  funnel.push({ step: `kinds ${sel.kinds.join("+")}`, count: cur.length });
  if (sel.direct_push_via_merge === "exclude" && sel.kinds.includes("direct_push")) {
    cur = cur.filter((c) => !(c.kind === "direct_push" && c.landedVia !== undefined));
    funnel.push({ step: VIA_MERGE_STEP, count: cur.length });
  }
  cur = cur.filter((c) => matchesAuthor(c, sel.authors, opts.aliases));
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
    // A change whose diff the SCM truncated has no known size: it stays in the stratum (it must not slip
    // out, or in, on an undercount) and the funnel says how many there are.
    cur = cur.filter((c) => c.changedLinesUnknown === true || c.changedLines <= max);
    funnel.push({ step: `<= ${max} changed lines`, count: cur.length });
    const unknown = cur.filter((c) => c.changedLinesUnknown === true).length;
    if (unknown > 0) funnel.push({ step: UNKNOWN_SIZE_STEP, count: unknown });
  }
  return { selected: cur, funnel, mergedByBreakdown };
}
