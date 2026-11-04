import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitFileAudit, gitlabIssuesAudit, labelGitlab, workspace, type TrackerAudit } from "./helpers/ci-fixtures.js";
import { MockApi, ROOT, cannedShim, cliShim, codeBlocks, deniedConnections, fakeTracker, newIsolation, renderGitLabTemplate, ruleApplies, runScript, writeBin, type MockHandler } from "./helpers/ci-harness.js";
import type { FakeGitLabIssues } from "./helpers/fake-issue-trackers.js";

/**
 * The GitLab component, the GitLab plain snippet and the Bitbucket step, each run by the harness
 * (FR6.2, FR6.3, FR6.4, FR6.5; test-design.md section 2, U7): their `script` lines in one shell
 * against fixture audit directories, with the real CLI as the installed pr-rla and mock servers
 * for the trackers. Fixtures are synthetic or recorded: see test/fixtures/ci/README.md.
 */

const TEMPLATE = join(ROOT, "integrations", "gitlab", "templates", "pr-rla.yml");
const GL = "https://gitlab.com";
const SELF = "https://gitlab.example.com";

interface Target {
  name: string;
  shell: "gitlab" | "bitbucket";
  lines: string[];
  /** What the platform sets for the job before the script runs. */
  vars: Record<string, string>;
  artifacts: string[];
}

function gitlabComponent(inputs: Record<string, string> = {}): Target {
  const t = renderGitLabTemplate(TEMPLATE, inputs);
  return { name: "GitLab component", shell: "gitlab", lines: t.job.script, vars: t.job.variables ?? {}, artifacts: t.job.artifacts?.paths ?? [] };
}
function gitlabSnippet(): Target {
  const block = codeBlocks(join(ROOT, "docs", "ci", "gitlab.md")).find((b) => b.info === "yaml .gitlab-ci.yml");
  const job = (YAML.parse(block!.text) as Record<string, { script: string[]; variables: Record<string, string>; artifacts: { paths: string[] } }>)["pr-rla-status"]!;
  return { name: "GitLab plain snippet", shell: "gitlab", lines: job.script, vars: job.variables, artifacts: job.artifacts.paths };
}
function bitbucketStep(): Target {
  const block = codeBlocks(join(ROOT, "docs", "ci", "bitbucket.md")).find((b) => b.info === "yaml bitbucket-pipelines.yml");
  const doc = YAML.parse(block!.text) as { pipelines: { branches: { main: { step: { script: string[]; artifacts: string[] } }[] } } };
  const step = doc.pipelines.branches.main[0]!.step;
  return { name: "Bitbucket step", shell: "bitbucket", lines: step.script, vars: {}, artifacts: step.artifacts };
}
const targets: Target[] = [gitlabComponent(), gitlabSnippet(), bitbucketStep()];

const opened: MockApi[] = [];
afterAll(async () => void (await Promise.all(opened.map((a) => a.stop()))));

interface Job {
  code: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
  home: string;
  denied: string[];
  api: MockApi | null;
  json: () => { sequence?: { state: string }; error?: { code: string }; verdict?: string };
  argv: () => string;
}

async function job(t: Target, o: { dir: string; override?: Record<string, string>; env?: Record<string, string>; bin?: (dir: string) => string; handlers?: Record<string, MockHandler>; path?: string; edit?: (dir: string) => void }): Promise<Job> {
  const api = o.handlers ? await new MockApi(o.handlers).start() : null;
  if (api) opened.push(api);
  const iso = newIsolation(api?.routes);
  const ws = workspace(o.dir, o.edit ? { edit: o.edit } : {});
  const binDir = join(iso.home, "bin");
  const bin = o.bin ? o.bin(binDir) : cliShim(binDir);
  const r = await runScript({
    lines: t.lines,
    shell: t.shell,
    cwd: ws.dir,
    isolation: iso,
    env: { ...t.vars, PRRLA_BIN: bin, CI_PROJECT_DIR: ws.dir, ...o.override, ...o.env, ...(o.path ? { PATH: `${o.path}:${process.env.PATH}` } : {}) },
  });
  if (api) await api.stop();
  const jsonFile = join(ws.dir, "pr-rla.json");
  return {
    code: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    cwd: ws.dir,
    home: iso.home,
    denied: deniedConnections(iso),
    api,
    json: () => JSON.parse(readFileSync(jsonFile, "utf8")),
    argv: () => (existsSync(join(binDir, "pr-rla.argv")) ? readFileSync(join(binDir, "pr-rla.argv"), "utf8").trim() : ""),
  };
}

