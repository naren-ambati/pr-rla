import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

/** The recorded audit in a fresh git repository (git-file's tamper trail), as the review's differential ran it. */
function recordedRepo(): string {
  const dir = recorded();
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", ...a], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "recorded");
  return dir;
}

describe("the writers keep master's exit codes (the review's differential flows, on the recorded audit)", () => {
  it("sample, record, status --checkpoint, checkpoint and verify (flow 2)", async () => {
    const dir = recordedRepo();
    const beacon = fixturePath("drand", "quicknet-33245812.json");
    const steps: [string[], number][] = [
      [["sample", "--beacon-file", beacon], 0],
      [["sample", "--beacon-file", beacon, "--through", "40"], 0],
      [["record", "1", "pass", "--reviewer", "alice", "--note", "ok"], 0],
      [["record", "1", "fail", "--reviewer", "bob"], 1],
      [["record", "999", "pass", "--reviewer", "x"], 1],
      [["record", "2", "maybe", "--reviewer", "x"], 1],
      [["record", "2", "pass"], 1],
      [["status"], 0],
      [["status", "--checkpoint"], 1],
      [["checkpoint"], 1],
      [["checkpoint", "--push"], 1],
      // A git-file ledger never committed beside a committed registration has no tamper trail at
      // its path: verify check 7 FAILs until the ledger file is committed (fix/p4-ledger-path).
      [["verify", "--offline"], 1],
    ];
    for (const [argv, code] of steps) expect(await cli(ctxIn(dir), ...argv), argv.join(" ")).toBe(code);
    // The honest next step "record" prints ("commit the ledger file now"); then verify passes.
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", ...a], { cwd: dir, stdio: "ignore" });
    git("add", "audit/2026-q3/verdicts.jsonl");
    git("commit", "-qm", "verdicts");
    expect(await cli(ctxIn(dir), "verify", "--offline"), "verify --offline after committing the ledger").toBe(0);
  });

  it("init, status, verify, freeze --dry-run, register --dry-run, plugin and simulate on an empty directory (flow 3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-flow3-"));
    const steps: [string[], number][] = [
      [["init", "--repo", "acme/w"], 0],
      [["init"], 1],
      [["init", "--force", "--provider", "gitlab"], 0],
      [["status"], 1],
      [["verify", "--offline"], 1],
      [["register", "--dry-run"], 0],
      [["plugin", "check", "./nope.mjs"], 1],
      [["plugin", "add", "./nope.mjs"], 1],
      [["plugin", "lock", "github"], 1],
      [["simulate", "--population", "10", "--defects", "1", "--runs", "3", "--p0", "0.2"], 0],
    ];
    for (const [argv, code] of steps) expect(await cli(ctxIn(dir), ...argv), argv.join(" ")).toBe(code);
  });
});

describe("--json: stdout carries exactly one JSON document, always (contracts.md §7; M5)", () => {
  const one = (c: { stdout: string[] }) => {
    const text = c.stdout.join("\n");
    expect(() => JSON.parse(text), text.slice(0, 200)).not.toThrow();
    return JSON.parse(text) as Record<string, unknown>;
  };

  it("status --json --checkpoint with a ledger that cannot be checkpointed: the status, its checkpoint's error folded in, exit 1", async () => {
    const c = ctxIn(recordedRepo());
    expect(await cli(c, "status", "--json", "--checkpoint")).toBe(1);
    const doc = one(c);
    expect(doc).toMatchObject({ phase: "sampled", checkpoint: { error: { code: "FAILED", message: expect.stringMatching(/has no readHistory, so it cannot be checkpointed/) } } });
  });

  it("freeze --dry-run --json --out: the JSON on stdout, the note about the file on stderr", async () => {
    const dir = recorded();
    const c = ctxIn(dir);
    expect(await cli(c, "freeze", "--dry-run", "--json", "--out", "l.json")).toBe(0);
    expect(one(c)).toMatchObject({ dryRun: true, N: 1589 });
    expect(c.stderr).toContain("wrote the dry-run population to l.json");
    expect(existsSync(join(dir, "l.json"))).toBe(true);
  });

  it("freeze --json --submit --rekor-api v2 --yes: the v2 warning goes to stderr, stdout stays one document", async () => {
    const dir = recordedRepo();
    const c = ctxIn(dir);
    expect(await cli(c, "register", "--force")).toBe(0);
    const j = ctxIn(dir);
    await cli(j, "freeze", "--force", "--json", "--submit", "--rekor-url", "https://rekor.invalid", "--rekor-api", "v2", "--yes");
    one(j);
    expect(j.stderr.join("\n")).toMatch(/Rekor v2/);
    expect(j.stdout.join("\n")).not.toMatch(/WARNING|Rekor v2 is/);
  });

  it("log is null, not missing, when nothing was submitted (freeze --json)", async () => {
    const dir = recordedRepo();
    expect(await cli(ctxIn(dir), "register", "--force")).toBe(0);
    const j = ctxIn(dir);
    expect(await cli(j, "freeze", "--force", "--json")).toBe(0);
    const doc = one(j);
    expect(Object.hasOwn(doc, "log")).toBe(true);
    expect(doc.log).toBeNull();
  });
});

