import { signalledFetch, signalledSleep, sleepFor } from "../net/abort.js";
import { createBroker, type Broker, type BrokerMode, type Credential, type RecordedExchange } from "../net/broker.js";
import { DESTINATION_TIMEOUT_MS, type Destination } from "../net/contract.js";
import { LEDGER_BUDGET_FAMILY, PROVIDER_BUDGET_FAMILY, applyRateOverrides, defaultBudgets, familyBudget, type BudgetFamily, type HostBudgetDefault, type RateLimitOverrides } from "../net/rate-limits.js";
import { httpsOrigin, localConsent, type LocalConsent } from "../plugins/approvals.js";
import { builtinCredentialUses, type BuiltinCredentialUse } from "../plugins/builtin-credentials.js";
import { pluginPolicy, type PluginPolicy } from "../plugins/lock.js";
import { openExternalLedger, openExternalProvider } from "../plugins/open.js";
import { BUILTIN_LEDGERS, BUILTIN_PROVIDERS, builtinLedgerName, builtinProviderName, createLedger, createProvider, loadLedgerDefinition, loadProviderDefinition, type PluginSpec } from "../registry.js";
import type { Ledger } from "../sdk/ledger.js";
import type { PluginCredential, ScmProvider } from "../sdk/provider.js";
import { AuditError } from "./errors.js";

/**
 * The audit API foundation (functional-design.md §U2a; contracts.md §1a, §2).
 *
 * An AuditContext is everything an audit function needs besides its arguments: the
 * environment, the clock, the log and the fetch broker, in one of two modes.
 *
 * - **read-write** (the CLI): the broker allows component writes (timestamp requests,
 *   `--submit`) and ledger writes under their declared writePaths. Provider requests are
 *   read-only in both modes.
 * - **read-only** (the MCP server, through `pr-rla/api/read`, from U5): the broker refuses
 *   every request that is not a read (ReadOnlyViolation), no recorder can be installed,
 *   the ledger is opened with its read methods only, and write operations refuse with
 *   READ_ONLY_VIOLATION before they start.
 *
 * Later units add their functions on top: U4 (checkpoints), U8 (pooled freeze), U9
 * (presence), and U5 moves every command onto it.
 */

export type AuditMode = BrokerMode;

/** A credential a plugin is granted; `withheld` when the person running the command has not approved it (src/plugins/approvals.ts). */
export interface GrantedCredential extends PluginCredential {
  withheld?: { approve: string };
}

export interface PluginGrant {
  /** `builtin` and `full` run in-process with any host; `isolated` (U2b) is held to `hosts`. */
  trust: "builtin" | "full" | "isolated";
  hosts?: readonly string[];
  writePaths?: readonly string[];
  credentials?: readonly GrantedCredential[];
  /** The default rate budget to give the plugin's hosts (built-in providers). */
  budgetFamily?: BudgetFamily;
}

export interface AuditContext {
  readonly mode: AuditMode;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nowMs: () => number;
  /** Waits on the command's clock; `signal` ends a wait early (a plugin host cancels a plugin's wait with it). */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly log: (line: string) => void;
  /** Every outbound HTTP request of this context goes through this one broker, so all callers share its budgets. */
  readonly broker: Broker;
  /**
   * `builtin-only` refuses every external plugin before it is imported (U2b, FR2.6). A read-only
   * context is at least `isolated-only`: it never loads a `trust: full` plugin in process (U5 fix round).
   */
  readonly plugins: PluginPolicy;
  /**
   * The local consent of the person running the command (src/plugins/approvals.ts): a repo's
   * credential grants and `trust: full` take effect only when approved here, or with
   * `--accept-lock-grants` for this run.
   */
  readonly consent: LocalConsent;
  /** A plain fetch for a built-in component (`pr-rla/drand`, `pr-rla/rekor`) on its destination. */
  componentFetch(componentId: `pr-rla/${string}`, destination: Destination): typeof fetch;
  /** Records what a plugin may reach, send and write, and gives its hosts their default budget. */
  grant(pluginId: string, grant: PluginGrant): void;
  /** Applies `rate_limits:` from .pr-rla.yml. Hosts without a default budget yet wait for a plugin that declares them. */
  setRateLimits(overrides: RateLimitOverrides): void;
  /** Hosts named in `rate_limits:` that no default budget covers yet. */
  pendingRateLimits(): string[];
}

