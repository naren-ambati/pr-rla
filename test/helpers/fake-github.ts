/**
 * A synthetic GitHub (REST pulls + the GraphQL queries pr-rla sends) over one
 * hand-built commit graph. Used for classification cases real repos rarely
 * show in one window: squash, merge commit, rebase merge, direct pushes,
 * a PR merged into another branch, a missing association, >100 reviews.
 */
export interface FakeCommit {
  oid: string;
  date: string;
  parents: string[];
  prs?: { number: number; merged: boolean; baseRefName: string }[];
  author?: { name: string; email: string; login: string | null };
  lines?: number;
}

export interface FakePr {
  number: number;
  base: string;
  mergedAt: string | null;
  updatedAt: string;
  mergeCommit: string | null;
  author: { __typename: string; login: string } | null;
  mergedBy: { __typename: string; login: string } | null;
  reviews: { state: string; submittedAt: string | null; author: { __typename: string; login: string } | null }[];
  additions: number;
  deletions: number;
  labels?: string[];
}

const h = (c: string) => c.repeat(40).slice(0, 40);
export const OID = (tag: string) => h(Buffer.from(tag).toString("hex"));

export function fakeGitHub(repo: string, head: string, commits: FakeCommit[], prs: FakePr[], opts: { pageSize?: number; failHistoryAbove?: number } = {}) {
  let served = 0;
  const byOid = new Map(commits.map((c) => [c.oid, c]));
  const commitNode = (c: FakeCommit) => ({
    oid: c.oid,
    url: `https://github.com/${repo}/commit/${c.oid}`,
    committedDate: c.date,
    additions: c.lines ?? 10,
    deletions: 0,
    parents: { nodes: c.parents.map((oid) => ({ oid })) },
    author: c.author ? { name: c.author.name, email: c.author.email, user: c.author.login ? { login: c.author.login } : null } : { name: "Dev", email: "dev@example.com", user: { login: "dev" } },
    associatedPullRequests: { nodes: c.prs ?? [] },
  });
  // git log order from head: reverse chronological over all reachable commits.
  const reachable: FakeCommit[] = [];
  const seen = new Set<string>();
  const stack = [head];
  while (stack.length) {
    const o = stack.pop()!;
    if (seen.has(o) || !byOid.has(o)) continue;
    seen.add(o);
    reachable.push(byOid.get(o)!);
    stack.push(...byOid.get(o)!.parents);
  }
  reachable.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const prNode = (p: FakePr, first = 100) => ({
    number: p.number,
    url: `https://github.com/${repo}/pull/${p.number}`,
    merged: p.mergedAt !== null,
    mergedAt: p.mergedAt,
    baseRefName: p.base,
    additions: p.additions,
    deletions: p.deletions,
    author: p.author,
    mergedBy: p.mergedBy,
    mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null,
    labels: { nodes: (p.labels ?? []).map((name) => ({ name })) },
    reviews: { totalCount: p.reviews.length, pageInfo: { hasNextPage: p.reviews.length > first, endCursor: p.reviews.length > first ? String(first) : null }, nodes: p.reviews.slice(0, first) },
  });
  const pageSize = opts.pageSize ?? 2;
  const restSorted = [...prs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    served++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === `/repos/${repo}/pulls`) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const per = Math.min(pageSize, Number(url.searchParams.get("per_page") ?? pageSize));
      const items = restSorted.slice((page - 1) * per, page * per).map((p) => ({ number: p.number, merged_at: p.mergedAt, updated_at: p.updatedAt, base: { ref: p.base }, merge_commit_sha: p.mergeCommit }));
      const next: Record<string, string> = page * per < restSorted.length ? { link: `<https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${per}&page=${page + 1}>; rel="next"` } : {};
      return json(items, next);
    }
    if (url.pathname.endsWith("/graphql")) {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (query.includes("defaultBranchRef")) return json({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: head } } } } });
      if (query.includes("history(")) {
        const size = Number(/history\(first: (\d+)/.exec(query)![1]);
        if (opts.failHistoryAbove !== undefined && size > opts.failHistoryAbove) return new Response("bad gateway", { status: 502 });
        const since = Date.parse(String(variables.since));
        const all = reachable.filter((c) => Date.parse(c.date) >= since);
        const start = variables.after ? Number(variables.after) : 0;
        const nodes = all.slice(start, start + size).map(commitNode);
        return json({ data: { repository: { object: { history: { pageInfo: { hasNextPage: start + size < all.length, endCursor: String(start + size) }, nodes } } } } });
      }
      if (query.includes("object(oid: $oid)")) {
        const c = byOid.get(String(variables.oid));
        return json({ data: { repository: { object: c ? commitNode(c) : null } } });
      }
      if (query.includes("reviews(first: 100, after: $after)")) {
        const p = prs.find((x) => x.number === variables.number)!;
        const start = Number(variables.after);
        const nodes = p.reviews.slice(start, start + 100);
        return json({ data: { repository: { pullRequest: { reviews: { pageInfo: { hasNextPage: start + 100 < p.reviews.length, endCursor: String(start + 100) }, nodes } } } } });
      }
      const repoData: Record<string, unknown> = {};
      for (const m of query.matchAll(/p(\d+): pullRequest\(number: (\d+)\)/g)) {
        const p = prs.find((x) => x.number === Number(m[2]));
        repoData[`p${m[1]}`] = p ? prNode(p) : null;
      }
      return json({ data: { repository: repoData } });
    }
    if (url.pathname === "/search/issues") return json({ total_count: 0 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, served: () => served };
}

