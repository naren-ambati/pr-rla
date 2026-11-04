import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../src/beacon/drand.js";
import type { CommandContext } from "../src/commands/context.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import { FIXTURES, recordedBeacon } from "./helpers/fixtures.js";

/**
 * NFR7: v1 records keep verifying. The fixture was written on 2026-11-03 by the
 * phase-2 code (schema v1: Rekor v1 integratedTime as the time evidence, a mock
 * log) before bolt 1 changed any writer. The log's key is trusted only as the
 * verifier's own --log-key (test/fixtures/log-keys/), never from the audit repo.
 */
const LOG_KEY = join(FIXTURES, "log-keys", "v1-retrospective-mock-rekor.pub");
function v1Audit(): { dir: string; out: string[]; ctx: CommandContext } {
  const dir = mkdtempSync(join(tmpdir(), "prrla-v1-"));
  cpSync(join(FIXTURES, "audits", "v1-retrospective-2026-q3"), dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "v1 audit");
  const out: string[] = [];
  const ctx: CommandContext = {
    cwd: dir,
    env: {},
    nowMs: () => Date.parse("2026-11-03T00:00:00Z"),
    fetch: globalThis.fetch,
    out: (l) => out.push(l),
    err: (l) => out.push(`ERR ${l}`),
    beacon: async (round) => {
      if (Date.parse("2026-11-03T00:00:00Z") / 1000 < 1692803367 + 3 * (round - 1)) throw new RoundNotYetPublished(round, 0);
      const b = recordedBeacon(round);
      if (!(await verifyQuicknetBeacon(b, round))) throw new Error("bad beacon");
      return b;
    },
  };
  return { dir, out, ctx };
}

describe("schema v1 compatibility (NFR7)", () => {
  it("the fixture really is v1", () => {
    const reg = JSON.parse(readFileSync(join(FIXTURES, "audits/v1-retrospective-2026-q3/audit/2026-q3/registration.json"), "utf8")) as { record: { schema: string }; timestamps?: unknown };
    expect(reg.record.schema).toBe("pr-rla/registration/v1");
    expect(reg.timestamps).toBeUndefined();
  });

  it("a v1 audit written by phase 2 still verifies 7/7 and prints the v1 summary, with the verifier's --log-key", async () => {
    const a = v1Audit();
    const report = await runVerify(a.ctx, { logKey: LOG_KEY });
    expect(report.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:PASS", "6:PASS", "7:PASS"]);
    expect(report.timestampTamperProof).toBe(true);
    expect(report.timestamps).toEqual({ registration: null, commitment: null });
    expect(await verifyCommand(a.ctx, { logKey: LOG_KEY })).toBe(0);
    expect(a.out.join("\n")).toMatch(/registration after window close → RETROSPECTIVE \(a demonstration\) · manifest logged .* before R ✓ · R = 33,245,812: first round ≥ 24 h after registration ✓ · BLS ✓ · population 200\/200 match ✓ · 36\/36 draws reproduce ✓ · labels/);
    expect(a.out.at(-1)).toBe("VERIFIED");
  });

  it("review finding 3: without --log-key the audit repo's own key (rekor.pub, public_key_file) is not trusted, so the v1 times are unproven", async () => {
    const a = v1Audit();
    const report = await runVerify(a.ctx, {});
    // Checks 1 and 2 WARN; R is still derived from the logged integratedTime (the v1 contract), so check 3 is unchanged.
    expect(report.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:WARN", "2:WARN", "3:PASS", "4:PASS", "5:PASS", "6:PASS", "7:PASS"]);
    expect(report.timestampTamperProof).toBe(false);
    expect(report.derivedRound).toBe(33245812);
    expect(report.checks[0]!.summary).toBe("registration after window close → RETROSPECTIVE (a demonstration) (time unproven: no transparency-log entry verified under a trusted key)");
    expect(report.checks[0]!.details.join("\n")).toMatch(/registration log entry unverified: no trusted key for http:\/\/127\.0\.0\.1:61085 .*--log-key <file>\), so its integratedTime is not evidence/);
    expect(report.checks[1]!.summary).toMatch(/^manifest logged \(unverified\) .* before R$/);
    expect(await verifyCommand(a.ctx, {})).toBe(0);
    expect(a.out.join("\n")).toMatch(/TIMESTAMP NOT TAMPER-PROOF: registration and\/or manifest times are self-asserted \(no transparency-log entry was verified\)/);
  });

  it("status on the v1 audit says TIMESTAMP NOT TAMPER-PROOF: its log key is not pinned in the package", async () => {
    const a = v1Audit();
    expect(await statusCommand(a.ctx, {})).toBe(0);
    expect(a.out[0]).toMatch(/^prefix 36\/36 · fails 0 · claim D .* · CERTIFIED \(risk 5%\) · RETROSPECTIVE · TIMESTAMP NOT TAMPER-PROOF$/);
  });
});
