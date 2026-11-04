import { LEDGER_API_VERSION, defineLedger, type LedgerActor, type LedgerContext, type Verdict } from "../../sdk/ledger.js";
import { normalizeUser } from "../../providers/gitlab/normalize.js";
import { LedgerHttp, isoUtc, nextLink, type LedgerResponse } from "../http.js";
import type { IndexedIssue } from "../issue-index.js";
import { IssueTrackerLedger, type ExistingDrawIssue, type TrackerIssue, type TrackerLabelEvent } from "../issue-ledger.js";

/**
 * `gitlab-issues` (FR4.1, FR4.8): draws as issues in an audit project on gitlab.com or GitLab
 * self-managed (`base_url`), verdicts as labels read from `resource_label_events`.
 *
 * Plain labels work on every tier. Scoped labels (`pr-rla::pass`) need Premium, and applying one
 * removes the other: GitLab shows such a swap as one "added … and removed …" note at a single
 * instant by one user (recorded from gitlab-org/gitlab, BUILD-NOTES "Bolt 3"). Its REST
 * `resource_label_events` shape needs a token to read and stays unverified; it is read here as a
 * remove and an add, which the shared rules report as a relabel.
 *
 * GitLab label events carry the label's id, so verdicts follow the ids the draws were published
 * with; GitLab nulls the label on past events when a label is deleted, which verify reports.
 *
 *   ledger:
 *     use: gitlab-issues
 *     options: { project: acme/audit }         # base_url: https://gitlab.example.com for self-managed
 */
export interface GitLabIssuesOptions {
  /** The audit project: its path (`group/project`) or numeric id. Only it is written. */
  project: string | number;
  /** Instance root for self-managed GitLab (default https://gitlab.com). Taken from a `gitlab` provider's base_url when absent. */
  base_url?: string;
  /** Env var holding the token (default GITLAB_TOKEN): `api` scope for sample and record, `read_api` for verify. */
  token_env?: string;
  /** Verdict and draw label names (defaults pr-rla-pass, pr-rla-fail, pr-rla-draw). */
  labels?: { pass?: string; fail?: string; draw?: string };
}

export const GITLAB_ISSUES_LABELS = { pass: "pr-rla-pass", fail: "pr-rla-fail", draw: "pr-rla-draw" } as const;

const COLORS: Record<Verdict | "draw", { color: string; description: string }> = {
  pass: { color: "#1f883d", description: "pr-rla verdict: the change passes the registered review protocol" },
  fail: { color: "#cf222e", description: "pr-rla verdict: the change fails the registered review protocol" },
  draw: { color: "#8250df", description: "pr-rla: an audit draw to review" },
};

interface GlUser {
  id: number;
  username: string;
  bot?: boolean;
}
interface GlLabelEvent {
  id: number;
  user: GlUser | null;
  created_at: string;
  label: { id: number; name: string } | null;
  action: "add" | "remove";
}
interface GlIssue {
  iid: number;
  id: number;
  web_url: string;
  created_at: string;
  description: string | null;
  labels: string[];
  moved_to_id: number | null;
}

function endpoints(o: GitLabIssuesOptions): { api: string; projectPath: string } {
  const p = o?.project;
  if (!(typeof p === "number" && Number.isInteger(p) && p > 0) && !(typeof p === "string" && /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$|^\d+$/.test(p)))
    throw new Error(`gitlab-issues: options.project must be the audit project's path ("group/project") or numeric id${typeof p === "string" && p.includes("<") ? " (replace the placeholder)" : ""}, got ${JSON.stringify(p)}`);
  const base = (o.base_url ?? "https://gitlab.com").replace(/\/+$/, "").replace(/\/api\/v4$/, "");
  return { api: `${base}/api/v4`, projectPath: `/projects/${encodeURIComponent(String(p))}` };
}

export function gitlabActor(u: GlUser | null): LedgerActor {
  const a = normalizeUser(u ? { username: u.username, ...(u.bot !== undefined ? { bot: u.bot } : {}) } as never : null);
  return { ...a, ...(u ? { id: String(u.id) } : {}) };
}

export class GitLabIssuesLedger extends IssueTrackerLedger {
  readonly name = "gitlab-issues";
  readonly tracker: string;
  readonly where: string;
  readonly http: LedgerHttp;

