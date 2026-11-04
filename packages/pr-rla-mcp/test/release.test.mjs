// Release engineering for this package (U10, FR8.3, NFR2): what `npm pack` would ship, that the build
// starts from an empty dist/, and the secret grep over the tarball (scripts/secret-grep.mjs in the
// repository root, the same code test/release.test.ts runs on pr-rla's tarball). Nothing is published:
// `npm pack` runs with --offline and writes only into a temporary directory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { grepPackage } from "../../../scripts/secret-grep.mjs";
import { PKG, REPO } from "./helpers.mjs";

const PRELOAD = join(REPO, "test", "helpers", "ci-preload.cjs");
const ALLOWED = (p) => p === "package.json" || p === "README.md" || p === "CHANGELOG.md" || p.startsWith("dist/");

function packList(cwd, denied, ignoreScripts = true) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--offline", ...(ignoreScripts ? ["--ignore-scripts"] : [])], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: `--require ${PRELOAD}`, PRRLA_TEST_DENIED: denied, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
  });
  return JSON.parse(out.slice(out.indexOf("[")))[0].files.map((f) => f.path).sort();
}

describe("FR8.3: npm pack --dry-run lists only dist/, README, CHANGELOG and package.json", () => {
  it("pr-rla-mcp's tarball holds exactly those (the built dist/, packed without scripts)", () => {
    const t = mkdtempSync(join(tmpdir(), "pr-rla-mcp-pack-"));
    try {
      const files = packList(PKG, join(t, "denied.txt"));
      assert.deepEqual(files.filter((f) => !ALLOWED(f)), []);
      for (const f of ["package.json", "README.md", "CHANGELOG.md", "dist/bin.js", "dist/server.js"]) assert.ok(files.includes(f), f);
      assert.equal(files.some((f) => /^src\/|^test\/|^scripts\//.test(f)), false);
      assert.equal(existsSync(join(t, "denied.txt")), false, "npm tried the network");
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("a stale file planted in dist/ does not reach the list: prepack rebuilds from an empty dist/", () => {
    const t = mkdtempSync(join(tmpdir(), "pr-rla-mcp-stale-"));
    try {
      const pkg = join(t, "pkg");
      mkdirSync(join(pkg, "scripts"), { recursive: true });
      for (const f of ["package.json", "tsconfig.json", "README.md", "CHANGELOG.md"]) cpSync(join(PKG, f), join(pkg, f));
      cpSync(join(PKG, "src"), join(pkg, "src"), { recursive: true });
      cpSync(join(PKG, "scripts", "clean-dist.mjs"), join(pkg, "scripts", "clean-dist.mjs"));
      symlinkSync(join(PKG, "node_modules"), join(pkg, "node_modules"), "dir");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      for (const f of ["removed-tool.js", "removed-tool.d.ts"]) writeFileSync(join(pkg, "dist", f), "// stale: compiled from a deleted source\n");
      assert.ok(packList(pkg, join(t, "denied.txt"), true).includes("dist/removed-tool.js"), "the control: without the build the stale file ships");
      const files = packList(pkg, join(t, "denied.txt"), false);
      assert.deepEqual(files.filter((f) => f.includes("removed-tool")), []);
      assert.deepEqual(files.filter((f) => !ALLOWED(f)), []);
      assert.ok(files.includes("dist/bin.js"));
      assert.equal(existsSync(join(t, "denied.txt")), false, "npm tried the network");
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe("FR8.3, NFR2: the secret grep over the tarball", () => {
  it("finds no token, private key or e-mail address in pr-rla-mcp's tarball", () => {
    const r = grepPackage(PKG);
    assert.equal(r.name, "pr-rla-mcp");
    assert.ok(r.files.length >= 5);
    assert.deepEqual(r.findings, []);
  });

  it("names its changelog's version, which is the package's", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
    assert.equal(/^## ([0-9]+\.[0-9]+\.[0-9]+)/m.exec(readFileSync(join(PKG, "CHANGELOG.md"), "utf8"))[1], pkg.version);
  });
});
