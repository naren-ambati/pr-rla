/**
 * pr-rla ledger SDK (`pr-rla/ledger`).
 *
 * A ledger is where reviewer verdicts on the draws are recorded. The core reads
 * verdict events in recorded order and counts only the FIRST verdict per change
 * (a change drawn twice reuses that verdict). The default ledger is `git-file`
 * (`audit/<window>/verdicts.jsonl`, with git history as the tamper trail).
 * Issue-tracker ledgers (one issue per draw, pass/fail labels) plug in here.
 */

export const LEDGER_API_VERSION = 1 as const;
export const SUPPORTED_LEDGER_API_VERSIONS: readonly number[] = [1];

export type Verdict = "pass" | "fail";

/**
 * How much a verdict's `reviewer` and `recordedAt` can be trusted (contracts.md §1):
 * `self-asserted` (whatever the writer typed: an unsigned git-file line), `account` (an SCM or
 * tracker account did it, at a server-assigned time: issue ledgers; or a git-file verdict signed
 * by the reviewer's registered SSH key), `presence` (U9: a git-file verdict signed by the
 * reviewer's registered FIDO security key, with the user-presence flag set; pr-rla does not check
 * that the key is hardware-backed). Added in phase 3 within API version 1.
 */
export type ProvenanceLevel = "self-asserted" | "account" | "presence";
export const PROVENANCE_LEVELS: readonly ProvenanceLevel[] = ["self-asserted", "account", "presence"];

/** Orders provenance levels; an absent level is `self-asserted`. */
export function provenanceRank(level: ProvenanceLevel | undefined): number {
  return PROVENANCE_LEVELS.indexOf(level ?? "self-asserted");
}

/** Where a verdict came from (optional, phase 3). Absent means `self-asserted`. */
export interface VerdictProvenance {
  level: ProvenanceLevel;
  source: "git-commit" | "git-signed-commit" | "verdict-signature" | "scm-label-event" | "jira-field-change" | (string & {});
  /** The tracker's stable account id of the actor, when it has one. */
  actorId?: string;
  /** GitHub's `performed_via_github_app` slug; non-null makes the verdict ineligible. */
  viaApp?: string | null;
  /** The tracker's id of the event the verdict was read from. */
  eventId?: string;
  /** verdict-signature (U9): the allowed-signers principal whose key signed the verdict. */
  signer?: string;
  /** verdict-signature (U9): the signing key's `SHA256:` fingerprint, as `ssh-keygen -l` prints it. */
  keyFingerprint?: string;
  /** verdict-signature with a FIDO security key (U9): the authenticator's signature counter. */
  counter?: number;
}

export interface VerdictEvent {
  /** Draw number (1-based) the reviewer was working from. */
  draw: number;
  changeId: string;
  verdict: Verdict;
  /** SHA-256 of the review protocol the reviewer applied. */
  protocolSha256: string;
  reviewer: string;
  /** ISO-8601 UTC. Self-asserted unless the ledger backs it with an external timestamp. */
  recordedAt: string;
  note?: string;
  /** Optional (phase 3): where the verdict came from. Issue ledgers set `account` with the label event. */
  provenance?: VerdictProvenance;
  /**
   * Optional (U9, git-file lines): the registration a signed verdict names, and its SSHSIG in
   * namespace `pr-rla-verdict@v1` over the verdict's bytes, base64 without the armor (contracts.md
   * §1, "Per-verdict signatures"). pr-rla checks it against the registration's allowed signers; a
   * ledger never sets provenance from it.
   */
  registrationSha256?: string;
  sshsig?: string;
}

/** An account in a ledger's history. `id` is the tracker's stable account id, when it has one. */
export interface LedgerActor {
  login: string;
  kind: "human" | "bot";
  id?: string;
}

/**
 * One event of a ledger's verdict history (contracts.md §1), the unit a checkpoint hashes.
 * Issue ledgers list every add and remove of a verdict label (or field value) on an indexed issue.
 */
