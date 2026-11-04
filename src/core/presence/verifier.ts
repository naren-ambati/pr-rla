import type { ProvenanceLevel, VerdictEvent, VerdictProvenance } from "../../sdk/ledger.js";
import { signersFor, type AllowedSigner } from "./allowed-signers.js";
import { signatureFormat, splitCommitSignature } from "./commit.js";
import { verifySshsig, type SecurityKeySignature } from "./sshsig.js";

/**
 * PresenceVerifier (functional-design.md §U9): the provenance of git-file verdict lines from the
 * signatures on the commits that added them. Pure: the git-file ledger reads the repository and
 * hands over raw commit objects; nothing here touches the disk, a process or the network.
 *
 * A line added by a commit that its registered reviewer signed (SSHSIG, namespace `git`, a key in
 * `verdicts.reviewers` whose principal is the line's `reviewer`) is `account`; with a FIDO
 * security key whose signature has the user-presence flag set, `presence`. Every other line is
 * `self-asserted`, whatever the line itself claims.
 */

/** Git signs commits in this SSHSIG namespace. */
export const GIT_NAMESPACE = "git";

export type CommitSignatureState = "unsigned" | "unsupported" | "invalid" | "unlisted" | "signed";

export interface CommitSignatureCheck {
  commit: string;
  state: CommitSignatureState;
  /** One line saying why. */
  detail: string;
  /** The key the signature names, once its blob parses. */
  key?: { type: string; fingerprint: string; securityKey: boolean };
  /** `signed`: the registered principals holding the key. */
  principals?: string[];
  /** Security-key signatures: the signed flags and counter. */
  sk?: SecurityKeySignature;
}

const short = (sha: string) => sha.slice(0, 10);

/** Checks the signature on one raw commit object against the allowed signers. */
export function checkCommitSignature(commit: string, raw: Uint8Array, signers: readonly AllowedSigner[]): CommitSignatureCheck {
  const { payload, signature } = splitCommitSignature(raw);
  if (signature === null) return { commit, state: "unsigned", detail: "not signed" };
  const format = signatureFormat(signature);
  if (format !== "ssh") return { commit, state: "unsupported", detail: `signed with ${format === "openpgp" ? "OpenPGP" : format === "x509" ? "X.509" : "an unknown format"}; only SSH signatures (gpg.format=ssh) are checked` };
  const v = verifySshsig(signature, payload, GIT_NAMESPACE);
  const key = v.key ? { type: v.key.type, fingerprint: v.key.fingerprint, securityKey: v.key.securityKey } : undefined;
  if (!v.ok) return { commit, state: "invalid", detail: `its SSH signature does not verify: ${v.problem}`, ...(key ? { key } : {}) };
  const holders = signersFor(v.key!, signers, GIT_NAMESPACE);
  if (!holders.length) return { commit, state: "unlisted", detail: `signed by key ${v.key!.fingerprint} (${v.key!.type}), which no registered reviewer holds`, key: key! };
  const principals = [...new Set(holders.flatMap((h) => h.principals))];
  const touch = v.sk ? (v.sk.userPresent ? " with the user-presence flag" : " without the user-presence flag (no touch)") : "";
  return { commit, state: "signed", detail: `signed by ${principals.join(", ")}'s ${v.key!.type} key ${v.key!.fingerprint}${touch}`, key: key!, principals, ...(v.sk ? { sk: v.sk } : {}) };
}

/** The level a verdict line takes from its commit's signature, and why it is lower than the signature suggests (a reviewer who did not sign). */
export function lineProvenance(check: CommitSignatureCheck | null, reviewer: string): { provenance?: VerdictProvenance; mismatch?: string } {
  if (!check) return {};
  const unattested: VerdictProvenance = { level: "self-asserted", source: "git-commit", eventId: check.commit };
  if (check.state !== "signed") return { provenance: unattested };
  const signer = check.principals!.find((p) => p.toLowerCase() === reviewer.trim().toLowerCase());
  if (!signer) return { provenance: unattested, mismatch: `names reviewer ${reviewer} but commit ${short(check.commit)} was signed by ${check.principals!.join(", ")}` };
  const level: ProvenanceLevel = check.key!.securityKey && check.sk?.userPresent ? "presence" : "account";
  return {
    provenance: { level, source: "git-signed-commit", signer, eventId: check.commit, keyFingerprint: check.key!.fingerprint, ...(check.sk ? { counter: check.sk.counter } : {}) },
  };
}

