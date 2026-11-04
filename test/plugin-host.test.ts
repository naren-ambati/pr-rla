import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createAuditContext, openLedger, openProvider, type AuditContext } from "../src/api/context.js";
import { buildProgram } from "../src/cli.js";
import { hostedProviderConformance, readRecordedFixture } from "../src/plugins/check.js";
import { abortableSleep, closeAllPluginHosts, describePlugin, hostedProvider, isolationLine, MAX_PLUGIN_FETCHES, MAX_PLUGIN_SLEEP_MS, nodeMajor, startPluginHost, type HostOptions, type PluginHost } from "../src/plugins/host.js";
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
const SECRETS = { GITHUB_TOKEN: "ghp_REAL+SECRET/0123456789=abcdef", GITHUB_USER: "alice", AWS_SECRET_ACCESS_KEY: "aws-real-secret-do-not-leak" };
/** Every form the fake host echoes the token in (src/net/scrub.ts covers each). */
const tokenForms = (v: string) => [v, encodeURIComponent(v), new URLSearchParams({ t: v }).toString().slice(2), Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url")];
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
  // Without a Node 25 or later the test above cannot run: say so as a skipped test, never as a green one.
  if (!NODE25) it.skip("UNVERIFIED: no Node 25 or later here (PATH or PR_RLA_NODE25), so network denial was not tested", () => {});
});

