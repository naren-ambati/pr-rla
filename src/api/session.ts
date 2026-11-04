import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fetchQuicknetBeacon, verifyQuicknetBeacon, type Beacon } from "../beacon/drand.js";
import { sha256Hex } from "../core/canonical.js";
import { isManifestV2, isRegistrationV2, type AnyCommitment, type AnyManifest, type AnyRegistration, type DrawsFile, type SignedRecord } from "../core/records.js";
import { CONFIG_FILE, parseConfig, windowPaths, type PrRlaConfig, type WindowPaths } from "../config.js";
import { readTextConfined, readConfined } from "../io/confine.js";
import { gitFilePath } from "../ledgers/git-file.js";
import { signalledFetch, sleepFor } from "../net/abort.js";
import type { BrokerFetch } from "../net/contract.js";
import { pluginPolicy } from "../plugins/lock.js";
import type { Ledger } from "../sdk/ledger.js";
import { isCommitId, type ScmProvider } from "../sdk/provider.js";
import { SHIPPED_TRUST_BUNDLE, mergeTrust, readTrustExtra, type TrustBundle, type TrustBundleExtra } from "../timestamp/bundle.js";
import { AuditApiError, createAuditContext, openLedger, openProvider, type AuditContext, type AuditMode } from "./context.js";
import { AuditError, type AuditErrorCode } from "./errors.js";

/**
 * What an audit API function works on (functional-design.md §U5): the audit repo, the environment,
 * the clock, the transport under the fetch broker, and a sink for notes meant for a person. The CLI's
 * CommandContext is one (it adds `out`); `pr-rla/api/read` builds a read-only one for each caller.
 *
 * API functions return their result objects and never print them: `err` carries only notes and
 * progress, as the CLI's stderr does.
 */
export interface ApiContext {
  /** Directory holding .pr-rla.yml (the audit repo). */
  cwd: string;
  configPath?: string;
  /** Replace the configured provider with json-file at this path. */
  fromFile?: string;
  env: Readonly<Record<string, string | undefined>>;
  nowMs: () => number;
  fetch: typeof fetch;
  /** Notes and progress for a person (the CLI's stderr). Never the result. */
  err: (line: string) => void;
  /** Overrides how beacons are obtained (tests, --beacon-file). Must return a VERIFIED beacon or throw. */
  beacon?: (round: number) => Promise<Beacon>;
  /** Waits; injected with nowMs so retry deadlines run on one clock (tests use a fake one). `signal` ends a wait early. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Request nonce per authority; injected only to replay recorded timestamp responses. */
  nonceFor?: (tsa: string) => Uint8Array;
  /** Extra timestamp-authority anchors trusted by whoever runs the command (tests; the CLI's --tsa-trust adds files). */
  tsaTrust?: TrustBundleExtra[];
  /** Asks the human a yes/no question; absent when there is no terminal. */
  confirm?: (question: string) => Promise<boolean>;
  /** `--plugins builtin-only` (PR_RLA_PLUGINS=builtin-only in env does the same): refuse every external plugin. */
  plugins?: string;
  /**
   * Signs a verdict's bytes with the key `record --sign` names, returning the armored SSHSIG (U9).
   * Default: `ssh-keygen -Y sign -n pr-rla-verdict@v1`. Injected only for a test's software-emulated authenticator.
   */
  signVerdict?: (payload: Uint8Array, keyPath: string) => Promise<string>;
  /**
   * `--accept-lock-grants` (PR_RLA_ACCEPT_LOCK_GRANTS=1 does the same): take the repo's grants and trust for this run
   * (src/plugins/approvals.ts). A read-only context ignores it: only what is approved on this machine counts there.
   */
  acceptLockGrants?: boolean;
  /**
   * The mode of this context's AuditContext. The CLI runs read-write; `pr-rla/api/read` (the MCP
   * server) is read-only, so the broker refuses every non-read request and write functions refuse.
   */
  mode?: AuditMode;
  /**
   * Refuses a file or directory the caller may not open (the MCP server's roots: ROOT_ESCAPE). The
   * API calls it for the config, the audit directory, the protocol and any file the config names.
   */
  confine?: (path: string, what: string) => void;
  /** Aborts provider work (the MCP server cancels a job's requests with it). */
  signal?: AbortSignal;
  /** Progress of a long call (freeze preview, online verify), for the MCP server's notifications. */
  onProgress?: (p: { done: number; total?: number; message: string }) => void;
}

const auditContexts = new WeakMap<ApiContext, AuditContext>();

/**
 * The call's AuditContext (src/api/context.ts), made once per ApiContext so every request of the
 * call (providers, ledgers, timestamp authorities, drand, Rekor) goes through one broker and shares
 * its per-host budgets. It reads the context's transport, clock and sleep when it uses them, on the
 * context's clock. Read-write unless the context says read-only.
 */
