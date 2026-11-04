import { OID, type ScCommit, type ScPr, type ScUser, type ScmScenario } from "./scm-scenario.js";

/**
 * A fake self-managed GitLab (REST v4 + the GraphQL queries pr-rla sends)
 * serving the shared scenario in GitLab's shapes:
 * - rebase and fast-forward MRs have no merge_commit_sha; GitLab rebases the
 *   source branch itself, so the MR's commits are the commits that land;
 * - squash MRs have squash_commit_sha (plus merge_commit_sha for squash + merge commit);
 * - REST user objects carry `bot` only on an MR's author; GraphQL has it everywhere;
 * - the direct-push bot commits as a project access token user;
 * - MR !5 has no GraphQL diff stats (exercises the REST diffs fallback).
 */
export const GL_BASE = "https://gitlab.example.com";
export const PROJECT_BOT_EMAIL = "project_42_bot_0a1b2c@noreply.gitlab.example.com";
/** The fake's stable numeric user id for a login (REST `id`, and the number in the GraphQL gid). */
export const glUserId = (login: string) => 100 + [...login].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_000, 7);

export function fakeGitLab(sc: ScmScenario, opts: { pageSize?: number } = {}) {
  let served = 0;
  const ps = opts.pageSize ?? 3;
  const pid = 42;
  // One stable numeric id per account (REST `id`; GraphQL `gid://gitlab/User/<id>`).
  const idOf = glUserId;
  const gid = (login: string) => `gid://gitlab/User/${idOf(login)}`;
  const user = (u: ScUser | null, withBot = false) => (u ? { id: idOf(u.login), username: u.login, ...(withBot ? { bot: u.bot } : {}) } : null);
  const merged = (p: ScPr) => p.mergedAt !== null;
  const mrCommits = (p: ScPr) => (p.strategy === "rebase" || p.strategy === "fast-forward" ? p.landed : p.listed);
  const mrJson = (p: ScPr) => ({
    iid: p.number,
    web_url: `${GL_BASE}/${sc.repo}/-/merge_requests/${p.number}`,
    state: merged(p) ? "merged" : "opened",
    target_branch: p.base,
    merged_at: p.mergedAt,
    updated_at: p.updatedAt,
    merge_commit_sha: p.strategy === "merge" || p.strategy === "squash+merge" ? p.mergeCommit : null,
    squash_commit_sha: p.strategy === "squash" || p.strategy === "squash+merge" ? p.squashCommit : null,
    sha: p.head,
    author: user(p.author, true),
    merge_user: user(p.mergedBy),
    merged_by: user(p.mergedBy),
    labels: p.labels,
  });
  const notes = (p: ScPr) => {
    const body: Record<string, [boolean, string]> = {
      approve: [true, "approved this merge request"],
      unapprove: [true, "unapproved this merge request"],
      request_changes: [true, "requested changes"],
      comment: [false, "Looks fine."],
      reset_by_push: [true, "reset approvals from @carol by pushing to the branch"],
    };
    return [
      { system: true, body: "requested review from @carol", createdAt: p.createdAt, author: { id: gid(p.author.login), username: p.author.login, bot: p.author.bot } },
      { system: false, body: "Ready for review.", createdAt: p.createdAt, author: { id: gid(p.author.login), username: p.author.login, bot: p.author.bot } },
      ...p.events.map((e) => ({ system: body[e.kind]![0], body: body[e.kind]![1], createdAt: e.at, author: { id: gid(e.user.login), username: e.user.login, bot: e.user.bot } })),
    ];
  };
  const standing = (p: ScPr) => {
    const m = new Map<string, { user: ScUser; at: string }>();
    for (const e of p.events) {
      if (e.kind === "approve") m.set(e.user.login, { user: e.user, at: e.at });
      if (e.kind === "unapprove" || e.kind === "reset_by_push") m.delete(e.kind === "reset_by_push" ? "carol" : e.user.login);
    }
    return [...m.values()];
  };
  const reviewerStates = (p: ScPr) => {
    const m = new Map<string, { user: ScUser; state: string }>();
    for (const e of p.events) {
      const state = { approve: "approved", unapprove: "unapproved", request_changes: "requested_changes", comment: "reviewed", reset_by_push: "unreviewed" }[e.kind];
      m.set(e.kind === "reset_by_push" ? "carol" : e.user.login, { user: e.kind === "reset_by_push" ? { login: "carol", bot: false } : e.user, state });
    }
    return [...m.values()].map((r) => ({ user: user(r.user), state: r.state, created_at: p.createdAt }));
  };
  const commitJson = (c: ScCommit) => ({
    id: c.oid,
    web_url: `${GL_BASE}/${sc.repo}/-/commit/${c.oid}`,
    committed_date: c.date.replace("Z", ".000+00:00"),
    author_name: c.author.name,
    author_email: c.oid === OID("D1") ? PROJECT_BOT_EMAIL : c.author.email,
    parent_ids: c.parents,
    stats: { additions: c.additions, deletions: c.deletions, total: c.additions + c.deletions },
  });
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
  const page = <T>(url: URL, items: T[], size = ps) => {
    const n = Number(url.searchParams.get("page") ?? "1");
    const per = Math.min(size, Number(url.searchParams.get("per_page") ?? size));
    const next = new URL(url);
    next.searchParams.set("page", String(n + 1));
    return json(items.slice((n - 1) * per, n * per), n * per < items.length ? { link: `<${next.href}>; rel="next"` } : {});
  };
  const pr = (iid: string) => sc.prs.find((p) => p.number === Number(iid))!;

  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    served++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    if (path === "/api/graphql") {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      const notesPage = (p: ScPr, after: string | null) => {
        const all = notes(p);
        const start = after ? Number(after) : 0;
        return { pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) }, nodes: all.slice(start, start + 100) };
      };
      if (query.includes("mergeRequests(iids")) {
        const nodes = (variables.iids as string[]).map((iid) => {
          const p = pr(iid);
          const g = (u: ScUser | null) => (u ? { id: gid(u.login), username: u.login, bot: u.bot } : null);
          return {
            iid: String(p.number),
            diffStatsSummary: p.number === 5 ? null : { additions: p.additions, deletions: p.deletions },
            author: g(p.author),
            mergeUser: g(p.mergedBy),
            approvedBy: { nodes: standing(p).map((s) => g(s.user)) },
            reviewers: { nodes: reviewerStates(p).map((r) => ({ id: gid(r.user!.username), username: r.user!.username, bot: sc.prs.flatMap((x) => x.events).find((e) => e.user.login === r.user!.username)?.user.bot ?? false })) },
            notes: notesPage(p, null),
          };
        });
        return json({ data: { project: { mergeRequests: { nodes: nodes.reverse() } } } }); // GitLab does not keep the requested order
      }
      if (query.includes("mergeRequest(iid")) return json({ data: { project: { mergeRequest: { notes: notesPage(pr(String(variables.iid)), String(variables.after)) } } } });
      return json({ errors: [{ message: "unknown query" }] });
    }
    const base = `/api/v4/projects/${pid}`;
    if (path === `/api/v4/projects/${encodeURIComponent(sc.repo)}` || path === `/api/v4/projects/${sc.repo}`) return json({ id: pid, default_branch: sc.defaultBranch, path_with_namespace: sc.repo });
    if (path === `${base}/merge_requests`) {
      const after = Date.parse(url.searchParams.get("updated_after") ?? "1970-01-01T00:00:00Z");
      const items = sc.prs.filter((p) => merged(p) && Date.parse(p.updatedAt) >= after).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map(mrJson);
      return page(url, items);
    }
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^${base}/merge_requests/(\\d+)/approvals$`).exec(path))) return json({ approved_by: standing(pr(m[1]!)).map((s) => ({ user: user(s.user), approved_at: s.at.replace("Z", ".123Z") })) });
    if ((m = new RegExp(`^${base}/merge_requests/(\\d+)/reviewers$`).exec(path))) return json(reviewerStates(pr(m[1]!)));
    if ((m = new RegExp(`^${base}/merge_requests/(\\d+)/commits$`).exec(path))) return page(url, [...mrCommits(pr(m[1]!))].reverse().map((oid) => ({ id: oid })), 2);
    if ((m = new RegExp(`^${base}/merge_requests/(\\d+)/diffs$`).exec(path))) {
      const p = pr(m[1]!);
      return page(url, Array.from({ length: p.additions }, () => ({ diff: "@@ -1 +1 @@\n-old\n+new\n" })));
    }
    if (path === `${base}/repository/branches/${sc.defaultBranch}`) return json({ name: sc.defaultBranch, commit: { id: sc.head } });
    if (path === `${base}/repository/commits`) {
      const since = Date.parse(url.searchParams.get("since")!);
      const until = Date.parse(url.searchParams.get("until")!);
      const items = sc.reachable(url.searchParams.get("ref_name")!).filter((c) => Date.parse(c.date) >= since && Date.parse(c.date) <= until).map(commitJson);
      return page(url, items, 4);
    }
    if ((m = new RegExp(`^${base}/repository/commits/([0-9a-f]{40})/merge_requests$`).exec(path))) {
      const sha = m[1]!;
      return json(sc.prs.filter((p) => [...p.landed, ...p.listed, p.mergeCommit, p.squashCommit].includes(sha)).map((p) => ({ iid: p.number, state: merged(p) ? "merged" : "opened", target_branch: p.base })));
    }
    return new Response(JSON.stringify({ message: "404 Not Found" }), { status: 404 });
  }) as typeof fetch;
  return { fetch: f, served: () => served };
}
