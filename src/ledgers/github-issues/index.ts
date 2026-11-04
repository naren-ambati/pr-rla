import { LEDGER_API_VERSION, defineLedger, type LedgerActor, type LedgerContext, type Verdict } from "../../sdk/ledger.js";
import { githubEndpoints } from "../../providers/github/index.js";
import { LedgerHttp, isoUtc, nextLink } from "../http.js";
import type { IndexedIssue } from "../issue-index.js";
import { IssueTrackerLedger, type ExistingDrawIssue, type TrackerIssue, type TrackerLabelEvent } from "../issue-ledger.js";

/**
 * `github-issues` (FR4.1, FR4.8): draws as issues in an audit repo on GitHub.com or GitHub
 * Enterprise Server, verdicts as labels read from REST issue events.
 *
 * REST, not GraphQL: REST events keep a label's name as it was applied, while GraphQL's
 * `LabeledEvent.label` follows a rename (recorded 2026-11-03 on rust-lang/rust #30003 and #30010,
 * BUILD-NOTES "Bolt 3"). The label ids the draws were published with are kept in the index,
 * because a renamed label's old name can be taken by a new label.
 *
 *   ledger:
 *     use: github-issues
 *     options: { repo: acme/audit }            # base_url: https://ghe.example.com for GHES
 */
export interface GitHubIssuesOptions {
  /** The audit repo, `owner/name`: draw issues and verdict labels live there. Only it is written. */
  repo: string;
  /** GitHub Enterprise Server root, e.g. `https://ghe.example.com` (REST at /api/v3). Taken from a `github` provider's base_url when absent. */
  base_url?: string;
  /** REST root, overriding base_url. */
  api_url?: string;
  /** Env var holding the token (default GITHUB_TOKEN, then GH_TOKEN; GH_ENTERPRISE_TOKEN too on GHES). Issues: write on the audit repo for sample and record; read for verify. */
  token_env?: string;
  /** Verdict and draw label names (defaults pr-rla:pass, pr-rla:fail, pr-rla:draw). */
  labels?: { pass?: string; fail?: string; draw?: string };
}

export const GITHUB_ISSUES_LABELS = { pass: "pr-rla:pass", fail: "pr-rla:fail", draw: "pr-rla:draw" } as const;

const COLORS: Record<Verdict | "draw", { color: string; description: string }> = {
  pass: { color: "1f883d", description: "pr-rla verdict: the change passes the registered review protocol" },
  fail: { color: "cf222e", description: "pr-rla verdict: the change fails the registered review protocol" },
  draw: { color: "8250df", description: "pr-rla: an audit draw to review" },
};

interface GhUser {
  login: string;
  id: number;
  type?: string;
}
interface GhEvent {
  id: number;
  event: string;
  created_at: string;
  actor: GhUser | null;
  label?: { name: string };
  performed_via_github_app?: { slug?: string; name?: string } | null;
}
interface GhIssue {
  number: number;
  node_id: string;
  html_url: string;
  created_at: string;
  repository_url: string;
  body: string | null;
  labels: ({ name: string } | string)[];
}

function parseRepo(repo: unknown): { owner: string; name: string } {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error(`github-issues: options.repo must be the audit repo as "owner/name"${typeof repo === "string" && repo.includes("<") ? " (replace the placeholder)" : ""}, got ${JSON.stringify(repo)}`);
  const [owner, name] = repo.split("/") as [string, string];
  return { owner, name };
}

/** The REST root and the audit repo's path under it, for both hosts() and writePaths(). */
function endpoints(o: GitHubIssuesOptions): { apiUrl: string; repoPath: string; enterprise: boolean } {
  const { owner, name } = parseRepo(o?.repo);
  const { apiUrl, enterprise } = githubEndpoints({ ...(o.base_url ? { base_url: o.base_url } : {}), ...(o.api_url ? { api_url: o.api_url } : {}) });
  return { apiUrl, repoPath: `/repos/${owner}/${name}`, enterprise };
}

export function githubActor(u: GhUser | null): LedgerActor {
  if (!u) return { login: "ghost", kind: "human" };
  const bot = u.type === "Bot" || u.login.endsWith("[bot]");
  return { login: bot && !u.login.endsWith("[bot]") ? `${u.login}[bot]` : u.login, kind: bot ? "bot" : "human", id: String(u.id) };
}

export class GitHubIssuesLedger extends IssueTrackerLedger {
  readonly name = "github-issues";
  readonly tracker: string;
  readonly where: string;
  readonly http: LedgerHttp;
  private readonly repoUrl: string;

