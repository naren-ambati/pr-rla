import { describe, expect, it } from "vitest";
import {
  analyzeSignedVerdicts,
  capProvenance,
  checkCommitSignature,
  dearmorSshsig,
  isAllowedSignerEntry,
  isSmallOrderEd25519,
  lineProvenance,
  matchPatternList,
  parseAllowedSigner,
  parsePublicKeyBlob,
  parsePublicKeyText,
  parseSshsig,
  provenanceLabel,
  reachableProvenance,
  registeredVerdicts,
  signatureFormat,
  splitCommitSignature,
  verdictRuleFailures,
  verifySshsig,
  PRESENCE_LABEL,
  type AllowedSigner,
} from "../src/core/presence/index.js";
import { verdictIneligibility, type VerdictEvent } from "../src/sdk/ledger.js";
import { armor, makeTestKey, tamperArmor, type TestKeyType } from "./helpers/sshsig-signer.js";

/**
 * The PresenceVerifier on its own (FR9.2, FR9.3, FR9.4): SSHSIG over node:crypto for every supported
 * key type, the FIDO signed-data layout and the user-presence flag, allowed signers, commit
 * splitting, line provenance and the rules check 7 applies. Signatures come from software keys and
 * a software-emulated authenticator (test/helpers/sshsig-signer.ts, D7); test/presence-oracle.test.ts
 * cross-checks the same kinds of signature against ssh-keygen.
 */

