import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, sha256Hex } from "../../core/canonical.js";
import { readConfined } from "../../io/confine.js";
import type { Population } from "../../core/population.js";
import { derivedRoundFor, isRegistrationV2, registeredRepos, registrationRepoSet, type AnyRegistration, type AuditParameters, type ManifestRepo, type RepoSet, type SignedRecord } from "../../core/records.js";
import { repoSetLabel, RepoSetError, resolvePool } from "../../core/repo-set.js";
import { TSA_RETRY_DEADLINE_MS } from "../../net/contract.js";
import { PR_RLA_VERSION } from "../../version.js";
import { estimateFreeze, type FreezeEstimate } from "../freeze-estimate.js";
import { FreezeRepoFailed, FreezeStopped, listPool, ResumeRefused, type CheckpointOptions, type PooledFreeze } from "../pool-list.js";
import { isoToUnix, unixToIso } from "../../core/seed.js";
import type { FunnelStep, Selector } from "../../core/selector.js";
import type { ResolvedWindow } from "../../core/window.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { pluginIdentity } from "../../registry.js";
import type { ChangeKind, ChangeRecord, ScmProvider } from "../../sdk/provider.js";
import { AuditError } from "../errors.js";
import { readOnlyContext, auditContextFor, configFor, fmt, isoNow, protocolSha256, providerFor, readRegistration, type ApiContext } from "../session.js";

/**
 * `freeze_preview` and `freeze --dry-run` (functional-design.md §U5): the population a freeze would
 * write, built through the context's broker and kept in memory. It writes nothing: no manifest, no
 * key, no file of any kind (the CLI's `--out` listing is the CLI's own write).
 */

export interface FreezePreviewOptions {
  /** Another window than the configured one (it must be registered). */
  window?: string;
  /**
   * A cost estimate instead of the population (U8's `freeze --dry-run --estimate`): the repo set resolved
   * and each repo's first page probed, in memory; see `freezeEstimate`.
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
  /** A pooled preview (U8): each repo the manifest would record, with its pinned head. Absent for a single repo. */
  repos?: ManifestRepo[];
  /** A pooled preview: how many repos, how many with a pinned head, how many with changes in the window. */
  pool?: { repos: number; pinned: number; withChanges: number };
}

/** `freeze --dry-run --estimate` and freeze_preview's `estimate` (U8): what a pooled freeze would cost. */
export interface FreezeEstimateResult {
  estimate: FreezeEstimate;
  /** Milliseconds left before seed round R publishes, when a registration names it. */
  msLeftBeforeR: number | null;
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
  /** The repo, or the pool's label. */
  repo: string;
  /** The registered repo set (else the configured one). */
  repoSet: RepoSet;
  pooled: boolean;
  /** The command's start. The manifest's as-of time is the run's (`run.startedAt`): a resumed pooled run keeps its own. */
  frozenAt: string;
  round: { round: number; publishesAt: number } | null;
  /** Whether a commitment made at `atMs` could get its tokens after R (the authorities' retry deadline included, U8). */
  tooLate: (atMs: number) => boolean;
  /** The authorities' retry deadline counted before R (0 with none configured). */
  tsaMs: number;
  provider: ScmProvider;
  pop: Population;
  run: PooledFreeze;
  preview: FreezePreview;
}

/** Steps 1–9 of a freeze: the registration, the clock and the provider, before anything is listed. */
interface FreezeInputs extends Omit<FreezePlan, "pop" | "run" | "preview"> {}

async function freezeInputs(ctx: ApiContext, o: { dryRun: boolean; window?: string; beforeListing?: (plan: { config: PrRlaConfig; paths: WindowPaths }) => Promise<void> }): Promise<FreezeInputs> {
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
    if (canonicalJson(reg.record.selector) !== canonicalJson(config.selector) || reg.record.window.name !== config.window.name || canonicalJson(registrationRepoSet(reg)) !== canonicalJson(config.repoSet))
      ctx.err("note: .pr-rla.yml differs from the registration; freezing with the REGISTERED selector, window and repos");
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
  // The commitment's tokens may take up to the authorities' retry deadline to arrive: they must all be issued before R (U8).
  const tsaMs = reg && isRegistrationV2(reg) && reg.record.timestamping.authorities.length ? TSA_RETRY_DEADLINE_MS : 0;
  const tooLate = (atMs: number) => !!round && atMs + tsaMs >= round.publishesAt * 1000;
  if (!o.dryRun && tooLate(ctx.nowMs()))
    throw new AuditError(`seed round ${round!.round} publishes at ${unixToIso(round!.publishesAt)}, within the timestamp authorities' ${tsaMs / 60_000}-minute retry deadline: the commitment's tokens could be issued after the seed is public (verify check 2 fails). Register a new audit.`);
  await o.beforeListing?.({ config, paths });
  const repoSet = reg ? registrationRepoSet(reg) : config.repoSet;
  const pooled = repoSet.kind !== "repo";
  const repo = repoSet.kind === "repo" ? repoSet.repo : repoSetLabel(repoSet);
  // P1: freeze runs the registered provider only (its name, source, files, trust and every option); a dry run notes the difference.
  const provider = await providerFor(ctx, config, { registration: reg, command: "freeze", onMismatch: o.dryRun ? "note" : "refuse" });
  return { config, paths, reg, selector, window, parameters, protocol, repo, repoSet, pooled, frozenAt, round, tooLate, tsaMs, provider };
}

