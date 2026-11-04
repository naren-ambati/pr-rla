import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { githubIssuesAudit, labelGithub, smallPopulationAudit, workspace, type TrackerAudit } from "./helpers/ci-fixtures.js";
import { MockApi, ROOT, cannedShim, cliShim, deniedConnections, fakeTracker, newIsolation, runComposite, type CompositeOptions, type CompositeResult, type MockHandler } from "./helpers/ci-harness.js";
import type { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";

/**
 * The GitHub composite action on the harness (FR6.1, FR6.4, FR6.5; test-design.md section 2, U7).
 * The real CLI runs against fixture audit directories; the GitHub API is a mock server on
 * 127.0.0.1 that the child processes reach through test/helpers/ci-preload.cjs. Fixtures are
 * synthetic: see test/fixtures/ci/README.md.
 */

const ACTION = join(ROOT, "integrations", "github-action");
const API = "https://api.github.com";
const GHES = "https://ghe.example.com";

let audit: TrackerAudit<FakeGitHubIssues>;
let ghes: TrackerAudit<FakeGitHubIssues>;
const all = (a: TrackerAudit<FakeGitHubIssues>) => a.firstDraws.length;
const opened: MockApi[] = [];

beforeAll(async () => {
  audit = await githubIssuesAudit();
  ghes = await githubIssuesAudit({ baseUrl: GHES });
}, 180_000);
afterAll(async () => {
  await Promise.all([...opened.map((a) => a.stop()), audit?.tsa.stop(), ghes?.tsa.stop()]);
});

interface Run {
  r: CompositeResult;
  api: MockApi;
  ws: { dir: string; remote: string | null };
  denied: string[];
}

/** One action run: a mock API serving `trackers` (origin -> fake), a workspace from `dir`, the CLI as the installed pr-rla. */
/** One action run; `trust` is the audit's trust file for its two mock timestamp authorities, as the owner's `tsa-trust` input. */
async function action(o: {
  dir: string;
  trust?: string;
  trackers?: Record<string, FakeGitHubIssues>;
  inputs?: Record<string, string>;
  github?: CompositeOptions["github"];
  env?: Record<string, string>;
  bin?: CompositeOptions["bin"];
  remote?: boolean;
  edit?: (dir: string) => void;
  handlers?: Record<string, MockHandler>;
}): Promise<Run> {
  const handlers = Object.fromEntries([...Object.entries(o.trackers ?? {}).map(([origin, f]) => [origin, fakeTracker(origin, f)]), ...Object.entries(o.handlers ?? {})]);
  const api = await new MockApi(handlers).start();
  opened.push(api);
  const iso = newIsolation(api.routes);
  const ws = workspace(o.dir, { ...(o.remote ? { remote: true } : {}), ...(o.edit ? { edit: o.edit } : {}) });
  const r = await runComposite({
    actionDir: ACTION,
    workspace: ws.dir,
    isolation: iso,
    ...(o.inputs || o.trust ? { inputs: { ...(o.trust ? { "tsa-trust": o.trust } : {}), ...o.inputs } } : {}),
    ...(o.github ? { github: o.github } : {}),
    ...(o.bin ? { bin: o.bin } : {}),
    env: { ...o.env },
  });
  await api.stop();
  return { r, api, ws, denied: deniedConnections(iso) };
}

const certified = () => labelGithub(audit, { pass: all(audit) });
/** The labelled prefix once the first `n` drawn changes are labelled: a change drawn twice reuses its verdict, so it can pass n. */
function labelledPrefix(a: TrackerAudit<FakeGitHubIssues>, n: number): number {
  const labelled = new Set(a.firstDraws.slice(0, n));
  const first = new Map<string, number>();
  for (const d of a.draws.draws) if (!first.has(d.changeId)) first.set(d.changeId, d.draw);
  let prefix = 0;
  for (const d of a.draws.draws.slice(0, a.draws.issued)) {
    if (!labelled.has(first.get(d.changeId)!)) break;
    prefix++;
  }
  return prefix;
}
const escalated = () => labelGithub(audit, { fail: 6 });
const json = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { sequence?: { state: string }; certified?: boolean; certificate?: { state: string }; error?: { code: string } };
const summaryOf = (x: Run) => x.r.summary;

describe("FR6.1: status on fixtures gives the right job outcome", () => {
  it("CERTIFIED: the job passes; state, prefix, llr and json are outputs; the summary carries the certificate line", async () => {
    const x = await action({ dir: audit.dir, trust: audit.tsaTrust, trackers: { [API]: certified() } });
    expect(x.r.conclusion).toBe("success");
    expect(x.r.outputs).toMatchObject({ state: "CERTIFIED", prefix: "36/36", llr: "3.066", "exit-code": "0" });
    expect(json(x.r.outputs.json!)).toMatchObject({ sequence: { state: "CERTIFIED" }, certified: true, certificate: { state: "CERTIFIED", withheld: [] } });
    expect(summaryOf(x)).toContain("### CERTIFIED");
    expect(summaryOf(x)).toMatch(/prefix 36\/36 · fails 0 · claim D .* LLR 3\.066 \/ target 2\.996 · CERTIFIED \(risk 5%\)/);
    expect(summaryOf(x)).toContain("| LLR / target | 3.066 / 2.996 |");
    expect(summaryOf(x)).toContain("**Job result: PASS** (exit 0)");
    expect(x.r.step("run").stdout).toContain(`pr-rla --plugins builtin-only -C . status --json --offline --tsa-trust ${audit.tsaTrust} -> exit 0`);
    expect(x.denied).toEqual([]);
  });

  it("the same audit without the owner's anchors: its times are not proven, so the state is WITHHELD, pr-rla exits 6 and the job fails unless fail-on leaves incomplete out", async () => {
    const x = await action({ dir: audit.dir, trackers: { [API]: certified() } });
    expect(x.r.conclusion).toBe("failure");
    // The output is the certificate's state, never the sequential test's raw CERTIFIED.
    expect(x.r.outputs).toMatchObject({ state: "WITHHELD", prefix: "36/36", "exit-code": "6" });
    expect(json(x.r.outputs.json!)).toMatchObject({ sequence: { state: "CERTIFIED" }, certified: false, certificate: { state: "WITHHELD" } });
    expect(summaryOf(x)).toContain("### WITHHELD");
    expect(summaryOf(x)).toMatch(/target reached · CERTIFICATE WITHHELD \(registration time unproven/);
    expect(summaryOf(x)).not.toMatch(/CERTIFIED \(risk/);
    const lenient = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { "fail-on": "escalate,refusal,timestamps" } });
    expect(lenient.r.conclusion).toBe("success");
    expect(summaryOf(lenient)).toContain("fail-on does not include incomplete, so the job passes");
  });

  it("reads the ledger with the job's token, and only reads: every request to the tracker is a GET", async () => {
    const x = await action({ dir: audit.dir, trackers: { [API]: certified() } });
    const seen = x.api.to(API);
    expect(seen.length).toBeGreaterThan(36);
    expect(seen.every((q) => q.method === "GET")).toBe(true);
    expect(new Set(seen.map((q) => q.headers.authorization))).toEqual(new Set(["Bearer ghs_harness_token"]));
  });

  it("a label event (issues, labeled): NOT_CERTIFIED while 20 of 36 changes are labelled, the job passes, and comment: true posts the status line on the event's issue", async () => {
    const event = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "ci", "issues-labeled.json"), "utf8")) as Record<string, unknown>;
    const fake = labelGithub(audit, { pass: 20 });
    const x = await action({ dir: audit.dir, trackers: { [API]: fake }, github: { event, event_name: "issues" }, inputs: { comment: "true" } });
    expect(x.r.conclusion).toBe("success");
    // The prefix counts draws: a change drawn twice reuses its verdict, so 20 labelled changes can cover more than 20 draws.
    const prefix = labelledPrefix(audit, 20);
    expect(x.r.outputs).toMatchObject({ state: "NOT_CERTIFIED", prefix: `${prefix}/36` });
    const posts = x.api.to(API).filter((q) => q.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe("/repos/acme/audit/issues/7/comments");
    expect(posts[0]!.headers.authorization).toBe("Bearer ghs_harness_token");
    const body = JSON.parse(posts[0]!.body) as { body: string };
    expect(body.body).toMatch(new RegExp(`^\\*\\*pr-rla status\\*\\*: NOT_CERTIFIED\\n\\n\`\`\`text\\nprefix ${prefix}/36 · fails 0 `));
    expect(x.r.step("comment").stdout).toContain("posted the status line on acme/audit#7");
  });

  it("DEMO, ESCALATE fixture fails the job: exit 2, state ESCALATE, an error annotation naming the rule", async () => {
    const x = await action({ dir: audit.dir, trackers: { [API]: escalated() } });
    expect(x.r.conclusion).toBe("failure");
    expect(x.r.step("run").status).toBe("success");
    expect(x.r.step("decide").status).toBe("failure");
    expect(x.r.step("decide").stdout).toContain("::error title=pr-rla::exit 2: ESCALATE (the sequential test cannot certify), or the seed round is not yet published; fail-on includes escalate");
    expect(x.r.outputs).toMatchObject({ state: "ESCALATE", "exit-code": "2", prefix: "6/36" });
    expect(summaryOf(x)).toContain("### ESCALATE");
    expect(summaryOf(x)).toContain("**Job result: FAIL**");
  });

  it("fail-on without escalate: the same ESCALATE exits 2 and the job passes, and the summary says why", async () => {
    const x = await action({ dir: audit.dir, trackers: { [API]: escalated() }, inputs: { "fail-on": "refusal,timestamps" } });
    expect(x.r.conclusion).toBe("success");
    expect(x.r.outputs["exit-code"]).toBe("2");
    expect(summaryOf(x)).toContain("fail-on does not include escalate, so the job passes");
  });

  it("a refusal: `sample` on 12 changes exits 3, which fails the job by default and passes when fail-on leaves refusal out", async () => {
    const dir = await smallPopulationAudit();
    const inputs = { command: "sample", "allow-writes": "true" };
    const failing = await action({ dir, inputs });
    expect(failing.r.outputs["exit-code"]).toBe("3");
    expect(failing.r.step("run").stdout).toContain("population 12 < 150: review all 12 instead");
    expect(failing.r.conclusion).toBe("failure");
    expect(failing.r.step("decide").stdout).toContain("exit 3: the population is below the registered minimum");
    expect(failing.denied).toEqual([]);
    const passing = await action({ dir, inputs: { ...inputs, "fail-on": "escalate" } });
    expect(passing.r.conclusion).toBe("success");
  });

  it("a status result that carries a refusal is state REFUSED", async () => {
    const refused = JSON.stringify({ phase: "sampled", line: "population 12 < 150: review all 12 instead", labelledPrefix: 0, drawsIssued: 0, refusal: "population 12 < 150", sequence: { state: "CONTINUE", llr: 0, target: 2.9957, fails: 0 } });
    const x = await action({ dir: audit.dir, bin: (d) => void cannedShim(d, { code: 3, stdout: refused }) });
    expect(x.r.outputs).toMatchObject({ state: "REFUSED", "exit-code": "3" });
    expect(x.r.conclusion).toBe("failure");
  });

  it("exit 1 always fails, even with an empty fail-on; the error from the JSON is in the summary and the state output is empty", async () => {
    const x = await action({ dir: audit.dir, trackers: {}, edit: (dir) => writeFileSync(join(dir, ".pr-rla.yml"), "provider: json-file\n"), inputs: { "fail-on": "" } });
    expect(x.r.outputs["exit-code"]).toBe("1");
    expect(x.r.conclusion).toBe("failure");
    expect(x.r.outputs.state).toBe("");
    expect(summaryOf(x)).toMatch(/pr-rla could not finish: \*\*[A-Z_]+\*\*: /);
    expect(json(x.r.outputs.json!).error?.code).toBeTruthy();
  });

  it("verify runs offline by default and reports the verdict and the seven checks in the summary", async () => {
    const x = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { command: "verify" } });
    const run = x.r.step("run");
    expect(run.stdout).toContain("pr-rla --plugins builtin-only -C . verify --json --offline -> exit ");
    expect(summaryOf(x)).toMatch(/^### (VERIFIED|INCOMPLETE|FAILED)$/m);
    // Offline, check 7 skips the tracker: verify has a verdict and no state to report.
    expect(x.r.outputs.state).toBe("");
    expect(summaryOf(x)).toContain("| # | Check | Status | Summary |");
    expect(summaryOf(x).match(/^\| \d \| /gm)).toHaveLength(7);
    // The exit code is whatever verify decided (0, 1 or 6), and the mapping is applied to that one.
    const rc = Number(x.r.outputs["exit-code"]);
    expect([0, 1, 6]).toContain(rc);
    expect(x.r.conclusion).toBe(rc === 0 ? "success" : "failure");
  });

  it("dir: points the CLI at a subdirectory of the workspace", async () => {
    const x = await action({ dir: audit.dir, trust: audit.tsaTrust, trackers: { [API]: certified() }, inputs: { dir: "audit-repo" }, edit: (dir) => {
      mkdirSync(join(dir, "audit-repo"));
      for (const f of readdirSync(dir)) if (f !== "audit-repo" && f !== ".git") renameSync(join(dir, f), join(dir, "audit-repo", f));
    } });
    expect(x.r.conclusion).toBe("success");
    expect(x.r.step("run").stdout).toContain("-C audit-repo status");
    expect(x.r.outputs.state).toBe("CERTIFIED");
  });
});

