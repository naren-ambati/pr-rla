import { MAX_WAIT_MS, isRetryableStatus, readRateLimitHeaders } from "../sdk/http.js";
import { budgetFor, type AuthState, type HostBudgetDefault, type RateRule } from "./rate-limits.js";

/**
 * The rate governor (contracts.md §2 step 4): one budget per host, shared by every
 * caller in the process, because the broker holds the only instance.
 *
 * - **Defaults** are the token-bucket rules in ./rate-limits.ts for the host and the
 *   request's auth state.
 * - **Headers win.** A response's `Retry-After` pauses the whole host. Its remaining /
 *   reset headers become the budget for that resource (GitHub reports `core`,
 *   `graphql`, `search` …) and replace the primary default from then on.
 * - **Reservations.** A request reserves its slot when it asks (tokens may go negative,
 *   which queues it behind earlier reservations), so parallel callers interleave fairly
 *   and a wait is slept once, even on a clock that does not move.
 */

export interface GovernedRequest {
  host: string;
  path: string;
  method: string;
  authenticated: boolean;
  graphql: boolean;
  /** A non-read: a REST POST/PUT/PATCH/DELETE, or a GraphQL mutation. */
  write: boolean;
}

interface Bucket {
  tokens: number;
  last: number;
}

interface ServerWindow {
  limit: number;
  remaining: number;
  resetAtMs: number | null;
}

const authOf = (r: GovernedRequest): AuthState => (r.authenticated ? "authenticated" : "anonymous");

/** Groups requests that share a server-reported budget: GraphQL, else the first path segment after any /api/vN root. */
function classOf(r: GovernedRequest): string {
  if (r.graphql) return "graphql";
  return r.path.replace(/^\/api\/v\d+(?:\.\d+)?(?=\/)/, "").split("/")[1] ?? "";
}

function applies(rule: RateRule, r: GovernedRequest): boolean {
  if (rule.auth !== "any" && rule.auth !== authOf(r)) return false;
  if (rule.pathPrefix && !r.path.startsWith(rule.pathPrefix)) return false;
  if (rule.keyPattern && !rule.keyPattern.test(r.path)) return false;
  switch (rule.scope) {
    case "all":
      return true;
    case "rest":
      return !r.graphql;
    case "graphql":
      return r.graphql;
    case "writes":
      return r.write;
  }
}

export class RateGovernor {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windows = new Map<string, ServerWindow>();
  private readonly resourceOf = new Map<string, string>();
  private readonly pausedUntil = new Map<string, number>();
  private readonly inFlight = new Map<string, number>();
  private readonly queued = new Map<string, (() => void)[]>();

  constructor(
    private readonly budgets: ReadonlyMap<string, HostBudgetDefault>,
    private readonly now: () => number,
  ) {}

  private budget(host: string): HostBudgetDefault | undefined {
    return budgetFor(this.budgets, host);
  }

  /** Reserves capacity for one request now and returns how long it must wait before it is sent. */
  reserve(r: GovernedRequest): number {
    const now = this.now();
    // What a server's headers impose is capped (a bogus header cannot stall a run for hours);
    // what the budget itself requires is not, or the budget would not hold.
    let told = Math.max(0, (this.pausedUntil.get(r.host) ?? 0) - now);
    let wait = 0;
    const auth = authOf(r);
    const resource = this.resourceOf.get(`${r.host}|${auth}|${classOf(r)}`);
    const win = resource !== undefined ? this.windows.get(`${r.host}|${auth}|${resource}`) : undefined;
    if (win) {
      if (win.resetAtMs !== null && now >= win.resetAtMs) {
        win.remaining = win.limit;
        win.resetAtMs = null;
      }
      win.remaining -= 1;
      if (win.remaining < 0 && win.resetAtMs !== null) told = Math.max(told, win.resetAtMs - now);
    }
    for (const rule of this.budget(r.host)?.rules ?? []) {
      if (!applies(rule, r) || (rule.primary && win)) continue;
      const key = `${r.host}|${auth}|${rule.id}|${rule.keyPattern?.exec(r.path)?.[1] ?? ""}`;
      const b = this.buckets.get(key) ?? { tokens: rule.burst, last: now };
      b.tokens = Math.min(rule.burst, b.tokens + (Math.max(0, now - b.last) * rule.count) / rule.perMs);
      b.last = Math.max(b.last, now);
      b.tokens -= rule.cost === "points" && r.write ? 5 : 1;
      this.buckets.set(key, b);
      if (b.tokens < 0) wait = Math.max(wait, (-b.tokens * rule.perMs) / rule.count);
    }
    return Math.ceil(Math.max(wait, Math.min(told, MAX_WAIT_MS)) - 1e-6);
  }

  /** Waits for an in-flight slot when the host limits concurrency; returns the release. A released slot passes straight to the next waiter. */
  async slot(host: string): Promise<() => void> {
    const limit = this.budget(host)?.concurrency?.limit;
    if (!limit) return () => {};
    const n = this.inFlight.get(host) ?? 0;
    if (n < limit) this.inFlight.set(host, n + 1);
    else await new Promise<void>((res) => (this.queued.get(host) ?? this.queued.set(host, []).get(host)!).push(res));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queued.get(host)?.shift();
      if (next) next();
      else this.inFlight.set(host, (this.inFlight.get(host) ?? 1) - 1);
    };
  }

  /** Takes in what a response's headers say. Returns the host pause it imposed, if any. */
  observe(r: GovernedRequest, res: Response): number | null {
    const now = this.now();
    const h = readRateLimitHeaders(res.headers, now);
    let paused: number | null = null;
    if (h.retryAfterMs !== null && isRetryableStatus(res)) {
      this.pausedUntil.set(r.host, Math.max(this.pausedUntil.get(r.host) ?? 0, now + h.retryAfterMs));
      paused = h.retryAfterMs;
    }
    if (h.remaining !== null) {
      const auth = authOf(r);
      const resource = h.resource ?? "*";
      this.resourceOf.set(`${r.host}|${auth}|${classOf(r)}`, resource);
      const prev = this.windows.get(`${r.host}|${auth}|${resource}`);
      this.windows.set(`${r.host}|${auth}|${resource}`, { limit: h.limit ?? prev?.limit ?? h.remaining, remaining: h.remaining, resetAtMs: h.resetAtMs });
    }
    return paused;
  }

  /** The server-reported budget currently in force for a request, if any (for tests and --verbose). */
  windowFor(r: GovernedRequest): Readonly<ServerWindow> | undefined {
    const auth = authOf(r);
    const resource = this.resourceOf.get(`${r.host}|${auth}|${classOf(r)}`);
    return resource === undefined ? undefined : this.windows.get(`${r.host}|${auth}|${resource}`);
  }
}
