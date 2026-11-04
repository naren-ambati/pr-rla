import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as read from "pr-rla/api/read";
import type { ApiContext } from "../src/api/session.js";
import { checkPlugin } from "../src/api/plugin-check.js";
import { checkpoint } from "../src/api/write/checkpoint.js";
import { freeze } from "../src/api/write/freeze.js";
import { initAudit } from "../src/api/write/init.js";
import { commitPluginLock, preparePluginAdd, preparePluginLock } from "../src/api/write/plugin.js";
import { record } from "../src/api/write/record.js";
import { register } from "../src/api/write/register.js";
import { sample } from "../src/api/write/sample.js";
import { buildProgram } from "../src/cli.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import type { DrawsFile } from "../src/core/records.js";
import { makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { fixturePath } from "./helpers/fixtures.js";
import { treeHash } from "./helpers/tree-hash.js";

/**
 * The audit API (functional-design.md §U5; contracts.md §1a, §7): its functions return the
 * objects `--json` prints, `pr-rla/api/read` is read-only, write functions refuse a read-only
 * context, and the offline read paths meet NFR10 on fixtures.
 */

const W = "audit/2026-q3";
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;

async function audit(n: number, opts: { verdicts?: number; ledger?: string; fetch?: typeof fetch } = {}): Promise<Scenario> {
  const s = setupAuditRepo({ changes: makeChanges(n), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  if (opts.ledger) {
    appendFileSync(join(s.dir, ".pr-rla.yml"), `ledger: ${opts.ledger}\n`);
    s.git("commit", "-qam", "ledger");
  }
  s.clock.now = T("2026-10-20T00:00:00Z");
  expect(await registerCommand(s.ctx, {})).toBe(0);
  s.clock.now = T("2026-10-20T12:00:00Z");
  expect(await freezeCommand(s.ctx, {})).toBe(0);
  s.clock.now = T("2026-10-21T01:00:00Z");
  expect(await sampleCommand(s.ctx, {})).toBe(0);
  const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
  for (const d of draws.draws.slice(0, opts.verdicts ?? 0)) if (d.firstOccurrence) await recordCommand(s.ctx, String(d.draw), "pass", { reviewer: "outside-reviewer" });
  s.git("add", "-A");
  s.git("commit", "-qm", "sampled");
  s.clock.now = T("2026-10-21T03:00:00Z");
  s.out.length = 0;
  return s;
}

/** The read subpath's options for a scenario: its clock and transport, nothing else. */
const opts = (s: Scenario, more: read.ReadOptions = {}): read.ReadOptions => ({ nowMs: () => s.clock.now, fetch: s.fetch, env: s.ctx.env, ...more });
const cli = async (s: Scenario, ...argv: string[]): Promise<{ code: number; out: string }> => {
  s.out.length = 0;
  let code = -1;
  await buildProgram(() => s.ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", ...argv]);
  return { code, out: s.out.filter((l) => !l.startsWith("ERR ")).join("\n") };
};

let gitFile: Scenario;
beforeAll(async () => {
  gitFile = await audit(400, { verdicts: 20 });
}, 120_000);

describe("API functions return the same objects as --json (contracts.md §7)", () => {
  it("status (a sampled window, part reviewed)", async () => {
    const r = await cli(gitFile, "status", "--json");
    expect(r.code).toBe(0);
    const api = await read.status({ dir: gitFile.dir }, opts(gitFile));
    expect(JSON.parse(r.out)).toEqual(api);
    expect(api).toMatchObject({ phase: "sampled", verdictsRead: true, drawsIssued: 36, mode: "RETROSPECTIVE" });
  });

  it("status in the earlier phases: unregistered, registered and frozen now print their result too", async () => {
    const s = setupAuditRepo({ changes: makeChanges(200) });
    s.clock.now = T("2026-09-01T00:00:00Z");
    let r = await cli(s, "status", "--json");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual(await read.status({ dir: s.dir }, opts(s)));
    expect(JSON.parse(r.out)).toMatchObject({ phase: "unregistered", line: 'not registered: window 2026-q3 (2026-07-01..2026-09-30). Run "pr-rla register".' });
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    r = await cli(s, "status", "--json", "--offline");
    expect(JSON.parse(r.out)).toEqual(await read.status({ dir: s.dir }, opts(s)));
    expect(JSON.parse(r.out)).toMatchObject({ phase: "registered", windowPhase: "window closed, not frozen", nSoFar: null });
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    r = await cli(s, "status", "--json");
    expect(JSON.parse(r.out)).toEqual(await read.status({ dir: s.dir }, opts(s)));
    expect(JSON.parse(r.out)).toMatchObject({ phase: "frozen", N: expect.any(Number), seedRound: 33245812 });
  });

  it("verify --offline", async () => {
    const r = await cli(gitFile, "verify", "--offline", "--json");
    expect(JSON.parse(r.out)).toEqual(await read.verify({ dir: gitFile.dir }, opts(gitFile)));
    expect(JSON.parse(r.out).checks).toHaveLength(7);
  });

  it("freeze --dry-run (freezePreview)", async () => {
    const r = await cli(gitFile, "freeze", "--dry-run", "--json");
    const api = await read.freezePreview({ dir: gitFile.dir }, opts(gitFile));
    expect(JSON.parse(r.out)).toEqual(api);
    expect(api).toMatchObject({ dryRun: true, N: 400, provider: "json-file", registrationSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("simulate", async () => {
    const r = await cli(gitFile, "simulate", "--population", "400", "--defects", "40", "--runs", "500", "--json");
    expect(JSON.parse(r.out)).toEqual(await read.simulate({ population: 400, defects: 40, runs: 500 }));
  });

  it("the CLI text is the API's line: status prints the result's line first", async () => {
    const r = await cli(gitFile, "status");
    const api = await read.status({ dir: gitFile.dir }, opts(gitFile));
    expect(r.out.split("\n")[0]).toBe(api.line);
  });
});

describe("write functions refuse a read-only context (READ_ONLY_VIOLATION), before writing anything", () => {
  it("register, freeze, sample, record, checkpoint, init, plugin add and plugin lock", async () => {
    const ro: ApiContext = { ...gitFile.ctx, mode: "read-only" };
    const before = treeHash(gitFile.dir);
    const calls: [string, () => Promise<unknown>][] = [
      ["register", () => register(ro, { force: true })],
      ["freeze", () => freeze(ro, { force: true })],
      ["sample", () => sample(ro, {})],
      ["record", () => record(ro, { draw: 1, verdict: "pass", reviewer: "x", force: true })],
      ["checkpoint", () => checkpoint(ro, {})],
      ["init", () => initAudit(ro, { force: true })],
      ["plugin add", () => preparePluginAdd(ro, "./x.mjs")],
      ["plugin lock", () => preparePluginLock(ro, "./x.mjs")],
    ];
    for (const [name, call] of calls) await expect(call(), name).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION", next: expect.stringContaining("pr-rla") });
    expect(() => commitPluginLock(ro, { previous: null } as never)).toThrow(/read-only/);
    expect(treeHash(gitFile.dir)).toBe(before);
  });

  it("plugin check is not a write, and is not in the read subpath either", async () => {
    expect(Object.keys(read)).not.toContain("checkPlugin");
    await expect(checkPlugin({ ...gitFile.ctx, mode: "read-only" }, "github")).rejects.toThrow(/built in/);
  });
});

describe("pr-rla/api/read reads only", () => {
  let tracker: Scenario;
  let fake: FakeGitHubIssues;
  const requests: string[] = [];
  beforeAll(async () => {
    fake = new FakeGitHubIssues();
    const routed = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${(init?.method ?? "GET").toUpperCase()} ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`);
      return fake.fetch(input, init);
    }) as typeof fetch;
    tracker = await audit(400, { ledger: "{ use: github-issues, options: { repo: acme/audit } }", fetch: routed });
    tracker.ctx.env = { GITHUB_TOKEN: "test-token" };
    const draws = readJ<DrawsFile>(tracker, `${W}/draws.json`);
    fake.setTime("2026-10-21T02:00:00Z");
    for (const d of draws.draws.slice(0, 5)) if (d.firstOccurrence) fake.label(fake.issueByDraw(d.draw).number, "pr-rla:pass", { login: "alice", id: 11, type: "User" });
  }, 120_000);

  it("offline status, draws, audit_list and verify never contact the tracker; online status reads it with GETs only", async () => {
    requests.length = 0;
    const st = await read.status({ dir: tracker.dir }, opts(tracker));
    expect(st).toMatchObject({ phase: "sampled", verdictsRead: false, ledger: "github-issues", verdictsSkipped: expect.stringMatching(/lives in api\.github\.com/) });
    const dv = await read.draws({ dir: tracker.dir }, opts(tracker));
    expect(dv.verdictsRead).toBe(false);
    expect(dv.draws.every((d) => d.state === null)).toBe(true);
    const al = await read.auditList({ dir: tracker.dir }, opts(tracker));
    expect(al.windows[0]).toMatchObject({ phase: "sampled", N: 400, drawsIssued: 36 });
    expect(al.windows[0]!.certified).toBeUndefined();
    const v = await read.verify({ dir: tracker.dir }, opts(tracker));
    expect(v.checks.find((c) => c.n === 7)!.status).toBe("SKIP");
    expect(requests).toEqual([]);
    const online = await read.status({ dir: tracker.dir, offline: false }, opts(tracker));
    expect(online).toMatchObject({ phase: "sampled", verdictsRead: true, labelledPrefix: expect.any(Number) });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.startsWith("GET "))).toBe(true);
  });

  it("every read function leaves the audit directory byte-identical (tree hash, .git included)", async () => {
    for (const s of [gitFile, tracker]) {
      const before = treeHash(s.dir);
      await read.auditList({ dir: s.dir }, opts(s));
      await read.status({ dir: s.dir }, opts(s));
      await read.status({ dir: s.dir, offline: false }, opts(s));
      await read.draws({ dir: s.dir, from: 2, limit: 3 }, opts(s));
      await read.drawContext({ dir: s.dir, draw: 1 }, opts(s));
      await read.verify({ dir: s.dir }, opts(s));
      await read.freezePreview({ dir: s.dir }, opts(s));
      await read.simulate({ population: 100, defects: 1, runs: 10 });
      expect(treeHash(s.dir)).toBe(before);
    }
  });

  it("a write a ledger would make is refused by the read-only view", async () => {
    const { openLedger, createAuditContext } = await import("../src/api/context.js");
    const actx = createAuditContext({ mode: "read-only", fetch: tracker.fetch, env: tracker.ctx.env });
    const ledger = await openLedger(actx, { use: "github-issues", options: { repo: "acme/audit" } }, tracker.dir, join(tracker.dir, W));
    await expect(ledger.appendVerdict({ draw: 1, changeId: "x", verdict: "pass", protocolSha256: "0", reviewer: "x", recordedAt: "2026-10-21T00:00:00Z" })).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    await expect(ledger.publishDraws!([], { window: "2026-q3", protocolSha256: "0" })).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
  });
});

describe("draws (contracts.md §4): the issued draws with state, and the blocking draw", () => {
  it("lists draws from `from`, at most `limit`, with the verdicts of a local ledger", async () => {
    const v = await read.draws({ dir: gitFile.dir, from: 1, limit: 200 }, opts(gitFile));
    expect(v).toMatchObject({ issued: 36, cap: 144, from: 1, limit: 200, verdictsRead: true });
    expect(v.draws).toHaveLength(36);
    expect(v.draws.filter((d) => d.state === "pass").length).toBeGreaterThan(0);
    expect(v.blockingDraw?.draw).toBe(v.draws.find((d) => d.state === "unlabelled")!.draw);
    const page = await read.draws({ dir: gitFile.dir, from: 30, limit: 5 }, opts(gitFile));
    expect(page.draws.map((d) => d.draw)).toEqual([30, 31, 32, 33, 34]);
  });

  it("refuses a limit over 200, and a `from` past the issued draws (DRAW_OUT_OF_RANGE)", async () => {
    await expect(read.draws({ dir: gitFile.dir, limit: 201 }, opts(gitFile))).rejects.toThrow(/1 to 200/);
    await expect(read.draws({ dir: gitFile.dir, from: 37 }, opts(gitFile))).rejects.toMatchObject({ code: "DRAW_OUT_OF_RANGE" });
    await expect(read.draws({ dir: gitFile.dir, from: 0 }, opts(gitFile))).rejects.toMatchObject({ code: "DRAW_OUT_OF_RANGE" });
  });
});

describe("audit_list", () => {
  it("lists the configured window and the earlier ones in the audit directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-list-"));
    cpSync(gitFile.dir, dir, { recursive: true });
    // An earlier window: its directory holds the registration (its manifest, audit/2026-q2.manifest.json, is not there).
    cpSync(join(dir, W), join(dir, "audit", "2026-q2"), { recursive: true });
    const al = await read.auditList({ dir }, { nowMs: () => gitFile.clock.now });
    expect(al.windows.map((w) => [w.name, w.configured, w.phase])).toEqual([["2026-q2", false, "registered"], ["2026-q3", true, "sampled"]]);
    expect(al.windows[1]).toMatchObject({ mode: "RETROSPECTIVE", N: 400, drawsIssued: 36, certified: false });
  });

  it("on the recorded gh-aw audit: one window, sampled, N = 1,589, not certified (no verdicts)", async () => {
    const al = await read.auditList({ dir: fixturePath("audits", "gh-aw-q3-recorded") });
    expect(al.windows).toEqual([expect.objectContaining({ name: "2026-q3", phase: "sampled", mode: "RETROSPECTIVE", N: 1589, drawsIssued: 36, certified: false, timestampTamperProof: false })]);
  });

  it("a window name that is a path is BAD_WINDOW, a missing audit NO_AUDIT", async () => {
    for (const window of ["../2026-q3", "..", "a/b", "2026-q4"]) await expect(read.status({ dir: gitFile.dir, window }, opts(gitFile))).rejects.toMatchObject({ code: "BAD_WINDOW" });
    await expect(read.status({ dir: tmpdir() })).rejects.toMatchObject({ code: "NO_AUDIT" });
    await expect(read.status({ dir: gitFile.dir, window: "2026-q3" }, opts(gitFile))).resolves.toMatchObject({ phase: "sampled" });
  });
});

describe("freezePreview: in memory, cached 600 s by (window, registration digest, estimate)", () => {
  it("a repeat within 600 s comes from the cache without listing again; after 600 s it lists again", async () => {
    let listings = 0;
    const s = gitFile;
    const cache = new Map<string, { at: number; value: read.FreezePreview }>();
    const counting = { ...opts(s), previewCache: cache, onProgress: (p: { message: string }) => void (p.message.startsWith("listing") && listings++) };
    const a = await read.freezePreview({ dir: s.dir }, counting);
    expect(a.cached).toBeUndefined();
    s.clock.now += 599_000;
    const b = await read.freezePreview({ dir: s.dir }, counting);
    expect(b).toEqual({ ...a, cached: true });
    expect(listings).toBe(1);
    s.clock.now += 2_000;
    const c = await read.freezePreview({ dir: s.dir }, counting);
    expect(c.cached).toBeUndefined();
    expect(listings).toBe(2);
    expect(cache.size).toBe(1);
    s.clock.now = T("2026-10-21T03:00:00Z");
  });

  it("writes nothing: no manifest, no key, no cache file (.pr-rla/cache), the tree unchanged", async () => {
    const s = setupAuditRepo({ changes: makeChanges(200) });
    s.clock.now = T("2026-10-20T00:00:00Z");
    const before = treeHash(s.dir);
    const p = await read.freezePreview({ dir: s.dir }, opts(s));
    expect(p).toMatchObject({ dryRun: true, registrationSha256: null, N: expect.any(Number) });
    expect(existsSync(join(s.dir, ".pr-rla"))).toBe(false);
    expect(treeHash(s.dir)).toBe(before);
  });

  it("estimate is refused in this build (the org-pooled freeze adds it), and keys apart", async () => {
    await expect(read.freezePreview({ dir: gitFile.dir, estimate: true }, opts(gitFile))).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});

describe("roots: confine refuses what the caller may not open", () => {
  it("the config, the protocol and a json-file path outside the allowed directory are refused", async () => {
    const seen: string[] = [];
    // Files are checked by their real path as they are opened, directories as configured: either may come.
    const roots = [gitFile.dir, realpathSync(gitFile.dir)];
    const inside = (p: string, what: string) => {
      seen.push(what);
      if (!roots.some((r) => p.startsWith(r))) throw Object.assign(new Error(`${what} is outside the roots`), { code: "ROOT_ESCAPE" });
    };
    await read.status({ dir: gitFile.dir }, opts(gitFile, { confine: inside }));
    expect(seen).toEqual(expect.arrayContaining([".pr-rla.yml", "audit_dir", "protocol", "the json-file provider's path"]));
    const s = setupAuditRepo({ changes: makeChanges(10) });
    appendFileSync(join(s.dir, ".pr-rla.yml"), "protocol: /etc/hosts\n");
    await expect(read.status({ dir: s.dir }, opts(s, { confine: (p, w) => inside(p.replace(realpathSync(s.dir), gitFile.dir).replace(s.dir, gitFile.dir), w) }))).rejects.toMatchObject({ code: "ROOT_ESCAPE" });
  });
});

describe("NFR10 on fixtures, offline: status < 1 s, verify < 2 s at N = 10,000", () => {
  let big: Scenario;
  beforeAll(async () => {
    big = await audit(10_000, { verdicts: 36 });
  }, 300_000);

  it("status offline", async () => {
    const t0 = performance.now();
    const r = await read.status({ dir: big.dir }, opts(big));
    const ms = performance.now() - t0;
    expect(r).toMatchObject({ phase: "sampled", N: 10_000 });
    expect(ms).toBeLessThan(process.env.CI ? 2000 : 1000);
  });

  it("verify offline", async () => {
    const t0 = performance.now();
    const r = await read.verify({ dir: big.dir }, opts(big));
    const ms = performance.now() - t0;
    expect(r.checks).toHaveLength(7);
    expect(ms).toBeLessThan(process.env.CI ? 4000 : 2000);
  });
});
