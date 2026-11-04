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
  /**
   * Optional (U3, same API version): the SCM's stable account id, which survives a rename:
   * GitHub `databaseId`, GitLab user id, Bitbucket Cloud account `uuid`, Data Center user id,
   * Gitea user id. Selectors match it as `id:<value>`; logins stay the display value. Absent for
   * a commit's git identity that the SCM links to no account (`git:<email>`) and for `ghost`.
   */
  id?: string;
}

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
export const REVIEW_STATES: readonly ReviewState[] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"];

/**
 * One review object (U3, FR7.4). On an SCM with review submissions, one object is one submitted
 * review event: a GitHub or Gitea review, a GitLab approval or request-changes event. An SCM with no
 * review objects for comments synthesises one `COMMENTED` per non-author user, at their first comment.
 * A provider declares which it does with `ProviderDefinition.reviewGranularity`.
 *
 * `DISMISSED` is a decision that no longer stands: a dismissed review, a withdrawn approval, an
 * approval reset by a push. A revoked approval never comes back as `APPROVED`.
 */
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
 * - `direct_push`: a commit that reached the default branch with no merged
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
  /**
   * Optional (same API version): true when the SCM truncated the diff (GitLab `too_large`, Bitbucket
   * Data Center's `truncated`) and offered no stat field to count instead, so `changedLines` is a lower
   * bound, not the size. A provider must set it rather than report an undercount. The selector keeps
   * such a change in a `max_changed_lines` stratum and the funnel reports how many there were.
   */
  changedLinesUnknown?: true;
  labels: string[];
  /**
   * Optional (U3, same API version), direct pushes only: the SHA of the direct-push merge commit,
   * on the default branch's own history, whose non-first parent brought this commit in (for example
   * a release branch merged by a push). The selector option `direct_push_via_merge: exclude` drops
   * such records. Absent when the commit was pushed to the default branch itself.
   */
  landedVia?: string;
}

/**
 * How a provider forms review objects (see `Review`): one per submitted review event, or one
 * `COMMENTED` per non-author user at their first comment. Recorded in the manifest.
 */
export type ReviewGranularity = "submission" | "first-comment-per-user";
export const REVIEW_GRANULARITIES: readonly ReviewGranularity[] = ["submission", "first-comment-per-user"];
/** What a definition without `reviewGranularity` (written before the field existed) means. */
export const DEFAULT_REVIEW_GRANULARITY: ReviewGranularity = "submission";

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
  /**
   * Optional (U3, same API version): walk default-branch history from this commit instead of the
   * branch's current head. `freeze` leaves it unset and records the result's `headSha`; `verify`
   * passes that SHA back, so a commit dated in the window but pushed after freeze is not reachable.
   */
  head?: string;
}

export interface ListChangesResult {
  /** Every change in the window of the requested kinds. The core applies the selector. */
  changes: ChangeRecord[];
  /** The default branch the changes landed on. */
  defaultBranch: string;
  /** Limitations a reader of the manifest must know (copied into every manifest). */
  limitations: string[];
  /** Optional counts that explain the population (e.g. PRs merged into other branches, excluded). Not used for selection. */
  diagnostics?: { label: string; value: number }[];
  /**
   * Optional (U3): the default-branch commit the provider actually walked history from: `request.head`
   * when it honours one, else the head it resolved. Absent when the provider does not pin history.
   */
  headSha?: string;
}

export interface ProviderContext {
  /** Directory of the audit repo (where `.pr-rla.yml` lives). */
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  log: (message: string) => void;
  /** Injected for testing and recording; defaults to global fetch. */
  fetch: typeof fetch;
  /**
   * Optional (added in pr-rla 0.2, same API version): how the provider waits
   * between retries. The conformance kit injects one that records the wait
   * instead of sleeping. When absent, use a real timer.
   */
  sleep?: (ms: number) => Promise<void>;
}

export type RepoVisibility = "public" | "private" | "internal";
export const REPO_VISIBILITIES: readonly RepoVisibility[] = ["public", "private", "internal"];

