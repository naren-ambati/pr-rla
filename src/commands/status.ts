import { existsSync } from "node:fs";
import { buildPopulation } from "../core/population.js";
import { auditMode, derivedRoundFor, isRegistrationV2, registrationRepo, type AuditMode, type RegistrationRecordV2, type SignedRecord } from "../core/records.js";
import { unixToIso } from "../core/seed.js";
import { computeStatus, provenanceLine, provenanceOf, type StatusReport } from "../core/status.js";
import { PRESENCE_LIMIT, countedVerdicts, provenanceLabel, signaturesCountFor, verdictRuleFailures } from "../core/presence/index.js";
import { latestCheckpointAt } from "../api/checkpoint.js";
import { ledgerTraits } from "../ledger-traits.js";
import { builtinLedgerName } from "../registry.js";
import { provenanceRank } from "../sdk/ledger.js";
import { checkpointCommand } from "./checkpoint.js";
import { windowDays } from "../core/window.js";
import type { PrRlaConfig, WindowPaths } from "../config.js";
import type { Selector } from "../core/selector.js";
import { notTamperProof } from "../timestamp/verify.js";
import { auditContextFor, configFor, fmt, isoNow, ledgerFor, pct, providerFor, readCommitment, readDraws, readManifest, readRegistration, trustFor, type CommandContext } from "./context.js";
import { assessRecord } from "./timestamps.js";

/**
 * The audit mode and the honest-output note for status. v1: tamper-evident iff logged.
 * v2: the stored tokens are checked offline; the mode is proven by U_k when k operators agree,
 * and the note says TIMESTAMP NOT TAMPER-PROOF (n of k) when the registration or the commitment falls short.
 */
