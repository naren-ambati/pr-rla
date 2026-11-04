// A synthetic Jira Cloud (fixtures built on it are `source: "synthetic"`), shaped like the recorded
// hibernate.atlassian.net responses: changelog items for a single-select custom field carry
// fieldtype "custom", the field id, option ids in from/to and values in fromString/toString.
const json = (status, body) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const FIELD = "customfield_10050";

export class FakeJira {
  constructor(base = "https://acme.atlassian.net", project = "AUD") {
    Object.assign(this, { base, project });
    this.issues = new Map();
    this.fields = [{ id: FIELD, name: "pr-rla verdict", custom: true, schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select", customId: 10050 } }];
    this.options = { pass: "10001", fail: "10002" };
    // The options' display names now; changelog entries keep the name as it was when the field was set.
    this.optionNames = { pass: "pass", fail: "fail" };
    /** The credentials cannot see the project: Jira answers 404 to its issues and to the project itself. */
    this.unauthorized = false;
    this.requests = [];
    this.writer = { accountId: "557058:writer", accountType: "atlassian" };
    this.next = 1;
    this.historyId = 500001;
    this.clockMs = Date.parse("2026-10-21T02:00:00Z");
    this.pageSize = 100;
  }

  tick() {
    this.clockMs += 1000;
    return new Date(this.clockMs).toISOString().replace("Z", "+0000");
  }
  setTime(iso) {
    this.clockMs = Date.parse(iso) - 1000;
  }
  get fetch() {
    return async (input, init) => this.handle(new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), (init?.method ?? "GET").toUpperCase(), typeof init?.body === "string" ? JSON.parse(init.body) : null, new Headers(init?.headers));
  }
  clone() {
    const c = new FakeJira(this.base, this.project);
    Object.assign(c, structuredClone({ ...this, requests: [] }));
    return c;
  }

  // --- test controls ---------------------------------------------------------------
  /** A reviewer sets the verdict field in Jira's UI (null clears it). */
  set(key, value, author = this.writer) {
    const i = this.issue(key);
    const id = String(this.historyId++);
    const opt = (v) => (v === "pass" ? this.options.pass : v === "fail" ? this.options.fail : null);
    const name = (v) => (v === "pass" ? this.optionNames.pass : v === "fail" ? this.optionNames.fail : null);
    i.changelog.push({ id, created: this.tick(), author, items: [{ field: "pr-rla verdict", fieldtype: "custom", fieldId: FIELD, from: opt(i.value), fromString: name(i.value), to: opt(value), toString: name(value) }] });
    i.value = value;
    return id;
  }
  /** Sets the field to an option the ledger does not know (id and name given), as an admin adding a third option would. */
  setOption(key, optionId, optionName, author = this.writer) {
    const i = this.issue(key);
    const id = String(this.historyId++);
    i.changelog.push({ id, created: this.tick(), author, items: [{ field: "pr-rla verdict", fieldtype: "custom", fieldId: FIELD, from: null, fromString: null, to: optionId, toString: optionName }] });
    return id;
  }
  /** Renames an option in the field's configuration (past changelog entries keep the old name; ids never change). */
  renameOption(which, to) {
    this.optionNames[which] = to;
  }
  /** An unrelated field change (status), as real changelogs are full of. */
  touch(key) {
    this.issue(key).changelog.push({ id: String(this.historyId++), created: this.tick(), author: this.writer, items: [{ field: "status", fieldtype: "jira", fieldId: "status", from: "1", fromString: "Open", to: "3", toString: "In Progress" }] });
  }
  deleteIssue(key) {
    this.issue(key).deleted = true;
  }
  moveIssue(key, to) {
    this.issue(key).movedTo = to;
  }
  deleteField() {
    this.fields = [];
  }
  eraseHistory(id) {
    for (const i of this.issues.values()) i.changelog = i.changelog.filter((h) => h.id !== id);
  }
  byDraw(draw) {
    const i = [...this.issues.values()].find((x) => x.summary.startsWith(`pr-rla draw #${draw} (`));
    if (!i) throw new Error(`no issue for draw ${draw}`);
    return i.key;
  }
  writes() {
    return this.requests.filter((r) => r.method !== "GET");
  }

  issue(key) {
    const i = this.issues.get(key);
    if (!i) throw new Error(`fake Jira: no issue ${key}`);
    return i;
  }

  handle(url, method, body, headers) {
    this.requests.push({ method, url: url.href, body, authorization: headers.get("authorization") });
    const p = url.pathname;
    let m;
    if (this.unauthorized && (p.startsWith("/rest/api/3/issue/") || p.startsWith("/rest/api/3/project/"))) return json(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."], errors: {} });
    if (p === "/rest/api/3/field" && method === "GET") return json(200, this.fields);
    if ((m = /^\/rest\/api\/3\/project\/([^/]+)$/.exec(p)) && method === "GET") return decodeURIComponent(m[1]) === this.project ? json(200, { key: this.project }) : json(404, { errorMessages: ["No project could be found."], errors: {} });
    if (p === "/rest/api/3/search/jql" && method === "GET") {
      const all = [...this.issues.values()].filter((i) => !i.deleted && i.labels.includes("pr-rla-draw"));
      return json(200, { issues: all.map((i) => ({ id: i.id, key: i.key, fields: { summary: i.summary, created: i.created } })), isLast: true });
    }
    if (p === "/rest/api/3/issue" && method === "POST") {
      const n = this.next++;
      const key = `${this.project}-${n}`;
      const f = body.fields;
      this.issues.set(key, { id: String(10000 + n), key, project: f.project.key, summary: f.summary, labels: f.labels ?? [], created: this.tick(), value: null, changelog: [], deleted: false, movedTo: null });
      return json(201, { id: String(10000 + n), key, self: `${this.base}/rest/api/3/issue/${10000 + n}` });
    }
    if ((m = /^\/rest\/api\/3\/issue\/([^/]+)(\/[a-z]+)?$/.exec(p))) {
      const i = this.issues.get(decodeURIComponent(m[1]));
      if (!i || i.deleted) return json(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."], errors: {} });
      const rest = m[2] ?? "";
      if (rest === "" && method === "GET") return json(200, { id: i.id, key: i.movedTo ?? i.key, fields: { project: { key: i.movedTo ? i.movedTo.split("-")[0] : i.project } } });
      if (rest === "" && method === "PUT") {
        const name = body.fields[FIELD]?.value ?? null;
        const v = ["pass", "fail"].find((k) => this.optionNames[k] === name) ?? null;
        this.set(i.key, v);
        return json(204, null);
      }
      if (rest === "/editmeta" && method === "GET") return json(200, { fields: { [FIELD]: { allowedValues: [{ id: this.options.pass, value: this.optionNames.pass }, { id: this.options.fail, value: this.optionNames.fail }] } } });
      if (rest === "/changelog" && method === "GET") {
        const startAt = Number(url.searchParams.get("startAt") ?? 0);
        const max = Math.min(Number(url.searchParams.get("maxResults") ?? 50), this.pageSize);
        const values = i.changelog.slice(startAt, startAt + max);
        return json(200, { self: url.href, maxResults: max, startAt, total: i.changelog.length, isLast: startAt + values.length >= i.changelog.length, values });
      }
      if (rest === "/comment" && method === "POST") return json(201, { id: "1" });
    }
    return json(404, { errorMessages: [`fake Jira: no route ${method} ${p}`] });
  }
}
