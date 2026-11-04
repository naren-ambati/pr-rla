import { normalizeLogin, type ChangeRecord, type RepoSetRule, type RepoVisibility } from "../sdk/provider.js";
import { canonicalJson, hashCanonical, sha256Hex } from "./canonical.js";
import type { FunnelStep, Selector } from "./selector.js";
import { QUICKNET, SEED_DELAY_SECONDS, deriveSeedRound, isoToUnix, roundPublishTime, unixToIso } from "./seed.js";
import type { ResolvedWindow } from "./window.js";

export interface AuditParameters {
  claim: "D";
  p0: number;
  p1: number;
  alpha: number;
  /** Draw cap; null means the default (4 x zero-failure stopping point). */
  cap: number | null;
  /** Below this N the audit refuses and says "review all N". */
  minPopulation: number;
}

export interface RegistrationRecord {
  schema: "pr-rla/registration/v1";
  provider: string;
  repo: string;
  window: ResolvedWindow;
  selector: Selector;
  protocolSha256: string;
  parameters: AuditParameters;
  beacon: { chain: "drand-quicknet"; chainHash: string; genesis: number; period: number; delaySeconds: number };
  /** Local clock. Self-asserted; only a transparency-log integratedTime is tamper-evident. */
  registeredAt: string;
}

export interface ManifestCommitmentRecord {
  schema: "pr-rla/manifest-commitment/v1";
  repo: string;
  window: string;
  manifestSha256: string;
  N: number;
  registrationSha256: string;
  frozenAt: string;
  /** The seed round this commitment names. verify recomputes it. */
  seedRound: number;
  seedRoundPublishesAt: string;
}

/** A transparency-log entry for a signed record (Rekor hashedrekord shape). */
export interface LoggedEntry {
  logUrl: string;
  uuid: string;
  logIndex: number;
  /** Unix seconds, assigned by the log. */
  integratedTime: number;
  logID: string;
  /** Base64 canonical entry body as the log stored it. */
  body: string;
  verification: {
    signedEntryTimestamp: string;
    inclusionProof?: { logIndex: number; rootHash: string; treeSize: number; hashes: string[]; checkpoint?: string };
  };
}

/**
 * A Rekor v2 (rekor-tiles) entry. v2 sets no usable time (`integrated_time` is
 * always 0 and must be ignored), so it is evidence of public discoverability
 * only; the time comes from RFC 3161 tokens. Built from the documented API and
 * tested against a mock log only: unverified against the production log.
 */
export interface RekorV2Entry {
  apiVersion: "v2";
  logUrl: string;
  logIndex: number;
  /** Base64 key id of the log. */
  logId: string;
  kindVersion: { kind: string; version: string };
  /** Base64 canonicalized entry body (the Merkle leaf). */
  canonicalizedBody: string;
  inclusionProof: { logIndex: number; treeSize: number; rootHash: string; hashes: string[]; checkpoint: { envelope: string } };
}

/** An RFC 3161 token over a signed record's digest (contracts.md §5). Identity: (tsa, serial). */
export interface TimestampEvidence {
  kind: "rfc3161";
  /** Trust-bundle id of the authority, e.g. "sigstore". */
  tsa: string;
  url: string;
  /** Base64 DER TimeStampToken (CMS ContentInfo). */
  tokenDer: string;
  /** Copied from the token for reading; verify checks it against the token. */
  genTime: string;
  /** The token's stated accuracy in seconds, or null when the authority states none (verify then uses 60 s). */
  accuracySeconds: number | null;
  /** Hex, as the authority issued it. */
  serial: string;
  /** Hex of the 64-bit request nonce. */
  nonce: string;
}

export interface SignedRecord<T> {
  record: T;
  /** SHA-256 of canonicalJson(record): the artifact digest that is signed, time-stamped and logged. */
  sha256: string;
  /** Base64 DER ECDSA (P-256, SHA-256) signature over canonicalJson(record). */
  signature: string;
  publicKeyPem: string;
  /** null = not in a transparency log. */
  log: LoggedEntry | RekorV2Entry | null;
  /** Schema v2: RFC 3161 tokens over `sha256`. Absent on v1 records. */
  timestamps?: TimestampEvidence[];
}

