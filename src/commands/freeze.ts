import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "../core/canonical.js";
import type { Population } from "../core/population.js";
import {
  derivedRoundFor,
  isRegistrationV2,
  manifestSha256,
  registrationRepoSet,
  type CommitmentRecordV2,
  type Manifest,
  type ManifestCommitmentRecord,
  type ManifestV2,
  type RegistrationRecordV2,
  type SignedRecord,
} from "../core/records.js";
import type { Selector } from "../core/selector.js";
import { repoSetLabel } from "../core/repo-set.js";
import { isoToUnix, unixToIso } from "../core/seed.js";
import { loadOrCreateKey, signRecord } from "../core/signing.js";
import { providerTraits } from "../provider-traits.js";
import { pluginIdentity } from "../registry.js";
import { PROVIDER_API_VERSION } from "../sdk/provider.js";
import { isoMs } from "../timestamp/verify.js";
import { PR_RLA_VERSION } from "../version.js";
import { auditContextFor, CommandError, configFor, fmt, isoNow, protocolSha256, providerFor, readRegistration, trustFor, writeJson, type CommandContext } from "./context.js";
import { estimateCommand, runFreezeRepos } from "./freeze-pool.js";
import { assessRecord, obtainTimestamps, reportTimestamps } from "./timestamps.js";
import { confirmRekorV2, rekorApi, submitSigned, submitSignedV2, submitUrl } from "./translog.js";

export const REFREEZE_COMMAND = "pr-rla freeze --force";

export interface FreezeOptions {
  dryRun?: boolean;
  submit?: boolean;
  rekorUrl?: string;
  key?: string;
  json?: boolean;
  /** --dry-run only: write the full listing and the would-be manifest entries to this file for inspection. */
  out?: string;
  /** Replace an existing manifest (only if it was never shown to anyone, and only before R publishes). */
  force?: boolean;
  rekorApi?: string;
  yes?: boolean;
  tsaTrust?: string[];
  /** With --dry-run: predict the requests and wall time of a pooled freeze (probes the first page of each repo; writes nothing). Implies --dry-run. */
  estimate?: boolean;
  /** Continue the run with this id (printed when a pooled freeze stops); refused if its inputs differ. */
  resume?: string;
}

export function summarizePopulation(pop: Population, sel: Selector, defaultBranch: string): { lines: string[]; summary: string } {
  const lines: string[] = [];
  const f = pop.selection.funnel;
  lines.push(`  landed on ${defaultBranch} in window: ${fmt(f[0]!.count)} (pull_request ${fmt(pop.byKind.pull_request)} · direct_push ${fmt(pop.byKind.direct_push)})`);
  for (const step of f.slice(1)) {
    const extra = /review/.test(step.step)
      ? ` (merged by: ${fmt(pop.selection.mergedByBreakdown.human)} human accounts, ${fmt(pop.selection.mergedByBreakdown.bot)} bot, ${fmt(pop.selection.mergedByBreakdown.unknown)} unknown/direct push)`
      : "";
    lines.push(`  ${step.step.padEnd(40, ".")} ${fmt(step.count)}${extra}`);
  }
  const author = f.find((s) => s.step.startsWith("author") || s.step === "any author")!;
  const review = f.find((s) => /review/.test(s.step))!;
  const parts = [`${fmt(author.count)} ${sel.kinds.length === 1 && sel.kinds[0] === "pull_request" ? "merged" : "landed"}`];
  if (sel.unreviewed !== "any") parts.push(`${fmt(review.count)} ${review.step} (merged by: ${fmt(pop.selection.mergedByBreakdown.human)} human accounts, ${fmt(pop.selection.mergedByBreakdown.bot)} bot)`);
  if (sel.merged_by !== "any") parts.push(`${fmt(f.find((s) => s.step.startsWith("merged by"))!.count)} merged by ${sel.merged_by}`);
  if (sel.max_changed_lines !== null) parts.push(`${fmt(pop.entries.length)} ≤ ${sel.max_changed_lines} changed lines`);
  return { lines, summary: parts.join(" · ") };
}

