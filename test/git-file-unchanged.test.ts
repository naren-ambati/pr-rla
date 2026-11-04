import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { runVerify } from "../src/commands/verify.js";
import type { DrawsFile } from "../src/core/records.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * A phase-1/2 git-file audit that registers no keys verifies exactly as it did before U9 (review
 * finding 11, the U9 fix round): the same check statuses, summaries and check-7 details, clean,
 * with a line not committed yet, and with a rewritten history. This file passes unchanged on the
 * branch's base (a360348, before U9) and after the fix round; only public commands are used.
 */
const W = "audit/2026-q3";
let tsa: MockTsaServer;
let base: Scenario;
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};
const shape = (r: Awaited<ReturnType<typeof runVerify>>) => r.checks.map((c) => ({ n: c.n, status: c.status, summary: c.summary, ...(c.n >= 6 ? { details: c.details } : {}) }));

async function reviewed(opts: { leaveLast?: boolean } = {}): Promise<Scenario> {
  const s = cloneScenario(base);
  at(s, "2026-10-21T03:00:00Z");
  const ds = (JSON.parse(readFileSync(join(s.dir, W, "draws.json"), "utf8")) as DrawsFile).draws.slice(0, 36).filter((d) => d.firstOccurrence);
  for (const [i, d] of ds.entries()) {
    await recordCommand(s.ctx, String(d.draw), "pass", { reviewer: "outside-reviewer" });
    if (!(opts.leaveLast && i === ds.length - 1)) {
      s.git("add", "-A");
      s.git("commit", "-qm", `verdict ${d.draw}`);
    }
  }
  return s;
}

beforeAll(async () => {
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  base = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
  at(base, "2026-10-20T00:00:00Z");
  expect(await registerCommand(base.ctx, {})).toBe(0);
  at(base, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(base.ctx, {})).toBe(0);
  at(base, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(base.ctx, {})).toBe(0);
  base.git("add", "-A");
  base.git("commit", "-qm", "registration, manifest, draws");
}, 120_000);
afterAll(async () => {
  await tsa.stop();
});

describe("finding 11: a git-file audit with no keys verifies as before U9", () => {
  it("clean: 7/7 PASS, check 7 prints only the provenance line", async () => {
    const r = await runVerify((await reviewed()).ctx, {});
    expect(shape(r)).toEqual([
      { n: 1, status: "PASS", summary: expect.any(String) },
      { n: 2, status: "PASS", summary: expect.any(String) },
      { n: 3, status: "PASS", summary: expect.any(String) },
      { n: 4, status: "PASS", summary: expect.any(String) },
      { n: 5, status: "PASS", summary: "population 200/200 match" },
      { n: 6, status: "PASS", summary: "36/36 draws reproduce", details: [] },
      { n: 7, status: "PASS", summary: "labels (prefix 36, 35 events)", details: ["VERDICT PROVENANCE: self-asserted (35) (registered minimum: self-asserted)"] },
    ]);
  });

  it("a line not committed yet is noted, as before", async () => {
    const r = await runVerify((await reviewed({ leaveLast: true })).ctx, {});
    expect(r.checks.find((c) => c.n === 7)).toMatchObject({ status: "PASS", details: ["VERDICT PROVENANCE: self-asserted (35) (registered minimum: self-asserted)", "1 verdict line(s) not yet committed (no tamper trail for them until committed)"] });
  });

  it("a rewritten history FAILs check 7 with the same finding", async () => {
    const s = await reviewed();
    const p = join(s.dir, W, "verdicts.jsonl");
    writeFileSync(p, readFileSync(p, "utf8").split("\n").slice(1).join("\n"));
    s.git("commit", "-qam", "drop a verdict");
    const c7 = (await runVerify(s.ctx, {})).checks.find((c) => c.n === 7)!;
    expect(c7.status).toBe("FAIL");
    expect(c7.summary).toBe("labels FAIL");
    expect(c7.details).toEqual(["VERDICT PROVENANCE: none counted (registered minimum: self-asserted)", `audit/2026-q3/verdicts.jsonl was rewritten (not appended) in commit ${s.git("rev-parse", "HEAD").trim().slice(0, 10)}`]);
  });
});
