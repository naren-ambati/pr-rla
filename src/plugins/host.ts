import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_MAX_RETRIES, MAX_WAIT_MS } from "../sdk/http.js";
import { assertLedgerDefinition, LedgerApiVersionError, PROVENANCE_LEVELS, SUPPORTED_LEDGER_API_VERSIONS, type Ledger, type LedgerIndexStore, type ProvenanceLevel } from "../sdk/ledger.js";
import {
  assertProviderDefinition,
  DEFAULT_REVIEW_GRANULARITY,
  isPluginName,
  ProviderApiVersionError,
  providerTraitProblems,
  SUPPORTED_PROVIDER_API_VERSIONS,
  type ListChangesRequest,
  type PluginCredential,
  type ReviewGranularity,
  type ScmProvider,
} from "../sdk/provider.js";
import { bounded } from "../core/text.js";
import { scrubBytes, scrubPairs, scrubText, type SecretValue } from "../net/scrub.js";
import { PluginError } from "./errors.js";
import type { LockedCredential } from "./lock.js";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  IPC_FD,
  IPC_PROTOCOL,
  MAX_MESSAGE_BYTES,
  type ChildBoot,
  type ChildMessage,
  type CreateResult,
  type DescribeResult,
  type FetchMessage,
  type ParentMessage,
  type AcceptResultMessage,
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
  "pr-rla/http": resolveSibling("../sdk/http"),
};

/** A wait that ends early, and clears its timer, when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
const realSleep = abortableSleep;
/** The longest wait a plugin's ctx.sleep is served for (the SDK's own cap on a single wait). */
export const MAX_PLUGIN_SLEEP_MS = MAX_WAIT_MS;
/**
 * Fetches one child may have in flight. Each holds its request (up to a frame, 64 MiB) in the parent
 * until it is answered, so this bounds what a child can make the parent hold; real plugins stay far below.
 */
export const MAX_PLUGIN_FETCHES = 64;
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
  /** Secrets the broker may swap in; stripped from every response before the child sees it (identities, `secret: false`, are left alone). */
  secrets?: readonly SecretValue[];
  execPath?: string;
  /** Silence that stops the child while a call is in flight, counted from `ready` (default HEARTBEAT_TIMEOUT_MS). */
  heartbeatTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** How long the child may take to start and report `ready` (default HEARTBEAT_TIMEOUT_MS). */
  loadTimeoutMs?: number;
  maxMessageBytes?: number;
  /** Arms the heartbeat watchdog (tests use a recording one). */
  setTimer?: (fire: () => void, ms: number) => () => void;
}

/** Where the child's fetches, waits and log lines go: the plugin context's own. */
export interface HostIo {
  fetch: typeof fetch;
  /** Waits on the command's clock; `signal` aborts when the wait is no longer served (the host closed, or no call is in flight). */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  log: (line: string) => void;
  /** A ledger's local index (LedgerContext.index), kept by the parent. */
  index?: LedgerIndexStore;
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
  /** Heartbeats received, and the most bytes the frame reader ever held at once (diagnostics; tests read them). */
  stats(): { heartbeats: number; maxBufferedBytes: number };
}

const live = new Set<PluginHost>();
/** The hosts started inside a scope (withPluginHostScope), by async context. */
const scoped = new AsyncLocalStorage<Set<PluginHost>>();

/** How many plugin hosts are running in this process. */
export const livePluginHosts = (): number => live.size;

/** Stops every plugin host this process started (the CLI calls it when a command ends). */
export function closeAllPluginHosts(): void {
  for (const h of [...live]) h.close();
}

/**
 * Runs `fn` and then stops the plugin hosts started inside it, and only those: a long-running
 * process (the MCP server, through pr-rla/api/read) keeps no child per call, and calls running at
 * the same time do not stop each other's hosts.
 */
export async function withPluginHostScope<T>(fn: () => Promise<T>): Promise<T> {
  const started = new Set<PluginHost>();
  try {
    return await scoped.run(started, fn);
  } finally {
    for (const h of started) h.close();
  }
}

