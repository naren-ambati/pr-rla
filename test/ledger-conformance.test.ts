import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import githubIssues from "../src/ledgers/github-issues/index.js";
import type { Ledger, LedgerHistoryEvent, VerdictEvent } from "../src/sdk/ledger.js";
import { runLedgerConformance, type LedgerFixture } from "../src/testing/index.js";
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

  it("first-label: a ledger that lets the latest label win (current labels, not history)", async () => {
    const r = await result(() => memory({ verdicts: [later, first] }), base("last wins", "first-label", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "PASS" }), "first-label");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/draw #1: counted .*"fail".*expected .*"pass"/);
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
    const counted = await result(() => memory({ verdicts: [ev(1, "pass", "github-actions[bot]", "2026-10-21T03:00:00Z", "e9")] }), base("bot listed", "app-applied", { counted: { 1: null }, integrity: "PASS" }), "app-applied");
    expect(counted.ok).toBe(true);
    const unlisted = await result(() => memory({ verdicts: [first] }), base("no unlisted", "unlisted-reviewer", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: first.recordedAt } }, integrity: "PASS" }, { reviewers: ["alice"] }), "unlisted-reviewer");
    expect(unlisted.message).toMatch(/no verdict event by an unlisted account/);
  });

  it("verdict-before-seed: a ledger that stamps verdicts with the reading time, not the tracker's", async () => {
    const r = await result(() => memory({ verdicts: [ev(1, "pass", "alice", "2026-10-23T00:00:00Z", "e1")] }), base("read time", "verdict-before-seed", { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: "2026-10-23T00:00:00Z" } }, integrity: "PASS", seedPublishedAt: "2026-10-22T00:00:00Z" }), "verdict-before-seed");
    expect(r.message).toMatch(/no counted verdict is dated before 2026-10-22T00:00:00Z/);
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
