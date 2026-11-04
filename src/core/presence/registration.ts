import { provenanceRank, type ProvenanceLevel } from "../../sdk/ledger.js";
import { allowedSignersOf, describeSigner, isAllowedSignerEntry, parseAllowedSigner } from "./allowed-signers.js";
import { provenanceLabel } from "./provenance.js";
import { reachableProvenance } from "./verifier.js";

/** What `register` knows when it fixes the verdict rules (FR3.8, FR9.1, FR9.3, FR9.4). */
export interface VerdictRulesInput {
  ledger: string;
  /** The ledger is one whose verdict signatures pr-rla checks itself (git-file). */
  verifiesSignatures: boolean;
  /** The level the ledger's verdicts carry: the default minimum (FR3.8). */
  ledgerLevel: ProvenanceLevel;
  /** The most its verdicts can count as (src/ledger-traits.ts). */
  ledgerCeiling: ProvenanceLevel;
  /** `verdicts.min_provenance`, or null for the default. */
  minProvenance: ProvenanceLevel | null;
  /** `verdicts.reviewers`. */
  reviewers: string[] | null;
  /** The git-file option `require_signed`. */
  requireSigned: boolean;
}

/** The registration's `verdicts` (contracts.md §5). */
export interface RegisteredVerdicts {
  minProvenance: ProvenanceLevel;
  reviewers: string[] | null;
  require_signed?: boolean;
}

const SK_TYPES = "sk-ssh-ed25519@openssh.com or sk-ecdsa-sha2-nistp256@openssh.com";

/**
 * The verdict rules a registration fixes, or an Error saying why no verdict could ever meet them.
 * The default minimum is the ledger's own level (`account` with an issue ledger, `self-asserted`
 * with git-file); git-file reaches `account` only with registered SSH keys and `presence` only with
 * a registered security key; SSH keys count only with git-file.
 */
export function registeredVerdicts(i: VerdictRulesInput): RegisteredVerdicts {
  const signers = allowedSignersOf(i.reviewers);
  if (signers.length && !i.verifiesSignatures)
    throw new Error(`verdicts.reviewers lists SSH keys (${signers.map(describeSigner).join(", ")}), but ledger ${i.ledger} reads accounts, not signed commits; keys count only with the git-file ledger, so register logins or "id:<account id>" instead`);
  const requireSigned = i.verifiesSignatures && i.requireSigned;
  if (requireSigned && !signers.length)
    throw new Error(`ledger ${i.ledger}: require_signed needs the reviewers' SSH keys in verdicts.reviewers (allowed-signers lines, "<principal> <keytype> <base64 key>"), or no verdict could count`);
  const reachable = i.verifiesSignatures ? reachableProvenance(signers) : i.ledgerCeiling;
  const minProvenance = i.minProvenance ?? i.ledgerLevel;
  if (provenanceRank(minProvenance) > provenanceRank(reachable)) {
    if (i.verifiesSignatures && !signers.length)
      throw new Error(
        `verdicts.min_provenance is ${minProvenance}, but ledger ${i.ledger} records self-asserted verdicts, so no verdict could count; register the reviewers' SSH keys in verdicts.reviewers and sign verdict commits (git commit -S), or use an issue ledger (github-issues, gitlab-issues) for account provenance`,
      );
    if (i.verifiesSignatures) throw new Error(`verdicts.min_provenance is presence, but no key in verdicts.reviewers is a FIDO security key (${SK_TYPES}), so no verdict could reach presence`);
    throw new Error(
      `verdicts.min_provenance is ${minProvenance}, but ledger ${i.ledger} records ${i.ledgerLevel} verdicts, so no verdict could count; ${minProvenance === "presence" ? "presence needs the git-file ledger, with verdict commits signed by registered security keys" : "use an issue ledger (github-issues, gitlab-issues) for account provenance"}`,
    );
  }
  return { minProvenance, reviewers: i.reviewers, ...(requireSigned ? { require_signed: true } : {}) };
}

/** `verdict provenance … · reviewers …` as `register` prints it: keys by principal, type and fingerprint. */
export function verdictsSummary(v: RegisteredVerdicts): string {
  const reviewers = v.reviewers?.map((r) => (isAllowedSignerEntry(r) ? describeSigner(parseAllowedSigner(r)) : r));
  return `verdict provenance ${provenanceLabel(v.minProvenance)}${v.require_signed ? " · signed verdict commits required (require_signed)" : ""}${reviewers ? ` · reviewers ${reviewers.join(", ")}` : ""}`;
}

/** True when the registered keys can give `presence` (a security key is among them): the T16 limit is then printed. */
export const presenceReachable = (reviewers: readonly string[] | null | undefined) => reachableProvenance(allowedSignersOf(reviewers)) === "presence";
