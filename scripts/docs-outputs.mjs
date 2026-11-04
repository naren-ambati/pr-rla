// The docs' generated output blocks (FR8.2): every block that shows what pr-rla prints offline on a
// fixture is written by running the command, never by hand.
//
// Usage (after `npm run build`):
//   node scripts/docs-outputs.mjs          run every command below and rewrite its block and date
//   node scripts/docs-outputs.mjs --check  run them and report blocks that differ (what check-docs does)
//
// A generated block is an `output` fence whose caption, the line before it, ends with
// `<!-- docs-output: <id> -->` and says `run YYYY-MM-DD`. Each command runs on a fresh temporary copy
// of its fixture, with no credential in its environment, its own approvals file, and a preload that
// refuses every socket beyond loopback: nothing is written to the repository and nothing leaves the
// machine. The block is `$ <command>`, what it printed (stdout, then stderr), and `(exit <code>)`.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const GUARD = join(ROOT, "integrations", "claude-code", "hooks", "guard.mjs");
const PRELOAD = join(ROOT, "test", "helpers", "ci-preload.cjs");
const RECORDED = "test/fixtures/audits/gh-aw-q3-recorded";

const pr = (...argv) => ({ program: CLI, argv, display: `pr-rla ${argv.map(quote).join(" ")}` });
const guard = (cmd) => ({ program: GUARD, argv: ["--check-shell", cmd, "--cwd", "."], display: `node integrations/claude-code/hooks/guard.mjs --check-shell ${quote(cmd)} --cwd .` });
function quote(a) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`;
}

/**
 * Every generated block, by id. `copy` lists [from, to] paths (relative to the repository and to the
 * temporary directory) and `cwd` is where the commands run in it; `mask` lists what differs from run
 * to run (the clock), replaced before a block is compared with a fresh run.
 */
export const OUTPUTS = {
  "help": { runs: [pr("--help")] },
  "status-recorded": { copy: [[RECORDED, "audit"]], cwd: "audit", runs: [pr("status", "--offline")] },
  "verify-recorded": { copy: [[RECORDED, "audit"]], cwd: "audit", runs: [pr("verify", "--offline")] },
  "register-dry-run": {
    // The phase-1 demo config, with the protocol it names, at the paths it names it by.
    copy: [["examples/gh-aw-q3", "examples/gh-aw-q3"], ["docs/design/review-protocol.example.md", "docs/design/review-protocol.example.md"]],
    cwd: "examples/gh-aw-q3",
    runs: [pr("register", "--dry-run")],
    // The registration hashes its own registeredAt (now), and R is 24 h after it.
    mask: [/registration [0-9a-f]{12}…/g, /R = \d+ \(drand quicknet\), publishes \S+/g],
  },
  "simulate-tolerance": { runs: [pr("simulate", "--population", "400", "--defects", "40")] },
  "simulate-clean": { runs: [pr("simulate", "--population", "1590", "--defects", "16")] },
  "simulate-small": { runs: [pr("simulate", "--population", "150", "--defects", "15"), pr("simulate", "--population", "150", "--defects", "1")] },
  "draw-by-hand": {
    // A second implementation of the draw formula (node:crypto only), on the recorded audit.
    copy: [[RECORDED, RECORDED], ["scripts/rederive-draws.mjs", "scripts/rederive-draws.mjs"]],
    runs: [{ program: "scripts/rederive-draws.mjs", argv: [RECORDED, "1", "2", "3", "36"], display: `node scripts/rederive-draws.mjs ${RECORDED} 1 2 3 36` }],
  },
  "guard-check": { copy: [[RECORDED, "audit"]], cwd: "audit", runs: [guard("pr-rla record 5 pass"), guard("echo pass >> audit/2026-q3/verdicts.jsonl"), guard("pr-rla status --offline")] },
};

/** The environment every command runs in: no credential, its own approvals file, no network. */
function envFor(tmp) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|_KEY$|^GH_|^GITHUB_|^GITLAB_|^BITBUCKET_|^JIRA_|^PR_RLA_|^PRRLA_|^NODE_OPTIONS$|^npm_/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, TZ: "UTC", NO_COLOR: "1", PR_RLA_APPROVALS_FILE: join(tmp, "approvals.json"), NODE_OPTIONS: `--require ${PRELOAD}`, PRRLA_TEST_DENIED: join(tmp, "denied.txt") };
}

/** Runs one generated block's commands; returns the block's text (no fences). Throws if a command tried the network. */
export function runOutput(id) {
  const spec = OUTPUTS[id];
  if (!spec) throw new Error(`docs-outputs: no output named ${id}`);
  if (!existsSync(CLI)) throw new Error("docs-outputs: dist/cli.js is missing; run npm run build first");
  const tmp = mkdtempSync(join(tmpdir(), "pr-rla-docs-"));
  try {
    for (const [from, to] of spec.copy ?? []) {
      mkdirSync(dirname(join(tmp, to)), { recursive: true });
      cpSync(join(ROOT, from), join(tmp, to), { recursive: true });
    }
    const cwd = join(tmp, spec.cwd ?? ".");
    mkdirSync(cwd, { recursive: true });
    const env = envFor(tmp);
    const parts = [];
    for (const run of spec.runs) {
      const program = isAbsolute(run.program) ? run.program : join(cwd, run.program);
      const r = spawnSync(process.execPath, [program, ...run.argv], { cwd, env, encoding: "utf8", timeout: 120_000 });
      if (r.error) throw r.error;
      const printed = `${r.stdout}${r.stderr}`.replace(/\s+$/, "");
      parts.push([`$ ${run.display}`, ...(printed ? [printed] : []), `(exit ${r.status})`].join("\n"));
    }
    if (existsSync(join(tmp, "denied.txt"))) throw new Error(`docs-outputs: ${id} tried to reach ${readFileSync(join(tmp, "denied.txt"), "utf8").trim()}`);
    const text = parts.join("\n\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
    if (text.includes(tmp) || text.includes(ROOT)) throw new Error(`docs-outputs: ${id} printed a local path`);
    return text;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** What a block's comparison ignores: its masks, and trailing spaces. */
export function masked(id, text) {
  let t = text.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
  for (const re of OUTPUTS[id]?.mask ?? []) t = t.replace(re, "‹varies›");
  return t;
}

const CAPTION_ID = /<!-- docs-output: ([a-z0-9-]+) -->\s*$/;

/** The generated blocks of one Markdown text: `{ id, caption, captionLine, start, end, body }` (0-based line numbers of the fences). */
export function generatedBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})output\s*$/.exec(lines[i]);
    if (!open) continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== open[1]) end++;
    let c = i - 1;
    while (c >= 0 && lines[c].trim() === "") c--;
    const m = c >= 0 ? CAPTION_ID.exec(lines[c]) : null;
    if (m) out.push({ id: m[1], caption: lines[c], captionLine: c, start: i, end, body: lines.slice(i + 1, end).join("\n") });
    i = end;
  }
  return out;
}

/** Rewrites every generated block in `text` whose fresh output differs; returns the new text and what changed. */
export function regenerate(text, { today = new Date().toISOString().slice(0, 10), cache = new Map() } = {}) {
  const lines = text.split("\n");
  const changed = [];
  for (const b of generatedBlocks(text).reverse()) {
    if (!cache.has(b.id)) cache.set(b.id, runOutput(b.id));
    const fresh = cache.get(b.id);
    if (masked(b.id, fresh) === masked(b.id, b.body)) continue;
    lines.splice(b.start + 1, b.end - b.start - 1, ...fresh.split("\n"));
    lines[b.captionLine] = b.caption.replace(/\b([Rr]un) \d{4}-\d{2}-\d{2}\b/, `$1 ${today}`);
    changed.push(b.id);
  }
  return { text: lines.join("\n"), changed: changed.reverse() };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes("--check");
  const files = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
  const cache = new Map();
  let differ = 0;
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), "utf8");
    if (!text.includes("<!-- docs-output: ")) continue;
    const { text: next, changed } = regenerate(text, { cache });
    if (!changed.length) continue;
    differ += changed.length;
    if (check) console.log(`${f}: out of date: ${changed.join(", ")} (run npm run docs:outputs)`);
    else {
      writeFileSync(join(ROOT, f), next);
      console.log(`${f}: regenerated ${changed.join(", ")}`);
    }
  }
  if (!differ) console.log("docs-outputs: every generated block matches a fresh run");
  process.exitCode = check && differ ? 1 : 0;
}
