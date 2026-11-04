/**
 * Release engineering without publishing (U10; FR8.3, NFR2, NFR13, NFR18; delivery-plan bolt 11).
 *
 * - The tarball `npm pack` would ship holds dist/, README.md, CHANGELOG.md and package.json, nothing else.
 * - The build starts from an empty dist/, so a file tsc compiled from a deleted source never ships
 *   (the wave-2 integration found dist/commands/freeze-pool.* in a tarball).
 * - The secret grep over the tarball is clean, and finds what it is meant to find.
 * - Every place that names the release names one version.
 * - No licence file or licence text, both packages private and UNLICENSED (the founder's instruction).
 * - No step of the build publishes anything.
 *
 * Every npm call runs with --offline under a preload that refuses any socket beyond loopback, and
 * `npm pack` writes only into a temporary directory: nothing leaves the machine (NFR11).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs maintainer script, no type declarations
import { findSecrets, grepPackage, tarballFiles } from "../scripts/secret-grep.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = join(ROOT, "test", "helpers", "ci-preload.cjs");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const json = <T = Record<string, unknown>>(...p: string[]) => JSON.parse(read(...p)) as T;
const rootPkg = json<{ version: string; private: boolean; license: string; files: string[]; scripts: Record<string, string>; engines: { node: string } }>("package.json");

/** What may be in a tarball (FR8.3). npm adds package.json and README.md itself; `files` names the rest. */
const ALLOWED = (path: string) => path === "package.json" || path === "README.md" || path === "CHANGELOG.md" || path.startsWith("dist/");

