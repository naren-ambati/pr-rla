import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fetchQuicknetBeacon, verifyQuicknetBeacon, type Beacon } from "../beacon/drand.js";
import { sha256Hex } from "../core/canonical.js";
import type { AnyCommitment, AnyManifest, AnyRegistration, DrawsFile, SignedRecord } from "../core/records.js";
import { writeFileAtomic } from "../io/atomic.js";
import { createAuditContext, openLedger, openProvider, type AuditContext } from "../api/context.js";
import type { BrokerFetch } from "../net/contract.js";
import { SHIPPED_TRUST_BUNDLE, mergeTrust, readTrustExtra, type TrustBundle, type TrustBundleExtra } from "../timestamp/bundle.js";
export type { DrawsFile } from "../core/records.js";
import { CONFIG_FILE, loadConfig, windowPaths, type PrRlaConfig, type WindowPaths } from "../config.js";
import type { Ledger } from "../sdk/ledger.js";
import type { ScmProvider } from "../sdk/provider.js";

export interface CommandContext {
  /** Directory holding .pr-rla.yml (the audit repo). */
  cwd: string;
  configPath?: string;
  /** Replace the configured provider with json-file at this path. */
  fromFile?: string;
  env: Readonly<Record<string, string | undefined>>;
  nowMs: () => number;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Overrides how beacons are obtained (tests, --beacon-file). Must return a VERIFIED beacon or throw. */
  beacon?: (round: number) => Promise<Beacon>;
  /** Waits; injected with nowMs so retry deadlines run on one clock (tests use a fake one). */
  sleep?: (ms: number) => Promise<void>;
  /** Request nonce per authority; injected only to replay recorded timestamp responses. */
  nonceFor?: (tsa: string) => Uint8Array;
  /** Extra timestamp-authority anchors trusted by whoever runs the command (tests; the CLI's --tsa-trust adds files). */
  tsaTrust?: TrustBundleExtra[];
  /** Asks the human a yes/no question; absent when there is no terminal. */
  confirm?: (question: string) => Promise<boolean>;
}

export class CommandError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "CommandError";
  }
}

export function nodeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    nowMs: () => Date.now(),
    fetch: globalThis.fetch,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...(process.stdin.isTTY
      ? {
          confirm: async (q: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
            } finally {
              rl.close();
            }
          },
        }
      : {}),
    ...overrides,
  };
}

const auditContexts = new WeakMap<CommandContext, AuditContext>();
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The command's AuditContext (src/api/context.ts), read-write, made once per CommandContext so
 * every request of the command (providers, ledgers, timestamp authorities, drand, Rekor) goes
 * through one broker and shares its per-host budgets. It reads the context's transport, clock
 * and sleep when it uses them, on the command's clock.
 */
export function auditContextFor(ctx: CommandContext): AuditContext {
  let a = auditContexts.get(ctx);
  if (!a) {
    a = createAuditContext({
      mode: "read-write",
      env: ctx.env,
      nowMs: () => ctx.nowMs(),
      sleep: (ms) => (ctx.sleep ?? realSleep)(ms),
      log: (l) => ctx.err(l),
      fetch: ((input, init) => ctx.fetch(input, init)) as typeof fetch,
    });
    auditContexts.set(ctx, a);
  }
  return a;
}

/** The fetch broker for this command: shared by every caller, on the context's clock. */
export function brokerFor(ctx: CommandContext): BrokerFetch {
  return auditContextFor(ctx).broker.fetch;
}

/** The shipped trust bundle plus anchors the caller trusts (ctx.tsaTrust, --tsa-trust files). Never the audit repo's own. */
export function trustFor(ctx: CommandContext, files: readonly string[] = []): TrustBundle {
  return mergeTrust(SHIPPED_TRUST_BUNDLE, [...(ctx.tsaTrust ?? []), ...files.map((f) => readTrustExtra(resolve(ctx.cwd, f)))]);
}

export function configFor(ctx: CommandContext): { config: PrRlaConfig; paths: WindowPaths } {
  const path = ctx.configPath ? resolve(ctx.cwd, ctx.configPath) : join(ctx.cwd, CONFIG_FILE);
  const config = loadConfig(path, ctx.fromFile ? { fromFile: resolve(ctx.cwd, ctx.fromFile) } : {});
  auditContextFor(ctx).setRateLimits(config.rateLimits);
  return { config, paths: windowPaths(config) };
}

/** The configured provider, its requests through the command's broker. */
export async function providerFor(ctx: CommandContext, config: PrRlaConfig): Promise<ScmProvider> {
  return openProvider(auditContextFor(ctx), config.provider, config.dir);
}

/** The configured ledger, its requests through the command's broker. */
export async function ledgerFor(ctx: CommandContext, config: PrRlaConfig, paths: WindowPaths): Promise<Ledger> {
  return openLedger(auditContextFor(ctx), config.ledger, config.dir, paths.windowDir);
}

export function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) throw new CommandError(`${what} not found at ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new CommandError(`${what} at ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Every audit file is written atomically: a temporary file, then a rename (NFR15). */
export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function protocolSha256(config: PrRlaConfig): string {
  const p = isAbsolute(config.protocol) ? config.protocol : join(config.dir, config.protocol);
  if (!existsSync(p)) throw new CommandError(`review protocol not found at ${p} (run "pr-rla init" or set protocol: in ${CONFIG_FILE})`);
  return sha256Hex(readFileSync(p));
}

export const readRegistration = (paths: WindowPaths) => readJson<SignedRecord<AnyRegistration>>(paths.registration, "registration");
export const readManifest = (paths: WindowPaths) => readJson<AnyManifest>(paths.manifest, "manifest");
export const readCommitment = (paths: WindowPaths) => readJson<SignedRecord<AnyCommitment>>(paths.commitment, "manifest commitment");

export const readDraws = (paths: WindowPaths) => readJson<DrawsFile>(paths.draws, "draws");

export async function getBeacon(ctx: CommandContext, round: number, beaconFile?: string): Promise<Beacon> {
  if (beaconFile) {
    const b = readJson<Beacon>(resolve(ctx.cwd, beaconFile), "beacon file");
    if (!(await verifyQuicknetBeacon(b, round))) throw new CommandError(`beacon file ${beaconFile} is not a valid quicknet beacon for round ${round}`);
    return b;
  }
  if (ctx.beacon) return ctx.beacon(round);
  return fetchQuicknetBeacon(round, { fetch: auditContextFor(ctx).componentFetch("pr-rla/drand", "beacon"), nowUnix: Math.floor(ctx.nowMs() / 1000) });
}

export const fmt = (n: number) => n.toLocaleString("en-US");
export const isoNow = (ctx: CommandContext) => new Date(Math.floor(ctx.nowMs() / 1000) * 1000).toISOString().replace(".000Z", "Z");
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
