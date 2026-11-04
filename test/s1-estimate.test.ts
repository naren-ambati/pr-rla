import { describe, expect, it } from "vitest";
import { createAuditContext } from "../src/api/context.js";
import { estimateFreeze } from "../src/api/freeze-estimate.js";
import { normalizeSelector } from "../src/core/selector.js";
import { RateGovernor } from "../src/net/governor.js";
import github from "../src/providers/github/index.js";
import type { ScmProvider } from "../src/sdk/provider.js";

/**
 * Round S1 (integration seams), item 4: `freeze_preview {estimate: true}` cannot block the event loop. A provider's
 * `estimateRequests` is a plugin's answer (over IPC, any JSON) or, for GitHub with a base_url, arithmetic on any
 * server's pages. Synthetic: hostile providers and a hostile GitHub Enterprise Server, no network.
 */

const WINDOW = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" };
const SEL = normalizeSelector({ kinds: ["pull_request"], unreviewed: "no-human-review" });


/** An audit context whose broker has sent one request to api.github.com, so the estimate replays that host's budgets. */
async function githubCtx() {
  const ctx = createAuditContext({ mode: "read-only", fetch: (async () => new Response("{}")) as typeof fetch });
  await ctx.broker.bind("provider:github")("https://api.github.com/x").catch(() => {});
  return ctx;
}
/** A provider whose estimate is `e`, after one request to api.github.com (rv-seams-exp/estimate-hang.mjs). */
function hostile(ctx: Awaited<ReturnType<typeof githubCtx>>, e: unknown): ScmProvider {
  return {
    apiVersion: 1,
    name: "hostile",
    listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }),
    estimateRequests: async () => {
      await ctx.broker.bind("provider:github")("https://api.github.com/repos/o/r/pulls");
      return e as never;
    },
  };
}

