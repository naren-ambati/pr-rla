import { mapPool } from "../core/population.js";
import type { ResolvedRepo } from "../core/repo-set.js";
import type { Selector } from "../core/selector.js";
import { RateGovernor, type GovernedRequest } from "../net/governor.js";
import { budgetFor } from "../net/rate-limits.js";
import type { AuditWindow, RequestEstimate, ScmProvider } from "../sdk/provider.js";
import type { AuditContext } from "./context.js";

/**
 * `freeze --dry-run --estimate` (FR5.5; functional-design.md §U8): the requests and the wall time a pooled freeze
 * will take, before spending them.
 *
 * - **Requests.** The provider's `estimateRequests` probes the first page of what `listChanges` reads for a repo
 *   and extrapolates. At most `MAX_PROBED_REPOS` repos are probed (every k-th, in repo order); the rest are
 *   scaled from them. The `listRepos` pages the resolution made are counted as they happened.
 * - **Wall time.** The predicted requests are replayed through a fresh rate governor holding the broker's budgets
 *   (the published-limit defaults, `rate_limits:` overrides, and any limit a server's headers reported while probing),
 *   so it waits exactly as the real run's governor will. If the server is slow, the work itself can bound the run:
 *   requests × the latency the probes saw ÷ the repos in flight.
 *
 * The estimate reads; it writes nothing (no checkpoints), and an in-memory result is all it keeps.
 */

export const MAX_PROBED_REPOS = 200;

export interface FreezeEstimate {
  /** False when the provider cannot estimate: `reason` says so and no figures are given. */
  supported: boolean;
  reason?: string;
  repos: number;
  sampled: number;
  /** The host the requests go to (the one the probes used most), or null. */
  host: string | null;
  requests: {
    /** The listRepos pages the resolution made. */
    listing: number;
    /** The listChanges requests, scaled from the sample. */
    repos: number;
    rest: number;
    graphql: number;
    total: number;
    /** Requests the probes spent (included in the sample's share of `repos`). */
    probed: number;
  };
  wallMs: { predicted: number; budget: number; work: number };
  latencyMs: number;
  concurrency: number;
  /** What the broker's budgets for the host say, one line per rule that applied (for the output). */
  budget: string[];
}

export interface EstimateArgs {
  ctx: AuditContext;
  provider: ScmProvider;
  resolved: readonly ResolvedRepo[];
  window: AuditWindow;
  selector: Selector;
  /** Requests the resolution (listRepos) made, from the broker's stats before and after. */
  listingRequests: number;
  /** Repos in flight at once in the real run. */
  concurrency: number;
  maxProbed?: number;
  signal?: AbortSignal;
}

/** Every k-th repo, so the sample spans the sorted list. */
export function sampleRepos<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  return Array.from({ length: max }, (_, i) => items[Math.floor((i * items.length) / max)]!);
}

export async function estimateFreeze(a: EstimateArgs): Promise<FreezeEstimate> {
  const n = a.resolved.length;
  const empty = (reason: string): FreezeEstimate => ({
    supported: false,
    reason,
    repos: n,
    sampled: 0,
    host: null,
    requests: { listing: a.listingRequests, repos: 0, rest: 0, graphql: 0, total: a.listingRequests, probed: 0 },
    wallMs: { predicted: 0, budget: 0, work: 0 },
    latencyMs: 0,
    concurrency: a.concurrency,
    budget: [],
  });
  const estimate = a.provider.estimateRequests?.bind(a.provider);
  if (!estimate) return empty(`provider ${a.provider.name} cannot estimate its requests (it has no estimateRequests), so no figures are printed: ${n} repos need at least ${n} requests`);

  const stats = a.ctx.broker.stats;
  const before = { requests: stats.requests, busyMs: stats.busyMs, byHost: new Map([...stats.byHost].map(([h, v]) => [h, { ...v }])) };
  const sample = sampleRepos(a.resolved, a.maxProbed ?? MAX_PROBED_REPOS);
  const parts: RequestEstimate[] = await mapPool(sample, Math.max(1, a.concurrency), (r) =>
    estimate({ repo: r.repo, window: a.window, kinds: a.selector.kinds, ...(a.signal ? { signal: a.signal } : {}) }),
  );
  const scale = n / sample.length;
  const sum = (f: (e: RequestEstimate) => number) => parts.reduce((t, e) => t + f(e), 0);
  const requests = Math.round(sum((e) => e.requests) * scale);
  const graphql = Math.round(sum((e) => e.graphql ?? 0) * scale);
  const rest = requests - graphql;
  const probed = sum((e) => e.probed ?? 0);

  // The host the probes used most, whether they carried credentials, and how long a request takes there.
  const spent = [...stats.byHost].map(([host, v]) => ({ host, requests: v.requests - (before.byHost.get(host)?.requests ?? 0), authenticated: v.authenticated - (before.byHost.get(host)?.authenticated ?? 0) }));
  const main = spent.sort((x, y) => y.requests - x.requests)[0];
  const probeRequests = stats.requests - before.requests;
  const latencyMs = probeRequests > 0 ? (stats.busyMs - before.busyMs) / probeRequests : 0;
  const total = a.listingRequests + requests;

  let host: string | null = null;
  let budgetMs = 0;
  const budgetLines: string[] = [];
  if (main && main.requests > 0) {
    host = main.host;
    const authenticated = main.authenticated * 2 >= main.requests;
    budgetMs = replay(a.ctx, host, authenticated, a.listingRequests + rest, graphql, budgetLines);
  }
  const work = (total * latencyMs) / Math.max(1, Math.min(a.concurrency, n));
  return {
    supported: true,
    repos: n,
    sampled: sample.length,
    host,
    requests: { listing: a.listingRequests, repos: requests, rest, graphql, total, probed },
    wallMs: { predicted: Math.round(Math.max(budgetMs, work)), budget: Math.round(budgetMs), work: Math.round(work) },
    latencyMs: Math.round(latencyMs),
    concurrency: a.concurrency,
    budget: budgetLines,
  };
}