function npm(args: string[], cwd: string, denied: string): string {
  return execFileSync("npm", [...args, "--offline"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: `--require ${PRELOAD}`, PRRLA_TEST_DENIED: denied, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
  });
}
const packList = (cwd: string, denied: string, ignoreScripts = true): string[] => {
  const out = npm(["pack", "--dry-run", "--json", ...(ignoreScripts ? ["--ignore-scripts"] : [])], cwd, denied);
  return (JSON.parse(out.slice(out.indexOf("["))) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path).sort();
};
const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe("FR8.3: npm pack --dry-run lists only dist/, README, CHANGELOG and package.json", () => {
  it("pr-rla's tarball holds exactly those (the built dist/, packed without scripts)", () => {
    const t = tempDir("pr-rla-pack-");
    try {
      const files = packList(ROOT, join(t, "denied.txt"));
      expect(files.filter((f) => !ALLOWED(f))).toEqual([]);
      for (const f of ["package.json", "README.md", "CHANGELOG.md", "dist/cli.js", "dist/index.js", "dist/api/read/index.js", "dist/sdk/provider.js", "dist/timestamp/trust-bundle.json"]) expect(files, f).toContain(f);
      // No source, test, fixture or maintainer script ships; the bin and every export point into dist/.
      expect(files.some((f) => /\.test\.|^src\/|^test\/|^scripts\//.test(f))).toBe(false);
      expect(rootPkg.files).toEqual(["dist", "CHANGELOG.md"]);
      expect(existsSync(join(t, "denied.txt"))).toBe(false);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("a stale file planted in dist/ does not reach the list: prepack rebuilds from an empty dist/", () => {
    // A copy of the package, so the repository's own dist/ (which other test files run) is never touched.
    const t = tempDir("pr-rla-stale-");
    try {
      const pkg = join(t, "pkg");
      mkdirSync(pkg);
      for (const f of ["package.json", "tsconfig.json", "tsconfig.build.json", "README.md", "CHANGELOG.md"]) cpSync(join(ROOT, f), join(pkg, f));
      cpSync(join(ROOT, "src"), join(pkg, "src"), { recursive: true });
      mkdirSync(join(pkg, "scripts"));
      cpSync(join(ROOT, "scripts", "clean-dist.mjs"), join(pkg, "scripts", "clean-dist.mjs"));
      symlinkSync(join(ROOT, "node_modules"), join(pkg, "node_modules"), "dir");
      // What the integration found: the output of src/commands/freeze-pool.ts, which no longer exists.
      mkdirSync(join(pkg, "dist", "commands"), { recursive: true });
      for (const f of ["freeze-pool.js", "freeze-pool.d.ts", "freeze-pool.js.map"]) writeFileSync(join(pkg, "dist", "commands", f), "// stale: compiled from a deleted source\n");
      expect(existsSync(join(pkg, "src", "commands", "freeze-pool.ts"))).toBe(false);

      // With --ignore-scripts the stale file would ship: the control shows the plant is real.
      expect(packList(pkg, join(t, "denied.txt"), true)).toContain("dist/commands/freeze-pool.js");
      // npm pack --dry-run runs prepack, which is the build, which starts by emptying dist/.
      const files = packList(pkg, join(t, "denied.txt"), false);
      expect(files.filter((f) => f.includes("freeze-pool"))).toEqual([]);
      expect(files.filter((f) => !ALLOWED(f))).toEqual([]);
      expect(files).toContain("dist/cli.js");
      expect(existsSync(join(pkg, "dist", "commands", "freeze-pool.js"))).toBe(false);
      expect(existsSync(join(t, "denied.txt"))).toBe(false);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  }, 180_000);

  it("npm run build starts by emptying dist/, and prepack is the build", () => {
    expect(rootPkg.scripts.build).toBe("node scripts/clean-dist.mjs && tsc -p tsconfig.build.json");
    expect(rootPkg.scripts.prepack).toBe("npm run build");
    const mcp = json<{ scripts: Record<string, string> }>("packages", "pr-rla-mcp", "package.json");
    expect(mcp.scripts.build).toBe("node scripts/clean-dist.mjs && tsc -p tsconfig.json");
    expect(mcp.scripts.prepack).toBe("npm run build");
  });

  it("clean-dist refuses to run outside a package root and removes nothing but ./dist", () => {
    const t = tempDir("pr-rla-clean-");
    try {
      const run = (cwd: string) => execFileSync(process.execPath, [join(ROOT, "scripts", "clean-dist.mjs")], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(() => run(t)).toThrow(/not a package root/);
      writeFileSync(join(t, "package.json"), "{}");
      mkdirSync(join(t, "dist", "a"), { recursive: true });
      writeFileSync(join(t, "dist", "a", "x.js"), "");
      writeFileSync(join(t, "keep.js"), "");
      run(t);
      expect(existsSync(join(t, "dist"))).toBe(false);
      expect(existsSync(join(t, "keep.js"))).toBe(true);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe("FR8.3, NFR2: the secret grep over the tarball", () => {
  it("finds no token, private key or e-mail address in pr-rla's tarball, and reads every file in it", () => {
    const r = grepPackage(ROOT) as { name: string; version: string; files: string[]; findings: unknown[] };
    expect(r.name).toBe("pr-rla");
    expect(r.findings).toEqual([]);
    // The reader saw every file npm packs (the tarball's paths are under package/).
    const t = tempDir("pr-rla-pack-");
    try {
      expect(r.files.map((f) => f.replace(/^package\//, "")).sort()).toEqual(packList(ROOT, join(t, "denied.txt")));
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("is not vacuous: a planted token, key and address in a packed file are each found, without repeating them whole", () => {
    // Built at run time, so this file itself holds no token-shaped literal.
    const planted = {
      github: `gh${"p"}_${"A1b2C3d4E5".repeat(4)}`,
      gitlab: `gl${"pat"}-${"x7Y8z9".repeat(4)}`,
      aws: `AK${"IA"}${"QWERTYUIOP123456"}`,
      key: `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`,
      mail: `someone.real${"@"}company.test`,
    };
    const t = tempDir("pr-rla-plant-");
    try {
      const pkg = join(t, "pkg");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "planted", version: "0.0.0", private: true, license: "UNLICENSED", files: ["dist"] }));
      writeFileSync(join(pkg, "dist", "a.js"), `const t = "${planted.github}";\nconst g = "${planted.gitlab}";\n// ${planted.aws}\n${planted.key}\nmailto ${planted.mail}\n`);
      // Allowed: the scrubbed recorder form, a reserved example domain, OpenSSH's key-type names.
      writeFileSync(join(pkg, "dist", "b.js"), `user-3f2a${"@"}example.invalid sk-ssh-ed25519${"@"}openssh.com a${"@"}example.com prrla-cred:GITHUB_TOKEN\n`);
      const r = grepPackage(pkg) as { findings: { file: string; pattern: string; match: string }[] };
      expect(r.findings.map((f) => [f.file, f.pattern]).sort()).toEqual(
        [
          ["package/dist/a.js", "AWS access key id"],
          ["package/dist/a.js", "GitHub token"],
          ["package/dist/a.js", "GitLab token"],
          ["package/dist/a.js", "e-mail address"],
          ["package/dist/a.js", "private key"],
        ].sort(),
      );
      for (const f of r.findings) for (const secret of Object.values(planted)) if (secret.length > 12) expect(f.match).not.toContain(secret);
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });

  it("each pattern matches its issuer's documented shape and leaves placeholders alone", () => {
    const hits = (s: string) => (findSecrets(s) as { pattern: string }[]).map((f) => f.pattern);
    expect(hits(`token github_pat_${"1".repeat(22)}_${"a".repeat(59)}`)).toEqual(["GitHub token"]);
    expect(hits(`npm_${"a".repeat(36)}`)).toEqual(["npm token"]);
    expect(hits(`ATATT3${"x".repeat(30)}`)).toEqual(["Atlassian token"]);
    expect(hits(`xox${"b"}-123456789012-abcdefghij`)).toEqual(["Slack token"]);
    expect(hits(`Authorization: Bearer ${"Zm9v".repeat(8)}`)).toEqual(["credential in an Authorization header"]);
    expect(hits("Authorization: token prrla-cred:GITHUB_TOKEN · prrla-basic:JIRA_EMAIL:JIRA_TOKEN · ghp_short")).toEqual([]);
    expect(hits("-----BEGIN CERTIFICATE----- (public: the trust bundle ships certificates)")).toEqual([]);
  });

  it("reads a tarball's files itself (no tar program needed)", () => {
    const t = tempDir("pr-rla-tar-");
    try {
      const pkg = join(t, "pkg");
      mkdirSync(join(pkg, "dist", "a", "b"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "tarred", version: "0.0.0", private: true, license: "UNLICENSED", files: ["dist"] }));
      const long = `${"segment-".repeat(14)}file.js`; // a path past ustar's 100-byte name field
      writeFileSync(join(pkg, "dist", "a", "b", long), "deep\n");
      writeFileSync(join(pkg, "dist", "x.js"), "x\n");
      execFileSync("npm", ["pack", "--ignore-scripts", "--offline", "--pack-destination", t], { cwd: pkg, stdio: "ignore", env: { ...process.env, npm_config_update_notifier: "false" } });
      const files = tarballFiles(join(t, "tarred-0.0.0.tgz")) as { path: string; text: string }[];
      expect(files.map((f) => f.path).sort()).toEqual([`package/dist/a/b/${long}`, "package/dist/x.js", "package/package.json"].sort());
      expect(files.find((f) => f.path.endsWith(long))!.text).toBe("deep\n");
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  });
});

describe("one release version everywhere (both packages, the plugin, every pin and the changelogs)", () => {
  const v = rootPkg.version;

  it("is 0.1.0, the first public release the design gives (NFR8, RQ17)", () => {
    expect(v).toBe("0.1.0");
  });

  it("every source names it", () => {
    const mcp = json<{ version: string; dependencies: Record<string, string> }>("packages", "pr-rla-mcp", "package.json");
    const sources: [string, string | undefined][] = [
      ["src/version.ts", /PR_RLA_VERSION = "([^"]+)"/.exec(read("src", "version.ts"))?.[1]],
      ["packages/pr-rla-mcp/package.json", mcp.version],
      ["packages/pr-rla-mcp/src/version.ts", /PR_RLA_MCP_VERSION = "([^"]+)"/.exec(read("packages", "pr-rla-mcp", "src", "version.ts"))?.[1]],
      ["integrations/claude-code/.claude-plugin/plugin.json", json<{ version: string }>("integrations", "claude-code", ".claude-plugin", "plugin.json").version],
      ["integrations/claude-code/.mcp.json", /pr-rla-mcp@([0-9.]+)/.exec(read("integrations", "claude-code", ".mcp.json"))?.[1]],
      ["integrations/codex/config.toml", /pr-rla-mcp@([0-9.]+)/.exec(read("integrations", "codex", "config.toml"))?.[1]],
      ["integrations/cursor/mcp.json", /pr-rla-mcp@([0-9.]+)/.exec(read("integrations", "cursor", "mcp.json"))?.[1]],
      ["integrations/claude-code/hooks/guard.mjs", /GUARD_VERSION = "([^"]+)"/.exec(read("integrations", "claude-code", "hooks", "guard.mjs"))?.[1]],
      ["integrations/github-action/package.json", /^file:vendor\/pr-rla-([0-9.]+)\.tgz$|^([0-9.]+)$/.exec(json<{ dependencies: Record<string, string> }>("integrations", "github-action", "package.json").dependencies["pr-rla"]!)?.slice(1).find(Boolean)],
      ["integrations/github-action/package-lock.json", json<{ packages: Record<string, { version: string }> }>("integrations", "github-action", "package-lock.json").packages["node_modules/pr-rla"]!.version],
      ["integrations/gitlab/templates/pr-rla.yml", /version:\n(?:.*\n)*?\s+default: "([^"]+)"/.exec(read("integrations", "gitlab", "templates", "pr-rla.yml"))?.[1]],
      ["docs/ci/gitlab.md", /PRRLA_VERSION: "([^"]+)"/.exec(read("docs", "ci", "gitlab.md"))?.[1]],
      ["docs/ci/bitbucket.md", /PRRLA_VERSION="\$\{PRRLA_VERSION-([^}]+)\}"/.exec(read("docs", "ci", "bitbucket.md"))?.[1]],
      ["CHANGELOG.md", /^## ([0-9]+\.[0-9]+\.[0-9]+)/m.exec(read("CHANGELOG.md"))?.[1]],
      ["packages/pr-rla-mcp/CHANGELOG.md", /^## ([0-9]+\.[0-9]+\.[0-9]+)/m.exec(read("packages", "pr-rla-mcp", "CHANGELOG.md"))?.[1]],
    ];
    expect(sources.filter(([, found]) => found !== v)).toEqual([]);
    // Until release, the MCP server links this checkout; the release pins the exact version (docs/release-checklist.md).
    expect(["file:../..", v]).toContain(mcp.dependencies["pr-rla"]);
  });

  it("the built CLI prints it", () => {
    expect(existsSync(join(ROOT, "dist", "cli.js")), "run npm run build first").toBe(true);
    expect(execFileSync(process.execPath, [join(ROOT, "dist", "cli.js"), "--version"], { encoding: "utf8" }).trim()).toBe(v);
  });

  it("the example plugins accept it as a peer (~0.1.0) and the vendored Action tarball is that version's", () => {
    for (const p of [["examples", "providers", "gitea"], ["examples", "ledgers", "jira"]]) expect(json<{ peerDependencies: Record<string, string> }>(...p, "package.json").peerDependencies["pr-rla"], p.join("/")).toBe(`~${v}`);
    expect(existsSync(join(ROOT, "integrations", "github-action", "vendor", `pr-rla-${v}.tgz`))).toBe(true);
  });
});

describe("NFR13: the runtime both packages declare", () => {
  it("is Node 22.15 or later (module.registerHooks, which the plugin host needs)", () => {
    expect(rootPkg.engines.node).toBe(">=22.15");
    expect(json<{ engines: { node: string } }>("packages", "pr-rla-mcp", "package.json").engines.node).toBe(">=22.15");
  });
});

describe("no licence: none chosen yet (the founder decides before release)", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n");

  it("no licence file is tracked, anywhere", () => {
    expect(tracked.filter((f) => /(^|\/)(LICEN[CS]E|COPYING|UNLICENSE)([.-][^/]*)?$/i.test(f))).toEqual([]);
  });

  it("every package.json of ours is private and UNLICENSED", () => {
    const ours = tracked.filter((f) => f.endsWith("package.json") && !f.includes("node_modules/") && !f.startsWith("test/fixtures/"));
    expect(ours.length).toBeGreaterThanOrEqual(5);
    for (const f of ours) {
      const p = json<{ private?: boolean; license?: string }>(f);
      expect([f, p.private, p.license]).toEqual([f, true, "UNLICENSED"]);
    }
  });

  it("no file of ours carries licence text (lockfiles' third-party metadata and recorded fixtures aside)", () => {
    const grant = /Permission is hereby granted|Licensed under the Apache License|SPDX-License-Identifier|GNU (?:Lesser |Affero )?General Public License|Mozilla Public License|THE SOFTWARE IS PROVIDED "AS IS"|Redistribution and use in source and binary forms/i;
    const mine = tracked.filter((f) => !/(^|\/)package-lock\.json$|\.tgz$|^test\/fixtures\/|^test\/release\.test\.ts$/.test(f) && statSync(join(ROOT, f)).size < 4_000_000);
    expect(mine.filter((f) => grant.test(read(f)))).toEqual([]);
  });

  it("the docs say who decides, and offer no licence", () => {
    for (const f of ["CHANGELOG.md", "CONTRIBUTING.md", "docs/release-checklist.md"]) expect(read(f), f).toMatch(/licence: decided by the founder before release/i);
  });
});

describe("FR8.3, FR6.6, NFR18: no step in the build publishes anything", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (f === "node_modules" ? [] : statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

  it("no package script and no maintainer script publishes, tags, logs in or pushes", () => {
    const pkgs = ["package.json", "packages/pr-rla-mcp/package.json", "examples/providers/gitea/package.json", "examples/ledgers/jira/package.json", "integrations/github-action/package.json"];
    for (const f of pkgs) for (const [name, cmd] of Object.entries(json<{ scripts?: Record<string, string> }>(f).scripts ?? {})) expect(`${f} ${name}: ${cmd}`).not.toMatch(/\bpublish\b|\bnpm (?:login|adduser|token|dist-tag)\b|\bgit (?:push|tag)\b/);
    const scripts = [...walk(join(ROOT, "scripts")), ...walk(join(ROOT, "packages", "pr-rla-mcp", "scripts"))].filter((f) => f.endsWith(".mjs"));
    for (const f of scripts) expect(readFileSync(f, "utf8"), relative(ROOT, f)).not.toMatch(/["'`]publish["'`]|\bnpm publish\b|["'`]push["'`]\s*[,\]]|\bgit push\b/);
  });

  it("the release checklist leaves every publish to the founder and names trusted publishing with provenance (NFR18)", () => {
    const checklist = read("docs", "release-checklist.md");
    expect(checklist).toMatch(/--provenance/);
    expect(checklist).toMatch(/trusted publishing/i);
    // Every step that runs npm publish, or makes anything public, is the founder's own.
    const sections = checklist.split(/^## (?=\d+\. )/m).slice(1);
    const publishing = sections.filter((s) => /npm publish|Publish |Create the public repository|Register the prospective/.test(s));
    expect(publishing.length).toBeGreaterThanOrEqual(5);
    for (const s of publishing) expect(s.split("\n")[0] + " " + /\*\*Owner: ([a-z]+)/.exec(s)?.[1]).toMatch(/ founder$/);
  });
});
