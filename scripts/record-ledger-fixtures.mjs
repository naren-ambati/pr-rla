// Records the issue-ledger fixtures from PUBLIC trackers, read-only (FR4.7; D8; AS-04).
// Usage (after `npm run build`; a token only raises GitHub's rate limit, nothing is written):
//   GITHUB_TOKEN=$(gh auth token) node scripts/record-ledger-fixtures.mjs [github|evidence|gitlab|all]
//
// Every request goes through the fetch broker in READ-ONLY mode, so a write could not be sent even
// by mistake (ReadOnlyViolation before the transport). Responses are trimmed to the fields pr-rla
// reads; no request header (token) is recorded. Each fixture says `"source": "recorded"`.
//
// - github:   github-issues read against public issue timelines, mapped to verdict labels.
// - evidence: the raw observations that settle the design's unverified items (REST vs GraphQL label
//             names after a rename; performed_via_github_app on label events).
// - gitlab:   GitLab's own rendering of a scoped-label swap (resource_label_events need a token).
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import githubIssues from "../dist/ledgers/github-issues/index.js";
import { createBroker } from "../dist/net/broker.js";

const which = process.argv[2] ?? "all";
const out = (p) => new URL(`../test/fixtures/ledgers/${p}`, import.meta.url);
const hash = (s) => createHash("sha256").update(s).digest("hex");
const token = process.env.GITHUB_TOKEN;
const pick = (o, keys) => (o == null ? o : Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])));
const recordedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();

// --- trimming ------------------------------------------------------------------
const ghUser = (u) => (u ? pick(u, ["login", "id", "type"]) : null);
function trimGitHub(url, body) {
  const p = new URL(url).pathname;
  if (/\/issues\/\d+\/events$/.test(p) || /\/issues\/events$/.test(p))
    return body.map((e) => ({ ...pick(e, ["id", "event", "created_at"]), actor: ghUser(e.actor), ...(e.label ? { label: { name: e.label.name } } : {}), performed_via_github_app: e.performed_via_github_app ? pick(e.performed_via_github_app, ["slug", "name"]) : null, ...(e.issue ? { issue: { number: e.issue.number, pull_request: !!e.issue.pull_request } } : {}) }));
  if (/\/issues\/\d+$/.test(p)) return { ...pick(body, ["number", "id", "node_id", "html_url", "created_at", "repository_url", "state"]), labels: (body.labels ?? []).map((l) => ({ name: l.name })), body: null };
  if (/\/labels\/[^/]+$/.test(p)) return pick(body, ["id", "node_id", "name"]);
  if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return pick(body, ["id", "full_name"]);
  return body;
}

// --- a recording transport under a read-only broker --------------------------------
function recorder() {
  const exchanges = [];
  const transport = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const res = await fetch(input, init);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (res.ok && typeof body === "object" && /api\.github\.com/.test(url)) body = trimGitHub(url, body);
    const headers = Object.fromEntries(["link"].filter((h) => res.headers.get(h) !== null).map((h) => [h, res.headers.get(h)]));
    const reqBody = typeof init?.body === "string" ? init.body : null;
    exchanges.push({ method: (init?.method ?? "GET").toUpperCase(), url, bodySha256: reqBody ? hash(reqBody) : null, ...(reqBody ? { variables: JSON.parse(reqBody).variables } : {}), status: res.status, headers, response: body });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json", ...headers } });
  };
  const broker = createBroker({ mode: "read-only" }, { fetch: transport, log: (m) => console.error(m) });
  return { exchanges, broker };
}

function writeFixture(path, header, exchanges) {
  const text = JSON.stringify({ ...header, exchanges: [] }, null, 1).replace(/"exchanges": \[\]\n}$/, `"exchanges": [\n${exchanges.map((e) => JSON.stringify(e)).join(",\n")}\n ]\n}`);
  writeFileSync(out(path), `${text}\n`);
  console.error(`wrote ${path}: ${exchanges.length} exchanges`);
}

const auth = token ? { authorization: `Bearer ${token}` } : {};
async function ghGet(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", ...auth } });
  return { status: r.status, body: await r.json() };
}

