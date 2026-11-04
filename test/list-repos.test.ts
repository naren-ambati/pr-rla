import { describe, expect, it } from "vitest";
import bitbucketCloud from "../src/providers/bitbucket-cloud/index.js";
import bitbucketDc from "../src/providers/bitbucket-data-center/index.js";
import github from "../src/providers/github/index.js";
import gitlab from "../src/providers/gitlab/index.js";
import { resolveRepoSet } from "../src/core/repo-set.js";
import type { ListChangesRequest, ProviderContext, RepoSetRule, ScmProvider } from "../src/sdk/provider.js";
import { runProviderConformance, formatConformanceReport, type ConformanceFixture } from "../src/testing/index.js";
import { fakeOrg, orgSpec, ORG, WINDOW } from "./helpers/fake-org.js";

/**
 * `listRepos` on the built-in providers (U8; fixture kind: synthetic, one hand-made server per SCM) and the two opt-in
 * kit checks. Each provider lists an owner's repositories with the stable id, archived and fork flags and visibility
 * the core filters on; none of them filters itself.
 */
const rule = (owner: string, over: Partial<RepoSetRule> = {}): RepoSetRule => ({ kind: "rule", owner, include: ["*"], exclude: [], archived: false, forks: false, visibility: ["internal", "private", "public"], ...over });
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ctxWith = (fetch: typeof globalThis.fetch): ProviderContext => ({ cwd: ".", env: {}, log: () => {}, fetch });

describe("GitHub listRepos", () => {
  it("lists an org's repositories page by page with id, default branch, archived, fork and visibility", async () => {
    const org = fakeOrg(orgSpec({ eligible: 8, archived: 1, forks: 1 }));
    const p = await github.create({ page_size: 4 }, ctxWith(org.fetch));
    const refs = await p.listRepos!(rule(ORG));
    expect(refs).toHaveLength(10);
    expect(refs.find((r) => r.repo === `${ORG}/old-0`)).toMatchObject({ archived: true, fork: false });
    expect(refs.find((r) => r.repo === `${ORG}/fork-0`)).toMatchObject({ archived: false, fork: true });
    expect(refs.find((r) => r.repo === `${ORG}/svc-03`)!.visibility).toBe("private");
    expect(refs.find((r) => r.repo === `${ORG}/svc-05`)!.visibility).toBe("internal");
    expect(refs.every((r) => /^\d+$/.test(r.id) && r.defaultBranch === "main")).toBe(true);
    // The core then applies the rule: archived repos and forks are out by default.
    expect((await resolveRepoSet(p, rule(ORG))).map((r) => r.repo)).toEqual(Array.from({ length: 8 }, (_, i) => `${ORG}/svc-0${i}`));
    expect(await resolveRepoSet(p, rule(ORG, { archived: true, forks: true }))).toHaveLength(10);
  });

  it("falls back to the user's own repositories when the owner is not an org", async () => {
    const seen: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      seen.push(u.pathname + u.search);
      if (u.pathname.startsWith("/orgs/")) return json({ message: "Not Found" }, {}, 404);
      return json([{ full_name: "alice/dotfiles", id: 7, default_branch: "main", private: false }]);
    }) as typeof fetch;
    const refs = await (await github.create({}, ctxWith(f))).listRepos!(rule("alice"));
    expect(refs).toEqual([{ repo: "alice/dotfiles", id: "7", defaultBranch: "main", archived: false, fork: false, visibility: "public" }]);
    expect(seen).toEqual(["/orgs/alice/repos?type=all&per_page=100", "/users/alice/repos?type=owner&per_page=100"]);
  });

  it("an owner that does not exist at all is a 404 the caller sees (register refuses it)", async () => {
    const f = (async () => json({ message: "Not Found" }, {}, 404)) as typeof fetch;
    await expect((await github.create({}, ctxWith(f))).listRepos!(rule("nobody"))).rejects.toMatchObject({ status: 404 });
  });

  it("an empty repository has no changes in any window: it does not stop an org-wide pool", async () => {
    const org = fakeOrg({ owner: ORG, seed: 1, repos: [{ name: "empty", prs: 0, pushes: 0, empty: true }] });
    const p = await github.create({}, ctxWith(org.fetch));
    const r = await p.listChanges({ repo: `${ORG}/empty`, window: WINDOW, kinds: ["pull_request", "direct_push"] });
    expect(r).toMatchObject({ changes: [], defaultBranch: "" });
    expect(r.headSha).toBeUndefined();
  });

  it("a deleted or invisible repository is a 404 or 403, whichever API reports it", async () => {
    const org = fakeOrg(orgSpec({ eligible: 2 }));
    org.control.gone.set(`${ORG}/svc-00`, 404);
    org.control.gone.set(`${ORG}/svc-01`, 403);
    const p = await github.create({}, ctxWith(org.fetch));
    const req = (repo: string): ListChangesRequest => ({ repo, window: WINDOW, kinds: ["pull_request"] });
    await expect(p.listChanges(req(`${ORG}/svc-00`))).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/Could not resolve to a Repository/) });
    await expect(p.listChanges(req(`${ORG}/svc-01`))).rejects.toMatchObject({ status: 403 });
  });
});

