import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAuditContext, openProvider } from "../src/api/context.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import type { ManifestV2 } from "../src/core/records.js";
import { closeAllPluginHosts, credentialGrants } from "../src/plugins/host.js";
import { readLock } from "../src/plugins/lock.js";
import { providerTraits } from "../src/provider-traits.js";
import { optionsDigest, pluginIdentity } from "../src/registry.js";
import { assertProviderDefinition } from "../src/sdk/provider.js";
import { makeChanges, setupAuditRepo, T } from "./helpers/audit-scenario.js";
import { fakeGitea } from "./helpers/fake-gitea.js";
import { auditDirWith, lockPlugin } from "./helpers/plugin-lock.js";
import { scenarioExpectations, scmScenario } from "./helpers/scm-scenario.js";

/**
 * Integration of U2b (the isolated plugin host) and U3 (the SDK carry-overs): the definition's U3
 * traits cross the host in `describe` (pr-rla/ipc/v1), and a self-hosted isolated plugin's credential
 * follows its validated URL option (`hostFromOption`), recorded in pr-rla.lock.json.
 */

const ROOT = join(import.meta.dirname, "..");
const GITEA = join(ROOT, "examples", "providers", "gitea");
const USE = "./gitea/index.mjs";
/** A temp audit directory holding a copy of the Gitea example (its module and package.json only). */
const giteaAudit = () => auditDirWith({ "gitea/index.mjs": join(GITEA, "index.mjs"), "gitea/package.json": join(GITEA, "package.json") });
const BOTS = ["agent-bot", "review-bot", "merge-bot"];

afterAll(() => closeAllPluginHosts());