describe("FR6.4: the version is pinned and plugins are off unless the owner opts in", () => {
  it("runs with --plugins builtin-only by default; plugins: allow drops the flag", async () => {
    const def = await action({ dir: audit.dir, trackers: { [API]: certified() } });
    expect(def.r.step("run").stdout).toContain("pr-rla --plugins builtin-only -C . status");
    const opt = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { plugins: "allow" } });
    expect(opt.r.step("run").stdout).toContain("pr-rla -C . status");
    expect(opt.r.step("run").stdout).not.toContain("builtin-only");
  });

  it("--accept-lock-grants is passed only when the owner sets accept-lock-grants: true", async () => {
    const off = await action({ dir: audit.dir, trackers: { [API]: certified() } });
    expect(off.r.step("run").stdout).not.toContain("--accept-lock-grants");
    const on = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { "accept-lock-grants": "true" } });
    expect(on.r.step("run").stdout).toContain("--accept-lock-grants");
  });
});

describe("credentials in CI follow the local-consent model", () => {
  const edit = (from: string, to: string) => (dir: string) => writeFileSync(join(dir, ".pr-rla.yml"), readFileSync(join(dir, ".pr-rla.yml"), "utf8").replace(from, to));
  const authOf = (x: Run, origin: string) => new Set(x.api.to(origin).map((q) => q.headers.authorization ?? "none"));

  /** The audit repo is private to anonymous callers, as a real one is: no Authorization header, no data. */
  const private404 = (origin: string, fake: FakeGitHubIssues) => {
    const read = fakeTracker(origin, fake);
    return (req: Parameters<typeof read>[0]) => (req.headers.authorization ? read(req) : new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }));
  };

  it("a self-hosted SCM gets no token without an approve-origins entry, and gets it with one", async () => {
    const origin = `${GHES}/api/v3`;
    const without = await action({ dir: ghes.dir, handlers: { [origin]: private404(origin, labelGithub(ghes, { pass: all(ghes) })) } });
    expect(without.api.to(origin).length).toBeGreaterThan(0);
    expect(authOf(without, origin)).toEqual(new Set(["none"]));
    // The withheld credential is not an error to pr-rla: the ledger runs anonymously. A private tracker then refuses
    // every read, so the verdicts were not read (time round B): INCOMPLETE, exit 6, and the job fails by default. The
    // warning and the approve command are what tell the owner to add approve-origins.
    expect(without.r.outputs).toMatchObject({ state: "INCOMPLETE", "exit-code": "6" });
    expect(without.r.conclusion).toBe("failure");
    expect(without.r.step("run").stderr).toContain("GITHUB_TOKEN -> https://ghe.example.com is not approved on this machine, so withheld");
    expect(without.r.summary).toContain("is not approved on this machine, so withheld");

    const withApproval = await action({ dir: ghes.dir, trust: ghes.tsaTrust, handlers: { [origin]: private404(origin, labelGithub(ghes, { pass: all(ghes) })) }, inputs: { "approve-origins": `GITHUB_TOKEN=${GHES}` } });
    expect(withApproval.r.conclusion).toBe("success");
    expect(withApproval.r.outputs.state).toBe("CERTIFIED");
    expect(authOf(withApproval, origin)).toEqual(new Set(["Bearer ghs_harness_token"]));
    // The approval is the job owner's: recorded in the runner's temp directory, not in the workspace.
    const file = join(withApproval.r.runnerTemp, "pr-rla-approvals.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ schema: "pr-rla/approvals/v1", approvals: [{ kind: "builtin", env: "GITHUB_TOKEN", origin: GHES }] });
    expect(file.startsWith(withApproval.ws.dir)).toBe(false);
    expect(existsSync(join(withApproval.ws.dir, "pr-rla-approvals.json"))).toBe(false);
    expect(withApproval.r.step("prepare").stdout).toContain("approved");
  });

  it("a non-default token_env is ignored until approved for its origin: the job's own GITHUB_TOKEN is what api.github.com gets", async () => {
    const mark = edit("options: { repo: acme/audit }", "options: { repo: acme/audit, token_env: AUDIT_TOKEN }");
    const without = await action({ dir: audit.dir, trackers: { [API]: certified() }, edit: mark, env: { AUDIT_TOKEN: "audit-secret" } });
    expect(authOf(without, API)).toEqual(new Set(["Bearer ghs_harness_token"]));
    const withApproval = await action({ dir: audit.dir, trackers: { [API]: certified() }, edit: mark, env: { AUDIT_TOKEN: "audit-secret" }, inputs: { "approve-origins": `AUDIT_TOKEN=${API}` } });
    expect(authOf(withApproval, API)).toEqual(new Set(["Bearer audit-secret"]));
  });

  it("the audited repository cannot approve its own credentials: a config naming another host gets no token", async () => {
    const origin = `${GHES}/api/v3`;
    const hostile = edit("options: { repo: acme/audit }", `options: { repo: acme/audit, base_url: ${GHES} }`);
    const x = await action({ dir: audit.dir, handlers: { [origin]: private404(origin, labelGithub(ghes, { pass: all(ghes) })) }, edit: hostile });
    expect(x.api.to(origin).length).toBeGreaterThan(0);
    expect(authOf(x, origin)).toEqual(new Set(["none"]));
    expect(x.denied).toEqual([]);
  });

  it("tsa-trust names files: a name that is not one is refused in prepare, and a shell metacharacter in it never runs", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "prrla-inject-")), "pwned");
    for (const bad of ["no-such-trust.json", `x.json;touch ${marker}`, `$(touch ${marker})`]) {
      const x = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { "tsa-trust": bad } });
      expect(x.r.step("prepare").status, bad).toBe("failure");
      expect(x.r.step("prepare").stdout, bad).toContain("tsa-trust:");
      expect(x.r.step("prepare").stdout, bad).toContain("is not a file");
      expect(x.r.step("run").kind, bad).toBe("not-run");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("prepare refuses malformed approve-origins entries, an approvals file inside the workspace, and runs nothing after", async () => {
    for (const bad of ["GITHUB_TOKEN", "GITHUB_TOKEN=http://ghe.example.com", "1BAD=https://ghe.example.com", "GITHUB_TOKEN=https://ghe.example.com/path", "*=https://ghe.example.com", "A=https://x.example.com B"]) {
      const x = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { "approve-origins": bad } });
      expect(x.r.step("prepare").status, bad).toBe("failure");
      expect(x.r.step("run").kind, bad).toBe("not-run");
      expect(x.r.conclusion, bad).toBe("failure");
    }
    const ws = workspace(audit.dir);
    const prepare = (approvals: string) =>
      spawnSync("bash", [join(ACTION, "scripts", "prepare.sh")], {
        cwd: ws.dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH!, ACTION_PATH: ACTION, GITHUB_WORKSPACE: ws.dir, RUNNER_TEMP: ws.dir, PR_RLA_APPROVALS_FILE: approvals, INPUT_COMMAND: "status", INPUT_DIR: ".", INPUT_OFFLINE: "true", INPUT_COMMENT: "false", INPUT_COMMENT_ISSUE: "", INPUT_FAIL_ON: "escalate", INPUT_PLUGINS: "builtin-only", INPUT_APPROVE_ORIGINS: "", INPUT_ACCEPT_LOCK_GRANTS: "false", INPUT_ALLOW_WRITES: "false" },
      });
    const inside = prepare(join(ws.dir, "approvals.json"));
    expect(inside.status).toBe(1);
    expect(inside.stdout).toContain("the approvals file must not be inside the workspace");
    const relative = prepare("approvals.json");
    expect(relative.stdout).toContain("must be an absolute path");
  });
});

