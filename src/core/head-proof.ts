import { isCommitId, isIsoUtc, NO_COMMIT, type AuditWindow, type PushLog, type PushLogEvent, type ScmProvider } from "../sdk/provider.js";
import { isTransientFailure } from "./failures.js";
import { mapPool } from "./population.js";
import type { HeadEvidence } from "./records.js";

/**
 * Push-time evidence for a frozen head (P3). A manifest's frozen head, and the commit dates and graph shape behind it,
 * are the pusher's to set; the SCM's push log is not: each update of the branch is recorded, with its time, by the SCM
 * when it happens. This module reads that log and decides, for one repo:
 *
 * - **proven**: the frozen head was the branch's tip at some instant of the freeze span (from the manifest's as-of time
 *   until seed round R published), and every commit on the branch when the window closed is reachable from it: either
 *   every update between the window's close and the head becoming the tip is one the SCM calls a fast-forward, or
 *   `rewrites` lists the ones it does not, for the caller to check otherwise. A window commit the frozen head does not
 *   reach then arrived after the window closed (FR7.2), which is legitimate.
 * - **disproven**: the log covers the freeze, and the frozen head was never the tip during it.
 * - **none**: there is no usable log (the provider has none, it cannot be read, it does not reach back to the window's
 *   close, or it has a gap). A window commit the frozen head does not reach is then unverified: INCOMPLETE.
 *
 * It never reads a commit date or the shape of the history.
 */

export interface HeadProofArgs {
  /** The frozen head (lowercase hex). */
  head: string;
  window: AuditWindow;
  /** The freeze span: the frozen head must have been the branch's tip at some instant from `from` to `until` (inclusive). */
  from: string;
  until: string;
}

export type HeadProof =
  | {
      kind: "proven";
      /** When the frozen head became the branch's tip (the update that made it so), at or before it was frozen. */
      since: string;
      /** The update that made it the tip. */
      event: PushLogEvent;
      /** The branch's tip when the window closed; null when the branch did not exist then. */
      tipAtClose: string | null;
      /** Updates after the window closed, up to the frozen head becoming the tip, that the SCM does not call fast-forwards. */
      rewrites: PushLogEvent[];
      /** Updates after the frozen head became the tip, oldest first. */
      after: PushLogEvent[];
      /** Force pushes and deletions of the branch inside the window. */
      forcedInWindow: PushLogEvent[];
      limitations: string[];
    }
  | { kind: "disproven"; reason: string; limitations: string[] }
  | { kind: "none"; reason: string; limitations: string[] };

const short = (sha: string) => (sha === NO_COMMIT || sha === "" ? "(none)" : `${sha.slice(0, 12)}…`);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const KINDS: ReadonlySet<string> = new Set(["fast-forward", "forced", "created", "deleted", "unknown"]);

interface Ev extends PushLogEvent {
  t: number;
}

/** Problems with one event as the SDK defines it; empty means usable. */
function eventProblem(e: unknown): string | null {
  if (!e || typeof e !== "object") return "an update is not an object";
  const x = e as Partial<PushLogEvent>;
  if (typeof x.id !== "string" || x.id === "") return "an update has no id";
  if (!isIsoUtc(x.at)) return `update ${x.id} has no ISO 8601 UTC time (${JSON.stringify(x.at)})`;
  if (!KINDS.has(x.kind as string)) return `update ${x.id} has kind ${JSON.stringify(x.kind)}`;
  for (const side of ["before", "after"] as const) {
    const v = x[side];
    if (v !== "" && v !== NO_COMMIT && !isCommitId(v)) return `update ${x.id} has ${side} ${JSON.stringify(v)}, not a commit id`;
  }
  return null;
}

/**
 * Decides what a push log shows about a frozen head (see the module comment). `log.events` is newest first, as the
 * SDK returns it; equal times keep that order.
 */
