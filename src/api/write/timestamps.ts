import { canonicalJson, sha256Hex } from "../../core/canonical.js";
import type { SignedRecord, TimestampingParams, TimestampEvidence } from "../../core/records.js";
import type { TrustBundle } from "../../timestamp/bundle.js";
import { requestTimestamps, type AuthorityOutcome } from "../../timestamp/client.js";
import { isoMs, medianGenTimeMs } from "../../timestamp/verify.js";
import { AuditError } from "../errors.js";
import { brokerFor, type ApiContext } from "../session.js";
import { MAX_CLOCK_SKEW_SECONDS } from "../timestamps.js";

/**
 * Requests tokens from every configured authority (in parallel, through the broker),
 * refuses on local-clock skew, and returns the accepted tokens to store. Tokens are
 * never added to a record later: a short record is fixed by registering (or freezing) again.
 */
export async function obtainTimestamps(
  ctx: ApiContext,
  signed: SignedRecord<unknown>,
  signedTimeIso: string,
  ts: TimestampingParams,
  bundle: TrustBundle,
): Promise<{ timestamps: TimestampEvidence[]; outcomes: AuthorityOutcome[] }> {
  if (!ts.authorities.length) return { timestamps: [], outcomes: [] };
  const data = new Uint8Array(Buffer.from(canonicalJson(signed.record)));
  const outcomes = await requestTimestamps({
    authorities: ts.authorities,
    bundle,
    digestHex: sha256Hex(data),
    data,
    signedTimeIso,
    toleranceSeconds: ts.toleranceSeconds,
    defaultAccuracySeconds: ts.defaultAccuracySeconds,
    broker: brokerFor(ctx),
    ...(ctx.nonceFor ? { nonceFor: ctx.nonceFor } : {}),
  });
  const median = medianGenTimeMs(outcomes.flatMap((o) => (o.check ? [o.check] : [])));
  if (median !== null) {
    const skew = Math.abs(median - Date.parse(signedTimeIso)) / 1000;
    if (skew > MAX_CLOCK_SKEW_SECONDS)
      throw new AuditError(`local clock differs from timestamp authority time by ${Math.round(skew)} s (local ${signedTimeIso}, authorities' median ${isoMs(median)}); fix the clock and run again. Nothing was written.`);
  }
  return { timestamps: outcomes.filter((o) => o.check?.accepted && o.evidence).map((o) => o.evidence!), outcomes };
}
