/**
 * The plugin host's child process (functional-design.md §U2b; contracts.md §3).
 *
 * Started by ./host.ts as `node --permission --allow-fs-read=<plugin files> child.js <boot>`
 * with a scrubbed environment: `PR_RLA_HOST=1` plus one `prrla-cred:<ENV>` placeholder per
 * approved credential. No fs-write, child-process, worker, addon or WASI permission; on
 * Node 25 or later no network either. It imports the plugin, reports its definition, and
 * runs the methods the parent calls. Every fetch and every wait goes to the parent: fetches
 * through the fetch broker, waits on the command's clock.
 *
 * Messages travel as length-prefixed JSON frames on file descriptor 3 (`pr-rla/ipc/v2`).
 *
 * This file has no runtime import from pr-rla (only `node:` modules; the protocol import is
 * type-only), so it runs the same compiled from dist/ and type-stripped from src/.
 */
import * as nodeModule from "node:module";
import { Socket } from "node:net";
import type { CallMessage, ChildBoot, ChildMessage, CreateResult, DescribeResult, FetchMessage, FetchResultMessage, ParentMessage, ReadyMessage } from "./protocol.js";

type Fn = (...args: unknown[]) => unknown;
interface Definition {
  name?: unknown;
  providerApiVersion?: unknown;
  ledgerApiVersion?: unknown;
  reviewGranularity?: unknown;
  description?: unknown;
  credentials?: unknown;
  populationOptions?: unknown;
  reportsLandedVia?: unknown;
  labelHistory?: unknown;
  provenance?: unknown;
  hosts?: unknown;
  writePaths?: unknown;
  create?: unknown;
}

const METHODS: Record<ChildBoot["kind"], readonly string[]> = {
  provider: ["listChanges", "nativeCounts", "listRepos", "describeChange", "estimateRequests", "describeRepo", "listingVisibility", "firstParentPath", "pushLog", "resolveAccounts"],
  ledger: ["readVerdicts", "appendVerdict", "publishDraws", "verifyIntegrity", "readHistory"],
};

const boot = JSON.parse(process.argv[2] ?? "{}") as ChildBoot;

// --- frames on fd 3: a 4-byte big-endian length, then that many bytes of JSON -----------------

const pipe = new Socket({ fd: 3, readable: true, writable: true });

function send(m: ChildMessage): void {
  const body = Buffer.from(JSON.stringify(m));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  pipe.write(Buffer.concat([head, body]));
}

/** Reports a load failure and exits once the frame is flushed; the returned promise never settles. */
async function fail(code: string, message: string, id: number | null = null): Promise<never> {
  send({ type: "error", id, code, message });
  await new Promise<void>((r) => pipe.end(r));
  process.exit(1);
}

// Chunks are joined only once a whole frame is in, so a large frame costs one copy, not one per chunk.
let chunks: Buffer[] = [];
let have = 0;
let need: number | null = null;
const take = (n: number): Buffer => {
  const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
  chunks = all.length > n ? [all.subarray(n)] : [];
  have -= n;
  return all.subarray(0, n);
};
pipe.on("data", (chunk: Buffer) => {
  chunks.push(chunk);
  have += chunk.length;
  for (;;) {
    if (need === null) {
      if (have < 4) return;
      need = take(4).readUInt32BE(0);
      // The parent never sends more; if it did, stop rather than buffer it.
      if (need > boot.maxMessageBytes) process.exit(1);
    }
    if (have < need) return;
    const frame = take(need);
    need = null;
    receive(JSON.parse(frame.toString("utf8")) as ParentMessage);
  }
});
// The parent closed the pipe (or exited): nothing more will come.
pipe.on("end", () => process.exit(0));
pipe.on("error", () => process.exit(0));

// A plugin links against the host's own SDK, never a copy in its node_modules.
const registerHooks = (nodeModule as { registerHooks?: (hooks: { resolve: (s: string, c: unknown, next: (s: string, c: unknown) => unknown) => unknown }) => unknown }).registerHooks;
if (typeof registerHooks !== "function") await fail("NODE_TOO_OLD", `the plugin host needs Node 22.15 or later (module.registerHooks); this is ${process.version}`);
else
  registerHooks({
    resolve(specifier, context, next) {
      const url = boot.sdk[specifier];
      return url ? { url, shortCircuit: true } : next(specifier, context);
    },
  });

// --- fetch and sleep, both answered by the parent -------------------------------------------

let nextFid = 1;
const fetches = new Map<number, { resolve: (r: Response) => void; reject: (e: unknown) => void }>();
/** The plugin's acceptJson rule for each fetch in flight that has one. */
const acceptors = new Map<number, (body: unknown) => unknown>();
let nextSid = 1;
const sleeps = new Map<number, () => void>();

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError", code: 20 });

