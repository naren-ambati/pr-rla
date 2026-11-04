// The bolt 3 demo (delivery-plan.md): a recorded public timeline with a remove and re-add shows WARN;
// a deleted-issue fixture shows FAIL. Offline: every tracker answer is a read-only recording
// (test/fixtures/ledgers/github, 2026-11-03), replayed; nothing is contacted or written.
//   npm run build && node scripts/demo-ledgers.mjs
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../dist/cli.js";
import { nodeContext } from "../dist/commands/context.js";
import { verifyQuicknetBeacon } from "../dist/beacon/drand.js";
import githubIssues from "../dist/ledgers/github-issues/index.js";

const fixture = (f) => JSON.parse(readFileSync(new URL(`../test/fixtures/ledgers/github/${f}`, import.meta.url), "utf8"));
/** Serves the recorded exchanges; an unrecorded request throws, so the demo stays offline. */
function replay(rec) {
  const queue = rec.exchanges.map((e) => ({ e, used: false }));
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.href ?? input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const hit = queue.find((q) => !q.used && q.e.method === method && q.e.url === url);
    if (!hit) throw new Error(`demo: unrecorded request ${method} ${url} (nothing is sent anywhere)`);
    hit.used = true;
    return new Response(JSON.stringify(hit.e.response), { status: hit.e.status, headers: { "content-type": "application/json", ...hit.e.headers } });
  };
}
const result = (i) => (!i.ok ? "FAIL" : i.warnings?.length ? "WARN" : "PASS");

console.log("Part 1: the github-issues ledger on two recorded public timelines (what check 7 consumes)\n");
for (const [f, title] of [
  ["relabel-same-nodejs-node-67038.json", "nodejs/node#67038, commit-queue-squash mapped to pr-rla:pass"],
  ["deleted-microsoft-vscode-345635.json", "microsoft/vscode#345635, deleted"],
]) {
  const rec = fixture(f);
  const windowDir = mkdtempSync(join(tmpdir(), "prrla-demo-"));
  writeFileSync(join(windowDir, "ledger-index.json"), JSON.stringify(rec.index));
  const l = await githubIssues.create(rec.options, { cwd: windowDir, windowDir, env: {}, log: () => {}, fetch: replay(rec) });
  const verdicts = await l.readVerdicts();
  const integ = await l.verifyIntegrity();
  console.log(`${title}  (source: ${rec.source}, recorded ${rec.recordedAt})`);
  const events = rec.exchanges.filter((e) => /\/events/.test(e.url)).flatMap((e) => e.response).filter((e) => e.label?.name === rec.options.labels.pass);
  for (const e of events) console.log(`  event ${e.id}  ${e.created_at}  ${e.event.padEnd(9)}  ${e.label.name}  by ${e.actor.login} (${e.actor.type})`);
  if (rec.case === "deletion") console.log(`  GET ${rec.exchanges.find((e) => /issues\/\d+$/.test(e.url)).url} → HTTP ${rec.exchanges.find((e) => /issues\/\d+$/.test(e.url)).status}`);
  for (const v of verdicts) console.log(`  verdict: draw #${v.draw} ${v.verdict} by ${v.reviewer} at ${v.recordedAt} (provenance ${v.provenance.level}, event ${v.provenance.eventId})`);
  console.log(`  integrity: ${result(integ)}`);
  for (const x of [...integ.findings, ...(integ.warnings ?? [])]) console.log(`    ${x}`);
  console.log();
}

