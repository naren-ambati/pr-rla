import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../src/beacon/drand.js";
import { configFor, readCommitment, readDraws, readManifest, readRegistration } from "../src/api/session.js";
import { statusCore } from "../src/api/read/offline-core.js";
import { buildProgram } from "../src/cli.js";
import type { CommandContext } from "../src/commands/context.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCheckpointExitCode, statusCommand } from "../src/commands/status.js";
import { OFFLINE_CORE_CHECKS } from "../src/core/verify-core.js";
import { makeChanges, setupAuditRepo, T } from "./helpers/audit-scenario.js";
import { FIXTURES, recordedBeacon } from "./helpers/fixtures.js";

/** P5 findings 9 and 11 (synthetic json-file audits; the v1 fixture of NFR7 for the log key), and finding 6's plug-in point. */

describe("finding 9: status of a frozen audit below the registered minimum reports the refusal, exit 3 (as sample does)", () => {
  async function frozen(n: number) {
    const s = setupAuditRepo({ changes: makeChanges(n) });
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-21T01:00:00Z");
    s.out.length = 0;
    return s;
  }
  it("N 100 < 150: text and --json say REFUSED and exit 3, the same as sample; no 'run pr-rla sample'", async () => {
    const s = await frozen(100);
    expect(await statusCommand(s.ctx, {})).toBe(3);
    expect(s.out[0]).toMatch(/^RETROSPECTIVE · frozen N 100 · REFUSED: population 100 < the registered minimum 150: review all 100 instead \(sample draws nothing\)/);
    expect(s.out.join("\n")).not.toContain('run "pr-rla sample"');
    s.out.length = 0;
    expect(await statusCommand(s.ctx, { json: true })).toBe(3);
    expect(JSON.parse(s.out.join("\n"))).toMatchObject({ phase: "frozen", N: 100, refusal: expect.stringMatching(/^REFUSED: population 100 < the registered minimum 150/) });
    s.out.length = 0;
    expect(await sampleCommand(s.ctx, {})).toBe(3);
  });
  it("N 200: frozen, no refusal, exit 0, and the line asks for sample", async () => {
    const s = await frozen(200);
    expect(await statusCommand(s.ctx, {})).toBe(0);
    expect(s.out[0]).toContain('run "pr-rla sample"');
    s.out.length = 0;
    expect(await statusCommand(s.ctx, { json: true })).toBe(0);
    expect(JSON.parse(s.out.join("\n"))).toMatchObject({ phase: "frozen", refusal: null });
  });
});

describe("finding 11: status --checkpoint precedence, the help, and status --log-key", () => {
  it("a FAIL (1) first, then the checkpoint's 4 or 5, then status's 2, 3 or 6, else the checkpoint's: status's 6 no longer hides the checkpoint's 5", () => {
    const table: [number, number, number][] = [
      [1, 0, 1],
      [0, 1, 1],
      [6, 5, 5],
      [6, 4, 4],
      [2, 5, 5],
      [6, 0, 6],
      [2, 0, 2],
      [3, 0, 3],
      [0, 0, 0],
      [0, 5, 5],
      [1, 5, 1],
    ];
    for (const [st, cp, want] of table) expect(statusCheckpointExitCode(st, cp), `status ${st}, checkpoint ${cp}`).toBe(want);
  });
  it("status --help lists exit 1 for a FAILED withholding and exit 6 for unread verdicts, the precedence, --log-key and --registration", async () => {
    let help = "";
    const program = buildProgram(() => setupAuditRepo({ changes: [] }).ctx, () => {});
    const status = program.commands.find((c) => c.name() === "status")!;
    status.configureOutput({ writeOut: (t) => (help += t) });
    status.outputHelp();
    expect(help).toMatch(/1 not registered, or a check verify would FAIL on these records \(a FAILED withholding/);
    expect(help).toMatch(/6 the certificate is withheld as not established .* or the verdicts were read without the ledger's credential and refused/);
    expect(help).toContain("With --checkpoint: a FAIL (1) first, then the checkpoint's 4 or 5, then status's 2, 3 or 6, else the checkpoint's");
    expect(help).toContain("--log-key <url=pem>");
    expect(help).toContain("--registration <sha256>");
  });

  const LOG_KEY = join(FIXTURES, "log-keys", "v1-retrospective-mock-rekor.pub");
  function v1Audit() {
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
  it("a v1 audit's log entry proves its time under the key you give status, as verify's --log-key; the certificate stays withheld for check 6 (legacy schema), exit 6", async () => {
    const a = v1Audit();
    expect(await statusCommand(a.ctx, {})).toBe(6);
    expect(a.out[0]).toContain("registration time unproven: no transparency-log entry verified under a pinned key");
    a.out.length = 0;
    expect(await statusCommand(a.ctx, { logKey: [`http://127.0.0.1:61085=${LOG_KEY}`] })).toBe(6);
    expect(a.out[0]).not.toContain("time unproven");
    expect(a.out[0]).not.toContain("TIMESTAMP NOT TAMPER-PROOF");
    expect(a.out[0]).toContain("verify check 6 (draws) is not established: legacy schema: draws bound to the manifest");
  });
  it("a malformed --log-key is a usage error, as verify's", async () => {
    const a = v1Audit();
    await expect(statusCommand(a.ctx, { logKey: ["not-a-pair"] })).rejects.toThrow(/log-key/i);
  });
});

describe("finding 6: the offline core takes further checks as gates (P1's check-7 local gate plugs in here)", () => {
  it("a gate's fails become FAILED withholdings and its incompletes INCOMPLETE ones, beside the core's own", async () => {
    const s = setupAuditRepo({ changes: makeChanges(200) });
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    const { config, paths } = configFor(s.ctx);
    const records = { registration: readRegistration(paths), manifest: readManifest(paths), commitment: readCommitment(paths), draws: readDraws(paths) };
    expect(OFFLINE_CORE_CHECKS).toEqual([1, 2, 3, 4, 6]);
    const none = await statusCore(s.ctx, config, records, {});
    expect(none.checks.map((c) => c.n)).toEqual([1, 2, 3, 4, 6]);
    expect(none.withholdings.filter((w) => w.verdict === "FAILED")).toEqual([]);
    const gated = await statusCore(s.ctx, config, records, {}, [{ n: 7, name: "labels", run: async () => ({ fails: ["a committed line was removed"], incompletes: ["the tracker was not read"] }) }]);
    expect(gated.withholdings).toEqual([...none.withholdings, { verdict: "FAILED", reason: "verify check 7 (labels) would FAIL: a committed line was removed" }, { verdict: "INCOMPLETE", reason: "verify check 7 (labels) is not established: the tracker was not read" }]);
  });
});
