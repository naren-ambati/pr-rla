import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateFreeze, estimateLines, sampleRepos } from "../src/api/freeze-estimate.js";
import { differingInputs, FreezeCheckpointStore, freezeRunId, type FreezeRunInputs } from "../src/api/freeze-store.js";
import { FreezeRepoFailed, FreezeStopped, freezeRepos, isTransientFailure, ResumeRefused } from "../src/api/pooled-freeze.js";
import { createAuditContext } from "../src/api/context.js";
import { BrokerRetriesExhausted, BrokerTimeout } from "../src/net/contract.js";
import type { PluginIdentity } from "../src/core/records.js";
import { normalizeSelector } from "../src/core/selector.js";
import { RepoUnavailableError, type ChangeRecord, type ListChangesRequest, type ListChangesResult, type ScmProvider } from "../src/sdk/provider.js";

/**
 * The pooled-freeze API (src/api/pooled-freeze.ts, freeze-store.ts, freeze-estimate.ts) against in-memory providers
 * (fixture kind: synthetic): stopping versus failing, what the checkpoint store keeps, and the run id.
 */
const WINDOW = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z", name: "w" };
const SEL = normalizeSelector({ kinds: ["pull_request"], unreviewed: "any" });
const sha = (tag: string) => Buffer.from(tag).toString("hex").padStart(40, "0").slice(-40);
const PROVIDER_ID: PluginIdentity = { name: "stub", source: "builtin", version: "0.1.0", integrity: null, optionsSha256: "o", populationOptionsSha256: "p", trust: "builtin" };

function change(repo: string, n: number): ChangeRecord {
  return { id: `stub:${repo}#${n}`, kind: "pull_request", repo, url: `https://x.invalid/${repo}/${n}`, mergeSha: sha(`${repo}${n}`), mergedAt: "2026-08-10T10:00:00Z", author: { login: "bob", kind: "human" }, mergedBy: { login: "maint", kind: "human" }, reviews: [], changedLines: n, labels: [] };
}
const ok = (repo: string, n = 3): ListChangesResult => ({ changes: Array.from({ length: n }, (_, i) => change(repo, i + 1)), defaultBranch: "main", limitations: [], headSha: sha(`head-${repo}`) });

/** The error a promise rejects with (the test fails if it resolves). */
async function failure<T extends Error>(p: Promise<unknown>): Promise<T> {
  try {
    await p;
  } catch (e) {
    return e as T;
  }
  throw new Error("expected a rejection");
}

function stub(behave: (req: ListChangesRequest) => Promise<ListChangesResult> | ListChangesResult, extra: Partial<ScmProvider> = {}): ScmProvider & { calls: string[] } {
  const calls: string[] = [];
  return { apiVersion: 1, name: "stub", calls, listChanges: async (req: ListChangesRequest) => (calls.push(req.repo), behave(req)), ...extra } as never;
}

const dirs: string[] = [];
const tmp = () => (dirs[dirs.length] = mkdtempSync(join(tmpdir(), "prrla-store-")));
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const base = (provider: ScmProvider, repos: string[], over: Partial<Parameters<typeof freezeRepos>[0]> = {}): Parameters<typeof freezeRepos>[0] => ({
  provider,
  set: { kind: "list", repos },
  window: WINDOW,
  selector: SEL,
  startedAt: "2026-10-20T12:00:00Z",
  concurrency: 2,
  log: () => {},
  ...over,
});
const cp = (dir: string, over: Record<string, unknown> = {}) => ({ base: dir, windowName: "w", registrationSha256: "reg", prRlaVersion: "0.1.0", provider: PROVIDER_ID, ...over });