type Refable = { ref?: () => void; unref?: () => void };

/** Replaces each secret, in every form a server may echo it in, with its placeholder (src/net/scrub.ts). */
function scrubber(secrets: readonly SecretValue[]): { bytes: (b: Buffer) => Buffer; text: (s: string) => string } {
  const pairs = scrubPairs(secrets);
  return { bytes: (b) => scrubBytes(pairs, b), text: (t) => scrubText(pairs, t) };
}

function tooLarge(label: string, what: string, bytes: number, max: number): PluginError {
  const limit = max >= 1024 * 1024 ? `${Math.round(max / 1024 / 1024)} MiB` : `${max}-byte`;
  return new PluginError(`plugin ${label}: ${what} is ${bytes} bytes, over the ${limit} message limit; refused`, "MESSAGE_TOO_LARGE");
}

/** One frame: a 4-byte big-endian length, then the JSON (pr-rla/ipc/v2). */
function frame(m: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(m));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/**
 * Reads frames as they arrive, holding at most one frame's bytes: a length over `max` is refused
 * from the 4-byte header, before any of its payload is buffered (finding 11).
 */
export function frameReader(max: number, onFrame: (json: Buffer) => void, onTooLarge: (bytes: number) => void): { push(chunk: Buffer): void; maxBuffered(): number } {
  let chunks: Buffer[] = [];
  let have = 0;
  let need: number | null = null;
  let high = 0;
  let stopped = false;
  const take = (n: number): Buffer => {
    const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
    chunks = all.length > n ? [all.subarray(n)] : [];
    have -= n;
    return all.subarray(0, n);
  };
  return {
    push(chunk) {
      if (stopped) return;
      chunks.push(chunk);
      have += chunk.length;
      high = Math.max(high, have);
      for (;;) {
        if (need === null) {
          if (have < 4) return;
          const n = take(4).readUInt32BE(0);
          if (n > max) {
            stopped = true;
            chunks = [];
            have = 0;
            return onTooLarge(n);
          }
          need = n;
        }
        if (have < need) return;
        const body = take(need);
        need = null;
        onFrame(body);
        if (stopped) return;
      }
    },
    maxBuffered: () => high,
  };
}

/**
 * Starts the child, waits for `ready`, and validates the definition it reports with the SDK's
 * own checks. Nothing is created yet: call `describe` and `create` next.
 */