export function auditContextFor(ctx: ApiContext): AuditContext {
  let a = auditContexts.get(ctx);
  if (!a) {
    a = createAuditContext({
      mode: ctx.mode ?? "read-write",
      env: ctx.env,
      nowMs: () => ctx.nowMs(),
      sleep: (ms, signal) => (ctx.sleep ? ctx.sleep(ms, signal) : sleepFor(ms, signal)),
      log: (l) => ctx.err(l),
      fetch: ((input, init) => ctx.fetch(input, init)) as typeof fetch,
      plugins: pluginPolicy(ctx.plugins, ctx.env),
      ...(ctx.acceptLockGrants ? { acceptLockGrants: true } : {}),
    });
    auditContexts.set(ctx, a);
  }
  return a;
}

/**
 * Gives an ApiContext an AuditContext made elsewhere, so several calls share one broker and its
 * per-host budgets (`pr-rla/api/read` does this per caller session and audit directory).
 * The modes must agree.
 */
export function bindAuditContext(ctx: ApiContext, actx: AuditContext): void {
  if ((ctx.mode ?? "read-write") !== actx.mode) throw new Error(`an ApiContext in ${ctx.mode ?? "read-write"} mode cannot use a ${actx.mode} AuditContext`);
  auditContexts.set(ctx, actx);
}

/**
 * Refuses a write operation on a read-only ApiContext, before it starts. It reads the context's
 * mode only: it builds no AuditContext, so it never evaluates the plugin policy (an invalid
 * PR_RLA_PLUGINS still fails where it always did, not in `init` or before `plugin add`'s own checks).
 */
export function requireWritable(ctx: Pick<ApiContext, "mode">, operation: string): void {
  if ((ctx.mode ?? "read-write") === "read-only") throw new AuditApiError(`${operation} writes, and this audit context is read-only`, "READ_ONLY_VIOLATION", `run "pr-rla ${operation}" yourself from the CLI`);
}

/** The fetch broker for this call: shared by every caller, on the context's clock. */
export function brokerFor(ctx: ApiContext): BrokerFetch {
  return auditContextFor(ctx).broker.fetch;
}

/** The shipped trust bundle plus anchors the caller trusts (ctx.tsaTrust, --tsa-trust files). Never the audit repo's own. */
export function trustFor(ctx: ApiContext, files: readonly string[] = []): TrustBundle {
  return mergeTrust(SHIPPED_TRUST_BUNDLE, [...(ctx.tsaTrust ?? []), ...files.map((f) => readTrustExtra(resolve(ctx.cwd, f)))]);
}

/** Every file the configuration makes the API open, for `ApiContext.confine` (the MCP server's roots). */
function confineConfig(ctx: ApiContext, config: PrRlaConfig, paths: WindowPaths): void {
  const c = ctx.confine;
  if (!c) return;
  c(resolve(config.dir, config.auditDir), "audit_dir");
  c(paths.windowDir, "the window directory");
  c(isAbsolute(config.protocol) ? config.protocol : join(config.dir, config.protocol), "protocol");
  const path = config.provider.options.path;
  if ((config.provider.use === "json-file" || config.provider.use === "json") && typeof path === "string") c(isAbsolute(path) ? path : resolve(config.dir, path), "the json-file provider's path");
  // The path the git-file ledger opens (its own computation); every read is confined again when it opens it.
  if (config.ledger.use === "git-file") c(gitFilePath(paths.windowDir, config.ledger.options as { file?: string }), "the ledger's file");
  if (config.transparencyLog.publicKeyFile) c(resolve(config.dir, config.transparencyLog.publicKeyFile), "transparency_log.public_key_file");
}

/** The audit's configuration and the paths of its window (another window than the configured one, when named). */
export function configFor(ctx: ApiContext, window?: string): { config: PrRlaConfig; paths: WindowPaths } {
  const path = ctx.configPath ? resolve(ctx.cwd, ctx.configPath) : join(ctx.cwd, CONFIG_FILE);
  ctx.confine?.(path, CONFIG_FILE);
  if (!existsSync(path)) throw new AuditError(`no ${CONFIG_FILE} at ${path} (run "pr-rla init")`, 1, "NO_AUDIT");
  let config: PrRlaConfig;
  try {
    config = parseConfig(readTextConfined(path, CONFIG_FILE), path, ctx.fromFile ? { fromFile: resolve(ctx.cwd, ctx.fromFile) } : {});
  } catch (e) {
    if ((e as { code?: unknown }).code === "ROOT_ESCAPE") throw e;
    // One line, never a YAML code frame: an error message carries no file contents.
    throw new AuditError(firstLine((e as Error).message), 1, "NO_AUDIT");
  }
  auditContextFor(ctx).setRateLimits(config.rateLimits);
  let paths = windowPaths(config);
  if (window !== undefined && window !== config.window.name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(window) || window.includes(".."))
      throw new AuditError(`window ${JSON.stringify(window)} is not a window name (letters, digits, ".", "_" and "-")`, 1, "BAD_WINDOW", "list the windows with audit_list");
    paths = windowPaths({ ...config, window: { ...config.window, name: window } });
    if (!existsSync(paths.windowDir)) throw new AuditError(`window ${window} has no directory in ${resolve(config.dir, config.auditDir)}`, 1, "BAD_WINDOW", "list the windows with audit_list");
  }
  confineConfig(ctx, config, paths);
  return { config, paths };
}