export interface ManifestEntry extends ChangeRecord {}

/* ---------------------------------------------------------------------------
 * Schema v2 (contracts.md §5), defined in full here once. Writers emit v2 from
 * bolt 1 on; v1 files keep verifying. Fields that later bolts fill carry null
 * (or their documented default) until then, so the shape does not change again.
 * ------------------------------------------------------------------------- */

/**
 * Which repositories an audit covers (U8). `repo` is a pool of one; `list` names repositories;
 * `rule` names an owner plus globs and flags and is resolved once, at freeze (src/core/repo-set.ts).
 */
export type RepoSet = { kind: "repo"; repo: string } | { kind: "list"; repos: string[] } | RepoSetRule;

export type ProvenanceLevel = "self-asserted" | "account" | "presence";

/** What exactly ran as a provider or ledger. */
export interface PluginIdentity {
  name: string;
  source: "builtin" | "package" | "path";
  /** The pr-rla version for built-ins; the plugin's package version otherwise (null if it has none). */
  version: string | null;
  /** The lock's treeSha256 (bolt 4). null for built-ins, and for external plugins until the lock exists. */
  integrity: string | null;
  optionsSha256: string;
  /** SHA-256 over only the options the definition lists in `populationOptions` (none are listed before bolt 5). */
  populationOptionsSha256: string;
  trust: "builtin" | "isolated" | "full";
}

export interface TimestampingParams {
  /** Trust-bundle ids. [] = none configured: no network call, and every output says TIMESTAMP NOT TAMPER-PROOF. */
  authorities: string[];
  /** k: distinct operators whose tokens must be accepted. */
  minTokens: number;
  toleranceSeconds: number;
  defaultAccuracySeconds: number;
  /** Trust-bundle version the record was made with (informational). */
  bundle: string;
}

export interface RegistrationRecordV2 {
  schema: "pr-rla/registration/v2";
  repos: RepoSet;
  window: ResolvedWindow;
  selector: Selector;
  protocolSha256: string;
  parameters: AuditParameters;
  beacon: RegistrationRecord["beacon"];
  /** Signed; the seed-derivation input. RFC 3161 tokens bound it, they do not replace it. */
  registeredAt: string;
  timestamping: TimestampingParams;
  plugins: { provider: PluginIdentity; ledger: PluginIdentity };
  /**
   * The built-in git-file ledger only (P4): the ledger file's path from the audit repository's
   * toplevel, lexical and normalised (`<audit_dir>/<window>/<file>`). Check 7 FAILs when the ledger
   * verify walks is anywhere else. Absent for other ledgers, and in registrations written before P4
   * (check 7 then WARNs that the location is not bound).
   */
  ledgerPath?: string;
  /**
   * `allowed_signers` (U9): the reviewers' SSH keys, OpenSSH allowed-signers lines; present only
   * when keys are registered, so other registrations keep their shape. `require_signed` only when true.
   */
  verdicts: { minProvenance: ProvenanceLevel; reviewers: string[] | null; require_signed?: boolean; allowed_signers?: string[] };
  /** The pr-rla release that wrote the record. */
  prRlaVersion: string;
  /**
   * The SPKI PEM of the P-256 key that signs this registration and the audit's commitment (time round B),
   * inside the signed and time-stamped bytes, so the registration cannot be re-signed under another key.
   * verify FAILs check 1 when the envelope's key is not this one. Absent only in registrations written
   * before the field existed (test fixtures; nothing was released): verify then WARNs that it can be re-keyed.
   */
  publicKeyPem?: string;
  /**
   * A `rule` registration only (U8): the repositories the rule matched when it was registered, by stable id, sorted by
   * repo. Freeze includes every one of them that still exists, whatever its archive state, visibility or name by then,
   * so nothing the auditee changes after registration takes a repository out of the pool. Required for a rule (P3):
   * check 2 FAILs a rule registration without it.
   */
  registeredRepos?: RegisteredRepo[];
  /**
   * A `rule` registration only (P3): what the registering token could prove it saw, per visibility, when the rule was
   * resolved into `registeredRepos` (the same proof a pooled manifest's `repoListing` records). A visibility the rule
   * admits whose proof is not complete leaves check 5 INCOMPLETE: a repo of it the token missed is not registered.
   */
  registeredVisibility?: RegisteredVisibility;
  /**
   * P5: every login the selector names (`authors` when a list, and `bots`; not `id:<v>` entries), each with the stable
   * account id the provider resolved it to at `register` (`ScmProvider.resolveAccounts`), sorted by login. Selection and
   * verify match those entries by id only, never by a login a manifest carries. Absent when the selector names no login,
   * and when the provider could not resolve them for a retrospective audit (logins then match as logins, and check 2
   * WARNs; register refuses that for a prospective audit).
   */
  accounts?: RegisteredAccount[];
}

