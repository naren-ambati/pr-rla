import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildProgram } from "../src/cli.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { buildPopulation } from "../src/core/population.js";
import type { ManifestV2, RegistrationRecordV2, SignedRecord } from "../src/core/records.js";
import { normalizeSelector } from "../src/core/selector.js";
import { createProvider } from "../src/registry.js";
import { FreezeCheckpointStore } from "../src/api/freeze-store.js";
import { fakeClock } from "./helpers/fake-clock.js";
import { fakeOrg, orgSpec, ORG, WINDOW, type FakeOrg } from "./helpers/fake-org.js";
import { setupPoolAudit, type PoolScenario } from "./helpers/pool-scenario.js";
import { T } from "./helpers/audit-scenario.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";
import { runVerify } from "../src/commands/verify.js";

/**
 * U8, end to end on a SYNTHETIC 40-repo org (fixture kind: synthetic; test-design.md §U8): the pooled freeze
 * (FR5.1 to FR5.4, FR5.7), its resume (NFR5, NFR6), exit 4 and the refusals. Every request goes to the mock in
 * test/helpers/fake-org.ts; no network, no scratch repo.
 */
const W = "audit/2026-q3";
const manifestText = (s: PoolScenario) => readFileSync(join(s.dir, `${W}.manifest.json`), "utf8");
const manifestOf = (s: PoolScenario) => JSON.parse(manifestText(s)) as ManifestV2;
const registrationOf = (s: PoolScenario) => JSON.parse(readFileSync(join(s.dir, W, "registration.json"), "utf8")) as SignedRecord<RegistrationRecordV2>;
const commitmentOf = (s: PoolScenario) => JSON.parse(readFileSync(join(s.dir, W, "manifest-commitment.json"), "utf8")) as { record: { frozenAt: string; N: number } };
/** 400 requests an hour on both budgets: the 40-repo org then waits on the rate budget for a while, as a big org does. */
const SLOW = "rate_limits: { api.github.com: { rest: 200/h, graphql: 200/h } }";

const org40 = () => fakeOrg(orgSpec({ eligible: 40, archived: 3, forks: 2, scale: 2 }));

async function registered(org: FakeOrg, o: Parameters<typeof setupPoolAudit>[1] = {}) {
  const s = setupPoolAudit(org, { extra: SLOW, ...o });
  expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
  await s.advance(12 * 3600_000); // 2026-10-20T12:00Z: the window is closed, R (10-21T00:00Z) is not yet public
  return s;
}