/** The configured provider, its requests through the context's broker. */
export async function providerFor(ctx: ApiContext, config: PrRlaConfig): Promise<ScmProvider> {
  return openProvider(auditContextFor(ctx), config.provider, config.dir, ctx.signal ? { signal: ctx.signal } : {});
}

/** The configured ledger, its requests through the context's broker, told the registered reviewers once a registration exists. */
export async function ledgerFor(ctx: ApiContext, config: PrRlaConfig, paths: WindowPaths): Promise<Ledger> {
  const reg = existsSync(paths.registration) ? readRegistration(paths) : null;
  const reviewers = reg && isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null;
  return openLedger(auditContextFor(ctx), config.ledger, config.dir, paths.windowDir, { reviewers, ...(ctx.signal ? { signal: ctx.signal } : {}) });
}

/** The first line of an error message, at most 300 characters: what a parser's message says, without the text it quotes. */
export function firstLine(message: string): string {
  const l = message.split(/\r?\n/)[0]!.replace(/:\s*$/, "");
  return l.length > 300 ? `${l.slice(0, 300)}…` : l;
}

/**
 * Reads an audit record: confined to the caller's roots when it has any (src/io/confine.ts), the
 * path checked being the path opened. A missing one is NO_AUDIT (nothing to report yet); an
 * unreadable one too. The error never quotes the file (JSON.parse's message would).
 */
export function readJson<T>(path: string, what: string, code: AuditErrorCode = "NO_AUDIT"): T {
  if (!existsSync(path)) throw new AuditError(`${what} not found at ${path}`, 1, code);
  const text = readTextConfined(path, what);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AuditError(`${what} at ${path} is not valid JSON`, 1, code);
  }
}

export function protocolPath(config: PrRlaConfig): string {
  return isAbsolute(config.protocol) ? config.protocol : join(config.dir, config.protocol);
}

export function protocolSha256(config: PrRlaConfig): string {
  const p = protocolPath(config);
  if (!existsSync(p)) throw new AuditError(`review protocol not found at ${p} (run "pr-rla init" or set protocol: in ${CONFIG_FILE})`, 1, "NO_AUDIT");
  return sha256Hex(readConfined(p, "protocol"));
}

/** The review protocol's bytes, confined, or null when the file is missing. */
export function readProtocol(config: PrRlaConfig): Buffer | null {
  const p = protocolPath(config);
  return existsSync(p) ? readConfined(p, "protocol") : null;
}

export const readRegistration = (paths: WindowPaths) => readJson<SignedRecord<AnyRegistration>>(paths.registration, "registration");
export function readManifest(paths: WindowPaths): AnyManifest {
  const m = readJson<AnyManifest>(paths.manifest, "manifest");
  // The pinned head goes into provider URLs and queries: only a commit id is accepted (schema pr-rla/manifest/v2).
  if (isManifestV2(m))
    for (const r of m.repos ?? [])
      if (r.headSha !== null && r.headSha !== undefined && !isCommitId(r.headSha)) throw new AuditError(`manifest at ${paths.manifest}: repos[].headSha ${JSON.stringify(r.headSha)} must be null or 40 to 64 lowercase hex characters`);
  return m;
}
export const readCommitment = (paths: WindowPaths) => readJson<SignedRecord<AnyCommitment>>(paths.commitment, "manifest commitment");
export const readDraws = (paths: WindowPaths) => readJson<DrawsFile>(paths.draws, "draws");

export async function getBeacon(ctx: ApiContext, round: number, beaconFile?: string): Promise<Beacon> {
  if (beaconFile) {
    const b = readJson<Beacon>(resolve(ctx.cwd, beaconFile), "beacon file", "FAILED");
    if (!(await verifyQuicknetBeacon(b, round))) throw new AuditError(`beacon file ${beaconFile} is not a valid quicknet beacon for round ${round}`);
    return b;
  }
  if (ctx.beacon) return ctx.beacon(round);
  return fetchQuicknetBeacon(round, { fetch: signalledFetch(auditContextFor(ctx).componentFetch("pr-rla/drand", "beacon"), ctx.signal), nowUnix: Math.floor(ctx.nowMs() / 1000) });
}

export const fmt = (n: number) => n.toLocaleString("en-US");
export const isoNow = (ctx: Pick<ApiContext, "nowMs">) => new Date(Math.floor(ctx.nowMs() / 1000) * 1000).toISOString().replace(".000Z", "Z");
export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
