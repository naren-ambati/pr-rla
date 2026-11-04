import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

/**
 * The CI harness (FR6.5, D8; test-design.md section 2, U7): runs what the three CI integrations
 * run, on this machine, against fixture audit directories and mock servers.
 *
 *  - runComposite: a GitHub composite action. It reads action.yml, evaluates the expressions the
 *    action uses, and runs every `run` step with bash, in order, with GITHUB_OUTPUT,
 *    GITHUB_STEP_SUMMARY and the other runner files pointed at temporary files. A `uses` step is
 *    recorded, never fetched.
 *  - runScript: the `script` lines of a GitLab job or a Bitbucket step, in one shell.
 *  - MockApi: an HTTP server on 127.0.0.1 standing in for api.github.com, gitlab.com and the like.
 *    Child processes reach it through test/helpers/ci-preload.cjs, which swaps only the last hop of
 *    fetch, so the real CLI's grants, read-only guard and pacing all run.
 *
 * Never used: act, a real repository, a hosted runner, GitLab's lint API.
 */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PRELOAD = join(ROOT, "test", "helpers", "ci-preload.cjs");
export const CLI = join(ROOT, "dist", "cli.js");
/** dash when the machine has it: it rejects bashisms that a POSIX sh job image (alpine's ash) would reject too. */
export const POSIX_SH = existsSync("/bin/dash") ? "/bin/dash" : "/bin/sh";

// ---------------------------------------------------------------------------------------------
// Expressions: the subset of GitHub's `${{ }}` language the action uses. Anything else throws, so
// the action cannot start using a construct this harness has never run.
// ---------------------------------------------------------------------------------------------

type Json = unknown;
export interface ExprContext {
  vars: Record<string, Json>;
  /** The job status functions: success() and failure(). */
  failed: boolean;
}

type Tok = { t: "str" | "id" | "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:'((?:[^']|'')*)'|(==|!=|&&|\|\||!|\(|\))|([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*(?:\(\))?))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`harness: unsupported expression syntax near "${src.slice(pos)}" in "${src}"`);
    if (m[1] !== undefined) out.push({ t: "str", v: m[1].replace(/''/g, "'") });
    else if (m[2] !== undefined) out.push({ t: "op", v: m[2] });
    else out.push({ t: "id", v: m[3]! });
    pos = re.lastIndex;
  }
  return out;
}

const truthy = (v: Json): boolean => !(v === null || v === undefined || v === "" || v === 0 || v === false);
const looseEq = (a: Json, b: Json): boolean => {
  const n = (x: Json) => (x === null || x === undefined ? "" : typeof x === "string" ? x.toLowerCase() : String(x));
  return n(a) === n(b);
};

export function evalExpression(src: string, ctx: ExprContext): Json {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const lookup = (name: string): Json => {
    if (name === "always()") return true;
    if (name === "success()") return !ctx.failed;
    if (name === "failure()") return ctx.failed;
    if (name.endsWith("()")) throw new Error(`harness: function ${name} is not supported`);
    const parts = name.split(".");
    const root = parts[0]!;
    if (!(root in ctx.vars)) throw new Error(`harness: unknown context "${root}" in "${src}"`);
    let cur: Json = ctx.vars[root];
    for (const p of parts.slice(1)) {
      if (cur === null || typeof cur !== "object") return null;
      cur = (cur as Record<string, Json>)[p];
    }
    return cur ?? null;
  };
  const primary = (): Json => {
    const t = toks[i++];
    if (!t) throw new Error(`harness: expression ended early: "${src}"`);
    if (t.t === "str") return t.v;
    if (t.t === "id") return lookup(t.v);
    if (t.v === "(") {
      const v = or();
      if (toks[i++]?.v !== ")") throw new Error(`harness: missing ) in "${src}"`);
      return v;
    }
    throw new Error(`harness: unexpected "${t.v}" in "${src}"`);
  };
  const unary = (): Json => {
    if (peek()?.v === "!" && peek()?.t === "op") {
      i++;
      return !truthy(unary());
    }
    return primary();
  };
  const eq = (): Json => {
    let l = unary();
    while (peek()?.t === "op" && (peek()!.v === "==" || peek()!.v === "!=")) {
      const op = toks[i++]!.v;
      const r = unary();
      l = op === "==" ? looseEq(l, r) : !looseEq(l, r);
    }
    return l;
  };
  const and = (): Json => {
    let l = eq();
    while (peek()?.t === "op" && peek()!.v === "&&") {
      i++;
      const r = eq();
      l = truthy(l) ? r : l;
    }
    return l;
  };
  const or = (): Json => {
    let l = and();
    while (peek()?.t === "op" && peek()!.v === "||") {
      i++;
      const r = and();
      l = truthy(l) ? l : r;
    }
    return l;
  };
  const v = or();
  if (i < toks.length) throw new Error(`harness: trailing tokens in "${src}"`);
  return v;
}

