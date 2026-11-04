import { existsSync } from "node:fs";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../../beacon/drand.js";
import { isRegistrationV2, type PluginIdentity } from "../../core/records.js";
import { verifyAudit, type VerifyReport } from "../../core/verify.js";
import { ledgerTraits } from "../../ledger-traits.js";
import { pluginIdentity } from "../../registry.js";
import { PR_RLA_VERSION } from "../../version.js";
import { readCheckpoints } from "./checkpoints.js";
import { auditContextFor, configFor, getBeacon, ledgerFor, protocolSha256, providerFor, readCommitment, readDraws, readManifest, readRegistration, trustFor, type ApiContext } from "../session.js";
import { logPublicKey } from "../translog.js";
import { statusLine } from "./status.js";

export interface VerifyOptions {
  /** Another window than the configured one. */
  window?: string;
  offline?: boolean;
  logKey?: string;
  beaconFile?: string;
  /** Timestamp-authority anchors the verifier adds to the shipped bundle (files). The audit repo cannot add its own. */
  tsaTrust?: string[];
}

/** The seven checks (core/verify.ts) plus what the certificate prints around them. */
export interface VerifyResult extends VerifyReport {
  /** The certificate line, when the audit has draws. */
  statusLine: string | null;
  /** Registered plugins that run with the verifier's environment and files (`PLUGIN TRUST: full`). */
  fullTrustPlugins: { name: string; version: string | null }[];
  /** The pr-rla release that verified. */
  verifiedWith: string;
}

/** `verify` (FR3.1): a third party's check of the seven audit properties. Reads only; offline skips the population rebuild and every fetch. */
export async function verify(ctx: ApiContext, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const { config, paths } = configFor(ctx, opts.window);
  const registration = readRegistration(paths);
  const manifest = existsSync(paths.manifest) ? readManifest(paths) : null;
  const commitment = existsSync(paths.commitment) ? readCommitment(paths) : null;
  const draws = existsSync(paths.draws) ? readDraws(paths) : null;
  let currentProtocol: string | null = null;
  try {
    currentProtocol = protocolSha256(config);
  } catch {
    currentProtocol = null;
  }
  // A ledger that lives in a tracker (it declares hosts) is not read offline: check 7 then SKIPs and says why.
  // An external ledger's hosts are its locked ones: it is not imported here.
  const lt = await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx).plugins);
  const skipLedger = !!opts.offline && lt.hosts.length > 0;
  const { checkpoints, problems } = readCheckpoints(paths.windowDir);
  const provider = opts.offline ? null : await providerFor(ctx, config);
  const ledger = skipLedger ? null : await ledgerFor(ctx, config, paths);
  // The identity of the provider verify loaded: compared with the registered one in check 5 (population options) and below (U2b).
  const loaded = opts.offline ? null : await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx).plugins);
  const report = await verifyAudit(
    { registration, manifest, commitment, draws, currentProtocolSha256: currentProtocol, checkpoints, checkpointProblems: problems },
    {
      provider,
      ledger,
      ...(skipLedger ? { ledgerSkipped: `offline: ledger ${lt.name} lives in ${lt.hosts.join(", ")}; run verify without --offline to check the verdicts` } : {}),
      beacon: async (round) => {
        // Prefer the beacon recorded in draws.json (verified offline); else fetch.
        if (!opts.beaconFile && draws && draws.round === round && draws.beacon.round === round) {
          if (await verifyQuicknetBeacon(draws.beacon, round)) return draws.beacon;
          throw new Error("the beacon recorded in draws.json fails BLS verification");
        }
        if (opts.offline && !opts.beaconFile && !ctx.beacon) return null;
        try {
          return await getBeacon(ctx, round, opts.beaconFile);
        } catch (e) {
          if (e instanceof RoundNotYetPublished) return null;
          throw e;
        }
      },
      logKey: (url) => logPublicKey(ctx, config, url, opts.logKey, !!opts.offline),
      trustBundle: trustFor(ctx, opts.tsaTrust),
      ...(loaded ? { providerIdentity: loaded } : {}),
    },
  );
  if (loaded && isRegistrationV2(registration)) noteProviderIdentity(report, registration.record.plugins.provider, loaded);
  const reg = registration.record;
  return {
    ...report,
    statusLine: report.status ? statusLine(report.status, { p0: reg.parameters.p0, alpha: reg.parameters.alpha, protocol: reg.protocolSha256, maxLines: reg.selector.max_changed_lines, mode: report.mode, selector: reg.selector }) : null,
    fullTrustPlugins: isRegistrationV2(registration) ? [registration.record.plugins.provider, registration.record.plugins.ledger].filter((id) => id.trust === "full").map((id) => ({ name: id.name, version: id.version })) : [],
    verifiedWith: PR_RLA_VERSION,
  };
}

/**
 * Check 5 rebuilt the population with the provider verify loaded; say so when that is not the
 * registered external plugin (another release, other files or options, another trust).
 */
function noteProviderIdentity(report: VerifyReport, registered: PluginIdentity, loaded: PluginIdentity): void {
  if (registered.source === "builtin" && loaded.source === "builtin") return;
  const show = (v: string | null) => (v === null ? "none" : /^[0-9a-f]{64}$/.test(v) ? `${v.slice(0, 12)}…` : v);
  const diffs = (["name", "source", "version", "integrity", "optionsSha256", "trust"] as const).filter((k) => registered[k] !== loaded[k]).map((k) => `${k} ${show(registered[k])} → ${show(loaded[k])}`);
  const c5 = report.checks.find((c) => c.n === 5);
  if (!diffs.length || !c5) return;
  c5.details.push(`WARN the provider verify loaded is not the registered one (${diffs.join("; ")}): the population was rebuilt with it`);
  if (c5.status === "PASS") c5.status = "WARN";
}
