import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import type { CommandContext } from "../src/commands/context.js";
import { fixturePath } from "./helpers/fixtures.js";

/**
 * The CLI contract U5 owns (contracts.md §7): exit codes, `--json` errors in the documented form
 * (NFR16, NFR17), and atomic writes for every file the write API makes (NFR15).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function ctxIn(dir: string): CommandContext & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cwd: dir,
    env: {},
    nowMs: () => Date.parse("2026-11-04T00:00:00Z"),
    fetch: (async () => {
      throw new Error("no network");
    }) as typeof fetch,
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    stdout,
    stderr,
  };
}
async function cli(ctx: CommandContext, ...argv: string[]): Promise<number> {
  let code = -1;
  await buildProgram(() => ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", ...argv]);
  return code;
}
function recorded(): string {
  const dir = mkdtempSync(join(tmpdir(), "prrla-cli-"));
  cpSync(fixturePath("audits", "gh-aw-q3-recorded"), dir, { recursive: true });
  return dir;
}

describe("errors: a plain sentence and the next step on stderr; with --json, the error object on stdout (NFR17)", () => {
  it("draw-context past the issued draws: exit 1, DRAW_OUT_OF_RANGE, the next step", async () => {
    const plain = ctxIn(recorded());
    expect(await cli(plain, "draw-context", "99")).toBe(1);
    expect(plain.stdout).toEqual([]);
    expect(plain.stderr).toEqual(["pr-rla: draw #99 is not issued: the issued draws are #1 to #36", '  next: "pr-rla sample --through <n>" issues more (a human\'s command)']);
    const json = ctxIn(recorded());
    expect(await cli(json, "draw-context", "99", "--json")).toBe(1);
    expect(json.stderr).toEqual([]);
    expect(JSON.parse(json.stdout.join("\n"))).toEqual({ error: { code: "DRAW_OUT_OF_RANGE", message: "draw #99 is not issued: the issued draws are #1 to #36", next: '"pr-rla sample --through <n>" issues more (a human\'s command)' } });
  });

  it("status --json with no audit: NO_AUDIT; verify --json on an unregistered window: NO_AUDIT; exit 1", async () => {
    const empty = ctxIn(mkdtempSync(join(tmpdir(), "prrla-none-")));
    expect(await cli(empty, "status", "--json")).toBe(1);
    expect(JSON.parse(empty.stdout.join("\n")).error).toMatchObject({ code: "NO_AUDIT", message: expect.stringMatching(/^no \.pr-rla\.yml at /) });
    const dir = recorded();
    writeFileSync(join(dir, ".pr-rla.yml"), readFileSync(join(dir, ".pr-rla.yml"), "utf8").replace("name: 2026-q3", "name: 2026-q4"));
    const c = ctxIn(dir);
    expect(await cli(c, "verify", "--offline", "--json")).toBe(1);
    expect(JSON.parse(c.stdout.join("\n")).error).toMatchObject({ code: "NO_AUDIT", message: expect.stringMatching(/^registration not found at /) });
  });

  it("a provider that cannot be reached: exit 1, and the JSON error carries the broker's message", async () => {
    const dir = recorded();
    writeFileSync(join(dir, ".pr-rla.yml"), readFileSync(join(dir, ".pr-rla.yml"), "utf8").replace(/^provider: .*$/m, "provider: github"));
    const c = { ...ctxIn(dir), sleep: async () => {} };
    expect(await cli(c, "draw-context", "7", "--json")).toBe(1);
    const e = JSON.parse(c.stdout.join("\n")).error;
    expect(e).toMatchObject({ code: "FAILED", message: expect.stringMatching(/^GitHub GET \/repos\/github\/gh-aw\/pulls\/42597: gave up after 7 attempts \(no network\)$/) });
  });

  it("draw-context: exit 0 with the context, 1 on a refusal; record, sample and the other writers keep their codes", async () => {
    const c = ctxIn(recorded());
    expect(await cli(c, "draw-context", "1")).toBe(0);
    expect(c.stdout.join("\n")).toMatch(/^pr-rla draw-context · window 2026-q3 · draw #1 of 36 issued/);
    expect(await cli(ctxIn(recorded()), "draw-context", "zero")).toBe(1);
    expect(await cli(ctxIn(recorded()), "draw-context", "1", "--max-patch-bytes", "2000000")).toBe(1);
  });
});

describe("atomic writes (NFR15): a write killed part-way leaves the previous file whole", () => {
  it("SIGKILL during writeFileAtomic of a large record: the file is always the old one or the new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-kill-"));
    const target = join(dir, "manifest.json");
    const old = JSON.stringify({ version: "old", pad: "o".repeat(1000) });
    writeFileSync(target, old);
    const child = `
      import { writeFileAtomic } from ${JSON.stringify(join(ROOT, "src", "io", "atomic.ts"))};
      const big = JSON.stringify({ version: "new", pad: "n".repeat(8 * 1024 * 1024) });
      process.stdout.write("ready\\n");
      for (;;) writeFileAtomic(${JSON.stringify(target)}, big);
    `;
    for (const delayMs of [10, 25, 40, 70, 100, 150]) {
      const p = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", child], { stdio: ["ignore", "pipe", "inherit"] });
      await new Promise<void>((r) => p.stdout!.once("data", () => r()));
      await new Promise((r) => setTimeout(r, delayMs));
      p.kill("SIGKILL");
      await new Promise((r) => p.once("exit", r));
      const v = JSON.parse(readFileSync(target, "utf8")) as { version: string; pad: string };
      expect(["old", "new"]).toContain(v.version);
      expect(v.pad.length).toBe(v.version === "old" ? 1000 : 8 * 1024 * 1024);
    }
    // At least one kill landed part-way through a write (its temporary is left beside the file, never in its place).
    expect(readdirSync(dir).filter((f) => !f.endsWith(".tmp"))).toEqual(["manifest.json"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length).toBeGreaterThan(0);
  }, 60_000);

  it("init writes .pr-rla.yml, the protocol, audit/ and .gitignore through the atomic writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-init-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/");
    const c = ctxIn(dir);
    expect(await cli(c, "init", "--repo", "acme/widgets")).toBe(0);
    for (const f of [".pr-rla.yml", "review-protocol.md", "audit/.gitkeep"]) expect(existsSync(join(dir, f))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n# pr-rla signing key (never commit)\n.pr-rla/\n");
    expect(readFileSync(join(dir, ".pr-rla.yml"), "utf8")).toMatch(/^# pr-rla configuration/);
    expect(await cli(ctxIn(dir), "init")).toBe(1);
  });
});
