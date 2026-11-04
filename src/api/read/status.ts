import { existsSync } from "node:fs";
import { buildPopulation } from "../../core/population.js";
import { auditMode, derivedRoundFor, isRegistrationV2, registrationRepo, type AuditMode, type RegistrationRecordV2, type SignedRecord } from "../../core/records.js";
import { unixToIso } from "../../core/seed.js";
import type { Selector } from "../../core/selector.js";
import { computeStatus, provenanceOf, type StatusReport } from "../../core/status.js";
import { windowDays } from "../../core/window.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { ledgerTraits } from "../../ledger-traits.js";
import { provenanceRank, type ProvenanceLevel, type VerdictEvent } from "../../sdk/ledger.js";
import { notTamperProof } from "../../timestamp/verify.js";
import { latestCheckpointAt } from "./checkpoints.js";
import { auditContextFor, configFor, fmt, isoNow, ledgerFor, pct, providerFor, readCommitment, readDraws, readManifest, readRegistration, trustFor, type ApiContext } from "../session.js";
import { assessRecord } from "../timestamps.js";

/**
 * `status` (functional-design.md §U5): where an audit stands, as one result object per phase.
 * It never writes: `--checkpoint` is the CLI's, as a separate write (`pr-rla checkpoint`).
 */

export interface StatusOptions {
  /** Another window than the configured one (its directory under the audit dir). */
  window?: string;
  /** Do not call the provider (no "N so far" while the window is open). */
  offline?: boolean;
  /**
   * Do not read a ledger that lives in a tracker (one that declares hosts). Status then reports the
   * draws without verdict state. The CLI always reads the ledger; the MCP `status` tool skips it offline.
   */
  skipTrackerLedger?: boolean;
}

interface TimeStanding {
  /** PROSPECTIVE or RETROSPECTIVE: proven by U_k when k operators agree, else the registration's own claim. */
  mode: AuditMode;
  timestampTamperProof: boolean;
  /** ` · TIMESTAMP NOT TAMPER-PROOF (n of k)`, or "" when the times are proven. */
  timestampNote: string;
}

interface SeedRound {
  seedRound: number;
  seedRoundPublishesAt: string;
  seedRoundPublished: boolean;
}

export type StatusResult =
  | { phase: "unregistered"; window: string; start: string; end: string; line: string }
  | ({ phase: "registered"; window: string; windowPhase: string; nSoFar: number | null; line: string } & TimeStanding & SeedRound)
  | ({ phase: "frozen"; window: string; N: number; line: string } & TimeStanding & SeedRound)
  | ({
      phase: "sampled";
      window: string;
      verdictsRead: true;
      ledger: string;
      /** The registration's minimum provenance for a counted verdict. */
      minProvenance: ProvenanceLevel;
      /** Draws whose counted verdict is below the minimum (verify check 7 FAILs them). */
      belowMinimum: number[];
      /** CERTIFIED with a checkpointable ledger whose verdict history is newer than its last checkpoint. */
      checkpointAdvised: boolean;
      /** The certificate line (or the refusal), as the CLI prints it first. */
      line: string;
    } & TimeStanding &
      StatusReport)
  | ({ phase: "sampled"; window: string; verdictsRead: false; ledger: string; verdictsSkipped: string; N: number; drawsIssued: number; line: string } & TimeStanding);

/**
 * The audit mode and the honest-output note for status. v1: tamper-evident iff logged.
 * v2: the stored tokens are checked offline; the mode is proven by U_k when k operators agree,
 * and the note says TIMESTAMP NOT TAMPER-PROOF (n of k) when the registration or the commitment falls short.
 */
