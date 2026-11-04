import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RoundNotYetPublished } from "../../beacon/drand.js";
import { PUBLICATION_FILE, appendPublicationFile, indexExtensionProblems, issueOrderProblems, type LedgerPublicationRecord, type ReadPublications, type SignedPublication } from "../../core/ledger-publication.js";
import { compareChangeIds, derivedRoundFor, drawBinding, isRegistrationV2, manifestSha256, repoLabel, type AnyRegistration, type DrawsFile, type SignedRecord, type TimestampEvidence } from "../../core/records.js";
import { loadOrCreateKey, signRecord, type SigningKey } from "../../core/signing.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { pluginIdentity } from "../../registry.js";
import type { AuthorityOutcome } from "../../timestamp/client.js";
import type { TimeEvidenceSummary } from "../../timestamp/verify.js";
import { PR_RLA_VERSION } from "../../version.js";
import { publicationsPath, readPublications } from "../read/publications.js";
import { assessRecord } from "../timestamps.js";
import { obtainTimestamps } from "./timestamps.js";
import { computeDraws, QUICKNET, unixToIso } from "../../core/seed.js";
import { effectiveCap, zeroFailureStop } from "../../core/sprt.js";
import { INDEX_FILE, readIndexDocument } from "../../ledgers/issue-index.js";
import { AuditError } from "../errors.js";
import { auditContextFor, configFor, getBeacon, isoNow, ledgerFor, readCommitment, readDraws, readManifest, readRegistration, requireWritable, trustFor, type ApiContext } from "../session.js";
import { writeJson } from "./files.js";

export interface SampleOptions {
  /** Issue draws 1..n (default: the zero-failure stopping point). */
  through?: number;
  /** A recorded quicknet beacon (still BLS-verified) instead of fetching. */
  beaconFile?: string;
  /** The key that signed the registration (default: signing_key in .pr-rla.yml): it signs the ledger publication record. */
  key?: string;
  /** Extra timestamp-authority anchors, for the publication record's tokens (as register's and freeze's). */
  tsaTrust?: string[];
}

/** What `sample` appended to ledger-publication.json (P1), when the ledger publishes draws. */
export interface SamplePublication {
  /** Its place in the file (1 for the first). */
  sequence: number;
  /** The draws it covers: 1 to `through`. */
  through: number;
  path: string;
  /** The tokens' assessment (null for a v1 registration, which names no authority). */
  evidence: TimeEvidenceSummary | null;
  outcomes: AuthorityOutcome[];
}

export type SampleResult =
  | { outcome: "below-minimum"; N: number; minPopulation: number; line: string }
  | { outcome: "seed-not-published"; seedRound: number; seedRoundPublishesAt: string; hoursToGo: number }
  | {
      outcome: "sampled";
      seedRound: number;
      randomness: string;
      N: number;
      issued: number;
      cap: number;
      /** The issued draws, in order. */
      draws: DrawsFile["draws"];
      drawsPath: string;
      ledger: string;
      /** The ledger opened one issue per drawn change (issue ledgers). */
      publishedToLedger: boolean;
      /**
       * The publication record appended this run (P1), or null: the ledger publishes no draws, or the index is the one
       * the latest proven publication already holds. With too few tokens, run sample again before anyone records a verdict.
       */
      publication: SamplePublication | null;
      protocolFile: string;
      window: string;
    };

/**
 * `sample` (write side): fetches and BLS-verifies seed round R, computes the draws, writes
 * draws.json and publishes the issued draws to the ledger (issue ledgers open one issue per
 * drawn change). CLI only; refused in a read-only context. Issuing draws is never an MCP tool.
 */
