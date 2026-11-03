import { describe, expect, it } from "vitest";
import { GitHubHttp } from "../src/providers/github/http.js";

const seq = (responses: (() => Response)[]) => {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]!()) as unknown as typeof fetch;
};
const json = (b: unknown, status = 200) => () => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("GitHub transport retries (seen on the real gh-aw run)", () => {
  const opts = { sleep: async () => {}, log: () => {} };

  it("retries a 503, then a truncated 200 body, then succeeds", async () => {
    const http = new GitHubHttp({ ...opts, fetch: seq([json({}, 503), () => new Response('{"data": {"repo', { status: 200 }), json({ data: { ok: 1 } })]) });
    expect(await http.graphql<{ ok: number }>("q", {})).toEqual({ ok: 1 });
    expect(http.requestCount).toBe(3);
  });

  it("retries a GraphQL timeout error but not a real query error", async () => {
    const http = new GitHubHttp({ ...opts, fetch: seq([json({ errors: [{ message: "Something went wrong while executing your query. This may be the result of a timeout" }] }), json({ data: { ok: 2 } })]) });
    expect(await http.graphql<{ ok: number }>("q", {})).toEqual({ ok: 2 });
    const bad = new GitHubHttp({ ...opts, fetch: seq([json({ errors: [{ message: "Field 'nope' doesn't exist on type 'Repository'" }] })]) });
    await expect(bad.graphql("q", {})).rejects.toThrow(/doesn't exist/);
  });

  it("does not retry a 404 and gives up after maxRetries", async () => {
    await expect(new GitHubHttp({ ...opts, fetch: seq([json({ message: "Not Found" }, 404)]) }).rest("/x")).rejects.toThrow(/HTTP 404/);
    await expect(new GitHubHttp({ ...opts, maxRetries: 2, fetch: seq([json({}, 502)]) }).rest("/x")).rejects.toThrow(/gave up after 3 attempts \(HTTP 502\)/);
  });
});
