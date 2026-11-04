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
    await expect(createProvider({ use: "no-such-provider-pkg", options: {} }, pctx(dir))).rejects.toThrow(/cannot load provider "no-such-provider-pkg".*Built-in providers: github, gitlab, bitbucket-cloud, bitbucket-data-center, json-file/);
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
  // Every .ts file under src/<dir>, subdirectories included (src/core/presence is part of the core).
  const filesOf = (dir: string): string[] =>
    (readdirSync(join(ROOT, "src", dir), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f.split("\\").join("/")}`);
  const importsOf = (dir: string) =>
    filesOf(dir).flatMap((file) => [...readFileSync(join(ROOT, "src", file), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => ({ file, spec: m[1]! })));

  it("the core imports no provider, ledger, registry or command module", () => {
    const bad = importsOf("core").filter((i) => /providers\/|ledgers\/|registry|commands\/|octokit/.test(i.spec));
    expect(bad).toEqual([]);
  });

  it("the core never mentions a concrete SCM's API", () => {
    const hits = filesOf("core").filter((f) => /graphql|api\.github\.com|pullRequest\(/i.test(readFileSync(join(ROOT, "src", f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("PresenceVerifier (src/core/presence) is pure: node:crypto, the core and the SDK only (functional-design.md §U9)", () => {
    const presence = importsOf("core/presence");
    expect(presence.map((i) => i.file)).toContain("core/presence/sshsig.ts");
    // Allowed: node:crypto, its own modules, other core modules (../x.js) and the SDK (../../sdk/x.js); nothing else.
    const bad = presence.filter((i) => !(i.spec === "node:crypto" || /^\.\/[a-z-]+\.js$/.test(i.spec) || /^\.\.\/(\.\.\/sdk\/)?[a-z-]+\.js$/.test(i.spec)));
    expect(bad).toEqual([]);
    // Nothing it reaches, transitively, spawns a process, opens a file or a socket, or calls fetch.
    const reach = (file: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(file)) return seen;
      seen.add(file);
      for (const m of readFileSync(join(ROOT, "src", file), "utf8").matchAll(/^(?:import|export) (?!type )[^;]*?from\s+"(\.[^"]+)"/gm)) reach(join(file, "..", m[1]!).replace(/\.js$/, ".ts"), seen);
      return seen;
    };
    const closure = [...reach("core/presence/index.ts")];
    expect(closure).toContain("sdk/ledger.ts");
    const io = closure.filter((f) => /child_process|node:fs|node:net|node:http|node:dns|\bfetch\(|execFile|spawn\(/.test(readFileSync(join(ROOT, "src", f), "utf8")));
    expect(io).toEqual([]);
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