describe("estimateRequests on GitHub", () => {
  const one = async (spec: { prs: number; pushes: number }, kinds: ListChangesRequest["kinds"]) => {
    const org = fakeOrg({ owner: ORG, seed: 3, repos: [{ name: "r", after: 2, ...spec }] });
    const p = await github.create({}, ctxWith(org.fetch)) as ScmProvider;
    const req = { repo: `${ORG}/r`, window: WINDOW, kinds };
    const before = org.requests();
    const est = await p.estimateRequests!(req);
    const probed = org.requests() - before;
    const b2 = org.requests();
    await p.listChanges(req);
    return { est, probed, actual: org.requests() - b2 };
  };

  it("is exact when the first pages hold everything (a small repo), and counts only what it asks", async () => {
    const { est, probed, actual } = await one({ prs: 30, pushes: 5 }, ["pull_request", "direct_push"]);
    expect(est.requests).toBe(actual);
    expect(est.probed).toBe(probed);
    expect(est.graphql).toBeGreaterThan(0);
  });

  it("without direct pushes it reads no history; without pull requests, no PR batches", async () => {
    const prsOnly = await one({ prs: 30, pushes: 5 }, ["pull_request"]);
    const pushesOnly = await one({ prs: 30, pushes: 5 }, ["direct_push"]);
    expect(prsOnly.est.requests).toBe(prsOnly.actual);
    expect(pushesOnly.est.requests).toBe(pushesOnly.actual);
    expect(pushesOnly.est.requests).toBeLessThan(prsOnly.est.requests + 5);
  });

  it("extrapolates a large repo from its first pages to within 15%", async () => {
    const { est, actual } = await one({ prs: 700, pushes: 150 }, ["pull_request", "direct_push"]);
    expect(Math.abs(est.requests - actual) / actual).toBeLessThan(0.15);
    expect(est.probed).toBeLessThanOrEqual(4);
  });

  it("an empty repository costs its probe", async () => {
    const org = fakeOrg({ owner: ORG, seed: 1, repos: [{ name: "empty", prs: 0, pushes: 0, empty: true }] });
    const p = await github.create({}, ctxWith(org.fetch));
    expect(await p.estimateRequests!({ repo: `${ORG}/empty`, window: WINDOW, kinds: ["pull_request"] })).toEqual({ requests: 1, graphql: 1, probed: 1 });
  });
});

