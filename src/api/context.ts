import { createBroker, type Broker, type BrokerMode, type Credential, type RecordedExchange } from "../net/broker.js";
import { DESTINATION_TIMEOUT_MS, type Destination } from "../net/contract.js";
import { LEDGER_BUDGET_FAMILY, PROVIDER_BUDGET_FAMILY, applyRateOverrides, defaultBudgets, familyBudget, type BudgetFamily, type HostBudgetDefault, type RateLimitOverrides } from "../net/rate-limits.js";
import { credentialGrants } from "../plugins/host.js";
import { pluginPolicy, type PluginPolicy } from "../plugins/lock.js";
import { openExternalLedger, openExternalProvider } from "../plugins/open.js";
import { BUILTIN_LEDGERS, BUILTIN_PROVIDERS, builtinLedgerName, builtinProviderName, createLedger, createProvider, loadLedgerDefinition, loadProviderDefinition, type PluginSpec } from "../registry.js";
import type { Ledger } from "../sdk/ledger.js";
import type { PluginCredential, ScmProvider } from "../sdk/provider.js";

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

export interface PluginGrant {
  /** `builtin` and `full` run in-process with any host; `isolated` (U2b) is held to `hosts`. */
  trust: "builtin" | "full" | "isolated";
  hosts?: readonly string[];
  writePaths?: readonly string[];
  credentials?: readonly PluginCredential[];
  /** The default rate budget to give the plugin's hosts (built-in providers). */
  budgetFamily?: BudgetFamily;
}

export interface AuditContext {
  readonly mode: AuditMode;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** Every outbound HTTP request of this context goes through this one broker, so all callers share its budgets. */
  readonly broker: Broker;
  /** `builtin-only` refuses every external plugin before it is imported (U2b, FR2.6). */
  readonly plugins: PluginPolicy;
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
  sleep?: (ms: number) => Promise<void>;
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
}

/** An isolated plugin that declares no hosts may contact none (an empty set would mean "any" to the broker). */
const NO_HOSTS: ReadonlySet<string> = new Set(["(no hosts declared)"]);

/** An API refusal, in the CLI error form (contracts.md §7) and the MCP error codes (§4). */
export class AuditApiError extends Error {
  constructor(
    message: string,
    readonly code: "READ_ONLY_VIOLATION",
    readonly next: string,
  ) {
    super(message);
    this.name = "AuditApiError";
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const sleep = o.sleep ?? realSleep;
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
    plugins: o.plugins ?? pluginPolicy(undefined, env),
    componentFetch: (id, destination) => broker.bind(id, destination),
    grant(pluginId, g) {
      const credentials = new Map<string, Credential>();
      for (const c of g.credentials ?? []) {
        const value = env[c.env];
        if (value !== undefined) credentials.set(c.env, { value, hosts: new Set(c.hosts) });
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

/** Refuses a write operation in read-only mode, before it starts. */
export function requireReadWrite(ctx: AuditContext, operation: string): void {
  if (ctx.mode === "read-only") throw new AuditApiError(`${operation} writes, and this audit context is read-only`, "READ_ONLY_VIOLATION", `run "pr-rla ${operation}" yourself from the CLI`);
}

/** Opens the configured provider with its fetch bound to the broker as `provider:<name>`. */
export async function openProvider(ctx: AuditContext, spec: PluginSpec, cwd: string): Promise<ScmProvider> {
  if (!builtinProviderName(spec.use)) return openExternalProvider(ctx, spec, cwd);
  const def = await loadProviderDefinition(spec.use, cwd);
  const builtin = Object.values(BUILTIN_PROVIDERS).includes(def as never);
  const id = `provider:${def.name}`;
  ctx.grant(id, {
    trust: builtin ? "builtin" : "full",
    hosts: def.hosts?.(spec.options as never) ?? [],
    credentials: def.credentials ?? [],
    ...(builtin && PROVIDER_BUDGET_FAMILY[def.name] ? { budgetFamily: PROVIDER_BUDGET_FAMILY[def.name] } : {}),
  });
  for (const host of ctx.pendingRateLimits()) ctx.log(`rate_limits: ${host} has no default budget (not a known public host or a host of provider ${def.name}); the override is not used`);
  return createProvider(spec, { cwd, env: ctx.env, log: ctx.log, fetch: ctx.broker.bind(id), sleep: ctx.sleep });
}

const LEDGER_READS = ["readVerdicts", "verifyIntegrity", "readHistory"] as const;

/**
 * Opens the configured ledger with its fetch bound as `ledger:<name>`. In read-only mode the
 * ledger comes back with its read methods only; a write method refuses with READ_ONLY_VIOLATION.
 * `reviewers` (the registration's `verdicts.reviewers`) feeds the ledger's integrity analysis.
 */
export async function openLedger(ctx: AuditContext, spec: PluginSpec, cwd: string, windowDir: string, opts: { reviewers?: readonly string[] | null } = {}): Promise<Ledger> {
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

async function openBuiltinLedger(ctx: AuditContext, spec: PluginSpec, cwd: string, windowDir: string, opts: { reviewers?: readonly string[] | null }): Promise<Ledger> {
  const def = await loadLedgerDefinition(spec.use, cwd);
  const builtin = Object.values(BUILTIN_LEDGERS).includes(def as never);
  const id = `ledger:${def.name}`;
  ctx.grant(id, {
    trust: builtin ? "builtin" : "full",
    hosts: def.hosts?.(spec.options as never) ?? [],
    writePaths: def.writePaths?.(spec.options as never) ?? [],
    // A credential's hosts for these options: its declared hosts, or the https host of the URL option it names (hostFromOption).
    credentials: credentialGrants(def.credentials ?? [], spec.options),
    ...(builtin && LEDGER_BUDGET_FAMILY[def.name] ? { budgetFamily: LEDGER_BUDGET_FAMILY[def.name] } : {}),
  });
  return createLedger(spec, { cwd, windowDir, env: ctx.env, log: ctx.log, fetch: ctx.broker.bind(id), sleep: ctx.sleep, ...(opts.reviewers !== undefined ? { reviewers: opts.reviewers } : {}) });
}
