import { canonicalJson, sha256Hex } from "../core/canonical.js";
import type { LoggedEntry, SignedRecord, TimestampingParams } from "../core/records.js";
import type { PrRlaConfig } from "../config.js";
import { DEFAULT_ACCURACY_SECONDS, TOLERANCE_SECONDS, operatorCount, type TrustBundle } from "../timestamp/bundle.js";
import { assessTimestamps, type TimeEvidenceSummary } from "../timestamp/verify.js";
import { verifyLoggedEntry } from "../translog/rekor.js";
import { AuditError } from "./errors.js";
import type { ApiContext } from "./session.js";
import { logPublicKey } from "./translog.js";

/** Local-clock skew beyond this (against the median genTime) refuses the write (FR1.8): no accuracy term. */
export const MAX_CLOCK_SKEW_SECONDS = TOLERANCE_SECONDS;

/** The timestamping block a new registration signs, checked against the trust bundle. */
export function timestampingFor(config: PrRlaConfig, bundle: TrustBundle): TimestampingParams {
  const { authorities, minTokens } = config.timestamping;
  const unknown = authorities.filter((a) => !bundle.authorities[a]);
  if (unknown.length)
    throw new AuditError(`timestamping.authorities: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the trust bundle ${bundle.version} (bundled: ${Object.keys(bundle.authorities).join(", ")}; add anchors with --tsa-trust <file>)`);
  if (authorities.length && minTokens > operatorCount(bundle, authorities))
    throw new AuditError(`timestamping.min_tokens is ${minTokens}, but the configured authorities belong to ${operatorCount(bundle, authorities)} distinct operator(s); tokens from one operator count once`);
  return { authorities: [...authorities], minTokens, toleranceSeconds: TOLERANCE_SECONDS, defaultAccuracySeconds: DEFAULT_ACCURACY_SECONDS, bundle: bundle.version };
}

/** A v1 log entry's integratedTime, if its SET verifies under a key pinned in the package (status and register take no --log-key; the pinned operator is Sigstore). */
export async function logBound(ctx: ApiContext, config: PrRlaConfig, signed: SignedRecord<unknown>, logKey: readonly string[] = []): Promise<number | null> {
  const log = signed.log;
  if (!log || "apiVersion" in log) return null;
  // The pinned key for a pinned log; else the caller's own --log-key for exactly that log (P5: status takes them too).
  const key = await logPublicKey(ctx, config, log.logUrl, logKey, true).catch(() => null);
  if (!key) return null;
  return verifyLoggedEntry(log as LoggedEntry, signed, key.publicKeyPem).ok ? log.integratedTime : null;
}

/** Offline assessment of a v2 record's stored evidence (for register/freeze output and status). */
export async function assessRecord(ctx: ApiContext, config: PrRlaConfig, signed: SignedRecord<unknown>, signedTimeIso: string, ts: TimestampingParams, bundle: TrustBundle, logKey: readonly string[] = []): Promise<TimeEvidenceSummary> {
  const data = new Uint8Array(Buffer.from(canonicalJson(signed.record)));
  const integratedTime = await logBound(ctx, config, signed, logKey);
  return assessTimestamps({
    timestamps: signed.timestamps ?? [],
    data,
    digestHex: sha256Hex(data),
    signedTimeIso,
    timestamping: ts,
    bundle,
    log: integratedTime !== null ? { operator: bundle.authorities.sigstore?.operator ?? "Sigstore", integratedTime } : null,
  });
}
