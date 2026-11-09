import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { gitFileAudit, githubIssuesAudit, labelGithub, workspace, type GitFileAudit, type TrackerAudit } from "./helpers/ci-fixtures.js";
import { MockApi, ROOT, cliShim, codeBlocks, fakeTracker, newIsolation, renderGitLabTemplate, runComposite, runScript } from "./helpers/ci-harness.js";
import type { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";

/**
 * Not a test of behaviour: the capture the CI screenshots in docs/ci/github.md are made from. Set
 * PR_RLA_E2E_CAPTURE=<dir> to run it; without it the file is skipped, so `npm test` is unchanged.
 * It runs the real GitHub composite action steps (the harness of ci-github-action.test.ts) on a
 * CERTIFIED fixture (verify, online) and on a WITHHELD one (status), and writes each run's step
 * output, outputs, conclusion and job summary (GITHUB_STEP_SUMMARY) as JSON. The fixtures are
 * synthetic (a 400-change population, mock timestamp authorities, a fake tracker on 127.0.0.1).
 */
const out = process.env.PR_RLA_E2E_CAPTURE;
const API = "https://api.github.com";

describe.skipIf(!out)("e2e capture: the GitHub Action's job summary", () => {
  let audit: TrackerAudit<FakeGitHubIssues>;
  const opened: MockApi[] = [];
  beforeAll(async () => {
    audit = await githubIssuesAudit();
  }, 240_000);
  afterAll(async () => {
    await Promise.all([...opened.map((a) => a.stop()), audit?.tsa.stop()]);
  });

  async function capture(name: string, inputs: Record<string, string>, trackerAudit = labelGithub(audit, { pass: audit.firstDraws.length })) {
    const api = await new MockApi({ [API]: fakeTracker(API, trackerAudit) }).start();
    opened.push(api);
    const ws = workspace(audit.dir, {});
    const t0 = Date.now();
    const r = await runComposite({ actionDir: join(ROOT, "integrations", "github-action"), workspace: ws.dir, isolation: newIsolation(api.routes), inputs: { "tsa-trust": audit.tsaTrust, ...inputs }, env: {} });
    const ms = Date.now() - t0;
    await api.stop();
    mkdirSync(out!, { recursive: true });
    writeFileSync(join(out!, `${name}.json`), JSON.stringify({ name, inputs, conclusion: r.conclusion, outputs: { state: r.outputs.state, prefix: r.outputs.prefix, llr: r.outputs.llr, "exit-code": r.outputs["exit-code"] }, runStdout: r.step("run").stdout, summary: r.summary, ms }, null, 2));
    return r;
  }

  it("CERTIFIED: verify, online", async () => {
    const r = await capture("action-certified", { command: "verify", offline: "false" });
    expect(r.conclusion).toBe("success");
    expect(r.summary).toContain("### VERIFIED · CERTIFIED");
  });

  it("WITHHELD: status reaches the target and never certifies", async () => {
    const r = await capture("action-withheld", {});
    expect(r.conclusion).toBe("failure");
    expect(r.summary).toContain("### WITHHELD");
  });
});

// The GitLab component and the Bitbucket step, once each, on the git-file fixtures (the recorded gh-aw audit with
// synthetic time-stamps and verdicts): their `script` lines in one shell, as the platform's runner would run them.
describe.skipIf(!out)("e2e capture: the GitLab component and the Bitbucket step", () => {
  const servers: { stop(): Promise<void> }[] = [];
  afterAll(async () => void (await Promise.all(servers.map((s) => s.stop()))));

  async function script(name: string, shell: "gitlab" | "bitbucket", lines: string[], vars: Record<string, string>, a: GitFileAudit, env: Record<string, string>) {
    const iso = newIsolation(undefined);
    const ws = workspace(a.dir, {});
    const binDir = join(iso.home, "bin");
    const bin = cliShim(binDir);
    const t0 = Date.now();
    const r = await runScript({ lines, shell, cwd: ws.dir, isolation: iso, env: { ...vars, PRRLA_BIN: bin, CI_PROJECT_DIR: ws.dir, PRRLA_TSA_TRUST: a.tsaTrust, ...env } });
    mkdirSync(out!, { recursive: true });
    writeFileSync(join(out!, `${name}.json`), JSON.stringify({ name, shell, exitCode: r.code, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 }, null, 2));
    return r;
  }

  it("GitLab component: verify on a CERTIFIED fixture", async () => {
    const a = await gitFileAudit("certified");
    servers.push(a.tsa);
    const t = renderGitLabTemplate(join(ROOT, "integrations", "gitlab", "templates", "pr-rla.yml"), {});
    const r = await script("gitlab-certified", "gitlab", t.job.script, t.job.variables ?? {}, a, { PRRLA_COMMAND: "verify", PRRLA_OFFLINE: "false" });
    expect(r.code).toBe(0);
  }, 180_000);

  it("Bitbucket step: status on an ESCALATE fixture", async () => {
    const a = await gitFileAudit("escalate");
    servers.push(a.tsa);
    const block = codeBlocks(join(ROOT, "docs", "ci", "bitbucket.md")).find((b) => b.info === "yaml bitbucket-pipelines.yml");
    const doc = YAML.parse(block!.text) as { pipelines: { branches: { main: { step: { script: string[] } }[] } } };
    const r = await script("bitbucket-escalate", "bitbucket", doc.pipelines.branches.main[0]!.step.script, {}, a, {});
    expect(r.code).not.toBe(0);
  }, 180_000);
});
