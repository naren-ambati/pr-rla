// Records what `describeChange` reads for every issued draw of an audit built on GitHub data, read-only:
// the built-in GitHub provider's describeChange, through pr-rla's fetch broker in READ-ONLY mode (it
// refuses any request that is not a read), with a token from the environment (GITHUB_TOKEN).
// Writes (1) the exchanges, trimmed to the fields pr-rla reads, as a replayable recording, and (2) each
// change's description into the audit's changes.json `descriptions`, for the json-file provider.
// E-mail addresses in recorded text become user-<hash>@example.invalid (GitHub noreply and the reserved
// example domains are kept).
//
// The recording keeps the exchanges of the changes named by --keep (all of them without it).
// --only <id,...> describes only those changes of the issued draws. --merge keeps the descriptions changes.json
// already holds (recorded earlier, for other draws) and adds or replaces the ones recorded now; without it,
// changes.json holds exactly the ones recorded now.
//
// Usage: GITHUB_TOKEN=$(gh auth token) node scripts/record-draw-descriptions.mjs <audit dir> <recording.json> [--keep <id,id,...>] [--only <id,id,...>] [--merge]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAuditContext, openProvider } from "../dist/api/context.js";
import { changeDescriptionProblems } from "../dist/sdk/provider.js";

const [dirArg, outArg, ...flags] = process.argv.slice(2);
const flag = (name) => {
  const i = flags.indexOf(name);
  if (i < 0) return null;
  if (!flags[i + 1] || flags[i + 1].startsWith("--")) throw new Error(`${name} needs a comma-separated list of change ids`);
  return new Set(flags[i + 1].split(","));
};
if (!dirArg || !outArg || flags.some((f, i) => f.startsWith("--") && !["--keep", "--only", "--merge"].includes(f) && !(i > 0 && ["--keep", "--only"].includes(flags[i - 1]))))
  throw new Error("usage: record-draw-descriptions.mjs <audit dir> <recording.json> [--keep <id,id,...>] [--only <id,id,...>] [--merge]");
const keep = flag("--keep");
const only = flag("--only");
const merge = flags.includes("--merge");
const dir = resolve(dirArg);
const draws = JSON.parse(readFileSync(join(dir, "audit", "2026-q3", "draws.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(dir, "audit", "2026-q3.manifest.json"), "utf8"));
const issued = draws.draws.filter((d) => d.draw <= draws.issued);
const ids = [...new Set(issued.map((d) => d.changeId))].filter((id) => !only || only.has(id));
if (only && ids.length !== only.size) throw new Error(`--only names changes that no issued draw names: ${[...only].filter((id) => !ids.includes(id)).join(", ")}`);
const byId = new Map(manifest.changes.map((c) => [c.id, c]));

const KEEP = /(noreply\.github\.com|@example\.(com|org|net|invalid))$/i;
const scrubText = (s) => (typeof s === "string" ? s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (e) => (KEEP.test(e) ? e : `user-${createHash("sha256").update(e.toLowerCase()).digest("hex").slice(0, 8)}@example.invalid`)) : s);
const trim = (url, b) => {
  if (/\/pulls\/\d+$/.test(url)) return { number: b.number, title: scrubText(b.title), body: scrubText(b.body), head: { sha: b.head.sha }, base: { sha: b.base.sha }, changed_files: b.changed_files, html_url: b.html_url };
  if (/\/pulls\/\d+\/files/.test(url)) return b.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, ...(f.patch !== undefined ? { patch: scrubText(f.patch) } : {}), ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}) }));
  if (/\/commits\/[0-9a-f]{40}$/.test(url)) return { sha: b.sha, commit: { message: scrubText(b.commit.message) }, parents: (b.parents ?? []).map((p) => ({ sha: p.sha })), stats: b.stats, files: (b.files ?? []).map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, ...(f.patch !== undefined ? { patch: scrubText(f.patch) } : {}), ...(f.previous_filename ? { previous_filename: f.previous_filename } : {}) })) };
  if (/\/contents\/(.+\/)?\.gitattributes\?/.test(url)) return b.type ? { type: b.type, encoding: b.encoding, content: b.content, path: b.path } : b;
  if (/\/check-runs/.test(url)) return { total_count: b.total_count, check_runs: b.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, html_url: r.html_url })) };
  if (/\/status\?/.test(url)) return { state: b.state, total_count: b.total_count, statuses: b.statuses.map((s) => ({ context: s.context, state: s.state, target_url: s.target_url })) };
  return b;
};

const exchanges = [];
let recordingFor = null;
const recordingFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error(`refusing ${method} ${url}: this recorder reads only`);
  const res = await fetch(input, init);
  const text = await res.text();
  let body;
  try {
    body = trim(url, JSON.parse(text));
  } catch {
    body = { message: text.slice(0, 200) };
  }
  const headers = {};
  if (res.headers.get("link")) headers.link = res.headers.get("link");
  exchanges.push({ method, url, bodySha256: null, status: res.status, headers, response: body, for: recordingFor });
  return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json", ...headers } });
};

const recordedAt = new Date();
const actx = createAuditContext({ mode: "read-only", env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN }, fetch: recordingFetch, log: (l) => console.error(l) });
const provider = await openProvider(actx, { use: "github", options: {} }, dir);
const descriptions = {};
for (const id of ids) {
  const change = byId.get(id);
  recordingFor = id;
  const d = await provider.describeChange(change);
  const problems = changeDescriptionProblems(d, id);
  if (problems.length) throw new Error(`${id}: ${problems.join("; ")}`);
  descriptions[id] = d;
  console.error(`${id}: ${d.files.length} file(s), ${d.checks.length} check(s)`);
}
const kept = keep ? ids.filter((id) => keep.has(id)) : ids;
const changesFile = join(dir, "changes.json");
const changes = JSON.parse(readFileSync(changesFile, "utf8"));
const distinct = new Set(issued.map((d) => d.changeId)).size;
const now = `GitHub API, read-only (pr-rla's broker in read-only mode, GETs only), ${recordedAt.toISOString()}: describeChange for ${only ? `${ids.length} of the ${distinct}` : `the ${distinct}`} changes of the ${draws.issued} issued draws; e-mail addresses in recorded text replaced by user-<hash>@example.invalid`;
changes.descriptions = merge ? { ...(changes.descriptions ?? {}), ...descriptions } : descriptions;
changes.recordedDescriptions = merge && changes.recordedDescriptions ? `${changes.recordedDescriptions}. Then: ${now}` : now;
writeFileSync(changesFile, JSON.stringify(changes));
writeFileSync(
  resolve(outArg),
  JSON.stringify(
    {
      description: `Real GitHub API responses for describeChange on ${keep || only ? `${kept.length} of the ${distinct}` : `the ${ids.length}`} changes of the issued draws of test/fixtures/audits/gh-aw-q3-recorded (github/gh-aw, Q3 2026 Copilot stratum), recorded read-only. Trimmed to the fields pr-rla reads; e-mail addresses in recorded text replaced by user-<hash>@example.invalid.${keep ? ` Kept: ${kept.length} of the ${ids.length} changes recorded in this run (draws ${issued.filter((d) => keep.has(d.changeId)).map((d) => d.draw).join(", ")}).` : ""}`,
      source: "recorded",
      recordedAt: recordedAt.toISOString(),
      changes: kept,
      exchanges: exchanges.filter((e) => !keep || keep.has(e.for)).map(({ for: _for, ...e }) => e),
    },
    null,
    1,
  ),
);
console.error(`recorded ${exchanges.length} exchanges for ${ids.length} changes`);
