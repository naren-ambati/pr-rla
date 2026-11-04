import { isRepoEmpty, type ChangeRecord, type FirstParentCommit, type ListChangesResult, type RepoRef, type RepoSetRule, type RepoVisibility, type ScmProvider } from "../sdk/provider.js";
import { isTransientFailure, looksUnavailable, probeRepo } from "./failures.js";
import { checkListed, listRepoChanges, mapPool } from "./population.js";
import type { GoneRepo, ManifestRepo, RegisteredRepo, RepoListing, RepoSet } from "./records.js";
import { describeExclusions, isMutableExclusion, listOwner, matchRepo, ruleExclusions } from "./repo-set.js";
import type { Selector } from "./selector.js";
import type { AuditWindow } from "../sdk/provider.js";

/**
 * Check 5's rebuild, repo by repo and for the pool as a whole (U8 and the review's findings 1–8). Pure apart from the
 * provider calls; the caller (src/core/verify.ts) diffs the rebuilt populations with the manifest.
 *
 * Its lines start with `FAIL `, `INCOMPLETE ` or `WARN ` when they decide the check, and are notes otherwise:
 * - FAIL: the manifest is provably wrong (a window landing it lacks, a frozen head the repository does not have);
 * - INCOMPLETE: part of the population could not be rebuilt, or its completeness could not be established (a gone or
 *   unreadable repo, a token that cannot be shown to see every private repository, a rate limit);
 * - WARN: something a reader must know that this audit cannot decide (an attribute change a retrospective audit
 *   cannot date).
 */

