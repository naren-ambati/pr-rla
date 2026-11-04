import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerCommand } from "../src/commands/register.js";
import type { CommandContext } from "../src/commands/context.js";

/**
 * The prospective gh-aw audit (docs/gh-aw-prospective.md) passes register's preflight once the
 * founder fills in its remaining placeholders (the window and the audit repo; the reviewer login was
 * filled in on 2026-11-03), and refuses, naming the placeholder, until then. Only
 * `register --dry-run` runs here, on a copy: it writes nothing and contacts nothing. The real
 * `register` is the founder's to run.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "audits", "gh-aw-prospective");

function copy(fill: { window?: boolean; repo?: boolean; reviewerPlaceholder?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "prrla-ghaw-"));
  cpSync(SRC, dir, { recursive: true });
  let yml = readFileSync(join(dir, ".pr-rla.yml"), "utf8");
  if (fill.window) yml = yml.replace("start: YYYY-MM-DD", "start: 2026-11-11").replace("end: YYYY-MM-DD", "end: 2026-12-22");
  if (fill.repo) yml = yml.replace("repo: <owner>/<audit-repo>", "repo: founder/gh-aw-audit");
  if (fill.reviewerPlaceholder) yml = yml.replace(`reviewers: ["naren-ambati"]`, `reviewers: ["<founder's GitHub login>"]`);
  writeFileSync(join(dir, ".pr-rla.yml"), yml);
  const out: string[] = [];
  const requests: string[] = [];
  const ctx: CommandContext = {
    cwd: dir,
    env: {},
    nowMs: () => Date.parse("2026-11-10T12:00:00Z"),
    fetch: (async (u: string | URL | Request) => {
      requests.push(String(u));
      // P5: register binds the selector's login to its account id, a read of GitHub's /users. Synthetic answer: the id is
      // copilot-swe-agent's databaseId as recorded in test/fixtures/github/gh-aw-2026-11-02.json.
      if (String(u) === "https://api.github.com/users/copilot-swe-agent%5Bbot%5D") return new Response(JSON.stringify({ login: "copilot-swe-agent[bot]", id: 198982749, type: "Bot" }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("a dry run contacts nothing else");
    }) as typeof fetch,
    out: (l) => out.push(l),
    err: (l) => out.push(`ERR ${l}`),
  };
  return { dir, ctx, out, requests };
}

describe("audits/gh-aw-prospective: register's preflight", () => {
  it("as shipped, refuses at the window placeholder", async () => {
    const c = copy({});
    await expect(registerCommand(c.ctx, { dryRun: true })).rejects.toThrow(/window\.start and window\.end must be YYYY-MM-DD/);
  });

  it("refuses each remaining placeholder by name", async () => {
    await expect(registerCommand(copy({ window: true }).ctx, { dryRun: true })).rejects.toThrow(/ledger github-issues: github-issues: options\.repo must be the audit repo as "owner\/name" \(replace the placeholder\)/);
    // The reviewer login is filled in; a placeholder put back is still refused by name.
    await expect(registerCommand(copy({ window: true, repo: true, reviewerPlaceholder: true }).ctx, { dryRun: true })).rejects.toThrow(/verdicts\.reviewers: replace the placeholder "<founder's GitHub login>" with a login/);
  });

  it("filled in, passes: PROSPECTIVE, github-issues with account provenance and the registered reviewer, the four default authorities, the stratum's login bound to its account id, nothing written and nothing else contacted", async () => {
    const c = copy({ window: true, repo: true });
    expect(await registerCommand(c.ctx, { dryRun: true })).toBe(0);
    const out = c.out.join("\n");
    expect(out).toMatch(/^\[dry run\] registration [0-9a-f]{12}… · github\/gh-aw · window gh-aw-prospective \(2026-11-11\.\.2026-12-22\)/);
    expect(out).toMatch(/provider github \(builtin 0\.1\.0\) · ledger github-issues · verdict provenance account · reviewers naren-ambati/);
    expect(out).toMatch(/PROSPECTIVE/);
    expect(out).toMatch(/timestamps: not requested \(dry run\) · authorities sigstore, digicert, globalsign, microsoft · k = 2/);
    expect(out).toContain("  accounts: copilot-swe-agent[bot] = id 198982749 (signed in: the selector matches them by account id only)");
    expect(c.requests).toEqual(["https://api.github.com/users/copilot-swe-agent%5Bbot%5D"]);
    expect(existsSync(join(c.dir, "audit"))).toBe(false);
    expect(existsSync(join(c.dir, ".pr-rla"))).toBe(false);
  });
});
