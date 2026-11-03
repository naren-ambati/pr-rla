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
}

export interface LedgerContext {
  cwd: string;
  /** The audit window's directory, e.g. `<cwd>/audit/2026-q3`. */
  windowDir: string;
  env: Readonly<Record<string, string | undefined>>;
  log: (message: string) => void;
  fetch: typeof fetch;
}

export interface Ledger {
  readonly apiVersion: number;
  readonly name: string;
  /** All verdict events, in the order they were recorded. */
  readVerdicts(): Promise<VerdictEvent[]>;
  appendVerdict(event: VerdictEvent): Promise<void>;
  /** Optional: publish draws for reviewers (e.g. open one issue per draw, in draw order). */
  publishDraws?(draws: DrawForLedger[]): Promise<void>;
  /** Optional: check the ledger's own history (append-only, no relabels). */
  verifyIntegrity?(): Promise<LedgerIntegrityReport>;
}

/** An environment variable a plugin may receive, and the hosts its value may be sent to. */
export interface LedgerCredential {
  env: string;
  hosts: string[];
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
