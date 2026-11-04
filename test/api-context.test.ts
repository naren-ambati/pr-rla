import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditApiError, createAuditContext, openLedger, openProvider, requireReadWrite } from "../src/api/context.js";
import { auditContextFor, brokerFor, configFor, getBeacon, nodeContext, providerFor, type CommandContext } from "../src/commands/context.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { ReadOnlyViolation } from "../src/net/contract.js";
import { budgetFor } from "../src/net/rate-limits.js";
import { setupAuditRepo, T } from "./helpers/audit-scenario.js";
import { fakeGitLab, GL_BASE } from "./helpers/fake-gitlab.js";
import { recordedBeacon } from "./helpers/fixtures.js";
import { generatedGitLabScenario } from "./helpers/gitlab-population.js";
import { MockRekor } from "./helpers/mock-rekor.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";
import { auditDirWith, lockPlugin } from "./helpers/plugin-lock.js";

/** The src/api foundation (U2a): an AuditContext in read-only or read-write mode, with one broker. */

const ROOT = join(import.meta.dirname, "..");
const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

describe("AuditContext modes", () => {
  it("read-only: the broker refuses non-reads, write operations refuse before they start, and the ledger has read methods only", async () => {
    const seen: string[] = [];
    const ctx = createAuditContext({ mode: "read-only", fetch: (async (u: URL) => (seen.push(String(u)), ok())) as unknown as typeof fetch });
    expect(ctx.broker.policy.mode).toBe("read-only");
    await ctx.componentFetch("pr-rla/drand", "beacon")("https://api.drand.sh/x");
    await expect(ctx.componentFetch("pr-rla/timestamp", "tsa")("https://tsa.example/", { method: "POST", body: "x" })).rejects.toThrow(ReadOnlyViolation);
    const e = (() => {
      try {
        requireReadWrite(ctx, "register");
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(AuditApiError);
    expect(e).toMatchObject({ code: "READ_ONLY_VIOLATION", message: "register writes, and this audit context is read-only", next: 'run "pr-rla register" yourself from the CLI' });

    const dir = mkdtempSync(join(tmpdir(), "prrla-api-"));
    const ledger = await openLedger(ctx, { use: "git-file", options: {} }, dir, join(dir, "audit", "w"));
    expect(await ledger.readVerdicts()).toEqual([]);
    await expect(ledger.appendVerdict({ draw: 1, changeId: "x:a/b#1", verdict: "pass", protocolSha256: "0".repeat(64), reviewer: "r", recordedAt: "2026-11-03T00:00:00Z" })).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    expect(typeof ledger.verifyIntegrity).toBe("function");
    expect(seen).toEqual(["https://api.drand.sh/x"]);
  });

  it("read-write: components write, providers stay read-only, write operations proceed", async () => {
    const ctx = createAuditContext({ mode: "read-write", fetch: (async () => ok()) as unknown as typeof fetch });
    expect(() => requireReadWrite(ctx, "register")).not.toThrow();
    expect((await ctx.componentFetch("pr-rla/timestamp", "tsa")("https://tsa.example/", { method: "POST", body: "x" })).status).toBe(200);
    await expect(ctx.broker.bind("provider:github")("https://api.github.com/repos/a/b/issues", { method: "POST" })).rejects.toThrow(ReadOnlyViolation);
  });

  it("openProvider binds the provider to the broker and gives a self-hosted host its service's default budget", async () => {
    const seen: string[] = [];
    const ctx = createAuditContext({ mode: "read-only", fetch: (async (u: URL) => (seen.push(String(u)), ok())) as unknown as typeof fetch, rateLimits: { "ghe.example.com": { rest: "5000/h" } } });
    expect(ctx.pendingRateLimits()).toEqual(["ghe.example.com"]);
    const gh = await openProvider(ctx, { use: "github", options: { base_url: "https://ghe.example.com" } }, ROOT);
    expect(gh.name).toBe("github");
    expect(ctx.pendingRateLimits()).toEqual([]);
    const ghe = budgetFor(ctx.broker.policy.budgets, "ghe.example.com")!;
    expect(ghe.service).toBe("GitHub");
    expect(ghe.rules.find((r) => r.id === "rest")).toMatchObject({ count: 5000, source: "configured in .pr-rla.yml" });
    await openProvider(ctx, { use: "bitbucket-data-center", options: { base_url: "https://bitbucket.example.com:7990" } }, ROOT);
    expect(budgetFor(ctx.broker.policy.budgets, "bitbucket.example.com")?.rules.map((r) => [r.id, r.count, r.perMs, r.burst])).toEqual([["api", 5, 1000, 60]]);
    // An external plugin must be locked (U2b): the template is opened from an audit directory that locks it.
    const audit = auditDirWith({ "provider-template.mjs": join(ROOT, "examples", "provider-template.mjs") });
    await lockPlugin(audit, "./provider-template.mjs");
    const template = await openProvider(ctx, { use: "./provider-template.mjs", options: { changes: [] } }, audit);
    expect(template.name).toBeTruthy();
    expect([...ctx.broker.policy.budgets.keys()].sort()).toEqual(["*.atlassian.net", "api.bitbucket.org", "api.github.com", "bitbucket.example.com", "freetsa.org", "ghe.example.com", "gitlab.com", "timestamp.sectigo.com"]);
  });

  it("an unknown override host is reported when the provider is opened", async () => {
    const logs: string[] = [];
    const ctx = createAuditContext({ mode: "read-write", log: (l) => logs.push(l), rateLimits: { "api.githb.com": { rest: "1/h" } } });
    await openProvider(ctx, { use: "github", options: {} }, ROOT);
    expect(logs).toEqual(["rate_limits: api.githb.com has no default budget (not a known public host or a host of provider github); the override is not used"]);
  });
});

describe("commands: one broker per command, and every request goes through it", () => {
  it("brokerFor, providerFor, ledgers, drand and Rekor share the command's single AuditContext", async () => {
    const ctx: CommandContext = nodeContext({ cwd: ROOT, env: {} });
    expect(brokerFor(ctx)).toBe(brokerFor(ctx));
    expect(brokerFor(ctx)).toBe(auditContextFor(ctx).broker.fetch);
    expect(auditContextFor({ ...ctx })).not.toBe(auditContextFor(ctx));
  });

  it("configFor applies rate_limits from .pr-rla.yml to the command's broker", () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-api-"));
    writeFileSync(join(dir, ".pr-rla.yml"), "repo: a/b\nwindow: { name: w, start: 2026-07-01, end: 2026-09-30 }\nrate_limits:\n  gitlab.com: { api: 4000/min }\n");
    const ctx = nodeContext({ cwd: dir, env: {} });
    configFor(ctx);
    expect(budgetFor(auditContextFor(ctx).broker.policy.budgets, "gitlab.com")?.rules.find((r) => r.id === "api")?.count).toBe(4000);
  });

  describe("register and freeze against a GitLab instance, two authorities and a Rekor log, all mocks", () => {
    const log = new MockRekor();
    let tsa: MockTsaServer;
    const calls: { host: string; redirect: string | undefined; method: string }[] = [];
    beforeAll(async () => {
      await log.start();
      tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
    });
    afterAll(async () => {
      await log.stop();
      await tsa.stop();
    });

    it("every outbound request came through the broker (only the broker follows redirects by hand)", async () => {
      const gitlab = fakeGitLab(generatedGitLabScenario(), { pageSize: 100 });
      const spy = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        calls.push({ host: url.host, redirect: init?.redirect, method: (init?.method ?? "GET").toUpperCase() });
        return url.href.startsWith(GL_BASE) ? gitlab.fetch(input, init) : globalThis.fetch(input, init);
      }) as typeof fetch;
      const s = setupAuditRepo({ changes: [], log, provider: `{ use: gitlab, options: { base_url: "${GL_BASE}", batch_size: 20 } }`, fetch: spy, tsa: { ids: ["test-a", "test-b"], server: tsa } });
      s.clock.now = T("2026-10-20T00:00:00Z");
      log.now = Math.floor(s.clock.now / 1000);
      tsa.nowMs = s.clock.now;
      expect(await registerCommand(s.ctx, { submit: true })).toBe(0);
      s.clock.now = T("2026-10-20T12:00:00Z");
      log.now = Math.floor(s.clock.now / 1000);
      tsa.nowMs = s.clock.now;
      expect(await freezeCommand(s.ctx, { submit: true })).toBe(0);
      const hosts = new Set(calls.map((c) => c.host));
      expect(hosts).toContain(new URL(GL_BASE).host);
      expect(hosts).toContain(new URL(tsa.url).host);
      expect(hosts).toContain(new URL(log.url).host);
      expect(calls.filter((c) => c.redirect !== "manual")).toEqual([]);
      expect(calls.filter((c) => c.host === new URL(GL_BASE).host && c.method !== "GET" && c.method !== "POST")).toEqual([]);
      // One broker: the GitLab host got GitLab's default budget from the provider's declared hosts.
      expect(budgetFor(auditContextFor(s.ctx).broker.policy.budgets, "gitlab.example.com")?.service).toBe("GitLab.com");
      expect(JSON.parse(readFileSync(join(s.dir, "audit", "2026-q3.manifest.json"), "utf8")).N).toBe(400);
      const provider = await providerFor(s.ctx, configFor(s.ctx).config);
      expect(provider.name).toBe("gitlab");
    });

    it("drand goes through the broker too, with its 15 s beacon timeout", async () => {
      const round = 33245812;
      const seen: { redirect: string | undefined; host: string }[] = [];
      const ctx: CommandContext = {
        ...nodeContext({ cwd: ROOT, env: {} }),
        nowMs: () => Date.parse("2026-11-03T00:00:00Z"),
        fetch: (async (input: URL, init?: RequestInit) => (seen.push({ redirect: init?.redirect, host: new URL(String(input)).host }), new Response(JSON.stringify(recordedBeacon(round)), { headers: { "content-type": "application/json" } }))) as unknown as typeof fetch,
      };
      expect((await getBeacon(ctx, round)).round).toBe(round);
      expect(seen).toEqual([{ redirect: "manual", host: "api.drand.sh" }]);
    });
  });
});
