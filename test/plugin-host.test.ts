import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createAuditContext, openLedger, openProvider, type AuditContext } from "../src/api/context.js";
import { hostedProviderConformance, readRecordedFixture } from "../src/plugins/check.js";
import { closeAllPluginHosts, describePlugin, hostedProvider, isolationLine, nodeMajor, startPluginHost, type HostOptions, type PluginHost } from "../src/plugins/host.js";
import { placeholderEnv, readGrants, resolvePlugin, verifyLocked } from "../src/plugins/lock.js";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS, IPC_PROTOCOL, MAX_MESSAGE_BYTES } from "../src/plugins/protocol.js";
import type { ScmProvider } from "../src/sdk/provider.js";
import { formatConformanceReport, runProviderConformance, type ConformanceFixture } from "../src/testing/index.js";
import { fakeGitea } from "./helpers/fake-gitea.js";
import { auditDirWith, lockPlugin } from "./helpers/plugin-lock.js";
import { scenarioExpectations, scmScenario } from "./helpers/scm-scenario.js";

/** The plugin host (U2b): out of process, placeholder credentials, the Node permission model. */

const ROOT = join(import.meta.dirname, "..");
const HOSTILE = join(ROOT, "test", "fixtures", "plugins", "hostile");
const USE = "./plugins/hostile/index.mjs";
const SECRETS = { GITHUB_TOKEN: "ghp_REALSECRET0123456789abcdef", GITHUB_USER: "alice", AWS_SECRET_ACCESS_KEY: "aws-real-secret-do-not-leak" };
const WINDOW = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };

/** A Node at 25 or later, for the network-denial test: this one, PR_RLA_NODE25, or any `node` on PATH. */
function findNode25(): string | null {
  const candidates = [process.execPath, process.env.PR_RLA_NODE25, ...(process.env.PATH ?? "").split(delimiter).map((d) => join(d, "node"))];
  for (const c of new Set(candidates.filter((x): x is string => !!x && existsSync(x)).map((x) => realpathSync(x)))) {
    try {
      if (nodeMajor(c) >= 25) return c;
    } catch {
      /* not runnable */
    }
  }
  return null;
}
const NODE25 = findNode25();

afterAll(() => closeAllPluginHosts());

describe("RK-02: IPC under --permission without --allow-net, on Node 25 or later (the first U2b test)", () => {
  it.runIf(NODE25)(`IPC works and the child has no network (${NODE25 ?? "no Node 25+"})`, async () => {
    const plugin = resolvePlugin("./examples/provider-template.mjs", ROOT);
    const host = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "template", execPath: NODE25! });
    try {
      expect(host.nodeMajor).toBeGreaterThanOrEqual(25);
      expect(host.networkDenied).toBe(true);
      expect(host.ready).toMatchObject({ type: "ready", protocol: IPC_PROTOCOL, kind: "provider", name: "example", apiVersion: 1 });
      const p = await hostedProvider(host, { changes: [] }, { cwd: ROOT, fetch: globalThis.fetch, log: () => {} });
      expect(await p.listChanges({ repo: "acme/widgets", window: WINDOW, kinds: ["pull_request"] })).toEqual({ changes: [], defaultBranch: "main", limitations: ["example: in-memory data, for illustration"] });
    } finally {
      host.close();
    }
  });
  it.skipIf(NODE25)("UNVERIFIED: no Node 25 or later here (PATH or PR_RLA_NODE25), so network denial was not tested", () => {});
});

