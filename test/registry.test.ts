import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLedger, createProvider, loadLedgerDefinition, loadProviderDefinition, unsafeCreateLedger, unsafeCreateProvider } from "../src/registry.js";
import { ProviderApiVersionError } from "../src/sdk/provider.js";
import { LedgerApiVersionError } from "../src/sdk/ledger.js";
import { runProviderConformance, formatConformanceReport } from "../src/testing/index.js";
import { readJsonFixture } from "./helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pctx = (cwd: string) => ({ cwd, env: {}, log: () => {}, fetch: globalThis.fetch });
const W = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };

describe("provider registry (bring-your-own providers)", () => {
  it("resolves built-ins and the json alias", async () => {
    expect((await loadProviderDefinition("github", ROOT)).name).toBe("github");
    expect((await loadProviderDefinition("json-file", ROOT)).name).toBe("json-file");
    expect((await loadProviderDefinition("json", ROOT)).name).toBe("json-file");
  });

  it("loads an external provider by path and it passes the conformance kit", async () => {
    const changes = readJsonFixture<{ changes: unknown[] }>("changes", "acme-2026-08-01.json").changes;
    const p = await unsafeCreateProvider({ use: "./examples/provider-template.mjs", options: { changes } }, pctx(ROOT));
    expect(p.name).toBe("example");
    const report = await runProviderConformance(p, [{ name: "template", request: { repo: "acme/widgets", window: W, kinds: ["pull_request", "direct_push"] }, expect: {} }]);
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });

  it("loads an external provider by package name, resolved from the audit repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-pkg-"));
    const pkg = join(dir, "node_modules", "pr-rla-provider-fake");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pr-rla-provider-fake", type: "module", exports: { ".": { import: "./index.mjs", default: "./index.mjs" } } }));
    writeFileSync(join(pkg, "index.mjs"), `export const provider = { providerApiVersion: 1, name: "fake", create: () => ({ apiVersion: 1, name: "fake", listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }) }) };`);
    const p = await unsafeCreateProvider({ use: "pr-rla-provider-fake", options: {} }, pctx(dir));
    expect(p.name).toBe("fake");
  });

  it("rejects a provider built for another API version, with a clear error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-ver-"));
    writeFileSync(join(dir, "v2.mjs"), `export default { providerApiVersion: 2, name: "future", create() {} };`);
    await expect(unsafeCreateProvider({ use: "./v2.mjs", options: {} }, pctx(dir))).rejects.toThrow(ProviderApiVersionError);
    await expect(unsafeCreateProvider({ use: "./v2.mjs", options: {} }, pctx(dir))).rejects.toThrow(/declares providerApiVersion 2; this pr-rla supports 1/);
    writeFileSync(join(dir, "lies.mjs"), `export default { providerApiVersion: 1, name: "lies", create: () => ({ apiVersion: 3, name: "lies", listChanges: async () => ({}) }) };`);
    await expect(unsafeCreateProvider({ use: "./lies.mjs", options: {} }, pctx(dir))).rejects.toThrow(/providerApiVersion 3/);
    writeFileSync(join(dir, "none.mjs"), `export const nothing = 1;`);
    await expect(unsafeCreateProvider({ use: "./none.mjs", options: {} }, pctx(dir))).rejects.toThrow(/defineProvider/);
    await expect(unsafeCreateProvider({ use: "no-such-provider-pkg", options: {} }, pctx(dir))).rejects.toThrow(/cannot load provider "no-such-provider-pkg".*Built-in providers: github, gitlab, bitbucket-cloud, bitbucket-data-center, json-file/);
  });

  it("ledgers plug in the same way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-ledger-"));
    const lctx = { ...pctx(dir), windowDir: join(dir, "audit", "w") };
    expect((await createLedger({ use: "git-file", options: {} }, lctx)).name).toBe("git-file");
    writeFileSync(join(dir, "mem.mjs"), `const ev = []; export default { ledgerApiVersion: 1, name: "memory", create: () => ({ apiVersion: 1, name: "memory", readVerdicts: async () => ev, appendVerdict: async (e) => void ev.push(e) }) };`);
    expect((await unsafeCreateLedger({ use: "./mem.mjs", options: {} }, lctx)).name).toBe("memory");
    writeFileSync(join(dir, "old.mjs"), `export default { ledgerApiVersion: 0, name: "old", create() {} };`);
    await expect(unsafeCreateLedger({ use: "./old.mjs", options: {} }, lctx)).rejects.toThrow(LedgerApiVersionError);
  });
});

