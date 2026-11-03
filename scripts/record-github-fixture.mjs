// Records real, read-only GitHub API responses for the provider tests.
// Usage: GITHUB_TOKEN=$(gh auth token) node scripts/record-github-fixture.mjs <owner/repo> <YYYY-MM-DD> <out.json>
// REST pull objects are trimmed to the fields pr-rla reads; GraphQL responses are stored as returned.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createBroker } from "../dist/net/broker.js";
import github from "../dist/providers/github/index.js";

const [repo, day, out] = process.argv.slice(2);
if (!repo || !day || !out) throw new Error("usage: record-github-fixture.mjs <owner/repo> <YYYY-MM-DD> <out.json>");
const exchanges = [];
const sha = (b) => (typeof b === "string" ? createHash("sha256").update(b).digest("hex") : null);
const trimPull = (p) => ({ number: p.number, merged_at: p.merged_at, updated_at: p.updated_at, base: { ref: p.base.ref }, user: { login: p.user?.login, type: p.user?.type }, merge_commit_sha: p.merge_commit_sha, html_url: p.html_url });
const recordingFetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let body = await res.json();
  if (/\/pulls\?/.test(url) && Array.isArray(body)) body = body.map(trimPull);
  if (/\/search\/issues/.test(url)) body = { total_count: body.total_count };
  const headers = {};
  if (res.headers.get("link")) headers.link = res.headers.get("link");
  let variables;
  if (typeof init?.body === "string") variables = JSON.parse(init.body).variables;
  exchanges.push({ method: (init?.method ?? "GET").toUpperCase(), url, bodySha256: sha(init?.body), ...(variables ? { variables } : {}), status: res.status, headers, response: body });
  return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json", ...headers } });
};
const recordedAt = new Date();
const opts = { page_size: 30, batch_size: 10, history_page_size: 40 };
// Through the fetch broker, as in a real run: it retries (the provider makes one attempt each) and paces.
const fetchThroughBroker = createBroker({}, { fetch: recordingFetch, log: (m) => console.error(m) }).bind("provider:github");
const provider = github.create(opts, { cwd: process.cwd(), env: process.env, log: (m) => console.error(m), fetch: fetchThroughBroker, now: () => recordedAt.getTime() });
const window = { opensAt: `${day}T00:00:00Z`, closesAt: new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().replace(".000Z", "Z") };
const result = await provider.listChanges({ repo, window, kinds: ["pull_request", "direct_push"] });
const native = await provider.nativeCounts({ repo, window, kinds: ["pull_request"] }, { authors: ["copilot-swe-agent[bot]"] });
writeFileSync(
  out,
  JSON.stringify(
    {
      description: `Real GitHub API responses for ${repo}, window ${day} (UTC), recorded read-only with page_size=${opts.page_size}, batch_size=${opts.batch_size}, history_page_size=${opts.history_page_size}. REST pull objects trimmed to the fields pr-rla reads.`,
      recordedAt: recordedAt.toISOString(),
      options: opts,
      window,
      repo,
      expected: {
        ids: result.changes.map((c) => c.id).sort(),
        pullRequests: result.changes.filter((c) => c.kind === "pull_request").length,
        directPushes: result.changes.filter((c) => c.kind === "direct_push").map((c) => c.id),
        diagnostics: result.diagnostics,
        nativeCounts: native,
      },
      exchanges,
    },
    null,
    1,
  ),
);
console.error(`recorded ${exchanges.length} exchanges; ${result.changes.length} changes (${result.changes.filter((c) => c.kind === "direct_push").length} direct pushes)`);