export interface LedgerHistoryEvent {
  /** The tracker's event id. */
  id: string;
  /** Server time, ISO 8601 UTC. */
  at: string;
  actor: LedgerActor;
  action: "add" | "remove" | "edit" | "delete-issue" | "transfer";
  label: string | null;
  draw: number | null;
  /** Not hashed: anything the ledger wants to keep for display. */
  raw?: unknown;
}

/** What `publishDraws` is told about the audit (optional second argument, phase 3). */
export interface PublishContext {
  window: string;
  /** The registration's protocol hash, which every verdict on the draws is made under. */
  protocolSha256: string;
  registrationSha256?: string;
  /** The audited repository, for issue titles. */
  repo?: string;
}

export interface DrawForLedger {
  draw: number;
  changeId: string;
  url: string;
  mergeSha: string;
  /** False when this change was already drawn earlier (its verdict is reused). */
  firstOccurrence: boolean;
}

export interface LedgerIntegrityReport {
  ok: boolean;
  /** Human-readable findings, e.g. "verdicts.jsonl rewritten in commit abc123". */
  findings: string[];
  /** True when the ledger has an external tamper trail (git history, issue events). */
  tamperTrail: boolean;
  /** Optional (phase 3): findings that make check 7 WARN (a relabel, a removal later replaced). */
  warnings?: string[];
}

export interface LedgerContext {
  cwd: string;
  /** The audit window's directory, e.g. `<cwd>/audit/2026-q3`. */
  windowDir: string;
  env: Readonly<Record<string, string | undefined>>;
  log: (message: string) => void;
  fetch: typeof fetch;
  /** Optional (phase 3): how the ledger waits; the conformance kit injects one that records waits. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional (phase 3): the registered reviewers (`verdicts.reviewers`), for the integrity
   * analysis. null or absent: any account that is not a bot or an app.
   */
  reviewers?: readonly string[] | null;
  /**
   * Optional (phase 3): the ledger's local index, one JSON document pr-rla keeps for it at
   * `<windowDir>/ledger-index.json` (committed with draws.json), written atomically. A ledger in
   * the plugin host cannot write files, so it keeps its state here; `read()` gives null before the
   * first `write()`. pr-rla gives it to external ledgers.
   */
  index?: LedgerIndexStore;
}

