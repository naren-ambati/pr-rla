import { basename } from "node:path";
import {
  LEDGER_API_VERSION,
  analyzeDrawHistory,
  compareByTimeThenId,
  type DrawForLedger,
  type Ledger,
  type LedgerActor,
  type LedgerContext,
  type LedgerHistoryEvent,
  type LedgerIntegrityReport,
  type PublishContext,
  type Verdict,
  type VerdictEvent,
  type VerdictLabelEvent,
} from "../sdk/ledger.js";
import { mapLimit } from "./http.js";
import { INDEX_FILE, findMarker, indexProblems, issueBody, issueTitle, openIndex, planIssues, readIndex, writeIndex, type IndexedIssue, type IndexedLabel, type LedgerIndex } from "./issue-index.js";

/**
 * The issue-tracker ledgers (FR4.1–FR4.3, functional-design.md §U4): one issue per drawn
 * change, verdicts as labels, read from the label-event history (never the current labels).
 * Tracker specifics live in the adapters (./github-issues, ./gitlab-issues); everything here is
 * shared, so both apply the same rules.
 */

export interface TrackerLabelEvent {
  id: string;
  /** Server time, ISO 8601 UTC. */
  at: string;
  action: "add" | "remove" | "transfer";
  /** The label's name as the event reports it; null when the tracker erased it (GitLab nulls deleted labels). */
  labelName: string | null;
  /** The label's id, when the event carries one (GitLab does; GitHub's REST events do not). */
  labelId: string | null;
  actor: LedgerActor;
  /** GitHub's performed_via_github_app slug. */
  viaApp: string | null;
}

export type TrackerIssue =
  | {
      state: "ok";
      /** The tracker's own id of the issue it returned (GitHub node id, GitLab id): the index must name this one. */
      id: string;
      /** The issue's number (GitHub) or iid (GitLab) as the tracker returned it. */
      number: number | string;
      /** The issue body, where the draw's marker lives. null: the tracker gave none. */
      body: string | null;
      currentLabels: string[];
      events: TrackerLabelEvent[];
    }
  | { state: "deleted"; detail: string }
  | { state: "moved"; detail: string };

export interface ExistingDrawIssue extends Omit<IndexedIssue, "draw" | "changeId"> {
  body: string | null;
}

export interface LabelNames {
  pass: string;
  fail: string;
  draw: string;
}

/** What one read of the tracker gives every read method (one fetch per command). */
interface Snapshot {
  verdicts: VerdictEvent[];
  history: LedgerHistoryEvent[];
  failures: string[];
  warnings: string[];
  notes: string[];
}

export abstract class IssueTrackerLedger implements Ledger {
  readonly apiVersion = LEDGER_API_VERSION;
  abstract readonly name: string;
  /** e.g. `https://api.github.com/repos/acme/audit`: recorded in the index. */
  abstract readonly tracker: string;
  /** e.g. `acme/audit`, for messages. */
  abstract readonly where: string;
  private snapshot: Promise<Snapshot> | null = null;

  constructor(
    protected readonly labels: LabelNames,
    protected readonly ctx: LedgerContext,
  ) {}

  // --- adapter ---------------------------------------------------------------
  /** Whether this tracker treats label names as one label when only their case differs (GitHub does, GitLab does not). */
  protected readonly caseInsensitiveLabels: boolean = false;
  /** The label as the tracker has it now: its id and its name exactly as stored (a case-insensitive lookup returns the stored case). */
  protected abstract lookupLabel(name: string): Promise<{ id: string; name: string } | null>;
  /** Whether the token can read the audit repo or project at all: told apart from "issue deleted" when an issue answers 404. */
  protected abstract canReadTracker(): Promise<boolean>;
  protected abstract createLabel(name: string, role: Verdict | "draw"): Promise<{ id: string; name: string }>;
  protected abstract listDrawIssues(drawLabel: string): Promise<ExistingDrawIssue[]>;
  protected abstract createIssue(title: string, body: string, drawLabel: string): Promise<Omit<IndexedIssue, "draw" | "changeId">>;
  protected abstract readIssue(issue: IndexedIssue): Promise<TrackerIssue>;
  protected abstract applyLabel(issue: IndexedIssue, label: string): Promise<void>;
  protected abstract addNote(issue: IndexedIssue, body: string): Promise<void>;

