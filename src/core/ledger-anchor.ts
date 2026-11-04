import type { CheckpointArtifact } from "./checkpoint.js";
import type { DrawsFile } from "./records.js";

/**
 * What check 7 says about the things that anchor an issue ledger's history to the audit repo
 * (findings 3 and 9 of the master review): the draw → issue index `sample` bound to draws.json, and
 * the time-stamped checkpoints. Pure; the commands read the files.
 */

/** The window's `ledger-index.json` as parsed JSON with its hash (src/ledgers/issue-index.ts). */
export interface LedgerIndexDocument {
  sha256: string;
  value: unknown;
  /** Set when the file is not JSON. */
  error?: string;
}

export interface AnchorFindings {
  /** Each makes check 7 FAIL. */
  fails: string[];
  /** Each makes check 7 WARN. */
  warns: string[];
  /** Shown, no status change. */
  notes: string[];
}

const empty = (): AnchorFindings => ({ fails: [], warns: [], notes: [] });

interface IndexShape {
  issues?: unknown;
  repeats?: unknown;
  /** Not an index field (P1): an index that carries it FAILs. */
  foreignIssues?: unknown;
}

/**
 * The index against draws.json. The hash `sample` recorded must be the file's hash now; whatever
 * the hash says, every issue in the index must be the draw it claims to be, and every issued draw
 * with a first occurrence must have one (an index with fewer issues than draws leaves draws that
 * nothing can be recorded against). An index without an `issues` list (an external ledger's own
 * shape) gets the hash check only.
 */
export function indexBindingFindings(draws: DrawsFile, index: LedgerIndexDocument | null): AnchorFindings {
  const out = empty();
  const bound = draws.ledgerIndexSha256;
  if (index?.error) out.fails.push(index.error);
  if (!index) {
    if (bound) out.fails.push(`ledger-index.json is missing, but draws.json bound it at sample time (sha256 ${bound.slice(0, 12)}…): the draw → issue mapping is gone`);
    return out;
  }
  if (bound === undefined) out.warns.push("draws.json does not record the ledger index's hash (it was sampled by an earlier pr-rla): the draw → issue mapping is not bound to the draws; run \"pr-rla sample\" again to bind it");
  else if (bound !== index.sha256) out.fails.push(`ledger-index.json (sha256 ${index.sha256.slice(0, 12)}…) is not the index draws.json bound at sample time (${bound.slice(0, 12)}…): the draw → issue mapping was edited after the draws were published`);
  const v = index.value as IndexShape | null;
  if (!v || typeof v !== "object") return out;
  // P1: foreign issues are a test-only ledger option now (recorded public timelines), never an index field.
  if (v.foreignIssues !== undefined) out.fails.push("the ledger index carries foreignIssues, which turns off the issues' body-marker check: an audit's index never carries it (it is a test-only ledger option for recorded public timelines)");
  if (!Array.isArray(v.issues)) return out;
  const byNumber = new Map(draws.draws.map((d) => [d.draw, d]));
  const issueDraws = new Set<number>();
  for (const i of v.issues as { draw?: unknown; changeId?: unknown }[]) {
    const d = typeof i?.draw === "number" ? byNumber.get(i.draw) : undefined;
    if (!d || d.changeId !== i.changeId) out.fails.push(`ledger index: draw #${String(i?.draw)} is ${String(i?.changeId)}, but draws.json draws ${d ? d.changeId : "nothing"} there`);
    else issueDraws.add(d.draw);
  }
  const repeats = new Map<number, { changeId?: unknown; sameAs?: unknown }>();
  if (Array.isArray(v.repeats)) for (const r of v.repeats as { draw?: unknown; changeId?: unknown; sameAs?: unknown }[]) if (typeof r?.draw === "number") repeats.set(r.draw, r);
  for (const d of draws.draws.slice(0, draws.issued)) {
    if (d.firstOccurrence) {
      if (!issueDraws.has(d.draw)) out.fails.push(`ledger index: draw #${d.draw} (${d.changeId}) has no issue; a verdict cannot be recorded against it`);
    } else {
      const first = draws.draws.find((x) => x.changeId === d.changeId && x.firstOccurrence);
      const r = repeats.get(d.draw);
      if (!r || r.changeId !== d.changeId || !first || r.sameAs !== first.draw) out.fails.push(`ledger index: draw #${d.draw} (${d.changeId}) repeats draw #${first?.draw ?? "?"} but the index does not say so`);
    }
  }
  return out;
}

