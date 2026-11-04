import { createHash } from "node:crypto";
import { DEFAULT_MAX_RETRIES, backoffMs, blindRateLimitWaitMs, checkJsonBody, isRateLimited, isRetryableStatus, rateLimitedByBody, waitFromHeaders, type RetryHints } from "../sdk/http.js";
import {
  BrokerError,
  BrokerRetriesExhausted,
  BrokerTimeout,
  CredentialHostMismatch,
  DESTINATION_TIMEOUT_MS,
  HostNotAllowed,
  ReadOnlyViolation,
  TSA_RETRY_DEADLINE_MS,
  WritePathNotAllowed,
  type BrokerFetch,
  type BrokerInit,
  type Destination,
} from "./contract.js";
import { isGraphqlPath, isQueryOnly } from "./graphql.js";
import { RateGovernor, type GovernedRequest } from "./governor.js";
import { defaultBudgets, type HostBudgetDefault } from "./rate-limits.js";

/**
 * The fetch broker (contracts.md §2; ADR-002): the one function every outbound
 * HTTP request in the process goes through. Per request, in order:
 *
 * 1. host allowlist (each redirect hop re-checked; redirects are followed here, by hand);
 * 2. read-only guard (GET, HEAD, a GraphQL query; provider requests always; ledger
 *    writes only under their declared writePaths);
 * 3. credential swap (`prrla-cred:<ENV>`, `prrla-basic:<USER_ENV>:<TOKEN_ENV>`) for
 *    declared hosts only;
 * 4. rate governor: one budget per host, shared by every caller (./governor.ts);
 * 5. timeout by destination (SCM 30 s, authority 15 s, drand 15 s, Rekor 30 s);
 * 6. retry: the only retrier for callers wired to it (the phase-2 policy, src/sdk/http.ts);
 * 7. recorder, with secrets and e-mail addresses scrubbed; never in read-only mode.
 *
 * A caller is wired when its init names a `destination` (the BrokerInit contract).
 * A plugin that calls `ctx.fetch(url, init)` as plain fetch gets steps 1–5 and 7 and
 * one attempt: it brings its own retries, as phase-2 plugins do.
 */

export type BrokerMode = "read-write" | "read-only";

/** Who is calling, from the pluginId's namespace. Providers and unknown callers are always read-only. */
export type CallerRole = "provider" | "ledger" | "component" | "plugin";

export function roleOf(pluginId: string): CallerRole {
  if (pluginId.startsWith("provider:")) return "provider";
  if (pluginId.startsWith("ledger:")) return "ledger";
  if (pluginId.startsWith("pr-rla/")) return "component";
  return "plugin";
}

export interface Credential {
  value: string;
  hosts: Set<string>;
}

/** One recorded request and response, scrubbed (step 7). */
export interface RecordedExchange {
  pluginId: string;
  destination: Destination;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  /** SHA-256 of the request body, or null. */
  bodySha256: string | null;
  status: number;
  headers: Record<string, string>;
  response: string;
}

export interface BrokerPolicy {
  mode: BrokerMode;
  /** Hosts a plugin may contact; empty = any (built-ins and trust: full plugins). */
  hostsFor(pluginId: string): Set<string>;
  /** `host/path-prefix` entries where a ledger's non-read requests are allowed. */
  writePathsFor(pluginId: string): Set<string>;
  /** Env name -> the secret and the hosts it may be sent to. */
  credentialsFor(pluginId: string): Map<string, Credential>;
  /** Default budgets by host (`*.domain` entries match subdomains); see ./rate-limits.ts. */
  budgets: Map<string, HostBudgetDefault>;
  timeouts: Record<Destination, number>;
  recorder?: (exchange: RecordedExchange) => void;
}

export interface AttemptReport {
  host: string;
  destination: Destination;
  attempt: number;
  atMs: number;
  outcome: string;
}

