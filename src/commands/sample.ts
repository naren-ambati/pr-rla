import { RoundNotYetPublished } from "../beacon/drand.js";
import { manifestSha256, repoLabel, derivedRoundFor } from "../core/records.js";
import { computeDraws, QUICKNET, unixToIso } from "../core/seed.js";
import { effectiveCap, zeroFailureStop } from "../core/sprt.js";
import { existsSync } from "node:fs";
import {
  CommandError,
  configFor,
  fmt,
  getBeacon,
  ledgerFor,
  readCommitment,
  readDraws,
  readManifest,
  readRegistration,
  writeJson,
  type CommandContext,
  type DrawsFile,
} from "./context.js";

export interface SampleOptions {
  through?: number;
  beaconFile?: string;
}

export async function sampleCommand(ctx: CommandContext, opts: SampleOptions): Promise<number> {
  const { config, paths } = configFor(ctx);
  const reg = readRegistration(paths);
  const manifest = readManifest(paths);
  const commitment = readCommitment(paths);
  if (manifestSha256(manifest) !== manifest.sha256) throw new CommandError("manifest hash does not match its contents");
  if (commitment.record.manifestSha256 !== manifest.sha256) throw new CommandError("manifest commitment names a different manifest");
  const p = reg.record.parameters;
  if (manifest.N < p.minPopulation) {
    ctx.out(`population ${fmt(manifest.N)} < ${p.minPopulation}: review all ${fmt(manifest.N)} instead`);
    return 3;
  }
  const { round, publishesAt } = derivedRoundFor(reg);
  if (commitment.record.seedRound !== round) throw new CommandError(`commitment names seed round ${commitment.record.seedRound} ≠ derived round ${round}`);
  let beacon;
  try {
    beacon = await getBeacon(ctx, round, opts.beaconFile);
  } catch (e) {
    if (e instanceof RoundNotYetPublished) {
      const hours = (publishesAt - Math.floor(ctx.nowMs() / 1000)) / 3600;
      ctx.out(`seed round ${round} publishes ${unixToIso(publishesAt)} (in ${hours.toFixed(1)} h); run "pr-rla sample" then`);
      return 2;
    }
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
  ctx.out(`round ${round} verified (BLS, drand quicknet) · randomness ${beacon.randomness.slice(0, 16)}… · N ${fmt(manifest.N)} · issued ${issued} of cap ${cap}`);
  for (const d of draws.slice(0, issued)) ctx.out(`  #${String(d.draw).padStart(3)}  ${d.changeId}  ${d.url}${d.firstOccurrence ? "" : "  (drawn before: reuses its verdict)"}`);
  if (ledger.publishDraws)
    ctx.out(`ledger ${ledger.name}: one issue per drawn change (audit/${config.window.name}/ledger-index.json); review in draw order under ${config.protocol} and apply the verdict label on each issue; commit draws.json and ledger-index.json`);
  else ctx.out(`review in draw order under ${config.protocol}; record each with "pr-rla record <draw> pass|fail --reviewer <you>" and commit`);
  return 0;
}