export async function startPluginHost(o: HostOptions): Promise<PluginHost> {
  const execPath = o.execPath ?? process.execPath;
  const major = nodeMajor(execPath);
  const timeoutMs = o.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const loadMs = o.loadTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
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
    maxMessageBytes: maxBytes,
  };
  // fd 3 is a pipe carrying length-prefixed frames (pr-rla/ipc/v2), not Node's IPC channel.
  const child: ChildProcess = spawn(execPath, [...flags, CHILD_SCRIPT, JSON.stringify(boot)], { env: { ...o.env }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const pipe = child.stdio[IPC_FD] as Socket;

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

  const handles = [child, pipe, child.stdout, child.stderr] as unknown as (Refable | null | undefined)[];
  const setRef = (on: boolean) => handles.forEach((h) => (on ? h?.ref?.() : h?.unref?.()));

  let disarm: (() => void) | null = null;
  let armed = 0;
  const arm = () => {
    disarm?.();
    disarm = null;
    if (dead || closed || (!loading && pending.size === 0)) return;
    // Until `ready` the child is starting (a process, then the plugin's imports): that has its own limit.
    // The heartbeat timeout counts from `ready`, while a call is in flight.
    const starting = loading;
    const mine = ++armed;
    disarm = setTimer(() => {
      // When this process was not running for a while (a busy machine), the timer and the child's
      // heartbeat are both ready: timers run before I/O is read, so decide only after the poll phase
      // has read what arrived (setImmediate runs after it). A message re-arms, and this one stands down.
      setImmediate(() => {
        if (mine !== armed || dead || closed) return;
        const secs = (ms: number) => (ms < 10_000 ? String(ms / 1000) : String(Math.round(ms / 1000)));
        const why = starting ? `did not finish loading within ${secs(loadMs)} s` : `sent no heartbeat for ${secs(timeoutMs)} s`;
        die(new PluginError(withTail(`plugin ${o.label} ${why} and was stopped`), "PLUGIN_HOST_TIMEOUT", "check the plugin for a hang or a busy loop; run the command again"));
        child.kill("SIGKILL");
      });
    }, starting ? loadMs : timeoutMs);
  };
  /** The plugin's waits being served; each ends early when its controller aborts. */
  const sleeps = new Set<AbortController>();
  /** The broker's questions to the plugin's acceptJson rule, by aid. */
  const accepts = new Map<number, { resolve: (problem: string | null) => void; reject: (e: unknown) => void }>();
  let nextAid = 1;
  let heartbeats = 0;
  const stopSleeps = () => {
    for (const c of sleeps) c.abort();
    sleeps.clear();
  };
  const busy = () => {
    setRef(loading || pending.size > 0 || fetches.size > 0);
    // A wait is served only while a call is in flight (finding 13).
    if (!loading && pending.size === 0) stopSleeps();
    arm();
  };

  function die(e: PluginError): void {
    if (dead) return;
    dead = e;
    disarm?.();
    disarm = null;
    stopSleeps();
    for (const a of accepts.values()) a.reject(e);
    accepts.clear();
    for (const f of fetches.values()) f.abort();
    fetches.clear();
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    readyReject(e);
    live.delete(host);
  }

  function post(m: ParentMessage): void {
    if (dead || closed || pipe.destroyed) return;
    const f = frame(m);
    if (f.length - 4 > maxBytes) throw tooLarge(o.label, `a ${m.type} message`, f.length - 4, maxBytes);
    pipe.write(f);
  }

  /**
   * Answers something the child is waiting for, from a handler: it never throws there (S1: a throw inside an
   * unawaited handler is an unhandled rejection, which ends the process). An answer that cannot be framed (larger
   * than the message limit, or not serializable) is replaced by `instead`, a small fixed error for the same request,
   * so the child's call fails rather than waiting forever. If even that cannot be sent, the host stops: every
   * pending call fails with the reason, none silently.
   */
  function reply(m: ParentMessage, instead: (problem: string) => ParentMessage): void {
    try {
      post(m);
      return;
    } catch (e) {
      try {
        post(instead(bounded((e as Error)?.message ?? String(e))));
        return;
      } catch (e2) {
        die(new PluginError(`plugin ${o.label}: an answer to it could not be sent (${bounded((e2 as Error)?.message ?? String(e2))}), so its host was stopped`, "PLUGIN_HOST_FAILED"));
        child.kill("SIGKILL");
      }
    }
  }

  /** The error frame fields of a thrown value, each bounded (S1): a server or the child chose them. */
  const errorFields = (e: unknown): { name: string; message: string; code?: string } => {
    const err = e as { name?: unknown; code?: unknown; message?: unknown };
    return { name: bounded(typeof err?.name === "string" ? err.name : "Error"), message: bounded(scrub.text(typeof err?.message === "string" ? err.message : String(e))), ...(typeof err?.code === "string" ? { code: bounded(err.code) } : {}) };
  };

  /** Asks the plugin's own acceptJson rule about a body (finding 10); what the child sees is scrubbed, as every response is. */
  function askAccept(fid: number, body: unknown): Promise<string | null> {
    const aid = nextAid++;
    return new Promise<string | null>((resolve, reject) => {
      accepts.set(aid, { resolve, reject });
      try {
        post({ type: "accept", aid, fid, body: scrub.text(JSON.stringify(body ?? null)) });
      } catch {
        // Too large to ask about: too large to deliver too, so the fetch fails at its result instead.
        accepts.delete(aid);
        resolve(null);
      }
    });
  }

  async function serveFetch(m: FetchMessage): Promise<void> {
    // Like a sleep, a fetch is served only while a call is in flight, and only so many at once.
    const refusal = loading || pending.size === 0 ? "the plugin fetched outside a call; nothing was sent" : fetches.size >= MAX_PLUGIN_FETCHES ? `the plugin has ${MAX_PLUGIN_FETCHES} fetches in flight already; nothing was sent` : null;
    const failed = (problem: string): ParentMessage => ({ type: "fetchResult", fid: m.fid, error: { name: "PluginError", code: "MESSAGE_TOO_LARGE", message: `the answer to this fetch could not be sent (${problem}); nothing more of it is` } });
    if (refusal) {
      reply({ type: "fetchResult", fid: m.fid, error: { name: "PluginError", code: "PLUGIN_FETCH_REFUSED", message: refusal } }, failed);
      return;
    }
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
        // A hint is a number the child wrote into a JSON frame: anything but a finite number (NaN, {}, a string) is
        // left out, so the broker's default applies (S1: Math.floor({}) is NaN, and a NaN cap never stops retrying).
        const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
        // An isolated plugin cannot raise the attempt limit past the broker's own (contracts.md §2: at most 7 attempts).
        const cap = (n: unknown) => (finite(n) ? { ok: Math.max(0, Math.min(DEFAULT_MAX_RETRIES, Math.floor(n))) } : null);
        // P3's wait for a rate limit that names none: a plugin may lengthen it, never below the broker's own first
        // backoff (1 s before jitter, so never faster than without the hint), never past MAX_WAIT_MS. Its
        // `rateLimitBody` pattern is not carried: it would run in this process, where a pathological pattern stalls
        // the broker for every caller (BUILD-NOTES, "Integration: wave 2", merge 8).
        const blindWait = (n: unknown) => (finite(n) ? { ok: Math.min(MAX_WAIT_MS, Math.max(1000, Math.floor(n))) } : null);
        const retries = r ? cap(r.maxRetries) : null;
        const blindRetries = r ? cap(r.maxBlindRateLimitRetries) : null;
        const wait = r ? blindWait(r.blindRateLimitWaitMs) : null;
        if (r === false) init.retry = false;
        // The plugin's acceptJson rule runs in the child: the broker awaits its answer, as it would in process (finding 10).
        else if (r) init.retry = { ...(retries ? { maxRetries: retries.ok } : {}), ...(blindRetries ? { maxBlindRateLimitRetries: blindRetries.ok } : {}), ...(wait ? { blindRateLimitWaitMs: wait.ok } : {}), ...(r.acceptJson ? { acceptJson: (body: unknown) => askAccept(m.fid, body) } : {}) };
      }
      const res = await io.fetch(m.url, init);
      // Everything the child sees of the response is scrubbed: its body, headers, status text and final URL.
      const body = scrub.bytes(Buffer.from(await res.arrayBuffer())).toString("base64");
      const headers = [...res.headers].map(([k, v]) => [k, scrub.text(v)] as [string, string]);
      reply({ type: "fetchResult", fid: m.fid, status: res.status, statusText: scrub.text(res.statusText), headers, body, url: scrub.text(res.url) }, failed);
    } catch (e) {
      const err = e as { host?: unknown; next?: unknown };
      reply(
        {
          type: "fetchResult",
          fid: m.fid,
          error: {
            ...errorFields(e),
            ...(typeof err?.host === "string" ? { host: bounded(scrub.text(err.host)) } : {}),
            ...(typeof err?.next === "string" ? { next: bounded(scrub.text(err.next)) } : {}),
          },
        },
        failed,
      );
    } finally {
      fetches.delete(m.fid);
      busy();
    }
  }

  const reader = frameReader(
    maxBytes,
    (json) => {
      let m: unknown;
      try {
        m = JSON.parse(json.toString("utf8"));
      } catch {
        die(new PluginError(`plugin ${o.label} sent a message that is not JSON`, "PLUGIN_HOST_FAILED"));
        child.kill("SIGKILL");
        return;
      }
      receive(m as ChildMessage);
    },
    (bytes) => {
      if (dead || closed) return;
      die(tooLarge(o.label, "a message from it", bytes, maxBytes));
      child.kill("SIGKILL");
      pipe.destroy();
    },
  );
  pipe.on("data", (chunk: Buffer) => reader.push(chunk));
  pipe.on("error", () => {});

  /** The request ids the child sends are echoed in the answers: anything but a whole number is a protocol violation (S1). */
  const ID_OF: Partial<Record<string, "fid" | "sid" | "xid" | "aid" | "id">> = { fetch: "fid", sleep: "sid", index: "xid", acceptResult: "aid", result: "id", error: "id" };

  function receive(m: ChildMessage): void {
    if (dead || closed) return;
    arm();
    const idKey = ID_OF[(m as { type?: unknown } | null)?.type as string];
    const idValue = idKey ? (m as unknown as Record<string, unknown>)[idKey] : undefined;
    if (idKey && !(Number.isSafeInteger(idValue) || (idKey === "id" && m.type === "error" && idValue === null))) {
      die(new PluginError(`plugin ${o.label} sent a ${m.type} message whose ${idKey} is not a whole number`, "PLUGIN_HOST_FAILED"));
      child.kill("SIGKILL");
      return;
    }
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
        p?.reject(Object.assign(new Error(m.message), { name: m.name ?? "Error", code: m.code, ...(typeof m.status === "number" ? { status: m.status } : {}), ...(m.rateLimited === true ? { rateLimited: true } : {}) }));
        busy();
        return;
      }
      case "fetch":
        void serveFetch(m);
        return;
      case "sleep": {
        // Only while a call is in flight, for at most MAX_PLUGIN_SLEEP_MS, and cancelled when the calls end or the host closes (finding 13).
        if (loading || pending.size === 0) return;
        const ctrl = new AbortController();
        sleeps.add(ctrl);
        // pr-rla's own waits reject when aborted (src/net/abort.ts, U5) and the host's resolve: either way a cancelled wait answers nothing.
        void (io?.sleep ?? realSleep)(Math.min(MAX_PLUGIN_SLEEP_MS, Math.max(0, Number(m.ms) || 0)), ctrl.signal).then(
          () => {
            sleeps.delete(ctrl);
            if (!ctrl.signal.aborted) reply({ type: "slept", sid: m.sid }, () => ({ type: "slept", sid: m.sid }));
          },
          () => sleeps.delete(ctrl),
        );
        return;
      }
      case "acceptResult": {
        const a = accepts.get((m as AcceptResultMessage).aid);
        accepts.delete((m as AcceptResultMessage).aid);
        if (!a) return;
        const r = m as AcceptResultMessage;
        if (typeof r.error === "string") a.reject(new Error(r.error));
        else a.resolve(typeof r.problem === "string" ? r.problem : null);
        return;
      }
      case "log":
        io?.log(bounded(String(m.line)));
        return;
      case "index": {
        const store = io?.index;
        // The index is read and written whole (S1: one larger than a frame used to throw inside this handler, and the
        // child waited for an answer that never came). An answer that cannot be framed fails the child's index call.
        const failed = (problem: string): ParentMessage => ({ type: "indexResult", xid: m.xid, error: { name: "PluginError", code: "MESSAGE_TOO_LARGE", message: `the ledger index could not be sent to the plugin (${problem})` } });
        const op = !store ? Promise.reject(new Error("this plugin has no local index (LedgerContext.index is for ledgers)")) : m.op === "write" ? Promise.resolve().then(() => store.write(m.value)).then(() => null) : Promise.resolve().then(() => store.read());
        void op.then(
          (value) => reply({ type: "indexResult", xid: m.xid, value: value ?? null }, failed),
          (e: unknown) => reply({ type: "indexResult", xid: m.xid, error: errorFields(e) }, failed),
        );
        return;
      }
      case "heartbeat":
        heartbeats++;
        return;
      default:
        die(new PluginError(`plugin ${o.label} sent an unknown message (${JSON.stringify((m as { type?: unknown } | null)?.type)})`, "PLUGIN_HOST_FAILED"));
        child.kill("SIGKILL");
    }
  }
  // "close", not "exit": it comes after the child's pipes are drained, so a last error frame (a load failure) is read first.
  child.on("close", (code, signal) => {
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
          reply({ type: "cancel", id }, () => ({ type: "cancel", id }));
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
      stopSleeps();
      for (const f of fetches.values()) f.abort();
      const e = new PluginError(`plugin ${o.label}: its host was closed`, "PLUGIN_HOST_FAILED");
      for (const a of accepts.values()) a.reject(e);
      accepts.clear();
      for (const p of pending.values()) p.reject(e);
      pending.clear();
      child.kill();
      pipe.destroy();
    },
    stderrTail,
    stats: () => ({ heartbeats, maxBufferedBytes: reader.maxBuffered() }),
  };
  live.add(host);
  scoped.getStore()?.add(host);
  busy();
  const readyMessage = await ready;
  validateReady(readyMessage, o);
  return host;
}

