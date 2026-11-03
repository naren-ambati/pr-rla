import { describe, expect, it } from "vitest";
import type { ChangeRecord, ProviderContext, ScmProvider } from "../src/sdk/provider.js";
import { CONFORMANCE_CHECKS, runProviderConformance, formatConformanceReport, type ConformanceFixture, type ConformanceHarness } from "../src/testing/index.js";

/**
 * The kit's own tests: a small HTTP provider that passes, and one broken
 * variant per new check, each of which must FAIL exactly that check. A check
 * that cannot fail proves nothing.
 */
const sha = (c: string) => c.repeat(40);
const W = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };
const pr = (n: number, s: string, reviewer: { login: string; kind: "human" | "bot" }): ChangeRecord => ({
  id: `fake:acme/w#${n}`,
  kind: "pull_request",
  repo: "acme/w",
  url: `https://scm.example/acme/w/pull/${n}`,
  mergeSha: sha(s),
  mergedAt: `2026-08-01T1${n}:00:00Z`,
  author: { login: "agent[bot]", kind: "bot" },
  mergedBy: { login: "maint", kind: "human" },
  reviews: [{ author: reviewer, state: "COMMENTED", submittedAt: `2026-08-01T0${n}:00:00Z` }],
  changedLines: 10 * n,
  labels: [],
});
const push = (s: string): ChangeRecord => ({ id: `fake:acme/w@${sha(s)}`, kind: "direct_push", repo: "acme/w", url: `https://scm.example/c/${s}`, mergeSha: sha(s), mergedAt: "2026-08-01T20:00:00Z", author: { login: "alice", kind: "human" }, mergedBy: null, reviews: [], changedLines: 3, labels: [] });
// PR 2 was fast-forwarded: commits b (its head, the mergeSha) and c landed unchanged.
const PAGES: ChangeRecord[][] = [[pr(1, "a", { login: "reviewer[bot]", kind: "bot" })], [pr(2, "b", { login: "carol", kind: "human" })], [push("d")]];

type Variant = "good" | "no-retry" | "ignores-retry-after" | "ff-leak" | "bot-as-human" | "bypasses-harness" | "drops-page-on-error";

function fakeServer(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const page = Number(new URL(String(input)).searchParams.get("page") ?? "1");
    return new Response(JSON.stringify({ values: PAGES[page - 1] ?? [], next: page < PAGES.length ? page + 1 : null }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function provider(variant: Variant, ctx: ProviderContext): ScmProvider {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const get = async (url: string): Promise<{ values: ChangeRecord[]; next: number | null }> => {
    for (let attempt = 0; ; attempt++) {
      const res = await ctx.fetch(url);
      if (res.ok) return (await res.json()) as { values: ChangeRecord[]; next: number | null };
      const laterPage = !url.endsWith("page=1");
      if (variant === "no-retry" || (variant === "drops-page-on-error" && laterPage) || attempt >= 5 || (res.status < 500 && res.status !== 429 && res.status !== 403)) throw new Error(`HTTP ${res.status}`);
      const after = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      let wait = 100 * 2 ** attempt;
      if (variant !== "ignores-retry-after" && after > 0) wait = after * 1000;
      if (variant !== "ignores-retry-after" && res.headers.get("x-ratelimit-remaining") === "0" && reset > 0) wait = Math.max(wait, reset * 1000 - Date.now());
      await sleep(wait);
    }
  };
  return {
    apiVersion: 1,
    name: "fake",
    async listChanges(req) {
      const out: ChangeRecord[] = [];
      for (let page: number | null = 1; page !== null; ) {
        let body;
        try {
          body = await get(`https://scm.example/api/changes?page=${page}`);
        } catch (e) {
          if (variant === "drops-page-on-error" && page > 1) break;
          throw e;
        }
        out.push(...body.values.map((c) => structuredClone(c)));
        page = body.next;
      }
      if (variant === "ff-leak") out.push(push("c"));
      if (variant === "bot-as-human") for (const c of out) for (const r of c.reviews) r.author.kind = "human";
      return { changes: out.filter((c) => req.kinds.includes(c.kind)), defaultBranch: "main", limitations: [] };
    },
  };
}

const fixture: ConformanceFixture = {
  name: "fake",
  request: { repo: "acme/w", window: W, kinds: ["pull_request", "direct_push"] },
  expect: {
    ids: ["fake:acme/w#1", "fake:acme/w#2", `fake:acme/w@${sha("d")}`],
    prCommits: { "fake:acme/w#2": [sha("b"), sha("c")] },
    mergeShas: { "fake:acme/w#2": sha("b") },
    bots: ["agent[bot]", "reviewer[bot]"],
    humans: ["maint", "carol", "alice"],
    minPages: 3,
  },
  http: true,
  rateLimitFault: { status: 403, headers: (now) => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now + 20) }), minWaitMs: 19_000 },
};