/** One verdict line of the ledger file and the commit that added it (null: not committed yet). */
export interface VerdictLine {
  event: VerdictEvent;
  commit: string | null;
}

export interface SignedVerdictAnalysis {
  /** The verdicts, in file order, each with the provenance its commit gives it (a level the line claims itself is discarded). */
  events: VerdictEvent[];
  /** Informational: unsigned commits, security-key signatures without the user-presence flag. */
  findings: string[];
  /** Check 7 WARNs: invalid or unknown signatures, a signer who is not the named reviewer, a decreasing counter. */
  warnings: string[];
  /** Each commit's check, by commit SHA. */
  commits: Map<string, CommitSignatureCheck>;
}

/**
 * The provenance of every verdict line, from the raw commit objects that added them. A commit
 * missing from `commits` (it could not be read) counts as an invalid signature. A security key's
 * signature counter going down, in file order, is a WARN, never a FAIL: authenticators differ
 * in counter behaviour (some always report 0, OpenSSH's test middleware a constant).
 */
export function analyzeSignedVerdicts(lines: readonly VerdictLine[], commits: ReadonlyMap<string, Uint8Array>, signers: readonly AllowedSigner[]): SignedVerdictAnalysis {
  const checks = new Map<string, CommitSignatureCheck>();
  const drawsOf = new Map<string, number[]>();
  const events: VerdictEvent[] = [];
  const warnings: string[] = [];
  const findings: string[] = [];
  const highest = new Map<string, { counter: number; commit: string }>();
  const counted = new Set<string>();
  for (const { event, commit } of lines) {
    const { provenance: _claimed, ...rest } = event;
    let check: CommitSignatureCheck | null = null;
    if (commit) {
      check = checks.get(commit) ?? null;
      if (!check) {
        const raw = commits.get(commit);
        check = raw ? checkCommitSignature(commit, raw, signers) : { commit, state: "invalid", detail: "the commit object could not be read" };
        checks.set(commit, check);
      }
      drawsOf.set(commit, [...(drawsOf.get(commit) ?? []), event.draw]);
    }
    const { provenance, mismatch } = lineProvenance(check, event.reviewer);
    if (mismatch) warnings.push(`verdict on draw #${event.draw} ${mismatch}: self-asserted`);
    events.push(provenance ? { ...rest, provenance } : rest);
    // The counter, once per signing commit, in file order: per key, it should never go down.
    if (check?.state === "signed" && check.sk && !counted.has(check.commit)) {
      counted.add(check.commit);
      const fp = check.key!.fingerprint;
      const prev = highest.get(fp);
      if (prev && check.sk.counter < prev.counter)
        warnings.push(
          `security key ${fp} (${check.principals!.join(", ")}): its signature counter went down from ${prev.counter} (commit ${short(prev.commit)}) to ${check.sk.counter} (commit ${short(check.commit)}); authenticators differ in counter behaviour, so this is a warning, not a failure, but a cloned key would show it`,
        );
      if (!prev || check.sk.counter > prev.counter) highest.set(fp, { counter: check.sk.counter, commit: check.commit });
    }
  }
  for (const [commit, check] of checks) {
    const ds = [...new Set(drawsOf.get(commit))];
    const draws = `draw${ds.length > 1 ? "s" : ""} ${ds.map((d) => `#${d}`).join(", ")}`;
    const line = `commit ${short(commit)} (${draws}): ${check.detail}`;
    if (check.state === "unsigned") findings.push(`${line}: self-asserted`);
    else if (check.state === "signed") {
      if (check.sk && !check.sk.userPresent) findings.push(`${line}: account, not presence`);
    } else warnings.push(`${line}: self-asserted`);
  }
  return { events, findings, warnings, commits: checks };
}

/** The highest level verdicts can reach with these registered keys: none, software keys only, or a security key among them. */
export function reachableProvenance(signers: readonly AllowedSigner[]): ProvenanceLevel {
  if (!signers.length) return "self-asserted";
  return signers.some((s) => s.key.securityKey) ? "presence" : "account";
}

/** What `record` tells a git-file reviewer when keys are registered. */
export function signedCommitHint(signers: readonly AllowedSigner[]): string | null {
  if (!signers.length) return null;
  return `sign that commit with your registered key (git commit -S, with gpg.format=ssh and user.signingkey set), and record under your registered principal (--reviewer): a verdict counts as ${reachableProvenance(signers) === "presence" ? "account, or presence with a security key and its user-presence flag set," : "account"} only when its commit is signed by the reviewer it names`;
}
