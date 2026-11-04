// Long calls, jobs and the memory bounds (contracts.md §4; FR3.5; NFR20): the hand-off at 25 s
// (shortened here), progress notifications while the call is open, job_status, `unknown` after a
// restart, at most four long calls at once, a result over 8 MiB refused, finished jobs and cached
// previews dropped after 600 s.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createPrRlaMcp } from "../dist/server.js";
import { RECORDING, body, copyAudit, mockGitHub, onlineAudit, sleep, startServer, waitForJob } from "./helpers.mjs";

/** A recorded GitHub, in process: serves the recorded describeChange responses after `delayMs`. */
function recordedFetch(delayMs) {
  const rec = JSON.parse(readFileSync(RECORDING, "utf8"));
  const byPath = new Map(rec.exchanges.map((e) => [new URL(e.url).pathname + new URL(e.url).search, e]));
  const methods = [];
  const f = async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    methods.push(init.method ?? "GET");
    await sleep(delayMs);
    const hit = byPath.get(url.pathname.replace(/^\/api\/v3/, "") + url.search);
    return hit ? new Response(JSON.stringify(hit.response), { status: 200, headers: { "content-type": "application/json", ...hit.headers } }) : new Response('{"message":"Not Found"}', { status: 404, headers: { "content-type": "application/json" } });
  };
  return Object.assign(f, { methods });
}

