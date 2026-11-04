import { createHash } from "node:crypto";
import { bounded } from "../core/text.js";
import { abortable, sleepFor } from "./abort.js";
import { DEFAULT_MAX_RETRIES, backoffMs, blindRateLimitWaitMs, checkJsonBody, isRateLimited, isRetryableStatus, rateLimitedByBody, waitFromHeaders, type RetryHints } from "../sdk/http.js";
import {
  BrokerError,
  BrokerRetriesExhausted,
  BrokerTimeout,
  CredentialHeaderNotAllowed,
  CredentialHostMismatch,
  CredentialIdentityOnly,
  CredentialNotApproved,
  DESTINATION_TIMEOUT_MS,
  HostNotAllowed,
  ReadOnlyViolation,
  RetryHintInvalid,
  TSA_RETRY_DEADLINE_MS,
  WritePathNotAllowed,
  type BrokerFetch,
  type BrokerInit,
  type Destination,
} from "./contract.js";
import { isGraphqlPath, isQueryOnly } from "./graphql.js";
import { scrubBytes, scrubPairs, scrubText, type SecretValue } from "./scrub.js";
import { RateGovernor, type GovernedRequest } from "./governor.js";
import { defaultBudgets, type HostBudgetDefault } from "./rate-limits.js";

/**
 * The fetch broker (contracts.md §2; ADR-002): the one function every outbound
 * HTTP request in the process goes through. Per request, in order:
 *
 * 1. host allowlist (each redirect hop re-checked; redirects are followed here, by hand);
 * 2. read-only guard (GET, HEAD, a GraphQL query; provider requests always; ledger
 *    writes only under their declared writePaths);
 * 3. credential swap (`prrla-cred:<ENV>`, `prrla-basic:<USER_ENV>:<TOKEN_ENV>`) for the
 *    granted https origins only (host and port exact), never after a redirect from https to http,
 *    and only in `authorization` or a header the plugin declares for that credential;
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
  /**
   * The https origins it may go to, as URL hosts (`host`, or `host:port` for another port): the
   * scheme is always https, and the port must match exactly (finding 4).
   */
  hosts: Set<string>;
  /** Header names (lowercase), besides `authorization`, where its placeholder may be swapped (finding 5). */
  headers?: Set<string>;
  /** false: an identity (a Basic username): sent only as the user part of prrla-basic:, and not scrubbed (finding 8). */
  secret?: boolean;
  /**
   * Locked but not approved by the person running the command (src/plugins/approvals.ts): never
   * swapped; a placeholder for it is refused with CREDENTIAL_NOT_APPROVED, naming `approve`.
   */
  withheld?: { approve: string };
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
  /** Waits (the governor's and retry backoff). Passed the request's signal, which also cuts the wait short (U5). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  /**
   * Responses of 401, 403 or 404 (after redirects), by caller (time round B): with the caller's credential standing
   * (`AuditContext.credentialStanding`) they tell "not there" from "not readable without the credential you withheld".
   */
  denied: DeniedRead[];
  /** 2xx responses by caller: a caller with any is not wholly refused (src/api/access.ts). */
  answered: Map<string, number>;
}

