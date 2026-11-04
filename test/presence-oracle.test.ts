import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommitSignature, parseAllowedSigner, signersFor, splitCommitSignature, verifySshsig } from "../src/core/presence/index.js";
import { makeTestKey, tamperArmor, type TestKey } from "./helpers/sshsig-signer.js";
import { commitAll, rawCommit } from "./helpers/signed-commits.js";

/**
 * The oracle for FR9.2 (test-design.md §2, U9): every outcome of pr-rla's TypeScript SSHSIG
 * verifier is cross-checked against OpenSSH's `ssh-keygen -Y verify` (signature and allowed
 * signer) and `-Y check-novalidate` (signature only; with -vv it prints a security key's flags
 * and counter), and signed commits against `git verify-commit`. ssh-keygen verifies -sk signatures
 * purely in software, so no authenticator is needed. Skipped only where ssh-keygen is missing.
 *
 * It also settles the design's open item "whether ssh-keygen -Y verify enforces the presence flag":
 * it does not. A signature with the user-presence flag clear verifies, and neither -Y verify nor
 * the allowed-signers format has an option that requires the flag (OpenSSH 10.3p1: sig_verify in
 * ssh-keygen.c only logs the flags at debug2). That is why pr-rla checks the flag itself.
 */

const hasSshKeygen = spawnSync("ssh-keygen", ["-Y", "check-novalidate", "-n", "git", "-s", "/nonexistent"], { encoding: "utf8" }).error === undefined;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const enc = (s: string) => new TextEncoder().encode(s);

interface Oracle {
  /** `ssh-keygen -Y verify -f allowed -I principal -n git` exit status. */
  verify: number | null;
  verifyOut: string;
  /** `ssh-keygen -vv -Y check-novalidate -n git` exit status. */
  novalidate: number | null;
  /** Security-key details ssh-keygen logged. */
  details: { counter: number; flags: number } | null;
}

let work: string;
function oracle(sig: string, message: Uint8Array, allowed: string[], principal: string, namespace = "git"): Oracle {
  const d = mkdtempSync(join(work, "case-"));
  writeFileSync(join(d, "allowed_signers"), `${allowed.join("\n")}\n`);
  writeFileSync(join(d, "msg.sig"), sig);
  const v = spawnSync("ssh-keygen", ["-Y", "verify", "-f", join(d, "allowed_signers"), "-I", principal, "-n", namespace, "-s", join(d, "msg.sig")], { input: message, encoding: "utf8" });
  const n = spawnSync("ssh-keygen", ["-vv", "-Y", "check-novalidate", "-n", namespace, "-s", join(d, "msg.sig")], { input: message, encoding: "utf8" });
  const m = /signature details: counter = (\d+), flags = 0x([0-9a-f]{2})/.exec(n.stderr);
  return { verify: v.status, verifyOut: `${v.stdout}${v.stderr}`.trim(), novalidate: n.status, details: m ? { counter: Number(m[1]), flags: Number.parseInt(m[2]!, 16) } : null };
}

/** pr-rla's verdict on the same input: the signature, and whether a registered signer holds the key under that principal. */
function prRla(sig: string, message: Uint8Array, allowed: string[], principal: string) {
  const v = verifySshsig(sig, message, "git");
  const holders = v.ok ? signersFor(v.key!, allowed.map(parseAllowedSigner)) : [];
  return { valid: v.ok, accepted: v.ok && holders.some((h) => h.principals.includes(principal)), sk: v.sk ? { counter: v.sk.counter, flags: v.sk.flags } : null };
}

const message = enc("tree 7a0e4965abc2bbc40ed031432ba39c31b52b6d44\nauthor r <user-9a8b7c6d@example.invalid> 1792551600 +0000\n\nverdict: draw #1\n");
let k: Record<string, TestKey>;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "prrla-oracle-"));
  k = {
    ed25519: makeTestKey("ssh-ed25519"),
    edSk: makeTestKey("sk-ssh-ed25519@openssh.com"),
    p256: makeTestKey("ecdsa-sha2-nistp256"),
    p384: makeTestKey("ecdsa-sha2-nistp384"),
    p521: makeTestKey("ecdsa-sha2-nistp521"),
    ecSk: makeTestKey("sk-ecdsa-sha2-nistp256@openssh.com"),
    rsa: makeTestKey("ssh-rsa", { rsaBits: 3072 }),
    other: makeTestKey("ssh-ed25519"),
  };
});

