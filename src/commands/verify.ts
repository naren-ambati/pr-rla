import { existsSync } from "node:fs";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../beacon/drand.js";
import { isRegistrationV2, type PluginIdentity } from "../core/records.js";
import { verifyAudit, type VerifyReport } from "../core/verify.js";
import { ledgerTraits } from "../ledger-traits.js";
import { pluginIdentity } from "../registry.js";
import { statusLine } from "./status.js";
import {
  auditContextFor,
  configFor,
  getBeacon,
  trustFor,
  ledgerFor,
  protocolSha256,
  providerFor,
  readCommitment,
  readDraws,
  readManifest,
  readRegistration,
  type CommandContext,
} from "./context.js";
import { logPublicKey } from "./translog.js";
import { notTamperProof, timestampsLine } from "../timestamp/verify.js";
import { readCheckpoints } from "../api/checkpoint.js";
import { PR_RLA_VERSION } from "../version.js";

export interface VerifyOptions {
  offline?: boolean;
  logKey?: string;
  beaconFile?: string;
  json?: boolean;
  /** Timestamp-authority anchors the verifier adds to the shipped bundle (files). The audit repo cannot add its own. */
  tsaTrust?: string[];
}

export async function runVerify(ctx: CommandContext, opts: VerifyOptions): Promise<VerifyReport> {
  const { config, paths } = configFor(ctx);
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
      provenanceCeiling: lt.maxProvenance,
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
  return report;
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

export async function verifyCommand(ctx: CommandContext, opts: VerifyOptions): Promise<number> {
  const report = await runVerify(ctx, opts);
  if (opts.json) {
    ctx.out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  const mark = (s: string) => (s === "PASS" ? "✓" : s === "WARN" ? "(warn)" : s === "SKIP" ? "(skipped)" : "✗");
  for (const c of report.checks) {
    ctx.out(`${String(c.n)}. ${c.status.padEnd(4)} ${c.name}: ${c.summary}`);
    for (const d of c.details) ctx.out(`        ${d}`);
  }
  ctx.out(report.checks.map((c) => (c.n === 1 ? c.summary : `${c.summary} ${mark(c.status)}`)).join(" · "));
  const registered = readRegistration(configFor(ctx).paths);
  if (isRegistrationV2(registered))
    for (const id of [registered.record.plugins.provider, registered.record.plugins.ledger]) if (id.trust === "full") ctx.out(`PLUGIN TRUST: full (${id.name}@${id.version ?? "unversioned"} runs with your environment and files)`);
  if (report.versions.registered) ctx.out(`registered with pr-rla ${report.versions.registered}${report.versions.frozen ? ` · frozen with pr-rla ${report.versions.frozen}` : ""} · verified with pr-rla ${PR_RLA_VERSION}`);
  const ts = report.timestamps;
  if (ts.registration) {
    for (const [what, s] of [["registration", ts.registration], ["manifest commitment", ts.commitment]] as const) if (s) ctx.out(`${what} ${timestampsLine(s)}`);
    if (!report.timestampTamperProof) {
      const short = !ts.registration.proven ? ts.registration : ts.commitment;
      ctx.out(`${short ? notTamperProof(short) : "TIMESTAMP NOT TAMPER-PROOF"}: registration and/or manifest times are self-asserted (fewer than k timestamp authorities agree)`);
    }
  } else if (!report.timestampTamperProof) ctx.out("TIMESTAMP NOT TAMPER-PROOF: registration and/or manifest times are self-asserted (no transparency-log entry was verified)");
  if (report.status) {
    const reg = readRegistration(configFor(ctx).paths);
    ctx.out(statusLine(report.status, { p0: reg.record.parameters.p0, alpha: reg.record.parameters.alpha, protocol: reg.record.protocolSha256, maxLines: reg.record.selector.max_changed_lines, mode: report.mode, selector: reg.record.selector }));
  }
  ctx.out(report.ok ? "VERIFIED" : `FAILED: ${report.checks.filter((c) => c.status === "FAIL").map((c) => `check ${c.n} (${c.name})`).join(", ")}`);
  return report.ok ? 0 : 1;
}