describe("architecture boundaries", () => {
  const importsOf = (dir: string) =>
    readdirSync(join(ROOT, "src", dir))
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => [...readFileSync(join(ROOT, "src", dir, f), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => ({ file: `${dir}/${f}`, spec: m[1]! })));

  it("the core imports no provider, ledger, registry or command module", () => {
    const bad = importsOf("core").filter((i) => /providers\/|ledgers\/|registry|commands\/|octokit/.test(i.spec));
    expect(bad).toEqual([]);
  });

  it("the core never mentions a concrete SCM's API", () => {
    const hits = readdirSync(join(ROOT, "src", "core")).filter((f) => /graphql|api\.github\.com|pullRequest\(/i.test(readFileSync(join(ROOT, "src", "core", f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("the core imports no timestamp client, network module, API or plugin host (test-design.md §5)", () => {
    const bad = importsOf("core").filter((i) => /timestamp\/client|\/net\/|\/api\/|\/plugins\//.test(i.spec));
    expect(bad).toEqual([]);
    // The pure token verifier the core uses reaches no network code either (type-only imports aside).
    const closure = (file: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(file)) return seen;
      seen.add(file);
      const text = readFileSync(join(ROOT, "src", file), "utf8");
      for (const m of text.matchAll(/^import (?!type )[^;]*?from\s+"(\.[^"]+)"/gm)) closure(join(file, "..", m[1]!).replace(/\.js$/, ".ts"), seen);
      return seen;
    };
    const reach = [...closure("core/verify.ts")];
    expect(reach.filter((f) => /timestamp\/client|net\/|commands\/|registry/.test(f))).toEqual([]);
    expect(reach).toContain("timestamp/verify.ts");
  });

  it("the public SDKs are self-contained", () => {
    expect(importsOf("sdk").filter((i) => !i.spec.startsWith("./"))).toEqual([]);
    expect(importsOf("testing").filter((i) => !/^\.\.\/(sdk|core\/canonical)|^\.\//.test(i.spec))).toEqual([]);
  });
});

describe("config", () => {
  it("explains the unquoted [bot] YAML trap", async () => {
    const { parseConfig } = await import("../src/config.js");
    expect(() => parseConfig("repo: o/r\nwindow: { start: 2026-07-01, end: 2026-09-30 }\nselector:\n  authors: [copilot-swe-agent[bot]]\n", "/x/.pr-rla.yml")).toThrow(/quote logins that contain \[bot\]/);
    const c = parseConfig('repo: o/r\nwindow: { start: 2026-07-01, end: 2026-09-30 }\nselector:\n  authors: ["copilot-swe-agent[bot]"]\n', "/x/.pr-rla.yml");
    expect(c.selector.authors).toEqual(["copilot-swe-agent[bot]"]);
    expect(c.window).toMatchObject({ name: "2026-07-01_2026-09-30", opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" });
    expect(c.parameters).toEqual({ claim: "D", p0: 0.1, p1: 0.02, alpha: 0.05, cap: null, minPopulation: 150 });
    expect(() => parseConfig("repo: o/r\nwindow: { start: 2026-07-01, end: 2026-09-30 }\naudit: { claim: T }\n", "/x/.pr-rla.yml")).toThrow(/claim T/);
  });
});

describe("the public loaders run no external plugin in process unlocked (finding 14)", () => {
  it("createProvider, createLedger and the load*Definition exports refuse an external plugin, before importing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-unlocked-"));
    writeFileSync(join(dir, "boom.mjs"), 'throw new Error("IMPORTED: external code ran in process");\n');
    const ctx = { cwd: dir, env: {}, log: () => {}, fetch: globalThis.fetch };
    for (const run of [() => createProvider({ use: "./boom.mjs", options: {} }, ctx), () => loadProviderDefinition("./boom.mjs", dir), () => createLedger({ use: "./boom.mjs", options: {} }, { ...ctx, windowDir: dir }), () => loadLedgerDefinition("./boom.mjs", dir)])
      await expect(run()).rejects.toMatchObject({ code: "NOT_LOCKED", message: expect.stringMatching(/is an external plugin: open(Provider|Ledger) loads it, after checking pr-rla\.lock\.json and your approval, and runs it isolated/) });
    // The unsafe names do import it: they are for tests and plugin authors.
    await expect(unsafeCreateProvider({ use: "./boom.mjs", options: {} }, ctx)).rejects.toThrow(/IMPORTED/);
    const pkg = await import("../src/index.js");
    expect(typeof pkg.unsafeLoadLedgerDefinition).toBe("function");
    expect(typeof pkg.unsafeCreateProvider).toBe("function");
    expect(Object.keys(pkg).filter((k) => /^(create|load)(Provider|Ledger)/.test(k)).sort()).toEqual(["createLedger", "createProvider", "loadLedgerDefinition", "loadProviderDefinition"]);
  });
});

describe("scripts/record-fixture.mjs --cli imports no plugin (finding 14)", () => {
  it("names the provider from the built-ins or the lock, never by importing it", async () => {
    const { providerNameOf } = await import("../src/registry.js");
    const { lockPlugin } = await import("./helpers/plugin-lock.js");
    const dir = mkdtempSync(join(tmpdir(), "prrla-record-"));
    // Fine in the host (inspected there), fatal if imported in this process.
    writeFileSync(join(dir, "p.mjs"), 'if (process.env.PR_RLA_HOST !== "1") throw new Error("IMPORTED in process");\nexport default { providerApiVersion: 1, name: "locked-name", create() { return { apiVersion: 1, name: "locked-name", async listChanges() { return { changes: [], defaultBranch: "main" }; } }; } };\n');
    await lockPlugin(dir, "./p.mjs");
    expect(providerNameOf({ use: "./p.mjs", options: {} }, dir)).toBe("locked-name");
    expect(providerNameOf({ use: "json", options: {} }, dir)).toBe("json-file");
    expect(providerNameOf({ use: "./unlocked.mjs", options: {} }, dir)).toBeNull();
    const script = readFileSync(join(ROOT, "scripts", "record-fixture.mjs"), "utf8");
    const cli = script.slice(script.indexOf("if (cliMode) {"), script.indexOf("} else {", script.indexOf("if (cliMode) {")));
    expect(cli).toContain("providerNameOf(config.provider, cwd)");
    expect(cli).not.toMatch(/LoadProviderDefinition|import\(/);
  });
});
