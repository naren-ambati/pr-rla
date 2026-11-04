import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "../../core/canonical.js";
import { readConfined } from "../../io/confine.js";
import { buildPopulation, type Population } from "../../core/population.js";
import { derivedRoundFor, isRegistrationV2, registrationRepo, type AnyRegistration, type AuditParameters, type SignedRecord } from "../../core/records.js";
import { isoToUnix, unixToIso } from "../../core/seed.js";
import type { FunnelStep, Selector } from "../../core/selector.js";
import type { ResolvedWindow } from "../../core/window.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { pluginIdentity } from "../../registry.js";
import type { ChangeKind, ChangeRecord, ScmProvider } from "../../sdk/provider.js";
import { AuditError } from "../errors.js";
import { auditContextFor, configFor, fmt, isoNow, protocolSha256, providerFor, readRegistration, type ApiContext } from "../session.js";

/**
 * `freeze_preview` and `freeze --dry-run` (functional-design.md §U5): the population a freeze would
 * write, built through the context's broker and kept in memory. It writes nothing: no manifest, no
 * key, no file of any kind (the CLI's `--out` listing is the CLI's own write).
 */

export interface FreezePreviewOptions {
  /** Another window than the configured one (it must be registered). */
  window?: string;
  /**
   * A cost estimate instead of the population. The estimate belongs to the org-pooled freeze (U8);
   * this build has none, and refuses the option rather than running a full listing in its place.
   */
  estimate?: boolean;
  /** Also return every listed change and the selected ids (the CLI's `freeze --dry-run --out`). */
  listing?: boolean;
}

/** The `freeze --dry-run --json` object (contracts.md §7): the population a freeze would write now. */
export interface FreezePreview {
  dryRun: true;
  repo: string;
  window: ResolvedWindow;
  frozenAt: string;
  N: number;
  headSha: string | null;
  funnel: FunnelStep[];
  byKind: Record<ChangeKind, number>;
  mergedBy: { human: number; bot: number; unknown: number };
  nativeCounts: { label: string; value: number }[];
  diagnostics: { label: string; value: number }[];
  viaMerge: Population["viaMerge"];
  limitations: string[];
  summary: string;
  /** The provider that listed the changes, and the branch they landed on. */
  provider: string;
  defaultBranch: string;
  /** The selector the population was built with: the registered one, else (unregistered) the configured one. */
  selector: Selector;
  minPopulation: number;
  /** The registration it previews (null: an unregistered audit, previewed with .pr-rla.yml). */
  registrationSha256: string | null;
  /** With `listing`: every listed change and the ids the selector kept. */
  listing?: { listed: ChangeRecord[]; selected: string[] };
}

/** The view of a population the summary lines need (a FreezePreview carries it). */
export interface FunnelView {
  funnel: FunnelStep[];
  byKind: Record<ChangeKind, number>;
  mergedBy: { human: number; bot: number; unknown: number };
  N: number;
}

export function summarizeFunnel(v: FunnelView, sel: Selector, defaultBranch: string): { lines: string[]; summary: string } {
  const lines: string[] = [];
  const f = v.funnel;
  lines.push(`  landed on ${defaultBranch} in window: ${fmt(f[0]!.count)} (pull_request ${fmt(v.byKind.pull_request)} · direct_push ${fmt(v.byKind.direct_push)})`);
  for (const step of f.slice(1)) {
    const extra = /review/.test(step.step) ? ` (merged by: ${fmt(v.mergedBy.human)} human accounts, ${fmt(v.mergedBy.bot)} bot, ${fmt(v.mergedBy.unknown)} unknown/direct push)` : "";
    lines.push(`  ${step.step.padEnd(40, ".")} ${fmt(step.count)}${extra}`);
  }
  const author = f.find((s) => s.step.startsWith("author") || s.step === "any author")!;
  const review = f.find((s) => /review/.test(s.step))!;
  const parts = [`${fmt(author.count)} ${sel.kinds.length === 1 && sel.kinds[0] === "pull_request" ? "merged" : "landed"}`];
  if (sel.unreviewed !== "any") parts.push(`${fmt(review.count)} ${review.step} (merged by: ${fmt(v.mergedBy.human)} human accounts, ${fmt(v.mergedBy.bot)} bot)`);
  if (sel.merged_by !== "any") parts.push(`${fmt(f.find((s) => s.step.startsWith("merged by"))!.count)} merged by ${sel.merged_by}`);
  if (sel.max_changed_lines !== null) parts.push(`${fmt(v.N)} ≤ ${sel.max_changed_lines} changed lines`);
  return { lines, summary: parts.join(" · ") };
}