export interface BrokerDeps {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; the command's clock, so retry deadlines run on it. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1): backoff jitter. */
  random?: () => number;
  /** Starts a request's timeout and returns its cancel (tests use it against hanging servers). */
  setTimer?: (fire: () => void, ms: number) => () => void;
  /** Retry and wait notices (stderr). */
  log?: (line: string) => void;
  tsaDeadlineMs?: number;
  /** Called once per timestamp-authority attempt, for verbose output and tests. */
  onAttempt?: (a: AttemptReport) => void;
}

/**
 * What went over the wire (U8: `freeze` reports its request count, and `--estimate` its request mix and latency).
 * Every attempt counts, retries and redirect hops included; a request refused before it was sent does not.
 */
export interface BrokerStats {
  requests: number;
  /** Time spent inside the transport (the command's clock), summed over attempts. */
  busyMs: number;
  /** Per host: attempts, how many carried credentials, and how many were GraphQL. */
  byHost: Map<string, { requests: number; authenticated: number; graphql: number }>;
}

export interface Broker {
  readonly fetch: BrokerFetch;
  readonly policy: Readonly<BrokerPolicy>;
  readonly governor: RateGovernor;
  readonly stats: Readonly<BrokerStats>;
  /**
   * A plain `fetch` for one plugin or component: the pluginId is fixed (a plugin cannot
   * speak as another), and providers and ledgers always use the SCM destination.
   * Calls that pass a BrokerInit (`destination`) are wired; others get one attempt.
   */
  bind(pluginId: string, destination?: Destination): typeof fetch;
}

