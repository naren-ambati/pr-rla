import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "../core/canonical.js";
import { buildPopulation, type Population } from "../core/population.js";
import {
  derivedRoundFor,
  manifestSha256,
  type Manifest,
  type ManifestCommitmentRecord,
  type SignedRecord,
} from "../core/records.js";
import type { Selector } from "../core/selector.js";
import { isoToUnix, unixToIso } from "../core/seed.js";
import { loadOrCreateKey, signRecord } from "../core/signing.js";
import { PROVIDER_API_VERSION } from "../sdk/provider.js";
import { CommandError, configFor, fmt, isoNow, protocolSha256, providerFor, readRegistration, writeJson, type CommandContext } from "./context.js";
import { submitSigned, submitUrl } from "./translog.js";

export interface FreezeOptions {
  dryRun?: boolean;
  submit?: boolean;
  rekorUrl?: string;
  key?: string;
  json?: boolean;
  /** --dry-run only: write the full listing and the would-be manifest entries to this file for inspection. */
  out?: string;
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
    if (canonicalJson(reg.record.selector) !== canonicalJson(config.selector) || reg.record.window.name !== config.window.name)
      ctx.err("note: .pr-rla.yml differs from the registration; freezing with the REGISTERED selector and window");
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

  const provider = await providerFor(ctx, config);
  const pop = await buildPopulation(provider, { repo: config.repo, window, selector, cutoffIso: frozenAt });
  const N = pop.entries.length;
  const { lines, summary } = summarizePopulation(pop, selector, pop.listed.defaultBranch);
  let native: { label: string; value: number }[] = [];
  if (provider.nativeCounts) {
    try {
      native = await provider.nativeCounts({ repo: config.repo, window, kinds: selector.kinds }, selector as unknown as Record<string, unknown>);
    } catch (e) {
      ctx.err(`note: provider-native counts unavailable: ${(e as Error).message}`);
    }
  }
  if (opts.json) {
    ctx.out(JSON.stringify({ dryRun: !!opts.dryRun, repo: config.repo, window, frozenAt, N, funnel: pop.selection.funnel, byKind: pop.byKind, mergedBy: pop.selection.mergedByBreakdown, nativeCounts: native, diagnostics: pop.listed.diagnostics ?? [], limitations: pop.listed.limitations, summary }, null, 2));
  } else {
    ctx.out(`${opts.dryRun ? "[dry run] " : ""}${config.repo} · window ${window.name} (${window.start}..${window.end} UTC) · provider ${provider.name} · reviews as of ${frozenAt}`);
    lines.forEach((l) => ctx.out(l));
    ctx.out(`N = ${fmt(N)}`);
    ctx.out(summary);
    if (native.length) ctx.out(`provider-native, for comparison only (not used): ${native.map((n) => `${n.label} ${fmt(n.value)}`).join(" · ")}`);
    for (const d of pop.listed.diagnostics ?? []) ctx.out(`  diagnostic: ${d.label}: ${fmt(d.value)}`);
    for (const l of pop.listed.limitations) ctx.out(`  limitation: ${l}`);
    if (N < parameters.minPopulation) ctx.out(`population ${fmt(N)} < ${parameters.minPopulation}: review all ${fmt(N)} instead`);
  }
  if (opts.dryRun) {
    if (opts.out) {
      writeJson(resolve(ctx.cwd, opts.out), { repo: config.repo, window, frozenAt, selector, funnel: pop.selection.funnel, nativeCounts: native, diagnostics: pop.listed.diagnostics ?? [], limitations: pop.listed.limitations, listed: pop.listed.changes, selected: pop.entries.map((e) => e.id) });
      ctx.out(`wrote the dry-run population to ${opts.out}`);
    }
    return 0;
  }

  const body: Omit<Manifest, "sha256"> = {
    schema: "pr-rla/manifest/v1",
    repo: config.repo,
    provider: { name: provider.name, apiVersion: PROVIDER_API_VERSION },
    defaultBranch: pop.listed.defaultBranch,
    window,
    frozenAt,
    registrationSha256: reg!.sha256,
    selector,
    parameters,
    protocolSha256: protocol,
    funnel: pop.selection.funnel,
    limitations: pop.listed.limitations,
    N,
    changes: pop.entries,
  };
  const manifest: Manifest = { ...body, sha256: manifestSha256(body) };
  const commitment: ManifestCommitmentRecord = {
    schema: "pr-rla/manifest-commitment/v1",
    repo: config.repo,
    window: window.name,
    manifestSha256: manifest.sha256,
    N,
    registrationSha256: reg!.sha256,
    frozenAt,
    seedRound: round!.round,
    seedRoundPublishesAt: unixToIso(round!.publishesAt),
  };
  let signed: SignedRecord<ManifestCommitmentRecord> = signRecord(commitment, loadOrCreateKey(resolve(config.dir, opts.key ?? config.signingKey)));
  if (opts.submit) signed = await submitSigned(ctx, signed, submitUrl(config, opts.rekorUrl));
  writeJson(paths.manifest, manifest);
  writeJson(paths.commitment, signed);
  ctx.out(`manifest ${manifest.sha256} · N ${fmt(N)} → ${paths.manifest}`);
  ctx.out(`seed round R = ${round!.round}, publishes ${unixToIso(round!.publishesAt)}; run "pr-rla sample" after that`);
  if (signed.log && signed.log.integratedTime >= round!.publishesAt) ctx.out("FAIL manifest logged after the seed was public");
  if (!signed.log) ctx.out("TIMESTAMP NOT TAMPER-PROOF: manifest commitment written locally only");
  return 0;
}
