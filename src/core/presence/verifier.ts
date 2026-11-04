import type { ProvenanceLevel, VerdictEvent, VerdictProvenance } from "../../sdk/ledger.js";
import { signersFor, type AllowedSigner } from "./allowed-signers.js";
import { dearmorSshsig, verifySshsigBlob, type SecurityKeySignature } from "./sshsig.js";
import { VERDICT_NAMESPACE, VERDICT_PAYLOAD_V1, verdictPayload, verdictPayloadProblems, verdictPayloadV1, type VerdictBinding, type VerdictPayloadFields } from "./verdict-payload.js";

/**
 * PresenceVerifier (functional-design.md §U9, as changed after review): a verdict's provenance from
 * its own signature, and from nothing else. Pure: nothing here touches the disk, a process or the
 * network.
 *
 * A verdict line carries `sshsig`, an SSHSIG over the verdict's bytes (verdict-payload.ts) in
 * namespace `pr-rla-verdict@v1`, rebuilt from the line and the audit it is checked for: the
 * registration, the manifest and the seed (P4). Signed by the registered key of the reviewer it names: `account`;
 * by that reviewer's FIDO security key with the user-presence flag set: `presence`. Every other line
 * is `self-asserted`, whatever it claims. No line is credited to a git commit.
 */

/** `VerdictProvenance.source` of a verdict whose own signature pr-rla verified. */
export const VERDICT_SIGNATURE_SOURCE = "verdict-signature";

export type VerdictSignatureState = "unsigned" | "unreadable" | "other-registration" | "invalid" | "unlisted" | "mismatch" | "signed";

export interface VerdictSignatureCheck {
  state: VerdictSignatureState;
  /** One line saying why. */
  detail: string;
  /** The key the signature names, once its blob parses. */
  key?: { type: string; fingerprint: string; securityKey: boolean };
  /** `signed`: the registered principal holding the key (the verdict's reviewer). */
  principal?: string;
  /** Security-key signatures: the signed flags and counter. */
  sk?: SecurityKeySignature;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Checks one verdict's own signature against the audit it must be signed for (the registration, the
 * manifest and the seed: `binding`) and the registered allowed signers.
 */
export function checkVerdictSignature(v: VerdictEvent, binding: VerdictBinding, signers: readonly AllowedSigner[]): VerdictSignatureCheck {
  const { registrationSha256 } = binding;
  if (v.sshsig === undefined) return { state: "unsigned", detail: "carries no signature" };
  if (typeof v.sshsig !== "string" || !BASE64.test(v.sshsig)) return { state: "unreadable", detail: "has an sshsig field that is not base64" };
  if (v.registrationSha256 !== undefined && v.registrationSha256 !== registrationSha256)
    return { state: "other-registration", detail: `is signed for registration ${String(v.registrationSha256).slice(0, 12)}…, not this audit's ${registrationSha256.slice(0, 12)}…` };
  const fields = { ...binding, protocolSha256: v.protocolSha256, draw: v.draw, changeId: v.changeId, verdict: v.verdict, reviewer: v.reviewer, recordedAt: v.recordedAt } as VerdictPayloadFields;
  const problems = verdictPayloadProblems(fields);
  if (problems.length) return { state: "unreadable", detail: `cannot be checked: ${problems.join("; ")}` };
  const blob = new Uint8Array(Buffer.from(v.sshsig, "base64"));
  const s = verifySshsigBlob(blob, verdictPayload(fields), VERDICT_NAMESPACE);
  const key = s.key ? { type: s.key.type, fingerprint: s.key.fingerprint, securityKey: s.key.securityKey } : undefined;
  if (!s.ok && verifySshsigBlob(blob, verdictPayloadV1(fields), VERDICT_NAMESPACE).ok)
    return { state: "invalid", detail: `is signed over the ${VERDICT_PAYLOAD_V1} bytes, which name neither the manifest nor the seed and so could be signed before the seed was public; such signatures are refused: sign it again (pr-rla record --sign)`, ...(key ? { key } : {}) };
  if (!s.ok && /does not match the signed data/.test(s.problem ?? ""))
    return { state: "invalid", detail: `has a signature that does not verify for this audit (its registration, manifest and seed): ${s.problem}`, ...(key ? { key } : {}) };
  if (!s.ok) return { state: "invalid", detail: `has a signature that does not verify: ${s.problem}`, ...(key ? { key } : {}) };
  const holders = signersFor(s.key!, signers);
  const sk = s.sk ? { sk: s.sk } : {};
  if (!holders.length) return { state: "unlisted", detail: `is signed by key ${s.key!.fingerprint} (${s.key!.type}), which no registered reviewer holds`, key: key!, ...sk };
  const principals = holders.flatMap((h) => h.principals);
  // Exact, as `ssh-keygen -Y verify -I <reviewer>` matches: the registration refuses principals equal ignoring case.
  const principal = principals.find((p) => p === v.reviewer);
  if (!principal) return { state: "mismatch", detail: `names reviewer ${v.reviewer} but is signed by ${principals.join(", ")}'s key ${s.key!.fingerprint}`, key: key!, ...sk };
  const touch = s.sk ? (s.sk.userPresent ? " with the user-presence flag" : " without the user-presence flag (no touch)") : "";
  return { state: "signed", detail: `is signed by ${principal}'s ${s.key!.type} key ${s.key!.fingerprint}${touch}`, key: key!, principal, ...sk };
}

