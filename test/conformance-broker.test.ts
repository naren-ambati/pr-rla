import { describe, expect, it } from "vitest";
import type { ChangeRecord, ProviderContext, ScmProvider } from "../src/sdk/provider.js";
import { formatConformanceReport, runProviderConformance, type ConformanceFixture } from "../src/testing/index.js";

/**
 * The kit's broker-shaped harness (functional-design.md §U2a): a provider that hands its
 * retries to the broker (BrokerInit `destination`, as the built-ins do) passes
 * `transient-faults` by recovering through the harness's retries; the same provider
 * calling plain fetch, with no retries of its own, fails it, exactly as in phase 2.
 */
const sha = (c: string) => c.repeat(40);
const W = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };
const pr = (n: number): ChangeRecord => ({
  id: `fake:acme/w#${n}`,
  kind: "pull_request",
  repo: "acme/w",
  url: `https://scm.example/acme/w/pull/${n}`,
  mergeSha: sha(String(n)),
  mergedAt: `2026-08-01T1${n}:00:00Z`,
  author: { login: "agent[bot]", kind: "bot" },
  mergedBy: { login: "maint", kind: "human" },
  reviews: [],
  changedLines: n,
  labels: [],
});
const PAGES = [[pr(1)], [pr(2)], [pr(3)]];
const server = (async (input: string | URL | Request) => {
  const page = Number(new URL(String(input instanceof Request ? input.url : input)).searchParams.get("page") ?? "1");
  return new Response(JSON.stringify({ values: PAGES[page - 1] ?? [], next: page < PAGES.length ? page + 1 : null }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

/** No retry loop of its own: one call per page. `wired` passes the broker contract. */
function provider(ctx: ProviderContext, wired: boolean): ScmProvider {
  return {
    apiVersion: 1,
    name: "fake",
    async listChanges(req) {
      const out: ChangeRecord[] = [];
      for (let page: number | null = 1; page !== null; ) {
        const init = wired ? ({ destination: "scm", retry: { acceptJson: () => null } } as RequestInit) : undefined;
        const res = await ctx.fetch(`https://scm.example/api/changes?page=${page}`, init);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { values: ChangeRecord[]; next: number | null };
        out.push(...body.values);
        page = body.next;
      }
      return { changes: out.filter((c) => req.kinds.includes(c.kind)), defaultBranch: "main", limitations: [] };
    },
  };
}

const fixture: ConformanceFixture = {
  name: "fake",
  request: { repo: "acme/w", window: W, kinds: ["pull_request"] },
  expect: { ids: PAGES.flat().map((c) => c.id), minPages: 3 },
  http: true,
  rateLimitFault: { status: 403, headers: (now) => ({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now + 20) }), minWaitMs: 19_000 },
};

describe("conformance kit: the broker-shaped harness", () => {
  it("a provider that hands retries to the broker passes transient-faults through the harness's retries", async () => {
    const r = await runProviderConformance((_f, h) => provider(h.context({ fetch: server }), true), [fixture]);
    expect(r.ok, formatConformanceReport(r)).toBe(true);
    expect(r.results.find((x) => x.check === "transient-faults")).toMatchObject({ ok: true });
  });

  it("the same provider calling plain fetch, with no retries, still fails it", async () => {
    const r = await runProviderConformance((_f, h) => provider(h.context({ fetch: server }), false), [fixture]);
    expect(r.results.find((x) => x.check === "transient-faults")).toMatchObject({ ok: false });
  });
});
