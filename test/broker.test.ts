import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createBroker, type RecordedExchange } from "../src/net/broker.js";
import { BrokerRetriesExhausted, BrokerTimeout, CredentialHostMismatch, HostNotAllowed, ReadOnlyViolation, WritePathNotAllowed, type BrokerInit, type Destination } from "../src/net/contract.js";
import { isQueryOnly, operationKinds } from "../src/net/graphql.js";
import { BUDGET_FAMILIES, DEFAULT_HOSTS, HOST_SPACING_MS, applyRateOverrides, defaultBudgets, parseRate, type HostBudgetDefault } from "../src/net/rate-limits.js";
import { HEAD_QUERY, MORE_REVIEWS_QUERY, historyQuery, prBatchQuery } from "../src/providers/github/queries.js";
import { MORE_NOTES_QUERY, MR_BATCH_QUERY } from "../src/providers/gitlab/queries.js";
import { GitHubProvider } from "../src/providers/github/index.js";
import { GitLabProvider } from "../src/providers/gitlab/index.js";
import { BitbucketCloudProvider } from "../src/providers/bitbucket-cloud/index.js";
import { BitbucketDataCenterProvider } from "../src/providers/bitbucket-data-center/index.js";
import { fakeClock } from "./helpers/fake-clock.js";

/**
 * The fetch broker (U2a; contracts.md §2): FR10.1–FR10.5, NFR12, NFR14, on fake
 * transports and a fake clock, plus one hanging server on 127.0.0.1.
 */

const ok = (body: unknown = {}, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const raw = (body: string, status: number, headers: Record<string, string> = {}) => new Response(body, { status, headers });

/** A transport that records every request that reached it. */
function transport(respond: (url: URL, init: RequestInit, n: number) => Response | Promise<Response> = () => ok()) {
  const seen: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  const f = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({ url: url.href, method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers), body: init.body });
    return respond(url, init, seen.length);
  }) as unknown as typeof fetch;
  return { f, seen };
}
/** Responds with each of `responses` in turn, then 200 {}. */
const sequence = (...responses: (() => Response)[]) => transport((_u, _i, n) => responses[n - 1]?.() ?? ok({ done: true }));

const scm = (init: Partial<BrokerInit> = {}): BrokerInit => ({ pluginId: "provider:test", destination: "scm", ...init });
const gql = (query: string) => JSON.stringify({ query, variables: {} });
const noSleep = { sleep: async () => {} };

describe("FR10.3: the read-only guard", () => {
  const readOnly = () => {
    const t = transport();
    return { t, b: createBroker({ mode: "read-only" }, { fetch: t.f }) };
  };

  it("passes GET, HEAD and GraphQL queries (shorthand, named with variables, fragments, keywords inside strings and comments)", async () => {
    const { t, b } = readOnly();
    await b.fetch("https://api.example.com/repos/a/b", scm());
    await b.fetch("https://api.example.com/repos/a/b", scm({ method: "HEAD" }));
    for (const q of ["{ viewer { login } }", "query Q($n: Int = 1, $o: In = {a: 1}) { a(n: $n) { ...F } } fragment F on Mutation { id }", '# mutation { x }\nquery { search(q: "mutation { x }") { n } }', 'query { a(s: """mutation { b }""") }'])
      await b.fetch("https://ghe.example.com/api/graphql", scm({ method: "POST", body: gql(q) }));
    expect(t.seen.map((s) => s.method)).toEqual(["GET", "HEAD", "POST", "POST", "POST", "POST"]);
  });

  it("refuses a GraphQL mutation or subscription, a REST POST and an unreadable GraphQL body, and sends none of them", async () => {
    const { t, b } = readOnly();
    for (const q of ["mutation { addLabelsToLabelable(input: {}) { clientMutationId } }", "query A { a } mutation B { b }", "subscription { s }", "schema { query: Q }"])
      await expect(b.fetch("https://api.github.com/graphql", scm({ method: "POST", body: gql(q) }))).rejects.toThrow(ReadOnlyViolation);
    await expect(b.fetch("https://api.github.com/graphql", scm({ method: "POST", body: "not json" }))).rejects.toThrow(ReadOnlyViolation);
    const post = await b.fetch("https://api.github.com/repos/a/b/issues", scm({ method: "POST", body: "{}" })).catch((e: unknown) => e);
    expect(post).toBeInstanceOf(ReadOnlyViolation);
    expect(post).toMatchObject({ method: "POST", path: "/repos/a/b/issues", code: "READ_ONLY_VIOLATION", host: "api.github.com" });
    expect((post as Error).message).toBe("read-only: POST api.github.com/repos/a/b/issues refused (POST is not a read)");
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) await expect(b.fetch("https://api.github.com/x", scm({ method }))).rejects.toThrow(ReadOnlyViolation);
    expect(t.seen).toEqual([]);
  });

  it("guards provider requests in read-write mode too; components write only in read-write mode", async () => {
    const t = transport();
    const rw = createBroker({ mode: "read-write" }, { fetch: t.f });
    await expect(rw.fetch("https://gitlab.com/api/v4/projects/1/issues", scm({ method: "POST" }))).rejects.toThrow(/provider requests are always read-only/);
    await expect(rw.bind("some-plugin")("https://x.example/y", { method: "POST" })).rejects.toThrow(ReadOnlyViolation);
    await rw.fetch("https://tsa.example/", { pluginId: "pr-rla/timestamp", destination: "tsa", method: "POST", body: new Uint8Array([1]) });
    expect(t.seen).toHaveLength(1);
    const ro = createBroker({ mode: "read-only" }, { fetch: t.f });
    await expect(ro.fetch("https://tsa.example/", { pluginId: "pr-rla/timestamp", destination: "tsa", method: "POST" })).rejects.toThrow(ReadOnlyViolation);
    expect(t.seen).toHaveLength(1);
  });

  it("follows redirects itself and re-checks every hop: a cross-host redirect is refused for a plugin held to its hosts", async () => {
    const t = transport((u) => (u.pathname === "/old" ? raw("", 301, { location: "/new" }) : u.pathname === "/leak" ? raw("", 302, { location: "https://evil.example/steal" }) : ok({ at: u.pathname })));
    const b = createBroker({ hostsFor: (id) => (id === "provider:gitea" ? new Set(["codeberg.org"]) : new Set()) }, { fetch: t.f });
    const gitea = b.bind("provider:gitea");
    const moved = await gitea("https://codeberg.org/old");
    expect(await moved.json()).toEqual({ at: "/new" });
    expect(moved.url).toBe("https://codeberg.org/new");
    const e = await gitea("https://codeberg.org/leak").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HostNotAllowed);
    expect((e as Error).message).toBe("provider:gitea may not contact evil.example (declared hosts: codeberg.org)");
    await expect(gitea("https://evil.example/direct")).rejects.toThrow(HostNotAllowed);
    expect(t.seen.map((s) => s.url)).toEqual(["https://codeberg.org/old", "https://codeberg.org/new", "https://codeberg.org/leak"]);
  });

  it("every GraphQL document the built-in providers send is a query", () => {
    const docs = [HEAD_QUERY, MORE_REVIEWS_QUERY, prBatchQuery([1, 2, 3]), historyQuery(50), MR_BATCH_QUERY, MORE_NOTES_QUERY];
    for (const d of docs) {
      expect(operationKinds(d)).toEqual(["query"]);
      expect(isQueryOnly(gql(d))).toBe(true);
    }
  });
});