/** A ledger's local index document (LedgerContext.index). */
export interface LedgerIndexStore {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

export interface Ledger {
  readonly apiVersion: number;
  readonly name: string;
  /** All verdict events, in the order they were recorded. */
  readVerdicts(): Promise<VerdictEvent[]>;
  appendVerdict(event: VerdictEvent): Promise<void>;
  /** Optional: publish draws for reviewers (e.g. open one issue per draw, in draw order). Idempotent. */
  publishDraws?(draws: DrawForLedger[], context?: PublishContext): Promise<void>;
  /** Optional: check the ledger's own history (append-only, no relabels). */
  verifyIntegrity?(): Promise<LedgerIntegrityReport>;
  /** Optional (phase 3): the canonical verdict-event history, for checkpoints. Without it a ledger cannot be checkpointed. */
  readHistory?(): Promise<LedgerHistoryEvent[]>;
}

/**
 * An environment variable a plugin may receive, and the hosts its value may be sent to. For a
 * tracker whose host is the user's own (a Jira site, a self-hosted server), name the option that
 * holds its URL in `hostFromOption` (phase 3): pr-rla then sends the value to that URL's host (an
 * `https:` URL only) instead of `hosts`, as for providers (`PluginCredential`).
 */
export interface LedgerCredential {
  env: string;
  hosts: string[];
  hostFromOption?: string;
  /** Header names, besides `authorization`, where its placeholder may be swapped (as for providers, `PluginCredential.headers`). */
  headers?: string[];
  /** `false`: an identity such as a Basic username, not scrubbed from responses (as for providers, `PluginCredential.secret`). */
  secret?: boolean;
}

export interface LedgerDefinition<Options = Record<string, unknown>> {
  readonly ledgerApiVersion: number;
  readonly name: string;
  readonly description?: string;
  /** Optional (phase 3, same API version): the hosts this ledger contacts with these options. */
  readonly hosts?: (options: Options) => string[];
  /**
   * Optional (phase 3): `host/path-prefix` entries where this ledger may send non-read requests,
   * e.g. `api.github.com/repos/acme/audit/`. The fetch broker refuses any other write.
   */
  readonly writePaths?: (options: Options) => string[];
  /** Optional (phase 3): credentials, sent as `prrla-cred:<ENV>` placeholders and swapped only for these hosts. */
  readonly credentials?: readonly LedgerCredential[];
  /**
   * Optional (phase 3): the provenance its verdicts carry. `account` for issue-tracker ledgers.
   * `register` takes it as the default `verdicts.min_provenance` (FR3.8); absent means `self-asserted`.
   */
  readonly provenance?: ProvenanceLevel;
  create(options: Options, context: LedgerContext): Ledger | Promise<Ledger>;
}

export function defineLedger<Options = Record<string, unknown>>(definition: LedgerDefinition<Options>): LedgerDefinition<Options> {
  return definition;
}

export class LedgerApiVersionError extends Error {
  constructor(name: string, version: unknown) {
    super(
      `ledger "${name}" declares ledgerApiVersion ${String(version)}; ` +
        `this pr-rla supports ${SUPPORTED_LEDGER_API_VERSIONS.join(", ")}.`,
    );
    this.name = "LedgerApiVersionError";
  }
}

export function assertLedgerDefinition(value: unknown, source: string): asserts value is LedgerDefinition {
  if (!value || typeof value !== "object") {
    throw new Error(`${source}: does not export a ledger definition (use defineLedger() as the default export)`);
  }
  const def = value as Partial<LedgerDefinition>;
  if (typeof def.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(def.name)) {
    throw new Error(`${source}: ledger definition needs a lowercase "name"`);
  }
  if (!SUPPORTED_LEDGER_API_VERSIONS.includes(def.ledgerApiVersion as number)) {
    throw new LedgerApiVersionError(def.name, def.ledgerApiVersion);
  }
  if (typeof def.create !== "function") throw new Error(`${source}: ledger "${def.name}" has no create() function`);
  if (def.hosts !== undefined && typeof def.hosts !== "function") throw new Error(`${source}: ledger "${def.name}" hosts must be a function of the options`);
  if (def.writePaths !== undefined && typeof def.writePaths !== "function") throw new Error(`${source}: ledger "${def.name}" writePaths must be a function of the options`);
  if (def.credentials !== undefined && !(Array.isArray(def.credentials) && def.credentials.every((c) => c && typeof c.env === "string" && Array.isArray(c.hosts))))
    throw new Error(`${source}: ledger "${def.name}" credentials must be a list of { env, hosts }`);
  if (def.credentials?.some((c) => c.hostFromOption !== undefined && (typeof c.hostFromOption !== "string" || c.hostFromOption.length === 0)))
    throw new Error(`${source}: ledger "${def.name}" a credential's hostFromOption must name an option (a string)`);
  if (def.credentials?.some((c) => c.headers !== undefined && !(Array.isArray(c.headers) && c.headers.every((h: unknown) => typeof h === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h)))))
    throw new Error(`${source}: ledger "${def.name}" a credential's headers must be a list of header names`);
  if (def.credentials?.some((c) => c.secret !== undefined && typeof c.secret !== "boolean")) throw new Error(`${source}: ledger "${def.name}" a credential's secret must be true or false`);
  if (def.provenance !== undefined && !PROVENANCE_LEVELS.includes(def.provenance)) throw new Error(`${source}: ledger "${def.name}" provenance must be one of ${PROVENANCE_LEVELS.join(", ")}`);
}

