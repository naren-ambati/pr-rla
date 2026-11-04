import { describe, expect, it } from "vitest";
import {
  attestVerdicts,
  capProvenance,
  checkVerdictSignature,
  countedVerdicts,
  countingVerdictFor,
  dearmorSshsig,
  isSmallOrderEd25519,
  matchPatternList,
  parseAllowedSigner,
  parseAllowedSigners,
  parsePublicKeyBlob,
  parsePublicKeyText,
  parseSshsig,
  provenanceLabel,
  reachableProvenance,
  registeredVerdicts,
  signatureProvenance,
  signaturesRequired,
  signingRequirement,
  signVerdictHint,
  verdictPayloadProblems,
  verdictPayloadText,
  verdictRuleFailures,
  verdictRuleWarnings,
  verifySshsig,
  PRESENCE_LABEL,
  VERDICT_NAMESPACE,
} from "../src/core/presence/index.js";
import type { SignedRecord, RegistrationRecordV2 } from "../src/core/records.js";
import type { VerdictEvent } from "../src/sdk/ledger.js";
import { armor, makeTestKey, tamperArmor, type TestKeyType } from "./helpers/sshsig-signer.js";
import { signedLine, unsignedLine, verdictBytes, type LineFields } from "./helpers/verdict-lines.js";

/**
 * The PresenceVerifier on its own (FR9.2, FR9.3, FR9.4; U9 as changed after review): SSHSIG over
 * node:crypto for every supported key type, the FIDO signed-data layout and the user-presence flag,
 * the bytes one verdict signature covers, allowed signers, each verdict's own signature and the
 * rules check 7 applies. Signatures come from software keys and a software-emulated authenticator
 * (test/helpers/sshsig-signer.ts, D7); test/presence-oracle.test.ts cross-checks them against ssh-keygen.
 */

