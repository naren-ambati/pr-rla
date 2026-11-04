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
/** The fixture's mock log, as `verify --log-key <log url>=<pem file>` names it (time round B: keys are scoped to their log). */
const LOG_KEY_ARG = [`http://127.0.0.1:61085=${LOG_KEY}`];
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
    const report = await runVerify(a.ctx, { logKey: LOG_KEY_ARG });
    expect(report.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:PASS", "6:PASS", "7:PASS"]);
    expect(report.timestampTamperProof).toBe(true);
    expect(report.timestamps).toEqual({ registration: null, commitment: null });
    expect(await verifyCommand(a.ctx, { logKey: LOG_KEY_ARG })).toBe(0);
    expect(a.out.join("\n")).toMatch(/registration after window close → RETROSPECTIVE \(a demonstration\) · manifest logged .* before R ✓ · R = 33,245,812: first round ≥ 24 h after registration ✓ · BLS ✓ · population 200\/200 match ✓ · 36\/36 draws reproduce ✓ · labels/);
    expect(a.out.at(-1)).toBe("VERIFIED");
  });

  it("review finding 3 and pass-2 review #2: without --log-key the audit repo's own key is not trusted, the v1 times are unproven, and so is R: INCOMPLETE, never VERIFIED", async () => {
    const a = v1Audit();
    const report = await runVerify(a.ctx, {});
    // R is still derived from the logged integratedTime (the v1 contract, so every verifier computes the same R), but
    // that time is in the unsigned envelope and nothing vouches for it: check 3 is INCOMPLETE, not PASS (it was PASS,
    // and checks 1 and 2 WARNed, before time round B).
    expect(report.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:INCOMPLETE", "2:INCOMPLETE", "3:INCOMPLETE", "4:PASS", "5:PASS", "6:PASS", "7:PASS"]);
    expect(report.verdict).toBe("INCOMPLETE");
    expect(report.ok).toBe(false);
    expect(report.timestampTamperProof).toBe(false);
    expect(report.derivedRound).toBe(33245812);
    expect(report.checks[0]!.summary).toBe("registration after window close → RETROSPECTIVE (a demonstration) (time unproven: no transparency-log entry verified under a trusted key)");
    expect(report.checks[0]!.details.join("\n")).toMatch(/registration log entry unverified: no trusted key for http:\/\/127\.0\.0\.1:61085 .*--log-key <log url>=<pem file>\), so its integratedTime is not evidence/);
    expect(report.checks[1]!.summary).toMatch(/^manifest logged \(unverified\) .*: not shown to precede R$/);
    expect(report.checks[2]!.summary).toBe("R = 33,245,812: first round ≥ 24 h after registration, but the registration time it rests on is unproven");
    expect(report.checks[2]!.details.join("\n")).toMatch(/^INCOMPLETE R is derived from the registration time 2026-10-20T00:00:00Z, which no trusted evidence bounds \(no transparency-log entry verified under a trusted key\): it could have been written after round 33,245,812 was public, to choose R$/);
    expect(report.certificate).toMatchObject({ state: "WITHHELD" });
    expect(report.statusLine).not.toMatch(/CERTIFIED \(/);
    expect(await verifyCommand(a.ctx, {})).toBe(6);
    expect(a.out.join("\n")).toMatch(/TIMESTAMP NOT TAMPER-PROOF: registration and\/or manifest times are self-asserted \(no transparency-log entry was verified\)/);
    expect(a.out.join("\n")).toMatch(/· target reached · CERTIFICATE WITHHELD \(verify check 1 \(registration\) incomplete; verify check 2 \(manifest before seed\) incomplete; verify check 3 \(seed round\) incomplete\) · RETROSPECTIVE/);
  });

  it("status on the v1 audit: TIMESTAMP NOT TAMPER-PROOF (its log key is not pinned in the package), so the certificate is withheld, exit 6", async () => {
    const a = v1Audit();
    expect(await statusCommand(a.ctx, {})).toBe(6);
    expect(a.out[0]).toMatch(/^prefix 36\/36 · fails 0 · claim D .* · target reached · CERTIFICATE WITHHELD \(registration time unproven: no transparency-log entry verified under a pinned key; manifest commitment time unproven: no transparency-log entry verified under a pinned key\) · RETROSPECTIVE · TIMESTAMP NOT TAMPER-PROOF$/);
    expect(a.out.join("\n")).not.toMatch(/CERTIFIED \(risk/);
  });
});
