import { BrokerRetriesExhausted, BrokerTimeout, DESTINATION_TIMEOUT_MS, TSA_RETRY_DEADLINE_MS, type BrokerFetch, type Destination } from "./contract.js";

/**
 * The minimal broker adapter U1 binds to until bolt 2 (contracts.md §2).
 *
 * - Every request gets its destination's timeout (TSA 15 s).
 * - `tsa` requests are retried on network errors, timeouts, 5xx and 429, with
 *   exponential backoff, until a 5-minute per-request deadline. No attempt
 *   starts after the deadline; the caller then drops that authority. This is
 *   the only retry loop for timestamp requests: the timestamp client does not loop.
 * - Hosts with a published request spacing are spaced (Sectigo >= 15 s, FreeTSA <= 1/s).
 * - Other destinations get one attempt with their timeout; their callers keep
 *   their phase-2 retries until bolt 2 moves them onto the broker.
 *
 * There is no host allowlist, read-only guard, credential swap or recorder here:
 * those are U2a's, and nothing in U1 needs them.
 */

/** Minimum spacing between requests to one host, from the hosts' published guidance (nfr-design.md §3). */
export const HOST_SPACING_MS: Readonly<Record<string, number>> = {
  "timestamp.sectigo.com": 15_000,
  "freetsa.org": 1_000,
};

export interface MinimalBrokerOptions {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. Injected so tests can run the retry policy on a fake clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1): backoff jitter. */
  random?: () => number;
  timeouts?: Partial<Record<Destination, number>>;
  tsaDeadlineMs?: number;
  hostSpacingMs?: Readonly<Record<string, number>>;
  /** Called once per attempt, for verbose output and tests. */
  onAttempt?: (a: { host: string; destination: Destination; attempt: number; atMs: number; outcome: string }) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

export function createMinimalBroker(o: MinimalBrokerOptions = {}): BrokerFetch {
  const f = o.fetch ?? globalThis.fetch;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  const timeouts = { ...DESTINATION_TIMEOUT_MS, ...o.timeouts };
  const deadline = o.tsaDeadlineMs ?? TSA_RETRY_DEADLINE_MS;
  const spacing = o.hostSpacingMs ?? HOST_SPACING_MS;
  const lastStart = new Map<string, number>();

  async function once(url: URL, init: RequestInit, destination: Destination): Promise<Response> {
    const gap = spacing[url.hostname];
    if (gap) {
      const prev = lastStart.get(url.hostname);
      if (prev !== undefined && now() - prev < gap) await sleep(gap - (now() - prev));
    }
    lastStart.set(url.hostname, now());
    const ms = timeouts[destination];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await f(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw new BrokerTimeout(url.host, destination, ms);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  return async (input, init) => {
    const { pluginId: _pluginId, destination, idempotent: _idempotent, ...req } = init;
    const url = new URL(String(input));
    if (destination !== "tsa") return once(url, req, destination);
    const start = now();
    for (let attempt = 1; ; attempt++) {
      const at = now();
      let problem: string;
      let wait: number | null = null;
      try {
        const res = await once(url, req, destination);
        if (res.status < 500 && res.status !== 429) {
          o.onAttempt?.({ host: url.host, destination, attempt, atMs: at - start, outcome: `HTTP ${res.status}` });
          return res;
        }
        problem = `HTTP ${res.status}`;
        wait = retryAfterMs(res);
        await res.body?.cancel().catch(() => {});
      } catch (e) {
        problem = (e as Error).message;
      }
      o.onAttempt?.({ host: url.host, destination, attempt, atMs: at - start, outcome: problem });
      const backoff = wait ?? Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.5 + random() / 2);
      if (now() + backoff - start > deadline) throw new BrokerRetriesExhausted(url.host, attempt, now() - start, problem);
      await sleep(backoff);
    }
  };
}
