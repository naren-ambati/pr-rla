import { existsSync } from "node:fs";
import { buildPopulation } from "../core/population.js";
import { auditMode, derivedRoundFor } from "../core/records.js";
import { unixToIso } from "../core/seed.js";
import { computeStatus, type StatusReport } from "../core/status.js";
import { windowDays } from "../core/window.js";
import { configFor, fmt, isoNow, ledgerFor, pct, providerFor, readDraws, readManifest, readRegistration, type CommandContext } from "./context.js";

export interface StatusOptions {
  json?: boolean;
  offline?: boolean;
}

export function statusLine(r: StatusReport, info: { p0: number; alpha: number; protocol: string; maxLines: number | null; mode: string }): string {
  const s = r.sequence;
  const stratum = info.maxLines !== null ? `, stratum ≤ ${info.maxLines} lines` : "";
  const head = `prefix ${r.labelledPrefix}/${r.drawsIssued} · fails ${s.fails} · claim D (detected-defect rate ≤ ${pct(info.p0)}, protocol ${info.protocol.slice(0, 4)}…${stratum}) · LLR ${s.llr.toFixed(3)} / target ${s.target.toFixed(3)}`;
  let verdict: string;
  if (s.state === "CERTIFIED") verdict = `CERTIFIED (risk ${pct(info.alpha)})`;
  else if (s.state === "ESCALATE") verdict = `ESCALATE: review all ${fmt(r.N)} or narrow the claim`;
  else verdict = `NOT CERTIFIED · ${s.morePassesNeeded} more passing draws needed (${s.draws + (s.morePassesNeeded ?? 0)} total)`;
  return `${head} · ${verdict} · ${info.mode}`;
}

export async function statusCommand(ctx: CommandContext, opts: StatusOptions): Promise<number> {
  const { config, paths } = configFor(ctx);
  if (!existsSync(paths.registration)) {
    ctx.out(`not registered: window ${config.window.name} (${config.window.start}..${config.window.end}). Run "pr-rla register".`);
    return 1;
  }
  const reg = readRegistration(paths);
  const mode = auditMode(reg);
  const w = reg.record.window;
  const now = Math.floor(ctx.nowMs() / 1000);
  const { round, publishesAt } = derivedRoundFor(reg);
  const tsNote = reg.log ? "" : " · TIMESTAMP NOT TAMPER-PROOF";
  if (!existsSync(paths.manifest)) {
    const opens = Date.parse(w.opensAt) / 1000;
    const closes = Date.parse(w.closesAt) / 1000;
    const phase = now < opens ? "window not yet open" : now < closes ? `window open, day ${Math.floor((now - opens) / 86400) + 1} of ${windowDays(w)}` : "window closed, not frozen";
    let soFar = "";
    if (!opts.offline && now >= opens) {
      const provider = await providerFor(ctx, config);
      const pop = await buildPopulation(provider, { repo: reg.record.repo, window: { opensAt: w.opensAt, closesAt: unixToIso(Math.min(now, closes)) }, selector: reg.record.selector, cutoffIso: isoNow(ctx) });
      soFar = ` · N so far ${fmt(pop.entries.length)}`;
    }
    ctx.out(`${mode} · ${phase}${soFar} · seed round ${round} ${now < publishesAt ? "not yet published" : "published"}${tsNote}`);
    return 0;
  }
  const manifest = readManifest(paths);
  if (!existsSync(paths.draws)) {
    ctx.out(`${mode} · frozen N ${fmt(manifest.N)} · seed round ${round} ${now < publishesAt ? `publishes ${unixToIso(publishesAt)}` : `published ${unixToIso(publishesAt)}: run "pr-rla sample"`}${tsNote}`);
    return 0;
  }
  const draws = readDraws(paths);
  const ledger = await ledgerFor(ctx, config, paths);
  const report = computeStatus({
    N: manifest.N,
    minPopulation: reg.record.parameters.minPopulation,
    draws: draws.draws,
    drawsIssued: draws.issued,
    verdicts: await ledger.readVerdicts(),
    protocolSha256: reg.record.protocolSha256,
    params: reg.record.parameters,
  });
  if (opts.json) {
    ctx.out(JSON.stringify({ mode, timestampTamperProof: !!reg.log, ...report }, null, 2));
  } else if (report.refusal) {
    ctx.out(report.refusal);
    return 3;
  } else {
    ctx.out(statusLine(report, { p0: reg.record.parameters.p0, alpha: reg.record.parameters.alpha, protocol: reg.record.protocolSha256, maxLines: reg.record.selector.max_changed_lines, mode }) + tsNote);
    if (report.blockingDraw) ctx.out(`  blocking draw: #${report.blockingDraw.draw} ${report.blockingDraw.changeId} ${report.blockingDraw.url}`);
    ctx.out(`  distinct changes reviewed: ${report.distinctReviewed} · draws counted: ${report.sequence.draws}${report.beyondStop ? ` · ${report.beyondStop} labelled draw(s) after the stop are not counted` : ""}`);
    for (const i of report.ignored) ctx.out(`  ignored verdict on draw #${i.event.draw} (${i.event.changeId}): ${i.reason}`);
    for (const r of report.relabels) ctx.out(`  relabel: ${r.changeId} first ${r.first.verdict} (counts), later ${r.later.verdict}`);
    ctx.out("  assumptions: claim D is about detection under the registered protocol by these reviewers, not the true defect rate; draws are with replacement.");
  }
  return report.sequence.state === "ESCALATE" ? 2 : 0;
}
