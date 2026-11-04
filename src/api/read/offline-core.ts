import { verifyQuicknetBeacon } from "../../beacon/drand.js";
import type { AnyCommitment, AnyManifest, AnyRegistration, DrawsFile, SignedRecord } from "../../core/records.js";
import { verifyOfflineCore, type CoreGate, type OfflineCoreResult } from "../../core/verify-core.js";
import type { PrRlaConfig } from "../../config.js";
import { providerTraits } from "../../provider-traits.js";
import { auditContextFor, protocolSha256, trustFor, type ApiContext } from "../session.js";
import { verifierLogKeys } from "../translog.js";
import { AuditError } from "../errors.js";

/**
 * Status's run of the offline verify core (P5, finding 6; src/core/verify-core.ts): verify's checks 1, 2, 3, 4 and 6
 * over the audit's local records, with the beacon draws.json records (BLS-verified here; nothing is fetched), the log
 * keys and timestamp anchors the caller trusts (never the audit repo's), and the registered pin when one is given.
 * Its withholdings join status's certificate: a check that would FAIL makes it FAILED (exit 1), one not established
 * INCOMPLETE (exit 6). `gates` are further offline checks (P1's check-7 local gate) folded into the same result.
 */
export async function statusCore(
  ctx: ApiContext,
  config: PrRlaConfig,
  records: { registration: SignedRecord<AnyRegistration>; manifest: AnyManifest; commitment: SignedRecord<AnyCommitment> | null; draws: DrawsFile },
  opts: { tsaTrust?: readonly string[]; logKey?: readonly string[]; registrationSha256?: string },
  gates: readonly CoreGate[] = [],
): Promise<OfflineCoreResult> {
  const logKeys = verifierLogKeys(ctx, opts.logKey);
  let currentProtocolSha256: string | null = null;
  try {
    currentProtocolSha256 = protocolSha256(config);
  } catch {
    currentProtocolSha256 = null;
  }
  const { draws } = records;
  // P5 (finding 4): a labels stratum needs a provider that reads label history; read from the definition, offline.
  const labelHistory = records.registration.record.selector.labels?.length ? (await providerTraits(config.provider, config.dir, auditContextFor(ctx))).labelHistory : undefined;
  return verifyOfflineCore(
    { registration: records.registration, manifest: records.manifest, commitment: records.commitment, draws, currentProtocolSha256 },
    {
      // Round R's beacon from draws.json only, BLS-verified against the pinned quicknet key; status never fetches one.
      beacon: async (round) => {
        if (draws.round !== round || draws.beacon.round !== round) return null;
        if (!(await verifyQuicknetBeacon(draws.beacon, round))) throw new Error("the beacon recorded in draws.json fails BLS verification: the audit's draws.json was altered");
        return draws.beacon;
      },
      logKey: async (url) => logKeys.lookup(url),
      trustBundle: trustFor(ctx, opts.tsaTrust ?? []),
      ...(labelHistory !== undefined ? { labelHistory } : {}),
      ...(opts.registrationSha256 !== undefined ? { registrationSha256: opts.registrationSha256 } : {}),
    },
    gates,
  );
}

/** P5 (T14): a `--registration` value, checked: 64 hex characters (case folded), else a usage error (exit 1). */
export function registrationPin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(v)) throw new AuditError(`--registration takes the registration's SHA-256, 64 hex characters (got ${JSON.stringify(value.slice(0, 80))})`);
  return v;
}