/** The hostile fixture, locked in a temp audit repo and opened as a command would: through the broker. */
async function setupHostile() {
  const dir = auditDirWith({ "plugins/hostile": HOSTILE });
  await lockPlugin(dir, USE);
  const secretFile = join(tmpdir(), `prrla-secret-${process.pid}.txt`);
  writeFileSync(secretFile, "top secret");
  const server: { requests: { url: string; method: string; authorization: string | null }[] } = { requests: [] };
  const transport = (async (input: string | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    server.requests.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase(), authorization: h.get("authorization") });
    return new Response(JSON.stringify({ authorization: h.get("authorization") }), { status: 200, headers: { "content-type": "application/json", "x-echo": h.get("authorization") ?? "" } });
  }) as unknown as typeof fetch;
  const ctx = createAuditContext({ mode: "read-write", env: SECRETS, fetch: transport });
  return { dir, ctx, server, secretFile };
}

/** openProvider's isolated path (src/plugins/open.ts), with another Node for the child: openProvider uses its own. */
async function openWithNode(ctx: AuditContext, dir: string, execPath: string, options: Record<string, unknown>): Promise<ScmProvider> {
  const { entry, plugin } = verifyLocked(USE, dir);
  const id = `provider:${entry.name}`;
  ctx.grant(id, { trust: "isolated", hosts: entry.hosts, credentials: entry.credentials });
  const host = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: placeholderEnv(entry.credentials, ctx.env), label: USE, secrets: entry.credentials.map((c) => ({ env: c.env, value: (SECRETS as Record<string, string>)[c.env]! })), execPath });
  return hostedProvider(host, options, { cwd: dir, fetch: ctx.broker.bind(id), sleep: ctx.sleep, log: ctx.log });
}

async function listenOnce(): Promise<{ server: Server; port: number; received: () => string }> {
  let got = "";
  const server = createServer((s) => s.on("data", (d) => (got += d.toString())));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port, received: () => got };
}

type Seen = Record<string, { ok: boolean; value?: unknown; code?: string; message?: string } | unknown>;

async function runHostile(p: ScmProvider): Promise<Seen> {
  const r = await p.listChanges({ repo: "acme/widgets", window: WINDOW, kinds: ["pull_request"] });
  return JSON.parse(r.limitations[0]!) as Seen;
}

