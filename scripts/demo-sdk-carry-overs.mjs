// The U3 demo, offline (after `npm run build`): the registered stratum fields on recorded real data.
//   node scripts/demo-sdk-carry-overs.mjs
// 1. gitlab-org/cli, October 2026 (recorded through the CLI's freeze --dry-run): bots: ["gitlab-bot"].
// 2. atlassian/bamboo-specs, 2026-10-06 (a release branch merged by a push): direct_push_via_merge.
// Every request is served from the recordings; an unrecorded request throws, so nothing reaches the network.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { summarizePopulation } from "../dist/commands/freeze.js";
import { buildPopulation } from "../dist/core/population.js";
import { normalizeSelector } from "../dist/core/selector.js";
import { BitbucketCloudProvider } from "../dist/providers/bitbucket-cloud/index.js";
import { GitLabProvider } from "../dist/providers/gitlab/index.js";

const fixture = (path) => JSON.parse(readFileSync(new URL(`../test/fixtures/${path}`, import.meta.url), "utf8"));
const replay = (rec) => {
  const queue = rec.exchanges.map((e) => ({ e, used: false }));
  const key = (b) => (typeof b === "string" ? createHash("sha256").update(b).digest("hex") : null);
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const hit = queue.find((q) => !q.used && q.e.method === method && q.e.url === url && q.e.bodySha256 === key(init?.body));
    if (!hit) throw new Error(`unrecorded request ${method} ${url}`);
    hit.used = true;
    return new Response(JSON.stringify(hit.e.response), { status: hit.e.status, headers: { "content-type": "application/json", ...hit.e.headers } });
  };
};
// A CLI-mode recording re-scans its listing from the walk's own start: the latest updated_after plus 60 s.
const walkClock = (rec) => Date.parse(rec.exchanges.map((e) => /[?&]updated_after=([^&]+)/.exec(e.url)?.[1]).filter(Boolean).map(decodeURIComponent).sort().at(-1)) + 60_500;
const ctx = (rec, now) => ({ cwd: ".", env: {}, log: () => {}, fetch: replay(rec), now: () => now });

async function show(title, provider, rec, raw) {
  const selector = normalizeSelector(raw);
  const pop = await buildPopulation(provider, { repo: rec.repo, window: rec.window, selector, cutoffIso: rec.recordedAt });
  console.log(`   ${title}`);
  for (const line of summarizePopulation(pop, selector, pop.listed.defaultBranch).lines) console.log(`   ${line}`);
  console.log(`     N = ${pop.entries.length}${pop.entries.length && pop.entries.length <= 5 ? `: ${pop.entries.map((e) => e.id.replace(/^[^:]+:[^#@]+/, "")).join(", ")}` : ""}`);
  return pop;
}

console.log("1. gitlab-org/cli, October 2026 (recorded 2026-11-04): GitLab reports gitlab-bot as bot: false");
const cli = fixture("gitlab/gitlab-org-cli-2026-10.json");
const stratum = { kinds: ["pull_request", "direct_push"], authors: "any", unreviewed: "no-human-review", merged_by: "any", max_changed_lines: null };
await show('selector.bots: []', new GitLabProvider(cli.options, ctx(cli, walkClock(cli))), cli, stratum);
await show('selector.bots: ["gitlab-bot"]', new GitLabProvider(cli.options, ctx(cli, walkClock(cli))), cli, { ...stratum, bots: ["gitlab-bot"] });
await show('selector.bots: ["gitlab-bot"], max_changed_lines: 200 (the example\'s stratum)', new GitLabProvider(cli.options, ctx(cli, walkClock(cli))), cli, { ...stratum, bots: ["gitlab-bot"], max_changed_lines: 200 });

console.log("\n2. atlassian/bamboo-specs, 2026-10-06 (recorded 2026-11-04): Tardigrade's merge of the 13.0 branch, pushed to master");
const bb = fixture("bitbucket-cloud/bamboo-specs-2026-10-06.json");
const bbStratum = { kinds: ["pull_request", "direct_push"], authors: "any", unreviewed: "no-human-review" };
const inc = await show("direct_push_via_merge: include (the default)", new BitbucketCloudProvider(bb.options, ctx(bb, Date.parse(bb.recordedAt))), bb, { ...bbStratum, direct_push_via_merge: "include" });
for (const v of inc.viaMerge) console.log(`     diagnostic: direct pushes that arrived through merge ${v.merge.slice(0, 12)}… (a non-first parent): ${v.count}`);
await show("direct_push_via_merge: exclude", new BitbucketCloudProvider(bb.options, ctx(bb, Date.parse(bb.recordedAt))), bb, { ...bbStratum, direct_push_via_merge: "exclude" });
console.log(`     head walked: ${inc.headSha} (recorded in the manifest; verify passes it back as ListChangesRequest.head)`);
