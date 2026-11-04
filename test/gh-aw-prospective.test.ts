import { describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerCommand } from "../src/commands/register.js";
import type { CommandContext } from "../src/commands/context.js";

/**
 * The prospective gh-aw audit (docs/gh-aw-prospective.md) passes register's preflight once the
 * founder fills in its four placeholders, and refuses, naming the placeholder, until then. Only
 * `register --dry-run` runs here, on a copy: it writes nothing and contacts nothing. The real
 * `register` is the founder's to run.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "audits", "gh-aw-prospective");

function copy(fill: { window?: boolean; repo?: boolean; reviewer?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "prrla-ghaw-"));
  cpSync(SRC, dir, { recursive: true });
  let yml = readFileSync(join(dir, ".pr-rla.yml"), "utf8");
  if (fill.window) yml = yml.replace("start: YYYY-MM-DD", "start: 2026-11-11").replace("end: YYYY-MM-DD", "end: 2026-12-22");
  if (fill.repo) yml = yml.replace("repo: <owner>/<audit-repo>", "repo: founder/gh-aw-audit");
  if (fill.reviewer) yml = yml.replace(`reviewers: ["<founder's GitHub login>"]`, `reviewers: ["founder-login"]`);
  writeFileSync(join(dir, ".pr-rla.yml"), yml);
  const out: string[] = [];
  const requests: string[] = [];
  const ctx: CommandContext = {
    cwd: dir,
    env: {},
    nowMs: () => Date.parse("2026-11-10T12:00:00Z"),
    fetch: (async (u: string | URL | Request) => {
      requests.push(String(u));
      throw new Error("a dry run contacts nothing");
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
    await expect(registerCommand(copy({ window: true, repo: true }).ctx, { dryRun: true })).rejects.toThrow(/verdicts\.reviewers: replace the placeholder "<founder's GitHub login>" with a login/);
    await expect(registerCommand(copy({ window: true, reviewer: true }).ctx, { dryRun: true })).rejects.toThrow(/ledger github-issues: github-issues: options\.repo must be the audit repo as "owner\/name" \(replace the placeholder\)/);
  });

  it("filled in, passes: PROSPECTIVE, github-issues with account provenance and the registered reviewer, the four default authorities, nothing written or contacted", async () => {
    const c = copy({ window: true, repo: true, reviewer: true });
    expect(await registerCommand(c.ctx, { dryRun: true })).toBe(0);
    const out = c.out.join("\n");
    expect(out).toMatch(/^\[dry run\] registration [0-9a-f]{12}… · github\/gh-aw · window gh-aw-prospective \(2026-11-11\.\.2026-12-22\)/);
    expect(out).toMatch(/provider github \(builtin 0\.1\.0\) · ledger github-issues · verdict provenance account · reviewers founder-login/);
    expect(out).toMatch(/PROSPECTIVE/);
    expect(out).toMatch(/timestamps: not requested \(dry run\) · authorities sigstore, digicert, globalsign, microsoft · k = 2/);
    expect(c.requests).toEqual([]);
    expect(existsSync(join(c.dir, "audit"))).toBe(false);
    expect(existsSync(join(c.dir, ".pr-rla"))).toBe(false);
  });
});