export function verdictEventProblems(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["verdict event must be an object"];
  const v = value as Partial<VerdictEvent>;
  const p: string[] = [];
  if (typeof v.draw !== "number" || !Number.isInteger(v.draw) || v.draw < 1) p.push("draw must be a positive integer");
  if (typeof v.changeId !== "string" || v.changeId.length === 0) p.push("changeId must be a string");
  if (v.verdict !== "pass" && v.verdict !== "fail") p.push('verdict must be "pass" or "fail"');
  if (typeof v.protocolSha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.protocolSha256)) p.push("protocolSha256 must be 64 hex characters");
  if (typeof v.reviewer !== "string" || v.reviewer.length === 0) p.push("reviewer must be a non-empty string");
  if (typeof v.recordedAt !== "string" || Number.isNaN(Date.parse(v.recordedAt))) p.push("recordedAt must be an ISO timestamp");
  return p;
}

// ---------------------------------------------------------------------------
// Verdict history (phase 3, same API version): pure helpers shared by the core,
// the built-in issue ledgers, external ledgers (the Jira example) and the ledger kit,
// so every ledger applies the same first-eligible-event and relabel rules.
// ---------------------------------------------------------------------------

const BOT_SUFFIX = "[bot]";

/**
 * Why a verdict event cannot count, or null if it can (functional-design.md §U4):
 * a bot account (`[bot]` login), an app (`viaApp`), or, when reviewers are registered,
 * an account that is not on the list. Entries match as U3's selectors do (`actorMatches` in
 * src/core/selector.ts): `id:<account id>` matches the event's account id (`provenance.actorId`,
 * the `Actor.id` of the tracker's event) exactly, so it survives a renamed login; any other entry is
 * a login, matched case-insensitively, never an id. An ineligible event is ignored and reported, so
 * its draw stays unlabelled.
 */
export function verdictIneligibility(event: Pick<VerdictEvent, "reviewer" | "provenance">, reviewers?: readonly string[] | null): string | null {
  const login = event.reviewer.trim().toLowerCase();
  if (login.endsWith(BOT_SUFFIX)) return `applied by bot account ${event.reviewer}`;
  const app = event.provenance?.viaApp;
  if (app) return `applied by app "${app}"`;
  if (reviewers) {
    const id = event.provenance?.actorId;
    const listed = reviewers.some((r) => {
      const entry = r.trim();
      return entry.startsWith("id:") ? id !== undefined && entry.slice(3) === id : entry.toLowerCase() === login;
    });
    if (!listed) return `${event.reviewer} is not a registered reviewer`;
  }
  return null;
}

/**
 * Orders two tracker event ids. Numeric ids (GitHub's, GitLab's) compare as integers, with BigInt
 * so ids past 2^53 stay exact; a lexical order would put "100" before "99" and so would count the
 * wrong one of two same-second verdicts. An id made of colon-separated parts (Jira's
 * `<history id>:<item>:<action>`) compares part by part, each part by this rule, a shorter id
 * before a longer one it begins. In a part, a number sorts before anything else, and anything else
 * sorts by UTF-16 code unit; equal numbers written differently ("07" and "7") fall back to code
 * units too. The order is total and the same on every machine. Documented in contracts.md §1.
 */
export function compareEventIds(a: string, b: string): number {
  const pa = a.split(":");
  const pb = b.split(":");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const bx = BigInt(x);
      const by = BigInt(y);
      if (bx !== by) return bx < by ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1;
}

/** Server time, then event id (`compareEventIds`): the order in which "the first eligible event counts". */
export function compareByTimeThenId(a: { at: string; id: string }, b: { at: string; id: string }): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : compareEventIds(a.id, b.id);
}

/** One verdict the core did not count, and why (reported by `status` and check 7 as "ignored"). */
export interface IgnoredVerdictEvent {
  event: VerdictEvent;
  reason: string;
}

export interface VerdictClassification {
  /** The first eligible verdict of each drawn change, by change id, in the order the ledger returned them. */
  first: Map<string, VerdictEvent>;
  ignored: IgnoredVerdictEvent[];
  /** Later verdicts on a change that disagree with its first (the first counts). */
  relabels: { changeId: string; first: VerdictEvent; later: VerdictEvent }[];
}