const ALL: TestKeyType[] = ["ssh-ed25519", "sk-ssh-ed25519@openssh.com", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ecdsa-sha2-nistp256@openssh.com", "ssh-rsa"];
const keys = Object.fromEntries(ALL.map((t) => [t, makeTestKey(t)])) as Record<TestKeyType, ReturnType<typeof makeTestKey>>;
const msg = new TextEncoder().encode("tree 0000\nauthor x\n\nverdict: draw #1\n");
const P = "ab".repeat(32);
const verdict = (draw: number, reviewer: string, extra: Partial<VerdictEvent> = {}): VerdictEvent => ({ draw, changeId: `json:acme/widgets#${100 + draw}`, verdict: "pass", protocolSha256: P, reviewer, recordedAt: "2026-10-21T03:00:00Z", ...extra });

describe("SSHSIG verification in TypeScript (FR9.2)", () => {
  for (const t of ALL)
    it(`verifies a ${t} signature, and refuses it after one flipped bit`, () => {
      const sig = keys[t].sign(msg);
      const ok = verifySshsig(sig, msg, "git");
      expect(ok).toMatchObject({ ok: true, namespace: "git", hashAlgorithm: "sha512", key: { type: t } });
      expect(ok.key!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
      expect(verifySshsig(tamperArmor(sig), msg, "git")).toMatchObject({ ok: false });
      expect(verifySshsig(sig, new TextEncoder().encode("another message"), "git")).toMatchObject({ ok: false, problem: "the signature does not match the signed data" });
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
    expect(verifySshsig(k.sign(msg, { namespace: "file" }), msg, "git")).toMatchObject({ ok: false, problem: 'the signature is for namespace "file", not "git"' });
    expect(verifySshsig(k.sign(msg, { hash: "sha256" }), msg, "git")).toMatchObject({ ok: true, hashAlgorithm: "sha256" });
    expect(verifySshsig(k.sign(msg, { hash: "sha1" }), msg, "git")).toMatchObject({ ok: false, problem: 'message hash "sha1" is not sha256 or sha512' });
    expect(verifySshsig(k.sign(msg, { version: 2 }), msg, "git")).toMatchObject({ ok: false, problem: "SSHSIG version 2 is not supported (only 1)" });
    expect(verifySshsig("-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----\n", msg, "git")).toMatchObject({ ok: false, problem: expect.stringMatching(/does not start with -----BEGIN SSH SIGNATURE-----/) });
    expect(verifySshsig(armor(new TextEncoder().encode("NOTSIG\0\0\0\x01")), msg, "git")).toMatchObject({ ok: false, problem: "not an SSHSIG blob (no SSHSIG preamble)" });
    const blob = dearmorSshsig(k.sign(msg));
    expect(verifySshsig(armor(blob.subarray(0, blob.length - 3)), msg, "git")).toMatchObject({ ok: false, problem: expect.stringMatching(/truncated/) });
    expect(verifySshsig(armor(Uint8Array.from([...blob, 0])), msg, "git")).toMatchObject({ ok: false, problem: expect.stringMatching(/trailing byte/) });
  });

  it("a signature claiming another key's identity does not verify", () => {
    const forged = keys["ssh-ed25519"].sign(msg, { claimKey: makeTestKey("ssh-ed25519") });
    expect(verifySshsig(forged, msg, "git").ok).toBe(false);
  });

  it("RSA: SHA-2 signatures only, 2048 bits or more", () => {
    const k = keys["ssh-rsa"];
    expect(verifySshsig(k.sign(msg, { rsaAlgorithm: "rsa-sha2-256" }), msg, "git").ok).toBe(true);
    expect(verifySshsig(k.sign(msg, { rsaAlgorithm: "ssh-rsa" }), msg, "git")).toMatchObject({ ok: false, problem: 'a ssh-rsa key cannot make a "ssh-rsa" signature (SHA-1 RSA signatures are refused)' });
    expect(() => parsePublicKeyText("ssh-rsa", makeTestKey("ssh-rsa", { rsaBits: 1024 }).publicText.split(" ")[1]!)).toThrow(/has 1024 bits; pr-rla accepts 2048 or more/);
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
    const sig = keys["sk-ecdsa-sha2-nistp256@openssh.com"].sign(msg);
    const parsed = parseSshsig(dearmorSshsig(sig));
    expect(parsed.publicKey.application).toBe("ssh:");
    const name = "sk-ecdsa-sha2-nistp256@openssh.com";
    const blob = dearmorSshsig(sig);
    const at = Buffer.from(blob).lastIndexOf(Buffer.from(name));
    const renamed = Buffer.concat([Buffer.from(blob.subarray(0, at - 4)), Buffer.from([0, 0, 0, 43]), Buffer.from(`webauthn-${name}`), Buffer.from(blob.subarray(at + name.length))]);
    // The outer string holding the signature grew by 9 bytes.
    const sigStart = at - 8;
    renamed.writeUInt32BE(renamed.readUInt32BE(sigStart) + 9, sigStart);
    expect(verifySshsig(armor(new Uint8Array(renamed)), msg, "git")).toMatchObject({ ok: false, problem: expect.stringMatching(/web authentication\) signatures are not supported/) });
  });
});

describe("allowed signers (FR9.3)", () => {
  const k = keys["sk-ssh-ed25519@openssh.com"];
  it("parses principals, the namespaces option and the key; prints principal, type and fingerprint", () => {
    const s = parseAllowedSigner(`bob,robert namespaces="git,file" ${k.publicText} bob@laptop`);
    expect(s).toMatchObject({ principals: ["bob", "robert"], namespaces: ["git", "file"], key: { type: "sk-ssh-ed25519@openssh.com", securityKey: true, application: "ssh:" } });
    expect(parseAllowedSigner(`bob ${k.publicText}`).namespaces).toBeNull();
    expect(parseAllowedSigner(`bob NAMESPACES="*" ${k.publicText}`).namespaces).toEqual(["*"]);
    expect(isAllowedSignerEntry(`bob ${k.publicText}`)).toBe(true);
    expect(isAllowedSignerEntry("bob")).toBe(false);
    expect(isAllowedSignerEntry("id:42")).toBe(false);
  });

  it("refuses what a reviewer identity cannot be, and options it does not apply", () => {
    expect(() => parseAllowedSigner(`*@example ${k.publicText}`)).toThrow(/is a pattern; register each reviewer by exact name/);
    expect(() => parseAllowedSigner(`id:42 ${k.publicText}`)).toThrow(/looks like an account id/);
    expect(() => parseAllowedSigner(`bob namespaces="file" ${k.publicText}`)).toThrow(/does not admit namespace "git"/);
    expect(() => parseAllowedSigner(`bob namespaces="*,!git" ${k.publicText}`)).toThrow(/does not admit namespace "git"/);
    expect(() => parseAllowedSigner(`bob cert-authority ${k.publicText}`)).toThrow(/option cert-authority for bob is not supported/);
    expect(() => parseAllowedSigner(`bob valid-after="20260101" ${k.publicText}`)).toThrow(/option valid-after="20260101" for bob is not supported/);
    expect(() => parseAllowedSigner("bob ssh-ed25519")).toThrow(/needs "principal keytype base64-key"/);
    expect(() => parseAllowedSigner('bob namespaces="git ssh-ed25519 AAAA')).toThrow(/unterminated quote/);
  });

  it("matches OpenSSH pattern lists for namespaces", () => {
    expect(matchPatternList("git", ["g?t"])).toBe(true);
    expect(matchPatternList("git", ["*", "!g*"])).toBe(false);
    expect(matchPatternList("git", ["file"])).toBe(false);
  });

  it("a registered principal is an eligible reviewer, case-insensitively, as logins are", () => {
    const reviewers = [`bob ${k.publicText}`, "carol"];
    expect(verdictIneligibility({ reviewer: "Bob" }, reviewers)).toBeNull();
    expect(verdictIneligibility({ reviewer: "carol" }, reviewers)).toBeNull();
    expect(verdictIneligibility({ reviewer: "mallory" }, reviewers)).toBe("mallory is not a registered reviewer");
  });
});

describe("git commit signatures", () => {
  const raw = (headers: string, message = "verdict: draw #1\n") => new TextEncoder().encode(`${headers}\n${message}`);
  const sig = (k: ReturnType<typeof makeTestKey>, payload: string) => k.sign(payload).replace(/\n$/, "").split("\n").join("\n ");
  const H = "tree 7a0e4965abc2bbc40ed031432ba39c31b52b6d44\nauthor a <user-1a1a1a1a@example.invalid> 1 +0000\ncommitter a <user-1a1a1a1a@example.invalid> 1 +0000\n";

  it("splits the gpgsig header out of the payload, exactly as git does", () => {
    const k = keys["ssh-ed25519"];
    const payload = `${H}\nverdict: draw #1\n`;
    const parts = splitCommitSignature(raw(`${H}gpgsig ${sig(k, payload)}\n`));
    expect(new TextDecoder().decode(parts.payload)).toBe(payload);
    // Ed25519 signatures are deterministic, so the armor git stored is exactly the signer's output.
    expect(parts.signature).toBe(k.sign(payload));
    expect(signatureFormat(parts.signature!)).toBe("ssh");
    expect(verifySshsig(parts.signature!, parts.payload, "git").ok).toBe(true);
    expect(splitCommitSignature(raw(H)).signature).toBeNull();
  });

  it("drops another algorithm's signature header from the payload, and reads gpgsig-sha256 in a SHA-256 repository", () => {
    const k = keys["ssh-ed25519"];
    const payload = `${H}\nverdict: draw #1\n`;
    const both = splitCommitSignature(raw(`${H}gpgsig ${sig(k, payload)}\ngpgsig-sha256 -----BEGIN SSH SIGNATURE-----\n abc\n -----END SSH SIGNATURE-----\n`));
    expect(new TextDecoder().decode(both.payload)).toBe(payload);
    expect(verifySshsig(both.signature!, both.payload, "git").ok).toBe(true);
    const h256 = `tree ${"a".repeat(64)}\nauthor a <user-1a1a1a1a@example.invalid> 1 +0000\ncommitter a <user-1a1a1a1a@example.invalid> 1 +0000\n`;
    const p256 = `${h256}\nverdict: draw #1\n`;
    const s256 = splitCommitSignature(raw(`${h256}gpgsig-sha256 ${sig(k, p256)}\n`));
    expect(new TextDecoder().decode(s256.payload)).toBe(p256);
    expect(verifySshsig(s256.signature!, s256.payload, "git").ok).toBe(true);
  });

  it("a message line that looks like a header is part of the payload", () => {
    const k = keys["ssh-ed25519"];
    const message = "verdict\n\ngpgsig not a header\n";
    const payload = `${H}\n${message}`;
    const parts = splitCommitSignature(raw(`${H}gpgsig ${sig(k, payload)}\n`, message));
    expect(new TextDecoder().decode(parts.payload)).toBe(payload);
  });

  it("classifies a commit: unsigned, OpenPGP, invalid, unlisted, signed (with the principals holding the key)", () => {
    const bob = keys["sk-ssh-ed25519@openssh.com"];
    const signers = [parseAllowedSigner(`bob ${bob.publicText}`), parseAllowedSigner(`robert ${bob.publicText}`)];
    const payload = `${H}\nverdict: draw #1\n`;
    expect(checkCommitSignature("c0", raw(H), signers)).toMatchObject({ state: "unsigned" });
    expect(checkCommitSignature("c1", raw(`${H}gpgsig -----BEGIN PGP SIGNATURE-----\n x\n -----END PGP SIGNATURE-----\n`), signers)).toMatchObject({ state: "unsupported", detail: expect.stringMatching(/OpenPGP; only SSH signatures/) });
    expect(checkCommitSignature("c2", raw(`${H}gpgsig ${sig(bob, "something else")}\n`), signers)).toMatchObject({ state: "invalid", detail: expect.stringMatching(/does not verify/) });
    expect(checkCommitSignature("c3", raw(`${H}gpgsig ${sig(keys["ssh-ed25519"], payload)}\n`), signers)).toMatchObject({ state: "unlisted", detail: expect.stringMatching(/which no registered reviewer holds/) });
    expect(checkCommitSignature("c4", raw(`${H}gpgsig ${sig(bob, payload)}\n`), signers)).toMatchObject({ state: "signed", principals: ["bob", "robert"], sk: { userPresent: true } });
    // A namespaces option that does not admit git keeps the key from counting for commits.
    const fileOnly = [{ ...signers[0]!, namespaces: ["file"] } as AllowedSigner];
    expect(checkCommitSignature("c5", raw(`${H}gpgsig ${sig(bob, payload)}\n`), fileOnly)).toMatchObject({ state: "unlisted" });
  });
});

describe("the provenance of a verdict line (FR3.8, FR9.2, FR9.3)", () => {
  const signed = (securityKey: boolean, userPresent?: boolean) => ({ commit: "c".repeat(40), state: "signed" as const, detail: "", key: { type: securityKey ? "sk-ssh-ed25519@openssh.com" : "ssh-ed25519", fingerprint: "SHA256:x", securityKey }, principals: ["bob"], ...(securityKey ? { sk: { flags: userPresent ? 1 : 0, counter: 5, userPresent: !!userPresent, userVerified: false } } : {}) });

  it("a software key gives account; a security key with UP gives presence; UP clear gives account", () => {
    expect(lineProvenance(signed(false), "bob").provenance).toEqual({ level: "account", source: "git-signed-commit", signer: "bob", eventId: "c".repeat(40), keyFingerprint: "SHA256:x" });
    expect(lineProvenance(signed(true, true), "BOB").provenance).toMatchObject({ level: "presence", signer: "bob", counter: 5 });
    expect(lineProvenance(signed(true, false), "bob").provenance).toMatchObject({ level: "account", counter: 5 });
  });

  it("a reviewer the signer is not: self-asserted, and reported", () => {
    expect(lineProvenance(signed(true, true), "alice")).toEqual({ provenance: { level: "self-asserted", source: "git-commit", eventId: "c".repeat(40) }, mismatch: `names reviewer alice but commit cccccccccc was signed by bob` });
  });

  it("uncommitted: no provenance (self-asserted); unsigned, unlisted, invalid: self-asserted", () => {
    expect(lineProvenance(null, "bob")).toEqual({});
    for (const state of ["unsigned", "unlisted", "invalid", "unsupported"] as const) expect(lineProvenance({ commit: "d", state, detail: "" }, "bob").provenance).toEqual({ level: "self-asserted", source: "git-commit", eventId: "d" });
  });

  it("analyzeSignedVerdicts: a line's own claim never counts; a decreasing counter WARNs; an equal one does not", () => {
    const bob = keys["sk-ssh-ed25519@openssh.com"];
    const signers = [parseAllowedSigner(`bob ${bob.publicText}`)];
    const H = (n: number) => `tree ${String(n).padStart(40, "0")}\nauthor a <user-1a1a1a1a@example.invalid> ${n} +0000\ncommitter a <user-1a1a1a1a@example.invalid> ${n} +0000\n`;
    const commit = (n: number, counter: number) => {
      const payload = `${H(n)}\nverdict ${n}\n`;
      return new TextEncoder().encode(`${H(n)}gpgsig ${bob.sign(payload, { counter }).replace(/\n$/, "").split("\n").join("\n ")}\n\nverdict ${n}\n`);
    };
    const commits = new Map([["c1", commit(1, 10)], ["c2", commit(2, 10)], ["c3", commit(3, 4)], ["c4", commit(4, 11)]]);
    const lines = [
      { event: verdict(1, "bob", { provenance: { level: "presence", source: "typed" } }), commit: null },
      { event: verdict(2, "bob"), commit: "c1" },
      { event: verdict(3, "bob"), commit: "c2" },
      { event: verdict(4, "bob"), commit: "c3" },
      { event: verdict(5, "bob"), commit: "c4" },
      { event: verdict(6, "bob"), commit: "gone" },
    ];
    const a = analyzeSignedVerdicts(lines, commits, signers);
    expect(a.events.map((e) => e.provenance?.level ?? "self-asserted")).toEqual(["self-asserted", "presence", "presence", "presence", "presence", "self-asserted"]);
    expect(a.events[0]!.provenance).toBeUndefined();
    expect(a.warnings.filter((w) => /counter went down/.test(w))).toEqual([expect.stringMatching(/went down from 10 \(commit c1\) to 4 \(commit c3\); authenticators differ in counter behaviour, so this is a warning, not a failure/)]);
    expect(a.warnings).toContainEqual(expect.stringMatching(/^commit gone \(draw #6\): the commit object could not be read: self-asserted$/));
  });
});

describe("the rules check 7 applies (FR9.1, FR9.4) and the ceiling", () => {
  const presence = verdict(1, "bob", { provenance: { level: "presence", source: "git-signed-commit", signer: "bob", eventId: "e".repeat(40) } });
  const account = verdict(2, "alice", { provenance: { level: "account", source: "git-signed-commit", signer: "alice", eventId: "f".repeat(40) } });
  const unsigned = verdict(3, "alice", { provenance: { level: "self-asserted", source: "git-commit", eventId: "a".repeat(40) } });
  const issue = verdict(4, "alice", { provenance: { level: "account", source: "scm-label-event", eventId: "9" } });

  it("FR9.4: a verdict below the registered minimum fails; FR9.1: under require_signed an unsigned or uncommitted one fails", () => {
    expect(verdictRuleFailures(presence, { minProvenance: "presence", requireSigned: true })).toEqual([]);
    expect(verdictRuleFailures(account, { minProvenance: "presence" })).toEqual([`verdict on draw #2 (json:acme/widgets#102) is account; the registration requires presence`]);
    expect(verdictRuleFailures(unsigned, { minProvenance: "account" })).toEqual([`verdict on draw #3 (json:acme/widgets#103) is self-asserted; the registration requires account`]);
    expect(verdictRuleFailures(unsigned, { minProvenance: "self-asserted", requireSigned: true })).toEqual([
      `verdict on draw #3 (json:acme/widgets#103) was added in commit aaaaaaaaaa, which its registered reviewer did not sign; the registration requires signed verdict commits (require_signed)`,
    ]);
    expect(verdictRuleFailures(verdict(5, "alice"), { minProvenance: "self-asserted", requireSigned: true })).toEqual([`verdict on draw #5 (json:acme/widgets#105) is not committed; the registration requires signed verdict commits (require_signed)`]);
    // An issue ledger's account verdict is not a signed commit.
    expect(verdictRuleFailures(issue, { minProvenance: "account" })).toEqual([]);
  });

  it("a ledger cannot count a verdict above its ceiling", () => {
    const { verdicts, notes } = capProvenance([presence, account], "account", "tracker");
    expect(verdicts.map((v) => v.provenance!.level)).toEqual(["account", "account"]);
    expect(notes).toEqual(["ledger tracker reported presence for the verdict on draw #1, more than it can attest; counted as account"]);
    expect(capProvenance([presence], "presence", "git-file").notes).toEqual([]);
    expect(capProvenance([presence], undefined, "git-file").verdicts[0]!.provenance!.level).toBe("presence");
  });

  it("FR9.6: the presence level is never printed without its limit", () => {
    expect(provenanceLabel("presence")).toBe("presence (user-presence flag verified; key hardware not attested)");
    expect(PRESENCE_LABEL).toBe(provenanceLabel("presence"));
    expect(provenanceLabel("account")).toBe("account");
  });

  it("the level registered keys can reach", () => {
    expect(reachableProvenance([])).toBe("self-asserted");
    expect(reachableProvenance([parseAllowedSigner(`a ${keys["ssh-ed25519"].publicText}`)])).toBe("account");
    expect(reachableProvenance([parseAllowedSigner(`a ${keys["ssh-ed25519"].publicText}`), parseAllowedSigner(`b ${keys["sk-ecdsa-sha2-nistp256@openssh.com"].publicText}`)])).toBe("presence");
  });
});

describe("the verdict rules a registration fixes (FR3.8, FR9.1, FR9.3, FR9.4)", () => {
  const sw = `alice ${keys["ssh-ed25519"].publicText}`;
  const sk = `bob ${keys["sk-ssh-ed25519@openssh.com"].publicText}`;
  const gitFile = { ledger: "git-file", verifiesSignatures: true, ledgerLevel: "self-asserted" as const, ledgerCeiling: "presence" as const, minProvenance: null, reviewers: null, requireSigned: false };
  const issues = { ledger: "github-issues", verifiesSignatures: false, ledgerLevel: "account" as const, ledgerCeiling: "account" as const, minProvenance: null, reviewers: null, requireSigned: false };

  it("FR3.8: the default minimum is self-asserted with git-file and account with an issue ledger", () => {
    expect(registeredVerdicts(gitFile)).toEqual({ minProvenance: "self-asserted", reviewers: null });
    expect(registeredVerdicts(issues)).toEqual({ minProvenance: "account", reviewers: null });
  });

  it("git-file reaches account with registered keys, presence only with a security key; require_signed is recorded", () => {
    expect(registeredVerdicts({ ...gitFile, minProvenance: "account", reviewers: [sw], requireSigned: true })).toEqual({ minProvenance: "account", reviewers: [sw], require_signed: true });
    expect(registeredVerdicts({ ...gitFile, minProvenance: "presence", reviewers: [sk, sw] })).toEqual({ minProvenance: "presence", reviewers: [sk, sw] });
    expect(() => registeredVerdicts({ ...gitFile, minProvenance: "presence", reviewers: [sw] })).toThrow(/no key in verdicts.reviewers is a FIDO security key .* so no verdict could reach presence/);
    expect(() => registeredVerdicts({ ...gitFile, minProvenance: "account" })).toThrow(/verdicts.min_provenance is account, but ledger git-file records self-asserted verdicts, so no verdict could count; register the reviewers' SSH keys/);
    expect(() => registeredVerdicts({ ...gitFile, requireSigned: true, reviewers: ["alice"] })).toThrow(/require_signed needs the reviewers' SSH keys in verdicts.reviewers/);
  });

  it("issue ledgers top out at account, and SSH keys count only with git-file", () => {
    expect(() => registeredVerdicts({ ...issues, minProvenance: "presence" })).toThrow(/ledger github-issues records account verdicts, so no verdict could count; presence needs the git-file ledger/);
    expect(() => registeredVerdicts({ ...issues, reviewers: [sk] })).toThrow(/lists SSH keys \(bob \(sk-ssh-ed25519@openssh.com SHA256:.*\)\), but ledger github-issues reads accounts, not signed commits/);
    // require_signed is a git-file option: another ledger ignores it.
    expect(registeredVerdicts({ ...issues, requireSigned: true })).toEqual({ minProvenance: "account", reviewers: null });
  });
});

describe("hardening after review (findings 6 and 12)", () => {
  /** An RSA public-key blob with this exponent and the 2048-bit test key's modulus. */
  function rsaBlob(e: number[]): Uint8Array {
    const str = (b: Uint8Array) => Buffer.concat([Buffer.from([(b.length >>> 24) & 0xff, (b.length >>> 16) & 0xff, (b.length >>> 8) & 0xff, b.length & 0xff]), Buffer.from(b)]);
    const n = Buffer.from(keys["ssh-rsa"].blob).subarray(-257); // mpint n: 0x00, then 256 bytes
    return new Uint8Array(Buffer.concat([str(Buffer.from("ssh-rsa")), str(Uint8Array.from(e)), str(n)]));
  }

  it("finding 6: a non-empty reserved field is refused, whatever the signature covers (OpenSSH signs and verifies over an empty one)", () => {
    const k = keys["ssh-ed25519"];
    expect(verifySshsig(k.sign(msg, { reservedBlob: "X", reservedSigned: "X" }), msg, "git")).toMatchObject({ ok: false, problem: "the SSHSIG reserved field is not empty (1 bytes)" });
    expect(verifySshsig(k.sign(msg, { reservedBlob: "X", reservedSigned: "" }), msg, "git")).toMatchObject({ ok: false, problem: "the SSHSIG reserved field is not empty (1 bytes)" });
    expect(verifySshsig(k.sign(msg), msg, "git").ok).toBe(true);
  });

  it("a signature algorithm that does not match the key (or its curve) is refused", () => {
    expect(verifySshsig(keys["ecdsa-sha2-nistp256"].sign(msg, { algorithm: "ecdsa-sha2-nistp384" }), msg, "git")).toMatchObject({ ok: false, problem: 'a ecdsa-sha2-nistp256 key cannot make a "ecdsa-sha2-nistp384" signature' });
  });

  it("finding 12: an RSA public exponent of 1 or an even one is refused; 3 and 65537 are accepted", () => {
    expect(() => parsePublicKeyBlob(rsaBlob([1]))).toThrow(/public exponent is 1 or even/);
    expect(() => parsePublicKeyBlob(rsaBlob([2]))).toThrow(/public exponent is 1 or even/);
    expect(() => parsePublicKeyBlob(rsaBlob([1, 0, 0]))).toThrow(/public exponent is 1 or even/);
    expect(parsePublicKeyBlob(rsaBlob([3])).bits).toBe(2048);
    expect(parsePublicKeyBlob(rsaBlob([1, 0, 1])).bits).toBe(2048);
  });

  it("finding 12: small-order Ed25519 public keys are refused, with either sign bit", () => {
    for (const h of ["0100000000000000000000000000000000000000000000000000000000000000", "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa", "0000000000000000000000000000000000000000000000000000000000000080"]) {
      expect(isSmallOrderEd25519(Uint8Array.from(Buffer.from(h, "hex"))), h).toBe(true);
      const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.from(h, "hex")]);
      expect(() => parsePublicKeyBlob(new Uint8Array(blob))).toThrow(/is a point of small order/);
    }
    expect(isSmallOrderEd25519(new Uint8Array(Buffer.from(keys["ssh-ed25519"].blob).subarray(-32)))).toBe(false);
  });

  it("finding 12: a security key's application must start with ssh:", () => {
    for (const t of ["sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"] as const)
      expect(() => parsePublicKeyText(t, makeTestKey(t, { application: "https://example.org" }).publicText.split(" ")[1]!)).toThrow(/application "https:\/\/example.org" does not start with "ssh:"/);
  });

  it("a webauthn signature made by the emulated authenticator is refused", () => {
    const sig = keys["sk-ecdsa-sha2-nistp256@openssh.com"].sign(msg, { webauthn: { origin: "https://example.org" } });
    expect(verifySshsig(sig, msg, "git")).toMatchObject({ ok: false, problem: expect.stringMatching(/web authentication\) signatures are not supported/) });
  });
});