/** Replaces every `${{ expr }}` in a string, as the runner does before a step starts. */
export function interpolate(text: string, ctx: ExprContext): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_m, e: string) => {
    const v = evalExpression(e.trim(), ctx);
    return v === null || v === undefined ? "" : String(v);
  });
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }): Promise<Ran> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    p.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

/** A `pr-rla` executable for a job: the built CLI (or a canned program), as the CI job would find it after `npm ci`. */
export function writeBin(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
export const cliShim = (dir: string, name = "pr-rla") => writeBin(dir, name, `exec "${process.execPath}" "${CLI}" "$@"`);
/** A pr-rla that prints a fixed stdout and stderr and exits with `code`; `--version` still answers. */
export function cannedShim(dir: string, o: { code: number; stdout?: string; stderr?: string; version?: string }, name = "pr-rla"): string {
  const stdout = join(dir, `${name}.stdout`);
  const stderr = join(dir, `${name}.stderr`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stdout, o.stdout ?? "");
  writeFileSync(stderr, o.stderr ?? "");
  return writeBin(dir, name, `if [ "\${1:-}" = "--version" ]; then echo ${o.version ?? "0.1.0"}; exit 0; fi\ncat "${stdout}"\ncat "${stderr}" >&2\necho "$@" > "${dir}/${name}.argv"\nexit ${o.code}`);
}

export interface Isolation {
  /** origin -> base URL on the mock server (MockApi.routes). */
  routes?: Record<string, string>;
  denied: string;
}

/** The environment of every child: nothing from the real shell but PATH, and the preload. */
function baseEnv(home: string, iso: Isolation, extra: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: home,
    // A hermetic git: no identity or credential helper from the machine running the tests.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    NODE_OPTIONS: `--require=${PRELOAD}`,
    PRRLA_TEST_ROUTES: JSON.stringify(iso.routes ?? {}),
    PRRLA_TEST_DENIED: iso.denied,
  };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

export function deniedConnections(iso: Isolation): string[] {
  return existsSync(iso.denied) ? readFileSync(iso.denied, "utf8").split("\n").filter(Boolean) : [];
}

export function newIsolation(routes?: Record<string, string>): Isolation & { home: string } {
  const home = mkdtempSync(join(tmpdir(), "prrla-ci-home-"));
  return { home, denied: join(home, "denied.txt"), ...(routes ? { routes } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Mock HTTP API
// ---------------------------------------------------------------------------------------------

export interface SeenRequest {
  origin: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
export type MockHandler = (req: { method: string; path: string; headers: SeenRequest["headers"]; body: string }) => Response | Promise<Response>;

/** One server, one path prefix per mocked origin. */
export class MockApi {
  readonly seen: SeenRequest[] = [];
  private server: Server | null = null;
  private port = 0;
  private readonly origins: string[];

  constructor(private readonly handlers: Record<string, MockHandler>) {
    this.origins = Object.keys(handlers);
  }

  get routes(): Record<string, string> {
    return Object.fromEntries(this.origins.map((o, i) => [o, `http://127.0.0.1:${this.port}/o${i}`]));
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.serve(req).then(
        (r) => {
          res.statusCode = r.status;
          r.headers.forEach((v, k) => res.setHeader(k, v));
          void r.text().then((t) => res.end(t));
        },
        (e) => {
          res.statusCode = 500;
          res.end(String(e));
        },
      );
    });
    await new Promise<void>((ok) => this.server!.listen(0, "127.0.0.1", ok));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }

  private async serve(req: IncomingMessage): Promise<Response> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const m = /^\/o(\d+)(\/.*|)$/.exec(req.url ?? "");
    if (!m) return new Response("not routed", { status: 404 });
    const origin = this.origins[Number(m[1])]!;
    const path = m[2] || "/";
    const method = (req.method ?? "GET").toUpperCase();
    this.seen.push({ origin, method, path, headers: { ...req.headers }, body });
    return this.handlers[origin]!({ method, path, headers: req.headers, body });
  }

  /** Requests to one origin, in arrival order. */
  to(origin: string): SeenRequest[] {
    return this.seen.filter((r) => r.origin === origin);
  }
}

/** A handler that answers from a fake tracker's `fetch` (test/helpers/fake-issue-trackers.ts) as that origin. */
export function fakeTracker(origin: string, fake: { fetch: typeof fetch }): MockHandler {
  return async (req) => fake.fetch(`${origin}${req.path}`, { method: req.method, ...(req.body ? { body: req.body } : {}), headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")) as Record<string, string> });
}

// ---------------------------------------------------------------------------------------------
// GitHub composite action
// ---------------------------------------------------------------------------------------------

export interface StepResult {
  id: string | null;
  name: string | null;
  kind: "run" | "uses" | "skipped" | "not-run";
  status: "success" | "failure" | "skipped";
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  uses?: string;
  env: Record<string, string>;
  script?: string;
}

export interface CompositeOptions {
  actionDir: string;
  inputs?: Record<string, string>;
  /** The `github` context beyond the defaults: event, event_name, repository ... */
  github?: Record<string, Json>;
  workspace: string;
  /** Replaces node_modules/.bin/pr-rla in the action path. Default: the built CLI. */
  bin?: (binDir: string) => void;
  /** Step ids whose `run` is not executed (the npm install, which needs the network). Default ["install"]. */
  skip?: string[];
  isolation: ReturnType<typeof newIsolation>;
  /** Extra environment for every step (secrets the runner would provide). */
  env?: Record<string, string>;
}

export interface CompositeResult {
  steps: StepResult[];
  outputs: Record<string, string>;
  summary: string;
  conclusion: "success" | "failure";
  runnerTemp: string;
  actionPath: string;
  step: (id: string) => StepResult;
}

function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([^=<\s]+)<<(.+)$/.exec(lines[i]!);
    if (heredoc) {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i] !== heredoc[2]; i++) body.push(lines[i]!);
      out[heredoc[1]!] = body.join("\n");
      continue;
    }
    const eq = lines[i]!.indexOf("=");
    if (eq > 0) out[lines[i]!.slice(0, eq)] = lines[i]!.slice(eq + 1);
  }
  return out;
}

