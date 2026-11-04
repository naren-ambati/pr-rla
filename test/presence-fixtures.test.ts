import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCommitSignature, parseAllowedSigner, verdictRuleFailures } from "../src/core/presence/index.js";
import { createLedger } from "../src/registry.js";
import type { Ledger, VerdictEvent } from "../src/sdk/ledger.js";

/**
 * FR9.5 on commits made by real OpenSSH tooling: `git commit -S` (gpg.format=ssh) through
 * ssh-keygen 10.3p1, with software keys, and for the -sk keys OpenSSH's sk-dummy middleware, a
 * software-emulated authenticator (scripts/make-presence-fixtures.mjs; source: synthetic, D7).
 * The repository is rebuilt from the fixture with plain git plumbing, to the same commit SHAs, and
 * read by the git-file ledger with the fixture's allowed signers registered.
 */

interface Step {
  draw: number;
  reviewer: string;
  signer: string | null;
  expect: { level: "self-asserted" | "account" | "presence"; why: string };
  file: string;
  content: string;
  tree: string;
  commit: string;
  raw: string;
  oracle: { gitVerifyCommit: { exit: number; output: string }; sshKeygenSignatureDetails?: { flags: number; counter: number } };
}
interface Fixture {
  source: string;
  made: string;
  allowedSigners: string[];
  unlisted: Record<string, string>;
  steps: Step[];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = JSON.parse(readFileSync(join(ROOT, "test/fixtures/presence/sk-dummy-verdicts.json"), "utf8")) as Fixture;
const step = (draw: number) => fx.steps.find((s) => s.draw === draw)!;
let dir: string;
let ledger: Ledger;
let verdicts: VerdictEvent[];
const byDraw = (d: number) => verdicts.find((v) => v.draw === d)!;

/** Rebuilds the fixture's history with git plumbing (any git version): same trees, same commits. */
function rebuild(): string {
  const d = mkdtempSync(join(tmpdir(), "prrla-presence-fx-"));
  const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: d, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...(input !== undefined ? { input } : {}) }).trim();
  git(["init", "-q"]);
  for (const s of fx.steps) {
    mkdirSync(join(d, dirname(s.file)), { recursive: true });
    writeFileSync(join(d, s.file), s.content);
    git(["add", s.file]);
    expect(git(["write-tree"])).toBe(s.tree);
    expect(git(["hash-object", "-t", "commit", "-w", "--stdin"], s.raw)).toBe(s.commit);
    git(["update-ref", "HEAD", s.commit]);
  }
  return d;
}

beforeAll(async () => {
  dir = rebuild();
  ledger = await createLedger({ use: "git-file", options: {} }, { cwd: dir, windowDir: join(dir, "audit/w"), env: {}, log: () => {}, fetch: globalThis.fetch, reviewers: fx.allowedSigners });
  verdicts = await ledger.readVerdicts();
});