describe.each(targets)("$name: the script", (t) => {
  let certified: string;
  let escalated: string;
  beforeAll(() => {
    certified = gitFileAudit("certified");
    escalated = gitFileAudit("escalate");
  });

  it("runs as one script item, with the exit-code mapping and no unresolved placeholder", () => {
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).not.toMatch(/\$\[\[/);
    expect(t.artifacts).toEqual(["pr-rla.json"]);
  });

  it("CERTIFIED passes: the certificate line is in the log, pr-rla.json is the --json output, and the command is pinned and builtin-only", async () => {
    const j = await job(t, { dir: certified });
    expect(j.code, j.stderr).toBe(0);
    expect(j.stdout).toMatch(/prefix 36\/36 · fails 0 .* CERTIFIED \(risk 5%\)/);
    expect(j.stdout).toContain("pr-rla: pass (exit 0)");
    expect(j.json().sequence?.state).toBe("CERTIFIED");
    expect(j.denied).toEqual([]);
  });

  it("DEMO, an ESCALATE fixture fails the job: exit 2 under the default fail-on", async () => {
    const j = await job(t, { dir: escalated });
    expect(j.code).not.toBe(0);
    expect(j.stdout).toContain("pr-rla: fail (exit 2: ESCALATE (the sequential test cannot certify), or the seed round is not yet published; fail-on includes escalate)");
    expect(j.json().sequence?.state).toBe("ESCALATE");
  });

  it("fail-on without escalate lets the same ESCALATE pass", async () => {
    const j = await job(t, { dir: escalated, override: { PRRLA_FAIL_ON: "refusal,timestamps" } });
    expect(j.code, j.stderr).toBe(0);
    expect(j.stdout).toContain("fail-on does not include escalate, so the job passes");
  });

  it("runs pr-rla --plugins builtin-only by default; plugins=allow drops it; accept-lock-grants is off unless set", async () => {
    const bin = (d: string) => cannedShim(d, { code: 0, stdout: JSON.stringify({ phase: "unregistered", line: "x" }) });
    const dflt = await job(t, { dir: certified, bin });
    expect(dflt.argv()).toBe("--plugins builtin-only -C . status --json --offline");
    const allow = await job(t, { dir: certified, bin, override: { PRRLA_PLUGINS: "allow" } });
    expect(allow.argv()).toBe("-C . status --json --offline");
    const grants = await job(t, { dir: certified, bin, override: { PRRLA_ACCEPT_LOCK_GRANTS: "true" } });
    expect(grants.argv()).toBe("--accept-lock-grants --plugins builtin-only -C . status --json --offline");
    const online = await job(t, { dir: certified, bin, override: { PRRLA_OFFLINE: "false", PRRLA_COMMAND: "verify", PRRLA_DIR: "sub" } });
    expect(online.argv()).toBe("--plugins builtin-only -C sub verify --json");
  });

  describe("the exit-code mapping", () => {
    const status = JSON.stringify({ phase: "unregistered", line: "not registered" });
    // [code, governing name or null, passes by default]
    const table: [number, string | null, boolean][] = [
      [0, null, true],
      [1, null, false],
      [2, "escalate", false],
      [3, "refusal", false],
      [4, null, false],
      [5, "timestamps", false],
      [6, "incomplete", false],
      [7, null, false],
      [127, null, false],
    ];
    it.each(table)("exit %i", async (code, name, _passes) => {
      const bin = (d: string) => cannedShim(d, { code, stdout: status });
      const dflt = await job(t, { dir: certified, bin });
      expect(dflt.code === 0).toBe(code === 0);
      const none = await job(t, { dir: certified, bin, override: { PRRLA_FAIL_ON: "" } });
      expect(none.code === 0, `${code} with an empty fail-on`).toBe(code === 0 || name !== null);
      if (name) {
        const only = await job(t, { dir: certified, bin, override: { PRRLA_FAIL_ON: name } });
        expect(only.code === 0).toBe(false);
        const others = await job(t, { dir: certified, bin, override: { PRRLA_FAIL_ON: ["escalate", "refusal", "timestamps", "incomplete"].filter((n) => n !== name).join(",") } });
        expect(others.code, `${code} with ${name} left out`).toBe(0);
      }
    });
  });

  describe("pinning (FR6.4)", () => {
    it.each(["^0.1.0", "latest", "0.1", "1.x", "0.1.0 && true", "$(id)"])("refuses PRRLA_VERSION=%j before installing anything", async (v) => {
      const j = await job(t, { dir: certified, override: { PRRLA_VERSION: v }, env: { PRRLA_BIN: "" } });
      expect(j.code).not.toBe(0);
      expect(j.stderr).toContain("PRRLA_VERSION must be one exact version");
    });

    it("refuses an installed pr-rla whose --version is not the pinned one", async () => {
      const j = await job(t, { dir: certified, bin: (d) => cannedShim(d, { code: 0, version: "0.2.0" }) });
      expect(j.code).not.toBe(0);
      expect(j.stderr).toMatch(/the pr-rla at .* is not version 0\.1\.0/);
    });

    describe("the install", () => {
      /** A fake npm first on PATH: `view` prints FAKE_NPM_INTEGRITY; `install --prefix P` puts the real CLI at P/node_modules/.bin. */
      function fakeNpm(): { dir: string; log: () => string } {
        const dir = mkdtempSync(join(tmpdir(), "prrla-fake-npm-"));
        const logFile = join(dir, "npm.log");
        writeBin(dir, "npm", `echo "$@" >> "${logFile}"\ncase "$1" in\n  view) echo "$FAKE_NPM_INTEGRITY" ;;\n  install)\n    prefix=""\n    while [ $# -gt 0 ]; do if [ "$1" = "--prefix" ]; then prefix=$2; fi; shift; done\n    mkdir -p "$prefix/node_modules/.bin"\n    cp "$FAKE_PRRLA" "$prefix/node_modules/.bin/pr-rla"\n    ;;\nesac`);
        return { dir, log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim() : "") };
      }
      const install = (extra: Record<string, string>, npm: ReturnType<typeof fakeNpm>) => job(t, { dir: certified, path: npm.dir, env: { PRRLA_BIN: "", FAKE_PRRLA: cliShim(mkdtempSync(join(tmpdir(), "prrla-real-"))), FAKE_NPM_INTEGRITY: "sha512-abc", ...extra } });

      it("installs the exact version with --ignore-scripts into the temporary directory, then runs it", async () => {
        const npm = fakeNpm();
        const j = await install({}, npm);
        expect(j.code, j.stderr).toBe(0);
        expect(npm.log()).toBe(`install --prefix ${j.home}/pr-rla-tool --ignore-scripts --no-audit --no-fund --no-package-lock pr-rla@0.1.0`);
        expect(existsSync(join(j.cwd, "node_modules"))).toBe(false);
      });

      it("with an integrity pin, installs only when npm reports the same integrity", async () => {
        const good = fakeNpm();
        const ok = await install({ PRRLA_INTEGRITY: "sha512-abc" }, good);
        expect(ok.code, ok.stderr).toBe(0);
        expect(good.log().split("\n")).toEqual(["view pr-rla@0.1.0 dist.integrity", `install --prefix ${ok.home}/pr-rla-tool --ignore-scripts --no-audit --no-fund --no-package-lock pr-rla@0.1.0`]);
        const bad = fakeNpm();
        const refused = await install({ PRRLA_INTEGRITY: "sha512-other" }, bad);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain("pr-rla@0.1.0 has integrity sha512-abc, not the sha512-other you pinned");
        expect(bad.log()).toBe("view pr-rla@0.1.0 dist.integrity");
      });
    });
  });

  describe("credentials follow the local-consent model", () => {
    const approvals = (home: string) => JSON.parse(readFileSync(join(home, "pr-rla-approvals.json"), "utf8")) as { approvals: { kind: string; env: string; origin: string }[] };

    it("approve-origins runs pr-rla plugin approve --yes for each entry, into the temporary directory and not the checkout", async () => {
      const j = await job(t, { dir: certified, override: { PRRLA_APPROVE_ORIGINS: "GITLAB_TOKEN=https://gitlab.example.com,BITBUCKET_DC_TOKEN=https://bitbucket.example.com:7990\nMY_TOKEN=https://git.example.org" } });
      expect(j.code, j.stderr).toBe(0);
      expect(approvals(j.home).approvals.map((a) => `${a.env}=${a.origin}`).sort()).toEqual(["BITBUCKET_DC_TOKEN=https://bitbucket.example.com:7990", "GITLAB_TOKEN=https://gitlab.example.com", "MY_TOKEN=https://git.example.org"]);
      expect(existsSync(join(j.cwd, "pr-rla-approvals.json"))).toBe(false);
    });

    it.each(["GITLAB_TOKEN", "GITLAB_TOKEN=http://gitlab.example.com", "1BAD=https://x.example.com", "*=https://x.example.com", "A-B=https://x.example.com", "GITLAB_TOKEN=https://"])("refuses the approve-origins entry %j and runs nothing", async (entry) => {
      const j = await job(t, { dir: certified, override: { PRRLA_APPROVE_ORIGINS: entry }, bin: (d) => cannedShim(d, { code: 0, stdout: "{}" }) });
      expect(j.code).not.toBe(0);
      expect(j.stderr).toMatch(/approve-origins/);
      expect(j.argv()).toBe("");
    });

    it("an input is data: a shell metacharacter in a setting never runs", async () => {
      const marker = join(mkdtempSync(join(tmpdir(), "prrla-inject-")), "pwned");
      for (const [k, v] of [["PRRLA_FAIL_ON", `escalate;touch ${marker}`], ["PRRLA_COMMAND", `status;touch ${marker}`], ["PRRLA_PLUGINS", `allow;touch ${marker}`], ["PRRLA_APPROVE_ORIGINS", `A=https://x.example.com;touch ${marker}`]] as const) {
        const j = await job(t, { dir: certified, override: { [k]: v } });
        expect(j.code, k).not.toBe(0);
        expect(existsSync(marker), k).toBe(false);
      }
    });

    it("refuses an approvals file inside the project directory", async () => {
      const ws = workspace(certified);
      const iso = newIsolation();
      const r = await runScript({ lines: t.lines, shell: t.shell, cwd: ws.dir, isolation: iso, env: { ...t.vars, PRRLA_BIN: cliShim(join(iso.home, "bin")), TMPDIR: ws.dir } });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("the approvals file must be outside the project directory");
    });
  });

  it("an unknown command is refused", async () => {
    const j = await job(t, { dir: certified, override: { PRRLA_COMMAND: "checkpoint" } });
    expect(j.code).not.toBe(0);
    expect(j.stderr).toContain("PRRLA_COMMAND must be status or verify");
  });

  it("verify runs and the same mapping applies to its exit code", async () => {
    const j = await job(t, { dir: certified, override: { PRRLA_COMMAND: "verify", PRRLA_OFFLINE: "true" } });
    const body = j.json();
    expect(body.verdict).toMatch(/^(VERIFIED|INCOMPLETE|FAILED)$/);
    expect(j.code === 0).toBe(body.verdict === "VERIFIED" || body.verdict === "INCOMPLETE");
    expect(j.stdout).toMatch(/^(VERIFIED|INCOMPLETE|FAILED): /m);
  });
});

