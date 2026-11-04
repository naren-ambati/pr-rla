import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_MAX_RETRIES } from "../sdk/http.js";
import { assertLedgerDefinition, LedgerApiVersionError, SUPPORTED_LEDGER_API_VERSIONS, type Ledger } from "../sdk/ledger.js";
import { assertProviderDefinition, ProviderApiVersionError, SUPPORTED_PROVIDER_API_VERSIONS, type ListChangesRequest, type PluginCredential, type ScmProvider } from "../sdk/provider.js";
import { PluginError } from "./errors.js";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  IPC_PROTOCOL,
  MAX_MESSAGE_BYTES,
  type ChildBoot,
  type ChildMessage,
  type CreateResult,
  type DescribeResult,
  type FetchMessage,
  type ParentMessage,
  type PluginKind,
  type PluginMethod,
  type ReadyMessage,
} from "./protocol.js";

/**
 * The plugin host, parent side (functional-design.md §U2b; contracts.md §3).
 *
 * An external plugin runs in a child Node process:
 * - `--permission` with fs-read limited to the plugin's files, its dependencies', the child
 *   script and the host's SDK modules; no fs-write, child-process, worker, addon or WASI
 *   permission, and no `--allow-net` (Node 25 or later then gives the child no network);
 * - an environment of `PR_RLA_HOST=1` plus `prrla-cred:<ENV>` placeholders only;
 * - every request the plugin makes comes back here over IPC and goes through the context's
 *   fetch (the fetch broker in a command), which swaps placeholders for secrets on declared
 *   hosts only; any secret a server echoes is replaced by its placeholder before the child
 *   sees the response;
 * - every wait it makes runs on the context's sleep, so a command keeps one clock.
 *
 * What this does not do is stated in docs/security-model.md: the permission model is a
 * seatbelt, and on Node 22 and 24 the child can still open sockets.
 */

