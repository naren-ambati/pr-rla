/**
 * Synthetic issue trackers for the issue ledgers (FR4.7: every fixture built on these is
 * `source: "synthetic"`). They hold state, so write paths (publishDraws, record) and the
 * destructive cases (a deleted issue, a deleted or renamed label, a transfer, an admin erasing
 * an event) run against them, never against a real tracker (D8).
 *
 * Shapes follow the documented REST APIs and, where recorded, the real responses:
 * GitHub issue events keep a label's name as applied (recorded on rust-lang/rust); GitLab label
 * events carry the label object and lose it when the label is deleted.
 */

export interface FakeUser {
  login: string;
  id: number;
  type?: "User" | "Bot";
}

interface Req {
  method: string;
  url: string;
  body: unknown;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function bodyOf(init?: RequestInit): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

/** Each fake has its own clock, so a scenario rebuilt for another kit phase is identical. Every event gets a distinct second unless a time is given. */
abstract class FakeClock {
  private clockMs = Date.parse("2026-10-21T02:00:00Z");
  tick(): string {
    return new Date((this.clockMs += 1000)).toISOString().replace(".000Z", "Z");
  }
  /** Moves the fake's clock (events after it are later). */
  setTime(iso: string): void {
    this.clockMs = Date.parse(iso) - 1000;
  }
}

// ---------------------------------------------------------------------------
// GitHub (GitHub.com and Enterprise Server: REST under <api>/repos/<owner>/<repo>)
// ---------------------------------------------------------------------------

interface GhEvent {
  id: number;
  event: string;
  created_at: string;
  actor: FakeUser | null;
  label?: { name: string; color: string };
  performed_via_github_app: { slug: string } | null;
}

interface GhIssueState {
  number: number;
  node_id: string;
  title: string;
  body: string;
  labels: string[];
  created_at: string;
  events: GhEvent[];
  gone: 404 | 410 | null;
  movedTo: string | null;
}

export class FakeGitHubIssues extends FakeClock {
  readonly labels = new Map<string, { id: number; name: string }>();
  readonly issues = new Map<number, GhIssueState>();
  readonly requests: Req[] = [];
  /** The account a write request acts as (the token's owner). */
  writer: FakeUser = { login: "reviewer-a", id: 501, type: "User" };
  /** The next POST /issues is created but answered with this status (a lost response). */
  loseNextCreate: number | null = null;
  pageSize = 100;
  private nextIssue = 1;
  private nextLabelId = 9_000_001;
  private nextEventId = 70_000_001;
  readonly repoUrl: string;

  constructor(
    readonly api = "https://api.github.com",
    readonly repo = "acme/audit",
  ) {
    super();
    this.repoUrl = `${api}/repos/${repo}`;
  }