describe("inputs are validated before anything runs", () => {
  it.each([
    ["command", "freeze"],
    ["offline", "yes"],
    ["comment", "1"],
    ["plugins", "none"],
    ["fail-on", "escalate,everything"],
    ["comment-issue", "7; rm -rf /"],
    ["allow-writes", "maybe"],
  ])("%s: %s", async (input, value) => {
    const x = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { [input]: value } });
    expect(x.r.step("prepare").status).toBe("failure");
    expect(x.r.step("prepare").stdout).toContain("::error title=pr-rla action input::");
    expect(x.r.step("run").kind).toBe("not-run");
    expect(x.api.seen).toEqual([]);
  });

  it("an input is data: a shell metacharacter in fail-on or dir never reaches a shell as code", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "prrla-inject-")), "pwned");
    const x = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { dir: `.; touch ${marker}`, "fail-on": `escalate$(touch ${marker})` } });
    expect(x.r.step("prepare").status).toBe("failure");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("checkpoint and sample write, so they need allow-writes: true (FR6.1, FR4.4)", () => {
  it("command: checkpoint refuses without allow-writes: the run step never starts", async () => {
    const x = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { command: "checkpoint" } });
    expect(x.r.step("prepare").status).toBe("failure");
    expect(x.r.step("prepare").stdout).toContain("command checkpoint writes to the audit repository: set allow-writes: true");
    expect(x.r.step("run").kind).toBe("not-run");
    expect(x.api.seen).toEqual([]);
  });

  it("command: sample refuses without allow-writes too", async () => {
    const x = await action({ dir: audit.dir, trackers: { [API]: certified() }, inputs: { command: "sample" } });
    expect(x.r.step("prepare").status).toBe("failure");
    expect(x.r.step("run").kind).toBe("not-run");
  });

  it("with allow-writes it runs `pr-rla checkpoint --push` and the checkpoint reaches the bare remote, with no write to the tracker", async () => {
    // The checkpoint is time-stamped by the audit's two authorities, now, and checked with the owner's anchors.
    audit.tsa.nowMs = Date.now();
    const x = await action({ dir: audit.dir, trust: audit.tsaTrust, trackers: { [API]: certified() }, inputs: { command: "checkpoint", "allow-writes": "true" }, remote: true });
    const out = x.r.step("run").stdout;
    expect(out).toContain(`pr-rla --plugins builtin-only -C . checkpoint --push --tsa-trust ${audit.tsaTrust} -> exit 0`);
    expect(out).toMatch(/pushed to origin\/main \([0-9a-f]{10}, attempt 1 of 3, no force\)/);
    expect(x.r.conclusion).toBe("success");
    const log = execFileSync("git", ["--git-dir", x.ws.remote!, "log", "-1", "--name-only", "--format=%an|%s"], { encoding: "utf8" });
    expect(log).toMatch(/^github-actions\[bot\]\|/);
    expect(log).toContain("audit/2026-q3/ledger-checkpoints.jsonl");
    expect(x.api.to(API).every((q) => q.method === "GET")).toBe(true);
    expect(x.r.outputs.state).toBe("");
    expect(x.r.outputs.json).toBe("");
    expect(x.r.summary).toContain("## pr-rla checkpoint");
    expect(x.r.summary).toContain("pushed to origin/main");
  });

  it("a push that stops (exit 4) always fails the job and the summary carries the command that finishes it", async () => {
    const x = await action({
      dir: audit.dir,
      inputs: { command: "checkpoint", "allow-writes": "true", "fail-on": "" },
      bin: (d) => void cannedShim(d, { code: 4, stdout: "checkpoint 2026-10-21T03:00:00Z · ledger github-issues\n  not pushed: the push was rejected 3 times\n  run again: pr-rla -C . checkpoint --push\n" }),
    });
    expect(x.r.conclusion).toBe("failure");
    expect(x.r.step("decide").stdout).toContain("exit 4: pr-rla stopped before it finished");
    expect(x.r.summary).toContain("**Re-run:**");
    expect(x.r.summary).toMatch(/```text\npr-rla -C \. checkpoint --push\n```/);
  });
});

