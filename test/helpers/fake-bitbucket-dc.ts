import { OID, type ScCommit, type ScPr, type ScUser, type ScmScenario } from "./scm-scenario.js";

/**
 * A fake Bitbucket Data Center REST 1.0 server serving the shared scenario in the
 * shapes Atlassian documents (no public server exists to record from):
 * - paging is start/limit/isLastPage/nextPageStart; timestamps are epoch ms;
 * - users are NORMAL or SERVICE; commit authors resolve to accounts when the e-mail matches;
 * - the merge commit is in properties.mergeCommit for most PRs, and only in the
 *   MERGED activity for PR #3 (older servers);
 * - "needs work" is a REVIEWED activity; withdrawing an approval is UNAPPROVED;
 * - PR diffs are hunks of ADDED/REMOVED/CONTEXT segments; PR #1's diff is truncated;
 * - the rebased PR #2 lists its ORIGINAL commits; the default branch has no /default-branch
 *   endpoint (a pre-7.6 server), so the provider must fall back to /branches/default.
 */
export const DC_BASE = "https://bitbucket.example.com";

export function fakeBitbucketDc(sc: ScmScenario, opts: { limit?: number } = {}) {
  let served = 0;
  const lim = opts.limit ?? 3;
  const [key, slug] = ["ACME", "widgets"];
  const api = `/rest/api/1.0/projects/${key}/repos/${slug}`;
  const ms = (iso: string) => Date.parse(iso);
  // A stable numeric id per account, as Data Center keeps it across renames.
  const idOf = (login: string) => 10 + [...login].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 1_000_000, 7);
  const user = (u: ScUser | null) => (u ? { id: idOf(u.login), name: u.login, slug: u.login, emailAddress: `${u.login}@example.com`, displayName: u.login.toUpperCase(), type: u.bot ? "SERVICE" : "NORMAL", active: true } : null);
  const landedAs = (p: ScPr) => p.mergeCommit ?? p.squashCommit ?? p.landed[p.landed.length - 1]!;
  const prCommits = (p: ScPr) => (p.strategy === "fast-forward" ? p.landed : p.strategy === "squash+merge" ? [p.squashCommit!] : p.listed);
  const finals = (p: ScPr) => {
    const m = new Map<string, { user: ScUser; status: string }>();
    for (const e of p.events) {
      const who = e.kind === "reset_by_push" ? { login: "carol", bot: false } : e.user;
      const status = { approve: "APPROVED", unapprove: "UNAPPROVED", request_changes: "NEEDS_WORK", comment: m.get(who.login)?.status ?? "UNAPPROVED", reset_by_push: "UNAPPROVED" }[e.kind];
      m.set(who.login, { user: who, status });
    }
    return [...m.values()].map((r) => ({ user: user(r.user), role: "REVIEWER", approved: r.status === "APPROVED", status: r.status }));
  };
  const activities = (p: ScPr) => {
    const out = [{ createdDate: ms(p.createdAt), user: user(p.author), action: "OPENED" }];
    out.push({ createdDate: ms(p.createdAt) + 1000, user: user(p.author), action: "COMMENTED", commentAction: "ADDED" } as never);
    for (const e of p.events) {
      const action = { approve: "APPROVED", unapprove: "UNAPPROVED", request_changes: "REVIEWED", comment: "COMMENTED", reset_by_push: "UNAPPROVED" }[e.kind];
      const who = e.kind === "reset_by_push" ? { login: "carol", bot: false } : e.user;
      out.push({ createdDate: ms(e.at), user: user(who), action, ...(e.kind === "comment" ? { commentAction: "ADDED" } : {}) } as never);
    }
    if (p.mergedAt) out.push({ createdDate: ms(p.mergedAt), user: user(p.mergedBy), action: "MERGED", commit: { id: landedAs(p) } } as never);
    return out.sort((a, b) => b.createdDate - a.createdDate);
  };
  const prJson = (p: ScPr) => ({
    id: p.number,
    version: 3,
    state: "MERGED",
    open: false,
    closed: true,
    createdDate: ms(p.createdAt),
    updatedDate: ms(p.updatedAt),
    closedDate: ms(p.mergedAt!),
    fromRef: { id: `refs/heads/feature-${p.number}`, latestCommit: p.head },
    toRef: { id: `refs/heads/${p.base}`, displayId: p.base },
    author: { user: user(p.author), role: "AUTHOR", approved: false, status: "UNAPPROVED" },
    reviewers: finals(p),
    participants: [],
    properties: p.number === 3 ? { mergeResult: { outcome: "CLEAN" } } : { mergeResult: { outcome: "CLEAN" }, mergeCommit: { id: landedAs(p), displayId: landedAs(p).slice(0, 11) } },
    links: { self: [{ href: `${DC_BASE}/projects/${key}/repos/${slug}/pull-requests/${p.number}` }] },
  });
  const commitJson = (c: ScCommit) => ({
    id: c.oid,
    displayId: c.oid.slice(0, 11),
    message: `${c.subject}\n\nbody`,
    author: c.author.user && (c.oid === OID("D1") || c.oid === OID("D2")) ? user(c.author.user) : { name: c.author.name, emailAddress: c.author.email },
    authorTimestamp: ms(c.authorDate),
    committerTimestamp: ms(c.date),
    parents: c.parents.map((id) => ({ id })),
  });
  const diff = (added: number, removed: number, truncated = false) => ({
    contextLines: 0,
    diffs: [{ hunks: [{ segments: [{ type: "CONTEXT", lines: [{}] }, { type: "REMOVED", lines: Array(removed).fill({}) }, { type: "ADDED", lines: Array(added).fill({}) }], truncated }] }],
    truncated,
  });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const page = <T>(url: URL, items: T[]) => {
    const start = Number(url.searchParams.get("start") ?? "0");
    const limit = Math.min(lim, Number(url.searchParams.get("limit") ?? lim));
    const values = items.slice(start, start + limit);
    const last = start + limit >= items.length;
    return json({ size: values.length, limit, start, isLastPage: last, values, ...(last ? {} : { nextPageStart: start + limit }) });
  };
  const pr = (id: string) => sc.prs.find((p) => p.number === Number(id))!;

  const f = (async (input: string | URL | Request) => {
    served++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (path === `${api}/default-branch`) return json({ errors: [{ message: "not found" }] }, 404);
    if (path === `${api}/branches/default`) return json({ id: `refs/heads/${sc.defaultBranch}`, displayId: sc.defaultBranch, latestCommit: sc.head, isDefault: true });
    if (path === `${api}/pull-requests`) {
      const at = url.searchParams.get("at");
      return page(url, sc.prs.filter((p) => p.mergedAt && `refs/heads/${p.base}` === at && url.searchParams.get("state") === "MERGED").sort((a, b) => b.number - a.number).map(prJson));
    }
    if ((m = new RegExp(`^${api}/pull-requests/(\\d+)/activities$`).exec(path))) return page(url, activities(pr(m[1]!)));
    if ((m = new RegExp(`^${api}/pull-requests/(\\d+)/commits$`).exec(path))) return page(url, [...prCommits(pr(m[1]!))].reverse().map((oid) => commitJson(sc.byOid.get(oid)!)));
    if ((m = new RegExp(`^${api}/pull-requests/(\\d+)/diff$`).exec(path))) {
      const p = pr(m[1]!);
      return json(diff(p.additions, p.deletions, p.number === 1));
    }
    if (path === api) return json({ id: 1, slug, project: { key }, public: false }); // repository metadata (U8, describeRepo)
    if (path === `${api}/commits`) {
      // since (U8, firstParentPath): commits reachable from until and not from since.
      const behind = new Set(url.searchParams.get("since") ? sc.reachable(url.searchParams.get("since")!).map((c) => c.oid) : []);
      return page(url, sc.reachable(url.searchParams.get("until")!).filter((c) => !behind.has(c.oid)).map(commitJson));
    }
    if ((m = new RegExp(`^${api}/commits/([0-9a-f]{40})/diff$`).exec(path))) {
      const c = sc.byOid.get(m[1]!)!;
      return json(diff(c.additions, c.deletions));
    }
    return json({ errors: [{ message: `no route ${path}` }] }, 404);
  }) as typeof fetch;
  return { fetch: f, served: () => served, repo: `${key}/${slug}` };
}
