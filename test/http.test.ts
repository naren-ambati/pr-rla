import { describe, expect, it } from "vitest";
import { GAVE_UP, HttpClient, HttpError, isoUtcSeconds, nextLink, waitFromHeaders } from "../src/providers/http.js";

const seq = (responses: (() => Response)[]) => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as unknown as typeof fetch;
  return { f, calls };
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const raw = (body: string, status: number, headers: Record<string, string> = {}) => () => new Response(body, { status, headers });

describe("shared HTTP client (GitLab, Bitbucket)", () => {
  it("reads every rate-limit header form", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(waitFromHeaders(new Headers({ "retry-after": "7" }), now)).toBe(7000);
    expect(waitFromHeaders(new Headers({ "retry-after": "Tue, 03 Nov 2026 12:00:30 GMT" }), now)).toBe(30_000);
    expect(waitFromHeaders(new Headers({ "ratelimit-remaining": "0", "ratelimit-reset": String(now / 1000 + 20) }), now)).toBe(21_000); // GitLab: epoch seconds
    expect(waitFromHeaders(new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "12" }), now)).toBe(12_000); // seconds from now
    expect(waitFromHeaders(new Headers({ ratelimit: '"baseline";r=0;t=600' }), now)).toBe(600_000); // Forgejo/Codeberg structured header
    expect(waitFromHeaders(new Headers({ ratelimit: '"baseline";r=1997;t=600' }), now)).toBeNull();
    expect(waitFromHeaders(new Headers({ "ratelimit-remaining": "498", "ratelimit-reset": "1793718000" }), now)).toBeNull();
  });

  it("retries 503, 429 (honouring Retry-After) and a truncated 200 body, then succeeds", async () => {
    const { f, calls } = seq([raw("unavailable", 503), raw("slow down", 429, { "retry-after": "9" }), raw('{"a":', 200), json({ ok: true })]);
    const waits: number[] = [];
    const c = new HttpClient({ provider: "t", baseUrl: "https://scm.example/api/", fetch: f, sleep: async (ms) => void waits.push(ms) });
    expect((await c.get<{ ok: boolean }>("/x")).data).toEqual({ ok: true });
    expect(calls).toEqual(Array(4).fill("https://scm.example/api/x"));
    expect(waits).toEqual([1000, 9000, 4000]);
  });

  it("does not retry a 404; gives up with the auth hint after repeated 429s", async () => {
    const c404 = new HttpClient({ provider: "t", baseUrl: "https://scm.example", fetch: seq([raw("nope", 404)]).f, sleep: async () => {} });
    await expect(c404.get("/missing")).rejects.toMatchObject({ status: 404 });
    const c429 = new HttpClient({ provider: "bitbucket-cloud", baseUrl: "https://scm.example", fetch: seq(Array(3).fill(raw("Rate limit for this resource has been exceeded", 429))).f, sleep: async () => {}, maxRetries: 2, rateLimitHint: "Set BITBUCKET_TOKEN." });
    const e = (await c429.get("/x").catch((x: unknown) => x)) as HttpError;
    expect(e.status).toBe(GAVE_UP);
    expect(e.message).toBe("bitbucket-cloud GET /x: gave up after 3 attempts (HTTP 429). Set BITBUCKET_TOKEN.");
  });

  it("gives up early on a 429 that says nothing about when to come back, when told to", async () => {
    const { f, calls } = seq(Array(10).fill(raw("Rate limit for this resource has been exceeded", 429)));
    const c = new HttpClient({ provider: "bitbucket-cloud", baseUrl: "https://scm.example", fetch: f, sleep: async () => {}, maxBlindRateLimitRetries: 2, rateLimitHint: "Set BITBUCKET_TOKEN." });
    await expect(c.get("/x")).rejects.toThrow(/gave up after 3 attempts \(HTTP 429\)\. Set BITBUCKET_TOKEN\./);
    expect(calls).toHaveLength(3);
    // A 429 WITH Retry-After is still retried up to maxRetries.
    const told = seq([...Array(4).fill(raw("slow down", 429, { "retry-after": "1" })), json({ ok: 1 })]);
    const c2 = new HttpClient({ provider: "bitbucket-cloud", baseUrl: "https://scm.example", fetch: told.f, sleep: async () => {}, maxBlindRateLimitRetries: 2 });
    expect((await c2.get<{ ok: number }>("/x")).data).toEqual({ ok: 1 });
  });

  it("waits for the reset before the next request when a success reports zero remaining", async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    const { f } = seq([json([], 200, { "ratelimit-remaining": "0", "ratelimit-reset": String(reset) }), json([1])]);
    const waits: number[] = [];
    const c = new HttpClient({ provider: "gitlab", baseUrl: "https://scm.example", fetch: f, sleep: async (ms) => void waits.push(ms) });
    await c.get("/a");
    await c.get("/b");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(25_000);
  });

  it("parses Link headers and normalizes timestamps", () => {
    expect(nextLink(new Headers({ link: '<https://x/a?page=1>; rel="first", <https://x/a?page=2>; rel="next"' }))).toBe("https://x/a?page=2");
    expect(nextLink(new Headers({}))).toBeNull();
    expect(isoUtcSeconds("2026-11-03T09:48:49.000+10:00")).toBe("2026-11-02T23:48:49Z");
    expect(isoUtcSeconds("2026-11-03T12:00:46.202450+00:00")).toBe("2026-11-03T12:00:46Z");
  });
});