describe("the GitLab component (FR6.2)", () => {
  const t = renderGitLabTemplate(TEMPLATE);

  it("has typed spec:inputs, each with a default, and an exact-version regex", () => {
    for (const [name, spec] of Object.entries(t.specInputs)) {
      expect(spec.type, name).toBe("string");
      expect(spec, name).toHaveProperty("default");
    }
    const re = new RegExp(t.specInputs.version!.regex!);
    expect(["0.1.0", "12.0.103"].every((v) => re.test(v))).toBe(true);
    expect(["^0.1.0", "latest", "0.1", "1.x", "0.1.0-rc1", ""].some((v) => re.test(v))).toBe(false);
    expect(t.specInputs.command!.options).toEqual(["status", "verify"]);
    expect(t.specInputs.plugins!.options).toEqual(["builtin-only", "allow"]);
    expect(t.specInputs.plugins!.default).toBe("builtin-only");
  });

  it("is triggered by pushes to audit/** and by a schedule, and by nothing else it does not name", () => {
    const rules = t.job.rules!;
    const at = (source: string, files: string[] = []) => ruleApplies(rules, { CI_PIPELINE_SOURCE: source }, files);
    expect(at("push", ["audit/2026-q3/verdicts.jsonl"])).toBe(true);
    expect(at("push", ["audit/2026-q3.manifest.json"])).toBe(true);
    expect(at("push", ["src/index.ts", "README.md"])).toBe(false);
    expect(at("schedule")).toBe(true);
    expect(at("trigger")).toBe(true);
    expect(at("web")).toBe(true);
    expect(at("merge_request_event", ["audit/x"])).toBe(false);
    // audit-path moves the trigger.
    const moved = renderGitLabTemplate(TEMPLATE, { "audit-path": "ci/audit/**/*" });
    expect(ruleApplies(moved.job.rules!, { CI_PIPELINE_SOURCE: "push" }, ["ci/audit/2026-q3/draws.json"])).toBe(true);
    expect(ruleApplies(moved.job.rules!, { CI_PIPELINE_SOURCE: "push" }, ["audit/2026-q3/draws.json"])).toBe(false);
  });

  it("names its job after the command and keeps the status artifact on failure", () => {
    expect(t.jobName).toBe("pr-rla-status");
    expect(renderGitLabTemplate(TEMPLATE, { command: "verify" }).jobName).toBe("pr-rla-verify");
    const raw = YAML.parseAllDocuments(readFileSync(TEMPLATE, "utf8"))[1]!.toJS() as Record<string, { artifacts: { paths: string[]; when: string } }>;
    expect(raw["pr-rla-$[[ inputs.command ]]"]!.artifacts).toMatchObject({ paths: ["pr-rla.json"], when: "always" });
  });

  it("passes every input to the script as a variable, never as script text", () => {
    expect(t.job.variables).toMatchObject({ PRRLA_VERSION: "0.1.0", PRRLA_COMMAND: "status", PRRLA_PLUGINS: "builtin-only", PRRLA_OFFLINE: "true", PRRLA_DIR: ".", PRRLA_ACCEPT_LOCK_GRANTS: "false", PRRLA_APPROVE_ORIGINS: "", PRRLA_INTEGRITY: "" });
    const hostile = renderGitLabTemplate(TEMPLATE, { "fail-on": 'x"; touch /tmp/pwned #', dir: "$(id)" });
    expect(hostile.job.script).toEqual(t.job.script);
    expect(hostile.job.variables!.PRRLA_FAIL_ON).toBe('x"; touch /tmp/pwned #');
  });

  describe("against a mock gitlab.com (the gitlab-issues ledger)", () => {
    let audit: TrackerAudit<FakeGitLabIssues>;
    let selfManaged: TrackerAudit<FakeGitLabIssues>;
    beforeAll(async () => {
      audit = await gitlabIssuesAudit();
      selfManaged = await gitlabIssuesAudit({ baseUrl: SELF });
    }, 180_000);
    const comp = gitlabComponent();
    const handlers = (origin: string, fake: FakeGitLabIssues): Record<string, MockHandler> => ({ [origin]: fakeTracker(origin, fake) });

    it("a push to audit/** (a certified audit): the job selects, reads with GITLAB_TOKEN, only reads, and leaves the status artifact", async () => {
      expect(ruleApplies(t.job.rules!, { CI_PIPELINE_SOURCE: "push" }, ["audit/2026-q3/draws.json"])).toBe(true);
      const j = await job(comp, { dir: audit.dir, handlers: handlers(GL, labelGitlab(audit, { pass: audit.firstDraws.length })), env: { GITLAB_TOKEN: "glpat-test" } });
      expect(j.code, j.stderr).toBe(0);
      expect(j.json().sequence?.state).toBe("CERTIFIED");
      const seen = j.api!.to(GL);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((q) => q.method === "GET")).toBe(true);
      expect(new Set(seen.map((q) => q.headers.authorization))).toEqual(new Set(["Bearer glpat-test"]));
      expect(j.denied).toEqual([]);
    });

    it("a scheduled run notices new verdict labels: 20 of 36 labelled is NOT CERTIFIED and the job passes", async () => {
      expect(ruleApplies(t.job.rules!, { CI_PIPELINE_SOURCE: "schedule" }, [])).toBe(true);
      const j = await job(comp, { dir: audit.dir, handlers: handlers(GL, labelGitlab(audit, { pass: 20 })), env: { GITLAB_TOKEN: "glpat-test" } });
      expect(j.code, j.stderr).toBe(0);
      expect(j.stdout).toMatch(/prefix 20\/36 · fails 0 .* NOT CERTIFIED/);
    });

    it("an ESCALATE fixture fails the job", async () => {
      const j = await job(comp, { dir: audit.dir, handlers: handlers(GL, labelGitlab(audit, { fail: 6 })), env: { GITLAB_TOKEN: "glpat-test" } });
      expect(j.code).not.toBe(0);
      expect(j.json().sequence?.state).toBe("ESCALATE");
    });

    it("GitLab self-managed: the token is withheld until approve-origins names the host", async () => {
      const read = fakeTracker(SELF, labelGitlab(selfManaged, { pass: selfManaged.firstDraws.length }));
      const private404: MockHandler = (req) => (req.headers.authorization ? read(req) : new Response(JSON.stringify({ message: "404 Project Not Found" }), { status: 404, headers: { "content-type": "application/json" } }));
      const without = await job(comp, { dir: selfManaged.dir, handlers: { [SELF]: private404 }, env: { GITLAB_TOKEN: "glpat-test" } });
      expect(new Set(without.api!.to(SELF).map((q) => q.headers.authorization ?? "none"))).toEqual(new Set(["none"]));
      expect(without.stderr).toContain("GITLAB_TOKEN -> https://gitlab.example.com is not approved on this machine, so withheld");

      const approved = gitlabComponent({ "approve-origins": `GITLAB_TOKEN=${SELF}` });
      const withApproval = await job(approved, { dir: selfManaged.dir, handlers: { [SELF]: private404 }, env: { GITLAB_TOKEN: "glpat-test" } });
      expect(withApproval.code, withApproval.stderr).toBe(0);
      expect(new Set(withApproval.api!.to(SELF).map((q) => q.headers.authorization))).toEqual(new Set(["Bearer glpat-test"]));
      expect(withApproval.json().sequence?.state).toBe("CERTIFIED");
    });
  });
});

