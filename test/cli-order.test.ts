import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import type { DrawsFile } from "../src/core/records.js";
import { makeChanges, setupAuditRepo, T } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";

/**
 * Output order on the error paths the refactor moved (U5 review: "error-path output order"): a
 * command prints what it printed before U5, in the same order, even when the step after fails. The
 * failing steps are made to fail here: register's reading of the provider's traits, and a
 * checkpoint's assessment of its timestamps (both after their first lines on master).
 */

const fail = { traits: false, assess: false };
vi.mock("../src/provider-traits.js", async (orig) => {
  const m = (await orig()) as typeof import("../src/provider-traits.js");
  return { ...m, providerTraits: async (...a: Parameters<typeof m.providerTraits>) => (fail.traits ? Promise.reject(new Error("traits unreadable")) : m.providerTraits(...a)) };
});
vi.mock("../src/api/timestamps.js", async (orig) => {
  const m = (await orig()) as typeof import("../src/api/timestamps.js");
  return { ...m, assessRecord: async (...a: Parameters<typeof m.assessRecord>) => (fail.assess ? Promise.reject(new Error("assessment failed")) : m.assessRecord(...a)) };
});

async function cli(s: ReturnType<typeof setupAuditRepo>, ...argv: string[]): Promise<number> {
  let code = -1;
  await buildProgram(() => s.ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", ...argv]);
  return code;
}

describe("error paths print what they printed before, first", () => {
  it("register: the registration's first three lines come out before the provider's traits are read, and fail", async () => {
    const s = setupAuditRepo({ changes: makeChanges(160) });
    // direct_push_via_merge: exclude makes register read the provider's traits.
    const cfg = join(s.dir, ".pr-rla.yml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("unreviewed: no-human-review }", "unreviewed: no-human-review, direct_push_via_merge: exclude }"));
    s.clock.now = T("2026-10-20T00:00:00Z");
    fail.traits = true;
    try {
      expect(await cli(s, "register", "--dry-run")).toBe(1);
    } finally {
      fail.traits = false;
    }
    const lines = s.out.filter((l) => !l.startsWith("ERR "));
    expect(lines[0]).toMatch(/^\[dry run\] registration [0-9a-f]{12}… · acme\/widgets · window 2026-q3/);
    expect(lines[1]).toMatch(/^ {2}claim D: /);
    expect(lines[2]).toMatch(/^ {2}selector /);
    expect(lines).toHaveLength(3);
    expect(s.out.join("\n")).toMatch(/traits unreadable/);
  });

  it("checkpoint: the two lines naming the files it wrote come out before its timestamps are assessed, and that fails", async () => {
    const fake = new FakeGitHubIssues();
    const s = setupAuditRepo({ changes: makeChanges(400), fetch: fake.fetch.bind(fake) as typeof fetch });
    appendFileSync(join(s.dir, ".pr-rla.yml"), "ledger: { use: github-issues, options: { repo: acme/audit } }\n");
    s.git("commit", "-qam", "ledger");
    s.ctx.env = { GITHUB_TOKEN: "test-token" };
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    const draws = JSON.parse(readFileSync(join(s.dir, "audit", "2026-q3", "draws.json"), "utf8")) as DrawsFile;
    fake.setTime("2026-10-21T02:00:00Z");
    fake.label(fake.issueByDraw(draws.draws[0]!.draw).number, "pr-rla:pass", { login: "alice", id: 11, type: "User" });
    s.clock.now = T("2026-10-21T03:00:00Z");
    s.out.length = 0;
    fail.assess = true;
    try {
      expect(await cli(s, "checkpoint")).toBe(1);
    } finally {
      fail.assess = false;
    }
    const lines = s.out.filter((l) => !l.startsWith("ERR "));
    expect(lines[0]).toMatch(/^checkpoint 2026-10-21T03:00:00Z · ledger github-issues · \d+ event\(s\)/);
    expect(lines[1]).toMatch(/^ {2}appended to audit\/2026-q3\/ledger-checkpoints\.jsonl · event list audit\/2026-q3\/ledger-history\//);
    expect(s.out.join("\n")).toMatch(/assessment failed/);
  }, 120_000);
});