describe("the hostile fixture plugin, contained (functional-design.md §U2b; test-design.md U2b)", () => {
  const cases: [string, string | null][] = [[`this Node (${process.versions.node})`, null]];
  if (NODE25 && NODE25 !== realpathSync(process.execPath)) cases.push([`Node ${nodeMajor(NODE25)} (${NODE25})`, NODE25]);

  for (const [label, execPath] of cases) {
    describe(label, () => {
      const major = nodeMajor(execPath ?? process.execPath);
      let seen: Seen;
      let s: Awaited<ReturnType<typeof setupHostile>>;
      let socket: Awaited<ReturnType<typeof listenOnce>>;
      beforeAll(async () => {
        s = await setupHostile();
        socket = await listenOnce();
        const options = { secretFile: s.secretFile, socketPort: socket.port };
        seen = await runHostile(execPath ? await openWithNode(s.ctx, s.dir, execPath, options) : await openProvider(s.ctx, { use: USE, options }, s.dir));
      });
      afterAll(() => socket.server.close());

      it("reads a placeholder, not the token; no other variable reaches it", () => {
        expect(seen.envToken).toBe("prrla-cred:GITHUB_TOKEN");
        expect(seen.ctxEnvToken).toBe("prrla-cred:GITHUB_TOKEN");
        expect(seen.otherSecret).toBeNull();
        const keys = seen.envKeys as string[];
        expect(keys).toEqual(expect.arrayContaining(["GITHUB_TOKEN", "GITHUB_USER", "PR_RLA_HOST"]));
        // macOS adds __CF_USER_TEXT_ENCODING to every process; nothing else may appear.
        expect(keys.filter((k) => !["GITHUB_TOKEN", "GITHUB_USER", "PR_RLA_HOST", "__CF_USER_TEXT_ENCODING"].includes(k))).toEqual([]);
        expect(JSON.stringify(seen)).not.toContain(SECRETS.GITHUB_TOKEN);
        expect(JSON.stringify(seen)).not.toContain(SECRETS.AWS_SECRET_ACCESS_KEY);
      });

      it("cannot read ~/.npmrc, another file, or the parent's /proc environ; cannot write files or start processes", () => {
        for (const k of ["npmrc", "secretFile", "procEnviron", "writeOwnDir", "writeTmp", "spawn"]) expect(seen[k], k).toMatchObject({ ok: false, code: "ERR_ACCESS_DENIED" });
        expect(existsSync(join(s.dir, "plugins", "hostile", "written.txt"))).toBe(false);
      });

      it("the broker swaps the placeholder on the declared host only, and the plugin never sees the echoed secret", () => {
        expect(seen.echo).toEqual({ ok: true, value: `200 ${JSON.stringify({ authorization: "token prrla-cred:GITHUB_TOKEN" })}` });
        expect(seen.basicEcho).toEqual({ ok: true, value: `200 ${JSON.stringify({ authorization: "Basic prrla-basic:GITHUB_USER:GITHUB_TOKEN" })}` });
        const echo = s.server.requests.filter((r) => r.url === "https://api.github.com/echo");
        expect(echo.map((r) => r.authorization)).toEqual([`token ${SECRETS.GITHUB_TOKEN}`, `Basic ${Buffer.from(`alice:${SECRETS.GITHUB_TOKEN}`).toString("base64")}`]);
      });

      it("the placeholder or prrla-basic sent anywhere else is refused unsent; global fetch and writes go through the broker too", () => {
        expect(seen.placeholderToOtherDeclaredHost).toMatchObject({ ok: false, code: "CREDENTIAL_HOST_MISMATCH" });
        expect(seen.basicToOtherDeclaredHost).toMatchObject({ ok: false, code: "CREDENTIAL_HOST_MISMATCH" });
        expect(seen.placeholderToUndeclaredHost).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
        expect(seen.basicToUndeclaredHost).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
        expect(seen.globalFetch).toMatchObject({ ok: false, code: "HOST_NOT_ALLOWED" });
        expect(seen.post).toMatchObject({ ok: false, code: "READ_ONLY_VIOLATION" });
        expect(s.server.requests.map((r) => new URL(r.url).host)).toEqual(["api.github.com", "api.github.com"]);
        expect(s.server.requests.every((r) => r.method === "GET")).toBe(true);
      });

      it(major >= 25 ? "cannot open a socket (Node 25 or later, no --allow-net)" : "CAN open a socket: Node 22 and 24 have no network control (the stated limit)", () => {
        if (major >= 25) {
          expect(seen.socket).toMatchObject({ ok: false, code: "ERR_ACCESS_DENIED" });
          expect(socket.received()).toBe("");
        } else {
          expect(seen.socket).toEqual({ ok: true, value: "connected" });
          expect(socket.received()).toBe("exfiltrated");
        }
      });
    });
  }
});

