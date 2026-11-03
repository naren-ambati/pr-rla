import type { ChangeRecord } from "../sdk/provider.js";
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

export interface SignedRecord<T> {
  record: T;
  /** SHA-256 of canonicalJson(record): the artifact digest that is signed and logged. */
  sha256: string;
  /** Base64 DER ECDSA (P-256, SHA-256) signature over canonicalJson(record). */
  signature: string;
  publicKeyPem: string;
  /** null = written locally only; its timestamps are NOT tamper-proof. */
  log: LoggedEntry | null;
}

export interface ManifestEntry extends ChangeRecord {}

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

export function manifestSha256(m: Omit<Manifest, "sha256"> | Manifest): string {
  return hashCanonical(m as unknown as Record<string, unknown>, ["sha256"]);
}

export function sortChanges<T extends { id: string }>(changes: readonly T[]): T[] {
  return [...changes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function beaconParams(): RegistrationRecord["beacon"] {
  return { chain: "drand-quicknet", chainHash: QUICKNET.chainHash, genesis: QUICKNET.genesis, period: QUICKNET.period, delaySeconds: SEED_DELAY_SECONDS };
}

export interface EffectiveTime {
  unix: number;
  iso: string;
  source: "log" | "local";
}

/** The time a signed record counts as registered: the log's integratedTime if logged, else the self-asserted local time. */
export function effectiveTime(signed: SignedRecord<unknown>, localIso: string): EffectiveTime {
  if (signed.log) return { unix: signed.log.integratedTime, iso: unixToIso(signed.log.integratedTime), source: "log" };
  const unix = isoToUnix(localIso);
  return { unix, iso: unixToIso(unix), source: "local" };
}

export function registrationTime(reg: SignedRecord<RegistrationRecord>): EffectiveTime {
  return effectiveTime(reg, reg.record.registeredAt);
}

export function derivedRoundFor(reg: SignedRecord<RegistrationRecord>): { round: number; publishesAt: number; base: "window-close" | "registration" } {
  const windowClosesAt = isoToUnix(reg.record.window.closesAt);
  const registeredAt = registrationTime(reg).unix;
  const round = deriveSeedRound({ windowClosesAt, registeredAt });
  return { round, publishesAt: roundPublishTime(round), base: registeredAt > windowClosesAt ? "registration" : "window-close" };
}

export type AuditMode = "PROSPECTIVE" | "RETROSPECTIVE";

export function auditMode(reg: SignedRecord<RegistrationRecord>): AuditMode {
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
}