/** The level a verified signature gives: `presence` for a security key with UP set, else `account`. Absent unless `signed`. */
export function signatureProvenance(check: VerdictSignatureCheck): VerdictProvenance | undefined {
  if (check.state !== "signed") return undefined;
  const level: ProvenanceLevel = check.key!.securityKey && check.sk?.userPresent ? "presence" : "account";
  return { level, source: VERDICT_SIGNATURE_SOURCE, signer: check.principal!, keyFingerprint: check.key!.fingerprint, ...(check.sk ? { counter: check.sk.counter } : {}) };
}

/** A verdict without the signature fields its line carries. */
export function withoutSignatureFields(v: VerdictEvent): VerdictEvent {
  const { sshsig: _s, registrationSha256: _r, ...rest } = v;
  return rest;
}

export interface VerdictAttestation {
  /** The verdicts in ledger order, each with the provenance its own signature gives it (none: self-asserted). */
  events: VerdictEvent[];
  /** Each event's signature check, in the same order (null: no keys are registered, nothing was checked). */
  checks: (VerdictSignatureCheck | null)[];
  /** Informational: unsigned lines, security-key signatures without the user-presence flag. */
  findings: string[];
  /** Check 7 WARNs: unreadable, invalid or foreign signatures, an unlisted key, a signer who is not the named reviewer, a decreasing counter. */
  warnings: string[];
}

const where = (v: VerdictEvent) => `verdict on draw #${v.draw} (${v.changeId})`;
const drawList = (vs: readonly VerdictEvent[]) => vs.map((v) => `#${v.draw}`).join(", ");

/**
 * The provenance of every verdict from its own signature. A level a line claims for itself is
 * discarded. A security key's counter going down, in ledger order, is a WARN, never a FAIL:
 * authenticators differ (some always report 0, OpenSSH's test middleware a constant).
 *
 * `quiet` (P4): the caller reports every line without a valid registered signature itself (as an
 * ignored verdict, under a registration that requires signatures), so they are not noted here too.
 */