export async function timeStanding(ctx: CommandContext, config: PrRlaConfig, paths: WindowPaths, reg: ReturnType<typeof readRegistration>): Promise<{ mode: AuditMode; note: string; tamperProof: boolean }> {
  if (!isRegistrationV2(reg)) return { mode: auditMode(reg), note: reg.log ? "" : " · TIMESTAMP NOT TAMPER-PROOF", tamperProof: !!reg.log };
  const v2 = reg as SignedRecord<RegistrationRecordV2>;
  const bundle = trustFor(ctx);
  const ts = v2.record.timestamping;
  const r = await assessRecord(ctx, config, v2, v2.record.registeredAt, ts, bundle);
  let short = r.proven ? null : r;
  if (existsSync(paths.commitment)) {
    const cm = readCommitment(paths);
    const c = await assessRecord(ctx, config, cm, cm.record.frozenAt, ts, bundle);
    if (!c.proven && !short) short = c;
  }
  const mode: AuditMode = r.proven ? (r.ukMs! < Date.parse(v2.record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE") : auditMode(reg);
  return { mode, note: short ? ` · ${notTamperProof(short)}` : "", tamperProof: !short };
}

export interface StatusOptions {
  json?: boolean;
  offline?: boolean;
  /** Also append a ledger checkpoint (FR4.4); plain status never does. */
  checkpoint?: boolean;
}

/**
 * The registered U3 stratum choices, as the certificate names them: the bot list, and whether direct
 * pushes that arrived through a pushed merge are in the stratum (FR7.1, FR7.6). Empty for v1 records.
 */
export function stratumChoices(sel: Partial<Pick<Selector, "kinds" | "bots" | "direct_push_via_merge">> | undefined): string {
  if (!sel) return "";
  const parts: string[] = [];
  if (sel.bots && sel.bots.length > 0) parts.push(`registered bots ${sel.bots.join(", ")}`);
  if (sel.direct_push_via_merge !== undefined && sel.kinds?.includes("direct_push")) parts.push(`direct pushes via a pushed merge ${sel.direct_push_via_merge === "exclude" ? "excluded" : "included"}`);
  return parts.map((p) => `, ${p}`).join("");
}

export function statusLine(r: StatusReport, info: { p0: number; alpha: number; protocol: string; maxLines: number | null; mode: string; selector?: Partial<Selector> }): string {
  const s = r.sequence;
  const stratum = `${info.maxLines !== null ? `, stratum ≤ ${info.maxLines} lines` : ""}${stratumChoices(info.selector)}`;
  const head = `prefix ${r.labelledPrefix}/${r.drawsIssued} · fails ${s.fails} · claim D (detected-defect rate ≤ ${pct(info.p0)}, protocol ${info.protocol.slice(0, 4)}…${stratum}) · LLR ${s.llr.toFixed(3)} / target ${s.target.toFixed(3)}`;
  let verdict: string;
  if (s.state === "CERTIFIED") verdict = `CERTIFIED (risk ${pct(info.alpha)})`;
  else if (s.state === "ESCALATE") verdict = `ESCALATE: review all ${fmt(r.N)} or narrow the claim`;
  else verdict = `NOT CERTIFIED · ${s.morePassesNeeded} more passing draws needed (${s.draws + (s.morePassesNeeded ?? 0)} total)`;
  return `${head} · ${verdict} · ${info.mode}`;
}

export async function statusCommand(ctx: CommandContext, opts: StatusOptions): Promise<number> {
  const code = await statusOnly(ctx, opts);
  if (!opts.checkpoint) return code;
  const cp = await checkpointCommand(ctx, {});
  return code !== 0 ? code : cp;
}

async function statusOnly(ctx: CommandContext, opts: StatusOptions): Promise<number> {
  const { config, paths } = configFor(ctx);
  if (!existsSync(paths.registration)) {
    ctx.out(`not registered: window ${config.window.name} (${config.window.start}..${config.window.end}). Run "pr-rla register".`);
    return 1;
  }
  const reg = readRegistration(paths);
  const { mode, note: tsNote, tamperProof } = await timeStanding(ctx, config, paths, reg);
  const w = reg.record.window;
  const now = Math.floor(ctx.nowMs() / 1000);
  const { round, publishesAt } = derivedRoundFor(reg);
  if (!existsSync(paths.manifest)) {
    const opens = Date.parse(w.opensAt) / 1000;
    const closes = Date.parse(w.closesAt) / 1000;
    const phase = now < opens ? "window not yet open" : now < closes ? `window open, day ${Math.floor((now - opens) / 86400) + 1} of ${windowDays(w)}` : "window closed, not frozen";
    let soFar = "";
    if (!opts.offline && now >= opens) {
      const provider = await providerFor(ctx, config);
      const pop = await buildPopulation(provider, { repo: registrationRepo(reg), window: { opensAt: w.opensAt, closesAt: unixToIso(Math.min(now, closes)) }, selector: reg.record.selector, cutoffIso: isoNow(ctx) });
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
  // U9: verdict signatures count only in the registered built-in git-file ledger; nothing counts above the ledger's ceiling.
  const registeredLedger = isRegistrationV2(reg) ? reg.record.plugins.ledger : null;
  const ceiling = (await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx).plugins)).maxProvenance;
  const verifiesSignatures = signaturesCountFor(registeredLedger) && builtinLedgerName(config.ledger.use) === "git-file";
  const capped = countedVerdicts(await ledger.readVerdicts(), { registration: reg, verifiesSignatures, ceiling, ledger: ledger.name });
  const report = computeStatus({
    N: manifest.N,
    minPopulation: reg.record.parameters.minPopulation,
    draws: draws.draws,
    drawsIssued: draws.issued,
    verdicts: capped.verdicts,
    protocolSha256: reg.record.protocolSha256,
    params: reg.record.parameters,
    reviewers: isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null,
  });
  const minProvenance = isRegistrationV2(reg) ? reg.record.verdicts.minProvenance : "self-asserted";
  const requireSigned = isRegistrationV2(reg) && reg.record.verdicts.require_signed === true;
  if (opts.json) {
    ctx.out(JSON.stringify({ mode, timestampTamperProof: tamperProof, ...report }, null, 2));
  } else if (report.refusal) {
    ctx.out(report.refusal);
    return 3;
  } else {
    ctx.out(statusLine(report, { p0: reg.record.parameters.p0, alpha: reg.record.parameters.alpha, protocol: reg.record.protocolSha256, maxLines: reg.record.selector.max_changed_lines, mode, selector: reg.record.selector }) + tsNote);
    if (report.blockingDraw) ctx.out(`  blocking draw: #${report.blockingDraw.draw} ${report.blockingDraw.changeId} ${report.blockingDraw.url}`);
    ctx.out(`  distinct changes reviewed: ${report.distinctReviewed} · draws counted: ${report.sequence.draws}${report.beyondStop ? ` · ${report.beyondStop} labelled draw(s) after the stop are not counted` : ""}`);
    for (const i of report.ignored) ctx.out(`  ignored verdict on draw #${i.event.draw} (${i.event.changeId}): ${i.reason}`);
    for (const r of report.relabels) ctx.out(`  relabel: ${r.changeId} first ${r.first.verdict} (counts), later ${r.later.verdict}`);
    ctx.out(`  ${provenanceLine(report.provenance)} · registered minimum ${provenanceLabel(minProvenance)}${requireSigned ? " · signed verdicts required (require_signed)" : ""}`);
    if (minProvenance === "presence" || report.provenance.some((p) => p.level === "presence")) ctx.out(`  ${PRESENCE_LIMIT}`);
    for (const note of [...capped.notes, ...capped.warnings]) ctx.out(`  ${note}`);
    const counted = new Set(draws.draws.slice(0, report.sequence.draws).map((d) => d.changeId));
    const below = report.firstVerdicts.filter((v) => counted.has(v.changeId) && provenanceRank(provenanceOf(v)) < provenanceRank(minProvenance));
    if (below.length) ctx.out(`  ${below.length} counted verdict(s) are below the registered ${provenanceLabel(minProvenance)} provenance; verify check 7 will FAIL them (draws ${below.map((v) => `#${v.draw}`).join(", ")})`);
    const unsigned = requireSigned ? report.firstVerdicts.filter((v) => counted.has(v.changeId) && verdictRuleFailures(v, { minProvenance: "self-asserted", requireSigned }).length) : [];
    if (unsigned.length) ctx.out(`  ${unsigned.length} counted verdict(s) carry no valid signature by the registered key of the reviewer they name; verify check 7 will FAIL them under require_signed (draws ${unsigned.map((v) => `#${v.draw}`).join(", ")})`);
    if (report.sequence.state === "CERTIFIED" && ledger.readHistory) {
      const lastVerdict = report.firstVerdicts.filter((v) => counted.has(v.changeId)).reduce((m, v) => (v.recordedAt > m ? v.recordedAt : m), "");
      const cp = latestCheckpointAt(paths.windowDir);
      if (cp === null || Date.parse(cp) < Date.parse(lastVerdict)) ctx.out('  CERTIFIED: run "pr-rla checkpoint" and commit it to anchor the verdict history');
    }
    ctx.out("  assumptions: claim D is about detection under the registered protocol by these reviewers, not the true defect rate; draws are with replacement.");
  }
  return report.sequence.state === "ESCALATE" ? 2 : 0;
}
