import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import githubIssues from "../src/ledgers/github-issues/index.js";
import type { Ledger, LedgerHistoryEvent, VerdictEvent } from "../src/sdk/ledger.js";
import { assertLedgerConformance, countedVerdicts, LEDGER_CASES, runLedgerConformance, type LedgerFixture } from "../src/testing/index.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { PUB, draw } from "./helpers/ledger-draws.js";

/**
 * The ledger kit's own tests: each check fails on a ledger (or a fixture) that breaks the rule
 * it stands for. In-memory ledgers are synthetic by construction.
 */
const P = "ab".repeat(32);
const ev = (d: number, verdict: "pass" | "fail", reviewer: string, at: string, id: string, extra: Partial<VerdictEvent["provenance"]> = {}): VerdictEvent => ({ draw: d, changeId: `json:acme/widgets#${100 + d}`, verdict, protocolSha256: P, reviewer, recordedAt: at, provenance: { level: "account", source: "scm-label-event", eventId: id, viaApp: null, ...extra } });
const hist = (id: string, at: string, d: number, action: "add" | "remove", label: string, login: string): LedgerHistoryEvent => ({ id, at, actor: { login, kind: login.endsWith("[bot]") ? "bot" : "human" }, action, label, draw: d });

function memory(o: { verdicts: VerdictEvent[]; history?: LedgerHistoryEvent[]; ok?: boolean; warnings?: string[]; findings?: string[] }): Ledger {
  return {
    apiVersion: 1,
    name: "memory",
    readVerdicts: async () => o.verdicts,
    appendVerdict: async () => {},
    verifyIntegrity: async () => ({ ok: o.ok ?? true, findings: o.findings ?? [], warnings: o.warnings ?? [], tamperTrail: true }),
    readHistory: async () => o.history ?? [],
  };
}
const base = (name: string, c: LedgerFixture["case"], expect: LedgerFixture["expect"], extra: Partial<LedgerFixture> = {}): LedgerFixture => ({ name, case: c, source: "synthetic", draws: [draw(1, 101), draw(2, 102)], expect, ...extra });
const result = async (l: () => Ledger, f: LedgerFixture, check: string) => (await runLedgerConformance(async () => l(), [f])).results.find((r) => r.check === check)!;

