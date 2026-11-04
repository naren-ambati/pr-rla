import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturePath } from "./helpers/fixtures.js";
import { treeHash } from "./helpers/tree-hash.js";

/**
 * pr-rla/api/read at run time (review 2 of U5, test 5): the import-graph test reads source text,
 * so a computed `import()`, or a write the regexes miss, would pass it. This one runs every read
 * function in a fresh Node process, with a load hook recording every module loaded and a spy on
 * every fs write and child process, on the built package (`npm run build` comes first in the
 * verification).
 */

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");

function audit(): string {
  const dir = mkdtempSync(join(tmpdir(), "prrla-runtime-"));
  cpSync(fixturePath("audits", "gh-aw-q3-recorded"), dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", ...a], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "recorded audit");
  return dir;
}

describe("pr-rla/api/read at run time: what it loads, writes and starts", () => {
  it("loads no write-side module, writes nothing, and starts only read-only git", () => {
    expect(existsSync(join(DIST, "api", "read", "index.js")), "build first: npm run build").toBe(true);
    const dir = audit();
    const before = treeHash(dir);
    const out = execFileSync(process.execPath, ["--import", join(ROOT, "test", "helpers", "runtime-trace-hook.mjs"), join(ROOT, "test", "helpers", "runtime-trace-run.mjs"), DIST, dir], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const t = JSON.parse(out) as { results: Record<string, string>; loaded: string[]; writes: string[]; spawns: { fn: string; file: string; args: string[]; env: Record<string, string> | null }[] };
    // Every function ran (the online ones fail on the transport that refuses every request, as they should).
    expect(t.results).toMatchObject({ auditList: "ok", status: "ok", draws: "ok", drawContext: "ok", verify: "ok", freezePreview: "ok", simulate: "ok" });
    const mine = t.loaded.filter((u) => u.includes("/dist/")).map((u) => u.replace(/.*\/dist\//, ""));
    expect(mine.length).toBeGreaterThan(60);
    expect(mine.filter((m) => /^(api\/write\/|commands\/|cli\.js$|cli\/|io\/git-transport\.js$|api\/checkpoint\.js$|api\/plugin-check\.js$)/.test(m))).toEqual([]);
    expect(t.writes).toEqual([]);
    // The only processes: git, reading the git-file ledger's history, with the read-only environment.
    for (const s of t.spawns) {
      expect(s.file).toBe("git");
      // The union of U5's and U9's guards (src/io/git-safe.ts, joined at the wave-2 integration); U9's history walk reads raw objects.
      expect(s.args.slice(0, 9)).toEqual(["--no-replace-objects", "-c", "core.commitGraph=false", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false"]);
      expect(["rev-parse", "rev-list", "config", "cat-file"]).toContain(s.args[9]);
      expect(s.env).toMatchObject({ GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
      expect(s.env!.GIT_CEILING_DIRECTORIES).toBeDefined();
    }
    expect(t.spawns.length).toBeGreaterThan(0);
    expect(treeHash(dir)).toBe(before);
  }, 120_000);
});