console.log("Part 2: pr-rla verify, with an audit registered on the recorded tracker (check 7)\n");
const changes = Array.from({ length: 200 }, (_, i) => {
  const sha = (BigInt(i + 1) * 0x9e3779b97f4a7c15n).toString(16).padStart(40, "0").slice(-40);
  const mergedAt = new Date(Date.parse("2026-07-01T00:00:00Z") + i * 39_000_000).toISOString().replace(".000Z", "Z");
  return { id: `json:acme/widgets#${1000 + i}`, kind: "pull_request", repo: "acme/widgets", url: `https://git.example.com/acme/widgets/pulls/${1000 + i}`, mergeSha: sha, mergedAt, author: { login: "copilot-swe-agent[bot]", kind: "bot" }, mergedBy: { login: "maint", kind: "human" }, reviews: [], changedLines: 10 + i, labels: [] };
});
const yml = (ledger) => `provider: { use: json-file, options: { path: changes.json } }\nrepo: acme/widgets\nwindow: { name: 2026-q3, start: 2026-07-01, end: 2026-09-30 }\nselector: { kinds: [pull_request, direct_push], authors: any, unreviewed: no-human-review }\ntimestamping: { authorities: [] }\nledger: ${ledger}\n`;
const beacon = JSON.parse(readFileSync(new URL("../test/fixtures/drand/quicknet-33245812.json", import.meta.url), "utf8"));
const offline = async (u) => {
  throw new Error(`demo: no network (${u})`);
};
/**
 * A 200-change json-file audit registered with `ledger` (verify FAILs check 7 on any other: U9), then
 * frozen and sampled offline. Sampling runs with git-file so no draw is published to a tracker: the
 * recorded issue stands for draw #1.
 */
async function auditOn(ledger) {
  const dir = mkdtempSync(join(tmpdir(), "prrla-demo-audit-"));
  writeFileSync(join(dir, "changes.json"), JSON.stringify({ schema: "pr-rla/changes/v1", repo: "acme/widgets", defaultBranch: "main", changes }));
  writeFileSync(join(dir, "review-protocol.md"), "# Protocol\nA change fails if it introduces a user-visible bug or a security weakness.\n");
  let clock = Date.parse("2026-10-20T00:00:00Z");
  const run = async (args, fetch) => {
    const out = [];
    let code = 0;
    const ctx = () => nodeContext({ cwd: dir, env: {}, nowMs: () => clock, fetch, out: (l) => out.push(l), err: (l) => out.push(l), beacon: async (r) => (r === beacon.round && (await verifyQuicknetBeacon(beacon, r)) ? beacon : Promise.reject(new Error("no recorded beacon"))) });
    await buildProgram(ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", ...args]);
    return { code, out };
  };
  writeFileSync(join(dir, ".pr-rla.yml"), yml(ledger));
  await run(["register"], offline);
  clock = Date.parse("2026-10-20T12:00:00Z");
  await run(["freeze"], offline);
  clock = Date.parse("2026-10-21T01:00:00Z");
  writeFileSync(join(dir, ".pr-rla.yml"), yml("git-file"));
  await run(["sample"], offline);
  writeFileSync(join(dir, ".pr-rla.yml"), yml(ledger));
  return { dir, run };
}
console.log("  (a json-file audit of 200 changes per fixture, registered on github-issues, frozen and sampled offline)\n");
for (const [f, ledger] of [
  ["relabel-same-nodejs-node-67038.json", "{ use: github-issues, options: { repo: nodejs/node, labels: { pass: commit-queue-squash, fail: commit-queue-rebase } } }"],
  ["deleted-microsoft-vscode-345635.json", "{ use: github-issues, options: { repo: microsoft/vscode, labels: { pass: bug, fail: feature-request } } }"],
]) {
  const rec = fixture(f);
  const { dir, run } = await auditOn(ledger);
  mkdirSync(join(dir, "audit/2026-q3"), { recursive: true });
  // The recorded issue stands for the audit's draw #1, under the audit's registered protocol.
  const draws = JSON.parse(readFileSync(join(dir, "audit/2026-q3/draws.json"), "utf8"));
  const reg = JSON.parse(readFileSync(join(dir, "audit/2026-q3/registration.json"), "utf8"));
  const index = { ...rec.index, protocolSha256: reg.record.protocolSha256, issues: [{ ...rec.index.issues[0], draw: 1, changeId: draws.draws[0].changeId }] };
  writeFileSync(join(dir, "audit/2026-q3/ledger-index.json"), JSON.stringify(index));
  console.log(`$ pr-rla verify     (ledger: ${f.replace(".json", "")}, recorded)`);
  const { code, out } = await run(["verify"], replay(rec));
  // Check 7 and the verdict line only: checks 1–6 are the json-file audit's own.
  const i = out.findIndex((l) => l.startsWith("7. "));
  let j = i + 1;
  while (j < out.length && out[j].startsWith(" ")) j++;
  for (const l of out.slice(i, j)) console.log(`  ${l}`);
  console.log(`  ${out.at(-1)}`);
  console.log(`  (exit ${code})\n`);
}
