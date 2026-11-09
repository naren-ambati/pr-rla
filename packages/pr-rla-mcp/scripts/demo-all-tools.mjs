// The end-to-end MCP tour (e2e round 2026-11-09): every one of pr-rla-mcp's eight tools, once, through the MCP
// SDK's own client over stdio, against an audit directory, and the directory's tree hash unchanged at the end.
// The server runs as an assistant would start it, under Node's permission model with no fs-write grant, plus a
// preloaded guard that reports any write attempt or any socket beyond loopback. A second server, started with
// --handoff-ms 1, hands a call off as a job so that job_status has a real job to report.
//
// Usage (after `npm run build` at the root and here):  node scripts/demo-all-tools.mjs [audit-dir] [draw]
//   audit-dir: a copy of an audit repo (default: a copy of the recorded gh-aw audit in a fresh git repository)
import { body, copyAudit, startServer, treeHash } from "../test/helpers.mjs";

const dir = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : copyAudit();
const draw = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 1);
const before = treeHash(dir);
let failures = 0;
const show = async (s, name, args, summarise) => {
  const t0 = performance.now();
  const r = await s.call(name, args);
  const ms = Math.round(performance.now() - t0);
  const b = body(r);
  if (r.isError) failures++;
  console.log(`${name} ${JSON.stringify(args)}  ${r.isError ? "ERROR" : "ok"} · ${ms} ms${r.isError ? ` · ${b.code}: ${b.message}` : ""}`);
  if (!r.isError) for (const l of summarise(b)) console.log(`    ${l}`);
  return b;
};

const s = await startServer({ roots: [dir] });
console.log(`pr-rla-mcp ${s.client.getServerVersion()?.version} over stdio, started in ${Math.round(s.startMs)} ms (node --permission, no fs-write grant)`);
console.log(`audit directory ${dir}`);
const { tools } = await s.client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? " [readOnly]" : ""}`).join(", ")}\n`);

await show(s, "audit_list", {}, (b) => b.windows.map((w) => `${w.name}: ${w.phase} · N ${w.N} · ${w.drawsIssued} draws · certified ${w.certified}`));
await show(s, "status", {}, (b) => [`${b.line.split(" · ").slice(0, 1).join("")} · ${b.line.split(" · ").filter((p) => /LLR|NOT CERTIFIED|target reached/.test(p)).join(" · ")}`, `certified ${b.certified}`]);
await show(s, "draws", { limit: 3 }, (b) => [`${b.issued} issued, showing ${b.draws.length}; blocking draw #${b.blockingDraw?.draw}`, ...b.draws.map((d) => `#${d.draw} ${d.changeId}`)]);
await show(s, "draw_context", { draw }, (b) => [`${b.changeId} · ${b.url}`, `files ${b.summary.files} (+${b.summary.additions} -${b.summary.deletions}) · CI ${JSON.stringify(b.summary.checks)} · fence ${b.untrusted.fence}`, `how to record (for the person): ${b.howToRecord}`]);
await show(s, "verify", { offline: true }, (b) => [`verdict ${b.verdict} · exitCode ${b.exitCode} · certified ${b.certified}`, ...b.checks.map((c) => `check ${c.n} ${c.status} ${c.name}`)]);
await show(s, "simulate", { population: 1000, defects: 20, runs: 200, seed: 7 }, (b) => [`${b.runs} runs on ${b.population} changes with ${b.defects} defects: certified ${b.certified}, escalated ${b.escalated}, mean draws ${b.meanDraws}`]);
await show(s, "freeze_preview", {}, (b) => [`dry run for ${b.repo}, window ${b.window.name}: N ${b.N}, nothing written`]);
await show(s, "job_status", { jobId: "no-such-job" }, (b) => [`state ${b.state}${b.next ? ` · ${b.next}` : ""}`]);
await s.close();

const j = await startServer({ roots: [dir], args: ["--handoff-ms", "1"] });
const t0 = performance.now();
const started = body(await j.call("verify", { offline: false }));
if (started.jobId) {
  console.log(`\nverify {"offline":false} with --handoff-ms 1: handed off as job ${started.jobId} (${started.state}) after ${Math.round(performance.now() - t0)} ms`);
  let st;
  for (let i = 0; i < 100; i++) {
    st = body(await j.call("job_status", { jobId: started.jobId }));
    if (st.state !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`job_status {"jobId":"${started.jobId}"}  state ${st.state}${st.result ? ` · result verdict ${st.result.verdict}, exitCode ${st.result.exitCode}` : ""}`);
  if (st.state !== "done") failures++;
} else {
  console.log("\nverify finished before the hand-off: no job to poll");
  failures++;
}
await j.close();

const after = treeHash(dir);
console.log(`\ntree hash before ${before}`);
console.log(`tree hash after  ${after}  ${after === before ? "(unchanged)" : "(CHANGED)"}`);
console.log(`write attempts by the servers: ${s.writes().length + j.writes().length} · sockets beyond loopback refused: ${s.netDenied().length + j.netDenied().length} · tool errors: ${failures}`);
if (after !== before || s.writes().length || j.writes().length || failures) process.exit(1);
