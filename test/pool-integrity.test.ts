import { describe, expect, it } from "vitest";
import { probeRepo, isTransientFailure, looksUnavailable } from "../src/core/failures.js";
import { checkPool, rebuildRepo } from "../src/core/rebuild.js";
import { isMutableExclusion, matchRepo, poolRecordProblems, resolvePool, ruleExclusions } from "../src/core/repo-set.js";
import type { ListedRepo, RepoListing } from "../src/core/records.js";
import { normalizeSelector } from "../src/core/selector.js";
import { BrokerRetriesExhausted, BrokerTimeout } from "../src/net/contract.js";
import { NO_COMMIT, RepoEmptyError, RepoUnavailableError, type ChangeRecord, type FirstParentCommit, type ListChangesRequest, type ListChangesResult, type PushLogEvent, type RepoRef, type RepoSetRule, type ScmProvider } from "../src/sdk/provider.js";
import { quoted } from "../src/core/said.js";

/**
 * The U8 fix round's core, on in-memory providers (fixture kind: synthetic): rule exclusions and repo matching, the
 * pool a freeze resolves (registered repos by id, probed when the listing lacks them), check 2's pool record rules,
 * and check 5's per-repo rebuild and pool check (src/core/rebuild.ts).
 */
const WINDOW = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" };
const SEL = normalizeSelector({ kinds: ["pull_request", "direct_push"], unreviewed: "any" });
const sha = (tag: string) => Buffer.from(tag).toString("hex").padStart(40, "0").slice(-40);
const rule = (over: Partial<RepoSetRule> = {}): RepoSetRule => ({ kind: "rule", owner: "acme", include: ["*"], exclude: [], archived: false, forks: false, visibility: ["internal", "private", "public"], ...over });
const ref = (repo: string, over: Partial<RepoRef> = {}): RepoRef => ({ repo, id: `id-${repo}`, defaultBranch: "main", archived: false, fork: false, visibility: "public", ...over });
const pr = (repo: string, n: number, at = "2026-08-10T10:00:00Z"): ChangeRecord => ({ id: `x:${repo}#${n}`, kind: "pull_request", repo, url: "u", mergeSha: sha(`${repo}#${n}`), mergedAt: at, author: { login: "bob", kind: "human" }, mergedBy: { login: "m", kind: "human" }, reviews: [], changedLines: 1, labels: [] });
const push = (repo: string, tag: string, at = "2026-08-11T10:00:00Z"): ChangeRecord => ({ id: `x:${repo}@${sha(tag)}`, kind: "direct_push", repo, url: "u", mergeSha: sha(tag), mergedAt: at, author: { login: "bob", kind: "human" }, mergedBy: null, reviews: [], changedLines: 1, labels: [] });

describe("rule exclusions and repo matching", () => {
  it("names every clause that excludes a repo, and which of them its owners can change", () => {
    const r = rule({ include: ["svc-*"], exclude: ["*-tmp"], visibility: ["public"] });
    expect(ruleExclusions(r, ref("acme/svc-a"))).toEqual([]);
    expect(ruleExclusions(r, ref("acme/web", { archived: true, fork: true, visibility: "private" }))).toEqual(["include", "archived", "fork", "visibility:private"]);
    expect(ruleExclusions(r, ref("acme/svc-a-tmp"))).toEqual(["exclude:*-tmp"]);
    expect(ruleExclusions(r, ref("other/svc-a"))).toEqual(["owner"]);
    expect(["include", "archived", "exclude:*-tmp", "visibility:private"].every(isMutableExclusion)).toBe(true);
    expect(["fork", "owner"].some(isMutableExclusion)).toBe(false);
  });

  it("matches by repo id first, by path only where an id is unknown; two known ids are two repos", () => {
    const items = [{ repo: "acme/new-name", repoId: "7" }, { repo: "acme/b", repoId: "8" }, { repo: "acme/c", repoId: null }];
    expect(matchRepo(items, { repo: "acme/old-name", repoId: "7" })?.repo).toBe("acme/new-name");
    expect(matchRepo(items, { repo: "ACME/C", repoId: "9" })?.repo).toBe("acme/c");
    expect(matchRepo(items, { repo: "acme/b", repoId: "99" })).toBeUndefined(); // the path was reused by another repository
    expect(matchRepo(items, { repo: "acme/b", repoId: null })?.repoId).toBe("8");
  });
});

