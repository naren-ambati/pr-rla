import { isRepoEmpty, type ChangeRecord, type ListChangesResult, type RepoRef, type RepoSetRule, type RepoVisibility, type ScmProvider } from "../sdk/provider.js";
import { isTransientFailure, looksUnavailable, probeRepo } from "./failures.js";
import { provenLine, readHeadProof, type HeadProof } from "./head-proof.js";
import { checkListed, listRepoChanges, mapPool } from "./population.js";
import type { GoneRepo, ManifestRepo, RegisteredRepo, RegisteredVisibility, RepoListing, RepoSet } from "./records.js";
import { describeExclusions, isMutableExclusion, listOwner, matchRepo, ruleExclusions } from "./repo-set.js";
import type { Selector } from "./selector.js";
import type { AuditWindow } from "../sdk/provider.js";

/**
 * Check 5's rebuild, repo by repo and for the pool as a whole (U8, and the P3 round). Pure apart from the provider
 * calls; the caller (src/core/verify.ts) diffs the rebuilt populations with the manifest.
 *
 * Its lines start with `FAIL `, `INCOMPLETE ` or `WARN ` when they decide the check, and are notes otherwise:
 * - FAIL: the manifest is provably wrong (a window landing it lacks, a frozen head the repository does not have, a
 *   frozen head the push log shows was not the branch's tip at freeze);
 * - INCOMPLETE: part of the population could not be rebuilt, or its completeness could not be established (a gone or
 *   unreadable repo, a token that cannot be shown to see every private repository, a window commit the frozen head
 *   does not reach with no push-time evidence to place it, a rate limit, the verifier's own access failing);
 * - WARN: something a reader must know that this audit cannot decide (an attribute change a retrospective audit
 *   cannot date). Attribute WARNs are collapsed into one summary line; each repo's line is in `verbose`.
 *
 * P3: the frozen head is held to push-time evidence the SCM records itself (src/core/head-proof.ts), never to commit
 * dates or the shape of the history, which the pusher sets.
 */

const short = (sha: string) => `${sha.slice(0, 12)}…`;
const n = (x: number) => x.toLocaleString("en-US");
const eg = (xs: readonly string[]) => `e.g. ${xs.slice(0, 3).join(", ")}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : null);

export interface RebuildArgs {
  /** The repo's path in the manifest (its change ids carry it). */
  repo: string;
  /** Its path now, when it was renamed or transferred since freeze (matched by id). Default: `repo`. */
  current?: string;
  /** The default-branch head the manifest records for it (null: none recorded). */
  frozenHead: string | null;
  /** The manifest records it as empty (no default branch). */
  frozenEmpty: boolean;
  window: AuditWindow;
  selector: Selector;
  signal?: AbortSignal;
  /** Set when this rebuild already follows a rename its probe found (it follows one, never a chain). */
  followedRename?: boolean;
  /** P3: the default branch the head was frozen on, whose push log is read (default: the branch the listing reports). */
  branch?: string;
  /**
   * P3: the freeze span, from the manifest's as-of time to seed round R's publication: the frozen head must have been
   * the branch's tip at some instant of it. Absent: no push log is read, and push-time evidence is "none".
   */
  freezeSpan?: { from: string; until: string };
  /** P3 (pass 2, #6): the verifier's own access is failing elsewhere (the owner listing, /user): an unexplained listing error is INCOMPLETE. */
  verifierFailing?: boolean;
}

export interface RepoRebuild {
  repo: string;
  current: string;
  /** The listing the rebuild uses, from the frozen head when the provider pins it, with ids under `repo`. Null: not rebuilt. */
  listed: ListChangesResult | null;
  /** pinned: walked from the frozen head; unpinned: the provider ignored the head; no-head: the manifest records none; empty. */
  history: "pinned" | "unpinned" | "no-head" | "empty";
  /** The head the rebuild walked (unpinned: the one the provider reported). */
  walked: string | null;
  fail: string[];
  incomplete: string[];
  notes: string[];
  /** P3: what the push log showed about the frozen head (null: not read). */
  proof: HeadProof | null;
}

/** Rewrites change ids and repos listed under the repo's current path back to the manifest's path (a rename since freeze). */
function underName(l: ListChangesResult, from: string, to: string): ListChangesResult {
  if (from === to) return l;
  const fix = (c: ChangeRecord): ChangeRecord => {
    const i = c.id.indexOf(":");
    const rest = c.id.slice(i + 1);
    const id = rest.startsWith(`${from}#`) || rest.startsWith(`${from}@`) ? `${c.id.slice(0, i + 1)}${to}${rest.slice(from.length)}` : c.id;
    return { ...c, id, repo: to };
  };
  const ids = new Map(l.changes.map((c) => [c.id, fix(c).id]));
  return { ...l, changes: l.changes.map(fix), ...(l.unreachable ? { unreachable: l.unreachable.map((id) => ids.get(id) ?? id) } : {}) };
}