describe.skipIf(!hasSshKeygen)("oracle: ssh-keygen -Y verify and check-novalidate agree with pr-rla's verifier (FR9.2)", () => {
  const cases: [string, () => { sig: string; allowed: string[]; principal: string; expect: { valid: boolean; accepted: boolean; flags?: number; counter?: number } }][] = [
    ["ssh-ed25519", () => ({ sig: k.ed25519!.sign(message), allowed: [k.ed25519!.allowedSigner("alice")], principal: "alice", expect: { valid: true, accepted: true } })],
    ["ecdsa-sha2-nistp256", () => ({ sig: k.p256!.sign(message), allowed: [k.p256!.allowedSigner("frank")], principal: "frank", expect: { valid: true, accepted: true } })],
    ["ecdsa-sha2-nistp384", () => ({ sig: k.p384!.sign(message), allowed: [k.p384!.allowedSigner("heidi")], principal: "heidi", expect: { valid: true, accepted: true } })],
    ["ecdsa-sha2-nistp521", () => ({ sig: k.p521!.sign(message), allowed: [k.p521!.allowedSigner("ivan")], principal: "ivan", expect: { valid: true, accepted: true } })],
    ["ssh-rsa, rsa-sha2-512", () => ({ sig: k.rsa!.sign(message), allowed: [k.rsa!.allowedSigner("grace")], principal: "grace", expect: { valid: true, accepted: true } })],
    ["ssh-rsa, rsa-sha2-256", () => ({ sig: k.rsa!.sign(message, { rsaAlgorithm: "rsa-sha2-256" }), allowed: [k.rsa!.allowedSigner("grace")], principal: "grace", expect: { valid: true, accepted: true } })],
    ["sk-ssh-ed25519, UP set", () => ({ sig: k.edSk!.sign(message, { flags: 0x01, counter: 42 }), allowed: [k.edSk!.allowedSigner("bob")], principal: "bob", expect: { valid: true, accepted: true, flags: 0x01, counter: 42 } })],
    ["sk-ecdsa-sha2-nistp256, UP set", () => ({ sig: k.ecSk!.sign(message, { flags: 0x01, counter: 7 }), allowed: [k.ecSk!.allowedSigner("carol")], principal: "carol", expect: { valid: true, accepted: true, flags: 0x01, counter: 7 } })],
    ["sk-ssh-ed25519, UP clear", () => ({ sig: k.edSk!.sign(message, { flags: 0x00, counter: 43 }), allowed: [k.edSk!.allowedSigner("bob")], principal: "bob", expect: { valid: true, accepted: true, flags: 0x00, counter: 43 } })],
    ["sk-ecdsa-sha2-nistp256, UP clear", () => ({ sig: k.ecSk!.sign(message, { flags: 0x00, counter: 8 }), allowed: [k.ecSk!.allowedSigner("carol")], principal: "carol", expect: { valid: true, accepted: true, flags: 0x00, counter: 8 } })],
    ["sk-ssh-ed25519, UP and UV", () => ({ sig: k.edSk!.sign(message, { flags: 0x05, counter: 2 ** 31 }), allowed: [k.edSk!.allowedSigner("bob")], principal: "bob", expect: { valid: true, accepted: true, flags: 0x05, counter: 2 ** 31 } })],
    ["sha256 message hash", () => ({ sig: k.ed25519!.sign(message, { hash: "sha256" }), allowed: [k.ed25519!.allowedSigner("alice")], principal: "alice", expect: { valid: true, accepted: true } })],
    ["a valid signature by an unlisted key", () => ({ sig: k.other!.sign(message), allowed: [k.ed25519!.allowedSigner("alice")], principal: "alice", expect: { valid: true, accepted: false } })],
    ["a registered key, but under another principal", () => ({ sig: k.edSk!.sign(message), allowed: [k.edSk!.allowedSigner("bob")], principal: "alice", expect: { valid: true, accepted: false, flags: 0x01, counter: 1 } })],
    ["a flipped signature bit (ed25519)", () => ({ sig: tamperArmor(k.ed25519!.sign(message)), allowed: [k.ed25519!.allowedSigner("alice")], principal: "alice", expect: { valid: false, accepted: false } })],
    ["a flipped signature bit (ecdsa P-384)", () => ({ sig: tamperArmor(k.p384!.sign(message)), allowed: [k.p384!.allowedSigner("heidi")], principal: "heidi", expect: { valid: false, accepted: false } })],
    ["a flipped signature bit (rsa)", () => ({ sig: tamperArmor(k.rsa!.sign(message)), allowed: [k.rsa!.allowedSigner("grace")], principal: "grace", expect: { valid: false, accepted: false } })],
    ["a flipped signature bit (sk-ecdsa)", () => ({ sig: tamperArmor(k.ecSk!.sign(message), 12), allowed: [k.ecSk!.allowedSigner("carol")], principal: "carol", expect: { valid: false, accepted: false } })],
    ["UP set after signing (sk-ssh-ed25519)", () => ({ sig: tamperArmor(k.edSk!.sign(message, { flags: 0x00 }), 5), allowed: [k.edSk!.allowedSigner("bob")], principal: "bob", expect: { valid: false, accepted: false } })],
    ["UP set after signing (sk-ecdsa)", () => ({ sig: tamperArmor(k.ecSk!.sign(message, { flags: 0x00 }), 5), allowed: [k.ecSk!.allowedSigner("carol")], principal: "carol", expect: { valid: false, accepted: false } })],
    ["the counter changed after signing (sk-ssh-ed25519)", () => ({ sig: tamperArmor(k.edSk!.sign(message, { counter: 9 }), 1), allowed: [k.edSk!.allowedSigner("bob")], principal: "bob", expect: { valid: false, accepted: false } })],
    ["namespace file, verified as git", () => ({ sig: k.ed25519!.sign(message, { namespace: "file" }), allowed: [k.ed25519!.allowedSigner("alice")], principal: "alice", expect: { valid: false, accepted: false } })],
    ["SSHSIG version 2", () => ({ sig: k.ed25519!.sign(message, { version: 2 }), allowed: [k.ed25519!.allowedSigner("alice")], principal: "alice", expect: { valid: false, accepted: false } })],
    ["a blob claiming another key", () => ({ sig: k.other!.sign(message, { claimKey: k.ed25519 }), allowed: [k.ed25519!.allowedSigner("alice")], principal: "alice", expect: { valid: false, accepted: false } })],
    ["a legacy SHA-1 ssh-rsa signature", () => ({ sig: k.rsa!.sign(message, { rsaAlgorithm: "ssh-rsa" }), allowed: [k.rsa!.allowedSigner("grace")], principal: "grace", expect: { valid: false, accepted: false } })],
  ];

  it.each(cases)("%s", (_name, make) => {
    const c = make();
    const mine = prRla(c.sig, message, c.allowed, c.principal);
    const theirs = oracle(c.sig, message, c.allowed, c.principal);
    expect(mine.valid).toBe(c.expect.valid);
    expect(mine.accepted).toBe(c.expect.accepted);
    // ssh-keygen agrees: check-novalidate on the signature alone, -Y verify on signature plus allowed signer and principal.
    expect(theirs.novalidate === 0, theirs.verifyOut).toBe(mine.valid);
    expect(theirs.verify === 0, theirs.verifyOut).toBe(mine.accepted);
    if (c.expect.flags !== undefined) {
      expect(mine.sk).toEqual({ flags: c.expect.flags, counter: c.expect.counter });
      expect(theirs.details).toEqual(mine.sk);
    }
  });

  it("FINDING: ssh-keygen -Y verify does not enforce the user-presence flag; pr-rla does (account, not presence)", () => {
    const sig = k.edSk!.sign(message, { flags: 0x00, counter: 5 });
    const theirs = oracle(sig, message, [k.edSk!.allowedSigner("bob")], "bob");
    expect(theirs.verify).toBe(0);
    expect(theirs.verifyOut).toMatch(/^Good "git" signature for bob with ED25519-SK key SHA256:/);
    expect(theirs.details).toEqual({ counter: 5, flags: 0 });
    expect(verifySshsig(sig, message, "git").sk).toMatchObject({ userPresent: false });
  });

  it("a namespaces option without git: ssh-keygen refuses the signature, and pr-rla refuses the entry at registration", () => {
    const line = k.ed25519!.allowedSigner("alice", 'namespaces="file"');
    expect(oracle(k.ed25519!.sign(message), message, [line], "alice").verify).not.toBe(0);
    expect(() => parseAllowedSigner(line)).toThrow(/does not admit namespace "git"/);
  });

  it("git verify-commit agrees with pr-rla on commits signed through the software-emulated authenticator", () => {
    const d = mkdtempSync(join(work, "repo-"));
    spawnSync("git", ["init", "-q"], { cwd: d });
    const allowed = [k.ed25519!.allowedSigner("alice"), k.edSk!.allowedSigner("bob")];
    writeFileSync(join(d, "allowed_signers"), `${allowed.join("\n")}\n`);
    const signers = allowed.map(parseAllowedSigner);
    const outcomes: [string, string | null, boolean][] = [];
    const make = (name: string, sign: ((p: string) => string) | null, expectGood: boolean) => {
      writeFileSync(join(d, "f"), `${name}\n`);
      outcomes.push([commitAll(d, name, sign), name, expectGood]);
    };
    make("alice ed25519", (p) => k.ed25519!.sign(p), true);
    make("bob sk UP set", (p) => k.edSk!.sign(p, { flags: 0x01 }), true);
    make("bob sk UP clear", (p) => k.edSk!.sign(p, { flags: 0x00 }), true);
    make("unlisted", (p) => k.other!.sign(p), false);
    make("signed over other bytes", (p) => k.ed25519!.sign(`${p}x`), false);
    make("unsigned", null, false);
    for (const [sha, name, good] of outcomes) {
      const git = spawnSync("git", ["-c", `gpg.ssh.allowedSignersFile=${join(d, "allowed_signers")}`, "verify-commit", sha], { cwd: d, encoding: "utf8" });
      const mine = checkCommitSignature(sha, rawCommit(d, sha), signers);
      expect(git.status === 0, `${name}: ${git.stderr}`).toBe(good);
      expect(mine.state === "signed", name!).toBe(good);
    }
  });

  it("the recorded sk-dummy commits verify in ssh-keygen as they do in pr-rla, flags and counter included", () => {
    const fx = JSON.parse(readFileSync(join(ROOT, "test/fixtures/presence/sk-dummy-verdicts.json"), "utf8")) as { allowedSigners: string[]; steps: { draw: number; signer: string | null; raw: string }[] };
    for (const s of fx.steps.filter((x) => x.signer)) {
      const { payload, signature } = splitCommitSignature(enc(s.raw));
      const mine = prRla(signature!, payload, fx.allowedSigners, s.signer!);
      const theirs = oracle(signature!, payload, fx.allowedSigners, s.signer!);
      expect(theirs.novalidate === 0, `draw #${s.draw}`).toBe(mine.valid);
      expect(theirs.verify === 0, `draw #${s.draw}: ${theirs.verifyOut}`).toBe(mine.accepted);
      expect(theirs.details, `draw #${s.draw}`).toEqual(mine.sk);
    }
  });
});

describe.skipIf(hasSshKeygen)("oracle unavailable", () => {
  it("UNVERIFIED: ssh-keygen is not installed here, so the cross-check did not run", () => {});
});