describe("FR5.1 / FR5.7: registering a repo rule", () => {
  it("signs the rule, not its resolution, and says what it resolves to now (archived repos and forks are out by default)", async () => {
    const org = org40();
    const s = setupPoolAudit(org);
    expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
    expect(registrationOf(s).record.repos).toEqual({ kind: "rule", owner: ORG, include: ["*"], exclude: [], archived: false, forks: false, visibility: ["internal", "private", "public"] });
    expect(s.out.join("\n")).toMatch(/repos: rule acme-org: include \* · archived excluded · forks excluded · visibility internal, private, public · resolves to 40 now; resolved again at freeze/);
  });

  it("archived: true and forks: true put them back in", async () => {
    const s = setupPoolAudit(org40(), { repos: `{ owner: ${ORG}, archived: true, forks: true }` });
    await s.clock.run(registerCommand(s.ctx, {}));
    expect(s.out.join("\n")).toMatch(/resolves to 45 now/);
  });

  it("refuses a rule that matches nothing, naming the rule", async () => {
    const s = setupPoolAudit(org40(), { repos: `{ owner: ${ORG}, include: [nothing-*] }` });
    await expect(s.clock.run(registerCommand(s.ctx, {}))).rejects.toThrow(/rule acme-org: include nothing-\* .* matches no repository the token can see/);
    expect(existsSync(join(s.dir, W, "registration.json"))).toBe(false);
  });

  it("refuses a rule for a provider that cannot list repos, naming the provider (json-file here)", async () => {
    const s = setupPoolAudit(org40(), { provider: "{ use: json-file, options: { path: changes.json } }" });
    await expect(s.clock.run(registerCommand(s.ctx, {}))).rejects.toThrow(/provider json-file cannot list an owner's repositories \(it has no listRepos\)/);
  });

  it("FR5.6: refuses a list that mixes providers, with the reason", async () => {
    const s = setupPoolAudit(org40(), { repos: `[github:${ORG}/svc-00, gitlab:${ORG}/svc-01]` });
    await expect(s.clock.run(registerCommand(s.ctx, {}))).rejects.toThrow(/one provider per pooled registration: the repo list names repositories on github and gitlab/);
  });
});

describe("FR5.2 / FR5.3 / FR5.7: the pooled freeze writes one manifest and one commitment for the org", () => {
  it("lists every repo with its id, default branch and pinned head; N is the union of per-repo populations", async () => {
    const org = org40();
    const s = await registered(org);
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    const m = manifestOf(s);
    // The defaults are in the resolved set: 40 repos, none archived and no fork.
    expect(m.repos.length).toBe(40);
    expect(m.repos.map((r) => r.repo)).toEqual([...m.repos.map((r) => r.repo)].sort());
    expect(m.repos.every((r) => r.repo.startsWith(`${ORG}/svc-`) && /^\d+$/.test(r.repoId!) && r.defaultBranch === "main" && /^[0-9a-f]{40}$/.test(r.headSha!))).toBe(true);
    // N: the selector over every repo's own population, computed independently, repo by repo.
    const provider = await createProvider({ use: "github", options: {} }, { cwd: s.dir, env: { GITHUB_TOKEN: "x" }, log: () => {}, fetch: org.fetch, sleep: async () => {} });
    const sel = normalizeSelector({ kinds: ["pull_request", "direct_push"], authors: "any", unreviewed: "no-human-review" });
    const each = await Promise.all(m.repos.map((r) => buildPopulation(provider, { repo: r.repo, window: WINDOW, selector: sel, cutoffIso: m.frozenAt, head: r.headSha! })));
    expect(m.changes.map((c) => c.id)).toEqual(each.flatMap((p) => p.entries.map((e) => e.id)).sort());
    expect(m.N).toBe(m.changes.length);
    expect(m.N).toBeGreaterThan(150);
    expect(new Set(m.changes.map((c) => c.repo)).size).toBeGreaterThan(30);
    // One commitment names the manifest: one certificate for the owner and window.
    const entries = readdirSync(join(s.dir, W));
    expect(entries.filter((f) => f.endsWith("commitment.json"))).toEqual(["manifest-commitment.json"]);
    expect(commitmentOf(s).record.N).toBe(m.N);
    expect(s.out.join("\n")).toMatch(/manifest [0-9a-f]{64} · N [\d,]+ · 40 repos → /);
  });

  it("the manifest's as-of time is the run's start; the commitment is signed when the run finishes (hours later is fine)", async () => {
    const s = await registered(org40());
    const start = new Date(s.clock.now()).toISOString().replace(".000Z", "Z");
    await s.clock.run(freezeCommand(s.ctx, {}));
    expect(manifestOf(s).frozenAt).toBe(start);
    const done = commitmentOf(s).record.frozenAt;
    expect(Date.parse(done)).toBeGreaterThan(Date.parse(start) + 5 * 60_000);
    expect(done).toBe(new Date(s.clock.now()).toISOString().replace(".000Z", "Z"));
  });

  it("FR5.7: there is no --skip-repo; the defaults are the documented ones", () => {
    const program = buildProgram(() => ({}) as never, () => {});
    const freeze = program.commands.find((c) => c.name() === "freeze")!;
    expect(freeze.options.map((o) => o.long)).not.toContain("--skip-repo");
    expect(freeze.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--estimate", "--resume"]));
  });

  it("a list registers exactly its repos (no ids: the SCM was not asked), P=4 listings at a time", async () => {
    const org = org40();
    const s = await registered(org, { repos: `[${ORG}/svc-03, ${ORG}/svc-01, ${ORG}/svc-02]` });
    expect(registrationOf(s).record.repos).toEqual({ kind: "list", repos: [`${ORG}/svc-01`, `${ORG}/svc-02`, `${ORG}/svc-03`] });
    await s.clock.run(freezeCommand(s.ctx, {}));
    expect(manifestOf(s).repos.map((r) => [r.repo, r.repoId])).toEqual([[`${ORG}/svc-01`, null], [`${ORG}/svc-02`, null], [`${ORG}/svc-03`, null]]);
  });
});

/** The manifest an uninterrupted freeze of a fresh copy of the org writes: the reference every other run must equal. */
async function reference(): Promise<{ text: string; requests: number }> {
  const org = org40();
  const s = await registered(org);
  const before = org.requests();
  expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
  return { text: manifestText(s), requests: org.requests() - before };
}

describe("NFR6: two runs over the same SCM state write byte-identical manifests", () => {
  it("two uninterrupted freezes of the same org", async () => {
    const a = await reference();
    const b = await reference();
    expect(a.text).toBe(b.text);
    expect(a.text.length).toBeGreaterThan(100_000);
  });

  it("whatever order the repos finish in: one repo at a time, or eight", async () => {
    const one = await registered(org40(), { extra: `${SLOW}\nfreeze: { concurrency: 1 }` });
    await one.clock.run(freezeCommand(one.ctx, {}));
    const eight = await registered(org40(), { extra: `${SLOW}\nfreeze: { concurrency: 8 }` });
    await eight.clock.run(freezeCommand(eight.ctx, {}));
    expect(manifestText(one)).toBe(manifestText(eight));
    expect(manifestText(one)).toBe((await reference()).text);
  });
});

describe("FR5.4 / NFR5: a rate-limited, stopped or killed freeze resumes to a byte-identical manifest", () => {
  it("429s injected through the run are waited out by the broker: the same manifest", async () => {
    const org = org40();
    org.control.every429 = 11;
    const s = await registered(org);
    const before = org.requests();
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    expect(org.requests() - before).toBeGreaterThan((await reference()).requests); // the 429s were really served, and retried
    expect(manifestText(s)).toBe((await reference()).text);
  });

  it("a killed run (the process dies mid-listing) is finished by the next run: byte-identical to an uninterrupted one", async () => {
    const want = await reference();
    const org = org40();
    const s = await registered(org);
    // Run 1 dies after 150 requests: every fetch after that never returns, and nothing is cleaned up.
    let count = 0;
    let dead!: () => void;
    const died = new Promise<void>((r) => (dead = r));
    const doomed = ((input: string | URL | Request, init?: RequestInit) => (++count > 150 ? (dead(), new Promise<Response>(() => {})) : org.fetch(input, init))) as typeof fetch;
    const clock1 = fakeClock(s.clock.now());
    void freezeCommand(s.ctxFor(doomed, clock1), {}).catch(() => {});
    await clock1.run(died);
    expect(existsSync(join(s.dir, "audit/2026-q3.manifest.json"))).toBe(false);
    const runs = FreezeCheckpointStore.runs(s.dir, "2026-q3");
    expect(runs.length).toBe(1);
    const done = readdirSync(join(s.dir, ".pr-rla/cache/2026-q3", runs[0]!, "repos")).filter((f) => f.endsWith(".json")).length;
    expect(done).toBeGreaterThan(5);
    expect(done).toBeLessThan(40);
    // Run 2, half an hour later, in a new process (new context, new clock): it lists only what is left.
    const clock2 = fakeClock(s.clock.now() + 30 * 60_000);
    const before = org.requests();
    s.out.length = 0;
    expect(await clock2.run(freezeCommand(s.ctxFor(org.fetch, clock2), {}))).toBe(0);
    expect(s.out.join("\n")).toMatch(new RegExp(`run [0-9a-f]{12}… resuming \\(${done} of 40 repos already listed, as of 2026-10-20T12:00:00Z\\)`));
    expect(org.requests() - before).toBeLessThan(want.requests * 0.9);
    expect(manifestText(s)).toBe(want.text);
    expect(manifestOf(s).frozenAt).toBe("2026-10-20T12:00:00Z"); // the first run's start, not the resume's
  });

  it("a rate budget that never frees up stops the run with exit 4 and the resume command; --resume finishes it", async () => {
    const want = await reference();
    const org = org40();
    const s = await registered(org);
    org.control.stuck.add(`${ORG}/svc-17`);
    let err: { exitCode: number; message: string } | null = null;
    await s.clock.run(freezeCommand(s.ctx, {})).catch((e) => (err = e));
    expect(err).not.toBeNull();
    expect(err!.exitCode).toBe(4);
    expect(err!.message).toMatch(/^stopped after \d+ of 40 repos: .*gave up after .*\. The \d+ repos listed are checkpointed; no manifest was written\. Continue with: pr-rla freeze --resume [0-9a-f]{64}$/);
    expect(existsSync(join(s.dir, "audit/2026-q3.manifest.json"))).toBe(false);
    expect(existsSync(join(s.dir, W, "manifest-commitment.json"))).toBe(false);
    const runId = /--resume ([0-9a-f]{64})$/.exec(err!.message)![1]!;
    // The service recovers; the printed command finishes the run.
    org.control.stuck.clear();
    const before = org.requests();
    expect(await s.clock.run(freezeCommand(s.ctx, { resume: runId }))).toBe(0);
    expect(manifestText(s)).toBe(want.text);
    expect(org.requests() - before).toBeLessThan(want.requests);
    expect(new FreezeCheckpointStore(s.dir, "2026-q3", runId).complete).toBe(true);
  });

  it("--resume takes a unique prefix of the run id, and refuses what it cannot continue", async () => {
    const org = org40();
    const s = await registered(org);
    org.control.stuck.add(`${ORG}/svc-17`);
    let runId = "";
    await s.clock.run(freezeCommand(s.ctx, {})).catch((e) => (runId = /--resume ([0-9a-f]{64})/.exec((e as Error).message)![1]!));
    // Not hex, too short, unknown:
    await expect(s.clock.run(freezeCommand(s.ctx, { resume: "xyz" }))).rejects.toThrow(/--resume takes the run id freeze printed/);
    await expect(s.clock.run(freezeCommand(s.ctx, { resume: "abcdef0123" }))).rejects.toThrow(/no checkpoint for run abcdef0123 under \.pr-rla\/cache\/2026-q3/);
    // The org gained a repo since the run began: its inputs differ, so its checkpoints are not resumed.
    org.addRepo({ name: "svc-new", prs: 5, pushes: 1 });
    org.control.stuck.clear();
    await expect(s.clock.run(freezeCommand(s.ctx, { resume: runId.slice(0, 12) }))).rejects.toThrow(/run [0-9a-f]{12}… cannot resume: the inputs now differ in the resolved repo list \(1 added, 0 removed since that run started\)/);
    // Without --resume the same command starts a new run (a new id) instead.
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    expect(manifestOf(s).repos.length).toBe(41);
    expect(FreezeCheckpointStore.runs(s.dir, "2026-q3").length).toBe(2);
  });

  it("a plain re-run of the same command also continues its run (same inputs, same id)", async () => {
    const want = await reference();
    const org = org40();
    const s = await registered(org);
    org.control.stuck.add(`${ORG}/svc-05`);
    await expect(s.clock.run(freezeCommand(s.ctx, {}))).rejects.toMatchObject({ exitCode: 4 });
    org.control.stuck.clear();
    s.out.length = 0;
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    expect(s.out.join("\n")).toMatch(/resuming \(\d+ of 40 repos already listed/);
    expect(manifestText(s)).toBe(want.text);
  });

  it("--force starts the run over: nothing is taken from an earlier run's checkpoints", async () => {
    const org = org40();
    const s = await registered(org);
    await s.clock.run(freezeCommand(s.ctx, {}));
    const before = org.requests();
    expect(await s.clock.run(freezeCommand(s.ctx, { force: true }))).toBe(0);
    expect(org.requests() - before).toBeGreaterThan(400); // listed again, all of it
  });

  it("--resume on a single repo, or on a dry run, has nothing to resume; with --force it is contradictory", async () => {
    const s = await registered(org40());
    await expect(s.clock.run(freezeCommand(s.ctx, { dryRun: true, resume: "abcdef0123" }))).rejects.toThrow(/nothing to resume/);
    await expect(s.clock.run(freezeCommand(s.ctx, { force: true, resume: "abcdef0123" }))).rejects.toThrow(/--resume continues a stopped run and --force starts over/);
  });
});

describe("FR5.4: all-or-nothing (no --skip-repo)", () => {
  it.each([[403], [404]] as const)("a repo that answers %i fails the run, names the repo and writes no manifest", async (status) => {
    const org = org40();
    const s = await registered(org);
    org.control.gone.set(`${ORG}/svc-21`, status);
    await expect(s.clock.run(freezeCommand(s.ctx, {}))).rejects.toThrow(new RegExp(`repo ${ORG}/svc-21: .*A repo the token cannot read must be excluded in the registered rule, before the seed; nothing is skipped`));
    expect(existsSync(join(s.dir, "audit/2026-q3.manifest.json"))).toBe(false);
  });
});

describe("FR5.5: freeze --dry-run --estimate", () => {
  const estimateOf = (s: PoolScenario) => {
    const json = s.out.find((l) => l.startsWith("{"))!;
    return JSON.parse(json) as { estimate: { supported: boolean; repos: number; sampled: number; requests: { listing: number; repos: number; rest: number; graphql: number; total: number; probed: number }; wallMs: { predicted: number; budget: number; work: number } }; msLeftBeforeR: number | null };
  };

  it("lands within ±20% of the actual request count and ±50% of the actual wall time on the synthetic 40-repo org", async () => {
    const a = await registered(org40());
    expect(await a.clock.run(freezeCommand(a.ctx, { estimate: true, json: true }))).toBe(0);
    const { estimate } = estimateOf(a);
    expect(estimate).toMatchObject({ supported: true, repos: 40, sampled: 40 });

    const orgB = org40();
    const b = await registered(orgB);
    const r0 = orgB.requests();
    const t0 = b.clock.now();
    expect(await b.clock.run(freezeCommand(b.ctx, {}))).toBe(0);
    const requests = orgB.requests() - r0;
    const wallMs = b.clock.now() - t0;

    expect(Math.abs(estimate.requests.total - requests) / requests).toBeLessThanOrEqual(0.2);
    expect(wallMs).toBeGreaterThan(10 * 60_000); // the rate budget really bound the run, so the wall-time bound means something
    expect(Math.abs(estimate.wallMs.predicted - wallMs) / wallMs).toBeLessThanOrEqual(0.5);
  });

  it.each([[16, 1], [13, 4], [14, 2]] as const)("and on other synthetic orgs (seed %i, size x%i): the same bounds", async (seed, scale) => {
    const mk = () => fakeOrg(orgSpec({ eligible: 40, archived: 3, forks: 2, scale, seed }));
    const a = await registered(mk());
    await a.clock.run(freezeCommand(a.ctx, { estimate: true, json: true }));
    const { estimate } = estimateOf(a);
    const orgB = mk();
    const b = await registered(orgB);
    const r0 = orgB.requests();
    const t0 = b.clock.now();
    await b.clock.run(freezeCommand(b.ctx, {}));
    const requests = orgB.requests() - r0;
    const wallMs = b.clock.now() - t0;
    expect(Math.abs(estimate.requests.total - requests) / requests).toBeLessThanOrEqual(0.2);
    expect(Math.abs(estimate.wallMs.predicted - wallMs) / wallMs).toBeLessThanOrEqual(0.5);
  });

  it("prints the figures, the budget it paced to and the time left before R; reads only", async () => {
    const org = org40();
    const s = await registered(org);
    expect(await s.clock.run(freezeCommand(s.ctx, { estimate: true }))).toBe(0);
    const text = s.out.join("\n");
    expect(text).toMatch(/estimate: 40 repos \(all probed\)/);
    expect(text).toMatch(/requests: ~[\d,]+ = \d+ listing \+ ~[\d,]+ for the repos \(~[\d,]+ REST, ~[\d,]+ GraphQL\); the probes already spent [\d,]+/);
    expect(text).toMatch(/wall time: ~\d+ min at 4 repos at a time \(bound by the rate budget/);
    expect(text).toMatch(/budget api\.github\.com: rest \(configured|budget api\.github\.com: rest: GITHUB_TOKEN in GitHub Actions/);
    expect(text).toMatch(/time left before seed round R publishes: \d+(\.\d)? h/);
    // Reads only: no manifest, no checkpoint, no cache directory.
    expect(existsSync(join(s.dir, "audit/2026-q3.manifest.json"))).toBe(false);
    expect(existsSync(join(s.dir, ".pr-rla/cache"))).toBe(false);
  });

  it("works before anything is registered (it implies --dry-run), and warns when the wall time exceeds the time left before R", async () => {
    const org = org40();
    const s = setupPoolAudit(org, { extra: SLOW });
    await s.clock.run(registerCommand(s.ctx, {}));
    // 23:30: the freeze would need ~40 minutes at this budget, R publishes at 00:00.
    await s.advance(23.5 * 3600_000);
    s.out.length = 0;
    expect(await s.clock.run(freezeCommand(s.ctx, { estimate: true }))).toBe(0);
    expect(s.out.join("\n")).toMatch(/WARNING: the predicted wall time \(\d+ min\) exceeds the time left before seed round R publishes \(30 min\)/);
    const bare = setupPoolAudit(org40(), { extra: SLOW });
    expect(await bare.clock.run(freezeCommand(bare.ctx, { estimate: true }))).toBe(0);
    expect(bare.out.join("\n")).toMatch(/estimate: 40 repos/);
  });

  it("probes at most 200 repos and scales the rest", async () => {
    const { sampleRepos } = await import("../src/api/freeze-estimate.js");
    const repos = Array.from({ length: 1000 }, (_, i) => i);
    const sample = sampleRepos(repos, 200);
    expect(sample.length).toBe(200);
    expect(sample[0]).toBe(0);
    expect(sample.at(-1)).toBeGreaterThan(990);
    expect(sampleRepos(repos.slice(0, 40), 200)).toEqual(repos.slice(0, 40));
  });
});

describe("timestamps on a pooled freeze that takes a long time (tokens bound the commitment, not the manifest's as-of time)", () => {
  it("a freeze of ~40 minutes gets its tokens: the commitment is signed when the run finishes, 2 of 2 authorities agree, and verify accepts both times", async () => {
    const tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
    try {
      const org = org40();
      const s = setupPoolAudit(org, { extra: SLOW, timestamping: "{ authorities: [test-a, test-b], min_tokens: 2 }", tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
      // The authorities' genTime follows the test's clock; their answers come over real loopback HTTP, so wait for them in real time.
      Object.defineProperty(tsa, "nowMs", { get: () => s.clock.now() });
      const mixed = ((input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).hostname === "api.github.com" ? org.fetch(input, init) : globalThis.fetch(input, init))) as typeof fetch;
      const ctx = s.ctxFor(mixed);
      const drive = async <T>(work: Promise<T>): Promise<T> => {
        for (;;) {
          try {
            return await s.clock.run(work);
          } catch (e) {
            if (!/waiting on something other than the clock/.test((e as Error).message)) throw e;
            await new Promise((r) => setTimeout(r, 5));
          }
        }
      };
      expect(await drive(registerCommand(ctx, {}))).toBe(0);
      await s.advance(12 * 3600_000);
      expect(await drive(freezeCommand(ctx, {}))).toBe(0);
      const m = manifestOf(s);
      const done = commitmentOf(s).record.frozenAt;
      expect(Date.parse(done) - Date.parse(m.frozenAt)).toBeGreaterThan(10 * 60_000); // longer than the tokens' 10-minute tolerance
      const signed = JSON.parse(readFileSync(join(s.dir, W, "manifest-commitment.json"), "utf8")) as { timestamps: { tsa: string; genTime: string }[] };
      expect(signed.timestamps.map((t) => t.tsa).sort()).toEqual(["test-a", "test-b"]);
      expect(signed.timestamps.every((t) => Math.abs(Date.parse(t.genTime) - Date.parse(done)) < 5000)).toBe(true);
      expect(s.out.join("\n")).toMatch(/timestamps: 2 of 2 TSAs \(test-a, test-b\) · k = 2 · PROVEN/);
      const report = await drive(runVerify(ctx, { offline: false }));
      expect(report.timestampTamperProof).toBe(true);
      expect(report.checks.find((c) => c.n === 2)!.status).toBe("PASS");
      expect(report.checks.find((c) => c.n === 5)!.status).toBe("PASS");
    } finally {
      await tsa.stop();
    }
  });

  it("a freeze that would finish after seed round R is refused and writes nothing (its checkpoints are kept)", async () => {
    const org = org40();
    const s = setupPoolAudit(org, { extra: "rate_limits: { api.github.com: { rest: 60/h, graphql: 60/h } }" });
    expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
    await s.advance(23.9 * 3600_000); // 23:54: R publishes at 00:00 and this budget needs hours
    await expect(s.clock.run(freezeCommand(s.ctx, {}))).rejects.toThrow(/the freeze finished 2026-10-2\dT.*, after seed round \d+ published \(2026-10-21T00:00:00Z\).*Its checkpoints are kept; register a new audit/);
    expect(existsSync(join(s.dir, "audit/2026-q3.manifest.json"))).toBe(false);
    expect(FreezeCheckpointStore.runs(s.dir, "2026-q3").length).toBe(1);
  });
});