/** The hostile fixture, locked in a temp audit repo and opened as a command would: through the broker. */
async function setupHostile() {
  const dir = auditDirWith({ "plugins/hostile": HOSTILE });
  // Approved here, as the person who locks it: the credentials below are granted to it.
  await lockPlugin(dir, USE, { approve: true });
  const secretFile = join(tmpdir(), `prrla-secret-${process.pid}.txt`);
  writeFileSync(secretFile, "top secret");
  const server: { requests: { url: string; method: string; authorization: string | null }[] } = { requests: [] };
  const transport = (async (input: string | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const url = new URL(String(input));
    server.requests.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase(), authorization: h.get("authorization") });
    const token = (h.get("authorization") ?? "").replace(/^token /, "");
    // An echoing host (finding 5): the token comes back raw, encoded, in a header, the status text and a redirect's URL.
    if (url.pathname === "/echo-forms") return new Response(null, { status: 302, headers: { location: `/landing?t=${encodeURIComponent(token)}` } });
    if (url.pathname === "/landing") return new Response(JSON.stringify({ forms: tokenForms(token) }), { status: 200, statusText: `OK ${token}`, headers: { "content-type": "application/json", "x-echo": token } });
    // A redirect from https to http on the same host (finding 4): the broker must not follow with the token.
    if (url.pathname === "/downgrade") return new Response(null, { status: 302, headers: { location: "http://api.github.com/landing-in-clear-text" } });
    if (url.pathname === "/participants") return new Response(JSON.stringify({ values: [{ user: { name: SECRETS.GITHUB_USER } }, { user: { name: `${SECRETS.GITHUB_USER}a` } }, { user: { name: `b${SECRETS.GITHUB_USER}` } }] }), { status: 200, headers: { "content-type": "application/json" } });
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
  const host = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: placeholderEnv(entry.credentials, ctx.env), label: USE, secrets: entry.credentials.map((c) => ({ env: c.env, value: (SECRETS as Record<string, string>)[c.env]!, secret: c.secret !== false })), execPath });
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
        expect(s.server.requests.map((r) => new URL(r.url).pathname)).toEqual(["/echo", "/echo", "/echo-forms", "/landing", "/participants", "/downgrade"]);
        expect(s.server.requests.every((r) => new URL(r.url).host === "api.github.com" && r.method === "GET")).toBe(true);
      });

      it("the token goes only to its exact https origin: not over http, not to another port, not after a downgrading redirect (finding 4)", () => {
        for (const k of ["httpDowngrade", "otherPort", "redirectDowngrade"]) expect(seen[k], k).toMatchObject({ ok: false, code: "CREDENTIAL_HOST_MISMATCH" });
        // The redirect's first hop was the granted origin; the http hop was never sent.
        expect(s.server.requests.filter((r) => r.url.includes("downgrade") || r.url.includes("landing-in-clear-text")).map((r) => [r.url, r.authorization])).toEqual([["https://api.github.com/downgrade", `token ${SECRETS.GITHUB_TOKEN}`]]);
        expect(s.server.requests.some((r) => r.url.startsWith("http:") || r.url.includes(":8443"))).toBe(false);
      });

      it("the placeholder is swapped only in authorization; GraphQL documents in the URL and method overrides are not reads (findings 5, 6)", () => {
        expect(seen.otherHeader).toMatchObject({ ok: false, code: "CREDENTIAL_HEADER_NOT_ALLOWED" });
        for (const k of ["graphqlPostUrl", "graphqlGetMutation", "methodOverride"]) expect(seen[k], k).toMatchObject({ ok: false, code: "READ_ONLY_VIOLATION" });
        expect(s.server.requests.some((r) => r.url.includes("graphql") || r.url.includes("/repos/acme/widgets"))).toBe(false);
      });

      it("a token the host echoes back reaches it only as a placeholder, in every form: body, header, status text, redirect URL (finding 5)", () => {
        const e = seen.echoForms as { ok: boolean; value: { url: string; header: string; statusText: string; body: string } };
        expect(e.ok).toBe(true);
        expect(e.value.url).toBe("https://api.github.com/landing?t=prrla-cred:GITHUB_TOKEN");
        expect(e.value.header).toBe("prrla-cred:GITHUB_TOKEN");
        expect(e.value.statusText).toBe("OK prrla-cred:GITHUB_TOKEN");
        expect(JSON.parse(e.value.body)).toEqual({ forms: ["prrla-cred:GITHUB_TOKEN", "prrla-cred:GITHUB_TOKEN", "prrla-cred:GITHUB_TOKEN", "prrla-cred:GITHUB_TOKEN", "prrla-cred:GITHUB_TOKEN"] });
        for (const form of tokenForms(SECRETS.GITHUB_TOKEN)) expect(JSON.stringify(seen), form).not.toContain(form);
      });

      it("an identity (secret: false) is not scrubbed from responses, and is sent only as the user of prrla-basic: (finding 8)", () => {
        // Before the fix: prrla-cred:GITHUB_USER, prrla-cred:GITHUB_USERa and bprrla-cred:GITHUB_USER.
        expect(seen.identityEcho).toEqual({ ok: true, value: JSON.stringify({ values: [{ user: { name: "alice" } }, { user: { name: "alicea" } }, { user: { name: "balice" } }] }) });
        expect(seen.identityAsToken).toMatchObject({ ok: false, code: "CREDENTIAL_IDENTITY_ONLY" });
      });

      it(major >= 25 ? "cannot open a socket (Node 25 or later, no --allow-net)" : "CAN open a socket: Node 22 and 24 have no network control (the stated limit)", async () => {
        if (major >= 25) {
          expect(seen.socket).toMatchObject({ ok: false, code: "ERR_ACCESS_DENIED" });
          expect(socket.received()).toBe("");
        } else {
          expect(seen.socket).toEqual({ ok: true, value: "connected" });
          // The child's end() callback fires once its bytes reach the OS, not once this server's
          // "data" handler has run, so under load the bytes can still be in flight here.
          await vi.waitFor(() => expect(socket.received()).toBe("exfiltrated"), { timeout: 5000, interval: 10 });
        }
      });
    });
  }
});