describe("the sk-dummy fixture (synthetic: OpenSSH tooling, software keys only)", () => {
  it("is marked synthetic, keeps public keys only, and rebuilds to the same commits", () => {
    expect(fx.source).toBe("synthetic");
    expect(readFileSync(join(ROOT, "test/fixtures/presence/sk-dummy-verdicts.json"), "utf8")).not.toMatch(/PRIVATE KEY/);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()).toBe(fx.steps.at(-1)!.commit);
  });

  it("every line gets the level its commit's signature gives it", () => {
    expect(verdicts.map((v) => [v.draw, v.provenance?.level])).toEqual(fx.steps.map((s) => [s.draw, s.expect.level]));
  });

  it("FR9.2: pr-rla reads the same flags and counter from each -sk signature as ssh-keygen -vv did when it was made", () => {
    const signers = fx.allowedSigners.map(parseAllowedSigner);
    for (const s of fx.steps.filter((x) => x.signer)) {
      const c = checkCommitSignature(s.commit, new TextEncoder().encode(s.raw), signers);
      const details = s.oracle.sshKeygenSignatureDetails;
      if (details) expect(c.sk, `draw #${s.draw}`).toMatchObject({ flags: details.flags, counter: details.counter });
      else expect(c.sk, `draw #${s.draw}`).toBeUndefined();
      // The key git reported for a good signature is the key pr-rla verified.
      const fp = /key (SHA256:\S+)/.exec(s.oracle.gitVerifyCommit.output)?.[1];
      expect(c.key?.fingerprint, `draw #${s.draw}`).toBe(fp);
    }
  });

  it("each software key type gives account: ed25519, ECDSA P-256, P-384, P-521 and RSA 3072", () => {
    for (const d of [1, 9, 10, 11, 12]) expect(byDraw(d).provenance, step(d).expect.why).toMatchObject({ level: "account", source: "git-signed-commit", signer: step(d).reviewer, eventId: step(d).commit });
  });

  it("FR9.5 (1): an -sk signature with UP set passes at presence (ed25519-sk and ecdsa-sk)", () => {
    for (const d of [2, 3]) {
      expect(byDraw(d).provenance).toMatchObject({ level: "presence", source: "git-signed-commit", signer: step(d).reviewer, counter: 0x12345678 });
      expect(verdictRuleFailures(byDraw(d), { minProvenance: "presence", requireSigned: true })).toEqual([]);
    }
  });

  it("FR9.5 (2): one with UP clear fails at presence (no-touch-required keys), and is account", () => {
    for (const d of [4, 5]) {
      expect(byDraw(d).provenance).toMatchObject({ level: "account", source: "git-signed-commit", signer: step(d).reviewer });
      expect(verdictRuleFailures(byDraw(d), { minProvenance: "presence" })).toEqual([`verdict on draw #${d} (json:acme/widgets#${100 + d}) is account; the registration requires presence`]);
      expect(verdictRuleFailures(byDraw(d), { minProvenance: "account", requireSigned: true })).toEqual([]);
    }
  });

  it("FR9.5 (3): an unlisted signer fails (FR9.3)", () => {
    expect(byDraw(6).provenance).toEqual({ level: "self-asserted", source: "git-commit", eventId: step(6).commit });
    expect(verdictRuleFailures(byDraw(6), { minProvenance: "account" })).toHaveLength(1);
    expect(verdictRuleFailures(byDraw(6), { minProvenance: "self-asserted", requireSigned: true })).toEqual([expect.stringMatching(/which its registered reviewer did not sign; the registration requires signed verdict commits \(require_signed\)/)]);
  });

  it("FR9.5 (4): an unsigned verdict under require_signed fails (FR9.1)", () => {
    expect(byDraw(7).provenance).toEqual({ level: "self-asserted", source: "git-commit", eventId: step(7).commit });
    expect(verdictRuleFailures(byDraw(7), { minProvenance: "self-asserted", requireSigned: true })).toEqual([
      `verdict on draw #7 (json:acme/widgets#107) was added in commit ${step(7).commit.slice(0, 10)}, which its registered reviewer did not sign; the registration requires signed verdict commits (require_signed)`,
    ]);
  });

  it("a reviewer/principal mismatch is self-asserted and reported (git itself reports a good signature by bob)", async () => {
    expect(step(8).oracle.gitVerifyCommit).toMatchObject({ exit: 0, output: expect.stringMatching(/Good "git" signature for bob/) });
    expect(byDraw(8).provenance?.level).toBe("self-asserted");
    const integrity = await ledger.verifyIntegrity!();
    expect(integrity.ok).toBe(true);
    expect(integrity.warnings).toContain(`verdict on draw #8 names reviewer alice but commit ${step(8).commit.slice(0, 10)} was signed by bob: self-asserted`);
  });

  it("verifyIntegrity: WARNs for the unlisted signer and the mismatch; notes the unsigned commit and the touch-less signatures", async () => {
    const r = await ledger.verifyIntegrity!();
    expect(r).toMatchObject({ ok: true, tamperTrail: true });
    expect(r.warnings).toEqual([
      `verdict on draw #8 names reviewer alice but commit ${step(8).commit.slice(0, 10)} was signed by bob: self-asserted`,
      expect.stringMatching(new RegExp(`^commit ${step(6).commit.slice(0, 10)} \\(draw #6\\): signed by key SHA256:\\S+ \\(ssh-ed25519\\), which no registered reviewer holds: self-asserted$`)),
    ]);
    expect(r.findings).toEqual([
      expect.stringMatching(new RegExp(`^commit ${step(4).commit.slice(0, 10)} \\(draw #4\\): signed by dave's sk-ssh-ed25519@openssh.com key SHA256:\\S+ without the user-presence flag \\(no touch\\): account, not presence$`)),
      expect.stringMatching(new RegExp(`^commit ${step(5).commit.slice(0, 10)} \\(draw #5\\): signed by erin's sk-ecdsa-sha2-nistp256@openssh.com key .* without the user-presence flag`)),
      `commit ${step(7).commit.slice(0, 10)} (draw #7): not signed: self-asserted`,
    ]);
  });

  it("sk-dummy's counter is a constant (0x12345678): equal counters are not a decreasing counter", async () => {
    const counters = fx.steps.flatMap((s) => (s.oracle.sshKeygenSignatureDetails ? [s.oracle.sshKeygenSignatureDetails.counter] : []));
    expect(new Set(counters)).toEqual(new Set([0x12345678]));
    expect((await ledger.verifyIntegrity!()).warnings!.some((w) => /counter went down/.test(w))).toBe(false);
  });

  it("without registered keys every line is self-asserted, signed or not", async () => {
    const plain = await createLedger({ use: "git-file", options: {} }, { cwd: dir, windowDir: join(dir, "audit/w"), env: {}, log: () => {}, fetch: globalThis.fetch });
    expect((await plain.readVerdicts()).every((v) => v.provenance === undefined)).toBe(true);
    expect((await plain.verifyIntegrity!()).warnings).toBeUndefined();
  });
});
