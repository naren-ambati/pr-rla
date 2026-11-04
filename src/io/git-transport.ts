import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECKPOINTS_FILE, HISTORY_DIR, unionCheckpointLines } from "../core/checkpoint.js";
import { gitWriteEnv } from "./git-safe.js";
import { gitExecutable } from "./executables.js";

/**
 * The checkpoint git transport (contracts.md §6; FR4.4): how a checkpoint appended in one
 * clone reaches the audit repo's remote while other clones (CI, a reviewer) append too.
 *
 * It runs outside the fetch broker (git speaks its own protocols with the user's own
 * credentials), with a 30 s timeout per git call, in src/io/git-safe.ts's write-side environment. It refuses a dirty tree, a detached HEAD
 * and a branch with no upstream; commits on the current branch; then up to 3 times fetches,
 * rebases onto the remote branch (replaying every unpushed local commit, git-file verdict
 * commits included: nothing is reset or discarded), resolves a conflict only in the
 * checkpoint files by union, and pushes. It never forces, and never resets.
 */

export const GIT_TIMEOUT_MS = 30_000;
export const MAX_PUSH_ATTEMPTS = 3;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one git command in the repo. Never throws for a non-zero exit; tests wrap it to inject races. */
export type GitRunner = (args: string[], env?: Record<string, string>) => Promise<GitResult>;

export function nodeGit(cwd: string, timeoutMs = GIT_TIMEOUT_MS): GitRunner {
  return (args, env = {}) =>
    new Promise((resolve) => {
      // git by absolute path (P4): never a git the audit repository supplies; in git-safe's write-side environment.
      execFile(gitExecutable(), args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...gitWriteEnv(), ...env } }, (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (e?.killed) return resolve({ code: -1, stdout, stderr: `git ${args[0]} timed out after ${timeoutMs / 1000} s` });
        resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr });
      });
    });
}

export interface PushTarget {
  remote: string;
  branch: string;
}

export type Precondition = { ok: true; top: string; branch: string; target: PushTarget } | { ok: false; reason: string };