describe("the hostile fixture's dependency names cannot widen its read grant (finding 3)", () => {
  /** The hostile fixture in a temp audit repo, with `pkg` merged into its package.json and the repo's secrets beside it. */
  function hostileWith(pkg: Record<string, unknown>, at?: string): string {
    const dir = at ?? auditDirWith({});
    cpSync(HOSTILE, join(dir, "plugins", "hostile"), { recursive: true });
    const file = join(dir, "plugins", "hostile", "package.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...pkg }));
    mkdirSync(join(dir, ".pr-rla"), { recursive: true });
    writeFileSync(join(dir, ".pr-rla", "signing-key.pem"), "-----BEGIN PRIVATE KEY----- secret");
    writeFileSync(join(dir, ".env"), "AWS_SECRET_ACCESS_KEY=aws-real-secret-do-not-leak");
    return realpathSync(dir);
  }
  const refusal = async (dir: string) => {
    try {
      // Before the fix, this granted the child every file of the audit repo (the review's exp/drive-dep.mjs).
      return { grants: readGrants(resolvePlugin(USE, dir)) };
    } catch (e) {
      return { code: (e as { code?: string }).code, message: (e as Error).message };
    }
  };

  it("a name that is not an npm package name (\"../../..\") is refused before anything is granted", async () => {
    const dir = hostileWith({ optionalDependencies: { "../../..": "*" } });
    // As in the review's exp/audit: the audit repo has a package.json, so "../../.." resolved to the repo root.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "audit", private: true }));
    expect(await refusal(dir)).toEqual({ code: "PLUGIN_INVALID", message: `plugin ${USE}: its package.json names the dependency "../../..", which is not an npm package name; refusing it before anything is granted or run` });
    for (const bad of ["a/../../..", "@scope/../x", ".hidden", "_private", "a/b"]) expect((await refusal(hostileWith({ dependencies: { [bad]: "*" } }))).code, bad).toBe("PLUGIN_INVALID");
  });

  it("a dependency installed as a symlink out of node_modules (here: to the audit repo) is refused", async () => {
    const dir = hostileWith({ dependencies: { "evil-dep": "1.0.0" } });
    mkdirSync(join(dir, "plugins", "hostile", "node_modules"));
    symlinkSync("../../..", join(dir, "plugins", "hostile", "node_modules", "evil-dep"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "audit", version: "1.0.0" }));
    expect(await refusal(dir)).toEqual({ code: "TREE_ESCAPE", message: `plugin ${USE}: its dependency evil-dep resolves to ${dir}, which is not in a node_modules directory; refusing it before anything is granted or run` });
  });

  it("a dependency in a node_modules directory that holds the audit repo is refused", async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "prrla-outer-")));
    const dep = join(outer, "node_modules", "evil-dep");
    mkdirSync(join(dep, "audit"), { recursive: true });
    writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "evil-dep", version: "1.0.0" }));
    const dir = hostileWith({ dependencies: { "evil-dep": "1.0.0" } }, join(dep, "audit"));
    expect(await refusal(dir)).toEqual({ code: "TREE_ESCAPE", message: `plugin ${USE}: its dependency evil-dep resolves to ${dep}, which contains the audit directory ${dir}; refusing it before anything is granted or run` });
  });

  it("plugin check refuses it too, before it starts the plugin", async () => {
    const dir = hostileWith({ optionalDependencies: { "../../..": "*" } });
    const out: string[] = [];
    let code = -1;
    await buildProgram(() => ({ cwd: dir, env: {}, nowMs: () => 0, fetch: globalThis.fetch, out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) }), (c) => (code = c)).parseAsync(["node", "pr-rla", "plugin", "check", USE, "--offline"]);
    expect(code).toBe(1);
    expect(out).toEqual([`ERR pr-rla: plugin ${USE}: its package.json names the dependency "../../..", which is not an npm package name; refusing it before anything is granted or run`, "ERR   next: a dependency must be name or @scope/name, installed in node_modules"]);
  });

  it("the plugin's own package may be linked from a local directory, but not one that holds the audit repo (review of this round)", async () => {
    const dir = realpathSync(auditDirWith({}));
    cpSync(HOSTILE, join(dir, "vendor", "hostile"), { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    symlinkSync("../vendor/hostile", join(dir, "node_modules", "pr-rla-provider-hostile"));
    expect(resolvePlugin("pr-rla-provider-hostile", dir).root).toBe(join(dir, "vendor", "hostile"));
    const evil = realpathSync(auditDirWith({}));
    writeFileSync(join(evil, "package.json"), JSON.stringify({ name: "pr-rla-provider-evil", version: "1.0.0", main: "index.mjs" }));
    writeFileSync(join(evil, "index.mjs"), "export default {};\n");
    mkdirSync(join(evil, "node_modules"));
    symlinkSync("..", join(evil, "node_modules", "pr-rla-provider-evil"));
    expect(() => resolvePlugin("pr-rla-provider-evil", evil)).toThrow(/package pr-rla-provider-evil resolves to .*, which contains the audit directory/);
  });

  it("scoped and pnpm-style (symlinked inside node_modules) dependencies still resolve", async () => {
    const dir = hostileWith({ dependencies: { "@acme/util": "1.0.0", "left-pad": "1.3.0" } });
    const nm = join(dir, "plugins", "hostile", "node_modules");
    mkdirSync(join(nm, "@acme", "util"), { recursive: true });
    writeFileSync(join(nm, "@acme", "util", "package.json"), JSON.stringify({ name: "@acme/util", version: "1.0.0" }));
    const store = join(nm, ".pnpm", "left-pad@1.3.0", "node_modules", "left-pad");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "package.json"), JSON.stringify({ name: "left-pad", version: "1.3.0" }));
    symlinkSync(join(".pnpm", "left-pad@1.3.0", "node_modules", "left-pad"), join(nm, "left-pad"));
    expect(resolvePlugin(USE, dir).deps.map((d) => `${d.name}@${d.version}`).sort()).toEqual(["@acme/util@1.0.0", "left-pad@1.3.0"]);
  });
});