describe("the Bitbucket step (FR6.3)", () => {
  const doc = YAML.parse(codeBlocks(join(ROOT, "docs", "ci", "bitbucket.md")).find((b) => b.info === "yaml bitbucket-pipelines.yml")!.text) as {
    image: string;
    pipelines: {
      branches: { main: { step: { name: string; condition: { changesets: { includePaths: string[] } }; script: string[] } }[] };
      custom: Record<string, ({ variables: { name: string; default: string }[] } | { step: { script: string[] } })[]>;
    };
  };

  it("runs on a push to main that changes audit/**, and the custom pipeline runs verify with the same script", () => {
    const main = doc.pipelines.branches.main[0]!.step;
    expect(main.condition.changesets.includePaths).toEqual(["audit/**"]);
    const custom = doc.pipelines.custom["pr-rla-verify"]!;
    const vars = (custom[0] as { variables: { name: string; default: string }[] }).variables;
    expect(vars.find((v) => v.name === "PRRLA_COMMAND")?.default).toBe("verify");
    expect(vars.find((v) => v.name === "PRRLA_OFFLINE")?.default).toBe("false");
    expect((custom[1] as { step: { script: string[] } }).step.script).toEqual(main.script);
  });

  it("is a script step: no Docker pipe, and the image is pinned by digest", () => {
    expect(JSON.stringify(doc)).not.toMatch(/\bpipe:/);
    expect(doc.image).toMatch(/^node:24@sha256:[0-9a-f]{64}$/);
  });

  it("the custom pipeline's settings reach the script: verify, online", async () => {
    const dir = gitFileAudit("certified");
    const j = await job(bitbucketStep(), { dir, bin: (d) => cannedShim(d, { code: 0, stdout: JSON.stringify({ verdict: "VERIFIED", statusLine: "s", checks: [] }) }), override: { PRRLA_COMMAND: "verify", PRRLA_OFFLINE: "false" } });
    expect(j.argv()).toBe("--plugins builtin-only -C . verify --json");
  });
});
