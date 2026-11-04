import { existsSync } from "node:fs";
import { buildPopulation } from "../../core/population.js";
import { perRepoRows, type RepoRow } from "../../core/pooled-report.js";
import { PRESENCE_LIMIT, auditBinding, countedVerdicts, signaturesCountFor, verdictRuleFailures, type CountedVerdicts } from "../../core/presence/index.js";
import { certificateWithheld, gitFileLedgerGate } from "../../core/ledger-path.js";
import { auditMode, derivedRoundFor, isRegistrationV2, manifestRepos, registrationRepoSet, type AnyRegistration, type AuditMode, type RegistrationRecordV2, type SignedRecord } from "../../core/records.js";
import { describeRepoSet } from "../../core/repo-set.js";
import { unixToIso } from "../../core/seed.js";
import type { Selector } from "../../core/selector.js";
import { computeStatus, provenanceOf, type StatusReport } from "../../core/status.js";
import { windowDays } from "../../core/window.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { ledgerTraits, registeredCeiling } from "../../ledger-traits.js";
import { builtinLedgerName } from "../../registry.js";
import { provenanceRank, type ProvenanceLevel, type VerdictEvent } from "../../sdk/ledger.js";
import { anchorLines, notTamperProof } from "../../timestamp/verify.js";
import { latestCheckpointAt } from "./checkpoints.js";
import { auditContextFor, configFor, fmt, isoNow, ledgerFor, pct, providerFor, readCommitment, readDraws, readManifest, readRegistration, trustFor, type ApiContext } from "../session.js";
import { assessRecord, logBound } from "../timestamps.js";
import { fenceStatus, renderResult } from "./untrusted.js";

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
  /** Each counted authority's anchor and its independence (NFR4, trusted-time round); empty for v1 or no tokens. */
  timestampAnchors: string[];
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
      /** The registration requires every counted verdict to be signed (U9). */
      requireSigned: boolean;
      /** Under require_signed: draws whose counted verdict carries no valid signature by its reviewer's registered key (check 7 FAILs them). */
      unsigned: number[];
      /** What counting the verdicts found (U9): ceilings applied, and signatures that did not count. */
      verdictNotes: string[];
      /** A pooled audit's per-repo counts (U8): descriptive; the risk limit applies to the pool. */
      perRepo?: RepoRow[];
      /** The built-in git-file ledger's integrity walk and path rule, as check 7 runs them (P4); null for other ledgers. */
      ledgerIntegrity: { ok: boolean; findings: string[]; fails: string[]; warnings: string[] } | null;
      /** Why CERTIFIED is withheld although the sequence certifies: what check 7 would FAIL (P4). Empty otherwise. */
      certificateWithheld: string[];
      /** Read-only mode (S1): what ledger lines said (a reviewer, a note, an app's name), which the fields above point to as `untrusted.errors[i]`. */
      untrusted?: { errors: string[] };
      /** The certificate line (or the refusal), as the CLI prints it first. */
      line: string;
    } & TimeStanding &
      StatusReport)
  | ({ phase: "sampled"; window: string; verdictsRead: false; ledger: string; verdictsSkipped: string; N: number; drawsIssued: number; line: string } & TimeStanding);

/**
 * The audit mode and the honest-output note for status. v1: tamper-evident iff its log entries verify
 * under a pinned log key (an entry in any other log is unverified). v2: the stored tokens are checked
 * offline; the mode is proven by U_k when k operators agree, and the note says TIMESTAMP NOT TAMPER-PROOF
 * (n of k) when the registration or the commitment falls short. `anchors` names each counted authority's
 * anchor and its independence (NFR4), or is empty.
 */