const ALL: TestKeyType[] = ["ssh-ed25519", "sk-ssh-ed25519@openssh.com", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ecdsa-sha2-nistp256@openssh.com", "ssh-rsa"];
const keys = Object.fromEntries(ALL.map((t) => [t, makeTestKey(t)])) as Record<TestKeyType, ReturnType<typeof makeTestKey>>;
const msg = new TextEncoder().encode("pr-rla-verdict/v1\ndraw 1\n");
const P = "ab".repeat(32);
const REG = "c1".repeat(32);
/** The audit the test verdicts are signed for (P4: the registration, the manifest and the seed). */
const B = { registrationSha256: REG, manifestSha256: "e5".repeat(32), beaconRound: 12345, beaconRandomness: "f6".repeat(32) };
const fields = (draw: number, reviewer: string, extra: Partial<LineFields> = {}): LineFields => ({ draw, changeId: `json:acme/widgets#${100 + draw}`, verdict: "pass", protocolSha256: P, reviewer, recordedAt: "2026-10-21T03:00:00Z", ...extra });
const event = (line: string): VerdictEvent => JSON.parse(line) as VerdictEvent;
const verdict = (draw: number, reviewer: string, extra: Partial<VerdictEvent> = {}): VerdictEvent => ({ ...fields(draw, reviewer), ...extra });
/** An RSA public-key blob with this exponent and the 2048-bit test key's modulus. */
function rsaBlob(e: number[]): Uint8Array {
  const str = (b: Uint8Array) => Buffer.concat([Buffer.from([(b.length >>> 24) & 0xff, (b.length >>> 16) & 0xff, (b.length >>> 8) & 0xff, b.length & 0xff]), Buffer.from(b)]);
  const n = Buffer.from(keys["ssh-rsa"].blob).subarray(-257); // mpint n: 0x00, then 256 bytes
  return new Uint8Array(Buffer.concat([str(Buffer.from("ssh-rsa")), str(Uint8Array.from(e)), str(n)]));
}

describe("SSHSIG verification in TypeScript (FR9.2)", () => {
  for (const t of ALL)
    it(`verifies a ${t} signature, and refuses it after one flipped bit`, () => {
      const sig = keys[t].sign(msg, { namespace: VERDICT_NAMESPACE });
      const ok = verifySshsig(sig, msg, VERDICT_NAMESPACE);
      expect(ok).toMatchObject({ ok: true, namespace: VERDICT_NAMESPACE, hashAlgorithm: "sha512", key: { type: t } });
      expect(ok.key!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
      expect(verifySshsig(tamperArmor(sig), msg, VERDICT_NAMESPACE)).toMatchObject({ ok: false });
      expect(verifySshsig(sig, new TextEncoder().encode("another message"), VERDICT_NAMESPACE)).toMatchObject({ ok: false, problem: "the signature does not match the signed data" });
    });

  it("reads the FIDO flags and counter: UP set, UP clear, UP and UV", () => {
    for (const t of ["sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"] as const) {
      expect(verifySshsig(keys[t].sign(msg, { flags: 0x01, counter: 7 }), msg, "git").sk).toEqual({ flags: 1, counter: 7, userPresent: true, userVerified: false });
      expect(verifySshsig(keys[t].sign(msg, { flags: 0x00, counter: 8 }), msg, "git")).toMatchObject({ ok: true, sk: { flags: 0, counter: 8, userPresent: false } });
      expect(verifySshsig(keys[t].sign(msg, { flags: 0x05, counter: 2 ** 32 - 1 }), msg, "git").sk).toEqual({ flags: 5, counter: 4294967295, userPresent: true, userVerified: true });
    }
  });

  it("the flags byte and the counter are signed: changing either breaks the signature", () => {
    for (const t of ["sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"] as const) {
      const sig = keys[t].sign(msg, { flags: 0x00, counter: 9 });
      // The signature blob ends with byte flags, uint32 counter: set UP after the fact, or change the counter.
      expect(verifySshsig(tamperArmor(sig, 5), msg, "git")).toMatchObject({ ok: false, sk: { flags: 1, userPresent: true } });
      expect(verifySshsig(tamperArmor(sig, 1), msg, "git")).toMatchObject({ ok: false, sk: { counter: 8 } });
    }
  });

  it("checks the namespace, the message hash, the version and the preamble", () => {
    const k = keys["ssh-ed25519"];
    expect(verifySshsig(k.sign(msg, { namespace: "git" }), msg, VERDICT_NAMESPACE)).toMatchObject({ ok: false, problem: `the signature is for namespace "git", not "${VERDICT_NAMESPACE}"` });
    expect(verifySshsig(k.sign(msg, { hash: "sha256" }), msg, "git")).toMatchObject({ ok: true, hashAlgorithm: "sha256" });
    expect(verifySshsig(k.sign(msg, { hash: "sha1" }), msg, "git")).toMatchObject({ ok: false, problem: 'message hash "sha1" is not sha256 or sha512' });
    expect(verifySshsig(k.sign(msg, { version: 2 }), msg, "git")).toMatchObject({ ok: false, problem: "SSHSIG version 2 is not supported (only 1)" });
    expect(verifySshsig("-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n", msg, "git")).toMatchObject({ ok: false, problem: expect.stringMatching(/does not start with -----BEGIN SSH SIGNATURE-----/) });
    expect(verifySshsig(armor(new TextEncoder().encode("NOTSIG\0\0\0\x01")), msg, "git")).toMatchObject({ ok: false, problem: "not an SSHSIG blob (no SSHSIG preamble)" });
    const blob = dearmorSshsig(k.sign(msg));
    expect(verifySshsig(armor(blob.subarray(0, blob.length - 3)), msg, "git")).toMatchObject({ ok: false, problem: expect.stringMatching(/truncated/) });
    expect(verifySshsig(armor(Uint8Array.from([...blob, 0])), msg, "git")).toMatchObject({ ok: false, problem: expect.stringMatching(/trailing byte/) });
  });

  it("finding 6: a non-empty reserved field is refused, whatever the signature covers (OpenSSH signs and verifies over an empty one)", () => {
    const k = keys["ssh-ed25519"];
    expect(verifySshsig(k.sign(msg, { reservedBlob: "X", reservedSigned: "X" }), msg, "git")).toMatchObject({ ok: false, problem: "the SSHSIG reserved field is not empty (1 bytes)" });
    expect(verifySshsig(k.sign(msg, { reservedBlob: "X", reservedSigned: "" }), msg, "git")).toMatchObject({ ok: false, problem: "the SSHSIG reserved field is not empty (1 bytes)" });
    expect(() => parseSshsig(dearmorSshsig(k.sign(msg, { reservedBlob: "X" })))).toThrow(/reserved field is not empty/);
    expect(verifySshsig(k.sign(msg), msg, "git").ok).toBe(true);
  });

  it("a signature claiming another key's identity does not verify", () => {
    const forged = keys["ssh-ed25519"].sign(msg, { claimKey: makeTestKey("ssh-ed25519") });
    expect(verifySshsig(forged, msg, "git").ok).toBe(false);
  });

  it("a signature algorithm that does not match the key (or its curve) is refused", () => {
    expect(verifySshsig(keys["ecdsa-sha2-nistp256"].sign(msg, { algorithm: "ecdsa-sha2-nistp384" }), msg, "git")).toMatchObject({ ok: false, problem: 'a ecdsa-sha2-nistp256 key cannot make a "ecdsa-sha2-nistp384" signature' });
    expect(verifySshsig(keys["ssh-ed25519"].sign(msg, { algorithm: "sk-ssh-ed25519@openssh.com" }), msg, "git")).toMatchObject({ ok: false });
  });

  it("RSA: SHA-2 signatures only, 2048 bits or more", () => {
    const k = keys["ssh-rsa"];
    expect(verifySshsig(k.sign(msg, { rsaAlgorithm: "rsa-sha2-256" }), msg, "git").ok).toBe(true);
    expect(verifySshsig(k.sign(msg, { rsaAlgorithm: "ssh-rsa" }), msg, "git")).toMatchObject({ ok: false, problem: 'a ssh-rsa key cannot make a "ssh-rsa" signature (SHA-1 RSA signatures are refused)' });
    expect(() => parsePublicKeyText("ssh-rsa", makeTestKey("ssh-rsa", { rsaBits: 1024 }).publicText.split(" ")[1]!)).toThrow(/has 1024 bits; pr-rla accepts 2048 or more/);
  });

  it("finding 12: an RSA public exponent of 1 or an even one is refused; 3 and 65537 are accepted", () => {
    expect(() => parsePublicKeyBlob(rsaBlob([1]))).toThrow(/public exponent is 1 or even/);
    expect(() => parsePublicKeyBlob(rsaBlob([2]))).toThrow(/public exponent is 1 or even/);
    expect(() => parsePublicKeyBlob(rsaBlob([1, 0, 0]))).toThrow(/public exponent is 1 or even/);
    expect(parsePublicKeyBlob(rsaBlob([3])).bits).toBe(2048);
    expect(parsePublicKeyBlob(rsaBlob([1, 0, 1])).bits).toBe(2048);
  });

  it("finding 12: small-order Ed25519 public keys are refused, with either sign bit", () => {
    const small = ["0100000000000000000000000000000000000000000000000000000000000000", "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa", "0000000000000000000000000000000000000000000000000000000000000080"];
    for (const h of small) {
      expect(isSmallOrderEd25519(Uint8Array.from(Buffer.from(h, "hex"))), h).toBe(true);
      const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.from(h, "hex")]);
      expect(() => parsePublicKeyBlob(new Uint8Array(blob))).toThrow(/is a point of small order/);
    }
    expect(isSmallOrderEd25519(new Uint8Array(Buffer.from(keys["ssh-ed25519"].blob).subarray(-32)))).toBe(false);
  });

  it("finding 12: a security key's application must start with ssh:", () => {
    expect(parseAllowedSigner(`bob ${makeTestKey("sk-ssh-ed25519@openssh.com", { application: "ssh:pr-rla" }).publicText}`).key.application).toBe("ssh:pr-rla");
    for (const t of ["sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"] as const)
      expect(() => parsePublicKeyText(t, makeTestKey(t, { application: "https://example.org" }).publicText.split(" ")[1]!)).toThrow(/application "https:\/\/example.org" does not start with "ssh:"/);
  });

  it("refuses unknown key types, mislabelled keys, and points off the curve", () => {
    expect(() => parsePublicKeyText("ssh-dss", "AAAA")).toThrow(/key type "ssh-dss" is not supported/);
    expect(() => parsePublicKeyText("ssh-ed25519", keys["ecdsa-sha2-nistp256"].publicText.split(" ")[1]!)).toThrow(/the key text says ssh-ed25519 but its blob is ecdsa-sha2-nistp256/);
    const blob = Buffer.from(keys["ecdsa-sha2-nistp256"].publicText.split(" ")[1]!, "base64");
    blob[blob.length - 1]! ^= 0x01; // y no longer on P-256
    expect(() => parsePublicKeyText("ecdsa-sha2-nistp256", blob.toString("base64"))).toThrow(/not a valid key/);
    expect(() => parsePublicKeyText("ssh-ed25519", "not base64!")).toThrow(/not base64/);
  });

  it("refuses webauthn signatures", () => {
    const sig = keys["sk-ecdsa-sha2-nistp256@openssh.com"].sign(msg, { webauthn: { origin: "https://example.org" } });
    expect(parseSshsig(dearmorSshsig(sig)).publicKey.application).toBe("ssh:");
    expect(verifySshsig(sig, msg, "git")).toMatchObject({ ok: false, problem: expect.stringMatching(/webauthn-sk-ecdsa-sha2-nistp256@openssh.com \(web authentication\) signatures are not supported/) });
  });
});