async function encodeBody(body: unknown): Promise<Pick<FetchMessage, "body" | "bodyEncoding">> {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body, bodyEncoding: "utf8" };
  if (body instanceof URLSearchParams) return { body: body.toString(), bodyEncoding: "utf8" };
  if (body instanceof ArrayBuffer) return { body: Buffer.from(body).toString("base64"), bodyEncoding: "base64" };
  if (ArrayBuffer.isView(body)) return { body: Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("base64"), bodyEncoding: "base64" };
  if (body instanceof Blob) return { body: Buffer.from(await body.arrayBuffer()).toString("base64"), bodyEncoding: "base64" };
  throw new TypeError("the plugin host sends string, binary, URLSearchParams and Blob request bodies only");
}

/** ctx.fetch inside the child: the request goes to the parent, which sends it through the fetch broker. */
async function hostFetch(input: string | URL | Request, init: (RequestInit & Record<string, unknown>) | undefined = {}): Promise<Response> {
  let url: string;
  let req: RequestInit & Record<string, unknown> = init ?? {};
  if (input instanceof Request) {
    url = input.url;
    req = { method: input.method, headers: input.headers, ...(input.body ? { body: await input.arrayBuffer() } : {}), signal: input.signal, ...init };
  } else url = String(input);
  const signal = req.signal ?? undefined;
  if (signal?.aborted) throw abortError();
  const msg: FetchMessage = { type: "fetch", fid: nextFid++, url, method: (req.method ?? "GET").toUpperCase(), headers: [...new Headers(req.headers)], ...(await encodeBody(req.body)) };
  if (typeof req.destination === "string") {
    const r = req.retry as false | { maxRetries?: unknown; maxBlindRateLimitRetries?: unknown; blindRateLimitWaitMs?: unknown; acceptJson?: unknown } | undefined;
    if (r && typeof r.acceptJson === "function") acceptors.set(msg.fid, r.acceptJson as (body: unknown) => unknown);
    msg.broker = {
      destination: req.destination,
      ...(typeof req.idempotent === "boolean" ? { idempotent: req.idempotent } : {}),
      ...(r === false
        ? { retry: false as const }
        : r
          ? {
              retry: {
                ...(typeof r.maxRetries === "number" ? { maxRetries: r.maxRetries } : {}),
                ...(typeof r.maxBlindRateLimitRetries === "number" ? { maxBlindRateLimitRetries: r.maxBlindRateLimitRetries } : {}),
                ...(typeof r.blindRateLimitWaitMs === "number" ? { blindRateLimitWaitMs: r.blindRateLimitWaitMs } : {}),
                ...(r.acceptJson ? { acceptJson: true } : {}),
              },
            }
          : {}),
    };
  }
  return new Promise<Response>((resolve, reject) => {
    fetches.set(msg.fid, { resolve, reject });
    signal?.addEventListener("abort", () => {
      acceptors.delete(msg.fid);
      if (fetches.delete(msg.fid)) reject(abortError());
    });
    send(msg);
  });
}

function settleFetch(m: FetchResultMessage): void {
  const f = fetches.get(m.fid);
  acceptors.delete(m.fid);
  if (!f) return;
  fetches.delete(m.fid);
  if (m.error) return f.reject(Object.assign(new Error(m.error.message), m.error));
  const status = m.status ?? 200;
  const res = new Response(NULL_BODY.has(status) || m.body === null || m.body === undefined ? null : Buffer.from(m.body, "base64"), { status, statusText: m.statusText ?? "", headers: m.headers ?? [] });
  f.resolve(Object.defineProperty(res, "url", { value: m.url ?? "", enumerable: true }));
}

let nextXid = 1;
const indexOps = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

/** LedgerContext.index inside the child: the parent reads and writes the file. */
function hostIndex(op: "read" | "write", value?: unknown): Promise<unknown> {
  const xid = nextXid++;
  return new Promise((resolve, reject) => {
    indexOps.set(xid, { resolve, reject });
    send({ type: "index", xid, op, ...(op === "write" ? { value } : {}) });
  });
}

function hostSleep(ms: number): Promise<void> {
  const sid = nextSid++;
  return new Promise<void>((resolve) => {
    sleeps.set(sid, resolve);
    send({ type: "sleep", sid, ms });
  });
}

// A plugin that calls the global fetch instead of ctx.fetch reaches the broker too.
globalThis.fetch = hostFetch as typeof fetch;

// --- calls ----------------------------------------------------------------------------------

let def: Definition;
let instance: Record<string, unknown> | null = null;
const running = new Map<number, AbortController>();
let heartbeat: ReturnType<typeof setInterval> | null = null;

