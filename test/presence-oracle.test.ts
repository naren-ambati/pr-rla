import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVerdictSignature, parseAllowedSigner, parseAllowedSigners, verdictPayloadText, verifySshsig, type AllowedSigner } from "../src/core/presence/index.js";
import type { VerdictEvent } from "../src/sdk/ledger.js";
import { armor, makeTestKey, tamperArmor, unarmor, type SignOptions, type TestKey } from "./helpers/sshsig-signer.js";
import { NAMESPACE, signedLine, verdictBytes, type LineFields } from "./helpers/verdict-lines.js";
import { quoted } from "../src/core/said.js";

/**
 * The oracle for FR9.2 (test-design.md §2, U9; as changed after review): pr-rla's verdict on each
 * per-verdict signature is cross-checked against OpenSSH's `ssh-keygen -Y verify -I <reviewer>`
 * (signature, allowed signer and principal, matched exactly as pr-rla matches them) and
 * `-Y check-novalidate` (signature only; with -vv it prints a security key's flags and counter).
 * Signatures come from a software-emulated authenticator, from real `ssh-keygen -Y sign` with a
 * software ed25519 key made here, and, recorded, from ssh-keygen with OpenSSH's sk-dummy (-sk keys,
 * UP set and clear). Where pr-rla is deliberately stricter than ssh-keygen, the case says so.
 *
 * ssh-keygen must be installed: without it this file FAILs, unless PR_RLA_SKIP_ORACLE=1 says to skip
 * the cross-check knowingly. It settled the design's open item: `ssh-keygen -Y verify` does not
 * enforce the user-presence flag (OpenSSH 10.3p1: sig_verify only logs the flags at debug2), so
 * pr-rla checks the flag itself.
 */

const SKIP = process.env.PR_RLA_SKIP_ORACLE === "1";
const hasSshKeygen = spawnSync("ssh-keygen", ["-Y", "check-novalidate", "-n", NAMESPACE, "-s", "/nonexistent"], { encoding: "utf8" }).error === undefined;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REG = createHash("sha256").update("oracle registration").digest("hex");
/** The audit the oracle's verdicts are signed for (P4: the registration, the manifest and the seed). */
const B = { registrationSha256: REG, manifestSha256: createHash("sha256").update("oracle manifest").digest("hex"), beaconRound: 22745280, beaconRandomness: createHash("sha256").update("oracle beacon").digest("hex") };
const P = "ab".repeat(32);
const fields = (reviewer: string, extra: Partial<LineFields> = {}): LineFields => ({ draw: 1, changeId: "json:acme/widgets#101", verdict: "pass", protocolSha256: P, reviewer, recordedAt: "2026-10-21T03:00:00Z", ...extra });

interface Oracle {
  /** `ssh-keygen -Y verify -f allowed -I principal -n pr-rla-verdict@v1` exit status. */
  verify: number | null;
  verifyOut: string;
  /** `ssh-keygen -vv -Y check-novalidate -n pr-rla-verdict@v1` exit status. */
  novalidate: number | null;
  /** Security-key details ssh-keygen logged. */
  details: { counter: number; flags: number } | null;
}

let work: string;
function oracle(sig: string, message: Uint8Array | string, allowed: string[], principal: string): Oracle {
  const d = mkdtempSync(join(work, "case-"));
  writeFileSync(join(d, "allowed_signers"), `${allowed.join("\n")}\n`);
  writeFileSync(join(d, "verdict.sig"), sig);
  const v = spawnSync("ssh-keygen", ["-Y", "verify", "-f", join(d, "allowed_signers"), "-I", principal, "-n", NAMESPACE, "-s", join(d, "verdict.sig")], { input: message, encoding: "utf8" });
  const n = spawnSync("ssh-keygen", ["-vv", "-Y", "check-novalidate", "-n", NAMESPACE, "-s", join(d, "verdict.sig")], { input: message, encoding: "utf8" });
  const m = /signature details: counter = (\d+), flags = 0x([0-9a-f]{2})/.exec(n.stderr);
  return { verify: v.status, verifyOut: `${v.stdout}${v.stderr}`.trim(), novalidate: n.status, details: m ? { counter: Number(m[1]), flags: Number.parseInt(m[2]!, 16) } : null };
}