describe("the bytes one verdict signature covers (contracts.md §1)", () => {
  it("are versioned text, one field per line in a fixed order, as the README's printf writes them", () => {
    const f = { ...B, ...fields(7, "bob") };
    expect(verdictPayloadText(f)).toBe(
      `pr-rla-verdict/v2\nregistrationSha256 ${REG}\nmanifestSha256 ${"e5".repeat(32)}\nbeaconRound 12345\nbeaconRandomness ${"f6".repeat(32)}\nprotocolSha256 ${P}\ndraw 7\nchangeId json:acme/widgets#107\nverdict pass\nreviewer bob\nrecordedAt 2026-10-21T03:00:00Z\n`,
    );
    // The test helper writes the same bytes from the contract, independently.
    expect(verdictPayloadText(f)).toBe(verdictBytes(B, fields(7, "bob")));
    expect(VERDICT_NAMESPACE).toBe("pr-rla-verdict@v1");
  });

  it("refuse what could not be encoded unambiguously: a line break or other control character, a lone surrogate, malformed hashes, draws and times", () => {
    const ok = { ...B, ...fields(7, "bob") };
    expect(verdictPayloadProblems(ok)).toEqual([]);
    expect(verdictPayloadProblems({ ...ok, manifestSha256: "e5" })).toEqual(["manifestSha256 must be 64 lowercase hex characters"]);
    expect(verdictPayloadProblems({ ...ok, beaconRound: 0 })).toEqual(["beaconRound must be a positive integer"]);
    expect(verdictPayloadProblems({ ...ok, beaconRandomness: "F6".repeat(32) })).toEqual(["beaconRandomness must be 64 lowercase hex characters"]);
    expect(verdictPayloadProblems({ ...ok, changeId: "x\nverdict fail" })).toEqual(["changeId must be non-empty text with no control character"]);
    expect(verdictPayloadProblems({ ...ok, reviewer: "bob\u0000" })).toEqual(["reviewer must be non-empty text with no control character"]);
    expect(verdictPayloadProblems({ ...ok, reviewer: "b\uD800" })).toEqual(["reviewer must be non-empty text with no control character"]);
    expect(verdictPayloadProblems({ ...ok, registrationSha256: REG.toUpperCase() })).toEqual(["registrationSha256 must be 64 lowercase hex characters"]);
    expect(verdictPayloadProblems({ ...ok, draw: 1.5 })).toEqual(["draw must be a positive integer"]);
    expect(verdictPayloadProblems({ ...ok, recordedAt: "2026-10-21 03:00:00" })).toEqual(["recordedAt must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ)"]);
    expect(() => verdictPayloadText({ ...ok, verdict: "maybe" as "pass" })).toThrow(/the verdict cannot be signed: verdict must be "pass" or "fail"/);
    expect(verdictPayloadText({ ...ok, changeId: "github:acme/w#1 ünïcode" })).toContain("changeId github:acme/w#1 ünïcode\n");
  });
});