describe("the Gitea example passes the conformance kit through the host", () => {
  it("on recorded Codeberg responses (forgejo/docs, 2026-10-01..07), as plugin check runs it", async () => {
    const plugin = resolvePlugin("./examples/providers/gitea/index.mjs", ROOT);
    const file = join(ROOT, "examples", "providers", "gitea", "fixtures", "codeberg-forgejo-docs-2026-10-01.json");
    const report = await hostedProviderConformance(plugin, "gitea", [{ name: "codeberg forgejo/docs", rec: readRecordedFixture(file) }]);
    expect(report.ok, formatConformanceReport(report)).toBe(true);
    // The recording declares only its ids and direct pushes, so the checks that read other expectations skip and say so
    // (merge strategies, review states, actors); U3's revoked-approval check has nothing to check (its one stale Codeberg approval
    // still counts). review-granularity runs on the traits the child describes.
    expect(report.results.filter((r) => r.skipped && r.fixture !== "(check coverage)").map((r) => r.check)).toEqual(["merge-strategies", "review-state-mapping", "actors", "bot-detection", "revoked-approval"]);
    // P1: plugin check names each check the recordings exercise nowhere, with why, rather than passing it.
    expect(report.results.filter((r) => r.fixture === "(check coverage)").map((r) => `${r.check}: ${r.message}`)).toEqual(["merge-strategies", "review-state-mapping", "actors", "bot-detection", "revoked-approval"].map((c) => `${c}: not exercised by this run: the recordings plugin check was given declare no expectation for it`));
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
          reviewStates: {
            [x.ids.squash]: Array(150).fill("COMMENTED"),
            [x.ids.rebase]: ["CHANGES_REQUESTED", "DISMISSED"],
            [x.ids.merge]: ["APPROVED"],
            [x.ids.ff]: ["APPROVED"],
            [x.ids.squash5]: [],
            [x.ids.squashMerge]: ["DISMISSED", "APPROVED"],
            [x.ids.atOpen]: [],
          },
          actors: { [x.ids.squash]: { author: { login: "agent-bot[bot]", kind: "bot" }, mergedBy: { login: "maint", kind: "human" } } },
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
      // The 45 s wait ran on the kit's clock in the parent, not in real time in the child: the whole run took less than
      // the wait itself (30 s was the bound until two suites at load ~150 took 30.3 s, U8 fix round).
      expect(Date.now() - started).toBeLessThan(45_000);
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
  const list = (p: ScmProvider) => p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] });

  it("the watchdog arms 60 s by default; firing it stops the child, and the error carries its output", async () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(10_000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(60_000);
    const armed: { ms: number; fire: () => void }[] = [];
    const host = await hostileHost({ setTimer: (fire, ms) => (armed.push({ ms, fire }), () => {}) });
    const p = await hostedProvider(host, { hang: true }, ctx);
    const call = list(p);
    await new Promise((r) => setTimeout(r, 300)); // the child prints, then busy-loops: no more messages
    const last = armed[armed.length - 1]!;
    expect(last.ms).toBe(60_000);
    last.fire();
    await expect(call).rejects.toThrow(/plugin hostile sent no heartbeat for 60 s and was stopped[\s\S]*hostile: about to hang/);
    await expect(list(p)).rejects.toMatchObject({ code: "PLUGIN_HOST_TIMEOUT" });
  });

  /**
   * The contract's ratio, kept at a test's pace: the parent waits HEARTBEAT_TIMEOUT_MS / HEARTBEAT_INTERVAL_MS
   * = 6 intervals, so it tolerates five missed heartbeats. At a 250 ms interval that is 1.5 s of silence,
   * counted from the child's `ready` (its start-up has its own limit), so a loaded machine that is slow to
   * start a child, or late with one heartbeat, does not trip it.
   */
  const INTERVAL = 250;
  const TIMEOUT = INTERVAL * (HEARTBEAT_TIMEOUT_MS / HEARTBEAT_INTERVAL_MS);

  it("a call that waits sends heartbeats, which the parent receives (test gap: it used to check the constants only)", async () => {
    const host = await hostileHost({ heartbeatIntervalMs: INTERVAL });
    try {
      const p = await hostedProvider(host, { slowMs: 8 * INTERVAL, bigResultBytes: 10 }, ctx);
      expect(host.stats().heartbeats).toBe(0);
      await list(p);
      // About 8; at least 2 however late the child's timer runs.
      expect(host.stats().heartbeats).toBeGreaterThanOrEqual(2);
    } finally {
      host.close();
    }
  });

  it("a slow call that keeps sending heartbeats outlives the watchdog; a silent one is stopped by the real timer", async () => {
    expect(TIMEOUT).toBe(1_500);
    const host = await hostileHost({ heartbeatTimeoutMs: TIMEOUT, heartbeatIntervalMs: INTERVAL });
    try {
      const p = await hostedProvider(host, { slowMs: 2 * TIMEOUT, bigResultBytes: 10 }, ctx);
      expect((await list(p)).defaultBranch).toBe("main");
    } finally {
      host.close();
    }
    const silent = await hostileHost({ heartbeatTimeoutMs: TIMEOUT, heartbeatIntervalMs: INTERVAL });
    const started = Date.now();
    await expect(list(await hostedProvider(silent, { hang: true }, ctx))).rejects.toMatchObject({ code: "PLUGIN_HOST_TIMEOUT", message: expect.stringMatching(/sent no heartbeat for 1\.5 s and was stopped/) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(TIMEOUT - 50);
  });

  it("the heartbeat timeout counts from ready: start-up has its own limit, loadTimeoutMs", async () => {
    const dir = auditDirWith({});
    writeFileSync(join(dir, "slow-start.mjs"), 'await new Promise((r) => setTimeout(r, 1000));\nexport default { providerApiVersion: 1, name: "slow-start", create() { return { apiVersion: 1, name: "slow-start", async listChanges() { return { changes: [], defaultBranch: "main" }; } }; } };\n');
    const start = (o: Partial<HostOptions>) => {
      const plugin = resolvePlugin("./slow-start.mjs", dir);
      return startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "slow-start", ...o });
    };
    // A heartbeat timeout far shorter than the start-up does not stop it.
    const host = await start({ heartbeatTimeoutMs: 100 });
    host.close();
    await expect(start({ loadTimeoutMs: 300 })).rejects.toMatchObject({ code: "PLUGIN_HOST_TIMEOUT", message: expect.stringMatching(/^plugin slow-start did not finish loading within 0\.3 s and was stopped/) });
  });

  it("a heartbeat that arrived while this process was busy counts (the watchdog decides after the poll phase reads it)", async () => {
    const host = await hostileHost({ heartbeatTimeoutMs: 1_000, heartbeatIntervalMs: 50 });
    try {
      const p = await hostedProvider(host, { slowMs: 3_500, bigResultBytes: 10 }, ctx);
      const call = p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] });
      // Let the call reach the child and its heartbeats start.
      await new Promise((r) => setTimeout(r, 400));
      // Block this process past the timeout from a check-phase callback, while the child goes on writing
      // heartbeats into the pipe. The next loop turn runs the expired watchdog timer before the poll
      // phase reads those heartbeats; a watchdog that decided in the timer itself stopped the child here.
      await new Promise<void>((r) =>
        setImmediate(() => {
          const until = Date.now() + 1_500;
          while (Date.now() < until) {
            /* busy */
          }
          r();
        }),
      );
      expect((await call).defaultBranch).toBe("main");
    } finally {
      host.close();
    }
  });

  it("a message over the limit (64 MiB by default) is refused by its length, before its body is buffered (finding 11)", async () => {
    expect(MAX_MESSAGE_BYTES).toBe(64 * 1024 * 1024);
    const host = await hostileHost({ maxMessageBytes: 1024 * 1024 });
    const p = await hostedProvider(host, { bigResultBytes: 8 * 1024 * 1024 }, ctx);
    await expect(list(p)).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE", message: expect.stringMatching(/^plugin hostile: a message from it is 83886\d\d bytes, over the 1 MiB message limit; refused/) });
    // The reader held one chunk of the 8 MiB frame at most, never the frame.
    expect(host.stats().maxBufferedBytes).toBeLessThan(1024 * 1024);
  });

  it("a frame header claiming 1 GiB is refused at once, with nothing after it buffered (finding 11)", { timeout: 15_000 }, async () => {
    const host = await hostileHost({ maxMessageBytes: 1024 * 1024 });
    const p = await hostedProvider(host, { rawFrameBytes: 1024 * 1024 * 1024 }, ctx);
    const started = Date.now();
    // Node's IPC channel used to wait for the rest of the message, buffering it (the review saw 3 GB for 500 MB).
    await expect(list(p)).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE", message: expect.stringMatching(/a message from it is 1073741824 bytes/) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(host.stats().maxBufferedBytes).toBeLessThan(64 * 1024);
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

describe("a plugin's sleep: capped, only during a call, cancelled on close (finding 13)", () => {
  const hostileHost = async () => {
    const plugin = resolvePlugin("./hostile/index.mjs", auditDirWith({ hostile: HOSTILE }));
    return startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "hostile" });
  };
  const list = (p: ScmProvider) => p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] });

  it("a wait asked for within a call is served on the command's clock, capped at MAX_PLUGIN_SLEEP_MS (15 min)", async () => {
    const asked: number[] = [];
    const host = await hostileHost();
    try {
      const p = await hostedProvider(host, { sleepMs: 10 * 3600_000 }, { cwd: ".", fetch: globalThis.fetch, log: () => {}, sleep: async (ms) => void asked.push(ms) });
      expect((await list(p)).limitations).toEqual(["slept"]);
      expect(asked).toEqual([MAX_PLUGIN_SLEEP_MS]);
      expect(MAX_PLUGIN_SLEEP_MS).toBe(15 * 60_000);
    } finally {
      host.close();
    }
  });

  it("a wait asked for after the call returned is not served", async () => {
    const asked: number[] = [];
    const host = await hostileHost();
    try {
      const p = await hostedProvider(host, { sleepAfterReturnMs: 600_000 }, { cwd: ".", fetch: globalThis.fetch, log: () => {}, sleep: async (ms) => void asked.push(ms) });
      expect((await list(p)).limitations).toEqual(["returned"]);
      await new Promise((r) => setTimeout(r, 300));
      expect(asked).toEqual([]);
    } finally {
      host.close();
    }
  });

  it("close() cancels a wait in progress, and the default sleep clears its timer", async () => {
    const signals: AbortSignal[] = [];
    const host = await hostileHost();
    const p = await hostedProvider(host, { sleepMs: 600_000 }, { cwd: ".", fetch: globalThis.fetch, log: () => {}, sleep: (_ms, signal) => new Promise<void>((r) => (signal && signals.push(signal), signal?.addEventListener("abort", () => r()))) });
    const call = list(p);
    await vi.waitFor(() => expect(signals).toHaveLength(1), { timeout: 5000, interval: 10 });
    expect(signals[0]!.aborted).toBe(false);
    host.close();
    expect(signals[0]!.aborted).toBe(true);
    await expect(call).rejects.toThrow(/its host was closed/);
    // The waits pr-rla itself provides end on abort and clear their timers: the CLI's, an AuditContext's, the host's own.
    const { auditContextFor, nodeContext } = await import("../src/commands/context.js");
    const cli = nodeContext({ env: {} });
    for (const sleep of [abortableSleep, cli.sleep!, auditContextFor(cli).sleep, createAuditContext({ mode: "read-only" }).sleep]) {
      const c = new AbortController();
      const started = Date.now();
      const sleeping = sleep(600_000, c.signal);
      c.abort();
      // The host's own wait resolves; pr-rla's other waits reject with an AbortError (U5's cancellation, joined at the
      // wave-2 integration), so a cancelled call stops. Either way the wait ends at once and its timer is cleared.
      await sleeping.catch((e: Error) => expect(e.name).toBe("AbortError"));
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
});

describe("a plugin's fetches: only during a call, at most MAX_PLUGIN_FETCHES at once (review of this round)", () => {
  it("a fan-out past the limit is refused unsent, and a fetch after the call returned is never sent", async () => {
    const plugin = resolvePlugin("./hostile/index.mjs", auditDirWith({ hostile: HOSTILE }));
    const host = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "hostile" });
    const sent: string[] = [];
    let inFlight = 0;
    let most = 0;
    const transport = (async (input: string | URL) => {
      sent.push(String(input));
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 300));
      inFlight--;
      return new Response("{}");
    }) as unknown as typeof fetch;
    try {
      const fan = await hostedProvider(host, { fanOut: MAX_PLUGIN_FETCHES + 36 }, { cwd: ".", fetch: transport, log: () => {} });
      const codes = JSON.parse((await fan.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] })).limitations[0]!) as string[];
      expect(codes.filter((c) => c === "sent")).toHaveLength(MAX_PLUGIN_FETCHES);
      expect(codes.filter((c) => c === "PLUGIN_FETCH_REFUSED")).toHaveLength(36);
      expect(most).toBeLessThanOrEqual(MAX_PLUGIN_FETCHES);
    } finally {
      host.close();
    }
    const late = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "hostile" });
    try {
      sent.length = 0;
      const p = await hostedProvider(late, { fetchAfterReturn: true }, { cwd: ".", fetch: transport, log: () => {} });
      expect((await p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] })).limitations).toEqual(["returned"]);
      await new Promise((r) => setTimeout(r, 300));
      expect(sent).toEqual([]);
    } finally {
      late.close();
    }
  });
});

