import type { Ledger } from "../sdk/ledger.js";
import type { ScmProvider } from "../sdk/provider.js";
import { canonicalJson } from "./canonical.js";
import { buildPopulation } from "./population.js";
import {
  auditMode,
  derivedRoundFor,
  effectiveTime,
  manifestSha256,
  registrationTime,
  type DrawsFile,
  type LoggedEntry,
  type Manifest,
  type ManifestCommitmentRecord,
  type RegistrationRecord,
  type SignedRecord,
} from "./records.js";
import { computeDraws, isoToUnix, unixToIso } from "./seed.js";
import { verifySignedRecord } from "./signing.js";
import { effectiveCap } from "./sprt.js";
import { computeStatus, type StatusReport } from "./status.js";
import { verifyLoggedEntry } from "../translog/rekor.js";

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
  registration: SignedRecord<RegistrationRecord>;
  manifest: Manifest | null;
  commitment: SignedRecord<ManifestCommitmentRecord> | null;
  draws: DrawsFile | null;
  /** SHA-256 of the protocol file as it is now (null if the file is missing). */
  currentProtocolSha256: string | null;
}

export interface VerifyDeps {
  /** null = offline: check 5 is skipped. */
  provider: ScmProvider | null;
  ledger: Ledger | null;
  /** Returns a VERIFIED beacon for the round, or null if unavailable (not yet published / offline). */
  beacon: (round: number) => Promise<{ round: number; randomness: string; signature: string } | null>;
  /** Trusted public key (PEM) for a log URL, or null if none is available. */
  logKey: (logUrl: string) => Promise<string | null>;
}

export interface VerifyReport {
  checks: VerifyCheck[];
  ok: boolean;
  mode: "PROSPECTIVE" | "RETROSPECTIVE";
  timestampTamperProof: boolean;
  status: StatusReport | null;
  derivedRound: number;
}

const n = (x: number) => x.toLocaleString("en-US");

async function checkLog(entry: LoggedEntry | null, signed: SignedRecord<unknown>, what: string, deps: VerifyDeps, c: VerifyCheck): Promise<boolean> {
  if (!entry) {
    c.details.push(`TIMESTAMP NOT TAMPER-PROOF: the ${what} is not in a transparency log; its time is the signer's own clock`);
    if (c.status === "PASS") c.status = "WARN";
    return false;
  }
  const key = await deps.logKey(entry.logUrl);
  if (!key) {
    c.details.push(`${what} log entry present but no trusted key for ${entry.logUrl} (offline): integratedTime not checked`);
    if (c.status === "PASS") c.status = "WARN";
    return false;
  }
  const r = verifyLoggedEntry(entry, signed, key);
  if (!r.ok) {
    c.status = "FAIL";
    c.details.push(...r.problems.map((p) => `${what} log entry: ${p}`));
    return false;
  }
  c.details.push(`${what} logged at ${entry.logUrl} index ${entry.logIndex}, integratedTime ${unixToIso(entry.integratedTime)} (SET and inclusion proof verified)`);
  return true;
}

