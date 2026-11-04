// Run by test/api-read-runtime.test.ts under runtime-trace-hook.mjs: calls every function of
// pr-rla/api/read (the built dist/) on the audit directory in argv[3], offline and online (online
// with a transport that refuses every request), then prints the trace as JSON on stdout.
const [dist, dir] = process.argv.slice(2);
const read = await import(new URL(`file://${dist}/api/read/index.js`).href);
const noNet = async () => {
  throw new Error("no network in this trace");
};
const o = { fetch: noNet, roots: [dir], confine: () => {} };
const results = {};
const call = async (name, fn) => {
  try {
    await fn();
    results[name] = "ok";
  } catch (e) {
    results[name] = e?.code ?? "error";
  }
};
await call("auditList", () => read.auditList({ dir }, o));
await call("status", () => read.status({ dir }, o));
await call("status online", () => read.status({ dir, offline: false }, o));
await call("draws", () => read.draws({ dir }, o));
await call("drawContext", () => read.drawContext({ dir, draw: 7 }, o));
await call("verify", () => read.verify({ dir }, o));
await call("verify online", () => read.verify({ dir, offline: false }, o));
await call("freezePreview", () => read.freezePreview({ dir }, o));
await call("simulate", () => read.simulate({ population: 100, defects: 1, runs: 10 }, o));
process.stdout.write(JSON.stringify({ results, ...globalThis.__trace }));