/** pr-rla's verdict through the production check (checkVerdictSignature): valid as a signature, and counted for this reviewer. */
function prRla(line: string, allowed: string[]) {
  let signers: AllowedSigner[];
  try {
    signers = parseAllowedSigners(allowed);
  } catch {
    signers = allowed.flatMap((l) => {
      try {
        return [parseAllowedSigner(l)];
      } catch {
        return [];
      }
    });
  }
  const c = checkVerdictSignature(JSON.parse(line) as VerdictEvent, B, signers);
  return { valid: c.state === "signed" || c.state === "unlisted" || c.state === "mismatch", accepted: c.state === "signed", sk: c.sk ? { counter: c.sk.counter, flags: c.sk.flags } : null, state: c.state, detail: c.detail };
}

interface Case {
  /** The armored signature, the bytes ssh-keygen verifies it over, the line pr-rla reads, the allowed signers and the principal. */
  sig: string;
  bytes: string;
  line: string;
  allowed: string[];
  principal: string;
  expect: { valid: boolean; accepted: boolean; flags?: number; counter?: number };
  /** Where pr-rla refuses what ssh-keygen accepts, and why. */
  stricter?: string;
}

let k: Record<string, TestKey>;
/** A case signed by the emulated authenticator over the verdict bytes, or over other bytes (`bytesFor`). */
function signed(key: TestKey, reviewer: string, allowed: string[], expectation: Case["expect"], opts: SignOptions & { fields?: Partial<LineFields>; stricter?: string; bytesFor?: Partial<typeof B>; v1?: boolean } = {}): Case {
  const f = fields(reviewer, opts.fields);
  const line = signedLine(B, f, key, opts);
  const sig = armor(new Uint8Array(Buffer.from(JSON.parse(line).sshsig as string, "base64")));
  return { sig, bytes: verdictBytes(B, f), line, allowed, principal: reviewer, expect: expectation, ...(opts.stricter ? { stricter: opts.stricter } : {}) };
}

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
    rsa1024: makeTestKey("ssh-rsa", { rsaBits: 1024 }),
    other: makeTestKey("ssh-ed25519"),
  };
});

if (!hasSshKeygen && !SKIP)
  describe("oracle: ssh-keygen", () => {
    it("is required: install OpenSSH's ssh-keygen, or set PR_RLA_SKIP_ORACLE=1 to skip the cross-check knowingly", () => {
      expect.fail("ssh-keygen is not installed, so pr-rla's SSHSIG verifier was not cross-checked against OpenSSH");
    });
  });

