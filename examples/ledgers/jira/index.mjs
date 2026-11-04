// pr-rla-ledger-jira: an example external pr-rla ledger for Jira Cloud (FR4.5).
//
// Draws become Jira issues; the verdict is a single-select custom field ("pr-rla verdict", values
// pass / fail), read from each issue's paged changelog (GET /rest/api/3/issue/{key}/changelog), never
// from the field's current value. Labels are not supported: Jira reports a label change as whole old
// and new sets, which would have to be diffed.
//
// It imports only the public SDK (pr-rla/ledger) and speaks the fetch-broker contract (destination,
// idempotent), so the broker retries its reads and never retries its writes after a 5xx. Lock it with
// `pr-rla plugin add`; it then runs in pr-rla's plugin host (isolated: no file writes, so it keeps its
// index through ctx.index, which pr-rla writes to ledger-index.json for it).
//
//   ledger:
//     use: pr-rla-ledger-jira                     # or ./examples/ledgers/jira/index.mjs
//     options: { base_url: https://acme.atlassian.net, project: AUD, field: customfield_10050 }
//
// Credentials: JIRA_EMAIL and JIRA_TOKEN (an Atlassian API token), sent as
// `Authorization: prrla-basic:JIRA_EMAIL:JIRA_TOKEN`: the broker builds the Basic header for the
// host of options.base_url only (an https site; hostFromOption below). Without them the ledger reads
// anonymously (public projects).
//
// Jira deletes an issue's changelog with the issue, and admins can delete issues: run
// `pr-rla checkpoint` after verdicts; checkpoints are not optional with Jira.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { analyzeDrawHistory, defineLedger } from "pr-rla/ledger";

const NAME = "jira";
const INDEX = "ledger-index.json";
const DRAW_LABEL = "pr-rla-draw";

function settings(o) {
  if (!o || typeof o.base_url !== "string" || !/^https?:\/\/[^/]+\/?$/.test(o.base_url)) throw new Error(`jira: options.base_url must be the site root, e.g. https://acme.atlassian.net`);
  if (typeof o.project !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(o.project)) throw new Error(`jira: options.project must be a project key, e.g. AUD`);
  if (typeof o.field !== "string" || !/^customfield_\d+$/.test(o.field)) throw new Error(`jira: options.field must be the verdict field's id, e.g. customfield_10050`);
  const base = o.base_url.replace(/\/+$/, "");
  return { base, host: new URL(base).host, project: o.project, field: o.field, values: { pass: o.values?.pass ?? "pass", fail: o.values?.fail ?? "fail" }, issueType: o.issue_type ?? "Task" };
}

/** Jira times carry an offset and milliseconds (2023-07-28T03:43:22.045-0700): UTC, with milliseconds kept. */
export function isoUtc(t) {
  const ms = Date.parse(String(t).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(ms)) throw new Error(`jira: invalid time ${t}`);
  const iso = new Date(ms).toISOString();
  return iso.endsWith(".000Z") ? iso.replace(".000Z", "Z") : iso;
}

/** An Atlassian account: humans by accountId, app accounts as `<accountId>[bot]` (the SDK's bot form). */
export function jiraActor(a) {
  if (!a) return { login: "ghost", kind: "human" };
  const bot = a.accountType === "app";
  return { login: bot ? `${a.accountId}[bot]` : a.accountId, kind: bot ? "bot" : "human", id: a.accountId };
}

/**
 * The verdict-field changes in one changelog page, as adds and removes. A single-select change from
 * A to B is a remove of A and an add of B at the same instant.
 */
export function fieldEvents(histories, s) {
  const out = [];
  for (const h of histories) {
    h.items.forEach((it, n) => {
      if (it.fieldId !== s.field && !(it.fieldId === undefined && it.field === s.field)) return;
      const verdictOf = (v) => (v === s.values.pass ? "pass" : v === s.values.fail ? "fail" : null);
      const base = { at: isoUtc(h.created), actor: jiraActor(h.author) };
      const from = verdictOf(it.fromString);
      const to = verdictOf(it.toString);
      if (from) out.push({ ...base, id: `${h.id}:${n}:remove`, action: "remove", verdict: from });
      if (to) out.push({ ...base, id: `${h.id}:${n}:add`, action: "add", verdict: to });
    });
  }
  return out;
}

class JiraLedger {
  apiVersion = 1;
  name = NAME;

  constructor(options, ctx) {
    this.s = settings(options);
    this.ctx = ctx;
    this.auth = ctx.env.JIRA_EMAIL && ctx.env.JIRA_TOKEN ? { authorization: "prrla-basic:JIRA_EMAIL:JIRA_TOKEN" } : {};
    this.snapshot = null;
  }

