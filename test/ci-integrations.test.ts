import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { Ajv, type ValidateFunction } from "ajv";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { POSIX_SH, ROOT, codeBlocks, exitMapBlock, interpolateGitLab, renderGitLabTemplate } from "./helpers/ci-harness.js";

/**
 * The three CI templates, checked as files (FR6.2, FR6.3, FR6.4, FR6.5, FR6.6, NFR18; test-design.md
 * section 2, U7): each against its published schema, vendored under test/fixtures/schemas with its
 * source and date; the pins; the exit-code mapping; and the rule that nothing here publishes.
 * Offline: the schemas are files, and no test in this file opens a socket.
 */

const ACTION_DIR = join(ROOT, "integrations", "github-action");
const ACTION_YML = join(ACTION_DIR, "action.yml");
const TEMPLATE = join(ROOT, "integrations", "gitlab", "templates", "pr-rla.yml");
const SCHEMAS = join(ROOT, "test", "fixtures", "schemas");
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

// ---------------------------------------------------------------------------------------------
// Schemas (FR6.5)
// ---------------------------------------------------------------------------------------------

interface Source {
  source: string;
  kind: string;
  fetchedAt: string;
  sha256: string;
  bytes: number;
}
const sources = (JSON.parse(readFileSync(join(SCHEMAS, "SOURCES.json"), "utf8")) as { schemas: Record<string, Source> }).schemas;

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const validators = new Map<string, ValidateFunction>();
function validator(file: string): ValidateFunction {
  let v = validators.get(file);
  if (!v) {
    v = ajv.compile(JSON.parse(readFileSync(join(SCHEMAS, file), "utf8")) as object);
    validators.set(file, v);
  }
  return v;
}
function problems(file: string, doc: unknown): string[] {
  const v = validator(file);
  return v(doc) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`);
}
const yamlDocs = (text: string) => YAML.parseAllDocuments(text).map((d) => d.toJS() as unknown);

describe("the vendored schemas are the published ones, recorded with their source and date", () => {
  it.each(Object.entries(sources))("%s", (file, s) => {
    expect(s.kind).toBe("recorded");
    expect(s.source).toMatch(/^https:\/\/(www\.schemastore\.org|gitlab\.com\/gitlab-org\/gitlab\/|api\.bitbucket\.org)/);
    expect(s.fetchedAt).toBe("2026-11-04");
    const bytes = readFileSync(join(SCHEMAS, file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(s.sha256);
    expect(bytes.length).toBe(s.bytes);
  });
  it("covers action.yml, the GitLab CI file and bitbucket-pipelines.yml, and nothing else sits there", () => {
    expect(Object.keys(sources).sort()).toEqual(["bitbucket-pipelines.json", "github-action.json", "gitlab-ci.json"]);
    expect(readdirSync(SCHEMAS).sort()).toEqual(["SOURCES.json", "bitbucket-pipelines.json", "github-action.json", "gitlab-ci.json"]);
  });
});

describe("FR6.1, FR6.5: action.yml passes GitHub's action-metadata schema", () => {
  const action = YAML.parse(read("integrations", "github-action", "action.yml")) as { runs: { using: string; steps: { run?: string; uses?: string; shell?: string; id?: string; env?: Record<string, string> }[] }; inputs: Record<string, { default?: string; required?: boolean; description: string }>; outputs: Record<string, { value: string }> };

  it("is valid", () => expect(problems("github-action.json", action)).toEqual([]));

  it("the instrument can fail: a typo in `using`, a step with neither run nor uses, and an unknown top-level key are each refused", () => {
    expect(problems("github-action.json", { ...action, runs: { ...action.runs, using: "composit" } })).not.toEqual([]);
    expect(problems("github-action.json", { ...action, runs: { using: "composite", steps: [{ name: "nothing" }] } })).not.toEqual([]);
    expect(problems("github-action.json", { ...action, extra: true })).not.toEqual([]);
  });

  it("has the inputs and outputs the design lists, and no default sample", () => {
    expect(Object.keys(action.inputs)).toEqual(expect.arrayContaining(["command", "dir", "offline", "comment", "fail-on", "plugins", "approve-origins", "accept-lock-grants", "allow-writes"]));
    expect(Object.keys(action.outputs).sort()).toEqual(["exit-code", "json", "llr", "prefix", "state"]);
    expect(action.inputs.command!.default).toBe("status");
    expect(action.inputs["allow-writes"]!.default).toBe("false");
    expect(action.inputs["accept-lock-grants"]!.default).toBe("false");
    expect(action.inputs["fail-on"]!.default).toBe("escalate,refusal,timestamps,incomplete");
    expect(action.inputs.plugins!.default).toBe("builtin-only");
    expect(action.inputs.offline!.default).toBe("true");
    expect(action.inputs.comment!.default).toBe("false");
    expect(action.inputs["accept-lock-grants"]!.description).toContain("Only for an audit repository you control");
  });

  it("pins actions/setup-node by full commit SHA at Node 24, and uses nothing else it does not pin", () => {
    const uses = action.runs.steps.filter((s) => s.uses).map((s) => s.uses!);
    expect(uses).toEqual(["actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"]);
    expect(read("integrations", "github-action", "action.yml")).toMatch(/uses: actions\/setup-node@[0-9a-f]{40} # v7\.1\.0\n\s+with:\n\s+node-version: "24"/);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  it("never splices an expression into a script: every run step reads inputs from the environment", () => {
    for (const s of action.runs.steps.filter((x) => x.run)) {
      expect(s.run, s.id).not.toContain("${{");
      expect(s.shell, s.id).toBe("bash");
    }
    // Every input reaches the scripts as an INPUT_* variable defined in a step's `env:`.
    const envNames = new Set(action.runs.steps.flatMap((s) => Object.keys(s.env ?? {})));
    for (const name of Object.keys(action.inputs).filter((n) => n !== "token")) expect(envNames, name).toContain(`INPUT_${name.toUpperCase().replace(/-/g, "_")}`);
  });

  it("the install step is `npm ci` from the action's own lockfile, without lifecycle scripts", () => {
    const install = action.runs.steps.find((s) => s.id === "install")!;
    expect(install.run).toBe('npm ci --prefix "$ACTION_PATH" --ignore-scripts --no-audit --no-fund');
  });

  it("every script the action runs passes the shell's own syntax check", () => {
    for (const f of ["prepare.sh", "run.sh"]) expect(spawnSync("bash", ["-n", join(ACTION_DIR, "scripts", f)]).status, f).toBe(0);
    expect(spawnSync(POSIX_SH, ["-n", join(ACTION_DIR, "scripts", "exit-map.sh")]).status).toBe(0);
    for (const f of ["report.mjs", "comment.mjs"]) expect(spawnSync(process.execPath, ["--check", join(ACTION_DIR, "scripts", f)]).status, f).toBe(0);
  });
});

describe("FR6.2, FR6.5: the GitLab component and the plain snippet pass GitLab's CI schema", () => {
  const [header, body] = yamlDocs(read("integrations", "gitlab", "templates", "pr-rla.yml")) as [{ spec: { inputs: Record<string, unknown> } }, Record<string, Record<string, unknown>>];
  const snippet = YAML.parse(codeBlocks(join(ROOT, "docs", "ci", "gitlab.md")).find((b) => b.info === "yaml .gitlab-ci.yml")!.text) as Record<string, Record<string, unknown>>;

  it("the header (spec:inputs) and the job document are each valid", () => {
    expect(problems("gitlab-ci.json", header)).toEqual([]);
    expect(problems("gitlab-ci.json", body)).toEqual([]);
  });

  it("the job as GitLab would see it after interpolation is valid, for the defaults and for another command", () => {
    for (const given of [{} as Record<string, string>, { command: "verify", offline: "false", plugins: "allow", "approve-origins": "GITLAB_TOKEN=https://gitlab.example.com", integrity: "sha512-x" }]) {
      const t = renderGitLabTemplate(TEMPLATE, given);
      expect(problems("gitlab-ci.json", { [t.jobName]: t.job }), JSON.stringify(given)).toEqual([]);
    }
  });

  it("the plain snippet is valid", () => expect(problems("gitlab-ci.json", snippet)).toEqual([]));

  it("the instrument can fail: an unknown job keyword, a script of the wrong type and a bad spec are refused", () => {
    const job = body["pr-rla-$[[ inputs.command ]]"]!;
    expect(problems("gitlab-ci.json", { "pr-rla": { ...job, scripts: ["x"], script: undefined } })).not.toEqual([]);
    expect(problems("gitlab-ci.json", { "pr-rla": { ...job, script: 5 } })).not.toEqual([]);
    expect(problems("gitlab-ci.json", { spec: { inputs: { version: { type: "strings" } } } })).not.toEqual([]);
  });

  it("every spec:input is typed and has a default", () => {
    for (const [name, spec] of Object.entries(header.spec.inputs)) expect(spec, name).toMatchObject({ type: "string" });
    expect(Object.keys(header.spec.inputs).sort()).toEqual(["accept-lock-grants", "approve-origins", "audit-path", "command", "dir", "fail-on", "image", "integrity", "offline", "plugins", "stage", "tsa-trust", "version"]);
  });

  it("interpolating the inputs leaves no placeholder behind", () => {
    const t = renderGitLabTemplate(TEMPLATE);
    expect(JSON.stringify(t)).not.toContain("$[[");
    const values = Object.fromEntries(Object.entries(t.specInputs).map(([k, v]) => [k, v.default ?? ""]));
    expect(interpolateGitLab({ a: "x-$[[ inputs.stage ]]-y" }, values)).toEqual({ a: "x-test-y" });
    expect(() => interpolateGitLab({ a: "$[[ inputs.nope ]]" }, values)).toThrow(/no value for input nope/);
  });
});

describe("FR6.3, FR6.5: the Bitbucket step passes Bitbucket's pipelines schema", () => {
  const block = codeBlocks(join(ROOT, "docs", "ci", "bitbucket.md")).find((b) => b.info === "yaml bitbucket-pipelines.yml")!;
  const doc = YAML.parse(block.text) as { pipelines: { branches: { main: { step: Record<string, unknown> }[] } } };

  it("is valid", () => expect(problems("bitbucket-pipelines.json", doc)).toEqual([]));

  it("the instrument can fail: a script that is a string or empty, a pipe that is not a string, a bad size and a bad condition are each refused", () => {
    const step = doc.pipelines.branches.main[0]!.step;
    const withStep = (s: unknown) => ({ pipelines: { branches: { main: [{ step: s }] } } });
    expect(problems("bitbucket-pipelines.json", withStep({ ...step, script: "echo" }))).not.toEqual([]);
    expect(problems("bitbucket-pipelines.json", withStep({ ...step, script: [] }))).not.toEqual([]);
    expect(problems("bitbucket-pipelines.json", withStep({ ...step, script: [{ pipe: 5 }] }))).not.toEqual([]);
    expect(problems("bitbucket-pipelines.json", withStep({ ...step, size: "3x" }))).not.toEqual([]);
    expect(problems("bitbucket-pipelines.json", withStep({ ...step, condition: { changesets: { includePaths: "audit" } } }))).not.toEqual([]);
  });

  it("the schema does NOT catch a step with no script or an unknown key (recorded 2026-11-04), so this test does", () => {
    const withStep = (s: unknown) => ({ pipelines: { branches: { main: [{ step: s }] } } });
    expect(problems("bitbucket-pipelines.json", withStep({ name: "no script" }))).toEqual([]);
    expect(problems("bitbucket-pipelines.json", withStep({ name: "x", script: ["true"], bogus: 1 }))).toEqual([]);
    const known = new Set(["name", "condition", "script", "artifacts"]);
    const steps = [...doc.pipelines.branches.main.map((x) => x.step), ...Object.values((doc.pipelines as unknown as { custom: Record<string, ({ step?: Record<string, unknown> })[]> }).custom).flatMap((p) => p.flatMap((x) => (x.step ? [x.step] : [])))];
    expect(steps.length).toBe(2);
    for (const st of steps) {
      expect(Object.keys(st).every((k) => known.has(k))).toBe(true);
      expect(Array.isArray(st.script) && (st.script as unknown[]).length > 0).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Pins (FR6.4, NFR18)
// ---------------------------------------------------------------------------------------------

describe("FR6.4, NFR18: every integration pins the pr-rla version, and runs builtin-only unless the owner opts in", () => {
  const pkg = JSON.parse(readFileSync(join(ACTION_DIR, "package.json"), "utf8")) as { private: boolean; license: string; dependencies: Record<string, string>; devDependencies?: unknown };
  const lock = JSON.parse(readFileSync(join(ACTION_DIR, "package-lock.json"), "utf8")) as { lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string }> };

  it("the Action's package.json is private and UNLICENSED, and names exactly one dependency, pr-rla", () => {
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe("UNLICENSED");
    expect(Object.keys(pkg.dependencies)).toEqual(["pr-rla"]);
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("the dependency is one exact version: a vendored tarball until release, an exact registry version after", () => {
    const spec = pkg.dependencies["pr-rla"]!;
    expect(spec === rootPkg.version || spec === `file:vendor/pr-rla-${rootPkg.version}.tgz`, spec).toBe(true);
    expect(spec).not.toMatch(/[\^~*><|x]|latest/);
  });

  it("the lockfile pins pr-rla by version and sha512 integrity, and every package it installs has an integrity", () => {
    expect(lock.lockfileVersion).toBe(3);
    const entry = lock.packages["node_modules/pr-rla"]!;
    expect(entry.version).toBe(rootPkg.version);
    expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    for (const [path, p] of Object.entries(lock.packages)) if (path !== "") expect(p.integrity, path).toMatch(/^sha512-/);
    for (const [path, p] of Object.entries(lock.packages)) if (path !== "" && !p.resolved!.startsWith("file:")) expect(p.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
  });

  it("the tarball the lockfile names is the one on disk, and it is pr-rla", () => {
    const entry = lock.packages["node_modules/pr-rla"]!;
    if (!entry.resolved!.startsWith("file:")) return; // after release: the registry's tarball
    const file = join(ACTION_DIR, entry.resolved!.slice("file:".length));
    expect(existsSync(file)).toBe(true);
    const bytes = readFileSync(file);
    expect(`sha512-${createHash("sha512").update(bytes).digest("base64")}`).toBe(entry.integrity);
    // package/package.json inside the tarball, read without extracting it.
    const tar = gunzipSync(bytes);
    let off = 0;
    let inner: { name: string; version: string; bin: Record<string, string> } | null = null;
    while (off + 512 <= tar.length && !inner) {
      const name = tar.subarray(off, off + 100).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(tar.subarray(off + 124, off + 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
      if (name === "package/package.json") inner = JSON.parse(tar.subarray(off + 512, off + 512 + size).toString("utf8")) as typeof inner;
      off += 512 + Math.ceil(size / 512) * 512;
    }
    expect(inner).toMatchObject({ name: "pr-rla", version: rootPkg.version, bin: { "pr-rla": "dist/cli.js" } });
  });

  it("the GitLab component's version default is that exact version, its image is pinned by digest, and plugins default to builtin-only", () => {
    const t = renderGitLabTemplate(TEMPLATE);
    expect(t.specInputs.version!.default).toBe(rootPkg.version);
    expect(t.specInputs.image!.default).toMatch(/^node:24-alpine@sha256:[0-9a-f]{64}$/);
    expect(t.specInputs.plugins!.default).toBe("builtin-only");
    expect(t.job.variables!.PRRLA_PLUGINS).toBe("builtin-only");
    expect(t.job.script.join("\n")).toContain('--plugins builtin-only "$@"');
  });

  it("the plain snippet and the Bitbucket step carry the same exact version and the same builtin-only switch", () => {
    const bb = codeBlocks(join(ROOT, "docs", "ci", "bitbucket.md")).find((b) => b.info === "yaml bitbucket-pipelines.yml")!.text;
    const gl = codeBlocks(join(ROOT, "docs", "ci", "gitlab.md")).find((b) => b.info === "yaml .gitlab-ci.yml")!.text;
    expect(bb).toContain(`PRRLA_VERSION="\${PRRLA_VERSION-${rootPkg.version}}"`);
    expect(bb).toContain('PRRLA_PLUGINS="${PRRLA_PLUGINS-builtin-only}"');
    expect(bb).toContain('--plugins builtin-only "$@"');
    expect(gl).toContain(`PRRLA_VERSION: "${rootPkg.version}"`);
    expect(gl).toContain('PRRLA_PLUGINS: "builtin-only"');
    expect(gl).toMatch(/image: node:24-alpine@sha256:[0-9a-f]{64}/);
    expect(bb).toMatch(/^image: node:24@sha256:[0-9a-f]{64}$/m);
  });

  it("the Action's workflow example pins actions/checkout by commit SHA and the action by a full commit SHA placeholder", () => {
    const example = codeBlocks(join(ROOT, "docs", "ci", "github.md")).find((b) => b.info === "yaml" && b.text.includes("name: pr-rla"))!;
    const wf = YAML.parse(example.text) as { jobs: { status: { steps: { uses: string }[] } } };
    const [checkout, ours] = wf.jobs.status.steps.map((s) => s.uses);
    expect(checkout).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(ours).toBe("<owner>/pr-rla/integrations/github-action@<full commit SHA>");
  });
});

// ---------------------------------------------------------------------------------------------
// The exit-code mapping, once, in the shell all three share
// ---------------------------------------------------------------------------------------------

describe("the exit-code mapping (functional-design.md U7 with exit 6)", () => {
  const map = join(ACTION_DIR, "scripts", "exit-map.sh");
  const NAMES = ["escalate", "refusal", "timestamps", "incomplete"];
  const GOVERNED: Record<number, string> = { 2: "escalate", 3: "refusal", 5: "timestamps", 6: "incomplete" };
  const failOns = ["escalate,refusal,timestamps,incomplete", "", "escalate", "refusal,timestamps", " escalate , incomplete ", "timestamps,incomplete,escalate,refusal"];
  const codes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 64, 126, 127, 130, 255, 256];

  /** The model, written apart from the shell: which code fails under which list. */
  const fails = (code: number, failOn: string): boolean => {
    if (code === 0) return false;
    const name = GOVERNED[code];
    return name === undefined ? true : failOn.split(",").map((x) => x.trim()).includes(name);
  };

  for (const [shellName, shell] of [["sh (dash where available)", POSIX_SH], ["bash", "bash"]] as const) {
    it(`prrla_decide matches the table for every code and list, in ${shellName}`, () => {
      const script = [`. "${map}"`, ...codes.flatMap((c) => failOns.map((f) => `prrla_decide ${c} '${f}' && echo "${c}|${f}|pass|$PRRLA_RESULT" || echo "${c}|${f}|fail|$PRRLA_RESULT"`))].join("\n");
      const r = spawnSync(shell, ["-c", script], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines).toHaveLength(codes.length * failOns.length);
      for (const line of lines) {
        const [c, f, verdict, result] = line.split("|") as [string, string, string, string];
        const failed = fails(Number(c), f);
        expect(verdict, line).toBe(failed ? "fail" : "pass");
        expect(result, line).toBe(failed ? "fail" : "pass");
      }
    });
  }

  it("exit 4 and exit 1 fail whatever fail-on says; the default fail-on names all four governed codes", () => {
    const r = spawnSync(POSIX_SH, ["-c", `. "${map}"; for c in 1 4; do prrla_decide $c 'escalate,refusal,timestamps,incomplete' || echo "$c fails: $PRRLA_REASON"; done`], { encoding: "utf8" });
    expect(r.stdout).toContain("1 fails: exit 1: a check failed");
    expect(r.stdout).toContain("4 fails: exit 4: pr-rla stopped before it finished");
    expect(NAMES).toEqual(Object.values(GOVERNED));
  });

  it("prrla_check_fail_on accepts the four names (any order, spaces, empty) and refuses anything else", () => {
    const run = (v: string) => spawnSync(POSIX_SH, ["-c", `. "${map}"; prrla_check_fail_on '${v}'`], { encoding: "utf8" });
    for (const ok of ["", "escalate", "incomplete,escalate", " refusal , timestamps "]) expect(run(ok).status, ok).toBe(0);
    for (const bad of ["everything", "escalate,exit2", "Escalate", "none", "escalate;true"]) {
      const r = run(bad);
      expect(r.status, bad).toBe(1);
      expect(r.stderr).toContain("fail-on: unknown name");
    }
  });

  it("the same text is in all three integrations (one mapping, not three that drift apart)", () => {
    const canonical = exitMapBlock(readFileSync(map, "utf8"));
    const component = renderGitLabTemplate(TEMPLATE).job.script.join("\n");
    const snippet = (YAML.parse(codeBlocks(join(ROOT, "docs", "ci", "gitlab.md")).find((b) => b.info === "yaml .gitlab-ci.yml")!.text) as Record<string, { script: string[] }>)["pr-rla-status"]!.script.join("\n");
    const bitbucket = (YAML.parse(codeBlocks(join(ROOT, "docs", "ci", "bitbucket.md")).find((b) => b.info === "yaml bitbucket-pipelines.yml")!.text) as { pipelines: { branches: { main: { step: { script: string[] } }[] } } }).pipelines.branches.main[0]!.step.script.join("\n");
    for (const [name, text] of [["component", component], ["snippet", snippet], ["bitbucket", bitbucket]] as const) expect(text, name).toContain(canonical);
    // And the rest of the GitLab and Bitbucket script is shared too: from the exit map to the end.
    const tail = (t: string) => t.slice(t.indexOf("# 2. Inputs, checked."));
    expect(tail(snippet)).toBe(tail(component));
    expect(tail(bitbucket)).toBe(tail(component));
  });
});

// ---------------------------------------------------------------------------------------------
// FR6.6, FR6.7, docs
// ---------------------------------------------------------------------------------------------

describe("FR6.6: nothing in the build publishes", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (f === "node_modules" ? [] : statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  const ours = [...walk(join(ROOT, "integrations")).filter((f) => !f.endsWith(".tgz")), ...walk(join(ROOT, "docs", "ci")), join(ROOT, "scripts", "pack-action-tarball.mjs")];

  it("no publish command, no release job, no catalog publication in any file U7 added", () => {
    for (const f of ours) {
      const text = readFileSync(f, "utf8");
      // The docs may say they do not publish; no file may do it.
      expect(text, relative(ROOT, f)).not.toMatch(/npm publish|npm\s+dist-tag|\brelease-cli\b|glab\s+(ci|release)\b|catalog\s+publish/i);
    }
    const component = read("integrations", "gitlab", "templates", "pr-rla.yml");
    expect(component).not.toMatch(/^\s*release:/m);
  });

  it("the repository has no CI of its own to publish from", () => {
    for (const p of [".github", ".gitlab-ci.yml", "bitbucket-pipelines.yml"]) expect(existsSync(join(ROOT, p)), p).toBe(false);
  });

  it("every package.json under integrations is private and UNLICENSED, and there is no licence file anywhere U7 wrote", () => {
    for (const f of walk(join(ROOT, "integrations")).filter((x) => x.endsWith("package.json"))) {
      const p = JSON.parse(readFileSync(f, "utf8")) as { private: boolean; license: string };
      expect([p.private, p.license], f).toEqual([true, "UNLICENSED"]);
    }
    for (const f of [...walk(join(ROOT, "integrations")), ...walk(join(ROOT, "docs", "ci"))]) expect(f, f).not.toMatch(/(^|\/)(LICEN[SC]E|COPYING)(\.|$)/i);
  });

  it("the pr-rla in the Action is a local tarball: no registry URL names pr-rla itself", () => {
    expect(read("integrations", "github-action", "package-lock.json")).not.toContain("registry.npmjs.org/pr-rla/");
  });

  it("the build has no network step of its own: the only `npm` the scripts run is the install the docs name", () => {
    expect(read("integrations", "github-action", "action.yml")).toContain("npm ci --prefix");
    expect(read("integrations", "github-action", "action.yml")).not.toMatch(/npm (publish|login|adduser|token)/);
  });
});

describe("the integrations stand apart from any company: no name of one, no tracking ledger of its own", () => {
  const words = [["cen", "driix"], ["lat", "tice"]].map((w) => new RegExp(`\\b${w.join("")}\\b`, "i"));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (f === "node_modules" ? [] : statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  it("none of the U7 files names one", () => {
    const files = [...walk(join(ROOT, "integrations")).filter((f) => !f.endsWith(".tgz")), ...walk(join(ROOT, "docs", "ci")), ...walk(join(ROOT, "test", "fixtures", "ci")), join(ROOT, "scripts", "pack-action-tarball.mjs"), join(ROOT, "test", "helpers", "ci-harness.ts"), join(ROOT, "test", "helpers", "ci-fixtures.ts"), join(ROOT, "test", "helpers", "ci-preload.cjs")];
    for (const f of files) for (const w of words) expect(readFileSync(f, "utf8"), relative(ROOT, f)).not.toMatch(w);
  });
});

describe("FR6.7: the end-to-end matrix names one ledger per SCM, and each cell points at a test that runs", () => {
  const readme = read("docs", "ci", "README.md");
  const row = (name: string) => readme.split("\n").find((l) => l.startsWith(`| **${name}**`))!;

  it("the Ledger row has github-issues, gitlab-issues, and git-file or the Jira example", () => {
    const cells = row("Ledger").split("|").map((c) => c.trim());
    expect(cells[2]).toBe("`github-issues`");
    expect(cells[3]).toBe("`gitlab-issues`");
    expect(cells[4]).toBe("`git-file`, or the Jira example where the team uses Jira");
  });

  it("every test file the matrix names exists, and the CI cells name the harness tests that run each SCM's job", () => {
    const named = [...readme.matchAll(/`(test\/[A-Za-z0-9._/-]+\.test\.ts)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(6);
    for (const f of named) expect(existsSync(join(ROOT, f)), f).toBe(true);
    const ci = row("CI");
    expect(ci).toContain("test/ci-github-action.test.ts");
    expect(ci).toContain("test/ci-job-scripts.test.ts");
  });

  it("each SCM's CI test runs the cell it claims: an ESCALATE fixture fails the job, in all three", () => {
    expect(read("test", "ci-github-action.test.ts")).toContain("DEMO, ESCALATE fixture fails the job");
    expect(read("test", "ci-job-scripts.test.ts")).toContain("DEMO, an ESCALATE fixture fails the job");
  });
});

