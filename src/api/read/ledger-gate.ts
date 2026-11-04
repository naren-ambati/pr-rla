import { existsSync } from "node:fs";
import { assessedLedgerGate, type LedgerGate, type LedgerGateInput, type LoadedLedger } from "../../core/ledger-gate.js";
import type { AnyRegistration, SignedRecord } from "../../core/records.js";
import type { WindowPaths } from "../../config.js";
import { readIndexDocument } from "../../ledgers/issue-index.js";
import type { TrustBundle } from "../../timestamp/bundle.js";
import { readDraws, readManifest } from "../session.js";
import { readCheckpoints } from "./checkpoints.js";
import { readPublications } from "./publications.js";

/**
 * Check 7's local gate (P1, the seam review of 45f1c9d): a function of the audit directory, the registration and the
 * loaded ledger, with no side effects. It reads the window's files (the manifest's hash, draws.json, the ledger index,
 * the publication records, the checkpoints), assesses their tokens offline under the registration's timestamping and
 * `trust` (the shipped bundle plus the caller's anchors: `trustFor(ctx, tsaTrust)`), and runs the rules verify's check 7
 * runs (src/core/ledger-gate.ts) over them and over what was read from the ledger (`ledger.read`; null when it was not
 * read). It makes no request and writes nothing.
 *
 * What it returns: `fails`, every FAIL (verify's check 7 FAILs for each, and a status that certifies withholds the
 * certificate as FAILED); `incompletes`, every finding the files cannot establish but do not show false (check 7 is
 * INCOMPLETE for them when nothing FAILs, and the certificate is withheld as INCOMPLETE); and, for printing, `warns`,
 * `lines`, and one short reason per kind of either (`withheld`, `unestablished`). `o.draws` are the issued draws as
 * verified (verify: check 6's recomputation); draws.json's otherwise.
 */
export async function check7Gate(paths: WindowPaths, registration: SignedRecord<AnyRegistration>, ledger: LoadedLedger, trust: TrustBundle, o: { draws?: LedgerGateInput["draws"] } = {}): Promise<LedgerGate> {
  const { checkpoints, problems, unchained } = readCheckpoints(paths.windowDir);
  return assessedLedgerGate(
    registration,
    {
      manifestSha256: existsSync(paths.manifest) ? readManifest(paths).sha256 : null,
      drawsFile: existsSync(paths.draws) ? readDraws(paths) : null,
      ledgerIndex: readIndexDocument(paths.windowDir),
      publications: readPublications(paths.windowDir),
      checkpoints,
      checkpointProblems: problems,
      checkpointsUnchained: unchained,
    },
    ledger,
    trust,
    o,
  );
}
