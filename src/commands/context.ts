import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fetchQuicknetBeacon, verifyQuicknetBeacon, type Beacon } from "../beacon/drand.js";
import { sha256Hex } from "../core/canonical.js";
import type { AnyCommitment, AnyManifest, AnyRegistration, DrawsFile, SignedRecord } from "../core/records.js";
import { writeFileAtomic } from "../io/atomic.js";
import type { BrokerFetch } from "../net/contract.js";
import { createMinimalBroker } from "../net/minimal-adapter.js";
import { SHIPPED_TRUST_BUNDLE, mergeTrust, readTrustExtra, type TrustBundle, type TrustBundleExtra } from "../timestamp/bundle.js";
export type { DrawsFile } from "../core/records.js";
import { CONFIG_FILE, loadConfig, windowPaths, type PrRlaConfig, type WindowPaths } from "../config.js";
import { createLedger, createProvider } from "../registry.js";
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

/** The fetch broker for this command (the minimal adapter until bolt 2), on the context's clock. */
export function brokerFor(ctx: CommandContext): BrokerFetch {
  return createMinimalBroker({ fetch: ctx.fetch, now: ctx.nowMs, ...(ctx.sleep ? { sleep: ctx.sleep } : {}) });
}

/** The shipped trust bundle plus anchors the caller trusts (ctx.tsaTrust, --tsa-trust files). Never the audit repo's own. */
export function trustFor(ctx: CommandContext, files: readonly string[] = []): TrustBundle {
  return mergeTrust(SHIPPED_TRUST_BUNDLE, [...(ctx.tsaTrust ?? []), ...files.map((f) => readTrustExtra(resolve(ctx.cwd, f)))]);
}

export function configFor(ctx: CommandContext): { config: PrRlaConfig; paths: WindowPaths } {
  const path = ctx.configPath ? resolve(ctx.cwd, ctx.configPath) : join(ctx.cwd, CONFIG_FILE);
  const config = loadConfig(path, ctx.fromFile ? { fromFile: resolve(ctx.cwd, ctx.fromFile) } : {});
  return { config, paths: windowPaths(config) };
}

export async function providerFor(ctx: CommandContext, config: PrRlaConfig): Promise<ScmProvider> {
  return createProvider(config.provider, { cwd: config.dir, env: ctx.env, log: ctx.err, fetch: ctx.fetch });
}

export async function ledgerFor(ctx: CommandContext, config: PrRlaConfig, paths: WindowPaths): Promise<Ledger> {
  return createLedger(config.ledger, { cwd: config.dir, windowDir: paths.windowDir, env: ctx.env, log: ctx.err, fetch: ctx.fetch });
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
  return fetchQuicknetBeacon(round, { fetch: ctx.fetch, nowUnix: Math.floor(ctx.nowMs() / 1000) });
}

export const fmt = (n: number) => n.toLocaleString("en-US");
export const isoNow = (ctx: CommandContext) => new Date(Math.floor(ctx.nowMs() / 1000) * 1000).toISOString().replace(".000Z", "Z");
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