describe("resolvePool: the pool a freeze lists", () => {
  const provider = (refs: RepoRef[], describe?: ScmProvider["describeRepo"]): ScmProvider => ({ apiVersion: 1, name: "stub", listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }), listRepos: async () => refs, ...(describe ? { describeRepo: describe } : {}) });
  const now = () => "2026-10-20T12:00:00Z";

  it("the rule's repos now, plus every registered repo that still exists, whatever its archive state, name or owner now", async () => {
    const refs = [ref("acme/a"), ref("acme/b", { archived: true }), ref("acme/renamed", { id: "id-acme/c" })];
    const transferred = async (r: { repo: string; id?: string }) => (r.id === "id-acme/d" ? ref("elsewhere/d", { id: "id-acme/d" }) : Promise.reject(new RepoUnavailableError(r.repo, 404)));
    const res = await resolvePool(provider(refs, transferred), rule(), { registered: [{ repo: "acme/a", repoId: "id-acme/a" }, { repo: "acme/b", repoId: "id-acme/b" }, { repo: "acme/c", repoId: "id-acme/c" }, { repo: "acme/d", repoId: "id-acme/d" }, { repo: "acme/e", repoId: "id-acme/e" }], now });
    expect(res.pool).toEqual([
      { repo: "acme/a", repoId: "id-acme/a" },
      { repo: "acme/b", repoId: "id-acme/b" },
      { repo: "acme/renamed", repoId: "id-acme/c" },
      { repo: "elsewhere/d", repoId: "id-acme/d" },
    ]);
    expect(res.gone).toEqual([{ repo: "acme/e", repoId: "id-acme/e", status: 404, detail: "acme/e: HTTP 404", probedAt: now() }]);
    expect(res.listing!.repos.map((r) => [r.repo, r.excludedBy])).toEqual([["acme/a", []], ["acme/b", ["archived"]], ["acme/renamed", []]]);
    expect(res.listing!.visibility.private).toEqual({ listed: 0, complete: null, reason: "provider stub cannot say what its token sees (it has no listingVisibility)" });
  });

  it("records what the token proves it sees, and a provider that cannot say (or fails to) as not proven, without stopping the freeze", async () => {
    const proof = { complete: true, reason: "owner" };
    const seeing = { ...provider([ref("acme/a", { visibility: "private" })]), listingVisibility: async () => ({ identity: "me", visibilities: { public: proof, private: proof, internal: { complete: false, reason: "no" } } }) };
    expect((await resolvePool(seeing, rule(), { now })).listing).toMatchObject({ identity: "me", visibility: { private: { listed: 1, complete: true, reason: "owner" }, internal: { listed: 0, complete: false } } });
    const failing = { ...provider([ref("acme/a")]), listingVisibility: async () => Promise.reject(new Error("HTTP 500")) };
    expect((await resolvePool(failing, rule(), { now })).listing!.visibility.private).toEqual({ listed: 0, complete: false, reason: "the provider could not say what its token sees (HTTP 500)" });
  });

  it("refuses to skip: a registered repo it cannot probe, or whose probe fails, stops the freeze; a rate limit is rethrown as it is", async () => {
    const reg = { registered: [{ repo: "acme/x", repoId: "1" }], now };
    await expect(resolvePool(provider([ref("acme/a")]), rule(), reg)).rejects.toThrow(/cannot probe a repository \(it has no describeRepo\) to tell whether it is gone; nothing is skipped/);
    await expect(resolvePool(provider([ref("acme/a")], async () => Promise.reject(Object.assign(new Error("Forbidden: SSO"), { status: 403 }))), rule(), reg)).rejects.toThrow(/probing it failed \(no access: Forbidden: SSO\); nothing is skipped/);
    const limited = new BrokerRetriesExhausted("h", 7, 1000, "HTTP 403", 403, true);
    await expect(resolvePool(provider([ref("acme/a")], async () => Promise.reject(limited)), rule(), reg)).rejects.toBe(limited);
  });
});

