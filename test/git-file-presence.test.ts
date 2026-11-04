import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger } from "../src/registry.js";
import type { Ledger, VerdictEvent } from "../src/sdk/ledger.js";
import { commitAll, commitStaged } from "./helpers/signed-commits.js";
import { makeTestKey } from "./helpers/sshsig-signer.js";

/**
 * The git-file ledger's side of U9: which commit added each verdict line (git blame on the
 * working tree), read as the objects git names and nothing else, and the line's provenance from
 * that commit's signature. Local repositories and software keys only (D8, D7).
 */
const bob = makeTestKey("sk-ssh-ed25519@openssh.com");
const alice = makeTestKey("ssh-ed25519");
const reviewers = [bob.allowedSigner("bob"), alice.allowedSigner("alice")];
const P = "cd".repeat(32);
const line = (draw: number, reviewer: string) => `${JSON.stringify({ changeId: `json:acme/widgets#${100 + draw}`, draw, protocolSha256: P, recordedAt: "2026-10-21T03:00:00Z", reviewer, schema: "pr-rla/verdict/v1", verdict: "pass" })}\n`;
let dir: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=user-1a2b3c4d@example.invalid", ...args], { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const ledgerIn = (d: string, opts: Record<string, unknown> = {}, rv: string[] | null = reviewers): Promise<Ledger> => createLedger({ use: "git-file", options: opts }, { cwd: d, windowDir: join(d, "audit/w"), env: {}, log: () => {}, fetch: globalThis.fetch, reviewers: rv });
const append = (draw: number, reviewer: string) => appendFileSync(join(dir, "audit/w/verdicts.jsonl"), line(draw, reviewer));
const levels = (vs: VerdictEvent[]) => vs.map((v) => [v.draw, v.provenance?.level ?? "self-asserted"]);
const bobSign = (counter: number) => (p: string) => bob.sign(p, { counter });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prrla-gitfile-"));
  mkdirSync(join(dir, "audit/w"), { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README"), "audit\n");
  commitAll(dir, "audit repo", null);
});