describe("exit-code mapping (functional-design.md U7, with exit 6)", () => {
  const status = JSON.stringify({ phase: "unregistered", window: "w", start: "s", end: "e", line: "not registered" });
  const verifyJson = JSON.stringify({ verdict: "INCOMPLETE", ok: false, mode: "RETROSPECTIVE", checks: [{ n: 1, name: "registration", status: "PASS", summary: "ok", details: [] }], status: null, statusLine: null, verifiedWith: "0.1.0" });
  // [exit code, command, stdout, default fail-on fails, fail-on name that governs it]
  const table: [number, string, string, boolean, string | null][] = [
    [0, "status", status, false, null],
    [1, "status", status, true, null],
    [2, "status", status, true, "escalate"],
    [3, "status", status, true, "refusal"],
    [5, "status", status, true, "timestamps"],
    [6, "verify", verifyJson, true, "incomplete"],
    [7, "status", status, true, null],
    [127, "status", status, true, null],
  ];
  it.each(table)("exit %i (%s)", async (code, command, stdout, failsByDefault, name) => {
    const bin = (d: string) => void cannedShim(d, { code, stdout });
    const dflt = await action({ dir: audit.dir, inputs: { command }, bin });
    expect(dflt.r.outputs["exit-code"]).toBe(String(code));
    expect(dflt.r.conclusion).toBe(failsByDefault ? "failure" : "success");
    // Left out of fail-on, only the four named codes pass; 1, 7 and 127 always fail.
    const lenient = await action({ dir: audit.dir, inputs: { command, "fail-on": "" }, bin });
    expect(lenient.r.conclusion).toBe(name !== null || code === 0 ? "success" : "failure");
    // And naming only that code fails it again.
    if (name) {
      const only = await action({ dir: audit.dir, inputs: { command, "fail-on": name }, bin });
      expect(only.r.conclusion).toBe("failure");
    }
  });

  it("the default fail-on is escalate,refusal,timestamps,incomplete", () => {
    const meta = readFileSync(join(ACTION, "action.yml"), "utf8");
    expect(meta).toMatch(/fail-on:\n\s+description: .*\n\s+required: false\n\s+default: escalate,refusal,timestamps,incomplete\n/);
  });
});

