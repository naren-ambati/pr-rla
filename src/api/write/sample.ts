import { existsSync } from "node:fs";
import { RoundNotYetPublished } from "../../beacon/drand.js";
import { derivedRoundFor, manifestSha256, repoLabel, type DrawsFile } from "../../core/records.js";
import { computeDraws, QUICKNET, unixToIso } from "../../core/seed.js";
import { effectiveCap, zeroFailureStop } from "../../core/sprt.js";
import { readIndexDocument } from "../../ledgers/issue-index.js";
import { AuditError } from "../errors.js";
import { configFor, getBeacon, ledgerFor, readCommitment, readDraws, readManifest, readRegistration, requireWritable, type ApiContext } from "../session.js";
import { writeJson } from "./files.js";

export interface SampleOptions {
  /** Issue draws 1..n (default: the zero-failure stopping point). */
  through?: number;
  /** A recorded quicknet beacon (still BLS-verified) instead of fetching. */
  beaconFile?: string;
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
  const draws = computeDraws(beacon.randomness, manifest.sha256, manifest.N, cap).map((d) => {
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
  writeJson(paths.draws, file);
  const ledger = await ledgerFor(ctx, config, paths);
  await ledger.publishDraws?.(draws.slice(0, issued), { window: config.window.name, protocolSha256: reg.record.protocolSha256, registrationSha256: reg.sha256, repo: repoLabel(manifest) });
  // The ledger's draw → issue index now exists: bind it to the draws (verify compares this hash with the file).
  const index = readIndexDocument(paths.windowDir);
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
    protocolFile: config.protocol,
    window: config.window.name,
  };
}
