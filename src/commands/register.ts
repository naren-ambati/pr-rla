import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { auditMode, beaconParams, derivedRoundFor, type RegistrationRecord, type SignedRecord } from "../core/records.js";
import { loadOrCreateKey, signRecord } from "../core/signing.js";
import { unixToIso } from "../core/seed.js";
import { stoppingTable, effectiveCap } from "../core/sprt.js";
import { CommandError, configFor, isoNow, pct, protocolSha256, writeJson, type CommandContext } from "./context.js";
import { submitSigned, submitUrl } from "./translog.js";

export interface RegisterOptions {
  dryRun?: boolean;
  submit?: boolean;
  rekorUrl?: string;
  key?: string;
  force?: boolean;
}

export async function registerCommand(ctx: CommandContext, opts: RegisterOptions): Promise<number> {
  const { config, paths } = configFor(ctx);
  const record: RegistrationRecord = {
    schema: "pr-rla/registration/v1",
    provider: config.provider.use,
    repo: config.repo,
    window: config.window,
    selector: config.selector,
    protocolSha256: protocolSha256(config),
    parameters: config.parameters,
    beacon: beaconParams(),
    registeredAt: isoNow(ctx),
  };
  if (!opts.dryRun && existsSync(paths.registration) && !opts.force)
    throw new CommandError(`${paths.registration} exists. A new registration replaces the selector; use --force only if the old one was never shown to anyone.`);
  const key = loadOrCreateKey(resolve(config.dir, opts.key ?? config.signingKey));
  let signed: SignedRecord<RegistrationRecord> = signRecord(record, key);
  if (opts.submit && !opts.dryRun) signed = await submitSigned(ctx, signed, submitUrl(config, opts.rekorUrl));
  const mode = auditMode(signed);
  const r = derivedRoundFor(signed);
  const table = stoppingTable(config.parameters).map((x) => x.draws).join(" / ");
  ctx.out(`${opts.dryRun ? "[dry run] " : ""}registration ${signed.sha256.slice(0, 12)}… · ${config.repo} · window ${config.window.name} (${config.window.start}..${config.window.end})`);
  ctx.out(`  claim D: detected-defect rate <= ${pct(config.parameters.p0)} (p1 ${pct(config.parameters.p1)}, risk ${pct(config.parameters.alpha)}) · certify after ${table} draws with 0/1/2 fails · cap ${effectiveCap(config.parameters)}`);
  ctx.out(`  selector ${JSON.stringify(config.selector)}`);
  ctx.out(`  protocol ${record.protocolSha256.slice(0, 12)}… (${config.protocol})`);
  ctx.out(`  ${mode}${mode === "RETROSPECTIVE" ? " (registered after the window opened: a demonstration, not evidence)" : ""}`);
  ctx.out(`  seed round R = ${r.round} (drand quicknet), publishes ${unixToIso(r.publishesAt)}: 24 h after the ${r.base === "registration" ? "registration" : "window close"}`);
  if (!signed.log) ctx.out("  TIMESTAMP NOT TAMPER-PROOF: written locally only (not submitted to a transparency log; pass --submit --rekor-url <url>)");
  else ctx.out(`  logged at ${signed.log.logUrl} · index ${signed.log.logIndex} · integratedTime ${unixToIso(signed.log.integratedTime)}`);
  if (opts.dryRun) return 0;
  writeJson(paths.registration, signed);
  ctx.out(`wrote ${paths.registration}`);
  return 0;
}