function validateReady(m: ReadyMessage, o: HostOptions): void {
  if (m.protocol !== IPC_PROTOCOL) throw new PluginError(`plugin ${o.label}: its host speaks ${String(m.protocol)}, not ${IPC_PROTOCOL}`, "PLUGIN_INVALID");
  if (m.kind !== o.kind) throw new PluginError(`plugin ${o.label}: loaded as a ${String(m.kind)}, expected a ${o.kind}`, "PLUGIN_INVALID");
  const fn = (t: string) => (t === "function" ? () => [] : t === "undefined" ? undefined : t);
  const stub: Record<string, unknown> = { name: m.name, create: m.shape.create === "function" ? () => ({}) : undefined, hosts: fn(m.shape.hosts), writePaths: fn(m.shape.writePaths), credentials: m.credentials, reviewGranularity: m.reviewGranularity, populationOptions: m.populationOptions };
  try {
    if (o.kind === "provider") assertProviderDefinition({ ...stub, providerApiVersion: m.apiVersion }, `provider "${o.label}"`);
    else assertLedgerDefinition({ ...stub, ledgerApiVersion: m.apiVersion }, `ledger "${o.label}"`);
  } catch (e) {
    throw e instanceof ProviderApiVersionError || e instanceof LedgerApiVersionError ? e : new PluginError((e as Error).message, "PLUGIN_INVALID");
  }
}