/** A read the server refused or did not show (HTTP 401, 403 or 404). */
export interface DeniedRead {
  pluginId: string;
  status: 401 | 403 | 404;
  method: string;
  host: string;
  path: string;
  /** Whether the request carried a credential (an authorization or private-token header). */
  authenticated: boolean;
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
/** The shortest secret read-only mode scrubs from responses: 8 characters, NIST SP 800-63B's minimum for a memorized secret. */
const MIN_SCRUBBED_SECRET = 8;
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

const realTimer = (fire: () => void, ms: number) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const scrubEmails = (s: string) => s.replace(EMAIL, (e) => `user-${sha256(e.toLowerCase()).slice(0, 8)}@example.invalid`);
/** Secret values in every form (src/net/scrub.ts), then e-mail addresses. */
const scrubAll = (pairs: readonly [string, string][], s: string) => scrubEmails(scrubText(pairs, s));
const scrubHeaders = (pairs: readonly [string, string][], h: Headers): Record<string, string> => Object.fromEntries([...h].map(([k, v]) => [k, SECRET_HEADERS.has(k) ? "[scrubbed]" : scrubAll(pairs, v)]));

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

/** Whether a request reads, for the read-only guard (step 2) and the governor's cost. */
interface Reading {
  read: boolean;
  graphql: boolean;
  why: string;
}

/** The GraphQL-over-HTTP parameters a server may take from the URL (Rails merges them over the body). */
const GRAPHQL_URL_PARAMS = ["query", "operationName", "extensions"] as const;
/** Headers and the query parameter servers honour as the request's real method. */
const METHOD_OVERRIDES = ["x-http-method-override", "x-http-method", "x-method-override"] as const;

/**
 * What a request with this method does (finding 6). GET and HEAD read, except on a GraphQL path
 * whose URL carries a document: that is a read only when the document is a query (and carries no
 * `extensions`, a persisted query pr-rla cannot see). A GraphQL POST reads when its body is a
 * query and its URL carries none of query, operationName or extensions. Anything else writes.
 */
function reading(method: string, url: URL, text: string | null): Reading {
  const graphql = isGraphqlPath(url.pathname);
  const inUrl = graphql ? GRAPHQL_URL_PARAMS.filter((k) => url.searchParams.has(k)) : [];
  if (method === "GET" || method === "HEAD") {
    if (!inUrl.length) return { read: true, graphql: false, why: "" };
    const q = url.searchParams.get("query");
    const read = !url.searchParams.has("extensions") && q !== null && isQueryOnly(JSON.stringify({ query: q }));
    return { read, graphql: true, why: "a GraphQL request whose URL carries a mutation, a subscription, a persisted query (extensions) or a document that is not a query" };
  }
  if (method === "POST" && graphql) {
    if (inUrl.length) return { read: false, graphql: true, why: `a GraphQL POST with ${inUrl.join(", ")} in its URL (a server may run the URL's document instead of the body's)` };
    return { read: text !== null && isQueryOnly(text), graphql: true, why: "a GraphQL mutation or subscription, or not a GraphQL query" };
  }
  return { read: false, graphql: false, why: `${method} is not a read` };
}

/** Every other method a server may take from an override header or `_method` (finding 6): a request must be allowed as each. */
function overriddenMethods(method: string, headers: Headers, url: URL): string[] {
  const named = [...METHOD_OVERRIDES.map((h) => headers.get(h)), ...url.searchParams.getAll("_method")];
  return [...new Set(named.flatMap((v) => (v ? v.split(",") : [])).map((v) => v.trim().toUpperCase()).filter((v) => v && v !== method))];
}

/** `prefix` covers `target` on a `/` segment boundary (finding 9): `…/issue` covers `…/issue/A-1`, not `…/issueLink`. */
const underPrefix = (target: string, prefix: string) => target === prefix || (target.startsWith(prefix) && (prefix.endsWith("/") || target[prefix.length] === "/"));

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
  const sleep = deps.sleep ?? sleepFor;
  /** A wait that the caller's signal ends early (a stopped job never sits out a rate-limit wait). */
  const pause = (ms: number, signal?: AbortSignal | null) => abortable(sleep(ms, signal ?? undefined), signal);
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? realTimer;
  const log = deps.log ?? (() => {});
  const deadline = deps.tsaDeadlineMs ?? TSA_RETRY_DEADLINE_MS;
  const governor = new RateGovernor(p.budgets, now);
  const stats: BrokerStats = { requests: 0, busyMs: 0, byHost: new Map(), denied: [], answered: new Map() };

  // Step 1.
  function checkHost(call: Call, url: URL): void {
    const allowed = p.hostsFor(call.pluginId);
    if (allowed.size && !allowed.has(url.host) && !allowed.has(url.hostname)) throw new HostNotAllowed(url.host, call.pluginId, [...allowed]);
  }