describe("failures: transient, gone, or neither", () => {
  it("a rate limit or a give-up is transient whatever its status; only a probe's 404 is gone", async () => {
    expect(isTransientFailure(new BrokerRetriesExhausted("h", 7, 1000, "HTTP 403", 403, true))).toBe(true);
    expect(isTransientFailure(new BrokerTimeout("h", "scm", 30_000))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { status: 403, rateLimited: true }))).toBe(true);
    expect(looksUnavailable(Object.assign(new Error("x"), { status: 403, rateLimited: true }))).toBe(false);
    expect(looksUnavailable(Object.assign(new Error("x"), { status: 404 }))).toBe(true);
    const p = (f: () => Promise<RepoRef>) => probeRepo({ describeRepo: f }, { repo: "acme/a" });
    expect((await p(async () => Promise.reject(new RepoUnavailableError("acme/a", 404)))).kind).toBe("gone");
    expect((await p(async () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })))).kind).toBe("gone");
    expect((await p(async () => Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 })))).kind).toBe("no-access");
    expect((await p(async () => Promise.reject(new BrokerRetriesExhausted("h", 7, 1, "HTTP 429", 429, true)))).kind).toBe("transient");
    expect((await probeRepo({}, { repo: "acme/a" })).kind).toBe("unsupported");
  });
});

describe("poolRecordProblems (check 2, offline): the manifest's repos against the registration", () => {
  const listed = (repo: string, over: Partial<ListedRepo> = {}): ListedRepo => ({ repo, repoId: `id-${repo}`, defaultBranch: "main", archived: false, fork: false, visibility: "public", createdAt: null, excludedBy: [], ...over });
  const listing = (repos: ListedRepo[]): RepoListing => ({ owner: "acme", identity: null, visibility: { public: { listed: repos.filter((r) => r.visibility === "public").length, complete: true, reason: "" }, private: { listed: repos.filter((r) => r.visibility === "private").length, complete: null, reason: "" }, internal: { listed: 0, complete: null, reason: "" } }, repos });
  const set = rule({ include: ["svc-*"] });

  it("an honest record passes: registered repos in the pool under any name, the rest of the listing excluded by what it says", () => {
    const repos = [{ repo: "acme/legacy-a", repoId: "id-acme/svc-a" }, { repo: "acme/svc-b", repoId: "id-acme/svc-b" }];
    const l = listing([listed("acme/legacy-a", { repoId: "id-acme/svc-a", excludedBy: ["include"] }), listed("acme/svc-b"), listed("acme/web", { excludedBy: ["include"] })]);
    expect(poolRecordProblems(set, { repos, listing: l, registered: [{ repo: "acme/svc-a", repoId: "id-acme/svc-a" }, { repo: "acme/svc-b", repoId: "id-acme/svc-b" }] })).toEqual([]);
  });

  it("names a dropped registered repo, a false gone record, a lying exclusion, and a listing the pool contradicts", () => {
    const registered = [{ repo: "acme/svc-a", repoId: "1" }, { repo: "acme/svc-b", repoId: "2" }];
    expect(poolRecordProblems(set, { repos: [{ repo: "acme/svc-a", repoId: "1" }], registered })).toEqual(["manifest drops 1 registered repo(s) (e.g. acme/svc-b): each must be in the manifest, or recorded gone with a probe's evidence"]);
    const gone = [{ repo: "acme/svc-z", repoId: "9", status: 404 as const, detail: "", probedAt: "" }];
    expect(poolRecordProblems(set, { repos: [{ repo: "acme/svc-a", repoId: "1" }, { repo: "acme/svc-b", repoId: "2" }], registered, gone })).toEqual(["manifest records 1 repo(s) as gone that were not registered (e.g. acme/svc-z)"]);
    const lying = listing([listed("acme/svc-a", { repoId: "1" }), listed("acme/svc-b", { repoId: "2" }), listed("acme/svc-c", { repoId: "3", excludedBy: ["archived"] })]);
    expect(poolRecordProblems(set, { repos: [{ repo: "acme/svc-a", repoId: "1" }, { repo: "acme/svc-b", repoId: "2" }], registered, listing: lying })).toEqual(["manifest listing gives 1 repo(s) an exclusion their recorded attributes do not (e.g. acme/svc-c)", "manifest listing shows 1 repo(s) the rule matches that the manifest does not list (e.g. acme/svc-c)"]);
    const counts = { ...listing([listed("acme/svc-a", { repoId: "1" }), listed("acme/svc-b", { repoId: "2" })]) };
    counts.visibility.public.listed = 5;
    expect(poolRecordProblems(set, { repos: [{ repo: "acme/svc-a", repoId: "1" }, { repo: "acme/svc-b", repoId: "2" }], registered, listing: counts })).toEqual(["manifest listing's public count(s) do not match its repos"]);
  });
});