describe("GitLab, Bitbucket Cloud and Bitbucket Data Center listRepos", () => {
  it("GitLab: a group's projects, subgroups included; a fork carries forked_from_project; a user namespace is the fallback", async () => {
    const seen: string[] = [];
    const proj = (id: number, path: string, extra: Record<string, unknown> = {}) => ({ id, path_with_namespace: path, default_branch: "main", visibility: "private", archived: false, ...extra });
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      seen.push(u.pathname + u.search);
      if (u.pathname === "/api/v4/groups/acme/projects") {
        return u.searchParams.get("page") === "2"
          ? json([proj(3, "acme/team/b", { visibility: "internal", forked_from_project: { id: 9 } })])
          : json([proj(1, "acme/a", { visibility: "public" }), proj(2, "acme/team/old", { archived: true })], { link: `<https://gitlab.com/api/v4/groups/acme/projects?page=2>; rel="next"` });
      }
      if (u.pathname === "/api/v4/groups/solo/projects") return json({ message: "404 Group Not Found" }, {}, 404);
      if (u.pathname === "/api/v4/users/solo/projects") return json([proj(4, "solo/x", { default_branch: null })]);
      return json({}, {}, 404);
    }) as typeof fetch;
    const p = await gitlab.create({}, ctxWith(f));
    const refs = await p.listRepos!(rule("acme"));
    expect(refs.map((r) => [r.repo, r.id, r.visibility, r.archived, r.fork])).toEqual([
      ["acme/a", "1", "public", false, false],
      ["acme/team/old", "2", "private", true, false],
      ["acme/team/b", "3", "internal", false, true],
    ]);
    expect(seen[0]).toBe("/api/v4/groups/acme/projects?include_subgroups=true&with_shared=false&per_page=100&order_by=path&sort=asc");
    expect((await p.listRepos!(rule("solo")))[0]).toMatchObject({ repo: "solo/x", defaultBranch: "" });
    // A subgroup is written as a glob over the full path (here with forks kept in, since !b is one, and the archived project out).
    expect((await resolveRepoSet(p, rule("acme", { include: ["acme/team/**"], forks: true }))).map((r) => r.repo)).toEqual(["acme/team/b"]);
  });

  it("Bitbucket Cloud: a workspace's repositories, paged by next; no archived state; parent marks a fork", async () => {
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname !== "/2.0/repositories/ws") return json({}, {}, 404);
      return u.searchParams.get("page") === "2"
        ? json({ values: [{ full_name: "ws/c", uuid: "{c}", is_private: true, mainbranch: null, parent: { full_name: "other/c" } }] })
        : json({ values: [{ full_name: "ws/a", uuid: "{a}", is_private: false, mainbranch: { name: "master" } }, { full_name: "ws/b", uuid: "{b}", is_private: true, mainbranch: { name: "main" } }], next: "https://api.bitbucket.org/2.0/repositories/ws?page=2" });
    }) as typeof fetch;
    const refs = await (await bitbucketCloud.create({}, ctxWith(f))).listRepos!(rule("ws"));
    expect(refs).toEqual([
      { repo: "ws/a", id: "{a}", defaultBranch: "master", archived: false, fork: false, visibility: "public" },
      { repo: "ws/b", id: "{b}", defaultBranch: "main", archived: false, fork: false, visibility: "private" },
      { repo: "ws/c", id: "{c}", defaultBranch: "", archived: false, fork: true, visibility: "private" },
    ]);
  });

  it("Bitbucket Data Center: a project's repositories, paged by start; origin marks a fork (UNVERIFIED against a live server)", async () => {
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname !== "/rest/api/1.0/projects/PROJ/repos") return json({}, {}, 404);
      return u.searchParams.get("start") === "2"
        ? json({ values: [{ id: 12, slug: "gamma", project: { key: "PROJ" }, public: false, archived: true }], isLastPage: true })
        : json({ values: [{ id: 10, slug: "alpha", project: { key: "PROJ" }, public: true }, { id: 11, slug: "beta", project: { key: "PROJ" }, origin: { id: 1 } }], isLastPage: false, nextPageStart: 2 });
    }) as typeof fetch;
    const refs = await (await bitbucketDc.create({ base_url: "https://bb.example.com", page_size: 2 }, ctxWith(f))).listRepos!(rule("PROJ"));
    expect(refs.map((r) => [r.repo, r.id, r.visibility, r.archived, r.fork])).toEqual([
      ["PROJ/alpha", "10", "public", false, false],
      ["PROJ/beta", "11", "private", false, true],
      ["PROJ/gamma", "12", "private", true, false],
    ]);
  });
});