describe("isTransientFailure: what a run waits out, and what it fails on", () => {
  it("the broker giving up, a provider's own give-up (status 0), 429 and 5xx, a dropped connection", () => {
    expect(isTransientFailure(new BrokerRetriesExhausted("h", 8, 1000, "HTTP 429", 429, true))).toBe(true);
    expect(isTransientFailure(new BrokerTimeout("h", "scm", 30000, 3))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { code: "BROKER_RETRIES_EXHAUSTED" }))).toBe(true); // across the plugin host: only the code survives
    expect(isTransientFailure(Object.assign(new Error("x"), { code: "BROKER_TIMEOUT" }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { status: 0 }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { cause: { code: "ECONNRESET" } }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
  });

  it("a 403 or 404, a gone repo, a contract violation, a plain error and a non-error are final", () => {
    expect(isTransientFailure(Object.assign(new Error("x"), { status: 403 }))).toBe(false);
    expect(isTransientFailure(Object.assign(new Error("x"), { status: 404 }))).toBe(false);
    expect(isTransientFailure(new RepoUnavailableError("o/r", 404))).toBe(false);
    expect(isTransientFailure(new Error("provider stub returned stub:o/r#1 twice"))).toBe(false);
    expect(isTransientFailure("boom")).toBe(false);
    expect(isTransientFailure(null)).toBe(false);
  });
});

describe("the run stops or fails as a whole (FR5.4: all-or-nothing)", () => {
  it("a transient failure stops scheduling, lets the repos in flight finish, keeps their checkpoints and throws FreezeStopped", async () => {
    const dir = tmp();
    const repos = Array.from({ length: 10 }, (_, i) => `o/r${i}`);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = stub(async (req) => {
      if (req.repo === "o/r3") throw new BrokerRetriesExhausted("h", 8, 1000, "HTTP 429", 429, true);
      if (req.repo === "o/r2") await gate; // still in flight when r3 fails
      return ok(req.repo);
    });
    const run = freezeRepos(base(p, repos, { checkpoint: cp(dir) }));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const err = await failure<FreezeStopped>(run);
    expect(err).toBeInstanceOf(FreezeStopped);
    expect(err.message).toMatch(/^stopped after \d+ of 10 repos: o\/r3 gave up|stopped after \d+ of 10 repos: h: gave up after 8 attempt\(s\)/);
    // r0, r1 and r2 finished (r2 after the failure); r4 onwards never started.
    expect(p.calls.sort()).toEqual(["o/r0", "o/r1", "o/r2", "o/r3"]);
    const store = new FreezeCheckpointStore(dir, "w", err.runId!);
    expect(store.done(repos)).toBe(3);
    expect(err.done).toBe(3);
  });

  it("a 404 fails the run naming the repo and what to do (exclude it in the rule, before the seed), and starts nothing new", async () => {
    const dir = tmp();
    const p = stub((req) => {
      if (req.repo === "o/r1") throw new RepoUnavailableError(req.repo, 404);
      return ok(req.repo);
    });
    const err = await failure<FreezeRepoFailed>(freezeRepos(base(p, ["o/r0", "o/r1", "o/r2", "o/r3", "o/r4", "o/r5"], { concurrency: 1, checkpoint: cp(dir) })));
    expect(err).toBeInstanceOf(FreezeRepoFailed);
    expect(err.repo).toBe("o/r1");
    expect(err.message).toMatch(/^repo o\/r1: o\/r1: HTTP 404 .*must be excluded in the registered rule, before the seed; nothing is skipped$/);
    expect(p.calls).toEqual(["o/r0", "o/r1"]);
  });

  it("a provider that breaks the contract (a change from another repo) fails the run naming the repo", async () => {
    const p = stub((req) => (req.repo === "o/r1" ? { ...ok("o/r1"), changes: [change("o/other", 1)] } : ok(req.repo)));
    const err = await failure<FreezeRepoFailed>(freezeRepos(base(p, ["o/r0", "o/r1"], { concurrency: 1 })));
    expect(err).toBeInstanceOf(FreezeRepoFailed);
    expect(err.message).toMatch(/^repo o\/r1: provider stub returned stub:o\/other#1 from repo o\/other, not o\/r1$/);
  });

  it("a single repo is a pool of one: its error reaches the caller unwrapped, as before", async () => {
    const boom = new BrokerRetriesExhausted("h", 8, 1000, "HTTP 503", 503);
    await expect(freezeRepos(base(stub(() => Promise.reject(boom)), [], { set: { kind: "repo", repo: "o/solo" } }))).rejects.toBe(boom);
  });

  it("an aborted run stops like a transient failure", async () => {
    const ctrl = new AbortController();
    const p = stub(async (req) => {
      if (req.repo === "o/r1") ctrl.abort();
      return ok(req.repo);
    });
    const err = await failure<FreezeStopped>(freezeRepos(base(p, ["o/r0", "o/r1", "o/r2", "o/r3"], { concurrency: 1, signal: ctrl.signal })));
    expect(err).toBeInstanceOf(FreezeStopped);
    expect(err.message).toMatch(/aborted/);
  });

  it("a rule that matches no repo is refused before anything is listed", async () => {
    const p = stub(() => ok("x"), { listRepos: async () => [] });
    await expect(freezeRepos(base(p, [], { set: { kind: "rule", owner: "o", include: ["*"], exclude: [], archived: false, forks: false, visibility: ["public"] } }))).rejects.toThrow(/matches no repository the token can see/);
    expect(p.calls).toEqual([]);
  });
});

describe("resuming: a repo with a done-marker is not listed again; everything else about the run must be the same", () => {
  it("the second invocation lists only the repos without a marker, from the first run's start time", async () => {
    const dir = tmp();
    const repos = ["o/a", "o/b", "o/c", "o/d"];
    let fail = true;
    const p = stub((req) => {
      if (req.repo === "o/c" && fail) throw new BrokerTimeout("h", "scm", 30000, 3);
      return ok(req.repo);
    });
    const first = await failure<FreezeStopped>(freezeRepos(base(p, repos, { concurrency: 1, checkpoint: cp(dir) })));
    expect(first).toBeInstanceOf(FreezeStopped);
    fail = false;
    p.calls.length = 0;
    const second = await freezeRepos(base(p, repos, { concurrency: 1, startedAt: "2026-10-20T18:00:00Z", checkpoint: cp(dir) }));
    expect(p.calls).toEqual(["o/c", "o/d"]);
    expect(second.startedAt).toBe("2026-10-20T12:00:00Z");
    expect(second).toMatchObject({ resumed: 2, fetched: 2 });
    expect(second.repos.map((r) => r.repo)).toEqual(repos);
    // The resumed result is what a straight run gives.
    const straight = await freezeRepos(base(stub((req) => ok(req.repo)), repos, { concurrency: 1 }));
    expect(JSON.stringify(second.population.entries)).toBe(JSON.stringify(straight.population.entries));
    expect(JSON.stringify(second.repos)).toBe(JSON.stringify(straight.repos));
  });

  it("--resume refuses a run whose registration, provider, version or repo list differs, saying which", async () => {
    const dir = tmp();
    const repos = ["o/a", "o/b"];
    const p = stub((req) => (req.repo === "o/b" ? Promise.reject(new BrokerTimeout("h", "scm", 30000)) : ok(req.repo)));
    const stopped = await failure<FreezeStopped>(freezeRepos(base(p, repos, { checkpoint: cp(dir) })));
    const id = stopped.runId!;
    const resume = (over: Record<string, unknown>, list = repos) => freezeRepos(base(stub((req) => ok(req.repo)), list, { checkpoint: cp(dir, { resume: id.slice(0, 16), ...over }) }));
    await expect(resume({ registrationSha256: "other" })).rejects.toThrow(/the inputs now differ in the registration/);
    await expect(resume({ prRlaVersion: "0.2.0" })).rejects.toThrow(/the pr-rla version \(0\.1\.0 then, 0\.2\.0 now\)/);
    await expect(resume({ provider: { ...PROVIDER_ID, integrity: "abc" } })).rejects.toThrow(/the provider \(its version, files or options\)/);
    await expect(resume({}, ["o/a", "o/b", "o/c"])).rejects.toThrow(/the resolved repo list \(1 added, 0 removed since that run started\)/);
    await expect(resume({})).resolves.toMatchObject({ runId: id, resumed: 1, fetched: 1 });
    expect(ResumeRefused.name).toBe("ResumeRefused");
  });

  it("two registrations of one window, or two rules, have different run ids; the same inputs have one", () => {
    const inputs: FreezeRunInputs = { registrationSha256: "r", repos: [{ repo: "o/a", repoId: "1" }], prRlaVersion: "0.1.0", provider: PROVIDER_ID };
    expect(freezeRunId(inputs)).toMatch(/^[0-9a-f]{64}$/);
    expect(freezeRunId({ ...inputs })).toBe(freezeRunId(inputs));
    expect(freezeRunId({ ...inputs, registrationSha256: "r2" })).not.toBe(freezeRunId(inputs));
    expect(freezeRunId({ ...inputs, repos: [{ repo: "o/a", repoId: "2" }] })).not.toBe(freezeRunId(inputs));
    expect(differingInputs(inputs, { ...inputs, repos: [] })).toEqual(["the resolved repo list (0 added, 1 removed since that run started)"]);
  });
});

describe("FreezeCheckpointStore", () => {
  const inputs: FreezeRunInputs = { registrationSha256: "r", repos: [{ repo: "o/a", repoId: null }], prRlaVersion: "0.1.0", provider: PROVIDER_ID };
  const open = (dir: string) => new FreezeCheckpointStore(dir, "w", freezeRunId(inputs));

  it("begin keeps the first start time; fresh starts over and discards the markers", () => {
    const dir = tmp();
    const s = open(dir);
    expect(s.begin(inputs, "2026-10-20T12:00:00Z")).toMatchObject({ resumed: false, header: { startedAt: "2026-10-20T12:00:00Z" } });
    s.writeRepo("o/a", ok("o/a"));
    expect(open(dir).begin(inputs, "2026-10-20T18:00:00Z")).toMatchObject({ resumed: true, header: { startedAt: "2026-10-20T12:00:00Z" } });
    expect(open(dir).readRepo("o/a")?.changes).toHaveLength(3);
    expect(open(dir).begin(inputs, "2026-10-21T01:00:00Z", { fresh: true })).toMatchObject({ resumed: false, header: { startedAt: "2026-10-21T01:00:00Z" } });
    expect(open(dir).readRepo("o/a")).toBeNull();
  });

  it("a damaged or foreign marker is not trusted; a header whose id does not match its inputs is not a header", () => {
    const dir = tmp();
    const s = open(dir);
    s.begin(inputs, "2026-10-20T12:00:00Z");
    s.writeRepo("o/a", ok("o/a"));
    const file = join(s.dir, "repos", readdirSync(join(s.dir, "repos"))[0]!);
    writeFileSync(file, readFileSync(file, "utf8").slice(0, 40)); // truncated, as a crash mid-write would leave a non-atomic file
    expect(open(dir).readRepo("o/a")).toBeNull();
    writeFileSync(file, JSON.stringify({ schema: "pr-rla/freeze-repo/v1", repo: "o/other", listed: { changes: [] } }));
    expect(open(dir).readRepo("o/a")).toBeNull();
    const header = JSON.parse(readFileSync(join(s.dir, "run.json"), "utf8")) as { inputs: { registrationSha256: string } };
    header.inputs.registrationSha256 = "tampered";
    writeFileSync(join(s.dir, "run.json"), JSON.stringify(header));
    expect(open(dir).header()).toBeNull();
  });

  it("writes are atomic: no temporary file is left behind, and runs() lists the runs of a window", () => {
    const dir = tmp();
    const s = open(dir);
    s.begin(inputs, "2026-10-20T12:00:00Z");
    for (let i = 0; i < 5; i++) s.writeRepo(`o/r${i}`, ok(`o/r${i}`));
    expect(readdirSync(join(s.dir, "repos")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(s.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(FreezeCheckpointStore.runs(dir, "w")).toEqual([freezeRunId(inputs)]);
    expect(FreezeCheckpointStore.runs(dir, "other")).toEqual([]);
    expect(s.complete).toBe(false);
    s.markComplete();
    expect(open(dir).complete).toBe(true);
  });
});

describe("the estimate for a provider that cannot estimate, and its output", () => {
  const ctx = () => createAuditContext({ mode: "read-write", fetch: (async () => new Response("{}")) as typeof fetch });
  it("says so and prints no figures", async () => {
    const e = await estimateFreeze({ ctx: ctx(), provider: stub(() => ok("x")), resolved: [{ repo: "o/a", repoId: null }, { repo: "o/b", repoId: null }], window: WINDOW, selector: SEL, listingRequests: 3, concurrency: 4 });
    expect(e.supported).toBe(false);
    expect(estimateLines(e, null)).toEqual(["estimate: provider stub cannot estimate its requests (it has no estimateRequests), so no figures are printed: 2 repos need at least 2 requests"]);
  });

  it("scales a sample to the whole list; the sample spans the sorted repos", async () => {
    const resolved = Array.from({ length: 400 }, (_, i) => ({ repo: `o/r${String(i).padStart(3, "0")}`, repoId: null }));
    const seen: string[] = [];
    const p = stub(() => ok("x"), { estimateRequests: async (req) => (seen.push(req.repo), { requests: 10, graphql: 4, probed: 2 }) });
    const e = await estimateFreeze({ ctx: ctx(), provider: p, resolved, window: WINDOW, selector: SEL, listingRequests: 5, concurrency: 4, maxProbed: 100 });
    expect(seen).toHaveLength(100);
    expect(e).toMatchObject({ supported: true, repos: 400, sampled: 100 });
    expect(e.requests).toMatchObject({ listing: 5, repos: 4000, graphql: 1600, rest: 2400, total: 4005, probed: 200 });
    expect(estimateLines(e, null)[0]).toBe("estimate: 400 repos (probed 100 of them, every 4.0th, and scaled)");
    expect(sampleRepos(resolved, 100).map((r) => r.repo).slice(0, 3)).toEqual(["o/r000", "o/r004", "o/r008"]);
  });
});

describe("the checkpoint store belongs to freeze alone (components.md: verify must never read it)", () => {
  const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
  const closure = (file: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const m of src(file).matchAll(/^(?:import|export) (?!type )[^;]*?from\s+"(\.[^"]+)"/gm)) closure(join(file, "..", m[1]!).replace(/\.js$/, ".ts"), seen);
    return seen;
  };
  it("neither the verifier nor its command reaches the store, and the core reaches no API module", () => {
    expect([...closure("core/verify.ts")].filter((f) => /freeze-store|pooled-freeze|api\//.test(f))).toEqual([]);
    const verifyCommand = closure("commands/verify.ts");
    expect([...verifyCommand].filter((f) => /freeze-store|pooled-freeze/.test(f))).toEqual([]);
    expect(existsSync(join(__dirname, "..", "src", "api", "freeze-store.ts"))).toBe(true);
  });

  it("only the pooled run imports the store", () => {
    const importers = readdirSync(join(__dirname, "..", "src"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && /from\s+"[^"]*freeze-store\.js"/.test(src(f)))
      .sort();
    expect(importers).toEqual(["api/pooled-freeze.ts"]);
  });
});