// --- github: timelines read by github-issues ----------------------------------------
const GITHUB = [
  {
    file: "github/relabel-same-nodejs-node-67038.json",
    case: "relabel-same",
    repo: "nodejs/node",
    labels: { pass: "commit-queue-squash", fail: "commit-queue-rebase" },
    issues: [67038],
    why: "A maintainer applied commit-queue-squash, removed it, and applied it again: mapped to pass, the remove and re-add is a WARN relabel (same verdict), and the first event counts.",
  },
  {
    file: "github/first-label-microsoft-vscode-345779.json",
    case: "first-label",
    repo: "microsoft/vscode",
    labels: { pass: "bug", fail: "feature-request" },
    issues: [345779],
    why: "A maintainer applied bug once (later labels are other labels): mapped to pass, a clean first verdict, PASS.",
  },
  {
    file: "github/app-applied-microsoft-vscode-345652.json",
    case: "app-applied",
    repo: "microsoft/vscode",
    labels: { pass: "unreleased", fail: "insiders-released" },
    issues: [345652],
    why: "The vs-code-engineering GitHub App applied unreleased. REST reports actor.type Bot and performed_via_github_app null: the bot rule, not the app field, keeps it from counting.",
  },
  {
    file: "github/deleted-microsoft-vscode-345635.json",
    case: "deletion",
    repo: "microsoft/vscode",
    labels: { pass: "bug", fail: "feature-request" },
    issues: [345635],
    issueMeta: { 345635: { node_id: "unknown (deleted)", html_url: "https://github.com/microsoft/vscode/issues/345635", created_at: "2026-11-02T19:45:30Z" } },
    why: "Issue number 345635 lies between #345634 (2026-11-02T19:45:30Z) and #345636 (20:00:15Z); discussions are disabled; REST, GraphQL and the web all answer not found. A deleted issue: GitHub answers 404 (not 410) for it. Its own creation time cannot be read; the index carries its predecessor's.",
  },
  {
    file: "github/label-renamed-rust-lang-rust-30010.json",
    case: "label-rename",
    repo: "rust-lang/rust",
    labels: { pass: "I-enhancement", fail: "C-bug" },
    issues: [30010],
    why: "I-enhancement was applied in 2015 and later renamed C-enhancement. REST events still say I-enhancement, and the name no longer exists: FAIL.",
  },
  {
    file: "github/label-renamed-and-reused-rust-lang-rust-30003.json",
    case: "label-rename",
    repo: "rust-lang/rust",
    labels: { pass: "T-libs", fail: "C-bug" },
    labelIds: { pass: "211668062" },
    issues: [30003],
    why: "T-libs (id 211668062) was applied and removed in 2017, then renamed T-libs-api; a new label (id 2011781731) took the name T-libs. By name alone the old events look like the new label's; the id kept in the index tells them apart: FAIL. C-bug, applied after T-libs was removed, is mapped to fail: a WARN relabel.",
  },
];

async function recordGitHub() {
  // Optional 4th argument: only the specs whose file name contains it (re-recording one fixture, e.g. `github deleted`).
  for (const spec of GITHUB.filter((g) => !process.argv[3] || g.file.includes(process.argv[3]))) {
    const labels = {};
    for (const role of ["pass", "fail"]) {
      const l = await ghGet(`/repos/${spec.repo}/labels/${encodeURIComponent(spec.labels[role])}`);
      labels[role] = { name: spec.labels[role], id: spec.labelIds?.[role] ?? (l.status === 200 ? String(l.body.id) : null) };
    }
    labels.draw = { name: "pr-rla:draw", id: null };
    const issues = [];
    for (const [k, n] of spec.issues.entries()) {
      const meta = spec.issueMeta?.[n] ?? (await ghGet(`/repos/${spec.repo}/issues/${n}`)).body;
      // P1: an issue is named by its numeric id (the node id can change format).
      issues.push({ draw: k + 1, changeId: `github:${spec.repo}#${n}`, number: n, id: meta.id === undefined ? meta.node_id : String(meta.id), url: meta.html_url, createdAt: meta.created_at });
    }
    // These are issues pr-rla did not open: the test-only option foreign_issues reads them (P1: never an index field).
    const index = { schema: "pr-rla/ledger-index/v1", ledger: "github-issues", tracker: `https://api.github.com/repos/${spec.repo}`, window: "recorded", protocolSha256: "0".repeat(64), registrationSha256: null, labels, issues, repeats: [] };
    const windowDir = mkdtempSync(join(tmpdir(), "prrla-record-"));
    writeFileSync(join(windowDir, "ledger-index.json"), JSON.stringify(index, null, 2));
    const { exchanges, broker } = recorder();
    const ledger = await githubIssues.create({ repo: spec.repo, labels: spec.labels, foreign_issues: true }, { cwd: windowDir, windowDir, env: token ? { GITHUB_TOKEN: token } : {}, log: (m) => console.error(m), fetch: broker.bind("ledger:github-issues") });
    const verdicts = await ledger.readVerdicts();
    const integrity = await ledger.verifyIntegrity();
    const history = await ledger.readHistory();
    writeFixture(spec.file, {
      description: `Public ${spec.repo} issue timeline(s) ${spec.issues.map((n) => `#${n}`).join(", ")}, recorded read-only through github-issues${token ? " with a token" : ""}. Trimmed to the fields pr-rla reads; no request header recorded. ${spec.why}`,
      source: "recorded",
      tracker: "github",
      case: spec.case,
      recordedAt,
      options: { repo: spec.repo, labels: spec.labels, foreign_issues: true },
      index,
      observed: { verdicts, integrity, history },
    }, exchanges);
  }
}