/** The refusals of contracts.md §6, checked before anything is written. */
export async function checkPreconditions(git: GitRunner, opts: { remote?: string; branch?: string } = {}): Promise<Precondition> {
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ok: false, reason: "the audit directory is not in a git repository" };
  const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.code !== 0) return { ok: false, reason: `git status failed: ${dirty.stderr.trim()}` };
  if (dirty.stdout.trim()) return { ok: false, reason: `the working tree has uncommitted changes (${dirty.stdout.trim().split("\n").length} path(s)); commit them first, so the checkpoint commit holds only the checkpoint` };
  const head = await git(["symbolic-ref", "-q", "--short", "HEAD"]);
  if (head.code !== 0) return { ok: false, reason: "HEAD is detached; check out the audit branch first" };
  const branch = head.stdout.trim();
  if (opts.remote && opts.branch) return { ok: true, top: top.stdout.trim(), branch, target: { remote: opts.remote, branch: opts.branch } };
  if (opts.remote || opts.branch) return { ok: false, reason: "--remote and --branch go together" };
  const remote = await git(["config", "--get", `branch.${branch}.remote`]);
  const merge = await git(["config", "--get", `branch.${branch}.merge`]);
  if (remote.code !== 0 || merge.code !== 0 || !remote.stdout.trim() || !merge.stdout.trim())
    return { ok: false, reason: `branch ${branch} has no upstream; set one (git branch --set-upstream-to <remote>/<branch>) or pass --remote and --branch` };
  return { ok: true, top: top.stdout.trim(), branch, target: { remote: remote.stdout.trim(), branch: merge.stdout.trim().replace(/^refs\/heads\//, "") } };
}

export type PushOutcome = { ok: true; attempts: number; head: string } | { ok: false; attempts: number; reason: string };

const isCheckpointPath = (p: string) => p.endsWith(`/${CHECKPOINTS_FILE}`) || p === CHECKPOINTS_FILE;
const isHistoryPath = (p: string) => p.includes(`/${HISTORY_DIR}/`) || p.startsWith(`${HISTORY_DIR}/`);
/** A push that lost a race: the remote branch moved (or was being moved) under it. Anything else is not retried. */
const REJECTED = /\[rejected\]|non-fast-forward|fetch first|failed to update ref|stale info|cannot lock ref/i;

/**
 * Replays local commits onto `FETCH_HEAD`. A conflict confined to ledger-checkpoints.jsonl is
 * resolved by union (remote lines, then ours not already there); anything else aborts the rebase,
 * which leaves the branch exactly as it was.
 */
async function rebase(git: GitRunner, top: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let r = await git(["rebase", "FETCH_HEAD"], { GIT_EDITOR: "true" });
  while (r.code !== 0) {
    const u = await git(["diff", "--name-only", "--diff-filter=U"]);
    const paths = u.stdout.split("\n").filter(Boolean);
    const other = paths.filter((p) => !isCheckpointPath(p));
    if (!paths.length || other.length) {
      await git(["rebase", "--abort"]);
      const why = paths.length ? `conflicts in ${other.join(", ")}${other.some(isHistoryPath) ? "" : ", which are not checkpoint files"}` : r.stderr.trim().split("\n")[0];
      return { ok: false, reason: `rebasing onto the remote branch stopped: ${why}; the rebase was aborted, the branch is as it was, and nothing was pushed` };
    }
    for (const p of paths) {
      const theirs = await git(["show", `:2:${p}`]); // during a rebase, stage 2 is the branch being rebased onto (the remote)
      const ours = await git(["show", `:3:${p}`]); // and stage 3 the local commit being replayed
      writeFileSync(join(top, p), unionCheckpointLines(theirs.code === 0 ? theirs.stdout : "", ours.code === 0 ? ours.stdout : ""));
      await git(["add", "--", p]);
    }
    // The remote already holds this checkpoint (same identity, same event list): the replayed commit is empty, so it is skipped.
    const staged = await git(["diff", "--cached", "--quiet"]);
    r = staged.code === 0 ? await git(["rebase", "--skip"], { GIT_EDITOR: "true" }) : await git(["-c", "core.editor=true", "rebase", "--continue"], { GIT_EDITOR: "true" });
  }
  return { ok: true };
}

/** Commits `files` and pushes them (contracts.md §6 steps 1–3). Never passes --force. */
export async function commitAndPush(git: GitRunner, input: { top: string; files: string[]; message: string; target: PushTarget; attempts?: number; log?: (line: string) => void }): Promise<PushOutcome> {
  const add = await git(["add", "--", ...input.files]);
  if (add.code !== 0) return { ok: false, attempts: 0, reason: `git add failed: ${add.stderr.trim()}` };
  const commit = await git(["commit", "-q", "-m", input.message, "--", ...input.files]);
  if (commit.code !== 0) return { ok: false, attempts: 0, reason: `git commit failed: ${(commit.stderr || commit.stdout).trim()}` };
  const max = input.attempts ?? MAX_PUSH_ATTEMPTS;
  const { remote, branch } = input.target;
  let last = "";
  for (let attempt = 1; attempt <= max; attempt++) {
    const fetched = await git(["fetch", "-q", remote, branch]);
    if (fetched.code === 0) {
      const rb = await rebase(git, input.top);
      if (!rb.ok) return { ok: false, attempts: attempt, reason: rb.reason };
    } else if (!/couldn't find remote ref/i.test(fetched.stderr)) {
      last = `git fetch ${remote} ${branch} failed: ${fetched.stderr.trim()}`;
      input.log?.(`checkpoint: ${last} (attempt ${attempt} of ${max})`);
      continue;
    }
    const pushed = await git(["push", "-q", remote, `HEAD:${branch}`]);
    if (pushed.code === 0) {
      const head = await git(["rev-parse", "HEAD"]);
      return { ok: true, attempts: attempt, head: head.stdout.trim() };
    }
    if (!REJECTED.test(pushed.stderr)) return { ok: false, attempts: attempt, reason: `git push ${remote} HEAD:${branch} failed: ${pushed.stderr.trim()}` };
    last = `the push to ${remote}/${branch} was rejected (the remote moved on)`;
    input.log?.(`checkpoint: ${last}; fetching and rebasing again (attempt ${attempt} of ${max})`);
  }
  return { ok: false, attempts: max, reason: `${last || "the push did not succeed"}, ${max} times; nothing was forced. The checkpoint is committed locally` };
}
