import { execFileSync } from "node:child_process";

/**
 * Git commits signed in the SSH format without ssh-keygen: the commit object git would write for
 * `git commit -S` (gpg.format=ssh), with its `gpgsig` header made by a test signer
 * (test/helpers/sshsig-signer.ts). Local repositories only (D8). Git's own `verify-commit` reads
 * them like any signed commit (test/presence-oracle.test.ts checks that).
 */

export const TEST_IDENTITY = "pr-rla test <user-5e1f2a3b@example.invalid>";

const run = (dir: string, args: string[], input?: string) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...(input !== undefined ? { input } : {}) }).trim();

/** The commit object for the staged tree on top of HEAD, signed by `sign` over git's payload (null: unsigned). */
export function commitStaged(dir: string, message: string, sign: ((payload: string) => string) | null, opts: { unix?: number; identity?: string } = {}): string {
  const tree = run(dir, ["write-tree"]);
  let parent: string | null = null;
  try {
    parent = run(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
  } catch {
    parent = null;
  }
  const who = `${opts.identity ?? TEST_IDENTITY} ${opts.unix ?? 1792551600} +0000`;
  const headers = `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author ${who}\ncommitter ${who}\n`;
  const body = `\n${message}\n`;
  // git signs the object without the gpgsig header, and stores the signature after committer, continuation lines indented by one space.
  const sig = sign ? sign(headers + body) : null;
  const raw = sig ? `${headers}gpgsig ${sig.replace(/\n$/, "").split("\n").join("\n ")}\n${body}` : headers + body;
  const sha = run(dir, ["hash-object", "-t", "commit", "-w", "--stdin"], raw);
  run(dir, ["update-ref", "HEAD", sha]);
  return sha;
}

/** `git add -A` then a (signed) commit. */
export function commitAll(dir: string, message: string, sign: ((payload: string) => string) | null, opts: { unix?: number; identity?: string } = {}): string {
  run(dir, ["add", "-A"]);
  return commitStaged(dir, message, sign, opts);
}

export const rawCommit = (dir: string, sha: string) => new Uint8Array(execFileSync("git", ["cat-file", "commit", sha], { cwd: dir }));