  get fetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => this.handle(new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), (init?.method ?? "GET").toUpperCase(), bodyOf(init))) as typeof fetch;
  }

  // --- test controls -------------------------------------------------------------
  /** An independent copy of the tracker (for tamper scenarios on a cloned audit). */
  clone(): FakeGitHubIssues {
    const c = Object.assign(new FakeGitHubIssues(this.api, this.repo), structuredClone({ ...this, requests: [] }));
    (c as { labels: Map<string, { id: number; name: string }> }).labels = new Map(structuredClone([...this.labels]));
    (c as { issues: Map<number, GhIssueState> }).issues = new Map(structuredClone([...this.issues]));
    return c;
  }
  addLabel(name: string): number {
    const id = this.nextLabelId++;
    this.labels.set(name.toLowerCase(), { id, name });
    return id;
  }
  /** A label event on issue n by `actor` (a reviewer acting in the web UI). */
  label(n: number, name: string, actor: FakeUser, opts: { at?: string; app?: string } = {}): number {
    const i = this.issue(n);
    if (!this.labels.has(name.toLowerCase())) this.addLabel(name);
    if (!i.labels.includes(name)) i.labels.push(name);
    return this.event(i, "labeled", actor, { name, ...opts });
  }
  unlabel(n: number, name: string, actor: FakeUser, opts: { at?: string; app?: string } = {}): number {
    const i = this.issue(n);
    i.labels = i.labels.filter((l) => l !== name);
    return this.event(i, "unlabeled", actor, { name, ...opts });
  }
  /** Many add/remove pairs on one issue (pagination past 100 events). */
  toggle(n: number, name: string, actor: FakeUser, pairs: number): void {
    for (let k = 0; k < pairs; k++) {
      this.label(n, name, actor);
      this.unlabel(n, name, actor);
    }
  }
  deleteIssue(n: number, status: 404 | 410 = 410): void {
    this.issue(n).gone = status;
  }
  transferIssue(n: number, toRepo: string): void {
    const i = this.issue(n);
    i.movedTo = toRepo;
    this.event(i, "transferred", this.writer, {});
  }
  /** A rename keeps the label's id; past REST events keep the old name. */
  renameLabel(from: string, to: string): void {
    const l = this.labels.get(from.toLowerCase())!;
    this.labels.delete(from.toLowerCase());
    this.labels.set(to.toLowerCase(), { id: l.id, name: to });
    for (const i of this.issues.values()) i.labels = i.labels.map((x) => (x === from ? to : x));
  }
  /** Deleting a label removes it from issues (no event recorded on closed issues; this fake records none). */
  deleteLabel(name: string): void {
    this.labels.delete(name.toLowerCase());
    for (const i of this.issues.values()) i.labels = i.labels.filter((x) => x !== name);
  }
  /** An admin rewriting history: the event disappears. */
  eraseEvent(id: number): void {
    for (const i of this.issues.values()) i.events = i.events.filter((e) => e.id !== id);
  }
  issueByDraw(draw: number): GhIssueState {
    const i = [...this.issues.values()].find((x) => x.body.includes(` draw=${draw} `));
    if (!i) throw new Error(`no issue for draw ${draw}`);
    return i;
  }
  writes(): Req[] {
    return this.requests.filter((r) => r.method !== "GET");
  }
  /** An issue made directly (as if a previous run created it), with its body. */
  seedIssue(title: string, body: string, labels: string[] = []): number {
    const n = this.nextIssue++;
    this.issues.set(n, { number: n, node_id: `I_kw${n}`, title, body, labels: [...labels], created_at: this.tick(), events: [], gone: null, movedTo: null });
    return n;
  }

  private issue(n: number): GhIssueState {
    const i = this.issues.get(n);
    if (!i) throw new Error(`fake GitHub: no issue #${n}`);
    return i;
  }
  private event(i: GhIssueState, event: string, actor: FakeUser | null, o: { name?: string; at?: string; app?: string }): number {
    const id = this.nextEventId++;
    i.events.push({ id, event, created_at: o.at ?? this.tick(), actor, ...(o.name ? { label: { name: o.name, color: "ededed" } } : {}), performed_via_github_app: o.app ? { slug: o.app } : null });
    return id;
  }
  private page<T>(url: URL, items: T[]): Response {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 30), this.pageSize);
    const page = Number(url.searchParams.get("page") ?? 1);
    const slice = items.slice((page - 1) * per, page * per);
    const headers: Record<string, string> = {};
    if (page * per < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next.href}>; rel="next"`;
    }
    return json(200, slice, headers);
  }
  private issueJson(i: GhIssueState) {
    const where = i.movedTo ?? this.repo;
    return { number: i.number, node_id: i.node_id, title: i.title, body: i.body, html_url: `https://github.example/${where}/issues/${i.number}`, created_at: i.created_at, repository_url: `${this.api}/repos/${where}`, labels: i.labels.map((name) => ({ name })) };
  }

  handle(url: URL, method: string, body: unknown): Response {
    this.requests.push({ method, url: url.href, body });
    const base = new URL(this.repoUrl).pathname;
    if (!url.pathname.startsWith(`${base}/`)) return json(404, { message: "Not Found" });
    const path = url.pathname.slice(base.length);
    let m: RegExpExecArray | null;
    if ((m = /^\/labels\/([^/]+)$/.exec(path)) && method === "GET") {
      const l = this.labels.get(decodeURIComponent(m[1]!).toLowerCase());
      return l ? json(200, { id: l.id, name: l.name }) : json(404, { message: "Not Found" });
    }
    if (path === "/labels" && method === "POST") {
      const b = body as { name: string };
      if (this.labels.has(b.name.toLowerCase())) return json(422, { message: "Validation Failed", errors: [{ code: "already_exists" }] });
      return json(201, { id: this.addLabel(b.name), name: b.name });
    }
    if (path === "/issues" && method === "GET") {
      const want = url.searchParams.get("labels");
      return this.page(url, [...this.issues.values()].filter((i) => !i.gone && (!want || i.labels.includes(want))).map((i) => this.issueJson(i)));
    }
    if (path === "/issues" && method === "POST") {
      const b = body as { title: string; body: string; labels?: string[] };
      const n = this.seedIssue(b.title, b.body);
      const i = this.issue(n);
      for (const l of b.labels ?? []) this.label(n, l, this.writer);
      if (this.loseNextCreate !== null) {
        const status = this.loseNextCreate;
        this.loseNextCreate = null;
        return json(status, { message: "the response was lost" });
      }
      return json(201, this.issueJson(i));
    }
    if ((m = /^\/issues\/(\d+)(\/.*)?$/.exec(path))) {
      const i = this.issues.get(Number(m[1]));
      if (!i) return json(404, { message: "Not Found" });
      if (i.gone) return json(i.gone, { message: i.gone === 410 ? "This issue was deleted" : "Not Found" });
      const rest = m[2] ?? "";
      if (rest === "" && method === "GET") return json(200, this.issueJson(i));
      if (rest === "/events" && method === "GET") return this.page(url, i.events);
      if (rest === "/labels" && method === "POST") {
        for (const l of (body as { labels: string[] }).labels) this.label(i.number, l, this.writer);
        return json(200, i.labels.map((name) => ({ name })));
      }
      if (rest === "/comments" && method === "POST") return json(201, { id: 1 });
    }
    return json(404, { message: `fake GitHub: no route ${method} ${path}` });
  }
}