describe("what pr-rla prints is data: it cannot become markup or a workflow command", () => {
  it("escapes table cells and fences, and defangs a leading :: in text output", async () => {
    const hostile = JSON.stringify({
      verdict: "FAILED",
      ok: false,
      mode: "RETROSPECTIVE",
      checks: [{ n: 1, name: "a|b", status: "FAIL", summary: "<img src=x onerror=1> `tick` | pipe", details: ["FAIL x\n| injected | row |"] }],
      status: null,
      statusLine: "```\n# injected heading\n```",
      verifiedWith: "0.1.0",
    });
    const v = await action({ dir: audit.dir, inputs: { command: "verify" }, bin: (d) => void cannedShim(d, { code: 1, stdout: hostile }) });
    expect(v.r.summary).toContain("| 1 | a\\|b | FAIL | &lt;img src=x onerror=1&gt; 'tick' \\| pipe |");
    expect(v.r.summary).not.toContain("<img");
    expect(v.r.summary).toContain("````text\n```\n# injected heading\n```\n````");
    expect(v.r.summary).toContain("- FAIL x \\| injected \\| row \\|");

    const t = await action({
      dir: audit.dir,
      inputs: { command: "checkpoint", "allow-writes": "true" },
      bin: (d) => void cannedShim(d, { code: 0, stdout: "::set-output name=x::y\n::add-mask::z\nfine\n", stderr: "::error::fake\n" }),
    });
    const lines = [...t.r.step("run").stdout.split("\n"), ...t.r.step("run").stderr.split("\n")];
    expect(lines.some((l) => l.startsWith("::set-output") || l.startsWith("::add-mask") || l.startsWith("::error::fake"))).toBe(false);
    expect(lines).toContain(" ::set-output name=x::y");
  });

  it("outputs are fixed shapes: a hostile prefix cannot add an output line or flip the result", async () => {
    const x = await action({ dir: audit.dir, bin: (d) => void cannedShim(d, { code: 2, stdout: JSON.stringify({ phase: "sampled", line: "l", labelledPrefix: "1\nresult=pass", drawsIssued: 2, sequence: { state: "ESCALATE", llr: 1, target: 1, fails: 0 } }) }) });
    expect(x.r.step("run").outputs).toMatchObject({ result: "fail", prefix: "", state: "ESCALATE", "exit-code": "2" });
    expect(x.r.conclusion).toBe("failure");
  });
});