/** One login of the selector and the account id `register` resolved it to (RegistrationRecordV2.accounts, P5). */
export interface RegisteredAccount {
  login: string;
  id: string;
}

/** What a registering token could prove it saw under the rule's owner (RegistrationRecordV2.registeredVisibility). */
export type RegisteredVisibility = Pick<RepoListing, "identity" | "visibility">;

/**
 * What the SCM's push log showed at freeze about one repo's frozen head (P3; ManifestV2.headEvidence). `tip`: the log
 * showed `headSha` as the default branch's tip during the freeze, since `since` (the update `event`). `unproven`: it did
 * not, and `detail` says why. Informational: verify reads the log again and decides from what it reads.
 */
export interface HeadEvidence {
  repo: string;
  headSha: string;
  status: "tip" | "unproven";
  since?: string;
  event?: string;
  detail: string;
}

/** A repository a rule matched at `register` (RegistrationRecordV2.registeredRepos). */
export interface RegisteredRepo {
  repo: string;
  repoId: string;
}

/** One repository of the owner's unfiltered listing at freeze, as the SCM described it, and why the rule left it out. */
export interface ListedRepo {
  repo: string;
  repoId: string;
  defaultBranch: string;
  archived: boolean;
  fork: boolean;
  visibility: RepoVisibility;
  /** When the SCM created it (null when the provider does not say). */
  createdAt: string | null;
  /** The rule's clauses that exclude it (src/core/repo-set.ts `ruleExclusions`); empty when the rule matches it. */
  excludedBy: string[];
}

/**
 * A pooled manifest's record of what the freeze saw under the owner (U8): every repository the token listed, not only
 * those in the pool, with the identity that listed them and, per visibility, how many it listed and whether the
 * listing was provably complete (null: the provider cannot say). verify compares it, by repo id, with what it sees.
 */
export interface RepoListing {
  owner: string;
  identity: string | null;
  visibility: Record<RepoVisibility, { listed: number; complete: boolean | null; reason: string }>;
  /** Sorted by repo. */
  repos: ListedRepo[];
}

/** A registered repository that a repo-level probe found gone at freeze (manifest `goneRepos`), with the evidence. */
export interface GoneRepo {
  repo: string;
  /** Null for a repo of a registered list (lists carry no ids). */
  repoId: string | null;
  status: 403 | 404;
  detail: string;
  probedAt: string;
}

export interface ManifestRepo {
  repo: string;
  /** The SCM's stable repository id, from `listRepos` (a `rule` repo set); null for a `repo` or `list` set. */
  repoId: string | null;
  defaultBranch: string;
  /** The default-branch head the population was walked from (bolt 5). */
  headSha: string | null;
}

