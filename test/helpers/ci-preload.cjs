// Loaded into every Node process the CI harness starts (NODE_OPTIONS=--require=<this file>): the
// pr-rla CLI and the action's own scripts. It does two things, so that the real code runs unchanged
// and still touches nothing outside this machine (NFR11, D8):
//
//   1. fetch: a request to an origin in PRRLA_TEST_ROUTES (JSON, origin -> base URL) goes to the
//      mock server on 127.0.0.1 at that base instead. The caller sees the real origin in its own
//      logic (grants, read-only guard, pacing); only the last hop is swapped.
//   2. sockets: a connection to anything but loopback is refused and recorded in the file named by
//      PRRLA_TEST_DENIED, which the test reads afterwards.
"use strict";
const net = require("node:net");
const fs = require("node:fs");

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  let host = null;
  if (typeof a === "number") host = typeof args[1] === "string" ? args[1] : "localhost";
  else if (a && typeof a === "object" && !a.path) host = a.host || "localhost";
  if (host !== null && !LOOPBACK.has(String(host).replace(/^\[|\]$/g, ""))) {
    if (process.env.PRRLA_TEST_DENIED) fs.appendFileSync(process.env.PRRLA_TEST_DENIED, `${host}\n`);
    throw new Error(`network-deny: the CI harness refused a connection to ${host}`);
  }
  return original.apply(this, args);
};

const routes = JSON.parse(process.env.PRRLA_TEST_ROUTES || "{}");
const realFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  for (const [origin, base] of Object.entries(routes)) {
    if (url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`)) {
      const to = base + url.slice(origin.length);
      return realFetch(typeof input === "object" && !(input instanceof URL) ? new Request(to, input) : to, init);
    }
  }
  return realFetch(input, init);
};