/** The funnel lines and summary of a built population (kept for scripts that build one themselves). */
export function summarizePopulation(pop: Population, sel: Selector, defaultBranch: string): { lines: string[]; summary: string } {
  return summarizeFunnel({ funnel: pop.selection.funnel, byKind: pop.byKind, mergedBy: pop.selection.mergedByBreakdown, N: pop.entries.length }, sel, defaultBranch);
}

/** Everything a freeze decides before it writes: shared by the preview (read) and the freeze (write side). */
export interface FreezePlan {
  config: PrRlaConfig;
  paths: WindowPaths;
  reg: SignedRecord<AnyRegistration> | null;
  selector: Selector;
  window: ResolvedWindow;
  parameters: AuditParameters;
  protocol: string;
  repo: string;
  frozenAt: string;
  round: { round: number; publishesAt: number } | null;
  provider: ScmProvider;
  pop: Population;
  preview: FreezePreview;
}

/**
 * Steps 1–10 of a freeze: check the registration and the clock, list the window through the
 * provider and apply the registered selector. `beforeListing` runs the write side's own refusals
 * and confirmations at the point a freeze has always run them (after the clock checks, before listing).
 */
export async function planFreeze(ctx: ApiContext, o: { dryRun: boolean; window?: string; listing?: boolean; beforeListing?: (plan: { config: PrRlaConfig; paths: WindowPaths }) => Promise<void> }): Promise<FreezePlan> {
  const { config, paths } = configFor(ctx, o.window);
  const frozenAt = isoNow(ctx);
  const now = isoToUnix(frozenAt);
  let selector = config.selector;
  let window = config.window;
  let parameters = config.parameters;
  let protocol = protocolSha256(config);
  let reg: SignedRecord<AnyRegistration> | null = null;
  if (!o.dryRun || existsSync(paths.registration)) {
    if (!existsSync(paths.registration)) throw new AuditError(`not registered: run "pr-rla register" before "pr-rla freeze" (the selector must be fixed before the population is)`, 1, "NO_AUDIT");
    reg = readRegistration(paths);
    if (canonicalJson(reg.record.selector) !== canonicalJson(config.selector) || reg.record.window.name !== config.window.name)
      ctx.err("note: .pr-rla.yml differs from the registration; freezing with the REGISTERED selector and window");
    selector = reg.record.selector;
    window = reg.record.window;
    parameters = reg.record.parameters;
    if (!o.dryRun && protocol !== reg.record.protocolSha256) throw new AuditError(`review protocol changed since registration (${protocol.slice(0, 12)}… ≠ registered ${reg.record.protocolSha256.slice(0, 12)}…)`);
    protocol = reg.record.protocolSha256;
  } else if (o.window !== undefined && o.window !== config.window.name) {
    throw new AuditError(`window ${o.window} is not registered, and only the configured window (${config.window.name}) can be previewed without a registration`, 1, "BAD_WINDOW");
  }
  const closes = isoToUnix(window.closesAt);
  if (!o.dryRun && now < closes) throw new AuditError(`window ${window.name} closes ${window.closesAt}; freeze after it closes (use --dry-run to see the population so far)`);
  const round = reg ? derivedRoundFor(reg) : null;
  if (!o.dryRun && round && now >= round.publishesAt)
    throw new AuditError(`seed round ${round.round} published at ${unixToIso(round.publishesAt)}: a manifest frozen now would be written after the seed was public (verify check 2 fails). Register a new audit.`);
  await o.beforeListing?.({ config, paths });
  const repo = reg ? registrationRepo(reg) : config.repo;
  if (reg && isRegistrationV2(reg)) {
    // Options that change the population are part of the stratum (populationOptions, check 5).
    const id = await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx).plugins);
    const reg0 = reg.record.plugins.provider;
    if (id.optionsSha256 !== reg0.optionsSha256 && id.populationOptionsSha256 !== reg0.populationOptionsSha256) {
      const why = `the provider options that change the population (populationOptions) differ from the registration (${id.populationOptionsSha256.slice(0, 12)}… ≠ registered ${reg0.populationOptionsSha256.slice(0, 12)}…)`;
      if (!o.dryRun) throw new AuditError(`${why}: freeze with the registered options, or verify check 5 fails`);
      ctx.err(`note: ${why}`);
    }
  }

  const provider = await providerFor(ctx, config);
  ctx.onProgress?.({ done: 0, message: `listing ${repo} on ${provider.name}, window ${window.name}` });
  const pop = await buildPopulation(provider, { repo, window, selector, cutoffIso: frozenAt, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  const N = pop.entries.length;
  const mergedBy = pop.selection.mergedByBreakdown;
  const { summary } = summarizeFunnel({ funnel: pop.selection.funnel, byKind: pop.byKind, mergedBy, N }, selector, pop.listed.defaultBranch);
  let nativeCounts: { label: string; value: number }[] = [];
  if (provider.nativeCounts) {
    try {
      nativeCounts = await provider.nativeCounts({ repo, window, kinds: selector.kinds }, selector as unknown as Record<string, unknown>);
    } catch (e) {
      ctx.err(`note: provider-native counts unavailable: ${(e as Error).message}`);
    }
  }
  const preview: FreezePreview = {
    dryRun: true,
    repo,
    window,
    frozenAt,
    N,
    headSha: pop.headSha,
    funnel: pop.selection.funnel,
    byKind: pop.byKind,
    mergedBy,
    nativeCounts,
    diagnostics: pop.listed.diagnostics ?? [],
    viaMerge: pop.viaMerge,
    limitations: pop.limitations,
    summary,
    provider: provider.name,
    defaultBranch: pop.listed.defaultBranch,
    selector,
    minPopulation: parameters.minPopulation,
    registrationSha256: reg?.sha256 ?? null,
    ...(o.listing ? { listing: { listed: pop.listed.changes, selected: pop.entries.map((e) => e.id) } } : {}),
  };
  ctx.onProgress?.({ done: 1, total: 1, message: `N = ${fmt(N)}` });
  return { config, paths, reg, selector, window, parameters, protocol, repo, frozenAt, round, provider, pop, preview };
}

/** `freeze_preview` / `freeze --dry-run`: the population a freeze would write now. Writes nothing. */
export async function freezePreview(ctx: ApiContext, opts: FreezePreviewOptions = {}): Promise<FreezePreview> {
  if (opts.estimate)
    throw new AuditError("freeze_preview with estimate: this pr-rla build has no freeze estimate (the org-pooled freeze, U8, adds it)", 1, "UNSUPPORTED", "call freeze_preview without estimate for the population itself");
  const plan = await planFreeze(ctx, { dryRun: true, ...(opts.window !== undefined ? { window: opts.window } : {}), ...(opts.listing ? { listing: true } : {}) });
  return plan.preview;
}

/**
 * The key a finished preview is cached under (contracts.md §4): the window, the registration digest
 * and `estimate`; and, so a preview built by another provider is never served (U5 fix round), the
 * digest of the provider spec, of the config file, and of a json-file export's bytes. Unregistered,
 * the registration digest is over what the preview is built from in .pr-rla.yml.
 */
export function freezePreviewKey(ctx: ApiContext, opts: { window?: string; estimate?: boolean } = {}): string {
  const { config, paths } = configFor(ctx, opts.window);
  const digest = existsSync(paths.registration)
    ? readRegistration(paths).sha256
    : sha256Hex(canonicalJson({ unregistered: true, repo: config.repo, window: config.window, selector: config.selector, provider: config.provider }));
  const exportPath = (config.provider.use === "json-file" || config.provider.use === "json") && typeof config.provider.options.path === "string" ? resolve(config.dir, config.provider.options.path) : null;
  return canonicalJson({
    dir: config.dir,
    window: opts.window ?? config.window.name,
    registration: digest,
    estimate: !!opts.estimate,
    provider: sha256Hex(canonicalJson(config.provider)),
    config: existsSync(config.configPath) ? sha256Hex(readConfined(config.configPath, "the config file")) : null,
    export: exportPath && existsSync(exportPath) ? sha256Hex(readConfined(exportPath, "the json-file provider's export")) : null,
  });
}
