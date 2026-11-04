// The package itself (FR3.1; NFR10 start time; units-of-work.md U5): what it is allowed to import,
// how it pins pr-rla, its licence fields, its command line, its start time, and a negative control
// showing the write guard the other tests rely on does catch a write.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BIN, GUARD, PKG, REPO, copyAudit, startServer } from "./helpers.mjs";

const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(PKG, "package-lock.json"), "utf8"));

describe("the pr-rla-mcp package", () => {
  it("is private and unlicensed, like every package here", () => {
    assert.equal(pkg.private, true);
    assert.equal(pkg.license, "UNLICENSED");
    assert.ok(!existsSync(join(PKG, "LICENSE")));
  });

  it("pins every dependency to an exact version; pr-rla is the repository's own package, linked", () => {
    for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (name === "pr-rla") assert.equal(v, "file:../..");
      else assert.match(v, /^\d+\.\d+\.\d+$/, `${name}@${v}`);
    }
    assert.equal(pkg.dependencies["@modelcontextprotocol/server"], "2.4.0");
    assert.equal(lock.packages["node_modules/pr-rla"].link, true);
    assert.equal(lock.packages["node_modules/pr-rla"].resolved, "../..");
    // Released together: the MCP server and the pr-rla it links are the same version.
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    assert.equal(pkg.version, root.version);
    assert.equal(readFileSync(join(PKG, "src", "version.ts"), "utf8").match(/PR_RLA_MCP_VERSION = "([^"]+)"/)[1], pkg.version);
  });

  it("imports only pr-rla/api/read from pr-rla, and nothing outside the package by path (contracts.md §4)", () => {
    const seen = new Set();
    for (const f of readdirSync(join(PKG, "src")).filter((x) => x.endsWith(".ts"))) {
      const text = readFileSync(join(PKG, "src", f), "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) seen.add(m[1]);
    }
    const external = [...seen].filter((s) => !s.startsWith("./") && !s.startsWith("node:"));
    assert.deepEqual(external.sort(), ["@modelcontextprotocol/server", "@modelcontextprotocol/server/stdio", "pr-rla/api/read", "zod"]);
    assert.deepEqual([...seen].filter((s) => s.startsWith("../")), []);
    // The built server, too: no pr-rla import other than the read subpath.
    for (const f of readdirSync(join(PKG, "dist")).filter((x) => x.endsWith(".js"))) {
      const text = readFileSync(join(PKG, "dist", f), "utf8");
      for (const m of text.matchAll(/from\s*["'](pr-rla[^"']*)["']/g)) assert.equal(m[1], "pr-rla/api/read", f);
    }
  });

  it("the command line: --help, --version, and refusals for a bad root or an unknown flag", () => {
    assert.match(execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" }), /read-only MCP server for pr-rla audits/);
    assert.equal(execFileSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).trim(), pkg.version);
    const bad = spawnSync(process.execPath, [BIN, "--root", join(tmpdir(), "no-such-dir-pr-rla")], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a directory/);
    assert.equal(spawnSync(process.execPath, [BIN, "--frobnicate"], { encoding: "utf8" }).status, 1);
    assert.equal(spawnSync(process.execPath, [BIN, "--handoff-ms", "30000"], { encoding: "utf8" }).status, 1);
  });

  it("starts in under 2 s when installed (NFR10), under the permission model", async () => {
    const dir = copyAudit();
    // The best of five starts: the target is the server's start, not other work on a busy machine.
    const times = [];
    for (let i = 0; i < 5; i++) {
      const s = await startServer({ roots: [dir] });
      times.push(s.startMs);
      await s.close();
    }
    const best = Math.min(...times);
    assert.ok(best < (process.env.CI ? 4000 : 2000), `started in ${times.map((t) => Math.round(t)).join(", ")} ms`);
  });

  it("negative control: the write guard and the permission model catch a write the server would attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-guard-"));
    const r = spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", "--import", GUARD, "-e", `try { require("node:fs").writeFileSync(${JSON.stringify(join(dir, "x"))}, "x") } catch (e) { process.stderr.write(e.code + "\\n") }`], { encoding: "utf8" });
    assert.match(r.stderr, /PRRLA-WRITE-ATTEMPT writeFileSync .*\/x/);
    assert.match(r.stderr, /ERR_ACCESS_DENIED/);
    assert.equal(existsSync(join(dir, "x")), false);
  });
});