describe("ledger writes only under declared writePaths", () => {
  const t = transport(() => ok({}, {}, 201));
  const b = createBroker({ writePathsFor: (id) => (id === "ledger:github-issues" ? new Set(["api.github.com/repos/acme/audit/"]) : new Set()) }, { fetch: t.f });
  const ledger = b.bind("ledger:github-issues");

  it("allows a write under the prefix and refuses one outside it", async () => {
    expect((await ledger("https://api.github.com/repos/acme/audit/issues", { method: "POST", body: "{}" })).status).toBe(201);
    const e = await ledger("https://api.github.com/repos/acme/widgets/issues", { method: "POST", body: "{}" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WritePathNotAllowed);
    expect((e as Error).message).toBe("ledger:github-issues may not POST api.github.com/repos/acme/widgets/issues (it may write only under: api.github.com/repos/acme/audit/)");
    await expect(b.bind("ledger:other")("https://api.github.com/repos/acme/audit/issues", { method: "POST" })).rejects.toThrow(/may write only under: nothing/);
    expect(t.seen).toHaveLength(1);
  });

  it("in read-only mode even a declared write path is refused", async () => {
    const ro = createBroker({ mode: "read-only", writePathsFor: () => new Set(["api.github.com/repos/acme/audit/"]) }, { fetch: t.f });
    await expect(ro.bind("ledger:github-issues")("https://api.github.com/repos/acme/audit/issues", { method: "POST" })).rejects.toThrow(ReadOnlyViolation);
  });
});

describe("FR10.5: credentials are swapped in only for declared hosts", () => {
  const creds = new Map([
    ["JIRA_TOKEN", { value: "tok-123", hosts: new Set(["acme.atlassian.net"]) }],
    ["JIRA_EMAIL", { value: "me@acme.example", hosts: new Set(["acme.atlassian.net"]) }],
  ]);
  const setup = () => {
    const t = transport((u) => (u.pathname === "/hop" ? raw("", 302, { location: "https://elsewhere.example/landed" }) : ok()));
    const b = createBroker({ credentialsFor: (id) => (id === "ledger:jira" ? creds : new Map()) }, { fetch: t.f });
    return { t, jira: b.bind("ledger:jira"), b };
  };

  it("swaps a placeholder for a declared host", async () => {
    const { t, jira } = setup();
    await jira("https://acme.atlassian.net/rest/api/3/issue/A-1", { headers: { authorization: "Bearer prrla-cred:JIRA_TOKEN" } });
    expect(t.seen[0]!.headers.get("authorization")).toBe("Bearer tok-123");
  });

  it("refuses a placeholder addressed to another host and sends nothing, so that host never sees an Authorization header", async () => {
    const { t, jira } = setup();
    const e = await jira("https://evil.example/collect", { headers: { authorization: "Bearer prrla-cred:JIRA_TOKEN" } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CredentialHostMismatch);
    expect((e as Error).message).toBe("credential JIRA_TOKEN may be sent only to acme.atlassian.net, not evil.example; nothing was sent");
    await expect(jira("https://acme.atlassian.net/x", { headers: { authorization: "Bearer prrla-cred:UNDECLARED" } })).rejects.toThrow(/credential UNDECLARED may be sent only to no host/);
    await jira("https://evil.example/plain");
    expect(t.seen.map((s) => [s.url, s.headers.get("authorization")])).toEqual([["https://evil.example/plain", null]]);
  });

  it("turns prrla-basic:<USER_ENV>:<TOKEN_ENV> into Basic auth, for declared hosts only", async () => {
    const { t, jira } = setup();
    await jira("https://acme.atlassian.net/rest/api/3/myself", { headers: { authorization: "prrla-basic:JIRA_EMAIL:JIRA_TOKEN" } });
    expect(t.seen[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from("me@acme.example:tok-123").toString("base64")}`);
    await expect(jira("https://other.example/", { headers: { authorization: "prrla-basic:JIRA_EMAIL:JIRA_TOKEN" } })).rejects.toThrow(CredentialHostMismatch);
    expect(t.seen).toHaveLength(1);
  });

  it("never swaps a placeholder in a URL or a body", async () => {
    const { t, b } = setup();
    await b.fetch("https://acme.atlassian.net/x?t=prrla-cred:JIRA_TOKEN", { pluginId: "pr-rla/test", destination: "scm", method: "POST", body: "prrla-cred:JIRA_TOKEN" });
    expect(t.seen[0]!.url).toContain("prrla-cred:JIRA_TOKEN");
    expect(t.seen[0]!.body).toBe("prrla-cred:JIRA_TOKEN");
  });

  it("a credential never follows a redirect to another origin", async () => {
    const { t, jira, b } = setup();
    await expect(jira("https://acme.atlassian.net/hop", { headers: { authorization: "Bearer prrla-cred:JIRA_TOKEN" } })).rejects.toThrow(/may be sent only to acme\.atlassian\.net, not elsewhere\.example/);
    // A built-in's own token (no placeholder) is dropped at the origin change, as fetch itself does.
    await b.bind("provider:github")("https://acme.atlassian.net/hop", { headers: { authorization: "Bearer raw-token", "private-token": "glpat" } });
    const hops = t.seen.map((s) => [s.url, s.headers.get("authorization"), s.headers.get("private-token")]);
    expect(hops.slice(-2)).toEqual([
      ["https://acme.atlassian.net/hop", "Bearer raw-token", "glpat"],
      ["https://elsewhere.example/landed", null, null],
    ]);
  });
});

describe("finding 4: a credential goes only to its exact https origin, never in clear text", () => {
  const creds = new Map([
    ["JIRA_TOKEN", { value: "tok-123", hosts: new Set(["acme.atlassian.net"]) }],
    ["JIRA_EMAIL", { value: "me@acme.example", hosts: new Set(["acme.atlassian.net"]) }],
    ["FORGE_TOKEN", { value: "forge-456", hosts: new Set(["forge.example.com:8443"]) }],
  ]);
  const setup = (respond?: (u: URL) => Response) => {
    const t = transport(respond);
    const b = createBroker({ credentialsFor: () => creds }, { fetch: t.f });
    return { t, f: b.bind("ledger:jira"), raw: b.bind("provider:github") };
  };
  const bearer = { headers: { authorization: "Bearer prrla-cred:JIRA_TOKEN" } };

  it("refuses http: for the granted host, and sends nothing (it used to send Basic auth in clear text)", async () => {
    const { t, f } = setup();
    await expect(f("http://acme.atlassian.net/rest/api/3/myself", { headers: { authorization: "prrla-basic:JIRA_EMAIL:JIRA_TOKEN" } })).rejects.toThrow("credential JIRA_EMAIL may be sent only to acme.atlassian.net over https, not http://acme.atlassian.net; nothing was sent");
    await expect(f("http://acme.atlassian.net/x", bearer)).rejects.toMatchObject({ code: "CREDENTIAL_HOST_MISMATCH", next: "use the https URL of acme.atlassian.net; a credential is never sent in clear text" });
    expect(t.seen).toEqual([]);
  });

  it("refuses another port of the granted host; a grant with a port matches only that port; the default port is the same origin", async () => {
    const { t, f } = setup();
    await expect(f("https://acme.atlassian.net:8443/x", bearer)).rejects.toThrow("credential JIRA_TOKEN may be sent only to acme.atlassian.net, not acme.atlassian.net:8443; nothing was sent");
    await expect(f("https://forge.example.com/x", { headers: { authorization: "token prrla-cred:FORGE_TOKEN" } })).rejects.toThrow(/may be sent only to forge\.example\.com:8443, not forge\.example\.com;/);
    await f("https://forge.example.com:8443/x", { headers: { authorization: "token prrla-cred:FORGE_TOKEN" } });
    await f("https://ACME.atlassian.net:443/x", bearer);
    expect(t.seen.map((s) => [s.url, s.headers.get("authorization")])).toEqual([
      ["https://forge.example.com:8443/x", "token forge-456"],
      ["https://acme.atlassian.net/x", "Bearer tok-123"],
    ]);
  });

  it("never swaps on a hop after a redirect from https to http, even back on https; a raw secret header is dropped from then on too", async () => {
    const hops = (u: URL) => (u.pathname === "/down" ? raw("", 302, { location: "http://acme.atlassian.net/landing" }) : u.pathname === "/landing" && u.protocol === "http:" ? raw("", 302, { location: "https://acme.atlassian.net/back" }) : ok());
    const { t, f, raw: builtin } = setup(hops);
    await expect(f("https://acme.atlassian.net/down", bearer)).rejects.toThrow("credential JIRA_TOKEN may be sent only to acme.atlassian.net over https, not http://acme.atlassian.net; nothing was sent");
    // Before the fix the http hop carried "Bearer tok-123".
    expect(t.seen.map((s) => [s.url, s.headers.get("authorization")])).toEqual([["https://acme.atlassian.net/down", "Bearer tok-123"]]);
    t.seen.length = 0;
    await builtin("https://acme.atlassian.net/down", { headers: { authorization: "Bearer raw-token" } });
    expect(t.seen.map((s) => [s.url, s.headers.get("authorization")])).toEqual([
      ["https://acme.atlassian.net/down", "Bearer raw-token"],
      ["http://acme.atlassian.net/landing", null],
      ["https://acme.atlassian.net/back", null],
    ]);
  });

  it("a hostFromOption grant takes its port from the URL, and only an https URL grants anything", async () => {
    const { credentialGrants } = await import("../src/plugins/host.js");
    const declared = [{ env: "T", hosts: ["codeberg.org"], hostFromOption: "base_url" }];
    expect(credentialGrants(declared, { base_url: "https://forge.example.com:8443/" })).toEqual([{ env: "T", hosts: ["forge.example.com:8443"], hostFromOption: "base_url" }]);
    expect(credentialGrants(declared, { base_url: "https://forge.example.com:443" })).toEqual([{ env: "T", hosts: ["forge.example.com"], hostFromOption: "base_url" }]);
    expect(credentialGrants(declared, { base_url: "http://forge.example.com" })).toEqual([{ env: "T", hosts: [], hostFromOption: "base_url" }]);
  });
});

describe("FR10.2: the broker retries, with backoff and jitter, honouring rate-limit headers", () => {
  it("retries 503, 429 (Retry-After) and a truncated JSON body, then succeeds", async () => {
    const t = sequence(() => raw("unavailable", 503), () => raw("slow down", 429, { "retry-after": "9" }), () => raw('{"a":', 200), () => ok({ ok: true }));
    const waits: number[] = [];
    let now = 0;
    const b = createBroker({}, { fetch: t.f, now: () => now, random: () => 0.5, sleep: async (ms) => void (waits.push(ms), (now += ms)) });
    const res = await b.fetch("https://scm.example/x", scm({ retry: { acceptJson: () => null } }));
    expect(await res.json()).toEqual({ ok: true });
    expect(t.seen).toHaveLength(4);
    // Backoff 1 s then 2 s, times the jitter factor 0.75; the 429's 9 s is the governor's host pause.
    expect(waits).toEqual([750, 9000, 1500]);
  });

  it("a 204, 205 or 304 to a request with a JSON check passes through, with no body to check (it used to throw)", async () => {
    for (const status of [204, 205, 304]) {
      const t = transport(() => new Response(null, { status, headers: { "x-n": String(status) } }));
      const res = await createBroker({}, { fetch: t.f, ...noSleep }).fetch("https://scm.example/x", scm({ retry: { acceptJson: () => "never asked" } }));
      expect(res.status).toBe(status);
      expect(res.headers.get("x-n")).toBe(String(status));
      expect(await res.text()).toBe("");
      expect(t.seen).toHaveLength(1);
    }
  });

  it("gives up after 7 attempts (phase-2 maxRetries 6), naming the last status", async () => {
    const t = transport(() => raw("down", 503));
    const e = await createBroker({}, { fetch: t.f, ...noSleep }).fetch("https://scm.example/x", scm()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BrokerRetriesExhausted);
    expect(e).toMatchObject({ attempts: 7, status: 503, rateLimited: false, code: "BROKER_RETRIES_EXHAUSTED" });
    expect(t.seen).toHaveLength(7);
  });

  it("waits a rate-limit header imposes are not attempts: 3 × 503 and 4 × 429 with Retry-After still succeed", async () => {
    const t = sequence(...[503, 503, 503].map((s) => () => raw("", s)), ...Array.from({ length: 4 }, () => () => raw("", 429, { "retry-after": "1" })));
    const res = await createBroker({}, { fetch: t.f, ...noSleep }).fetch("https://scm.example/x", scm());
    expect(res.status).toBe(200);
    expect(t.seen).toHaveLength(8);
  });

  it("stops early on blind 429s when the caller says so (Bitbucket Cloud's hourly anonymous limit)", async () => {
    const t = transport(() => raw("Rate limit for this resource has been exceeded", 429));
    const e = await createBroker({}, { fetch: t.f, ...noSleep }).fetch("https://api.bitbucket.org/2.0/x", scm({ retry: { maxBlindRateLimitRetries: 2 } })).catch((x: unknown) => x);
    expect(e).toMatchObject({ attempts: 3, rateLimited: true });
  });

  it("does not retry a 4xx, and returns a transient GraphQL error only once the caller's rule accepts it", async () => {
    const t404 = transport(() => raw("nope", 404));
    expect((await createBroker({}, { fetch: t404.f }).fetch("https://scm.example/x", scm())).status).toBe(404);
    expect(t404.seen).toHaveLength(1);
    const t = sequence(() => ok({ errors: [{ message: "Something went wrong while executing your query" }] }), () => ok({ data: { a: 1 } }));
    const res = await createBroker({}, { fetch: t.f, ...noSleep }).fetch("https://api.github.com/graphql", scm({ method: "POST", body: gql("{ a }"), retry: { acceptJson: (b) => ((b as { errors?: unknown[] }).errors ? "GraphQL: transient" : null) } }));
    expect(await res.json()).toEqual({ data: { a: 1 } });
  });

  it("a non-idempotent request is retried on 429 and on connection errors before send, never after a 5xx", async () => {
    const post = (t: ReturnType<typeof transport>) => createBroker({}, { fetch: t.f, ...noSleep }).fetch("https://rekor.example/api/v2/log/entries", { pluginId: "pr-rla/rekor", destination: "rekor", idempotent: false, method: "POST", body: "{}" });
    const t5 = sequence(() => raw("", 503));
    expect((await post(t5)).status).toBe(503);
    expect(t5.seen).toHaveLength(1);
    const t429 = sequence(() => raw("", 429, { "retry-after": "0" }), () => ok({}, {}, 201));
    expect((await post(t429)).status).toBe(201);
    let n = 0;
    const refused = transport(() => {
      if (++n === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      return ok({}, {}, 201);
    });
    expect((await post(refused)).status).toBe(201);
    expect(refused.seen).toHaveLength(2);
    const reset = transport(() => {
      throw new TypeError("fetch failed: other side closed");
    });
    await expect(post(reset)).rejects.toThrow(/other side closed/);
    expect(reset.seen).toHaveLength(1);
  });

  it("a plugin's plain fetch call gets one attempt and its own response: it retries itself (phase-2 plugins)", async () => {
    const t = transport(() => raw("busy", 503));
    expect((await createBroker({}, { fetch: t.f }).bind("provider:gitea")("https://codeberg.org/api/v1/x")).status).toBe(503);
    expect(t.seen).toHaveLength(1);
  });

  describe("the built-in providers make one attempt per request; the broker is their only retrier", () => {
    const ctx = (f: typeof fetch) => ({ cwd: ".", env: {}, log: () => {}, fetch: f, now: () => 0 });
    const clients = {
      github: (f: typeof fetch) => (path: string) => new GitHubProvider({}, ctx(f)).http.rest(path),
      gitlab: (f: typeof fetch) => (path: string) => new GitLabProvider({}, ctx(f)).http.get(path),
      "bitbucket-cloud": (f: typeof fetch) => (path: string) => new BitbucketCloudProvider({}, ctx(f)).http.get(path),
      "bitbucket-data-center": (f: typeof fetch) => (path: string) => new BitbucketDataCenterProvider({ base_url: "https://bitbucket.example.com" }, ctx(f)).http.get(path),
    };
    it.each(Object.keys(clients))("%s: alone it gives up on the first 503; behind the broker it recovers", async (name) => {
      const make = clients[name as keyof typeof clients];
      const alone = sequence(() => raw("", 503));
      await expect(make(alone.f)("/x")).rejects.toThrow(/gave up after 1 attempts \(HTTP 503\)/);
      expect(alone.seen).toHaveLength(1);
      const brokered = sequence(() => raw("", 503));
      await make(createBroker({}, { fetch: brokered.f, ...noSleep }).bind(`provider:${name}`))("/x");
      expect(brokered.seen).toHaveLength(2);
      const down = transport(() => raw("", 502));
      await expect(make(createBroker({}, { fetch: down.f, ...noSleep }).bind(`provider:${name}`))("/x")).rejects.toThrow(/gave up after 7 attempts \(HTTP 502\)/);
    });

    it("Bitbucket Cloud still gives up early on blind 429s, with its token hint", async () => {
      const t = transport(() => raw("Rate limit for this resource has been exceeded", 429));
      await expect(clients["bitbucket-cloud"](createBroker({}, { fetch: t.f, ...noSleep }).bind("provider:bitbucket-cloud"))("/x")).rejects.toThrow(/gave up after 3 attempts \(HTTP 429\)\. .*BITBUCKET_TOKEN/);
    });
  });
});

describe("FR10.4: one rate governor per host, shared by every caller", () => {
  const budgetOf = (count: number, perMs: number, burst = count, concurrency: number | null = null): Map<string, HostBudgetDefault> =>
    new Map([["scm.example", { service: "Test", rules: [{ id: "api", scope: "all", cost: "requests", auth: "any", count, perMs, burst, primary: true, published: "test", source: "test" }], concurrency: concurrency ? { limit: concurrency, published: "test", source: "test" } : null }]]);

  it("two parallel callers share one budget under a fake clock", async () => {
    const run = async (shared: boolean) => {
      const clock = fakeClock(0);
      const starts: { who: string; at: number }[] = [];
      const t = transport((u) => (starts.push({ who: u.searchParams.get("who")!, at: clock.now() }), ok()));
      const make = () => createBroker({ budgets: budgetOf(2, 1000) }, { fetch: t.f, now: clock.now, sleep: clock.sleep });
      const one = make();
      const brokers = { a: one, b: shared ? one : make() };
      const caller = async (who: "a" | "b") => {
        for (let i = 0; i < 5; i++) await brokers[who].bind(`provider:${who}`)(`https://scm.example/x?who=${who}`);
      };
      await clock.run(Promise.all([caller("a"), caller("b")]));
      return starts;
    };
    const shared = await run(true);
    expect(shared.map((s) => s.at).sort((x, y) => x - y)).toEqual([0, 0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]);
    expect(shared.filter((s) => s.at === 0).map((s) => s.who).sort()).toEqual(["a", "b"]);
    // A budget per caller would have let both bursts through at once, at twice the rate.
    const separate = await run(false);
    expect(separate.filter((s) => s.at === 0)).toHaveLength(4);
  });

  it("a server header lower than the default slows the pace (GitLab.com, anonymous: default 500/min, server says 3)", async () => {
    const run = async (headers: boolean) => {
      const clock = fakeClock(1_800_000_000_000);
      const reset = Math.floor(clock.now() / 1000) + 60;
      const starts: number[] = [];
      const t = transport((_u, _i, n) => (starts.push(clock.now()), ok({}, headers ? { "ratelimit-limit": "3", "ratelimit-remaining": String(Math.max(0, 3 - n)), "ratelimit-reset": String(reset) } : {})));
      const b = createBroker({}, { fetch: t.f, now: clock.now, sleep: clock.sleep });
      await clock.run((async () => {
        for (let i = 0; i < 4; i++) await b.bind("provider:gitlab")("https://gitlab.com/api/v4/projects/1");
      })());
      return starts.map((s) => s - starts[0]!);
    };
    expect(await run(false)).toEqual([0, 0, 0, 0]);
    expect(await run(true)).toEqual([0, 0, 0, 61_000]); // until the reset, plus a second, as in phase 2
  });

  it("headers replace the default both ways: a server limit above the default is used (the gh-aw case)", async () => {
    const run = async (headers: boolean) => {
      const clock = fakeClock(1_800_000_000_000);
      const budgets = defaultBudgets();
      budgets.set("api.github.com", applyRateOverrides(budgets.get("api.github.com")!, { rest: "2/h" }, "test"));
      const starts: number[] = [];
      const t = transport((_u, _i, n) => (starts.push(clock.now()), ok({}, headers ? { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(5000 - n), "x-ratelimit-reset": String(Math.floor(clock.now() / 1000) + 3600), "x-ratelimit-resource": "core" } : {})));
      const b = createBroker({ budgets }, { fetch: t.f, now: clock.now, sleep: clock.sleep });
      await clock.run((async () => {
        for (let i = 0; i < 4; i++) await b.bind("provider:github")("https://api.github.com/repos/a/b", { headers: { authorization: "Bearer t" } });
      })());
      return starts.map((s) => s - starts[0]!);
    };
    expect(await run(false)).toEqual([0, 0, 1_800_000, 3_600_000]);
    expect(await run(true)).toEqual([0, 0, 0, 0]);
  });

  it("a search budget does not pace the core budget: headers are kept per reported resource", async () => {
    const clock = fakeClock(1_800_000_000_000);
    const reset = String(Math.floor(clock.now() / 1000) + 60);
    const starts: string[] = [];
    const t = transport((u) => {
      starts.push(`${u.pathname}@${clock.now() - 1_800_000_000_000}`);
      return u.pathname.startsWith("/search") ? ok({}, { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "30", "x-ratelimit-reset": reset, "x-ratelimit-resource": "search" }) : ok({}, { "x-ratelimit-remaining": "4000", "x-ratelimit-limit": "5000", "x-ratelimit-reset": reset, "x-ratelimit-resource": "core" });
    });
    const gh = createBroker({}, { fetch: t.f, now: clock.now, sleep: clock.sleep }).bind("provider:github");
    const auth = { headers: { authorization: "Bearer t" } };
    await clock.run((async () => {
      await gh("https://api.github.com/repos/a/b", auth);
      await gh("https://api.github.com/search/issues?q=x", auth);
      await gh("https://api.github.com/repos/a/b/pulls", auth);
      await gh("https://api.github.com/search/issues?q=y", auth);
    })());
    expect(starts).toEqual(["/repos/a/b@0", "/search/issues@0", "/repos/a/b/pulls@0", "/search/issues@61000"]);
  });

  it("Retry-After pauses the whole host, for every caller", async () => {
    const clock = fakeClock(0);
    const starts: string[] = [];
    const t = transport((u, _i, n) => (starts.push(`${u.pathname}@${clock.now()}`), n === 1 ? raw("", 429, { "retry-after": "30" }) : ok()));
    const b = createBroker({}, { fetch: t.f, now: clock.now, sleep: clock.sleep });
    await clock.run((async () => {
      expect((await b.bind("provider:a")("https://scm.example/a")).status).toBe(429); // a plain call: its caller sees the 429
      await b.bind("ledger:b")("https://scm.example/b");
      await b.bind("ledger:b")("https://other.example/c");
    })());
    expect(starts).toEqual(["/a@0", "/b@30000", "/c@30000"]);
  });

  it("concurrency: no more requests in flight per host than its limit (GitHub: 100)", async () => {
    let inFlight = 0;
    let most = 0;
    const t = transport(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok();
    });
    const b = createBroker({ budgets: budgetOf(1000, 1000, 1000, 2) }, { fetch: t.f });
    await Promise.all(Array.from({ length: 6 }, (_, i) => b.fetch(`https://scm.example/${i}`, scm())));
    expect(t.seen).toHaveLength(6);
    expect(most).toBe(2);
    expect(BUDGET_FAMILIES.github.concurrency?.limit).toBe(100);
  });
});