const short = (sha: string) => `${sha.slice(0, 12)}…`;
const n = (x: number) => x.toLocaleString("en-US");
const eg = (xs: readonly string[]) => `e.g. ${xs.slice(0, 3).join(", ")}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  return { ...l, changes: l.changes.map(fix) };
}

/** What a listing failure means for one repo: an empty repo, a rate limit, a gone repo (by probe), or a FAIL. */
async function classifyFailure(provider: ScmProvider, e: unknown, a: RebuildArgs & { current: string }, where: "current" | "frozen"): Promise<{ kind: "empty" } | { kind: "renamed"; to: string } | { kind: "fail" | "incomplete"; reason: string }> {
  if (isRepoEmpty(e)) {
    if (a.frozenEmpty) return { kind: "empty" };
    return { kind: "fail", reason: `frozen head ${a.frozenHead ? short(a.frozenHead) : "(none recorded)"} not found: the repository has no default branch now (${message(e)})` };
  }
  if (isTransientFailure(e)) return { kind: "incomplete", reason: `could not be listed (${message(e)}): a rate limit or an outage, not a missing repository; run verify again` };
  if (looksUnavailable(e)) {
    const status = (e as { status?: unknown }).status;
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
  return { kind: "fail", reason: `${where === "frozen" ? "rebuilding from the frozen head" : "listing it"} failed: ${message(e)}` };
}

/**
 * Rebuilds one repo for check 5 (FR7.2, and the review's finding 3). The rebuild walks the frozen head, so it
 * reproduces the freeze. It also lists the window from the default branch's current head, with the provider's own
 * landing-time definition: a window change reachable now but not from the frozen head FAILs (a pull request always; a
 * direct push unless the first-parent commits after the frozen head are all dated after the window, which is a merge
 * after freeze of work dated in the window, FR7.2), and it is INCOMPLETE where the provider cannot tell the two apart.
 */
export async function rebuildRepo(provider: ScmProvider, args: RebuildArgs): Promise<RepoRebuild> {
  const a = { ...args, current: args.current ?? args.repo };
  const out: RepoRebuild = { repo: a.repo, current: a.current, listed: null, history: a.frozenHead ? "pinned" : a.frozenEmpty ? "empty" : "no-head", walked: null, fail: [], incomplete: [], notes: [] };
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
  const head = typeof now.headSha === "string" ? now.headSha.toLowerCase() : null;
  const frozen = a.frozenHead?.toLowerCase() ?? null;
  if (frozen === null || head === frozen) {
    out.listed = underName(now, a.current, a.repo);
    out.walked = head;
    if (frozen === null && a.frozenEmpty && now.changes.length) out.history = "no-head";
    return out;
  }
  // The branch moved since freeze (or the provider reports no head now): rebuild from the frozen head.
  let pinned: ListChangesResult;
  try {
    pinned = await list(frozen);
  } catch (e) {
    return settle(e, "frozen");
  }
  const walked = typeof pinned.headSha === "string" ? pinned.headSha.toLowerCase() : null;
  out.listed = underName(pinned, a.current, a.repo);
  out.walked = walked;
  if (walked !== frozen) {
    out.history = "unpinned";
    return out;
  }
  if (head === null) {
    out.incomplete.push(`provider ${provider.name} reports no head for its listing from the default branch's current head, so window landings after the frozen head ${short(frozen)} cannot be checked`);
    return out;
  }
  const frozenIds = new Set(pinned.changes.map((c) => c.id));
  const nowIds = new Set(now.changes.map((c) => c.id));
  const missing = now.changes.filter((c) => !frozenIds.has(c.id));
  const extra = pinned.changes.filter((c) => !nowIds.has(c.id));
  if (!missing.length && !extra.length) return out;
  const prs = missing.filter((c) => c.kind === "pull_request");
  const pushes = missing.filter((c) => c.kind === "direct_push");
  if (prs.length) out.fail.push(`${n(prs.length)} pull request(s) merged in the window are on the default branch now but not in the history from the frozen head ${short(frozen)} (${eg(prs.map((c) => c.id))}): the frozen head hides window landings`);
  if (!pushes.length && !extra.length) return out;
  let path: FirstParentCommit[] | null | undefined;
  if (typeof provider.firstParentPath !== "function") path = undefined;
  else {
    try {
      path = await provider.firstParentPath({ repo: a.current, base: frozen, head, ...(a.signal ? { signal: a.signal } : {}) });
    } catch (e) {
      out.incomplete.push(`comparing the frozen head ${short(frozen)} with the current head ${short(head)} failed (${message(e)}), so ${n(pushes.length + extra.length)} differing change(s) are unverified`);
      return out;
    }
  }
  if (path === undefined) {
    if (pushes.length) out.incomplete.push(`${n(pushes.length)} direct push(es) dated in the window are on the default branch now but not reachable from the frozen head ${short(frozen)} (${eg(pushes.map((c) => c.id))}), and provider ${provider.name} cannot report first-parent history (no firstParentPath): whether they arrived after freeze (FR7.2) or the frozen head hides them is unverified`);
    if (extra.length) out.incomplete.push(`${n(extra.length)} change(s) of the frozen history are not on the default branch now (${eg(extra.map((c) => c.id))}): it was rewritten since freeze, or the frozen head is not the branch's`);
    return out;
  }
  if (path === null) {
    if (pushes.length) out.fail.push(`the frozen head ${short(frozen)} is not on the default branch's first-parent history (its head is ${short(head)} now), and ${n(pushes.length)} direct push(es) dated in the window are reachable now but not from it (${eg(pushes.map((c) => c.id))})`);
    if (extra.length) out.incomplete.push(`the frozen head ${short(frozen)} is not on the default branch's first-parent history (its head is ${short(head)} now), and ${n(extra.length)} change(s) of the frozen history are not on the branch now (${eg(extra.map((c) => c.id))})`);
    return out;
  }
  const closes = Date.parse(a.window.closesAt);
  const early = path.filter((c) => !(Date.parse(c.committedAt) >= closes));
  if (pushes.length && early.length) out.fail.push(`${n(pushes.length)} direct push(es) dated in the window are on the default branch now but not reachable from the frozen head ${short(frozen)} (${eg(pushes.map((c) => c.id))}), and ${n(early.length)} first-parent commit(s) after the frozen head are dated before the window closed (${short(early[0]!.sha)} at ${early[0]!.committedAt}): the frozen head is older than the window's landings`);
  else if (pushes.length) out.notes.push(`${n(pushes.length)} commit(s) dated in the window arrived on the default branch after it closed, through ${n(path.length)} first-parent commit(s) after the frozen head, all dated after the window (newest ${short(path[0]!.sha)} at ${path[0]!.committedAt}): not in the population (FR7.2)`);
  if (extra.length) out.incomplete.push(`${n(extra.length)} change(s) of the frozen history are not reachable from the current head (${eg(extra.map((c) => c.id))})`);
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
}