/** What a listing failure means for one repo: an empty repo, a rate limit, a gone repo (by probe), the verifier's own access, or a FAIL. */
async function classifyFailure(provider: ScmProvider, e: unknown, a: RebuildArgs & { current: string }, where: "current" | "frozen"): Promise<{ kind: "empty" } | { kind: "renamed"; to: string } | { kind: "fail" | "incomplete"; reason: string }> {
  if (isRepoEmpty(e)) {
    if (a.frozenEmpty) return { kind: "empty" };
    return { kind: "fail", reason: `frozen head ${a.frozenHead ? short(a.frozenHead) : "(none recorded)"} not found: the repository has no default branch now (${message(e)})` };
  }
  if (isTransientFailure(e)) return { kind: "incomplete", reason: `could not be listed (${message(e)}): a rate limit or an outage, not a missing repository; run verify again` };
  const status = (e as { status?: unknown } | null)?.status;
  // P3 (#6): a token the SCM refuses is the verifier's problem, never evidence against the audit.
  if (status === 401) return { kind: "incomplete", reason: `the verifier's token was refused (HTTP 401: ${message(e)}): its access, not the audit, is at fault; verify again with a working token` };
  if (looksUnavailable(e)) {
    const p = await probeRepo(provider, { repo: a.current });
    switch (p.kind) {
      case "exists":
        // The probe found it under another path (a rename, found by the SCM's redirect): list it there.
        if (p.ref.repo.toLowerCase() !== a.current.toLowerCase()) return { kind: "renamed", to: p.ref.repo };
        return { kind: "fail", reason: where === "frozen" && a.frozenHead ? `frozen head ${short(a.frozenHead)} not found (HTTP ${status}: ${message(e)}); the repository itself exists` : `HTTP ${status} on part of the repository although it exists (${message(e)})` };
      case "gone":
        return { kind: "incomplete", reason: `gone: its repo-level metadata answers HTTP ${p.status}${p.status === 404 ? " (deleted, or hidden from this token)" : " (hidden from this token)"}` };
      case "no-access":
        return { kind: "incomplete", reason: `no access: its repo-level metadata answers HTTP ${p.status} (${p.detail}), a permission problem, not a missing repository` };
      case "transient":
        return { kind: "incomplete", reason: `could not be listed (HTTP ${status}), and probing it hit a rate limit or an outage (${p.detail}); run verify again` };
      case "unsupported":
        return { kind: "incomplete", reason: `HTTP ${status} (${message(e)}), and provider ${provider.name} cannot probe a repository (it has no describeRepo), so whether it is gone is unknown` };
      default:
        return { kind: "incomplete", reason: `HTTP ${status} (${message(e)}), and probing it failed too (${p.detail})` };
    }
  }
  const what = where === "frozen" ? "rebuilding from the frozen head" : "listing it";
  if (a.verifierFailing) return { kind: "incomplete", reason: `${what} failed (${message(e)}) while the verifier's own access is failing too (the owner listing, or what its token is): not counted against the audit; verify again with working access` };
  return { kind: "fail", reason: `${what} failed: ${message(e)}` };
}

/**
 * Whether everything on the branch when the window closed is reachable from the frozen head, when the push log shows an
 * update after the close that the SCM does not call a fast-forward (P3): first the cheap proof (the close's tip on the
 * frozen head's first-parent history), else the window listed from the close's tip, every change of which must be in the
 * frozen head's rebuild.
 */
async function closeTipReached(provider: ScmProvider, a: RebuildArgs & { current: string }, list: (head?: string) => Promise<ListChangesResult>, frozen: string, tip: string, rewrites: string[], pinned: ListChangesResult): Promise<{ ok: string } | { fail: string } | { incomplete: string }> {
  if (typeof provider.firstParentPath === "function") {
    try {
      if ((await provider.firstParentPath({ repo: a.current, base: tip, head: frozen, ...(a.signal ? { signal: a.signal } : {}) })) !== null) return { ok: `the branch's tip when the window closed (${short(tip)}) is on the frozen head's first-parent history` };
    } catch {
      // The listing below decides.
    }
  }
  let atClose: ListChangesResult;
  try {
    atClose = await list(tip);
  } catch (e) {
    return { incomplete: `the default branch was updated after the window closed by ${n(rewrites.length)} update(s) ${provider.name} does not call fast-forwards (${eg(rewrites)}), and listing the window from its tip when the window closed (${short(tip)}) failed (${message(e)}): whether the frozen head reaches everything on the branch then is unverified` };
  }
  if (lower(atClose.headSha) !== tip) return { incomplete: `the default branch was updated after the window closed by ${n(rewrites.length)} update(s) ${provider.name} does not call fast-forwards (${eg(rewrites)}), and the provider does not pin history to its tip when the window closed (${short(tip)}): whether the frozen head reaches everything on the branch then is unverified` };
  const have = new Set(pinned.changes.map((c) => c.id));
  const lost = atClose.changes.filter((c) => !have.has(c.id));
  if (lost.length) return { fail: `${n(lost.length)} change(s) on the default branch when the window closed (its tip was ${short(tip)}) are not reachable from the frozen head ${short(frozen)} (${eg(lost.map((c) => c.id))}): the branch was rewritten after the window closed (${eg(rewrites)}), and the frozen head leaves them out` };
  return { ok: `every change on the branch when the window closed (tip ${short(tip)}) is in the frozen head's rebuild` };
}