/**
 * A provider over one repo's two histories: the frozen head's and the current head's, each with its window listing
 * (synthetic: it lists pull requests through history, as no built-in does; the built-ins are in p3-pool-head.test.ts).
 * `log` is the branch's push log, newest first (P3).
 */
function twoHeads(o: { frozen: ChangeRecord[]; now: ChangeRecord[]; path?: FirstParentCommit[] | null; pins?: boolean; failFrozen?: unknown; describe?: ScmProvider["describeRepo"]; log?: PushLogEvent[] }): ScmProvider {
  const H0 = sha("frozen-head");
  const H1 = sha("current-head");
  const result = (changes: ChangeRecord[], head: string): ListChangesResult => ({ changes, defaultBranch: "main", limitations: [], headSha: head });
  return {
    apiVersion: 1,
    name: "two",
    async listChanges(req: ListChangesRequest) {
      if (req.head === H0) {
        if (o.failFrozen) throw o.failFrozen;
        return o.pins === false ? result(o.now, H1) : result(o.frozen, H0);
      }
      return result(o.now, H1);
    },
    ...(o.path !== undefined ? { firstParentPath: async () => o.path! } : {}),
    ...(o.describe ? { describeRepo: o.describe } : {}),
    ...(o.log ? { pushLog: async () => ({ events: o.log! }) } : {}),
  };
}
const H0 = sha("frozen-head");
const H1 = sha("current-head");
const args = (over = {}) => ({ repo: "acme/a", frozenHead: H0, frozenEmpty: false, window: WINDOW, selector: SEL, ...over });
/** The freeze span verify holds a frozen head to: the manifest's as-of time until R. */
const SPAN = { freezeSpan: { from: "2026-10-20T12:00:00Z", until: "2026-10-21T00:00:00Z" } };
const ev = (id: string, at: string, before: string, after: string, kind: PushLogEvent["kind"] = "fast-forward"): PushLogEvent => ({ id, at, before, after, kind });
const B = sha("base");