/**
 * What a provider definition declares about the population it builds (U3), read in process for a
 * built-in or a `trust: full` plugin, and from `describe` for an isolated one.
 */
export interface DefinitionTraits {
  /** Absent in the definition means "submission". */
  reviewGranularity: ReviewGranularity;
  /** Whether the provider sets ChangeRecord.landedVia. */
  reportsLandedVia: boolean;
  /** Option keys whose values `populationOptionsSha256` hashes. */
  populationOptions: string[];
  /** P5: whether the provider reads label history (answers `labelsAt: "landing"`). */
  labelHistory: boolean;
}

/** The U3 traits of a definition (or of what a child reported), validated with the SDK's own check, defaults applied. */
export function definitionTraits(raw: { reviewGranularity?: unknown; populationOptions?: unknown; reportsLandedVia?: unknown; labelHistory?: unknown }, label: string): DefinitionTraits {
  const problem = providerTraitProblems(raw);
  if (problem) throw new PluginError(`plugin ${label}: ${problem}`, "PLUGIN_INVALID");
  return {
    reviewGranularity: (raw.reviewGranularity as ReviewGranularity | undefined) ?? DEFAULT_REVIEW_GRANULARITY,
    reportsLandedVia: raw.reportsLandedVia === true,
    populationOptions: [...((raw.populationOptions as string[] | undefined) ?? [])],
    labelHistory: raw.labelHistory === true,
  };
}

