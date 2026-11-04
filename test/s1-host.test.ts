import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBroker } from "../src/net/broker.js";
import { BrokerRetriesExhausted, CredentialHostMismatch, HostNotAllowed, ReadOnlyViolation, WritePathNotAllowed } from "../src/net/contract.js";
import { closeAllPluginHosts, hostedLedger, hostedProvider, startPluginHost, type PluginHost } from "../src/plugins/host.js";
import { DEFAULT_MAX_RETRIES, RETRIES_EXHAUSTED } from "../src/sdk/http.js";

/**
 * Round S1 (integration seams), items 3 and 5: a hostile isolated plugin can neither crash the process that hosts it
 * nor lift the broker's attempt limit. Every plugin here is synthetic, written for the test; no network.
 */

afterAll(() => closeAllPluginHosts());

const WINDOW = { opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-02-01T00:00:00Z" };

/** A plugin module in its own temp directory (synthetic). */
function pluginDir(source: string): string {
  // The real path: the child's permission grant is checked against it (tmpdir() is a symbolic link on macOS).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "prrla-s1-plugin-")));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "s1-plugin", version: "0.0.1", type: "module" }));
  writeFileSync(join(dir, "index.mjs"), source);
  return dir;
}

/** Rejections nothing awaited, while a test runs: each would have ended the MCP server or the CLI. */
const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => void unhandled.push(e);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => void process.off("unhandledRejection", onUnhandled));
/** Lets rejections from the last turns surface (they are reported after the microtasks drain). */
const settle = () => new Promise((r) => setTimeout(r, 50));
/** Settles `p`, or says it did not within `ms` (a hang must fail the test, not stall it). */
const within = <T>(p: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | "pending"> =>
  Promise.race([p.then((value) => ({ value }), (error: unknown) => ({ error })), new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);

/** A provider whose listChanges fetches with a method of `n` characters and reports the error code it got (synthetic). */
const METHOD_PLUGIN = `export default {
  providerApiVersion: 1,
  name: "meth",
  create: (o, ctx) => ({
    apiVersion: 1,
    name: "meth",
    async listChanges() {
      try { await ctx.fetch("https://api.example.com/x", { method: "P".repeat(o.n) }); } catch (e) { return { changes: [], defaultBranch: "main", limitations: [String(e.code), String(e.message.length)] }; }
      return { changes: [], defaultBranch: "main", limitations: ["sent"] };
    },
  }),
};
`;

describe("item 3: a reply too large for a frame never throws inside the host's handlers", () => {
  const readOnlyBroker = () => createBroker({ mode: "read-only", hostsFor: () => new Set(["api.example.com"]) }, { fetch: async () => new Response("{}") });

  it("a 34-million-character method: the broker's refusal reaches the plugin bounded, and nothing rejects unhandled (rv-seams-exp/method-crash-default.mjs)", async () => {
    const dir = pluginDir(METHOD_PLUGIN);
    const host = await startPluginHost({ kind: "provider", entry: join(dir, "index.mjs"), readPaths: [dir], env: { PR_RLA_HOST: "1" }, label: "meth" });
    try {
      const p = await hostedProvider(host, { n: 34 * 1024 * 1024 }, { cwd: dir, fetch: readOnlyBroker().bind("provider:meth"), log: () => {} });
      const r = await within(p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] }), 60_000);
      await settle();
      expect(unhandled).toEqual([]);
      // ReadOnlyViolation echoes the method twice; each echo is cut to about 2 KiB, so the whole error is small.
      expect(r).toMatchObject({ value: { limitations: ["READ_ONLY_VIOLATION", expect.any(String)] } });
      expect(Number((r as { value: { limitations: string[] } }).value.limitations[1])).toBeLessThan(6000);
    } finally {
      host.close();
    }
  }, 120_000);

  it("an error frame over a small message limit: the child gets a small fixed error for that fetch, and the host serves the next call (method-crash.mjs)", async () => {
    const dir = pluginDir(METHOD_PLUGIN);
    // 1,500 bytes stands in for the 64 MiB limit: the child's fetch (a 1,000-character method) fits it, the refusal
    // that echoes the method twice does not.
    const host = await startPluginHost({ kind: "provider", entry: join(dir, "index.mjs"), readPaths: [dir], env: { PR_RLA_HOST: "1" }, label: "meth", maxMessageBytes: 1500 });
    try {
      const p = await hostedProvider(host, { n: 1000 }, { cwd: dir, fetch: readOnlyBroker().bind("provider:meth"), log: () => {} });
      const first = await within(p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] }), 10_000);
      await settle();
      expect(unhandled).toEqual([]);
      expect(first).toMatchObject({ value: { limitations: ["MESSAGE_TOO_LARGE", expect.any(String)] } });
      // The host is still serving.
      const second = await within(p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] }), 10_000);
      expect(second).toMatchObject({ value: { limitations: ["MESSAGE_TOO_LARGE", expect.any(String)] } });
    } finally {
      host.close();
    }
  });

  it("an index larger than a frame: the ledger's index read fails in the child, so readVerdicts rejects at once instead of waiting forever (index-crash.mjs)", async () => {
    const dir = pluginDir(`export default {
  ledgerApiVersion: 1,
  name: "idx",
  create: (o, ctx) => ({ apiVersion: 1, name: "idx", async readVerdicts() { await ctx.index.read(); return []; }, async appendVerdict() {} }),
};
`);
    const host: PluginHost = await startPluginHost({ kind: "ledger", entry: join(dir, "index.mjs"), readPaths: [dir], env: { PR_RLA_HOST: "1" }, label: "idx", maxMessageBytes: 4096 });
    try {
      const index = { read: async () => ({ big: "x".repeat(8000) }), write: async () => {} };
      const l = await hostedLedger(host, {}, { cwd: dir, windowDir: dir, fetch: globalThis.fetch, log: () => {}, index });
      const r = await within(l.readVerdicts(), 10_000);
      await settle();
      expect(unhandled).toEqual([]);
      expect(r).toMatchObject({ error: { message: expect.stringMatching(/the ledger index could not be sent to the plugin \(.*over the 4096-byte message limit/) } });
    } finally {
      host.close();
    }
  });

  it("a child that sends a request id that is not a whole number (it would be echoed back in the answer) stops its host with the reason", async () => {
    // It rewrites its own fetch frame (as the retry plugins below do) so the frame's fid is a 1 MB string.
    const dir = pluginDir(`const orig = JSON.stringify;
JSON.stringify = function (v, ...rest) {
  if (v && v.type === "fetch") v = { ...v, fid: "x".repeat(1024 * 1024) };
  return orig.call(this, v, ...rest);
};
export default {
  providerApiVersion: 1,
  name: "ids",
  create: (o, ctx) => ({ apiVersion: 1, name: "ids", async listChanges() { await ctx.fetch("https://api.example.com/x"); return { changes: [], defaultBranch: "main", limitations: [] }; } }),
};
`);
    const host = await startPluginHost({ kind: "provider", entry: join(dir, "index.mjs"), readPaths: [dir], env: { PR_RLA_HOST: "1" }, label: "ids" });
    try {
      const p = await hostedProvider(host, {}, { cwd: dir, fetch: readOnlyBroker().bind("provider:ids"), log: () => {} });
      const r = await within(p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] }), 10_000);
      await settle();
      expect(unhandled).toEqual([]);
      expect(r).toMatchObject({ error: { code: "PLUGIN_HOST_FAILED", message: "plugin ids sent a fetch message whose fid is not a whole number" } });
    } finally {
      host.close();
    }
  });

  it("every broker refusal bounds what it echoes (about 2 KiB per string), so none can outgrow a frame or a log line", () => {
    const huge = "Z".repeat(5_000_000);
    const errors = [
      new ReadOnlyViolation(huge, `/${huge}`, "api.example.com", `${huge} is not a read`),
      new WritePathNotAllowed(huge, `/${huge}`, "api.example.com", "ledger:x", [huge]),
      new HostNotAllowed(`${huge}.example.com`, "provider:x", [huge]),
      new CredentialHostMismatch(huge, `${huge}.example.com`, [huge], { name: huge, overHttps: true }),
      new BrokerRetriesExhausted(`${huge}.example.com`, 7, 1000, `HTTP 503 ${huge}`),
    ];
    for (const e of errors) {
      expect(e.message.length).toBeLessThan(12_000);
      expect(e.host.length).toBeLessThan(2100);
      expect(e.message).toMatch(/… \(5,000,0\d\d characters\)/);
    }
    expect((errors[0] as ReadOnlyViolation).method.length).toBeLessThan(2100);
    // Short strings are not touched.
    expect(new ReadOnlyViolation("PUT", "/repos/o/r", "api.github.com", "PUT is not a read").message).toBe("read-only: PUT api.github.com/repos/o/r refused (PUT is not a read)");
  });
});