  // Step 2.
  function checkReadOnly(call: Call, url: URL, method: string, r: Reading): void {
    if (r.read) return;
    const role = roleOf(call.pluginId);
    if (p.mode === "read-only") throw new ReadOnlyViolation(method, url.pathname, url.host, r.why);
    if (role === "provider" || role === "plugin") throw new ReadOnlyViolation(method, url.pathname, url.host, `${r.why}; provider requests are always read-only`);
    if (role === "ledger") {
      const allowed = [...p.writePathsFor(call.pluginId)];
      const target = [`${url.host}${url.pathname}`, `${url.hostname}${url.pathname}`];
      if (!allowed.some((prefix) => target.some((t) => underPrefix(t, prefix)))) throw new WritePathNotAllowed(method, url.pathname, url.host, call.pluginId, allowed);
    }
  }

  // Step 3. `downgraded`: an earlier hop of this request redirected from https to http.
  function swapCredentials(call: Call, url: URL, original: Headers, crossOrigin: boolean, downgraded: boolean): Headers {
    const creds = p.credentialsFor(call.pluginId);
    const secret = (env: string, header: string, role: "user" | "token" = "token"): string => {
      const c = creds.get(env);
      if (c?.withheld) throw new CredentialNotApproved(env, url.host, call.pluginId, c.withheld.approve);
      if (header !== "authorization" && !c?.headers?.has(header)) throw new CredentialHeaderNotAllowed(env, header, url.host);
      if (c?.secret === false && role !== "user") throw new CredentialIdentityOnly(env, url.host);
      const allowed = c ? [...c.hosts] : [];
      if (url.protocol !== "https:") throw new CredentialHostMismatch(env, url.host, allowed, { name: url.origin, overHttps: true });
      if (downgraded) throw new CredentialHostMismatch(env, url.host, allowed, { name: `${url.origin} after a redirect from https to http`, overHttps: true });
      if (!c || !c.hosts.has(url.host)) throw new CredentialHostMismatch(env, url.host, allowed);
      return c.value;
    };
    const out = new Headers();
    for (const [name, value] of original) {
      const basic = name === "authorization" ? BASIC.exec(value) : null;
      if (basic) out.set(name, `Basic ${Buffer.from(`${secret(basic[1]!, name, "user")}:${secret(basic[2]!, name)}`).toString("base64")}`);
      else if (PLACEHOLDER.test(value)) out.set(name, value.replace(PLACEHOLDERS, (_m, env: string) => secret(env, name)));
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

  /** The secret values the caller holds (its granted, approved credentials). */
  const callerSecrets = (call: Call): SecretValue[] => [...p.credentialsFor(call.pluginId)].flatMap(([env, c]) => (c.withheld || !c.value ? [] : [{ env, value: c.value, secret: c.secret !== false }]));

  /**
   * A response with every form of `secrets` replaced by its placeholder: body, header values, status text. A value
   * shorter than MIN_SCRUBBED_SECRET is left alone: it occurs in ordinary responses (a one-letter value is in nearly
   * every JSON key), so replacing it would corrupt them, and a credential that short is no secret.
   */
  async function scrubResponse(res: Response, all: readonly SecretValue[]): Promise<Response> {
    const secrets = all.filter((x) => x.value.length >= MIN_SCRUBBED_SECRET);
    if (!secrets.some((x) => x.secret !== false && x.value)) return res;
    const pairs = scrubPairs(secrets);
    const body = NULL_BODY.has(res.status) ? null : scrubBytes(pairs, Buffer.from(await res.arrayBuffer()));
    const headers = new Headers();
    for (const [k, v] of res.headers) headers.append(k, scrubText(pairs, v));
    return new Response(body, { status: res.status, statusText: scrubText(pairs, res.statusText), headers });
  }

  // Step 7. Every secret value the caller holds is scrubbed wherever it appears, in every form (finding 5).
  async function record(call: Call, url: URL, method: string, headers: Headers, body: Body | null, res: Response): Promise<void> {
    if (!p.recorder) return;
    const bytes = bodyBytes(body);
    const pairs = scrubPairs(callerSecrets(call));
    p.recorder({
      pluginId: call.pluginId,
      destination: call.destination,
      method,
      url: scrubAll(pairs, url.href),
      requestHeaders: scrubHeaders(pairs, headers),
      bodySha256: bytes === null ? null : sha256(bytes),
      status: res.status,
      headers: scrubHeaders(pairs, res.headers),
      response: scrubAll(pairs, await res.clone().text()),
    });
  }

  /** Steps 1–5 and 7 for one attempt, following redirects hop by hop. */
  async function attempt(call: Call): Promise<Response> {
    let url = call.url;
    let method = (call.req.method ?? "GET").toUpperCase();
    let body: Body | null = call.req.body ?? null;
    const original = new Headers(call.req.headers);
    let downgraded = false;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new BrokerError(`${bounded(url.host)}: more than ${MAX_REDIRECTS} redirects`, "TOO_MANY_REDIRECTS", url.host, "check the URL");
      checkHost(call, url);
      const text = bodyText(body);
      // A method override must be allowed too, every one of them: a server may run any of the methods.
      const r = reading(method, url, text);
      checkReadOnly(call, url, method, r);
      const overrides = overriddenMethods(method, original, url).map((m) => ({ m, r: reading(m, url, text) }));
      for (const o of overrides) checkReadOnly(call, url, `${method} (as ${o.m})`, o.r);
      // After a redirect from https to http, no credential is swapped and no raw secret header is sent, to the end of the chain.
      const headers = swapCredentials(call, url, original, url.origin !== call.url.origin || downgraded, downgraded);
      const g: GovernedRequest = {
        host: url.hostname,
        path: url.pathname,
        method,
        authenticated: headers.has("authorization") || headers.has("private-token"),
        graphql: r.graphql,
        // As before for the budgets: OPTIONS spends no write budget.
        write: [{ m: method, r }, ...overrides].some((o) => !o.r.read && o.m !== "OPTIONS"),
      };
      const wait = governor.reserve(g);
      if (wait > 0) {
        if (wait >= 1000) log(`${url.host}: rate budget; waiting ${Math.ceil(wait / 1000)}s before ${method} ${url.pathname}`);
        await pause(wait, call.req.signal);
      }
      const release = await governor.slot(url.hostname, call.req.signal ?? undefined);
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
      // Read-only mode (S1, item 8): a response reaches a built-in as an isolated plugin's reaches its child (src/plugins/host.ts):
      // every secret the caller holds, in every form a server may echo it in, is its placeholder, so no error body,
      // header, status text or redirect can carry the operator's token into a read result.
      if (p.mode === "read-only") res = await scrubResponse(res, callerSecrets(call));
      await record(call, url, method, headers, body, res);
      const location = res.headers.get("location");
      if (REDIRECTS.has(res.status) && location) {
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          if (method !== "HEAD") method = "GET";
          body = null;
          original.delete("content-type");
        }
        const next = new URL(location, url);
        if (url.protocol === "https:" && next.protocol !== "https:") downgraded = true;
        url = next;
        continue;
      }
      if (res.status >= 200 && res.status < 300) stats.answered.set(call.pluginId, (stats.answered.get(call.pluginId) ?? 0) + 1);
      if (res.status === 401 || res.status === 403 || res.status === 404) stats.denied.push({ pluginId: call.pluginId, status: res.status, method, host: url.host, path: url.pathname, authenticated: g.authenticated });
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
    // Every caller's limits are checked here, whatever checked them before (S1): a cap that is not a finite number
    // (NaN compares false with everything) would never be reached.
    for (const k of ["maxRetries", "maxBlindRateLimitRetries", "blindRateLimitWaitMs"] as const) {
      const v: unknown = hints[k];
      if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v >= 0)) throw new RetryHintInvalid(k, call.url.host);
    }
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
      if (wait > 0) await pause(wait, call.req.signal);
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
      if (told === null) await pause(wait, call.req.signal);
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