export async function sample(ctx: ApiContext, opts: SampleOptions = {}): Promise<SampleResult> {
  requireWritable(ctx, "sample");
  const { config, paths } = configFor(ctx);
  const reg = readRegistration(paths);
  const manifest = readManifest(paths);
  const commitment = readCommitment(paths);
  if (manifestSha256(manifest) !== manifest.sha256) throw new AuditError("manifest hash does not match its contents");
  if (commitment.record.manifestSha256 !== manifest.sha256) throw new AuditError("manifest commitment names a different manifest");
  // Draw indexes point into the change ids in canonical order (contracts.md §5): the manifest must list them so.
  if (manifest.changes.some((c, i) => i > 0 && compareChangeIds(manifest.changes[i - 1]!.id, c.id) >= 0)) throw new AuditError("manifest changes are not sorted by id (or one is listed twice): the draws cannot be taken from it");
  const p = reg.record.parameters;
  if (manifest.N < p.minPopulation) return { outcome: "below-minimum", N: manifest.N, minPopulation: p.minPopulation, line: `population ${manifest.N.toLocaleString("en-US")} < ${p.minPopulation}: review all ${manifest.N.toLocaleString("en-US")} instead` };
  const { round, publishesAt } = derivedRoundFor(reg);
  if (commitment.record.seedRound !== round) throw new AuditError(`commitment names seed round ${commitment.record.seedRound} ≠ derived round ${round}`);
  let beacon;
  try {
    beacon = await getBeacon(ctx, round, opts.beaconFile);
  } catch (e) {
    if (e instanceof RoundNotYetPublished) return { outcome: "seed-not-published", seedRound: round, seedRoundPublishesAt: unixToIso(publishesAt), hoursToGo: (publishesAt - Math.floor(ctx.nowMs() / 1000)) / 3600 };
    throw e;
  }
  const cap = effectiveCap(p);
  const prior = existsSync(paths.draws) ? readDraws(paths) : null;
  const issued = Math.min(cap, Math.max(opts.through ?? zeroFailureStop(p), prior?.issued ?? 0));
  const seen = new Set<string>();
  // Schema v2: bound to the registration, so a re-freeze cannot move a draw; v1: to the manifest (records.ts drawBinding).
  const draws = computeDraws(beacon.randomness, drawBinding(reg, manifest).hex, manifest.N, cap).map((d) => {
    const c = manifest.changes[d.index]!;
    const firstOccurrence = !seen.has(c.id);
    seen.add(c.id);
    return { draw: d.draw, index: d.index, changeId: c.id, url: c.url, mergeSha: c.mergeSha, firstOccurrence };
  });
  const file: DrawsFile = {
    schema: "pr-rla/draws/v1",
    repo: repoLabel(manifest),
    window: manifest.window.name,
    manifestSha256: manifest.sha256,
    N: manifest.N,
    round,
    beacon,
    chainHash: QUICKNET.chainHash,
    issued,
    cap,
    draws,
  };
  // The registered ledger (P1), bound before anything is written: a refused ledger leaves draws.json as it was.
  const ledger = await ledgerFor(ctx, config, paths, { command: "sample" });
  const publishes = !!ledger.publishDraws;
  // P1 (pass-2 review #1): before anything is published, the index must be the one already bound, extended at most.
  const pubs = publishes ? readPublications(paths.windowDir) : null;
  const before = publishes ? readIndexDocument(paths.windowDir) : null;
  const key = publishes ? publicationKey(config, reg, opts.key) : null;
  if (publishes) refuseRebind(before, pubs, prior);
  // Until the new index is published, draws.json keeps the binding it had.
  writeJson(paths.draws, { ...file, ...(prior?.ledgerIndexSha256 && prior.manifestSha256 === file.manifestSha256 ? { ledgerIndexSha256: prior.ledgerIndexSha256 } : {}) });
  await ledger.publishDraws?.(draws.slice(0, issued), { window: config.window.name, protocolSha256: reg.record.protocolSha256, registrationSha256: reg.sha256, repo: repoLabel(manifest) });
  // The ledger's draw → issue index now exists.
  const index = readIndexDocument(paths.windowDir);
  let publication: SamplePublication | null = null;
  if (publishes) {
    if (!index) throw new AuditError(`ledger ${ledger.name} published the draws but keeps no ${INDEX_FILE}: pr-rla cannot bind the draw → issue mapping, and verify will FAIL every verdict read from it (a ledger that publishes draws keeps its index in ctx.index: docs/writing-a-provider.md)`);
    if (index.error) throw new AuditError(`${INDEX_FILE} is not valid JSON after ledger ${ledger.name} published the draws; nothing was bound`);
    // An honest publish only appends; the issues it opened rise with the draws.
    const problems = [...(before && !before.error ? indexExtensionProblems(before.value, index.value, { prev: "the index before this run", next: "the index ledger " + ledger.name + " left" }) : []), ...issueOrderProblems(index.value)];
    if (problems.length) throw new AuditError(`ledger ${ledger.name} left an index that is not an append-only extension of the one before, or not in draw order (${problems.slice(0, 3).join("; ")}); nothing was bound`);
    publication = await publish(ctx, config, paths, { reg, manifestSha256: manifest.sha256, issued, index, pubs: pubs?.publications ?? [], key: key!, ledgerName: ledger.name, tsaTrust: opts.tsaTrust });
  }
  // Bind the index to the draws (verify compares this hash with the file).
  if (index) writeJson(paths.draws, { ...file, ledgerIndexSha256: index.sha256 });
  return {
    outcome: "sampled",
    seedRound: round,
    randomness: beacon.randomness,
    N: manifest.N,
    issued,
    cap,
    draws: draws.slice(0, issued),
    drawsPath: paths.draws,
    ledger: ledger.name,
    publishedToLedger: !!ledger.publishDraws,
    publication,
    protocolFile: config.protocol,
    window: config.window.name,
  };
}

/** The key that signed the registration, which signs the publication record: it must exist and be that key (P1). */
function publicationKey(config: PrRlaConfig, reg: SignedRecord<AnyRegistration>, keyOpt: string | undefined): SigningKey {
  const path = resolve(config.dir, keyOpt ?? config.signingKey);
  if (!existsSync(path)) throw new AuditError(`the signing key ${path} is missing: sample signs the ledger publication record with the key that signed the registration (signing_key in .pr-rla.yml, or --key)`);
  const key = loadOrCreateKey(path);
  if (key.publicKeyPem.trim() !== reg.publicKeyPem.trim()) throw new AuditError(`the signing key ${path} is not the key that signed the registration: sample signs the ledger publication record with that key (--key <path>)`);
  return key;
}