export async function freezeCommand(ctx: CommandContext, opts: FreezeOptions): Promise<number> {
  if (opts.estimate && !opts.dryRun) opts = { ...opts, dryRun: true };
  const { config, paths } = configFor(ctx);
  const frozenAt = isoNow(ctx);
  const now = isoToUnix(frozenAt);
  let selector = config.selector;
  let window = config.window;
  let parameters = config.parameters;
  let protocol = protocolSha256(config);
  let reg: ReturnType<typeof readRegistration> | null = null;
  if (!opts.dryRun || existsSync(paths.registration)) {
    if (!existsSync(paths.registration)) throw new CommandError(`not registered: run "pr-rla register" before "pr-rla freeze" (the selector must be fixed before the population is)`);
    reg = readRegistration(paths);
    if (canonicalJson(reg.record.selector) !== canonicalJson(config.selector) || reg.record.window.name !== config.window.name || canonicalJson(registrationRepoSet(reg)) !== canonicalJson(config.repoSet))
      ctx.err("note: .pr-rla.yml differs from the registration; freezing with the REGISTERED selector, window and repos");
    selector = reg.record.selector;
    window = reg.record.window;
    parameters = reg.record.parameters;
    if (!opts.dryRun && protocol !== reg.record.protocolSha256) throw new CommandError(`review protocol changed since registration (${protocol.slice(0, 12)}… ≠ registered ${reg.record.protocolSha256.slice(0, 12)}…)`);
    protocol = reg.record.protocolSha256;
  }
  const closes = isoToUnix(window.closesAt);
  if (!opts.dryRun && now < closes) throw new CommandError(`window ${window.name} closes ${window.closesAt}; freeze after it closes (use --dry-run to see the population so far)`);
  const round = reg ? derivedRoundFor(reg) : null;
  if (!opts.dryRun && round && now >= round.publishesAt)
    throw new CommandError(`seed round ${round.round} published at ${unixToIso(round.publishesAt)}: a manifest frozen now would be written after the seed was public (verify check 2 fails). Register a new audit.`);
  if (!opts.dryRun && !opts.force && existsSync(paths.commitment))
    throw new CommandError(`${paths.commitment} exists: this window is frozen. Use --force only if the manifest was never shown to anyone (it is replaced, with new timestamps).`);
  const api = rekorApi(opts.rekorApi);
  const url = opts.submit && !opts.dryRun ? submitUrl(config, opts.rekorUrl) : null;
  if (url && api === "v2") await confirmRekorV2(ctx, opts.yes);
  const repoSet = reg ? registrationRepoSet(reg) : config.repoSet;
  const pooled = repoSet.kind !== "repo";
  const repo = repoSet.kind === "repo" ? repoSet.repo : repoSetLabel(repoSet);
  if (reg && isRegistrationV2(reg)) {
    // Options that change the population are part of the stratum (populationOptions, check 5).
    const now = await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx).plugins);
    const reg0 = reg.record.plugins.provider;
    if (now.optionsSha256 !== reg0.optionsSha256 && now.populationOptionsSha256 !== reg0.populationOptionsSha256) {
      const why = `the provider options that change the population (populationOptions) differ from the registration (${now.populationOptionsSha256.slice(0, 12)}… ≠ registered ${reg0.populationOptionsSha256.slice(0, 12)}…)`;
      if (!opts.dryRun) throw new CommandError(`${why}: freeze with the registered options, or verify check 5 fails`);
      ctx.err(`note: ${why}`);
    }
  }

  const provider = await providerFor(ctx, config);
  if (opts.estimate) return estimateCommand(ctx, { provider, repoSet, window, selector, concurrency: config.freeze.concurrency, publishesAt: round?.publishesAt ?? null, json: opts.json });
  const run = await runFreezeRepos(ctx, config, { provider, repoSet, window, selector, startedAt: frozenAt, reg, dryRun: !!opts.dryRun, force: !!opts.force, resume: opts.resume });
  const pop = run.population;
  // The as-of time of the reviews and of the manifest: the command's start, or (a resumed pooled run) the run's own.
  const asOf = run.startedAt;
  const N = pop.entries.length;
  const { lines, summary } = summarizePopulation(pop, selector, pooled ? "each repo's default branch" : pop.listed.defaultBranch);
  let native: { label: string; value: number }[] = [];
  if (provider.nativeCounts && !pooled) {
    try {
      native = await provider.nativeCounts({ repo, window, kinds: selector.kinds }, selector as unknown as Record<string, unknown>);
    } catch (e) {
      ctx.err(`note: provider-native counts unavailable: ${(e as Error).message}`);
    }
  }
  if (opts.json) {
    ctx.out(JSON.stringify({ dryRun: !!opts.dryRun, repo, window, frozenAt: asOf, N, headSha: pop.headSha, funnel: pop.selection.funnel, byKind: pop.byKind, mergedBy: pop.selection.mergedByBreakdown, nativeCounts: native, diagnostics: pop.listed.diagnostics ?? [], viaMerge: pop.viaMerge, limitations: pop.limitations, summary, ...(pooled ? { repos: run.repos } : {}) }, null, 2));
  } else {
    ctx.out(`${opts.dryRun ? "[dry run] " : ""}${repo} · window ${window.name} (${window.start}..${window.end} UTC) · provider ${provider.name} · reviews as of ${asOf}`);
    lines.forEach((l) => ctx.out(l));
    ctx.out(`N = ${fmt(N)}`);
    ctx.out(summary);
    if (native.length) ctx.out(`provider-native, for comparison only (not used): ${native.map((n) => `${n.label} ${fmt(n.value)}`).join(" · ")}`);
    for (const d of pop.listed.diagnostics ?? []) ctx.out(`  diagnostic: ${d.label}: ${fmt(d.value)}`);
    for (const v of pop.viaMerge) ctx.out(`  diagnostic: direct pushes that arrived through merge ${v.merge.slice(0, 12)}… (a non-first parent): ${fmt(v.count)}`);
    if (pooled) ctx.out(`  ${fmt(run.repos.length)} repos (${fmt(run.repos.filter((r) => r.headSha).length)} with a pinned head, recorded in the manifest) · ${fmt(pop.repos.filter((r) => r.listed > 0).length)} with changes in the window`);
    if (pop.headSha) ctx.out(`  history walked from ${pop.listed.defaultBranch} head ${pop.headSha} (recorded in the manifest; verify walks the same history)`);
    for (const l of pop.limitations) ctx.out(`  limitation: ${l}`);
    if (N < parameters.minPopulation) ctx.out(`population ${fmt(N)} < ${parameters.minPopulation}: review all ${fmt(N)} instead`);
  }
  if (opts.dryRun) {
    if (opts.out) {
      writeJson(resolve(ctx.cwd, opts.out), { repo, window, frozenAt: asOf, selector, headSha: pop.headSha, funnel: pop.selection.funnel, nativeCounts: native, diagnostics: pop.listed.diagnostics ?? [], limitations: pop.limitations, listed: pop.listed.changes, selected: pop.entries.map((e) => e.id) });
      ctx.out(`wrote the dry-run population to ${opts.out}`);
    }
    return 0;
  }

  const key = loadOrCreateKey(resolve(config.dir, opts.key ?? config.signingKey));
  // A pooled freeze can run for hours: its commitment is signed when it finishes (its tokens then agree with its signed
  // time), while the manifest keeps the run's start as its as-of time. A single repo signs both at the command's start.
  const committedAt = pooled ? isoNow(ctx) : frozenAt;
  if (pooled && isoToUnix(committedAt) >= round!.publishesAt)
    throw new CommandError(`the freeze finished ${committedAt}, after seed round ${round!.round} published (${unixToIso(round!.publishesAt)}): a manifest written now would be written after the seed was public (verify check 2 fails). Its checkpoints are kept; register a new audit`);
  if (!isRegistrationV2(reg!)) {
    // A v1 registration (made before bolt 1) is frozen as v1, so the audit stays one schema end to end.
    const body: Omit<Manifest, "sha256"> = {
      schema: "pr-rla/manifest/v1",
      repo,
      provider: { name: provider.name, apiVersion: PROVIDER_API_VERSION },
      defaultBranch: pop.listed.defaultBranch,
      window,
      frozenAt,
      registrationSha256: reg!.sha256,
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
      registrationSha256: reg!.sha256,
      frozenAt,
      seedRound: round!.round,
      seedRoundPublishesAt: unixToIso(round!.publishesAt),
    };
    let signed: SignedRecord<ManifestCommitmentRecord> = signRecord(commitment, key);
    if (url) signed = await submitSigned(ctx, signed, url);
    writeJson(paths.manifest, manifest);
    writeJson(paths.commitment, signed);
    ctx.out(`manifest ${manifest.sha256} · N ${fmt(N)} → ${paths.manifest} (schema v1, as the registration)`);
    ctx.out(`seed round R = ${round!.round}, publishes ${unixToIso(round!.publishesAt)}; run "pr-rla sample" after that`);
    if (signed.log && !("apiVersion" in signed.log) && signed.log.integratedTime >= round!.publishesAt) ctx.out("FAIL manifest logged after the seed was public");
    if (!signed.log) ctx.out("TIMESTAMP NOT TAMPER-PROOF: manifest commitment written locally only");
    return 0;
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
    repos: run.repos,
    provider: { ...providerId, apiVersion: PROVIDER_API_VERSION, reviewGranularity: traits.reviewGranularity },
    window,
    frozenAt: asOf,
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
    frozenAt: committedAt,
    seedRound: round!.round,
    seedRoundPublishesAt: unixToIso(round!.publishesAt),
    prRlaVersion: PR_RLA_VERSION,
  };
  const ts = v2reg.record.timestamping;
  const bundle = trustFor(ctx, opts.tsaTrust);
  let signed: SignedRecord<CommitmentRecordV2> = signRecord(commitment, key);
  const got = await obtainTimestamps(ctx, signed, committedAt, ts, bundle);
  signed = { ...signed, timestamps: got.timestamps };
  writeJson(paths.manifest, manifest);
  writeJson(paths.commitment, signed);
  run.finish();
  ctx.out(`manifest ${manifest.sha256} · N ${fmt(N)}${pooled ? ` · ${fmt(run.repos.length)} repos` : ""} → ${paths.manifest}`);
  if (url) {
    try {
      signed = api === "v2" ? await submitSignedV2(ctx, config, signed, url) : await submitSigned(ctx, signed, url);
      writeJson(paths.commitment, signed);
    } catch (e) {
      ctx.out(`wrote ${paths.commitment} with its timestamps; the transparency-log submission failed: ${(e as Error).message}`);
      return 1;
    }
  }
  const evidence = await assessRecord(ctx, config, signed, committedAt, ts, bundle);
  if (evidence.ukMs !== null && evidence.ukMs >= round!.publishesAt * 1000) ctx.out("FAIL manifest logged after the seed was public");
  else if (evidence.ukMs !== null) ctx.out(`  manifest commitment existed by ${isoMs(evidence.ukMs)} (U_k), before R`);
  const code = reportTimestamps(ctx, evidence, got.outcomes, REFREEZE_COMMAND);
  ctx.out(`seed round R = ${round!.round}, publishes ${unixToIso(round!.publishesAt)}; run "pr-rla sample" after that`);
  return code;
}
