import { recordedBeforeSeed, type Ledger, type ProvenanceLevel } from "../sdk/ledger.js";
import { checkpointRecord, compareWithCheckpoint, type CheckpointArtifact } from "./checkpoint.js";
import { checkpointCoverage, indexBindingFindings, type LedgerIndexDocument } from "./ledger-anchor.js";
import { ledgerPathFindings } from "./ledger-path.js";
import type { ScmProvider } from "../sdk/provider.js";
import type { TrustBundle } from "../timestamp/bundle.js";
import { anchorLines, assessTimestamps, isoMs, notTamperProof, timestampsLine, type TimeEvidenceSummary } from "../timestamp/verify.js";
import { logKeySource } from "../translog/keys.js";
import { verifyLoggedEntry } from "../translog/rekor.js";
import { verifyRekorV2Entry } from "../translog/rekor-v2.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { assemblePopulation, manifestAliases, type Population } from "./population.js";
import { checkPool } from "./rebuild.js";
import { poolRecordProblems } from "./repo-set.js";
import {
  auditMode,
  derivedRoundFor,
  effectiveTime,
  isCommitmentV2,
  isManifestV2,
  isRegistrationV2,
  manifestRepos,
  manifestSha256,
  recordedRegisteredRepos,
  registeredRepos,
  registeredVisibility,
  registrationRepoSet,
  registrationTime,
  type AnyCommitment,
  type AnyManifest,
  type AnyRegistration,
  type AuditMode,
  type DrawsFile,
  type LoggedEntry,
  type PluginIdentity,
  type RegistrationRecordV2,
  type RekorV2Entry,
  type SignedRecord,
} from "./records.js";
import { dropPrefix, foreign, foreignError, said, wordsOf, type Line } from "./said.js";
import { computeDraws, isoToUnix, unixToIso } from "./seed.js";
import { verifySignedRecord } from "./signing.js";
import { effectiveCap } from "./sprt.js";
import { computeStatus, provenanceLine, type StatusReport } from "./status.js";
import { PRESENCE_LIMIT, auditBinding, countedVerdicts, provenanceLabel, rulesLine, signaturesCountFor, verdictRuleFailures, type VerdictRules } from "./presence/provenance.js";

/**
 * INCOMPLETE (U8): no FAIL, but part of what the check covers could not be checked (a repo that could not be rebuilt,
 * completeness that could not be established). The audit is then neither VERIFIED nor FAILED: `verify` exits 6.
 */
export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP" | "INCOMPLETE";

/** VERIFIED: no check FAILed and none is INCOMPLETE. INCOMPLETE: none FAILed, some could not be completed. */
export type VerifyVerdict = "VERIFIED" | "INCOMPLETE" | "FAILED";

export interface VerifyCheck {
  n: number;
  name: string;
  status: CheckStatus;
  /**
   * One-line summary, e.g. "population 1,590/1,590 match". Lines (src/core/said.ts): what a provider, a ledger or a
   * relay said is carried in them as foreign text, and pr-rla/api/read renders them by mode (S1).
   */
  summary: Line;
  details: Line[];
  /** Optional (P3): the per-item lines a summary line in `details` stands for; `verify` prints them with --verbose, and --json has them. */
  verbose?: Line[];
}

export interface VerifyArtifacts {
  registration: SignedRecord<AnyRegistration>;
  manifest: AnyManifest | null;
  commitment: SignedRecord<AnyCommitment> | null;
  draws: DrawsFile | null;
  /** SHA-256 of the protocol file as it is now (null if the file is missing). */
  currentProtocolSha256: string | null;
  /** Ledger checkpoints committed in the audit repo (de-duplicated), with their stored event lists. */
  checkpoints?: CheckpointArtifact[];
  /** Lines of ledger-checkpoints.jsonl that are not checkpoints, or break its hash chain (check 7 FAILs: the file is append-only). */
  checkpointProblems?: string[];
  /** Checkpoint lines with no `prevLineSha256` (written before the chain); shown, not judged. */
  checkpointsUnchained?: number;
  /** The window's ledger-index.json (null when there is none): check 7 compares its hash with the one draws.json bound. */
  ledgerIndex?: LedgerIndexDocument | null;
}

export interface VerifyDeps {
  /** null = offline: check 5 is skipped. */
  provider: ScmProvider | null;
  ledger: Ledger | null;
  /** Why the ledger was not read (an offline verify of a ledger that lives in a tracker); check 7 then SKIPs saying so. */
  ledgerSkipped?: string;
  /**
   * The most the registered ledger's verdicts can count as (U9: `presence` only for git-file, whose
   * verdict signatures pr-rla checks; `account` for the issue ledgers). A verdict claiming more is
   * counted at this level and check 7 WARNs. Absent: no cap.
   */
  provenanceCeiling?: ProvenanceLevel;
  /** The identity of the ledger verify loaded (U9, after review): check 7 FAILs when it is not the registered one. */
  ledgerIdentity?: PluginIdentity;
  /**
   * The ledger is pr-rla's built-in git-file (S1): its integrity findings are pr-rla's own words (commit ids, the
   * registered path, counts). Any other ledger's findings and warnings are its text, quoted as foreign: an issue
   * tracker's label names, a plugin's sentences.
   */
  ledgerFindingsArePrRlas?: boolean;
  /** Returns a VERIFIED beacon for the round, or null if unavailable (not yet published / offline). */
  beacon: (round: number) => Promise<{ round: number; randomness: string; signature: string } | null>;
  /** Trusted public key (PEM) for a log URL: the verifier's --log-key or a key pinned in the package, never the audit repo's; null if none. */
  logKey: (logUrl: string) => Promise<string | null>;
  /** RFC 3161 anchors: the shipped bundle plus any the verifier added with --tsa-trust. Never the audit repo's own. */
  trustBundle: TrustBundle;
  /**
   * What the verifier's provider is (its options hashed as at registration). When given for a v2
   * registration, provider options that change the population must match the registered ones (check 5).
   */
  providerIdentity?: PluginIdentity;
}