describe("kit: list-repos and estimate-requests are opt-in checks", () => {
  const fixture = (over: Partial<ConformanceFixture> = {}): ConformanceFixture => ({
    name: "synthetic org",
    request: { repo: `${ORG}/svc-00`, window: WINDOW, kinds: ["pull_request", "direct_push"] },
    expect: {},
    ...over,
  });
  const only = (r: Awaited<ReturnType<typeof runProviderConformance>>, check: string) => r.results.filter((x) => x.check === check);

  it("a fixture without them adds no result for either", async () => {
    const org = fakeOrg(orgSpec({ eligible: 2 }));
    const r = await runProviderConformance(await github.create({}, ctxWith(org.fetch)), [fixture()]);
    expect(only(r, "list-repos")).toEqual([]);
    expect(only(r, "estimate-requests")).toEqual([]);
  });

  it("the GitHub built-in passes both on the synthetic org", async () => {
    const org = fakeOrg(orgSpec({ eligible: 5, archived: 1 }));
    const r = await runProviderConformance(
      () => github.create({}, ctxWith(org.fetch)) as never,
      [fixture({ listRepos: { rule: rule(ORG), includes: [`${ORG}/svc-00`, `${ORG}/svc-04`], ids: { [`${ORG}/svc-00`]: "1001" } }, estimate: true })],
    );
    expect(only(r, "list-repos")).toEqual([{ fixture: "synthetic org", check: "list-repos", ok: true }]);
    expect(only(r, "estimate-requests")).toEqual([{ fixture: "synthetic org", check: "estimate-requests", ok: true }]);
  });

  it("a provider without listRepos fails a fixture that expects it; one without estimateRequests fails estimate", async () => {
    const bare: ScmProvider = { apiVersion: 1, name: "bare", listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }) };
    const r = await runProviderConformance(bare, [fixture({ listRepos: { rule: rule(ORG), includes: [] }, estimate: true })]);
    expect(only(r, "list-repos")[0]).toMatchObject({ ok: false, message: "the fixture expects listRepos, but the provider implements none" });
    expect(only(r, "estimate-requests")[0]).toMatchObject({ ok: false, message: "the fixture expects estimateRequests, but the provider implements none" });
  });

  it("catches a listing that is malformed, duplicated, outside the owner, incomplete or unstable", async () => {
    let call = 0;
    const p: ScmProvider = {
      apiVersion: 1,
      name: "bad",
      listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }),
      listRepos: async () => {
        call++;
        const good = { repo: `${ORG}/a`, id: "1", defaultBranch: "main", archived: false, fork: false, visibility: "public" as const };
        return [good, good, { ...good, repo: "elsewhere/x", id: `${call}` }, { ...good, repo: `${ORG}/b`, id: "", visibility: "secret" as never }];
      },
    };
    const r = await runProviderConformance(p, [fixture({ listRepos: { rule: rule(ORG), includes: [`${ORG}/a`, `${ORG}/missing`], ids: { [`${ORG}/a`]: "9" } } })]);
    const c = only(r, "list-repos")[0]!;
    expect(c.ok).toBe(false);
    for (const want of [/is listed twice/, /elsewhere\/x" is not a repo path under acme-org/, /has no stable id/, /visibility "secret"/, /1 expected repo\(s\) not found \(e\.g\. acme-org\/missing\)/, /acme-org\/a: id 1 ≠ 9/, /two identical calls listed different repos or ids/]) expect(c.message).toMatch(want);
    expect(formatConformanceReport(r)).toMatch(/FAIL synthetic org › list-repos/);
  });

  it("estimateRequests must answer whole counts that add up", async () => {
    const mk = (est: unknown): ScmProvider => ({ apiVersion: 1, name: "est", listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }), estimateRequests: async () => est as never });
    const run = async (est: unknown) => only(await runProviderConformance(mk(est), [fixture({ estimate: true })]), "estimate-requests")[0]!;
    expect((await run({ requests: 10, graphql: 4, probed: 3 })).ok).toBe(true);
    expect((await run({ requests: 0 })).message).toMatch(/requests must be a whole number of at least 1/);
    expect((await run({ requests: 3, graphql: 5 })).message).toMatch(/graphql must be a whole number of at most requests/);
    expect((await run({ requests: 3, probed: 1.5 })).message).toMatch(/probed must be a whole number of at most requests/);
  });
});