describe("the ledger kit fails ledgers that break the rules", () => {
  const first = ev(1, "pass", "alice", "2026-10-21T03:00:00Z", "e1");
  const later = ev(1, "fail", "bob", "2026-10-21T04:00:00Z", "e2");

  it("first-label: a ledger that returns the later label first is not in recorded order (the core counts the first it is given)", async () => {
    const f = base("last wins", "first-label", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "PASS" });
    const r = await result(() => memory({ verdicts: [later, first] }), f, "normalization");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/readVerdicts is not in recorded order: draw #1's verdict \(2026-10-21T03:00:00Z, event e1\) comes after draw #1's \(2026-10-21T04:00:00Z, event e2\)/);
    // The kit's own count is by time, then id, so the declared first verdict is judged against the right one.
    expect(countedVerdicts([later, first]).get(1)).toBe(first);
  });

  it("first-label: a ledger whose first verdict is the wrong one still fails the count", async () => {
    const r = await result(() => memory({ verdicts: [{ ...first, verdict: "fail" }] }), base("wrong", "first-label", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "PASS" }), "first-label");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/draw #1: counted .*"fail".*expected .*"pass"/);
  });

  it("countedVerdicts orders same-second events by numeric id, as the core's ledgers do", () => {
    const at = "2026-10-21T03:00:00Z";
    const hundred = ev(1, "pass", "alice", at, "100");
    const ninetyNine = ev(1, "fail", "alice", at, "99");
    expect(countedVerdicts([hundred, ninetyNine]).get(1)).toBe(ninetyNine);
  });

  it("removal: a ledger that passes a verdict removed after it counted, and a fixture that declares it may", async () => {
    const f = base("removal passes", "removal", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "FAIL" });
    const r = await result(() => memory({ verdicts: [first] }), f, "integrity");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/integrity PASS, expected FAIL/);
    const declared = await result(() => memory({ verdicts: [first], ok: false, findings: ["removed"] }), { ...f, expect: { ...f.expect, integrity: "PASS" } }, "integrity");
    expect(declared.message).toMatch(/the fixture declares PASS, but the design requires FAIL for removal/);
  });

  it("relabel-same: a ledger that stays quiet about a removed and re-added verdict", async () => {
    const r = await result(() => memory({ verdicts: [first, ev(1, "pass", "alice", "2026-10-21T05:00:00Z", "e3")] }), base("quiet relabel", "relabel-same", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "WARN" }), "relabel-same");
    expect(r.ok).toBe(false);
  });

  it("app-applied and unlisted-reviewer: a ledger that drops ineligible events instead of returning them to be reported", async () => {
    const app = await result(() => memory({ verdicts: [] }), base("drops apps", "app-applied", { counted: { 1: null }, integrity: "PASS" }), "app-applied");
    expect(app.message).toMatch(/no verdict event applied by an app or bot account came back/);
    const unlisted = await result(() => memory({ verdicts: [first] }), base("no unlisted", "unlisted-reviewer", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "PASS" }, { reviewers: ["alice"] }), "unlisted-reviewer");
    expect(unlisted.message).toMatch(/no verdict event by an unlisted account/);
  });

  it("app-applied and unlisted-reviewer exercise the ledger's own path: its report must name the event, and the core must ignore it", async () => {
    const bot = ev(1, "pass", "github-actions[bot]", "2026-10-21T03:00:00Z", "e9");
    const f = base("bot listed", "app-applied", { counted: { 1: null }, integrity: "PASS" });
    const quiet = await result(() => memory({ verdicts: [bot] }), f, "app-applied");
    expect(quiet.ok).toBe(false);
    expect(quiet.message).toMatch(/the ledger's own integrity report does not mention the app-applied event/);
    const told = await result(() => memory({ verdicts: [bot], findings: ["draw #1: pr-rla:pass applied by bot account github-actions[bot] (2026-10-21T03:00:00Z); not counted"] }), f, "app-applied");
    expect(told.ok, told.message).toBe(true);
    const intruder = ev(1, "pass", "intruder", "2026-10-21T03:00:00Z", "e8");
    const u = base("unlisted", "unlisted-reviewer", { counted: { 1: { verdict: "fail", reviewer: "alice", recordedAt: later.recordedAt } }, integrity: "PASS" }, { reviewers: ["alice"] });
    const silent = await result(() => memory({ verdicts: [intruder, { ...later, reviewer: "alice" }] }), u, "unlisted-reviewer");
    expect(silent.message).toMatch(/the ledger's own integrity report does not mention the unlisted account/);
    const loud = await result(() => memory({ verdicts: [intruder, { ...later, reviewer: "alice" }], findings: ["draw #1: pr-rla:pass intruder is not a registered reviewer (2026-10-21T03:00:00Z); not counted"] }), u, "unlisted-reviewer");
    expect(loud.ok, loud.message).toBe(true);
  });

  it("verdict-before-seed: a ledger that stamps verdicts with the reading time, not the tracker's", async () => {
    const r = await result(() => memory({ verdicts: [ev(1, "pass", "alice", "2026-10-23T00:00:00Z", "e1")] }), base("read time", "verdict-before-seed", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: "2026-10-23T00:00:00Z" } }, integrity: "PASS", seedPublishedAt: "2026-10-22T00:00:00Z" }), "verdict-before-seed");
    expect(r.message).toMatch(/no counted verdict is dated before 2026-10-22T00:00:00Z/);
  });

  it("verdict-before-seed asks the core: only the verdict the core COUNTS can be refused (an early verdict by an unlisted account does not count)", async () => {
    const early = ev(1, "pass", "intruder", "2026-10-21T00:00:00Z", "e1");
    const f = base("early but ignored", "verdict-before-seed", { counted: { 1: null }, integrity: "PASS", seedPublishedAt: "2026-10-22T00:00:00Z" }, { reviewers: ["alice"] });
    const ignored = await result(() => memory({ verdicts: [early] }), f, "verdict-before-seed");
    expect(ignored.ok).toBe(false);
    expect(ignored.message).toMatch(/no counted verdict is dated before/);
    const counted = await result(() => memory({ verdicts: [{ ...early, reviewer: "alice" }] }), f, "verdict-before-seed");
    expect(counted.ok, counted.message).toBe(true);
  });

  it("checkpoint-round-trip: unstable history, a counted verdict missing from it, and an erasure that does not show", async () => {
    let n = 0;
    const f = base("unstable", "checkpoint-round-trip", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "PASS" }, { erasedEventId: "e1" });
    const r = await result(() => memory({ verdicts: [first], history: [hist(`x${n++}`, first.recordedAt, 1, "add", "pr-rla:pass", "alice")] }), f, "checkpoint-round-trip");
    expect(r.message).toMatch(/two reads of an unchanged tracker gave different canonical histories/);
    expect(r.message).toMatch(/the counted verdict on draw #1 \(event e1\) is not in the history/);
  });

  it("pagination: a fixture whose history fits on one page", async () => {
    const r = await result(() => memory({ verdicts: [first], history: [hist("e1", first.recordedAt, 1, "add", "pr-rla:pass", "alice")] }), base("short", "pagination", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "PASS" }), "pagination");
    expect(r.message).toMatch(/history has 1 events < 101/);
  });

  it("normalization: an unmarked fixture source, and a verdict without provenance", async () => {
    const r = await runLedgerConformance(async () => memory({ verdicts: [] }), [{ ...base("unmarked", "first-label", { counted: {}, integrity: "PASS" }), source: "recorded?" as never }]);
    expect(r.results[0]!.message).toMatch(/fixture source must be "recorded" or "synthetic" \(FR4\.7\)/);
    const { provenance: _p, ...bare } = first;
    const n = await result(() => memory({ verdicts: [bare] }), base("bare", "first-label", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "PASS" }), "normalization");
    expect(n.message).toMatch(/has no provenance/);
  });

  it("transient-faults: an HTTP ledger that neither retries nor speaks the broker contract", async () => {
    const fake = new FakeGitHubIssues();
    const dir = mkdtempSync(join(tmpdir(), "prrla-kit-"));
    const seed = await githubIssues.create({ repo: "acme/audit" }, { cwd: dir, windowDir: dir, env: {}, log: () => {}, fetch: fake.fetch });
    await seed.publishDraws!([draw(1, 101)], PUB);
    fake.label(1, "pr-rla:pass", { login: "alice", id: 1, type: "User" });
    // Strips the broker fields, so neither the broker nor the kit's broker-shaped harness retries it.
    const plain = (f: typeof fetch) => (async (u: string | URL | Request, i?: RequestInit) => {
      const { destination: _d, retry: _r, idempotent: _i, ...rest } = (i ?? {}) as RequestInit & { destination?: string; retry?: unknown; idempotent?: boolean };
      return f(u, rest);
    }) as typeof fetch;
    const r = await runLedgerConformance(
      async (_f, h) => githubIssues.create({ repo: "acme/audit" }, { ...h.context({ fetch: fake.fetch, windowDir: dir }), fetch: plain(h.context({ fetch: fake.fetch, windowDir: dir }).fetch) }),
      [{ ...base("no retries", "first-label", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: fake.issues.get(1)!.events.at(-1)!.created_at } }, integrity: "PASS" }), draws: [draw(1, 101)], http: true }],
    );
    const t = r.results.find((x) => x.check === "transient-faults")!;
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/threw under transient faults/);
  });

  it("idempotent-publish: a ledger that opens issues again when its index is lost", async () => {
    const fake = new FakeGitHubIssues();
    const dir = mkdtempSync(join(tmpdir(), "prrla-kit-"));
    const forgetful = async (_f: LedgerFixture, h: Parameters<Parameters<typeof runLedgerConformance>[0]>[1]) => {
      const ctx = h.context({ fetch: fake.fetch, windowDir: dir });
      const l = await githubIssues.create({ repo: "acme/audit" }, ctx);
      // Publishes without looking for existing markers: a fresh index every time.
      return { ...l, readVerdicts: () => l.readVerdicts(), verifyIntegrity: () => l.verifyIntegrity!(), readHistory: () => l.readHistory!(), publishDraws: async (d: Parameters<NonNullable<Ledger["publishDraws"]>>[0], c?: Parameters<NonNullable<Ledger["publishDraws"]>>[1]) => {
        for (const x of d) await ctx.fetch(`${fake.repoUrl}/issues`, { method: "POST", body: JSON.stringify({ title: `draw ${x.draw}`, body: "no marker" }) });
        void c;
      } } as Ledger;
    };
    const r = await runLedgerConformance(forgetful, [{ ...base("forgetful", "idempotent-publish", { counted: {}, integrity: "PASS" }), publish: PUB, forgetLocalState: () => {} }]);
    expect(r.results[0]!.ok).toBe(false);
  });
});

