import { PROVENANCE_LEVELS, provenanceRank, type ProvenanceLevel, type VerdictEvent } from "../../sdk/ledger.js";

/**
 * How provenance levels are printed and enforced (FR3.8, FR9.1, FR9.4, FR9.6). Pure.
 *
 * `presence` means pr-rla verified a FIDO user-presence flag in the signature. It does not mean a
 * person touched hardware: a software-emulated authenticator sets the same flag (threat T16), and
 * pr-rla does not check that a registered key is hardware-backed. So the level is never printed
 * without saying so.
 */
export const PRESENCE_LABEL = "presence (user-presence flag verified; key hardware not attested)";

/** The T16 limit, printed wherever a presence verdict or a presence minimum is shown. */
export const PRESENCE_LIMIT =
  "presence relies on each reviewer having registered a hardware-backed security key, which pr-rla does not check: a software-emulated authenticator can set the user-presence flag too (threat T16)";

/** The level as every certificate and status line prints it. */
export function provenanceLabel(level: ProvenanceLevel): string {
  return level === "presence" ? PRESENCE_LABEL : level;
}

export const provenanceOfEvent = (v: VerdictEvent): ProvenanceLevel => v.provenance?.level ?? "self-asserted";

/** What the registration requires of every counted verdict. */
export interface VerdictRules {
  minProvenance: ProvenanceLevel;
  /** git-file `require_signed` (FR9.1): a counted verdict must come from a commit its registered reviewer signed. */
  requireSigned?: boolean;
}

/** `registered minimum: account · signed verdict commits required`, for status and verify. */
export function rulesLine(rules: VerdictRules): string {
  return `registered minimum: ${provenanceLabel(rules.minProvenance)}${rules.requireSigned ? " · signed verdict commits required (require_signed)" : ""}`;
}

/** Why a counted verdict fails check 7 under the registered rules (empty: it meets them). */
export function verdictRuleFailures(v: VerdictEvent, rules: VerdictRules): string[] {
  const out: string[] = [];
  const level = provenanceOfEvent(v);
  const where = `verdict on draw #${v.draw} (${v.changeId})`;
  if (provenanceRank(level) < provenanceRank(rules.minProvenance)) out.push(`${where} is ${level}; the registration requires ${rules.minProvenance}`);
  if (rules.requireSigned && !(v.provenance?.source === "git-signed-commit" && provenanceRank(level) >= provenanceRank("account"))) {
    const commit = v.provenance?.eventId;
    out.push(`${where} ${commit ? `was added in commit ${commit.slice(0, 10)}, which its registered reviewer did not sign` : "is not committed"}; the registration requires signed verdict commits (require_signed)`);
  }
  return out;
}

/**
 * Lowers any verdict claiming more than the ledger can attest. `presence` is granted only by pr-rla's
 * own signature check (the git-file ledger); issue-tracker ledgers top out at `account`, because a
 * label event carries no presence evidence.
 */
export function capProvenance(verdicts: readonly VerdictEvent[], ceiling: ProvenanceLevel | undefined, ledger: string): { verdicts: VerdictEvent[]; notes: string[] } {
  if (!ceiling || ceiling === PROVENANCE_LEVELS[PROVENANCE_LEVELS.length - 1]) return { verdicts: [...verdicts], notes: [] };
  const notes: string[] = [];
  const out = verdicts.map((v) => {
    if (!v.provenance || provenanceRank(v.provenance.level) <= provenanceRank(ceiling)) return v;
    notes.push(`ledger ${ledger} reported ${v.provenance.level} for the verdict on draw #${v.draw}, more than it can attest; counted as ${ceiling}`);
    return { ...v, provenance: { ...v.provenance, level: ceiling } };
  });
  return { verdicts: out, notes };
}
