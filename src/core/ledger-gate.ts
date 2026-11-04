import { recordedBeforeSeed, type LedgerHistoryEvent, type LedgerIntegrityReport, type VerdictEvent } from "../sdk/ledger.js";
import { anchorLines, isoMs, notTamperProof, timestampsLine, type TimeEvidenceSummary } from "../timestamp/verify.js";
import { compareWithCheckpoint, type CheckpointArtifact } from "./checkpoint.js";
import { checkpointCoverage, indexBindingFindings, type AnchorFindings, type LedgerIndexDocument } from "./ledger-anchor.js";
import { ledgerPathFindings } from "./ledger-path.js";
import { publicationFindings, type PublicationTime, type ReadPublications } from "./ledger-publication.js";
import { identityDiffs, type BindingIdentity } from "./plugin-binding.js";
import { signaturesCountFor, verdictRuleFailures, type VerdictRules } from "./presence/provenance.js";
import { isRegistrationV2, type AnyRegistration, type DrawsFile, type SignedRecord } from "./records.js";

/**
 * Check 7's gate (P1, with the seam review of 45f1c9d): every rule of check 7 that turns on what pr-rla has
 * already read, in one place, so verify and status reach the same FAIL for the same audit. Status folds each
 * FAIL into `certificateWithheld`, so nothing verify would FAIL here can show as CERTIFIED there.
 *
 * It covers: the ledger read being the registered one; `require_signed` needing git-file; counted verdicts
 * recorded before the seed, below the registered provenance, or unsigned where signatures are required; the
 * ledger's own integrity report and git-file's registered path (P4); the checkpoint file, each checkpoint's
 * ledger, tokens and comparison with the history now, and the coverage of the last counted verdict; the draw
 * → issue index's binding to draws.json; and the ledger publication record (src/core/ledger-publication.ts).
 *
 * What it does not do is read anything: the caller reads the ledger (verdicts, integrity, history) and
 * assesses the tokens, and passes what it got. Pure.
 */

/** Which rule a line comes from (status prints some of them its own way: the verdict rules and the integrity report). */
export type GateRule = "identity" | "seed" | "provenance" | "signatures" | "integrity" | "checkpoints" | "index" | "publication" | "coverage";

/** One line of check 7's details, as verify prints it, and whether it FAILs, WARNs or only informs. */
export interface GateLine {
  level: "fail" | "warn" | "note";
  text: string;
  rule: GateRule;
}

export interface LedgerGate {
  /** Check 7's lines for these rules, in order. */
  lines: GateLine[];
  /** Each FAIL, as a sentence (without the `FAIL ` some lines carry). */
  fails: string[];
  /** Each WARN, likewise. */
  warns: string[];
  /** Why status withholds CERTIFIED: one short reason per kind of FAIL (P4's wording where it had one). */
  withheld: string[];
}

/** What the ledger gave when it was read (null in the gate: it was not read, offline or not the registered one). */
export interface GateLedger {
  name: string;
  /** It publishes draws (an issue ledger): the publication record applies. */
  publishes: boolean;
  /** It has readHistory (checkpoints apply to it). */
  checkpointable: boolean;
  /** Every verdict event it returned (null: readVerdicts failed; the caller reported it). */
  verdictsRead: readonly VerdictEvent[] | null;
  /** The first verdict of every counted change (the counted prefix). */
  counted: readonly VerdictEvent[];
  /** The first verdicts of every drawn change, for the checkpoints' comparison. */
  firstVerdicts: readonly VerdictEvent[];
  /** verifyIntegrity's report or error; null when the ledger has none. */
  integrity: { report: LedgerIntegrityReport | null; error: string | null } | null;
  /** readHistory's events or error, when checkpoints exist; null when the ledger has none or there is no checkpoint. */
  history: { events: LedgerHistoryEvent[] | null; error: string | null } | null;
}