/**
 * A repository set rule (U8, FR5.1): every repository under `owner` (a GitHub org or user, a GitLab group,
 * a Bitbucket workspace or project) whose path matches `include` and not `exclude`, filtered by the flags.
 * It is registered as written and resolved once, at freeze.
 */
export interface RepoSetRule {
  kind: "rule";
  owner: string;
  /** Globs over the repo path (`*` within a segment, `**` across segments). A pattern with no `/` matches the repo's last segment. Sorted; default `["*"]`. */
  include: string[];
  exclude: string[];
  /** true includes archived repositories (default false: excluded). */
  archived: boolean;
  /** true includes forks (default false: excluded). */
  forks: boolean;
  /** Which visibilities count. Sorted; default all three. */
  visibility: RepoVisibility[];
}

/** One repository `listRepos` found. `id` is the SCM's stable repository id. */
export interface RepoRef {
  /** Provider-scoped repository path, as `ListChangesRequest.repo` takes it (for example `navikt/pdfgenrs`). */
  repo: string;
  id: string;
  defaultBranch: string;
  archived: boolean;
  fork: boolean;
  visibility: RepoVisibility;
  /**
   * Optional (U8): when the SCM created the repository, ISO 8601 UTC, where the SCM reports it. `verify` uses it to
   * excuse a repo that matches the rule but was created after the window closed: it cannot hold a window landing.
   */
  createdAt?: string;
}

/** Whether a listing provably shows every repository of one visibility, and why (or why not). */
export interface VisibilityProof {
  complete: boolean;
  /** One line a reader can check, e.g. "org owner (admin) with a classic token holding the repo scope". */
  reason: string;
}

/**
 * Optional (U8): what `listRepos` can see under an owner. `identity` is the account the token acts as, when the SCM
 * says (null otherwise). For each visibility, whether the listing provably holds every repository of that visibility
 * under the owner, with the reason. A pooled freeze records it; `verify` needs `complete` for every visibility the
 * rule admits other than `public` (an SCM lists public repositories to anyone), or check 5 is INCOMPLETE.
 */
export interface ListingVisibility {
  identity: string | null;
  visibilities: Record<RepoVisibility, VisibilityProof>;
}

/** Optional (U8): one commit on the default branch's first-parent chain. */
export interface FirstParentCommit {
  sha: string;
  /** The commit's committer date, ISO 8601 UTC (the date the provider's window applies to direct pushes). */
  committedAt: string;
}

/**
 * Optional (U8): the requests one `listChanges` for this request would make, predicted from a cheap
 * probe (the first page of what it would read). `freeze --dry-run --estimate` sums these.
 */
export interface RequestEstimate {
  /** Every request, GraphQL queries included. */
  requests: number;
  /** How many of `requests` are GraphQL queries (they have their own budget on GitHub). Default 0. */
  graphql?: number;
  /** The requests the probe itself made (already spent; part of `requests`). */
  probed?: number;
}

/**
 * Thrown by a provider's `describeRepo` when the repository itself does not exist: HTTP 404, or 403 only where the
 * SCM documents a 403 as hiding a repository from the caller. The core decides a repo is gone only on this answer to
 * one repo-level probe, never on an error from `listChanges` (a 404 there can be a missing commit or sub-resource).
 * `verify` then reports the repo's changes as not rebuilt (INCOMPLETE); `freeze` records a registered repo as gone.
 * Across the plugin host the `code` carries it.
 */
