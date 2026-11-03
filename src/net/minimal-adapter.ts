import { createBroker, type AttemptReport } from "./broker.js";
import { DESTINATION_TIMEOUT_MS, type BrokerFetch, type Destination } from "./contract.js";
import { HOST_SPACING_MS, defaultBudgets, spacingBudget } from "./rate-limits.js";

/**
 * Bolt 1's adapter interface, kept so its callers and tests run unchanged: it now
 * builds the real broker (./broker.ts) in read-write mode with the default budgets,
 * so the `tsa` policy it was written to (15 s per attempt, retries until a 5-minute
 * deadline, Sectigo/FreeTSA spacing, Retry-After honoured, no retry on 4xx) is the
 * broker's own. New code should use createBroker or the AuditContext (src/api/context.ts).
 */

export { HOST_SPACING_MS };

export interface MinimalBrokerOptions {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. Injected so tests can run the retry policy on a fake clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1): backoff jitter. */
  random?: () => number;
  timeouts?: Partial<Record<Destination, number>>;
  tsaDeadlineMs?: number;
  /** Replaces the default spacing for timestamp authorities. */
  hostSpacingMs?: Readonly<Record<string, number>>;
  /** Called once per timestamp attempt, for verbose output and tests. */
  onAttempt?: (a: AttemptReport) => void;
}

export function createMinimalBroker(o: MinimalBrokerOptions = {}): BrokerFetch {
  const budgets = defaultBudgets();
  if (o.hostSpacingMs) {
    for (const host of Object.keys(HOST_SPACING_MS)) budgets.delete(host);
    for (const [host, ms] of Object.entries(o.hostSpacingMs)) budgets.set(host, spacingBudget(host, ms));
  }
  return createBroker(
    { timeouts: { ...DESTINATION_TIMEOUT_MS, ...o.timeouts }, budgets },
    {
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.now ? { now: o.now } : {}),
      ...(o.sleep ? { sleep: o.sleep } : {}),
      ...(o.random ? { random: o.random } : {}),
      ...(o.tsaDeadlineMs !== undefined ? { tsaDeadlineMs: o.tsaDeadlineMs } : {}),
      ...(o.onAttempt ? { onAttempt: o.onAttempt } : {}),
    },
  ).fetch;
}