export interface LedgerGateInput {
  registration: SignedRecord<AnyRegistration>;
  manifestSha256: string | null;
  /** draws.json: the index binding and the issued count. */
  drawsFile: DrawsFile | null;
  /** The issued draws as verified (verify: check 6's recomputation); draws.json's elsewhere. */
  draws: readonly { draw: number; changeId: string; firstOccurrence?: boolean }[] | null;
  /** When seed round R published (unix): a counted verdict recorded before it FAILs. */
  seedPublishesAt: number;
  /** The configured ledger's identity (null when it could not be read). */
  ledgerIdentity: BindingIdentity | null;
  /** Test-only options the ledger runs with (src/ledger-traits.ts `testOnlyLedgerOptions`): an audit never sets one. */
  testOnlyOptions?: readonly string[];
  ledger: GateLedger | null;
  ledgerIndex: LedgerIndexDocument | null | undefined;
  publications: ReadPublications | null;
  /** The tokens of each publication, assessed under the registration's timestamping (null for a v1 registration). */
  publicationStamps: readonly (TimeEvidenceSummary | null)[];
  checkpoints: readonly CheckpointArtifact[];
  checkpointProblems: readonly string[];
  checkpointsUnchained: number;
  /** The tokens of each checkpoint, assessed likewise (absent: not assessed, a v1 registration). */
  checkpointStamps: ReadonlyMap<CheckpointArtifact, TimeEvidenceSummary>;
}

/** Built-in ledgers that publish draws (one issue per draw): the publication record is required for them by name. */
export const PUBLISHING_BUILTIN_LEDGERS: ReadonlySet<string> = new Set(["github-issues", "gitlab-issues"]);

/**
 * Whether the registration requires a ledger publication record (P1). Keyed on the signed registration, never on
 * an unsigned file: schema v2, and the registered ledger publishes draws (a built-in issue ledger by name; an
 * external one when the registered plugin, which is the one read, has publishDraws). An external ledger that was not
 * read (offline) is held to the records it left.
 */
export function publicationRequired(reg: SignedRecord<AnyRegistration>, ledger: Pick<GateLedger, "publishes"> | null, hasArtifacts: boolean): boolean {
  if (!isRegistrationV2(reg)) return false;
  const r = reg.record.plugins.ledger;
  if (r.source === "builtin") return PUBLISHING_BUILTIN_LEDGERS.has(r.name);
  return ledger ? ledger.publishes : hasArtifacts;
}

/** A record's token lines (failures, ignored, the summary and anchors, and the not-tamper-proof note), as checks 1 and 2 print theirs. */
function tokenLines(what: string, ts: TimeEvidenceSummary, unprovenLevel: "warn" | "note"): Omit<GateLine, "rule">[] {
  const out: Omit<GateLine, "rule">[] = [];
  for (const f of ts.failed) out.push({ level: "fail", text: `FAIL ${what} token from ${f.tsa}: ${f.problems.join("; ")}` });
  for (const i of ts.ignored) out.push({ level: "note", text: `${what} token from ${i.tsa} ignored (not registered: the registration names ${ts.configured.join(", ") || "no authority"})` });
  out.push({ level: "note", text: `${what} ${timestampsLine(ts)}${ts.ukMs !== null ? ` · existed by ${isoMs(ts.ukMs)} (U_k)` : ""}` });
  for (const l of anchorLines(ts)) out.push({ level: "note", text: `${what} ${l}` });
  if (!ts.proven) out.push({ level: unprovenLevel, text: `${notTamperProof(ts)}: the ${what}'s time is the signer's own clock${ts.configured.length ? `, bounded by ${ts.operators.length} operator(s) where ${ts.k} are required` : ""}` });
  return out;
}

const fromAnchor = (f: AnchorFindings): Omit<GateLine, "rule">[] => [...f.fails.map((t) => ({ level: "fail" as const, text: `FAIL ${t}` })), ...f.warns.map((t) => ({ level: "warn" as const, text: `WARN ${t}` })), ...f.notes.map((t) => ({ level: "note" as const, text: t }))];