export interface ManifestV2 {
  schema: "pr-rla/manifest/v2";
  registrationSha256: string;
  /** Sorted by repo. */
  repos: ManifestRepo[];
  provider: PluginIdentity & { apiVersion: number; reviewGranularity: "submission" | "first-comment-per-user" };
  window: ResolvedWindow;
  frozenAt: string;
  selector: Selector;
  parameters: AuditParameters;
  protocolSha256: string;
  funnel: FunnelStep[];
  limitations: string[];
  N: number;
  /** Sorted by id (UTF-16 code-unit order). Reviews are as of frozenAt. */
  changes: ManifestEntry[];
  prRlaVersion: string;
  /** A `rule` pool only (U8): the owner's unfiltered listing at freeze. Absent for a repo or a list, and in older manifests. */
  repoListing?: RepoListing;
  /** A pool only (U8): registered repos found gone at freeze. Their changes are not in the manifest; verify reports them. */
  goneRepos?: GoneRepo[];
  /** P3: per repo with a pinned head, sorted by repo, what the push log showed about it; present when the provider has a push log. */
  headEvidence?: HeadEvidence[];
  /** SHA-256 over canonicalJson of every other field. */
  sha256: string;
}

/** Signed; carries its RFC 3161 tokens in the SignedRecord envelope. */
export interface CommitmentRecordV2 {
  schema: "pr-rla/commitment/v2";
  window: string;
  manifestSha256: string;
  N: number;
  registrationSha256: string;
  /** Signed; the freeze time that must precede round R. */
  frozenAt: string;
  /** The seed round this commitment names. verify recomputes it (check 3). */
  seedRound: number;
  seedRoundPublishesAt: string;
  prRlaVersion: string;
}

export type AnyRegistration = RegistrationRecord | RegistrationRecordV2;
export type AnyManifest = Manifest | ManifestV2;
export type AnyCommitment = ManifestCommitmentRecord | CommitmentRecordV2;

export const isRegistrationV2 = (r: SignedRecord<AnyRegistration>): r is SignedRecord<RegistrationRecordV2> => r.record.schema === "pr-rla/registration/v2";
export const isCommitmentV2 = (c: SignedRecord<AnyCommitment>): c is SignedRecord<CommitmentRecordV2> => c.record.schema === "pr-rla/commitment/v2";
export const isManifestV2 = (m: AnyManifest): m is ManifestV2 => m.schema === "pr-rla/manifest/v2";

/** The repo set a registration covers: a v1 registration and a v2 `repo` set are a pool of one. */
export function registrationRepoSet(reg: SignedRecord<AnyRegistration>): RepoSet {
  const r = reg.record;
  return r.schema !== "pr-rla/registration/v2" ? { kind: "repo", repo: r.repo } : r.repos;
}

/** The one repository of a single-repo audit (every v1 audit, and v2 with `repos.kind: "repo"`). Pooled audits use `registrationRepoSet`. */
export function registrationRepo(reg: SignedRecord<AnyRegistration>): string {
  const set = registrationRepoSet(reg);
  if (set.kind === "repo") return set.repo;
  throw new Error(`registration covers a repo set of kind "${set.kind}", not one repository`);
}

/** The one repository of a single-repo manifest. A pooled manifest has `repos.length > 1` or a non-`repo` registration: use `manifestRepos`. */
export function manifestRepo(m: AnyManifest): string {
  if (m.schema !== "pr-rla/manifest/v2") return m.repo;
  if (m.repos.length !== 1) throw new Error(`manifest covers ${m.repos.length} repos, not one repository`);
  return m.repos[0]!.repo;
}

/** The registered repos of a rule registration (empty for a repo or list set, and for registrations made before the field existed). */
export function registeredRepos(reg: SignedRecord<AnyRegistration>): RegisteredRepo[] {
  return reg.record.schema === "pr-rla/registration/v2" ? (reg.record.registeredRepos ?? []) : [];
}

/** A rule registration's registeredRepos as recorded: null when the field is absent (check 2 FAILs such a rule registration, P3). */
export function recordedRegisteredRepos(reg: SignedRecord<AnyRegistration>): RegisteredRepo[] | null {
  return reg.record.schema === "pr-rla/registration/v2" ? (reg.record.registeredRepos ?? null) : null;
}

/**
 * The registration's account map (P5): each selector login, normalized (case-insensitive), to the account id signed at
 * `register`. null when the registration binds none (v1, no login in the selector, or a retrospective audit whose provider
 * could not resolve them): logins then match as logins.
 */
