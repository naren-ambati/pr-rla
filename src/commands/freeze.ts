import { resolve } from "node:path";
import { estimateLines } from "../api/freeze-estimate.js";
import { freezeEstimate, freezePreview, summarizeFunnel, type FreezePreview } from "../api/read/freeze-preview.js";
import { freeze, REFREEZE_COMMAND, type FreezeResult } from "../api/write/freeze.js";
import { rekorApi } from "../api/write/translog.js";
import { fmt } from "../api/session.js";
import { isoMs } from "../timestamp/verify.js";
import { writeJson, type CommandContext } from "./context.js";
import { reportTimestamps } from "./timestamps.js";
import { confirmRekorV2 } from "./translog.js";

// The freeze logic moved to the audit API in U5 (src/api/read/freeze-preview.ts, src/api/write/freeze.ts).
export { summarizePopulation } from "../api/read/freeze-preview.js";
export { REFREEZE_COMMAND } from "../api/write/freeze.js";

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
  /** Continue the pooled run with this id (printed when a pooled freeze stops); refused if its inputs differ. */
  resume?: string;
}

/** The population lines `freeze` prints (dry run or not). */
export function printPopulation(ctx: Pick<CommandContext, "out">, p: Omit<FreezePreview, "dryRun">, dryRun: boolean): void {
  const { lines } = summarizeFunnel(p, p.selector, p.defaultBranch);
  ctx.out(`${dryRun ? "[dry run] " : ""}${p.repo} · window ${p.window.name} (${p.window.start}..${p.window.end} UTC) · provider ${p.provider} · reviews as of ${p.frozenAt}`);
  lines.forEach((l) => ctx.out(l));
  ctx.out(`N = ${fmt(p.N)}`);
  ctx.out(p.summary);
  if (p.nativeCounts.length) ctx.out(`provider-native, for comparison only (not used): ${p.nativeCounts.map((n) => `${n.label} ${fmt(n.value)}`).join(" · ")}`);
  for (const d of p.diagnostics) ctx.out(`  diagnostic: ${d.label}: ${fmt(d.value)}`);
  for (const v of p.viaMerge) ctx.out(`  diagnostic: direct pushes that arrived through merge ${v.merge.slice(0, 12)}… (a non-first parent): ${fmt(v.count)}`);
  if (p.pool) ctx.out(`  ${fmt(p.pool.repos)} repos (${fmt(p.pool.pinned)} with a pinned head, recorded in the manifest) · ${fmt(p.pool.withChanges)} with changes in the window`);
  if (p.headSha) ctx.out(`  history walked from ${p.defaultBranch} head ${p.headSha} (recorded in the manifest; verify walks the same history)`);
  for (const l of p.limitations) ctx.out(`  limitation: ${l}`);
  if (p.N < p.minPopulation) ctx.out(`population ${fmt(p.N)} < ${p.minPopulation}: review all ${fmt(p.N)} instead`);
}

export async function freezeCommand(ctx: CommandContext, opts: FreezeOptions): Promise<number> {
  if (opts.estimate) {
    // --estimate implies --dry-run: it resolves and probes, and writes nothing (U8).
    rekorApi(opts.rekorApi);
    const r = await freezeEstimate(ctx);
    if (opts.json) ctx.out(JSON.stringify(r, null, 2));
    else for (const l of estimateLines(r.estimate, r.msLeftBeforeR)) ctx.out(l);
    return 0;
  }
  if (opts.dryRun) {
    rekorApi(opts.rekorApi);
    const { listing, ...preview } = await freezePreview(ctx, { listing: !!opts.out });
    if (opts.json) ctx.out(JSON.stringify(preview, null, 2));
    else printPopulation(ctx, preview, true);
    if (opts.out && listing) {
      writeJson(resolve(ctx.cwd, opts.out), { repo: preview.repo, window: preview.window, frozenAt: preview.frozenAt, selector: preview.selector, headSha: preview.headSha, funnel: preview.funnel, nativeCounts: preview.nativeCounts, diagnostics: preview.diagnostics, limitations: preview.limitations, listed: listing.listed, selected: listing.selected });
      // With --json, stdout carries the one JSON document; the note goes to stderr.
      (opts.json ? ctx.err : ctx.out)(`wrote the dry-run population to ${opts.out}`);
    }
    return 0;
  }
  const r = await freeze(ctx, opts, {
    ...(opts.json ? {} : { onPopulation: (p: FreezePreview) => printPopulation(ctx, p, false) }),
    confirmRekorV2: () => confirmRekorV2(ctx, opts.yes, !!opts.json),
  });
  if (opts.json) {
    ctx.out(JSON.stringify(r, null, 2));
    return freezeExitCode(r);
  }
  return printFreeze(ctx, r);
}

/** The exit code of a freeze (contracts.md §7): 1 when the log submission failed, 5 with too few timestamps. */
export function freezeExitCode(r: FreezeResult): number {
  if (r.submitError) return 1;
  if (r.schema === "pr-rla/manifest/v1" || !r.evidence) return 0;
  return !r.evidence.configured.length || r.evidence.proven ? 0 : 5;
}

function printFreeze(ctx: CommandContext, r: FreezeResult): number {
  const publishesAtMs = Date.parse(r.seedRoundPublishesAt);
  if (r.schema === "pr-rla/manifest/v1") {
    ctx.out(`manifest ${r.manifestSha256} · N ${fmt(r.N)} → ${r.manifestPath} (schema v1, as the registration)`);
    ctx.out(`seed round R = ${r.seedRound}, publishes ${r.seedRoundPublishesAt}; run "pr-rla sample" after that`);
    if (r.log && !("apiVersion" in r.log) && r.log.integratedTime * 1000 >= publishesAtMs) ctx.out("FAIL manifest logged after the seed was public");
    if (!r.log) ctx.out("TIMESTAMP NOT TAMPER-PROOF: manifest commitment written locally only");
    return 0;
  }
  ctx.out(`manifest ${r.manifestSha256} · N ${fmt(r.N)}${r.pool ? ` · ${fmt(r.pool.repos)} repos` : ""} → ${r.manifestPath}`);
  if (r.submitError) {
    ctx.out(`wrote ${r.commitmentPath} with its timestamps; the transparency-log submission failed: ${r.submitError}`);
    return 1;
  }
  const evidence = r.evidence!;
  if (evidence.ukMs !== null && evidence.ukMs >= publishesAtMs) ctx.out("FAIL manifest logged after the seed was public");
  else if (evidence.ukMs !== null) ctx.out(`  manifest commitment existed by ${isoMs(evidence.ukMs)} (U_k), before R`);
  const code = reportTimestamps(ctx, evidence, r.outcomes, REFREEZE_COMMAND);
  ctx.out(`seed round R = ${r.seedRound}, publishes ${r.seedRoundPublishesAt}; run "pr-rla sample" after that`);
  return code;
}
