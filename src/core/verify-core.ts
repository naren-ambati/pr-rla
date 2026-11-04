import type { Withholding } from "./verdict.js";
import { verifyAudit, type VerifyArtifacts, type VerifyCheck, type VerifyDeps, type VerifyReport } from "./verify.js";

/**
 * The one offline verify core (P5, "draws that cannot be steered", finding 6). `verify` and `status` both run it, so
 * status can never show CERTIFIED where verify would FAIL on what is local: before, status recounted the SPRT over
 * draws.json and a swapped draw, a re-signed registration, a bad envelope signature, a changed protocol or an
 * inconsistent manifest all certified there while verify FAILED.
 *
 * It is verify's own checks 1, 2, 3, 4 and 6 (src/core/verify.ts), run with no provider and no ledger: the
 * registration and its time evidence, the manifest against the registration and its commitment, the seed round, round
 * R's BLS signature from the beacon draws.json records (verified offline; no network), and every draw recomputed.
 * Checks 5 and 7 need the SCM and the ledger; status's own gates cover what of check 7 is local.
 *
 * `gates` plug further offline checks into the same result (P1's check-7 local gate joins here at merge): each says what
 * it would FAIL and what it cannot establish, and both become withholdings with the core's own.
 */
export const OFFLINE_CORE_CHECKS: readonly number[] = [1, 2, 3, 4, 6];

/** An offline check plugged into the core: what it shows would FAIL, and what it cannot establish. */
export interface CoreGate {
  n: number;
  name: string;
  run(): Promise<{ fails: string[]; incompletes: string[] }>;
}

export interface OfflineCoreResult {
  /** Checks 1, 2, 3, 4 and 6, as verify reports them. */
  checks: VerifyCheck[];
  /**
   * Why a certificate cannot stand on them: one FAILED withholding per FAIL check (and per gate FAIL), one INCOMPLETE per
   * line a check (or gate) marks `INCOMPLETE `, and one per SKIP. The records' unproven times (checks 1 and 3, and the
   * commitment's in check 2) are left to the caller's own time standing, which names them (`timeStanding` in status).
   */
  withholdings: Withholding[];
  /** The full report verify's checks were taken from (its mode, time evidence and versions). */
  report: VerifyReport;
}

/** What a FAIL check says first: its first `FAIL ` line, else (check 2's consistency lines carry no prefix) its first line, else its summary. */
function failLine(c: VerifyCheck): string {
  const tagged = c.details.find((d) => d.startsWith("FAIL "));
  if (tagged) return tagged.slice("FAIL ".length);
  const first = c.n === 2 ? c.details.find((d) => !/^(?:WARN|INCOMPLETE) /.test(d)) : undefined;
  return first ?? c.summary;
}

/** Runs the offline core over an audit's local records (see the module comment). Never reads the network. */
export async function verifyOfflineCore(a: Omit<VerifyArtifacts, "checkpoints" | "checkpointProblems" | "checkpointsUnchained" | "ledgerIndex">, deps: Omit<VerifyDeps, "provider" | "ledger" | "ledgerSkipped" | "ledgerIdentity" | "provenanceCeiling" | "providerIdentity">, gates: readonly CoreGate[] = []): Promise<OfflineCoreResult> {
  const report = await verifyAudit({ ...a }, { ...deps, provider: null, ledger: null });
  const checks = report.checks.filter((c) => OFFLINE_CORE_CHECKS.includes(c.n));
  const withholdings: Withholding[] = [];
  for (const c of checks) {
    if (c.status === "FAIL") withholdings.push({ verdict: "FAILED", reason: `verify check ${c.n} (${c.name}) would FAIL: ${failLine(c)}` });
    else if (c.status === "SKIP") withholdings.push({ verdict: "INCOMPLETE", reason: `verify check ${c.n} (${c.name}) cannot run: ${c.summary}` });
    else if (c.status === "INCOMPLETE")
      // Checks 1 and 3 are INCOMPLETE only for an unproven registration time; the caller names the times itself.
      for (const d of c.n === 1 || c.n === 3 ? [] : c.details.filter((x) => x.startsWith("INCOMPLETE ")))
        withholdings.push({ verdict: "INCOMPLETE", reason: `verify check ${c.n} (${c.name}) is not established: ${d.slice("INCOMPLETE ".length)}` });
  }
  for (const g of gates) {
    const r = await g.run();
    for (const f of r.fails) withholdings.push({ verdict: "FAILED", reason: `verify check ${g.n} (${g.name}) would FAIL: ${f}` });
    for (const x of r.incompletes) withholdings.push({ verdict: "INCOMPLETE", reason: `verify check ${g.n} (${g.name}) is not established: ${x}` });
  }
  return { checks, withholdings, report };
}