// ---------------------------------------------------------------------------
// GitLab (gitlab.com and self-managed: REST under <base>/api/v4/projects/<id>)
// ---------------------------------------------------------------------------

interface GlEvent {
  id: number;
  user: { id: number; username: string } | null;
  created_at: string;
  resource_type: "Issue";
  label: { id: number; name: string } | null;
  action: "add" | "remove";
}

interface GlIssueState {
  iid: number;
  id: number;
  title: string;
  description: string;
  labels: string[];
  created_at: string;
  events: GlEvent[];
  gone: boolean;
  moved_to_id: number | null;
}

export class FakeGitLabIssues extends FakeClock {
  readonly labels = new Map<string, { id: number; name: string }>();
  readonly issues = new Map<number, GlIssueState>();
  readonly requests: Req[] = [];
  writer = { id: 801, username: "reviewer-a" };
  pageSize = 100;
  private nextIid = 1;
  private nextId = 4_000_001;
  private nextLabelId = 6_000_001;
  private nextEventId = 90_000_001;
  readonly projectUrl: string;

  constructor(
    readonly base = "https://gitlab.example.com",
    readonly project = "acme/audit",
  ) {
    super();
    this.projectUrl = `${base}/api/v4/projects/${encodeURIComponent(project)}`;
  }