  constructor(options: GitHubIssuesOptions, ctx: LedgerContext) {
    const o = options ?? ({} as GitHubIssuesOptions);
    super({ ...GITHUB_ISSUES_LABELS, ...o.labels }, ctx);
    const { apiUrl, repoPath, enterprise } = endpoints(o);
    const token = (o.token_env ? ctx.env[o.token_env] : undefined) ?? ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN ?? (enterprise ? ctx.env.GH_ENTERPRISE_TOKEN : undefined);
    this.where = o.repo;
    this.repoUrl = `${apiUrl}${repoPath}`;
    this.tracker = this.repoUrl;
    this.http = new LedgerHttp({
      ledger: this.name,
      baseUrl: this.repoUrl,
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      fetch: ctx.fetch,
      authHint: `set ${o.token_env ?? "GITHUB_TOKEN"} to a token with Issues: write on ${o.repo} (verify needs Issues: read)`,
    });
  }

  /** GitHub treats label names that differ only in case as one label (and a rename of only the case keeps the label, and its id). */
  protected override readonly caseInsensitiveLabels = true;

  protected async lookupLabel(name: string): Promise<{ id: string; name: string } | null> {
    const r = await this.http.get<{ id: number; name?: string }>(`/labels/${encodeURIComponent(name)}`, [404]);
    return r.status === 404 ? null : { id: String(r.data.id), name: r.data.name ?? name };
  }

  protected async canReadTracker(): Promise<boolean> {
    const r = await this.http.get<unknown>(this.repoUrl, [401, 403, 404]);
    return r.status >= 200 && r.status < 300;
  }

  protected async createLabel(name: string, role: Verdict | "draw"): Promise<{ id: string; name: string }> {
    const r = await this.http.request<{ id: number; name?: string }>("POST", "/labels", { body: { name, ...COLORS[role] } });
    return { id: String(r.data.id), name: r.data.name ?? name };
  }

  protected async listDrawIssues(drawLabel: string): Promise<ExistingDrawIssue[]> {
    const out: ExistingDrawIssue[] = [];
    let url: string | null = `/issues?state=all&labels=${encodeURIComponent(drawLabel)}&per_page=100`;
    while (url) {
      const r: Awaited<ReturnType<LedgerHttp["get"]>> = await this.http.get<GhIssue[]>(url);
      for (const i of r.data as GhIssue[]) out.push({ number: i.number, id: i.node_id, url: i.html_url, createdAt: isoUtc(i.created_at), body: i.body });
      url = nextLink(r.headers);
    }
    return out;
  }

  protected async createIssue(title: string, body: string, drawLabel: string): Promise<Omit<IndexedIssue, "draw" | "changeId">> {
    const r = await this.http.request<GhIssue>("POST", "/issues", { body: { title, body, labels: [drawLabel] } });
    return { number: r.data.number, id: r.data.node_id, url: r.data.html_url, createdAt: isoUtc(r.data.created_at) };
  }

  protected async readIssue(issue: IndexedIssue): Promise<TrackerIssue> {
    const r = await this.http.get<GhIssue>(`/issues/${issue.number}`, [404, 410]);
    if (r.status === 404 || r.status === 410) return { state: "deleted", detail: `HTTP ${r.status}` };
    if (r.data.repository_url.toLowerCase() !== this.repoUrl.toLowerCase()) return { state: "moved", detail: `now ${r.data.html_url}` };
    const events: TrackerLabelEvent[] = [];
    let url: string | null = `/issues/${issue.number}/events?per_page=100`;
    while (url) {
      const page: Awaited<ReturnType<LedgerHttp["get"]>> = await this.http.get<GhEvent[]>(url);
      for (const e of page.data as GhEvent[]) {
        const base = { id: String(e.id), at: isoUtc(e.created_at), actor: githubActor(e.actor), viaApp: e.performed_via_github_app?.slug ?? null, labelId: null };
        if (e.event === "labeled" || e.event === "unlabeled") events.push({ ...base, action: e.event === "labeled" ? "add" : "remove", labelName: e.label?.name ?? null });
        else if (e.event === "transferred") events.push({ ...base, action: "transfer", labelName: null });
      }
      url = nextLink(page.headers);
    }
    return { state: "ok", id: r.data.node_id, number: r.data.number, body: r.data.body ?? null, currentLabels: r.data.labels.map((l) => (typeof l === "string" ? l : l.name)), events };
  }

  protected async applyLabel(issue: IndexedIssue, label: string): Promise<void> {
    await this.http.request("POST", `/issues/${issue.number}/labels`, { body: { labels: [label] } });
  }

  protected async addNote(issue: IndexedIssue, body: string): Promise<void> {
    await this.http.request("POST", `/issues/${issue.number}/comments`, { body: { body } });
  }
}

export default defineLedger<GitHubIssuesOptions>({
  ledgerApiVersion: LEDGER_API_VERSION,
  name: "github-issues",
  description: "one issue per draw in an audit repo on GitHub.com or GHES; verdicts are labels read from REST issue events",
  provenance: "account",
  hosts: (options) => [new URL(endpoints(options).apiUrl).host],
  writePaths: (options) => {
    const { apiUrl, repoPath } = endpoints(options);
    const u = new URL(apiUrl);
    return [`${u.host}${u.pathname.replace(/\/+$/, "")}${repoPath}/`];
  },
  create: (options, ctx) => new GitHubIssuesLedger(options, ctx),
});
