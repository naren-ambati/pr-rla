import { afterAll, describe, expect, it } from "vitest";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../src/cli.js";
import type { CommandContext } from "../src/commands/context.js";
import type { RegistrationRecordV2, SignedRecord } from "../src/core/records.js";
import { closeAllPluginHosts } from "../src/plugins/host.js";
import { LOCK_FILE, pluginPolicy, readLock, resolvePlugin, treeSha256 } from "../src/plugins/lock.js";
import { CORRECTNESS_NOT_SAFETY } from "../src/plugins/check.js";
import { optionsDigest } from "../src/registry.js";
import { makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";

/** pr-rla.lock.json, plugin add / lock / check, and the load-time refusals (U2b; FR2.1–FR2.3, FR2.5–FR2.7). */

const ROOT = join(import.meta.dirname, "..");
const USE = "./plugins/acme/index.mjs";
const W = join("audit", "2026-q3");

afterAll(() => closeAllPluginHosts());

/** A small external provider serving options.changes, as a package directory inside the audit repo. */
const PLUGIN_SOURCE = `import { defineProvider } from "pr-rla/provider";
export default defineProvider({
  providerApiVersion: 1,
  name: "acme",
  create(options) {
    return {
      apiVersion: 1,
      name: "acme",
      async listChanges(req) {
        const o = Date.parse(req.window.opensAt), c = Date.parse(req.window.closesAt);
        return { changes: (options.changes ?? []).filter((x) => req.kinds.includes(x.kind) && Date.parse(x.mergedAt) >= o && Date.parse(x.mergedAt) < c), defaultBranch: "main", limitations: ["acme: from options"] };
      },
    };
  },
});
`;

function withPlugin(o: { pkg?: Record<string, unknown>; source?: string; use?: string } = {}): Scenario & { options: Record<string, unknown> } {
  const changes = makeChanges(6);
  const options = { changes };
  const s = setupAuditRepo({ changes, provider: `{ use: ${o.use ?? USE}, options: ${JSON.stringify(options)} }` });
  mkdirSync(join(s.dir, "plugins", "acme"), { recursive: true });
  writeFileSync(join(s.dir, "plugins", "acme", "package.json"), JSON.stringify({ name: "acme-provider", version: "1.2.3", type: "module", ...o.pkg }));
  writeFileSync(join(s.dir, "plugins", "acme", "index.mjs"), o.source ?? PLUGIN_SOURCE);
  return { ...s, options };
}

/** Runs the CLI in a fresh command context (one AuditContext per command, as in a real process). */
async function cli(s: Scenario, args: string[], extra: Partial<CommandContext> = {}): Promise<{ code: number; out: string[] }> {
  let code = -1;
  const from = s.out.length;
  await buildProgram(() => ({ ...s.ctx, ...extra }), (c) => (code = c)).parseAsync(["node", "pr-rla", ...args]);
  return { code, out: s.out.slice(from) };
}

const text = (r: { out: string[] }) => r.out.join("\n");

describe("register refuses an external plugin that is not locked, and names plugin add (FR2.3)", () => {
  it("exits 1 with the command to run; writes no lock and no registration", async () => {
    const s = withPlugin();
    const r = await cli(s, ["register"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`ERR pr-rla: plugin ${USE} is not locked; review it and run "pr-rla plugin add ${USE}"`);
    expect(r.out).toContain(`ERR   next: pr-rla plugin add ${USE}`);
    expect(existsSync(join(s.dir, LOCK_FILE))).toBe(false);
    expect(existsSync(join(s.dir, W, "registration.json"))).toBe(false);
  });
});

describe("plugin add: the only way into the lock (FR2.3)", () => {
  it("prints the source, version, resolved, npm integrity and tree hash it trusts, and asks first", async () => {
    const s = withPlugin();
    const noTerminal = await cli(s, ["plugin", "add", USE]);
    expect(noTerminal.code).toBe(1);
    expect(text(noTerminal)).toMatch(/plugin add needs your confirmation: review the lines above, then run it again with --yes/);
    const asked: string[] = [];
    const declined = await cli(s, ["plugin", "add", USE], { confirm: async (q) => (asked.push(q), false) });
    expect(declined.code).toBe(1);
    expect(declined.out).toContain("not added");
    expect(asked).toEqual([`Trust ${USE} as shown and add it to ${join(s.dir, LOCK_FILE)}?`]);
    expect(existsSync(join(s.dir, LOCK_FILE))).toBe(false);

    const tree = treeSha256(resolvePlugin(USE, s.dir));
    const added = await cli(s, ["plugin", "add", USE], { confirm: async () => true });
    expect(added.code).toBe(0);
    expect(added.out.slice(0, 10)).toEqual([
      `plugin add ${USE}: provider acme`,
      "  source        path",
      "  version       1.2.3",
      "  resolved      file:plugins/acme",
      "  npmIntegrity  none (a path plugin: the tree hash and the audit repo's git history pin it)",
      `  treeSha256    ${tree}`,
      expect.stringMatching(/^ {2}trust {9}isolated: out of process, placeholder credentials, read-only access to its own files; /),
      "  hosts         none",
      "  writePaths    none",
      "  credentials   none",
    ]);
    expect(readLock(s.dir)).toEqual({
      schema: "pr-rla/lock/v1",
      plugins: { [USE]: { source: "path", name: "acme", version: "1.2.3", resolved: "file:plugins/acme", npmIntegrity: null, treeSha256: tree, trust: "isolated", hosts: [], writePaths: [], credentials: [] } },
    });
    const again = await cli(s, ["plugin", "add", USE, "--yes"]);
    expect(again.code).toBe(1);
    expect(text(again)).toMatch(/is already in .*pr-rla\.lock\.json; to trust a reviewed change, run "pr-rla plugin lock \.\/plugins\/acme\/index\.mjs"/);
  });

  it("refuses a built-in, a plugin the config does not name, and a path outside the audit repo", async () => {
    const s = withPlugin();
    expect(text(await cli(s, ["plugin", "add", "github", "--yes"]))).toMatch(/github is not the provider or the ledger/);
    expect(text(await cli(s, ["plugin", "add", "git-file", "--yes"]))).toMatch(/git-file is built in; built-in plugins need no lock/);
    const outside = join(tmpdir(), `prrla-outside-${process.pid}.mjs`);
    writeFileSync(outside, PLUGIN_SOURCE);
    const o = withPlugin({ use: outside });
    const r = await cli(o, ["plugin", "add", outside, "--yes"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/resolves to .*, outside the audit repo .*\n.*next: vendor the plugin into the audit repo/);
  });

  it("warns when the plugin declares install scripts", async () => {
    const s = withPlugin({ pkg: { scripts: { postinstall: "node steal.js", test: "node --test" } } });
    const r = await cli(s, ["plugin", "add", USE, "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('ERR warning: acme-provider declares install scripts (postinstall); pr-rla plugins need none. Install plugins with "npm ci --ignore-scripts".');
  });
});

describe("the locked identity is registered, and every load re-hashes (FR2.1, FR2.2)", () => {
  it("register records name, source, version, content hash and options hash, and leaves the lock untouched", async () => {
    const s = withPlugin();
    expect((await cli(s, ["plugin", "add", USE, "--yes"])).code).toBe(0);
    const lockBytes = readFileSync(join(s.dir, LOCK_FILE), "utf8");
    const r = await cli(s, ["register"]);
    expect(r.code).toBe(0);
    const reg = JSON.parse(readFileSync(join(s.dir, W, "registration.json"), "utf8")) as SignedRecord<RegistrationRecordV2>;
    const tree = readLock(s.dir).plugins[USE]!.treeSha256;
    expect(reg.record.plugins.provider).toEqual({ name: "acme", source: "path", version: "1.2.3", integrity: tree, optionsSha256: optionsDigest(s.options), populationOptionsSha256: optionsDigest(s.options, []), trust: "isolated" });
    expect(r.out).toContain(`  plugin acme: trust isolated · treeSha256 ${tree.slice(0, 12)}… (pr-rla.lock.json)`);
    expect(readFileSync(join(s.dir, LOCK_FILE), "utf8")).toBe(lockBytes);
  });

  it("a changed file is refused at load; plugin lock re-hashes it after review", async () => {
    const s = withPlugin();
    expect((await cli(s, ["plugin", "add", USE, "--yes"])).code).toBe(0);
    const before = readLock(s.dir).plugins[USE]!.treeSha256;
    const ok = await cli(s, ["freeze", "--dry-run"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("N = 6");
    expect(ok.out.some((l) => l.startsWith("ERR plugin acme@1.2.3 runs isolated: placeholder credentials, read-only access to its own files"))).toBe(true);

    appendFileSync(join(s.dir, "plugins", "acme", "index.mjs"), "// a reviewed change\n");
    const after = treeSha256(resolvePlugin(USE, s.dir));
    for (const cmd of [["freeze", "--dry-run"], ["register"]]) {
      const r = await cli(s, cmd);
      expect(r.code, cmd.join(" ")).toBe(1);
      expect(r.out).toContain(`ERR pr-rla: plugin ${USE} changed since it was locked (treeSha256 ${before.slice(0, 12)}… → ${after.slice(0, 12)}…); run "pr-rla plugin lock ${USE}" after reviewing the change`);
    }
    const relock = await cli(s, ["plugin", "lock", USE, "--yes"]);
    expect(relock.code).toBe(0);
    expect(relock.out).toContain(`  treeSha256    "${before}" -> "${after}"`);
    expect((await cli(s, ["freeze", "--dry-run"])).code).toBe(0);
    expect((await cli(s, ["plugin", "lock", USE, "--yes"])).out).toContain(`${USE}: unchanged since it was locked (treeSha256 ${after.slice(0, 12)}…)`);
  });

  it("a symlink that leaves the plugin aborts hashing; one inside it is hashed through", async () => {
    const s = withPlugin();
    writeFileSync(join(s.dir, "plugins", "acme", "data.json"), "{}");
    symlinkSync("data.json", join(s.dir, "plugins", "acme", "alias.json"));
    expect((await cli(s, ["plugin", "add", USE, "--yes"])).code).toBe(0);
    const secret = join(tmpdir(), `prrla-symlink-target-${process.pid}.txt`);
    writeFileSync(secret, "outside");
    symlinkSync(secret, join(s.dir, "plugins", "acme", "escape.txt"));
    const r = await cli(s, ["freeze", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/plugin \.\/plugins\/acme\/index\.mjs: escape\.txt is a symlink to .*prrla-symlink-target-.*, outside .*plugins\/acme; refusing to hash it/);
    expect(text(await cli(s, ["plugin", "lock", USE, "--yes"]))).toMatch(/escape\.txt is a symlink .* refusing to hash it/);
    // Before a first add too: nothing is granted to a child until the tree hashes.
    const fresh = withPlugin();
    symlinkSync(secret, join(fresh.dir, "plugins", "acme", "escape.txt"));
    const add = await cli(fresh, ["plugin", "add", USE, "--yes"]);
    expect(add.code).toBe(1);
    expect(text(add)).toMatch(/escape\.txt is a symlink .* refusing to hash it/);
    expect(existsSync(join(fresh.dir, LOCK_FILE))).toBe(false);
  });

  it("the tree hash covers every file but node_modules and .git, and each dependency separately", async () => {
    const s = withPlugin({ pkg: { dependencies: { "left-pad": "1.3.0" } }, source: PLUGIN_SOURCE.replace('import { defineProvider } from "pr-rla/provider";', 'import { defineProvider } from "pr-rla/provider";\nimport leftPad from "left-pad";\nvoid leftPad;') });
    const dep = join(s.dir, "plugins", "acme", "node_modules", "left-pad");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "left-pad", version: "1.3.0", type: "module", exports: "./index.js" }));
    writeFileSync(join(dep, "index.js"), "export default (s, n) => String(s).padStart(n);\n");
    const tree = () => treeSha256(resolvePlugin(USE, s.dir));
    const t0 = tree();
    expect(resolvePlugin(USE, s.dir).deps.map((d) => `${d.name}@${d.version}`)).toEqual(["left-pad@1.3.0"]);
    mkdirSync(join(s.dir, "plugins", "acme", ".git"), { recursive: true });
    writeFileSync(join(s.dir, "plugins", "acme", ".git", "HEAD"), "x");
    writeFileSync(join(s.dir, "plugins", "acme", "node_modules", ".package-lock.json"), "{}");
    expect(tree()).toBe(t0);
    expect((await cli(s, ["plugin", "add", USE, "--yes"])).code).toBe(0);
    // The dependency is readable by the child and the plugin runs.
    expect((await cli(s, ["freeze", "--dry-run"])).out).toContain("N = 6");
    appendFileSync(join(dep, "index.js"), "// changed\n");
    expect(tree()).not.toBe(t0);
    expect(text(await cli(s, ["freeze", "--dry-run"]))).toMatch(/changed since it was locked \(treeSha256/);
  });
});

describe("a package plugin is pinned by its package-lock integrity too", () => {
  function packageAudit(withLockEntry: boolean): Scenario {
    const changes = makeChanges(4);
    const s = setupAuditRepo({ changes, provider: `{ use: pr-rla-provider-acme, options: ${JSON.stringify({ changes })} }` });
    const pkg = join(s.dir, "node_modules", "pr-rla-provider-acme");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pr-rla-provider-acme", version: "2.0.1", type: "module", exports: { ".": { import: "./index.mjs" } } }));
    writeFileSync(join(pkg, "index.mjs"), PLUGIN_SOURCE);
    const packages: Record<string, unknown> = { "": { name: "audit" } };
    if (withLockEntry) packages["node_modules/pr-rla-provider-acme"] = { version: "2.0.1", resolved: "https://registry.npmjs.org/pr-rla-provider-acme/-/pr-rla-provider-acme-2.0.1.tgz", integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
    writeFileSync(join(s.dir, "package-lock.json"), JSON.stringify({ name: "audit", lockfileVersion: 3, packages }));
    return s;
  }

  it("records the integrity and resolved URL; a changed package-lock entry is refused at load", async () => {
    const s = packageAudit(true);
    const r = await cli(s, ["plugin", "add", "pr-rla-provider-acme", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  npmIntegrity  sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(readLock(s.dir).plugins["pr-rla-provider-acme"]).toMatchObject({ source: "package", name: "acme", version: "2.0.1", resolved: "https://registry.npmjs.org/pr-rla-provider-acme/-/pr-rla-provider-acme-2.0.1.tgz", npmIntegrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect((await cli(s, ["freeze", "--dry-run"])).out).toContain("N = 4");
    const lockfile = join(s.dir, "package-lock.json");
    writeFileSync(lockfile, readFileSync(lockfile, "utf8").replace("sha512-AAAA", "sha512-BBBB"));
    const refused = await cli(s, ["register"]);
    expect(refused.code).toBe(1);
    expect(text(refused)).toMatch(/plugin pr-rla-provider-acme changed since it was locked \(npm integrity sha512-A+… → sha512-BBBBA+…\); run "pr-rla plugin lock pr-rla-provider-acme"/);
  });

  it("plugin add refuses a package with no package-lock entry", async () => {
    const r = await cli(packageAudit(false), ["plugin", "add", "pr-rla-provider-acme", "--yes"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/package pr-rla-provider-acme has no entry in the audit repo's package-lock\.json, so its npm integrity cannot be recorded/);
  });
});

describe("--plugins builtin-only and PR_RLA_PLUGINS=builtin-only (FR2.6)", () => {
  const THROWS = 'throw new Error("IMPORTED: external code ran");\n';

  it("refuse an external plugin before it is resolved or imported, and leave built-ins alone", async () => {
    const s = withPlugin({ source: THROWS });
    const refusal = /provider \.\/plugins\/acme\/index\.mjs is an external plugin, and --plugins builtin-only \(or PR_RLA_PLUGINS=builtin-only\) refuses all external code/;
    for (const [args, extra] of [
      [["--plugins", "builtin-only", "register"], {}],
      [["register"], { env: { PR_RLA_PLUGINS: "builtin-only" } }],
      [["--plugins", "builtin-only", "freeze", "--dry-run"], {}],
      [["--plugins", "builtin-only", "plugin", "add", USE, "--yes"], {}],
    ] as [string[], Partial<CommandContext>][]) {
      const r = await cli(s, args, extra);
      expect(r.code, args.join(" ")).toBe(1);
      expect(text(r), args.join(" ")).toMatch(refusal);
      expect(text(r)).not.toMatch(/IMPORTED|not locked/);
    }
    const builtin = setupAuditRepo({ changes: makeChanges(3) });
    expect((await cli(builtin, ["--plugins", "builtin-only", "freeze", "--dry-run"])).code).toBe(0);
  });

  it("any other value is refused, so a typo never lets external code in", async () => {
    expect(() => pluginPolicy("all", {})).toThrow(/--plugins "all": the only value is builtin-only/);
    // An empty --plugins is a mistake, not "unset" (finding 15); an empty variable is unset, as shells set them.
    expect(() => pluginPolicy("", {})).toThrow(/--plugins "": the only value is builtin-only/);
    expect(pluginPolicy(undefined, { PR_RLA_PLUGINS: "" })).toBe("locked");
    const s = withPlugin({ source: 'throw new Error("IMPORTED: external code ran");\n' });
    const r = await cli(s, ["--plugins", "", "freeze", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/--plugins "": the only value is builtin-only/);
    expect(text(r)).not.toMatch(/IMPORTED/);
    expect(() => pluginPolicy(undefined, { PR_RLA_PLUGINS: "builtin_only" })).toThrow(/PR_RLA_PLUGINS "builtin_only"/);
    expect(pluginPolicy(undefined, {})).toBe("locked");
    expect(pluginPolicy(undefined, { PR_RLA_PLUGINS: "builtin-only" })).toBe("builtin-only");
  });
});

describe("trust: full is an explicit opt-in, said on every command and repeated by verify (FR2.5)", () => {
  it("runs in process with the real environment and prints PLUGIN TRUST: full", async () => {
    const s = withPlugin({ source: PLUGIN_SOURCE.replace('limitations: ["acme: from options"]', 'limitations: [`acme: in process ${process.env.ACME_PROBE ?? "no env"}`]') });
    const added = await cli(s, ["plugin", "add", USE, "--trust", "full", "--yes"]);
    expect(added.out).toContain("  trust         full: IN THIS PROCESS, with your environment and files (every command prints PLUGIN TRUST: full)");
    const line = "PLUGIN TRUST: full (acme@1.2.3 runs with your environment and files)";
    const reg = await cli(s, ["register"]);
    expect(reg.code).toBe(0);
    expect(reg.out).toContain(`  ${line}`);
    process.env.ACME_PROBE = "real env";
    try {
      const dry = await cli(s, ["freeze", "--dry-run"], { env: process.env });
      expect(dry.out).toContain(`ERR ${line}`);
      expect(dry.out).toContain("  limitation: acme: in process real env");
    } finally {
      delete process.env.ACME_PROBE;
    }
    const v = await cli(s, ["verify", "--offline"]);
    expect(v.out).toContain(line);
    expect(JSON.parse(readFileSync(join(s.dir, W, "registration.json"), "utf8")).record.plugins.provider.trust).toBe("full");
  });
});

describe("trust: full loads only the pr-rla running it (finding 14)", () => {
  it("a copy of pr-rla in the plugin's node_modules, which the tree hash leaves out, is refused before the plugin is imported", async () => {
    const marker = join(tmpdir(), `prrla-unhashed-${process.pid}-${Date.now()}.txt`);
    const s = withPlugin({ source: `if (process.env.PR_RLA_HOST !== "1") await import("pr-rla");\n${PLUGIN_SOURCE}` });
    const copy = join(s.dir, "plugins", "acme", "node_modules", "pr-rla");
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, "package.json"), JSON.stringify({ name: "pr-rla", version: "0.1.0", type: "module", exports: "./index.js" }));
    writeFileSync(join(copy, "index.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "unhashed pr-rla ran in process");\n`);
    expect((await cli(s, ["plugin", "add", USE, "--trust", "full", "--yes"])).code).toBe(0);
    const before = readLock(s.dir).plugins[USE]!.treeSha256;
    appendFileSync(join(copy, "index.js"), "// changed\n");
    expect(treeSha256(resolvePlugin(USE, s.dir))).toBe(before);
    const r = await cli(s, ["freeze", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/plugin \.\/plugins\/acme\/index\.mjs would load pr-rla from .*plugins\/acme\/node_modules\/pr-rla, not the pr-rla running it \(.*\); that copy is not in its tree hash, so it is not run in this process/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("verify compares the provider it loads with the registered one (functional-design.md §U2b item 5)", () => {
  // KNOWN GAP, left as it is on purpose: finding 2 of the plugin and broker review. A provider whose
  // integrity differs from the registered one should make check 5 FAIL (and freeze refuse it); this
  // test pins today's WARN. The identity round, after the other branches merge, fixes it and this test.
  it("a plugin re-locked after registration rebuilds the population with a WARN naming the difference", async () => {
    const s = withPlugin();
    expect((await cli(s, ["plugin", "add", USE, "--yes"])).code).toBe(0);
    expect((await cli(s, ["register"])).code).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect((await cli(s, ["freeze"])).code).toBe(0);
    const clean = await cli(s, ["verify"]);
    expect(clean.out.find((l) => l.startsWith("5. "))).toMatch(/^5\. PASS population: population 6\/6 match/);
    const registered = readLock(s.dir).plugins[USE]!.treeSha256;
    appendFileSync(join(s.dir, "plugins", "acme", "index.mjs"), "// upgraded after registration\n");
    expect((await cli(s, ["plugin", "lock", USE, "--yes"])).code).toBe(0);
    const now = readLock(s.dir).plugins[USE]!.treeSha256;
    const v = await cli(s, ["verify"]);
    expect(v.out.find((l) => l.startsWith("5. "))).toMatch(/^5\. WARN population: population 6\/6 match/);
    expect(v.out).toContain(`        WARN the provider verify loaded is not the registered one (integrity ${registered.slice(0, 12)}… → ${now.slice(0, 12)}…): the population was rebuilt with it`);
  });
});

describe("plugin check: a correctness gate, never a safety gate (FR2.7)", () => {
  const ctxAtRoot = (s: Scenario): Partial<CommandContext> => ({ cwd: ROOT });

  it("passes the Gitea example through the host and says correctness, not safety", async () => {
    const s = setupAuditRepo({ changes: [] });
    const r = await cli(s, ["plugin", "check", "./examples/providers/gitea/index.mjs", "--offline"], ctxAtRoot(s));
    expect(r.code, text(r)).toBe(0);
    expect(r.out.slice(0, 6)).toEqual([
      "plugin check ./examples/providers/gitea/index.mjs: provider gitea@0.1.0 (path)",
      '  lock            not locked: run "pr-rla plugin add ./examples/providers/gitea/index.mjs" to trust it',
      "  npm signatures  not applicable: a path plugin is not from the npm registry",
      "  hosts           codeberg.org (with no options: not named in .pr-rla.yml)",
      "  credentials     GITEA_TOKEN -> codeberg.org",
      "  conformance     the provider kit through the plugin host, on 1 recorded fixture(s)",
    ]);
    expect(r.out).toContain("    ok   codeberg-forgejo-docs-2026-10-01.json › transient-faults");
    expect(r.out).toContain("  conformance     PASS");
    expect(r.out[r.out.length - 1]).toBe(CORRECTNESS_NOT_SAFETY);
    expect(CORRECTNESS_NOT_SAFETY).toBe("conformance = correctness, not safety: a malicious plugin can pass it");
  });

  it("fails on a fixture the plugin does not satisfy, and with no fixtures at all", async () => {
    const s = setupAuditRepo({ changes: [] });
    const rec = JSON.parse(readFileSync(join(ROOT, "examples", "providers", "gitea", "fixtures", "codeberg-forgejo-docs-2026-10-01.json"), "utf8"));
    rec.expected.ids = rec.expected.ids.slice(1);
    const bad = join(s.dir, "wrong-ids.json");
    writeFileSync(bad, JSON.stringify(rec));
    const plugin = join(s.dir, "plugin");
    cpSync(join(ROOT, "examples", "providers", "gitea", "index.mjs"), join(plugin, "index.mjs"));
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "gitea-copy", version: "0.0.1" }));
    const r = await cli(s, ["plugin", "check", "./plugin/index.mjs", "--offline", "--fixture", "wrong-ids.json"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("  conformance     FAIL");
    expect(text(r)).toMatch(/FAIL wrong-ids\.json › pagination: ids: missing 0 \(\), extra 1/);
    const none = await cli(s, ["plugin", "check", "./plugin/index.mjs", "--offline"]);
    expect(none.code).toBe(1);
    expect(text(none)).toMatch(/conformance {5}not run: no fixtures/);
    expect(none.out[none.out.length - 1]).toBe(CORRECTNESS_NOT_SAFETY);
  });
});

describe("plugin check runs the ledger kit for a ledger (finding 15)", () => {
  const JIRA = "./examples/ledgers/jira/index.mjs";
  const ctxAtRoot: Partial<CommandContext> = { cwd: ROOT };

  it("on the Jira example's recorded hibernate.atlassian.net changelogs, through the host; it used to exit 1 without running", async () => {
    const s = setupAuditRepo({ changes: [] });
    const r = await cli(s, ["plugin", "check", JIRA, "--kind", "ledger", "--offline"], ctxAtRoot);
    expect(r.code, text(r)).toBe(0);
    expect(r.out).toContain("  conformance     the ledger kit through the plugin host, on 2 recorded fixture(s)");
    for (const c of ["api-version", "normalization", "first-label", "integrity", "transient-faults"]) expect(r.out).toContain(`    ok   hibernate-first-verdicts.json › ${c}`);
    expect(r.out).toContain("    ok   hibernate-removal-HHH-14722.json › removal");
    expect(r.out).toContain("  conformance     PASS");
    expect(r.out[r.out.length - 1]).toBe(CORRECTNESS_NOT_SAFETY);
  });

  it("fails on a recording whose expectation the ledger does not meet, and runs nothing without fixtures", async () => {
    const s = setupAuditRepo({ changes: [] });
    const rec = JSON.parse(readFileSync(join(ROOT, "examples", "ledgers", "jira", "fixtures", "hibernate-removal-HHH-14722.json"), "utf8"));
    rec.expected.counted["1"] = null;
    const bad = join(s.dir, "wrong-counted.json");
    writeFileSync(bad, JSON.stringify(rec));
    const plugin = join(s.dir, "ledger");
    cpSync(join(ROOT, "examples", "ledgers", "jira", "index.mjs"), join(plugin, "index.mjs"));
    writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "jira-copy", version: "0.0.1", type: "module" }));
    const r = await cli(s, ["plugin", "check", "./ledger/index.mjs", "--kind", "ledger", "--offline", "--fixture", "wrong-counted.json"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/FAIL wrong-counted\.json › first-label: draw #1: counted .*expected none/);
    expect(r.out).toContain("  conformance     FAIL");
    // Named in .pr-rla.yml, so it is asked with the audit's options, and it lists no fixtures.
    appendFileSync(join(s.dir, ".pr-rla.yml"), "ledger:\n  use: ./ledger/index.mjs\n  options: { base_url: https://acme.atlassian.net, project: AUD, field: customfield_10050 }\n");
    const none = await cli(s, ["plugin", "check", "./ledger/index.mjs", "--offline"]);
    expect(none.code).toBe(1);
    expect(text(none)).toMatch(/conformance {5}not run: no fixtures \(list recorded ledger fixtures/);
  });
});

describe("pr-rla.lock.json format", () => {
  it("a lock with another schema or a malformed entry is refused by name", async () => {
    const s = withPlugin();
    writeFileSync(join(s.dir, LOCK_FILE), JSON.stringify({ schema: "pr-rla/lock/v9", plugins: {} }));
    expect(() => readLock(s.dir)).toThrow(/schema "pr-rla\/lock\/v9"; this pr-rla reads pr-rla\/lock\/v1/);
    writeFileSync(join(s.dir, LOCK_FILE), JSON.stringify({ schema: "pr-rla/lock/v1", plugins: { [USE]: { source: "path", name: "acme", treeSha256: "x" } } }));
    expect(text(await cli(s, ["register"]))).toMatch(/plugin \.\/plugins\/acme\/index\.mjs: version must be a string or null/);
  });
});
