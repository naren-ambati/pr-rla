import { existsSync } from "node:fs";
import { buildPopulation } from "../../core/population.js";
import { perRepoRows, type RepoRow } from "../../core/pooled-report.js";
import { PRESENCE_LIMIT, auditBinding, countedVerdicts, signaturesCountFor, verdictRuleFailures, type CountedVerdicts } from "../../core/presence/index.js";
import type { GateLedger } from "../../core/ledger-gate.js";
import { auditMode, derivedRoundFor, isRegistrationV2, manifestRepos, registeredAccounts, registrationRepoSet, type AnyRegistration, type AuditMode, type RegistrationRecordV2, type SignedRecord } from "../../core/records.js";
import { describeRepoSet } from "../../core/repo-set.js";
import { dropPrefix, foreign, foreignError, said, wordsOf } from "../../core/said.js";
import { unixToIso } from "../../core/seed.js";
import type { Selector } from "../../core/selector.js";
import { computeStatus, provenanceOf, type StatusReport } from "../../core/status.js";
import { certificateFor, failedWithholdings, isCertified, verdictExitCode, withheldVerdict, type Certificate, type Withholding } from "../../core/verdict.js";
import { windowDays } from "../../core/window.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { ledgerTraits, registeredCeiling, testOnlyLedgerOptions } from "../../ledger-traits.js";
import { builtinLedgerName } from "../../registry.js";
import { provenanceRank, type ProvenanceLevel, type VerdictEvent } from "../../sdk/ledger.js";
import { anchorLines, notTamperProof } from "../../timestamp/verify.js";
import { latestCheckpointAt, readCheckpoints } from "./checkpoints.js";
import { check7Gate } from "./ledger-gate.js";
import { bindRegisteredPlugin, callerOf, readOnlyContext, auditContextFor, configFor, fmt, isoNow, ledgerFor, pct, providerFor, readCommitment, readDraws, readManifest, readRegistration, trustFor, type ApiContext } from "../session.js";
import { accessShortfall } from "../access.js";
import { assessRecord, logBound } from "../timestamps.js";
import { fenceStatus, renderResult } from "./untrusted.js";
import { registrationPin, statusCore } from "./offline-core.js";
import type { CoreGate } from "../../core/verify-core.js";

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
  /**
   * Timestamp-authority anchors the caller trusts beyond the shipped bundle (files, as verify's `--tsa-trust`; the
   * audit repo cannot add its own). Since time round B a certificate cannot stand on a time status cannot prove, so
   * status needs the same anchors verify is given for an authority outside the shipped bundle.
   */
  tsaTrust?: string[];
  /**
   * P5: the verifier's transparency-log keys, `<log url>=<pem file>` each, as verify's `--log-key`: a v1 record's log
   * entry proves its time only under a key the caller trusts (the pinned ones always do).
   */
  logKey?: string[];
  /**
   * P5 (T14): the registration's SHA-256 you were given before R published (prospective: before the window opened), as
   * verify's `--registration`: the offline checks FAIL a registration that is not it.
   */
  registration?: string;
}

interface TimeStanding {
  /** PROSPECTIVE or RETROSPECTIVE: proven by U_k when k operators agree, else the registration's own claim. */
  mode: AuditMode;
  timestampTamperProof: boolean;
  /** ` · TIMESTAMP NOT TAMPER-PROOF (n of k)`, or "" when the times are proven. */
  timestampNote: string;
  /** Each counted authority's anchor and its independence (NFR4, trusted-time round); empty for v1 or no tokens. */
  timestampAnchors: string[];
  /**
   * Why a certificate cannot stand on these times (time round B): one INCOMPLETE withholding per record whose time is
   * not proven (the registration, the commitment). Empty when both are proven. verify's checks 1–3 say the same.
   */
  timeWithheld: Withholding[];
}

interface SeedRound {
  seedRound: number;
  seedRoundPublishesAt: string;
  seedRoundPublished: boolean;
}

