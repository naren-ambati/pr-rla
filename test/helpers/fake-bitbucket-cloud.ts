import { OID, type ScCommit, type ScPr, type ScUser, type ScmScenario } from "./scm-scenario.js";

/**
 * A fake Bitbucket Cloud 2.0 API serving the shared scenario in Bitbucket's shapes:
 * - `merge_commit.hash` is abbreviated to 12 characters; `closed_on` is never set;
 * - merge time and merger exist only as the MERGED `update` in the activity;
 * - bots are `app_user` accounts; withdrawn approvals vanish from the activity;
 * - a fast-forward's merge_commit is the source head; a squash PR lists its squash
 *   commit as its commits (as seen on atlassian/bamboo-specs #745);
 * - the rebased PR #2 lists its ORIGINAL commits (the worst case): its rebased
 *   copies on main must be attributed by author + message;
 * - the `state` parameter is ignored when `q` is given (real behaviour), so the
 *   provider must filter on state inside `q`.
 */
export function fakeBitbucketCloud(sc: ScmScenario, opts: { pageLen?: number } = {}) {
  let served = 0;
  const pl = opts.pageLen ?? 3;
  const base = `/2.0/repositories/${sc.repo}`;
  const user = (u: ScUser | null) =>
    !u ? null : u.bot ? { type: "app_user", uuid: `{${u.login}}`, display_name: u.login, account_id: `app:${u.login}` } : { type: "user", uuid: `{${u.login}}`, nickname: u.login, display_name: u.login.toUpperCase(), account_id: `acc:${u.login}` };
  const short = (oid: string | null) => (oid ? oid.slice(0, 12) : null);
  const landedAs = (p: ScPr) => p.mergeCommit ?? p.squashCommit ?? p.landed[p.landed.length - 1]!;
  const prCommits = (p: ScPr) => (p.strategy === "squash" ? [p.squashCommit!] : p.strategy === "fast-forward" || p.strategy === "squash+merge" ? (p.strategy === "squash+merge" ? [p.squashCommit!] : p.landed) : p.listed);
  const standing = (p: ScPr) => {
    const m = new Map<string, { user: ScUser; at: string }>();
    for (const e of p.events) {
      if (e.kind === "approve") m.set(e.user.login, { user: e.user, at: e.at });
      if (e.kind === "unapprove") m.delete(e.user.login);
      if (e.kind === "reset_by_push") m.delete("carol");
    }
    return m;
  };
  const activity = (p: ScPr) => {
    const items: { at: string; v: Record<string, unknown> }[] = [];
    items.push({ at: p.createdAt, v: { update: { state: "OPEN", date: p.createdAt, author: user(p.author) } } });
    for (const s of standing(p).values()) items.push({ at: s.at, v: { approval: { date: s.at, user: user(s.user) } } });
    for (const e of p.events) {
      if (e.kind === "request_changes") items.push({ at: e.at, v: { changes_requested: { date: e.at, user: user(e.user) } } });
      if (e.kind === "comment") items.push({ at: e.at, v: { comment: { created_on: e.at.replace("Z", ".000000+00:00"), user: user(e.user) } } });
    }
    items.push({ at: p.createdAt, v: { comment: { created_on: p.createdAt, user: user(p.author) } } }); // the author's own comment is not a review
    if (p.mergedAt) items.push({ at: p.mergedAt, v: { update: { state: "MERGED", date: p.mergedAt.replace("Z", ".202450+00:00"), author: user(p.mergedBy) } } });
    return items.sort((a, b) => (a.at < b.at ? 1 : -1)).map((x) => ({ ...x.v, pull_request: { id: p.number } }));
  };
  const participants = (p: ScPr) => {
    const m = new Map<string, Record<string, unknown>>();
    for (const e of p.events) {
      const prev = m.get(e.user.login) ?? { role: "PARTICIPANT", approved: false, state: null, participated_on: e.at, user: user(e.user) };
      if (e.kind === "request_changes") Object.assign(prev, { state: "changes_requested", participated_on: e.at });
      m.set(e.user.login, prev);
    }
    for (const [login, s] of standing(p)) m.set(login, { role: "REVIEWER", approved: true, state: "approved", participated_on: s.at, user: user(s.user) });
    return [...m.values()];
  };
  const prJson = (p: ScPr) => ({
    id: p.number,
    state: p.mergedAt ? "MERGED" : "OPEN",
    updated_on: p.updatedAt.replace("Z", ".154292+00:00"),
    closed_on: null,
    destination: { branch: { name: p.base } },
    source: { commit: { hash: short(p.head) } },
    merge_commit: { hash: short(landedAs(p)) },
    author: user(p.author),
    closed_by: user(p.mergedBy),
    links: { html: { href: `https://bitbucket.org/${sc.repo}/pull-requests/${p.number}` } },
    participants: participants(p),
  });
  const commitJson = (c: ScCommit) => ({
    hash: c.oid,
    date: c.date.replace("Z", "+00:00"),
    parents: c.parents.map((hash) => ({ hash })),
    message: `${c.subject}\n\nbody`,
    author: { raw: `${c.author.name} <${c.oid === OID("D1") ? "k0pte9d0wz@bots.bitbucket.org" : c.author.email}>`, user: c.oid === OID("D1") ? user(c.author.user) : c.author.user && !c.author.user.bot ? user(c.author.user) : null },
    links: { html: { href: `https://bitbucket.org/${sc.repo}/commits/${c.oid}` } },
  });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const page = <T>(url: URL, items: T[], size = pl) => {
    const n = Number(url.searchParams.get("page") ?? "1");
    const per = Math.min(size, Number(url.searchParams.get("pagelen") ?? size));
    const next = new URL(url);
    next.searchParams.set("page", String(n + 1));
    return json({ pagelen: per, page: n, values: items.slice((n - 1) * per, n * per), ...(n * per < items.length ? { next: next.href } : {}) });
  };
  const pr = (id: string) => sc.prs.find((p) => p.number === Number(id))!;
  const find = (hash: string) => sc.commits.find((c) => c.oid.startsWith(hash))!;

  const f = (async (input: string | URL | Request) => {
    served++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (path === base) return json({ mainbranch: { name: sc.defaultBranch } });
    if (path === `${base}/pullrequests`) {
      const q = url.searchParams.get("q") ?? "";
      const after = Date.parse(/updated_on >= (\S+)/.exec(q)?.[1] ?? "1970-01-01T00:00:00Z");
      const onlyMerged = /state="MERGED"/.test(q);
      const items = sc.prs.filter((p) => (!onlyMerged || p.mergedAt) && Date.parse(p.updatedAt) >= after).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map(prJson);
      return page(url, items);
    }
    if ((m = new RegExp(`^${base}/pullrequests/(\\d+)/activity$`).exec(path))) return page(url, activity(pr(m[1]!)), 50);
    if ((m = new RegExp(`^${base}/pullrequests/(\\d+)/commits$`).exec(path))) return page(url, [...prCommits(pr(m[1]!))].reverse().map((oid) => commitJson(sc.byOid.get(oid)!)), 2);
    if ((m = new RegExp(`^${base}/pullrequests/(\\d+)/diffstat$`).exec(path))) {
      const p = pr(m[1]!);
      return page(url, [{ lines_added: p.additions, lines_removed: 0 }, { lines_added: 0, lines_removed: p.deletions }], 1);
    }
    if (path === `${base}/refs/branches/${sc.defaultBranch}`) return json({ target: { hash: sc.head } });
    if ((m = new RegExp(`^${base}/commits/([0-9a-f]{40})$`).exec(path))) return page(url, sc.reachable(m[1]!).map(commitJson), 4);
    if ((m = new RegExp(`^${base}/commit/([0-9a-f]+)$`).exec(path))) return json({ hash: find(m[1]!).oid, date: find(m[1]!).date });
    if ((m = new RegExp(`^${base}/diffstat/([0-9a-f]{40})$`).exec(path))) {
      const c = find(m[1]!);
      return page(url, [{ lines_added: c.additions, lines_removed: c.deletions }]);
    }
    return new Response(JSON.stringify({ type: "error", error: { message: "not found" } }), { status: 404 });
  }) as typeof fetch;
  return { fetch: f, served: () => served };
}