describe.skipIf(SKIP || !hasSshKeygen)("oracle: ssh-keygen -Y verify and check-novalidate against pr-rla's verdict check (FR9.2)", () => {
  const as = (key: () => TestKey, principal: string, options?: string) => () => key().allowedSigner(principal, options);
  const cases: [string, () => Case][] = [
    ["ssh-ed25519", () => signed(k.ed25519!, "alice", [as(() => k.ed25519!, "alice")()], { valid: true, accepted: true })],
    ["ssh-ed25519 with namespaces=\"pr-rla-verdict@v1\"", () => signed(k.ed25519!, "alice", [k.ed25519!.allowedSigner("alice", `namespaces="${NAMESPACE}"`)], { valid: true, accepted: true })],
    ["ecdsa-sha2-nistp256", () => signed(k.p256!, "frank", [k.p256!.allowedSigner("frank")], { valid: true, accepted: true })],
    ["ecdsa-sha2-nistp384", () => signed(k.p384!, "heidi", [k.p384!.allowedSigner("heidi")], { valid: true, accepted: true })],
    ["ecdsa-sha2-nistp521", () => signed(k.p521!, "ivan", [k.p521!.allowedSigner("ivan")], { valid: true, accepted: true })],
    ["ssh-rsa 3072, rsa-sha2-512", () => signed(k.rsa!, "grace", [k.rsa!.allowedSigner("grace")], { valid: true, accepted: true })],
    ["ssh-rsa 3072, rsa-sha2-256", () => signed(k.rsa!, "grace", [k.rsa!.allowedSigner("grace")], { valid: true, accepted: true }, { rsaAlgorithm: "rsa-sha2-256" })],
    ["sk-ssh-ed25519, UP set", () => signed(k.edSk!, "bob", [k.edSk!.allowedSigner("bob")], { valid: true, accepted: true, flags: 0x01, counter: 42 }, { flags: 0x01, counter: 42 })],
    ["sk-ecdsa-sha2-nistp256, UP set", () => signed(k.ecSk!, "carol", [k.ecSk!.allowedSigner("carol")], { valid: true, accepted: true, flags: 0x01, counter: 7 }, { flags: 0x01, counter: 7 })],
    ["sk-ssh-ed25519, UP clear", () => signed(k.edSk!, "bob", [k.edSk!.allowedSigner("bob")], { valid: true, accepted: true, flags: 0x00, counter: 43 }, { flags: 0x00, counter: 43 })],
    ["sk-ecdsa-sha2-nistp256, UP clear", () => signed(k.ecSk!, "carol", [k.ecSk!.allowedSigner("carol")], { valid: true, accepted: true, flags: 0x00, counter: 8 }, { flags: 0x00, counter: 8 })],
    ["sk-ssh-ed25519, UP and UV", () => signed(k.edSk!, "bob", [k.edSk!.allowedSigner("bob")], { valid: true, accepted: true, flags: 0x05, counter: 2 ** 31 }, { flags: 0x05, counter: 2 ** 31 })],
    ["sha256 message hash", () => signed(k.ed25519!, "alice", [k.ed25519!.allowedSigner("alice")], { valid: true, accepted: true }, { hash: "sha256" })],
    ["a valid signature by an unlisted key", () => signed(k.other!, "alice", [k.ed25519!.allowedSigner("alice")], { valid: true, accepted: false })],
    ["a registered key, but under another principal", () => signed(k.edSk!, "alice", [k.edSk!.allowedSigner("bob")], { valid: true, accepted: false, flags: 0x01, counter: 1 })],
    ["finding 10: a principal that differs only in case (exact, as -I matches)", () => signed(k.edSk!, "Bob", [k.edSk!.allowedSigner("bob")], { valid: true, accepted: false, flags: 0x01, counter: 1 })],
    ["a flipped signature bit (ed25519)", () => ({ ...signed(k.ed25519!, "alice", [k.ed25519!.allowedSigner("alice")], { valid: false, accepted: false }), tamper: 10 }) as Case],
    ["the verdict flipped after signing", () => {
      const c = signed(k.edSk!, "bob", [k.edSk!.allowedSigner("bob")], { valid: false, accepted: false }, { fields: { verdict: "fail" } });
      // The line now says pass: pr-rla checks the bytes of what the line says, and so does ssh-keygen here.
      const line = JSON.stringify({ ...JSON.parse(c.line), verdict: "pass" });
      return { ...c, line, bytes: verdictBytes(B, fields("bob")) };
    }],
    ["signed for another registration", () => {
      const other = createHash("sha256").update("another audit").digest("hex");
      const c = signed(k.edSk!, "bob", [k.edSk!.allowedSigner("bob")], { valid: false, accepted: false }, { bytesFor: { registrationSha256: other } });
      return c; // ssh-keygen verifies it over this audit's bytes, as pr-rla does
    }],
    ["P4: signed for another manifest under the same registration", () => signed(k.edSk!, "bob", [k.edSk!.allowedSigner("bob")], { valid: false, accepted: false }, { bytesFor: { manifestSha256: "e6".repeat(32) } })],
    ["P4: signed for another seed (beacon randomness)", () => signed(k.edSk!, "bob", [k.edSk!.allowedSigner("bob")], { valid: false, accepted: false }, { bytesFor: { beaconRandomness: "f7".repeat(32) } })],
    ["P4: signed over the v1 bytes (no manifest, no seed), verified over this audit's v2 bytes", () => signed(k.edSk!, "bob", [k.edSk!.allowedSigner("bob")], { valid: false, accepted: false }, { v1: true })],
    ["namespace git (a commit signature), verified as pr-rla-verdict@v1", () => signed(k.ed25519!, "alice", [k.ed25519!.allowedSigner("alice")], { valid: false, accepted: false }, { namespace: "git" })],
    ["SSHSIG version 2", () => signed(k.ed25519!, "alice", [k.ed25519!.allowedSigner("alice")], { valid: false, accepted: false }, { version: 2 })],
    ["a blob claiming another key", () => signed(k.other!, "alice", [k.ed25519!.allowedSigner("alice")], { valid: false, accepted: false }, { claimKey: k.ed25519! })],
    ["a legacy SHA-1 ssh-rsa signature", () => signed(k.rsa!, "grace", [k.rsa!.allowedSigner("grace")], { valid: false, accepted: false }, { rsaAlgorithm: "ssh-rsa" })],
    ["finding 6: reserved \"X\" in the blob, signed over \"X\"", () => signed(k.ed25519!, "alice", [k.ed25519!.allowedSigner("alice")], { valid: false, accepted: false }, { reservedBlob: "X", reservedSigned: "X" })],
    [
      "finding 6: reserved \"X\" in the blob, signed over an empty one",
      () => signed(k.ed25519!, "alice", [k.ed25519!.allowedSigner("alice")], { valid: false, accepted: false }, { reservedBlob: "X", reservedSigned: "", stricter: "ssh-keygen ignores the reserved field's content; pr-rla refuses a non-empty one, so no byte of a signature goes unchecked" }),
    ],
    ["finding 10: a curve/algorithm mismatch (P-256 key, nistp384 algorithm)", () => signed(k.p256!, "frank", [k.p256!.allowedSigner("frank")], { valid: false, accepted: false }, { algorithm: "ecdsa-sha2-nistp384" })],
    [
      "finding 10: RSA under 2048 bits (1024)",
      () => signed(k.rsa1024!, "grace", [k.rsa1024!.allowedSigner("grace")], { valid: false, accepted: false }, { stricter: "OpenSSH accepts RSA keys of 1024 bits or more; pr-rla requires 2048" }),
    ],
    [
      "finding 10: a webauthn-sk-ecdsa signature",
      () => signed(k.ecSk!, "carol", [k.ecSk!.allowedSigner("carol")], { valid: false, accepted: false }, { webauthn: { origin: "https://example.org" }, stricter: "ssh-keygen verifies WebAuthn signatures; pr-rla refuses them (ssh-keygen never makes one, and their clientData is a second format to get right)" }),
    ],
  ];

  it.each(cases)("%s", (_name, make) => {
    const c0 = make() as Case & { tamper?: number };
    const c = c0.tamper ? { ...c0, sig: tamperArmor(c0.sig, c0.tamper), line: JSON.stringify({ ...JSON.parse(c0.line), sshsig: unarmor(tamperArmor(c0.sig, c0.tamper)) }) } : c0;
    const mine = prRla(c.line, c.allowed);
    const theirs = oracle(c.sig, c.bytes, c.allowed, c.principal);
    expect(mine.valid, quoted(mine.detail)).toBe(c.expect.valid);
    expect(mine.accepted, quoted(mine.detail)).toBe(c.expect.accepted);
    if (c.stricter) {
      // ssh-keygen accepts it; pr-rla refuses on purpose.
      expect(theirs.verify, `${c.stricter}: ${theirs.verifyOut}`).toBe(0);
      expect(theirs.novalidate).toBe(0);
    } else {
      // ssh-keygen agrees: check-novalidate on the signature alone, -Y verify with the allowed signers and the reviewer as principal.
      expect(theirs.novalidate === 0, theirs.verifyOut).toBe(mine.valid);
      expect(theirs.verify === 0, theirs.verifyOut).toBe(mine.accepted);
    }
    if (c.expect.flags !== undefined) {
      expect(mine.sk).toEqual({ flags: c.expect.flags, counter: c.expect.counter });
      expect(theirs.details).toEqual(mine.sk);
    }
  });

  it("finding 12: a small-order Ed25519 key makes one 'signature' valid for every message in ssh-keygen; pr-rla refuses the key", () => {
    const identity = Buffer.alloc(32);
    identity[0] = 1;
    const str = (b: Uint8Array | string) => {
      const body = Buffer.from(b);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      return Buffer.concat([len, body]);
    };
    const blob = Buffer.concat([str("ssh-ed25519"), str(identity)]);
    const bytes = verdictBytes(B, fields("mallory"));
    const sshsig = Buffer.concat([Buffer.from("SSHSIG"), Buffer.from([0, 0, 0, 1]), str(blob), str(NAMESPACE), str(""), str("sha512"), str(Buffer.concat([str("ssh-ed25519"), str(Buffer.concat([identity, Buffer.alloc(32)]))]))]);
    const allowed = [`mallory ssh-ed25519 ${blob.toString("base64")}`];
    expect(oracle(armor(new Uint8Array(sshsig)), bytes, allowed, "mallory").verify).toBe(0);
    expect(() => parseAllowedSigner(allowed[0]!)).toThrow(/is a point of small order/);
    expect(prRla(JSON.stringify({ ...fields("mallory"), registrationSha256: REG, sshsig: sshsig.toString("base64") }), allowed).accepted).toBe(false);
  });

  it("FINDING: ssh-keygen -Y verify does not enforce the user-presence flag; pr-rla does (account, not presence)", () => {
    const c = signed(k.edSk!, "bob", [k.edSk!.allowedSigner("bob")], { valid: true, accepted: true }, { flags: 0x00, counter: 5 });
    const theirs = oracle(c.sig, c.bytes, c.allowed, "bob");
    expect(theirs.verify).toBe(0);
    expect(theirs.verifyOut).toMatch(/^Good "pr-rla-verdict@v1" signature for bob with ED25519-SK key SHA256:/);
    expect(theirs.details).toEqual({ counter: 5, flags: 0 });
    expect(verifySshsig(c.sig, new TextEncoder().encode(c.bytes), NAMESPACE).sk).toMatchObject({ userPresent: false });
  });

  it("a namespaces option without pr-rla-verdict@v1: ssh-keygen refuses the signature, and pr-rla refuses the entry at registration", () => {
    const line = k.ed25519!.allowedSigner("alice", 'namespaces="git"');
    const c = signed(k.ed25519!, "alice", [line], { valid: true, accepted: false });
    expect(oracle(c.sig, c.bytes, [line], "alice").verify).not.toBe(0);
    expect(() => parseAllowedSigner(line)).toThrow(/does not admit namespace "pr-rla-verdict@v1"/);
  });

  it("real ssh-keygen -Y sign, a software ed25519 key made here: the README's bytes, signed by hand, count as account", () => {
    const d = mkdtempSync(join(work, "keygen-"));
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "dana", "-f", join(d, "dana")], { stdio: "ignore", env: { PATH: process.env.PATH, HOME: d } });
    const pub = readFileSync(join(d, "dana.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
    const allowed = [`dana namespaces="${NAMESPACE}" ${pub}`];
    const f = fields("dana");
    writeFileSync(join(d, "verdict.txt"), verdictBytes(B, f));
    execFileSync("ssh-keygen", ["-Y", "sign", "-n", NAMESPACE, "-f", join(d, "dana"), join(d, "verdict.txt")], { stdio: "ignore", env: { PATH: process.env.PATH, HOME: d } });
    const sig = readFileSync(join(d, "verdict.txt.sig"), "utf8");
    const line = JSON.stringify({ ...f, registrationSha256: REG, schema: "pr-rla/verdict/v1", sshsig: unarmor(sig) });
    const mine = prRla(line, allowed);
    expect(mine).toMatchObject({ valid: true, accepted: true, sk: null });
    expect(oracle(sig, verdictBytes(B, f), allowed, "dana").verify).toBe(0);
    expect(verdictPayloadText({ ...B, ...f })).toBe(readFileSync(join(d, "verdict.txt"), "utf8"));
    // A flipped verdict under the same signature: both refuse.
    expect(prRla(JSON.stringify({ ...JSON.parse(line), verdict: "fail" }), allowed).accepted).toBe(false);
    expect(oracle(sig, verdictBytes(B, { ...f, verdict: "fail" }), allowed, "dana").verify).not.toBe(0);
  });

  it("the recorded sk-dummy signatures (real ssh-keygen -Y sign, -sk keys with UP set and clear) verify in ssh-keygen as they do in pr-rla, flags and counter included", () => {
    const fx = JSON.parse(readFileSync(join(ROOT, "test/fixtures/presence/sk-dummy-verdicts.json"), "utf8")) as {
      registrationSha256: string;
      manifestSha256: string;
      beaconRound: number;
      beaconRandomness: string;
      allowedSigners: string[];
      steps: { draw: number; reviewer: string; signer: string | null; namespace?: string; registrationSha256?: string; manifestSha256?: string; payloadVersion?: string; payload: string; line: string }[];
    };
    const signers = parseAllowedSigners(fx.allowedSigners);
    let sk = 0;
    for (const s of fx.steps.filter((x) => x.signer)) {
      const v = JSON.parse(s.line) as VerdictEvent;
      // Each signature against the audit it was made for (another registration or manifest for the foreign ones).
      const c = checkVerdictSignature(v, { registrationSha256: s.registrationSha256 ?? fx.registrationSha256, manifestSha256: s.manifestSha256 ?? fx.manifestSha256, beaconRound: fx.beaconRound, beaconRandomness: fx.beaconRandomness }, signers);
      const theirs = oracle(armor(new Uint8Array(Buffer.from(v.sshsig!, "base64"))), s.payload, fx.allowedSigners, s.reviewer);
      if (s.payloadVersion === "v1") {
        // Stricter on purpose: ssh-keygen accepts the signature over the v1 bytes it was made over; pr-rla refuses v1 bytes, which name no manifest and no seed.
        expect(theirs.verify, `draw #${s.draw}: ${theirs.verifyOut}`).toBe(0);
        expect(c).toMatchObject({ state: "invalid", detail: expect.stringMatching(/pr-rla-verdict\/v1 bytes/) });
        continue;
      }
      expect(theirs.verify === 0, `draw #${s.draw}: ${theirs.verifyOut}`).toBe(c.state === "signed");
      if (c.sk) {
        sk++;
        expect(theirs.details, `draw #${s.draw}`).toEqual({ counter: c.sk.counter, flags: c.sk.flags });
      }
    }
    expect(sk).toBeGreaterThanOrEqual(5); // bob and carol with UP set, dave and erin with UP clear, and bob's foreign ones
  });
});
