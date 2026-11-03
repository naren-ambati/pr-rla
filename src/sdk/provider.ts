/**
 * pr-rla provider SDK (`pr-rla/provider`).
 *
 * A provider turns one source-control system into normalized `ChangeRecord`s.
 * The audit core (selector, manifest, seeding, sampling, SPRT, status, verify,
 * simulate) only ever sees these types, never a provider's own API shapes.
 *
 * Versioning: `PROVIDER_API_VERSION` is bumped only on a breaking change to
 * anything exported here. A provider declares the version it was written for;
 * the core refuses one it does not support.
 */

export const PROVIDER_API_VERSION = 1 as const;
export type ProviderApiVersion = typeof PROVIDER_API_VERSION;

/** The provider API versions this build of pr-rla can load. */
export const SUPPORTED_PROVIDER_API_VERSIONS: readonly number[] = [1];

export type ActorKind = "human" | "bot";

export interface Actor {
  /** Provider login. Bot accounts carry a `[bot]` suffix, e.g. `copilot-swe-agent[bot]`. */
  login: string;
  kind: ActorKind;
}

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
export const REVIEW_STATES: readonly ReviewState[] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"];

export interface Review {
  author: Actor;
  state: ReviewState;
  /** ISO-8601 UTC, e.g. `2026-09-30T16:21:35Z`. */
  submittedAt: string;
}

export type ChangeKind = "pull_request" | "direct_push";
export const CHANGE_KINDS: readonly ChangeKind[] = ["pull_request", "direct_push"];

/**
 * One change that landed on the default branch.
 *
 * - `pull_request`: a merged PR/MR into the default branch. All commits the
 *   merge brought in (merge commit, squash commit, or every rebased commit)
 *   belong to this one record.
 * - `direct_push`: a first-parent commit on the default branch with no merged
 *   PR into that branch. It has no reviews by definition and `mergedBy: null`
 *   (most SCM APIs do not expose the pusher; `author` is the commit author).
 */
export interface ChangeRecord {
  /**
   * Provider-scoped, stable id: `<scheme>:<repo>#<number>` for a PR,
   * `<scheme>:<repo>@<sha>` for a direct push. Example: `github:github/gh-aw#74360`.
   */
  id: string;
  kind: ChangeKind;
  /** Provider-scoped repository path, e.g. `github/gh-aw`. */
  repo: string;
  url: string;
  /** The commit that landed on the default branch (lowercase hex). */
  mergeSha: string;
  /** When the change landed (PR merge time, or commit date for a direct push). ISO-8601 UTC. */
  mergedAt: string;
  author: Actor;
  mergedBy: Actor | null;
  reviews: Review[];
  /** Raw additions + deletions as the SCM reports them (no generated-file exclusion). */
  changedLines: number;
  labels: string[];
}

export interface AuditWindow {
  /** Inclusive start, ISO-8601 UTC. */
  opensAt: string;
  /** Exclusive end, ISO-8601 UTC. */
  closesAt: string;
}

export interface ListChangesRequest {
  /** Provider-scoped repository path from `.pr-rla.yml`. */
  repo: string;
  window: AuditWindow;
  /** The kinds the selector will keep. A provider MAY skip work for kinds not listed. */
  kinds: ChangeKind[];
  signal?: AbortSignal;
}

export interface ListChangesResult {
  /** Every change in the window of the requested kinds. The core applies the selector. */
  changes: ChangeRecord[];
  /** The default branch the changes landed on. */
  defaultBranch: string;
  /** Limitations a reader of the manifest must know (copied into every manifest). */
  limitations: string[];
  /** Optional provider-native comparison numbers, e.g. GitHub's own `review:none` count. Not used for selection. */
  nativeCounts?: { label: string; value: number }[];
}

export interface ProviderContext {
  /** Directory of the audit repo (where `.pr-rla.yml` lives). */
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  log: (message: string) => void;
  /** Injected for testing and recording; defaults to global fetch. */
  fetch: typeof fetch;
}

export interface ScmProvider {
  readonly apiVersion: number;
  /** Short scheme, used as the `id` prefix. e.g. `github`. */
  readonly name: string;
  listChanges(request: ListChangesRequest): Promise<ListChangesResult>;
  /**
   * Optional: provider-native counts for a selector (e.g. a search-API figure)
   * printed next to pr-rla's own population so readers see the difference.
   */
  nativeCounts?(request: ListChangesRequest, selector: Readonly<Record<string, unknown>>): Promise<{ label: string; value: number }[]>;
}

export interface ProviderDefinition<Options = Record<string, unknown>> {
  readonly providerApiVersion: number;
  readonly name: string;
  readonly description?: string;
  create(options: Options, context: ProviderContext): ScmProvider | Promise<ScmProvider>;
}

/** Identity helper that types a provider module's default export. */
export function defineProvider<Options = Record<string, unknown>>(
  definition: ProviderDefinition<Options>,
): ProviderDefinition<Options> {
  return definition;
}