  get fetch(): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => this.handle(new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url), (init?.method ?? "GET").toUpperCase(), bodyOf(init))) as typeof fetch;
  }

  addLabel(name: string): number {
    const id = this.nextLabelId++;
    this.labels.set(name, { id, name });
    return id;
  }
  /** Adds a label as `user`; a scoped label (`scope::value`) removes the other value of its scope at the same instant, as GitLab does. */
  label(iid: number, name: string, user: { id: number; username: string }, at = this.tick()): number[] {
    const i = this.issue(iid);
    if (!this.labels.has(name)) this.addLabel(name);
    const ids: number[] = [];
    const scope = name.includes("::") ? name.slice(0, name.lastIndexOf("::")) : null;
    if (scope) for (const other of i.labels.filter((l) => l !== name && l.startsWith(`${scope}::`) && l.lastIndexOf("::") === scope.length)) ids.push(this.unlabel(iid, other, user, at));
    if (!i.labels.includes(name)) {
      i.labels.push(name);
      ids.push(this.event(i, "add", name, user, at));
    }
    return ids;
  }
  unlabel(iid: number, name: string, user: { id: number; username: string }, at = this.tick()): number {
    const i = this.issue(iid);
    i.labels = i.labels.filter((l) => l !== name);
    return this.event(i, "remove", name, user, at);
  }
  deleteIssue(iid: number): void {
    this.issue(iid).gone = true;
  }
  moveIssue(iid: number): void {
    this.issue(iid).moved_to_id = 4_999_999;
  }
  /** GitLab today: a deleted label disappears from issues and is nulled on past events. */
  deleteLabel(name: string): void {
    const l = this.labels.get(name);
    this.labels.delete(name);
    for (const i of this.issues.values()) {
      i.labels = i.labels.filter((x) => x !== name);
      for (const e of i.events) if (l && e.label?.id === l.id) e.label = null;
    }
  }
  /** GitLab label events show the label as it is now (a rename keeps the id). */
  renameLabel(from: string, to: string): void {
    const l = this.labels.get(from)!;
    this.labels.delete(from);
    this.labels.set(to, { id: l.id, name: to });
    for (const i of this.issues.values()) {
      i.labels = i.labels.map((x) => (x === from ? to : x));
      for (const e of i.events) if (e.label?.id === l.id) e.label = { id: l.id, name: to };
    }
  }
  /** An older instance: the issue carries a label with no event recording it. */
  labelWithoutEvent(iid: number, name: string): void {
    if (!this.labels.has(name)) this.addLabel(name);
    this.issue(iid).labels.push(name);
  }
  eraseEvent(id: number): void {
    for (const i of this.issues.values()) i.events = i.events.filter((e) => e.id !== id);
  }
  issueByDraw(draw: number): GlIssueState {
    const i = [...this.issues.values()].find((x) => x.description.includes(` draw=${draw} `));
    if (!i) throw new Error(`no issue for draw ${draw}`);
    return i;
  }
  writes(): Req[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  private issue(iid: number): GlIssueState {
    const i = this.issues.get(iid);
    if (!i) throw new Error(`fake GitLab: no issue ${iid}`);
    return i;
  }
  private event(i: GlIssueState, action: "add" | "remove", name: string, user: { id: number; username: string }, at: string): number {
    const id = this.nextEventId++;
    const l = this.labels.get(name);
    i.events.push({ id, user, created_at: at.replace("Z", ".000Z"), resource_type: "Issue", label: l ? { id: l.id, name: l.name } : null, action });
    return id;
  }
  private page<T>(url: URL, items: T[]): Response {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 20), this.pageSize);
    const page = Number(url.searchParams.get("page") ?? 1);
    const headers: Record<string, string> = { "x-page": String(page) };
    if (page * per < items.length) headers["x-next-page"] = String(page + 1);
    return json(200, items.slice((page - 1) * per, page * per), headers);
  }
  private issueJson(i: GlIssueState) {
    return { iid: i.iid, id: i.id, title: i.title, description: i.description, web_url: `${this.base}/${this.project}/-/issues/${i.iid}`, created_at: i.created_at.replace("Z", ".000Z"), labels: [...i.labels], moved_to_id: i.moved_to_id };
  }

  handle(url: URL, method: string, body: unknown): Response {
    this.requests.push({ method, url: url.href, body });
    const base = new URL(this.projectUrl).pathname;
    if (!url.pathname.startsWith(`${base}/`)) return json(404, { message: "404 Project Not Found" });
    const path = url.pathname.slice(base.length);
    let m: RegExpExecArray | null;
    if ((m = /^\/labels\/([^/]+)$/.exec(path)) && method === "GET") {
      const l = this.labels.get(decodeURIComponent(m[1]!));
      return l ? json(200, l) : json(404, { message: "404 Label Not Found" });
    }
    if (path === "/labels" && method === "POST") {
      const b = body as { name: string };
      if (this.labels.has(b.name)) return json(409, { message: "Label already exists" });
      return json(201, { id: this.addLabel(b.name), name: b.name });
    }
    if (path === "/issues" && method === "GET") {
      const want = url.searchParams.get("labels");
      return this.page(url, [...this.issues.values()].filter((i) => !i.gone && (!want || i.labels.includes(want))).map((i) => this.issueJson(i)));
    }
    if (path === "/issues" && method === "POST") {
      const b = body as { title: string; description: string; labels?: string };
      const iid = this.nextIid++;
      const i: GlIssueState = { iid, id: this.nextId++, title: b.title, description: b.description, labels: [], created_at: this.tick(), events: [], gone: false, moved_to_id: null };
      this.issues.set(iid, i);
      for (const l of (b.labels ?? "").split(",").filter(Boolean)) this.label(iid, l, this.writer);
      return json(201, this.issueJson(i));
    }
    if ((m = /^\/issues\/(\d+)(\/.*)?$/.exec(path))) {
      const i = this.issues.get(Number(m[1]));
      if (!i || i.gone) return json(404, { message: "404 Not found" });
      const rest = m[2] ?? "";
      if (rest === "" && method === "GET") return json(200, this.issueJson(i));
      if (rest === "" && method === "PUT") {
        for (const l of String((body as { add_labels?: string }).add_labels ?? "").split(",").filter(Boolean)) this.label(i.iid, l, this.writer);
        return json(200, this.issueJson(i));
      }
      if (rest === "/resource_label_events" && method === "GET") return this.page(url, i.events);
      if (rest === "/notes" && method === "POST") return json(201, { id: 1 });
    }
    return json(404, { message: `fake GitLab: no route ${method} ${path}` });
  }
}
