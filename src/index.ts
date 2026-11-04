/** pr-rla library entry: the audit core plus the plugin registry. */
export * from "./core/canonical.js";
export * from "./core/sprt.js";
export * from "./core/seed.js";
export * from "./core/selector.js";
export * from "./core/window.js";
export * from "./core/records.js";
export * from "./core/population.js";
export * from "./core/repo-set.js";
export * from "./core/pooled-report.js";
export * from "./core/rebuild.js";
export { looksUnavailable, probeRepo, type ProbeResult } from "./core/failures.js";
export * from "./core/status.js";
export * from "./core/simulate.js";
export * from "./core/verify.js";
export {
  verifySshsig,
  verifySshsigBlob,
  parseSshsig,
  dearmorSshsig,
  parsePublicKeyText,
  parseAllowedSigner,
  parseAllowedSigners,
  allowedSignersOf,
  verdictPayload,
  verdictPayloadText,
  checkVerdictSignature,
  attestVerdicts,
  countedVerdicts,
  countingVerdictFor,
  signaturesRequired,
  auditBinding,
  provenanceLabel,
  verdictRuleFailures,
  VERDICT_NAMESPACE,
  VERDICT_PAYLOAD_VERSION,
  PRESENCE_LABEL,
  PRESENCE_LIMIT,
  type SshsigCheck,
  type SshPublicKey,
  type AllowedSigner,
  type VerdictPayloadFields,
  type VerdictBinding,
  type VerdictSignatureCheck,
  type VerdictRules,
} from "./core/presence/index.js";
export { verifyQuicknetBeacon, fetchQuicknetBeacon, QUICKNET_CHAIN_INFO } from "./beacon/drand.js";
export { RekorClient, buildHashedRekord, verifyLoggedEntry } from "./translog/rekor.js";
export { RekorV2Client, buildHashedRekordV002, verifyRekorV2Entry, REKOR_V2_WARNING } from "./translog/rekor-v2.js";
export { checkToken, assessTimestamps, timestampsLine, notTamperProof, type TokenCheck, type TimeEvidenceSummary } from "./timestamp/verify.js";
export { requestTimestamps, buildTimeStampReq } from "./timestamp/client.js";
export { SHIPPED_TRUST_BUNDLE, mergeTrust, readTrustExtra, type TrustBundle, type TrustBundleExtra } from "./timestamp/bundle.js";
export { EXIT } from "./cli/exit-codes.js";
export { createBroker, roleOf, type Broker, type BrokerPolicy, type BrokerDeps, type RecordedExchange } from "./net/broker.js";
export {
  BrokerError,
  BrokerTimeout,
  BrokerRetriesExhausted,
  HostNotAllowed,
  ReadOnlyViolation,
  WritePathNotAllowed,
  CredentialHostMismatch,
  DESTINATION_TIMEOUT_MS,
  TSA_RETRY_DEADLINE_MS,
  type BrokerFetch,
  type BrokerInit,
  type Destination,
} from "./net/contract.js";
export { BUDGET_FAMILIES, DEFAULT_HOSTS, defaultBudgets, parseRate, type HostBudgetDefault, type RateRule, type RateLimitOverrides } from "./net/rate-limits.js";
export { createAuditContext, openProvider, openLedger, requireReadWrite, AuditApiError, type AuditContext, type AuditContextOptions, type AuditMode } from "./api/context.js";
export { freezeRepos, FreezeStopped, FreezeRepoFailed, ResumeRefused, isTransientFailure, type PooledFreeze, type PooledFreezeOptions } from "./api/pooled-freeze.js";
export { FreezeCheckpointStore, freezeRunId, type FreezeRunInputs, type FreezeRunHeader } from "./api/freeze-store.js";
export { estimateFreeze, estimateLines, type FreezeEstimate } from "./api/freeze-estimate.js";
export { PR_RLA_VERSION } from "./version.js";
export { createProvider, createLedger, loadProviderDefinition, loadLedgerDefinition, BUILTIN_PROVIDERS, BUILTIN_LEDGERS } from "./registry.js";
export { loadConfig, parseConfig } from "./config.js";