describe("the ledger kit does not pass by checking nothing (finding 10, tests that cannot fail)", () => {
  it("fails an empty fixture list, and assertLedgerConformance throws", async () => {
    const r = await runLedgerConformance(async () => memory({ verdicts: [] }), []);
    expect(r.ok).toBe(false);
    expect(r.results[0]).toMatchObject({ fixture: "(no fixtures)", ok: false, message: expect.stringMatching(/checked nothing/) });
    await expect(assertLedgerConformance(async () => memory({ verdicts: [] }), [])).rejects.toThrow(/ledger conformance failed/);
  });

  it("fails every case no fixture covers, unless the caller names it with a reason, and then reports it as skipped", async () => {
    const f = base("one case", "first-label", { counted: {}, integrity: "PASS" });
    const r = await runLedgerConformance(async () => memory({ verdicts: [] }), [f]);
    const missing = r.results.filter((x) => x.fixture === "(case coverage)" && !x.ok).map((x) => x.check);
    expect(missing).toEqual(LEDGER_CASES.filter((c) => c !== "first-label"));
    expect(r.results.find((x) => x.check === "deletion")!.message).toMatch(/no fixture exercises the case "deletion": add one, or name it in options\.skipCases/);
    const skipAll = Object.fromEntries(LEDGER_CASES.filter((c) => c !== "first-label").map((c) => [c, `${c} needs a tracker`]));
    const skipped = await runLedgerConformance(async () => memory({ verdicts: [] }), [f], { skipCases: skipAll });
    expect(skipped.ok).toBe(true);
    expect(skipped.results.filter((x) => x.skipped && x.fixture === "(case coverage)")).toHaveLength(LEDGER_CASES.length - 1);
    expect(skipped.results.find((x) => x.check === "deletion")).toMatchObject({ ok: true, skipped: true, message: "not exercised by this run: deletion needs a tracker" });
    const typo = await runLedgerConformance(async () => memory({ verdicts: [] }), [f], { skipCases: { ...skipAll, "no-such-case": "x" } as never });
    expect(typo.ok).toBe(false);
  });
});