describe("allowed signers (FR9.3)", () => {
  const k = keys["sk-ssh-ed25519@openssh.com"];
  it("parses the principal, the namespaces option and the key", () => {
    const s = parseAllowedSigner(`bob namespaces="pr-rla-verdict@v1,file" ${k.publicText} bob@laptop`);
    expect(s).toMatchObject({ principals: ["bob"], namespaces: ["pr-rla-verdict@v1", "file"], key: { type: "sk-ssh-ed25519@openssh.com", securityKey: true, application: "ssh:" } });
    expect(parseAllowedSigner(`bob ${k.publicText}`).namespaces).toBeNull();
    expect(parseAllowedSigner(`bob NAMESPACES="pr-rla-*" ${k.publicText}`).namespaces).toEqual(["pr-rla-*"]);
  });

  it("the namespaces option must admit pr-rla-verdict@v1 (a git-only key cannot sign verdicts)", () => {
    expect(() => parseAllowedSigner(`bob namespaces="git" ${k.publicText}`)).toThrow(/does not admit namespace "pr-rla-verdict@v1"/);
    expect(() => parseAllowedSigner(`bob namespaces="*,!pr-rla-verdict@v1" ${k.publicText}`)).toThrow(/does not admit namespace "pr-rla-verdict@v1"/);
  });

  it("refuses what a reviewer identity cannot be, and options it does not apply", () => {
    expect(() => parseAllowedSigner(`*@example ${k.publicText}`)).toThrow(/is a pattern; register each reviewer by exact name/);
    expect(() => parseAllowedSigner(`id:42 ${k.publicText}`)).toThrow(/looks like an account id/);
    expect(() => parseAllowedSigner(`bob,robert ${k.publicText}`)).toThrow(/lists several principals; register one reviewer per key/);
    expect(() => parseAllowedSigner(`bob cert-authority ${k.publicText}`)).toThrow(/option cert-authority for bob is not supported/);
    expect(() => parseAllowedSigner(`bob valid-after="20260101" ${k.publicText}`)).toThrow(/option valid-after="20260101" for bob is not supported/);
    expect(() => parseAllowedSigner("bob ssh-ed25519")).toThrow(/needs "principal keytype base64-key"/);
    expect(() => parseAllowedSigner('bob namespaces="git ssh-ed25519 AAAA')).toThrow(/unterminated quote/);
  });

  it("finding 7: refuses principals equal ignoring case, and one key under two principals", () => {
    const other = keys["ssh-ed25519"];
    expect(() => parseAllowedSigners([`Alice ${k.publicText}`, `alice ${other.publicText}`])).toThrow(/allowed signers "Alice" and "alice" are the same principal ignoring case/);
    expect(() => parseAllowedSigners([`alice ${k.publicText}`, `bob ${k.publicText}`])).toThrow(/allowed signers alice and bob hold the same key SHA256:\S+; one key belongs to one reviewer/);
    expect(parseAllowedSigners([`alice ${other.publicText}`, `bob ${k.publicText}`]).map((s) => s.principals[0])).toEqual(["alice", "bob"]);
  });

  it("matches OpenSSH pattern lists for namespaces", () => {
    expect(matchPatternList("pr-rla-verdict@v1", ["pr-rla-verdict@v?"])).toBe(true);
    expect(matchPatternList("git", ["*", "!g*"])).toBe(false);
    expect(matchPatternList("git", ["file"])).toBe(false);
  });
});