const U = (login: string) => ({ __typename: "User", login });
const B = (login: string) => ({ __typename: "Bot", login });
const rev = (state: string, at: string | null, author: { __typename: string; login: string } | null) => ({ state, submittedAt: at, author });

/** The canonical classification scenario used by tests and docs. Window: 2026-08-01 (UTC). */
export function classificationScenario() {
  const c = (tag: string, date: string, parents: string[], extra: Partial<FakeCommit> = {}): FakeCommit => ({ oid: OID(tag), date, parents: parents.map(OID), ...extra });
  const pr = (number: number, base = "main") => ({ number, merged: true, baseRefName: base });
  const commits: FakeCommit[] = [
    c("H10", "2026-08-02T10:00:00Z", ["D2"], { prs: [pr(10)] }), // squash, after window
    c("D2", "2026-08-01T20:00:00Z", ["M3"], { author: { name: "Alice", email: "alice@example.com", login: "alice" }, lines: 7 }), // direct push
    c("M3", "2026-08-01T18:00:00Z", ["R2c", "F3b"], { prs: [pr(3)] }), // merge commit of PR 3
    c("F3b", "2026-08-01T09:00:00Z", ["F3a"], { prs: [pr(3)] }), // PR 3's own commits (2nd parent)
    c("F3a", "2026-07-31T12:00:00Z", ["S1"], { prs: [pr(3)] }),
    c("S5", "2026-08-01T16:00:00Z", ["R2c"], {}), // PR 5 squash commit with NO association (GitHub gap), placed below M3
    c("R2c", "2026-08-01T15:00:03Z", ["R2b"], { prs: [pr(2)] }), // rebase merge of PR 2: 3 commits
    c("R2b", "2026-08-01T15:00:02Z", ["R2a"], { prs: [pr(2)] }),
    c("R2a", "2026-08-01T15:00:01Z", ["S1"], { prs: [pr(2)] }),
    c("S1", "2026-08-01T12:00:00Z", ["D1"], { prs: [pr(1)] }), // squash of PR 1
    c("D1", "2026-08-01T08:00:00Z", ["B0"], { prs: [{ number: 7, merged: false, baseRefName: "main" }], author: { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com", login: null }, lines: 3 }), // direct push; only an UNMERGED PR contains it
    c("B0", "2026-07-31T23:00:00Z", [], { prs: [pr(0)] }), // before window
  ];
  // Put S5 on the first-parent chain: M3's first parent is S5, S5's is R2c.
  commits.find((x) => x.oid === OID("M3"))!.parents = [OID("S5"), OID("F3b")];
  const many = Array.from({ length: 150 }, (_, i) => rev("COMMENTED", `2026-08-01T11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`, B("copilot-pull-request-reviewer")));
  const prs: FakePr[] = [
    { number: 10, base: "main", mergedAt: "2026-08-02T10:00:01Z", updatedAt: "2026-08-02T10:00:05Z", mergeCommit: OID("H10"), author: B("copilot-swe-agent"), mergedBy: U("maint"), reviews: [], additions: 1, deletions: 1 },
    { number: 3, base: "main", mergedAt: "2026-08-01T18:00:01Z", updatedAt: "2026-08-01T18:00:09Z", mergeCommit: OID("M3"), author: U("bob"), mergedBy: U("maint"), reviews: [rev("APPROVED", "2026-08-01T17:00:00Z", U("carol"))], additions: 40, deletions: 2 },
    { number: 5, base: "main", mergedAt: "2026-08-01T16:00:01Z", updatedAt: "2026-08-01T16:00:02Z", mergeCommit: OID("S5"), author: B("copilot-swe-agent"), mergedBy: U("maint"), reviews: [rev("APPROVED", "2026-08-01T15:30:00Z", B("github-actions"))], additions: 5, deletions: 5 },
    { number: 2, base: "main", mergedAt: "2026-08-01T15:00:04Z", updatedAt: "2026-08-01T15:00:06Z", mergeCommit: OID("R2c"), author: B("copilot-swe-agent"), mergedBy: B("github-merge-queue"), reviews: [rev("CHANGES_REQUESTED", "2026-08-01T14:00:00Z", U("dave")), rev("DISMISSED", "2026-08-01T14:10:00Z", U("erin")), rev("PENDING", null, U("frank"))], additions: 30, deletions: 3 },
    { number: 4, base: "release", mergedAt: "2026-08-01T13:00:00Z", updatedAt: "2026-08-01T13:00:01Z", mergeCommit: "f".repeat(40), author: U("bob"), mergedBy: U("maint"), reviews: [], additions: 1, deletions: 0 },
    { number: 1, base: "main", mergedAt: "2026-08-01T12:00:01Z", updatedAt: "2026-08-01T12:30:00Z", mergeCommit: OID("S1"), author: B("copilot-swe-agent"), mergedBy: U("maint"), reviews: many, additions: 150, deletions: 50, labels: ["agent"] },
    { number: 7, base: "main", mergedAt: null, updatedAt: "2026-08-01T07:00:00Z", mergeCommit: null, author: U("bob"), mergedBy: null, reviews: [], additions: 1, deletions: 0 },
    { number: 0, base: "main", mergedAt: "2026-07-31T23:00:01Z", updatedAt: "2026-07-31T23:00:02Z", mergeCommit: OID("B0"), author: U("bob"), mergedBy: U("maint"), reviews: [], additions: 1, deletions: 0 },
  ];
  return { repo: "acme/widgets", head: OID("H10"), commits, prs, window: { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" } };
}
