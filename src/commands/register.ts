import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describeRepoSet, registerRuleRepos, RepoSetError, resolveRepoSet } from "../core/repo-set.js";
import { beaconParams, derivedRoundFor, type AuditMode, type RegisteredRepo, type RegisteredVisibility, type RegistrationRecordV2, type SignedRecord } from "../core/records.js";
import { ephemeralKey, loadOrCreateKey, signRecord } from "../core/signing.js";
import { unixToIso } from "../core/seed.js";
import { stoppingTable, effectiveCap } from "../core/sprt.js";
import { providerTraits } from "../provider-traits.js";
import { preflightExternalLedger } from "../plugins/open.js";
import { builtinLedgerName, loadLedgerDefinition, pluginIdentity } from "../registry.js";
import type { ProvenanceLevel } from "../sdk/ledger.js";
import { maxProvenanceOf, SIGNATURE_LEDGERS } from "../ledger-traits.js";
import { PRESENCE_LIMIT, presenceReachable, registeredVerdicts, verdictRuleWarnings, verdictsSummary, type RegisteredVerdicts } from "../core/presence/index.js";
import type { PrRlaConfig, WindowPaths } from "../config.js";
import { isoMs } from "../timestamp/verify.js";
import { PR_RLA_VERSION } from "../version.js";
import { auditContextFor, CommandError, configFor, isoNow, pct, protocolSha256, providerFor, trustFor, writeJson, type CommandContext } from "./context.js";
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
 * An external ledger must be locked, and an isolated one does all of this in its plugin host.
 */
export async function preflightLedger(ctx: CommandContext, config: PrRlaConfig, paths: WindowPaths): Promise<RegisteredVerdicts> {
  const offline = (async () => {
    throw new CommandError("register's preflight contacts no tracker");
  }) as unknown as typeof fetch;
  let def: { name: string; provenance?: ProvenanceLevel };
  if (builtinLedgerName(config.ledger.use)) {
    const builtin = await loadLedgerDefinition(config.ledger.use, config.dir);
    def = builtin;
    try {
      builtin.hosts?.(config.ledger.options);
      builtin.writePaths?.(config.ledger.options);
      await builtin.create(config.ledger.options, { cwd: config.dir, windowDir: paths.windowDir, env: ctx.env, log: () => {}, fetch: offline });
    } catch (e) {
      throw new CommandError(`ledger ${config.ledger.use}: ${(e as Error).message}`);
    }
  } else {
    const x = await preflightExternalLedger(auditContextFor(ctx), config.ledger, config.dir, paths.windowDir, offline);
    if (x.problem) throw new CommandError(`ledger ${config.ledger.use}: ${x.problem}`);
    def = x;
  }
  // U9: git-file reaches account and presence through per-verdict signatures; SSH keys count only there.
  const builtin = !!builtinLedgerName(config.ledger.use);
  const input = {
    ledger: def.name,
    verifiesSignatures: builtin && SIGNATURE_LEDGERS.has(def.name),
    ledgerLevel: def.provenance ?? "self-asserted",
    ledgerCeiling: maxProvenanceOf(builtin, def.name, def.provenance ?? "self-asserted"),
    minProvenance: config.verdicts.minProvenance,
    reviewers: config.verdicts.reviewers,
    allowedSigners: config.verdicts.allowedSigners,
    requireSigned: config.ledger.options.require_signed === true,
  };
  try {
    const verdicts = registeredVerdicts(input);
    for (const w of verdictRuleWarnings(input, verdicts)) ctx.out(`  warning: ${w}`);
    return verdicts;
  } catch (e) {
    throw new CommandError((e as Error).message);
  }
}

/**
 * A pooled registration (a repo list or a rule) is checked before it is signed (FR5.1, FR5.6): one provider per
 * pool, a provider that can list repos for a rule, and a rule that matches something now (a dry resolve, reads
 * only). Returns the repos it resolves to, or null for a single repo. A rule's are signed into the registration
 * (`registeredRepos`, by id), so a repo archived, renamed or made private after registration stays in the pool.
 */