export type StatusResult =
  | { phase: "unregistered"; window: string; start: string; end: string; line: string }
  | ({ phase: "registered"; window: string; windowPhase: string; nSoFar: number | null; line: string } & TimeStanding & SeedRound)
  | ({
      phase: "frozen";
      window: string;
      N: number;
      line: string;
      /** P5 (finding 9): N below the registered minimum: the registration says review all N instead (exit 3). Null otherwise. */
      refusal: string | null;
    } & TimeStanding &
      SeedRound)
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
      /** The ledger's integrity report and git-file's path rule, as check 7 judges them (P4; every ledger since P1); null for a ledger with no integrity check. */
      ledgerIntegrity: { ok: boolean; findings: string[]; fails: string[]; warnings: string[] } | null;
      /**
       * Check 7's gate as status ran it (P1, src/core/ledger-gate.ts): every FAIL and WARN verify's check 7 gives for the same
       * files and ledger read. `shown`: the lines status prints besides its own (the binding, the publication, the
       * checkpoints and their coverage). Any FAIL withholds CERTIFIED (`certificateWithheld`).
       */
      ledgerGate: { fails: string[]; incompletes: string[]; warns: string[]; shown: string[] };
      /** Why CERTIFIED is withheld although the sequence certifies: what check 7 would FAIL (P4). Empty otherwise. */
      certificateWithheld: string[];
      /**
       * What the certificate line may say (src/core/verdict.ts): CERTIFIED only when the SPRT certified, the population
       * is not below the minimum, and nothing withholds it (an unproven time; `withheld` says what). `status` exits by it.
       */
      certificate: Certificate;
      /** `isCertified(certificate)`: the only "certified" a client may show. `sequence.state` is the SPRT's raw state. */
      certified: boolean;
      /** Read-only mode (S1): what ledger lines said (a reviewer, a note, an app's name), which the fields above point to as `untrusted.errors[i]`. */
      untrusted?: { errors: string[] };
      /**
       * P5 (finding 6): verify's offline checks (1, 2, 3, 4 and 6, src/core/verify-core.ts) as status ran them on the same
       * records; check 5 (the SCM) and the tracker reads of check 7 need `pr-rla verify`.
       */
      offlineChecks: { n: number; name: string; status: string; summary: string }[];
      /** What of `offlineChecks` would FAIL in verify: status exits 1 on any, whatever the sequence's state. */
      offlineFails: string[];
      /** The certificate line (or the refusal), as the CLI prints it first. */
      line: string;
    } & TimeStanding &
      StatusReport)
  | ({
      phase: "sampled";
      window: string;
      verdictsRead: false;
      ledger: string;
      verdictsSkipped: string;
      N: number;
      drawsIssued: number;
      line: string;
      /** Check 7's local rules, without the tracker (P1): the index binding, its publication record, the checkpoint file. */
      ledgerGate: { fails: string[]; incompletes: string[]; warns: string[] };
      /** verify's offline checks (1, 2, 3, 4 and 6) on the same records, as in the verdicts-read result. */
      offlineChecks: { n: number; name: string; status: string; summary: string }[];
      /** What of `offlineChecks` and check 7's local rules would FAIL in verify: status exits 1 on any. */
      offlineFails: string[];
    } & TimeStanding);

/**
 * The audit mode and the honest-output note for status. v1: tamper-evident iff its log entries verify
 * under a pinned log key (an entry in any other log is unverified). v2: the stored tokens are checked
 * offline; the mode is proven by U_k when k operators agree, and the note says TIMESTAMP NOT TAMPER-PROOF
 * (n of k) when the registration or the commitment falls short. `anchors` names each counted authority's
 * anchor and its independence (NFR4), or is empty. `withheld` has one INCOMPLETE withholding per record
 * whose time is not proven (time round B): a certificate cannot stand on it.
 */