describe("the Gitea example passes the conformance kit through the host", () => {
  it("on recorded Codeberg responses (forgejo/docs, 2026-10-01..07), as plugin check runs it", async () => {
    const plugin = resolvePlugin("./examples/providers/gitea/index.mjs", ROOT);
    const file = join(ROOT, "examples", "providers", "gitea", "fixtures", "codeberg-forgejo-docs-2026-10-01.json");
    const report = await hostedProviderConformance(plugin, "gitea", [{ name: "codeberg forgejo/docs", rec: readRecordedFixture(file) }]);
    expect(report.ok, formatConformanceReport(report)).toBe(true);
    // U3's revoked-approval check has nothing to check here: the recording lists no revoked approval
    // (its one stale Codeberg approval still counts). review-granularity runs on the traits the child describes.
    expect(report.results.filter((r) => r.skipped).map((r) => r.check)).toEqual(["bot-detection", "revoked-approval"]);
    expect(report.results.find((r) => r.check === "review-granularity")).toMatchObject({ ok: true });
    expect(report.results.find((r) => r.check === "review-granularity")?.skipped).toBeFalsy();
  });

  it("on the synthetic Forgejo (every merge strategy, a 45 s rate-limit wait proxied to the parent's clock)", async () => {
    const sc = scmScenario();
    const late = scmScenario({ latePush: true });
    const x = scenarioExpectations("gitea");
    const plugin = resolvePlugin("./examples/providers/gitea/index.mjs", ROOT);
    const hosts: PluginHost[] = [];
    let fake = fakeGitea(sc, { limit: 3 });
    const options = { base_url: "https://forge.example.com", page_size: 3, bots: ["agent-bot", "review-bot", "merge-bot"] };
    const started = Date.now();
    try {
      // U3's definition fields, read from the child (describe), never by importing the plugin here.
      const probe = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "gitea" });
      hosts.push(probe);
      const { traits } = await describePlugin(probe, options);
      const base: ConformanceFixture = {
        name: "synthetic gitea acme/widgets 2026-08-01, through the host",
        request: { repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] },
        expect: {
          ids: x.all,
          pullRequests: x.pullRequests,
          directPushes: x.directPushes,
          prCommits: x.prCommits,
          mergeShas: x.mergeShas,
          changedLines: x.changedLines,
          bots: ["agent-bot[bot]", "review-bot[bot]", "merge-bot[bot]", "forgejo-actions[bot]"],
          humans: ["maint", "bob", "dave", "erin", "carol", "alice"],
          minPages: 40,
          reviewGranularity: "submission",
          revokedApprovals: x.revokedApprovals,
        },
        pagesServed: () => fake.served(),
        http: true,
        rateLimitFault: { status: 429, headers: () => ({ ratelimit: '"baseline";r=0;t=45', "ratelimit-policy": '"baseline";q=2000;w=600' }), minWaitMs: 45_000 },
      };
      // U3's pinned head crosses IPC as data: a merge pushed after freeze is left out when the request names the frozen head.
      const pushedLater: ConformanceFixture = { ...base, name: "synthetic gitea, a merge pushed after freeze, through the host", expect: { ...base.expect, ids: [...x.all, x.late.id], directPushes: [...x.directPushes, x.late.id] }, pinnedHead: { head: sc.frozenHead, late: [x.late.sha] } };
      const report = await runProviderConformance(
        async (f, h) => {
          const host = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "gitea" });
          hosts.push(host);
          return hostedProvider(host, options, h.context({ fetch: (fake = fakeGitea(f.pinnedHead ? late : sc, { limit: 3 })).fetch, cwd: ROOT }));
        },
        [base, pushedLater],
        { definition: traits },
      );
      expect(report.ok, formatConformanceReport(report)).toBe(true);
      expect(report.results.filter((r) => r.skipped)).toEqual([]);
      // The 45 s wait ran on the kit's clock in the parent, not in real time in the child.
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      hosts.forEach((h) => h.close());
    }
  });
});

