import { describe, expect, it } from "vitest";
import bitbucketCloud from "../src/providers/bitbucket-cloud/index.js";
import bitbucketDc from "../src/providers/bitbucket-data-center/index.js";
import github from "../src/providers/github/index.js";
import gitlab from "../src/providers/gitlab/index.js";
import { resolveRepoSet } from "../src/core/repo-set.js";
import { isRepoEmpty, isRepoUnavailable, RepoEmptyError, RepoUnavailableError, type ListChangesRequest, type ProviderContext, type RepoSetRule, type ScmProvider } from "../src/sdk/provider.js";
import { CONFORMANCE_CHECKS, OPT_IN_CONFORMANCE_CHECKS, runProviderConformance, formatConformanceReport, type ConformanceCheck, type ConformanceFixture, type OptInConformanceCheck } from "../src/testing/index.js";
import { fakeBitbucketCloud } from "./helpers/fake-bitbucket-cloud.js";
import { fakeBitbucketDc } from "./helpers/fake-bitbucket-dc.js";
import { fakeGitLab, GL_BASE } from "./helpers/fake-gitlab.js";
import { scmScenario } from "./helpers/scm-scenario.js";
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

  it("an empty repository throws master's error, with a code the pooled freeze and verify read as 'empty' (finding 7)", async () => {
    const org = fakeOrg({ owner: ORG, seed: 1, repos: [{ name: "empty", prs: 0, pushes: 0, empty: true }] });
    const p = await github.create({}, ctxWith(org.fetch));
    const err = await p.listChanges({ repo: `${ORG}/empty`, window: WINDOW, kinds: ["pull_request", "direct_push"] }).catch((e) => e);
    expect(err).toBeInstanceOf(RepoEmptyError);
    expect(err).toMatchObject({ message: `${ORG}/empty has no default branch`, code: "REPO_EMPTY" });
    expect(isRepoEmpty(err)).toBe(true);
  });

  it("describeRepo reads one repository by its id (found after a rename) or its path; 404 is a RepoUnavailableError, 403 an access error", async () => {
    const org = fakeOrg(orgSpec({ eligible: 3 }));
    const p = await github.create({}, ctxWith(org.fetch));
    const id = org.idOf("svc-01");
    org.renameRepo("svc-01", "renamed");
    expect(await p.describeRepo!({ repo: `${ORG}/svc-01`, id })).toMatchObject({ repo: `${ORG}/renamed`, id, createdAt: "2020-01-01T00:00:00Z" });
    expect(await p.describeRepo!({ repo: `${ORG}/svc-02` })).toMatchObject({ repo: `${ORG}/svc-02`, visibility: "public" });
    await expect(p.describeRepo!({ repo: `${ORG}/nope` })).rejects.toMatchObject({ code: "REPO_UNAVAILABLE", status: 404 });
    org.control.gone.set(`${ORG}/svc-02`, 403);
    const forbidden = await p.describeRepo!({ repo: `${ORG}/svc-02` }).catch((e) => e);
    expect(forbidden).toMatchObject({ status: 403 });
    expect(forbidden.code).toBeUndefined();
  });

  it("listingVisibility: complete for private and internal only for an org owner with a classic token holding repo", async () => {
    const org = fakeOrg(orgSpec({ eligible: 3 }));
    const p = await github.create({}, { ...ctxWith(org.fetch), env: { GITHUB_TOKEN: "synthetic" } });
    const seen = () => p.listingVisibility!(rule(ORG));
    expect(await seen()).toEqual({ identity: "auditor", visibilities: { public: { complete: true, reason: "GitHub lists every public repository to anyone" }, private: { complete: true, reason: expect.stringMatching(/owner \(admin\) of acme-org, with a classic token holding the repo scope/) }, internal: { complete: true, reason: expect.stringMatching(/owner/) } } });
    org.control.viewer.scopes = "read:org";
    expect((await seen()).visibilities.private).toEqual({ complete: false, reason: "the classic token's scopes (read:org) do not include repo, so GitHub shows it no private repository" });
    org.control.viewer.scopes = null;
    expect((await seen()).visibilities.internal.reason).toMatch(/no X-OAuth-Scopes header, so it is a fine-grained personal access token or a GitHub App token/);
    org.control.viewer.scopes = "repo";
    org.control.viewer.role = "member";
    expect((await seen()).visibilities.private.complete).toBe(false);
    const anonymous = await github.create({}, ctxWith(org.fetch));
    expect(await anonymous.listingVisibility!(rule(ORG))).toMatchObject({ identity: null, visibilities: { public: { complete: true }, private: { complete: false, reason: "no token: GitHub shows only public repositories" } } });
  });

  it("firstParentPath reads the compare API: the first-parent commits after the base, or null when the base is not on that chain", async () => {
    const org = fakeOrg({ owner: ORG, seed: 3, repos: [{ name: "r", prs: 4, pushes: 2 }] });
    const h = org.history("r");
    const side = { oid: "a".repeat(40), date: "2026-09-30T12:00:00Z", parents: [h.commits.find((c) => c.oid === h.head)!.parents[0]!] };
    const merge = { oid: "b".repeat(40), date: "2026-10-25T09:00:00Z", parents: [h.head, side.oid] };
    org.pushCommits("r", [side, merge]);
    const p = await github.create({}, ctxWith(org.fetch));
    expect(await p.firstParentPath!({ repo: `${ORG}/r`, base: h.head, head: merge.oid })).toEqual([{ sha: merge.oid, committedAt: "2026-10-25T09:00:00Z" }]);
    expect(await p.firstParentPath!({ repo: `${ORG}/r`, base: side.oid, head: merge.oid })).toBeNull(); // reached only through the merge's second parent
    expect(await p.firstParentPath!({ repo: `${ORG}/r`, base: merge.oid, head: h.head })).toBeNull(); // behind
    expect(await p.firstParentPath!({ repo: `${ORG}/r`, base: h.head, head: h.head })).toEqual([]);
  });

  it("a 403 whose body says secondary rate limit is transient (GitHub documents it with or without headers), never 'unavailable'", async () => {
    const f = (async () => new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch;
    const p = await github.create({}, ctxWith(f));
    const err = await p.listChanges({ repo: `${ORG}/a`, window: WINDOW, kinds: ["pull_request"] }).catch((e) => e);
    expect(err).toMatchObject({ status: 0, message: expect.stringMatching(/HTTP 403 \(secondary rate limit\)/) });
    expect(isRepoUnavailable(err)).toBe(false);
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

describe("kit: repo-unavailable is an opt-in check (finding 6)", () => {
  const fixture = (over: Partial<ConformanceFixture> = {}): ConformanceFixture => ({ name: "synthetic org", request: { repo: `${ORG}/svc-00`, window: WINDOW, kinds: ["pull_request", "direct_push"] }, expect: {}, ...over });
  const only = (r: Awaited<ReturnType<typeof runProviderConformance>>) => r.results.filter((x) => x.check === "repo-unavailable");

  it("the GitHub built-in passes: it describes a repo, throws RepoUnavailableError(404) for a deleted one, and a rate limit is not 'gone'", async () => {
    const org = fakeOrg(orgSpec({ eligible: 2 }));
    const r = await runProviderConformance((_f, h) => github.create({}, h.context({ fetch: org.fetch, env: { GITHUB_TOKEN: "x" } })) as never, [fixture({ repoUnavailable: { gone: `${ORG}/deleted` } })]);
    expect(only(r)).toEqual([{ fixture: "synthetic org", check: "repo-unavailable", ok: true }]);
  });

  it("catches a provider that reports a deleted repo as a plain error, or a rate limit as a gone repo", async () => {
    const make = (gone: () => Error, limited: (e: unknown) => Error): ((f: ConformanceFixture, h: { context(b: { fetch: typeof fetch }): ProviderContext }) => ScmProvider) => (_f, h) => {
      const ctx = h.context({ fetch: (async () => new Response("{}")) as typeof fetch });
      return {
        apiVersion: 1,
        name: "bad",
        listChanges: async () => {
          try {
            await ctx.fetch("https://scm.invalid/x", { destination: "scm" } as RequestInit);
          } catch (e) {
            throw limited(e);
          }
          return { changes: [], defaultBranch: "main", limitations: [] };
        },
        describeRepo: async (ref) => {
          if (ref.repo.endsWith("deleted")) throw gone();
          return { repo: ref.repo, id: "1", defaultBranch: "main", archived: false, fork: false, visibility: "public" };
        },
      };
    };
    const plain = await runProviderConformance(make(() => new Error("not found"), (e) => e as Error) as never, [fixture({ repoUnavailable: { gone: `${ORG}/deleted` } })]);
    expect(only(plain)[0]).toMatchObject({ ok: false, message: expect.stringMatching(/threw Error: not found, not a RepoUnavailableError \(code REPO_UNAVAILABLE\)/) });
    const lying = await runProviderConformance(make(() => new RepoUnavailableError(`${ORG}/deleted`, 404), () => Object.assign(new Error("gone"), { status: 403 })) as never, [fixture({ repoUnavailable: { gone: `${ORG}/deleted` } })]);
    expect(only(lying)[0]).toMatchObject({ ok: false, message: "under a rate-limited 403, listChanges threw Error: gone, which counts as a gone repository (isRepoUnavailable): a rate limit never is one" });
    const none: ScmProvider = { apiVersion: 1, name: "none", listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }) };
    expect(only(await runProviderConformance(none, [fixture({ repoUnavailable: { gone: "x/y" } })]))[0]).toMatchObject({ ok: false, message: "the fixture expects describeRepo, but the provider implements none" });
  });

  it("ConformanceCheck is unchanged for an exhaustive switch; the opt-in checks have their own type", () => {
    // A compile-time test (npm run typecheck covers test/): this switch must stay exhaustive over ConformanceCheck.
    const label = (c: ConformanceCheck): number => {
      switch (c) {
        case "api-version": case "normalization": case "window-and-kinds": case "classification": case "merge-strategies": case "no-double-counting": case "stable-sorted-ids": case "review-state-mapping": case "actors": case "bot-detection": case "pagination": case "kind-filtering": case "transient-faults": case "pinned-head": case "actor-ids": case "review-granularity": case "revoked-approval":
          return 1;
        default: {
          const never: never = c;
          return never;
        }
      }
    };
    expect(CONFORMANCE_CHECKS.map(label).length).toBe(17);
    const optIn: readonly OptInConformanceCheck[] = OPT_IN_CONFORMANCE_CHECKS;
    expect(optIn).toEqual(["list-repos", "estimate-requests", "repo-unavailable"]);
  });
});

describe("describeRepo and firstParentPath on GitLab, Bitbucket Cloud and Bitbucket Data Center (U8 fix round)", () => {
  const sc = scmScenario({ latePush: true });
  it("GitLab: a project by id or path; first parents from a revision range", async () => {
    const p = await gitlab.create({ base_url: GL_BASE }, ctxWith(fakeGitLab(sc).fetch));
    expect(await p.describeRepo!({ repo: sc.repo })).toMatchObject({ repo: sc.repo, id: "42", createdAt: "2020-01-01T00:00:00Z" });
    expect(await p.describeRepo!({ repo: sc.repo, id: "42" })).toMatchObject({ repo: sc.repo });
    await expect(p.describeRepo!({ repo: "acme/nope" })).rejects.toMatchObject({ code: "REPO_UNAVAILABLE", status: 404 });
    expect(await p.firstParentPath!({ repo: sc.repo, base: sc.frozenHead, head: sc.head })).toEqual([{ sha: sc.head, committedAt: sc.byOid.get(sc.head)!.date }]);
    expect(await p.firstParentPath!({ repo: sc.repo, base: sc.head, head: sc.frozenHead })).toBeNull();
  });

  it("Bitbucket Cloud: a repository by slug or {uuid}; first parents from include/exclude", async () => {
    const p = await bitbucketCloud.create({}, ctxWith(fakeBitbucketCloud(sc).fetch));
    expect(await p.describeRepo!({ repo: sc.repo })).toMatchObject({ repo: sc.repo, id: "{fake-uuid}", visibility: "public", createdAt: "2020-01-01T00:00:00Z" });
    expect(await p.describeRepo!({ repo: sc.repo, id: "{fake-uuid}" })).toMatchObject({ repo: sc.repo });
    await expect(p.describeRepo!({ repo: "acme/nope" })).rejects.toMatchObject({ code: "REPO_UNAVAILABLE", status: 404 });
    expect(await p.firstParentPath!({ repo: sc.repo, base: sc.frozenHead, head: sc.head })).toEqual([{ sha: sc.head, committedAt: sc.byOid.get(sc.head)!.date }]);
  });

  it("Bitbucket Data Center: a repository by path; first parents from since/until (UNVERIFIED against a live server)", async () => {
    const fake = fakeBitbucketDc(sc);
    const p = await bitbucketDc.create({ base_url: "https://bitbucket.example.com" }, ctxWith(fake.fetch));
    expect(await p.describeRepo!({ repo: fake.repo })).toMatchObject({ repo: fake.repo, id: "1", visibility: "private" });
    await expect(p.describeRepo!({ repo: "ACME/nope" })).rejects.toMatchObject({ code: "REPO_UNAVAILABLE", status: 404 });
    expect(await p.firstParentPath!({ repo: fake.repo, base: sc.frozenHead, head: sc.head })).toEqual([{ sha: sc.head, committedAt: sc.byOid.get(sc.head)!.date }]);
  });
});
