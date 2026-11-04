// The U5 demo (delivery-plan.md, bolt 6): `draw_context` on a recorded gh-aw draw, through a real
// MCP client session (the MCP SDK's own client, over stdio), and the audit directory's hash unchanged.
//
// The server runs as an assistant would start it, plus two seatbelts for the demo: Node's permission
// model with no fs-write grant, and a preloaded guard that reports any write attempt or any socket
// beyond loopback.
//
// Usage (after `npm run build` at the root and `npm run build` here):
//   node scripts/demo-draw-context.mjs [draw]          the recorded audit, offline (json-file export)
//   GITHUB_TOKEN=… node scripts/demo-draw-context.mjs --live [draw]
//                                                      the same draw read live from api.github.com (GETs only),
//                                                      on a copy of the audit whose provider is the built-in github
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE, body, startServer, treeHash } from "../test/helpers.mjs";

const live = process.argv.includes("--live");
const draw = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 13);
let dir = FIXTURE;
if (live) {
  dir = mkdtempSync(join(tmpdir(), "prrla-live-"));
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, ".pr-rla.yml"), readFileSync(join(dir, ".pr-rla.yml"), "utf8").replace(/^provider: .*$/m, "provider: github"));
}

const before = treeHash(dir);
const s = await startServer({ roots: [dir], env: live ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "" } : {}, allowNet: live });
console.log(`pr-rla-mcp ${s.client.getServerVersion()?.version} over stdio, started in ${Math.round(s.startMs)} ms (node --permission, no fs-write grant)`);
const { tools } = await s.client.listTools();
console.log(`tools: ${tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? " (readOnly)" : ""}`).join(", ")}`);
const t0 = performance.now();
const r = await s.call("draw_context", { draw });
const ms = performance.now() - t0;
const c = body(r);
if (r.isError) throw new Error(`draw_context failed: ${JSON.stringify(c)}`);
console.log(`\ndraw_context { draw: ${draw} }  ${live ? "live from api.github.com" : "recorded (json-file export)"} · ${Math.round(ms)} ms`);
console.log(`  ${c.changeId} · ${c.url}`);
console.log(`  files shown ${c.summary.files} (+${c.summary.additions} −${c.summary.deletions}) · linguist-generated dropped ${c.summary.generatedFiles}: ${c.untrusted.generatedFiles.slice(0, 3).join(", ")}${c.untrusted.generatedFiles.length > 3 ? ", …" : ""}`);
console.log(`  shown: ${c.untrusted.files.map((f) => f.path).join(", ")}`);
console.log(`  checks ${JSON.stringify(c.summary.checks)} · protocol ${c.protocol.ok ? "is the registered one" : c.protocol.problem} · state ${c.state.verdict}`);
console.log(`  fence ${c.untrusted.fence} (the core's, passed through: the text content is the same JSON)`);
const open = c.text.indexOf("<<<UNTRUSTED");
console.log(`\n${c.text.slice(0, open + 140).split("\n").map((l) => `    | ${l}`).join("\n")}\n    | …\n${c.text.slice(c.text.indexOf("<<<END")).split("\n").map((l) => `    | ${l}`).join("\n")}`);
await s.close();
const afterHash = treeHash(dir);
console.log(`\naudit directory ${dir}`);
console.log(`  tree hash before ${before}`);
console.log(`  tree hash after  ${afterHash}  ${afterHash === before ? "(unchanged)" : "(CHANGED)"}`);
console.log(`  write attempts by the server: ${s.writes().length} · sockets beyond loopback refused: ${s.netDenied().length}`);
if (afterHash !== before || s.writes().length) process.exit(1);