export function analysePushLog(log: PushLog, a: HeadProofArgs): HeadProof {
  const limitations = Array.isArray(log?.limitations) ? log.limitations.filter((l): l is string => typeof l === "string") : [];
  const none = (reason: string): HeadProof => ({ kind: "none", reason, limitations });
  if (!log || !Array.isArray(log.events)) return none("the provider's push log has no list of updates");
  for (const e of log.events) {
    const p = eventProblem(e);
    if (p) return none(`the provider's push log is malformed: ${p}`);
  }
  const head = a.head.toLowerCase();
  // Oldest first; equal times in the log's own (newest-first) order, reversed.
  const evs: Ev[] = log.events.map((e, i) => ({ ...e, before: e.before.toLowerCase(), after: e.after.toLowerCase(), t: Date.parse(e.at), i })).sort((x, y) => x.t - y.t || y.i - x.i).map(({ i: _i, ...e }) => e);
  const closes = Date.parse(a.window.closesAt);
  const opens = Date.parse(a.window.opensAt);
  const from = Date.parse(a.from);
  const until = Date.parse(a.until);

  // The log must show the tip at the window's close: an update at or before it, or the branch's creation after it.
  let anchor = -1;
  for (let i = 0; i < evs.length; i++) if (evs[i]!.t <= closes) anchor = i;
  let tipAtClose: string | null;
  if (anchor >= 0) tipAtClose = evs[anchor]!.kind === "deleted" || evs[anchor]!.after === NO_COMMIT ? null : evs[anchor]!.after;
  else if (evs[0]?.kind === "created") {
    tipAtClose = null;
    anchor = 0;
  } else
    return none(
      evs.length
        ? `the push log does not reach back to the window's close (${a.window.closesAt}): its oldest update is from ${evs[0]!.at}`
        : "the push log holds no update of the branch (the SCM keeps none that old, or never recorded one)",
    );
  // From the anchor on, each update must start where the one before it ended: a gap means updates are missing.
  for (let i = anchor + 1; i < evs.length; i++) {
    const prev = evs[i - 1]!;
    const cur = evs[i]!;
    const was = prev.kind === "deleted" ? NO_COMMIT : prev.after;
    if (cur.before === "" || was === "" || cur.before !== was) return none(`the push log has a gap: update ${cur.id} at ${cur.at} starts from ${short(cur.before)}, but the tip before it was ${short(was)}`);
  }

  const relevant = evs.slice(anchor);
  const tipAt = (t: number): { tip: string | null; ev: Ev | null } => {
    let ev: Ev | null = null;
    for (const e of relevant) if (e.t <= t) ev = e;
    if (!ev) return { tip: tipAtClose, ev: null };
    return { tip: ev.kind === "deleted" || ev.after === NO_COMMIT ? null : ev.after, ev };
  };
  const atFrom = tipAt(from);
  let made: Ev | null = null;
  if (atFrom.tip === head && atFrom.ev) made = atFrom.ev;
  else made = relevant.find((e) => e.t > from && e.t <= until && e.after === head && e.kind !== "deleted") ?? null;
  if (!made) {
    const was = relevant.filter((e) => e.after === head);
    const span = `from ${a.from} to ${a.until}`;
    const then = atFrom.tip === null ? "the branch did not exist" : `the tip was ${short(atFrom.tip)}${atFrom.ev ? ` (since ${atFrom.ev.at}, update ${atFrom.ev.id})` : ""}`;
    const moves = relevant.filter((e) => e.t > from && e.t <= until).length;
    const where = was.length ? `; the log shows it as the tip only from ${was[0]!.at}${was.length > 1 ? ` (and ${was.length - 1} other time(s))` : ""}, outside the freeze` : "; the log never shows it as the branch's tip";
    return { kind: "disproven", reason: `the push log shows that at ${a.from} ${then}, and none of the ${moves} update(s) ${span} made ${short(head)} the tip${where}`, limitations };
  }
  const rewrites = relevant.filter((e) => e.t > closes && e.t <= made!.t && e.kind !== "fast-forward");
  const after = relevant.filter((e) => e.t > made!.t);
  const forcedInWindow = evs.filter((e) => e.t >= opens && e.t < closes && (e.kind === "forced" || e.kind === "deleted"));
  return { kind: "proven", since: iso(made.t), event: { id: made.id, before: made.before, after: made.after, at: made.at, kind: made.kind }, tipAtClose, rewrites: rewrites.map(strip), after: after.map(strip), forcedInWindow: forcedInWindow.map(strip), limitations };
}

const strip = ({ t: _t, ...e }: Ev): PushLogEvent => e;

export interface ReadHeadProofArgs extends HeadProofArgs {
  repo: string;
  /** The branch whose log to read (the default branch the head was frozen on). */
  branch: string;
  signal?: AbortSignal;
  /** freeze: a rate limit or an outage is thrown (the run stops and resumes) instead of becoming "none". */
  rethrowTransient?: boolean;
}