describe("each verdict's own signature (U9, after review)", () => {
  const bob = keys["sk-ssh-ed25519@openssh.com"];
  const alice = keys["ssh-ed25519"];
  const signers = parseAllowedSigners([`bob ${bob.publicText}`, `alice ${alice.publicText}`]);
  const check = (line: string) => checkVerdictSignature(event(line), B, signers);

  it("a registered software key gives account; a security key with UP, presence; with UP clear, account", () => {
    expect(signatureProvenance(check(signedLine(B, fields(1, "alice"), alice)))).toEqual({ level: "account", source: "verdict-signature", signer: "alice", keyFingerprint: parseAllowedSigner(`a ${alice.publicText}`).key.fingerprint });
    expect(signatureProvenance(check(signedLine(B, fields(2, "bob"), bob, { flags: 0x01, counter: 5 })))).toMatchObject({ level: "presence", signer: "bob", counter: 5 });
    expect(signatureProvenance(check(signedLine(B, fields(3, "bob"), bob, { flags: 0x00, counter: 6 })))).toMatchObject({ level: "account", counter: 6 });
    expect(check(signedLine(B, fields(3, "bob"), bob, { flags: 0x00 }))).toMatchObject({ state: "signed", detail: expect.stringMatching(/without the user-presence flag \(no touch\)$/) });
  });

  it("covers every field: a verdict flipped, a draw or change moved, a protocol or time changed no longer verifies", () => {
    const line = JSON.parse(signedLine(B, fields(4, "bob", { verdict: "fail" }), bob)) as Record<string, unknown>;
    for (const [k, v] of [["verdict", "pass"], ["draw", 5], ["changeId", "json:acme/widgets#105"], ["recordedAt", "2026-10-22T03:00:00Z"], ["protocolSha256", "cd".repeat(32)]] as const)
      expect(checkVerdictSignature({ ...line, [k]: v } as unknown as VerdictEvent, B, signers), k).toMatchObject({ state: "invalid", detail: expect.stringMatching(/does not match the signed data/) });
    expect(checkVerdictSignature({ ...line, reviewer: "alice" } as unknown as VerdictEvent, B, signers).state).not.toBe("signed");
    expect(checkVerdictSignature(line as unknown as VerdictEvent, B, signers).state).toBe("signed");
  });

  it("P4 finding 5: the signature binds the manifest and the seed; one made over the v1 bytes (no manifest, no seed) is refused, saying why", () => {
    expect(check(signedLine(B, fields(1, "bob"), bob, { bytesFor: { manifestSha256: "e6".repeat(32) } }))).toMatchObject({ state: "invalid", detail: expect.stringMatching(/does not verify for this audit \(its registration, manifest and seed\)/) });
    expect(check(signedLine(B, fields(1, "bob"), bob, { bytesFor: { beaconRandomness: "f7".repeat(32) } }))).toMatchObject({ state: "invalid" });
    expect(check(signedLine(B, fields(1, "bob"), bob, { bytesFor: { beaconRound: 12346 } }))).toMatchObject({ state: "invalid" });
    expect(check(signedLine(B, fields(1, "bob"), bob, { v1: true }))).toMatchObject({ state: "invalid", detail: expect.stringMatching(/is signed over the pr-rla-verdict\/v1 bytes, which name neither the manifest nor the seed .* such signatures are refused/) });
    expect(check(signedLine(B, fields(1, "bob"), bob)).state).toBe("signed");
  });

  it("finding 8: a verdict signed for another registration does not count here, even when its line names this one", () => {
    const OTHER = "d2".repeat(32);
    expect(check(signedLine({ ...B, registrationSha256: OTHER }, fields(1, "bob"), bob))).toMatchObject({ state: "other-registration", detail: expect.stringMatching(/is signed for registration d2d2d2d2d2d2…, not this audit's c1c1c1c1c1c1…/) });
    expect(check(signedLine(B, fields(1, "bob"), bob, { bytesFor: { registrationSha256: OTHER } }))).toMatchObject({ state: "invalid" });
  });

  it("a commit-namespace signature, an unlisted key, a principal that is not the reviewer, and garbage do not count", () => {
    expect(check(signedLine(B, fields(1, "bob"), bob, { namespace: "git" }))).toMatchObject({ state: "invalid", detail: expect.stringMatching(/namespace "git", not "pr-rla-verdict@v1"/) });
    expect(check(signedLine(B, fields(1, "bob"), makeTestKey("sk-ssh-ed25519@openssh.com")))).toMatchObject({ state: "unlisted", detail: expect.stringMatching(/which no registered reviewer holds/) });
    expect(check(signedLine(B, fields(1, "alice"), bob))).toMatchObject({ state: "mismatch", detail: expect.stringMatching(/^names reviewer alice but is signed by bob's key SHA256:/) });
    // Exact, as ssh-keygen -Y verify -I matches principals (finding 10): "Bob" is not "bob".
    expect(check(signedLine(B, fields(1, "Bob"), bob))).toMatchObject({ state: "mismatch" });
    expect(check(unsignedLine(fields(1, "bob")))).toMatchObject({ state: "unsigned" });
    expect(checkVerdictSignature({ ...verdict(1, "bob"), sshsig: "not base64!" }, B, signers)).toMatchObject({ state: "unreadable" });
    expect(checkVerdictSignature({ ...event(signedLine(B, fields(1, "bob"), bob)), changeId: "x\ny" }, B, signers)).toMatchObject({ state: "unreadable", detail: expect.stringMatching(/changeId must be non-empty text/) });
    expect(check(signedLine(B, fields(1, "bob"), bob, { reservedBlob: "X", reservedSigned: "X" }))).toMatchObject({ state: "invalid", detail: expect.stringMatching(/reserved field is not empty/) });
  });

  it("attestVerdicts: a line's own claim never counts; a decreasing counter WARNs; an equal one does not; unsigned and touch-less lines are noted", () => {
    const lines = [
      { ...event(unsignedLine(fields(1, "bob"))), provenance: { level: "presence" as const, source: "typed" } },
      event(signedLine(B, fields(2, "bob"), bob, { counter: 10 })),
      event(signedLine(B, fields(3, "bob"), bob, { counter: 10 })),
      event(signedLine(B, fields(4, "bob"), bob, { counter: 4 })),
      event(signedLine(B, fields(5, "bob"), bob, { counter: 11, flags: 0x00 })),
      event(signedLine(B, fields(6, "bob"), makeTestKey("ssh-ed25519"))),
    ];
    const a = attestVerdicts(lines, B, signers);
    expect(a.events.map((e) => e.provenance?.level ?? "self-asserted")).toEqual(["self-asserted", "presence", "presence", "presence", "account", "self-asserted"]);
    expect(a.events[0]!.provenance).toBeUndefined();
    expect(a.events.every((e) => e.sshsig === undefined && e.registrationSha256 === undefined)).toBe(true);
    expect(a.warnings.filter((w) => /counter went down/.test(w))).toEqual([expect.stringMatching(/went down from 10 \(draw #2\) to 4 \(draw #4\); authenticators differ in counter behaviour, so this is a warning, not a failure/)]);
    expect(a.warnings).toContainEqual(expect.stringMatching(/^verdict on draw #6 \(json:acme\/widgets#106\) is signed by key SHA256:\S+ \(ssh-ed25519\), which no registered reviewer holds: self-asserted$/));
    expect(a.findings).toEqual([expect.stringMatching(/^verdict on draw #5 .* without the user-presence flag \(no touch\): account$/), "1 verdict line(s) carry no signature (draws #1): self-asserted"]);
  });

  it("with no keys registered nothing is checked and nothing is noted", () => {
    const a = attestVerdicts([event(signedLine(B, fields(1, "bob"), bob)), event(unsignedLine(fields(2, "bob")))], B, []);
    expect(a.findings).toEqual([]);
    expect(a.warnings).toEqual([]);
    expect(a.events.map((e) => [e.draw, e.provenance, e.sshsig])).toEqual([[1, undefined, undefined], [2, undefined, undefined]]);
  });
});

describe("the rules check 7 applies (FR9.1, FR9.4) and the ceiling", () => {
  const presence = verdict(1, "bob", { provenance: { level: "presence", source: "verdict-signature", signer: "bob" } });
  const account = verdict(2, "alice", { provenance: { level: "account", source: "verdict-signature", signer: "alice" } });
  const unsigned = verdict(3, "alice");
  const issue = verdict(4, "alice", { provenance: { level: "account", source: "scm-label-event", eventId: "9" } });

  it("FR9.4: a verdict below the registered minimum fails; FR9.1: under require_signed one without a valid signature fails", () => {
    expect(verdictRuleFailures(presence, { minProvenance: "presence", requireSigned: true })).toEqual([]);
    expect(verdictRuleFailures(account, { minProvenance: "presence" })).toEqual([`verdict on draw #2 (json:acme/widgets#102) is account; the registration requires ${PRESENCE_LABEL}`]);
    expect(verdictRuleFailures(unsigned, { minProvenance: "account" })).toEqual([`verdict on draw #3 (json:acme/widgets#103) is self-asserted; the registration requires account`]);
    expect(verdictRuleFailures(unsigned, { minProvenance: "self-asserted", requireSigned: true })).toEqual([
      `verdict on draw #3 (json:acme/widgets#103) carries no valid signature by the registered key of reviewer alice; the registration requires signed verdicts (require_signed)`,
    ]);
    // An issue ledger's account verdict is not a signed verdict.
    expect(verdictRuleFailures(issue, { minProvenance: "account" })).toEqual([]);
    expect(verdictRuleFailures(issue, { minProvenance: "account", requireSigned: true })).toHaveLength(1);
  });

  it("a ledger cannot count a verdict above its ceiling, and says so with the level labelled", () => {
    const { verdicts, notes } = capProvenance([presence, account], "account", "tracker");
    expect(verdicts.map((v) => v.provenance!.level)).toEqual(["account", "account"]);
    expect(notes).toEqual([`ledger tracker reported ${PRESENCE_LABEL} for the verdict on draw #1, more than it can attest; counted as account`]);
    expect(capProvenance([presence], "presence", "git-file").notes).toEqual([]);
    expect(capProvenance([presence], undefined, "git-file").verdicts[0]!.provenance!.level).toBe("presence");
  });

  it("countedVerdicts: only the registered git-file ledger's signatures are checked; any other ledger keeps its provenance, its signature fields ignored", () => {
    const bob = keys["sk-ssh-ed25519@openssh.com"];
    const reg = { record: { schema: "pr-rla/registration/v2", verdicts: { minProvenance: "presence", reviewers: null, allowed_signers: [`bob ${bob.publicText}`] } }, sha256: REG } as unknown as SignedRecord<RegistrationRecordV2>;
    const line = event(signedLine(B, fields(1, "bob"), bob));
    expect(countedVerdicts([line], { registration: reg, binding: B, verifiesSignatures: true, ceiling: "presence", ledger: "git-file" }).verdicts[0]!.provenance?.level).toBe("presence");
    const other = countedVerdicts([{ ...line, provenance: { level: "presence", source: "verdict-signature" } }], { registration: reg, binding: B, verifiesSignatures: false, ceiling: "account", ledger: "tracker" });
    expect(other.verdicts[0]).toMatchObject({ provenance: { level: "account" } });
    expect(other.verdicts[0]!.sshsig).toBeUndefined();
    expect(other.notes).toHaveLength(1);
  });

  it("P4 finding 2: under keys and require_signed, or a minimum above self-asserted, a line without a valid registered signature is ineligible, with its reason; otherwise it counts as self-asserted", () => {
    const bob = keys["sk-ssh-ed25519@openssh.com"];
    const regWith = (verdicts: Record<string, unknown>) => ({ record: { schema: "pr-rla/registration/v2", verdicts: { reviewers: null, allowed_signers: [`bob ${bob.publicText}`], ...verdicts } }, sha256: REG }) as unknown as SignedRecord<RegistrationRecordV2>;
    const lines = [event(unsignedLine(fields(1, "bob"))), event(signedLine(B, fields(1, "bob", { verdict: "fail" }), bob)), event(signedLine(B, fields(2, "bob"), makeTestKey("ssh-ed25519")))];
    for (const v of [{ minProvenance: "self-asserted", require_signed: true }, { minProvenance: "account" }, { minProvenance: "presence" }]) {
      expect(signaturesRequired(regWith(v)), JSON.stringify(v)).toBe(true);
      const c = countedVerdicts(lines, { registration: regWith(v), binding: B, verifiesSignatures: true, ceiling: "presence", ledger: "git-file" });
      expect(c.verdicts.map((x) => c.ineligible(x))).toEqual([
        "carries no signature, and the registration counts only verdicts signed with their reviewer's registered key",
        null,
        expect.stringMatching(/^is signed by key SHA256:\S+ \(ssh-ed25519\), which no registered reviewer holds, and the registration counts only/),
      ]);
      // The lines it ignores are not noted twice (they show as ignored verdicts).
      expect(c.warnings).toEqual([]);
      expect(c.findings).toEqual([]);
      // The first eligible verdict for the change is bob's signed FAIL, not the unsigned PASS appended before it.
      expect(countingVerdictFor(lines, fields(1, "bob").changeId, { registration: regWith(v), binding: B, verifiesSignatures: true, ledger: "git-file", protocolSha256: P, eligible: () => true })?.verdict).toBe("fail");
      // Through another ledger than the registered git-file, nothing is eligible.
      const other = countedVerdicts(lines, { registration: regWith(v), binding: B, verifiesSignatures: false, ledger: "tracker" });
      expect(other.verdicts.every((x) => /^the ledger read is not the registered built-in git-file/.test(other.ineligible(x) ?? ""))).toBe(true);
    }
    const lax = regWith({ minProvenance: "self-asserted" });
    expect(signaturesRequired(lax)).toBe(false);
    const c = countedVerdicts(lines, { registration: lax, binding: B, verifiesSignatures: true, ceiling: "presence", ledger: "git-file" });
    expect(c.verdicts.map((x) => c.ineligible(x))).toEqual([null, null, null]);
    expect(countingVerdictFor(lines, fields(1, "bob").changeId, { registration: lax, binding: B, verifiesSignatures: true, ledger: "git-file", protocolSha256: P, eligible: () => true })?.verdict).toBe("pass");
    expect(c.findings).toEqual(["1 verdict line(s) carry no signature (draws #1): self-asserted"]);
  });

  it("record's message for an unsigned line: ignored and not counted, with the rule, where signatures are required; self-asserted otherwise", () => {
    const bob = keys["sk-ssh-ed25519@openssh.com"];
    const signers = parseAllowedSigners([`bob ${bob.publicText}`]);
    const regWith = (verdicts: Record<string, unknown>) => ({ record: { schema: "pr-rla/registration/v2", verdicts: { reviewers: null, allowed_signers: [`bob ${bob.publicText}`], ...verdicts } }, sha256: REG }) as unknown as SignedRecord<RegistrationRecordV2>;
    const how = `--sign <your registered key> (pr-rla runs ssh-keygen -Y sign -n ${VERDICT_NAMESPACE}), or sign its bytes yourself (README, "Signed verdicts")`;
    const rule = "the registration counts only verdicts signed with their reviewer's registered key";
    for (const [v, why] of [
      [{ minProvenance: "self-asserted", require_signed: true }, "require_signed is set"],
      [{ minProvenance: "account" }, "min_provenance is account"],
      [{ minProvenance: "presence", require_signed: true }, "require_signed is set"],
    ] as const) {
      expect(signingRequirement(regWith(v))).toBe(`${rule} (${why})`);
      const hint = signVerdictHint(signers, signingRequirement(regWith(v)));
      expect(hint).toBe(`this verdict is not signed, so it is ignored and does not count: ${rule} (${why}); record it again with ${how}`);
      expect(hint).not.toMatch(/self-asserted/);
    }
    // No requirement: the unsigned line counts, as self-asserted.
    expect(signingRequirement(regWith({ minProvenance: "self-asserted" }))).toBeNull();
    expect(signVerdictHint(signers, signingRequirement(regWith({ minProvenance: "self-asserted" })))).toBe(`this verdict is not signed, so it counts as self-asserted: record it with ${how}`);
    // No keys registered: nothing to sign with, so no message, and no requirement (signatures cannot be required).
    const keyless = { record: { schema: "pr-rla/registration/v2", verdicts: { reviewers: null, allowed_signers: [], minProvenance: "account" } }, sha256: REG } as unknown as SignedRecord<RegistrationRecordV2>;
    expect(signingRequirement(keyless)).toBeNull();
    expect(signVerdictHint([], null)).toBeNull();
  });

  it("FR9.6: the presence level is never printed without its limit", () => {
    expect(provenanceLabel("presence")).toBe("presence (user-presence flag verified; key hardware not attested)");
    expect(PRESENCE_LABEL).toBe(provenanceLabel("presence"));
    expect(provenanceLabel("account")).toBe("account");
  });

  it("the level registered keys can reach", () => {
    expect(reachableProvenance([])).toBe("self-asserted");
    expect(reachableProvenance([parseAllowedSigner(`a ${keys["ssh-ed25519"].publicText}`)])).toBe("account");
    expect(reachableProvenance(parseAllowedSigners([`a ${keys["ssh-ed25519"].publicText}`, `b ${keys["sk-ecdsa-sha2-nistp256@openssh.com"].publicText}`]))).toBe("presence");
  });
});

describe("the verdict rules a registration fixes (FR3.8, FR9.1, FR9.3, FR9.4)", () => {
  const sw = `alice ${keys["ssh-ed25519"].publicText}`;
  const sk = `bob ${keys["sk-ssh-ed25519@openssh.com"].publicText}`;
  const gitFile = { ledger: "git-file", verifiesSignatures: true, ledgerLevel: "self-asserted" as const, ledgerCeiling: "presence" as const, minProvenance: null, reviewers: null, allowedSigners: null, requireSigned: false };
  const issues = { ledger: "github-issues", verifiesSignatures: false, ledgerLevel: "account" as const, ledgerCeiling: "account" as const, minProvenance: null, reviewers: null, allowedSigners: null, requireSigned: false };

  it("FR3.8: the default minimum is self-asserted with git-file and account with an issue ledger", () => {
    expect(registeredVerdicts(gitFile)).toEqual({ minProvenance: "self-asserted", reviewers: null });
    expect(registeredVerdicts(issues)).toEqual({ minProvenance: "account", reviewers: null });
  });

  it("git-file reaches account with registered keys, presence only with a security key; require_signed and the keys are recorded", () => {
    expect(registeredVerdicts({ ...gitFile, minProvenance: "account", allowedSigners: [sw], requireSigned: true })).toEqual({ minProvenance: "account", reviewers: null, require_signed: true, allowed_signers: [sw] });
    expect(registeredVerdicts({ ...gitFile, minProvenance: "presence", allowedSigners: [sk, sw], reviewers: ["alice", "bob"] })).toEqual({ minProvenance: "presence", reviewers: ["alice", "bob"], allowed_signers: [sw, sk] });
    expect(() => registeredVerdicts({ ...gitFile, minProvenance: "presence", allowedSigners: [sw] })).toThrow(/no key in verdicts.allowed_signers is a FIDO security key .* so no verdict could reach it/);
    expect(() => registeredVerdicts({ ...gitFile, minProvenance: "account" })).toThrow(/verdicts.min_provenance is account, but ledger git-file records self-asserted verdicts, so no verdict could count; register the reviewers' SSH keys in verdicts.allowed_signers/);
    expect(() => registeredVerdicts({ ...gitFile, requireSigned: true, reviewers: ["alice"] })).toThrow(/require_signed needs the reviewers' SSH keys in verdicts.allowed_signers/);
  });

  it("issue ledgers top out at account; SSH keys and require_signed count only with the built-in git-file", () => {
    expect(() => registeredVerdicts({ ...issues, minProvenance: "presence" })).toThrow(/^verdicts.min_provenance is presence \(user-presence flag verified; key hardware not attested\), but ledger github-issues records account verdicts, so no verdict could count; it needs the git-file ledger/);
    expect(() => registeredVerdicts({ ...issues, allowedSigners: [sk] })).toThrow(/lists SSH keys \(bob \(sk-ssh-ed25519@openssh.com SHA256:.*\)\), but ledger github-issues reads accounts, not signed verdicts/);
    expect(() => registeredVerdicts({ ...issues, requireSigned: true })).toThrow(/require_signed needs the built-in git-file ledger/);
  });

  it("finding 12: register warns when keys are registered but enforce nothing; finding 11(b): a key line among the reviewers is a name, and is flagged", () => {
    expect(verdictRuleWarnings({ ...gitFile, allowedSigners: [sk] }, registeredVerdicts({ ...gitFile, allowedSigners: [sk] }))).toEqual([expect.stringMatching(/registers SSH keys, but neither require_signed nor a min_provenance above self-asserted is set/)]);
    const signed = { ...gitFile, allowedSigners: [sk], requireSigned: true };
    expect(verdictRuleWarnings(signed, registeredVerdicts(signed))).toEqual([]);
    const named = { ...gitFile, reviewers: ["Alice Smith", sk] };
    expect(verdictRuleWarnings(named, registeredVerdicts(named))).toEqual([expect.stringMatching(/^verdicts.reviewers entry "bob sk-ssh-ed25519@openssh.com AAAA.*" is read as a reviewer's name; SSH keys belong in verdicts.allowed_signers$/)]);
    const missing = { ...gitFile, reviewers: ["alice"], allowedSigners: [sk], requireSigned: true };
    expect(verdictRuleWarnings(missing, registeredVerdicts(missing))).toEqual(["allowed signer bob is not in verdicts.reviewers, so a verdict they sign is not counted"]);
  });
});