describe("heartbeats, silence and message size (contracts.md §3)", () => {
  const hostileHost = async (o: Partial<HostOptions> = {}) => {
    const plugin = resolvePlugin("./hostile/index.mjs", auditDirWith({ hostile: HOSTILE }));
    return startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "hostile", ...o });
  };
  const ctx = { cwd: ".", fetch: globalThis.fetch, log: () => {} };

  it("a heartbeat every 10 s; silence for 60 s stops the child, and the error carries its output", async () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(10_000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(60_000);
    const armed: { ms: number; fire: () => void }[] = [];
    const host = await hostileHost({ setTimer: (fire, ms) => (armed.push({ ms, fire }), () => {}) });
    const p = await hostedProvider(host, { hang: true }, ctx);
    const call = p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] });
    await new Promise((r) => setTimeout(r, 300)); // the child prints, then busy-loops: no more messages
    const last = armed[armed.length - 1]!;
    expect(last.ms).toBe(60_000);
    last.fire();
    await expect(call).rejects.toThrow(/plugin hostile sent no heartbeat for 60 s and was stopped[\s\S]*hostile: about to hang/);
    await expect(p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] })).rejects.toMatchObject({ code: "PLUGIN_HOST_TIMEOUT" });
  });

  it("a slow call that keeps sending heartbeats is not stopped", async () => {
    const host = await hostileHost({ heartbeatTimeoutMs: 500, heartbeatIntervalMs: 100 });
    try {
      const p = await hostedProvider(host, { slowMs: 1_500, bigResultBytes: 10 }, ctx);
      expect((await p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] })).defaultBranch).toBe("main");
    } finally {
      host.close();
    }
  });

  it("a message over the limit (64 MiB by default) is refused", async () => {
    expect(MAX_MESSAGE_BYTES).toBe(64 * 1024 * 1024);
    const host = await hostileHost({ maxMessageBytes: 1024 * 1024 });
    const p = await hostedProvider(host, { bigResultBytes: 2 * 1024 * 1024 }, ctx);
    await expect(p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] })).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
  });

  it("an isolated plugin's line says what is and is not contained", async () => {
    const host = await hostileHost();
    try {
      expect(isolationLine(host, "hostile", "6.6.6")).toMatch(host.networkDenied ? /no network/ : /cannot block its network access/);
    } finally {
      host.close();
    }
  });

  it("the child reports a module that is not a provider definition, and the parent refuses another API version", async () => {
    const dir = auditDirWith({});
    writeFileSync(join(dir, "nothing.mjs"), "export const x = 1;\n");
    writeFileSync(join(dir, "v2.mjs"), 'export default { providerApiVersion: 2, name: "future", create() {} };\n');
    const open = (f: string) => {
      const plugin = resolvePlugin(`./${f}`, dir);
      return startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: f });
    };
    await expect(open("nothing.mjs")).rejects.toThrow(/exports no provider definition/);
    await expect(open("v2.mjs")).rejects.toThrow(/declares providerApiVersion 2; this pr-rla supports 1/);
    expect(readFileSync(join(dir, "v2.mjs"), "utf8")).toContain("future");
  });
});

describe("an external ledger runs in the host too", () => {
  it("appends and reads verdicts over IPC; in read-only mode its writes refuse before reaching the child", async () => {
    const dir = auditDirWith({});
    mkdirSync(join(dir, "ledger"));
    writeFileSync(join(dir, "ledger", "package.json"), JSON.stringify({ name: "memory-ledger", version: "0.0.1", type: "module" }));
    writeFileSync(
      join(dir, "ledger", "index.mjs"),
      'import { defineLedger } from "pr-rla/ledger";\nconst ev = [];\nexport default defineLedger({ ledgerApiVersion: 1, name: "memory", create: (o, ctx) => ({ apiVersion: 1, name: "memory", readVerdicts: async () => ev, appendVerdict: async (e) => void ev.push({ ...e, note: ctx.windowDir }) }) });\n',
    );
    await lockPlugin(dir, "./ledger/index.mjs", { kind: "ledger" });
    const windowDir = join(dir, "audit", "w");
    const event = { draw: 1, changeId: "x:a/b#1", verdict: "pass", protocolSha256: "0".repeat(64), reviewer: "r", recordedAt: "2026-11-03T00:00:00Z" } as const;
    const ledger = await openLedger(createAuditContext({ mode: "read-write" }), { use: "./ledger/index.mjs", options: {} }, dir, windowDir);
    expect(ledger.name).toBe("memory");
    await ledger.appendVerdict(event);
    expect(await ledger.readVerdicts()).toEqual([{ ...event, note: windowDir }]);
    const view = await openLedger(createAuditContext({ mode: "read-only" }), { use: "./ledger/index.mjs", options: {} }, dir, windowDir);
    await expect(view.appendVerdict(event)).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    expect(await view.readVerdicts()).toEqual([]);
  });
});
