// Records real, read-only SCM API responses for provider tests (GitLab, Bitbucket Cloud, Gitea/Forgejo).
// Usage (after `npm run build`):
//   node scripts/record-fixture.mjs <provider|./path.mjs> <repo> <first-day> <last-day> <out.json> ['{"base_url":"…"}']
//   node scripts/record-fixture.mjs --cli <audit-dir> <out.json>
// --cli runs the CLI program itself (`pr-rla -C <audit-dir> freeze --dry-run`, the same commander
// program dist/cli.js runs) with a recording fetch, so one live dry run also produces the fixture.
// Days are inclusive UTC days. Responses are trimmed to the fields pr-rla reads and scrubbed:
// personal e-mail addresses become user-<hash>@example.invalid (bot addresses are kept, since bot
// detection reads them), comment bodies become "(comment)", system-note bodies are cut to 120 chars.
// Tokens are never recorded (only URLs and request-body hashes are).
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProgram } from "../dist/cli.js";
import { nodeContext } from "../dist/commands/context.js";
import { loadConfig } from "../dist/config.js";
import { createBroker } from "../dist/net/broker.js";
import { loadProviderDefinition } from "../dist/registry.js";

const cliMode = process.argv[2] === "--cli";
const [use, repo, first, last, out, optionsJson] = cliMode ? [] : process.argv.slice(2);
if (!cliMode && (!use || !repo || !first || !last || !out)) throw new Error("usage: record-fixture.mjs <provider> <repo> <first-day> <last-day> <out.json> [options-json] | --cli <audit-dir> <out.json>");
const options = optionsJson ? JSON.parse(optionsJson) : {};
const hash = (s) => createHash("sha256").update(s).digest("hex");
const BOT_EMAIL = /^((project|group)_?\d+_bot|service_account_)|@bots\.bitbucket\.org$|noreply\.github\.com$/;
const email = (e) => (!e || BOT_EMAIL.test(e) ? e : `user-${hash(e.toLowerCase()).slice(0, 8)}@example.invalid`);
const raw = (r) => r && r.replace(/<([^>]*)>/, (_, e) => `<${email(e)}>`);
const pick = (o, keys) => (o == null ? o : Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])));