export interface AuditContextOptions {
  mode: AuditMode;
  env?: Readonly<Record<string, string | undefined>>;
  nowMs?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
  /** The transport under the broker (tests inject fakes; default global fetch). */
  fetch?: typeof fetch;
  random?: () => number;
  setTimer?: (fire: () => void, ms: number) => () => void;
  timeouts?: Partial<Record<Destination, number>>;
  rateLimits?: RateLimitOverrides;
  /** Records every exchange, scrubbed (fixture recording). Refused in read-only mode. */
  recorder?: (exchange: RecordedExchange) => void;
  /** Default: `builtin-only` when PR_RLA_PLUGINS=builtin-only is in `env`, else external plugins load if locked. */
  plugins?: PluginPolicy;
  /** Where approvals are read (default: PR_RLA_APPROVALS_FILE, XDG_CONFIG_HOME or ~/.config; src/plugins/approvals.ts). */
  approvalsFile?: string;
  /** Take the repo's lock grants and trust for this run without a local approval (`--accept-lock-grants`; also PR_RLA_ACCEPT_LOCK_GRANTS=1 in `env`). */
  acceptLockGrants?: boolean;
}

/** An isolated plugin that declares no hosts may contact none (an empty set would mean "any" to the broker). */
const NO_HOSTS: ReadonlySet<string> = new Set(["(no hosts declared)"]);

/** An API refusal, in the CLI error form (contracts.md §7) and the MCP error codes (§4). */
export class AuditApiError extends AuditError {
  declare readonly code: "READ_ONLY_VIOLATION";
  declare readonly next: string;
  constructor(message: string, code: "READ_ONLY_VIOLATION", next: string) {
    super(message, 1, code, next);
    this.name = "AuditApiError";
  }
}

interface Stored {
  trust: PluginGrant["trust"];
  hosts: Set<string>;
  writePaths: Set<string>;
  credentials: Map<string, Credential>;
}

