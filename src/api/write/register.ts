import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beaconParams, derivedRoundFor, type AuditMode, type LoggedEntry, type RegistrationRecordV2, type RekorV2Entry, type SignedRecord } from "../../core/records.js";
import { unixToIso } from "../../core/seed.js";
import { ephemeralKey, loadOrCreateKey, signRecord } from "../../core/signing.js";
import { effectiveCap, stoppingTable } from "../../core/sprt.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { preflightExternalLedger } from "../../plugins/open.js";
import { providerTraits } from "../../provider-traits.js";
import { builtinLedgerName, loadLedgerDefinition, pluginIdentity } from "../../registry.js";
import { provenanceRank, type ProvenanceLevel } from "../../sdk/ledger.js";
import type { AuthorityOutcome } from "../../timestamp/client.js";
import type { TimeEvidenceSummary } from "../../timestamp/verify.js";
import { PR_RLA_VERSION } from "../../version.js";
import { requireReadWrite } from "../context.js";
import { AuditError } from "../errors.js";
import { auditContextFor, configFor, isoNow, protocolSha256, trustFor, type ApiContext } from "../session.js";
import { assessRecord, timestampingFor } from "../timestamps.js";
import { writeJson } from "./files.js";
import { obtainTimestamps } from "./timestamps.js";
import { rekorApi, submitSigned, submitSignedV2, submitUrl, type RekorApi } from "./translog.js";

export const REREGISTER_COMMAND = "pr-rla register --force";

export interface RegisterOptions {
  dryRun?: boolean;
  submit?: boolean;
  rekorUrl?: string;
  /** v1 (default) or v2. v2 is unverified against the production log and needs confirmation. */
  rekorApi?: string;
  key?: string;
  force?: boolean;
  /** Extra timestamp-authority anchors (files), for authorities outside the shipped bundle. */
  tsaTrust?: string[];
}

export interface RegisterHooks {
  /** The signed registration, before any authority is asked or anything is written (the CLI prints it here). */
  onPlanned?: (plan: RegistrationPlan) => void;
  /** Called before a `--submit --rekor-api v2` run contacts anything; it throws to refuse. */
  confirmRekorV2?: () => Promise<void>;
}

/** The registration as signed, and what follows from it. A dry run signs it with a throwaway key. */
export interface RegistrationPlan {
  dryRun: boolean;
  signed: SignedRecord<RegistrationRecordV2>;
  /** The protocol file, as .pr-rla.yml names it. */
  protocolFile: string;
  seedRound: number;
  seedRoundPublishesAt: string;
  /** What R is counted from: 24 h after the registration, or after the window closes. */
  seedRoundBase: "window-close" | "registration";
  /** Draws that certify with 0, 1 and 2 fails. */
  stoppingTable: number[];
  cap: number;
  /** The mode the registration's own clock claims (proven only by k timestamp tokens). */
  claimed: AuditMode;
  /** Set when direct_push_via_merge: exclude has no effect with this provider. */
  landedViaWarning: string | null;
}

/** What `register` wrote. */
export interface RegisterResult extends RegistrationPlan {
  /** The registration file (null on a dry run, which writes nothing). */
  path: string | null;
  /** PROSPECTIVE or RETROSPECTIVE, proven by U_k when k operators agree. */
  mode: AuditMode;
  evidence: TimeEvidenceSummary | null;
  outcomes: AuthorityOutcome[];
  log: LoggedEntry | RekorV2Entry | null;
  /** The submission failed after the registration was written with its timestamps (the CLI exits 1). */
  submitError: string | null;
}

/**
 * The ledger part of register's preflight: the ledger loads, its options are valid (hosts,
 * writePaths and create() all check them), and nothing is contacted. Returns the verdict rules
 * the registration fixes (FR3.8): `min_provenance` from .pr-rla.yml, else the ledger's own level.
 * An external ledger must be locked, and an isolated one does all of this in its plugin host.
 */
export async function preflightLedger(ctx: ApiContext, config: PrRlaConfig, paths: WindowPaths): Promise<{ minProvenance: ProvenanceLevel; reviewers: string[] | null }> {
  const offline = (async () => {
    throw new AuditError("register's preflight contacts no tracker");
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
      throw new AuditError(`ledger ${config.ledger.use}: ${(e as Error).message}`);
    }
  } else {
    const x = await preflightExternalLedger(auditContextFor(ctx), config.ledger, config.dir, paths.windowDir, offline);
    if (x.problem) throw new AuditError(`ledger ${config.ledger.use}: ${x.problem}`);
    def = x;
  }
  const level = def.provenance ?? "self-asserted";
  const minProvenance = config.verdicts.minProvenance ?? level;
  if (provenanceRank(minProvenance) > provenanceRank(level))
    throw new AuditError(`verdicts.min_provenance is ${minProvenance}, but ledger ${def.name} records ${level} verdicts, so no verdict could count; use an issue ledger (github-issues, gitlab-issues) for account provenance`);
  return { minProvenance, reviewers: config.verdicts.reviewers };
}

