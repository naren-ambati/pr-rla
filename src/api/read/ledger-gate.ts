import { checkpointRecord, type CheckpointArtifact } from "../../core/checkpoint.js";
import { ledgerGate, type GateLedger, type LedgerGate } from "../../core/ledger-gate.js";
import type { BindingIdentity } from "../../core/plugin-binding.js";
import { derivedRoundFor, isRegistrationV2, type AnyManifest, type AnyRegistration, type DrawsFile, type SignedRecord } from "../../core/records.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { testOnlyLedgerOptions } from "../../ledger-traits.js";
import { readIndexDocument } from "../../ledgers/issue-index.js";
import type { TimeEvidenceSummary } from "../../timestamp/verify.js";
import { trustFor, type ApiContext } from "../session.js";
import { assessRecord } from "../timestamps.js";
import { readCheckpoints } from "./checkpoints.js";
import { readPublications } from "./publications.js";

/**
 * Check 7's gate for a caller other than verify (P1, the seam review of 45f1c9d): status, and anything that
 * prints a certificate. It reads the window's local files (the index, the publication records, the
 * checkpoints), assesses their tokens offline under the registration's timestamping, and runs the same
 * src/core/ledger-gate.ts check 7 runs, with what the caller got from the ledger (`ledger`; null when the
 * ledger was not read). Whatever it FAILs, verify's check 7 FAILs; `withheld` says why a certificate
 * must not be printed.
 */
export async function localLedgerGate(ctx: ApiContext, config: PrRlaConfig, paths: WindowPaths, input: { registration: SignedRecord<AnyRegistration>; manifest: AnyManifest; draws: DrawsFile; ledger: GateLedger | null; ledgerIdentity: BindingIdentity | null }): Promise<LedgerGate> {
  const reg = input.registration;
  const { checkpoints, problems, unchained } = readCheckpoints(paths.windowDir);
  const publications = readPublications(paths.windowDir);
  const checkpointStamps = new Map<CheckpointArtifact, TimeEvidenceSummary>();
  const publicationStamps: (TimeEvidenceSummary | null)[] = [];
  if (isRegistrationV2(reg)) {
    const bundle = trustFor(ctx);
    for (const cp of checkpoints) if (cp.line.timestamps.length) checkpointStamps.set(cp, await assessRecord(ctx, config, { record: checkpointRecord(cp.line), timestamps: cp.line.timestamps } as SignedRecord<unknown>, cp.line.takenAt, reg.record.timestamping, bundle));
    for (const p of publications?.publications ?? []) publicationStamps.push(await assessRecord(ctx, config, p, p.record.publishedAt, reg.record.timestamping, bundle));
  }
  return ledgerGate({
    registration: reg,
    manifestSha256: input.manifest.sha256,
    drawsFile: input.draws,
    draws: input.draws.draws,
    seedPublishesAt: derivedRoundFor(reg).publishesAt,
    ledgerIdentity: input.ledgerIdentity,
    testOnlyOptions: testOnlyLedgerOptions(config.ledger),
    ledger: input.ledger,
    ledgerIndex: readIndexDocument(paths.windowDir),
    publications,
    publicationStamps,
    checkpoints,
    checkpointProblems: problems,
    checkpointsUnchained: unchained,
    checkpointStamps,
  });
}