/** The definition's request for these options, its U3 traits and a ledger's provenance (U4), evaluated in the child. */
export async function describePlugin(host: PluginHost, options: unknown): Promise<{ hosts: string[]; writePaths: string[]; traits: DefinitionTraits; provenance: ProvenanceLevel | null }> {
  const d = (await host.call("describe", [options])) as DescribeResult;
  const list = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0)) throw new PluginError(`plugin ${host.label}: ${what}(options) must return a list of host names`, "PLUGIN_INVALID");
    return [...new Set(v as string[])].sort();
  };
  if (d.provenance !== undefined && !PROVENANCE_LEVELS.includes(d.provenance as ProvenanceLevel)) throw new PluginError(`plugin ${host.label}: provenance must be one of ${PROVENANCE_LEVELS.join(", ")}`, "PLUGIN_INVALID");
  return { hosts: list(d.hosts, "hosts"), writePaths: list(d.writePaths, "writePaths"), traits: definitionTraits(d, host.label), provenance: (d.provenance as ProvenanceLevel | undefined) ?? null };
}

/**
 * Where each declared credential may be sent with these options. A credential with
 * `hostFromOption` goes to the host of that option's URL when the options set it, and only to an
 * `https:` URL's host (any other value grants it no host, so a token is never sent in clear text);
 * without the option it keeps its declared `hosts`. pr-rla computes this from the audit's own
 * options, not from the plugin's code, and the lock records the result, with any extra header
 * names the definition declares for it (lowercase) and whether it is an identity (`secret: false`).
 */