describe("the refactor's regressions, fixed", () => {
  it("init works under an invalid PR_RLA_PLUGINS, as it did before the refactor; plugin add checks its config first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-init-env-"));
    const c = { ...ctxIn(dir), env: { PR_RLA_PLUGINS: "nonsense" } };
    expect(await cli(c, "init", "--repo", "acme/w")).toBe(0);
    expect(existsSync(join(dir, ".pr-rla.yml"))).toBe(true);
    const add = { ...ctxIn(dir), env: { PR_RLA_PLUGINS: "nonsense" } };
    expect(await cli(add, "plugin", "add", "./nope.mjs")).toBe(1);
    expect(add.stderr[0]).toMatch(/\.\/nope\.mjs is not the provider or the ledger in/);
  });

  it("plugin check prints as it goes: a missing fixture still leaves the report so far, then the error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-check-"));
    writeFileSync(join(dir, "p.mjs"), 'export default { providerApiVersion: 1, name: "p", create() { return { apiVersion: 1, name: "p", async listChanges() { return { changes: [], defaultBranch: "main", limitations: [] }; } }; } };\n');
    const c = ctxIn(dir);
    expect(await cli(c, "plugin", "check", "./p.mjs", "--offline", "--fixture", "missing.json")).toBe(1);
    const out = c.stdout.join("\n");
    for (const s of ["plugin check ./p.mjs: provider p", "  lock            not locked", "  npm signatures  not applicable", "  hosts           none", "  credentials     none", "  conformance     the provider kit through the plugin host, on 1 recorded fixture(s)"]) expect(out).toContain(s);
    expect(c.stderr.join("\n")).toMatch(/missing\.json/);
  }, 60_000);

  it("init writes through the atomic writer: a hard link to the old file keeps the old content (an in-place write would change both)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-init-atomic-"));
    expect(await cli(ctxIn(dir), "init", "--repo", "acme/one")).toBe(0);
    const keep = join(dir, "old.yml");
    linkSync(join(dir, ".pr-rla.yml"), keep);
    writeFileSync(join(dir, ".gitignore"), "node_modules/");
    linkSync(join(dir, ".gitignore"), join(dir, "old.gitignore"));
    expect(await cli(ctxIn(dir), "init", "--force", "--repo", "acme/two")).toBe(0);
    expect(readFileSync(join(dir, ".pr-rla.yml"), "utf8")).toMatch(/acme\/two/);
    expect(readFileSync(keep, "utf8")).toMatch(/acme\/one/);
    expect(readFileSync(join(dir, "old.gitignore"), "utf8")).toBe("node_modules/");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/\.pr-rla\/\n$/);
  });
});

describe("every line the CLI prints has its control characters escaped (M4)", () => {
  it("status text, an error on stderr, and --json (still exact JSON, read back to the same text)", () => {
    const dir = recordedRepo();
    const nasty = "x\u001b[2K\r\u009b‮y";
    const draws = JSON.parse(readFileSync(join(dir, "audit", "2026-q3", "draws.json"), "utf8")) as { draws: { url: string }[] };
    draws.draws[0]!.url = `https://example.invalid/${nasty}`;
    writeFileSync(join(dir, "audit", "2026-q3", "draws.json"), JSON.stringify(draws));
    const run = (...argv: string[]) => {
      const r = spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), ...argv], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
      return { out: r.stdout, err: r.stderr, code: r.status };
    };
    const raw = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
    const st = run("status");
    expect(st.out).toContain("https://example.invalid/x\\u001b[2K\\u000d\\u009b\\u202ey");
    expect(raw.test(st.out)).toBe(false);
    const js = run("status", "--json");
    expect(raw.test(js.out)).toBe(false);
    expect((JSON.parse(js.out) as { blockingDraw: { url: string } }).blockingDraw.url).toBe(`https://example.invalid/${nasty}`);
    const bad = run("draw-context", `1${nasty}`);
    expect(bad.code).toBe(1);
    expect(raw.test(bad.err)).toBe(false);
    expect(bad.err).toContain("\\u001b[2K");
  });
});
