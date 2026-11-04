import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { assemblePopulation, buildPooledPopulation, buildPopulation, checkListed, mapPool } from "../src/core/population.js";
import { manifestRepoProblems, normalizeRepoSet, resolveRepoSet, RepoSetError, repoSetLabel, validateRepoSet, globMatches, repoMatchesRule, applyRule, splitScheme } from "../src/core/repo-set.js";
import type { RepoSet } from "../src/core/records.js";
import { normalizeSelector } from "../src/core/selector.js";
import { RepoUnavailableError, type ChangeRecord, type ListChangesRequest, type RepoRef, type RepoSetRule, type ScmProvider } from "../src/sdk/provider.js";

/**
 * U8 at the core: repo sets and their resolution (FR5.1, FR5.7), the population rules every caller gets
 * (FR5.6: one provider per pool, AuditCore), and the pooled population as the union of per-repo
 * populations under one selector (FR5.2). Pure: providers here are in-memory stubs (fixture kind: synthetic).
 */
const WINDOW = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" };
const sha = (tag: string) => Buffer.from(tag).toString("hex").padStart(40, "0").slice(-40);

function change(scheme: string, repo: string, n: number, over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    id: `${scheme}:${repo}#${n}`,
    kind: "pull_request",
    repo,
    url: `https://example.invalid/${repo}/pull/${n}`,
    mergeSha: sha(`${repo}:${n}`),
    mergedAt: `2026-08-${String(1 + (n % 27)).padStart(2, "0")}T10:00:00Z`,
    author: { login: "bob", kind: "human" },
    mergedBy: { login: "maint", kind: "human" },
    reviews: n % 3 === 0 ? [{ author: { login: "carol", kind: "human" }, state: "APPROVED", submittedAt: "2026-07-30T10:00:00Z" }] : [],
    changedLines: n,
    labels: [],
    ...over,
  };
}

function stub(name: string, repos: Record<string, number>, opts: { scheme?: string; refs?: RepoRef[]; listed?: string[] } = {}): ScmProvider {
  return {
    apiVersion: 1,
    name,
    async listChanges(req: ListChangesRequest) {
      opts.listed?.push(req.repo);
      const n = repos[req.repo];
      if (n === undefined) throw new RepoUnavailableError(req.repo, 404);
      return { changes: Array.from({ length: n }, (_, i) => change(opts.scheme ?? name, req.repo, i + 1)), defaultBranch: "main", limitations: ["limit"], headSha: sha(`head:${req.repo}`) };
    },
    ...(opts.refs ? { listRepos: async () => opts.refs! } : {}),
  };
}

const ref = (repo: string, over: Partial<RepoRef> = {}): RepoRef => ({ repo, id: `id-${repo}`, defaultBranch: "main", archived: false, fork: false, visibility: "public", ...over });
const rule = (over: Partial<RepoSetRule> = {}): RepoSetRule => ({ kind: "rule", owner: "acme", include: ["*"], exclude: [], archived: false, forks: false, visibility: ["internal", "private", "public"], ...over });
const sel = normalizeSelector({ kinds: ["pull_request"], unreviewed: "no-human-review" });