describe("the comment is best effort and the token stays on GitHub", () => {
  const event = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "ci", "issues-labeled.json"), "utf8")) as Record<string, unknown>;

  it("a 403 from the API is a warning; the job's outcome is the audit's", async () => {
    const read = fakeTracker(API, certified());
    const x = await action({ dir: audit.dir, trust: audit.tsaTrust, trackers: { [API]: certified() }, github: { event, event_name: "issues" }, inputs: { comment: "true" }, handlers: { [API]: (req) => (req.method === "POST" ? new Response("{}", { status: 403 }) : read(req)) } });
    expect(x.r.conclusion).toBe("success");
    expect(x.r.step("comment").stdout).toContain("::warning title=pr-rla comment::GitHub answered 403 to the comment on acme/audit#7 (a comment needs issues: write)");
  });

  it("no issue number (a push event): a warning, no request", async () => {
    const x = await action({ dir: audit.dir, trust: audit.tsaTrust, trackers: { [API]: certified() }, inputs: { comment: "true" } });
    expect(x.r.conclusion).toBe("success");
    expect(x.r.step("comment").stdout).toContain("comment: true needs an audit issue number");
    expect(x.api.to(API).some((q) => q.method === "POST")).toBe(false);
  });

  it("comment-issue overrides the event; GITHUB_API_URL that is not https is refused and the token is not sent", async () => {
    const fake = certified();
    const ok = await action({ dir: audit.dir, trackers: { [API]: fake }, inputs: { comment: "true", "comment-issue": "12" } });
    expect(ok.api.to(API).filter((q) => q.method === "POST").map((q) => q.path)).toEqual(["/repos/acme/audit/issues/12/comments"]);
    const evil = await action({ dir: audit.dir, trackers: { [API]: fake }, github: { event, event_name: "issues", api_url: "http://api.evil.example" }, env: {}, inputs: { comment: "true" } });
    expect(evil.r.step("comment").stdout).toContain("GITHUB_API_URL is not an https URL; the token was not sent");
    expect(evil.denied).toEqual([]);
  });
});

