import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProgram } from "../src/cli.js";
import { checkpointCommand } from "../src/commands/checkpoint.js";
import type { CommandContext } from "../src/commands/context.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify } from "../src/commands/verify.js";
import { identityDiffs } from "../src/core/plugin-binding.js";
import { manifestSha256, type CommitmentRecordV2, type DrawsFile, type ManifestV2, type PluginIdentity, type RegistrationRecordV2, type SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { closeAllPluginHosts } from "../src/plugins/host.js";
import { optionsDigest, pluginIdentity } from "../src/registry.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * P1, "identity everywhere": the provider and the ledger every command runs must be the registration's
 * `plugins.provider` and `plugins.ledger` (name, source, files, trust, every option; an external plugin's
 * version). The reproductions of master-ledgers-review #1 and #2 and master-plugins-review #2, as tests.
 * Synthetic data: json-file populations, a fake GitHub tracker, mock timestamp authorities.
 */
const W = "audit/2026-q3";
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const writeJ = (s: Scenario, p: string, v: unknown) => writeFileSync(join(s.dir, p), `${JSON.stringify(v, null, 2)}\n`);
const check = (r: Awaited<ReturnType<typeof runVerify>>, n: number) => r.checks.find((c) => c.n === n)!;
const yml = (s: Scenario) => join(s.dir, ".pr-rla.yml");
const swapProvider = (s: Scenario, to: string) => writeFileSync(yml(s), readFileSync(yml(s), "utf8").replace(/^provider: .*$/m, `provider: ${to}`));

/** Runs the CLI in a fresh command context (one AuditContext per command, as in a real process). */
async function cli(s: Scenario, args: string[], extra: Partial<CommandContext> = {}): Promise<{ code: number; out: string[] }> {
  let code = -1;
  const from = s.out.length;
  await buildProgram(() => ({ ...s.ctx, ...extra }), (c) => (code = c)).parseAsync(["node", "pr-rla", ...args]);
  return { code, out: s.out.slice(from) };
}

afterAll(() => closeAllPluginHosts());

describe("the registered provider (master-ledgers-review #2, master-plugins-review #2)", () => {
  it("the old escape: github with no options and json-file have the same populationOptionsSha256, but not the same identity", async () => {
    const g = await pluginIdentity({ use: "github", options: {} }, "provider", "/tmp");
    const j = await pluginIdentity({ use: "json-file", options: { path: "forged.json" } }, "provider", "/tmp");
    // Before P1, check 5 FAILed only when both hashes differed, and noted nothing between two built-ins.
    expect(g.populationOptionsSha256).toBe(j.populationOptionsSha256);
    expect(identityDiffs(g, j)).toEqual([`name github → json-file`, `optionsSha256 ${g.optionsSha256.slice(0, 12)}… → ${j.optionsSha256.slice(0, 12)}…`]);
  });

  it("a built-in's version is the release that ran it and is not compared; an external plugin's is", () => {
    const base: PluginIdentity = { name: "github", source: "builtin", version: "0.1.0", integrity: null, optionsSha256: optionsDigest({}), populationOptionsSha256: optionsDigest({}), trust: "builtin" };
    expect(identityDiffs(base, { ...base, version: "0.2.0" })).toEqual([]);
    const ext: PluginIdentity = { ...base, name: "acme", source: "package", version: "1.2.3", integrity: "a".repeat(64), trust: "isolated" };
    expect(identityDiffs(ext, { ...ext, version: "1.2.4" })).toEqual(["version 1.2.3 → 1.2.4"]);
    expect(identityDiffs(ext, { ...ext, trust: "full" })).toEqual(["trust isolated → full"]);
  });

  it("registered github, swapped for json-file with a forged export: freeze refuses; a dry run notes it and writes nothing", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400), provider: "{ use: github, options: {} }" });
    expect(await registerCommand(s.ctx, {})).toBe(0);
    swapProvider(s, "{ use: json-file, options: { path: changes.json } }");
    s.clock.now = T("2026-10-20T12:00:00Z");
    await expect(freezeCommand(s.ctx, {})).rejects.toThrow(/^freeze refused: the provider in \.pr-rla\.yml is not the registered one \(name github → json-file; optionsSha256 [0-9a-f]{12}… → [0-9a-f]{12}…\)\. The registration names provider github \(builtin, trust builtin, options [0-9a-f]{12}…\)/);
    expect(existsSync(join(s.dir, `${W}.manifest.json`))).toBe(false);
    s.out.length = 0;
    expect(await freezeCommand(s.ctx, { dryRun: true })).toBe(0);
    expect(s.out.join("\n")).toMatch(/ERR note: the provider in \.pr-rla\.yml is not the registered one \(name github → json-file; .*a real freeze refuses it/);
  });

  it("records forged to match a forged export (registered github, frozen with json-file): verify FAILs check 5 on the manifest and on the provider it loaded, offline too", async () => {
    // What the review's auditee ships: the registration names github; manifest and commitment are re-signed with the
    // audit's own key around a json-file population. No authority is registered, so nothing else can tell.
    const s = setupAuditRepo({ changes: makeChanges(400) });
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const key = loadOrCreateKey(join(s.dir, ".pr-rla", "signing-key.pem"));
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
    const github = await pluginIdentity({ use: "github", options: {} }, "provider", s.dir);
    const forgedReg = { ...signRecord({ ...reg.record, plugins: { ...reg.record.plugins, provider: github } }, key), timestamps: [] };
    const m = readJ<ManifestV2>(s, `${W}.manifest.json`);
    const { sha256: _old, ...body } = { ...m, registrationSha256: forgedReg.sha256 };
    const manifest = { ...body, sha256: manifestSha256(body) };
    const cm = readJ<SignedRecord<CommitmentRecordV2>>(s, `${W}/manifest-commitment.json`);
    const commitment = { ...signRecord({ ...cm.record, registrationSha256: forgedReg.sha256, manifestSha256: manifest.sha256 }, key), timestamps: [] };
    writeJ(s, `${W}/registration.json`, forgedReg);
    writeJ(s, `${W}.manifest.json`, manifest);
    writeJ(s, `${W}/manifest-commitment.json`, commitment);
    s.clock.now = T("2026-10-21T01:00:00Z");
    const r = await runVerify(s.ctx, {});
    expect(check(r, 2).status).not.toBe("FAIL");
    expect(check(r, 5).status).toBe("FAIL");
    expect(check(r, 5).details).toContain(`FAIL the manifest was frozen with a provider that is not the registered one (name github → json-file; optionsSha256 ${github.optionsSha256.slice(0, 12)}… → ${m.provider.optionsSha256.slice(0, 12)}…): its population is not the registered stratum`);
    expect(check(r, 5).details.join("\n")).toMatch(/FAIL the provider in \.pr-rla\.yml is not the registered one \(name github → json-file; optionsSha256 [0-9a-f]{12}… → [0-9a-f]{12}…\): verify did not run it, so the population was not rebuilt/);
    expect(r.verdict).toBe("FAILED");
    const off = await runVerify(s.ctx, { offline: true });
    expect(check(off, 5).status).toBe("FAIL");
    expect(check(off, 5).summary).toBe("the manifest was frozen with a provider that is not the registered one");
  });

  it("an external plugin swapped after registration (master-plugins-review #2, the reviewer's swap.test.ts): freeze refuses it, nothing is written", async () => {
    const SOURCE = `import { defineProvider } from "pr-rla/provider";
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
    const USE = "./plugins/acme/index.mjs";
    const changes = makeChanges(6);
    const s = setupAuditRepo({ changes, provider: `{ use: ${USE}, options: ${JSON.stringify({ changes })} }` });
    mkdirSync(join(s.dir, "plugins", "acme"), { recursive: true });
    writeFileSync(join(s.dir, "plugins", "acme", "package.json"), JSON.stringify({ name: "acme-provider", version: "1.2.3", type: "module" }));
    writeFileSync(join(s.dir, "plugins", "acme", "index.mjs"), SOURCE);
    expect((await cli(s, ["plugin", "add", USE, "--yes"])).code).toBe(0);
    expect((await cli(s, ["register"])).code).toBe(0);
    // After registration: a plugin that silently drops the first change, re-locked.
    writeFileSync(join(s.dir, "plugins", "acme", "index.mjs"), SOURCE.replace("return { changes: (options.changes ?? [])", "return { changes: (options.changes ?? []).slice(1)"));
    expect((await cli(s, ["plugin", "lock", USE, "--yes"])).code).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    const f = await cli(s, ["freeze"]);
    // Before P1: "population 6 → 5, no note", and verify printed WARN, then VERIFIED.
    expect(f.code).toBe(1);
    expect(f.out.join("\n")).toMatch(/freeze refused: the provider in \.pr-rla\.yml is not the registered one \(integrity [0-9a-f]{12}… → [0-9a-f]{12}…\)/);
    expect(existsSync(join(s.dir, `${W}.manifest.json`))).toBe(false);
  });
});

describe("the registered ledger (master-ledgers-review #1)", () => {
  let tsa: MockTsaServer;
  let fake: FakeGitHubIssues;
  let honest: Scenario;
  const alice = { login: "alice", id: 11, type: "User" as const };
  const at = (s: Scenario, iso: string) => {
    s.clock.now = T(iso);
    tsa.nowMs = T(iso);
  };
  const withToken = (s: Scenario): Scenario => ((s.ctx.env = { GITHUB_TOKEN: "test-token" }), s);
  const clone = (s: Scenario) => withToken(cloneScenario(s));
  const LEDGER = "ledger: { use: github-issues, options: { repo: acme/audit } }\n";
  const swapLedger = (s: Scenario, to: string) => writeFileSync(yml(s), readFileSync(yml(s), "utf8").replace(LEDGER, `ledger: ${to}\n`));

  beforeAll(async () => {
    tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
    fake = new FakeGitHubIssues();
    honest = withToken(
      setupAuditRepo({
        changes: makeChanges(400),
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          return url.startsWith("https://api.github.com/") ? fake.fetch(input, init) : globalThis.fetch(input, init);
        }) as typeof fetch,
        tsa: { ids: ["test-a", "test-b"], server: tsa },
      }),
    );
    appendFileSync(yml(honest), LEDGER);
    honest.git("commit", "-qam", "ledger: github-issues");
    at(honest, "2026-10-20T00:00:00Z");
    expect(await registerCommand(honest.ctx, {})).toBe(0);
    at(honest, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(honest.ctx, {})).toBe(0);
    at(honest, "2026-10-21T01:00:00Z");
    expect(await sampleCommand(honest.ctx, {})).toBe(0);
    fake.setTime("2026-10-21T02:00:00Z");
    const draws = readJ<DrawsFile>(honest, `${W}/draws.json`);
    for (const d of draws.draws.slice(0, 36)) if (d.firstOccurrence) fake.label(fake.issueByDraw(d.draw).number, "pr-rla:pass", alice);
    at(honest, "2026-10-21T03:00:00Z");
    honest.git("add", "-A");
    honest.git("commit", "-qm", "draws and ledger index");
  }, 120_000);
  afterAll(async () => {
    await tsa.stop();
  });

  // The review's Jira case, on the built-in: the same ledger and option keys, pointed at a tracker the auditee controls.
  for (const [what, to, diff] of [
    ["the same ledger pointed at another tracker", "{ use: github-issues, options: { repo: acme/forged } }", /\(optionsSha256 [0-9a-f]{12}… → [0-9a-f]{12}…\)/],
    ["another built-in ledger", "{ use: gitlab-issues, options: { project: acme/audit } }", /\(name github-issues → gitlab-issues; optionsSha256 /],
  ] as const) {
    it(`${what}: sample, record, status and checkpoint refuse before the ledger is opened; verify FAILs check 7`, async () => {
      const s = clone(honest);
      swapLedger(s, to);
      const before = fake.requests.length;
      await expect(sampleCommand(s.ctx, { through: 40 })).rejects.toThrow(new RegExp(`^sample refused: the ledger in \\.pr-rla\\.yml is not the registered one ${diff.source}`));
      await expect(recordCommand(s.ctx, "1", "pass", {})).rejects.toThrow(/^record refused: the ledger in \.pr-rla\.yml is not the registered one/);
      await expect(statusCommand(s.ctx, {})).rejects.toThrow(/^status refused: the ledger in \.pr-rla\.yml is not the registered one/);
      await expect(checkpointCommand(s.ctx, {})).rejects.toThrow(/^checkpoint refused: the ledger in \.pr-rla\.yml is not the registered one/);
      // Nothing reached the registered tracker (nor any other) for the refused commands.
      expect(fake.requests.length).toBe(before);
      const r = await runVerify(s.ctx, {});
      expect(check(r, 7).status).toBe("FAIL");
      expect(check(r, 7).details.join("\n")).toMatch(new RegExp(`FAIL the ledger in \\.pr-rla\\.yml is not the registered one ${diff.source}`));
    });
  }

  it("the refusal says what to do next", async () => {
    const s = clone(honest);
    swapLedger(s, "{ use: github-issues, options: { repo: acme/forged } }");
    const e = (await statusCommand(s.ctx, {}).then(() => ({}), (x: unknown) => x)) as { next?: string; code?: string };
    expect(e.code).toBe("FAILED");
    expect(e.next).toMatch(/^restore the registered ledger and its options in \.pr-rla\.yml/);
  });

  it("a checkpoint records the registered ledger, and a line naming another ledger FAILs check 7", async () => {
    const s = clone(honest);
    expect(await checkpointCommand(s.ctx, {})).toBe(0);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
    const p = join(s.dir, W, "ledger-checkpoints.jsonl");
    const line = JSON.parse(readFileSync(p, "utf8").trim()) as { ledger: PluginIdentity };
    expect(line.ledger).toEqual(reg.record.plugins.ledger);
    expect(check(await runVerify(s.ctx, {}), 7).status).toBe("PASS");
    // The line as a checkpoint of the other tracker would have it (its tokens no longer cover it: rule 2 FAILs too).
    writeFileSync(p, `${JSON.stringify({ ...line, ledger: { ...line.ledger, optionsSha256: optionsDigest({ repo: "acme/forged" }) } })}\n`);
    const c7 = check(await runVerify(s.ctx, {}), 7);
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join("\n")).toMatch(/FAIL checkpoint 2026-10-21T03:00:00Z was taken of a ledger that is not the registered one \(optionsSha256 [0-9a-f]{12}… → [0-9a-f]{12}…\)/);
  });
});