export async function timeStanding(ctx: ApiContext, config: PrRlaConfig, paths: WindowPaths, reg: ReturnType<typeof readRegistration>): Promise<{ mode: AuditMode; note: string; tamperProof: boolean; anchors: string[] }> {
  if (!isRegistrationV2(reg)) {
    const logged = (await logBound(ctx, config, reg)) !== null && (!existsSync(paths.commitment) || (await logBound(ctx, config, readCommitment(paths))) !== null);
    return { mode: auditMode(reg), note: logged ? "" : " · TIMESTAMP NOT TAMPER-PROOF", tamperProof: logged, anchors: [] };
  }
  const v2 = reg as SignedRecord<RegistrationRecordV2>;
  const bundle = trustFor(ctx);
  const ts = v2.record.timestamping;
  const r = await assessRecord(ctx, config, v2, v2.record.registeredAt, ts, bundle);
  let short = r.proven ? null : r;
  const anchors = anchorLines(r);
  if (existsSync(paths.commitment)) {
    const cm = readCommitment(paths);
    const c = await assessRecord(ctx, config, cm, cm.record.frozenAt, ts, bundle);
    if (!c.proven && !short) short = c;
    for (const l of anchorLines(c)) if (!anchors.includes(l)) anchors.push(l);
  }
  const mode: AuditMode = r.proven ? (r.ukMs! < Date.parse(v2.record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE") : auditMode(reg);
  return { mode, note: short ? ` · ${notTamperProof(short)}` : "", tamperProof: !short, anchors };
}

/**
 * The ledger's verdicts as they count (U9): signatures attested against the registration's allowed
 * signers only in the registered built-in git-file ledger, over the v2 bytes that also name the
 * manifest and the seed (P4: `binding`, from manifest.json and draws.json; verify takes it from what
 * it verified), every level capped at the registered ledger's ceiling, and no signature fields in
 * what comes back. `ineligible` says which lines cannot count under the signing rules. Status, the
 * draws and the draw context read verdicts through this, as verify's check 7 does.
 */
export async function countedLedgerVerdicts(ctx: ApiContext, config: PrRlaConfig, reg: SignedRecord<AnyRegistration>, ledger: { name: string; readVerdicts(): Promise<VerdictEvent[]> }, at: { manifestSha256: string; beacon: { round: number; randomness: string } }): Promise<CountedVerdicts> {
  const registeredLedger = isRegistrationV2(reg) ? reg.record.plugins.ledger : null;
  const ceiling = registeredCeiling(registeredLedger, await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx)));
  const verifiesSignatures = signaturesCountFor(registeredLedger) && builtinLedgerName(config.ledger.use) === "git-file";
  const binding = auditBinding(reg.sha256, at.manifestSha256, at.beacon);
  return countedVerdicts(await ledger.readVerdicts(), { registration: reg, binding, verifiesSignatures, ceiling, ledger: ledger.name });
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
export function statusLine(r: StatusReport, info: { p0: number; alpha: number; protocol: string; maxLines: number | null; mode: string; selector?: Partial<Selector>; withheld?: readonly string[] }): string {
  const s = r.sequence;
  const stratum = `${info.maxLines !== null ? `, stratum ≤ ${info.maxLines} lines` : ""}${stratumChoices(info.selector)}`;
  const head = `prefix ${r.labelledPrefix}/${r.drawsIssued} · fails ${s.fails} · claim D (detected-defect rate ≤ ${pct(info.p0)}, protocol ${info.protocol.slice(0, 4)}…${stratum}) · LLR ${s.llr.toFixed(3)} / target ${s.target.toFixed(3)}`;
  let verdict: string;
  // P4: never CERTIFIED where verify would FAIL check 7.
  if (s.state === "CERTIFIED" && info.withheld?.length) verdict = `NOT CERTIFIED: verify check 7 would FAIL (${info.withheld.join("; ")}); run "pr-rla verify"`;
  else if (s.state === "CERTIFIED") verdict = `CERTIFIED (risk ${pct(info.alpha)})`;
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
  const { mode, note: timestampNote, tamperProof: timestampTamperProof, anchors: timestampAnchors } = await timeStanding(ctx, config, paths, reg);
  const standing: TimeStanding = { mode, timestampTamperProof, timestampNote, timestampAnchors };
  const w = reg.record.window;
  const now = Math.floor(ctx.nowMs() / 1000);
  const { round, publishesAt } = derivedRoundFor(reg);
  const seed: SeedRound = { seedRound: round, seedRoundPublishesAt: unixToIso(publishesAt), seedRoundPublished: now >= publishesAt };
  if (!existsSync(paths.manifest)) {
    const opens = Date.parse(w.opensAt) / 1000;
    const closes = Date.parse(w.closesAt) / 1000;
    const windowPhase = now < opens ? "window not yet open" : now < closes ? `window open, day ${Math.floor((now - opens) / 86400) + 1} of ${windowDays(w)}` : "window closed, not frozen";
    let nSoFar: number | null = null;
    let soFar = "";
    const set = registrationRepoSet(reg);
    if (!opts.offline && now >= opens && set.kind === "repo") {
      const provider = await providerFor(ctx, config);
      ctx.onProgress?.({ done: 0, message: `listing ${set.repo} on ${provider.name} for N so far` });
      const pop = await buildPopulation(provider, { repo: set.repo, window: { opensAt: w.opensAt, closesAt: unixToIso(Math.min(now, closes)) }, selector: reg.record.selector, cutoffIso: isoNow(ctx), ...(ctx.signal ? { signal: ctx.signal } : {}) });
      nSoFar = pop.entries.length;
      soFar = ` · N so far ${fmt(nSoFar)}`;
      ctx.onProgress?.({ done: 1, total: 1, message: `N so far ${fmt(nSoFar)}` });
    } else if (!opts.offline && now >= opens)
      // A pool's N needs a listing of every repo (about what a freeze costs), so plain status does not spend it (U8).
      soFar = ` · N so far: not computed for a pool (${describeRepoSet(set)}): it lists every repo, about as many requests as the freeze; "pr-rla freeze --dry-run --estimate" predicts them and "pr-rla freeze --dry-run" counts N`;
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
    const lt = await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx));
    if (lt.hosts.length > 0) {
      const verdictsSkipped = `offline: ledger ${lt.name} lives in ${lt.hosts.join(", ")}; read its verdicts with offline: false`;
      const line = `${mode} · frozen N ${fmt(manifest.N)} · ${draws.issued} draw(s) issued · verdicts not read (${verdictsSkipped})${timestampNote}`;
      return { phase: "sampled", window, verdictsRead: false, ledger: lt.name, verdictsSkipped, N: manifest.N, drawsIssued: draws.issued, line, ...standing };
    }
  }
  const ledger = await ledgerFor(ctx, config, paths);
  ctx.onProgress?.({ done: 0, message: `reading the verdicts from ledger ${ledger.name}` });
  const capped = await countedLedgerVerdicts(ctx, config, reg, ledger, { manifestSha256: manifest.sha256, beacon: draws.beacon });
  const report = computeStatus({
    N: manifest.N,
    minPopulation: reg.record.parameters.minPopulation,
    draws: draws.draws,
    drawsIssued: draws.issued,
    verdicts: capped.verdicts,
    protocolSha256: reg.record.protocolSha256,
    params: reg.record.parameters,
    reviewers: isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null,
    ineligible: capped.ineligible,
  });
  const minProvenance: ProvenanceLevel = isRegistrationV2(reg) ? reg.record.verdicts.minProvenance : "self-asserted";
  const counted = new Set(draws.draws.slice(0, report.sequence.draws).map((d) => d.changeId));
  const belowMinimum = report.firstVerdicts.filter((v) => counted.has(v.changeId) && provenanceRank(provenanceOf(v)) < provenanceRank(minProvenance)).map((v) => v.draw);
  const requireSigned = isRegistrationV2(reg) && reg.record.verdicts.require_signed === true;
  const unsigned = requireSigned ? report.firstVerdicts.filter((v) => counted.has(v.changeId) && verdictRuleFailures(v, { minProvenance: "self-asserted", requireSigned }).length).map((v) => v.draw) : [];
  const verdictNotes = [...(minProvenance === "presence" || report.provenance.some((p) => p.level === "presence") ? [PRESENCE_LIMIT] : []), ...capped.notes, ...capped.warnings];
  const perRepo = manifestRepos(manifest).length > 1 ? perRepoRows(manifest, draws.draws.slice(0, report.sequence.draws), report.firstVerdicts) : null;
  // P4: status runs check 7's git-file integrity walk and path rule (local), and withholds CERTIFIED where check 7 would FAIL.
  const gate = builtinLedgerName(config.ledger.use) === "git-file" ? await gitFileLedgerGate(ledger, reg) : null;
  const withheld = report.sequence.state === "CERTIFIED" ? certificateWithheld({ gate, below: belowMinimum.length, unsigned: unsigned.length }) : [];
  const ledgerIntegrity = gate ? { ok: !gate.fails.length, findings: gate.integrity?.findings ?? [], fails: gate.fails, warnings: gate.warns } : null;
  let checkpointAdvised = false;
  if (report.sequence.state === "CERTIFIED" && ledger.readHistory) {
    const lastVerdict = report.firstVerdicts.filter((v) => counted.has(v.changeId)).reduce((m, v) => (v.recordedAt > m ? v.recordedAt : m), "");
    const cp = latestCheckpointAt(paths.windowDir);
    checkpointAdvised = cp === null || Date.parse(cp) < Date.parse(lastVerdict);
  }
  const line =
    report.refusal ??
    statusLine(report, { p0: reg.record.parameters.p0, alpha: reg.record.parameters.alpha, protocol: reg.record.protocolSha256, maxLines: reg.record.selector.max_changed_lines, mode, selector: reg.record.selector, withheld }) + timestampNote;
  // Rendered once, by the mode (S1): in read-only mode the verdicts' reviewers, notes and other ledger-written fields,
  // and what the counting notes quote from ledger lines, are pr-rla's words with the text in untrusted.errors.
  const shown = ctx.mode === "read-only" ? fenceStatus(report) : report;
  return renderResult<StatusResult>(ctx.mode ?? "read-write", { phase: "sampled", window, verdictsRead: true, ledger: ledger.name, ...standing, ...shown, minProvenance, belowMinimum, checkpointAdvised, requireSigned, unsigned, verdictNotes, ...(perRepo ? { perRepo } : {}), ledgerIntegrity, certificateWithheld: withheld, line });
}