// --- GitLab -----------------------------------------------------------------
const glUser = (u) => pick(u, ["id", "username", "bot"]);
const gitlab = (url, b) => {
  const p = new URL(url).pathname;
  if (p.endsWith("/api/graphql")) {
    const notes = (n) => ({ ...n, nodes: n.nodes.map((x) => ({ ...x, body: x.system ? x.body.slice(0, 120) : "(comment)" })) });
    const proj = b?.data?.project;
    if (proj?.mergeRequests) for (const m of proj.mergeRequests.nodes) m.notes = notes(m.notes);
    if (proj?.mergeRequest) proj.mergeRequest.notes = notes(proj.mergeRequest.notes);
    return b;
  }
  if (/\/merge_requests$/.test(p)) return b.map((m) => ({ ...pick(m, ["iid", "web_url", "state", "target_branch", "merged_at", "updated_at", "merge_commit_sha", "squash_commit_sha", "sha", "labels"]), author: glUser(m.author), merge_user: glUser(m.merge_user), merged_by: glUser(m.merged_by) }));
  if (/\/approvals$/.test(p)) return { approved_by: b.approved_by.map((a) => ({ user: glUser(a.user), approved_at: a.approved_at })) };
  if (/\/reviewers$/.test(p)) return b.map((r) => ({ user: glUser(r.user), state: r.state, created_at: r.created_at }));
  if (/\/merge_requests\/\d+\/commits$/.test(p)) return b.map((c) => ({ id: c.id }));
  if (/\/repository\/commits\/[0-9a-f]+\/merge_requests$/.test(p)) return b.map((m) => pick(m, ["iid", "state", "target_branch"]));
  if (/\/repository\/commits$/.test(p)) return b.map((c) => ({ ...pick(c, ["id", "web_url", "committed_date", "author_name", "parent_ids"]), author_email: email(c.author_email), stats: pick(c.stats, ["additions", "deletions"]) }));
  if (/\/repository\/branches\//.test(p)) return { commit: { id: b.commit.id } };
  if (/\/merge_requests\/\d+\/diffs$/.test(p)) return b.map((d) => ({ diff: d.diff }));
  if (/^\/api\/v4\/projects\/[^/]+$/.test(p)) return pick(b, ["id", "default_branch", "path_with_namespace"]);
  return b;
};

// --- Bitbucket Cloud ----------------------------------------------------------
const bbUser = (u) => (u ? pick(u, ["type", "uuid", "account_id", "nickname", "display_name", "kind"]) : u);
const bitbucket = (url, b) => {
  const p = new URL(url).pathname;
  const page = (vals) => ({ ...pick(b, ["next", "page", "pagelen"]), values: vals });
  if (/\/pullrequests$/.test(p))
    return page(
      b.values.map((x) => ({
        ...pick(x, ["id", "state", "updated_on", "created_on"]),
        destination: { branch: x.destination.branch },
        source: { commit: pick(x.source?.commit, ["hash"]) },
        merge_commit: pick(x.merge_commit, ["hash"]),
        author: bbUser(x.author),
        closed_by: bbUser(x.closed_by),
        links: { html: x.links?.html },
        participants: (x.participants ?? []).map((q) => ({ ...pick(q, ["role", "approved", "state", "participated_on"]), user: bbUser(q.user) })),
      })),
    );
  if (/\/pullrequests\/\d+$/.test(p)) return { ...pick(b, ["id", "state", "updated_on"]), participants: b.participants.map((x) => ({ ...pick(x, ["role", "approved", "state", "participated_on"]), user: bbUser(x.user) })) };
  if (/\/activity$/.test(p))
    return page(
      b.values.map((a) => {
        if (a.update) return { update: { ...pick(a.update, ["state", "date"]), author: bbUser(a.update.author) } };
        if (a.approval) return { approval: { date: a.approval.date, user: bbUser(a.approval.user) } };
        if (a.changes_requested) return { changes_requested: { date: a.changes_requested.date, user: bbUser(a.changes_requested.user) } };
        if (a.comment) return { comment: { created_on: a.comment.created_on, user: bbUser(a.comment.user) } };
        return Object.fromEntries(Object.keys(a).filter((k) => k !== "pull_request").map((k) => [k, {}]));
      }),
    );
  if (/\/diffstat/.test(p)) return page(b.values.map((x) => pick(x, ["lines_added", "lines_removed", "status"])));
  if (/\/commits(\/[^/]+)?$/.test(p) || /\/pullrequests\/\d+\/commits$/.test(p))
    return page(b.values.map((c) => ({ hash: c.hash, date: c.date, parents: c.parents.map((x) => ({ hash: x.hash })), message: (c.message ?? "").split("\n")[0], author: { raw: raw(c.author?.raw), user: bbUser(c.author?.user) }, links: { html: c.links?.html } })));
  if (/\/commit\/[^/]+$/.test(p)) return pick(b, ["hash", "date"]);
  if (/\/diffstat\//.test(p)) return b;
  if (/^\/2\.0\/repositories\/[^/]+\/[^/]+$/.test(p)) return { full_name: b.full_name, mainbranch: b.mainbranch, links: { html: b.links?.html } };
  return b;
};

// --- Gitea / Forgejo ------------------------------------------------------------
const gtUser = (u) => (u ? pick(u, ["id", "login"]) : u);
const gitea = (url, b) => {
  const p = new URL(url).pathname;
  const pr = (x) => ({ ...pick(x, ["number", "html_url", "state", "merged", "merged_at", "updated_at", "merge_commit_sha", "additions", "deletions", "changed_files"]), base: { ref: x.base.ref }, head: { sha: x.head?.sha }, user: gtUser(x.user), merged_by: gtUser(x.merged_by), labels: (x.labels ?? []).map((l) => ({ name: l.name })) });
  const commit = (c) => ({ sha: c.sha, html_url: c.html_url, parents: c.parents?.map((x) => ({ sha: x.sha })), author: gtUser(c.author), stats: c.stats ? pick(c.stats, ["additions", "deletions"]) : undefined, commit: { message: c.commit.message.split("\n")[0], author: { name: c.commit.author.name, email: email(c.commit.author.email), date: c.commit.author.date }, committer: { date: c.commit.committer.date } } });
  if (/\/pulls$/.test(p)) return b.map(pr);
  if (/\/pulls\/\d+$/.test(p)) return pr(b);
  if (/\/pulls\/\d+\/files$/.test(p)) return b.map((f) => pick(f, ["filename", "additions", "deletions"]));
  if (/\/reviews$/.test(p)) return b.map((r) => ({ ...pick(r, ["id", "state", "submitted_at", "dismissed", "stale", "official"]), user: gtUser(r.user) }));
  if (/\/pulls\/\d+\/commits$/.test(p) || /\/commits$/.test(p)) return b.map(commit);
  if (/\/branches\/[^/]+$/.test(p)) return { name: b.name, commit: { id: b.commit.id } };
  if (/^\/api\/v1\/repos\/[^/]+\/[^/]+$/.test(p)) return pick(b, ["full_name", "default_branch", "html_url"]);
  return b;
};

const scrubberFor = (u) => (/\/api\/v4\/|\/api\/graphql$/.test(new URL(u).pathname) ? gitlab : /api\.bitbucket\.org/.test(u) ? bitbucket : /\/api\/v1\//.test(u) ? gitea : (_u, b) => b);
const KEEP_HEADERS = ["link", "x-next-page", "x-total-count", "x-hasmore"];
const exchanges = [];
const recordingFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const res = await fetch(input, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (res.ok && typeof body === "object") body = scrubberFor(url)(url, body);
  const headers = Object.fromEntries(KEEP_HEADERS.filter((h) => res.headers.get(h) !== null).map((h) => [h, res.headers.get(h)]));
  const variables = typeof init?.body === "string" ? JSON.parse(init.body).variables : undefined;
  exchanges.push({ method: (init?.method ?? "GET").toUpperCase(), url, bodySha256: typeof init?.body === "string" ? hash(init.body) : null, ...(variables ? { variables } : {}), status: res.status, headers, response: body });
  if (exchanges.length % 25 === 0) console.error(`recorded ${exchanges.length} exchanges`);
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json", ...headers } });
};

const recordedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
const tokenEnv = Object.keys(process.env).filter((k) => /TOKEN/.test(k) && /GITLAB|BITBUCKET|GITEA|FORGEJO|CODEBERG/.test(k));
let fixture;
if (cliMode) {
  const [dir, cliOut] = process.argv.slice(3);
  const cwd = resolve(dir);
  const config = loadConfig(join(cwd, ".pr-rla.yml"));
  const tmp = join(tmpdir(), `pr-rla-record-${process.pid}.json`);
  let code = 0;
  console.error(`$ pr-rla -C ${dir} freeze --dry-run   (recording)`);
  await buildProgram(() => nodeContext({ cwd, fetch: recordingFetch }), (c) => (code = c)).parseAsync(["node", "pr-rla", "freeze", "--dry-run", "--out", tmp]);
  if (code !== 0) throw new Error(`freeze --dry-run exited ${code}`);
  const pop = JSON.parse(readFileSync(tmp, "utf8"));
  rmSync(tmp);
  const def = await loadProviderDefinition(config.provider.use, cwd);
  fixture = { out: cliOut, def, options: config.provider.options, repo: config.repo, window: { opensAt: config.window.opensAt, closesAt: config.window.closesAt }, label: `${config.window.start}..${config.window.end}`, changes: pop.listed, diagnostics: pop.diagnostics, defaultBranch: null };
} else {
  const def = await loadProviderDefinition(use, resolve("."));
  // Through the fetch broker, as in a real run: it retries (the built-ins make one attempt each) and paces.
  const fetchThroughBroker = createBroker({}, { fetch: recordingFetch, log: (m) => console.error(m) }).bind(`provider:${def.name}`);
  const provider = await def.create(options, { cwd: process.cwd(), env: process.env, log: (m) => console.error(m), fetch: fetchThroughBroker, now: () => recordedAt.getTime() });
  const window = { opensAt: `${first}T00:00:00Z`, closesAt: new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().replace(".000Z", "Z") };
  const result = await provider.listChanges({ repo, window, kinds: ["pull_request", "direct_push"] });
  fixture = { out, def, options, repo, window, label: `${first}..${last}`, changes: result.changes, diagnostics: result.diagnostics ?? [], defaultBranch: result.defaultBranch };
}
const { def, window } = fixture;
const result = { changes: fixture.changes, diagnostics: fixture.diagnostics, defaultBranch: fixture.defaultBranch };
const header = {
  description: `Real ${def.name} API responses for ${fixture.repo}, window ${fixture.label} (UTC), recorded read-only${tokenEnv.length ? " with a token" : " without a token"}${cliMode ? " during a CLI freeze --dry-run" : ""}. Trimmed to the fields pr-rla reads; personal e-mail addresses and comment bodies scrubbed.`,
  provider: def.name,
  recordedAt: recordedAt.toISOString(),
  options: fixture.options,
  window,
  repo: fixture.repo,
  expected: {
    ids: result.changes.map((c) => c.id).sort(),
    pullRequests: result.changes.filter((c) => c.kind === "pull_request").length,
    directPushes: result.changes.filter((c) => c.kind === "direct_push").map((c) => c.id).sort(),
    ...(result.defaultBranch ? { defaultBranch: result.defaultBranch } : {}),
    diagnostics: result.diagnostics ?? [],
  },
};
// One compact line per exchange keeps the file small and its diffs readable.
const text = JSON.stringify({ ...header, exchanges: [] }, null, 1).replace(/"exchanges": \[\]\n}$/, `"exchanges": [\n${exchanges.map((e) => JSON.stringify(e)).join(",\n")}\n ]\n}`);
writeFileSync(fixture.out, `${text}\n`);
console.error(`recorded ${exchanges.length} exchanges; ${result.changes.length} changes (${result.changes.filter((c) => c.kind === "direct_push").length} direct pushes) -> ${fixture.out}`);
