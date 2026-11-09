// demo-all-tools.test.mjs (the end-to-end round, 2026-11-09): scripts/demo-all-tools.mjs calls every one of the
// server's tools once through the MCP SDK's client, hands one call off as a job and polls job_status, and exits 0
// only if no tool failed and the audit directory's tree hash is unchanged. This runs it on a copy of the
// recorded gh-aw audit and checks it names every tool.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";
import { PKG, copyAudit } from "./helpers.mjs";

it("the all-tools demo calls the eight tools, polls a real job, and leaves the audit directory untouched", () => {
  const dir = copyAudit();
  const r = spawnSync(process.execPath, [join(PKG, "scripts", "demo-all-tools.mjs"), dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const tool of ["audit_list", "status", "draws", "draw_context", "verify", "simulate", "freeze_preview", "job_status"]) assert.match(r.stdout, new RegExp(`^${tool} `, "m"), tool);
  assert.match(r.stdout, /handed off as job verify:/);
  assert.match(r.stdout, /state done · result verdict INCOMPLETE, exitCode 6/);
  assert.match(r.stdout, /\(unchanged\)/);
  assert.match(r.stdout, /write attempts by the servers: 0 .* tool errors: 0/);
});