export function credentialGrants(declared: readonly PluginCredential[], options: unknown): LockedCredential[] {
  const o = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
  return declared.map((c) => {
    const key = c.hostFromOption;
    const headers = { ...(c.headers?.length ? { headers: [...new Set(c.headers.map((h) => h.toLowerCase()))].sort() } : {}), ...(c.secret === false ? { secret: false as const } : {}) };
    if (key === undefined || o[key] === undefined || o[key] === null) return { env: c.env, hosts: [...new Set(c.hosts)].sort(), ...headers };
    let host: string | null = null;
    try {
      const u = typeof o[key] === "string" ? new URL(o[key] as string) : null;
      if (u?.protocol === "https:" && u.host) host = u.host;
    } catch {
      host = null;
    }
    return { env: c.env, hosts: host ? [host] : [], hostFromOption: key, ...headers };
  });
}

/** The credentials the definition declares (validated in validateReady), with their hosts for these options. */
export function declaredCredentials(host: PluginHost, options: unknown): LockedCredential[] {
  const c = host.ready.credentials;
  return Array.isArray(c) ? credentialGrants(c as PluginCredential[], options) : [];
}

async function createInstance(host: PluginHost, options: unknown, base: { cwd: string; windowDir?: string; reviewers?: readonly string[] | null }): Promise<CreateResult> {
  const c = (await host.call("create", [options, base])) as CreateResult;
  if (!c || typeof c.name !== "string" || !Array.isArray(c.methods)) throw new PluginError(`plugin ${host.label}: create() returned no instance`, "PLUGIN_INVALID");
  // The instance's name is printed in pr-rla's own lines ("provider <name> …"): it must be a plugin name, as the definition's is (S1).
  if (!isPluginName(c.name)) throw new PluginError(`plugin ${host.label}: create() returned an instance whose name is not a plugin name (lowercase letters, digits and hyphens)`, "PLUGIN_INVALID");
  return c;
}

const withoutSignal = (req: ListChangesRequest): Omit<ListChangesRequest, "signal"> => {
  const { signal: _s, ...rest } = req;
  return rest;
};