const MAX_REDIRECTS = 10;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** A request body, as RequestInit types it (lib "dom" is not loaded). */
type Body = NonNullable<RequestInit["body"]>;

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const SECRET_HEADERS = new Set(["authorization", "private-token", "cookie", "proxy-authorization", "set-cookie"]);
const PLACEHOLDER = /prrla-cred:([A-Za-z_][A-Za-z0-9_]*)/;
const PLACEHOLDERS = /prrla-cred:([A-Za-z_][A-Za-z0-9_]*)/g;
const BASIC = /^prrla-basic:([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Connection errors that mean the request never reached the server (safe to retry a write). */
const BEFORE_SEND = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const realTimer = (fire: () => void, ms: number) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const scrubEmails = (s: string) => s.replace(EMAIL, (e) => `user-${sha256(e.toLowerCase()).slice(0, 8)}@example.invalid`);
const scrubHeaders = (h: Headers): Record<string, string> => Object.fromEntries([...h].map(([k, v]) => [k, SECRET_HEADERS.has(k) ? "[scrubbed]" : scrubEmails(v)]));

function bodyBytes(body: Body | null | undefined): Uint8Array | string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return body.toString();
  return null;
}

function bodyText(body: Body | null | undefined): string | null {
  const b = bodyBytes(body);
  return b === null ? null : typeof b === "string" ? b : new TextDecoder().decode(b);
}

const withUrl = (res: Response, url: string): Response => Object.defineProperty(res, "url", { value: url, enumerable: true });

function isBeforeSend(e: unknown): boolean {
  const code = (e as { cause?: { code?: unknown } })?.cause?.code ?? (e as { code?: unknown })?.code;
  return typeof code === "string" && BEFORE_SEND.has(code);
}

interface Call {
  pluginId: string;
  destination: Destination;
  idempotent: boolean;
  url: URL;
  req: RequestInit;
}

export function createBroker(policy: Partial<BrokerPolicy> = {}, deps: BrokerDeps = {}): Broker {
  const p: BrokerPolicy = {
    mode: policy.mode ?? "read-write",
    hostsFor: policy.hostsFor ?? (() => new Set()),
    writePathsFor: policy.writePathsFor ?? (() => new Set()),
    credentialsFor: policy.credentialsFor ?? (() => new Map()),
    budgets: policy.budgets ?? defaultBudgets(),
    timeouts: { ...DESTINATION_TIMEOUT_MS, ...policy.timeouts },
    ...(policy.recorder ? { recorder: policy.recorder } : {}),
  };
  if (p.mode === "read-only" && p.recorder) throw new Error("the fetch broker never records in read-only mode (contracts.md §2 step 7)");
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? realTimer;
  const log = deps.log ?? (() => {});
  const deadline = deps.tsaDeadlineMs ?? TSA_RETRY_DEADLINE_MS;
  const governor = new RateGovernor(p.budgets, now);
  const stats: BrokerStats = { requests: 0, busyMs: 0, byHost: new Map() };

  // Step 1.
  function checkHost(call: Call, url: URL): void {
    const allowed = p.hostsFor(call.pluginId);
    if (allowed.size && !allowed.has(url.host) && !allowed.has(url.hostname)) throw new HostNotAllowed(url.host, call.pluginId, [...allowed]);
  }

  // Step 2.
  function checkReadOnly(call: Call, url: URL, method: string, graphql: boolean, text: string | null): void {
    if (method === "GET" || method === "HEAD" || (graphql && text !== null && isQueryOnly(text))) return;
    const why = graphql ? "a GraphQL mutation or subscription, or not a GraphQL query" : `${method} is not a read`;
    const role = roleOf(call.pluginId);
    if (p.mode === "read-only") throw new ReadOnlyViolation(method, url.pathname, url.host, why);
    if (role === "provider" || role === "plugin") throw new ReadOnlyViolation(method, url.pathname, url.host, `${why}; provider requests are always read-only`);
    if (role === "ledger") {
      const allowed = [...p.writePathsFor(call.pluginId)];
      const target = [`${url.host}${url.pathname}`, `${url.hostname}${url.pathname}`];
      if (!allowed.some((prefix) => target.some((t) => t.startsWith(prefix)))) throw new WritePathNotAllowed(method, url.pathname, url.host, call.pluginId, allowed);
    }
  }

  // Step 3.
  function swapCredentials(call: Call, url: URL, original: Headers, crossOrigin: boolean): Headers {
    const creds = p.credentialsFor(call.pluginId);
    const secret = (env: string): string => {
      const c = creds.get(env);
      if (!c || !(c.hosts.has(url.host) || c.hosts.has(url.hostname))) throw new CredentialHostMismatch(env, url.host, c ? [...c.hosts] : []);
      return c.value;
    };
    const out = new Headers();
    for (const [name, value] of original) {
      const basic = name === "authorization" ? BASIC.exec(value) : null;
      if (basic) out.set(name, `Basic ${Buffer.from(`${secret(basic[1]!)}:${secret(basic[2]!)}`).toString("base64")}`);
      else if (PLACEHOLDER.test(value)) out.set(name, value.replace(PLACEHOLDERS, (_m, env: string) => secret(env)));
      else if (crossOrigin && SECRET_HEADERS.has(name)) continue; // a raw secret never follows a redirect to another origin
      else out.append(name, value);
    }
    return out;
  }

  // Step 5: one exchange under the destination's timeout, body read in full.
  async function send(call: Call, url: URL, method: string, headers: Headers, body: Body | null): Promise<Response> {
    const ms = p.timeouts[call.destination];
    const ctrl = new AbortController();
    const cancel = setTimer(() => ctrl.abort(), ms);
    const signal = call.req.signal ? AbortSignal.any([ctrl.signal, call.req.signal]) : ctrl.signal;
    try {
      const res = await doFetch(url, { ...call.req, method, headers, body, redirect: "manual", signal });
      const buf = NULL_BODY.has(res.status) ? null : await res.arrayBuffer();
      return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      if (ctrl.signal.aborted && !call.req.signal?.aborted) throw new BrokerTimeout(url.host, call.destination, ms);
      throw e;
    } finally {
      cancel();
    }
  }

  // Step 7.
  async function record(call: Call, url: URL, method: string, headers: Headers, body: Body | null, res: Response): Promise<void> {
    if (!p.recorder) return;
    const bytes = bodyBytes(body);
    p.recorder({
      pluginId: call.pluginId,
      destination: call.destination,
      method,
      url: scrubEmails(url.href),
      requestHeaders: scrubHeaders(headers),
      bodySha256: bytes === null ? null : sha256(bytes),
      status: res.status,
      headers: scrubHeaders(res.headers),
      response: scrubEmails(await res.clone().text()),
    });
  }

  /** Steps 1–5 and 7 for one attempt, following redirects hop by hop. */
  async function attempt(call: Call): Promise<Response> {
    let url = call.url;
    let method = (call.req.method ?? "GET").toUpperCase();
    let body: Body | null = call.req.body ?? null;
    const original = new Headers(call.req.headers);
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new BrokerError(`${url.host}: more than ${MAX_REDIRECTS} redirects`, "TOO_MANY_REDIRECTS", url.host, "check the URL");
      checkHost(call, url);
      const text = bodyText(body);
      const graphql = method === "POST" && isGraphqlPath(url.pathname);
      checkReadOnly(call, url, method, graphql, text);
      const headers = swapCredentials(call, url, original, url.origin !== call.url.origin);
      const g: GovernedRequest = {
        host: url.hostname,
        path: url.pathname,
        method,
        authenticated: headers.has("authorization") || headers.has("private-token"),
        graphql,
        write: graphql ? !(text !== null && isQueryOnly(text)) : !["GET", "HEAD", "OPTIONS"].includes(method),
      };
      const wait = governor.reserve(g);
      if (wait > 0) {
        if (wait >= 1000) log(`${url.host}: rate budget; waiting ${Math.ceil(wait / 1000)}s before ${method} ${url.pathname}`);
        await sleep(wait);
      }
      const release = await governor.slot(url.hostname);
      let res: Response;
      const sentAt = now();
      stats.requests++;
      const host = stats.byHost.get(url.hostname) ?? { requests: 0, authenticated: 0, graphql: 0 };
      host.requests++;
      if (g.authenticated) host.authenticated++;
      if (g.graphql) host.graphql++;
      stats.byHost.set(url.hostname, host);
      try {
        res = await send(call, url, method, headers, body);
      } finally {
        stats.busyMs += now() - sentAt;
        release();
      }
      governor.observe(g, res);
      await record(call, url, method, headers, body, res);
      const location = res.headers.get("location");
      if (REDIRECTS.has(res.status) && location) {
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          if (method !== "HEAD") method = "GET";
          body = null;
          original.delete("content-type");
        }
        url = new URL(location, url);
        continue;
      }
      return withUrl(res, url.href);
    }
  }

  const callerAborted = (call: Call) => call.req.signal?.aborted === true;

  /**
   * Step 6 for scm, beacon and rekor: at most maxRetries + 1 attempts; header-imposed waits are the governor's and do
   * not count. A rate limit that names no wait (P3: GitHub's secondary limits, which may say so only in the body) waits
   * the caller's `blindRateLimitWaitMs`, doubling, and gives up after `maxBlindRateLimitRetries` of them.
   */
  async function withRetries(call: Call, hints: RetryHints): Promise<Response> {
    const max = hints.maxRetries ?? DEFAULT_MAX_RETRIES;
    const maxBlind = hints.maxBlindRateLimitRetries ?? max;
    const start = now();
    let sends = 0;
    let errors = 0;
    let blind = 0;
    let rateWaits = 0;
    for (;;) {
      let problem: string;
      let status: number | null = null;
      let rateLimited = false;
      let told = false;
      let timeout: BrokerTimeout | null = null;
      sends++;
      try {
        const res = await attempt(call);
        if (res.ok && hints.acceptJson) {
          const { response, problem: why } = await checkJsonBody(res, hints.acceptJson);
          if (why === null || !call.idempotent) return withUrl(response, res.url);
          problem = why;
          status = res.status;
        } else if (!isRetryableStatus(res)) {
          const body = await rateLimitedByBody(res, hints);
          if (body === null) return res;
          status = res.status;
          problem = `HTTP ${res.status} (a rate limit, by its body: ${body})`;
          rateLimited = true;
        } else {
          status = res.status;
          problem = `HTTP ${res.status}`;
          rateLimited = isRateLimited(res);
          told = waitFromHeaders(res.headers, now()) !== null;
          if (!call.idempotent && !rateLimited) return res; // a non-idempotent request is never retried after a 5xx
        }
      } catch (e) {
        if ((e instanceof BrokerError && !(e instanceof BrokerTimeout)) || callerAborted(call)) throw e;
        if (!call.idempotent && !isBeforeSend(e)) throw e;
        if (e instanceof BrokerTimeout) timeout = e;
        problem = e instanceof BrokerTimeout ? e.lastProblem : (e as Error).message;
      }
      let giveUp: boolean;
      const blindWait = rateLimited && !told ? blindRateLimitWaitMs(hints, blind + 1) : null;
      if (told) giveUp = ++rateWaits > max;
      else if (blindWait !== null) giveUp = ++blind > maxBlind;
      else {
        errors++;
        giveUp = errors > max || (rateLimited && ++blind > maxBlind);
      }
      if (giveUp) {
        if (timeout) throw new BrokerTimeout(timeout.host, timeout.destination, timeout.ms, sends);
        throw new BrokerRetriesExhausted(call.url.host, sends, now() - start, problem, status, rateLimited);
      }
      const wait = told ? 0 : (blindWait ?? backoffMs(errors, random()));
      log(`${call.url.host}: ${problem} on ${call.req.method ?? "GET"} ${call.url.pathname}; retrying ${told ? "when the rate limit allows" : `in ${Math.round(wait / 1000)}s`}`);
      if (wait > 0) await sleep(wait);
    }
  }

  /**
   * Step 6 for tsa: retries until the per-request deadline (FR1.10); no attempt starts after it.
   * A wait a header imposes is slept by the governor before the next attempt; the deadline counts it.
   */
  async function untilDeadline(call: Call): Promise<Response> {
    const start = now();
    for (let n = 1; ; n++) {
      const at = now();
      let problem: string;
      let told: number | null = null;
      try {
        const res = await attempt(call);
        if (!isRetryableStatus(res)) {
          deps.onAttempt?.({ host: call.url.host, destination: call.destination, attempt: n, atMs: at - start, outcome: `HTTP ${res.status}` });
          return res;
        }
        problem = `HTTP ${res.status}`;
        told = waitFromHeaders(res.headers, now());
      } catch (e) {
        if ((e instanceof BrokerError && !(e instanceof BrokerTimeout)) || callerAborted(call)) throw e;
        problem = (e as Error).message;
      }
      deps.onAttempt?.({ host: call.url.host, destination: call.destination, attempt: n, atMs: at - start, outcome: problem });
      const wait = told ?? backoffMs(n, random(), 30_000);
      if (now() + wait - start > deadline) throw new BrokerRetriesExhausted(call.url.host, n, now() - start, problem);
      if (told === null) await sleep(wait);
    }
  }

  const brokerFetch: BrokerFetch = async (input, init: BrokerInit) => {
    const { pluginId, destination, idempotent = true, retry, ...req } = init;
    const call: Call = { pluginId, destination, idempotent, url: new URL(String(input)), req };
    if (destination === "tsa") return untilDeadline(call);
    if (retry === false) return attempt(call);
    return withRetries(call, retry ?? {});
  };

  return {
    fetch: brokerFetch,
    policy: p,
    governor,
    stats,
    bind(pluginId, destination = "scm") {
      const role = roleOf(pluginId);
      return (async (input: string | URL | Request, init?: RequestInit & Partial<BrokerInit>) => {
        let url: string | URL;
        let req: RequestInit & Partial<BrokerInit> = init ?? {};
        if (input instanceof Request) {
          url = input.url;
          req = { method: input.method, headers: input.headers, ...(input.body ? { body: await input.arrayBuffer() } : {}), signal: input.signal, ...init };
        } else url = input;
        const wired = typeof req.destination === "string";
        const dest: Destination = role === "component" && wired ? req.destination! : role === "component" ? destination : "scm";
        return brokerFetch(url, { ...req, pluginId, destination: dest, ...(wired ? {} : { retry: false }) });
      }) as typeof fetch;
    },
  };
}