export function createAuditContext(o: AuditContextOptions): AuditContext {
  if (o.mode === "read-only" && o.recorder) throw new Error("an AuditContext in read-only mode cannot record (contracts.md §2 step 7)");
  const env = o.env ?? {};
  const nowMs = o.nowMs ?? Date.now;
  const sleep = o.sleep ?? sleepFor;
  const log = o.log ?? (() => {});
  const grants = new Map<string, Stored>();
  const budgets: Map<string, HostBudgetDefault> = defaultBudgets();
  const pending = new Map<string, Record<string, unknown>>();

  /** Overrides for `host`: an exact default entry, or a copy of a matching `*.domain` entry. */
  const applyTo = (host: string, overrides: Record<string, unknown>): boolean => {
    const exact = budgets.get(host);
    const wildcard = exact ? undefined : [...budgets].find(([k]) => k.startsWith("*.") && host.endsWith(k.slice(1)))?.[1];
    const base = exact ?? wildcard;
    if (!base) return false;
    budgets.set(host, applyRateOverrides(base, overrides, `rate_limits.${host}`));
    return true;
  };

  const broker = createBroker(
    {
      mode: o.mode,
      hostsFor: (id) => {
        const g = grants.get(id);
        return g?.trust === "isolated" ? (g.hosts.size ? g.hosts : (NO_HOSTS as Set<string>)) : new Set();
      },
      writePathsFor: (id) => grants.get(id)?.writePaths ?? new Set(),
      credentialsFor: (id) => grants.get(id)?.credentials ?? new Map(),
      budgets,
      timeouts: { ...DESTINATION_TIMEOUT_MS, ...o.timeouts },
      ...(o.recorder ? { recorder: o.recorder } : {}),
    },
    {
      ...(o.fetch ? { fetch: o.fetch } : {}),
      now: nowMs,
      sleep,
      log,
      ...(o.random ? { random: o.random } : {}),
      ...(o.setTimer ? { setTimer: o.setTimer } : {}),
    },
  );

  const ctx: AuditContext = {
    mode: o.mode,
    env,
    nowMs,
    sleep,
    log,
    broker,
    plugins: readOnlyPolicy(o.mode, o.plugins ?? pluginPolicy(undefined, env)),
    consent: approvedOnly(o.mode, localConsent(env, { ...(o.acceptLockGrants !== undefined ? { acceptLockGrants: o.acceptLockGrants } : {}), ...(o.approvalsFile !== undefined ? { file: o.approvalsFile } : {}) })),
    componentFetch: (id, destination) => broker.bind(id, destination),
    grant(pluginId, g) {
      const credentials = new Map<string, Credential>();
      for (const c of g.credentials ?? []) {
        const value = env[c.env];
        // As the broker compares them: URL hosts of https origins (lowercase, the default port left out).
        const hosts = new Set(c.hosts.flatMap((h) => (httpsOrigin(h) ? [new URL(httpsOrigin(h)!).host] : [])));
        const headers = { ...(c.headers?.length ? { headers: new Set(c.headers.map((h) => h.toLowerCase())) } : {}), ...(c.secret === false ? { secret: false } : {}) };
        if (value !== undefined) credentials.set(c.env, c.withheld ? { value: "", hosts, ...headers, withheld: c.withheld } : { value, hosts, ...headers });
      }
      grants.set(pluginId, { trust: g.trust, hosts: new Set(g.hosts ?? []), writePaths: new Set(g.writePaths ?? []), credentials });
      if (g.budgetFamily) {
        for (const host of g.hosts ?? []) {
          const name = host.replace(/:\d+$/, "");
          if (!budgets.has(name)) budgets.set(name, familyBudget(g.budgetFamily));
          const ov = pending.get(name);
          if (ov && applyTo(name, ov)) pending.delete(name);
        }
      }
    },
    setRateLimits(overrides) {
      for (const [host, ov] of Object.entries(overrides)) if (!applyTo(host, ov)) pending.set(host, ov);
    },
    pendingRateLimits: () => [...pending.keys()],
  };
  if (o.rateLimits) ctx.setRateLimits(o.rateLimits);
  return ctx;
}

/**
 * Read-only contexts (pr-rla/api/read, the MCP server) take only what is approved on this machine
 * (`pr-rla plugin approve`) and the built-in defaults: never `--accept-lock-grants` or
 * PR_RLA_ACCEPT_LOCK_GRANTS, which accept a repo's grants and are only for a repo you control.
 */
export function approvedOnly(mode: AuditMode, c: LocalConsent): LocalConsent {
  if (mode !== "read-only") return c;
  const stored = <T>(x: T | "accepted" | null): T | null => (x === "accepted" ? null : x);
  return { file: c.file, acceptLockGrants: false, plugin: (use, entry) => stored(c.plugin(use, entry)), builtin: (env, origin) => stored(c.builtin(env, origin)) };
}

/** In read-only mode, a `locked` policy becomes `isolated-only`: no `trust: full` plugin runs in process there. */
export function readOnlyPolicy(mode: AuditMode, policy: PluginPolicy): PluginPolicy {
  return mode === "read-only" && policy === "locked" ? "isolated-only" : policy;
}

/** Options for opening a provider or a ledger for one call. */
export interface OpenOptions {
  /** The call's signal: it reaches every request, wait and plugin call the plugin makes (U5 fix round). */
  signal?: AbortSignal;
}