export function registeredAccounts(reg: SignedRecord<AnyRegistration>): ReadonlyMap<string, string> | null {
  if (reg.record.schema !== "pr-rla/registration/v2" || !Array.isArray(reg.record.accounts)) return null;
  return new Map(reg.record.accounts.map((a) => [normalizeLogin(a.login), a.id]));
}

/** What the registering token could prove it saw (a rule registration, P3); null when the registration does not record it. */
export function registeredVisibility(reg: SignedRecord<AnyRegistration>): RegisteredVisibility | null {
  return reg.record.schema === "pr-rla/registration/v2" ? (reg.record.registeredVisibility ?? null) : null;
}

/** The repositories a manifest covers, in manifest order (a v1 manifest has one, without id or head). */
export function manifestRepos(m: AnyManifest): ManifestRepo[] {
  return m.schema === "pr-rla/manifest/v2" ? m.repos : [{ repo: m.repo, repoId: null, defaultBranch: m.defaultBranch, headSha: null }];
}

/** What a draws file and a ledger's draw issues call the audited repositories: the repo, or `owner (n repos)`. */
export function repoLabel(m: AnyManifest): string {
  const repos = manifestRepos(m);
  if (repos.length === 1) return repos[0]!.repo;
  const owners = new Set(repos.map((r) => r.repo.split("/")[0]!));
  return `${owners.size === 1 ? [...owners][0]! : "pool"} (${repos.length} repos)`;
}

export interface Manifest {
  schema: "pr-rla/manifest/v1";
  repo: string;
  provider: { name: string; apiVersion: number };
  defaultBranch: string;
  window: ResolvedWindow;
  frozenAt: string;
  registrationSha256: string;
  selector: Selector;
  parameters: AuditParameters;
  protocolSha256: string;
  funnel: FunnelStep[];
  limitations: string[];
  N: number;
  /** Sorted by id (UTF-16 code-unit order). Reviews are as of frozenAt. */
  changes: ManifestEntry[];
  /** SHA-256 over canonicalJson of every other field. */
  sha256: string;
}

export function recordSha256(record: unknown): string {
  return sha256Hex(canonicalJson(record));
}

export function manifestSha256(m: Omit<Manifest, "sha256"> | Manifest | Omit<ManifestV2, "sha256"> | ManifestV2): string {
  return hashCanonical(m as unknown as Record<string, unknown>, ["sha256"]);
}

/**
 * The canonical order of change ids (contracts.md §5, "Draws"): ascending by UTF-16 code units, which is
 * JavaScript's `<` on strings (equivalently: the ids' UTF-16BE encodings compared byte by byte). Ids are unique.
 */
export function compareChangeIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortChanges<T extends { id: string }>(changes: readonly T[]): T[] {
  return [...changes].sort((a, b) => compareChangeIds(a.id, b.id));
}

/** How an audit's draws are derived: what they are bound to besides the beacon's randomness. */
export type DrawDerivation = "registration" | "manifest";

/**
 * The 32-byte value each draw hashes with the randomness (contracts.md §5, "Draws"), keyed on the signed
 * registration's schema, never on a field of an unsigned file:
 *  - schema v2: the registration's sha256. Nothing chosen at freeze can move a draw: the draws are a function of
 *    the registration, the beacon and the population's sorted change ids, so freezing again (another frozenAt,
 *    funnel, limitations, version or provider description) gives the same draws (time review finding 2);
 *  - schema v1: the manifest's sha256, as v1 audits were drawn (read-only compatibility, NFR7).
 */
export function drawBinding(reg: SignedRecord<AnyRegistration>, manifest: Pick<AnyManifest, "sha256">): { hex: string; derivation: DrawDerivation } {
  return isRegistrationV2(reg) ? { hex: reg.sha256, derivation: "registration" } : { hex: manifest.sha256, derivation: "manifest" };
}