/**
 * How the core treats the verdicts a ledger returns (`computeStatus`, check 7 and the ledger kit share
 * this): one made under another protocol, on a change that was not drawn, on a draw that is not that
 * change, or by an ineligible account is ignored with a reason; of the rest, the FIRST per change counts,
 * in the order the ledger returned them (a ledger returns them in recorded order: time, then event id).
 */
export function classifyVerdicts(verdicts: readonly VerdictEvent[], ctx: { protocolSha256: string; draws: readonly { draw: number; changeId: string }[]; reviewers?: readonly string[] | null }): VerdictClassification {
  const drawByNumber = new Map(ctx.draws.map((d) => [d.draw, d]));
  const drawnIds = new Set(ctx.draws.map((d) => d.changeId));
  const first = new Map<string, VerdictEvent>();
  const ignored: IgnoredVerdictEvent[] = [];
  const relabels: VerdictClassification["relabels"] = [];
  for (const ev of verdicts) {
    if (ev.protocolSha256 !== ctx.protocolSha256) {
      ignored.push({ event: ev, reason: `protocol ${ev.protocolSha256.slice(0, 8)}… is not the registered protocol ${ctx.protocolSha256.slice(0, 8)}…` });
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
    const ineligible = verdictIneligibility(ev, ctx.reviewers);
    if (ineligible) {
      ignored.push({ event: ev, reason: ineligible });
      continue;
    }
    const prior = first.get(ev.changeId);
    if (!prior) first.set(ev.changeId, ev);
    else if (prior.verdict !== ev.verdict) relabels.push({ changeId: ev.changeId, first: prior, later: ev });
  }
  return { first, ignored, relabels };
}

/**
 * Whether a counted verdict was recorded before the seed was public (`publishesAtUnix`, seconds):
 * check 7 FAILs it, and the ledger kit's verdict-before-seed check asks this same question of the
 * verdicts a ledger returns.
 */
export const recordedBeforeSeed = (recordedAt: string, publishesAtUnix: number): boolean => Date.parse(recordedAt) / 1000 < publishesAtUnix;

/** A history event as it is hashed into a checkpoint: no `raw`, keys fixed. */
export type CanonicalHistoryEvent = Omit<LedgerHistoryEvent, "raw">;

/** Sorts by time then id (`compareByTimeThenId`) and drops `raw`: the list `eventsSha256` is computed over (canonical JSON). */
export function canonicalHistory(events: readonly LedgerHistoryEvent[]): CanonicalHistoryEvent[] {
  return events
    .map((e) => ({ id: e.id, at: e.at, actor: { login: e.actor.login, kind: e.actor.kind, ...(e.actor.id !== undefined ? { id: e.actor.id } : {}) }, action: e.action, label: e.label, draw: e.draw }))
    .sort(compareByTimeThenId);
}

const sameEvent = (a: CanonicalHistoryEvent, b: CanonicalHistoryEvent) =>
  a.at === b.at && a.action === b.action && a.label === b.label && a.draw === b.draw && a.actor.login === b.actor.login && a.actor.kind === b.actor.kind && a.actor.id === b.actor.id;

/** What changed between a checkpointed history and the current one: events gone, and events whose content changed. New events are normal. */
export function historyDiff(checkpointed: readonly LedgerHistoryEvent[], current: readonly LedgerHistoryEvent[]): { missing: string[]; changed: string[] } {
  const now = new Map(canonicalHistory(current).map((e) => [e.id, e]));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const e of canonicalHistory(checkpointed)) {
    const c = now.get(e.id);
    if (!c) missing.push(e.id);
    else if (!sameEvent(e, c)) changed.push(e.id);
  }
  return { missing, changed };
}

