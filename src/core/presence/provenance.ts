import { PROVENANCE_LEVELS, provenanceRank, type ProvenanceLevel, type VerdictEvent } from "../../sdk/ledger.js";
import { isRegistrationV2, type AnyRegistration, type PluginIdentity, type SignedRecord } from "../records.js";
import { allowedSignersOf, type AllowedSigner } from "./allowed-signers.js";
import { VERDICT_SIGNATURE_SOURCE, attestVerdicts, withoutSignatureFields } from "./verifier.js";

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
  /** `require_signed` (FR9.1): a counted verdict must carry a valid signature by the registered key of the reviewer it names. */
  requireSigned?: boolean;
}

/** `registered minimum: account · signed verdicts required`, for status and verify. */
export function rulesLine(rules: VerdictRules): string {
  return `registered minimum: ${provenanceLabel(rules.minProvenance)}${rules.requireSigned ? " · signed verdicts required (require_signed)" : ""}`;
}

/** Why a counted verdict fails check 7 under the registered rules (empty: it meets them). */
export function verdictRuleFailures(v: VerdictEvent, rules: VerdictRules): string[] {
  const out: string[] = [];
  const level = provenanceOfEvent(v);
  const where = `verdict on draw #${v.draw} (${v.changeId})`;
  if (provenanceRank(level) < provenanceRank(rules.minProvenance)) out.push(`${where} is ${provenanceLabel(level)}; the registration requires ${provenanceLabel(rules.minProvenance)}`);
  if (rules.requireSigned && !(v.provenance?.source === VERDICT_SIGNATURE_SOURCE && provenanceRank(level) >= provenanceRank("account")))
    out.push(`${where} carries no valid signature by the registered key of reviewer ${v.reviewer}; the registration requires signed verdicts (require_signed)`);
  return out;
}

/**
 * Lowers any verdict claiming more than the ledger can attest. `presence` is granted only by pr-rla's
 * own check of a verdict's signature (with the git-file ledger); issue-tracker ledgers top out at
 * `account`, because a label event carries no presence evidence.
 */
export function capProvenance(verdicts: readonly VerdictEvent[], ceiling: ProvenanceLevel | undefined, ledger: string): { verdicts: VerdictEvent[]; notes: string[] } {
  if (!ceiling || ceiling === PROVENANCE_LEVELS[PROVENANCE_LEVELS.length - 1]) return { verdicts: [...verdicts], notes: [] };
  const notes: string[] = [];
  const out = verdicts.map((v) => {
    if (!v.provenance || provenanceRank(v.provenance.level) <= provenanceRank(ceiling)) return v;
    notes.push(`ledger ${ledger} reported ${provenanceLabel(v.provenance.level)} for the verdict on draw #${v.draw}, more than it can attest; counted as ${provenanceLabel(ceiling)}`);
    return { ...v, provenance: { ...v.provenance, level: ceiling } };
  });
  return { verdicts: out, notes };
}

/** True when verdict signatures count for this registered ledger: only the built-in git-file, whose lines pr-rla reads itself. */
export const signaturesCountFor = (ledger: Pick<PluginIdentity, "name" | "source"> | null | undefined): boolean => !!ledger && ledger.source === "builtin" && ledger.name === "git-file";

/** The allowed signers a registration fixes (none for a phase-1 registration). */
export function registeredSigners(reg: SignedRecord<AnyRegistration>): AllowedSigner[] {
  return isRegistrationV2(reg) ? allowedSignersOf(reg.record.verdicts.allowed_signers) : [];
}

export interface CountingInput {
  /** The registration the verdicts are counted for: its digest and allowed signers. */
  registration: SignedRecord<AnyRegistration>;
  /** The ledger read is the registered built-in git-file one: only then do verdict signatures count. */
  verifiesSignatures: boolean;
  /** The most the registered ledger's verdicts can count as. */
  ceiling?: ProvenanceLevel;
  /** The ledger's name, for the notes. */
  ledger: string;
}

export interface CountedVerdicts {
  verdicts: VerdictEvent[];
  /** A ledger's claim above its ceiling (check 7 WARN). */
  notes: string[];
  findings: string[];
  warnings: string[];
}

/**
 * The verdicts as status and check 7 count them. With the registered git-file ledger, each verdict's
 * provenance is what its own signature gives it (attestVerdicts), checked against the registration's
 * digest and allowed signers; any other ledger's verdicts keep the provenance the ledger reports,
 * and any signature fields they carry are ignored. Either way, nothing counts above the ceiling.
 */
export function countedVerdicts(read: readonly VerdictEvent[], input: CountingInput): CountedVerdicts {
  let events: VerdictEvent[];
  let findings: string[] = [];
  let warnings: string[] = [];
  if (input.verifiesSignatures) {
    const a = attestVerdicts(read, input.registration.sha256, registeredSigners(input.registration));
    ({ events, findings, warnings } = a);
  } else events = read.map(withoutSignatureFields);
  const capped = capProvenance(events, input.ceiling, input.ledger);
  return { verdicts: capped.verdicts, notes: capped.notes, findings, warnings };
}
