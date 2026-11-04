import { canonicalJson } from "../core/canonical.js";
import { DEFAULT_MAX_RETRIES, RETRIES_EXHAUSTED, backoffMs, checkJsonBody, isBrokerInit, isRateLimited, isRetryableStatus, waitFromHeaders, type RetryHints } from "../sdk/http.js";
import {
  DEFAULT_REVIEW_GRANULARITY,
  SUPPORTED_PROVIDER_API_VERSIONS,
  changeRecordProblems,
  normalizeLogin,
  type Actor,
  type ChangeKind,
  type ChangeRecord,
  type ListChangesRequest,
  type ListChangesResult,
  type ProviderContext,
  type ProviderDefinition,
  type ReviewGranularity,
  type ReviewState,
  type ScmProvider,
} from "../sdk/provider.js";

/**
 * Provider conformance kit (`pr-rla/testing`). Framework-agnostic: it returns a
 * report, and `assertProviderConformance` throws, so it runs under vitest, jest,
 * node:test or a plain script. A third-party provider author wires their adapter
 * to recorded or fake SCM data and declares what that data must normalize to.
 */
export interface ConformanceFixture {
  name: string;
  request: ListChangesRequest;
  expect: {
    /** The exact set of change ids the provider must return (covers pagination: make the data span pages). */
    ids?: string[];
    pullRequests?: string[];
    directPushes?: string[];
    /** Review states per change id, in submittedAt order. */
    reviewStates?: Record<string, ReviewState[]>;
    /** Review authors per change id, in submittedAt order (checks reviewer bot detection). */
    reviewers?: Record<string, Actor[]>;
    actors?: Record<string, { author?: Actor; mergedBy?: Actor | null }>;
    changedLines?: Record<string, number>;
    /** With `pagesServed` (or requests through the harness): the transport must have served at least this many requests. */
    minPages?: number;
    /**
     * Commits each PR brought onto the default branch: its merge or squash commit,
     * every rebased or fast-forwarded commit, a merge commit's branch commits.
     * None of them may come back as a direct push, and each PR must be returned.
     */
    prCommits?: Record<string, string[]>;
    /** The commit each change landed as (`mergeSha`): merge/squash commit, last rebased commit, or the fast-forwarded head. */
    mergeShas?: Record<string, string>;
    /** Logins that must be `kind: "bot"` wherever they appear (author, mergedBy, review authors). */
    bots?: string[];
    /** Logins that must be `kind: "human"` wherever they appear. */
    humans?: string[];
    /** U3 (`actor-ids`): the stable account id each login must carry (`Actor.id`). */
    actorIds?: Record<string, string>;
    /** U3 (`review-granularity`): how the fixture's data forms review objects; must match what the definition declares. */
    reviewGranularity?: ReviewGranularity;
    /** U3 (`revoked-approval`): per change id, the logins whose approval was revoked (unapproved, reset by a push, dismissed). None may come back as APPROVED. */
    revokedApprovals?: Record<string, string[]>;
  };
  /**
   * U3 (`pinned-head`): the transport serves a default branch with commits pushed after `head` (the
   * frozen tip), dated in the window. Unpinned, the provider must return the `late` commits; with
   * `request.head = head` it must report `headSha: head`, leave them out and change nothing else.
   */
  pinnedHead?: { head: string; late: string[] };
  /** How many requests/pages the fixture transport has served (pagination check). Defaults to the harness's request count. */
  pagesServed?: () => number;
  /**
   * The provider talks HTTP. The kit then requires its requests to go through
   * `harness.wrapFetch` (or `harness.context`) and runs the transient-fault check.
   */
  http?: boolean;
  /**
   * Optional provider-specific rate-limit response for the transient-fault
   * check, e.g. GitHub's 403 with `x-ratelimit-remaining: 0`. The provider must
   * wait at least `minWaitMs` before its next request.
   */
  rateLimitFault?: { status: number; headers: (nowUnixSeconds: number) => Record<string, string>; minWaitMs: number };
}