async function preflightRepoSet(ctx: CommandContext, config: PrRlaConfig): Promise<{ count: number; registered: RegisteredRepo[] | null; visibility: RegisteredVisibility | null; warnings: string[] } | null> {
  if (config.repoSet.kind === "repo") return null;
  try {
    // A rule (P3): the repos it matches, by id, and what the token can prove it saw (src/core/repo-set.ts).
    const rule = config.repoSet.kind === "rule" ? await registerRuleRepos(await providerFor(ctx, config), config.repoSet) : null;
    const count = rule ? rule.registered.length : (await resolveRepoSet(await providerFor(ctx, config), config.repoSet)).length;
    if (count === 0) throw new CommandError(`${describeRepoSet(config.repoSet)} matches no repository the token can see; widen the rule, or check the token's access`);
    return { count, registered: rule?.registered ?? null, visibility: rule?.visibility ?? null, warnings: rule?.warnings ?? [] };
  } catch (e) {
    if (e instanceof RepoSetError) throw new CommandError(e.message);
    throw e;
  }
}

export async function registerCommand(ctx: CommandContext, opts: RegisterOptions): Promise<number> {
  const { config, paths } = configFor(ctx);
  const bundle = trustFor(ctx, opts.tsaTrust);
  const timestamping = timestampingFor(config, bundle);
  const api = rekorApi(opts.rekorApi);
  const verdicts = await preflightLedger(ctx, config, paths);
  const pool = await preflightRepoSet(ctx, config);
  const record: RegistrationRecordV2 = {
    schema: "pr-rla/registration/v2",
    repos: config.repoSet,
    ...(pool?.registered ? { registeredRepos: pool.registered } : {}),
    ...(pool?.visibility ? { registeredVisibility: pool.visibility } : {}),
    window: config.window,
    selector: config.selector,
    protocolSha256: protocolSha256(config),
    parameters: config.parameters,
    beacon: beaconParams(),
    registeredAt: isoNow(ctx),
    timestamping,
    plugins: { provider: await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx).plugins), ledger: await pluginIdentity(config.ledger, "ledger", config.dir, auditContextFor(ctx).plugins) },
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
  if (pool !== null) ctx.out(`  repos: ${describeRepoSet(config.repoSet)} · resolves to ${pool.count} now${pool.registered ? " (signed by repo id: they stay in the pool whatever their name, archive state or visibility at freeze)" : ""}; resolved again at freeze, one certificate for the pool`);
  for (const w of pool?.warnings ?? []) ctx.out(`  WARNING: ${w}`);
  ctx.out(`  claim D: detected-defect rate <= ${pct(config.parameters.p0)} (p1 ${pct(config.parameters.p1)}, risk ${pct(config.parameters.alpha)}) · certify after ${table} draws with 0/1/2 fails · cap ${effectiveCap(config.parameters)}`);
  ctx.out(`  selector ${JSON.stringify(config.selector)}`);
  if (config.selector.direct_push_via_merge === "exclude" && config.selector.kinds.includes("direct_push")) {
    const traits = await providerTraits(config.provider, config.dir, auditContextFor(ctx).plugins);
    if (!traits.reportsLandedVia) ctx.out(`  warning: provider ${traits.name} does not report landedVia; direct_push_via_merge has no effect`);
  }
  ctx.out(`  protocol ${record.protocolSha256.slice(0, 12)}… (${config.protocol})`);
  ctx.out(`  provider ${record.plugins.provider.name} (${record.plugins.provider.source}${record.plugins.provider.version ? ` ${record.plugins.provider.version}` : ""}) · ledger ${record.plugins.ledger.name} · ${verdictsSummary(record.verdicts)}`);
  if (presenceReachable(record.verdicts.allowed_signers)) ctx.out(`  ${PRESENCE_LIMIT}`);
  for (const id of [record.plugins.provider, record.plugins.ledger]) {
    if (id.integrity) ctx.out(`  plugin ${id.name}: trust ${id.trust} · treeSha256 ${id.integrity.slice(0, 12)}… (pr-rla.lock.json)`);
    if (id.trust === "full") ctx.out(`  PLUGIN TRUST: full (${id.name}@${id.version ?? "unversioned"} runs with your environment and files)`);
  }
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