/**
 * Replays `rest` REST reads and `graphql` GraphQL queries (evenly interleaved, the order does not change the
 * total) through a fresh governor with the broker's budgets, and returns how long it waits. Limits a server reported
 * while probing are fed in through synthetic headers, so a 5,000/hour token is paced as the real run will pace it.
 */
function replay(ctx: AuditContext, host: string, authenticated: boolean, rest: number, graphql: number, lines: string[]): number {
  const clock = { t: ctx.nowMs() };
  const start = clock.t;
  const budgets = ctx.broker.policy.budgets;
  const fresh = new RateGovernor(budgets, () => clock.t);
  const req = (isGraphql: boolean): GovernedRequest => ({ host, path: isGraphql ? "/graphql" : "/repos/o/r/pulls", method: isGraphql ? "POST" : "GET", authenticated, graphql: isGraphql, write: false });
  for (const g of [req(false), req(true)]) {
    const w = ctx.broker.governor.windowFor(g);
    if (!w) continue;
    const headers: Record<string, string> = { "x-ratelimit-limit": String(w.limit), "x-ratelimit-remaining": String(Math.max(0, w.remaining)), "x-ratelimit-resource": g.graphql ? "graphql" : "core" };
    if (w.resetAtMs !== null) headers["x-ratelimit-reset"] = String(Math.ceil(w.resetAtMs / 1000));
    fresh.observe(g, new Response(null, { headers }));
    lines.push(`${host}: the server reports ${w.limit.toLocaleString("en-US")} ${g.graphql ? "GraphQL points" : "requests"} per window (${w.remaining.toLocaleString("en-US")} left); the estimate paces to that`);
  }
  const b = budgetFor(budgets, host);
  if (b) for (const r of b.rules) if (r.auth === "any" || r.auth === (authenticated ? "authenticated" : "anonymous")) lines.push(`${host}: ${r.id}${r.primary ? "" : " (secondary)"}: ${r.published}`);
  const total = rest + graphql;
  let doneGraphql = 0;
  for (let i = 0; i < total; i++) {
    // Bresenham: GraphQL requests are spread evenly through the run.
    const wantGraphql = Math.floor(((i + 1) * graphql) / Math.max(1, total)) > doneGraphql;
    if (wantGraphql) doneGraphql++;
    clock.t += fresh.reserve(req(wantGraphql));
  }
  return clock.t - start;
}

const duration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
};

/** The estimate as output lines. `msLeftBeforeR` (null when unknown) adds the warning the draft asks for. */
export function estimateLines(e: FreezeEstimate, msLeftBeforeR: number | null): string[] {
  const f = (n: number) => n.toLocaleString("en-US");
  if (!e.supported) return [`estimate: ${e.reason}`];
  const out = [
    `estimate: ${f(e.repos)} repos${e.sampled < e.repos ? ` (probed ${f(e.sampled)} of them, every ${(e.repos / e.sampled).toFixed(1)}th, and scaled)` : " (all probed)"}`,
    `  requests: ~${f(e.requests.total)} = ${f(e.requests.listing)} listing + ~${f(e.requests.repos)} for the repos (~${f(e.requests.rest)} REST, ~${f(e.requests.graphql)} GraphQL); the probes already spent ${f(e.requests.probed)}`,
    `  wall time: ~${duration(e.wallMs.predicted)} at ${f(e.concurrency)} repos at a time${e.wallMs.budget >= e.wallMs.work ? ` (bound by the rate budget: ${duration(e.wallMs.budget)})` : ` (bound by request latency, ${e.latencyMs} ms each: ${duration(e.wallMs.work)}; the rate budget alone needs ${duration(e.wallMs.budget)})`}`,
    ...e.budget.map((l) => `  budget ${l}`),
    "  the figures are predictions from the first pages of each repo: request counts depend on how evenly the window's activity is spread, and a retried request counts again",
  ];
  if (msLeftBeforeR !== null) out.push(e.wallMs.predicted > msLeftBeforeR ? `  WARNING: the predicted wall time (${duration(e.wallMs.predicted)}) exceeds the time left before seed round R publishes (${duration(Math.max(0, msLeftBeforeR))}); a freeze that finishes after R is refused` : `  time left before seed round R publishes: ${duration(msLeftBeforeR)}`);
  return out;
}