export const REPO_UNAVAILABLE = "REPO_UNAVAILABLE";
export class RepoUnavailableError extends Error {
  // No parameter properties or field initialisers: src/sdk is erasable TypeScript (tsconfig.sdk.json), because this
  // module also runs under Node's type stripping (the plugin host).
  readonly code: string;
  readonly repo: string;
  readonly status: 403 | 404;
  constructor(repo: string, status: 403 | 404, detail = "") {
    super(`${repo}: HTTP ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "RepoUnavailableError";
    this.code = REPO_UNAVAILABLE;
    this.repo = repo;
    this.status = status;
  }
}

/** The broker's give-up codes (src/sdk/http.ts): a rate limit or a timeout, never a missing repository. */
const GIVE_UP_CODES: readonly string[] = ["BROKER_RETRIES_EXHAUSTED", "BROKER_TIMEOUT"];

/**
 * True for a RepoUnavailableError, one that crossed the plugin host (its `code`), or a provider's own 404 or 403.
 * Never for a rate limit or a give-up: an error with a broker give-up code, `rateLimited: true` or status 0 is
 * transient, whatever status it carries (a GitHub secondary rate limit is a 403).
 */
export function isRepoUnavailable(e: unknown): boolean {
  const x = e as { code?: unknown; status?: unknown; rateLimited?: unknown } | null;
  if (!x || typeof x !== "object") return false;
  if (x.code === REPO_UNAVAILABLE) return true;
  if (x.rateLimited === true || (typeof x.code === "string" && GIVE_UP_CODES.includes(x.code))) return false;
  return x.status === 404 || x.status === 403;
}

/**
 * Thrown by `listChanges` for a repository with no commits, so no default branch (`<repo> has no default branch`).
 * A single-repo audit stops on it, as it always has; a pooled freeze or verify counts the repo as empty: nothing
 * landed in it in any window. Across the plugin host the `code` carries it.
 */
export const REPO_EMPTY = "REPO_EMPTY";
export class RepoEmptyError extends Error {
  readonly code: string;
  readonly repo: string;
  constructor(repo: string, message = `${repo} has no default branch`) {
    super(message);
    this.name = "RepoEmptyError";
    this.code = REPO_EMPTY;
    this.repo = repo;
  }
}

/** True for a RepoEmptyError, or one that crossed the plugin host (its `code`). */
export function isRepoEmpty(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === REPO_EMPTY;
}

export interface ScmProvider {
  readonly apiVersion: number;
  /** Short scheme, used as the `id` prefix. e.g. `github`. */
  readonly name: string;
  listChanges(request: ListChangesRequest): Promise<ListChangesResult>;
  /**
   * Optional (U8, same API version): the repositories under `set.owner` the token can see. A provider may
   * skip archived repositories, forks or visibilities the rule excludes, but need not: the core applies the
   * rule's globs and flags itself, sorts, and refuses a result outside `set.owner`. Required to register a
   * `rule` repo set; absent, `register` refuses and names the provider.
   */
  listRepos?(set: RepoSetRule): Promise<RepoRef[]>;
  /** Optional (U8): predicts `listChanges` request counts for `freeze --dry-run --estimate`. Absent: no estimate for this provider. */
  estimateRequests?(request: ListChangesRequest): Promise<RequestEstimate>;
  /**
   * Optional (U8): one repo-level metadata read, by stable `id` where the SCM can resolve one (it then finds a renamed
   * or transferred repository), else by path. Returns the repository as it is now, or throws `RepoUnavailableError`
   * (404, or 403 where the SCM documents 403 as hiding a repository) when it does not exist. Any other failure is
   * thrown as it is. Without it, the core cannot tell a gone repository from a missing commit, and says so.
   */
  describeRepo?(ref: { repo: string; id?: string }): Promise<RepoRef>;
  /**
   * Optional (U8): who the token is and whether `listRepos(set)` provably sees every repository of each visibility
   * under `set.owner`. Without it, `verify` cannot establish that a pool's private or internal repositories are
   * complete, and check 5 is INCOMPLETE for them.
   */
  listingVisibility?(set: RepoSetRule): Promise<ListingVisibility>;
  /**
   * Optional (U8): the default branch's first-parent commits from `head` back to, and not including, `base`, newest
   * first; null when `base` is not on `head`'s first-parent chain. `verify` uses it to tell a commit dated in the window
   * but merged after freeze (FR7.2: it is not in the population) from a window landing the frozen head left out.
   */
  firstParentPath?(request: { repo: string; base: string; head: string; signal?: AbortSignal }): Promise<FirstParentCommit[] | null>;
  /**
   * Optional: provider-native counts for a selector (e.g. a search-API figure)
   * printed next to pr-rla's own population so readers see the difference.
   */
  nativeCounts?(request: ListChangesRequest, selector: Readonly<Record<string, unknown>>): Promise<{ label: string; value: number }[]>;
}

/** An environment variable a plugin may receive, and the hosts its value may be sent to. */
export interface PluginCredential {
  env: string;
  hosts: string[];
  /**
   * Optional (phase 3, same API version): the option that holds the service's URL, such as
   * `base_url`, for a self-hosted server. When the options set it, the credential may be sent to
   * that URL's host instead of `hosts` (which then name the default service), and only to an
   * `https:` URL's host. pr-rla reads the option itself: the plugin's code never chooses where its
   * credential goes, and `pr-rla plugin add` records the host it computed in pr-rla.lock.json.
   */
  hostFromOption?: string;
  /**
   * Optional (same API version): header names, besides `authorization`, where pr-rla may swap this
   * credential's placeholder, for a service that takes its token elsewhere (GitLab's
   * `private-token`). A placeholder in any other header is refused unsent
   * (CREDENTIAL_HEADER_NOT_ALLOWED). `pr-rla plugin add` records them.
   */
  headers?: string[];
  /**
   * Optional (same API version): `false` marks an identity, not a secret: a Basic username or an
   * account e-mail. pr-rla then leaves its value alone in responses (a list of participants that
   * names the user still reads right), and sends it only as the user part of
   * `prrla-basic:<USER_ENV>:<TOKEN_ENV>`. Absent or `true`: a secret, scrubbed from every response
   * in every form pr-rla knows (raw, percent-encoded, base64).
   */
  secret?: boolean;
}

/** A header name (RFC 9110 token). */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface ProviderDefinition<Options = Record<string, unknown>> {
  readonly providerApiVersion: number;
  readonly name: string;
  readonly description?: string;
  /**
   * Optional (added in phase 3, same API version): the hosts this provider contacts with
   * these options. The fetch broker allows only these for an isolated plugin, and gives
   * a built-in provider's hosts its service's default rate budget.
   */
  readonly hosts?: (options: Options) => string[];
  /**
   * Optional (phase 3): credentials the provider may use. It sends `prrla-cred:<ENV>` in a
   * header (or `prrla-basic:<USER_ENV>:<TOKEN_ENV>` as Authorization) and the broker swaps
   * in the value only for these hosts.
   */
  readonly credentials?: readonly PluginCredential[];
  /**
   * Optional (U3): how this provider forms review objects (see `Review`). Copied into the manifest.
   * Absent means `"submission"`.
   */
  readonly reviewGranularity?: ReviewGranularity;
  /**
   * Optional (U3): the option keys that change the population (e.g. `base_url`, `bots`). The registration
   * records a hash of exactly these (`populationOptionsSha256`); a verifier whose values differ FAILs check 5.
   */
  readonly populationOptions?: readonly string[];
  /**
   * Optional (U3): true when the provider sets `ChangeRecord.landedVia`. Without it, `register` warns that
   * `direct_push_via_merge: exclude` has no effect.
   */
  readonly reportsLandedVia?: boolean;
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
  const problem = pluginGrantProblems(def) ?? providerTraitProblems(def);
  if (problem) throw new Error(`${source}: provider "${def.name}" ${problem}`);
}

/** Checks the optional U3 definition fields `reviewGranularity`, `populationOptions` and `reportsLandedVia`. */
export function providerTraitProblems(def: { reviewGranularity?: unknown; populationOptions?: unknown; reportsLandedVia?: unknown }): string | null {
  if (def.reviewGranularity !== undefined && !REVIEW_GRANULARITIES.includes(def.reviewGranularity as ReviewGranularity)) return `reviewGranularity must be ${REVIEW_GRANULARITIES.map((g) => `"${g}"`).join(" or ")}`;
  if (def.populationOptions !== undefined && (!Array.isArray(def.populationOptions) || def.populationOptions.some((k) => typeof k !== "string" || k.length === 0))) return "populationOptions must be a list of option names";
  if (def.reportsLandedVia !== undefined && typeof def.reportsLandedVia !== "boolean") return "reportsLandedVia must be true or false";
  return null;
}

/** Checks the optional `hosts`, `credentials` and `writePaths` fields of a plugin definition. */
export function pluginGrantProblems(def: { hosts?: unknown; credentials?: unknown; writePaths?: unknown }): string | null {
  if (def.hosts !== undefined && typeof def.hosts !== "function") return "hosts must be a function of the options returning host names";
  if (def.writePaths !== undefined && typeof def.writePaths !== "function") return "writePaths must be a function of the options returning host/path prefixes";
  if (def.credentials !== undefined) {
    const ok = Array.isArray(def.credentials) && def.credentials.every((c) => c && typeof c === "object" && typeof (c as PluginCredential).env === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test((c as PluginCredential).env) && Array.isArray((c as PluginCredential).hosts) && (c as PluginCredential).hosts.every((h) => typeof h === "string" && h.length > 0));
    if (!ok) return 'credentials must be a list of { env: "NAME", hosts: ["host", …] }';
    if (!(def.credentials as PluginCredential[]).every((c) => c.hostFromOption === undefined || (typeof c.hostFromOption === "string" && c.hostFromOption.length > 0))) return "a credential's hostFromOption must name an option (a string)";
    if (!(def.credentials as PluginCredential[]).every((c) => c.headers === undefined || (Array.isArray(c.headers) && c.headers.every((h) => typeof h === "string" && HEADER_NAME.test(h))))) return "a credential's headers must be a list of header names";
    if (!(def.credentials as PluginCredential[]).every((c) => c.secret === undefined || typeof c.secret === "boolean")) return "a credential's secret must be true or false";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation, shared by the core, the JSON-file provider and the conformance kit.
// ---------------------------------------------------------------------------

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID = /^[a-z0-9][a-z0-9-]*:[^\s#@]+(?:#[1-9][0-9]*|@(?:[0-9a-f]{40}|[0-9a-f]{64}))$/;

/** A git commit id as the manifest records and providers send it: 40 (SHA-1) to 64 (SHA-256) lowercase hex characters. */
export const COMMIT_ID = /^[0-9a-f]{40,64}$/;

export function isCommitId(value: unknown): value is string {
  return typeof value === "string" && COMMIT_ID.test(value);
}

export function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

function actorProblems(actor: unknown, path: string): string[] {
  if (!actor || typeof actor !== "object") return [`${path} must be an object`];
  const a = actor as Partial<Actor>;
  const out: string[] = [];
  if (typeof a.login !== "string" || a.login.length === 0) out.push(`${path}.login must be a non-empty string`);
  if (a.kind !== "human" && a.kind !== "bot") out.push(`${path}.kind must be "human" or "bot"`);
  if (a.id !== undefined && (typeof a.id !== "string" || a.id.length === 0)) out.push(`${path}.id must be a non-empty string when present`);
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
  if (r.changedLinesUnknown !== undefined && r.changedLinesUnknown !== true) p.push("changedLinesUnknown must be true when present");
  if (!Array.isArray(r.labels) || r.labels.some((l) => typeof l !== "string")) p.push("labels must be an array of strings");
  if (r.kind === "direct_push") {
    if (Array.isArray(r.reviews) && r.reviews.length > 0) p.push("a direct_push has no reviews");
    if (r.mergedBy !== null) p.push("a direct_push has mergedBy: null (the pusher is not known)");
  }
  if (r.landedVia !== undefined) {
    if (typeof r.landedVia !== "string" || !SHA.test(r.landedVia)) p.push("landedVia must be 40 or 64 lowercase hex characters when present");
    else if (r.kind !== "direct_push") p.push("only a direct_push has landedVia");
    else if (r.landedVia === r.mergeSha) p.push("landedVia names the merge that brought the commit in, not the commit itself");
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