const under = (variant: Variant) => (_f: ConformanceFixture, h: ConformanceHarness) =>
  provider(variant, variant === "bypasses-harness" ? { cwd: ".", env: {}, log: () => {}, fetch: fakeServer() } : h.context({ fetch: fakeServer() }));

const failed = async (variant: Variant) => (await runProviderConformance(under(variant), [fixture])).results.filter((r) => !r.ok).map((r) => r.check);

describe("conformance kit: the new checks can fail", () => {
  it("a well-behaved HTTP provider passes every check, none skipped", async () => {
    const r = await runProviderConformance(under("good"), [fixture]);
    expect(r.ok, formatConformanceReport(r)).toBe(true);
    expect(r.results.map((x) => x.check)).toEqual(CONFORMANCE_CHECKS);
    expect(r.results.filter((x) => x.skipped)).toEqual([]);
  });

  it("transient-faults: a provider that does not retry fails", async () => {
    expect(await failed("no-retry")).toEqual(["transient-faults"]);
  });

  it("transient-faults: ignoring Retry-After and rate-limit reset headers fails", async () => {
    const r = await runProviderConformance(under("ignores-retry-after"), [fixture]);
    const tf = r.results.find((x) => x.check === "transient-faults")!;
    expect(tf.ok).toBe(false);
    expect(tf.message).toMatch(/after the injected 429 with Retry-After: 7 the provider waited \d+ ms < 7000 ms/);
    expect(tf.message).toMatch(/after the injected rate-limit 403 the provider waited \d+ ms < 19000 ms/);
  });

  it("transient-faults: swallowing an error mid-walk (losing a page) fails", async () => {
    const r = await runProviderConformance(under("drops-page-on-error"), [fixture]);
    expect(r.results.find((x) => x.check === "transient-faults")!.message).toMatch(/records differ from the clean run/);
  });

  it("transient-faults: an HTTP provider that bypasses the harness fails instead of being skipped", async () => {
    expect(await failed("bypasses-harness")).toEqual(["transient-faults"]);
  });

  it("merge-strategies: a fast-forwarded PR commit returned as a direct push fails", async () => {
    const r = await runProviderConformance(under("ff-leak"), [fixture]);
    expect(r.results.find((x) => x.check === "merge-strategies")!.message).toMatch(/commit cccccccccccc of fake:acme\/w#2 was returned as direct push/);
  });

  it("bot-detection: a bot reviewer classified as human fails", async () => {
    const r = await runProviderConformance(under("bot-as-human"), [fixture]);
    expect(r.results.find((x) => x.check === "bot-detection")!.message).toBe("reviewer[bot] is kind human, expected bot");
  });

  it("a non-HTTP provider skips transient-faults; the report says so", async () => {
    const r = await runProviderConformance(provider("good", { cwd: ".", env: {}, log: () => {}, fetch: fakeServer() }), [{ ...fixture, http: undefined }]);
    expect(r.ok).toBe(true);
    expect(formatConformanceReport(r)).toMatch(/^skip fake › transient-faults: the provider made no requests through the harness/m);
  });
});
