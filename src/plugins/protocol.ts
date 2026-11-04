/**
 * The plugin host IPC protocol, `pr-rla/ipc/v1` (contracts.md §3).
 *
 * The parent (./host.ts) and the child (./child.ts) exchange one JSON object per message
 * over the Node IPC channel. The child imports this module for its types only, so it stays
 * free of runtime imports from pr-rla.
 */

export const IPC_PROTOCOL = "pr-rla/ipc/v1";
/** The child sends a heartbeat this often while a call runs. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** The parent stops a child that sends nothing for this long while a call runs. */
export const HEARTBEAT_TIMEOUT_MS = 60_000;
/** Messages larger than this (serialized) are refused in both directions. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export type PluginKind = "provider" | "ledger";

/**
 * Methods the parent may call. `describe` evaluates the definition's `hosts(options)` and
 * `writePaths(options)` without creating an instance; `create` makes the instance; the rest
 * are the SDK's instance methods.
 */
export const PROVIDER_METHODS = ["listChanges", "nativeCounts", "listRepos", "describeChange", "estimateRequests", "describeRepo", "listingVisibility", "firstParentPath", "pushLog"] as const;
export const LEDGER_METHODS = ["readVerdicts", "appendVerdict", "publishDraws", "verifyIntegrity", "readHistory"] as const;
export type PluginMethod = "describe" | "create" | (typeof PROVIDER_METHODS)[number] | (typeof LEDGER_METHODS)[number];

/** What the parent passes the child on its command line (no secrets). */
export interface ChildBoot {
  protocol: typeof IPC_PROTOCOL;
  kind: PluginKind;
  /** file: URL of the plugin module. */
  entry: string;
  /** `pr-rla/provider` etc. -> file: URL of the host's own SDK module, so a plugin links against the SDK that validates it. */
  sdk: Record<string, string>;
  heartbeatMs: number;
}

/** child -> parent: the plugin loaded. The parent validates the definition from these fields. */
export interface ReadyMessage {
  type: "ready";
  protocol: string;
  kind: PluginKind;
  name: unknown;
  apiVersion: unknown;
  reviewGranularity?: unknown;
  description?: unknown;
  credentials?: unknown;
  populationOptions?: unknown;
  /** typeof the definition's create, hosts and writePaths. */
  shape: { create: string; hosts: string; writePaths: string };
  /** process.version of the child. */
  node: string;
}

/**
 * What `describe` returns: what the definition asks for with these options, and (added within v1
 * for U3) the definition's population traits, so the parent never imports an isolated plugin to
 * read them. The parent validates every field with the SDK's own checks.
 */
export interface DescribeResult {
  hosts: unknown;
  writePaths: unknown;
  /** The definition's `reviewGranularity`, `populationOptions` and `reportsLandedVia`, when it declares them. */
  reviewGranularity?: unknown;
  populationOptions?: unknown;
  reportsLandedVia?: unknown;
  /** A ledger definition's `provenance` (U4), when it declares one. */
  provenance?: unknown;
}

/** What `create` returns: the instance's identity and which of its kind's methods it has. */
export interface CreateResult {
  apiVersion: unknown;
  name: unknown;
  methods: string[];
}

export interface CallMessage {
  type: "call";
  id: number;
  method: PluginMethod;
  args: unknown[];
}
export interface CancelMessage {
  type: "cancel";
  id: number;
}
export interface ResultMessage {
  type: "result";
  id: number;
  value: unknown;
}
/** `id: null` reports a failure to load the plugin, before any call. */
export interface ErrorMessage {
  type: "error";
  id: number | null;
  code: string;
  message: string;
  name?: string;
  /** Optional (U8 fix round): the error's HTTP status and rate-limit flag, which the core reads to tell gone from transient. */
  status?: number;
  rateLimited?: boolean;
}

/** child -> parent: the plugin called ctx.fetch (or fetch). A string body travels as text, others as base64. */
export interface FetchMessage {
  type: "fetch";
  fid: number;
  url: string;
  method: string;
  headers: [string, string][];
  body?: string;
  bodyEncoding?: "utf8" | "base64";
  /** The broker contract fields a wired request passes (contracts.md §2); `acceptJson` becomes a flag. */
  broker?: { destination?: string; idempotent?: boolean; retry?: false | { maxRetries?: number; maxBlindRateLimitRetries?: number; acceptJson?: boolean } };
}
export interface FetchResultMessage {
  type: "fetchResult";
  fid: number;
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  /** base64 */
  body?: string | null;
  url?: string;
  error?: { name: string; code?: string; message: string; host?: string; next?: string };
}

/** child -> parent: the plugin called ctx.sleep, which waits on the parent's clock (one clock per command). */
export interface SleepMessage {
  type: "sleep";
  sid: number;
  ms: number;
}
export interface SleptMessage {
  type: "slept";
  sid: number;
}
/** child -> parent: the plugin called ctx.log. */
export interface LogMessage {
  type: "log";
  line: string;
}
export interface HeartbeatMessage {
  type: "heartbeat";
}
/**
 * child -> parent (added within v1 for U4): a ledger read or wrote its local index
 * (LedgerContext.index). The parent keeps the file; the child has no fs-write.
 */
export interface IndexMessage {
  type: "index";
  xid: number;
  op: "read" | "write";
  value?: unknown;
}
export interface IndexResultMessage {
  type: "indexResult";
  xid: number;
  value?: unknown;
  error?: { name: string; code?: string; message: string };
}

export type ChildMessage = ReadyMessage | ResultMessage | ErrorMessage | FetchMessage | SleepMessage | LogMessage | HeartbeatMessage | IndexMessage;
export type ParentMessage = CallMessage | CancelMessage | FetchResultMessage | SleptMessage | IndexResultMessage;