export interface VerifyReport {
  checks: VerifyCheck[];
  /** True only when the verdict is VERIFIED: an INCOMPLETE audit is not ok (U8). */
  ok: boolean;
  verdict: VerifyVerdict;
  mode: "PROSPECTIVE" | "RETROSPECTIVE";
  timestampTamperProof: boolean;
  status: StatusReport | null;
  derivedRound: number;
  /** Schema v2: the RFC 3161 evidence for each signed record (null for v1 records). */
  timestamps: { registration: TimeEvidenceSummary | null; commitment: TimeEvidenceSummary | null };
  /** pr-rla releases that wrote the registration and the manifest (null for v1 records, which do not say). */
  versions: { registered: string | null; frozen: string | null };
}

const n = (x: number) => x.toLocaleString("en-US");

/** Adds anchor findings (ledger index binding, checkpoint coverage) to a check: FAIL beats WARN beats whatever it was. */
function addAnchor(c: VerifyCheck, f: { fails: string[]; warns: string[]; notes: string[] }): boolean {
  c.details.push(...f.fails.map((d) => `FAIL ${d}`), ...f.warns.map((d) => `WARN ${d}`), ...f.notes);
  if (f.fails.length) c.status = "FAIL";
  else if (f.warns.length && c.status === "PASS") c.status = "WARN";
  return f.fails.length > 0;
}

/**
 * Checks a record's transparency-log entry. v1 records: the entry is the time evidence.
 * v2 records: a Rekor v1 entry is one more bound (operator Sigstore), a Rekor v2 entry
 * carries no time, and a missing entry is not a warning (tokens are the evidence).
 */
async function checkLog(entry: LoggedEntry | RekorV2Entry | null, signed: SignedRecord<unknown>, what: string, deps: VerifyDeps, c: VerifyCheck, v2: boolean): Promise<{ verified: boolean; integratedTime: number | null }> {
  const none = { verified: false, integratedTime: null };
  if (!entry) {
    if (!v2) {
      c.details.push(`TIMESTAMP NOT TAMPER-PROOF: the ${what} is not in a transparency log; its time is the signer's own clock`);
      if (c.status === "PASS") c.status = "WARN";
    }
    return none;
  }
  const key = await deps.logKey(entry.logUrl);
  if (!key) {
    // An entry under a key the verifier did not choose proves nothing: no time evidence, no operator.
    c.details.push(`${what} log entry unverified: no trusted key for ${entry.logUrl} (pr-rla pins only Sigstore's production logs; a verifier who trusts this log passes its key with --log-key <file>), so its ${"apiVersion" in entry ? "inclusion proof is" : "integratedTime is"} not evidence`);
    if (!v2 && c.status === "PASS") c.status = "WARN";
    return none;
  }
  if ("apiVersion" in entry) {
    const r = verifyRekorV2Entry(entry, signed, key);
    if (!r.ok) {
      c.status = "FAIL";
      c.details.push(...r.problems.map((p) => `${what} Rekor v2 entry: ${p}`));
      return none;
    }
    c.details.push(`${what} in Rekor v2 log ${entry.logUrl} index ${entry.logIndex} (inclusion proof and signed checkpoint verified under ${logKeySource(entry.logUrl, key)}; v2 entries carry no time, and the client is unverified against the production log)`);
    return { verified: true, integratedTime: null };
  }
  const r = verifyLoggedEntry(entry, signed, key);
  if (!r.ok) {
    c.status = "FAIL";
    c.details.push(...r.problems.map((p) => `${what} log entry: ${p}`));
    return none;
  }
  c.details.push(`${what} logged at ${entry.logUrl} index ${entry.logIndex}, integratedTime ${unixToIso(entry.integratedTime)} (SET and inclusion proof verified under ${logKeySource(entry.logUrl, key)})`);
  return { verified: true, integratedTime: entry.integratedTime };
}