/**
 * `register` (write side): signs the selector, window, parameters, protocol hash and plugins,
 * time-stamps the registration with the configured authorities and writes it. A dry run signs
 * with a throwaway key and writes nothing. CLI only; refused in a read-only context.
 */
export async function register(ctx: ApiContext, opts: RegisterOptions = {}, hooks: RegisterHooks = {}): Promise<RegisterResult> {
  requireReadWrite(auditContextFor(ctx), "register");
  const { config, paths } = configFor(ctx);
  const bundle = trustFor(ctx, opts.tsaTrust);
  const timestamping = timestampingFor(config, bundle);
  const api: RekorApi = rekorApi(opts.rekorApi);
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
    plugins: { provider: await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx).plugins), ledger: await pluginIdentity(config.ledger, "ledger", config.dir, auditContextFor(ctx).plugins) },
    // FR3.8: `account` by default with an issue ledger, `self-asserted` with git-file.
    verdicts,
    prRlaVersion: PR_RLA_VERSION,
  };
  if (!opts.dryRun && existsSync(paths.registration) && !opts.force)
    throw new AuditError(`${paths.registration} exists. A new registration replaces the selector; use --force only if the old one was never shown to anyone.`);
  const url = opts.submit && !opts.dryRun ? submitUrl(config, opts.rekorUrl) : null;
  if (url && api === "v2") {
    if (!hooks.confirmRekorV2) throw new AuditError("not submitted: a Rekor v2 submission needs confirmation (nothing was written)");
    await hooks.confirmRekorV2();
  }
  // A dry run writes nothing, not even a key, and asks no authority: it signs with a throwaway in-memory key.
  const key = opts.dryRun ? ephemeralKey() : loadOrCreateKey(resolve(config.dir, opts.key ?? config.signingKey));
  let signed: SignedRecord<RegistrationRecordV2> = signRecord(record, key);
  const r = derivedRoundFor(signed);
  let landedViaWarning: string | null = null;
  if (config.selector.direct_push_via_merge === "exclude" && config.selector.kinds.includes("direct_push")) {
    const traits = await providerTraits(config.provider, config.dir, auditContextFor(ctx).plugins);
    if (!traits.reportsLandedVia) landedViaWarning = `provider ${traits.name} does not report landedVia; direct_push_via_merge has no effect`;
  }
  const claimed: AuditMode = Date.parse(record.registeredAt) < Date.parse(record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE";
  const plan: RegistrationPlan = {
    dryRun: !!opts.dryRun,
    signed,
    protocolFile: config.protocol,
    seedRound: r.round,
    seedRoundPublishesAt: unixToIso(r.publishesAt),
    seedRoundBase: r.base,
    stoppingTable: stoppingTable(config.parameters).map((x) => x.draws),
    cap: effectiveCap(config.parameters),
    claimed,
    landedViaWarning,
  };
  hooks.onPlanned?.(plan);
  if (opts.dryRun) return { ...plan, path: null, mode: claimed, evidence: null, outcomes: [], log: null, submitError: null };

  const got = await obtainTimestamps(ctx, signed, record.registeredAt, timestamping, bundle);
  signed = { ...signed, timestamps: got.timestamps };
  writeJson(paths.registration, signed);
  const written = { ...plan, signed, path: paths.registration, outcomes: got.outcomes };
  if (url) {
    try {
      signed = api === "v2" ? await submitSignedV2(ctx, config, signed, url) : await submitSigned(ctx, signed, url);
      writeJson(paths.registration, signed);
    } catch (e) {
      return { ...written, mode: claimed, evidence: null, log: null, submitError: (e as Error).message };
    }
  }
  const evidence = await assessRecord(ctx, config, signed, record.registeredAt, timestamping, bundle);
  const mode: AuditMode = evidence.proven ? (evidence.ukMs! < Date.parse(record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE") : claimed;
  return { ...written, signed, mode, evidence, log: signed.log, submitError: null };
}
