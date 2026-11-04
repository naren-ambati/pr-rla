// The bolt 7 (U7) demo (delivery-plan.md): the GitHub Action's steps on a fixture ESCALATE audit fail the
// job; on a CERTIFIED one they pass. Offline and local: the fixture is the recorded gh-aw Q3 audit
// (test/fixtures/audits/gh-aw-q3-recorded, git-file ledger) with synthetic verdicts written by
// `pr-rla record`, and the steps are integrations/github-action/scripts/*, run with bash exactly as the
// runner would, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY on temporary files. The test suite does the same
// through test/helpers/ci-harness.ts, which also reads action.yml and evaluates its expressions.
//   npm run build && node scripts/demo-ci.mjs
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const base = mkdtempSync(join(tmpdir(), "prrla-ci-demo-"));
const run = (cmd, args, opts) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

/** An action path as `npm ci` would leave it: the action's files and a pr-rla on node_modules/.bin. */
const actionPath = join(base, "action");
cpSync(join(root, "integrations", "github-action"), actionPath, { recursive: true, filter: (s) => !/node_modules|vendor/.test(s) });
mkdirSync(join(actionPath, "node_modules", ".bin"), { recursive: true });
writeFileSync(join(actionPath, "node_modules", ".bin", "pr-rla"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
chmodSync(join(actionPath, "node_modules", ".bin", "pr-rla"), 0o755);

function audit(name, verdict, n) {
  const dir = join(base, name);
  cpSync(join(root, "test", "fixtures", "audits", "gh-aw-q3-recorded"), dir, { recursive: true });
  for (let i = 1; i <= n; i++) run(process.execPath, [cli, "-C", dir, "record", String(i), verdict, "--reviewer", "demo-reviewer"]);
  return dir;
}

function job(name, workspace) {
  const temp = mkdtempSync(join(base, "runner-temp-"));
  const summary = join(temp, "summary.md");
  const out = join(temp, "output");
  writeFileSync(summary, "");
  writeFileSync(out, "");
  const env = { PATH: process.env.PATH, HOME: temp, ACTION_PATH: actionPath, RUNNER_TEMP: temp, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, PR_RLA_APPROVALS_FILE: join(temp, "pr-rla-approvals.json"), INPUT_COMMAND: "status", INPUT_DIR: ".", INPUT_OFFLINE: "true", INPUT_COMMENT: "false", INPUT_COMMENT_ISSUE: "", INPUT_FAIL_ON: "escalate,refusal,timestamps,incomplete", INPUT_PLUGINS: "builtin-only", INPUT_APPROVE_ORIGINS: "", INPUT_ACCEPT_LOCK_GRANTS: "false", INPUT_ALLOW_WRITES: "false" };
  console.log(`\n== ${name} ==`);
  for (const step of ["prepare.sh", "run.sh"]) {
    const r = run("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", join(actionPath, "scripts", step)], { cwd: workspace, env });
    process.stdout.write(r.stdout.split("\n").filter(Boolean).map((l) => `  [${step}] ${l}`).join("\n") + "\n");
    if (r.status !== 0) return console.log(`  step ${step} failed (${r.status})`);
  }
  const outputs = Object.fromEntries(readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  console.log(`  outputs: state=${outputs.state} prefix=${outputs.prefix} llr=${outputs.llr} exit-code=${outputs["exit-code"]}`);
  console.log("  job summary:");
  console.log(readFileSync(summary, "utf8").split("\n").map((l) => `    ${l}`).join("\n"));
  if (outputs.result === "fail") console.log(`  [decide] ::error title=pr-rla::${outputs.reason}\n  JOB RESULT: FAILED`);
  else console.log("  JOB RESULT: passed");
}

job("fixture ESCALATE (6 fails of 6 labelled draws)", audit("escalate", "fail", 6));
job("fixture CERTIFIED (36 passes)", audit("certified", "pass", 36));