export function ledgerGate(i: LedgerGateInput): LedgerGate {
  const reg = i.registration;
  const v2 = isRegistrationV2(reg) ? reg : null;
  const registeredLedger = v2 ? v2.record.plugins.ledger : null;
  const groups: { reason: string; lines: GateLine[] }[] = [];
  const add = (rule: GateRule, reason: string, lines: Omit<GateLine, "rule">[]) => groups.push({ reason, lines: lines.map((l) => ({ ...l, rule })) });

  // The ledger in .pr-rla.yml is the registered one (P1).
  const idDiffs = registeredLedger && i.ledgerIdentity ? identityDiffs(registeredLedger, i.ledgerIdentity) : [];
  if (idDiffs.length) add("identity", "the ledger is not the registered one", [{ level: "fail", text: `FAIL the ledger in .pr-rla.yml is not the registered one (${idDiffs.join("; ")}): ${i.ledger ? "verify with the registered ledger and options" : "verify did not read it; verify with the registered ledger and options"}` }]);
  for (const o of i.testOnlyOptions ?? []) add("identity", "the ledger runs with a test-only option", [{ level: "fail", text: `FAIL the ledger runs with ${o}, a test-only option (recorded public timelines of issues pr-rla did not open): an audit never sets it, and it turns off the issues' body-marker check` }]);
  const rules: VerdictRules = { minProvenance: v2?.record.verdicts.minProvenance ?? "self-asserted", requireSigned: v2?.record.verdicts.require_signed === true };
  if (rules.requireSigned && registeredLedger && !signaturesCountFor(registeredLedger))
    add("signatures", "require_signed needs the built-in git-file ledger", [{ level: "fail", text: `FAIL require_signed needs the built-in git-file ledger, but the registration names ledger ${registeredLedger.name} (${registeredLedger.source})` }]);

  // The counted verdicts against the registered rules (FR3.8, FR9.1, FR9.4) and the seed.
  const counted = i.ledger?.counted ?? [];
  const beforeSeed = counted.filter((v) => recordedBeforeSeed(v.recordedAt, i.seedPublishesAt));
  add("seed", `${beforeSeed.length} counted verdict(s) recorded before the seed was public`, beforeSeed.map((v) => ({ level: "fail", text: `verdict on draw #${v.draw} (${v.changeId}) recorded ${v.recordedAt}, before the seed was public` })));
  const below = counted.filter((v) => verdictRuleFailures(v, { minProvenance: rules.minProvenance, requireSigned: false }).length > 0);
  const unsigned = rules.requireSigned ? counted.filter((v) => verdictRuleFailures(v, { minProvenance: "self-asserted", requireSigned: true }).length > 0) : [];
  const ruleLines = counted.flatMap((v) => verdictRuleFailures(v, rules).map((text) => ({ level: "fail" as const, text })));
  add("provenance", `${below.length} counted verdict(s) below the registered provenance`, ruleLines.filter((l) => !/carries no valid signature/.test(l.text)));
  add("signatures", `${unsigned.length} counted verdict(s) without a valid signature`, ruleLines.filter((l) => /carries no valid signature/.test(l.text)));

  // The ledger's own integrity report, and git-file's registered path (P4).
  if (i.ledger) {
    const lines: Omit<GateLine, "rule">[] = [];
    const g = i.ledger.integrity;
    if (!g) lines.push({ level: "warn", text: `ledger ${i.ledger.name} has no integrity check` });
    else if (g.error !== null) lines.push({ level: "fail", text: `ledger ${i.ledger.name}: verifyIntegrity failed: ${g.error}` });
    else if (g.report) {
      const r = g.report;
      // As check 7 always judged it: not ok FAILs, no tamper trail or a warning WARNs.
      const findingLevel = !r.ok ? ("fail" as const) : !r.tamperTrail ? ("warn" as const) : ("note" as const);
      lines.push(...r.findings.map((text) => ({ level: findingLevel, text })), ...(r.warnings ?? []).map((text) => ({ level: "warn" as const, text })));
      if (r.ok && !r.tamperTrail && !r.findings.length && !(r.warnings ?? []).length) lines.push({ level: "warn", text: `ledger ${i.ledger.name} keeps no tamper trail` });
      if (!r.ok && !r.findings.length) lines.push({ level: "fail", text: `ledger ${i.ledger.name}: its integrity check FAILs` });
      if (i.ledger.name === "git-file") lines.push(...fromAnchor(ledgerPathFindings(reg, r.location)));
    }
    add("integrity", "the ledger's integrity check FAILs", lines);
  }

  // The checkpoints: the file, the ledger each names, the comparison with the history now, and their tokens.
  const cp: Omit<GateLine, "rule">[] = [];
  for (const p of i.checkpointProblems) cp.push({ level: "fail", text: `FAIL checkpoint file: ${p}` });
  if (registeredLedger)
    for (const c of i.checkpoints) {
      const d = c.line.ledger && typeof c.line.ledger === "object" ? identityDiffs(registeredLedger, c.line.ledger) : ["ledger (none recorded)"];
      if (d.length) cp.push({ level: "fail", text: `FAIL checkpoint ${c.line.takenAt} was taken of a ledger that is not the registered one (${d.join("; ")})` });
    }
  if (i.ledger && i.checkpoints.length) {
    if (!i.ledger.checkpointable) cp.push({ level: "warn", text: `${i.checkpoints.length} ledger checkpoint(s) in the audit repo, but ledger ${i.ledger.name} has no readHistory: they cannot be compared` });
    else if (i.ledger.history?.error) cp.push({ level: "fail", text: `ledger ${i.ledger.name}: readHistory failed: ${i.ledger.history.error}` });
    else if (i.ledger.history?.events)
      for (const c of i.checkpoints) {
        const problems = compareWithCheckpoint(c, i.ledger.history.events, i.ledger.firstVerdicts);
        cp.push(...(problems.length ? problems.map((p) => ({ level: "fail" as const, text: `FAIL ${p}` })) : [{ level: "note" as const, text: `checkpoint ${c.line.takenAt}: ${c.line.count} events, all still present` }]));
      }
  }
  for (const c of i.checkpoints) {
    const ts = i.checkpointStamps.get(c);
    if (ts && c.line.timestamps.length) cp.push(...tokenLines(`checkpoint ${c.line.takenAt}`, ts, "warn"));
  }
  add("checkpoints", "a ledger checkpoint FAILs", cp);

  // The draw → issue index bound to draws.json (master-ledgers-review #3).
  if (i.drawsFile && i.ledgerIndex !== undefined) add("index", "the ledger index is not the one bound to the draws", fromAnchor(indexBindingFindings(i.drawsFile, i.ledgerIndex)));

  // The ledger publication record (P1, pass-2 review #1).
  const required = publicationRequired(reg, i.ledger, !!i.ledgerIndex || !!i.publications?.publications.length || !!i.publications?.problems.length);
  if (i.drawsFile && i.manifestSha256 && (required || i.ledgerIndex || i.publications)) {
    const authoritiesRegistered = !!v2 && v2.record.timestamping.authorities.length > 0 && v2.record.timestamping.minTokens >= 1;
    const pubs = i.publications?.publications ?? [];
    const stampLines: Omit<GateLine, "rule">[] = [];
    const times: PublicationTime[] = pubs.map((p, n) => {
      const ts = i.publicationStamps[n] ?? null;
      if (ts && (p.timestamps.length || authoritiesRegistered)) stampLines.push(...tokenLines(`ledger publication #${n + 1}`, ts, "note"));
      return { proven: !!ts?.proven, boundMs: authoritiesRegistered ? (ts?.ukMs ?? null) : Date.parse(p.record.publishedAt), failed: ts?.failed.length ?? 0 };
    });
    const f = publicationFindings({
      required,
      authoritiesRegistered,
      registration: { sha256: reg.sha256, publicKeyPem: reg.publicKeyPem, window: reg.record.window.name, ledger: registeredLedger },
      manifestSha256: i.manifestSha256,
      file: i.publications,
      times,
      index: i.ledgerIndex && !i.ledgerIndex.error ? { value: i.ledgerIndex.value, sha256: i.ledgerIndex.sha256 } : null,
      draws: (i.draws ?? i.drawsFile.draws).map((d) => ({ draw: d.draw, changeId: d.changeId, firstOccurrence: d.firstOccurrence ?? true })),
      issued: i.drawsFile.issued,
      verdictsRead: i.ledger?.verdictsRead ?? null,
      counted: i.ledger ? counted : null,
    });
    const dedupe = (xs: string[]) => [...new Set(xs)];
    add("publication", "the draw → issue publication record FAILs", [...stampLines, ...fromAnchor({ fails: dedupe(f.fails), warns: dedupe(f.warns), notes: f.notes })]);
  }

  // Coverage (pass-2 review #5): a checkpoint covers the last counted verdict only when its tokens are proven, with U_k at or after it.
  if (i.ledger) {
    const lastCountedAt = counted.map((v) => v.recordedAt).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
    add(
      "coverage",
      "a ledger checkpoint FAILs",
      fromAnchor(
        checkpointCoverage(i.checkpoints, {
          checkpointable: i.ledger.checkpointable,
          lastCountedAt,
          ledgerIndexSha256: i.ledgerIndex?.sha256 ?? null,
          unchained: i.checkpointsUnchained,
          timeStamped: (c) => {
            const ts = i.checkpointStamps.get(c);
            return !!ts && ts.proven && ts.ukMs !== null && lastCountedAt !== null && ts.ukMs >= Date.parse(lastCountedAt);
          },
        }),
      ),
    );
  }

  const lines = groups.flatMap((g) => g.lines);
  const strip = (t: string) => t.replace(/^(FAIL|WARN) /, "");
  return {
    lines,
    fails: lines.filter((l) => l.level === "fail").map((l) => strip(l.text)),
    warns: lines.filter((l) => l.level === "warn").map((l) => strip(l.text)),
    withheld: [...new Set(groups.filter((g) => g.lines.some((l) => l.level === "fail")).map((g) => g.reason))],
  };
}