describe("rebuildRepo: the frozen head against the current head (finding 3)", () => {
  const frozen = [pr("acme/a", 1), push("acme/a", "p1")];
  const later = [...frozen, push("acme/a", "late", "2026-09-30T12:00:00Z")];

  it("the same head: one listing, nothing to compare", async () => {
    let calls = 0;
    const p: ScmProvider = { apiVersion: 1, name: "same", listChanges: async () => (calls++, { changes: frozen, defaultBranch: "main", limitations: [], headSha: H0 }) };
    const r = await rebuildRepo(p, args());
    expect(calls).toBe(1);
    expect(r).toMatchObject({ history: "pinned", fail: [], incomplete: [] });
  });

  it("a window commit reachable now but not from the frozen head (P3): FR7.2 when the push log proves the head, FAIL when it disproves it, INCOMPLETE without a log; commit dates and first parents decide nothing", async () => {
    const log = (head: string) => [ev("3", "2026-10-25T09:00:00Z", head, H1), ev("2", "2026-09-30T10:00:00Z", B, head), ev("1", "2026-06-01T00:00:00Z", NO_COMMIT, B, "created")];
    const proven = await rebuildRepo(twoHeads({ frozen, now: later, log: log(H0) }), args(SPAN));
    expect(proven.fail).toEqual([]);
    expect(proven.incomplete).toEqual([]);
    expect(proven.notes.map(quoted).join("\n")).toMatch(/1 commit\(s\) dated in the window reached the default branch after the window closed, not through the frozen head .*: the push log shows [0-9a-f]{12}… was the branch's tip at freeze \(it became the default branch's tip at 2026-09-30T10:00:00Z \(update 2, fast-forward\)\) .*\(FR7\.2\)/);
    expect(proven.listed!.changes).toEqual(frozen); // the rebuild is the frozen head's
    // A first-parent path dated after the window, which U8 took as proof, changes nothing when the log disagrees.
    const disproven = await rebuildRepo(twoHeads({ frozen, now: later, path: [{ sha: sha("merge"), committedAt: "2026-10-25T09:00:00Z" }], log: log(sha("real-tip")) }), args(SPAN));
    expect(disproven.fail.map(quoted).join("\n")).toMatch(/^the frozen head [0-9a-f]{12}… was not the default branch's tip at freeze: the push log shows that at 2026-10-20T12:00:00Z the tip was [0-9a-f]{12}… \(since 2026-09-30T10:00:00Z, update 2\)/);
    const none = await rebuildRepo(twoHeads({ frozen, now: later, path: [{ sha: sha("merge"), committedAt: "2026-10-25T09:00:00Z" }] }), args(SPAN));
    expect(none.fail).toEqual([]);
    expect(none.incomplete.map(quoted).join("\n")).toMatch(/1 direct push\(es\) dated in the window are on the default branch now but not reachable from the frozen head .*there is no push-time evidence to place them \(provider two keeps no push log pr-rla can read \(it has no pushLog\)\): whether they arrived after freeze \(FR7\.2\) or the frozen head hides them is unverified/);
  });

  it("a pull request reachable now but not from the frozen head always FAILs (a provider that lists pull requests through history)", async () => {
    const r = await rebuildRepo(twoHeads({ frozen, now: [...frozen, pr("acme/a", 2)] }), args());
    expect(r.fail.map(quoted).join("\n")).toMatch(/1 pull request\(s\) merged in the window are on the default branch now but not in the history from the frozen head/);
  });

  it("a provider that ignores the head: the rebuild walked the current head, as it always has (WARN in check 5)", async () => {
    const r = await rebuildRepo(twoHeads({ frozen, now: later, pins: false }), args());
    expect(r).toMatchObject({ history: "unpinned", fail: [], incomplete: [] });
  });

  it("a frozen head the server does not know (404) while the repo exists: FAIL; the repo gone by its probe: INCOMPLETE; no probe: INCOMPLETE", async () => {
    const e404 = Object.assign(new Error("Commit not found"), { status: 404 });
    const exists = async () => ref("acme/a");
    expect((await rebuildRepo(twoHeads({ frozen, now: later, failFrozen: e404, describe: exists }), args())).fail.map(quoted).join()).toMatch(/frozen head [0-9a-f]{12}… not found \(HTTP 404: Commit not found\); the repository itself exists/);
    const gone = async () => Promise.reject(new RepoUnavailableError("acme/a", 404));
    expect((await rebuildRepo(twoHeads({ frozen, now: later, failFrozen: e404, describe: gone }), args())).incomplete.map(quoted).join()).toMatch(/^gone: its repo-level metadata answers HTTP 404/);
    expect((await rebuildRepo(twoHeads({ frozen, now: later, failFrozen: e404 }), args())).incomplete.map(quoted).join()).toMatch(/cannot probe a repository \(it has no describeRepo\), so whether it is gone is unknown/);
    const limited = new BrokerRetriesExhausted("h", 7, 1000, "HTTP 403", 403, true);
    expect((await rebuildRepo(twoHeads({ frozen, now: later, failFrozen: limited }), args())).incomplete.map(quoted).join()).toMatch(/a rate limit or an outage, not a missing repository; run verify again/);
  });

  it("an empty repo: consistent when the manifest recorded it empty; a FAIL when it recorded history", async () => {
    const empty: ScmProvider = { apiVersion: 1, name: "e", listChanges: async (req) => Promise.reject(new RepoEmptyError(req.repo)) };
    expect(await rebuildRepo(empty, args({ frozenHead: null, frozenEmpty: true }))).toMatchObject({ listed: { changes: [] }, fail: [], incomplete: [] });
    expect((await rebuildRepo(empty, args())).fail.map(quoted).join()).toMatch(/not found: the repository has no default branch now/);
  });

  it("a repo of a list renamed after freeze (no id to match): the probe's redirect finds it, and it is rebuilt there", async () => {
    const p: ScmProvider = {
      apiVersion: 1,
      name: "x",
      listChanges: async (req) => (req.repo === "acme/a" ? Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })) : { changes: [pr(req.repo, 1)], defaultBranch: "main", limitations: [], headSha: H0 }),
      describeRepo: async () => ref("acme/renamed"),
    };
    const r = await rebuildRepo(p, args());
    expect(r).toMatchObject({ current: "acme/renamed", fail: [], incomplete: [] });
    expect(r.listed!.changes.map((c) => c.id)).toEqual(["x:acme/a#1"]);
  });

  it("a renamed repo is listed under its path now and compared under the manifest's", async () => {
    const p: ScmProvider = { apiVersion: 1, name: "x", listChanges: async (req) => ({ changes: [pr(req.repo, 1)], defaultBranch: "main", limitations: [], headSha: H0 }) };
    const r = await rebuildRepo(p, args({ current: "acme/b" }));
    expect(r.listed!.changes.map((c) => [c.id, c.repo])).toEqual([["x:acme/a#1", "acme/a"]]);
    expect(r.notes[0]).toBe("acme/a is named acme/b now (matched by repo id): rebuilt under its new name");
  });
});

