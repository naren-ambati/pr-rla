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
// The verdict is matched by the select options' ids, not by their display names: `publishDraws` reads
// the field's allowed values from the first issue's edit metadata and keeps the two option ids in the
// ledger index (`options: { pass, fail }`). A field renamed from "fail" to "Fail" still reads, and a
// changelog entry that sets the field to any other option is a FAIL, never silently dropped.
//
// Jira deletes an issue's changelog with the issue, and admins can delete issues: run
// `pr-rla checkpoint` after verdicts; checkpoints are not optional with Jira.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { analyzeDrawHistory, compareByTimeThenId, defineLedger } from "pr-rla/ledger";

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
 * The verdict-field changes in one changelog page, as adds and removes, matched by option id
 * (`s.options`, from the ledger index). A single-select change from A to B is a remove of A and an
 * add of B at the same instant. A change that sets the field to an option that is neither the pass
 * nor the fail option comes back in `unrecognised`: the caller FAILs it, because dropping it would
 * hide a verdict.
 */
export function fieldEvents(histories, s) {
  const events = [];
  const unrecognised = [];
  const verdictOf = (id) => (id === s.options.pass ? "pass" : id === s.options.fail ? "fail" : null);
  for (const h of histories) {
    h.items.forEach((it, n) => {
      if (it.fieldId !== s.field && !(it.fieldId === undefined && it.field === s.field)) return;
      const base = { at: isoUtc(h.created), actor: jiraActor(h.author) };
      const from = verdictOf(it.from == null ? null : String(it.from));
      const toId = it.to == null ? null : String(it.to);
      const to = verdictOf(toId);
      if (from) events.push({ ...base, id: `${h.id}:${n}:remove`, action: "remove", verdict: from });
      if (to) events.push({ ...base, id: `${h.id}:${n}:add`, action: "add", verdict: to });
      else if (toId !== null) unrecognised.push({ ...base, id: `${h.id}:${n}`, optionId: toId, value: it.toString ?? null });
    });
  }
  return { events, unrecognised };
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

  /** What is wrong with the index before any issue is read: its tracker, field and option ids, and duplicate draws, keys or ids. */
  indexProblems(index) {
    const out = [];
    if (index.field !== this.s.field) out.push(`ledger index was written for field ${String(index.field)}, not ${this.s.field}`);
    if (index.tracker !== `${this.s.base}/projects/${this.s.project}`) out.push(`ledger index was written for ${String(index.tracker)}, not ${this.s.base}/projects/${this.s.project}`);
    const o = index.options;
    if (!o || typeof o.pass !== "string" || typeof o.fail !== "string" || o.pass === o.fail) out.push(`ledger index records no distinct option ids for the pass and fail values (options: { pass, fail }); run "pr-rla sample" to learn them`);
    if (!Array.isArray(index.issues)) out.push("ledger index has no issues list");
    else
      for (const [what, key] of [["draw", (i) => String(i.draw)], ["issue key", (i) => String(i.key)], ["issue id", (i) => String(i.id)], ["change", (i) => String(i.changeId)]]) {
        const seen = new Map();
        for (const i of index.issues) {
          const k = key(i);
          if (seen.has(k)) out.push(`ledger index gives draws #${seen.get(k)} and #${i.draw} the same ${what} ${k}`);
          else seen.set(k, i.draw);
        }
      }
    return out;
  }

  async canReadProject() {
    const r = await this.request("GET", `/rest/api/3/project/${encodeURIComponent(this.s.project)}`, undefined, [401, 403, 404]);
    return r.status >= 200 && r.status < 300;
  }

  /** The select options' ids for the two verdict values, from an issue's edit metadata (what the field offers now). */
  async learnOptions(key) {
    const meta = (await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/editmeta`)).data;
    const allowed = meta.fields?.[this.s.field]?.allowedValues ?? [];
    const id = (name) => {
      const hit = allowed.filter((a) => a.value === name);
      if (hit.length !== 1) throw new Error(`jira: field ${this.s.field} offers ${hit.length === 0 ? "no" : "several"} option named "${name}" on ${key} (it offers ${allowed.map((a) => a.value).join(", ") || "nothing"}); create the options or set options.values`);
      return String(hit[0].id);
    };
    return { pass: id(this.s.values.pass), fail: id(this.s.values.fail) };
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
    const problems = this.indexProblems(index);
    if (problems.length) {
      s.failures.push(...problems);
      return s;
    }
    const sx = { ...this.s, options: index.options };
    const fields = (await this.request("GET", "/rest/api/3/field")).data;
    if (!fields.some((f) => f.id === this.s.field)) s.failures.push(`verdict field ${this.s.field} no longer exists on ${this.s.host}: the verdicts recorded in it cannot be checked`);
    let readable = null;
    for (const i of index.issues) {
      const r = await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(i.key)}?fields=project`, undefined, [404]);
      if (r.status === 404) {
        readable ??= this.canReadProject();
        if (await readable) s.failures.push(`draw #${i.draw} issue ${i.key} deleted (HTTP 404): Jira deleted its changelog with it`);
        else s.failures.push(`draw #${i.draw} issue ${i.key} answered HTTP 404, and the token cannot read project ${this.s.project} either: the credentials have no access to it (Jira answers not-found to an issue it will not show), so this is not evidence that the issue was deleted`);
        continue;
      }
      if (r.data.key !== i.key || r.data.fields?.project?.key !== this.s.project) {
        s.failures.push(`draw #${i.draw} issue ${i.key} moved (now ${r.data.key}); its history left project ${this.s.project}`);
        continue;
      }
      if (String(r.data.id) !== String(i.id)) {
        s.failures.push(`draw #${i.draw}: ${this.s.host} answered issue ${r.data.key} with id ${r.data.id} for the index's id ${i.id}; the index does not describe this issue`);
        continue;
      }
      const histories = [];
      for (let startAt = 0; ; ) {
        const page = (await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(i.key)}/changelog?startAt=${startAt}&maxResults=100`)).data;
        histories.push(...page.values);
        startAt += page.values.length;
        if (page.isLast === true || page.values.length === 0 || (page.isLast === undefined && startAt >= page.total)) break;
      }
      const parsed = fieldEvents(histories, sx);
      for (const u of parsed.unrecognised)
        s.failures.push(`draw #${i.draw}: the verdict field was set to ${u.value === null ? "an option" : `"${u.value}"`} (option id ${u.optionId}) at ${u.at}, which is neither the ${this.s.values.pass} option (${index.options.pass}) nor the ${this.s.values.fail} option (${index.options.fail}); a verdict set that way cannot be counted`);
      const events = parsed.events.map((e) => ({ ...e, reviewer: e.actor.login, provenance: { level: "account", source: "jira-field-change", actorId: e.actor.id, viaApp: null, eventId: e.id } }));
      for (const e of events) {
        s.history.push({ id: e.id, at: e.at, actor: e.actor, action: e.action, label: this.s.values[e.verdict], draw: i.draw });
        if (e.action === "add") s.verdicts.push({ draw: i.draw, changeId: i.changeId, verdict: e.verdict, protocolSha256: index.protocolSha256, reviewer: e.reviewer, recordedAt: e.at, provenance: e.provenance });
      }
      const a = analyzeDrawHistory(i.draw, events, { reviewers: this.ctx.reviewers ?? null, labelOf: (v) => `${this.s.field}=${this.s.values[v]}` });
      s.failures.push(...a.failures);
      s.warnings.push(...a.warnings);
      s.notes.push(...a.notes);
    }
    s.verdicts.sort((a, b) => compareByTimeThenId({ at: a.recordedAt, id: a.provenance.eventId }, { at: b.recordedAt, id: b.provenance.eventId }));
    s.history.sort(compareByTimeThenId);
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
    if (!index.options && index.issues.length) {
      index.options = await this.learnOptions(index.issues[0].key);
      this.ctx.log(`jira: verdict options ${this.s.values.pass}=${index.options.pass}, ${this.s.values.fail}=${index.options.fail}`);
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
  // JIRA_EMAIL is the Basic username, an identity (secret: false): pr-rla does not scrub it from responses.
  credentials: [
    { env: "JIRA_EMAIL", hosts: [], hostFromOption: "base_url", secret: false },
    { env: "JIRA_TOKEN", hosts: [], hostFromOption: "base_url" },
  ],
  create: (options, ctx) => new JiraLedger(options, ctx),
});