/** Reads the provider's push log for a repo and analyses it; a provider without one, or a log that cannot be read, is "none". */
export async function readHeadProof(provider: Pick<ScmProvider, "name" | "pushLog">, a: ReadHeadProofArgs): Promise<HeadProof> {
  if (typeof provider.pushLog !== "function") return { kind: "none", reason: `provider ${provider.name} keeps no push log pr-rla can read (it has no pushLog)`, limitations: [] };
  if (!a.branch) return { kind: "none", reason: "the manifest records no default branch for it", limitations: [] };
  let log: PushLog;
  try {
    log = await provider.pushLog({ repo: a.repo, branch: a.branch, since: a.window.closesAt, ...(a.signal ? { signal: a.signal } : {}) });
  } catch (e) {
    if (a.rethrowTransient && isTransientFailure(e)) throw e;
    return { kind: "none", reason: isTransientFailure(e) ? `reading its push log hit a rate limit or an outage (${message(e)}); run verify again` : `its push log could not be read (${message(e)})`, limitations: [] };
  }
  return analysePushLog(log, a);
}

/** One line on how a proven head became the tip, for notes and the manifest's record. */
export function provenLine(p: Extract<HeadProof, { kind: "proven" }>): string {
  return `it became the default branch's tip at ${p.since} (update ${p.event.id}, ${p.event.kind})`;
}

/** A repo whose head a freeze pinned, as the evidence pass needs it. */
export interface PinnedRepo {
  repo: string;
  defaultBranch: string;
  headSha: string | null;
}

/**
 * What `freeze` records about each pinned head (P3; ManifestV2.headEvidence): the branch's push log read after the
 * listing, sorted by repo, with the lines freeze prints (heads the log cannot show, updates after the close that the
 * SCM does not call fast-forwards). Null when the provider has no push log. A rate limit or an outage is thrown, so a
 * pooled freeze stops and resumes rather than recording a weaker manifest; any other failure is recorded as unproven.
 * The record holds only what does not change with the time it is read (the update that made the head the tip).
 */
export async function freezeHeadEvidence(
  provider: Pick<ScmProvider, "name" | "pushLog">,
  repos: readonly PinnedRepo[],
  o: { window: AuditWindow; from: string; until: string; concurrency: number; signal?: AbortSignal },
): Promise<{ evidence: HeadEvidence[]; notes: string[] } | null> {
  if (typeof provider.pushLog !== "function") return null;
  const pinned = [...repos].filter((r): r is PinnedRepo & { headSha: string } => typeof r.headSha === "string" && r.headSha !== "").sort((x, y) => (x.repo < y.repo ? -1 : x.repo > y.repo ? 1 : 0));
  const proofs = await mapPool(pinned, Math.max(1, o.concurrency), (r) => readHeadProof(provider, { repo: r.repo, branch: r.defaultBranch, head: r.headSha.toLowerCase(), window: o.window, from: o.from, until: o.until, rethrowTransient: true, ...(o.signal ? { signal: o.signal } : {}) }));
  const evidence: HeadEvidence[] = [];
  const unproven: string[] = [];
  const rewritten: string[] = [];
  pinned.forEach((r, k) => {
    const p = proofs[k]!;
    if (p.kind === "proven") {
      const forced = p.rewrites.length ? `; ${p.rewrites.length} update(s) after the window closed that ${provider.name} does not call fast-forwards (${p.rewrites.slice(0, 3).map((e) => `${e.kind} update ${e.id} at ${e.at}`).join(", ")})` : "";
      evidence.push({ repo: r.repo, headSha: r.headSha, status: "tip", since: p.since, event: p.event.id, detail: `${provenLine(p)}${forced}` });
      if (p.rewrites.length) rewritten.push(r.repo);
    } else {
      evidence.push({ repo: r.repo, headSha: r.headSha, status: "unproven", detail: p.kind === "disproven" ? `the push log does not show it as the branch's tip during the freeze: ${p.reason}` : p.reason });
      unproven.push(`${r.repo}: ${evidence.at(-1)!.detail}`);
    }
  });
  const notes: string[] = [];
  if (unproven.length) notes.push(`note: the push log cannot show ${unproven.length} frozen head(s) were the default branch's tip during the freeze (${unproven.slice(0, 2).join("; ")}): a commit dated in the window pushed there after freeze will leave verify INCOMPLETE for that repo, and a head the log contradicts FAILs check 5`);
  if (rewritten.length) notes.push(`note: ${rewritten.length} repo(s) had their default branch updated after the window closed by an update ${provider.name} does not call a fast-forward (e.g. ${rewritten.slice(0, 3).join(", ")}): verify checks that everything on the branch when the window closed is in the population`);
  return { evidence, notes };
}
