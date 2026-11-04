import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointCommand } from "../src/commands/checkpoint.js";
import { registerCommand } from "../src/commands/register.js";
import { parseCheckpointLines } from "../src/core/checkpoint.js";
import { nodeGit, type GitRunner } from "../src/io/git-transport.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";

/**
 * The checkpoint git transport (contracts.md §6; FR4.4), against a LOCAL BARE repository only:
 * no remote host, no network (D8). The bare repo refuses non-fast-forward pushes and keeps a
 * reflog, so a forced update would be both refused and visible.
 */
const W = "audit/2026-q3";
const LINES = `${W}/ledger-checkpoints.jsonl`;
const gitIn = (cwd: string) => (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Records every git call and lets a test act just before chosen ones (a race with another clone). */
function recordingGit(cwd: string, before: (args: string[]) => Promise<void> | void = () => {}): GitRunner & { calls: string[][] } {
  const inner = nodeGit(cwd);
  const calls: string[][] = [];
  const g = (async (args: string[], env?: Record<string, string>) => {
    calls.push(args);
    await before(args);
    return inner(args, { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com", ...env });
  }) as GitRunner & { calls: string[][] };
  g.calls = calls;
  return g;
}

let bare: string;
let a: Scenario;
const fake = new FakeGitHubIssues();
const tracker = (async (input: string | URL | Request, init?: RequestInit) => fake.fetch(input, init)) as typeof fetch;

/** An audit repo (registered, github-issues ledger, no authorities) pushed to a fresh bare repo; clones are copies of it. */
async function audit(): Promise<Scenario> {
  const s = setupAuditRepo({ changes: makeChanges(160), fetch: tracker });
  s.ctx.env = { GITHUB_TOKEN: "t" };
  appendFileSync(join(s.dir, ".pr-rla.yml"), "ledger: { use: github-issues, options: { repo: acme/audit } }\n");
  s.clock.now = T("2026-10-20T00:00:00Z");
  expect(await registerCommand(s.ctx, {})).toBe(0);
  s.git("add", "-A");
  s.git("commit", "-qm", "registration");
  s.git("branch", "-M", "main");
  bare = mkdtempSync(join(tmpdir(), "prrla-bare-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", bare]);
  const b = gitIn(bare);
  b("config", "receive.denyNonFastForwards", "true");
  b("config", "receive.denyDeletes", "true");
  b("config", "core.logAllRefUpdates", "always");
  s.git("remote", "add", "origin", bare);
  s.git("push", "-q", "-u", "origin", "main");
  return s;
}
const clone = (s: Scenario, iso: string) => {
  const c = cloneScenario(s);
  c.ctx.env = { GITHUB_TOKEN: "t" };
  c.clock.now = T(iso);
  return c;
};
const remoteFile = (path: string) => gitIn(bare)("show", `main:${path}`);
/** Every update of the bare repo's main was a fast-forward (its reflog, oldest first). */
function onlyFastForwards(): boolean {
  const log = gitIn(bare)("reflog", "show", "--format=%H", "refs/heads/main").trim().split("\n").reverse();
  const isAncestor = (older: string, newer: string) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", older, newer], { cwd: bare, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  return log.length > 1 && log.every((sha, i) => i === 0 || isAncestor(log[i - 1]!, sha));
}

beforeEach(async () => {
  a = await audit();
}, 60_000);

describe("checkpoint --push across clones (local bare repo)", () => {
  it("two clones push at once: both lines land after a rebase and a union, with no force push", async () => {
    const b = clone(a, "2026-10-21T03:00:01Z");
    a.clock.now = T("2026-10-21T03:00:00Z");
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((r) => (release = r));
    // Both clones reach their first push before either sends it.
    const atPush = async (args: string[]) => {
      if (args[0] === "push" && arrived < 2) {
        if (++arrived === 2) release();
        await together;
      }
    };
    const ga = recordingGit(a.dir, atPush);
    const gb = recordingGit(b.dir, atPush);
    const [ca, cb] = await Promise.all([checkpointCommand(a.ctx, { push: true, git: ga }), checkpointCommand(b.ctx, { push: true, git: gb })]);
    expect([ca, cb]).toEqual([0, 0]);
    const { lines } = parseCheckpointLines(remoteFile(LINES), LINES);
    expect(lines.map((l) => l.takenAt).sort()).toEqual(["2026-10-21T03:00:00Z", "2026-10-21T03:00:01Z"]);
    expect([...a.out, ...b.out].join("\n")).toMatch(/attempt 2 of 3, no force/);
    for (const args of [...ga.calls, ...gb.calls]) expect(args.some((x) => /^--force|^-f$|^\+/.test(x))).toBe(false);
    expect(onlyFastForwards()).toBe(true);
  });

  it("two clones checkpoint the same history in the same second: the replayed duplicate is skipped and reads once", async () => {
    const b = clone(a, "2026-10-21T03:00:00Z");
    a.clock.now = T("2026-10-21T03:00:00Z");
    expect(await checkpointCommand(a.ctx, { push: true, git: recordingGit(a.dir) })).toBe(0);
    expect(await checkpointCommand(b.ctx, { push: true, git: recordingGit(b.dir) })).toBe(0);
    const text = remoteFile(LINES);
    expect(text.trim().split("\n")).toHaveLength(1);
    // A file in which one checkpoint appears twice (e.g. a hand-made merge) reads as one checkpoint.
    expect(parseCheckpointLines(`${text}${text}`, LINES).lines).toHaveLength(1);
  });

  it("an unpushed git-file verdict commit is replayed by the rebase, never discarded", async () => {
    const c = clone(a, "2026-10-21T03:00:05Z");
    a.clock.now = T("2026-10-21T03:00:00Z");
    expect(await checkpointCommand(a.ctx, { push: true, git: recordingGit(a.dir) })).toBe(0);
    // Clone c has a local verdict commit it never pushed, and has not seen a's checkpoint.
    appendFileSync(join(c.dir, W, "verdicts.jsonl"), '{"draw":1,"note":"local only"}\n');
    c.git("add", "-A");
    c.git("commit", "-qm", "verdict on draw 1");
    expect(await checkpointCommand(c.ctx, { push: true, git: recordingGit(c.dir) })).toBe(0);
    const log = gitIn(bare)("log", "--format=%s", "main");
    expect(log).toMatch(/verdict on draw 1/);
    expect(log.match(/pr-rla checkpoint 2026-q3/g)).toHaveLength(2);
    expect(remoteFile(`${W}/verdicts.jsonl`)).toBe('{"draw":1,"note":"local only"}\n');
    expect(onlyFastForwards()).toBe(true);
  });

  it("refuses a dirty tree, a detached HEAD and a branch with no upstream (exit 1), and writes nothing", async () => {
    const before = gitIn(a.dir)("status", "--porcelain");
    writeFileSync(join(a.dir, "review-protocol.md"), "edited\n");
    await expect(checkpointCommand(a.ctx, { push: true })).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/the working tree has uncommitted changes/) });
    a.git("checkout", "-q", "--", "review-protocol.md");
    a.git("checkout", "-q", "--detach");
    await expect(checkpointCommand(a.ctx, { push: true })).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/HEAD is detached/) });
    a.git("checkout", "-q", "-b", "local-only");
    await expect(checkpointCommand(a.ctx, { push: true })).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/branch local-only has no upstream; .* or pass --remote and --branch/) });
    expect(gitIn(a.dir)("status", "--porcelain")).toBe(before);
    // With --remote and --branch the same branch pushes.
    a.clock.now = T("2026-10-21T03:00:00Z");
    expect(await checkpointCommand(a.ctx, { push: true, remote: "origin", branch: "main", git: recordingGit(a.dir) })).toBe(0);
    expect(parseCheckpointLines(remoteFile(LINES), LINES).lines).toHaveLength(1);
  });

  it("three rejected pushes stop with exit 4 and the command to run again; nothing is forced", async () => {
    const d = clone(a, "2026-10-21T02:00:00Z");
    let n = 0;
    // Before each of a's pushes, another clone moves the remote on (an unrelated commit).
    const racer = async (args: string[]) => {
      if (args[0] !== "push") return;
      writeFileSync(join(d.dir, `elsewhere-${++n}.txt`), `${n}\n`);
      d.git("add", "-A");
      d.git("commit", "-qm", `elsewhere ${n}`);
      d.git("pull", "-q", "--rebase", "origin", "main");
      d.git("push", "-q", "origin", "HEAD:main");
    };
    const g = recordingGit(a.dir, racer);
    a.clock.now = T("2026-10-21T03:00:00Z");
    const head = gitIn(a.dir)("rev-parse", "HEAD");
    expect(await checkpointCommand(a.ctx, { push: true, git: g })).toBe(4);
    expect(a.out.join("\n")).toMatch(/not pushed: the push to origin\/main was rejected \(the remote moved on\), 3 times; nothing was forced/);
    expect(a.out.join("\n")).toMatch(/run again: pr-rla checkpoint --push/);
    expect(g.calls.filter((x) => x[0] === "push")).toHaveLength(3);
    expect(g.calls.some((x) => x.some((y) => /^--force|^-f$|^\+/.test(y)))).toBe(false);
    // The checkpoint commit stays local, on top of the remote it last saw; nothing of the remote was lost.
    expect(gitIn(a.dir)("log", "--format=%s", "-1")).toMatch(/pr-rla checkpoint 2026-q3/);
    expect(gitIn(a.dir)("rev-parse", "HEAD")).not.toBe(head);
    expect(onlyFastForwards()).toBe(true);
  });

  it("a conflict outside the checkpoint files aborts the rebase, leaves the branch as it was, and exits 4", async () => {
    const d = clone(a, "2026-10-21T02:00:00Z");
    writeFileSync(join(d.dir, "review-protocol.md"), "the remote's version\n");
    d.git("commit", "-qam", "remote edits the protocol");
    d.git("push", "-q", "origin", "HEAD:main");
    writeFileSync(join(a.dir, "review-protocol.md"), "the local version\n");
    a.git("commit", "-qam", "local edits the protocol");
    a.clock.now = T("2026-10-21T03:00:00Z");
    const g = recordingGit(a.dir);
    expect(await checkpointCommand(a.ctx, { push: true, git: g })).toBe(4);
    expect(a.out.join("\n")).toMatch(/rebasing onto the remote branch stopped: conflicts in review-protocol\.md, which are not checkpoint files; the rebase was aborted, the branch is as it was/);
    expect(g.calls.some((x) => x[0] === "rebase" && x[1] === "--abort")).toBe(true);
    expect(gitIn(a.dir)("status", "--porcelain")).toBe("");
    expect(readFileSync(join(a.dir, "review-protocol.md"), "utf8")).toBe("the local version\n");
    expect(gitIn(a.dir)("log", "--format=%s", "-2")).toMatch(/pr-rla checkpoint 2026-q3[\s\S]*local edits the protocol/);
  });
});

describe("the transport's git runner", () => {
  it("gives every git call a timeout (30 s by default) and reports it instead of hanging", async () => {
    const r = await nodeGit(a.dir, 200)(["hash-object", "--stdin"]);
    expect(r).toMatchObject({ code: -1, stderr: "git hash-object timed out after 0.2 s" });
  });
});