describe("an isolated plugin keeps its acceptJson rule (finding 10)", () => {
  /** A plugin that retries, through the broker, a 2xx body its own rule rejects (a transient GraphQL error). */
  const SOURCE = `import { defineProvider } from "pr-rla/provider";
export default defineProvider({
  providerApiVersion: 1, name: "picky", hosts: () => ["scm.example.com"],
  create(options, ctx) {
    return { apiVersion: 1, name: "picky", async listChanges() {
      const res = await ctx.fetch("https://scm.example.com/graphql-ish", { destination: "scm", retry: { acceptJson: (b) => (b && b.errors ? "transient: " + b.errors[0] : null) } });
      return { changes: [], defaultBranch: "main", limitations: [await res.text()] };
    } };
  },
});
`;
  const list = (p: ScmProvider) => p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] });
  it("the broker asks the child's rule about each body and retries what it rejects, as in process", async () => {
    const dir = auditDirWith({});
    writeFileSync(join(dir, "picky.mjs"), SOURCE);
    await lockPlugin(dir, "./picky.mjs");
    let calls = 0;
    const transport = (async () => new Response(JSON.stringify(++calls < 3 ? { errors: [`busy ${calls}`] } : { data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const logs: string[] = [];
    const actx = createAuditContext({ mode: "read-only", fetch: transport, sleep: async () => {}, log: (l) => logs.push(l) });
    const p = await openProvider(actx, { use: "./picky.mjs", options: {} }, dir);
    // Before the fix the rule became "the body parses", so the first {errors} body came back accepted.
    expect((await list(p)).limitations).toEqual([JSON.stringify({ data: { ok: true } })]);
    expect(calls).toBe(3);
    expect(logs.filter((l) => l.includes("transient: busy"))).toHaveLength(2);
  });
});

describe("P3's rate-limit hints through the host (fix/p3-pool-head × fix/plugins-broker)", () => {
  /** A plugin whose requests carry P3's hints: a blind wait (shorter than the broker's own) and a body pattern. */
  const SOURCE = `import { defineProvider } from "pr-rla/provider";
export default defineProvider({
  providerApiVersion: 1, name: "waits", hosts: () => ["scm.example.com"],
  create(options, ctx) {
    return { apiVersion: 1, name: "waits", async listChanges(req) {
      const res = await ctx.fetch("https://scm.example.com/" + req.repo, { destination: "scm", retry: { blindRateLimitWaitMs: 5, maxBlindRateLimitRetries: 2, rateLimitBody: "secondary rate limit" } });
      return { changes: [], defaultBranch: "main", limitations: [res.status + " " + (await res.text())] };
    } };
  },
});
`;
  const list = (p: ScmProvider, repo: string) => p.listChanges({ repo, window: WINDOW, kinds: ["pull_request"] });
  it("blindRateLimitWaitMs crosses the host, floored at the broker's own first backoff; rateLimitBody does not (it would run in pr-rla's process), so a body-only limit comes back at once", async () => {
    const dir = auditDirWith({});
    writeFileSync(join(dir, "waits.mjs"), SOURCE);
    await lockPlugin(dir, "./waits.mjs");
    const calls: Record<string, number> = {};
    const transport = (async (input: string | URL) => {
      const repo = new URL(String(input)).pathname.slice(1);
      const n = (calls[repo] = (calls[repo] ?? 0) + 1);
      // a/limited: a 429 that names no wait, twice; a/body: GitHub's secondary limit, said only in a 403's body.
      if (repo === "a/limited" && n <= 2) return new Response("slow down", { status: 429 });
      if (repo === "a/body") return new Response("You have exceeded a secondary rate limit", { status: 403 });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const actx = createAuditContext({ mode: "read-only", fetch: transport, sleep: async (ms) => void waits.push(ms), log: () => {} });
    const p = await openProvider(actx, { use: "./waits.mjs", options: {} }, dir);
    expect((await list(p, "a/limited")).limitations).toEqual(["200 ok"]);
    expect(calls["a/limited"]).toBe(3);
    // The plugin asked for 5 ms; the broker waited 1 s, then 2 s (doubling), never less than its own first backoff.
    expect(waits.filter((ms) => ms >= 1000)).toEqual([1000, 2000]);
    waits.length = 0;
    expect((await list(p, "a/body")).limitations).toEqual(["403 You have exceeded a secondary rate limit"]);
    expect(calls["a/body"]).toBe(1);
    expect(waits.filter((ms) => ms >= 1000)).toEqual([]);
  });
});

describe("pr-rla/http through the host (finding 15)", () => {
  /** The retrying JSON client, behind the broker as the SDK says (maxRetries: 0), with a rule for a transient GraphQL error. */
  const SOURCE = `import { defineProvider } from "pr-rla/provider";
import { createJsonClient, HttpError, HTTP_HELPER_VERSION } from "pr-rla/http";
export default defineProvider({
  providerApiVersion: 1, name: "http-user", hosts: () => ["scm.example.com"],
  create(options, ctx) {
    const c = createJsonClient({ base: "https://scm.example.com/api", fetch: ctx.fetch, maxRetries: 0, name: "http-user" });
    return { apiVersion: 1, name: "http-user", async listChanges() {
      const { data } = await c.request("/graphql-ish", { accept: (b) => (b && b.errors ? "transient GraphQL error" : null) });
      let missing = "none";
      try { await c.get("/missing"); } catch (e) { missing = e instanceof HttpError ? "HttpError " + e.status : String(e); }
      return { changes: [], defaultBranch: "main", limitations: [JSON.stringify({ data, missing, version: HTTP_HELPER_VERSION })] };
    } };
  },
});
`;
  it("an isolated plugin imports it from the host's own SDK (type-stripped from src/ here), and its accept rule is kept", async () => {
    const dir = auditDirWith({});
    writeFileSync(join(dir, "http-user.mjs"), SOURCE);
    await lockPlugin(dir, "./http-user.mjs");
    let calls = 0;
    const transport = (async (input: string | URL) => {
      if (String(input).endsWith("/missing")) return new Response("not here", { status: 404 });
      return new Response(JSON.stringify(++calls === 1 ? { errors: ["timeout"] } : { data: { n: calls } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const p = await openProvider(createAuditContext({ mode: "read-only", fetch: transport, sleep: async () => {} }), { use: "./http-user.mjs", options: {} }, dir);
    // Before the fix the child could not load it: ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX (parameter properties in src/sdk/http.ts).
    const r = await p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] });
    expect(JSON.parse(r.limitations[0]!)).toEqual({ data: { data: { n: 2 } }, missing: "HttpError 404", version: 1 });
    expect(calls).toBe(2);
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