export interface PoolCheck {
  /** Decisive lines (FAIL / INCOMPLETE / WARN prefixes) and notes, in order. */
  lines: string[];
  /** One per manifest repo, in manifest order. */
  rebuilt: RepoRebuild[];
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

/**
 * Check 5 over a pool: re-list the owner unfiltered (a rule), establish what the token can see, rebuild every manifest
 * repo under its path now (matched by repo id, then by path; a repo the listing no longer holds is probed once),
 * re-examine the repos recorded gone, and hold the pool to the rule and the registered repos:
 * - a registered repo outside the manifest, or recorded gone but there, with changes in the window: FAIL;
 * - a repo the rule matches now, unseen by the freeze, with changes in the window: FAIL, unless the SCM says it was
 *   created after the window closed;
 * - a repo excluded at freeze or now only by an attribute its owners can change (name, archive state, visibility), with
 *   changes in the window, and not registered: WARN with the count (a retrospective audit cannot date the change);
 * - a rename since freeze is no failure: the repo is matched by its id.
 */
export async function checkPool(provider: ScmProvider, i: PoolCheckInput): Promise<PoolCheck> {
  const lines: string[] = [];
  const concurrency = i.concurrency ?? 4;
  const rule: RepoSetRule | null = i.set.kind === "rule" ? i.set : null;
  // The owner's repositories now, unfiltered.
  let now: RepoRef[] | null = null;
  if (rule) {
    try {
      now = await listOwner(provider, rule);
    } catch (e) {
      now = null;
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
            const proof = seen.visibilities?.[v];
            if (proof?.complete === true) lines.push(`${v} repositories under ${rule.owner}: listed completely (${proof.reason})`);
            else lines.push(`INCOMPLETE cannot establish that this token sees every ${v} repository under ${rule.owner}: ${proof?.reason ?? "the provider gave no answer for it"}${freezer(v)}`);
          }
        } catch (e) {
          for (const v of want) lines.push(`INCOMPLETE cannot establish that this token sees every ${v} repository under ${rule.owner}: ${message(e)}${freezer(v)}`);
        }
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
    if ("reason" in where) return { repo: m.repo, current: m.repo, listed: null, history: "no-head", walked: null, fail: [], incomplete: [where.reason], notes: [] };
    return rebuildRepo(provider, { repo: m.repo, current: where.current, frozenHead: m.headSha, frozenEmpty: m.defaultBranch === "" && m.headSha === null, window: i.window, selector: i.selector, ...(i.signal ? { signal: i.signal } : {}) });
  });

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
    const retro =
      i.mode === "RETROSPECTIVE"
        ? "the registration came after the window opened, so a change made before it cannot be detected"
        : i.registered.length
          ? "it was not among the repos the rule matched at registration"
          : "the registration does not record the repos it matched, so a change after registration cannot be told from one before";
    const quietMutable: string[] = [];
    const examine = (now ?? []).filter((r) => !inPool(r) && !isGone(r));
    const verdicts = await mapPool(examine, concurrency, async (r): Promise<string | null> => {
      const atFreeze = i.listing ? matchRepo(i.listing.repos, { repo: r.repo, repoId: r.id }) : undefined;
      const registered = matchRepo(i.registered, { repo: r.repo, repoId: r.id });
      const exclNow = ruleExclusions(rule, r);
      if (registered) {
        const c = await countNow(provider, r.repo, i);
        if ("error" in c) return `INCOMPLETE registered repo ${r.repo} is not in the manifest, and its window changes could not be counted (${c.error})`;
        return c.count > 0 ? `FAIL registered repo ${r.repo} is not in the manifest (${n(c.count)} changes landed in the window)` : `registered repo ${r.repo} is not in the manifest; it lists no change in the window, so it cannot change the population`;
      }
      if (exclNow.length === 0) {
        if (atFreeze && atFreeze.excludedBy.length) {
          const c = await countNow(provider, r.repo, i);
          if ("error" in c) return `INCOMPLETE repo ${r.repo} was excluded at freeze (${describeExclusions(atFreeze.excludedBy)}) and the rule matches it now; its window changes could not be counted (${c.error})`;
          return c.count > 0 ? `WARN repo ${r.repo} was excluded at freeze (${describeExclusions(atFreeze.excludedBy)}) and the rule matches it now: its ${n(c.count)} changes in the window are not in the population (${retro})` : null;
        }
        if (r.createdAt && Date.parse(r.createdAt) >= closes) return `repo ${r.repo} matches the registered rule but is not in the manifest; it was created ${r.createdAt}, after the window closed, so it cannot hold a window landing`;
        const c = await countNow(provider, r.repo, i);
        if ("error" in c) return `INCOMPLETE repo ${r.repo} matches the registered rule but is not in the manifest, and its window changes could not be counted (${c.error})`;
        return c.count > 0 ? `FAIL repo ${r.repo} matches the registered rule but is not in the manifest (${n(c.count)} changes landed in the window)` : `repo ${r.repo} matches the registered rule but is not in the manifest; it lists no change in the window, so it cannot change the population`;
      }
      const mutableNow = exclNow.every(isMutableExclusion);
      const mutableThen = !!atFreeze && atFreeze.excludedBy.length > 0 && atFreeze.excludedBy.every(isMutableExclusion);
      if (!mutableNow && !mutableThen) return null; // excluded by what it is (a fork, another owner) both times
      const c = await countNow(provider, r.repo, i);
      const then = atFreeze ? (JSON.stringify(atFreeze.excludedBy) === JSON.stringify(exclNow) ? "" : atFreeze.excludedBy.length ? `, by ${describeExclusions(atFreeze.excludedBy)} at freeze` : ", and the rule matched it at freeze") : i.listing ? ", and the freeze's listing did not show it" : "";
      if ("error" in c) return `INCOMPLETE repo ${r.repo} is excluded by ${describeExclusions(exclNow)} now${then}; its window changes could not be counted (${c.error})`;
      if (c.count === 0) {
        quietMutable.push(r.repo);
        return null;
      }
      return `WARN repo ${r.repo} is excluded by ${describeExclusions(exclNow)} now${then}, an attribute its owners can change, and has ${n(c.count)} changes in the window that are not in the population (${retro})`;
    });
    for (const v of verdicts) if (v) lines.push(v);
    if (quietMutable.length) lines.push(`${n(quietMutable.length)} repo(s) excluded only by attributes their owners can change (name, archive state, visibility) list no change in the window`);
  }
  return { lines, rebuilt };
}
