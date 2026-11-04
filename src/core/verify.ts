import { provenanceRank, type Ledger, type ProvenanceLevel } from "../sdk/ledger.js";
import { checkpointRecord, compareWithCheckpoint, type CheckpointArtifact } from "./checkpoint.js";
import type { ScmProvider } from "../sdk/provider.js";
import type { TrustBundle } from "../timestamp/bundle.js";
import { assessTimestamps, isoMs, notTamperProof, timestampsLine, type TimeEvidenceSummary } from "../timestamp/verify.js";
import { verifyLoggedEntry } from "../translog/rekor.js";
import { verifyRekorV2Entry } from "../translog/rekor-v2.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { buildPooledPopulation, buildPopulation, checkListed, listRepoChanges, manifestAliases, type Population } from "./population.js";
import { manifestRepoProblems, resolveRepoSet } from "./repo-set.js";
import { isRepoUnavailable } from "../sdk/provider.js";
import {
  auditMode,
  derivedRoundFor,
  effectiveTime,
  isCommitmentV2,
  isManifestV2,
  isRegistrationV2,
  manifestRepos,
  manifestSha256,
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
import { computeDraws, isoToUnix, unixToIso } from "./seed.js";
import { verifySignedRecord } from "./signing.js";
import { effectiveCap } from "./sprt.js";
import { computeStatus, provenanceLine, provenanceOf, type StatusReport } from "./status.js";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface VerifyCheck {
  n: number;
  name: string;
  status: CheckStatus;
  /** One-line summary, e.g. "population 1,590/1,590 match". */
  summary: string;
  details: string[];
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
  /** Lines of ledger-checkpoints.jsonl that are not checkpoints (check 7 FAILs: the file is append-only). */
  checkpointProblems?: string[];
}

export interface VerifyDeps {
  /** null = offline: check 5 is skipped. */
  provider: ScmProvider | null;
  ledger: Ledger | null;
  /** Why the ledger was not read (an offline verify of a ledger that lives in a tracker); check 7 then SKIPs saying so. */
  ledgerSkipped?: string;
  /** Returns a VERIFIED beacon for the round, or null if unavailable (not yet published / offline). */
  beacon: (round: number) => Promise<{ round: number; randomness: string; signature: string } | null>;
  /** Trusted public key (PEM) for a log URL, or null if none is available. */
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
  ok: boolean;
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
    c.details.push(`${what} log entry present but no trusted key for ${entry.logUrl} (offline): ${"apiVersion" in entry ? "inclusion proof not checked" : "integratedTime not checked"}`);
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
    c.details.push(`${what} in Rekor v2 log ${entry.logUrl} index ${entry.logIndex} (inclusion proof and signed checkpoint verified; v2 entries carry no time, and the client is unverified against the production log)`);
    return { verified: true, integratedTime: null };
  }
  const r = verifyLoggedEntry(entry, signed, key);
  if (!r.ok) {
    c.status = "FAIL";
    c.details.push(...r.problems.map((p) => `${what} log entry: ${p}`));
    return none;
  }
  c.details.push(`${what} logged at ${entry.logUrl} index ${entry.logIndex}, integratedTime ${unixToIso(entry.integratedTime)} (SET and inclusion proof verified)`);
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
  if (ts.logProblem) {
    c.status = "FAIL";
    c.details.push(`FAIL ${what} ${ts.logProblem}`);
  }
  c.details.push(`${what} ${timestampsLine(ts)}${ts.ukMs !== null ? ` · existed by ${isoMs(ts.ukMs)} (U_k)` : ""}`);
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
  if (v2) {
    regTs = await checkTimestamps(reg, reg.record.registeredAt, reg.record.timestamping, regLog, "registration", deps, c1);
    if (!regTs.proven) tamperProof = false;
    else mode = regTs.ukMs! < Date.parse(reg.record.window.opensAt) ? "PROSPECTIVE" : "RETROSPECTIVE";
    c1.details.push(`registered with pr-rla ${reg.record.prRlaVersion} · provider ${reg.record.plugins.provider.name} (${reg.record.plugins.provider.source} ${reg.record.plugins.provider.version ?? "?"}) · ledger ${reg.record.plugins.ledger.name} · verdict provenance ${reg.record.verdicts.minProvenance}`);
  } else if (!regLog.verified) tamperProof = false;
  if (a.currentProtocolSha256 === null) {
    c1.details.push("review protocol file not found: cannot confirm it is the registered one");
    if (c1.status === "PASS") c1.status = "WARN";
  } else if (a.currentProtocolSha256 !== reg.record.protocolSha256) {
    c1.status = "FAIL";
    c1.details.push(`review protocol changed: file hashes ${a.currentProtocolSha256.slice(0, 12)}…, registration says ${reg.record.protocolSha256.slice(0, 12)}…`);
  }
  const rt = registrationTime(reg);
  const unproven = v2 && !regTs?.proven ? " (unproven: too few timestamps)" : "";
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
    // The repos the manifest covers are the registered ones: the repo, the list, or inside the rule (U8, FR5.1/FR5.2).
    c2.details.push(...manifestRepoProblems(registrationRepoSet(reg), manifestRepos(m).map((r) => r.repo), m.changes.map((x) => x.repo)));
    const csig = verifySignedRecord(cm);
    if (!csig.ok) c2.details.push(`commitment signature: ${csig.reason}`);
    if (cm.publicKeyPem.trim() !== reg.publicKeyPem.trim()) c2.details.push("commitment is signed by a different key than the registration");
    if (cm.record.manifestSha256 !== m.sha256) c2.details.push("commitment names a different manifest hash");
    if (cm.record.N !== m.N) c2.details.push("commitment names a different N");
    if (cm.record.registrationSha256 !== reg.sha256) c2.details.push("commitment names a different registration");
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
    else c2.summary = `manifest ${t.source === "log" ? "logged" : "written (local clock)"} ${t.iso}, before R`;
  }
  checks.push(c2);

  // 3. R is the derived round.
  const c3: VerifyCheck = { n: 3, name: "seed round", status: "PASS", summary: "", details: [] };
  const named = [cm ? ["commitment", cm.record.seedRound] : null, a.draws ? ["draws", a.draws.round] : null].filter(Boolean) as [string, number][];
  for (const [where, r] of named) if (r !== derived.round) c3.details.push(`FAIL seed round ${n(r)} ≠ derived round ${n(derived.round)} (${where})`);
  c3.status = c3.details.length ? "FAIL" : "PASS";
  c3.summary = c3.details.length ? c3.details[0]!.replace(/^FAIL /, "") : `R = ${n(derived.round)}: first round ≥ 24 h after ${derived.base === "registration" ? "registration" : "window close"}`;
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
    c4.summary = `round ${derived.round}: ${(e as Error).message}`;
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
    // A pool: more than one repo, or a list or rule (which may resolve to one). Gone repos are tolerated only there.
    const pooled = set.kind !== "repo" || mrepos.length !== 1;
    const headOf = new Map(mrepos.map((r) => [r.repo, isManifestV2(m) ? r.headSha : null]));
    // Walk the frozen history (FR7.2) and match renamed accounts by id (FR7.3).
    const aliases = manifestAliases(m.changes);
    const window = reg.record.window;
    const selector = reg.record.selector;
    let pop: Population;
    let unavailable: { repo: string; error: Error }[] = [];
    if (pooled) {
      const built = await buildPooledPopulation(provider, { repos: mrepos.map((r) => ({ repo: r.repo, ...(headOf.get(r.repo) ? { head: headOf.get(r.repo)! } : {}) })), window, selector, cutoffIso: m.frozenAt, aliases, tolerateUnavailable: true });
      pop = built;
      unavailable = built.unavailable;
    } else {
      const pinned = headOf.get(mrepos[0]!.repo) ?? null;
      pop = await buildPopulation(provider, { repo: set.kind === "repo" ? set.repo : mrepos[0]!.repo, window, selector, cutoffIso: m.frozenAt, ...(pinned ? { head: pinned } : {}), aliases });
    }
    // Identical options cannot differ in the ones that change the population (a registration made before
    // U3 hashed no population options, so the population hash alone would differ for nothing).
    const registered = v2 ? (reg.record as RegistrationRecordV2).plugins.provider : null;
    const id = deps.providerIdentity;
    if (registered && id && id.optionsSha256 !== registered.optionsSha256 && id.populationOptionsSha256 !== registered.populationOptionsSha256)
      c5.details.push(`FAIL population: provider options that change the population differ from the registration (populationOptionsSha256 ${id.populationOptionsSha256.slice(0, 12)}… ≠ registered ${registered.populationOptionsSha256.slice(0, 12)}…); rebuild with the registered options`);
    // Repos the verifier cannot read (deleted, or not visible to its token): their changes cannot be rebuilt (FR5.2; draft 05 §U8).
    const goneRepos = new Set(unavailable.map((u) => u.repo));
    const verifiable = m.changes.filter((x) => !goneRepos.has(x.repo));
    let unverified = 0;
    for (const u of unavailable) {
      const count = m.changes.filter((x) => x.repo === u.repo).length;
      unverified += count;
      const status = (u.error as { status?: unknown }).status;
      c5.details.push(`WARN cannot rebuild ${u.repo} (${typeof status === "number" ? status : "404/403"}): its ${n(count)} changes are unverified`);
    }
    // A repo the rule matches now but the manifest does not list (created or made visible after freeze) FAILs, unless it
    // has no change in the window at all (its first commit came after the window closed), so it cannot change the population.
    let warned = unavailable.length > 0;
    if (set.kind === "rule") {
      let current: Awaited<ReturnType<typeof resolveRepoSet>> | null = null;
      try {
        current = await resolveRepoSet(provider, set);
      } catch (e) {
        warned = true;
        c5.details.push(`WARN cannot re-resolve the registered rule (${(e as Error).message}): repos added after freeze would not be seen`);
      }
      const have = new Set(mrepos.map((r) => r.repo.toLowerCase()));
      for (const added of (current ?? []).filter((r) => !have.has(r.repo.toLowerCase()))) {
        try {
          const listed = await listRepoChanges(provider, { repo: added.repo, window, selector });
          checkListed(provider.name, listed, { repo: added.repo, window, selector });
          if (listed.changes.length > 0) c5.details.push(`FAIL repo ${added.repo} matches the registered rule but is not in the manifest (${n(listed.changes.length)} changes landed in the window)`);
          else c5.details.push(`repo ${added.repo} matches the registered rule but is not in the manifest; it has no change in the window (its first commit is after the window closed), so it cannot change the population`);
        } catch (e) {
          if (!isRepoUnavailable(e)) throw e;
          warned = true;
          c5.details.push(`WARN repo ${added.repo} matches the registered rule but is not in the manifest, and cannot be read (${(e as { status?: unknown }).status ?? "404/403"}): whether it holds changes in the window is unverified`);
        }
      }
    }
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
    if (selector.kinds.includes("direct_push")) {
      const note = "direct pushes dated in the window but pushed after freeze will show as extra";
      if (!pooled) {
        const pinned = headOf.get(mrepos[0]!.repo) ?? null;
        if (pinned && pop.headSha !== pinned) {
          unpinned = true;
          c5.details.push(`provider ${provider.name} does not pin history (asked for the frozen head ${pinned.slice(0, 12)}…, ${pop.headSha ? `walked from ${pop.headSha.slice(0, 12)}…` : "reported no head"}); ${note}`);
        } else if (pinned) c5.details.push(`history walked from the frozen head ${pinned.slice(0, 12)}…`);
        else if (isManifestV2(m)) c5.details.push(`the manifest records no default-branch head: provider ${provider.name} does not pin history; ${note}`);
      } else {
        const walked = new Map(pop.repos.map((r) => [r.repo, r.headSha]));
        const notPinned = mrepos.filter((r) => !goneRepos.has(r.repo) && headOf.get(r.repo) && walked.get(r.repo) !== headOf.get(r.repo)).map((r) => r.repo);
        const noHead = mrepos.filter((r) => !goneRepos.has(r.repo) && !headOf.get(r.repo)).map((r) => r.repo);
        const pinnedCount = mrepos.length - goneRepos.size - notPinned.length - noHead.length;
        if (notPinned.length) {
          unpinned = true;
          c5.details.push(`provider ${provider.name} does not pin history for ${n(notPinned.length)} repo(s) (e.g. ${notPinned.slice(0, 3).join(", ")}); ${note}`);
        }
        if (noHead.length && isManifestV2(m)) c5.details.push(`the manifest records no default-branch head for ${n(noHead.length)} repo(s) (e.g. ${noHead.slice(0, 3).join(", ")}): provider ${provider.name} does not pin history; ${note}`);
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
    c5.status = c5.details.some((d) => d.startsWith("FAIL ")) ? "FAIL" : unpinned || warned ? "WARN" : "PASS";
    c5.summary =
      c5.status === "FAIL"
        ? c5.details.find((d) => d.startsWith("FAIL "))!.replace(/^FAIL /, "")
        : unverified
          ? `population ${n(pop.entries.length)}/${n(verifiable.length)} match · ${n(unverified)} changes in ${n(unavailable.length)} repo(s) could not be rebuilt`
          : `population ${n(pop.entries.length)}/${n(m.N)} match`;
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
  } else {
    // A ledger that cannot be read FAILs check 7 with the error; it never passes silently (contracts.md §1).
    const ledger = deps.ledger;
    const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (e) {
        c7.status = "FAIL";
        c7.details.push(`ledger ${ledger.name}: ${what} failed: ${(e as Error).message}`);
        return null;
      }
    };
    const verdicts = await attempt("readVerdicts", () => ledger.readVerdicts());
    const regVerdicts = isRegistrationV2(reg) ? reg.record.verdicts : null;
    const minProvenance: ProvenanceLevel = regVerdicts?.minProvenance ?? "self-asserted";
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
      });
      const countedIds = new Set(recomputed.slice(0, status.sequence.draws).map((d) => d.changeId));
      const firstFor = new Map(status.firstVerdicts.map((v) => [v.changeId, v]));
      for (const id of countedIds) {
        const v = firstFor.get(id);
        if (v && Date.parse(v.recordedAt) / 1000 < derived.publishesAt) {
          c7.status = "FAIL";
          c7.details.push(`verdict on draw #${v.draw} (${id}) recorded ${v.recordedAt}, before the seed was public`);
        }
        // FR3.8: a counted verdict below the registered minimum provenance FAILs.
        if (v && provenanceRank(provenanceOf(v)) < provenanceRank(minProvenance)) {
          c7.status = "FAIL";
          c7.details.push(`verdict on draw #${v.draw} (${id}) is ${provenanceOf(v)}; the registration requires ${minProvenance}`);
        }
      }
      c7.details.push(`${provenanceLine(status.provenance)} (registered minimum: ${minProvenance})`);
      for (const i of status.ignored) c7.details.push(`ignored verdict on draw #${i.event.draw}: ${i.reason}`);
      for (const r of status.relabels) c7.details.push(`relabel: ${r.changeId} first ${r.first.verdict} (counts), later ${r.later.verdict}`);
      if (status.ignored.length || status.relabels.length) if (c7.status === "PASS") c7.status = "WARN";
    }
    if (ledger.verifyIntegrity) {
      const integ = await attempt("verifyIntegrity", () => ledger.verifyIntegrity!());
      if (integ) {
        c7.details.push(...integ.findings, ...(integ.warnings ?? []));
        if (!integ.ok) c7.status = "FAIL";
        else if ((!integ.tamperTrail || integ.warnings?.length) && c7.status === "PASS") c7.status = "WARN";
      }
    } else {
      c7.details.push(`ledger ${ledger.name} has no integrity check`);
      if (c7.status === "PASS") c7.status = "WARN";
    }
    const checkpoints = a.checkpoints ?? [];
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
            c7.details.push(...problems.map((p) => `FAIL ${p}`));
          }
          if (!problems.length) c7.details.push(`checkpoint ${cp.line.takenAt}: ${cp.line.count} events, all still present`);
          // Its tokens bound when the history existed; one failing rules 1–7 FAILs, too few WARN.
          if (cp.line.timestamps.length && isRegistrationV2(reg))
            await checkTimestamps({ record: checkpointRecord(cp.line), timestamps: cp.line.timestamps } as SignedRecord<unknown>, cp.line.takenAt, reg.record.timestamping, { integratedTime: null }, `checkpoint ${cp.line.takenAt}`, deps, c7);
        }
      }
    }
    c7.summary = c7.status === "FAIL" ? "labels FAIL" : `labels (prefix ${status?.labelledPrefix ?? 0}, ${verdicts?.length ?? 0} events)`;
  }
  checks.push(c7);

  return {
    checks,
    ok: !checks.some((c) => c.status === "FAIL"),
    mode,
    timestampTamperProof: tamperProof,
    status,
    derivedRound: derived.round,
    timestamps: { registration: regTs, commitment: cmTs },
    versions: { registered: isRegistrationV2(reg) ? reg.record.prRlaVersion : null, frozen: m && isManifestV2(m) ? m.prRlaVersion : null },
  };
}