export async function timeStanding(ctx: ApiContext, config: PrRlaConfig, paths: WindowPaths, reg: ReturnType<typeof readRegistration>, tsaTrust: readonly string[] = [], logKey: readonly string[] = []): Promise<{ mode: AuditMode; note: string; tamperProof: boolean; anchors: string[]; withheld: Withholding[] }> {
  if (!isRegistrationV2(reg)) {
    const withheld: Withholding[] = [];
    const keys = logKey.length ? " or the --log-key you gave" : "";
    if ((await logBound(ctx, config, reg, logKey)) === null) withheld.push({ verdict: "INCOMPLETE", reason: `registration time unproven: no transparency-log entry verified under a pinned key${keys}` });
    if (existsSync(paths.commitment) && (await logBound(ctx, config, readCommitment(paths), logKey)) === null) withheld.push({ verdict: "INCOMPLETE", reason: `manifest commitment time unproven: no transparency-log entry verified under a pinned key${keys}` });
    return { mode: auditMode(reg), note: withheld.length ? " · TIMESTAMP NOT TAMPER-PROOF" : "", tamperProof: !withheld.length, anchors: [], withheld };
  }
  const v2 = reg as SignedRecord<RegistrationRecordV2>;
  const bundle = trustFor(ctx, tsaTrust);
  const ts = v2.record.timestamping;
  const r = await assessRecord(ctx, config, v2, v2.record.registeredAt, ts, bundle, logKey);
  let short = r.proven ? null : r;
  const withheld: Withholding[] = r.proven ? [] : [{ verdict: "INCOMPLETE", reason: `registration time unproven (${notTamperProof(r)})` }];
  const anchors = anchorLines(r);
  if (existsSync(paths.commitment)) {
    const cm = readCommitment(paths);
    const c = await assessRecord(ctx, config, cm, cm.record.frozenAt, ts, bundle, logKey);
    if (!c.proven && !short) short = c;
    if (!c.proven) withheld.push({ verdict: "INCOMPLETE", reason: `manifest commitment time unproven (${notTamperProof(c)})` });
    for (const l of anchorLines(c)) if (!anchors.includes(l)) anchors.push(l);
  }
  const mode: AuditMode = r.proven ? (r.ukMs! < Date.parse(v2.record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE") : auditMode(reg);
  return { mode, note: short ? ` · ${notTamperProof(short)}` : "", tamperProof: !short, anchors, withheld };
}

/** The standing withholding every status carries: check 5 (the population rebuilt from the SCM) is verify's alone. */
export const POPULATION_NOT_VERIFIED: Withholding = { verdict: "INCOMPLETE", reason: "population not verified: run `pr-rla verify`" };

/**
 * The exit code of a status result (contracts.md §7): 1 not registered; 3 below the registered minimum population;
 * 2 ESCALATE; for a certificate the SPRT reached but something withholds, the exit code of the withholding's verdict
 * (src/core/verdict.ts: 6 INCOMPLETE, 1 FAILED); else 0. The CLI exits with it; the MCP status tool reports it.
 */
export function statusExitCode(r: StatusResult): number {
  if (r.phase === "unregistered") return 1;
  // P5 (finding 9): frozen below the registered minimum is the refusal sample gives (review all N), exit 3.
  if (r.phase === "frozen") return r.refusal ? 3 : 0;
  if (r.phase !== "sampled") return 0;
  // Verdicts not read (the tracker is offline): the offline core and check 7's local rules still ran, and what verify would FAIL fails here.
  if (!r.verdictsRead) return r.offlineFails.length || r.ledgerGate.fails.length ? 1 : 0;
  if (r.certificate.state === "REFUSED") return 3;
  // P5 (finding 6): a check verify would FAIL on these records fails status too, whatever the sequence's state.
  if (r.offlineFails.length) return 1;
  if (r.certificate.state === "ESCALATE") return 2;
  if (r.certificate.state === "WITHHELD" || r.certificate.state === "INCOMPLETE") return verdictExitCode(withheldVerdict(r.certificate.withheld));
  return 0;
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

/**
 * The certificate line every status and verify prints. It says CERTIFIED only when `certificate` (src/core/verdict.ts)
 * is CERTIFIED: a certificate the SPRT reached but something withholds reads `CERTIFICATE WITHHELD (why)`, and a
 * population below the registered minimum reads its refusal, whatever the SPRT says. Without `certificate`, the
 * SPRT's state and the refusal decide, with `info.withheld` (reasons a check would FAIL) withholding a CERTIFIED.
 */
export function statusLine(
  r: StatusReport,
  info: { p0: number; alpha: number; protocol: string; maxLines: number | null; mode: string; selector?: Partial<Selector>; withheld?: readonly string[] },
  certificate: Certificate = certificateFor(r.sequence.state, r.refusal ?? null, failedWithholdings(info.withheld ?? [])),
): string {
  const s = r.sequence;
  const stratum = `${info.maxLines !== null ? `, stratum ≤ ${info.maxLines} lines` : ""}${stratumChoices(info.selector)}`;
  const head = `prefix ${r.labelledPrefix}/${r.drawsIssued} · fails ${s.fails} · claim D (detected-defect rate ≤ ${pct(info.p0)}, protocol ${info.protocol.slice(0, 4)}…${stratum}) · LLR ${s.llr.toFixed(3)} / target ${s.target.toFixed(3)}`;
  let verdict: string;
  if (certificate.state === "REFUSED") verdict = `REFUSED: ${r.refusal ?? `population ${fmt(r.N)} < ${fmt(r.minPopulation)}: review all ${fmt(r.N)} instead`}`;
  else if (certificate.state === "INCOMPLETE") verdict = `INCOMPLETE: not established (${certificate.withheld.map((w) => w.reason).join("; ")})`;
  else if (certificate.state === "WITHHELD") verdict = `target reached · CERTIFICATE WITHHELD (${certificate.withheld.map((w) => w.reason).join("; ")})`;
  else if (certificate.state === "CERTIFIED") verdict = `CERTIFIED (risk ${pct(info.alpha)})`;
  else if (certificate.state === "ESCALATE") verdict = `ESCALATE: review all ${fmt(r.N)} or narrow the claim`;
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
  ctx = readOnlyContext(ctx); // P1: status only reads (--checkpoint is a separate write, on the caller's own context)
  const { config, paths } = configFor(ctx, opts.window);
  const window = opts.window ?? config.window.name;
  const pinned = registrationPin(opts.registration); // a malformed --registration is a usage error, in every phase
  if (!existsSync(paths.registration)) {
    return { phase: "unregistered", window, start: config.window.start, end: config.window.end, line: `not registered: window ${window} (${config.window.start}..${config.window.end}). Run "pr-rla register".` };
  }
  const reg = readRegistration(paths);
  const { mode, note: timestampNote, tamperProof: timestampTamperProof, anchors: timestampAnchors, withheld: timeWithheld } = await timeStanding(ctx, config, paths, reg, opts.tsaTrust ?? [], opts.logKey ?? []);
  const standing: TimeStanding = { mode, timestampTamperProof, timestampNote, timestampAnchors, timeWithheld };
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
      const provider = await providerFor(ctx, config, { registration: reg, command: "status" });
      ctx.onProgress?.({ done: 0, message: `listing ${set.repo} on ${provider.name} for N so far` });
      const pop = await buildPopulation(provider, { repo: set.repo, window: { opensAt: w.opensAt, closesAt: unixToIso(Math.min(now, closes)) }, selector: reg.record.selector, cutoffIso: isoNow(ctx), accounts: registeredAccounts(reg), ...(ctx.signal ? { signal: ctx.signal } : {}) });
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
    // P5 (finding 9): below the registered minimum, sample refuses (exit 3); status says so now, with the same exit.
    const min = reg.record.parameters.minPopulation;
    const refusal = manifest.N < min ? `REFUSED: population ${fmt(manifest.N)} < the registered minimum ${fmt(min)}: review all ${fmt(manifest.N)} instead (sample draws nothing)` : null;
    const line = `${mode} · frozen N ${fmt(manifest.N)} · ${refusal ?? `seed round ${round} ${now < publishesAt ? `publishes ${unixToIso(publishesAt)}` : `published ${unixToIso(publishesAt)}: run "pr-rla sample"`}`}${timestampNote}`;
    return { phase: "frozen", window, N: manifest.N, line, refusal, ...standing, ...seed };
  }
  const draws = readDraws(paths);
  // P1: status reads only the registered ledger, and refuses any other before anything is read (even offline).
  await bindRegisteredPlugin(ctx, config, reg, "ledger", { command: "status" });
  // The ledger as check 7's gate has it: bound above, so its identity is the registered one.
  const loaded = { identity: isRegistrationV2(reg) ? reg.record.plugins.ledger : null, testOnlyOptions: testOnlyLedgerOptions(config.ledger) };
  const trust = trustFor(ctx, opts.tsaTrust ?? []);
  if (opts.skipTrackerLedger) {
    const lt = await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx));
    if (lt.hosts.length > 0) {
      const verdictsSkipped = `offline: ledger ${lt.name} lives in ${lt.hosts.join(", ")}; read its verdicts with offline: false`;
      const line = `${mode} · frozen N ${fmt(manifest.N)} · ${draws.issued} draw(s) issued · verdicts not read (${verdictsSkipped})${timestampNote}`;
      // Check 7's local rules still run (the index, its publication, the checkpoint file): what verify would FAIL without reading the tracker.
      const g = await check7Gate(paths, reg, { ...loaded, read: null }, trust);
      // The offline core too (checks 1, 2, 3, 4 and 6), as the verdicts-read path runs it: a registration, manifest or
      // draws file verify would FAIL must not exit 0 here because the tracker was not read.
      const local7: CoreGate = { n: 7, name: "labels", reason: { fail: "verify check 7 would FAIL: ", incomplete: "verify check 7 would be INCOMPLETE: " }, run: async () => ({ fails: g.withheld, incompletes: g.unestablished }) };
      const core = await statusCore(ctx, config, { registration: reg, manifest, commitment: existsSync(paths.commitment) ? readCommitment(paths) : null, draws }, { tsaTrust: opts.tsaTrust ?? [], logKey: opts.logKey ?? [], ...(pinned !== undefined ? { registrationSha256: pinned } : {}) }, [local7]);
      const offlineFails = core.withholdings.filter((w) => w.verdict === "FAILED").map((w) => w.reason);
      return renderResult<StatusResult>(callerOf(ctx) !== "person" ? "read-only" : "read-write", { phase: "sampled", window, verdictsRead: false, ledger: lt.name, verdictsSkipped, N: manifest.N, drawsIssued: draws.issued, line, ...standing, ledgerGate: { fails: g.fails.map(String), incompletes: g.incompletes.map(String), warns: g.warns.map(String) }, offlineChecks: core.checks.map((c) => ({ n: c.n, name: c.name, status: c.status, summary: c.summary })), offlineFails });
    }
  }
  const ledger = await ledgerFor(ctx, config, paths, { command: "status" });
  ctx.onProgress?.({ done: 0, message: `reading the verdicts from ledger ${ledger.name}` });
  // Time round B: a verdict read refused to a ledger running without its credential is not "no verdicts" (src/api/access.ts).
  const actx = auditContextFor(ctx);
  let capped: CountedVerdicts;
  try {
    capped = await countedLedgerVerdicts(ctx, config, reg, ledger, { manifestSha256: manifest.sha256, beacon: draws.beacon });
  } catch (e) {
    if (!accessShortfall(actx, `ledger:${ledger.name}`, `ledger ${ledger.name}`)) throw e;
    capped = { verdicts: [], notes: [said`ledger ${ledger.name}: readVerdicts failed: ${foreignError(e)}`], findings: [], warnings: [], ineligible: () => null };
  }
  const unread = accessShortfall(actx, `ledger:${ledger.name}`, `ledger ${ledger.name}`);
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
  // P1 (with the seam review): check 7's gate, the one verify runs (src/core/ledger-gate.ts), over what status read:
  // nothing verify FAILs there can show as CERTIFIED here. The ledger's integrity report and history come from the
  // same read as the verdicts (an issue ledger reads its tracker once).
  let integrity: GateLedger["integrity"] = null;
  if (ledger.verifyIntegrity) {
    try {
      integrity = { report: await ledger.verifyIntegrity(), error: null };
    } catch (e) {
      integrity = { report: null, error: foreignError(e) };
    }
  }
  let history: GateLedger["history"] = null;
  if (ledger.readHistory && readCheckpoints(paths.windowDir).checkpoints.length) {
    try {
      history = { events: await ledger.readHistory(), error: null };
    } catch (e) {
      history = { events: null, error: foreignError(e) };
    }
  }
  const countedFirst = report.firstVerdicts.filter((v) => counted.has(v.changeId));
  const gate = await check7Gate(paths, reg, { ...loaded, read: { name: ledger.name, publishes: !!ledger.publishDraws, checkpointable: !!ledger.readHistory, findingsArePrRlas: builtinLedgerName(config.ledger.use) === "git-file", verdictsRead: capped.verdicts, counted: countedFirst, firstVerdicts: report.firstVerdicts, integrity, history } }, trust);
  const withheld = report.sequence.state === "CERTIFIED" ? gate.withheld : [];
  // P4's view of the integrity rule (the integrity report and git-file's path), kept for its callers.
  const integrityLines = gate.lines.filter((l) => l.rule === "integrity");
  // Its warnings are the path rule's, as P4 printed them (the report's own warnings are check 7's WARN lines, not repeated here).
  // What the integrity report says is the ledger's text (S1), so it is carried as foreign unless the ledger is pr-rla's git-file.
  const ours = builtinLedgerName(config.ledger.use) === "git-file";
  const ledgerIntegrity = integrity ? { ok: !integrityLines.some((l) => l.level === "fail"), findings: (integrity.report?.findings ?? []).map((f) => (ours ? f : foreign("the ledger's integrity finding", f))), fails: integrityLines.filter((l) => l.level === "fail").map((l) => dropPrefix(l.text, "FAIL ")), warnings: integrityLines.filter((l) => l.level === "warn" && wordsOf(l.text).startsWith("WARN ")).map((l) => dropPrefix(l.text, "WARN ")) } : null;
  // The rest of the gate, as status prints it: what status does not already say its own way (the verdict rules, the integrity report).
  const shown = gate.lines.filter((l) => l.level !== "note" && l.rule !== "integrity" && l.rule !== "provenance" && l.rule !== "signatures");
  let checkpointAdvised = false;
  if (report.sequence.state === "CERTIFIED" && ledger.readHistory) {
    const lastVerdict = report.firstVerdicts.filter((v) => counted.has(v.changeId)).reduce((m, v) => (v.recordedAt > m ? v.recordedAt : m), "");
    const cp = latestCheckpointAt(paths.windowDir);
    checkpointAdvised = cp === null || Date.parse(cp) < Date.parse(lastVerdict);
  }
  // The one certificate rule (src/core/verdict.ts): what status can establish offline withholds it. The times give
  // INCOMPLETE withholdings; a status-side gate of check 7 (P4's git-file walk, P1's local gate) adds its FAIL reasons
  // here as failedWithholdings(...), so status never shows CERTIFIED where verify would not.
  // P5 (finding 6): verify's offline checks 1, 2, 3, 4 and 6 on the same records (src/core/verify-core.ts): nothing they
  // FAIL shows as CERTIFIED, and what they cannot establish withholds it. P1's check-7 local gate (computed above, which
  // also feeds `ledgerGate` and `certificateWithheld`) plugs into the same call as a CoreGate: one path.
  const check7: CoreGate = {
    n: 7,
    name: "labels",
    reason: { fail: "verify check 7 would FAIL: ", incomplete: "verify check 7 would be INCOMPLETE: " },
    run: async () => ({ fails: withheld, incompletes: gate.unestablished }),
  };
  const core = await statusCore(ctx, config, { registration: reg, manifest, commitment: existsSync(paths.commitment) ? readCommitment(paths) : null, draws }, { tsaTrust: opts.tsaTrust ?? [], logKey: opts.logKey ?? [], ...(pinned !== undefined ? { registrationSha256: pinned } : {}) }, [check7]);
  const offlineFails = core.withholdings.filter((w) => w.verdict === "FAILED").map((w) => w.reason);
  // Status never rebuilds the population (verify's check 5 does, from the SCM): a target the SPRT reached stands on a
  // population nobody here has compared with the registered stratum, so only `pr-rla verify` can produce CERTIFIED.
  // (A result that is INCOMPLETE already, for want of a read, is not CERTIFIED either way: the reason is not repeated there.)
  const withholdings = [...timeWithheld, ...core.withholdings, ...(unread ? [] : [POPULATION_NOT_VERIFIED])];
  const certificate = certificateFor(report.sequence.state, report.refusal, withholdings, unread ? [unread] : []);
  const line =
    report.refusal ??
    statusLine(report, { p0: reg.record.parameters.p0, alpha: reg.record.parameters.alpha, protocol: reg.record.protocolSha256, maxLines: reg.record.selector.max_changed_lines, mode, selector: reg.record.selector }, certificate) + timestampNote;
  // Rendered once, by the reader (S1): when an assistant reads, the verdicts' reviewers, notes and other ledger-written
  // fields, and what the counting notes and the gate quote from ledger lines, are pr-rla's words with the text in
  // untrusted.errors. P1 runs every read on a read-only context, so the caller decides, not the mode.
  const assistant = callerOf(ctx) !== "person";
  const fenced = assistant ? fenceStatus(report) : report;
  return renderResult<StatusResult>(assistant ? "read-only" : "read-write", {
    phase: "sampled",
    window,
    verdictsRead: true,
    ledger: ledger.name,
    ...standing,
    ...fenced,
    minProvenance,
    belowMinimum,
    checkpointAdvised,
    requireSigned,
    unsigned,
    verdictNotes,
    ...(perRepo ? { perRepo } : {}),
    ledgerIntegrity,
    ledgerGate: { fails: gate.fails, incompletes: gate.incompletes, warns: gate.warns, shown: shown.map((l) => l.text) },
    certificateWithheld: withheld,
    certificate,
    certified: isCertified(certificate),
    offlineChecks: core.checks.map((c) => ({ n: c.n, name: c.name, status: c.status, summary: c.summary })),
    offlineFails,
    line,
  });
}