export async function timeStanding(ctx: ApiContext, config: PrRlaConfig, paths: WindowPaths, reg: ReturnType<typeof readRegistration>): Promise<{ mode: AuditMode; note: string; tamperProof: boolean }> {
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

/** The certificate line every status and verify prints. */
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

/** The status of the audit's draws against a ledger's verdicts, when draws exist. */
export async function ledgerStatus(paths: WindowPaths, ledger: { readVerdicts(): Promise<VerdictEvent[]> }, reg = readRegistration(paths)): Promise<StatusReport | null> {
  if (!existsSync(paths.manifest) || !existsSync(paths.draws)) return null;
  const manifest = readManifest(paths);
  const draws = readDraws(paths);
  return computeStatus({
    N: manifest.N,
    minPopulation: reg.record.parameters.minPopulation,
    draws: draws.draws,
    drawsIssued: draws.issued,
    verdicts: await ledger.readVerdicts(),
    protocolSha256: reg.record.protocolSha256,
    params: reg.record.parameters,
    reviewers: isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null,
  });
}

/** Where the audit stands: one result per phase (unregistered, registered, frozen, sampled). */
export async function status(ctx: ApiContext, opts: StatusOptions = {}): Promise<StatusResult> {
  const { config, paths } = configFor(ctx, opts.window);
  const window = opts.window ?? config.window.name;
  if (!existsSync(paths.registration)) {
    return { phase: "unregistered", window, start: config.window.start, end: config.window.end, line: `not registered: window ${window} (${config.window.start}..${config.window.end}). Run "pr-rla register".` };
  }
  const reg = readRegistration(paths);
  const { mode, note: timestampNote, tamperProof: timestampTamperProof } = await timeStanding(ctx, config, paths, reg);
  const standing: TimeStanding = { mode, timestampTamperProof, timestampNote };
  const w = reg.record.window;
  const now = Math.floor(ctx.nowMs() / 1000);
  const { round, publishesAt } = derivedRoundFor(reg);
  const seed: SeedRound = { seedRound: round, seedRoundPublishesAt: unixToIso(publishesAt), seedRoundPublished: now >= publishesAt };
  if (!existsSync(paths.manifest)) {
    const opens = Date.parse(w.opensAt) / 1000;
    const closes = Date.parse(w.closesAt) / 1000;
    const windowPhase = now < opens ? "window not yet open" : now < closes ? `window open, day ${Math.floor((now - opens) / 86400) + 1} of ${windowDays(w)}` : "window closed, not frozen";
    let nSoFar: number | null = null;
    if (!opts.offline && now >= opens) {
      const provider = await providerFor(ctx, config);
      ctx.onProgress?.({ done: 0, message: `listing ${registrationRepo(reg)} on ${provider.name} for N so far` });
      const pop = await buildPopulation(provider, { repo: registrationRepo(reg), window: { opensAt: w.opensAt, closesAt: unixToIso(Math.min(now, closes)) }, selector: reg.record.selector, cutoffIso: isoNow(ctx), ...(ctx.signal ? { signal: ctx.signal } : {}) });
      nSoFar = pop.entries.length;
      ctx.onProgress?.({ done: 1, total: 1, message: `N so far ${fmt(nSoFar)}` });
    }
    const soFar = nSoFar === null ? "" : ` · N so far ${fmt(nSoFar)}`;
    const line = `${mode} · ${windowPhase}${soFar} · seed round ${round} ${now < publishesAt ? "not yet published" : "published"}${timestampNote}`;
    return { phase: "registered", window, windowPhase, nSoFar, line, ...standing, ...seed };
  }
  const manifest = readManifest(paths);
  if (!existsSync(paths.draws)) {
    const line = `${mode} · frozen N ${fmt(manifest.N)} · seed round ${round} ${now < publishesAt ? `publishes ${unixToIso(publishesAt)}` : `published ${unixToIso(publishesAt)}: run "pr-rla sample"`}${timestampNote}`;
    return { phase: "frozen", window, N: manifest.N, line, ...standing, ...seed };
  }
  const draws = readDraws(paths);
  if (opts.skipTrackerLedger) {
    const lt = await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx).plugins);
    if (lt.hosts.length > 0) {
      const verdictsSkipped = `offline: ledger ${lt.name} lives in ${lt.hosts.join(", ")}; read its verdicts with offline: false`;
      const line = `${mode} · frozen N ${fmt(manifest.N)} · ${draws.issued} draw(s) issued · verdicts not read (${verdictsSkipped})${timestampNote}`;
      return { phase: "sampled", window, verdictsRead: false, ledger: lt.name, verdictsSkipped, N: manifest.N, drawsIssued: draws.issued, line, ...standing };
    }
  }
  const ledger = await ledgerFor(ctx, config, paths);
  ctx.onProgress?.({ done: 0, message: `reading the verdicts from ledger ${ledger.name}` });
  const report = computeStatus({
    N: manifest.N,
    minPopulation: reg.record.parameters.minPopulation,
    draws: draws.draws,
    drawsIssued: draws.issued,
    verdicts: await ledger.readVerdicts(),
    protocolSha256: reg.record.protocolSha256,
    params: reg.record.parameters,
    reviewers: isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null,
  });
  const minProvenance: ProvenanceLevel = isRegistrationV2(reg) ? reg.record.verdicts.minProvenance : "self-asserted";
  const counted = new Set(draws.draws.slice(0, report.sequence.draws).map((d) => d.changeId));
  const belowMinimum = report.firstVerdicts.filter((v) => counted.has(v.changeId) && provenanceRank(provenanceOf(v)) < provenanceRank(minProvenance)).map((v) => v.draw);
  let checkpointAdvised = false;
  if (report.sequence.state === "CERTIFIED" && ledger.readHistory) {
    const lastVerdict = report.firstVerdicts.filter((v) => counted.has(v.changeId)).reduce((m, v) => (v.recordedAt > m ? v.recordedAt : m), "");
    const cp = latestCheckpointAt(paths.windowDir);
    checkpointAdvised = cp === null || Date.parse(cp) < Date.parse(lastVerdict);
  }
  const line =
    report.refusal ??
    statusLine(report, { p0: reg.record.parameters.p0, alpha: reg.record.parameters.alpha, protocol: reg.record.protocolSha256, maxLines: reg.record.selector.max_changed_lines, mode, selector: reg.record.selector }) + timestampNote;
  return { phase: "sampled", window, verdictsRead: true, ledger: ledger.name, ...standing, ...report, minProvenance, belowMinimum, checkpointAdvised, line };
}
