import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  manifestSha256,
  type CommitmentRecordV2,
  type LoggedEntry,
  type Manifest,
  type ManifestCommitmentRecord,
  type ManifestV2,
  type RegistrationRecordV2,
  type RekorV2Entry,
  type SignedRecord,
} from "../../core/records.js";
import { isRegistrationV2 } from "../../core/records.js";
import { unixToIso } from "../../core/seed.js";
import { loadOrCreateKey, signRecord } from "../../core/signing.js";
import { providerTraits } from "../../provider-traits.js";
import { pluginIdentity } from "../../registry.js";
import { PROVIDER_API_VERSION } from "../../sdk/provider.js";
import type { AuthorityOutcome } from "../../timestamp/client.js";
import type { TimeEvidenceSummary } from "../../timestamp/verify.js";
import { PR_RLA_VERSION } from "../../version.js";
import { requireReadWrite } from "../context.js";
import { AuditError } from "../errors.js";
import { planFreeze, type FreezePreview } from "../read/freeze-preview.js";
import { auditContextFor, trustFor, type ApiContext } from "../session.js";
import { assessRecord } from "../timestamps.js";
import { writeJson } from "./files.js";
import { obtainTimestamps } from "./timestamps.js";
import { rekorApi, submitSigned, submitSignedV2, submitUrl, type RekorApi } from "./translog.js";

export const REFREEZE_COMMAND = "pr-rla freeze --force";

export interface FreezeOptions {
  submit?: boolean;
  rekorUrl?: string;
  rekorApi?: string;
  key?: string;
  /** Replace an existing manifest (only if it was never shown to anyone, and only before R publishes). */
  force?: boolean;
  tsaTrust?: string[];
}

export interface FreezeHooks {
  /** The population, before anything is signed or written (the CLI prints it here). */
  onPopulation?: (preview: FreezePreview) => void;
  /** Called before a `--submit --rekor-api v2` run contacts anything; it throws to refuse (the CLI asks, or takes --yes). */
  confirmRekorV2?: () => Promise<void>;
}

/** What `freeze` wrote: the population, the manifest, its commitment, and the commitment's time evidence. */
export interface FreezeResult extends Omit<FreezePreview, "dryRun"> {
  dryRun: false;
  schema: "pr-rla/manifest/v1" | "pr-rla/manifest/v2";
  manifestSha256: string;
  manifestPath: string;
  commitmentPath: string;
  seedRound: number;
  seedRoundPublishesAt: string;
  /** The commitment's transparency-log entry, if submitted. */
  log: LoggedEntry | RekorV2Entry | null;
  /** The submission failed after the commitment was written with its timestamps (the CLI exits 1). */
  submitError: string | null;
  /** Schema v2: the commitment's RFC 3161 evidence and each authority's outcome. */
  evidence: TimeEvidenceSummary | null;
  outcomes: AuthorityOutcome[];
}

/**
 * `freeze` (write side): lists the window with the registered selector, signs the manifest's
 * commitment, time-stamps it and writes both. CLI only; refused in a read-only context.
 */
