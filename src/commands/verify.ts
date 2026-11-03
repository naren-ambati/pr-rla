import { existsSync } from "node:fs";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../beacon/drand.js";
import { verifyAudit, type VerifyReport } from "../core/verify.js";
import { statusLine } from "./status.js";
import {
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
  return verifyAudit(
    { registration, manifest, commitment, draws, currentProtocolSha256: currentProtocol },
    {
      provider: opts.offline ? null : await providerFor(ctx, config),
      ledger: await ledgerFor(ctx, config, paths),
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
    },
  );
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
    ctx.out(statusLine(report.status, { p0: reg.record.parameters.p0, alpha: reg.record.parameters.alpha, protocol: reg.record.protocolSha256, maxLines: reg.record.selector.max_changed_lines, mode: report.mode }));
  }
  ctx.out(report.ok ? "VERIFIED" : `FAILED: ${report.checks.filter((c) => c.status === "FAIL").map((c) => `check ${c.n} (${c.name})`).join(", ")}`);
  return report.ok ? 0 : 1;
}
