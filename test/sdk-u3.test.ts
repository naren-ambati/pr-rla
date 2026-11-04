import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as providersHttp from "../src/providers/http.js";
import { HTTP_HELPER_VERSION, HttpClient, createJsonClient } from "../src/sdk/http.js";
import { assertProviderDefinition, changeRecordProblems, DEFAULT_REVIEW_GRANULARITY, PROVIDER_API_VERSION, type ChangeRecord } from "../src/sdk/provider.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (c: string) => c.repeat(40);

describe("pr-rla/http (FR7.5): the retrying JSON client under its own version", () => {
  it("is a package export with its own version constant, independent of the provider API version", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { exports: Record<string, { types: string; default: string }> };
    expect(pkg.exports["./http"]).toEqual({ types: "./dist/sdk/http.d.ts", default: "./dist/sdk/http.js" });
    expect(existsSync(join(ROOT, "src", "sdk", "http.ts"))).toBe(true);
    expect(HTTP_HELPER_VERSION).toBe(1);
    expect(PROVIDER_API_VERSION).toBe(1);
  });

  it("the built-ins re-export the same client, so their imports did not change", () => {
    expect(providersHttp.HttpClient).toBe(HttpClient);
    expect(createJsonClient({ base: "https://x.example", fetch })).toBeInstanceOf(HttpClient);
  });

  it("createJsonClient retries a 503 and a truncated body with its own retries, waiting as Retry-After says", async () => {
    const responses = [new Response("busy", { status: 503, headers: { "retry-after": "4" } }), new Response('{"a":', { status: 200 }), new Response('{"ok":true}', { status: 200 })];
    const waits: number[] = [];
    const urls: string[] = [];
    const client = createJsonClient({
      base: "https://forge.example.com/api/v1/",
      fetch: (async (url: string) => (urls.push(url), responses.shift()!)) as unknown as typeof fetch,
      sleep: async (ms) => void waits.push(ms),
      name: "gitea",
    });
    expect((await client.get<{ ok: boolean }>("/repos/a/b")).data).toEqual({ ok: true });
    expect(urls).toEqual(Array(3).fill("https://forge.example.com/api/v1/repos/a/b"));
    expect(waits[0]).toBe(4000);
  });

  it("with maxRetries: 0 (behind the broker) it makes one attempt and names itself in the error", async () => {
    const client = createJsonClient({ base: "https://x.example", fetch: (async () => new Response("down", { status: 502 })) as unknown as typeof fetch, maxRetries: 0, name: "gitea" });
    await expect(client.get("/y")).rejects.toThrow(/^gitea GET \/y: gave up after 1 attempts \(HTTP 502\)/);
  });
});

describe("provider SDK additions (FR7.7): optional, within API version 1", () => {
  const push: ChangeRecord = { id: `x:o/r@${sha("a")}`, kind: "direct_push", repo: "o/r", url: "u", mergeSha: sha("a"), mergedAt: "2026-08-01T00:00:00Z", author: { login: "git:a@example.com", kind: "human" }, mergedBy: null, reviews: [], changedLines: 1, labels: [] };
  const pr: ChangeRecord = { ...push, id: "x:o/r#1", kind: "pull_request", author: { login: "bob", kind: "human", id: "42" }, mergedBy: { login: "maint", kind: "human", id: "7" } };

  it("a phase-2 record and definition (none of the new fields) are still valid", () => {
    expect(changeRecordProblems(push)).toEqual([]);
    expect(() => assertProviderDefinition({ providerApiVersion: 1, name: "old", create: () => null }, "old")).not.toThrow();
    expect(DEFAULT_REVIEW_GRANULARITY).toBe("submission");
  });

  it("Actor.id and landedVia are checked when present", () => {
    expect(changeRecordProblems(pr)).toEqual([]);
    expect(changeRecordProblems({ ...pr, author: { login: "bob", kind: "human", id: "" } })).toEqual(["author.id must be a non-empty string when present"]);
    expect(changeRecordProblems({ ...push, landedVia: sha("b") })).toEqual([]);
    expect(changeRecordProblems({ ...push, landedVia: "abc" })).toEqual(["landedVia must be 40 or 64 lowercase hex characters when present"]);
    expect(changeRecordProblems({ ...pr, landedVia: sha("b") })).toEqual(["only a direct_push has landedVia"]);
    expect(changeRecordProblems({ ...push, landedVia: sha("a") })).toEqual(["landedVia names the merge that brought the commit in, not the commit itself"]);
  });

  it("reviewGranularity, populationOptions and reportsLandedVia are validated at load", () => {
    const def = (extra: Record<string, unknown>) => ({ providerApiVersion: 1, name: "p", create: () => null, ...extra });
    expect(() => assertProviderDefinition(def({ reviewGranularity: "first-comment-per-user", populationOptions: ["base_url"], reportsLandedVia: true }), "p")).not.toThrow();
    expect(() => assertProviderDefinition(def({ reviewGranularity: "per-thread" }), "p")).toThrow(/reviewGranularity must be "submission" or "first-comment-per-user"/);
    expect(() => assertProviderDefinition(def({ populationOptions: "base_url" }), "p")).toThrow(/populationOptions must be a list of option names/);
    expect(() => assertProviderDefinition(def({ reportsLandedVia: "yes" }), "p")).toThrow(/reportsLandedVia must be true or false/);
  });
});
