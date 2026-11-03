import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLedger, createProvider, loadProviderDefinition } from "../src/registry.js";
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
    const p = await createProvider({ use: "./examples/provider-template.mjs", options: { changes } }, pctx(ROOT));
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
    const p = await createProvider({ use: "pr-rla-provider-fake", options: {} }, pctx(dir));
    expect(p.name).toBe("fake");
  });

  it("rejects a provider built for another API version, with a clear error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-ver-"));
    writeFileSync(join(dir, "v2.mjs"), `export default { providerApiVersion: 2, name: "future", create() {} };`);
    await expect(createProvider({ use: "./v2.mjs", options: {} }, pctx(dir))).rejects.toThrow(ProviderApiVersionError);
    await expect(createProvider({ use: "./v2.mjs", options: {} }, pctx(dir))).rejects.toThrow(/declares providerApiVersion 2; this pr-rla supports 1/);
    writeFileSync(join(dir, "lies.mjs"), `export default { providerApiVersion: 1, name: "lies", create: () => ({ apiVersion: 3, name: "lies", listChanges: async () => ({}) }) };`);
    await expect(createProvider({ use: "./lies.mjs", options: {} }, pctx(dir))).rejects.toThrow(/providerApiVersion 3/);
    writeFileSync(join(dir, "none.mjs"), `export const nothing = 1;`);
    await expect(createProvider({ use: "./none.mjs", options: {} }, pctx(dir))).rejects.toThrow(/defineProvider/);
    await expect(createProvider({ use: "no-such-provider-pkg", options: {} }, pctx(dir))).rejects.toThrow(/cannot load provider "no-such-provider-pkg".*Built-in providers: github, gitlab, bitbucket-cloud, json-file/);
  });

  it("ledgers plug in the same way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-ledger-"));
    const lctx = { ...pctx(dir), windowDir: join(dir, "audit", "w") };
    expect((await createLedger({ use: "git-file", options: {} }, lctx)).name).toBe("git-file");
    writeFileSync(join(dir, "mem.mjs"), `const ev = []; export default { ledgerApiVersion: 1, name: "memory", create: () => ({ apiVersion: 1, name: "memory", readVerdicts: async () => ev, appendVerdict: async (e) => void ev.push(e) }) };`);
    expect((await createLedger({ use: "./mem.mjs", options: {} }, lctx)).name).toBe("memory");
    writeFileSync(join(dir, "old.mjs"), `export default { ledgerApiVersion: 0, name: "old", create() {} };`);
    await expect(createLedger({ use: "./old.mjs", options: {} }, lctx)).rejects.toThrow(LedgerApiVersionError);
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