/** Refuses a write operation in read-only mode, before it starts. */
export function requireReadWrite(ctx: AuditContext, operation: string): void {
  if (ctx.mode === "read-only") throw new AuditApiError(`${operation} writes, and this audit context is read-only`, "READ_ONLY_VIOLATION", `run "pr-rla ${operation}" yourself from the CLI`);
}

/**
 * A built-in's environment for these options (finding 1, for built-ins): the variables it would
 * send whose every origin is a built-in default, approved on this machine, or accepted for this
 * run (`--accept-lock-grants`), and is https, and nothing else: a built-in reads no other variable
 * (test/builtin-consent.test.ts checks every one). Any other set variable is withheld, so the
 * built-in runs anonymously, and one line names the command that approves it.
 */
export function builtinEnvironment(ctx: Pick<AuditContext, "env" | "consent" | "log">, kind: "provider" | "ledger", name: string, use: string, options: unknown): { env: Record<string, string | undefined>; granted: BuiltinCredentialUse[] } {
  const env: Record<string, string | undefined> = {};
  const granted: BuiltinCredentialUse[] = [];
  const withheld: string[] = [];
  const accepted: string[] = [];
  for (const u of builtinCredentialUses(kind, name, options)) {
    if (!ctx.env[u.env]) continue;
    const line = `${u.env} -> ${u.origins.join(", ") || "no origin"}`;
    const https = u.origins.length > 0 && u.origins.every((o) => o.startsWith("https://"));
    const sources = u.origins.map((o) => ctx.consent.builtin(u.env, o));
    if (https && sources.every((x) => x !== null)) {
      granted.push(u);
      env[u.env] = ctx.env[u.env];
      if (sources.includes("accepted")) accepted.push(line);
    } else withheld.push(`${line}${https ? "" : " (not https)"}`);
  }
  if (withheld.length) ctx.log(`${kind} ${use}: ${withheld.join("; ")} ${withheld.length > 1 ? "are" : "is"} not approved on this machine, so withheld (the ${kind} runs without ${withheld.length > 1 ? "them" : "it"}); to approve: pr-rla plugin approve ${use}`);
  if (accepted.length) ctx.log(`${kind} ${use}: accepting ${accepted.join("; ")} from .pr-rla.yml for this run, not approved on this machine; --accept-lock-grants is only for a repo you control`);
  return { env, granted };
}

/** What a built-in may send, for the broker's grant (its recorder scrubs these values). */
const builtinGrantCredentials = (granted: readonly BuiltinCredentialUse[]) => granted.map((u) => ({ env: u.env, hosts: u.origins.map((o) => new URL(o).host), ...(u.secret ? {} : { secret: false }) }));

/**
 * What a built-in gets from the environment, and the broker grant that goes with it. One decision for
 * both modes: `builtinEnvironment` (the defaults and this machine's approvals). In read-only mode
 * (pr-rla/api/read, the MCP server) the built-in holds placeholders, never the secrets: the broker
 * swaps each only on the origin it was approved for (U5 fix round, joined to the approvals store).
 */
export function builtinEnv(ctx: AuditContext, kind: "provider" | "ledger", name: string, use: string, options: unknown): { env: Record<string, string | undefined>; credentials: PluginCredential[] } {
  const { env, granted } = builtinEnvironment(ctx, kind, name, use, options);
  const credentials = builtinGrantCredentials(granted);
  if (ctx.mode !== "read-only") return { env, credentials };
  return { env: Object.fromEntries(Object.keys(env).map((k) => [k, `prrla-cred:${k}`])), credentials };
}

/**
 * Opens the configured provider with its fetch bound to the broker as `provider:<name>`. With a
 * signal (one call's), every request and wait the provider makes for that call ends when it aborts.
 */
