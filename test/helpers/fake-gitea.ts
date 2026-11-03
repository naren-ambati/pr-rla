import { OID, type ScCommit, type ScPr, type ScUser, type ScmScenario } from "./scm-scenario.js";

/**
 * A fake Gitea/Forgejo API v1 serving the shared scenario in Gitea's shapes:
 * - every merged PR has merge_commit_sha (the merge commit, the squash commit, the last
 *   rebased commit, or the fast-forwarded head);
 * - the list endpoint returns merged_by: null (as Forgejo does on Codeberg); GET /pulls/{n} has it;
 * - the rebased PR #2 lists its ORIGINAL commits; their rebased copies keep author, date and message;
 * - no bot flag exists: bots are the Actions user (id -2) or listed in options.bots;
 * - /commits ignores since/until (as Forgejo does), so the provider must stop by date itself.
 */
export const GITEA_BASE = "https://forge.example.com";

const plus2 = (iso: string) => new Date(Date.parse(iso) + 7_200_000).toISOString().replace(".000Z", "+02:00");

export function fakeGitea(sc: ScmScenario, opts: { limit?: number } = {}) {
  let served = 0;
  const lim = opts.limit ?? 3;
  const api = `/api/v1/repos/${sc.repo}`;
  const ids = new Map<string, number>();
  const user = (u: ScUser | null) => (u ? { id: u.login === "deploy-bot" ? -2 : (ids.get(u.login) ?? ids.set(u.login, ids.size + 1).get(u.login)!), login: u.login === "deploy-bot" ? "forgejo-actions" : u.login } : null);
  const landedAs = (p: ScPr) => p.mergeCommit ?? p.squashCommit ?? p.landed[p.landed.length - 1]!;
  const listedCommits = (p: ScPr) => (p.strategy === "fast-forward" ? p.landed : p.strategy === "squash+merge" ? [p.squashCommit!] : p.listed);
  const prJson = (p: ScPr, full: boolean) => ({
    number: p.number,
    html_url: `${GITEA_BASE}/${sc.repo}/pulls/${p.number}`,
    state: "closed",
    merged: p.mergedAt !== null,
    merged_at: p.mergedAt ? plus2(p.mergedAt) : null, // Gitea reports server-local time with an offset
    updated_at: p.updatedAt,
    merge_commit_sha: p.mergedAt ? landedAs(p) : null,
    base: { ref: p.base },
    head: { sha: p.head },
    user: user(p.author),
    merged_by: full ? user(p.mergedBy) : null,
    labels: p.labels.map((name) => ({ name })),
    // Forgejo reports zero stats on some merged PRs (seen on Codeberg); PR 3 does here, so /files must be read.
    additions: p.number === 3 ? 0 : p.additions,
    deletions: p.number === 3 ? 0 : p.deletions,
    changed_files: p.number === 3 ? 0 : 1,
  });
  const reviewsOf = (p: ScPr) => {
    const out: Record<string, unknown>[] = [];
    let id = 1;
    for (const e of p.events) {
      if (e.kind === "approve") out.push({ id: id++, user: user(e.user), state: "APPROVED", submitted_at: e.at, dismissed: false, stale: false, official: true });
      if (e.kind === "request_changes") out.push({ id: id++, user: user(e.user), state: "REQUEST_CHANGES", submitted_at: e.at, dismissed: false });
      if (e.kind === "comment") out.push({ id: id++, user: user(e.user), state: "COMMENT", submitted_at: e.at, dismissed: false });
      // Gitea dismisses an approval explicitly; a withdrawn or push-reset approval shows as dismissed.
      if (e.kind === "unapprove" || e.kind === "reset_by_push") {
        const who = e.kind === "reset_by_push" ? "carol" : e.user.login;
        const prev = [...out].reverse().find((r) => (r.user as { login: string }).login === who && r.state === "APPROVED");
        if (prev) prev.dismissed = true;
      }
    }
    out.push({ id: id++, user: user(p.author), state: "REQUEST_REVIEW", submitted_at: null, dismissed: false }); // a review request is not a review
    return out;
  };
  const commitJson = (c: ScCommit) => ({
    sha: c.oid,
    html_url: `${GITEA_BASE}/${sc.repo}/commit/${c.oid}`,
    parents: c.parents.map((sha) => ({ sha })),
    author: c.oid === OID("D1") ? user(c.author.user) : c.oid === OID("D2") ? user(c.author.user) : null,
    stats: { total: c.additions + c.deletions, additions: c.additions, deletions: c.deletions },
    commit: { message: `${c.subject}\n\nbody`, author: { name: c.author.name, email: c.author.email, date: c.authorDate }, committer: { name: "Forge", email: "noreply@forge.example.com", date: c.date } },
  });
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
  const page = <T>(url: URL, items: T[]) => {
    const n = Number(url.searchParams.get("page") ?? "1");
    const per = Math.min(lim, Number(url.searchParams.get("limit") ?? lim));
    const next = new URL(url);
    next.searchParams.set("page", String(n + 1));
    return json(items.slice((n - 1) * per, n * per), { ...(n * per < items.length ? { link: `<${next.href}>; rel="next"` } : {}), "x-total-count": String(items.length) });
  };
  const pr = (n: string) => sc.prs.find((p) => p.number === Number(n))!;

  const f = (async (input: string | URL | Request) => {
    served++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (path === api) return json({ full_name: sc.repo, default_branch: sc.defaultBranch, html_url: `${GITEA_BASE}/${sc.repo}` });
    if (path === `${api}/pulls`) return page(url, [...sc.prs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((p) => prJson(p, false)));
    if ((m = new RegExp(`^${api}/pulls/(\\d+)$`).exec(path))) return json(prJson(pr(m[1]!), true));
    if ((m = new RegExp(`^${api}/pulls/(\\d+)/reviews$`).exec(path))) return page(url, reviewsOf(pr(m[1]!)));
    if ((m = new RegExp(`^${api}/pulls/(\\d+)/files$`).exec(path))) {
      const p = pr(m[1]!);
      return page(url, [{ filename: "a.ts", additions: p.additions, deletions: 0 }, { filename: "b.ts", additions: 0, deletions: p.deletions }]);
    }
    if ((m = new RegExp(`^${api}/pulls/(\\d+)/commits$`).exec(path))) return page(url, listedCommits(pr(m[1]!)).map((o) => commitJson(sc.byOid.get(o)!)));
    if (path === `${api}/branches/${sc.defaultBranch}`) return json({ name: sc.defaultBranch, commit: { id: sc.head } });
    if (path === `${api}/commits`) return page(url, sc.reachable(url.searchParams.get("sha")!).map(commitJson));
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as typeof fetch;
  return { fetch: f, served: () => served };
}