describe("NFR12: default budgets equal the published limits", () => {
  const H = 3_600_000;
  const MIN = 60_000;
  /**
   * The reviewed table: nfr-design.md §3, rows checked against the source pages on 2026-11-03.
   * Two rows differ from the design's table, each settled by U2a as the design asked:
   * - GitHub GraphQL is 1,000 points/h, not 5,000: GITHUB_TOKEN gets 1,000 per repository
   *   (GitHub Docs, GraphQL rate limits), and NFR12 takes the smallest published limit.
   * - GitLab.com anonymous is 500 requests/min per IP (GitLab Docs; the live header said 500).
   * Bolt 3 added GitLab.com's content-creation limits for gitlab-issues (same page, read 2026-11-03):
   * issue creation 200/min (per project and user), note creation 60/min (per user).
   */
  const TABLE: [family: string, rule: string, auth: string, count: number, perMs: number, burst: number, source: string][] = [
    ["github", "rest", "authenticated", 1_000, H, 1_000, "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api"],
    ["github", "rest_anonymous", "anonymous", 60, H, 60, "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api"],
    ["github", "rest_points", "any", 900, MIN, 900, "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api"],
    ["github", "graphql", "authenticated", 1_000, H, 1_000, "https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api"],
    ["github", "graphql_points", "any", 2_000, MIN, 2_000, "https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api"],
    ["github", "writes_per_minute", "any", 80, MIN, 80, "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api"],
    ["github", "writes_per_hour", "any", 500, H, 500, "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api"],
    ["gitlab", "api", "authenticated", 2_000, MIN, 2_000, "https://docs.gitlab.com/user/gitlab_com/rate_limits/"],
    ["gitlab", "api_anonymous", "anonymous", 500, MIN, 500, "https://docs.gitlab.com/user/gitlab_com/rate_limits/"],
    ["gitlab", "issue_create", "any", 200, MIN, 200, "https://docs.gitlab.com/user/gitlab_com/rate_limits/"],
    ["gitlab", "note_create", "any", 60, MIN, 60, "https://docs.gitlab.com/user/gitlab_com/rate_limits/"],
    ["bitbucket-cloud", "repositories", "authenticated", 1_000, H, 1_000, "https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/"],
    ["bitbucket-cloud", "anonymous", "anonymous", 60, H, 60, "https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/"],
    ["bitbucket-data-center", "api", "authenticated", 5, 1_000, 60, "https://confluence.atlassian.com/bitbucketserver/improving-instance-stability-with-rate-limiting-976171954.html"],
    ["jira-cloud", "issue_writes_2s", "any", 20, 2_000, 20, "https://developer.atlassian.com/cloud/jira/platform/rate-limiting/"],
    ["jira-cloud", "issue_writes_30s", "any", 100, 30_000, 100, "https://developer.atlassian.com/cloud/jira/platform/rate-limiting/"],
    ["sectigo", "spacing", "any", 1, 15_000, 1, "https://www.sectigo.com/resource-library/time-stamping-server"],
    ["freetsa", "spacing", "any", 1, 1_000, 1, "https://freetsa.org/freetsa.html"],
  ];

  it("every default equals its row, and there is no default without a row", () => {
    const code = Object.entries(BUDGET_FAMILIES).flatMap(([family, b]) => b.rules.map((r) => [family, r.id, r.auth, r.count, r.perMs, r.burst, r.source]));
    expect(code).toEqual(TABLE);
    expect(Object.fromEntries(Object.entries(BUDGET_FAMILIES).map(([f, b]) => [f, b.concurrency?.limit ?? null]))).toEqual({ github: 100, gitlab: null, "bitbucket-cloud": null, "bitbucket-data-center": null, "jira-cloud": null, sectigo: null, freetsa: null });
    expect(DEFAULT_HOSTS).toEqual({ "api.github.com": "github", "gitlab.com": "gitlab", "api.bitbucket.org": "bitbucket-cloud", "*.atlassian.net": "jira-cloud", "timestamp.sectigo.com": "sectigo", "freetsa.org": "freetsa" });
    expect(HOST_SPACING_MS).toEqual({ "timestamp.sectigo.com": 15_000, "freetsa.org": 1_000 });
    for (const b of Object.values(BUDGET_FAMILIES)) for (const r of b.rules) expect(r.published.length).toBeGreaterThan(10);
  });

  it("a limit raised in .pr-rla.yml is followed (Bitbucket Cloud anonymous: 60/h by default, raised to 600/h)", async () => {
    const { parseConfig } = await import("../src/config.js");
    const { createAuditContext } = await import("../src/api/context.js");
    const cfg = parseConfig("repo: a/b\nwindow: { name: w, start: 2026-07-01, end: 2026-09-30 }\nrate_limits:\n  api.bitbucket.org:\n    anonymous: 600/h\n", "/nonexistent/.pr-rla.yml");
    expect(cfg.rateLimits).toEqual({ "api.bitbucket.org": { anonymous: "600/h" } });
    const run = async (rateLimits: Record<string, Record<string, unknown>>) => {
      const clock = fakeClock(0);
      const starts: number[] = [];
      const t = transport(() => (starts.push(clock.now()), ok()));
      const ctx = createAuditContext({ mode: "read-write", fetch: t.f, nowMs: clock.now, sleep: clock.sleep, rateLimits });
      await clock.run((async () => {
        for (let i = 0; i < 61; i++) await ctx.broker.bind("provider:bitbucket-cloud")("https://api.bitbucket.org/2.0/repositories/a/b");
      })());
      return starts.at(-1);
    };
    expect(await run({})).toBe(60_000); // the 61st anonymous request waits for the hourly bucket to refill one
    expect(await run(cfg.rateLimits)).toBe(0);
  });

  it("refuses an unknown rule or a malformed rate, naming the key", async () => {
    const { parseConfig } = await import("../src/config.js");
    const { createAuditContext } = await import("../src/api/context.js");
    expect(() => createAuditContext({ mode: "read-write", rateLimits: { "api.github.com": { rset: "1/h" } } })).toThrow(/rate_limits\.api\.github\.com\.rset: GitHub has no rule "rset" \(rules: rest, rest_anonymous, rest_points, graphql, graphql_points, writes_per_minute, writes_per_hour, concurrency\)/);
    expect(() => parseConfig("repo: a/b\nwindow: { name: w, start: 2026-07-01, end: 2026-09-30 }\nrate_limits: { gitlab.com: { api: lots } }\n", "/x/.pr-rla.yml")).toThrow(/rate_limits\.gitlab\.com\.api: "lots" is not a rate/);
    expect(parseRate("20/2s")).toEqual({ count: 20, perMs: 2000 });
    expect(parseRate("5000/h")).toEqual({ count: 5000, perMs: 3_600_000 });
  });
});