describe("provider traits across the plugin host (U3 fields over describe)", () => {
  it("the Gitea plugin's reviewGranularity, populationOptions and reportsLandedVia are read from the child when it runs isolated", async () => {
    const dir = giteaAudit();
    const options = { base_url: "https://forge.example.com", bots: BOTS, page_size: 3 };
    await lockPlugin(dir, USE, { options });
    expect(readLock(dir).plugins[USE]!.trust).toBe("isolated");
    expect(await providerTraits({ use: USE, options }, dir)).toEqual({ name: "gitea", reviewGranularity: "submission", reportsLandedVia: false, populationOptions: ["base_url", "bots"] });
    // The registration's identity hashes exactly those keys: page_size is not one of them.
    const id = await pluginIdentity({ use: USE, options }, "provider", dir);
    expect(id).toMatchObject({ name: "gitea", source: "path", trust: "isolated", integrity: readLock(dir).plugins[USE]!.treeSha256 });
    expect(id.populationOptionsSha256).toBe(optionsDigest(options, ["base_url", "bots"]));
    expect(id.optionsSha256).toBe(optionsDigest(options));
    expect(id.populationOptionsSha256).not.toBe(id.optionsSha256);
    // builtin-only refuses before anything is started.
    await expect(providerTraits({ use: USE, options }, dir, "builtin-only")).rejects.toMatchObject({ code: "BUILTIN_ONLY" });
  });

  // A plugin that refuses to run in pr-rla's own process: there PR_RLA_HOST is unset. If register, freeze or
  // verify imported it to read its traits, they would fail with its error.
  const pluginSource = (reviewGranularity: string) => `import { defineProvider } from "pr-rla/provider";
if (process.env.PR_RLA_HOST !== "1") throw new Error("traits plugin: imported outside the plugin host");
export default defineProvider({
  providerApiVersion: 1,
  name: "traits",
  reviewGranularity: ${JSON.stringify(reviewGranularity)},
  reportsLandedVia: false,
  populationOptions: ["scope"],
  create(options) {
    return {
      apiVersion: 1,
      name: "traits",
      async listChanges(req) {
        const o = Date.parse(req.window.opensAt), c = Date.parse(req.window.closesAt);
        return { changes: (options.changes ?? []).filter((x) => req.kinds.includes(x.kind) && Date.parse(x.mergedAt) >= o && Date.parse(x.mergedAt) < c), defaultBranch: "main", limitations: [] };
      },
    };
  },
});
`;
  const TRAITS_USE = "./plugins/traits/index.mjs";
  const withTraitsPlugin = (reviewGranularity: string) => {
    const changes = makeChanges(6);
    const options = { scope: "all", changes };
    const s = setupAuditRepo({ changes, provider: `{ use: ${TRAITS_USE}, options: ${JSON.stringify(options)} }` });
    mkdirSync(join(s.dir, "plugins", "traits"), { recursive: true });
    writeFileSync(join(s.dir, "plugins", "traits", "package.json"), JSON.stringify({ name: "traits-provider", version: "0.0.1", type: "module" }));
    writeFileSync(join(s.dir, "plugins", "traits", "index.mjs"), pluginSource(reviewGranularity));
    const cfg = join(s.dir, ".pr-rla.yml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace(/^selector: .*$/m, "selector: { kinds: [pull_request, direct_push], authors: any, unreviewed: no-human-review, direct_push_via_merge: exclude }"));
    return { s, options };
  };

  it("register, freeze and verify read an isolated plugin's traits through its host, never by importing it", async () => {
    const { s, options } = withTraitsPlugin("first-comment-per-user");
    await lockPlugin(s.dir, TRAITS_USE, { options });
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    // reportsLandedVia came from the child: register warns that exclude has no effect.
    expect(s.out.join("\n")).toMatch(/warning: provider traits does not report landedVia; direct_push_via_merge has no effect/);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const m = JSON.parse(readFileSync(join(s.dir, "audit", "2026-q3.manifest.json"), "utf8")) as ManifestV2;
    expect(m.provider).toMatchObject({ name: "traits", source: "path", trust: "isolated", reviewGranularity: "first-comment-per-user", populationOptionsSha256: optionsDigest(options, ["scope"]) });
    const c5 = (await runVerify(s.ctx, { offline: false })).checks.find((c) => c.n === 5)!;
    expect(c5.status).toBe("PASS");
  });

  it("the parent validates the traits a child reports with the SDK's own check", async () => {
    const { s, options } = withTraitsPlugin("per-comment");
    await expect(lockPlugin(s.dir, TRAITS_USE, { options })).rejects.toMatchObject({ code: "PLUGIN_INVALID", message: expect.stringMatching(/reviewGranularity must be "submission" or "first-comment-per-user"/) });
  });
});

describe("credentials for a self-hosted isolated plugin (hostFromOption, provider API version 1)", () => {
  const SECRET = "gitea-token-0123456789abcdef";
  const sc = scmScenario();
  const x = scenarioExpectations("gitea");
  const options = { base_url: "https://forge.example.com", page_size: 3, bots: BOTS };
  const contextWith = (fetchImpl: typeof fetch) => createAuditContext({ mode: "read-write", env: { GITEA_TOKEN: SECRET }, fetch: fetchImpl, sleep: async () => {} });
  /** The fake Gitea at forge.example.com, recording each request's Authorization header. */
  const recordingGitea = () => {
    const fake = fakeGitea(sc, { limit: 3 });
    const seen: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return fake.fetch(input, init);
    }) as typeof fetch;
    return { fetch: f, seen };
  };

  it("plugin add records the base_url host for GITEA_TOKEN, and the broker swaps the placeholder there", async () => {
    const dir = giteaAudit();
    await lockPlugin(dir, USE, { options });
    expect(readLock(dir).plugins[USE]!.credentials).toEqual([{ env: "GITEA_TOKEN", hosts: ["forge.example.com"], hostFromOption: "base_url" }]);
    const gitea = recordingGitea();
    const provider = await openProvider(contextWith(gitea.fetch), { use: USE, options }, dir);
    const r = await provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] });
    expect(r.changes.map((c) => c.id).sort()).toEqual([...x.all].sort());
    expect(gitea.seen.length).toBeGreaterThan(10);
    expect(new Set(gitea.seen)).toEqual(new Set([`token ${SECRET}`]));
  });

  it("without base_url, GITEA_TOKEN keeps its declared host, codeberg.org", async () => {
    const dir = giteaAudit();
    await lockPlugin(dir, USE, { options: {} });
    expect(readLock(dir).plugins[USE]!).toMatchObject({ hosts: ["codeberg.org"], credentials: [{ env: "GITEA_TOKEN", hosts: ["codeberg.org"] }] });
    expect(readLock(dir).plugins[USE]!.credentials[0]).not.toHaveProperty("hostFromOption");
  });

  it("a base_url changed after plugin add is refused at load, naming the credential", async () => {
    const dir = giteaAudit();
    await lockPlugin(dir, USE, { options });
    const gitea = recordingGitea();
    await expect(openProvider(contextWith(gitea.fetch), { use: USE, options: { ...options, base_url: "https://other.example.com" } }, dir)).rejects.toMatchObject({
      code: "LOCK_MISMATCH",
      message: expect.stringMatching(/asks for host other\.example\.com, credential GITEA_TOKEN for other\.example\.com, which its lock entry does not grant/),
    });
    expect(gitea.seen).toEqual([]);
  });

  it("an http:// base_url grants the token no host: the request carrying it is refused unsent", async () => {
    const dir = giteaAudit();
    const http = { ...options, base_url: "http://forge.example.com" };
    await lockPlugin(dir, USE, { options: http });
    expect(readLock(dir).plugins[USE]!.credentials).toEqual([{ env: "GITEA_TOKEN", hosts: [], hostFromOption: "base_url" }]);
    const gitea = recordingGitea();
    const provider = await openProvider(contextWith(gitea.fetch), { use: USE, options: http }, dir);
    await expect(provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request"] })).rejects.toThrow(/credential GITEA_TOKEN may be sent only to no host, not forge\.example\.com; nothing was sent/);
    expect(gitea.seen).toEqual([]);
  });

  it("the SDK checks the field; pr-rla computes the host from the option itself", () => {
    const def = { providerApiVersion: 1, name: "x", create: () => ({}) };
    expect(() => assertProviderDefinition({ ...def, credentials: [{ env: "T", hosts: ["a.example"], hostFromOption: 3 }] }, "x")).toThrow(/hostFromOption must name an option/);
    expect(() => assertProviderDefinition({ ...def, credentials: [{ env: "T", hosts: ["a.example"], hostFromOption: "base_url" }] }, "x")).not.toThrow();
    const c = [{ env: "T", hosts: ["a.example"], hostFromOption: "base_url" }];
    expect(credentialGrants(c, { base_url: "https://git.example.com:8443/gitea/" })).toEqual([{ env: "T", hosts: ["git.example.com:8443"], hostFromOption: "base_url" }]);
    expect(credentialGrants(c, { base_url: "git.example.com" })).toEqual([{ env: "T", hosts: [], hostFromOption: "base_url" }]);
    expect(credentialGrants(c, { base_url: null })).toEqual([{ env: "T", hosts: ["a.example"] }]);
    expect(credentialGrants([{ env: "T", hosts: ["b.example", "a.example"] }], { base_url: "https://elsewhere.example" })).toEqual([{ env: "T", hosts: ["a.example", "b.example"] }]);
  });
});