export async function runComposite(o: CompositeOptions): Promise<CompositeResult> {
  const action = YAML.parse(readFileSync(join(o.actionDir, "action.yml"), "utf8")) as {
    inputs?: Record<string, { default?: string }>;
    outputs?: Record<string, { value: string }>;
    runs: { using: string; steps: { id?: string; name?: string; if?: string; uses?: string; with?: Record<string, string>; shell?: string; run?: string; env?: Record<string, string> }[] };
  };
  if (action.runs.using !== "composite") throw new Error("harness: not a composite action");

  // The action path: a copy of the action, with a pr-rla where `npm ci` would have put one.
  const actionPath = mkdtempSync(join(tmpdir(), "prrla-action-"));
  cpSync(o.actionDir, actionPath, { recursive: true, filter: (s) => !["node_modules", "vendor"].includes(basename(s)) });
  const binDir = join(actionPath, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  if (o.bin) o.bin(binDir);
  else cliShim(binDir);

  const runnerTemp = mkdtempSync(join(tmpdir(), "prrla-runner-temp-"));
  const summaryFile = join(runnerTemp, "step-summary.md");
  const envFile = join(runnerTemp, "github-env");
  writeFileSync(summaryFile, "");
  writeFileSync(envFile, "");

  const github: Record<string, Json> = {
    action_path: actionPath,
    token: "ghs_harness_token",
    event: {},
    event_name: "push",
    repository: "acme/audit",
    server_url: "https://github.com",
    api_url: "https://api.github.com",
    workspace: o.workspace,
    ...o.github,
  };
  const vars: Record<string, Json> = { github, runner: { temp: runnerTemp }, inputs: {}, steps: {}, env: {} };
  const ctx: ExprContext = { vars, failed: false };

  const given = o.inputs ?? {};
  for (const k of Object.keys(given)) if (!(k in (action.inputs ?? {}))) throw new Error(`harness: the action has no input "${k}"`);
  const inputs: Record<string, string> = {};
  for (const [k, def] of Object.entries(action.inputs ?? {})) inputs[k] = k in given ? given[k]! : interpolate(def.default ?? "", ctx);
  vars.inputs = inputs;

  const extraEnv: Record<string, string> = {};
  const skip = new Set(o.skip ?? ["install"]);
  const results: StepResult[] = [];
  const stepOutputs: Record<string, { outputs: Record<string, string> }> = {};
  vars.steps = stepOutputs;

  for (const step of action.runs.steps) {
    const base = { id: step.id ?? null, name: step.name ?? null, stdout: "", stderr: "", outputs: {}, env: {} };
    const cond = step.if === undefined ? "success()" : step.if.replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
    if (!truthy(evalExpression(cond, ctx))) {
      results.push({ ...base, kind: "not-run", status: "skipped" });
      continue;
    }
    if (step.uses) {
      results.push({ ...base, kind: "uses", status: "success", uses: step.uses });
      continue;
    }
    if (step.id && skip.has(step.id)) {
      results.push({ ...base, kind: "skipped", status: "skipped", ...(step.run ? { script: step.run } : {}) });
      continue;
    }
    if (step.shell !== "bash") throw new Error(`harness: step ${step.id ?? step.name} needs shell: bash`);
    const script = interpolate(step.run ?? "", ctx);
    const stepEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.env ?? {})) stepEnv[k] = interpolate(String(v), ctx);

    const outFile = join(runnerTemp, `output-${results.length}`);
    writeFileSync(outFile, "");
    const scriptFile = join(runnerTemp, `step-${results.length}.sh`);
    writeFileSync(scriptFile, script);
    const env = baseEnv(o.isolation.home, o.isolation, {
      GITHUB_OUTPUT: outFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_ENV: envFile,
      GITHUB_WORKSPACE: o.workspace,
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_REPOSITORY: String(github.repository),
      GITHUB_EVENT_NAME: String(github.event_name),
      GITHUB_API_URL: String(github.api_url),
      GITHUB_SERVER_URL: String(github.server_url),
      RUNNER_TEMP: runnerTemp,
      CI: "true",
      GITHUB_ACTIONS: "true",
      ...o.env,
      ...extraEnv,
      ...stepEnv,
    });
    const ran = await run("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptFile], { cwd: o.workspace, env });
    const outputs = parseOutputs(readFileSync(outFile, "utf8"));
    if (step.id) stepOutputs[step.id] = { outputs };
    for (const [k, v] of Object.entries(parseOutputs(readFileSync(envFile, "utf8")))) extraEnv[k] = v;
    const ok = ran.code === 0;
    if (!ok) ctx.failed = true;
    results.push({ ...base, kind: "run", status: ok ? "success" : "failure", stdout: ran.stdout, stderr: ran.stderr, outputs, env: stepEnv, script });
  }

  const outputs: Record<string, string> = {};
  for (const [k, def] of Object.entries(action.outputs ?? {})) outputs[k] = interpolate(def.value, ctx);
  return {
    steps: results,
    outputs,
    summary: readFileSync(summaryFile, "utf8"),
    conclusion: ctx.failed ? "failure" : "success",
    runnerTemp,
    actionPath,
    step: (id) => {
      const s = results.find((r) => r.id === id);
      if (!s) throw new Error(`no step ${id}`);
      return s;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// GitLab and Bitbucket job scripts
// ---------------------------------------------------------------------------------------------

/** Replaces GitLab's `$[[ inputs.name ]]` with the given values (defaults filled in from the spec). */
export function interpolateGitLab<T>(doc: T, inputs: Record<string, string>): T {
  const text = JSON.stringify(doc).replace(/\$\[\[\s*inputs\.([A-Za-z0-9_-]+)\s*\]\]/g, (_m, name: string) => {
    if (!(name in inputs)) throw new Error(`harness: no value for input ${name}`);
    return JSON.stringify(inputs[name]).slice(1, -1);
  });
  return JSON.parse(text) as T;
}

export interface GitLabTemplate {
  specInputs: Record<string, { type?: string; default?: string; options?: string[]; regex?: string }>;
  jobName: string;
  job: { stage?: string; image?: string; variables?: Record<string, string>; rules?: { if?: string; changes?: string[]; when?: string }[]; script: string[]; artifacts?: { paths?: string[] } };
}

/** The component's second YAML document with its inputs filled in (defaults, then `given`). */
export function renderGitLabTemplate(path: string, given: Record<string, string> = {}): GitLabTemplate {
  const docs = YAML.parseAllDocuments(readFileSync(path, "utf8")).map((d) => d.toJS() as Record<string, unknown>);
  const specInputs = ((docs[0]!.spec as { inputs: GitLabTemplate["specInputs"] }).inputs ?? {}) as GitLabTemplate["specInputs"];
  const values: Record<string, string> = {};
  for (const [k, def] of Object.entries(specInputs)) values[k] = k in given ? given[k]! : (def.default ?? "");
  for (const k of Object.keys(given)) if (!(k in specInputs)) throw new Error(`harness: the component has no input ${k}`);
  const body = interpolateGitLab(docs[1]!, values);
  const [jobName] = Object.keys(body);
  return { specInputs, jobName: jobName!, job: body[jobName!] as GitLabTemplate["job"] };
}

/** Which of a job's `rules` applies, with the subset of GitLab's rule language the component uses: `$VAR == "x"` joined by `||`, and `changes` globs. */
export function ruleApplies(rules: NonNullable<GitLabTemplate["job"]["rules"]>, vars: Record<string, string>, changedFiles: string[]): boolean {
  const cond = (expr: string) => expr.split("||").some((part) => part.split("&&").every((cmp) => {
    const m = /^\s*\$([A-Z_]+)\s*(==|!=)\s*"([^"]*)"\s*$/.exec(cmp);
    if (!m) throw new Error(`harness: unsupported rule expression "${cmp}"`);
    return (vars[m[1]!] ?? "") === m[3] === (m[2] === "==");
  }));
  const glob = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/\*?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
  for (const r of rules) {
    if (r.if !== undefined && !cond(r.if)) continue;
    if (r.changes !== undefined && !r.changes.some((g) => changedFiles.some((f) => glob(g).test(f)))) continue;
    return r.when !== "never";
  }
  return false;
}

export interface ScriptOptions {
  lines: string[];
  /** "gitlab": POSIX sh -e. "bitbucket": bash -e. */
  shell: "gitlab" | "bitbucket";
  cwd: string;
  env: Record<string, string>;
  isolation: ReturnType<typeof newIsolation>;
}

/** Runs a job's script items in one shell session, stopping at the first failing command. */
export async function runScript(o: ScriptOptions): Promise<Ran> {
  const file = join(o.isolation.home, `job-${Math.random().toString(16).slice(2)}.sh`);
  writeFileSync(file, `${o.lines.join("\n")}\n`);
  const env = baseEnv(o.isolation.home, o.isolation, { CI: "true", ...o.env });
  return o.shell === "gitlab" ? run(POSIX_SH, ["-e", file], { cwd: o.cwd, env }) : run("bash", ["--noprofile", "--norc", "-e", file], { cwd: o.cwd, env });
}

/** The fenced code blocks of a markdown file, with their info strings. */
export function codeBlocks(path: string): { info: string; text: string }[] {
  const out: { info: string; text: string }[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(`{3,})(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i]!.startsWith(m[1]!); i++) body.push(lines[i]!);
    out.push({ info: m[2]!.trim(), text: body.join("\n") });
  }
  return out;
}

/** The text between the exit-map markers of a file or string. */
export function exitMapBlock(text: string): string {
  const m = /^# >>> pr-rla exit map\n([\s\S]*?)^# <<< pr-rla exit map$/m.exec(text);
  if (!m) throw new Error("no exit map block");
  return m[0];
}

export function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)).map((f) => join(e.name, f)) : [e.name]));
}