const resolveSibling = (rel: string): string => {
  const js = fileURLToPath(new URL(`${rel}.js`, import.meta.url));
  return existsSync(js) ? js : fileURLToPath(new URL(`${rel}.ts`, import.meta.url));
};
/** dist/plugins/child.js in a build; src/plugins/child.ts (type-stripped by Node) when running from source. */
export const CHILD_SCRIPT = resolveSibling("./child");
/** The SDK subpaths a plugin imports, mapped to this pr-rla's own modules. */
export const SDK_MODULES: Readonly<Record<string, string>> = {
  "pr-rla/provider": resolveSibling("../sdk/provider"),
  "pr-rla/ledger": resolveSibling("../sdk/ledger"),
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const realTimer = (fire: () => void, ms: number) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

/** Node's major version for an executable (this process's without a spawn). */
export function nodeMajor(execPath: string = process.execPath): number {
  if (execPath === process.execPath) return Number(process.versions.node.split(".")[0]);
  const r = spawnSync(execPath, ["-p", "process.versions.node"], { encoding: "utf8", env: {}, timeout: 10_000 });
  return Number(String(r.stdout).trim().split(".")[0]);
}

/** Node 25 added `--allow-net`; without it a child under `--permission` has no network (tested: test/plugin-host.test.ts, RK-02). */
export const NETWORK_DENIED_FROM_NODE = 25;

export interface HostOptions {
  kind: PluginKind;
  /** The plugin module (a real path). */
  entry: string;
  /** Paths the child may read (./lock.ts readGrants). */
  readPaths: readonly string[];
  /** The child's whole environment (./lock.ts placeholderEnv). */
  env: Readonly<Record<string, string>>;
  /** How messages name the plugin: its `use`. */
  label: string;
  /** Secrets the broker may swap in; stripped from every response before the child sees it. */
  secrets?: readonly { env: string; value: string }[];
  execPath?: string;
  heartbeatTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maxMessageBytes?: number;
  /** Arms the heartbeat watchdog (tests use a recording one). */
  setTimer?: (fire: () => void, ms: number) => () => void;
}

/** Where the child's fetches, waits and log lines go: the plugin context's own. */
export interface HostIo {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface PluginHost {
  readonly ready: ReadyMessage;
  readonly label: string;
  readonly pid: number | undefined;
  /** The child's Node major version, and whether that Node denies it the network. */
  readonly nodeMajor: number;
  readonly networkDenied: boolean;
  attach(io: HostIo): void;
  call(method: PluginMethod, args: unknown[], signal?: AbortSignal): Promise<unknown>;
  close(): void;
  /** The last lines the child wrote to stdout or stderr. */
  stderrTail(): string;
}

const live = new Set<PluginHost>();

/** Stops every plugin host this process started (the CLI calls it when a command ends). */
export function closeAllPluginHosts(): void {
  for (const h of [...live]) h.close();
}

type Refable = { ref?: () => void; unref?: () => void };

/** Replaces each secret (and each Basic pair of them) with its placeholder, in bytes. */
function scrubber(secrets: readonly { env: string; value: string }[]): (b: Buffer) => Buffer {
  const pairs: [Buffer, Buffer][] = [];
  for (const s of secrets) if (s.value) pairs.push([Buffer.from(s.value), Buffer.from(`prrla-cred:${s.env}`)]);
  for (const a of secrets) for (const b of secrets) if (a.value && b.value) pairs.push([Buffer.from(Buffer.from(`${a.value}:${b.value}`).toString("base64")), Buffer.from(`prrla-basic:${a.env}:${b.env}`)]);
  pairs.sort((x, y) => y[0].length - x[0].length);
  return (buf) => {
    let out = buf;
    for (const [secret, placeholder] of pairs) {
      let i = out.indexOf(secret);
      if (i < 0) continue;
      const parts: Buffer[] = [];
      let from = 0;
      while (i >= 0) {
        parts.push(out.subarray(from, i), placeholder);
        from = i + secret.length;
        i = out.indexOf(secret, from);
      }
      parts.push(out.subarray(from));
      out = Buffer.concat(parts);
    }
    return out;
  };
}

function tooLarge(label: string, what: string, bytes: number, max: number): PluginError {
  return new PluginError(`plugin ${label}: ${what} is ${bytes} bytes, over the ${Math.round(max / 1024 / 1024)} MiB message limit; refused`, "MESSAGE_TOO_LARGE");
}

/**
 * Starts the child, waits for `ready`, and validates the definition it reports with the SDK's
 * own checks. Nothing is created yet: call `describe` and `create` next.
 */
export async function startPluginHost(o: HostOptions): Promise<PluginHost> {
  const execPath = o.execPath ?? process.execPath;
  const major = nodeMajor(execPath);
  const timeoutMs = o.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const maxBytes = o.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const setTimer = o.setTimer ?? realTimer;
  const scrub = scrubber(o.secrets ?? []);
  const reads = [...new Set([CHILD_SCRIPT, ...Object.values(SDK_MODULES), ...o.readPaths])];
  const flags = ["--permission", ...reads.map((p) => `--allow-fs-read=${p}`)];
  if (CHILD_SCRIPT.endsWith(".ts")) flags.push("--disable-warning=ExperimentalWarning");
  const boot: ChildBoot = {
    protocol: IPC_PROTOCOL,
    kind: o.kind,
    entry: pathToFileURL(o.entry).href,
    sdk: Object.fromEntries(Object.entries(SDK_MODULES).map(([k, v]) => [k, pathToFileURL(v).href])),
    heartbeatMs: o.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
  };
  const child: ChildProcess = spawn(execPath, [...flags, CHILD_SCRIPT, JSON.stringify(boot)], { env: { ...o.env }, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json" });

  let tail = "";
  const keep = (d: Buffer) => {
    tail = (tail + d.toString("utf8")).slice(-4096);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const stderrTail = () => {
    const lines = tail.trimEnd().split("\n").slice(-12);
    return lines.length && lines[0] ? lines.join("\n") : "";
  };
  const withTail = (msg: string) => {
    const t = stderrTail();
    return t ? `${msg}\n  plugin output (last lines):\n${t.split("\n").map((l) => `    ${l}`).join("\n")}` : msg;
  };

  let io: HostIo | null = null;
  let nextId = 1;
  let dead: PluginError | null = null;
  let closed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string }>();
  const fetches = new Map<number, AbortController>();
  let readyResolve!: (m: ReadyMessage) => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<ReadyMessage>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });
  let loading = true;

  const handles = [child, child.channel, child.stdout, child.stderr] as unknown as (Refable | null | undefined)[];
  const setRef = (on: boolean) => handles.forEach((h) => (on ? h?.ref?.() : h?.unref?.()));

  let disarm: (() => void) | null = null;
  const arm = () => {
    disarm?.();
    disarm = null;
    if (dead || closed || (!loading && pending.size === 0)) return;
    disarm = setTimer(() => {
      die(new PluginError(withTail(`plugin ${o.label} sent no heartbeat for ${Math.round(timeoutMs / 1000)} s and was stopped`), "PLUGIN_HOST_TIMEOUT", "check the plugin for a hang or a busy loop; run the command again"));
      child.kill("SIGKILL");
    }, timeoutMs);
  };
  const busy = () => {
    setRef(loading || pending.size > 0 || fetches.size > 0);
    arm();
  };

  function die(e: PluginError): void {
    if (dead) return;
    dead = e;
    disarm?.();
    disarm = null;
    for (const f of fetches.values()) f.abort();
    fetches.clear();
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    readyReject(e);
    live.delete(host);
  }

  function post(m: ParentMessage): void {
    if (dead || closed || !child.connected) return;
    const bytes = Buffer.byteLength(JSON.stringify(m));
    if (bytes > maxBytes) throw tooLarge(o.label, `a ${m.type} message`, bytes, maxBytes);
    child.send(m);
  }

  async function serveFetch(m: FetchMessage): Promise<void> {
    const ctrl = new AbortController();
    fetches.set(m.fid, ctrl);
    busy();
    try {
      if (!io) throw new Error("the plugin fetched before it was created");
      const init: RequestInit & Record<string, unknown> = { method: m.method, headers: m.headers, signal: ctrl.signal };
      if (m.body !== undefined) init.body = m.bodyEncoding === "base64" ? Buffer.from(m.body, "base64") : m.body;
      if (m.broker?.destination) {
        init.destination = m.broker.destination;
        if (m.broker.idempotent !== undefined) init.idempotent = m.broker.idempotent;
        const r = m.broker.retry;
        // An isolated plugin cannot raise the attempt limit past the broker's own (contracts.md §2: at most 7 attempts).
        const cap = (n: number) => Math.max(0, Math.min(DEFAULT_MAX_RETRIES, Math.floor(n)));
        if (r === false) init.retry = false;
        else if (r) init.retry = { ...(r.maxRetries !== undefined ? { maxRetries: cap(r.maxRetries) } : {}), ...(r.maxBlindRateLimitRetries !== undefined ? { maxBlindRateLimitRetries: cap(r.maxBlindRateLimitRetries) } : {}), ...(r.acceptJson ? { acceptJson: () => null } : {}) };
      }
      const res = await io.fetch(m.url, init);
      const body = scrub(Buffer.from(await res.arrayBuffer())).toString("base64");
      const headers = [...res.headers].map(([k, v]) => [k, scrub(Buffer.from(v)).toString("utf8")] as [string, string]);
      try {
        post({ type: "fetchResult", fid: m.fid, status: res.status, statusText: res.statusText, headers, body, url: res.url });
      } catch (e) {
        post({ type: "fetchResult", fid: m.fid, error: { name: "PluginError", code: (e as PluginError).code, message: (e as Error).message } });
      }
    } catch (e) {
      const err = e as { name?: unknown; code?: unknown; message?: unknown; host?: unknown; next?: unknown };
      post({
        type: "fetchResult",
        fid: m.fid,
        error: {
          name: typeof err?.name === "string" ? err.name : "Error",
          message: scrub(Buffer.from(typeof err?.message === "string" ? err.message : String(e))).toString("utf8"),
          ...(typeof err?.code === "string" ? { code: err.code } : {}),
          ...(typeof err?.host === "string" ? { host: err.host } : {}),
          ...(typeof err?.next === "string" ? { next: err.next } : {}),
        },
      });
    } finally {
      fetches.delete(m.fid);
      busy();
    }
  }

  child.on("message", (raw: unknown) => {
    const m = raw as ChildMessage;
    if (dead || closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(raw));
    if (bytes > maxBytes) {
      die(tooLarge(o.label, `a ${String(m?.type)} message from it`, bytes, maxBytes));
      child.kill("SIGKILL");
      return;
    }
    arm();
    switch (m?.type) {
      case "ready":
        loading = false;
        readyResolve(m);
        busy();
        return;
      case "result": {
        const p = pending.get(m.id);
        pending.delete(m.id);
        p?.resolve(m.value);
        busy();
        return;
      }
      case "error": {
        if (m.id === null) {
          die(new PluginError(withTail(`plugin ${o.label} failed to load: ${m.message}`), "PLUGIN_HOST_FAILED", m.code === "NODE_TOO_OLD" ? "run pr-rla on Node 22.15 or later" : "check the plugin's path and its dependencies (npm ci --ignore-scripts)"));
          return;
        }
        const p = pending.get(m.id);
        pending.delete(m.id);
        p?.reject(Object.assign(new Error(m.message), { name: m.name ?? "Error", code: m.code }));
        busy();
        return;
      }
      case "fetch":
        void serveFetch(m);
        return;
      case "sleep":
        void (io?.sleep ?? realSleep)(Math.max(0, Number(m.ms) || 0)).then(() => post({ type: "slept", sid: m.sid }));
        return;
      case "log":
        io?.log(String(m.line));
        return;
      case "heartbeat":
        return;
      default:
        die(new PluginError(`plugin ${o.label} sent an unknown message (${JSON.stringify((m as { type?: unknown } | null)?.type)})`, "PLUGIN_HOST_FAILED"));
        child.kill("SIGKILL");
    }
  });
  child.on("exit", (code, signal) => {
    if (!closed) die(new PluginError(withTail(`plugin ${o.label} exited (${signal ? `signal ${signal}` : `code ${code}`})`), "PLUGIN_HOST_FAILED", "check the plugin's output above"));
    live.delete(host);
  });
  child.on("error", (e) => die(new PluginError(`plugin ${o.label}: cannot start the host process: ${e.message}`, "PLUGIN_HOST_FAILED")));

  const host: PluginHost = {
    get ready() {
      return readyMessage;
    },
    label: o.label,
    pid: child.pid,
    nodeMajor: major,
    networkDenied: major >= NETWORK_DENIED_FROM_NODE,
    attach(x) {
      io = x;
    },
    call(method, args, signal) {
      if (dead) return Promise.reject(dead);
      if (closed) return Promise.reject(new PluginError(`plugin ${o.label}: its host was closed`, "PLUGIN_HOST_FAILED"));
      if (signal?.aborted) return Promise.reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        try {
          post({ type: "call", id, method, args });
        } catch (e) {
          pending.delete(id);
          return reject(e);
        }
        signal?.addEventListener("abort", () => {
          if (!pending.delete(id)) return;
          post({ type: "cancel", id });
          for (const f of fetches.values()) f.abort();
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
          busy();
        }, { once: true });
        busy();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      disarm?.();
      live.delete(host);
      for (const f of fetches.values()) f.abort();
      const e = new PluginError(`plugin ${o.label}: its host was closed`, "PLUGIN_HOST_FAILED");
      for (const p of pending.values()) p.reject(e);
      pending.clear();
      child.kill();
    },
    stderrTail,
  };
  live.add(host);
  busy();
  const readyMessage = await ready;
  validateReady(readyMessage, o);
  return host;
}

function validateReady(m: ReadyMessage, o: HostOptions): void {
  if (m.protocol !== IPC_PROTOCOL) throw new PluginError(`plugin ${o.label}: its host speaks ${String(m.protocol)}, not ${IPC_PROTOCOL}`, "PLUGIN_INVALID");
  if (m.kind !== o.kind) throw new PluginError(`plugin ${o.label}: loaded as a ${String(m.kind)}, expected a ${o.kind}`, "PLUGIN_INVALID");
  const fn = (t: string) => (t === "function" ? () => [] : t === "undefined" ? undefined : t);
  const stub: Record<string, unknown> = { name: m.name, create: m.shape.create === "function" ? () => ({}) : undefined, hosts: fn(m.shape.hosts), writePaths: fn(m.shape.writePaths), credentials: m.credentials };
  try {
    if (o.kind === "provider") assertProviderDefinition({ ...stub, providerApiVersion: m.apiVersion }, `provider "${o.label}"`);
    else assertLedgerDefinition({ ...stub, ledgerApiVersion: m.apiVersion }, `ledger "${o.label}"`);
  } catch (e) {
    throw e instanceof ProviderApiVersionError || e instanceof LedgerApiVersionError ? e : new PluginError((e as Error).message, "PLUGIN_INVALID");
  }
}

/** The definition's request for these options, evaluated in the child. */
export async function describePlugin(host: PluginHost, options: unknown): Promise<{ hosts: string[]; writePaths: string[] }> {
  const d = (await host.call("describe", [options])) as DescribeResult;
  const list = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0)) throw new PluginError(`plugin ${host.label}: ${what}(options) must return a list of host names`, "PLUGIN_INVALID");
    return [...new Set(v as string[])].sort();
  };
  return { hosts: list(d.hosts, "hosts"), writePaths: list(d.writePaths, "writePaths") };
}