describe("the docs: a CI guide per SCM, linked from the README", () => {
  it("docs/ci has a page for GitHub, GitLab and Bitbucket and an index, and the README links to them", () => {
    for (const f of ["README.md", "github.md", "gitlab.md", "bitbucket.md"]) expect(existsSync(join(ROOT, "docs", "ci", f)), f).toBe(true);
    const readme = read("README.md");
    for (const f of ["github.md", "gitlab.md", "bitbucket.md"]) expect(readme, f).toContain(`docs/ci/${f}`);
    expect(readme).toContain("docs/ci/README.md");
  });

  it("the guides state the credentials model, the budget notes, the checkpoint rule and what stays unverified", () => {
    const gh = read("docs", "ci", "github.md");
    expect(gh).toContain("Events caused by `GITHUB_TOKEN`");
    expect(gh).toContain("1,000 REST requests an hour");
    expect(gh).toContain("allow-writes: true");
    expect(gh).toContain("contents: write");
    expect(gh).toContain("### Re-pinning at release");
    for (const page of ["github.md", "gitlab.md", "bitbucket.md"]) {
      const text = read("docs", "ci", page);
      expect(text, page).toMatch(/plugin approve --env ENV_VAR --origin https:\/\/host --yes/);
      expect(text, page).toMatch(/Use it only for an audit repository you control/);
    }
    expect(read("docs", "ci", "gitlab.md")).toContain("CI/CD Catalog");
    expect(read("docs", "ci", "gitlab.md")).toContain("`CI_JOB_TOKEN` cannot call the issues API");
    expect(read("docs", "ci", "bitbucket.md")).toContain("2025-09-09");
    const index = read("docs", "ci", "README.md");
    expect(index).toContain("## Scopes");
    expect(index).toContain("unverified against the live service");
    expect(index).toMatch(/## Platforms\n\n.*Windows runners are untested/s);
  });
});