/**
 * Handed to a provider factory. Route the provider's HTTP through `wrapFetch`
 * and its retry waits through `sleep` (or use `context()`), so the kit can count
 * requests and inject transient faults (5xx, 429 with Retry-After).
 *
 * The wrapped fetch is broker-shaped: a request that passes the broker contract
 * (`destination` in its init, as the built-ins do) is retried by the harness with the
 * broker's policy (src/sdk/http.ts), as the fetch broker retries it in a real run; such a
 * provider passes by recovering with the harness's retries. A request made as plain
 * `fetch(url, init)` reaches the faults directly, so a provider that brings its own
 * retries is tested on them, as in phase 2.
 */
export interface ConformanceHarness {
  wrapFetch(inner: typeof fetch): typeof fetch;
  /** Records the wait instead of sleeping. */
  sleep(ms: number): Promise<void>;
  /** A ProviderContext whose fetch is wrapped and whose sleep is the kit's. */
  context(base: { fetch: typeof fetch } & Partial<ProviderContext>): ProviderContext;
  /** Requests that went through the wrapped fetch (injected faults included). */
  requests(): number;
}

export type ProviderUnderTest = ScmProvider | ((fixture: ConformanceFixture, harness: ConformanceHarness) => ScmProvider | Promise<ScmProvider>);

/** U3: what the kit needs beyond the provider: its definition, for the checks that read what it declares. */
export interface ConformanceOptions {
  definition?: Pick<ProviderDefinition, "reviewGranularity">;
}

export interface ConformanceResult {
  fixture: string;
  check: string;
  ok: boolean;
  /** True when the check did not apply (e.g. no HTTP); `message` says why. */
  skipped?: boolean;
  message?: string;
}

export interface ConformanceReport {
  ok: boolean;
  results: ConformanceResult[];
}

export const CONFORMANCE_CHECKS = [
  "api-version",
  "normalization",
  "window-and-kinds",
  "classification",
  "merge-strategies",
  "no-double-counting",
  "stable-sorted-ids",
  "review-state-mapping",
  "actors",
  "bot-detection",
  "pagination",
  "kind-filtering",
  "transient-faults",
  "pinned-head",
  "actor-ids",
  "review-granularity",
  "revoked-approval",
] as const;
export type ConformanceCheck = (typeof CONFORMANCE_CHECKS)[number];

/** The Retry-After the kit sends with its injected 429, in seconds. */
export const INJECTED_RETRY_AFTER_SECONDS = 7;