  // --- reads -----------------------------------------------------------------
  async readVerdicts(): Promise<VerdictEvent[]> {
    return (await this.load()).verdicts;
  }

  async verifyIntegrity(): Promise<LedgerIntegrityReport> {
    const s = await this.load();
    return { ok: s.failures.length === 0, findings: [...s.failures, ...s.notes], warnings: s.warnings, tamperTrail: true };
  }

  async readHistory(): Promise<LedgerHistoryEvent[]> {
    return (await this.load()).history;
  }

  private load(): Promise<Snapshot> {
    this.snapshot ??= this.read().catch((e: unknown) => {
      this.snapshot = null;
      throw e;
    });
    return this.snapshot;
  }

  private sameName(a: string, b: string): boolean {
    return this.caseInsensitiveLabels ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /** pass/fail for a verdict label, null for an event whose label the tracker erased, undefined for any other label. */
  private verdictOf(index: LedgerIndex, e: TrackerLabelEvent): Verdict | null | undefined {
    if (e.labelName === null && e.labelId === null) return null;
    for (const v of ["pass", "fail"] as const) {
      const l = index.labels[v];
      if (e.labelId !== null && l.id !== null ? e.labelId === l.id : e.labelName !== null && this.sameName(e.labelName, l.name)) return v;
    }
    return undefined;
  }

  private async read(): Promise<Snapshot> {
    const s: Snapshot = { verdicts: [], history: [], failures: [], warnings: [], notes: [] };
    const index = readIndex(this.ctx.windowDir);
    if (!index) return s;
    s.failures.push(...indexProblems(index));
    for (const v of ["pass", "fail"] as const) {
      const want = index.labels[v];
      const now = await this.lookupLabel(want.name);
      if (!now) s.failures.push(`verdict label "${want.name}" no longer exists in ${this.where} (deleted or renamed); a verdict under a deleted or renamed label cannot be checked`);
      else if (want.id !== null && now.id !== want.id) s.failures.push(`verdict label "${want.name}" in ${this.where} is not the label the draws were published with (id ${want.id}, now ${now.id}): it was renamed or removed, and a new label took its name`);
      else if (now.name !== want.name) s.warnings.push(`verdict label "${want.name}" is named "${now.name}" in ${this.where} now (${this.sameName(now.name, want.name) ? "renamed, case only; events under either spelling count" : "renamed"}); the draws were published under "${want.name}"`);
    }
    let readable: Promise<boolean> | null = null;
    const issues = await mapLimit(index.issues, 4, async (i) => ({ i, t: await this.readIssue(i) }));
    for (const { i, t } of issues) {
      if (t.state === "deleted") {
        readable ??= this.canReadTracker();
        if (await readable) s.failures.push(`draw #${i.draw} issue ${i.url} deleted (${t.detail}); its history is gone`);
        else s.failures.push(`draw #${i.draw} issue ${i.url} answered ${t.detail}, and the token cannot read ${this.where} either: the token has no access to the audit ${this.where.includes("/") ? "repo" : "project"} (a private one answers not-found to a token that cannot see it), so this is not evidence that the issue was deleted; give verify a token that can read it`);
        continue;
      }
      if (t.state === "moved") {
        s.failures.push(`draw #${i.draw} issue ${i.url} moved (${t.detail}); its history left ${this.where}`);
        continue;
      }
      // The index is a hint, not a witness: the tracker's answer must be the issue the index names, and the issue must say it is this draw's.
      if (String(t.id) !== String(i.id) || String(t.number) !== String(i.number)) {
        s.failures.push(`draw #${i.draw}: ${this.where} answered issue ${String(t.number)} (id ${t.id}) for the index's ${String(i.number)} (id ${i.id}); the index does not describe this issue`);
        continue;
      }
      if (!index.foreignIssues) {
        const marker = findMarker(t.body, index.window);
        if (!marker) s.failures.push(`draw #${i.draw} issue ${i.url} carries no pr-rla marker for window ${index.window} in its body (edited away, or not the issue pr-rla opened for this draw)`);
        else if (marker.draw !== i.draw || marker.changeId !== i.changeId) s.failures.push(`draw #${i.draw} issue ${i.url} says in its body that it is draw #${marker.draw} (${marker.changeId}), not draw #${i.draw} (${i.changeId}): the index points the draw at another draw's issue`);
        if (!marker || marker.draw !== i.draw || marker.changeId !== i.changeId) continue;
      }
      const labelEvents: VerdictLabelEvent[] = [];
      const otherLabels = new Map<string, number>();
      for (const e of t.events) {
        if (e.action === "transfer") {
          s.history.push({ id: e.id, at: e.at, actor: e.actor, action: "transfer", label: null, draw: i.draw });
          s.failures.push(`draw #${i.draw} issue ${i.url} was transferred at ${e.at}`);
          continue;
        }
        const verdict = this.verdictOf(index, e);
        if (verdict === undefined) {
          const isDraw = e.labelId !== null && index.labels.draw.id !== null ? e.labelId === index.labels.draw.id : e.labelName !== null && this.sameName(e.labelName, index.labels.draw.name);
          if (!isDraw && !index.foreignIssues) otherLabels.set(e.labelName ?? `id ${e.labelId}`, (otherLabels.get(e.labelName ?? `id ${e.labelId}`) ?? 0) + 1);
          continue;
        }
        const provenance = { level: "account" as const, source: "scm-label-event", ...(e.actor.id !== undefined ? { actorId: e.actor.id } : {}), viaApp: e.viaApp, eventId: e.id };
        labelEvents.push({ id: e.id, at: e.at, action: e.action, verdict, reviewer: e.actor.login, provenance });
        s.history.push({ id: e.id, at: e.at, actor: e.actor, action: e.action, label: verdict === null ? null : index.labels[verdict].name, draw: i.draw });
        if (e.action === "add" && verdict !== null) s.verdicts.push({ draw: i.draw, changeId: i.changeId, verdict, protocolSha256: index.protocolSha256, reviewer: e.actor.login, recordedAt: e.at, provenance });
      }
      for (const [name, n] of otherLabels)
        s.warnings.push(`draw #${i.draw}: ${n} label event(s) for "${name}", which is not the ${index.labels.pass.name}, ${index.labels.fail.name} or ${index.labels.draw.name} label; not counted (a verdict label renamed beyond its case, or a stray label, looks like this)`);
      const a = analyzeDrawHistory(i.draw, labelEvents, { reviewers: this.ctx.reviewers ?? null, labelOf: (v) => index.labels[v].name });
      s.failures.push(...a.failures);
      s.warnings.push(...a.warnings);
      s.notes.push(...a.notes);
      for (const v of ["pass", "fail"] as const)
        if (t.currentLabels.some((l) => this.sameName(l, index.labels[v].name)) && !labelEvents.some((e) => e.action === "add" && e.verdict === v))
          s.warnings.push(`draw #${i.draw}: the issue carries ${index.labels[v].name} but its label history has no event adding it (label history incomplete); that verdict is not counted`);
    }
    s.verdicts.sort((a, b) => compareByTimeThenId({ at: a.recordedAt, id: a.provenance?.eventId ?? "" }, { at: b.recordedAt, id: b.provenance?.eventId ?? "" }));
    s.history.sort(compareByTimeThenId);
    return s;
  }

  // --- writes ----------------------------------------------------------------
  /**
   * Opens one issue per newly drawn change, in draw order, recording each in the index as soon
   * as it exists. Idempotent: indexed draws are skipped, and an issue created before a lost
   * response is found by its body marker before anything is created.
   */
  async publishDraws(draws: DrawForLedger[], context?: PublishContext): Promise<void> {
    if (!context?.protocolSha256) throw new Error(`${this.name}: publishDraws needs the registration's protocol hash (run it through "pr-rla sample")`);
    const window = context.window || basename(this.ctx.windowDir);
    const index = openIndex(this.ctx.windowDir, {
      ledger: this.name,
      tracker: this.tracker,
      window,
      protocolSha256: context.protocolSha256,
      registrationSha256: context.registrationSha256 ?? null,
      labels: { pass: { name: this.labels.pass, id: null }, fail: { name: this.labels.fail, id: null }, draw: { name: this.labels.draw, id: null } },
    });
    this.snapshot = null;
    for (const role of ["pass", "fail", "draw"] as const) {
      const l: IndexedLabel = index.labels[role];
      if (l.id !== null) continue;
      let found = await this.lookupLabel(l.name);
      if (!found) {
        try {
          found = await this.createLabel(l.name, role);
        } catch (e) {
          found = await this.lookupLabel(l.name); // created meanwhile by another run
          if (!found) throw e;
        }
      }
      index.labels[role] = { name: l.name, id: found.id };
    }
    writeIndex(this.ctx.windowDir, index);
    const plan = planIssues(draws, index);
    if (plan.create.length) {
      const byMarker = async () => {
        const m = new Map<string, ExistingDrawIssue>();
        for (const x of await this.listDrawIssues(this.labels.draw)) {
          const k = findMarker(x.body, window);
          if (k) m.set(`${k.draw}|${k.changeId}`, x);
        }
        return m;
      };
      let existing = await byMarker();
      for (const d of plan.create) {
        const key = `${d.draw}|${d.changeId}`;
        let made: Omit<IndexedIssue, "draw" | "changeId"> | undefined = existing.get(key);
        if (!made) {
          try {
            made = await this.createIssue(issueTitle(d), issueBody(d, { ...context, window }, this.labels), this.labels.draw);
          } catch (e) {
            existing = await byMarker();
            made = existing.get(key);
            if (!made) throw new Error(`${(e as Error).message}\n  the issue for draw #${d.draw} may or may not exist: run "pr-rla sample" again; it finds issues already opened by their marker before opening any`);
          }
          this.ctx.log(`${this.name}: draw #${d.draw} → ${made.url}`);
        }
        index.issues.push({ draw: d.draw, changeId: d.changeId, number: made.number, id: made.id, url: made.url, createdAt: made.createdAt });
        writeIndex(this.ctx.windowDir, index);
      }
    }
    if (plan.repeats.length) {
      index.repeats.push(...plan.repeats);
      writeIndex(this.ctx.windowDir, index);
    }
  }

  /** `pr-rla record` with an issue ledger: applies the verdict label as the token's account (the tracker records who and when). */
  async appendVerdict(event: VerdictEvent): Promise<void> {
    const index = readIndex(this.ctx.windowDir);
    if (!index) throw new Error(`${this.name}: no ${INDEX_FILE} in ${this.ctx.windowDir}; run "pr-rla sample" to open the draw issues first`);
    const issue = issueForDraw(index, event.draw);
    if (!issue || issue.changeId !== event.changeId) throw new Error(`${this.name}: draw #${event.draw} (${event.changeId}) has no issue in the index; run "pr-rla sample" to publish it`);
    this.snapshot = null;
    await this.applyLabel(issue, index.labels[event.verdict].name);
    if (event.note) await this.addNote(issue, event.note);
  }
}

/** The issue a verdict for `draw` lives on (a repeated draw uses its first draw's issue). */
export function issueForDraw(index: LedgerIndex, draw: number): IndexedIssue | undefined {
  const first = index.repeats.find((r) => r.draw === draw)?.sameAs ?? draw;
  return index.issues.find((i) => i.draw === first);
}
