import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAuditContext, openLedger, openProvider } from "../src/api/context.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import type { ManifestV2 } from "../src/core/records.js";
import { ledgerTraits } from "../src/ledger-traits.js";
import { HostNotAllowed } from "../src/net/contract.js";
import { closeAllPluginHosts, credentialGrants, hostedLedger, startPluginHost, type PluginHost } from "../src/plugins/host.js";
import { readGrants, readLock, resolvePlugin } from "../src/plugins/lock.js";
import { ledgerIndexStore } from "../src/plugins/open.js";
import { providerTraits } from "../src/provider-traits.js";
import { optionsDigest, pluginIdentity } from "../src/registry.js";
import { verdictIneligibility, type DrawForLedger, type LedgerContext, type LedgerDefinition, type PublishContext } from "../src/sdk/ledger.js";
import { actorMatches } from "../src/core/selector.js";
import { assertProviderDefinition } from "../src/sdk/provider.js";
import { formatLedgerConformanceReport, runLedgerConformance, type LedgerFixture, type LedgerUnderTest } from "../src/testing/index.js";
import { makeChanges, setupAuditRepo, T } from "./helpers/audit-scenario.js";
import { fakeGitea } from "./helpers/fake-gitea.js";
import { auditDirWith, lockPlugin } from "./helpers/plugin-lock.js";
import { scenarioExpectations, scmScenario } from "./helpers/scm-scenario.js";