export async function freeze(ctx: ApiContext, opts: FreezeOptions = {}, hooks: FreezeHooks = {}): Promise<FreezeResult> {
  requireReadWrite(auditContextFor(ctx), "freeze");
  // Set by the refusals that run before listing (as freeze always ran them).
  const submit: { url: string | null; api: RekorApi } = { url: null, api: "v1" };
  const plan = await planFreeze(ctx, {
    dryRun: false,
    beforeListing: async ({ config, paths }) => {
      if (!opts.force && existsSync(paths.commitment))
        throw new AuditError(`${paths.commitment} exists: this window is frozen. Use --force only if the manifest was never shown to anyone (it is replaced, with new timestamps).`);
      submit.api = rekorApi(opts.rekorApi);
      submit.url = opts.submit ? submitUrl(config, opts.rekorUrl) : null;
      if (submit.url && submit.api === "v2") {
        if (!hooks.confirmRekorV2) throw new AuditError("not submitted: a Rekor v2 submission needs confirmation (nothing was written)");
        await hooks.confirmRekorV2();
      }
    },
  });
  hooks.onPopulation?.(plan.preview);
  const { config, paths, pop, provider, selector, window, parameters, protocol, repo, frozenAt } = plan;
  const reg = plan.reg!;
  const { url, api } = submit;
  const round = plan.round!;
  const N = pop.entries.length;
  const { dryRun: _dry, ...population } = plan.preview;
  const base = { ...population, dryRun: false as const, manifestPath: paths.manifest, commitmentPath: paths.commitment, seedRound: round.round, seedRoundPublishesAt: unixToIso(round.publishesAt) };

  const key = loadOrCreateKey(resolve(config.dir, opts.key ?? config.signingKey));
  if (!isRegistrationV2(reg)) {
    // A v1 registration (made before bolt 1) is frozen as v1, so the audit stays one schema end to end.
    const body: Omit<Manifest, "sha256"> = {
      schema: "pr-rla/manifest/v1",
      repo,
      provider: { name: provider.name, apiVersion: PROVIDER_API_VERSION },
      defaultBranch: pop.listed.defaultBranch,
      window,
      frozenAt,
      registrationSha256: reg.sha256,
      selector,
      parameters,
      protocolSha256: protocol,
      funnel: pop.selection.funnel,
      limitations: pop.limitations,
      N,
      changes: pop.entries,
    };
    const manifest: Manifest = { ...body, sha256: manifestSha256(body) };
    const commitment: ManifestCommitmentRecord = {
      schema: "pr-rla/manifest-commitment/v1",
      repo,
      window: window.name,
      manifestSha256: manifest.sha256,
      N,
      registrationSha256: reg.sha256,
      frozenAt,
      seedRound: round.round,
      seedRoundPublishesAt: unixToIso(round.publishesAt),
    };
    let signed: SignedRecord<ManifestCommitmentRecord> = signRecord(commitment, key);
    if (url) signed = await submitSigned(ctx, signed, url);
    writeJson(paths.manifest, manifest);
    writeJson(paths.commitment, signed);
    return { ...base, schema: "pr-rla/manifest/v1", manifestSha256: manifest.sha256, log: signed.log, submitError: null, evidence: null, outcomes: [] };
  }

  const v2reg = reg as SignedRecord<RegistrationRecordV2>;
  const providerId = await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx).plugins);
  const traits = await providerTraits(config.provider, config.dir, auditContextFor(ctx).plugins);
  const registered = v2reg.record.plugins.provider;
  if (providerId.name !== registered.name || providerId.optionsSha256 !== registered.optionsSha256)
    ctx.err(`note: the provider in .pr-rla.yml (${providerId.name}) differs from the registered one (${registered.name}, options ${registered.optionsSha256.slice(0, 8)}…); verify rebuilds the population with the provider it is given`);
  const body: Omit<ManifestV2, "sha256"> = {
    schema: "pr-rla/manifest/v2",
    registrationSha256: v2reg.sha256,
    repos: [{ repo, repoId: null, defaultBranch: pop.listed.defaultBranch, headSha: pop.headSha }],
    provider: { ...providerId, apiVersion: PROVIDER_API_VERSION, reviewGranularity: traits.reviewGranularity },
    window,
    frozenAt,
    selector,
    parameters,
    protocolSha256: protocol,
    funnel: pop.selection.funnel,
    limitations: pop.limitations,
    N,
    changes: pop.entries,
    prRlaVersion: PR_RLA_VERSION,
  };
  const manifest: ManifestV2 = { ...body, sha256: manifestSha256(body) };
  const commitment: CommitmentRecordV2 = {
    schema: "pr-rla/commitment/v2",
    window: window.name,
    manifestSha256: manifest.sha256,
    N,
    registrationSha256: v2reg.sha256,
    frozenAt,
    seedRound: round.round,
    seedRoundPublishesAt: unixToIso(round.publishesAt),
    prRlaVersion: PR_RLA_VERSION,
  };
  const ts = v2reg.record.timestamping;
  const bundle = trustFor(ctx, opts.tsaTrust);
  let signed: SignedRecord<CommitmentRecordV2> = signRecord(commitment, key);
  const got = await obtainTimestamps(ctx, signed, frozenAt, ts, bundle);
  signed = { ...signed, timestamps: got.timestamps };
  writeJson(paths.manifest, manifest);
  writeJson(paths.commitment, signed);
  const result = { ...base, schema: "pr-rla/manifest/v2" as const, manifestSha256: manifest.sha256, outcomes: got.outcomes };
  if (url) {
    try {
      signed = api === "v2" ? await submitSignedV2(ctx, config, signed, url) : await submitSigned(ctx, signed, url);
      writeJson(paths.commitment, signed);
    } catch (e) {
      return { ...result, log: null, submitError: (e as Error).message, evidence: null };
    }
  }
  const evidence = await assessRecord(ctx, config, signed, frozenAt, ts, bundle);
  return { ...result, log: signed.log, submitError: null, evidence };
}
