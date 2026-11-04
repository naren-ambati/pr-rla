import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beaconParams, derivedRoundFor, type AuditMode, type RegistrationRecordV2, type SignedRecord } from "../core/records.js";
import { ephemeralKey, loadOrCreateKey, signRecord } from "../core/signing.js";
import { unixToIso } from "../core/seed.js";
import { stoppingTable, effectiveCap } from "../core/sprt.js";
import { loadLedgerDefinition, pluginIdentity } from "../registry.js";
import { provenanceRank, type ProvenanceLevel } from "../sdk/ledger.js";
import type { PrRlaConfig, WindowPaths } from "../config.js";
import { isoMs } from "../timestamp/verify.js";
import { PR_RLA_VERSION } from "../version.js";
import { CommandError, configFor, isoNow, pct, protocolSha256, trustFor, writeJson, type CommandContext } from "./context.js";
import { assessRecord, obtainTimestamps, reportTimestamps, timestampingFor } from "./timestamps.js";
import { confirmRekorV2, rekorApi, submitSigned, submitSignedV2, submitUrl } from "./translog.js";

export interface RegisterOptions {
  dryRun?: boolean;
  submit?: boolean;
  rekorUrl?: string;
  /** v1 (default) or v2. v2 is unverified against the production log and needs --yes. */
  rekorApi?: string;
  yes?: boolean;
  key?: string;
  force?: boolean;
  /** Extra timestamp-authority anchors (files), for authorities outside the shipped bundle. */
  tsaTrust?: string[];
}

export const REREGISTER_COMMAND = "pr-rla register --force";

/**
 * The ledger part of register's preflight: the ledger loads, its options are valid (hosts,
 * writePaths and create() all check them), and nothing is contacted. Returns the verdict rules
 * the registration fixes (FR3.8): `min_provenance` from .pr-rla.yml, else the ledger's own level.
 */
export async function preflightLedger(ctx: CommandContext, config: PrRlaConfig, paths: WindowPaths): Promise<{ minProvenance: ProvenanceLevel; reviewers: string[] | null }> {
  const def = await loadLedgerDefinition(config.ledger.use, config.dir);
  const offline = (async () => {
    throw new CommandError("register's preflight contacts no tracker");
  }) as unknown as typeof fetch;
  try {
    def.hosts?.(config.ledger.options);
    def.writePaths?.(config.ledger.options);
    await def.create(config.ledger.options, { cwd: config.dir, windowDir: paths.windowDir, env: ctx.env, log: () => {}, fetch: offline });
  } catch (e) {
    throw new CommandError(`ledger ${config.ledger.use}: ${(e as Error).message}`);
  }
  const level = def.provenance ?? "self-asserted";
  const minProvenance = config.verdicts.minProvenance ?? level;
  if (provenanceRank(minProvenance) > provenanceRank(level))
    throw new CommandError(`verdicts.min_provenance is ${minProvenance}, but ledger ${def.name} records ${level} verdicts, so no verdict could count; use an issue ledger (github-issues, gitlab-issues) for account provenance`);
  return { minProvenance, reviewers: config.verdicts.reviewers };
}