function track(): void {
  if (running.size > 0 && !heartbeat) heartbeat = setInterval(() => send({ type: "heartbeat" }), boot.heartbeatMs);
  if (running.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

async function describe(options: unknown): Promise<DescribeResult> {
  const out: DescribeResult = {
    hosts: typeof def.hosts === "function" ? await (def.hosts as Fn)(options) : [],
    writePaths: typeof def.writePaths === "function" ? await (def.writePaths as Fn)(options) : [],
  };
  for (const k of ["reviewGranularity", "populationOptions", "reportsLandedVia", "labelHistory", "provenance"] as const) if (def[k] !== undefined) out[k] = def[k];
  return out;
}

async function create(options: unknown, base: { cwd?: unknown; windowDir?: unknown; reviewers?: unknown }): Promise<CreateResult> {
  const context = {
    cwd: base.cwd,
    ...(base.windowDir !== undefined ? { windowDir: base.windowDir } : {}),
    ...(base.reviewers !== undefined ? { reviewers: base.reviewers } : {}),
    env: { ...process.env },
    log: (line: unknown) => send({ type: "log", line: String(line) }),
    fetch: hostFetch,
    sleep: hostSleep,
    ...(boot.kind === "ledger" ? { index: { read: () => hostIndex("read"), write: async (v: unknown) => void (await hostIndex("write", v)) } } : {}),
  };
  instance = (await (def.create as Fn)(options, context)) as Record<string, unknown>;
  if (!instance || typeof instance !== "object") throw new Error("create() returned no object");
  return { apiVersion: instance.apiVersion, name: instance.name, methods: METHODS[boot.kind].filter((m) => typeof instance![m] === "function") };
}

async function run(m: CallMessage): Promise<void> {
  const ctrl = new AbortController();
  running.set(m.id, ctrl);
  track();
  try {
    let value: unknown;
    if (m.method === "describe") value = await describe(m.args[0]);
    else if (m.method === "create") value = await create(m.args[0], (m.args[1] ?? {}) as { cwd?: unknown; windowDir?: unknown; reviewers?: unknown });
    else {
      const fn = instance?.[m.method];
      if (!METHODS[boot.kind].includes(m.method) || typeof fn !== "function") throw new Error(`the plugin has no ${m.method}()`);
      const args = [...m.args];
      // A request object carries the call's abort signal (the parent's `cancel`).
      if ((m.method === "listChanges" || m.method === "nativeCounts" || m.method === "estimateRequests" || m.method === "firstParentPath" || m.method === "pushLog") && args[0] && typeof args[0] === "object") args[0] = { ...(args[0] as object), signal: ctrl.signal };
      // resolveAccounts(logins, { signal }) (P5): only the logins cross; the call's signal is the child's own.
      if (m.method === "resolveAccounts") args.splice(1, args.length - 1, { signal: ctrl.signal });
      value = await (fn as Fn).apply(instance, args);
    }
    send({ type: "result", id: m.id, value: value === undefined ? null : value });
  } catch (e) {
    const err = e as { name?: unknown; code?: unknown; message?: unknown; status?: unknown; rateLimited?: unknown };
    send({ type: "error", id: m.id, code: typeof err?.code === "string" ? err.code : "PLUGIN_ERROR", message: typeof err?.message === "string" ? err.message : String(e), ...(typeof err?.name === "string" ? { name: err.name } : {}), ...(typeof err?.status === "number" ? { status: err.status } : {}), ...(err?.rateLimited === true ? { rateLimited: true } : {}) });
  } finally {
    running.delete(m.id);
    track();
  }
}

function receive(m: ParentMessage): void {
  if (m.type === "call") void run(m);
  else if (m.type === "cancel") running.get(m.id)?.abort();
  else if (m.type === "fetchResult") settleFetch(m);
  else if (m.type === "slept") {
    sleeps.get(m.sid)?.();
    sleeps.delete(m.sid);
  } else if (m.type === "indexResult") {
    const op = indexOps.get(m.xid);
    indexOps.delete(m.xid);
    if (m.error) op?.reject(Object.assign(new Error(m.error.message), m.error));
    else op?.resolve(m.value ?? null);
  } else if (m.type === "accept") {
    // The plugin's own acceptJson rule, for a body the broker checks (finding 10).
    const rule = acceptors.get(m.fid);
    let answer: { problem: string | null } | { error: string };
    try {
      const problem = rule ? rule(JSON.parse(m.body)) : null;
      answer = { problem: typeof problem === "string" ? problem : null };
    } catch (e) {
      answer = { error: (e as Error)?.message ?? String(e) };
    }
    send({ type: "acceptResult", aid: m.aid, ...answer });
  }
}

// --- load -----------------------------------------------------------------------------------

async function load(): Promise<Definition> {
  let d: unknown;
  try {
    const mod = (await import(boot.entry)) as Record<string, unknown>;
    d = mod.default ?? mod[boot.kind];
  } catch (e) {
    return fail("LOAD_FAILED", `cannot load the plugin: ${(e as Error).message}`);
  }
  if (!d || typeof d !== "object") return fail("LOAD_FAILED", `the module exports no ${boot.kind} definition (use define${boot.kind === "provider" ? "Provider" : "Ledger"}() as the default export)`);
  return d as Definition;
}
def = await load();

const ready: ReadyMessage = {
  type: "ready",
  protocol: boot.protocol,
  kind: boot.kind,
  name: def.name,
  apiVersion: boot.kind === "provider" ? def.providerApiVersion : def.ledgerApiVersion,
  shape: { create: typeof def.create, hosts: typeof def.hosts, writePaths: typeof def.writePaths },
  node: process.version,
};
for (const k of ["reviewGranularity", "description", "credentials", "populationOptions"] as const) if (def[k] !== undefined) ready[k] = def[k];
send(ready);
