/**
 * The fetch-broker contract (contracts.md §2). Every outbound HTTP request goes
 * through one function of this shape. Bolt 2 (U2a) builds the real broker; until
 * then the minimal adapter in ./minimal-adapter.ts implements the parts U1 needs
 * (per-destination timeouts and the timestamp-authority retry policy) with the
 * same signature, so callers do not change when the broker lands.
 */

export type Destination = "scm" | "tsa" | "beacon" | "rekor";

export interface BrokerInit extends RequestInit {
  /** Who is asking: a plugin id, or "pr-rla/<component>" for built-in components. */
  pluginId: string;
  destination: Destination;
  /** false for non-idempotent writes (ledger writes): retried only before send and on 429. Default true. */
  idempotent?: boolean;
}

export type BrokerFetch = (input: string | URL, init: BrokerInit) => Promise<Response>;

/** Per-request timeouts by destination (NFR14). */
export const DESTINATION_TIMEOUT_MS: Readonly<Record<Destination, number>> = {
  scm: 30_000,
  tsa: 15_000,
  beacon: 15_000,
  rekor: 30_000,
};

/** Timestamp requests are retried until this per-request deadline: half the 10-minute tolerance (FR1.10). */
export const TSA_RETRY_DEADLINE_MS = 5 * 60_000;

/** Typed broker errors carry a code, the host and a next step (contracts.md §2, §7). */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly host: string,
    readonly next: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export class BrokerTimeout extends BrokerError {
  constructor(
    host: string,
    readonly destination: Destination,
    readonly ms: number,
  ) {
    super(`${host}: no response within ${ms / 1000} s (${destination})`, "BROKER_TIMEOUT", host, "check the network or the service's status, then run the command again");
    this.name = "BrokerTimeout";
  }
}

export class BrokerRetriesExhausted extends BrokerError {
  constructor(
    host: string,
    readonly attempts: number,
    readonly elapsedMs: number,
    readonly lastProblem: string,
  ) {
    super(`${host}: gave up after ${attempts} attempt(s) in ${Math.round(elapsedMs / 1000)} s (last: ${lastProblem})`, "BROKER_RETRIES_EXHAUSTED", host, "the service is unavailable; run the command again later");
    this.name = "BrokerRetriesExhausted";
  }
}