export async function verifyAudit(a: VerifyArtifacts, deps: VerifyDeps): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const reg = a.registration;
  const mode = auditMode(reg);
  const derived = derivedRoundFor(reg);
  let tamperProof = true;

  // 1. Registration exists, is signed, (ideally) logged; prospective or retrospective.
  const c1: VerifyCheck = { n: 1, name: "registration", status: "PASS", summary: "", details: [] };
  const sig = verifySignedRecord(reg);
  if (!sig.ok) {
    c1.status = "FAIL";
    c1.details.push(`registration signature: ${sig.reason}`);
  }
  if (!(await checkLog(reg.log, reg, "registration", deps, c1))) tamperProof = false;
  if (a.currentProtocolSha256 === null) {
    c1.details.push("review protocol file not found: cannot confirm it is the registered one");
    if (c1.status === "PASS") c1.status = "WARN";
  } else if (a.currentProtocolSha256 !== reg.record.protocolSha256) {
    c1.status = "FAIL";
    c1.details.push(`review protocol changed: file hashes ${a.currentProtocolSha256.slice(0, 12)}…, registration says ${reg.record.protocolSha256.slice(0, 12)}…`);
  }
  const rt = registrationTime(reg);
  c1.summary =
    mode === "PROSPECTIVE"
      ? `registered ${rt.iso} before the window opened → PROSPECTIVE`
      : `registration ${isoToUnix(reg.record.window.closesAt) <= rt.unix ? "after window close" : "after window opened"} → RETROSPECTIVE (a demonstration)`;
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
    for (const [k, mine, theirs] of [
      ["selector", m.selector, reg.record.selector],
      ["window", m.window, reg.record.window],
      ["parameters", m.parameters, reg.record.parameters],
      ["protocol", m.protocolSha256, reg.record.protocolSha256],
      ["repo", m.repo, reg.record.repo],
    ] as const)
      if (canonicalJson(mine) !== canonicalJson(theirs)) c2.details.push(`manifest ${k} differs from the registration`);
    const csig = verifySignedRecord(cm);
    if (!csig.ok) c2.details.push(`commitment signature: ${csig.reason}`);
    if (cm.publicKeyPem.trim() !== reg.publicKeyPem.trim()) c2.details.push("commitment is signed by a different key than the registration");
    if (cm.record.manifestSha256 !== m.sha256) c2.details.push("commitment names a different manifest hash");
    if (cm.record.N !== m.N) c2.details.push("commitment names a different N");
    if (cm.record.registrationSha256 !== reg.sha256) c2.details.push("commitment names a different registration");
    if (isoToUnix(m.frozenAt) < isoToUnix(reg.record.window.closesAt)) c2.details.push(`frozen ${m.frozenAt}, before the window closed`);
    if (c2.details.length) c2.status = "FAIL";
    if (!(await checkLog(cm.log, cm, "manifest commitment", deps, c2))) tamperProof = false;
    const t = effectiveTime(cm, cm.record.frozenAt);
    if (t.unix >= derived.publishesAt) {
      c2.status = "FAIL";
      c2.details.unshift(`FAIL manifest logged after the seed was public (${t.iso} ≥ round ${derived.round} at ${unixToIso(derived.publishesAt)})`);
      c2.summary = "manifest logged after the seed was public";
    } else c2.summary = c2.status === "FAIL" ? "manifest inconsistent" : `manifest ${t.source === "log" ? "logged" : "written (local clock)"} ${t.iso}, before R`;
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
    const pop = await buildPopulation(deps.provider, { repo: reg.record.repo, window: reg.record.window, selector: reg.record.selector, cutoffIso: m.frozenAt });
    const mine = new Map(m.changes.map((x) => [x.id, x]));
    const rebuilt = new Map(pop.entries.map((x) => [x.id, x]));
    const missing = [...rebuilt.keys()].filter((id) => !mine.has(id));
    const extra = [...mine.keys()].filter((id) => !rebuilt.has(id));
    const shaDiff = [...mine.keys()].filter((id) => rebuilt.has(id) && rebuilt.get(id)!.mergeSha !== mine.get(id)!.mergeSha);
    const frozen = Date.parse(m.frozenAt);
    const late = pop.listed.changes.filter((x) => mine.has(x.id) && x.reviews.some((r) => Date.parse(r.submittedAt) > frozen));
    if (missing.length) c5.details.push(`FAIL population: ${n(missing.length)} changes on ${deps.provider.name} are missing from the manifest (e.g. ${missing.slice(0, 3).join(", ")})`);
    if (extra.length) c5.details.push(`FAIL population: ${n(extra.length)} changes in the manifest are not in the rebuilt population (e.g. ${extra.slice(0, 3).join(", ")})`);
    if (shaDiff.length) c5.details.push(`FAIL population: ${n(shaDiff.length)} changes have a different merge SHA (e.g. ${shaDiff.slice(0, 3).join(", ")})`);
    if (late.length) c5.details.push(`${n(late.length)} manifest changes received reviews after freeze time (ignored, as of ${m.frozenAt}): ${late.slice(0, 5).map((x) => x.id).join(", ")}`);
    c5.status = missing.length || extra.length || shaDiff.length ? "FAIL" : "PASS";
    c5.summary = c5.status === "FAIL" ? c5.details[0]!.replace(/^FAIL /, "") : `population ${n(pop.entries.length)}/${n(m.N)} match`;
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
    c7.summary = "no verified draws to check labels against";
  } else {
    const verdicts = await deps.ledger.readVerdicts();
    status = computeStatus({
      N: m.N,
      minPopulation: reg.record.parameters.minPopulation,
      draws: recomputed,
      drawsIssued: a.draws.issued,
      verdicts,
      protocolSha256: reg.record.protocolSha256,
      params: reg.record.parameters,
    });
    const countedIds = new Set(recomputed.slice(0, status.sequence.draws).map((d) => d.changeId));
    const firstFor = new Map<string, (typeof verdicts)[number]>();
    for (const v of verdicts) if (v.protocolSha256 === reg.record.protocolSha256 && !firstFor.has(v.changeId)) firstFor.set(v.changeId, v);
    for (const id of countedIds) {
      const v = firstFor.get(id);
      if (v && Date.parse(v.recordedAt) / 1000 < derived.publishesAt) {
        c7.status = "FAIL";
        c7.details.push(`verdict on draw #${v.draw} (${id}) recorded ${v.recordedAt}, before the seed was public`);
      }
    }
    for (const i of status.ignored) c7.details.push(`ignored verdict on draw #${i.event.draw}: ${i.reason}`);
    for (const r of status.relabels) c7.details.push(`relabel: ${r.changeId} first ${r.first.verdict} (counts), later ${r.later.verdict}`);
    if (status.ignored.length || status.relabels.length) if (c7.status === "PASS") c7.status = "WARN";
    if (deps.ledger.verifyIntegrity) {
      const integ = await deps.ledger.verifyIntegrity();
      c7.details.push(...integ.findings);
      if (!integ.ok) c7.status = "FAIL";
      else if (!integ.tamperTrail && c7.status === "PASS") c7.status = "WARN";
    } else {
      c7.details.push(`ledger ${deps.ledger.name} has no integrity check`);
      if (c7.status === "PASS") c7.status = "WARN";
    }
    c7.summary = c7.status === "FAIL" ? "labels FAIL" : `labels (prefix ${status.labelledPrefix}, ${verdicts.length} events)`;
  }
  checks.push(c7);

  return { checks, ok: !checks.some((c) => c.status === "FAIL"), mode, timestampTamperProof: tamperProof, status, derivedRound: derived.round };
}