/** Rule-checks a v2 record's tokens; any token failing rules 1–7 FAILs the check. */
async function checkTimestamps(signed: SignedRecord<unknown>, signedTimeIso: string, timestamping: RegistrationRecordV2["timestamping"], log: { integratedTime: number | null }, what: string, deps: VerifyDeps, c: VerifyCheck): Promise<TimeEvidenceSummary> {
  const data = new Uint8Array(Buffer.from(canonicalJson(signed.record)));
  const ts = await assessTimestamps({
    timestamps: signed.timestamps ?? [],
    data,
    digestHex: sha256Hex(data),
    signedTimeIso,
    timestamping,
    bundle: deps.trustBundle,
    log: log.integratedTime !== null ? { operator: deps.trustBundle.authorities.sigstore?.operator ?? "Sigstore", integratedTime: log.integratedTime } : null,
  });
  for (const f of ts.failed) {
    c.status = "FAIL";
    c.details.push(`FAIL ${what} token from ${f.tsa}: ${f.problems.join("; ")}`);
  }
  for (const i of ts.ignored) c.details.push(`${what} token from ${i.tsa} ignored (not registered: the registration names ${ts.configured.join(", ") || "no authority"})`);
  if (ts.logProblem) {
    c.status = "FAIL";
    c.details.push(`FAIL ${what} ${ts.logProblem}`);
  }
  c.details.push(`${what} ${timestampsLine(ts)}${ts.ukMs !== null ? ` · existed by ${isoMs(ts.ukMs)} (U_k)` : ""}`);
  for (const l of anchorLines(ts)) c.details.push(`${what} ${l}`);
  if (!ts.proven) {
    c.details.push(`${notTamperProof(ts)}: the ${what}'s time is the signer's own clock${ts.configured.length ? `, bounded by ${ts.operators.length} operator(s) where ${ts.k} are required` : ""}`);
    if (c.status === "PASS") c.status = "WARN";
  }
  return ts;
}