/**
 * Checkpoint coverage for a ledger that can be checkpointed (an issue tracker): a checkpoint is the
 * only thing that notices history deleted from the tracker, so one must have been taken, with
 * time-stamp tokens, at or after the last counted verdict; and a line with no tokens proves nothing
 * about when it was taken. `lastCountedAt` is the latest `recordedAt` among the counted verdicts, or
 * null when none is counted. `timeStamped` says whether a checkpoint's tokens count: check 7's gate
 * passes the trusted-time verdict (P1, pass-2 review #5: proven by k registered authorities, with U_k at
 * or after the last counted verdict), so a line whose tokens are short, ignored or failing does not
 * cover it; without it, any token counts.
 */
export function checkpointCoverage(checkpoints: readonly CheckpointArtifact[], opts: { checkpointable: boolean; lastCountedAt: string | null; ledgerIndexSha256: string | null; unchained: number; timeStamped?: (cp: CheckpointArtifact) => boolean }): AnchorFindings {
  const out = empty();
  for (const cp of checkpoints)
    if (cp.line.timestamps.length === 0) out.warns.push(`checkpoint ${cp.line.takenAt} carries no time-stamp tokens: its time is the writer's clock, so it does not bound when the history existed`);
  if (opts.checkpointable && opts.lastCountedAt !== null) {
    const stamped = opts.timeStamped ?? ((c: CheckpointArtifact) => c.line.timestamps.length > 0);
    const after = checkpoints.filter((c) => Date.parse(c.line.takenAt) >= Date.parse(opts.lastCountedAt!));
    const covering = after.filter(stamped);
    if (covering.length === 0) {
      const latest = checkpoints.map((c) => c.line.takenAt).sort().at(-1);
      const unstamped = after.filter((c) => c.line.timestamps.length > 0);
      const why = unstamped.length ? ` (${unstamped.map((c) => c.line.takenAt).join(", ")} carr${unstamped.length === 1 ? "ies" : "y"} tokens, but they do not prove, by k registered authorities, that it existed at or after the last verdict)` : "";
      out.warns.push(
        `no time-stamped ledger checkpoint post-dates the last counted verdict (${opts.lastCountedAt}); ${latest ? `the latest checkpoint is ${latest}` : "there is none"}${why}. Issue history deleted after the last checkpoint cannot be detected: run "pr-rla checkpoint" now that the verdicts are in`,
      );
    }
  }
  if (opts.ledgerIndexSha256 !== null) {
    const latest = [...checkpoints].sort((a, b) => (a.line.takenAt < b.line.takenAt ? -1 : a.line.takenAt > b.line.takenAt ? 1 : 0)).at(-1);
    if (latest?.line.ledgerIndexSha256 !== undefined && latest.line.ledgerIndexSha256 !== opts.ledgerIndexSha256)
      out.warns.push(`the ledger index changed since the latest checkpoint (${latest.line.takenAt}: index ${latest.line.ledgerIndexSha256.slice(0, 12)}…, now ${opts.ledgerIndexSha256.slice(0, 12)}…): more draws were published since, or the index was edited; checkpoint again`);
  }
  if (opts.unchained > 0 && checkpoints.length > 0) out.notes.push(`${opts.unchained} checkpoint line(s) carry no prevLineSha256 (written before the chain existed, or by an older pr-rla): they are not chain-checked`);
  return out;
}