describe("run.sh does not depend on the calling shell's flags", () => {
  it("under bash -e a non-zero pr-rla exit is still data: the outputs and the summary are written, and the step ends 0", () => {
    const temp = mkdtempSync(join(tmpdir(), "prrla-run-e-"));
    const actionPath = join(temp, "action");
    mkdirSync(join(actionPath, "node_modules", ".bin"), { recursive: true });
    cannedShim(join(actionPath, "node_modules", ".bin"), { code: 2, stdout: JSON.stringify({ phase: "unregistered", line: "x" }) });
    const outFile = join(temp, "out");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", join(ACTION, "scripts", "run.sh")], {
      cwd: temp,
      encoding: "utf8",
      env: { PATH: process.env.PATH!, ACTION_PATH: join(temp, "action"), RUNNER_TEMP: temp, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: join(temp, "summary"), INPUT_COMMAND: "status", INPUT_DIR: ".", INPUT_OFFLINE: "true", INPUT_FAIL_ON: "escalate", INPUT_PLUGINS: "builtin-only", INPUT_ACCEPT_LOCK_GRANTS: "false" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(outFile, "utf8")).toContain("exit-code=2\nresult=fail\n");
  });
});

describe("the action is wired as designed (FR6.1, FR6.4, NFR18)", () => {
  it("the install step is exactly an npm ci from the action's own lockfile", async () => {
    const x = await action({ dir: audit.dir, trackers: { [API]: certified() } });
    expect(x.r.step("install").kind).toBe("skipped");
    expect(x.r.step("install").script).toBe('npm ci --prefix "$ACTION_PATH" --ignore-scripts --no-audit --no-fund');
  });

  it("with no pr-rla installed, the run step refuses before anything else", async () => {
    const x = await action({ dir: audit.dir, trackers: { [API]: certified() }, bin: () => undefined });
    expect(x.r.step("prepare").status).toBe("failure");
    expect(x.r.step("prepare").stdout).toContain("pr-rla is not installed at");
  });

  it("the installed binary is the one in the action path (a shim stands in for npm ci)", async () => {
    const x = await action({ dir: audit.dir, trust: audit.tsaTrust, trackers: { [API]: certified() }, bin: (d) => void cliShim(d) });
    expect(x.r.conclusion).toBe("success");
  });
});