describe("NFR14: per-destination timeouts against a hanging server", () => {
  let server: Server;
  let url = "";
  const hanging: ServerResponse[] = [];
  beforeAll(async () => {
    server = createServer((_req, res) => void hanging.push(res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    for (const r of hanging) r.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it.each<[Destination, number]>([
    ["scm", 30_000],
    ["tsa", 15_000],
    ["beacon", 15_000],
    ["rekor", 30_000],
  ])("a %s request with no response is aborted at %i ms", async (destination, ms) => {
    const armed: number[] = [];
    let fire: () => void = () => {};
    const b = createBroker({}, { setTimer: (f, t) => (armed.push(t), (fire = f), () => {}), tsaDeadlineMs: 0 });
    const before = hanging.length;
    const pending = b.fetch(url, { pluginId: "pr-rla/test", destination, retry: false }).catch((e: unknown) => e);
    await until(() => hanging.length > before); // the server holds the request and never answers
    expect(armed).toEqual([ms]);
    fire(); // the timer reaching its time
    const e = await pending;
    if (destination === "tsa") expect(e).toMatchObject({ code: "BROKER_RETRIES_EXHAUSTED", attempts: 1, lastProblem: `127.0.0.1:${new URL(url).port}: no response within ${ms / 1000} s (tsa)` });
    else expect(e).toMatchObject({ name: "BrokerTimeout", destination, ms, code: "BROKER_TIMEOUT" });
    if (destination !== "tsa") expect(e).toBeInstanceOf(BrokerTimeout);
  });
});

describe("step 7: the recorder", () => {
  it("records every exchange with secrets and e-mail addresses scrubbed", async () => {
    const exchanges: RecordedExchange[] = [];
    const t = transport(() => ok({ author: { email: "alice@example.com" } }, { "set-cookie": "s=1", "x-contact": "ops@example.org" }));
    const b = createBroker({ recorder: (e) => exchanges.push(e) }, { fetch: t.f });
    await b.fetch("https://gitlab.com/api/graphql", scm({ method: "POST", body: gql("{ a }"), headers: { authorization: "Bearer secret", "private-token": "glpat-x", cookie: "c=1", accept: "application/json" } }));
    expect(exchanges).toHaveLength(1);
    const e = exchanges[0]!;
    expect(e.requestHeaders).toMatchObject({ authorization: "[scrubbed]", "private-token": "[scrubbed]", cookie: "[scrubbed]", accept: "application/json" });
    expect(e.headers["set-cookie"]).toBe("[scrubbed]");
    expect(JSON.stringify(e)).not.toMatch(/secret|glpat|alice@example\.com|ops@example\.org/);
    expect(e.response).toMatch(/"email":"user-[0-9a-f]{8}@example\.invalid"/);
    expect(e).toMatchObject({ pluginId: "provider:test", destination: "scm", method: "POST", status: 200 });
    expect(e.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is never installed in read-only mode", async () => {
    const { createAuditContext } = await import("../src/api/context.js");
    expect(() => createBroker({ mode: "read-only", recorder: () => {} })).toThrow(/never records in read-only mode/);
    expect(() => createAuditContext({ mode: "read-only", recorder: () => {} })).toThrow(/read-only mode cannot record/);
  });
});