/** An in-process server and client over linked in-memory transports. */
async function inProcess(options) {
  const mcp = createPrRlaMcp({ log: () => {}, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.factory().connect(serverSide);
  const client = new Client({ name: "jobs-test", version: "0" });
  await client.connect(clientSide);
  return { mcp, client, call: (name, args = {}, opts) => client.callTool({ name, arguments: args }, opts), close: async () => (await client.close(), mcp.close()) };
}

const servers = [];
after(async () => {
  for (const s of servers) await s.close().catch(() => {});
});

describe("the hand-off: a long call returns { jobId } and keeps running (FR3.5)", () => {
  it("draw_context on a slow SCM: progress while the call is open, then a job that job_status follows to the result", async () => {
    const slow = await mockGitHub({ delayMs: 300 });
    const dir = onlineAudit(slow.url);
    const s = await startServer({ roots: [dir], args: ["--handoff-ms", "250"] });
    servers.push(s, { close: slow.close });
    const notes = [];
    const t0 = Date.now();
    const r = body(await s.call("draw_context", { draw: 7 }, { onprogress: (p) => notes.push(p) }));
    const handedOffMs = Date.now() - t0;
    assert.match(r.jobId, /^draw_context:[0-9a-f]{24}$/);
    assert.equal(r.state, "running");
    assert.ok(handedOffMs < 2000, `handed off after ${handedOffMs} ms`);
    assert.ok(notes.length >= 1, "a progress notification arrived before the hand-off");
    assert.match(notes[0].message, /asking github for github:github\/gh-aw#42597/);
    const running = body(await s.call("job_status", { jobId: r.jobId }));
    assert.equal(running.state, "running");
    const done = await waitForJob(s, r.jobId);
    assert.equal(done.state, "done");
    assert.equal(done.result.changeId, "github:github/gh-aw#42597");
    assert.equal(done.result.untrusted.generatedFiles.length, 2);
    assert.deepEqual(slow.requests.filter((q) => !q.read), []);
    assert.deepEqual(s.writes(), []);
  });

  it("freeze_preview and online verify hand off too; each job ends, done or failed, on reads only", async () => {
    const slow = await mockGitHub({ delayMs: 300 });
    const dir = onlineAudit(slow.url);
    const s = await startServer({ roots: [dir], args: ["--handoff-ms", "150"] });
    servers.push(s, { close: slow.close });
    for (const [tool, args] of [["freeze_preview", {}], ["verify", { offline: false }]]) {
      const h = body(await s.call(tool, args));
      assert.match(h.jobId, new RegExp(`^${tool}:[0-9a-f]{24}$`));
      const end = await waitForJob(s, h.jobId);
      // The mock serves describeChange only, so the listing fails: the job reports it as an error, not a crash.
      assert.ok(end.state === "failed" ? end.error.code === "PROVIDER_ERROR" : end.state === "done", JSON.stringify(end).slice(0, 300));
    }
    assert.deepEqual(slow.requests.filter((q) => !q.read), []);
    assert.ok(slow.requests.some((q) => q.method === "POST" && q.url === "/api/graphql"), "GraphQL queries are reads");
    assert.deepEqual(s.writes(), []);
  });

  it("a call that finishes before the hand-off returns its result directly", async () => {
    const dir = copyAudit();
    const s = await startServer({ roots: [dir], args: ["--handoff-ms", "25000"] });
    servers.push(s);
    const r = body(await s.call("draw_context", { draw: 7 }));
    assert.equal(r.changeId, "github:github/gh-aw#42597");
  });

  it("the hand-off cannot be set past 25 s (the tool budget is 30 s)", () => {
    assert.throws(() => createPrRlaMcp({ roots: [copyAudit()], limits: { handoffMs: 25_001 } }), /1\.\.25000/);
  });
});

describe("at most four long calls at once (NFR20)", () => {
  it("a fifth is refused with TOO_MANY_JOBS, before it starts", async () => {
    const slow = await mockGitHub({ delayMs: 1500 });
    const dir = onlineAudit(slow.url);
    const s = await startServer({ roots: [dir], args: ["--handoff-ms", "100"] });
    servers.push(s, { close: slow.close });
    const four = await Promise.all([7, 13, 31, 5].map((draw) => s.call("draw_context", { draw })));
    for (const r of four) assert.match(body(r).jobId, /^draw_context:/);
    const fifth = await s.call("draw_context", { draw: 7 });
    assert.equal(fifth.isError, true);
    assert.equal(body(fifth).code, "TOO_MANY_JOBS");
    assert.match(body(fifth).next, /poll job_status/);
    // Offline calls are not long calls: they still run.
    assert.equal(body(await s.call("status", {})).phase, "sampled");
    for (const r of four) assert.equal((await waitForJob(s, body(r).jobId)).state, "done");
    // Once they finish, long calls run again.
    assert.match(body(await s.call("draw_context", { draw: 7 })).jobId, /^draw_context:/);
  });
});

describe("jobs live in memory only", () => {
  it("after a restart, job_status answers unknown and says to run the tool again", async () => {
    const slow = await mockGitHub({ delayMs: 400 });
    const dir = onlineAudit(slow.url);
    const a = await startServer({ roots: [dir], args: ["--handoff-ms", "100"] });
    const { jobId } = body(await a.call("draw_context", { draw: 7 }));
    assert.match(jobId, /^draw_context:/);
    await a.close();
    const b = await startServer({ roots: [dir] });
    servers.push(b, { close: slow.close });
    assert.deepEqual(body(await b.call("job_status", { jobId })), { jobId, state: "unknown", message: "Unknown job (the server restarted or it expired): run draw_context again" });
  });

  it("a finished job is dropped after 600 s; a running one is kept", async () => {
    const clock = { now: Date.parse("2026-11-04T00:00:00Z") };
    const dir = onlineAudit("https://ghes.example.com");
    const fetch = recordedFetch(60);
    const s = await inProcess({ roots: [dir], fetch, nowMs: () => clock.now, limits: { handoffMs: 10 } });
    servers.push(s);
    const { jobId } = body(await s.call("draw_context", { draw: 7 }));
    assert.equal(body(await s.call("job_status", { jobId })).state, "running");
    clock.now += 700_000; // a running job never expires
    let st;
    while ((st = body(await s.call("job_status", { jobId }))).state === "running") await sleep(20);
    assert.equal(st.state, "done");
    clock.now += 599_000;
    assert.equal(body(await s.call("job_status", { jobId })).state, "done");
    clock.now += 2_000;
    assert.equal(body(await s.call("job_status", { jobId })).state, "unknown");
    assert.ok(fetch.methods.every((m) => m === "GET"));
  });
});

describe("a result over 8 MiB is refused (NFR20)", () => {
  it("returned directly: RESULT_TOO_LARGE, with the way to narrow it", async () => {
    const dir = copyAudit();
    const s = await inProcess({ roots: [dir], limits: { maxResultBytes: 4096 } });
    servers.push(s);
    const r = await s.call("draw_context", { draw: 13 });
    assert.equal(r.isError, true);
    assert.equal(body(r).code, "RESULT_TOO_LARGE");
    assert.match(body(r).next, /smaller maxPatchBytes/);
    // Small results still pass.
    assert.equal(body(await s.call("job_status", { jobId: "x:1" })).state, "unknown");
  });

  it("as a job: the job fails with RESULT_TOO_LARGE and keeps no result", async () => {
    const dir = onlineAudit("https://ghes.example.com");
    const s = await inProcess({ roots: [dir], fetch: recordedFetch(40), limits: { handoffMs: 5, maxResultBytes: 4096 } });
    servers.push(s);
    const { jobId } = body(await s.call("draw_context", { draw: 13 }));
    let st;
    while ((st = body(await s.call("job_status", { jobId }))).state === "running") await sleep(20);
    assert.equal(st.state, "failed");
    assert.equal(st.error.code, "RESULT_TOO_LARGE");
    assert.equal(st.result, undefined);
  });

  it("the default limit is 8 MiB", () => {
    const m = createPrRlaMcp({ roots: [copyAudit()] });
    assert.deepEqual(m.jobs.limits, { handoffMs: 25_000, maxJobs: 4, ttlMs: 600_000, maxResultBytes: 8 * 1024 * 1024 });
  });
});

describe("freeze_preview's cache: in memory, 600 s, by (window, registration digest, estimate)", () => {
  it("a hit within 600 s, a fresh preview after", async () => {
    const clock = { now: Date.parse("2026-11-04T00:00:00Z") };
    const s = await inProcess({ roots: [copyAudit()], nowMs: () => clock.now });
    servers.push(s);
    const a = body(await s.call("freeze_preview", {}));
    clock.now += 599_000;
    const b = body(await s.call("freeze_preview", {}));
    assert.equal(b.cached, true);
    assert.equal(b.frozenAt, a.frozenAt);
    clock.now += 2_000;
    const c = body(await s.call("freeze_preview", {}));
    assert.equal(c.cached, undefined);
    assert.notEqual(c.frozenAt, a.frozenAt);
  });
});