/** The credentials the definition declares (validated in validateReady). */
export function declaredCredentials(host: PluginHost): PluginCredential[] {
  const c = host.ready.credentials;
  return Array.isArray(c) ? (c as PluginCredential[]).map((x) => ({ env: x.env, hosts: [...new Set(x.hosts)].sort() })) : [];
}

async function createInstance(host: PluginHost, options: unknown, base: { cwd: string; windowDir?: string }): Promise<CreateResult> {
  const c = (await host.call("create", [options, base])) as CreateResult;
  if (!c || typeof c.name !== "string" || !Array.isArray(c.methods)) throw new PluginError(`plugin ${host.label}: create() returned no instance`, "PLUGIN_INVALID");
  return c;
}

const withoutSignal = (req: ListChangesRequest): Omit<ListChangesRequest, "signal"> => {
  const { signal: _s, ...rest } = req;
  return rest;
};

/** A ScmProvider whose methods run in the host. The context's fetch, sleep and log serve the child. */
export async function hostedProvider(host: PluginHost, options: unknown, ctx: { cwd: string; fetch: typeof fetch; sleep?: (ms: number) => Promise<void>; log: (line: string) => void }): Promise<ScmProvider> {
  host.attach({ fetch: ctx.fetch, sleep: ctx.sleep ?? realSleep, log: ctx.log });
  const c = await createInstance(host, options, { cwd: ctx.cwd });
  if (!SUPPORTED_PROVIDER_API_VERSIONS.includes(c.apiVersion as number)) throw new ProviderApiVersionError(String(host.ready.name), c.apiVersion);
  const has = new Set(c.methods);
  if (!has.has("listChanges")) throw new PluginError(`provider "${host.label}" returned an object without listChanges()`, "PLUGIN_INVALID");
  const p: ScmProvider = {
    apiVersion: c.apiVersion as number,
    name: c.name as string,
    listChanges: (req) => host.call("listChanges", [withoutSignal(req)], req.signal) as never,
  };
  if (has.has("nativeCounts")) p.nativeCounts = (req, selector) => host.call("nativeCounts", [withoutSignal(req), selector], req.signal) as never;
  for (const m of ["listRepos", "describeChange"] as const) if (has.has(m)) (p as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => host.call(m, args);
  return p;
}

/** A Ledger whose methods run in the host. */
export async function hostedLedger(host: PluginHost, options: unknown, ctx: { cwd: string; windowDir: string; fetch: typeof fetch; log: (line: string) => void; sleep?: (ms: number) => Promise<void> }): Promise<Ledger> {
  host.attach({ fetch: ctx.fetch, sleep: ctx.sleep ?? realSleep, log: ctx.log });
  const c = await createInstance(host, options, { cwd: ctx.cwd, windowDir: ctx.windowDir });
  if (!SUPPORTED_LEDGER_API_VERSIONS.includes(c.apiVersion as number)) throw new LedgerApiVersionError(String(host.ready.name), c.apiVersion);
  const has = new Set(c.methods);
  for (const m of ["readVerdicts", "appendVerdict"]) if (!has.has(m)) throw new PluginError(`ledger "${host.label}" has no ${m}()`, "PLUGIN_INVALID");
  const l = { apiVersion: c.apiVersion as number, name: c.name as string } as Record<string, unknown>;
  for (const m of ["readVerdicts", "appendVerdict", "publishDraws", "verifyIntegrity", "readHistory"] as const) if (has.has(m)) l[m] = (...args: unknown[]) => host.call(m, args);
  return l as unknown as Ledger;
}

/** What isolation this host gives, for the line every command prints (NFR4). */
export function isolationLine(host: PluginHost, name: string, version: string | null): string {
  const who = `${name}${version ? `@${version}` : ""}`;
  return host.networkDenied
    ? `plugin ${who} runs isolated: placeholder credentials, read-only access to its own files, no network (Node ${host.nodeMajor})`
    : `plugin ${who} runs isolated: placeholder credentials, read-only access to its own files; Node ${host.nodeMajor} cannot block its network access, so it could still send out what it reads (Node ${NETWORK_DENIED_FROM_NODE} or later blocks it)`;
}