const sortById = (cs: readonly ChangeRecord[]) => [...cs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const sameSet = (a: readonly string[], b: readonly string[]) => canonicalJson([...a].sort()) === canonicalJson([...b].sort());
const diff = (want: readonly string[], got: readonly string[]) => {
  const g = new Set(got);
  const w = new Set(want);
  const missing = want.filter((x) => !g.has(x));
  const extra = got.filter((x) => !w.has(x));
  return `missing ${missing.length} (${missing.slice(0, 3).join(", ")}), extra ${extra.length} (${extra.slice(0, 3).join(", ")})`;
};

/** A response injected by the harness (also used by the ledger kit). */
export interface Fault {
  /** 1-based call number through the wrapped fetch. With `write`, the call number is ignored. */
  call: number;
  /** Instead of `call`: the 1-based number of the write (a call that is not GET or HEAD) to fault. */
  write?: number;
  /** The write reaches the tracker, and its response is replaced: the lost response of a write that happened. */
  lost?: boolean;
  response: () => Response;
  /** The provider must wait at least this long before its next call. */
  minWaitMs: number;
  label: string;
}

export interface Harness extends ConformanceHarness {
  /** Per call: the waits requested after it, and wall-clock time to the next call. */
  log: { url: string; method: string; sleptAfter: number; at: number }[];
}

/**
 * The broker's retry step (contracts.md §2 step 6) over the harness's logged fetch, for
 * requests that speak the broker contract: retryable responses and errors are retried up to
 * the request's limit, waiting as long as the rate-limit headers say, else with backoff.
 */
async function brokerShaped(send: (input: string | URL | Request, init: RequestInit) => Promise<Response>, input: string | URL | Request, init: RequestInit & { destination: string; retry?: RetryHints | false }, sleep: (ms: number) => Promise<void>): Promise<Response> {
  const { destination: _d, retry, pluginId: _p, idempotent, ...req } = init as typeof init & { pluginId?: string; idempotent?: boolean };
  if (retry === false) return send(input, req);
  const hints = retry ?? {};
  const max = hints.maxRetries ?? DEFAULT_MAX_RETRIES;
  let errors = 0;
  let blind = 0;
  let waits = 0;
  for (let attempt = 1; ; attempt++) {
    let problem: string;
    let told: number | null = null;
    let rateLimited = false;
    try {
      const res = await send(input, req);
      if (res.ok && hints.acceptJson) {
        const checked = await checkJsonBody(res, hints.acceptJson);
        if (checked.problem === null) return checked.response;
        problem = checked.problem;
      } else if (!isRetryableStatus(res)) return res;
      else {
        problem = `HTTP ${res.status}`;
        rateLimited = isRateLimited(res);
        // As the broker: a non-idempotent request (a ledger write) is never retried after a 5xx, only on a rate limit.
        if (idempotent === false && !rateLimited) return res;
        told = waitFromHeaders(res.headers, Date.now());
        await res.body?.cancel().catch(() => {});
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      problem = (e as Error).message;
    }
    const giveUp = told !== null ? ++waits > max : ++errors > max || (rateLimited && ++blind > (hints.maxBlindRateLimitRetries ?? max));
    if (giveUp) throw Object.assign(new Error(`conformance harness: gave up after ${attempt} attempts (${problem})`), { code: RETRIES_EXHAUSTED, attempts: attempt, lastProblem: problem, rateLimited });
    await sleep(told ?? backoffMs(errors, 0.5));
  }
}

export function makeHarness(faults: readonly Fault[] = []): Harness {
  const log: Harness["log"] = [];
  let writes = 0;
  const h: Harness = {
    log,
    requests: () => log.length,
    wrapFetch(inner) {
      const logged = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        log.push({ url, method, sleptAfter: 0, at: Date.now() });
        const isWrite = method !== "GET" && method !== "HEAD";
        if (isWrite) writes++;
        const fault = faults.find((f) => (f.write !== undefined ? isWrite && f.write === writes : f.call === log.length));
        if (fault?.lost) {
          await inner(input as string, init); // the write happens; only its answer is lost
          return fault.response();
        }
        if (fault) return fault.response();
        return inner(input as string, init);
      };
      return (async (input: string | URL | Request, init?: RequestInit) => (isBrokerInit(init) ? brokerShaped(logged, input, init, h.sleep) : logged(input, init))) as typeof fetch;
    },
    async sleep(ms) {
      const last = log[log.length - 1];
      if (last) last.sleptAfter += ms;
    },
    context(base) {
      return { cwd: ".", env: {}, log: () => {}, ...base, fetch: h.wrapFetch(base.fetch), sleep: h.sleep };
    },
  };
  return h;
}

async function instantiate(p: ProviderUnderTest, f: ConformanceFixture, h: ConformanceHarness): Promise<ScmProvider> {
  return typeof p === "function" ? p(f, h) : p;
}

function allActors(c: ChangeRecord): Actor[] {
  return [c.author, ...(c.mergedBy ? [c.mergedBy] : []), ...c.reviews.map((r) => r.author)];
}

/** Actors that are SCM accounts: a direct push's author is a git identity the SCM links to an account only sometimes. */
function accountActors(c: ChangeRecord): Actor[] {
  return [...(c.kind === "pull_request" ? [c.author] : []), ...(c.mergedBy ? [c.mergedBy] : []), ...c.reviews.map((r) => r.author)];
}

/** An expected actor matches on login and kind, and on id when the expectation names one. */
function sameActor(got: Actor | null | undefined, want: Actor | null): boolean {
  if (want === null || !got) return (got ?? null) === want;
  return got.login === want.login && got.kind === want.kind && (want.id === undefined || got.id === want.id);
}

/** login (normalized) -> account ids seen for it, and id -> logins, over every actor that carries an id. */
function idMaps(changes: readonly ChangeRecord[]): { byLogin: Map<string, Set<string>>; byId: Map<string, Set<string>> } {
  const byLogin = new Map<string, Set<string>>();
  const byId = new Map<string, Set<string>>();
  for (const a of changes.flatMap(allActors)) {
    if (a.id === undefined) continue;
    const l = normalizeLogin(a.login);
    byLogin.set(l, (byLogin.get(l) ?? new Set()).add(a.id));
    byId.set(a.id, (byId.get(a.id) ?? new Set()).add(l));
  }
  return { byLogin, byId };
}

export async function runProviderConformance(provider: ProviderUnderTest, fixtures: readonly ConformanceFixture[], options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const results: ConformanceResult[] = [];
  // A kit given nothing to check has checked nothing: that is a failure, not a pass.
  if (fixtures.length === 0) return { ok: false, results: [{ fixture: "(no fixtures)", check: "normalization", ok: false, message: "the kit was given no fixtures, so it checked nothing: pass at least one fixture (recorded or synthetic SCM data and what it must normalize to)" }] };
  for (const f of fixtures) {
    const push = (check: ConformanceCheck, ok: boolean, message?: string) => results.push({ fixture: f.name, check, ok, ...(message && !ok ? { message } : {}) });
    const skip = (check: ConformanceCheck, message: string) => results.push({ fixture: f.name, check, ok: true, skipped: true, message });
    const h1 = makeHarness();
    const p1 = await instantiate(provider, f, h1);
    push("api-version", SUPPORTED_PROVIDER_API_VERSIONS.includes(p1.apiVersion) && /^[a-z0-9][a-z0-9-]*$/.test(p1.name), `apiVersion ${p1.apiVersion} / name ${p1.name}`);
    let first: ChangeRecord[];
    let firstResult: ListChangesResult;
    try {
      firstResult = await p1.listChanges(f.request);
      first = firstResult.changes;
    } catch (e) {
      push("normalization", false, `listChanges threw: ${(e as Error).message}`);
      continue;
    }
    const cleanRequests = h1.requests();
    const pages = f.pagesServed?.() ?? (cleanRequests > 0 ? cleanRequests : undefined);

    const bad = first.map((c) => ({ c, p: changeRecordProblems(c) })).filter((x) => x.p.length > 0);
    const wrongRepo = first.filter((c) => c.repo !== f.request.repo);
    push("normalization", bad.length === 0 && wrongRepo.length === 0, bad.length ? `${bad[0]!.c.id}: ${bad[0]!.p.join("; ")}` : `${wrongRepo[0]?.id} has repo ${wrongRepo[0]?.repo}`);

    const opens = Date.parse(f.request.window.opensAt);
    const closes = Date.parse(f.request.window.closesAt);
    const outside = first.filter((c) => Date.parse(c.mergedAt) < opens || Date.parse(c.mergedAt) >= closes);
    const wrongKind = first.filter((c) => !f.request.kinds.includes(c.kind));
    // Nothing outside the window or the requested kinds, and (completeness) everything the fixture says landed in it.
    // The expected set is expect.ids, or the pull requests and direct pushes together; with neither, the kit cannot
    // tell a provider that dropped changes from one that returned them all, and says so.
    const wk: string[] = [];
    if (outside.length) wk.push(`${outside[0]!.id} landed ${outside[0]!.mergedAt}, outside the window`);
    if (wrongKind.length) wk.push(`${wrongKind[0]!.id} is kind ${wrongKind[0]!.kind}, which was not requested`);
    const landed = f.expect.ids ?? (f.expect.pullRequests || f.expect.directPushes ? [...(f.expect.pullRequests ?? []), ...(f.expect.directPushes ?? [])] : undefined);
    if (!landed) wk.push("the fixture declares no expect.ids (or pullRequests and directPushes), so completeness (every change in the window came back) is not checked: list the ids the window must return");
    else {
      const returned = new Set(first.map((c) => c.id));
      const missing = landed.filter((id) => !returned.has(id));
      if (missing.length) wk.push(`${missing.length} change(s) of the window are missing (e.g. ${missing.slice(0, 3).join(", ")})`);
    }
    push("window-and-kinds", wk.length === 0, wk.join("; "));

    const classProblems: string[] = [];
    for (const c of first) {
      if (c.kind === "direct_push" && !c.id.endsWith(`@${c.mergeSha}`)) classProblems.push(`${c.id}: a direct_push id must end in @<mergeSha>`);
      if (c.kind === "pull_request" && !/#[1-9][0-9]*$/.test(c.id)) classProblems.push(`${c.id}: a pull_request id must end in #<number>`);
    }
    const byKind = (k: ChangeKind) => first.filter((c) => c.kind === k).map((c) => c.id);
    if (f.expect.pullRequests && !sameSet(f.expect.pullRequests, byKind("pull_request"))) classProblems.push(`pull requests: ${diff(f.expect.pullRequests, byKind("pull_request"))}`);
    if (f.expect.directPushes && !sameSet(f.expect.directPushes, byKind("direct_push"))) classProblems.push(`direct pushes: ${diff(f.expect.directPushes, byKind("direct_push"))}`);
    if (!f.expect.pullRequests && !f.expect.directPushes) skip("classification", "the fixture declares neither pullRequests nor directPushes");
    else push("classification", classProblems.length === 0, classProblems.join("; "));

    const ms: string[] = [];
    const directBySha = new Map(first.filter((c) => c.kind === "direct_push").map((c) => [c.mergeSha, c.id]));
    for (const [id, shas] of Object.entries(f.expect.prCommits ?? {})) {
      if (f.request.kinds.includes("pull_request") && !first.some((c) => c.id === id && c.kind === "pull_request")) ms.push(`${id} missing`);
      for (const sha of shas) {
        const leaked = directBySha.get(sha.toLowerCase());
        if (leaked) ms.push(`commit ${sha.slice(0, 12)} of ${id} was returned as direct push ${leaked}`);
      }
    }
    for (const [id, sha] of Object.entries(f.expect.mergeShas ?? {})) {
      const c = first.find((x) => x.id === id);
      if (c && c.mergeSha !== sha.toLowerCase()) ms.push(`${id} mergeSha ${c.mergeSha.slice(0, 12)} ≠ ${sha.slice(0, 12)}`);
      if (!c && f.request.kinds.includes(id.includes("#") ? "pull_request" : "direct_push")) ms.push(`${id} missing`);
    }
    if (!f.expect.prCommits && !f.expect.mergeShas) skip("merge-strategies", "the fixture declares neither prCommits nor mergeShas");
    else push("merge-strategies", ms.length === 0, ms.join("; "));

    const ids = first.map((c) => c.id);
    const shas = first.map((c) => c.mergeSha);
    const dupId = ids.find((x, i) => ids.indexOf(x) !== i);
    const dupSha = shas.find((x, i) => shas.indexOf(x) !== i);
    push("no-double-counting", !dupId && !dupSha, dupId ? `id ${dupId} returned twice` : `commit ${dupSha} counted by two changes`);

    let second: ChangeRecord[] | null = null;
    try {
      second = (await (await instantiate(provider, f, makeHarness())).listChanges(f.request)).changes;
    } catch (e) {
      push("stable-sorted-ids", false, `second listChanges threw: ${(e as Error).message}`);
    }
    if (second) {
      const a = canonicalJson(sortById(first));
      const b = canonicalJson(sortById(second));
      push("stable-sorted-ids", a === b, "two identical requests returned different records or ids");
    }

    const rs: string[] = [];
    for (const [id, states] of Object.entries(f.expect.reviewStates ?? {})) {
      const c = first.find((x) => x.id === id);
      const got = c?.reviews.map((r) => r.state) ?? null;
      if (canonicalJson(got) !== canonicalJson(states)) rs.push(`${id}: expected [${states.join(",")}] got [${got?.join(",") ?? "missing"}]`);
    }
    for (const [id, actors] of Object.entries(f.expect.reviewers ?? {})) {
      const c = first.find((x) => x.id === id);
      const got = c?.reviews.map((r) => r.author) ?? null;
      if (!got || got.length !== actors.length || got.some((a, i) => !sameActor(a, actors[i]!))) rs.push(`${id}: reviewers ${canonicalJson(got)}`);
    }
    if (!f.expect.reviewStates && !f.expect.reviewers) skip("review-state-mapping", "the fixture declares neither reviewStates nor reviewers");
    else push("review-state-mapping", rs.length === 0, rs.join("; "));

    const ac: string[] = [];
    for (const [id, exp] of Object.entries(f.expect.actors ?? {})) {
      const c = first.find((x) => x.id === id);
      if (!c) ac.push(`${id} missing`);
      else {
        if (exp.author && !sameActor(c.author, exp.author)) ac.push(`${id} author ${canonicalJson(c.author)}`);
        if (exp.mergedBy !== undefined && !sameActor(c.mergedBy, exp.mergedBy)) ac.push(`${id} mergedBy ${canonicalJson(c.mergedBy)}`);
      }
    }
    for (const [id, n] of Object.entries(f.expect.changedLines ?? {})) {
      const c = first.find((x) => x.id === id);
      if (c?.changedLines !== n) ac.push(`${id} changedLines ${c?.changedLines} ≠ ${n}`);
    }
    if (!f.expect.actors && !f.expect.changedLines) skip("actors", "the fixture declares neither actors nor changedLines");
    else push("actors", ac.length === 0, ac.join("; "));

    if (f.expect.bots || f.expect.humans) {
      const bd: string[] = [];
      const everyone = first.flatMap(allActors);
      for (const [logins, kind] of [[f.expect.bots ?? [], "bot"], [f.expect.humans ?? [], "human"]] as const) {
        for (const login of logins) {
          const seen = everyone.filter((a) => normalizeLogin(a.login) === normalizeLogin(login));
          if (seen.length === 0) bd.push(`${login} does not appear in any author, mergedBy or review`);
          const wrong = seen.find((a) => a.kind !== kind);
          if (wrong) bd.push(`${login} is kind ${wrong.kind}, expected ${kind}`);
        }
      }
      push("bot-detection", bd.length === 0, bd.join("; "));
    } else skip("bot-detection", "fixture declares no bots/humans");

    const pg: string[] = [];
    if (f.expect.ids && !sameSet(f.expect.ids, ids)) pg.push(`ids: ${diff(f.expect.ids, ids)}`);
    if (f.expect.minPages !== undefined && pages !== undefined && pages < f.expect.minPages) pg.push(`transport served ${pages} requests < ${f.expect.minPages}: the fixture does not exercise pagination`);
    if (!f.expect.ids && f.expect.minPages === undefined) skip("pagination", "the fixture declares neither ids nor minPages");
    else push("pagination", pg.length === 0, pg.join("; "));

    if (f.request.kinds.length > 1) {
      const kp: string[] = [];
      for (const k of f.request.kinds) {
        try {
          const only = (await (await instantiate(provider, f, makeHarness())).listChanges({ ...f.request, kinds: [k] })).changes;
          if (only.some((c) => c.kind !== k)) kp.push(`kinds [${k}] returned another kind`);
          if (!sameSet(only.map((c) => c.id), byKind(k))) kp.push(`kinds [${k}]: ${diff(byKind(k), only.map((c) => c.id))}`);
        } catch (e) {
          kp.push(`kinds [${k}] threw: ${(e as Error).message}`);
        }
      }
      push("kind-filtering", kp.length === 0, kp.join("; "));
    }

    if (cleanRequests === 0) {
      if (f.http) push("transient-faults", false, "fixture says http: true but no request went through the harness: build the provider's context with harness.context() or harness.wrapFetch()");
      else skip("transient-faults", "the provider made no requests through the harness (not an HTTP provider)");
    } else {
      push("transient-faults", ...(await transientFaults(provider, f, first, cleanRequests)));
    }

    // --- U3 checks -------------------------------------------------------------------------------
    const pin = await pinnedHead(provider, f, firstResult);
    if (pin.skip) skip("pinned-head", pin.skip);
    else push("pinned-head", pin.problems.length === 0, pin.problems.join("; "));

    const withId = first.flatMap(allActors).filter((a) => a.id !== undefined);
    if (withId.length === 0) {
      if (f.expect.actorIds) push("actor-ids", false, `the fixture expects account ids (${Object.keys(f.expect.actorIds).slice(0, 3).join(", ")}) but the provider reports no Actor.id`);
      else skip("actor-ids", "the provider reports no Actor.id");
    } else {
      const ai: string[] = [];
      const missing = first.flatMap((c) => accountActors(c).filter((a) => a.id === undefined && normalizeLogin(a.login) !== "ghost").map((a) => `${a.login} in ${c.id}`));
      if (missing.length) ai.push(`${missing.length} account actor(s) without an id although others have one (e.g. ${missing.slice(0, 3).join(", ")})`);
      const maps = idMaps(first);
      for (const [login, ids] of maps.byLogin) if (ids.size > 1) ai.push(`${login} carries ${ids.size} ids (${[...ids].slice(0, 3).join(", ")})`);
      for (const [id, logins] of maps.byId) if (logins.size > 1) ai.push(`id ${id} is carried by ${[...logins].slice(0, 3).join(", ")}`);
      for (const [login, id] of Object.entries(f.expect.actorIds ?? {})) {
        const got = [...(maps.byLogin.get(normalizeLogin(login)) ?? [])];
        if (got.length !== 1 || got[0] !== id) ai.push(`${login}: id ${got.join(",") || "missing"} ≠ ${id}`);
      }
      if (second) {
        const again = idMaps(second).byLogin;
        for (const [login, ids] of maps.byLogin) if (canonicalJson([...ids].sort()) !== canonicalJson([...(again.get(login) ?? [])].sort())) ai.push(`${login}'s id changed between two runs`);
      }
      push("actor-ids", ai.length === 0, ai.join("; "));
    }

    const declared = options.definition ? (options.definition.reviewGranularity ?? DEFAULT_REVIEW_GRANULARITY) : undefined;
    const shown = f.expect.reviewGranularity;
    if (declared === undefined && shown === undefined) skip("review-granularity", "neither the definition (pass { definition }) nor the fixture names a review granularity");
    else {
      const rg: string[] = [];
      if (declared !== undefined && shown !== undefined && declared !== shown) rg.push(`the definition declares reviewGranularity "${declared}", but the fixture's review objects are "${shown}"`);
      if ((declared ?? shown) === "first-comment-per-user") {
        for (const c of first) {
          const seen = new Set<string>();
          for (const r of c.reviews.filter((x) => x.state === "COMMENTED")) {
            const l = normalizeLogin(r.author.login);
            if (seen.has(l)) rg.push(`${c.id}: ${r.author.login} has more than one COMMENTED`);
            if (c.kind === "pull_request" && l === normalizeLogin(c.author.login)) rg.push(`${c.id}: its author's own comment is a COMMENTED review`);
            seen.add(l);
          }
        }
      }
      push("review-granularity", rg.length === 0, [...new Set(rg)].slice(0, 5).join("; "));
    }

    if (!f.expect.revokedApprovals) skip("revoked-approval", "the fixture lists no revoked approvals");
    else {
      const ra: string[] = [];
      for (const [id, logins] of Object.entries(f.expect.revokedApprovals)) {
        const c = first.find((x) => x.id === id);
        if (!c) {
          ra.push(`${id} missing`);
          continue;
        }
        for (const login of logins) if (c.reviews.some((r) => r.state === "APPROVED" && normalizeLogin(r.author.login) === normalizeLogin(login))) ra.push(`${id}: ${login}'s revoked approval came back as APPROVED`);
      }
      push("revoked-approval", ra.length === 0, ra.join("; "));
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

/**
 * `pinned-head` (U3): a provider that reports `headSha` must honour `request.head`. With the
 * fixture's `pinnedHead`, the late commits must appear unpinned and vanish pinned; without it, a
 * re-run from the reported head must give the same head and the same records.
 */
async function pinnedHead(provider: ProviderUnderTest, f: ConformanceFixture, first: ListChangesResult): Promise<{ skip?: string; problems: string[] }> {
  const ph = f.pinnedHead;
  if (!ph && first.headSha === undefined) return { skip: "the provider reports no headSha: it does not pin history (verify says so in check 5)", problems: [] };
  const head = (ph?.head ?? first.headSha!).toLowerCase();
  const late = new Set((ph?.late ?? []).map((x) => x.toLowerCase()));
  const problems: string[] = [];
  if (ph) {
    const landed = new Set(first.changes.map((c) => c.mergeSha));
    const absent = [...late].filter((x) => !landed.has(x));
    if (absent.length) problems.push(`the unpinned run does not return the late commit(s) ${absent.map((x) => x.slice(0, 12)).join(", ")}: the fixture does not exercise a push after freeze`);
    if (first.headSha !== undefined && first.headSha.toLowerCase() === head) problems.push(`the unpinned run reports the frozen head ${head.slice(0, 12)}, not the current one`);
  }
  let pinned: ListChangesResult;
  try {
    pinned = await (await instantiate(provider, f, makeHarness())).listChanges({ ...f.request, head });
  } catch (e) {
    return { problems: [...problems, `listChanges with head ${head.slice(0, 12)} threw: ${(e as Error).message}`] };
  }
  if (pinned.headSha?.toLowerCase() !== head) problems.push(`asked to walk from ${head.slice(0, 12)}, the provider reported headSha ${pinned.headSha?.slice(0, 12) ?? "none"}`);
  const leaked = pinned.changes.filter((c) => late.has(c.mergeSha));
  if (leaked.length) problems.push(`with the head pinned, a commit pushed after it came back: ${leaked[0]!.id}`);
  const expected = first.changes.filter((c) => !late.has(c.mergeSha));
  if (canonicalJson(sortById(pinned.changes)) !== canonicalJson(sortById(expected))) problems.push(ph ? "with the head pinned, the records differ from the unpinned run by more than the late commits" : "re-run from the reported head, the records differ");
  return { problems };
}

/**
 * Re-runs the fixture with faults injected through the harness: the first
 * request fails with 503, then 429 + Retry-After, then the fixture's own
 * rate-limit response (or 502); the request that was last in the clean run
 * fails once with 503. The provider must retry each, wait at least as long as
 * the rate-limit headers say, and return exactly the same records.
 */
async function transientFaults(provider: ProviderUnderTest, f: ConformanceFixture, clean: readonly ChangeRecord[], cleanRequests: number): Promise<[boolean, string]> {
  const text = (status: number, body: string, headers: Record<string, string> = {}) => () => new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
  const rl = f.rateLimitFault;
  const faults: Fault[] = [
    { call: 1, response: text(503, "service unavailable"), minWaitMs: 0, label: "503" },
    { call: 2, response: text(429, "too many requests", { "retry-after": String(INJECTED_RETRY_AFTER_SECONDS) }), minWaitMs: INJECTED_RETRY_AFTER_SECONDS * 1000, label: `429 with Retry-After: ${INJECTED_RETRY_AFTER_SECONDS}` },
    rl
      ? { call: 3, response: () => new Response("rate limited", { status: rl.status, headers: rl.headers(Math.floor(Date.now() / 1000)) }), minWaitMs: rl.minWaitMs, label: `rate-limit ${rl.status}` }
      : { call: 3, response: text(502, "<html>bad gateway</html>", { "content-type": "text/html" }), minWaitMs: 0, label: "502" },
  ];
  if (cleanRequests >= 2) faults.push({ call: cleanRequests + faults.length, response: text(503, "service unavailable"), minWaitMs: 0, label: "503 on the last request" });
  const h = makeHarness(faults);
  let got: ChangeRecord[];
  try {
    got = (await (await instantiate(provider, f, h)).listChanges(f.request)).changes;
  } catch (e) {
    return [false, `listChanges threw under transient faults (${faults.map((x) => x.label).join(", ")}): ${(e as Error).message}`];
  }
  const problems: string[] = [];
  for (const fault of faults) {
    const at = h.log[fault.call - 1];
    const next = h.log[fault.call];
    if (!at) continue;
    if (!next) {
      problems.push(`no request after the injected ${fault.label}: not retried`);
      continue;
    }
    if (next.url !== at.url || next.method !== at.method) problems.push(`after the injected ${fault.label} on ${at.method} ${at.url} the provider sent ${next.method} ${next.url} instead of retrying`);
    const waited = Math.max(at.sleptAfter, next.at - at.at);
    if (waited < fault.minWaitMs) problems.push(`after the injected ${fault.label} the provider waited ${waited} ms < ${fault.minWaitMs} ms`);
  }
  if (canonicalJson(sortById(got)) !== canonicalJson(sortById(clean))) problems.push("records differ from the clean run (data lost or changed under retries)");
  return [problems.length === 0, problems.join("; ")];
}

export function formatConformanceReport(r: ConformanceReport): string {
  return r.results.map((x) => `${x.ok ? (x.skipped ? "skip" : "ok  ") : "FAIL"} ${x.fixture} › ${x.check}${x.message ? `: ${x.message}` : ""}`).join("\n");
}

export async function assertProviderConformance(provider: ProviderUnderTest, fixtures: readonly ConformanceFixture[], options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const r = await runProviderConformance(provider, fixtures, options);
  if (!r.ok) throw new Error(`provider conformance failed:\n${formatConformanceReport(r)}`);
  return r;
}