describe("item 5: a retry hint that is not a number never lifts the broker's attempt limit", () => {
  /** A provider that rewrites its own fetch frame so its retry hint arrives as `hint` (rv-seams-exp/retryplug; synthetic). */
  const retryPlugin = (hint: string) => `const orig = JSON.stringify;
JSON.stringify = function (v, ...rest) {
  if (v && v.type === "fetch" && v.broker && v.broker.retry) v = { ...v, broker: { ...v.broker, retry: { ...v.broker.retry, maxRetries: ${hint} } } };
  return orig.call(this, v, ...rest);
};
export default {
  providerApiVersion: 1,
  name: "retry",
  create: (o, ctx) => ({
    apiVersion: 1,
    name: "retry",
    async listChanges() {
      try { await ctx.fetch("https://api.example.com/x", { destination: "scm", retry: { maxRetries: 0 } }); } catch (e) { return { changes: [], defaultBranch: "main", limitations: [String(e.code)] }; }
      return { changes: [], defaultBranch: "main", limitations: [] };
    },
  }),
};
`;

  for (const [hint, what] of [
    ["{}", "an object (Math.floor({}) is NaN)"],
    ['"many"', "a string"],
    ["null", "null"],
  ] as const) {
    it(`maxRetries as ${what}: the broker's default applies, at most ${DEFAULT_MAX_RETRIES + 1} attempts (rv-seams-exp/retry-nan.mjs)`, async () => {
      const dir = pluginDir(retryPlugin(hint));
      let sends = 0;
      const broker = createBroker({ mode: "read-only", hostsFor: () => new Set(["api.example.com"]) }, { fetch: async () => (sends++, new Response("busy", { status: 503 })), sleep: () => new Promise((r) => setTimeout(r, 1)), log: () => {} });
      const host = await startPluginHost({ kind: "provider", entry: join(dir, "index.mjs"), readPaths: [dir], env: { PR_RLA_HOST: "1" }, label: "retry" });
      try {
        const p = await hostedProvider(host, {}, { cwd: dir, fetch: broker.bind("provider:retry"), log: () => {} });
        const r = await within(p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] }), 10_000);
        expect(r).toMatchObject({ value: { limitations: [RETRIES_EXHAUSTED] } });
        expect(sends).toBe(DEFAULT_MAX_RETRIES + 1);
      } finally {
        host.close();
      }
    });
  }

  it("a hint the host keeps (a finite number) still applies, capped: maxRetries 3 gives 4 attempts (rv-seams-exp/retry-control.mjs)", async () => {
    const dir = pluginDir(retryPlugin("3"));
    let sends = 0;
    const broker = createBroker({ mode: "read-only", hostsFor: () => new Set(["api.example.com"]) }, { fetch: async () => (sends++, new Response("busy", { status: 503 })), sleep: () => new Promise((r) => setTimeout(r, 1)), log: () => {} });
    const host = await startPluginHost({ kind: "provider", entry: join(dir, "index.mjs"), readPaths: [dir], env: { PR_RLA_HOST: "1" }, label: "retry" });
    try {
      const p = await hostedProvider(host, {}, { cwd: dir, fetch: broker.bind("provider:retry"), log: () => {} });
      expect(await within(p.listChanges({ repo: "a/b", window: WINDOW, kinds: ["pull_request"] }), 10_000)).toMatchObject({ value: { limitations: [RETRIES_EXHAUSTED] } });
      expect(sends).toBe(4);
    } finally {
      host.close();
    }
  });

  it("in depth, the broker itself refuses a cap that is not a finite number of 0 or more, before anything is sent", async () => {
    let sends = 0;
    // Its waits yield to the timers, so a broker that never stops retrying (as before S1) fails this test instead of starving it.
    const broker = createBroker({ mode: "read-only" }, { fetch: async () => (sends++, new Response("busy", { status: 503 })), sleep: () => new Promise((r) => setImmediate(r)), log: () => {} });
    for (const retry of [{ maxRetries: Number.NaN }, { maxRetries: Number.POSITIVE_INFINITY }, { maxRetries: -1 }, { maxRetries: {} as never }, { maxBlindRateLimitRetries: Number.NaN }, { blindRateLimitWaitMs: Number.NaN }]) {
      const r = await within(broker.fetch("https://api.example.com/x", { pluginId: "provider:p", destination: "scm", retry }), 5_000);
      expect(r).toMatchObject({ error: { code: "RETRY_HINT_INVALID", message: expect.stringMatching(/^the request's retry hint \w+ is not a finite number of 0 or more; nothing was sent$/) } });
    }
    expect(sends).toBe(0);
    // A good hint still works as before.
    expect(await within(broker.fetch("https://api.example.com/x", { pluginId: "provider:p", destination: "scm", retry: { maxRetries: 2 } }), 5_000)).toMatchObject({ error: { code: RETRIES_EXHAUSTED } });
    expect(sends).toBe(3);
  });
});

describe("item 8: in read-only mode a response reaches a built-in with the caller's secrets scrubbed", () => {
  it("an echoing server's body, headers and status text carry the token's placeholder, not the token, in every form; read-write is as before", async () => {
    const SECRET = "ghp_OPERATOR+SECRET/0123456789=";
    const transport = (async (_u: string | URL, init?: RequestInit) => {
      const t = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
      return new Response(JSON.stringify({ message: `you sent ${t}`, forms: [encodeURIComponent(t), Buffer.from(t).toString("base64")] }), { status: 404, statusText: `Not ${t}`, headers: { "content-type": "application/json", "x-echo": t } });
    }) as typeof fetch;
    const credentials = () => new Map([["GITHUB_TOKEN", { value: SECRET, hosts: new Set(["api.github.com"]) }]]);
    for (const mode of ["read-only", "read-write"] as const) {
      const broker = createBroker({ mode, credentialsFor: credentials }, { fetch: transport, sleep: async () => {}, log: () => {} });
      const res = await broker.bind("provider:github")("https://api.github.com/x", { headers: { authorization: "Bearer prrla-cred:GITHUB_TOKEN" } });
      const seen = `${res.statusText}\n${res.headers.get("x-echo")}\n${await res.text()}`;
      const forms = [SECRET, encodeURIComponent(SECRET), Buffer.from(SECRET).toString("base64")];
      if (mode === "read-only") {
        for (const f of forms) expect(seen).not.toContain(f);
        expect(seen).toContain("prrla-cred:GITHUB_TOKEN");
      } else expect(seen).toContain(SECRET);
    }
    // A value shorter than 8 characters is no secret worth corrupting a response for: one letter is in every JSON key.
    const short = createBroker({ mode: "read-only", credentialsFor: () => new Map([["T", { value: "t", hosts: new Set(["api.github.com"]) }]]) }, { fetch: (async () => new Response(JSON.stringify({ repository_url: "https://api.github.com/repos/o/r" }), { status: 200 })) as typeof fetch, sleep: async () => {}, log: () => {} });
    expect(await (await short.bind("provider:github")("https://api.github.com/x", { headers: { authorization: "Bearer prrla-cred:T" } })).json()).toEqual({ repository_url: "https://api.github.com/repos/o/r" });
  });
});
