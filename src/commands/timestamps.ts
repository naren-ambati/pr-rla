import { canonicalJson, sha256Hex } from "../core/canonical.js";
import type { LoggedEntry, SignedRecord, TimestampingParams, TimestampEvidence } from "../core/records.js";
import { EXIT } from "../cli/exit-codes.js";
import type { PrRlaConfig } from "../config.js";
import { DEFAULT_ACCURACY_SECONDS, TOLERANCE_SECONDS, operatorCount, type TrustBundle } from "../timestamp/bundle.js";
import { requestTimestamps, type AuthorityOutcome } from "../timestamp/client.js";
import { assessTimestamps, isoMs, medianGenTimeMs, notTamperProof, timestampsLine, type TimeEvidenceSummary } from "../timestamp/verify.js";
import { verifyLoggedEntry } from "../translog/rekor.js";
import { CommandError, brokerFor, type CommandContext } from "./context.js";
import { logPublicKey } from "./translog.js";

/** Local-clock skew beyond this (against the median genTime) refuses the write (FR1.8): no accuracy term. */
export const MAX_CLOCK_SKEW_SECONDS = TOLERANCE_SECONDS;

/** The timestamping block a new registration signs, checked against the trust bundle. */
export function timestampingFor(config: PrRlaConfig, bundle: TrustBundle): TimestampingParams {
  const { authorities, minTokens } = config.timestamping;
  const unknown = authorities.filter((a) => !bundle.authorities[a]);
  if (unknown.length)
    throw new CommandError(`timestamping.authorities: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in the trust bundle ${bundle.version} (bundled: ${Object.keys(bundle.authorities).join(", ")}; add anchors with --tsa-trust <file>)`);
  if (authorities.length && minTokens > operatorCount(bundle, authorities))
    throw new CommandError(`timestamping.min_tokens is ${minTokens}, but the configured authorities belong to ${operatorCount(bundle, authorities)} distinct operator(s); tokens from one operator count once`);
  return { authorities: [...authorities], minTokens, toleranceSeconds: TOLERANCE_SECONDS, defaultAccuracySeconds: DEFAULT_ACCURACY_SECONDS, bundle: bundle.version };
}

/**
 * Requests tokens from every configured authority (in parallel, through the broker),
 * refuses on local-clock skew, and returns the accepted tokens to store. Tokens are
 * never added to a record later: a short record is fixed by registering (or freezing) again.
 */
export async function obtainTimestamps(
  ctx: CommandContext,
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
      throw new CommandError(`local clock differs from timestamp authority time by ${Math.round(skew)} s (local ${signedTimeIso}, authorities' median ${isoMs(median)}); fix the clock and run again. Nothing was written.`);
  }
  return { timestamps: outcomes.filter((o) => o.check?.accepted && o.evidence).map((o) => o.evidence!), outcomes };
}

/** A v1 log entry's integratedTime, if its SET verifies under a key this command can trust offline. */
async function logBound(ctx: CommandContext, config: PrRlaConfig, signed: SignedRecord<unknown>): Promise<number | null> {
  const log = signed.log;
  if (!log || "apiVersion" in log) return null;
  const key = await logPublicKey(ctx, config, log.logUrl, undefined, true).catch(() => null);
  if (!key) return null;
  return verifyLoggedEntry(log as LoggedEntry, signed, key).ok ? log.integratedTime : null;
}

/** Offline assessment of a v2 record's stored evidence (for register/freeze output and status). */
export async function assessRecord(ctx: CommandContext, config: PrRlaConfig, signed: SignedRecord<unknown>, signedTimeIso: string, ts: TimestampingParams, bundle: TrustBundle): Promise<TimeEvidenceSummary> {
  const data = new Uint8Array(Buffer.from(canonicalJson(signed.record)));
  const integratedTime = await logBound(ctx, config, signed);
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

/**
 * Prints the outcome table of functional-design.md §U1 item 3 and returns the exit code:
 * PROVEN → 0; 1..k-1 or 0 of k accepted → 5 with the re-run command; none configured → 0 with the warning.
 */
export function reportTimestamps(ctx: CommandContext, summary: TimeEvidenceSummary, outcomes: readonly AuthorityOutcome[], rerun: string): number {
  ctx.out(`  ${timestampsLine(summary)}`);
  for (const o of outcomes) {
    if (o.check?.accepted) continue;
    const why = o.error ?? o.check?.problems.join("; ") ?? "no token";
    ctx.out(`    ${o.tsa}: no accepted token (${why})`);
  }
  if (!summary.configured.length) return EXIT.OK;
  if (summary.proven) return EXIT.OK;
  ctx.out(`  ${notTamperProof(summary)}`);
  if (rerun.startsWith("pr-rla checkpoint")) ctx.out(`  to make it tamper-proof, take another checkpoint (lines are only ever added): ${rerun}`);
  else ctx.out(`  to make it tamper-proof, ${rerun.startsWith("pr-rla register") ? "register" : "freeze"} again before anything is shown to anyone: ${rerun}`);
  return EXIT.TIMESTAMPS_SHORT;
}
