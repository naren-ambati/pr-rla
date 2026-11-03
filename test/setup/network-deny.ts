import net from "node:net";
import { afterAll } from "vitest";

/**
 * The network-deny harness (test-design.md §1, NFR11): every test file runs with
 * outbound sockets refused, except to the local mock servers on loopback. A test
 * that reaches a real host (a timestamp authority, drand, any Rekor log, an SCM)
 * fails with the host it tried.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const attempts: string[] = [];
(globalThis as { __prrlaDeniedConnections?: string[] }).__prrlaDeniedConnections = attempts;

type ConnectArgs = unknown[];
const original = net.Socket.prototype.connect as (this: net.Socket, ...args: ConnectArgs) => net.Socket;

function target(args: ConnectArgs): { host: string | null; path: string | null } {
  let a: unknown = args[0];
  if (Array.isArray(a)) a = a[0]; // net.connect passes its normalized [options, cb]
  if (typeof a === "string") return { host: null, path: a };
  if (typeof a === "number") return { host: typeof args[1] === "string" ? args[1] : "localhost", path: null };
  const o = (a ?? {}) as { host?: string; path?: string };
  if (o.path) return { host: null, path: o.path };
  return { host: o.host ?? "localhost", path: null };
}

net.Socket.prototype.connect = function (this: net.Socket, ...args: ConnectArgs) {
  const t = target(args);
  if (t.host !== null && !LOOPBACK.has(t.host.replace(/^\[|\]$/g, ""))) {
    attempts.push(t.host);
    throw new Error(`network-deny: test tried to connect to ${t.host}; npm test makes no network call (use a recorded fixture or a mock on 127.0.0.1)`);
  }
  return original.apply(this, args);
} as typeof net.Socket.prototype.connect;

// A refused connection that some code caught and swallowed would not fail its test, so every
// test file also fails afterwards if anything tried to leave the machine.
afterAll(() => {
  if (attempts.length) throw new Error(`network-deny: this test file tried to reach ${[...new Set(attempts)].join(", ")}`);
});
