import type { Ledger, LedgerIntegrityReport } from "../sdk/ledger.js";
import { isRegistrationV2, type AnyRegistration, type PluginIdentity, type SignedRecord } from "./records.js";

/**
 * Where a git-file ledger lives, bound by the registration (P4, second-pass review findings 1 and
 * 3), and what status must know before it prints CERTIFIED for one. Pure: the ledger is given.
 *
 * `register` records the built-in git-file ledger's path from the audit repository's toplevel,
 * lexical and normalised (`ledgerPath`); the ledger's integrity check reports the path it walked
 * (`LedgerIntegrityReport.location`), refusing a symbolic link or another spelling on the way.
 * Check 7 and status compare the two.
 */

/** True when the registered ledger is the built-in git-file, whose path a registration records. */
export const isBuiltinGitFile = (ledger: Pick<PluginIdentity, "name" | "source"> | null | undefined): boolean => !!ledger && ledger.source === "builtin" && ledger.name === "git-file";

export interface PathFindings {
  fails: string[];
  warns: string[];
  notes: string[];
}

/**
 * Check 7's path rule: FAIL when the git-file ledger read is not at the registered path (or is in no
 * repository at all); WARN when the registration predates the field. Nothing for any other ledger or
 * for a phase-1 registration.
 */
export function ledgerPathFindings(reg: SignedRecord<AnyRegistration>, walked: string | null | undefined): PathFindings {
  const out: PathFindings = { fails: [], warns: [], notes: [] };
  if (!isRegistrationV2(reg) || !isBuiltinGitFile(reg.record.plugins.ledger)) return out;
  const registered = reg.record.ledgerPath;
  if (registered === undefined) {
    out.warns.push("the registration does not record the git-file ledger's path (registrations made before this field, only test fixtures, lack it): where the ledger lives is not bound, so a copy kept elsewhere would be read; register again to bind it");
    return out;
  }
  if (walked === undefined || walked === null) out.fails.push(`the registration places the git-file ledger at ${registered} in a git repository, but the ledger read is in none: verify in a clone of the audit repository`);
  else if (walked !== registered) out.fails.push(`the ledger read is ${walked}, but the registration places it at ${registered}: verify with the registered audit_dir, window and file, in the repository the audit was registered in`);
  return out;
}

export interface LedgerGate {
  /** The ledger's integrity report (null: the check threw, see `fails`). */
  integrity: LedgerIntegrityReport | null;
  /** What makes check 7 FAIL: the integrity check's findings when it is not ok, and the path rule. */
  fails: string[];
  /** What makes check 7 WARN on the path (a registration without `ledgerPath`). */
  warns: string[];
}

/**
 * The integrity walk and the path rule for a built-in git-file ledger, as check 7 judges them, for
 * status (P4: status never prints CERTIFIED where verify FAILs check 7). The walk is local: git
 * objects only. Null when the ledger is not git-file or has no integrity check.
 */
export async function gitFileLedgerGate(ledger: Ledger, reg: SignedRecord<AnyRegistration>): Promise<LedgerGate | null> {
  if (ledger.name !== "git-file" || !ledger.verifyIntegrity) return null;
  let integrity: LedgerIntegrityReport;
  try {
    integrity = await ledger.verifyIntegrity();
  } catch (e) {
    return { integrity: null, fails: [`ledger ${ledger.name}: verifyIntegrity failed: ${(e as Error).message}`], warns: [] };
  }
  const path = ledgerPathFindings(reg, integrity.location);
  return { integrity, fails: [...(integrity.ok ? [] : integrity.findings), ...path.fails], warns: path.warns };
}

/**
 * Why status withholds CERTIFIED although the sequence certifies (P4): what would make verify FAIL
 * check 7. The git-file ledger's integrity walk and path (`gate`), counted verdicts below the
 * registered minimum, and counted verdicts without a valid signature under `require_signed`.
 */
export function certificateWithheld(i: { gate: LedgerGate | null; below: number; unsigned: number }): string[] {
  const out: string[] = [];
  if (i.gate?.fails.length) out.push("the ledger's integrity check FAILs");
  if (i.below) out.push(`${i.below} counted verdict(s) below the registered provenance`);
  if (i.unsigned) out.push(`${i.unsigned} counted verdict(s) without a valid signature`);
  return out;
}