describe("item 4: the estimate replays a bounded number of batches, whatever count a provider names", () => {
  it("4 million predicted requests: the replay reserves at most two batches per step (it called the governor once per request, 2.9 s with no timer tick)", async () => {
    const ctx = await githubCtx();
    // Counts the governor's reservations (a spy that kept 4 million calls' arguments would itself take seconds).
    const reserve = RateGovernor.prototype.reserve;
    let calls = 0;
    RateGovernor.prototype.reserve = function (this: RateGovernor, ...a: Parameters<RateGovernor["reserve"]>) {
      calls++;
      return reserve.apply(this, a);
    };
    try {
      const e = await estimateFreeze({ ctx, provider: hostile(ctx, { requests: 4_000_000, graphql: 0 }), resolved: [{ repo: "o/r", repoId: null }], window: WINDOW, selector: SEL, listingRequests: 0, concurrency: 4 });
      // The replay's steps (two kinds each at most), and the broker's own reservation of the probe's request.
      expect(calls).toBeLessThanOrEqual(2 * 1000 + 2);
      expect(e).toMatchObject({ supported: true, requests: { repos: 4_000_000, total: 4_000_000 } });
      // The probes carried no token: GitHub's anonymous REST budget, 60 an hour, needs about 66,700 h.
      expect(e.wallMs.budget).toBeGreaterThan(60_000 * 3600_000);
    } finally {
      RateGovernor.prototype.reserve = reserve;
    }
  });

  it("the batched replay predicts what the one-at-a-time replay did, within a batch's share", async () => {
    const ctx = await githubCtx();
    const e = await estimateFreeze({ ctx, provider: hostile(ctx, { requests: 20_000, graphql: 5_000 }), resolved: [{ repo: "o/r", repoId: null }], window: WINDOW, selector: SEL, listingRequests: 0, concurrency: 4 });
    // One at a time, through a fresh governor holding the same budgets (what the replay did before S1).
    const clock = { t: ctx.nowMs() };
    const g = new RateGovernor(ctx.broker.policy.budgets, () => clock.t);
    const req = (q: boolean) => ({ host: "api.github.com", path: q ? "/graphql" : "/repos/o/r/pulls", method: q ? "POST" : "GET", authenticated: false, graphql: q, write: false });
    let done = 0;
    for (let i = 0; i < 20_000; i++) {
      const q = Math.floor(((i + 1) * 5_000) / 20_000) > done;
      if (q) done++;
      clock.t += g.reserve(req(q));
    }
    const stepwise = clock.t - ctx.nowMs();
    expect(Math.abs(e.wallMs.budget - stepwise) / stepwise).toBeLessThan(0.01);
  });

  it("an estimate that is not whole numbers of requests, or more than the repo set can count, prints no figures and says why", async () => {
    const { estimateProblem } = await import("../src/api/freeze-estimate.js");
    for (const [bad, why] of [
      [{ requests: Number.NaN }, /gives requests as a number that is not a whole count of requests/],
      [{ requests: Number.POSITIVE_INFINITY }, /gives requests as a number that is not a whole count/],
      [{ requests: -5 }, /not a whole number from 0 to/],
      [{ requests: 1.5 }, /not a whole count/],
      [{ requests: "9" }, /gives requests as text/],
      [{ requests: 10, graphql: 11 }, /gives more graphql requests than requests in all/],
      [{ requests: 10, probed: {} }, /gives probed as an object/],
      [null, /is not an object with a request count/],
      [{ requests: Number.MAX_SAFE_INTEGER }, /not a whole number from 0 to 4,503,599,627,370,495/],
    ] as const) {
      const ctx = await githubCtx();
      const e = await estimateFreeze({ ctx, provider: hostile(ctx, bad), resolved: [{ repo: "o/a", repoId: null }, { repo: "o/b", repoId: null }], window: WINDOW, selector: SEL, listingRequests: 0, concurrency: 4 });
      expect(e.supported).toBe(false);
      expect(e.reason).toMatch(why);
      expect(e.reason).toMatch(/^provider hostile's estimate for o\/a .*, so no figures are printed: 2 repos need at least 2 requests$/);
      expect(estimateProblem(bad, Math.floor(Number.MAX_SAFE_INTEGER / 2))).not.toBeNull();
    }
    expect(estimateProblem({ requests: 4, graphql: 1, probed: 2 }, 100)).toBeNull();
  });

  it("the replay stops when the call's signal aborts", async () => {
    const ctx = await githubCtx();
    const ac = new AbortController();
    ac.abort(new Error("stopped"));
    await expect(estimateFreeze({ ctx, provider: hostile(ctx, { requests: 5000 }), resolved: [{ repo: "o/r", repoId: null }], window: WINDOW, selector: SEL, listingRequests: 0, concurrency: 4, signal: ac.signal })).rejects.toThrow("stopped");
  });
});

describe("item 4: GitHub's projection is bounded against a hostile anonymous base_url server", () => {
  /** A GitHub Enterprise Server whose closed pull requests all carry one updated_at, 40 s after the window opened (synthetic). */
  function hostileGhes(at: string) {
    const fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const json = (v: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json", ...headers } });
      if (url.pathname === "/api/graphql") return json({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: "a".repeat(40) } } } } });
      if (url.pathname === "/api/v3/repos/o/r/pulls") {
        if (url.searchParams.get("page")) return json([]);
        const page = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, merged_at: at, updated_at: at, merge_commit_sha: "b".repeat(40), base: { ref: "main" } }));
        return json(page, { link: '<https://ghe.example.com/api/v3/repos/o/r/pulls?page=2>; rel="next"' });
      }
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    return github.create({ base_url: "https://ghe.example.com" }, { cwd: ".", env: {}, log: () => {}, fetch });
  }

  it("a page whose times span 0 ms is projected at most one page per second, not 100 per millisecond", async () => {
    const p = await hostileGhes("2026-07-01T00:00:40Z");
    const e = await p.estimateRequests!({ repo: "o/r", window: WINDOW, kinds: ["pull_request"] });
    // 100 pull requests, 40 s after the window opened: at most 100 per second gives 4,100, so 42 pages and 103 batches.
    expect(e.requests).toBeLessThan(200);
    expect(Number.isSafeInteger(e.requests) && Number.isSafeInteger(e.graphql!)).toBe(true);
  });

  it("times that do not parse are not used: the estimate is still whole numbers", async () => {
    const p = await hostileGhes("not a time");
    const e = await p.estimateRequests!({ repo: "o/r", window: WINDOW, kinds: ["pull_request"] });
    expect(Number.isSafeInteger(e.requests) && e.requests >= 1).toBe(true);
    expect(Number.isSafeInteger(e.graphql!)).toBe(true);
  });
});