/** Exit 4 (contracts.md §7): stopped before finishing; re-running the printed command finishes it. The read side imports nothing of src/cli. */
const STOPPED = 4;

/** The resume command a stopped pooled run prints; --force again when the run replaces an existing manifest. */
export const resumeCommand = (runId: string, force = false) => `pr-rla freeze${force ? " --force" : ""} --resume ${runId}`;

const wall = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};

/**
 * Lists the repo set (a single repo is a pool of one) and builds the population (U8). With
 * `checkpoint` (the write side's, src/api/write/freeze.ts: it carries the store) a pooled run is
 * checkpointed and can resume; a preview passes none and writes nothing. A stopped run is exit 4.
 */
export async function runPool(ctx: ApiContext, i: Pick<FreezeInputs, "config" | "provider" | "repoSet" | "window" | "selector" | "frozenAt" | "reg">, o: { checkpoint?: CheckpointOptions; force?: boolean; dryRun: boolean }): Promise<PooledFreeze> {
  const stats = auditContextFor(ctx).broker.stats;
  const requests0 = stats.requests;
  const graphql = () => [...stats.byHost.values()].reduce((n, h) => n + h.graphql, 0);
  const graphql0 = graphql();
  const t0 = ctx.nowMs();
  try {
    const done = await listPool({
      provider: i.provider,
      set: i.repoSet,
      window: i.window,
      selector: i.selector,
      startedAt: i.frozenAt,
      concurrency: i.config.freeze.concurrency,
      log: (l) => (ctx.err(l), ctx.onProgress?.({ done: 0, message: l })),
      registered: i.reg ? registeredRepos(i.reg) : [],
      now: () => isoNow(ctx),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(o.checkpoint ? { checkpoint: o.checkpoint } : {}),
    });
    if (i.repoSet.kind !== "repo") ctx.err(`freeze: ${done.repos.length} repos${done.gone.length ? ` (+${done.gone.length} gone)` : ""} · ${done.fetched} listed now, ${done.resumed} from checkpoints · ${stats.requests - requests0} requests (${graphql() - graphql0} GraphQL) · ${wall(ctx.nowMs() - t0)}`);
    for (const note of done.notes) ctx.err(note);
    return done;
  } catch (e) {
    if (e instanceof FreezeStopped)
      throw new AuditError(e.runId ? `${e.message}. The ${e.done} repos listed are checkpointed; no manifest was written. Continue with: ${resumeCommand(e.runId, o.force)}` : `${e.message}. Nothing was checkpointed${o.dryRun ? " (a dry run writes nothing)" : ""}; no manifest was written. Run the same command again`, STOPPED);
    if (e instanceof FreezeRepoFailed || e instanceof ResumeRefused || e instanceof RepoSetError) throw new AuditError(e.message);
    throw e;
  }
}

/**
 * Steps 1–10 of a freeze: check the registration and the clock, list the window through the
 * provider and apply the registered selector. `beforeListing` runs the write side's own refusals
 * and confirmations at the point a freeze has always run them (after the clock checks, before listing).
 * `checkpoint` is the write side's (it carries the store): a preview passes none.
 */