/**
 * Refuses to publish over an index that is not the bound one (P1): one carrying foreignIssues, one that is not
 * an append-only extension of the latest publication record, or (an audit sampled before publication records)
 * one whose hash is not the one draws.json bound. Nothing has been written yet.
 */
function refuseRebind(before: ReturnType<typeof readIndexDocument>, pubs: ReadPublications | null, prior: DrawsFile | null): void {
  if (pubs?.problems.length) throw new AuditError(`${PUBLICATION_FILE} cannot be read (${pubs.problems.join("; ")}); restore it from git before sampling again`);
  if (!before) {
    if (pubs?.publications.length) throw new AuditError(`${INDEX_FILE} is missing, but ${PUBLICATION_FILE} published it; restore it from git before sampling again`);
    return;
  }
  if (before.error) throw new AuditError(`${INDEX_FILE} is not valid JSON; restore it from git before sampling again`);
  if (before.value && typeof before.value === "object" && "foreignIssues" in before.value) throw new AuditError(`${INDEX_FILE} carries foreignIssues, which turns off the issues' body-marker check; an audit's index never carries it: restore the index from git`);
  const latest = pubs?.publications.at(-1);
  if (latest) {
    const ext = indexExtensionProblems(latest.record.index, before.value, { prev: `publication #${latest.record.sequence}`, next: INDEX_FILE });
    if (ext.length) throw new AuditError(`${INDEX_FILE} is not an append-only extension of the index ${PUBLICATION_FILE} published (${ext.slice(0, 3).join("; ")}${ext.length > 3 ? "; …" : ""}); sample does not rebind an edited index: restore it from git`);
  } else if (prior?.ledgerIndexSha256 && prior.ledgerIndexSha256 !== before.sha256)
    throw new AuditError(`${INDEX_FILE} (sha256 ${before.sha256.slice(0, 12)}…) is not the index draws.json bound (${prior.ledgerIndexSha256.slice(0, 12)}…); sample does not rebind an edited index: restore it from git`);
}

/**
 * Appends a publication record for `index` (P1), signed with the registration's key and time-stamped by the
 * registered authorities (SHA-256 digests only): unless the latest record already holds this exact index and
 * is proven (a re-run with nothing new). A latest record without enough tokens is published again.
 */
async function publish(ctx: ApiContext, config: PrRlaConfig, paths: WindowPaths, i: { reg: SignedRecord<AnyRegistration>; manifestSha256: string; issued: number; index: { sha256: string; value: unknown }; pubs: SignedPublication[]; key: SigningKey; ledgerName: string; tsaTrust?: string[] }): Promise<SamplePublication | null> {
  const v2 = isRegistrationV2(i.reg) ? i.reg : null;
  const bundle = trustFor(ctx, i.tsaTrust);
  const latest = i.pubs.at(-1);
  if (latest && latest.record.ledgerIndexSha256 === i.index.sha256 && latest.record.draws.through >= i.issued) {
    if (!v2 || !v2.record.timestamping.authorities.length) return null;
    const ts = await assessRecord(ctx, config, latest, latest.record.publishedAt, v2.record.timestamping, bundle);
    if (ts.proven) return null;
  }
  const publishedAt = isoNow(ctx);
  const ledgerId = v2 ? v2.record.plugins.ledger : await pluginIdentity(config.ledger, "ledger", config.dir, auditContextFor(ctx));
  const record: LedgerPublicationRecord = {
    schema: "pr-rla/ledger-publication/v1",
    window: config.window.name,
    registrationSha256: i.reg.sha256,
    manifestSha256: i.manifestSha256,
    ledger: ledgerId,
    sequence: i.pubs.length + 1,
    previousSha256: latest?.sha256 ?? null,
    draws: { through: i.issued },
    ledgerIndexSha256: i.index.sha256,
    index: i.index.value,
    publishedAt,
    prRlaVersion: PR_RLA_VERSION,
  };
  const signed = signRecord(record, i.key);
  let got: { timestamps: TimestampEvidence[]; outcomes: AuthorityOutcome[] } = { timestamps: [], outcomes: [] };
  if (v2) {
    try {
      got = await obtainTimestamps(ctx, signed, publishedAt, v2.record.timestamping, bundle);
    } catch (e) {
      if (!(e instanceof AuditError)) throw e;
      throw new AuditError(`ledger ${i.ledgerName} published the draws, but their publication record was not written: ${e.message.replace(/ Nothing was written\.$/, "")}; run "pr-rla sample" again before anyone records a verdict on the new issues`);
    }
  }
  const p: SignedPublication = { ...signed, timestamps: got.timestamps };
  writeJson(publicationsPath(paths.windowDir), appendPublicationFile(i.pubs, p));
  const evidence = v2 ? await assessRecord(ctx, config, p, publishedAt, v2.record.timestamping, bundle) : null;
  return { sequence: record.sequence, through: i.issued, path: publicationsPath(paths.windowDir), evidence, outcomes: got.outcomes };
}