export async function verifyAudit(a: VerifyArtifacts, deps: VerifyDeps): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const reg = a.registration;
  const v2 = isRegistrationV2(reg);
  let mode: AuditMode = auditMode(reg);
  const derived = derivedRoundFor(reg);
  let tamperProof = true;
  let regTs: TimeEvidenceSummary | null = null;
  let cmTs: TimeEvidenceSummary | null = null;

  // 1. Registration exists, is signed and time-stamped (v2: k-of-n tokens; v1: logged); prospective or retrospective.
  const c1: VerifyCheck = { n: 1, name: "registration", status: "PASS", summary: "", details: [] };
  const sig = verifySignedRecord(reg);
  if (!sig.ok) {
    c1.status = "FAIL";
    c1.details.push(`registration signature: ${sig.reason}`);
  }
  const regLog = await checkLog(reg.log, reg, "registration", deps, c1, v2);
  if (v2 && reg.timestamps === undefined) {
    // A v2 record always carries the field (empty when no authority is configured): its absence is tampering, never a fallback to the log (FR1.4).
    c1.status = "FAIL";
    c1.details.push("FAIL registration: a schema-v2 record has no timestamps field (writers always store one); its time evidence was removed");
  }
  if (v2) {
    regTs = await checkTimestamps(reg, reg.record.registeredAt, reg.record.timestamping, regLog, "registration", deps, c1);
    if (!regTs.proven) tamperProof = false;
    else mode = regTs.ukMs! < Date.parse(reg.record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE";
    c1.details.push(`registered with pr-rla ${reg.record.prRlaVersion} · provider ${reg.record.plugins.provider.name} (${reg.record.plugins.provider.source} ${reg.record.plugins.provider.version ?? "?"}) · ledger ${reg.record.plugins.ledger.name} · verdict provenance ${provenanceLabel(reg.record.verdicts.minProvenance)}${reg.record.verdicts.require_signed ? " · signed verdicts required" : ""}`);
  } else if (!regLog.verified) tamperProof = false;
  if (a.currentProtocolSha256 === null) {
    c1.details.push("review protocol file not found: cannot confirm it is the registered one");
    if (c1.status === "PASS") c1.status = "WARN";
  } else if (a.currentProtocolSha256 !== reg.record.protocolSha256) {
    c1.status = "FAIL";
    c1.details.push(`review protocol changed: file hashes ${a.currentProtocolSha256.slice(0, 12)}…, registration says ${reg.record.protocolSha256.slice(0, 12)}…`);
  }
  const rt = registrationTime(reg);
  const unproven = v2 ? (!regTs?.proven ? " (unproven: too few timestamps)" : "") : !regLog.verified ? " (time unproven: no transparency-log entry verified under a trusted key)" : "";
  c1.summary =
    mode === "PROSPECTIVE"
      ? `registered ${rt.iso}${regTs?.ukMs ? `, proven by ${isoMs(regTs.ukMs)}` : ""} before the window opened → PROSPECTIVE${unproven}`
      : `registration ${isoToUnix(reg.record.window.closesAt) <= rt.unix ? "after window close" : "after window opened"} → RETROSPECTIVE (a demonstration)${unproven}`;
  checks.push(c1);

  // 2. Manifest consistent with the registration, committed, and logged before R published.
  const c2: VerifyCheck = { n: 2, name: "manifest before seed", status: "PASS", summary: "", details: [] };
  const m = a.manifest;
  const cm = a.commitment;
  if (!m || !cm) {
    c2.status = "FAIL";
    c2.summary = !m ? "no manifest" : "no manifest commitment";
  } else {
    if (manifestSha256(m) !== m.sha256) c2.details.push("manifest contents do not match its sha256");
    if (m.changes.length !== m.N) c2.details.push(`manifest lists ${m.changes.length} changes but N = ${m.N}`);
    const ids = m.changes.map((x) => x.id);
    if (new Set(ids).size !== ids.length) c2.details.push("manifest lists a change twice");
    if (ids.some((id, i) => i > 0 && ids[i - 1]! >= id)) c2.details.push("manifest changes are not sorted by id");
    if (m.registrationSha256 !== reg.sha256) c2.details.push("manifest names a different registration");
    if (isManifestV2(m) !== v2 || isCommitmentV2(cm) !== v2) c2.details.push("registration, manifest and commitment use different schema versions");
    for (const [k, mine, theirs] of [
      ["selector", m.selector, reg.record.selector],
      ["window", m.window, reg.record.window],
      ["parameters", m.parameters, reg.record.parameters],
      ["protocol", m.protocolSha256, reg.record.protocolSha256],
    ] as const)
      if (canonicalJson(mine) !== canonicalJson(theirs)) c2.details.push(`manifest ${k} differs from the registration`);
    // The repos the manifest covers are the registered ones: the repo, the list (or recorded gone), or inside the rule,
    // every registered repo included, and a listing that agrees with itself (U8, FR5.1/FR5.2; the review's finding 1).
    const mv2 = isManifestV2(m) ? m : null;
    c2.details.push(...poolRecordProblems(registrationRepoSet(reg), { repos: manifestRepos(m), changeRepos: m.changes.map((x) => x.repo), listing: mv2?.repoListing ?? null, gone: mv2?.goneRepos ?? [], registered: isRegistrationV2(reg) ? recordedRegisteredRepos(reg) : [], ...(mv2?.headEvidence ? { headEvidence: mv2.headEvidence } : {}) }));
    const csig = verifySignedRecord(cm);
    if (!csig.ok) c2.details.push(`commitment signature: ${csig.reason}`);
    if (cm.publicKeyPem.trim() !== reg.publicKeyPem.trim()) c2.details.push("commitment is signed by a different key than the registration");
    if (cm.record.manifestSha256 !== m.sha256) c2.details.push("commitment names a different manifest hash");
    if (cm.record.N !== m.N) c2.details.push("commitment names a different N");
    if (cm.record.registrationSha256 !== reg.sha256) c2.details.push("commitment names a different registration");
    if (isCommitmentV2(cm) && cm.timestamps === undefined) c2.details.push("a schema-v2 commitment has no timestamps field (writers always store one); its time evidence was removed");
    if (isoToUnix(m.frozenAt) < isoToUnix(reg.record.window.closesAt)) c2.details.push(`frozen ${m.frozenAt}, before the window closed`);
    // A pooled freeze signs its commitment when it finishes, after the as-of time its manifest records; never before it.
    if (isoToUnix(cm.record.frozenAt) < isoToUnix(m.frozenAt)) c2.details.push(`commitment dated ${cm.record.frozenAt}, before the manifest's as-of time ${m.frozenAt}`);
    if (c2.details.length) c2.status = "FAIL";
    const cmLog = await checkLog(cm.log, cm, "manifest commitment", deps, c2, v2);
    if (v2 && isRegistrationV2(reg)) {
      cmTs = await checkTimestamps(cm, cm.record.frozenAt, reg.record.timestamping, cmLog, "manifest commitment", deps, c2);
      if (!cmTs.proven) tamperProof = false;
      if (isManifestV2(m)) c2.details.push(`frozen with pr-rla ${m.prRlaVersion} · provider ${m.provider.name} (${m.provider.source} ${m.provider.version ?? "?"})`);
    } else if (!cmLog.verified) tamperProof = false;
    const t = effectiveTime(cm, cm.record.frozenAt);
    const bound = cmTs?.ukMs ?? null;
    const late = t.unix >= derived.publishesAt ? t.iso : bound !== null && bound >= derived.publishesAt * 1000 ? isoMs(bound) : null;
    if (late) {
      c2.status = "FAIL";
      c2.details.unshift(`FAIL manifest logged after the seed was public (${late} ≥ round ${derived.round} at ${unixToIso(derived.publishesAt)})`);
      c2.summary = "manifest logged after the seed was public";
    } else if (c2.status === "FAIL") c2.summary = "manifest inconsistent";
    else if (cmTs) c2.summary = cmTs.proven ? `manifest logged by ${cmTs.k} of ${cmTs.operators.length} operators by ${isoMs(bound!)}, before R` : `manifest written (signed time, unproven) ${t.iso}, before R`;
    else c2.summary = `manifest ${t.source === "log" ? (cmLog.verified ? "logged" : "logged (unverified)") : "written (local clock)"} ${t.iso}, before R`;
  }
  checks.push(c2);

  // 3. R is the derived round.
  const c3: VerifyCheck = { n: 3, name: "seed round", status: "PASS", summary: "", details: [] };
  const named = [cm ? ["commitment", cm.record.seedRound] : null, a.draws ? ["draws", a.draws.round] : null].filter(Boolean) as [string, number][];
  for (const [where, r] of named) if (r !== derived.round) c3.details.push(`FAIL seed round ${n(r)} ≠ derived round ${n(derived.round)} (${where})`);
  c3.status = c3.details.length ? "FAIL" : "PASS";
  c3.summary = c3.details.length ? dropPrefix(c3.details[0]!, "FAIL ") : `R = ${n(derived.round)}: first round ≥ 24 h after ${derived.base === "registration" ? "registration" : "window close"}`;
  checks.push(c3);

  // 4. R's BLS signature.
  const c4: VerifyCheck = { n: 4, name: "BLS", status: "PASS", summary: "BLS", details: [] };
  let beacon: { randomness: string } | null = null;
  try {
    beacon = await deps.beacon(derived.round);
    if (!beacon) {
      c4.status = "SKIP";
      c4.summary = `round ${derived.round} not available (not yet published, or offline without it)`;
    } else c4.details.push(`round ${derived.round} randomness ${beacon.randomness.slice(0, 16)}… verified with drand-client against pinned quicknet key`);
  } catch (e) {
    c4.status = "FAIL";
    c4.summary = said`round ${derived.round}: ${foreignError(e, "the beacon relays did not give the round")}`;
  }
  checks.push(c4);

  // 5. Population rebuilt from the SCM with the registered selector, diffed against the manifest.
  const c5: VerifyCheck = { n: 5, name: "population", status: "PASS", summary: "", details: [] };
  if (!m) {
    c5.status = "SKIP";
    c5.summary = "no manifest";
  } else if (!deps.provider) {
    c5.status = "SKIP";
    c5.summary = "offline: population not rebuilt";
  } else {
    const provider = deps.provider;
    const set = registrationRepoSet(reg);
    const mrepos = manifestRepos(m);
    const mv2 = isManifestV2(m) ? m : null;
    // A pool: more than one repo, or a list or rule (which may resolve to one).
    const pooled = set.kind !== "repo" || mrepos.length !== 1;
    // Walk the frozen history (FR7.2) and match renamed accounts by id (FR7.3).
    const aliases = manifestAliases(m.changes);
    const window = reg.record.window;
    const selector = reg.record.selector;
    // Identical options cannot differ in the ones that change the population (a registration made before
    // U3 hashed no population options, so the population hash alone would differ for nothing).
    const registered = v2 ? (reg.record as RegistrationRecordV2).plugins.provider : null;
    const id = deps.providerIdentity;
    if (registered && id && id.optionsSha256 !== registered.optionsSha256 && id.populationOptionsSha256 !== registered.populationOptionsSha256)
      c5.details.push(`FAIL population: provider options that change the population differ from the registration (populationOptionsSha256 ${id.populationOptionsSha256.slice(0, 12)}… ≠ registered ${registered.populationOptionsSha256.slice(0, 12)}…); rebuild with the registered options`);
    // Every repo rebuilt from its frozen head and compared with the window as its current head shows it; the pool held to
    // the rule and the registered repos (src/core/rebuild.ts).
    // P3: each frozen head is held to the push log over the freeze span (the manifest's as-of time until R publishes),
    // and a rule's registered set to what the registering token could see.
    const pool = await checkPool(provider, {
      set,
      registered: registeredRepos(reg),
      mode,
      repos: mrepos.map((r) => ({ ...r, headSha: mv2 ? r.headSha : null })),
      listing: mv2?.repoListing ?? null,
      gone: mv2?.goneRepos ?? [],
      window,
      selector,
      registeredAt: registrationTime(reg).iso,
      ...(set.kind === "rule" ? { registeredVisibility: registeredVisibility(reg) } : {}),
      freezeSpan: { from: m.frozenAt, until: unixToIso(derived.publishesAt) },
    });
    if (pool.verbose.length) c5.verbose = pool.verbose;
    const count = (repo: string) => m.changes.filter((x) => x.repo === repo).length;
    let unverified = 0;
    const unrebuilt = new Set<string>();
    for (const b of pool.rebuilt) {
      for (const r of b.fail) c5.details.push(said`FAIL ${pooled ? `${b.repo}: ` : ""}${r}`);
      if (!b.listed) {
        unrebuilt.add(b.repo);
        unverified += count(b.repo);
      }
      for (const r of b.incomplete) c5.details.push(said`INCOMPLETE ${b.repo}: ${r}${!b.listed ? `: its ${n(count(b.repo))} changes in the manifest were not rebuilt` : ""}`);
      for (const note of b.notes) c5.details.push(note);
    }
    c5.details.push(...pool.lines);
    const listings = pool.rebuilt.filter((b) => b.listed).map((b) => ({ repo: b.repo, listed: b.listed! }));
    let pop: Population;
    try {
      pop = assemblePopulation(provider.name, listings, { window, selector, cutoffIso: m.frozenAt, aliases });
    } catch (e) {
      c5.details.push(said`FAIL population: the rebuilt population is malformed: ${foreignError(e)}`);
      pop = assemblePopulation(provider.name, [], { window, selector, cutoffIso: m.frozenAt, aliases });
    }
    const verifiable = m.changes.filter((x) => !unrebuilt.has(x.repo));
    const mine = new Map(verifiable.map((x) => [x.id, x]));
    const rebuilt = new Map(pop.entries.map((x) => [x.id, x]));
    const missing = [...rebuilt.keys()].filter((id) => !mine.has(id));
    const extra = [...mine.keys()].filter((id) => !rebuilt.has(id));
    const shaDiff = [...mine.keys()].filter((id) => rebuilt.has(id) && rebuilt.get(id)!.mergeSha !== mine.get(id)!.mergeSha);
    const frozen = Date.parse(m.frozenAt);
    const late = pop.listed.changes.filter((x) => mine.has(x.id) && x.reviews.some((r) => Date.parse(r.submittedAt) > frozen));
    if (missing.length) c5.details.push(`FAIL population: ${n(missing.length)} changes on ${provider.name} are missing from the manifest (e.g. ${missing.slice(0, 3).join(", ")})`);
    if (extra.length) c5.details.push(`FAIL population: ${n(extra.length)} changes in the manifest are not in the rebuilt population (e.g. ${extra.slice(0, 3).join(", ")})`);
    if (shaDiff.length) c5.details.push(`FAIL population: ${n(shaDiff.length)} changes have a different merge SHA (e.g. ${shaDiff.slice(0, 3).join(", ")})`);
    if (late.length) c5.details.push(`${n(late.length)} manifest changes received reviews after freeze time (ignored, as of ${m.frozenAt}): ${late.slice(0, 5).map((x) => x.id).join(", ")}`);
    let unpinned = false;
    const done = pool.rebuilt.filter((b) => b.listed);
    if (selector.kinds.includes("direct_push")) {
      const note = "direct pushes dated in the window but pushed after freeze will show as extra";
      const headOf = new Map(mrepos.map((r) => [r.repo, mv2 ? r.headSha : null]));
      if (!pooled) {
        const b = done[0];
        const pinned = headOf.get(mrepos[0]!.repo) ?? null;
        if (b?.history === "unpinned") {
          unpinned = true;
          c5.details.push(`provider ${provider.name} does not pin history (asked for the frozen head ${pinned!.slice(0, 12)}…, ${b.walked ? `walked from ${b.walked.slice(0, 12)}…` : "reported no head"}); ${note}`);
        } else if (b && pinned) c5.details.push(`history walked from the frozen head ${pinned.slice(0, 12)}…`);
        else if (b?.history === "empty") c5.details.push("the repository is empty (no default branch), as the manifest records");
        else if (b && mv2) c5.details.push(`the manifest records no default-branch head: provider ${provider.name} does not pin history; ${note}`);
      } else {
        const notPinned = done.filter((b) => b.history === "unpinned").map((b) => b.repo);
        const noHead = done.filter((b) => b.history === "no-head").map((b) => b.repo);
        const empty = done.filter((b) => b.history === "empty").map((b) => b.repo);
        const pinnedCount = done.filter((b) => b.history === "pinned").length;
        if (notPinned.length) {
          unpinned = true;
          c5.details.push(`provider ${provider.name} does not pin history for ${n(notPinned.length)} repo(s) (e.g. ${notPinned.slice(0, 3).join(", ")}); ${note}`);
        }
        if (noHead.length && mv2) c5.details.push(`the manifest records no default-branch head for ${n(noHead.length)} repo(s) (e.g. ${noHead.slice(0, 3).join(", ")}): provider ${provider.name} does not pin history; ${note}`);
        if (empty.length) c5.details.push(`${n(empty.length)} repo(s) are empty (no default branch), as the manifest records (e.g. ${empty.slice(0, 3).join(", ")})`);
        if (pinnedCount > 0) c5.details.push(`history walked from the frozen heads of ${n(pinnedCount)} repo(s)`);
      }
    }
    const renamed = new Map<string, string>();
    for (const c of pop.listed.changes)
      for (const a of [c.author, ...(c.mergedBy ? [c.mergedBy] : []), ...c.reviews.map((r) => r.author)]) {
        const was = a.id !== undefined ? aliases.get(a.id) : undefined;
        if (was !== undefined && was !== a.login) renamed.set(`${was} → ${a.login}`, a.id!);
      }
    if (renamed.size) c5.details.push(`${n(renamed.size)} account(s) renamed since freeze, matched by account id: ${[...renamed.keys()].slice(0, 5).join(", ")}`);
    const has = (p: string) => c5.details.some((d) => wordsOf(d).startsWith(p));
    c5.status = has("FAIL ") ? "FAIL" : has("INCOMPLETE ") ? "INCOMPLETE" : unpinned || has("WARN ") ? "WARN" : "PASS";
    const others = c5.details.filter((d) => wordsOf(d).startsWith("INCOMPLETE ")).length - pool.rebuilt.filter((b) => !b.listed).reduce((k, b) => k + b.incomplete.length, 0);
    c5.summary =
      c5.status === "FAIL"
        ? dropPrefix(c5.details.find((d) => wordsOf(d).startsWith("FAIL "))!, "FAIL ")
        : `population ${n(pop.entries.length)}/${n(verifiable.length)} match${unverified || unrebuilt.size ? ` · ${n(unverified)} changes in ${n(unrebuilt.size)} repo(s) could not be rebuilt` : ""}${others > 0 ? ` · completeness not established (${n(others)} reason(s) below)` : ""}`;
  }
  checks.push(c5);

  // 6. Every draw recomputed.
  const c6: VerifyCheck = { n: 6, name: "draws", status: "PASS", summary: "", details: [] };
  let recomputed: { draw: number; index: number; changeId: string; url: string }[] | null = null;
  if (!a.draws) {
    c6.status = "SKIP";
    c6.summary = "not sampled yet";
  } else if (!m || !beacon) {
    c6.status = "SKIP";
    c6.summary = "needs the manifest and round R";
  } else {
    const cap = effectiveCap(reg.record.parameters);
    recomputed = computeDraws(beacon.randomness, m.sha256, m.N, cap).map((d) => ({ ...d, changeId: m.changes[d.index]!.id, url: m.changes[d.index]!.url }));
    if (a.draws.manifestSha256 !== m.sha256) c6.details.push("draws file names a different manifest");
    if (a.draws.N !== m.N) c6.details.push("draws file names a different N");
    const bad = a.draws.draws.filter((d) => {
      const r = recomputed![d.draw - 1];
      return !r || r.index !== d.index || r.changeId !== d.changeId;
    });
    for (const d of bad.slice(0, 5)) c6.details.push(`draw #${d.draw}: file says ${d.changeId}, recomputed ${recomputed[d.draw - 1]?.changeId ?? "(beyond cap)"}`);
    if (a.draws.issued > cap) c6.details.push(`draws file issues ${a.draws.issued} > cap ${cap}`);
    c6.status = c6.details.length ? "FAIL" : "PASS";
    c6.summary = c6.status === "PASS" ? `${a.draws.issued}/${a.draws.issued} draws reproduce` : `${bad.length} draws do not reproduce`;
  }
  checks.push(c6);

  // 7. Label (verdict) events of the counted prefix.
  const c7: VerifyCheck = { n: 7, name: "labels", status: "PASS", summary: "labels", details: [] };
  let status: StatusReport | null = null;
  if (!recomputed || !a.draws || !m || !deps.ledger) {
    c7.status = "SKIP";
    c7.summary = !deps.ledger && deps.ledgerSkipped ? deps.ledgerSkipped : "no verified draws to check labels against";
    // The index file is local: its hash is checked even when the tracker is not read.
    if (a.draws && a.ledgerIndex !== undefined) {
      if (addAnchor(c7, indexBindingFindings(a.draws, a.ledgerIndex))) c7.summary = "labels FAIL";
    }
  } else {
    // A ledger that cannot be read FAILs check 7 with the error; it never passes silently (contracts.md §1).
    const ledger = deps.ledger;
    const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (e) {
        c7.status = "FAIL";
        c7.details.push(said`ledger ${ledger.name}: ${what} failed: ${foreignError(e)}`);
        return null;
      }
    };
    let lastCountedAt: string | null = null;
    const read = await attempt("readVerdicts", () => ledger.readVerdicts());
    const regVerdicts = isRegistrationV2(reg) ? reg.record.verdicts : null;
    const rules: VerdictRules = { minProvenance: regVerdicts?.minProvenance ?? "self-asserted", requireSigned: regVerdicts?.require_signed === true };
    // U9: the ledger read must be the registered one (name, source, files, options), or nothing it says counts as registered.
    const registeredLedger = isRegistrationV2(reg) ? reg.record.plugins.ledger : null;
    const loadedId = deps.ledgerIdentity;
    const idDiffs = registeredLedger && loadedId ? (["name", "source", "integrity", "optionsSha256"] as const).filter((k) => registeredLedger[k] !== loadedId[k]) : [];
    if (idDiffs.length) {
      const show = (v: string | null) => (v === null ? "none" : /^[0-9a-f]{64}$/.test(v) ? `${v.slice(0, 12)}…` : v);
      c7.status = "FAIL";
      c7.details.push(`FAIL the ledger verify loaded is not the registered one (${idDiffs.map((k) => `${k} ${show(registeredLedger![k])} → ${show(loadedId![k])}`).join("; ")}): verify with the registered ledger and options`);
    }
    if (rules.requireSigned && registeredLedger && !signaturesCountFor(registeredLedger)) {
      c7.status = "FAIL";
      c7.details.push(`FAIL require_signed needs the built-in git-file ledger, but the registration names ledger ${registeredLedger.name} (${registeredLedger.source})`);
    }
    // Verdict signatures count only in the registered built-in git-file ledger, read as registered; nothing counts above the registered ledger's ceiling.
    const verifiesSignatures = ledger.name === "git-file" && !idDiffs.length && (registeredLedger ? signaturesCountFor(registeredLedger) : false);
    // P4: each verdict signature must be made for this audit as verified above: the registration, the manifest (check 2) and the seed (check 4).
    const binding = auditBinding(reg.sha256, m.sha256, { round: derived.round, randomness: beacon!.randomness });
    const counted = read ? countedVerdicts(read, { registration: reg, binding, verifiesSignatures, ...(deps.provenanceCeiling ? { ceiling: deps.provenanceCeiling } : {}), ledger: ledger.name }) : null;
    const verdicts = counted?.verdicts ?? null;
    if (counted) {
      c7.details.push(...counted.notes, ...counted.findings, ...counted.warnings);
      if ((counted.notes.length || counted.warnings.length) && c7.status === "PASS") c7.status = "WARN";
    }
    if (verdicts) {
      status = computeStatus({
        N: m.N,
        minPopulation: reg.record.parameters.minPopulation,
        draws: recomputed,
        drawsIssued: a.draws.issued,
        verdicts,
        protocolSha256: reg.record.protocolSha256,
        params: reg.record.parameters,
        reviewers: regVerdicts?.reviewers ?? null,
        ineligible: counted!.ineligible,
      });
      const countedIds = new Set(recomputed.slice(0, status.sequence.draws).map((d) => d.changeId));
      const firstFor = new Map(status.firstVerdicts.map((v) => [v.changeId, v]));
      lastCountedAt = [...countedIds].map((id) => firstFor.get(id)?.recordedAt).filter((t): t is string => !!t).sort((x, y) => Date.parse(x) - Date.parse(y)).at(-1) ?? null;
      for (const id of countedIds) {
        const v = firstFor.get(id);
        if (v && recordedBeforeSeed(v.recordedAt, derived.publishesAt)) {
          c7.status = "FAIL";
          c7.details.push(`verdict on draw #${v.draw} (${id}) recorded ${v.recordedAt}, before the seed was public`);
        }
        // FR3.8, FR9.4: a counted verdict below the registered minimum provenance FAILs; FR9.1: so does one
        // its registered reviewer did not sign, under require_signed.
        for (const failure of v ? verdictRuleFailures(v, rules) : []) {
          c7.status = "FAIL";
          c7.details.push(failure);
        }
      }
      c7.details.push(`${provenanceLine(status.provenance)} (${rulesLine(rules)})`);
      if (rules.minProvenance === "presence" || status.provenance.some((p) => p.level === "presence")) c7.details.push(PRESENCE_LIMIT);
      for (const i of status.ignored) c7.details.push(said`ignored verdict on draw #${i.event.draw}: ${i.reason}`);
      for (const r of status.relabels) c7.details.push(`relabel: ${r.changeId} first ${r.first.verdict} (counts), later ${r.later.verdict}`);
      if (status.ignored.length || status.relabels.length) if (c7.status === "PASS") c7.status = "WARN";
    }
    if (ledger.verifyIntegrity) {
      const integ = await attempt("verifyIntegrity", () => ledger.verifyIntegrity!());
      if (integ) {
        // What a ledger reports about its own integrity is the ledger's text (S1): its status decides, its words are quoted.
        const ours = deps.ledgerFindingsArePrRlas === true;
        c7.details.push(...integ.findings.map((f) => (ours ? f : said`${foreign("the ledger's integrity finding", f)}`)), ...(integ.warnings ?? []).map((w) => (ours ? w : said`${foreign("the ledger's integrity warning", w)}`)));
        if (!integ.ok) c7.status = "FAIL";
        else if ((!integ.tamperTrail || integ.warnings?.length) && c7.status === "PASS") c7.status = "WARN";
        // P4: the git-file ledger walked must be at the path the registration records.
        if (ledger.name === "git-file") addAnchor(c7, ledgerPathFindings(reg, integ.location));
      }
    } else {
      c7.details.push(`ledger ${ledger.name} has no integrity check`);
      if (c7.status === "PASS") c7.status = "WARN";
    }
    const checkpoints = a.checkpoints ?? [];
    const stampedBy = new Map<CheckpointArtifact, boolean>();
    for (const p of a.checkpointProblems ?? []) {
      c7.status = "FAIL";
      c7.details.push(`FAIL checkpoint file: ${p}`);
    }
    if (checkpoints.length && !ledger.readHistory) {
      c7.details.push(`${checkpoints.length} ledger checkpoint(s) in the audit repo, but ledger ${ledger.name} has no readHistory: they cannot be compared`);
      if (c7.status === "PASS") c7.status = "WARN";
    } else if (checkpoints.length) {
      const current = await attempt("readHistory", () => ledger.readHistory!());
      if (current) {
        for (const cp of checkpoints) {
          const problems = compareWithCheckpoint(cp, current, status?.firstVerdicts ?? []);
          if (problems.length) {
            c7.status = "FAIL";
            c7.details.push(...problems.map((p) => said`FAIL ${p}`));
          }
          if (!problems.length) c7.details.push(`checkpoint ${cp.line.takenAt}: ${cp.line.count} events, all still present`);
          // Its tokens bound when the history existed; one failing rules 1–7 FAILs, too few WARN.
          if (cp.line.timestamps.length && isRegistrationV2(reg)) {
            const ts = await checkTimestamps({ record: checkpointRecord(cp.line), timestamps: cp.line.timestamps } as SignedRecord<unknown>, cp.line.takenAt, reg.record.timestamping, { integratedTime: null }, `checkpoint ${cp.line.takenAt}`, deps, c7);
            // Coverage counts only what the trusted-time rules count: ignored (unregistered) or failing tokens time-stamp nothing.
            stampedBy.set(cp, ts.counted.length > 0);
          }
        }
      }
    }
    if (a.ledgerIndex !== undefined) addAnchor(c7, indexBindingFindings(a.draws, a.ledgerIndex));
    addAnchor(c7, checkpointCoverage(checkpoints, { checkpointable: !!ledger.readHistory, lastCountedAt, ledgerIndexSha256: a.ledgerIndex?.sha256 ?? null, unchained: a.checkpointsUnchained ?? 0, timeStamped: (cp) => stampedBy.get(cp) ?? cp.line.timestamps.length > 0 }));
    c7.summary = c7.status === "FAIL" ? "labels FAIL" : `labels (prefix ${status?.labelledPrefix ?? 0}, ${verdicts?.length ?? 0} events)`;
  }
  checks.push(c7);

  const verdict: VerifyVerdict = checks.some((c) => c.status === "FAIL") ? "FAILED" : checks.some((c) => c.status === "INCOMPLETE") ? "INCOMPLETE" : "VERIFIED";
  return {
    checks,
    ok: verdict === "VERIFIED",
    verdict,
    mode,
    timestampTamperProof: tamperProof,
    status,
    derivedRound: derived.round,
    timestamps: { registration: regTs, commitment: cmTs },
    versions: { registered: isRegistrationV2(reg) ? reg.record.prRlaVersion : null, frozen: m && isManifestV2(m) ? m.prRlaVersion : null },
  };
}