/**
 * Rebuilds one repo for check 5 (FR7.2; the U8 review's finding 3; P3). The rebuild walks the frozen head, so it
 * reproduces the freeze. It also lists the window from the default branch's current head, and reads the branch's push
 * log (src/core/head-proof.ts):
 * - a pull request merged in the window that the frozen head does not reach FAILs (the listing's `unreachable`, the
 *   stopgap; and any merged in the window that is on the branch now but missing from the frozen rebuild);
 * - a frozen head the push log shows was not the branch's tip during the freeze FAILs;
 * - a window commit on the branch now but not reachable from the frozen head arrived after the window closed (FR7.2,
 *   a note) when the log proves the head; with no usable log it is INCOMPLETE, never PASS and never FAIL.
 */
export async function rebuildRepo(provider: ScmProvider, args: RebuildArgs): Promise<RepoRebuild> {
  const a = { ...args, current: args.current ?? args.repo };
  const out: RepoRebuild = { repo: a.repo, current: a.current, listed: null, history: a.frozenHead ? "pinned" : a.frozenEmpty ? "empty" : "no-head", walked: null, fail: [], incomplete: [], notes: [], proof: null };
  if (a.current !== a.repo) out.notes.push(`${a.repo} is named ${a.current} now (matched by repo id): rebuilt under its new name`);
  const list = async (head?: string) => {
    const l = await listRepoChanges(provider, { repo: a.current, window: a.window, selector: a.selector, ...(a.signal ? { signal: a.signal } : {}), ...(head ? { head } : {}) });
    checkListed(provider.name, l, { repo: a.current, window: a.window, selector: a.selector });
    return l;
  };
  const settle = async (e: unknown, where: "current" | "frozen"): Promise<RepoRebuild> => {
    const c = await classifyFailure(provider, e, a, where);
    if (c.kind === "renamed" && !args.followedRename) return rebuildRepo(provider, { ...args, current: c.to, followedRename: true });
    if (c.kind === "renamed") out.fail.push(`HTTP 404 on ${a.current}, which its probe finds at ${c.to}`);
    else if (c.kind === "empty") out.listed = { changes: [], defaultBranch: "", limitations: [] };
    else out[c.kind].push(c.reason);
    return out;
  };

  let now: ListChangesResult;
  try {
    now = await list();
  } catch (e) {
    return settle(e, "current");
  }
  const head = lower(now.headSha);
  const frozen = lower(a.frozenHead);
  if (frozen === null) {
    out.listed = underName(now, a.current, a.repo);
    out.walked = head;
    if (a.frozenEmpty && now.changes.length) out.history = "no-head";
    return out;
  }
  // The branch moved since freeze (or the provider reports no head now): rebuild from the frozen head.
  let pinned = now;
  if (head !== frozen) {
    try {
      pinned = await list(frozen);
    } catch (e) {
      return settle(e, "frozen");
    }
    const walked = lower(pinned.headSha);
    out.listed = underName(pinned, a.current, a.repo);
    out.walked = walked;
    if (walked !== frozen) {
      out.history = "unpinned";
      return out;
    }
  } else {
    out.listed = underName(now, a.current, a.repo);
    out.walked = head;
  }

  // 1. The stopgap: a pull request merged in the window whose merge commit the frozen head does not reach.
  const unreachable = pinned.unreachable ?? [];
  if (unreachable.length) out.fail.push(`${n(unreachable.length)} pull request(s) merged in the window have a merge commit that is not reachable from the frozen head ${short(frozen)} (${eg(unreachable)}): the frozen head is older than the window's merges, or the branch was rewritten after them`);

  // 2. Push-time evidence for the frozen head.
  if (a.freezeSpan) {
    const proof = await readHeadProof(provider, { repo: a.current, branch: a.branch || pinned.defaultBranch, head: frozen, window: a.window, from: a.freezeSpan.from, until: a.freezeSpan.until, ...(a.signal ? { signal: a.signal } : {}) });
    out.proof = proof;
    if (proof.kind === "disproven") out.fail.push(`the frozen head ${short(frozen)} was not the default branch's tip at freeze: ${proof.reason}`);
    else if (proof.kind === "proven") {
      const rewrites = proof.rewrites.map((e) => `${e.kind} update ${e.id} at ${e.at}`);
      if (proof.rewrites.length && proof.tipAtClose !== null && proof.tipAtClose !== frozen) {
        const r = await closeTipReached(provider, a, list, frozen, proof.tipAtClose, rewrites, pinned);
        if ("fail" in r) out.fail.push(r.fail);
        else if ("incomplete" in r) out.incomplete.push(r.incomplete);
        else out.notes.push(`push log: the default branch was updated after the window closed by ${n(rewrites.length)} update(s) ${provider.name} does not call fast-forwards (${eg(rewrites)}); ${r.ok}`);
      }
      if (proof.forcedInWindow.length) out.notes.push(`push log: the default branch was force-pushed or deleted ${n(proof.forcedInWindow.length)} time(s) inside the window (${eg(proof.forcedInWindow.map((e) => `${e.at}, update ${e.id}`))}): commits those updates took off the branch are not on it, so not in the population`);
    }
  }
  if (head === frozen) return out;
  if (head === null) {
    out.incomplete.push(`provider ${provider.name} reports no head for its listing from the default branch's current head, so window landings after the frozen head ${short(frozen)} cannot be checked`);
    return out;
  }

  // 3. The window as the branch shows it now, against the frozen rebuild.
  const frozenIds = new Set(pinned.changes.map((c) => c.id));
  const nowIds = new Set(now.changes.map((c) => c.id));
  const missing = now.changes.filter((c) => !frozenIds.has(c.id));
  const extra = pinned.changes.filter((c) => !nowIds.has(c.id));
  const prs = missing.filter((c) => c.kind === "pull_request");
  const pushes = missing.filter((c) => c.kind === "direct_push");
  if (prs.length) out.fail.push(`${n(prs.length)} pull request(s) merged in the window are on the default branch now but not in the history from the frozen head ${short(frozen)} (${eg(prs.map((c) => c.id))}): the frozen head hides window landings`);
  const proof = out.proof;
  if (pushes.length) {
    if (proof?.kind === "proven")
      out.notes.push(`${n(pushes.length)} commit(s) dated in the window reached the default branch after the window closed, not through the frozen head (${eg(pushes.map((c) => c.id))}): the push log shows ${short(frozen)} was the branch's tip at freeze (${provenLine(proof)}) and that it reaches everything on the branch when the window closed, so they are not in the population (FR7.2)`);
    else if (proof?.kind !== "disproven")
      out.incomplete.push(`${n(pushes.length)} direct push(es) dated in the window are on the default branch now but not reachable from the frozen head ${short(frozen)} (${eg(pushes.map((c) => c.id))}), and there is no push-time evidence to place them (${proof ? proof.reason : "no push log was read"}): whether they arrived after freeze (FR7.2) or the frozen head hides them is unverified`);
  }
  if (extra.length) {
    if (proof?.kind === "proven") {
      const forced = proof.after.filter((e) => e.kind !== "fast-forward").map((e) => `${e.kind} update ${e.id} at ${e.at}`);
      out.notes.push(`${n(extra.length)} change(s) of the frozen history are not on the default branch now (${eg(extra.map((c) => c.id))}): the branch was rewritten after freeze${forced.length ? ` (${eg(forced)})` : ""}; the push log shows the frozen head was its tip at freeze, so the frozen population stands`);
    } else if (proof?.kind !== "disproven") out.incomplete.push(`${n(extra.length)} change(s) of the frozen history are not on the default branch now (${eg(extra.map((c) => c.id))}): it was rewritten since freeze, or the frozen head is not the branch's, and there is no push-time evidence to tell which (${proof ? proof.reason : "no push log was read"})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pool as a whole
// ---------------------------------------------------------------------------

export interface PoolCheckInput {
  set: RepoSet;
  /** The registration's registeredRepos (empty when it has none). */
  registered: readonly RegisteredRepo[];
  mode: "PROSPECTIVE" | "RETROSPECTIVE";
  repos: readonly ManifestRepo[];
  listing: RepoListing | null;
  gone: readonly GoneRepo[];
  window: AuditWindow;
  selector: Selector;
  concurrency?: number;
  signal?: AbortSignal;
  /** P3: when the registration was made (its signed time): a repo created after it cannot have been registered. */
  registeredAt?: string;
  /**
   * P3: what the registering token could prove it saw (a rule registration). null: the registration does not record it,
   * so the registered set is not shown complete for private or internal repos (INCOMPLETE). Absent: not checked.
   */
  registeredVisibility?: RegisteredVisibility | null;
  /** P3: the freeze span every frozen head is held to (see RebuildArgs.freezeSpan). */
  freezeSpan?: { from: string; until: string };
}

export interface PoolCheck {
  /** Decisive lines (FAIL / INCOMPLETE / WARN prefixes) and notes, in order. */
  lines: string[];
  /** One per manifest repo, in manifest order. */
  rebuilt: RepoRebuild[];
  /** P3 (#10): the lines a summary line in `lines` stands for (one per repo); printed with --verbose, always in --json. */
  verbose: string[];
}

/** The window changes a repo lists now (from its current head), for a repo outside the manifest; or why it could not be counted. */
async function countNow(provider: ScmProvider, repo: string, i: PoolCheckInput): Promise<{ count: number } | { error: string }> {
  try {
    const l = await listRepoChanges(provider, { repo, window: i.window, selector: i.selector, ...(i.signal ? { signal: i.signal } : {}) });
    checkListed(provider.name, l, { repo, window: i.window, selector: i.selector });
    return { count: l.changes.length };
  } catch (e) {
    if (isRepoEmpty(e)) return { count: 0 };
    return { error: message(e) };
  }
}

const nonPublic = (vs: readonly RepoVisibility[]) => vs.filter((v) => v !== "public");

/** One repo outside the pool, as check 5 judges it (see `checkPool`): a decisive line, a collapsible WARN, quiet, or nothing. */
type Verdict = { line: string } | { warn: string; count: number } | { quiet: true } | null;

/**
 * Check 5 over a pool: re-list the owner unfiltered (a rule), establish what the token (and, P3, the registering token)
 * can see, rebuild every manifest repo under its path now (matched by repo id, then by path; a repo the listing no
 * longer holds is probed once), re-examine the repos recorded gone, and hold the pool to the rule and the registered
 * repos. For a repo under the owner now that is not in the pool, with changes in the window:
 * - registered (by id), or recorded by the freeze's own listing as matching the rule: FAIL;
 * - matching the rule now but not in the freeze's listing: INCOMPLETE (P3, #5): it may have been transferred in after
 *   freeze, and no built-in provider gives transfer events to tell that from a listing that left it out;
 * - excluded at freeze only by its archive state, in a prospective audit or when it was created after the registration
 *   (P3, #4): FAIL, because an archived repository is read-only, so it was archived after its window changes;
 * - excluded at freeze by its name or visibility (mutable), created after the registration or with no creation time
 *   from the SCM (P3, #4): INCOMPLETE;
 * - otherwise excluded by a mutable attribute: WARN with the count, collapsed into one summary line (P3, #10);
 * - created after the window closed: no window landing, a note;
 * - excluded by what it is (a fork, another owner): nothing.
 * A rename since freeze is no failure: the repo is matched by its id.
 */
export async function checkPool(provider: ScmProvider, i: PoolCheckInput): Promise<PoolCheck> {
  const lines: string[] = [];
  const verbose: string[] = [];
  const concurrency = i.concurrency ?? 4;
  const rule: RepoSetRule | null = i.set.kind === "rule" ? i.set : null;
  // P3 (#6): the verifier's own access failing (the owner listing, what its token is) turns unexplained listing errors INCOMPLETE.
  let verifierFailing = false;
  // The owner's repositories now, unfiltered.
  let now: RepoRef[] | null = null;
  if (rule) {
    try {
      now = await listOwner(provider, rule);
    } catch (e) {
      now = null;
      verifierFailing = true;
      lines.push(`INCOMPLETE cannot re-list the repositories under ${rule.owner} (${message(e)}): repos added, renamed or excluded since freeze would not be seen`);
    }
    // What this token can see: public listings are complete for anyone; private and internal need the provider's proof.
    const want = nonPublic(rule.visibility);
    if (want.length) {
      const freezer = (v: RepoVisibility) => (i.listing ? ` (the freeze listed ${n(i.listing.visibility[v]?.listed ?? 0)}${i.listing.identity ? `, as ${i.listing.identity}` : ""})` : "");
      if (typeof provider.listingVisibility !== "function") for (const v of want) lines.push(`INCOMPLETE cannot establish that this token sees every ${v} repository under ${rule.owner}: provider ${provider.name} cannot say what its token sees (it has no listingVisibility)${freezer(v)}`);
      else {
        try {
          const seen = await provider.listingVisibility(rule);
          for (const v of want) {
            let proof = seen.visibilities?.[v];
            // P3: held to the SCM's own count of the owner's repositories, where it gives one.
            for (const x of Array.isArray(seen.expected) ? seen.expected : []) {
              if (!now || !Array.isArray(x?.visibilities) || !x.visibilities.includes(v) || typeof x.count !== "number") continue;
              const have = now.filter((r) => x.visibilities.includes(r.visibility)).length;
              if (have < x.count) proof = { complete: false, reason: `the listing shows ${have} ${x.visibilities.join(" or ")} repositories, but ${String(x.source)} counts ${x.count}, so it is missing some` };
            }
            if (proof?.complete === true) lines.push(`${v} repositories under ${rule.owner}: listed completely (${proof.reason})`);
            else lines.push(`INCOMPLETE cannot establish that this token sees every ${v} repository under ${rule.owner}: ${proof?.reason ?? "the provider gave no answer for it"}${freezer(v)}`);
          }
        } catch (e) {
          verifierFailing = true;
          for (const v of want) lines.push(`INCOMPLETE cannot establish that this token sees every ${v} repository under ${rule.owner}: ${message(e)}${freezer(v)}`);
        }
      }
      // P3: what the registering token could see. A repo of a visibility it could not be shown to see in full may be
      // missing from registeredRepos, and nothing else would show it.
      if (i.registeredVisibility !== undefined)
        for (const v of want) {
          const reg = i.registeredVisibility?.visibility?.[v];
          if (i.registeredVisibility === null) lines.push(`INCOMPLETE the registration does not record what its token could see (registeredVisibility), so the registered repo set cannot be shown to hold every ${v} repository under ${rule.owner}`);
          else if (reg?.complete !== true) lines.push(`INCOMPLETE the registered repo set cannot be shown to hold every ${v} repository under ${rule.owner}: at registration, ${reg?.reason ?? "the token's listing gave no proof"}${i.registeredVisibility.identity ? ` (as ${i.registeredVisibility.identity})` : ""}`);
        }
    }
  }
  const nowAsResolved = (now ?? []).map((r) => ({ repo: r.repo, repoId: r.id, ref: r }));

  // Every manifest repo, under its path now.
  const located = await mapPool(i.repos, concurrency, async (m): Promise<{ current: string } | { reason: string }> => {
    if (!now) return { current: m.repo };
    const hit = matchRepo(nowAsResolved, m);
    if (hit) return { current: hit.repo };
    const p = await probeRepo(provider, { repo: m.repo, id: m.repoId });
    if (p.kind === "exists") return { current: p.ref.repo };
    if (p.kind === "gone") return { reason: `gone: not in ${rule!.owner}'s listing, and its repo-level metadata answers HTTP ${p.status}${p.status === 404 ? " (deleted, or hidden from this token)" : " (hidden from this token)"}` };
    if (p.kind === "no-access") return { reason: `no access: not in ${rule!.owner}'s listing, and its repo-level metadata answers HTTP ${p.status} (${p.detail})` };
    if (p.kind === "unsupported") return { reason: `not in ${rule!.owner}'s listing, and provider ${provider.name} cannot probe a repository (it has no describeRepo)` };
    return { reason: `not in ${rule!.owner}'s listing, and probing it failed (${p.detail})` };
  });
  const rebuilt = await mapPool(i.repos, concurrency, async (m, k): Promise<RepoRebuild> => {
    const where = located[k]!;
    if ("reason" in where) return { repo: m.repo, current: m.repo, listed: null, history: "no-head", walked: null, fail: [], incomplete: [where.reason], notes: [], proof: null };
    return rebuildRepo(provider, {
      repo: m.repo,
      current: where.current,
      frozenHead: m.headSha,
      frozenEmpty: m.defaultBranch === "" && m.headSha === null,
      window: i.window,
      selector: i.selector,
      ...(m.defaultBranch ? { branch: m.defaultBranch } : {}),
      ...(i.freezeSpan ? { freezeSpan: i.freezeSpan } : {}),
      ...(verifierFailing ? { verifierFailing } : {}),
      ...(i.signal ? { signal: i.signal } : {}),
    });
  });
  // What the push log showed, in one or two lines (P3).
  const proven = rebuilt.filter((b) => b.proof?.kind === "proven");
  const without = rebuilt.filter((b) => b.proof?.kind === "none");
  if (i.repos.length === 1 && proven.length === 1) lines.push(`push log: the frozen head ${short(i.repos[0]!.headSha!)} was the default branch's tip at freeze: ${provenLine(proven[0]!.proof as Extract<HeadProof, { kind: "proven" }>)}`);
  else if (proven.length) lines.push(`push log: ${n(proven.length)} of ${n(rebuilt.length)} frozen head(s) were their default branch's tip at freeze`);
  if (without.length) lines.push(`push log: no push-time evidence for ${n(without.length)} repo(s) (${without.slice(0, 2).map((b) => `${b.repo}: ${(b.proof as { reason: string }).reason}`).join("; ")}): a window commit pushed there after freeze cannot be placed, and makes that repo INCOMPLETE`);

  // The registered repos recorded gone at freeze.
  for (const g of i.gone) {
    const hit = now ? matchRepo(nowAsResolved, g) : undefined;
    let current: string | null = hit?.repo ?? null;
    if (!current) {
      const p = await probeRepo(provider, { repo: g.repo, id: g.repoId });
      if (p.kind === "exists") current = p.ref.repo;
      else if (p.kind === "gone") lines.push(`INCOMPLETE registered repo ${g.repo} was gone at freeze (HTTP ${g.status} at ${g.probedAt}) and still is (HTTP ${p.status}): its changes in the window are unknown`);
      else lines.push(`INCOMPLETE registered repo ${g.repo} was gone at freeze (HTTP ${g.status} at ${g.probedAt}); probing it now: ${p.kind === "unsupported" ? `provider ${provider.name} has no describeRepo` : p.detail}`);
    }
    if (current) {
      const c = await countNow(provider, current, i);
      if ("error" in c) lines.push(`INCOMPLETE registered repo ${g.repo} was recorded gone at freeze (HTTP ${g.status} at ${g.probedAt}) but exists as ${current}, and its window changes could not be counted (${c.error})`);
      else if (c.count > 0) lines.push(`FAIL registered repo ${g.repo} was recorded gone at freeze (HTTP ${g.status} at ${g.probedAt}) but exists${current !== g.repo ? ` as ${current}` : ""}, with ${n(c.count)} changes in the window that are not in the manifest`);
      else lines.push(`registered repo ${g.repo} was recorded gone at freeze but exists${current !== g.repo ? ` as ${current}` : ""}; it lists no change in the window, so it cannot change the population`);
    }
  }

  // The rule against the repos there are now.
  if (rule && now) {
    const inPool = (r: RepoRef) => i.repos.some((m) => (m.repoId ? m.repoId === r.id : m.repo.toLowerCase() === r.repo.toLowerCase())) || rebuilt.some((b) => b.current.toLowerCase() === r.repo.toLowerCase());
    const isGone = (r: RepoRef) => !!matchRepo(i.gone, { repo: r.repo, repoId: r.id });
    const closes = Date.parse(i.window.closesAt);
    const regAt = i.registeredAt ? Date.parse(i.registeredAt) : NaN;
    const prospective = i.mode === "PROSPECTIVE";
    const retro = (one: boolean) =>
      i.mode === "RETROSPECTIVE"
        ? "the registration came after the window opened, so a change made before it cannot be detected"
        : i.registered.length
          ? `${one ? "it was" : "they were"} not among the repos the rule matched at registration, so ${one ? "it was" : "they were"} excluded then too`
          : "the registration does not record the repos it matched, so a change after registration cannot be told from one before";
    const examine = now.filter((r) => !inPool(r) && !isGone(r));
    const verdicts = await mapPool(examine, concurrency, async (r): Promise<Verdict> => {
      const atFreeze = i.listing ? matchRepo(i.listing.repos, { repo: r.repo, repoId: r.id }) : undefined;
      const registered = matchRepo(i.registered, { repo: r.repo, repoId: r.id });
      const exclNow = ruleExclusions(rule, r);
      if (registered) {
        const c = await countNow(provider, r.repo, i);
        if ("error" in c) return { line: `INCOMPLETE registered repo ${r.repo} is not in the manifest, and its window changes could not be counted (${c.error})` };
        return { line: c.count > 0 ? `FAIL registered repo ${r.repo} is not in the manifest (${n(c.count)} changes landed in the window)` : `registered repo ${r.repo} is not in the manifest; it lists no change in the window, so it cannot change the population` };
      }
      // What kept it out of the pool at freeze: what the freeze's listing recorded, else what excludes it now.
      const excl = atFreeze ? atFreeze.excludedBy : exclNow;
      const fixed = excl.filter((c) => !isMutableExclusion(c));
      if (fixed.length && fixed.every((c) => exclNow.includes(c))) return null; // excluded by what it is (a fork, another owner)
      if (fixed.length) {
        // The freeze's listing says it was a fork (or not the owner's) then, and it is not now: what a repo is does not
        // change that way, so the record is wrong or the SCM changed it; its window changes are then unaccounted for.
        const c = await countNow(provider, r.repo, i);
        if ("error" in c) return { line: `INCOMPLETE repo ${r.repo} was excluded at freeze as ${describeExclusions(fixed)}, which it is not now; its window changes could not be counted (${c.error})` };
        return c.count === 0 ? null : { line: `INCOMPLETE repo ${r.repo} was excluded at freeze as ${describeExclusions(fixed)} (the manifest's listing records it so), which it is not now, and ${n(c.count)} of its changes landed in the window: the record is wrong, or the SCM changed what the repo is` };
      }
      const created = r.createdAt ? Date.parse(r.createdAt) : NaN;
      if (Number.isFinite(created) && created >= closes) return exclNow.length === 0 ? { line: `repo ${r.repo} matches the registered rule but is not in the manifest; it was created ${r.createdAt}, after the window closed, so it cannot hold a window landing` } : null;
      const seen = atFreeze ? (excl.length ? `was excluded at freeze (${describeExclusions(excl)})` : "matched the rule in the freeze's own listing") : "was not in the freeze's listing";
      const c = await countNow(provider, r.repo, i);
      if ("error" in c) return { line: `INCOMPLETE repo ${r.repo} ${seen}${exclNow.length ? `, is excluded by ${describeExclusions(exclNow)} now` : " and the rule matches it now"}; its window changes could not be counted (${c.error})` };
      if (c.count === 0) return excl.length ? { quiet: true } : { line: `repo ${r.repo} matches the registered rule but is not in the manifest; it lists no change in the window, so it cannot change the population` };
      const changes = `${n(c.count)} of its changes landed in the window`;
      if (excl.length === 0) {
        if (atFreeze) return { line: `FAIL repo ${r.repo} matched the registered rule in the freeze's own listing, but it is not in the manifest (${n(c.count)} changes landed in the window)` };
        return { line: `INCOMPLETE repo ${r.repo} matches the registered rule but ${seen}, and ${changes}: it may have been transferred in after freeze, and provider ${provider.name} gives no transfer events to tell that from a freeze listing that left it out` };
      }
      // Excluded only by attributes its owners can change.
      const afterReg = Number.isFinite(created) && Number.isFinite(regAt) ? created > regAt : null;
      if (atFreeze && excl.length === 1 && excl[0] === "archived" && (prospective || afterReg === true))
        return { line: `FAIL repo ${r.repo} was archived at freeze (the manifest's listing records it so), yet ${changes}${afterReg ? `, after it was created on ${r.createdAt}, after the registration` : ", all after the registration"}: an archived repository is read-only, so it was archived after them, and archiving it took them out of the pool` };
      if (afterReg !== false)
        return { line: `INCOMPLETE repo ${r.repo} ${seen}${atFreeze ? "" : `, is excluded by ${describeExclusions(exclNow)} now`}, and ${changes}, but ${afterReg === null ? `provider ${provider.name} gives no creation time, so whether it existed at registration is unknown` : `it was created on ${r.createdAt}, after the registration, so it could not be registered`}: whether it was excluded when its changes landed is unverified` };
      const then = atFreeze ? (JSON.stringify(atFreeze.excludedBy) === JSON.stringify(exclNow) ? "" : atFreeze.excludedBy.length ? `, by ${describeExclusions(atFreeze.excludedBy)} at freeze` : ", and the rule matched it at freeze") : ", and the freeze's listing did not show it";
      const what = exclNow.length ? `is excluded by ${describeExclusions(exclNow)} now${then}` : `was excluded by ${describeExclusions(excl)} at freeze and the rule matches it now`;
      return { warn: `WARN repo ${r.repo} ${what}, an attribute its owners can change, and has ${n(c.count)} changes in the window that are not in the population (${retro(true)})`, count: c.count };
    });
    const warns: { warn: string; count: number }[] = [];
    let quiet = 0;
    for (const v of verdicts) {
      if (!v) continue;
      if ("line" in v) lines.push(v.line);
      else if ("warn" in v) warns.push(v);
      else quiet++;
    }
    // P3 (#10): one line for the attribute-excluded repos with window changes; each repo's line is in `verbose`.
    if (warns.length) {
      const names = warns.map((w) => /^WARN repo (\S+)/.exec(w.warn)?.[1] ?? "?");
      lines.push(`WARN ${n(warns.length)} repo(s) excluded only by attributes their owners can change (name, archive state, visibility) have ${n(warns.reduce((k, w) => k + w.count, 0))} changes in the window that are not in the population (${eg(names)}): ${retro(warns.length === 1)}; each is listed with --verbose and in --json`);
      verbose.push(...warns.map((w) => w.warn));
    }
    if (quiet) lines.push(`${n(quiet)} repo(s) excluded only by attributes their owners can change (name, archive state, visibility) list no change in the window`);
  }
  return { lines, rebuilt, verbose };
}
