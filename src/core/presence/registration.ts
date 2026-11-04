import { provenanceRank, type ProvenanceLevel } from "../../sdk/ledger.js";
import { allowedSignersOf, describeSigner, looksLikeAllowedSigner } from "./allowed-signers.js";
import { provenanceLabel } from "./provenance.js";
import { reachableProvenance } from "./verifier.js";

/** What `register` knows when it fixes the verdict rules (FR3.8, FR9.1, FR9.3, FR9.4). */
export interface VerdictRulesInput {
  ledger: string;
  /** The ledger is the built-in git-file, the only one whose verdict signatures pr-rla checks. */
  verifiesSignatures: boolean;
  /** The level the ledger's verdicts carry: the default minimum (FR3.8). */
  ledgerLevel: ProvenanceLevel;
  /** The most its verdicts can count as (src/ledger-traits.ts). */
  ledgerCeiling: ProvenanceLevel;
  /** `verdicts.min_provenance`, or null for the default. */
  minProvenance: ProvenanceLevel | null;
  /** `verdicts.reviewers`: logins and `id:<account id>` entries (who may record a verdict that counts). */
  reviewers: string[] | null;
  /** `verdicts.allowed_signers`: the reviewers' SSH keys, allowed-signers lines (whose signatures give provenance). */
  allowedSigners: string[] | null;
  /** The ledger option `require_signed`. */
  requireSigned: boolean;
}

/** The registration's `verdicts` (contracts.md §5). */
export interface RegisteredVerdicts {
  minProvenance: ProvenanceLevel;
  reviewers: string[] | null;
  require_signed?: boolean;
  allowed_signers?: string[];
}

const SK_TYPES = "sk-ssh-ed25519@openssh.com or sk-ecdsa-sha2-nistp256@openssh.com";

/**
 * The verdict rules a registration fixes, or an Error saying why no verdict could ever meet them.
 * The default minimum is the ledger's own level (`account` with an issue ledger, `self-asserted`
 * with git-file); git-file reaches `account` only with registered SSH keys and `presence` only with
 * a registered security key; keys and `require_signed` count only with the built-in git-file.
 */
export function registeredVerdicts(i: VerdictRulesInput): RegisteredVerdicts {
  const signers = allowedSignersOf(i.allowedSigners);
  if (signers.length && !i.verifiesSignatures)
    throw new Error(`verdicts.allowed_signers lists SSH keys (${signers.map(describeSigner).join(", ")}), but ledger ${i.ledger} reads accounts, not signed verdicts; keys count only with the built-in git-file ledger`);
  if (i.requireSigned && !i.verifiesSignatures) throw new Error(`require_signed needs the built-in git-file ledger, whose verdict signatures pr-rla checks itself; ledger ${i.ledger} cannot meet it`);
  if (i.requireSigned && !signers.length)
    throw new Error(`ledger ${i.ledger}: require_signed needs the reviewers' SSH keys in verdicts.allowed_signers (allowed-signers lines, "<principal> <keytype> <base64 key>"), or no verdict could count`);
  const reachable = i.verifiesSignatures ? reachableProvenance(signers) : i.ledgerCeiling;
  const minProvenance = i.minProvenance ?? i.ledgerLevel;
  const min = provenanceLabel(minProvenance);
  if (provenanceRank(minProvenance) > provenanceRank(reachable)) {
    if (i.verifiesSignatures && !signers.length)
      throw new Error(
        `verdicts.min_provenance is ${min}, but ledger ${i.ledger} records self-asserted verdicts, so no verdict could count; register the reviewers' SSH keys in verdicts.allowed_signers and sign each verdict (pr-rla record --sign), or use an issue ledger (github-issues, gitlab-issues) for account provenance`,
      );
    if (i.verifiesSignatures) throw new Error(`verdicts.min_provenance is ${min}, but no key in verdicts.allowed_signers is a FIDO security key (${SK_TYPES}), so no verdict could reach it`);
    throw new Error(
      `verdicts.min_provenance is ${min}, but ledger ${i.ledger} records ${provenanceLabel(i.ledgerLevel)} verdicts, so no verdict could count; ${minProvenance === "presence" ? "it needs the git-file ledger, with each verdict signed by a registered security key" : "use an issue ledger (github-issues, gitlab-issues) for account provenance"}`,
    );
  }
  return {
    minProvenance,
    reviewers: i.reviewers,
    ...(i.requireSigned ? { require_signed: true } : {}),
    ...(signers.length ? { allowed_signers: signers.map((s) => s.line).sort() } : {}),
  };
}

/** What `register` warns about in rules it accepts: keys that enforce nothing, keys among the reviewer names, a key holder who may not record. */
export function verdictRuleWarnings(i: VerdictRulesInput, v: RegisteredVerdicts): string[] {
  const out: string[] = [];
  const signers = allowedSignersOf(v.allowed_signers);
  if (signers.length && !v.require_signed && v.minProvenance === "self-asserted")
    out.push("verdicts.allowed_signers registers SSH keys, but neither require_signed nor a min_provenance above self-asserted is set, so an unsigned verdict still counts (check 7 only notes it); set require_signed: true or min_provenance: account");
  for (const r of i.reviewers ?? [])
    if (looksLikeAllowedSigner(r)) out.push(`verdicts.reviewers entry ${JSON.stringify(r.length > 60 ? `${r.slice(0, 57)}...` : r)} is read as a reviewer's name; SSH keys belong in verdicts.allowed_signers`);
  if (v.reviewers) {
    const names = new Set(v.reviewers.map((r) => r.toLowerCase()));
    for (const s of signers) if (!names.has(s.principals[0]!.toLowerCase())) out.push(`allowed signer ${s.principals[0]} is not in verdicts.reviewers, so a verdict they sign is not counted`);
  }
  return out;
}

/** `verdict provenance … · reviewers … · keys …` as `register` prints it: keys by principal, type and fingerprint. */
export function verdictsSummary(v: RegisteredVerdicts): string {
  const keys = allowedSignersOf(v.allowed_signers).map(describeSigner);
  return `verdict provenance ${provenanceLabel(v.minProvenance)}${v.require_signed ? " · signed verdicts required (require_signed)" : ""}${v.reviewers ? ` · reviewers ${v.reviewers.join(", ")}` : ""}${keys.length ? ` · keys ${keys.join(", ")}` : ""}`;
}

/** True when the registered keys can give `presence` (a security key is among them): the T16 limit is then printed. */
export const presenceReachable = (allowedSigners: readonly string[] | null | undefined) => reachableProvenance(allowedSignersOf(allowedSigners)) === "presence";