/**
 * Integration of wave 1: U2b (the isolated plugin host), U3 (the SDK carry-overs) and U4 (issue
 * ledgers). The definition's U3 traits and a ledger's provenance cross the host in `describe`
 * (pr-rla/ipc/v1); a self-hosted isolated plugin's credential follows its validated URL option
 * (`hostFromOption`), recorded in pr-rla.lock.json; and the Jira example ledger runs in the host,
 * its index kept by the parent.
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
    await lockPlugin(dir, USE, { options, approve: true });
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
    await lockPlugin(dir, USE, { options: http, approve: true });
    expect(readLock(dir).plugins[USE]!.credentials).toEqual([{ env: "GITEA_TOKEN", hosts: [], hostFromOption: "base_url" }]);
    const gitea = recordingGitea();
    const provider = await openProvider(contextWith(gitea.fetch), { use: USE, options: http }, dir);
    await expect(provider.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request"] })).rejects.toThrow(/credential GITEA_TOKEN may be sent only to no host over https, not http:\/\/forge\.example\.com; nothing was sent/);
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

describe("external ledgers through the plugin host (U4 with U2b)", () => {
  const EX = join(ROOT, "examples", "ledgers", "jira");
  const JIRA_USE = "./jira/index.mjs";
  const JIRA_OPTIONS = { base_url: "https://acme.atlassian.net", project: "AUD", field: "customfield_10050" };
  const jiraAudit = () => auditDirWith({ "jira/index.mjs": join(EX, "index.mjs"), "jira/package.json": join(EX, "package.json") });
  type FakeJira = { fetch: typeof fetch; requests: { method: string; url: string; authorization: string | null }[]; writes(): { method: string; url: string }[] };
  const fakeJira = async (): Promise<FakeJira> => new ((await import(pathToFileURL(join(EX, "test/fake-jira.mjs")).href)) as { FakeJira: new () => FakeJira }).FakeJira();
  const cases = async () => (await import(pathToFileURL(join(EX, "test/cases.mjs")).href)) as { jiraCases: (j: Pick<LedgerDefinition, "create">) => Promise<{ fixtures: LedgerFixture[]; factory: LedgerUnderTest }>; draw: (d: number, n: number) => DrawForLedger; PUB: PublishContext };

  /**
   * Fresh hosts started ahead of need, at most `width` starting at once. Every kit instance still gets
   * its own child, never one another instance used: what changes is that its start-up (0.2 s to over
   * 1 s on a loaded machine, and the kit makes about 67) overlaps the kit's work instead of adding to it.
   */
  function hostPool(start: () => Promise<PluginHost>, width: number) {
    const queued: Promise<PluginHost>[] = [];
    const started: Promise<PluginHost>[] = [];
    const used: PluginHost[] = [];
    const fill = () => {
      while (queued.length < width) {
        const h = start();
        h.catch(() => {});
        queued.push(h);
        started.push(h);
      }
    };
    return {
      async take(): Promise<PluginHost> {
        fill();
        const h = await queued.shift()!;
        fill();
        used.push(h);
        return h;
      },
      used: () => used.length,
      async closeAll() {
        for (const h of started) (await h.catch(() => null))?.close();
      },
    };
  }

  // Generous because its ~67 children compete for the machine with every other test file (measured 13 s to 42 s).
  it("the Jira example passes the ledger conformance kit with every instance in its own plugin host", { timeout: 240_000 }, async () => {
    const plugin = resolvePlugin("./examples/ledgers/jira/index.mjs", ROOT);
    const pool = hostPool(() => startPluginHost({ kind: "ledger", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "jira" }), 3);
    // A definition whose create() starts the ledger in a host child of its own: the kit's fake Jira and
    // its faults stay in this process, and the ledger's index is kept here (LedgerContext.index).
    const isolated: Pick<LedgerDefinition, "create"> = {
      async create(options: unknown, ctx: LedgerContext) {
        const host = await pool.take();
        return hostedLedger(host, options, { cwd: ctx.cwd, windowDir: ctx.windowDir, fetch: ctx.fetch, log: ctx.log, ...(ctx.sleep ? { sleep: ctx.sleep } : {}), ...(ctx.reviewers !== undefined ? { reviewers: ctx.reviewers } : {}), index: ledgerIndexStore({ mode: "read-write" }, ctx.windowDir) });
      },
    };
    try {
      const { fixtures, factory } = await (await cases()).jiraCases(isolated);
      const report = await runLedgerConformance(factory, fixtures);
      expect(report.ok, formatLedgerConformanceReport(report)).toBe(true);
      expect(fixtures.filter((f) => f.source === "recorded")).toHaveLength(2);
      const ran = new Set(report.results.filter((r) => !r.skipped).map((r) => r.check));
      for (const c of ["first-label", "relabel-same", "relabel-opposite", "removal", "deletion", "label-rename", "unlisted-reviewer", "app-applied", "verdict-before-seed", "pagination", "idempotent-publish", "checkpoint-round-trip", "transient-faults"]) expect(ran.has(c), c).toBe(true);
      expect(pool.used()).toBeGreaterThan(fixtures.length);
    } finally {
      await pool.closeAll();
    }
  });

  it("isolated, the Jira ledger gets placeholders, the broker builds Basic auth for the base_url host only, and pr-rla writes its index", async () => {
    const audit = jiraAudit();
    await lockPlugin(audit, JIRA_USE, { kind: "ledger", options: JIRA_OPTIONS, approve: true });
    expect(readLock(audit).plugins[JIRA_USE]).toMatchObject({
      trust: "isolated",
      hosts: ["acme.atlassian.net"],
      writePaths: ["acme.atlassian.net/rest/api/3/issue"],
      credentials: [
        { env: "JIRA_EMAIL", hosts: ["acme.atlassian.net"], hostFromOption: "base_url", secret: false },
        { env: "JIRA_TOKEN", hosts: ["acme.atlassian.net"], hostFromOption: "base_url" },
      ],
    });
    const fake = await fakeJira();
    const windowDir = mkdtempSync(join(tmpdir(), "prrla-jira-w-"));
    const actx = createAuditContext({ mode: "read-write", fetch: fake.fetch, env: { JIRA_EMAIL: "me@acme.example", JIRA_TOKEN: "tok-123" } });
    const l = await openLedger(actx, { use: JIRA_USE, options: JIRA_OPTIONS }, audit, windowDir);
    const { draw, PUB } = await cases();
    await l.publishDraws!([draw(1, 101), draw(2, 102)], PUB);
    await l.appendVerdict({ draw: 2, changeId: draw(2, 102).changeId, verdict: "fail", protocolSha256: PUB.protocolSha256, reviewer: "x", recordedAt: "2026-10-21T03:00:00Z" });
    expect(fake.writes().map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["POST /rest/api/3/issue", "POST /rest/api/3/issue", "PUT /rest/api/3/issue/AUD-2"]);
    expect((await l.readVerdicts()).map((v) => [v.draw, v.verdict, v.reviewer, v.provenance?.source])).toEqual([[2, "fail", "557058:writer", "jira-field-change"]]);
    const basic = `Basic ${Buffer.from("me@acme.example:tok-123").toString("base64")}`;
    expect(fake.requests.length).toBeGreaterThan(6);
    expect(fake.requests.every((r) => r.authorization === basic)).toBe(true);
    // The child cannot write files: the index on disk was written by pr-rla for it, through ctx.index.
    const index = JSON.parse(readFileSync(join(windowDir, "ledger-index.json"), "utf8")) as { issues: { draw: number; key: string }[] };
    expect(index.issues.map((i) => [i.draw, i.key])).toEqual([[1, "AUD-1"], [2, "AUD-2"]]);
    // Isolated, the ledger may contact only its locked hosts: elsewhere is refused before the credential step.
    await expect(actx.broker.bind("ledger:jira")("https://evil.example/rest/api/3/myself", { headers: { authorization: "prrla-basic:JIRA_EMAIL:JIRA_TOKEN" } })).rejects.toBeInstanceOf(HostNotAllowed);
  });

  // A ledger that refuses to run in pr-rla's own process: register, record and verify must read its
  // provenance and hosts without importing it.
  const TRACKER = `import { defineLedger } from "pr-rla/ledger";
if (process.env.PR_RLA_HOST !== "1") throw new Error("tracker ledger: imported outside the plugin host");
const site = (o) => {
  if (!o || typeof o.base_url !== "string") throw new Error("tracker: options.base_url is required");
  return new URL(o.base_url).host;
};
export default defineLedger({
  ledgerApiVersion: 1,
  name: "tracker",
  provenance: "account",
  hosts: (o) => [site(o)],
  create(o) {
    site(o);
    return { apiVersion: 1, name: "tracker", readVerdicts: async () => [], appendVerdict: async () => {} };
  },
});
`;
  const TRACKER_USE = "./plugins/tracker/index.mjs";
  const withTracker = () => {
    const s = setupAuditRepo({ changes: makeChanges(160) });
    mkdirSync(join(s.dir, "plugins", "tracker"), { recursive: true });
    writeFileSync(join(s.dir, "plugins", "tracker", "package.json"), JSON.stringify({ name: "tracker-ledger", version: "0.0.1", type: "module" }));
    writeFileSync(join(s.dir, "plugins", "tracker", "index.mjs"), TRACKER);
    const cfg = join(s.dir, ".pr-rla.yml");
    const setLedger = (options: string) => writeFileSync(cfg, `${readFileSync(cfg, "utf8").replace(/^ledger:\n(?:  .*\n)*/m, "")}ledger:\n  use: ${TRACKER_USE}\n  options: ${options}\n`);
    setLedger("{ base_url: https://tracker.example }");
    return { s, setLedger };
  };

  it("register's preflight, record and verify --offline read an isolated ledger through its host, never by importing it", async () => {
    const { s, setLedger } = withTracker();
    await lockPlugin(s.dir, TRACKER_USE, { kind: "ledger", options: { base_url: "https://tracker.example" } });
    expect(await ledgerTraits({ use: TRACKER_USE, options: { base_url: "https://tracker.example" } }, s.dir)).toEqual({ name: "tracker", provenance: "account", hosts: ["tracker.example"] });
    s.clock.now = T("2026-06-20T00:00:00Z");
    // The preflight runs hosts(), writePaths() and create() in the child; the provenance it reports is the default minimum.
    expect(await registerCommand(s.ctx, { dryRun: true })).toBe(0);
    expect(s.out.join("\n")).toMatch(/ledger tracker · verdict provenance account/);
    expect(await registerCommand(s.ctx, {})).toBe(0);
    // An account-provenance ledger needs no --reviewer: record gets past that check (and stops at the missing draws).
    await expect(recordCommand(s.ctx, "1", "pass", {})).rejects.toThrow(/draws/);
    const c7 = (await runVerify(s.ctx, { offline: true })).checks.find((c) => c.n === 7)!;
    expect(c7).toMatchObject({ status: "SKIP", summary: "offline: ledger tracker lives in tracker.example; run verify without --offline to check the verdicts" });
    // Options the ledger refuses fail the preflight with its own message, from the child.
    setLedger("{ base_url: 7 }");
    await expect(registerCommand(s.ctx, { dryRun: true })).rejects.toThrow(/ledger \.\/plugins\/tracker\/index\.mjs: .*tracker: options\.base_url is required/);
  });

  it("an unlocked external ledger is refused by register's preflight, naming plugin add", async () => {
    const { s } = withTracker();
    s.clock.now = T("2026-06-20T00:00:00Z");
    await expect(registerCommand(s.ctx, { dryRun: true })).rejects.toMatchObject({ code: "NOT_LOCKED", message: expect.stringMatching(/plugin \.\/plugins\/tracker\/index\.mjs is not locked; review it and run "pr-rla plugin add/) });
    expect(existsSync(join(s.dir, "pr-rla.lock.json"))).toBe(false);
  });
});

describe("registered reviewers match as U3's selectors do (U4 eligibility with Actor.id)", () => {
  // A GitHub label event by account 77, whose login was alice when registered and alice-renamed now.
  const event = (login: string, actorId?: string) => ({ reviewer: login, provenance: { level: "account" as const, source: "scm-label-event", ...(actorId !== undefined ? { actorId } : {}), viaApp: null } });
  const actor = (login: string, id?: string) => ({ login, kind: "human" as const, ...(id !== undefined ? { id } : {}) });
  const cases: [string, string, string | undefined, boolean][] = [
    ["id:77", "alice-renamed", "77", true], // an id entry survives a rename
    ["id:77", "alice", "78", false],
    ["id:77", "alice", undefined, false], // no id on the event: an id entry cannot match
    ["Alice", "alice", "77", true], // a login, case-insensitively
    ["77", "alice", "77", false], // a bare entry is a login, never an id
    ["77", "77", "1", true],
  ];
  it.each(cases)("%s against %s (id %s): counts = %s, the same answer as actorMatches", (entry, login, id, counts) => {
    expect(verdictIneligibility(event(login, id), [entry]) === null).toBe(counts);
    expect(actorMatches(actor(login, id), entry)).toBe(counts);
  });
});