  constructor(options: GitLabIssuesOptions, ctx: LedgerContext) {
    const o = options ?? ({} as GitLabIssuesOptions);
    super({ ...GITLAB_ISSUES_LABELS, ...o.labels }, ctx);
    const { api, projectPath } = endpoints(o);
    const token = ctx.env[o.token_env ?? "GITLAB_TOKEN"];
    this.where = String(o.project);
    this.tracker = `${api}${projectPath}`;
    this.http = new LedgerHttp({
      ledger: this.name,
      baseUrl: this.tracker,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      fetch: ctx.fetch,
      authHint: `set ${o.token_env ?? "GITLAB_TOKEN"} to a token with api scope on ${o.project} (verify needs read_api; GitLab serves label events only to a token, even on public projects)`,
    });
  }

  private async pages<T>(first: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = first;
    while (url) {
      const r: LedgerResponse<T[]> = await this.http.get<T[]>(url);
      out.push(...r.data);
      const next = r.headers.get("x-next-page");
      url = nextLink(r.headers) ?? (next ? `${first}${first.includes("?") ? "&" : "?"}page=${next}` : null);
    }
    return out;
  }

  protected async lookupLabel(name: string): Promise<{ id: string; name: string } | null> {
    const r = await this.http.get<{ id: number; name?: string }>(`/labels/${encodeURIComponent(name)}`, [404]);
    return r.status === 404 ? null : { id: String(r.data.id), name: r.data.name ?? name };
  }

  protected async canReadTracker(): Promise<boolean> {
    const r = await this.http.get<unknown>(this.tracker, [401, 403, 404]);
    return r.status >= 200 && r.status < 300;
  }

  protected async createLabel(name: string, role: Verdict | "draw"): Promise<{ id: string; name: string }> {
    const r = await this.http.request<{ id: number; name?: string }>("POST", "/labels", { body: { name, ...COLORS[role] } });
    return { id: String(r.data.id), name: r.data.name ?? name };
  }

  protected async listDrawIssues(drawLabel: string): Promise<ExistingDrawIssue[]> {
    const issues = await this.pages<GlIssue>(`/issues?labels=${encodeURIComponent(drawLabel)}&scope=all&per_page=100`);
    return issues.map((i) => ({ number: i.iid, id: String(i.id), url: i.web_url, createdAt: isoUtc(i.created_at), body: i.description }));
  }

  protected async createIssue(title: string, body: string, drawLabel: string): Promise<Omit<IndexedIssue, "draw" | "changeId">> {
    const r = await this.http.request<GlIssue>("POST", "/issues", { body: { title, description: body, labels: drawLabel } });
    return { number: r.data.iid, id: String(r.data.id), url: r.data.web_url, createdAt: isoUtc(r.data.created_at) };
  }

  protected async readIssue(issue: IndexedIssue): Promise<TrackerIssue> {
    const r = await this.http.get<GlIssue>(`/issues/${issue.number}`, [404]);
    if (r.status === 404) return { state: "deleted", detail: "HTTP 404" };
    if (r.data.moved_to_id !== null && r.data.moved_to_id !== undefined) return { state: "moved", detail: `moved to issue id ${r.data.moved_to_id}` };
    const raw = await this.pages<GlLabelEvent>(`/issues/${issue.number}/resource_label_events?per_page=100`);
    const events: TrackerLabelEvent[] = raw.map((e) => ({
      id: String(e.id),
      at: isoUtc(e.created_at),
      action: e.action,
      labelName: e.label?.name ?? null,
      labelId: e.label ? String(e.label.id) : null,
      actor: gitlabActor(e.user),
      viaApp: null,
    }));
    return { state: "ok", id: String(r.data.id), number: r.data.iid, body: r.data.description ?? null, currentLabels: r.data.labels, events };
  }

  protected async applyLabel(issue: IndexedIssue, label: string): Promise<void> {
    await this.http.request("PUT", `/issues/${issue.number}`, { body: { add_labels: label } });
  }

  protected async addNote(issue: IndexedIssue, body: string): Promise<void> {
    await this.http.request("POST", `/issues/${issue.number}/notes`, { body: { body } });
  }
}

export default defineLedger<GitLabIssuesOptions>({
  ledgerApiVersion: LEDGER_API_VERSION,
  name: "gitlab-issues",
  description: "one issue per draw in an audit project on gitlab.com or self-managed GitLab; verdicts are labels read from resource_label_events",
  provenance: "account",
  hosts: (options) => [new URL(endpoints(options).api).host],
  writePaths: (options) => {
    const { api, projectPath } = endpoints(options);
    const u = new URL(api);
    return [`${u.host}${u.pathname}${projectPath}/`];
  },
  create: (options, ctx) => new GitLabIssuesLedger(options, ctx),
});