/**
 * Which reviews `unreviewed: no-review` sees (time round B). Schema v2: `landing`, the reviews submitted at or before
 * the change's own mergedAt, so the population is a function of the registration and the SCM's record of each change
 * at landing, and nothing done after landing or chosen at freeze changes N. Schema v1: `cutoff`, as of the freeze time,
 * as v1 manifests were made. (`no-human-review` already counts only reviews submitted at or before mergedAt.)
 */
export function reviewHorizonFor(reg: SignedRecord<AnyRegistration> | null): "landing" | "cutoff" {
  return reg && !isRegistrationV2(reg) ? "cutoff" : "landing";
}

export function beaconParams(): RegistrationRecord["beacon"] {
  return { chain: "drand-quicknet", chainHash: QUICKNET.chainHash, genesis: QUICKNET.genesis, period: QUICKNET.period, delaySeconds: SEED_DELAY_SECONDS };
}

export interface EffectiveTime {
  unix: number;
  iso: string;
  /** log: a v1 record's Rekor integratedTime · local: a v1 record's own clock · signed: a v2 record's signed time (tokens bound it). */
  source: "log" | "local" | "signed";
}

/** A schema-v2 signed record (registration or commitment): its signed time is its time, whatever its envelope holds. */
export function isSignedV2(signed: SignedRecord<unknown>): boolean {
  const schema = (signed.record as { schema?: unknown } | null)?.schema;
  return schema === "pr-rla/registration/v2" || schema === "pr-rla/commitment/v2";
}

/**
 * v1: the time a signed record counts as registered is the log's integratedTime
 * if logged, else the self-asserted local time. v2: always the signed field
 * (FR1.4); RFC 3161 tokens and any log entry only bound it. Keyed on the signed
 * `record.schema`, never on the unsigned envelope: dropping `timestamps` from a v2
 * envelope must not hand the time to the log, nor adding it take the time from a v1 log.
 */
export function effectiveTime(signed: SignedRecord<unknown>, localIso: string): EffectiveTime {
  const unix = isoToUnix(localIso);
  if (isSignedV2(signed)) return { unix, iso: unixToIso(unix), source: "signed" };
  if (signed.log && !("apiVersion" in signed.log)) return { unix: signed.log.integratedTime, iso: unixToIso(signed.log.integratedTime), source: "log" };
  return { unix, iso: unixToIso(unix), source: "local" };
}

export function registrationTime(reg: SignedRecord<AnyRegistration>): EffectiveTime {
  return effectiveTime(reg, reg.record.registeredAt);
}

export function derivedRoundFor(reg: SignedRecord<AnyRegistration>): { round: number; publishesAt: number; base: "window-close" | "registration" } {
  const windowClosesAt = isoToUnix(reg.record.window.closesAt);
  const registeredAt = registrationTime(reg).unix;
  const round = deriveSeedRound({ windowClosesAt, registeredAt });
  return { round, publishesAt: roundPublishTime(round), base: registeredAt > windowClosesAt ? "registration" : "window-close" };
}

export type AuditMode = "PROSPECTIVE" | "RETROSPECTIVE";

/** The mode the registration's own time claims. For v2, verify proves it from the tokens (U_k < opensAt). */
export function auditMode(reg: SignedRecord<AnyRegistration>): AuditMode {
  return registrationTime(reg).unix < isoToUnix(reg.record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE";
}

export interface DrawsFile {
  schema: "pr-rla/draws/v1";
  repo: string;
  window: string;
  manifestSha256: string;
  N: number;
  round: number;
  beacon: { round: number; randomness: string; signature: string };
  chainHash: string;
  /** Draws released to reviewers so far (the prefix rule only looks at these). */
  issued: number;
  cap: number;
  draws: { draw: number; index: number; changeId: string; url: string; mergeSha: string; firstOccurrence: boolean }[];
  /**
   * Optional (added after the first draws files): `ledgerIndexSha256` of the window's `ledger-index.json`
   * as `sample` left it, for a ledger that keeps one. `verify` compares it with the file now, so the
   * draw → issue mapping cannot be edited after the draws were published (contracts.md §5).
   */
  ledgerIndexSha256?: string;
}