export function historyEventProblems(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["history event must be an object"];
  const e = value as Partial<LedgerHistoryEvent>;
  const p: string[] = [];
  if (typeof e.id !== "string" || e.id.length === 0) p.push("id must be a non-empty string");
  if (typeof e.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(e.at)) p.push("at must be ISO-8601 UTC (…Z)");
  if (!e.actor || typeof e.actor.login !== "string" || (e.actor.kind !== "human" && e.actor.kind !== "bot")) p.push("actor must be { login, kind }");
  if (!["add", "remove", "edit", "delete-issue", "transfer"].includes(e.action as string)) p.push("action must be add, remove, edit, delete-issue or transfer");
  if (e.label !== null && typeof e.label !== "string") p.push("label must be a string or null");
  if (e.draw !== null && !(typeof e.draw === "number" && Number.isInteger(e.draw) && e.draw >= 1)) p.push("draw must be a positive integer or null");
  return p;
}

/** One add or remove of a verdict label (or field value) on one draw's issue. `verdict: null`: the tracker no longer says which label (it was deleted). */
export interface VerdictLabelEvent {
  id: string;
  at: string;
  action: "add" | "remove";
  verdict: Verdict | null;
  reviewer: string;
  provenance?: VerdictProvenance;
}

export interface DrawHistoryAnalysis {
  /** The first eligible add: the draw's verdict. */
  counted: VerdictLabelEvent | null;
  /** Relabels and removals later replaced (check 7 WARN). */
  warnings: string[];
  /** Removal after counting with nothing in its place, or a history the tracker altered (check 7 FAIL). */
  failures: string[];
  /** Informational: ineligible verdict events (also reported by the core as ignored). */
  notes: string[];
}

/**
 * The integrity rules of functional-design.md §U4 and FR4.3 for one draw, on its verdict-label events:
 * - the first eligible add counts (never removed: PASS);
 * - after it, the same verdict removed and added again: WARN `relabel (same verdict)`;
 * - the opposite verdict added (a swap, or both labels present): WARN `relabel pass→fail; the first verdict counts`;
 * - the counted verdict removed and nothing left in its place at the end: FAIL (removal after counting);
 * - an event whose label the tracker has since erased: FAIL.
 */
export function analyzeDrawHistory(draw: number, events: readonly VerdictLabelEvent[], opts: { reviewers?: readonly string[] | null; labelOf: (v: Verdict) => string }): DrawHistoryAnalysis {
  const out: DrawHistoryAnalysis = { counted: null, warnings: [], failures: [], notes: [] };
  // At one instant a removal comes before an add: a select-field change or a scoped-label swap is one of each.
  const rank = (e: VerdictLabelEvent) => (e.action === "remove" ? 0 : 1);
  const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : rank(a) - rank(b) || compareEventIds(a.id, b.id)));
  const present = new Set<Verdict>();
  let lastRemoval: VerdictLabelEvent | null = null;
  for (const e of sorted) {
    if (e.verdict === null) {
      out.failures.push(`draw #${draw}: label event ${e.id} (${e.at}) no longer names its label: the verdict label was deleted and the tracker erased it from the history`);
      continue;
    }
    const label = opts.labelOf(e.verdict);
    if (e.action === "remove") {
      present.delete(e.verdict);
      if (out.counted) lastRemoval = e;
      continue;
    }
    if (!out.counted) {
      const why = verdictIneligibility(e, opts.reviewers);
      present.add(e.verdict);
      if (why) out.notes.push(`draw #${draw}: ${label} ${why} (${e.at}); not counted`);
      else out.counted = e;
      continue;
    }
    const first = out.counted.verdict as Verdict;
    if (e.verdict === first) {
      if (!present.has(first)) out.warnings.push(`draw #${draw}: ${label} removed and added again (relabel, same verdict); the first event (${out.counted.at}) counts`);
    } else {
      out.warnings.push(`draw #${draw}: relabel ${first}→${e.verdict}${present.has(first) ? " (both labels present)" : ""}; the first verdict (${first}, ${out.counted.at}) counts`);
    }
    present.add(e.verdict);
  }
  if (out.counted && present.size === 0 && lastRemoval)
    out.failures.push(`draw #${draw}: the counted ${opts.labelOf(out.counted.verdict as Verdict)} verdict was removed at ${lastRemoval.at} and nothing replaced it (removal after counting)`);
  return out;
}