  async request(method, path, body, accept = []) {
    const write = method !== "GET";
    const res = await this.ctx.fetch(`${this.s.base}${path}`, {
      method,
      headers: { accept: "application/json", ...this.auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      destination: "scm",
      idempotent: !write,
      // Reads: a truncated body is retried. Writes are never retried after a response; Jira answers a PUT with 204 and no body.
      retry: write ? {} : { acceptJson: () => null },
    });
    const text = await res.text();
    if (!res.ok && !accept.includes(res.status)) throw new Error(`jira ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}${res.status === 401 || res.status === 403 ? " (set JIRA_EMAIL and JIRA_TOKEN)" : ""}`);
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }

  // --- the index ---------------------------------------------------------------
  // pr-rla keeps it (ctx.index, the same ledger-index.json) when it offers to: always in its plugin
  // host, where this ledger cannot write files. Without ctx.index (an older pr-rla, or a test calling
  // create() directly) the ledger reads and writes the file itself.
  async readIndex() {
    if (this.ctx.index) return (await this.ctx.index.read()) ?? null;
    const p = join(this.ctx.windowDir, INDEX);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }
  async writeIndex(index) {
    const sorted = { ...index, issues: [...index.issues].sort((a, b) => a.draw - b.draw) };
    if (this.ctx.index) return this.ctx.index.write(sorted);
    mkdirSync(this.ctx.windowDir, { recursive: true });
    const p = join(this.ctx.windowDir, INDEX);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
    renameSync(tmp, p);
  }

  // --- reads ---------------------------------------------------------------------
  async load() {
    this.snapshot ??= this.read().catch((e) => {
      this.snapshot = null;
      throw e;
    });
    return this.snapshot;
  }

  async read() {
    const s = { verdicts: [], history: [], failures: [], warnings: [], notes: [] };
    const index = await this.readIndex();
    if (!index) return s;
    const fields = (await this.request("GET", "/rest/api/3/field")).data;
    if (!fields.some((f) => f.id === this.s.field)) s.failures.push(`verdict field ${this.s.field} no longer exists on ${this.s.host}: the verdicts recorded in it cannot be checked`);
    for (const i of index.issues) {
      const r = await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(i.key)}?fields=project`, undefined, [404]);
      if (r.status === 404) {
        s.failures.push(`draw #${i.draw} issue ${i.key} deleted (HTTP 404): Jira deleted its changelog with it`);
        continue;
      }
      if (r.data.key !== i.key || r.data.fields?.project?.key !== this.s.project) {
        s.failures.push(`draw #${i.draw} issue ${i.key} moved (now ${r.data.key}); its history left project ${this.s.project}`);
        continue;
      }
      const histories = [];
      for (let startAt = 0; ; ) {
        const page = (await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(i.key)}/changelog?startAt=${startAt}&maxResults=100`)).data;
        histories.push(...page.values);
        startAt += page.values.length;
        if (page.isLast === true || page.values.length === 0 || (page.isLast === undefined && startAt >= page.total)) break;
      }
      const events = fieldEvents(histories, this.s).map((e) => ({ ...e, reviewer: e.actor.login, provenance: { level: "account", source: "jira-field-change", actorId: e.actor.id, viaApp: null, eventId: e.id } }));
      for (const e of events) {
        s.history.push({ id: e.id, at: e.at, actor: e.actor, action: e.action, label: this.s.values[e.verdict], draw: i.draw });
        if (e.action === "add") s.verdicts.push({ draw: i.draw, changeId: i.changeId, verdict: e.verdict, protocolSha256: index.protocolSha256, reviewer: e.reviewer, recordedAt: e.at, provenance: e.provenance });
      }
      const a = analyzeDrawHistory(i.draw, events, { reviewers: this.ctx.reviewers ?? null, labelOf: (v) => `${this.s.field}=${this.s.values[v]}` });
      s.failures.push(...a.failures);
      s.warnings.push(...a.warnings);
      s.notes.push(...a.notes);
    }
    const order = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1);
    s.verdicts.sort((a, b) => order({ at: a.recordedAt, id: a.provenance.eventId }, { at: b.recordedAt, id: b.provenance.eventId }));
    s.history.sort(order);
    return s;
  }

  async readVerdicts() {
    return (await this.load()).verdicts;
  }
  async verifyIntegrity() {
    const s = await this.load();
    return { ok: s.failures.length === 0, findings: [...s.failures, ...s.notes], warnings: s.warnings, tamperTrail: true };
  }
  async readHistory() {
    return (await this.load()).history;
  }

  // --- writes --------------------------------------------------------------------
  summary(d, window) {
    return `pr-rla draw #${d.draw} (${window}): ${d.changeId}`;
  }

  /** Issues already opened for this window, by their summary marker (after a lost response or a lost index). */
  async existing(window) {
    const found = new Map();
    let token = null;
    do {
      const q = new URLSearchParams({ jql: `project = "${this.s.project}" AND labels = "${DRAW_LABEL}"`, fields: "summary,created", maxResults: "100", ...(token ? { nextPageToken: token } : {}) });
      const page = (await this.request("GET", `/rest/api/3/search/jql?${q}`)).data;
      for (const it of page.issues ?? []) {
        const m = /^pr-rla draw #(\d+) \(([^)]+)\): (\S+)$/.exec(it.fields?.summary ?? "");
        if (m && m[2] === window) found.set(`${m[1]}|${m[3]}`, { key: it.key, id: it.id, createdAt: isoUtc(it.fields.created) });
      }
      token = page.isLast === false ? page.nextPageToken : null;
    } while (token);
    return found;
  }

  async publishDraws(draws, context) {
    if (!context?.protocolSha256) throw new Error("jira: publishDraws needs the registration's protocol hash");
    const window = context.window || basename(this.ctx.windowDir);
    const index = (await this.readIndex()) ?? { schema: "pr-rla-ledger-jira/index/v1", ledger: NAME, tracker: `${this.s.base}/projects/${this.s.project}`, window, protocolSha256: context.protocolSha256, field: this.s.field, issues: [], repeats: [] };
    if (index.protocolSha256 !== context.protocolSha256 || index.window !== window) throw new Error(`jira: ${INDEX} belongs to another window or protocol`);
    this.snapshot = null;
    const firstByChange = new Map(index.issues.map((i) => [i.changeId, i.draw]));
    const todo = [];
    for (const d of [...draws].sort((a, b) => a.draw - b.draw)) {
      const first = firstByChange.get(d.changeId);
      if (first !== undefined) {
        if (first !== d.draw && !index.repeats.some((r) => r.draw === d.draw)) index.repeats.push({ draw: d.draw, changeId: d.changeId, sameAs: first });
        continue;
      }
      firstByChange.set(d.changeId, d.draw);
      todo.push(d);
    }
    let existing = todo.length ? await this.existing(window) : new Map();
    for (const d of todo) {
      const key = `${d.draw}|${d.changeId}`;
      let made = existing.get(key);
      if (!made) {
        const text = `Review ${d.url} (landed as ${d.mergeSha}) under the registered protocol (SHA-256 ${context.protocolSha256}), then set the "pr-rla verdict" field to ${this.s.values.pass} or ${this.s.values.fail}. The first value set by a registered reviewer counts.`;
        try {
          const r = await this.request("POST", "/rest/api/3/issue", { fields: { project: { key: this.s.project }, issuetype: { name: this.s.issueType }, summary: this.summary(d, window), labels: [DRAW_LABEL], description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } } });
          made = { key: r.data.key, id: r.data.id, createdAt: null };
        } catch (e) {
          existing = await this.existing(window);
          made = existing.get(key);
          if (!made) throw new Error(`${e.message}\n  the issue for draw #${d.draw} may or may not exist: run "pr-rla sample" again; it looks for it first`);
        }
      }
      index.issues.push({ draw: d.draw, changeId: d.changeId, key: made.key, id: made.id, url: `${this.s.base}/browse/${made.key}`, createdAt: made.createdAt });
      await this.writeIndex(index);
    }
    await this.writeIndex(index);
  }

  async appendVerdict(event) {
    const index = await this.readIndex();
    const draw = index?.repeats.find((r) => r.draw === event.draw)?.sameAs ?? event.draw;
    const issue = index?.issues.find((i) => i.draw === draw);
    if (!issue) throw new Error(`jira: draw #${event.draw} has no issue; run "pr-rla sample" first`);
    this.snapshot = null;
    await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issue.key)}`, { fields: { [this.s.field]: { value: this.s.values[event.verdict] } } });
    if (event.note) await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment`, { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: event.note }] }] } });
  }
}

export default defineLedger({
  ledgerApiVersion: 1,
  name: NAME,
  description: "Jira Cloud: one issue per draw; the verdict is a single-select custom field read from the issue changelog",
  provenance: "account",
  hosts: (options) => [settings(options).host],
  writePaths: (options) => [`${settings(options).host}/rest/api/3/issue`],
  // No fixed host: pr-rla sends these only to the host of options.base_url, and only when it is https.
  credentials: [
    { env: "JIRA_EMAIL", hosts: [], hostFromOption: "base_url" },
    { env: "JIRA_TOKEN", hosts: [], hostFromOption: "base_url" },
  ],
  create: (options, ctx) => new JiraLedger(options, ctx),
});