export async function registerCommand(ctx: CommandContext, opts: RegisterOptions): Promise<number> {
  const { config, paths } = configFor(ctx);
  const bundle = trustFor(ctx, opts.tsaTrust);
  const timestamping = timestampingFor(config, bundle);
  const api = rekorApi(opts.rekorApi);
  const verdicts = await preflightLedger(ctx, config, paths);
  const record: RegistrationRecordV2 = {
    schema: "pr-rla/registration/v2",
    repos: { kind: "repo", repo: config.repo },
    window: config.window,
    selector: config.selector,
    protocolSha256: protocolSha256(config),
    parameters: config.parameters,
    beacon: beaconParams(),
    registeredAt: isoNow(ctx),
    timestamping,
    plugins: { provider: await pluginIdentity(config.provider, "provider", config.dir), ledger: await pluginIdentity(config.ledger, "ledger", config.dir) },
    // FR3.8: `account` by default with an issue ledger, `self-asserted` with git-file.
    verdicts,
    prRlaVersion: PR_RLA_VERSION,
  };
  if (!opts.dryRun && existsSync(paths.registration) && !opts.force)
    throw new CommandError(`${paths.registration} exists. A new registration replaces the selector; use --force only if the old one was never shown to anyone.`);
  const url = opts.submit && !opts.dryRun ? submitUrl(config, opts.rekorUrl) : null;
  if (url && api === "v2") await confirmRekorV2(ctx, opts.yes);
  // A dry run writes nothing, not even a key, and asks no authority: it signs with a throwaway in-memory key.
  const key = opts.dryRun ? ephemeralKey() : loadOrCreateKey(resolve(config.dir, opts.key ?? config.signingKey));
  let signed: SignedRecord<RegistrationRecordV2> = signRecord(record, key);
  const r = derivedRoundFor(signed);
  const table = stoppingTable(config.parameters).map((x) => x.draws).join(" / ");
  ctx.out(`${opts.dryRun ? "[dry run] " : ""}registration ${signed.sha256.slice(0, 12)}… · ${config.repo} · window ${config.window.name} (${config.window.start}..${config.window.end})`);
  ctx.out(`  claim D: detected-defect rate <= ${pct(config.parameters.p0)} (p1 ${pct(config.parameters.p1)}, risk ${pct(config.parameters.alpha)}) · certify after ${table} draws with 0/1/2 fails · cap ${effectiveCap(config.parameters)}`);
  ctx.out(`  selector ${JSON.stringify(config.selector)}`);
  ctx.out(`  protocol ${record.protocolSha256.slice(0, 12)}… (${config.protocol})`);
  ctx.out(`  provider ${record.plugins.provider.name} (${record.plugins.provider.source}${record.plugins.provider.version ? ` ${record.plugins.provider.version}` : ""}) · ledger ${record.plugins.ledger.name} · verdict provenance ${record.verdicts.minProvenance}${record.verdicts.reviewers ? ` · reviewers ${record.verdicts.reviewers.join(", ")}` : ""}`);
  ctx.out(`  seed round R = ${r.round} (drand quicknet), publishes ${unixToIso(r.publishesAt)}: 24 h after the ${r.base === "registration" ? "registration" : "window close"}`);
  const claimed: AuditMode = Date.parse(record.registeredAt) < Date.parse(record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE";
  const retro = " (registered after the window opened: a demonstration, not evidence)";
  if (opts.dryRun) {
    ctx.out(`  ${claimed}${claimed === "RETROSPECTIVE" ? retro : ""}`);
    ctx.out(`  timestamps: not requested (dry run) · authorities ${timestamping.authorities.join(", ") || "none"} · k = ${timestamping.minTokens}`);
    return 0;
  }

  const got = await obtainTimestamps(ctx, signed, record.registeredAt, timestamping, bundle);
  signed = { ...signed, timestamps: got.timestamps };
  writeJson(paths.registration, signed);
  if (url) {
    try {
      signed = api === "v2" ? await submitSignedV2(ctx, config, signed, url) : await submitSigned(ctx, signed, url);
      writeJson(paths.registration, signed);
    } catch (e) {
      ctx.out(`wrote ${paths.registration} with its timestamps; the transparency-log submission failed: ${(e as Error).message}`);
      return 1;
    }
  }
  const summary = await assessRecord(ctx, config, signed, record.registeredAt, timestamping, bundle);
  const mode: AuditMode = summary.proven ? (summary.ukMs! < Date.parse(record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE") : claimed;
  ctx.out(`  ${mode}${mode === "RETROSPECTIVE" ? retro : ""}${summary.proven ? ` · registration existed by ${isoMs(summary.ukMs!)} (U_k)` : summary.configured.length ? " (unproven: too few timestamps)" : ""}`);
  const code = reportTimestamps(ctx, summary, got.outcomes, REREGISTER_COMMAND);
  if (signed.log && !("apiVersion" in signed.log)) ctx.out(`  logged at ${signed.log.logUrl} · index ${signed.log.logIndex} · integratedTime ${unixToIso(signed.log.integratedTime)}`);
  else if (signed.log) ctx.out(`  in Rekor v2 log ${signed.log.logUrl} · index ${signed.log.logIndex} (v2 entries carry no time; unverified against the production log)`);
  ctx.out(`wrote ${paths.registration}`);
  return code;
}