export class ProviderApiVersionError extends Error {
  constructor(name: string, version: unknown) {
    super(
      `provider "${name}" declares providerApiVersion ${String(version)}; ` +
        `this pr-rla supports ${SUPPORTED_PROVIDER_API_VERSIONS.join(", ")}. ` +
        `Upgrade pr-rla or use a provider release built for API ${PROVIDER_API_VERSION}.`,
    );
    this.name = "ProviderApiVersionError";
  }
}

/** Throws if `value` is not a loadable provider definition. */
export function assertProviderDefinition(value: unknown, source: string): asserts value is ProviderDefinition {
  if (!value || typeof value !== "object") {
    throw new Error(`${source}: does not export a provider definition (use defineProvider() as the default export)`);
  }
  const def = value as Partial<ProviderDefinition>;
  if (typeof def.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(def.name)) {
    throw new Error(`${source}: provider definition needs a lowercase "name" (got ${JSON.stringify(def.name)})`);
  }
  if (!SUPPORTED_PROVIDER_API_VERSIONS.includes(def.providerApiVersion as number)) {
    throw new ProviderApiVersionError(def.name, def.providerApiVersion);
  }
  if (typeof def.create !== "function") {
    throw new Error(`${source}: provider "${def.name}" has no create() function`);
  }
}

// ---------------------------------------------------------------------------
// Validation, shared by the core, the JSON-file provider and the conformance kit.
// ---------------------------------------------------------------------------

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID = /^[a-z0-9][a-z0-9-]*:[^\s#@]+(?:#[1-9][0-9]*|@(?:[0-9a-f]{40}|[0-9a-f]{64}))$/;

export function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

function actorProblems(actor: unknown, path: string): string[] {
  if (!actor || typeof actor !== "object") return [`${path} must be an object`];
  const a = actor as Partial<Actor>;
  const out: string[] = [];
  if (typeof a.login !== "string" || a.login.length === 0) out.push(`${path}.login must be a non-empty string`);
  if (a.kind !== "human" && a.kind !== "bot") out.push(`${path}.kind must be "human" or "bot"`);
  return out;
}

/** Returns a list of problems; empty means the record is well-formed. */
export function changeRecordProblems(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["record must be an object"];
  const r = value as Partial<ChangeRecord>;
  const p: string[] = [];
  if (typeof r.id !== "string" || !ID.test(r.id)) p.push(`id ${JSON.stringify(r.id)} must look like "<scheme>:<repo>#<n>" or "<scheme>:<repo>@<sha>"`);
  if (r.kind !== "pull_request" && r.kind !== "direct_push") p.push(`kind must be "pull_request" or "direct_push"`);
  if (typeof r.id === "string" && r.kind === "pull_request" && !r.id.includes("#")) p.push("a pull_request id must end in #<number>");
  if (typeof r.id === "string" && r.kind === "direct_push" && !r.id.includes("@")) p.push("a direct_push id must end in @<sha>");
  if (typeof r.repo !== "string" || r.repo.length === 0) p.push("repo must be a non-empty string");
  if (typeof r.url !== "string" || r.url.length === 0) p.push("url must be a non-empty string");
  if (typeof r.mergeSha !== "string" || !SHA.test(r.mergeSha)) p.push("mergeSha must be 40 or 64 lowercase hex characters");
  if (!isIsoUtc(r.mergedAt)) p.push("mergedAt must be ISO-8601 UTC (…Z)");
  p.push(...actorProblems(r.author, "author"));
  if (r.mergedBy !== null) p.push(...actorProblems(r.mergedBy, "mergedBy"));
  if (!Array.isArray(r.reviews)) p.push("reviews must be an array");
  else
    r.reviews.forEach((rev, i) => {
      if (!rev || typeof rev !== "object") return void p.push(`reviews[${i}] must be an object`);
      p.push(...actorProblems(rev.author, `reviews[${i}].author`));
      if (!REVIEW_STATES.includes(rev.state)) p.push(`reviews[${i}].state must be one of ${REVIEW_STATES.join(", ")}`);
      if (!isIsoUtc(rev.submittedAt)) p.push(`reviews[${i}].submittedAt must be ISO-8601 UTC`);
    });
  if (typeof r.changedLines !== "number" || !Number.isInteger(r.changedLines) || r.changedLines < 0) p.push("changedLines must be a non-negative integer");
  if (!Array.isArray(r.labels) || r.labels.some((l) => typeof l !== "string")) p.push("labels must be an array of strings");
  if (r.kind === "direct_push") {
    if (Array.isArray(r.reviews) && r.reviews.length > 0) p.push("a direct_push has no reviews");
    if (r.mergedBy !== null) p.push("a direct_push has mergedBy: null (the pusher is not known)");
  }
  return p;
}

export function assertChangeRecord(value: unknown, where = "change"): asserts value is ChangeRecord {
  const problems = changeRecordProblems(value);
  if (problems.length > 0) {
    const id = value && typeof value === "object" ? (value as { id?: unknown }).id : undefined;
    throw new Error(`${where} ${JSON.stringify(id)}: ${problems.join("; ")}`);
  }
}

/** Canonical ordering of change ids: plain UTF-16 code-unit order. */
export function compareChangeIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalizes a login for comparison (case-insensitive). */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}
