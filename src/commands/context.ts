import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fetchQuicknetBeacon, verifyQuicknetBeacon, type Beacon } from "../beacon/drand.js";
import { sha256Hex } from "../core/canonical.js";
import type { DrawsFile, ManifestCommitmentRecord, Manifest, RegistrationRecord, SignedRecord } from "../core/records.js";
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
    ...overrides,
  };
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

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function protocolSha256(config: PrRlaConfig): string {
  const p = isAbsolute(config.protocol) ? config.protocol : join(config.dir, config.protocol);
  if (!existsSync(p)) throw new CommandError(`review protocol not found at ${p} (run "pr-rla init" or set protocol: in ${CONFIG_FILE})`);
  return sha256Hex(readFileSync(p));
}

export const readRegistration = (paths: WindowPaths) => readJson<SignedRecord<RegistrationRecord>>(paths.registration, "registration");
export const readManifest = (paths: WindowPaths) => readJson<Manifest>(paths.manifest, "manifest");
export const readCommitment = (paths: WindowPaths) => readJson<SignedRecord<ManifestCommitmentRecord>>(paths.commitment, "manifest commitment");

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
