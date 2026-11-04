import { PROVENANCE_LEVELS, provenanceRank, type ProvenanceLevel, type VerdictEvent } from "../../sdk/ledger.js";
import { isRegistrationV2, type AnyRegistration, type PluginIdentity, type SignedRecord } from "../records.js";
import { allowedSignersOf, type AllowedSigner } from "./allowed-signers.js";
import { foreign, said, type Line } from "../said.js";
import { VERDICT_SIGNATURE_SOURCE, attestVerdicts, lineChange, withoutSignatureFields, type VerdictSignatureCheck } from "./verifier.js";
import type { VerdictBinding } from "./verdict-payload.js";

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
export function verdictRuleFailures(v: VerdictEvent, rules: VerdictRules): Line[] {
  const out: Line[] = [];
  const level = provenanceOfEvent(v);
  const where = said`verdict on draw #${v.draw} (${lineChange(v)})`;
  if (provenanceRank(level) < provenanceRank(rules.minProvenance)) out.push(said`${where} is ${provenanceLabel(level)}; the registration requires ${provenanceLabel(rules.minProvenance)}`);
  if (rules.requireSigned && !(v.provenance?.source === VERDICT_SIGNATURE_SOURCE && provenanceRank(level) >= provenanceRank("account")))
    out.push(said`${where} carries no valid signature by the registered key of reviewer ${foreign("the reviewer the ledger line names", v.reviewer)}; the registration requires signed verdicts (require_signed)`);
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

/**
 * True when the registration counts only verdicts its reviewers signed with their registered keys
 * (P4, second-pass review finding 2): keys are registered, and `require_signed` or a minimum above
 * `self-asserted` is set. Then a line without a valid registered signature is ineligible: it is
 * ignored with its reason, as a bot's label is, and the first eligible signed verdict counts.
 */
export function signaturesRequired(reg: SignedRecord<AnyRegistration>): boolean {
  if (!isRegistrationV2(reg)) return false;
  const v = reg.record.verdicts;
  return registeredSigners(reg).length > 0 && (v.require_signed === true || provenanceRank(v.minProvenance) > provenanceRank("self-asserted"));
}

export interface CountingInput {
  /** The registration the verdicts are counted for: its digest and allowed signers. */
  registration: SignedRecord<AnyRegistration>;
  /**
   * The audit each verdict signature must be made for (the registration, the frozen manifest and
   * the seed, P4): what verify has already checked, or what status and record read from the audit's
   * files. Without it no signature can be checked, and none counts.
   */
  binding: VerdictBinding | null;
  /** The ledger read is the registered built-in git-file one: only then do verdict signatures count. */
  verifiesSignatures: boolean;
  /** The most the registered ledger's verdicts can count as. */
  ceiling?: ProvenanceLevel;
  /** The ledger's name, for the notes. */
  ledger: string;
}

export interface CountedVerdicts {
  verdicts: VerdictEvent[];
  /** A ledger's claim above its ceiling (check 7 WARN). Lines (src/core/said.ts): what a ledger line carries is foreign text in them (S1). */
  notes: Line[];
  findings: Line[];
  warnings: Line[];
  /**
   * Why a verdict (one of `verdicts`) cannot count under the registration's signing rules, or null
   * (P4). Status, check 7 and `record` pass it to `computeStatus` / `classifyVerdicts`, so the same
   * lines are ignored everywhere.
   */
  ineligible: (v: VerdictEvent) => Line | null;
}

const RULE = "the registration counts only verdicts signed with their reviewer's registered key";

/**
 * The signing rule that makes an unsigned line ineligible (`signaturesRequired`), with the setting
 * that imposes it, for `record`'s message; null when unsigned lines count as self-asserted.
 */
export function signingRequirement(reg: SignedRecord<AnyRegistration>): string | null {
  if (!signaturesRequired(reg) || !isRegistrationV2(reg)) return null;
  const v = reg.record.verdicts;
  return `${RULE} (${v.require_signed === true ? "require_signed is set" : `min_provenance is ${v.minProvenance}`})`;
}

const withoutClaim = ({ provenance: _claimed, ...v }: VerdictEvent): VerdictEvent => v;

/** The audit a verdict signature is checked for, from the registration's digest, the manifest's and the beacon (verify passes what it has verified; status and record what the audit's files say). */
export const auditBinding = (registrationSha256: string, manifestSha256: string, beacon: { round: number; randomness: string }): VerdictBinding => ({
  registrationSha256,
  manifestSha256,
  beaconRound: beacon.round,
  beaconRandomness: beacon.randomness,
});

/**
 * The verdicts as status and check 7 count them. With the registered git-file ledger, each verdict's
 * provenance is what its own signature gives it (attestVerdicts), checked against the audit it must
 * be signed for and the allowed signers; any other ledger's verdicts keep the provenance the ledger
 * reports, and any signature fields they carry are ignored. Either way, nothing counts above the
 * ceiling. Under a registration that requires signatures, every line without a valid registered
 * signature is ineligible (`ineligible`).
 */
export function countedVerdicts(read: readonly VerdictEvent[], input: CountingInput): CountedVerdicts {
  const required = signaturesRequired(input.registration);
  let events: VerdictEvent[];
  let checks: (VerdictSignatureCheck | null)[] = [];
  let findings: Line[] = [];
  let warnings: Line[] = [];
  if (input.verifiesSignatures && input.binding) {
    ({ events, checks, findings, warnings } = attestVerdicts(read, input.binding, registeredSigners(input.registration), { quiet: required }));
  } else events = read.map((v) => withoutSignatureFields(input.verifiesSignatures ? withoutClaim(v) : v));
  const capped = capProvenance(events, input.ceiling, input.ledger);
  const reasons = new Map<VerdictEvent, Line>();
  if (required)
    capped.verdicts.forEach((v, i) => {
      const check = checks[i];
      if (!input.verifiesSignatures) reasons.set(v, `the ledger read is not the registered built-in git-file, so no verdict signature counts, and ${RULE}`);
      else if (!check) reasons.set(v, `its signature could not be checked for this audit, and ${RULE}`);
      else if (check.state !== "signed") reasons.set(v, said`${check.detail}, and ${RULE}`);
    });
  return { verdicts: capped.verdicts, notes: capped.notes, findings, warnings, ineligible: (v) => reasons.get(v) ?? null };
}

/**
 * The verdict that already counts for a change, as status and check 7 would count it (`record`'s
 * check before it appends another, P4): same protocol, an eligible reviewer, and, under a
 * registration that requires signatures, a valid registered signature. An unsigned line an assistant
 * appended first no longer stands in the way of the reviewer's signed one.
 */
export function countingVerdictFor(read: readonly VerdictEvent[], changeId: string, input: CountingInput & { protocolSha256: string; eligible: (v: VerdictEvent) => boolean }): VerdictEvent | undefined {
  const c = countedVerdicts(read, input);
  return c.verdicts.find((v) => v.changeId === changeId && v.protocolSha256 === input.protocolSha256 && input.eligible(v) && !c.ineligible(v));
}