describe("transient faults on writes (finding 10, tests that cannot fail)", () => {
  type Mode = "careful" | "impatient";
  // A ledger that lists the tracker's issues before it writes (so a clean re-run writes nothing), but repeats a failed
  // write at once and blindly: it does not wait out a 429, and it writes again after a response was lost.
  const make = (mode: Mode) => {
    const clean = new FakeGitHubIssues();
    const faulty = new FakeGitHubIssues();
    const cleanDir = mkdtempSync(join(tmpdir(), "prrla-wf-"));
    const faultyDir = mkdtempSync(join(tmpdir(), "prrla-wf-"));
    const factory = async (_f: LedgerFixture, h: Parameters<Parameters<typeof runLedgerConformance>[0]>[1]): Promise<Ledger> => {
      const isFaulty = h.phase === "publish-faults" || h.phase === "publish-recover";
      const fake = isFaulty ? faulty : clean;
      const dir = isFaulty ? faultyDir : cleanDir;
      const real = await githubIssues.create({ repo: "acme/audit" }, h.context({ fetch: fake.fetch, windowDir: dir, env: { GITHUB_TOKEN: "t" } }));
      if (mode === "careful") return real;
      const ctx = h.context({ fetch: fake.fetch, windowDir: dir });
      const api = `${fake.repoUrl}/issues`;
      const write = async (title: string) => {
        const post = () => ctx.fetch(api, { method: "POST", body: JSON.stringify({ title, body: "x" }) });
        let r = await post();
        if (!r.ok) r = await post(); // repeated at once: no wait, and blind to a write that already happened
        return r;
      };
      return {
        ...real,
        readVerdicts: () => real.readVerdicts(),
        verifyIntegrity: async () => ({ ok: true, findings: [], tamperTrail: true }),
        readHistory: async () => [],
        appendVerdict: async () => {
          await write("record");
        },
        publishDraws: async (draws) => {
          const have = new Set(((await (await ctx.fetch(`${api}?state=all`)).json()) as { title: string }[]).map((i) => i.title));
          for (const d of draws) if (d.firstOccurrence && !have.has(`draw ${d.draw}`)) await write(`draw ${d.draw}`);
        },
      } as Ledger;
    };
    const f: LedgerFixture = { ...base("writes", "idempotent-publish", { counted: {}, integrity: "PASS" }), http: true, draws: [draw(1, 101), draw(2, 102), draw(3, 103)], publish: PUB, forgetLocalState: () => rmSync(join(cleanDir, "ledger-index.json"), { force: true }) };
    return { factory, f };
  };

  it("a ledger that waits out a 429 and does not repeat a write whose response was lost passes", async () => {
    const { factory, f } = make("careful");
    const r = await runLedgerConformance(factory, [f]);
    const w = r.results.find((x) => x.check === "transient-write-faults")!;
    expect(w, JSON.stringify(r.results)).toMatchObject({ ok: true });
    expect(w.skipped).toBeFalsy();
  });

  it("a ledger that repeats a write at once, and again after a lost response, fails both ways", async () => {
    const { factory, f } = make("impatient");
    const r = await runLedgerConformance(factory, [f]);
    const w = r.results.find((x) => x.check === "transient-write-faults")!;
    expect(w.ok).toBe(false);
    expect(w.message).toMatch(/the tracker received \d+ write\(s\) across the faulted publish and its recovery, a clean publish makes 3: a write was repeated after its response was lost \(a duplicate\)/);
    expect(w.message).toMatch(/after the injected 429 on a record the ledger did not wait as long as Retry-After says/);
  });

  it("a factory that serves no fresh tracker for publish-faults gets a skip that says what to serve, not a pass", async () => {
    const clean = new FakeGitHubIssues();
    const dir = mkdtempSync(join(tmpdir(), "prrla-wf-"));
    const f: LedgerFixture = { ...base("writes", "idempotent-publish", { counted: {}, integrity: "PASS" }), http: true, draws: [draw(1, 101)], publish: PUB, forgetLocalState: () => rmSync(join(dir, "ledger-index.json")) };
    const r = await runLedgerConformance(async (_f, h) => githubIssues.create({ repo: "acme/audit" }, h.context({ fetch: clean.fetch, windowDir: dir, env: { GITHUB_TOKEN: "t" } })), [f]);
    const w = r.results.find((x) => x.check === "transient-write-faults")!;
    expect(w).toMatchObject({ ok: true, skipped: true });
    expect(w.message).toMatch(/serve a fresh tracker .* for phase "publish-faults"|a clean publish makes \d+ write\(s\); two are needed/);
  });
});