describe("git-file: each line takes its own commit's signature", () => {
  it("lines appended in separate commits, several lines in one commit, and an uncommitted line", async () => {
    append(1, "bob");
    commitAll(dir, "draw 1", bobSign(1));
    append(2, "alice");
    append(3, "alice");
    commitAll(dir, "draws 2 and 3", (p) => alice.sign(p));
    append(4, "bob");
    commitAll(dir, "draw 4, unsigned", null);
    append(5, "bob");
    const l = await ledgerIn(dir);
    expect(levels(await l.readVerdicts())).toEqual([[1, "presence"], [2, "account"], [3, "account"], [4, "self-asserted"], [5, "self-asserted"]]);
    const r = await l.verifyIntegrity!();
    expect(r.ok).toBe(true);
    expect(r.findings).toContain("1 verdict line(s) not yet committed (no tamper trail for them until committed)");
    expect(r.findings).toContainEqual(expect.stringMatching(/\(draw #4\): not signed: self-asserted$/));
    expect(r.warnings).toEqual([]);
  });

  it("a line merged in from another branch keeps the signature of the commit that added it", async () => {
    append(1, "bob");
    commitAll(dir, "draw 1", bobSign(1));
    git("checkout", "-q", "-b", "side");
    append(2, "alice");
    commitAll(dir, "draw 2 on a branch", (p) => alice.sign(p));
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge", "side");
    expect(levels(await (await ledgerIn(dir)).readVerdicts())).toEqual([[1, "presence"], [2, "account"]]);
  });

  it("the next append is read afresh (the analysis is not kept across appendVerdict)", async () => {
    append(1, "bob");
    commitAll(dir, "draw 1", bobSign(1));
    const l = await ledgerIn(dir);
    expect(levels(await l.readVerdicts())).toEqual([[1, "presence"]]);
    await l.appendVerdict({ draw: 2, changeId: "json:acme/widgets#102", verdict: "fail", protocolSha256: P, reviewer: "alice", recordedAt: "2026-10-21T04:00:00Z" });
    expect(levels(await l.readVerdicts())).toEqual([[1, "presence"], [2, "self-asserted"]]);
    git("add", "-A");
    commitStaged(dir, "draw 2", (p) => alice.sign(p));
    expect(levels(await (await ledgerIn(dir)).readVerdicts())).toEqual([[1, "presence"], [2, "account"]]);
  });

  it("outside a git repository every line is self-asserted", async () => {
    const bare = mkdtempSync(join(tmpdir(), "prrla-nogit-"));
    mkdirSync(join(bare, "audit/w"), { recursive: true });
    writeFileSync(join(bare, "audit/w/verdicts.jsonl"), line(1, "bob"));
    const l = await ledgerIn(bare);
    expect(levels(await l.readVerdicts())).toEqual([[1, "self-asserted"]]);
    expect((await l.verifyIntegrity!()).findings).toEqual(["verdicts are not in a git repository: there is no tamper trail"]);
  });
});

describe("git-file reads the objects git names, and nothing else", () => {
  it("a replace ref cannot swap an unsigned verdict commit for a signed one", async () => {
    append(1, "bob");
    const unsigned = commitAll(dir, "draw 1, unsigned", null);
    // The same tree and parent, signed by bob: a genuine signature over a different commit object.
    const parent = git("rev-parse", `${unsigned}^`);
    const tree = git("rev-parse", `${unsigned}^{tree}`);
    const raw = `tree ${tree}\nparent ${parent}\nauthor b <user-2b3c4d5e@example.invalid> 1792551600 +0000\ncommitter b <user-2b3c4d5e@example.invalid> 1792551600 +0000\n`;
    const body = "\ndraw 1\n";
    const signed = `${raw}gpgsig ${bob.sign(raw + body).replace(/\n$/, "").split("\n").join("\n ")}\n${body}`;
    const forged = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: dir, input: signed, encoding: "utf8" }).trim();
    git("replace", unsigned, forged);
    // Plain git now shows the signed object under the unsigned commit's name...
    expect(git("cat-file", "commit", unsigned)).toMatch(/^gpgsig -----BEGIN SSH SIGNATURE-----$/m);
    // ...and the ledger does not.
    const l = await ledgerIn(dir);
    expect(levels(await l.readVerdicts())).toEqual([[1, "self-asserted"]]);
  });

  it("an ignore-revs list in the verifier's configuration does not move a line to another commit", async () => {
    append(1, "bob");
    commitAll(dir, "draw 1", bobSign(1));
    append(2, "bob");
    const unsigned = commitAll(dir, "draw 2, unsigned", null);
    writeFileSync(join(dir, ".ignore-revs"), `${unsigned}\n`);
    git("config", "blame.ignoreRevsFile", ".ignore-revs");
    expect(levels(await (await ledgerIn(dir)).readVerdicts())).toEqual([[1, "presence"], [2, "self-asserted"]]);
    git("config", "blame.ignoreRevsFile", "missing-file");
    expect(levels(await (await ledgerIn(dir)).readVerdicts())).toEqual([[1, "presence"], [2, "self-asserted"]]);
  });

  it("a rewritten history still FAILs the append-only check, signatures or not", async () => {
    append(1, "bob");
    commitAll(dir, "draw 1", bobSign(1));
    writeFileSync(join(dir, "audit/w/verdicts.jsonl"), line(1, "alice"));
    commitAll(dir, "rewrite", (p) => alice.sign(p));
    const r = await (await ledgerIn(dir)).verifyIntegrity!();
    expect(r.ok).toBe(false);
    expect(r.findings).toContainEqual(expect.stringMatching(/was rewritten \(not appended\) in commit/));
  });
});

describe("git-file options and registered reviewers", () => {
  it("require_signed must be true or false; file must be a name", async () => {
    await expect(ledgerIn(dir, { require_signed: "yes" })).rejects.toThrow(/option require_signed must be true or false/);
    await expect(ledgerIn(dir, { file: 3 })).rejects.toThrow(/option file must be a file name/);
    await expect(ledgerIn(dir, { require_signed: true })).resolves.toMatchObject({ name: "git-file" });
  });

  it("a malformed registered key makes the ledger refuse to open, naming the entry", async () => {
    await expect(ledgerIn(dir, {}, ["bob sk-ssh-ed25519@openssh.com AAAA"])).rejects.toThrow(/allowed-signers entry for bob/);
  });

  it("logins and id: entries among the reviewers are not keys", async () => {
    append(1, "bob");
    commitAll(dir, "draw 1", bobSign(1));
    expect(levels(await (await ledgerIn(dir, {}, ["bob", "id:42"])).readVerdicts())).toEqual([[1, "self-asserted"]]);
  });
});