export async function openProvider(ctx: AuditContext, spec: PluginSpec, cwd: string, o: OpenOptions = {}): Promise<ScmProvider> {
  if (!builtinProviderName(spec.use)) return openExternalProvider(ctx, spec, cwd, o);
  const def = await loadProviderDefinition(spec.use, cwd);
  const builtin = Object.values(BUILTIN_PROVIDERS).includes(def as never);
  const id = `provider:${def.name}`;
  const { env, credentials } = builtinEnv(ctx, "provider", def.name, spec.use, spec.options);
  ctx.grant(id, {
    trust: builtin ? "builtin" : "full",
    hosts: def.hosts?.(spec.options as never) ?? [],
    credentials,
    ...(builtin && PROVIDER_BUDGET_FAMILY[def.name] ? { budgetFamily: PROVIDER_BUDGET_FAMILY[def.name] } : {}),
  });
  for (const host of ctx.pendingRateLimits()) ctx.log(`rate_limits: ${host} has no default budget (not a known public host or a host of provider ${def.name}); the override is not used`);
  return createProvider(spec, { cwd, env, log: ctx.log, fetch: signalledFetch(ctx.broker.bind(id), o.signal), sleep: signalledSleep((ms) => ctx.sleep(ms, o.signal), o.signal) });
}

const LEDGER_READS = ["readVerdicts", "verifyIntegrity", "readHistory"] as const;

/**
 * Opens the configured ledger with its fetch bound as `ledger:<name>`. In read-only mode the
 * ledger comes back with its read methods only; a write method refuses with READ_ONLY_VIOLATION.
 * `reviewers` (the registration's `verdicts.reviewers`) feeds the ledger's integrity analysis.
 */
export async function openLedger(ctx: AuditContext, spec: PluginSpec, cwd: string, windowDir: string, opts: { reviewers?: readonly string[] | null } & OpenOptions = {}): Promise<Ledger> {
  const ledger = builtinLedgerName(spec.use) ? await openBuiltinLedger(ctx, spec, cwd, windowDir, opts) : await openExternalLedger(ctx, spec, cwd, windowDir, opts);
  if (ctx.mode === "read-write") return ledger;
  const refuse = (m: string) => async () => {
    throw new AuditApiError(`ledger ${ledger.name}: ${m} writes, and this audit context is read-only`, "READ_ONLY_VIOLATION", "record verdicts and publish draws from the CLI or the tracker's web UI");
  };
  const view: Ledger = { apiVersion: ledger.apiVersion, name: ledger.name, readVerdicts: () => ledger.readVerdicts(), appendVerdict: refuse("appendVerdict") };
  for (const m of LEDGER_READS) {
    const fn = (ledger as unknown as Record<string, unknown>)[m];
    if (typeof fn === "function") (view as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(ledger, args);
  }
  if (ledger.publishDraws) view.publishDraws = refuse("publishDraws");
  return view;
}

async function openBuiltinLedger(ctx: AuditContext, spec: PluginSpec, cwd: string, windowDir: string, opts: { reviewers?: readonly string[] | null } & OpenOptions): Promise<Ledger> {
  const def = await loadLedgerDefinition(spec.use, cwd);
  const builtin = Object.values(BUILTIN_LEDGERS).includes(def as never);
  const id = `ledger:${def.name}`;
  const { env, credentials } = builtinEnv(ctx, "ledger", def.name, spec.use, spec.options);
  ctx.grant(id, {
    trust: builtin ? "builtin" : "full",
    hosts: def.hosts?.(spec.options as never) ?? [],
    writePaths: def.writePaths?.(spec.options as never) ?? [],
    credentials,
    ...(builtin && LEDGER_BUDGET_FAMILY[def.name] ? { budgetFamily: LEDGER_BUDGET_FAMILY[def.name] } : {}),
  });
  return createLedger(spec, { cwd, windowDir, env, log: ctx.log, fetch: signalledFetch(ctx.broker.bind(id), opts.signal), sleep: signalledSleep((ms) => ctx.sleep(ms, opts.signal), opts.signal), ...(opts.reviewers !== undefined ? { reviewers: opts.reviewers } : {}) });
}