// --- evidence: the unverified items, as raw responses ------------------------------
const RENAME_QUERY = `query($o:String!,$n:String!,$i:Int!){repository(owner:$o,name:$n){issueOrPullRequest(number:$i){... on Issue{timelineItems(first:100,itemTypes:[LABELED_EVENT,UNLABELED_EVENT]){nodes{__typename ... on LabeledEvent{createdAt actor{login} label{id name}} ... on UnlabeledEvent{createdAt actor{login} label{id name}}}}}}}}`;
async function recordEvidence() {
  if (!token) throw new Error("evidence needs a token: GitHub's GraphQL API refuses anonymous queries");
  {
    const { exchanges, broker } = recorder();
    const f = broker.bind("ledger:github-issues");
    const h = { accept: "application/vnd.github+json", authorization: `Bearer ${token}` };
    for (const n of [30003, 30010]) {
      await f(`https://api.github.com/repos/rust-lang/rust/issues/${n}/events?per_page=100`, { headers: h, destination: "scm" });
      await f("https://api.github.com/graphql", { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ query: RENAME_QUERY, variables: { o: "rust-lang", n: "rust", i: n } }), destination: "scm" });
    }
    for (const l of ["T-libs", "T-libs-api", "I-enhancement", "C-enhancement"]) await f(`https://api.github.com/repos/rust-lang/rust/labels/${l}`, { headers: h, destination: "scm" });
    writeFixture("github/evidence-label-rename-rust-lang-rust.json", {
      description: "Settles 'GitHub REST keeps a label's original name after a rename': rust-lang/rust #30003 and #30010, REST issue events next to GraphQL LabeledEvent/UnlabeledEvent for the same events, and the labels as they are now. Recorded read-only with a token (GraphQL needs one).",
      source: "recorded",
      recordedAt,
    }, exchanges);
  }
  {
    const { exchanges, broker } = recorder();
    const f = broker.bind("ledger:github-issues");
    const h = { accept: "application/vnd.github+json", authorization: `Bearer ${token}` };
    for (const page of [1, 2, 3]) await f(`https://api.github.com/repos/github/gh-aw/issues/events?per_page=100&page=${page}`, { headers: h, destination: "scm" });
    writeFixture("github/evidence-performed-via-app-github-gh-aw.json", {
      description: "Settles 'whether GitHub fills performed_via_github_app on label events': three pages of github/gh-aw repository issue events. Label events by GitHub Apps carry actor.type Bot and performed_via_github_app null; the field is filled on other events (copilot_work_started/finished, with a User actor). Recorded read-only with a token.",
      source: "recorded",
      recordedAt,
    }, exchanges);
  }
}

// --- gitlab: a scoped-label swap as GitLab renders it ---------------------------------
async function recordGitLab() {
  const url = "https://gitlab.com/gitlab-org/gitlab/-/issues/633165/discussions.json";
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const discussions = await r.json();
  const names = (html) => [...html.matchAll(/label_name=([^"&]+)/g)].map((m) => decodeURIComponent(m[1].replace(/\+/g, " ")));
  const notes = discussions
    .flatMap((d) => d.notes)
    .filter((n) => n.system && /label/.test(n.note))
    .map((n) => {
      const [added, removed] = n.note_html.split(/ and removed /);
      return { id: n.id, created_at: n.created_at, author: n.author.username, system: n.system, note: n.note, labels: { added: /^<p[^>]*>added /.test(n.note_html) ? names(added) : [], removed: /removed/.test(n.note) ? names(removed ?? added) : [] } };
    });
  const probe = await fetch("https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab/issues/633165/resource_label_events");
  writeFileSync(
    out("gitlab/scoped-swap-gitlab-org-gitlab-633165.json"),
    `${JSON.stringify({
      description: "GitLab's own rendering of gitlab-org/gitlab#633165's label history (the web discussions.json, read anonymously): each 'added … label and removed … label' system note is synthesized from resource_label_events that share one user and one instant, so a scoped-label swap is one add and one remove at the same time. The REST resource_label_events themselves answered HTTP " + probe.status + " without a token, so their exact JSON stays unverified.",
      source: "recorded",
      recordedAt,
      url,
      resourceLabelEventsAnonymousStatus: probe.status,
      notes,
    }, null, 1)}\n`,
  );
  console.error(`wrote gitlab/scoped-swap-gitlab-org-gitlab-633165.json: ${notes.length} label notes`);
}

if (which === "github" || which === "all") await recordGitHub();
if (which === "evidence" || which === "all") await recordEvidence();
if (which === "gitlab" || which === "all") await recordGitLab();
