import { RETRIES_EXHAUSTED, TIMED_OUT, type RetryHints } from "../sdk/http.js";

/**
 * The fetch-broker contract (contracts.md §2). Every outbound HTTP request goes
 * through one function of this shape: the broker in ./broker.ts. (Bolt 1 bound
 * to a minimal adapter with the same signature; ./minimal-adapter.ts is now a
 * thin wrapper over the broker.)
 */

export type Destination = "scm" | "tsa" | "beacon" | "rekor";

export interface BrokerInit extends RequestInit {
  /** Who is asking: a plugin id, or "pr-rla/<component>" for built-in components. */
  pluginId: string;
  destination: Destination;
  /** false for non-idempotent writes (ledger writes): retried only before send and on 429. Default true. */
  idempotent?: boolean;
  /**
   * The caller's retry rules (attempt limit, blind-429 limit, JSON acceptance), or `false`
   * for one attempt whose response the caller handles itself. Ignored for `tsa`, which
   * retries until its deadline. Absent: the destination's default policy.
   */
  retry?: RetryHints | false;
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

/** A request got no response within its destination's timeout (NFR14). After retries, `attempts` says how many timed out. */
export class BrokerTimeout extends BrokerError {
  constructor(
    host: string,
    readonly destination: Destination,
    readonly ms: number,
    readonly attempts = 1,
  ) {
    super(`${host}: no response within ${ms / 1000} s (${destination})${attempts > 1 ? `, ${attempts} attempts` : ""}`, TIMED_OUT, host, "check the network or the service's status, then run the command again");
    this.name = "BrokerTimeout";
  }
  get lastProblem(): string {
    return `no response within ${this.ms / 1000} s`;
  }
}

export class BrokerRetriesExhausted extends BrokerError {
  constructor(
    host: string,
    readonly attempts: number,
    readonly elapsedMs: number,
    readonly lastProblem: string,
    /** The last response's status, when the last attempt got one. */
    readonly status: number | null = null,
    /** True when the service was rate limiting the requests. */
    readonly rateLimited = false,
  ) {
    super(`${host}: gave up after ${attempts} attempt(s) in ${Math.round(elapsedMs / 1000)} s (last: ${lastProblem})`, RETRIES_EXHAUSTED, host, rateLimited ? "the service is rate limiting this client; use a token, or run the command again later" : "the service is unavailable; run the command again later");
    this.name = "BrokerRetriesExhausted";
  }
}

/** Step 1: the URL's host (or a redirect hop's) is not in the plugin's declared hosts. */
export class HostNotAllowed extends BrokerError {
  constructor(
    host: string,
    readonly pluginId: string,
    readonly allowed: readonly string[],
  ) {
    super(`${pluginId} may not contact ${host} (declared hosts: ${allowed.join(", ") || "none"})`, "HOST_NOT_ALLOWED", host, "declare the host in the plugin's hosts(), or point it at a declared host");
    this.name = "HostNotAllowed";
  }
}

/** Step 2: a request that is not a read (GET, HEAD, a GraphQL query) under the read-only guard. */
export class ReadOnlyViolation extends BrokerError {
  constructor(
    readonly method: string,
    readonly path: string,
    host: string,
    why: string,
  ) {
    super(`read-only: ${method} ${host}${path} refused (${why})`, "READ_ONLY_VIOLATION", host, "this command or tool only reads; run the writing command yourself from the CLI");
    this.name = "ReadOnlyViolation";
  }
}

/** Step 2: a ledger's non-read request outside its declared writePaths. */
export class WritePathNotAllowed extends BrokerError {
  constructor(
    readonly method: string,
    readonly path: string,
    host: string,
    readonly pluginId: string,
    readonly allowed: readonly string[],
  ) {
    super(`${pluginId} may not ${method} ${host}${path} (it may write only under: ${allowed.join(", ") || "nothing"})`, "WRITE_PATH_NOT_ALLOWED", host, "declare the path in the ledger's writePaths(), or write to the audit repo or project");
    this.name = "WritePathNotAllowed";
  }
}

/**
 * Step 3: a credential placeholder addressed to an origin outside that credential's grant: another
 * host or port, a scheme other than https, or any hop after a redirect from https to http. Nothing
 * was sent. `target` names the refused destination when the host alone does not say why.
 */
export class CredentialHostMismatch extends BrokerError {
  constructor(
    readonly env: string,
    host: string,
    readonly allowed: readonly string[],
    target: { name: string; overHttps: true } | null = null,
  ) {
    super(`credential ${env} may be sent only to ${allowed.join(", ") || "no host"}${target ? " over https" : ""}, not ${target?.name ?? host}; nothing was sent`, "CREDENTIAL_HOST_MISMATCH", host, target ? `use the https URL of ${host}; a credential is never sent in clear text` : `declare ${host} in the plugin's credentials for ${env}, or remove the credential from this request`);
    this.name = "CredentialHostMismatch";
  }
}

/**
 * Step 3: the credential is locked for this host, but the person running the command has not
 * approved the grant on this machine (src/plugins/approvals.ts), so it is withheld. Nothing was sent.
 */
export class CredentialNotApproved extends BrokerError {
  constructor(
    readonly env: string,
    host: string,
    readonly pluginId: string,
    readonly approve: string,
  ) {
    super(`credential ${env} is withheld from ${pluginId}: you have not approved sending it to ${host} on this machine; nothing was sent`, "CREDENTIAL_NOT_APPROVED", host, `review the plugin, then: ${approve}`);
    this.name = "CredentialNotApproved";
  }
}

/**
 * Step 3: a credential placeholder in a header other than `authorization` and the header names the
 * plugin declares for that credential (finding 5). Nothing was sent.
 */
export class CredentialHeaderNotAllowed extends BrokerError {
  constructor(
    readonly env: string,
    readonly header: string,
    host: string,
  ) {
    super(`credential ${env} may be sent only in authorization${header === "authorization" ? "" : ` or a header its plugin declares for it, not in ${header}`}; nothing was sent`, "CREDENTIAL_HEADER_NOT_ALLOWED", host, `send it in authorization, or declare ${header} in the credential's headers`);
    this.name = "CredentialHeaderNotAllowed";
  }
}

/** Step 3: a credential its plugin declares an identity (`secret: false`) used anywhere but as the user of prrla-basic: (finding 8). Nothing was sent. */
export class CredentialIdentityOnly extends BrokerError {
  constructor(
    readonly env: string,
    host: string,
  ) {
    super(`credential ${env} is declared an identity (secret: false), so it is sent only as the user part of prrla-basic:<USER_ENV>:<TOKEN_ENV>; nothing was sent`, "CREDENTIAL_IDENTITY_ONLY", host, `use it as prrla-basic:${env}:<TOKEN_ENV>, or declare it a secret`);
    this.name = "CredentialIdentityOnly";
  }
}