/** Both signals, when there are two (a request's and the call's). */
const either = (a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined => (a && b ? AbortSignal.any([a, b]) : (a ?? b));

/**
 * A ScmProvider whose methods run in the host. The context's fetch, sleep and log serve the child.
 * `ctx.signal` (the call's, U5) cancels every method call, as a request's own signal does.
 */
export async function hostedProvider(host: PluginHost, options: unknown, ctx: { cwd: string; fetch: typeof fetch; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; log: (line: string) => void; signal?: AbortSignal }): Promise<ScmProvider> {
  host.attach({ fetch: ctx.fetch, sleep: ctx.sleep ?? realSleep, log: ctx.log });
  const c = await createInstance(host, options, { cwd: ctx.cwd });
  if (!SUPPORTED_PROVIDER_API_VERSIONS.includes(c.apiVersion as number)) throw new ProviderApiVersionError(String(host.ready.name), c.apiVersion);
  const has = new Set(c.methods);
  if (!has.has("listChanges")) throw new PluginError(`provider "${host.label}" returned an object without listChanges()`, "PLUGIN_INVALID");
  const p: ScmProvider = {
    apiVersion: c.apiVersion as number,
    name: c.name as string,
    listChanges: (req) => host.call("listChanges", [withoutSignal(req)], either(req.signal, ctx.signal)) as never,
  };
  if (has.has("nativeCounts")) p.nativeCounts = (req, selector) => host.call("nativeCounts", [withoutSignal(req), selector], either(req.signal, ctx.signal)) as never;
  if (has.has("estimateRequests")) p.estimateRequests = (req) => host.call("estimateRequests", [withoutSignal(req)], either(req.signal, ctx.signal)) as never;
  if (has.has("firstParentPath")) p.firstParentPath = ({ signal, ...req }) => host.call("firstParentPath", [req], either(signal, ctx.signal)) as never;
  if (has.has("pushLog")) p.pushLog = ({ signal, ...req }) => host.call("pushLog", [req], either(signal, ctx.signal)) as never;
  // resolveAccounts(logins, { signal }) (P5): only the logins cross to the child; the signal stays here.
  if (has.has("resolveAccounts")) p.resolveAccounts = (logins, o) => host.call("resolveAccounts", [[...logins]], either(o?.signal, ctx.signal)) as never;
  for (const m of ["listRepos", "describeRepo", "listingVisibility"] as const) if (has.has(m)) (p as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => host.call(m, args, ctx.signal);
  // describeChange(change, { signal }): only the change crosses to the child; the signal stays here.
  if (has.has("describeChange")) p.describeChange = (change, o) => host.call("describeChange", [change], either(o?.signal, ctx.signal)) as never;
  return p;
}

/** A Ledger whose methods run in the host. */
export async function hostedLedger(host: PluginHost, options: unknown, ctx: { cwd: string; windowDir: string; fetch: typeof fetch; log: (line: string) => void; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; reviewers?: readonly string[] | null; index?: LedgerIndexStore; signal?: AbortSignal }): Promise<Ledger> {
  host.attach({ fetch: ctx.fetch, sleep: ctx.sleep ?? realSleep, log: ctx.log, ...(ctx.index ? { index: ctx.index } : {}) });
  const c = await createInstance(host, options, { cwd: ctx.cwd, windowDir: ctx.windowDir, ...(ctx.reviewers !== undefined ? { reviewers: ctx.reviewers } : {}) });
  if (!SUPPORTED_LEDGER_API_VERSIONS.includes(c.apiVersion as number)) throw new LedgerApiVersionError(String(host.ready.name), c.apiVersion);
  const has = new Set(c.methods);
  for (const m of ["readVerdicts", "appendVerdict"]) if (!has.has(m)) throw new PluginError(`ledger "${host.label}" has no ${m}()`, "PLUGIN_INVALID");
  const l = { apiVersion: c.apiVersion as number, name: c.name as string } as Record<string, unknown>;
  for (const m of ["readVerdicts", "appendVerdict", "publishDraws", "verifyIntegrity", "readHistory"] as const) if (has.has(m)) l[m] = (...args: unknown[]) => host.call(m, args, ctx.signal);
  return l as unknown as Ledger;
}

/** What isolation this host gives, for the line every command prints (NFR4). */
export function isolationLine(host: PluginHost, name: string, version: string | null): string {
  const who = `${name}${version ? `@${version}` : ""}`;
  return host.networkDenied
    ? `plugin ${who} runs isolated: placeholder credentials, read-only access to its own files, no network (Node ${host.nodeMajor})`
    : `plugin ${who} runs isolated: placeholder credentials, read-only access to its own files; Node ${host.nodeMajor} cannot block its network access, so it could still send out what it reads (Node ${NETWORK_DENIED_FROM_NODE} or later blocks it)`;
}