describe("checkPool: what this token can see (finding 2)", () => {
  const stubPool = (over: Partial<ScmProvider> = {}): ScmProvider => ({ apiVersion: 1, name: "plain", listChanges: async (req) => ({ changes: [], defaultBranch: "main", limitations: [], headSha: H0 }), listRepos: async () => [ref("acme/a")], ...over });
  const input = (set: RepoSetRule) => ({ set, registered: [], mode: "PROSPECTIVE" as const, repos: [{ repo: "acme/a", repoId: "id-acme/a", defaultBranch: "main", headSha: H0 }], listing: null, gone: [], window: WINDOW, selector: SEL });

  it("a provider that cannot say what its token sees: INCOMPLETE for each private or internal visibility the rule admits; nothing for public", async () => {
    expect((await checkPool(stubPool(), input(rule()))).lines.map(quoted)).toEqual([
      "INCOMPLETE cannot establish that this token sees every internal repository under acme: provider plain cannot say what its token sees (it has no listingVisibility)",
      "INCOMPLETE cannot establish that this token sees every private repository under acme: provider plain cannot say what its token sees (it has no listingVisibility)",
    ]);
    expect((await checkPool(stubPool(), input(rule({ visibility: ["public"] })))).lines.map(quoted)).toEqual([]);
  });

  it("a provider that proves it: one line per visibility, and nothing INCOMPLETE", async () => {
    const proof = { complete: true, reason: "owner" };
    const p = stubPool({ listingVisibility: async () => ({ identity: "me", visibilities: { public: proof, private: proof, internal: proof } }) });
    expect((await checkPool(p, input(rule()))).lines.map(quoted)).toEqual(["internal repositories under acme: listed completely (owner)", "private repositories under acme: listed completely (owner)"]);
  });
});
