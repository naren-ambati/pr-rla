import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describeRepoSet, RepoSetError, resolveRepoSet } from "../../core/repo-set.js";
import { beaconParams, derivedRoundFor, type AuditMode, type LoggedEntry, type RegisteredRepo, type RegistrationRecordV2, type RekorV2Entry, type SignedRecord } from "../../core/records.js";
import { unixToIso } from "../../core/seed.js";
import { ephemeralKey, loadOrCreateKey, signRecord } from "../../core/signing.js";
import { effectiveCap, stoppingTable } from "../../core/sprt.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { preflightExternalLedger } from "../../plugins/open.js";
import { providerTraits } from "../../provider-traits.js";
import { builtinLedgerName, loadLedgerDefinition, pluginIdentity } from "../../registry.js";
import { gitFileRegisteredPath } from "../../ledgers/git-file.js";
import type { ProvenanceLevel } from "../../sdk/ledger.js";
import { maxProvenanceOf, SIGNATURE_LEDGERS } from "../../ledger-traits.js";
import { registeredVerdicts, verdictRuleWarnings, type RegisteredVerdicts } from "../../core/presence/index.js";
import type { AuthorityOutcome } from "../../timestamp/client.js";
import type { TimeEvidenceSummary } from "../../timestamp/verify.js";
import { PR_RLA_VERSION } from "../../version.js";
import { AuditError } from "../errors.js";
import { auditContextFor, configFor, isoNow, protocolSha256, providerFor, trustFor, requireWritable, type ApiContext } from "../session.js";
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
  /**
   * The signed registration's first facts (its digest, the claim, the selector), before the
   * provider's traits are read: the CLI prints its first lines here, so they come out, as they always
   * have, even when reading the traits fails. `landedViaWarning` is still null here.
   */
  onHeader?: (plan: RegistrationPlan) => void;
  /** The signed registration, before any authority is asked or anything is written (the CLI prints the rest of it here). */
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
  /** Warnings about the verdict rules (U9): keys registered while unsigned verdicts would still count, and the like. */
  verdictWarnings: string[];
  /** A pooled registration (U8): the repo set, how many repos it resolves to now, and whether they are signed in by id. */
  pool: { describe: string; count: number; registeredById: boolean } | null;
  /** The built-in git-file ledger's path from the toplevel, signed in (P4), or why there is none; null for other ledgers. */
  ledgerPath: { path: string } | { path: null; why: string } | null;
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
export async function preflightLedger(ctx: ApiContext, config: PrRlaConfig, paths: WindowPaths): Promise<{ verdicts: RegisteredVerdicts; warnings: string[] }> {
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
    return { verdicts, warnings: verdictRuleWarnings(input, verdicts) };
  } catch (e) {
    throw new AuditError((e as Error).message);
  }
}

function registeredLedgerPath(windowDir: string, options: Record<string, unknown>): ReturnType<typeof gitFileRegisteredPath> {
  try {
    return gitFileRegisteredPath(windowDir, options);
  } catch (e) {
    throw new AuditError((e as Error).message);
  }
}

/**
 * A pooled registration (a repo list or a rule) is checked before it is signed (FR5.1, FR5.6): one provider per
 * pool, a provider that can list repos for a rule, and a rule that matches something now (a dry resolve, reads
 * only). Returns the repos it resolves to, or null for a single repo. A rule's are signed into the registration
 * (`registeredRepos`, by id), so a repo archived, renamed or made private after registration stays in the pool.
 */
async function preflightRepoSet(ctx: ApiContext, config: PrRlaConfig): Promise<{ count: number; registered: RegisteredRepo[] | null } | null> {
  if (config.repoSet.kind === "repo") return null;
  try {
    const resolved = await resolveRepoSet(await providerFor(ctx, config), config.repoSet);
    if (resolved.length === 0) throw new AuditError(`${describeRepoSet(config.repoSet)} matches no repository the token can see; widen the rule, or check the token's access`);
    return { count: resolved.length, registered: config.repoSet.kind === "rule" ? resolved.map((r) => ({ repo: r.repo, repoId: r.repoId! })) : null };
  } catch (e) {
    if (e instanceof RepoSetError) throw new AuditError(e.message);
    throw e;
  }
}

/**
 * `register` (write side): signs the selector, window, parameters, protocol hash and plugins,
 * time-stamps the registration with the configured authorities and writes it. A dry run signs
 * with a throwaway key and writes nothing. CLI only; refused in a read-only context.
 */
export async function register(ctx: ApiContext, opts: RegisterOptions = {}, hooks: RegisterHooks = {}): Promise<RegisterResult> {
  requireWritable(ctx, "register");
  const { config, paths } = configFor(ctx);
  const bundle = trustFor(ctx, opts.tsaTrust);
  const timestamping = timestampingFor(config, bundle);
  const api: RekorApi = rekorApi(opts.rekorApi);
  const { verdicts, warnings: verdictWarnings } = await preflightLedger(ctx, config, paths);
  // P4: the built-in git-file ledger's path from the repository's toplevel is signed in; verify reads it only there.
  const ledgerPath = builtinLedgerName(config.ledger.use) === "git-file" ? registeredLedgerPath(paths.windowDir, config.ledger.options) : null;
  const pool = await preflightRepoSet(ctx, config);
  const record: RegistrationRecordV2 = {
    schema: "pr-rla/registration/v2",
    repos: config.repoSet,
    ...(pool?.registered ? { registeredRepos: pool.registered } : {}),
    window: config.window,
    selector: config.selector,
    protocolSha256: protocolSha256(config),
    parameters: config.parameters,
    beacon: beaconParams(),
    registeredAt: isoNow(ctx),
    timestamping,
    plugins: { provider: await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx)), ledger: await pluginIdentity(config.ledger, "ledger", config.dir, auditContextFor(ctx)) },
    ...(ledgerPath?.path ? { ledgerPath: ledgerPath.path } : {}),
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
    landedViaWarning: null,
    verdictWarnings,
    pool: pool ? { describe: describeRepoSet(config.repoSet), count: pool.count, registeredById: !!pool.registered } : null,
    ledgerPath,
  };
  hooks.onHeader?.(plan);
  if (config.selector.direct_push_via_merge === "exclude" && config.selector.kinds.includes("direct_push")) {
    const traits = await providerTraits(config.provider, config.dir, auditContextFor(ctx));
    if (!traits.reportsLandedVia) plan.landedViaWarning = `provider ${traits.name} does not report landedVia; direct_push_via_merge has no effect`;
  }
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
  return { ...written, signed, mode, evidence, log: signed.log ?? null, submitError: null };
}