describe("FR5.1 / FR5.7: the repo set a config registers", () => {
  const cfg = (extra: string) => parseConfig(`provider: github\n${extra}\nwindow: { name: w, start: 2026-07-01, end: 2026-09-30 }\n`, "/x/.pr-rla.yml");

  it("repo: is a pool of one (kind repo); repos: takes a list or a rule", () => {
    expect(cfg("repo: acme/app").repoSet).toEqual({ kind: "repo", repo: "acme/app" });
    expect(cfg("repo: acme/app").repo).toBe("acme/app");
    expect(cfg("repos: [acme/b, acme/a, acme/b]").repoSet).toEqual({ kind: "list", repos: ["acme/a", "acme/b"] });
    expect(cfg("repos: { owner: acme }").repoSet).toEqual(rule());
    expect(repoSetLabel(cfg("repos: { owner: acme }").repoSet)).toBe("acme/*");
  });

  it("the defaults are archived and forks excluded and every visibility included; the flags and filters change them", () => {
    expect(cfg("repos: { owner: acme }").repoSet).toMatchObject({ archived: false, forks: false, visibility: ["internal", "private", "public"], include: ["*"], exclude: [] });
    expect(cfg("repos: { owner: acme, archived: true, forks: true, visibility: [public], include: [b*, a*], exclude: [x] }").repoSet).toEqual(rule({ archived: true, forks: true, visibility: ["public"], include: ["a*", "b*"], exclude: ["x"] }));
  });

  it("two spellings of one rule register the same bytes (sorted, de-duplicated)", () => {
    const a = cfg("repos: { owner: acme, exclude: [z*, a*, a*], visibility: [public, private] }").repoSet;
    const b = cfg("repos: { visibility: [private, public], exclude: [a*, z*], owner: acme }").repoSet;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("refuses a malformed set with the setting named", () => {
    expect(() => cfg("repo: acme/app\nrepos: [acme/b]")).toThrow(/either "repo".*or "repos".*not both/);
    expect(() => cfg("repos: { owner: acme, skip: [x] }")).toThrow(/repos\.skip is not a setting/);
    expect(() => cfg("repos: { owner: acme, visibility: [secret] }")).toThrow(/"secret" is not one of public, private, internal/);
    expect(() => cfg("repos: { owner: acme, include: [] }")).toThrow(/include is empty/);
    expect(() => cfg("repos: { owner: acme, archived: sometimes }")).toThrow(/archived must be true or false/);
    expect(() => cfg("repos: []")).toThrow(/repos is empty/);
    expect(() => cfg("selector: {}")).toThrow(/"repo" is required/);
    expect(() => normalizeRepoSet({ repos: "acme" })).toThrow(RepoSetError);
  });

  it("freeze: takes a concurrency, default 4 (FR5.7)", () => {
    expect(cfg("repo: a/b").freeze).toEqual({ concurrency: 4 });
    expect(cfg("repo: a/b\nfreeze: { concurrency: 8 }").freeze).toEqual({ concurrency: 8 });
    expect(() => cfg("repo: a/b\nfreeze: { concurrency: 0 }")).toThrow(/whole number from 1 to 32/);
    expect(() => cfg("repo: a/b\nfreeze: { skip_repo: x }")).toThrow(/freeze\.skip_repo is not a setting/);
  });
});

describe("FR5.1: globs and rule application", () => {
  it("a pattern without / matches the repo's last segment; with / the whole path; ** crosses segments", () => {
    expect(globMatches("svc-*", "acme/svc-01")).toBe(true);
    expect(globMatches("svc-*", "acme/other")).toBe(false);
    expect(globMatches("acme/svc-*", "acme/svc-01")).toBe(true);
    expect(globMatches("acme/*", "acme/team/svc")).toBe(false);
    expect(globMatches("acme/**", "acme/team/svc")).toBe(true);
    expect(globMatches("SVC-0?", "acme/svc-01")).toBe(true);
    expect(globMatches("a.b", "acme/aXb")).toBe(false);
  });

  it("a repo is in the rule when it is under the owner, included and not excluded", () => {
    const r = rule({ include: ["svc-*"], exclude: ["*-tmp"] });
    expect(repoMatchesRule(r, "acme/svc-a")).toBe(true);
    expect(repoMatchesRule(r, "acme/svc-a-tmp")).toBe(false);
    expect(repoMatchesRule(r, "acme/web")).toBe(false);
    expect(repoMatchesRule(r, "other/svc-a")).toBe(false);
  });

  it("applyRule drops archived repos, forks and other visibilities unless the rule keeps them", () => {
    const refs = [ref("acme/a"), ref("acme/b", { archived: true }), ref("acme/c", { fork: true }), ref("acme/d", { visibility: "private" })];
    expect(applyRule(rule(), refs).map((r) => r.repo)).toEqual(["acme/a", "acme/d"]);
    expect(applyRule(rule({ archived: true, forks: true }), refs).map((r) => r.repo)).toEqual(["acme/a", "acme/b", "acme/c", "acme/d"]);
    expect(applyRule(rule({ visibility: ["public"] }), refs).map((r) => r.repo)).toEqual(["acme/a"]);
  });
});

describe("FR5.1: a rule resolves to the same list on two runs over the same state", () => {
  const refs = [ref("acme/zeta"), ref("acme/alpha"), ref("acme/Mid"), ref("acme/gone", { archived: true })];
  it("sorted by repo, with the SCM's stable id; independent of the order the provider lists them", async () => {
    const a = await resolveRepoSet(stub("github", {}, { refs }), rule());
    const b = await resolveRepoSet(stub("github", {}, { refs: [...refs].reverse() }), rule());
    expect(a).toEqual(b);
    expect(a).toEqual([
      { repo: "acme/Mid", repoId: "id-acme/Mid" },
      { repo: "acme/alpha", repoId: "id-acme/alpha" },
      { repo: "acme/zeta", repoId: "id-acme/zeta" },
    ]);
  });

  it("a list resolves to itself, sorted, with no ids; a single repo is a pool of one", async () => {
    const p = stub("github", {});
    expect(await resolveRepoSet(p, { kind: "list", repos: ["github:acme/b", "acme/a"] })).toEqual([
      { repo: "acme/a", repoId: null },
      { repo: "acme/b", repoId: null },
    ]);
    expect(await resolveRepoSet(p, { kind: "repo", repo: "acme/solo" })).toEqual([{ repo: "acme/solo", repoId: null }]);
  });

  it("re-validates what the provider returns, whatever it is", async () => {
    const bad = async (refs: unknown, why: RegExp) => await expect(resolveRepoSet({ name: "github", listRepos: async () => refs as RepoRef[] }, rule())).rejects.toThrow(why);
    await bad([ref("other/a")], /not under acme/);
    await bad([ref("acme/a"), ref("ACME/A")], /returned ACME\/A twice/);
    await bad([{ ...ref("acme/a"), id: "" }], /has no id/);
    await bad([{ ...ref("acme/a"), visibility: "secret" }], /visibility "secret"/);
    await bad([{ ...ref("acme/a"), archived: "no" }], /archived and fork as true or false/);
    await bad("nope", /returned string, not a list/);
  });
});

describe("FR5.6: one provider per pooled registration, enforced by AuditCore", () => {
  const gh = stub("github", {});

  it("a list naming repos on two providers is refused with the reason", () => {
    expect(() => validateRepoSet({ kind: "list", repos: ["github:acme/a", "gitlab:acme/b"] }, gh)).toThrow(/one provider per pooled registration: the repo list names repositories on github and gitlab/);
  });

  it("a list naming another provider's repos than the configured one is refused", () => {
    expect(() => validateRepoSet({ kind: "list", repos: ["gitlab:acme/a"] }, gh)).toThrow(/names gitlab repositories, but the provider is github/);
    expect(() => validateRepoSet({ kind: "list", repos: ["github:acme/a", "acme/b"] }, gh)).not.toThrow();
  });

  it("resolveRepoSet applies the rule too, so every caller gets it", async () => {
    await expect(resolveRepoSet(gh, { kind: "list", repos: ["github:acme/a", "gitlab:acme/b"] })).rejects.toThrow(/one provider per pooled registration/);
  });

  it("a rule needs listRepos: the refusal names the provider", () => {
    expect(() => validateRepoSet(rule(), gh)).toThrow(/provider github cannot list an owner's repositories \(it has no listRepos\)/);
    expect(() => validateRepoSet(rule(), stub("github", {}, { refs: [] }))).not.toThrow();
  });

  it("a malformed or repeated list entry is named", () => {
    expect(() => validateRepoSet({ kind: "list", repos: ["justaname"] }, gh)).toThrow(/"justaname" must look like owner\/name/);
    expect(() => validateRepoSet({ kind: "list", repos: ["acme/a", "ACME/a"] }, gh)).toThrow(/ACME\/a is listed twice \(acme\/a and ACME\/a\)/);
  });

  it("the pooled population refuses changes of two id schemes, however the provider got them", () => {
    const listed = (scheme: string, repo: string) => ({ repo, listed: { changes: [change(scheme, repo, 1)], defaultBranch: "main", limitations: [] } });
    expect(() => assemblePopulation("mixed", [listed("github", "acme/a"), listed("gitlab", "acme/b")], { window: WINDOW, selector: sel, cutoffIso: "2026-10-20T00:00:00Z" })).toThrow(/one provider, but provider mixed returned changes of github and gitlab/);
    expect(() => assemblePopulation("github", [listed("github", "acme/a"), listed("github", "acme/b")], { window: WINDOW, selector: sel, cutoffIso: "2026-10-20T00:00:00Z" })).not.toThrow();
  });

  it("splitScheme reads a provider prefix", () => {
    expect(splitScheme("github:acme/a")).toEqual({ scheme: "github", path: "acme/a" });
    expect(splitScheme("acme/a")).toEqual({ scheme: null, path: "acme/a" });
  });
});

describe("FR5.2: the pooled population is the union of per-repo populations under one selector", () => {
  const sizes = { "acme/a": 30, "acme/b": 12, "acme/c": 21 };
  const args = { window: WINDOW, selector: sel, cutoffIso: "2026-10-20T00:00:00Z" };

  it("equals the selector applied over every repo's listing, sorted by id, with N and the kinds summed", async () => {
    const p = stub("github", sizes);
    const pooled = await buildPooledPopulation(p, { repos: Object.keys(sizes).map((repo) => ({ repo })), ...args });
    const perRepo = await Promise.all(Object.keys(sizes).map((repo) => buildPopulation(p, { repo, ...args })));
    const unionIds = perRepo.flatMap((x) => x.entries.map((e) => e.id)).sort();
    expect(pooled.entries.map((e) => e.id)).toEqual(unionIds);
    expect(pooled.entries.length).toBe(perRepo.reduce((n, x) => n + x.entries.length, 0));
    expect(pooled.byKind.pull_request).toBe(63);
    expect(pooled.repos.map((r) => [r.repo, r.listed])).toEqual([["acme/a", 30], ["acme/b", 12], ["acme/c", 21]]);
    expect(pooled.repos.every((r) => r.headSha === sha(`head:${r.repo}`))).toBe(true);
    expect(pooled.limitations).toEqual(["limit"]);
    expect(pooled.headSha).toBeNull();
  });

  it("the same pool in any order, finishing in any order, is the same population, byte for byte", async () => {
    // Each repo lists its changes in a different order on every call, carries its own limitation and diagnostic,
    // and answers after a delay that depends on the call, so the repos finish in a different order each time.
    let call = 0;
    const p: ScmProvider = {
      apiVersion: 1,
      name: "github",
      async listChanges(req) {
        const k = ++call;
        await new Promise((r) => setTimeout(r, (k * 7) % 5));
        const changes = Array.from({ length: sizes[req.repo as keyof typeof sizes] }, (_, i) => change("github", req.repo, i + 1));
        if (k % 2) changes.reverse();
        return { changes, defaultBranch: "main", limitations: [`limit of ${req.repo}`, "shared"], diagnostics: [{ label: `only ${req.repo}`, value: sizes[req.repo as keyof typeof sizes] }, { label: "all", value: 1 }], headSha: sha(`head:${req.repo}`) };
      },
    };
    const a = await buildPooledPopulation(p, { repos: [{ repo: "acme/a" }, { repo: "acme/b" }, { repo: "acme/c" }], concurrency: 1, ...args });
    const b = await buildPooledPopulation(p, { repos: [{ repo: "acme/c" }, { repo: "acme/a" }, { repo: "acme/b" }], concurrency: 3, ...args });
    const c = await buildPooledPopulation(p, { repos: [{ repo: "acme/b" }, { repo: "acme/c" }, { repo: "acme/a" }], concurrency: 2, ...args });
    for (const x of [b, c]) {
      expect(JSON.stringify(x.entries)).toBe(JSON.stringify(a.entries));
      expect(x.limitations).toEqual(a.limitations);
      expect(x.selection.funnel).toEqual(a.selection.funnel);
      expect(x.repos).toEqual(a.repos);
      expect(x.listed.diagnostics).toEqual(a.listed.diagnostics);
    }
    expect(a.limitations).toEqual(["limit of acme/a", "shared", "limit of acme/b", "limit of acme/c"]);
  });

  it("a single repo is a pool of one: the pooled assembly of it (with an empty repo beside it) is the single repo's population", async () => {
    const p: ScmProvider = { ...stub("github", sizes), listChanges: async (req) => (req.repo === "acme/empty" ? { changes: [], defaultBranch: "", limitations: [] } : stub("github", sizes).listChanges(req)) };
    const one = await buildPopulation(p, { repo: "acme/a", ...args });
    // Two repos take the pooled path (merged listings, the duplicate and scheme checks); the empty one adds nothing.
    const pool = await buildPooledPopulation(p, { repos: [{ repo: "acme/empty" }, { repo: "acme/a" }], ...args });
    expect(JSON.stringify(pool.entries)).toBe(JSON.stringify(one.entries));
    expect(pool.selection.funnel).toEqual(one.selection.funnel);
    expect(pool.limitations).toEqual(one.limitations);
    expect(pool.byKind).toEqual(one.byKind);
    expect(pool.viaMerge).toEqual(one.viaMerge);
    expect(one.headSha).toBe(sha("head:acme/a"));
    expect(pool.headSha).toBeNull(); // a pool has one head per repo
    expect(one.repos).toEqual([{ repo: "acme/a", defaultBranch: "main", headSha: sha("head:acme/a"), listed: 30 }]);
    expect(pool.repos).toEqual([{ repo: "acme/a", defaultBranch: "main", headSha: sha("head:acme/a"), listed: 30 }, { repo: "acme/empty", defaultBranch: "", headSha: null, listed: 0 }]);
  });

  it("each repo is listed from its own head", async () => {
    const heads: Record<string, string | undefined> = {};
    const p: ScmProvider = { ...stub("github", sizes), listChanges: async (req) => ((heads[req.repo] = req.head), stub("github", sizes).listChanges(req)) };
    const head = "a".repeat(40); // a commit id: a pinned head that is not one is refused (the ledger round's headSha rule)
    await buildPooledPopulation(p, { repos: [{ repo: "acme/a", head }, { repo: "acme/b" }], ...args });
    expect(heads).toEqual({ "acme/a": head, "acme/b": undefined });
  });

  it("checks every repo's listing: a change from another repo, or one outside the window, is refused", () => {
    const base = { repo: "acme/a", window: WINDOW, selector: sel };
    expect(() => checkListed("github", { changes: [change("github", "acme/b", 1)], defaultBranch: "main", limitations: [] }, base)).toThrow(/from repo acme\/b, not acme\/a/);
    expect(() => checkListed("github", { changes: [change("github", "acme/a", 1, { mergedAt: "2026-11-01T00:00:00Z" })], defaultBranch: "main", limitations: [] }, base)).toThrow(/outside the window/);
  });

  it("a repo the provider reports gone fails the build: only verify's rebuild (src/core/rebuild.ts) tells gone from broken, by a probe", async () => {
    const p = stub("github", sizes);
    await expect(buildPooledPopulation(p, { repos: [{ repo: "acme/a" }, { repo: "acme/deleted" }], ...args })).rejects.toThrow(/acme\/deleted: HTTP 404/);
  });

  it("mapPool runs at most `limit` at once, keeps item order, and stops starting new work after a failure", async () => {
    let live = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (x) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBe(3);
    const started: number[] = [];
    await expect(
      mapPool([1, 2, 3, 4, 5, 6], 2, async (x) => {
        started.push(x);
        if (x === 2) throw new Error("boom");
        await new Promise((r) => setTimeout(r, 5));
        return x;
      }),
    ).rejects.toThrow("boom");
    expect(started.length).toBeLessThan(6);
  });
});

describe("FR5.2: the repos a manifest lists must be the registered ones (verify check 2, offline)", () => {
  const set: RepoSet = { kind: "rule", owner: "acme", include: ["svc-*"], exclude: [], archived: false, forks: false, visibility: ["public"] };
  it("a rule: every listed repo is inside it, sorted and unique, and every change comes from a listed repo", () => {
    expect(manifestRepoProblems(set, ["acme/svc-a", "acme/svc-b"], ["acme/svc-a"])).toEqual([]);
    expect(manifestRepoProblems(set, ["acme/svc-a", "acme/web"])).toEqual(["manifest lists 1 repo(s) outside the registered rule (e.g. acme/web)"]);
    expect(manifestRepoProblems(set, ["acme/svc-b", "acme/svc-a"])).toContain("manifest repos are not sorted by repo");
    expect(manifestRepoProblems(set, ["acme/svc-a", "acme/svc-a"])).toContain("manifest lists a repo twice");
    expect(manifestRepoProblems(set, ["acme/svc-a"], ["acme/svc-a", "acme/svc-z"])).toEqual(["manifest has changes from 1 repo(s) it does not list (e.g. acme/svc-z)"]);
    expect(manifestRepoProblems(set, [])).toContain("manifest lists no repos");
  });

  it("a list: exactly the registered repos, none dropped, none added", () => {
    const list: RepoSet = { kind: "list", repos: ["acme/a", "acme/b", "acme/c"] };
    expect(manifestRepoProblems(list, ["acme/a", "acme/b", "acme/c"])).toEqual([]);
    expect(manifestRepoProblems(list, ["acme/a", "acme/b"])).toEqual(["manifest repos differ from the registered list: 1 registered repo(s) missing (e.g. acme/c)"]);
    expect(manifestRepoProblems(list, ["acme/a", "acme/b", "acme/c", "acme/d"])).toEqual(["manifest repos differ from the registered list: 1 repo(s) not registered (e.g. acme/d)"]);
  });

  it("a single repo: the same message as before pooling existed", () => {
    expect(manifestRepoProblems({ kind: "repo", repo: "acme/a" }, ["acme/a"])).toEqual([]);
    expect(manifestRepoProblems({ kind: "repo", repo: "acme/a" }, ["acme/b"])).toEqual(["manifest repo differs from the registration"]);
  });
});