export async function planFreeze(ctx: ApiContext, o: { dryRun: boolean; window?: string; listing?: boolean; beforeListing?: (plan: { config: PrRlaConfig; paths: WindowPaths }) => Promise<void>; checkpoint?: (i: FreezeInputs) => Promise<CheckpointOptions | undefined>; force?: boolean }): Promise<FreezePlan> {
  const i = await freezeInputs(ctx, o);
  const { provider, repo, window, selector, pooled } = i;
  ctx.onProgress?.({ done: 0, message: `listing ${repo} on ${provider.name}, window ${window.name}` });
  const checkpoint = o.checkpoint ? await o.checkpoint(i) : undefined;
  const run = await runPool(ctx, i, { ...(checkpoint ? { checkpoint } : {}), dryRun: o.dryRun, ...(o.force ? { force: true } : {}) });
  const pop = run.population;
  const N = pop.entries.length;
  const mergedBy = pop.selection.mergedByBreakdown;
  const defaultBranch = pooled ? "each repo's default branch" : pop.listed.defaultBranch;
  const { summary } = summarizeFunnel({ funnel: pop.selection.funnel, byKind: pop.byKind, mergedBy, N }, selector, defaultBranch);
  let nativeCounts: { label: string; value: number }[] = [];
  if (provider.nativeCounts && !pooled) {
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
    frozenAt: run.startedAt,
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
    defaultBranch,
    selector,
    minPopulation: i.parameters.minPopulation,
    registrationSha256: i.reg?.sha256 ?? null,
    ...(o.listing ? { listing: { listed: pop.listed.changes, selected: pop.entries.map((e) => e.id) } } : {}),
    ...(pooled ? { repos: run.repos, pool: { repos: run.repos.length, pinned: run.repos.filter((r) => r.headSha).length, withChanges: pop.repos.filter((r) => r.listed > 0).length } } : {}),
  };
  ctx.onProgress?.({ done: 1, total: 1, message: `N = ${fmt(N)}` });
  return { ...i, pop, run, preview };
}

/**
 * `freeze --dry-run --estimate` and freeze_preview's `estimate` (U8): resolve the repo set, probe each repo's first
 * page through the provider's `estimateRequests`, and predict the requests and wall time. Reads only; nothing is
 * written, and no checkpoint is made.
 */
export async function freezeEstimate(ctx: ApiContext, opts: { window?: string } = {}): Promise<FreezeEstimateResult> {
  ctx = readOnlyContext(ctx); // P1: an estimate writes nothing, so it runs read-only
  const i = await freezeInputs(ctx, { dryRun: true, ...(opts.window !== undefined ? { window: opts.window } : {}) });
  const actx = auditContextFor(ctx);
  const before = actx.broker.stats.requests;
  let resolved;
  try {
    resolved = (await resolvePool(i.provider, i.repoSet, { registered: i.reg ? registeredRepos(i.reg) : [], now: () => isoNow(ctx) })).pool;
  } catch (e) {
    if (e instanceof RepoSetError) throw new AuditError(e.message);
    throw e;
  }
  if (resolved.length === 0) throw new AuditError("the repo set matches no repository the token can see; widen the rule, or check the token's access");
  const estimate = await estimateFreeze({ ctx: actx, provider: i.provider, resolved, window: i.window, selector: i.selector, listingRequests: actx.broker.stats.requests - before, concurrency: i.config.freeze.concurrency, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  return { estimate, msLeftBeforeR: i.round === null ? null : i.round.publishesAt * 1000 - ctx.nowMs() };
}

/** The checkpointing of a real pooled freeze of a registered list or rule (the write side adds the store). */
export async function pooledCheckpointFor(ctx: ApiContext, i: Pick<FreezeInputs, "config" | "repoSet" | "reg" | "window">, o: { dryRun: boolean; force: boolean; resume: string | undefined }): Promise<Omit<CheckpointOptions, "stores"> | undefined> {
  const checkpointed = i.repoSet.kind !== "repo" && !o.dryRun && i.reg !== null && isRegistrationV2(i.reg);
  if (o.resume !== undefined && !checkpointed) throw new AuditError("--resume continues a pooled freeze of a registered repo list or rule; this freeze has nothing to resume");
  if (!checkpointed) return undefined;
  return {
    base: i.config.dir,
    windowName: i.window.name,
    registrationSha256: i.reg!.sha256,
    prRlaVersion: PR_RLA_VERSION,
    provider: await pluginIdentity(i.config.provider, "provider", i.config.dir, auditContextFor(ctx)),
    ...(o.resume !== undefined ? { resume: o.resume } : {}),
    // --force starts the run over, unless --resume names the (forced) run to continue.
    ...(o.force && o.resume === undefined ? { fresh: true } : {}),
  };
}

/** `freeze_preview` / `freeze --dry-run`: the population a freeze would write now. Writes nothing. */
export async function freezePreview(ctx: ApiContext, opts: FreezePreviewOptions & { estimate: true }): Promise<FreezeEstimateResult>;
export async function freezePreview(ctx: ApiContext, opts?: FreezePreviewOptions & { estimate?: false }): Promise<FreezePreview>;
export async function freezePreview(ctx: ApiContext, opts?: FreezePreviewOptions): Promise<FreezePreview | FreezeEstimateResult>;
export async function freezePreview(ctx: ApiContext, opts: FreezePreviewOptions = {}): Promise<FreezePreview | FreezeEstimateResult> {
  ctx = readOnlyContext(ctx); // P1: a dry run writes nothing, so it runs read-only (freeze --dry-run)
  if (opts.estimate) return freezeEstimate(ctx, opts.window !== undefined ? { window: opts.window } : {});
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