export function attestVerdicts(read: readonly VerdictEvent[], binding: VerdictBinding, signers: readonly AllowedSigner[], opts: { quiet?: boolean } = {}): VerdictAttestation {
  const events: VerdictEvent[] = [];
  const checks: (VerdictSignatureCheck | null)[] = [];
  const findings: string[] = [];
  const warnings: string[] = [];
  const unsigned: VerdictEvent[] = [];
  const highest = new Map<string, { counter: number; draw: number }>();
  for (const v of read) {
    const { provenance: _claimed, ...rest } = withoutSignatureFields(v);
    if (!signers.length) {
      events.push(rest);
      checks.push(null);
      continue;
    }
    const check = checkVerdictSignature(v, binding, signers);
    const provenance = signatureProvenance(check);
    events.push(provenance ? { ...rest, provenance } : rest);
    checks.push(check);
    if (check.state === "unsigned") {
      if (!opts.quiet) unsigned.push(v);
    } else if (check.state !== "signed") {
      if (!opts.quiet) warnings.push(`${where(v)} ${check.detail}: self-asserted`);
    }
    else if (check.sk) {
      if (!check.sk.userPresent) findings.push(`${where(v)} ${check.detail}: account`);
      const fp = check.key!.fingerprint;
      const prev = highest.get(fp);
      if (prev && check.sk.counter < prev.counter)
        warnings.push(
          `security key ${fp} (${check.principal}): its signature counter went down from ${prev.counter} (draw #${prev.draw}) to ${check.sk.counter} (draw #${v.draw}); authenticators differ in counter behaviour, so this is a warning, not a failure, but a cloned key would show it`,
        );
      if (!prev || check.sk.counter > prev.counter) highest.set(fp, { counter: check.sk.counter, draw: v.draw });
    }
  }
  if (unsigned.length) findings.push(`${unsigned.length} verdict line(s) carry no signature (draws ${drawList(unsigned)}): self-asserted`);
  return { events, checks, findings, warnings };
}

/**
 * A verdict signed by `sign` (ssh-keygen, or a test's emulated authenticator), checked as verify will
 * check it before anything is written: the line fields to add, and the check. Throws when the
 * signature would not count (another key, another reviewer, a malformed signature).
 */
export async function signVerdict(fields: VerdictPayloadFields, signers: readonly AllowedSigner[], sign: (payload: Uint8Array) => Promise<string>): Promise<{ registrationSha256: string; sshsig: string; check: VerdictSignatureCheck }> {
  const armored = await sign(verdictPayload(fields));
  let sshsig: string;
  try {
    sshsig = Buffer.from(dearmorSshsig(armored)).toString("base64");
  } catch (e) {
    throw new Error(`the signature is not an SSH signature: ${(e as Error).message}`);
  }
  const { manifestSha256: _m, beaconRound: _r, beaconRandomness: _b, ...line } = fields;
  const check = checkVerdictSignature({ ...line, sshsig }, fields, signers);
  if (check.state !== "signed") throw new Error(`the signature would not count: the verdict ${check.detail}`);
  return { registrationSha256: fields.registrationSha256, sshsig, check };
}

/** The highest level verdicts can reach with these registered keys: none, software keys only, or a security key among them. */
export function reachableProvenance(signers: readonly AllowedSigner[]): ProvenanceLevel {
  if (!signers.length) return "self-asserted";
  return signers.some((s) => s.key.securityKey) ? "presence" : "account";
}

/**
 * What `record` tells a git-file reviewer when keys are registered and the verdict was recorded
 * unsigned. Where the registration requires signatures (`requirement`, from `signingRequirement`),
 * the line is ignored and does not count, so it says that, with the rule; otherwise the line counts
 * as self-asserted.
 */
export function signVerdictHint(signers: readonly AllowedSigner[], requirement: string | null = null): string | null {
  if (!signers.length) return null;
  const how = `--sign <your registered key> (pr-rla runs ssh-keygen -Y sign -n ${VERDICT_NAMESPACE}), or sign its bytes yourself (README, "Signed verdicts")`;
  if (requirement) return `this verdict is not signed, so it is ignored and does not count: ${requirement}; record it again with ${how}`;
  return `this verdict is not signed, so it counts as self-asserted: record it with ${how}`;
}
