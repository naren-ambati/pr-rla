import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditContext, openLedger } from "../src/api/context.js";
import githubIssues from "../src/ledgers/github-issues/index.js";
import { WritePathNotAllowed } from "../src/net/contract.js";
import type { DrawForLedger, Ledger } from "../src/sdk/ledger.js";
import { formatLedgerConformanceReport, runLedgerConformance, type LedgerFixture, type LedgerHarness } from "../src/testing/index.js";
import { FakeGitHubIssues, type FakeUser } from "./helpers/fake-issue-trackers.js";
import { PUB, draw } from "./helpers/ledger-draws.js";

/**
 * github-issues on a synthetic GitHub (FR4.1–FR4.3, FR4.8): every fixture here is
 * `source: "synthetic"`. Recorded public timelines are in github-issues-recorded.test.ts.
 */
const DRAWS = [draw(1, 101), draw(2, 102), draw(3, 103)];
const alice: FakeUser = { login: "alice", id: 11, type: "User" };
const bob: FakeUser = { login: "bob", id: 12, type: "User" };
const actionsBot: FakeUser = { login: "github-actions[bot]", id: 41898282, type: "Bot" };
const PASS = "pr-rla:pass";
const FAIL = "pr-rla:fail";

const tmp = () => mkdtempSync(join(tmpdir(), "prrla-ghi-"));

/** Publishes the draws to a fresh fake, then lets `setup` act as reviewers and admins. Deterministic, so every kit phase sees the same tracker. */
async function scenario(setup: (fake: FakeGitHubIssues, issue: (d: number) => number) => void, o: { api?: string; draws?: DrawForLedger[] } = {}) {
  const fake = new FakeGitHubIssues(o.api ?? "https://api.github.com");
  const windowDir = tmp();
  const options = { repo: "acme/audit", ...(o.api ? { api_url: o.api } : {}) };
  const l = await githubIssues.create(options, { cwd: windowDir, windowDir, env: { GITHUB_TOKEN: "t" }, log: () => {}, fetch: fake.fetch });
  await l.publishDraws!(o.draws ?? DRAWS, PUB);
  setup(fake, (d) => fake.issueByDraw(d).number);
  return { fake, windowDir, options };
}

const at = (fake: FakeGitHubIssues, id: number) => [...fake.issues.values()].flatMap((i) => i.events).find((e) => e.id === id)!.created_at;

type Setup = Parameters<typeof scenario>[0];
interface Case {
  fixture: Omit<LedgerFixture, "source" | "draws" | "http"> & { draws?: DrawForLedger[] };
  setup: Setup;
  erase?: (fake: FakeGitHubIssues) => void;
}

/** Builds each case once to learn its event ids and times, so the fixture can name them. */
async function cases(): Promise<{ fixtures: LedgerFixture[]; factory: (f: LedgerFixture, h: LedgerHarness) => Promise<Ledger> }> {
  const ids: Record<string, number> = {};
  const defs: Case[] = [];
  const probe = async (setup: Setup) => (await scenario(setup)).fake;

  // first-label: a human's first verdict counts, a fail too; an unlabelled draw has none.
  let f = await probe((g, i) => {
    ids.a = g.label(i(1), PASS, alice);
    ids.b = g.label(i(2), FAIL, bob);
  });
  defs.push({ fixture: { name: "synthetic first-label", case: "first-label", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.a!) }, 2: { verdict: "fail", reviewer: "bob", recordedAt: at(f, ids.b!) }, 3: null }, integrity: "PASS" } }, setup: (g, i) => (g.label(i(1), PASS, alice), g.label(i(2), FAIL, bob)) });

  const relabelSame: Setup = (g, i) => {
    ids.rs = g.label(i(1), PASS, alice);
    g.unlabel(i(1), PASS, alice);
    g.label(i(1), PASS, alice);
  };
  f = await probe(relabelSame);
  defs.push({ fixture: { name: "synthetic relabel-same", case: "relabel-same", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.rs!) } }, integrity: "WARN", messages: [/removed and added again \(relabel, same verdict\)/] } }, setup: relabelSame });

  const relabelOpp: Setup = (g, i) => {
    ids.ro1 = g.label(i(1), PASS, alice);
    g.label(i(1), FAIL, bob); // both present
    ids.ro2 = g.label(i(2), PASS, alice);
    g.unlabel(i(2), PASS, alice);
    g.label(i(2), FAIL, alice); // a swap
  };
  f = await probe(relabelOpp);
  defs.push({ fixture: { name: "synthetic relabel-opposite", case: "relabel-opposite", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.ro1!) }, 2: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.ro2!) } }, integrity: "WARN", messages: [/relabel pass→fail \(both labels present\)/, /draw #2: relabel pass→fail; the first verdict/] } }, setup: relabelOpp });

  const removal: Setup = (g, i) => {
    ids.rm = g.label(i(1), PASS, alice);
    g.unlabel(i(1), PASS, bob);
  };
  f = await probe(removal);
  defs.push({ fixture: { name: "synthetic removal after counting", case: "removal", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.rm!) } }, integrity: "FAIL", messages: [/the counted pr-rla:pass verdict was removed at .* and nothing replaced it/] } }, setup: removal });

  defs.push({ fixture: { name: "synthetic deleted issue", case: "deletion", expect: { counted: { 1: null, 2: null }, integrity: "FAIL", messages: [/draw #1 issue .* deleted \(HTTP 410\)/, /draw #2 issue .* moved \(now https:\/\/github\.example\/acme\/elsewhere/] } }, setup: (g, i) => (g.label(i(1), PASS, alice), g.deleteIssue(i(1), 410), g.transferIssue(i(2), "acme/elsewhere")) });

  const rename: Setup = (g, i) => {
    ids.rn = g.label(i(1), PASS, alice);
    g.renameLabel(PASS, "verdict: pass");
  };
  f = await probe(rename);
  defs.push({ fixture: { name: "synthetic label renamed", case: "label-rename", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.rn!) } }, integrity: "FAIL", messages: [/verdict label "pr-rla:pass" no longer exists in acme\/audit \(deleted or renamed\)/] } }, setup: rename });
  const recreated: Setup = (g, i) => {
    ids.rc = g.label(i(1), PASS, alice);
    g.renameLabel(PASS, "verdict: pass");
    g.addLabel(PASS); // a new label takes the old name (as rust-lang/rust's T-libs did)
  };
  f = await probe(recreated);
  defs.push({ fixture: { name: "synthetic label renamed and its name re-used", case: "label-rename", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.rc!) } }, integrity: "FAIL", messages: [/is not the label the draws were published with \(id \d+, now \d+\)/] } }, setup: recreated });

  const unlisted: Setup = (g, i) => {
    g.label(i(1), PASS, { login: "intruder", id: 66, type: "User" });
    ids.ul = g.label(i(1), FAIL, alice);
  };
  f = await probe(unlisted);
  defs.push({ fixture: { name: "synthetic unlisted reviewer", case: "unlisted-reviewer", reviewers: ["alice"], expect: { counted: { 1: { verdict: "fail", reviewer: "alice", recordedAt: at(f, ids.ul!) } }, integrity: "PASS", messages: [/pr-rla:pass intruder is not a registered reviewer/] } }, setup: unlisted });

  defs.push({ fixture: { name: "synthetic app-applied", case: "app-applied", expect: { counted: { 1: null, 2: null }, integrity: "PASS", messages: [/applied by bot account github-actions\[bot\]/, /applied by app "copilot-swe-agent"/] } }, setup: (g, i) => (g.label(i(1), PASS, actionsBot), g.label(i(2), PASS, alice, { app: "copilot-swe-agent" })) });

  const early: Setup = (g, i) => {
    g.setTime("2026-10-21T00:30:00Z");
    ids.ea = g.label(i(1), PASS, alice);
  };
  f = await probe(early);
  defs.push({ fixture: { name: "synthetic verdict before seed", case: "verdict-before-seed", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.ea!) } }, integrity: "PASS", seedPublishedAt: "2026-10-22T00:00:00Z" } }, setup: early });

  const paged: Setup = (g, i) => {
    ids.pg = g.label(i(1), PASS, alice);
    g.unlabel(i(1), PASS, alice);
    g.toggle(i(1), PASS, alice, 60);
    g.label(i(1), PASS, alice);
  };
  f = await probe(paged);
  defs.push({ fixture: { name: "synthetic 123 label events on one issue", case: "pagination", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.pg!) } }, integrity: "WARN", minHistory: 123 } }, setup: paged });

  const cp: Setup = (g, i) => {
    ids.c1 = g.label(i(1), PASS, alice);
    ids.c2 = g.label(i(2), FAIL, bob);
  };
  f = await probe(cp);
  defs.push({ fixture: { name: "synthetic checkpoint round trip", case: "checkpoint-round-trip", erasedEventId: String(ids.c2), expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.c1!) }, 2: { verdict: "fail", reviewer: "bob", recordedAt: at(f, ids.c2!) } }, integrity: "PASS" } }, setup: cp, erase: (g) => g.eraseEvent(ids.c2!) });

  // idempotent-publish keeps one tracker and one window directory across its three runs.
  const pubFake = new FakeGitHubIssues();
  const pubDir = tmp();
  const fixtures: LedgerFixture[] = [
    ...defs.map((d) => ({ draws: DRAWS, ...d.fixture, source: "synthetic" as const, http: true })),
    { name: "synthetic idempotent publish", case: "idempotent-publish", source: "synthetic", http: true, draws: [...DRAWS, draw(4, 102, false)], publish: PUB, forgetLocalState: () => rmSync(join(pubDir, "ledger-index.json")), expect: { counted: {}, integrity: "PASS" } },
  ];
  const byName = new Map(defs.map((d) => [d.fixture.name, d]));
  const factory = async (fx: LedgerFixture, h: LedgerHarness) => {
    if (fx.case === "idempotent-publish") return githubIssues.create({ repo: "acme/audit" }, h.context({ fetch: pubFake.fetch, windowDir: pubDir, env: { GITHUB_TOKEN: "t" } }));
    const d = byName.get(fx.name)!;
    const s = await scenario(d.setup);
    if (h.phase === "after-erasure") d.erase?.(s.fake);
    return githubIssues.create(s.options, h.context({ fetch: s.fake.fetch, windowDir: s.windowDir, env: { GITHUB_TOKEN: "t" } }));
  };
  return { fixtures, factory };
}

describe("github-issues on a synthetic GitHub: the ledger kit", () => {
  it("passes every case of the kit (first label, relabels, removal, deletion, renames, ineligible actors, seed time, pagination, idempotent publish, checkpoint round trip, transient faults)", async () => {
    const { fixtures, factory } = await cases();
    const report = await runLedgerConformance(factory, fixtures);
    expect(report.ok, formatLedgerConformanceReport(report)).toBe(true);
    const checks = new Set(report.results.filter((r) => !r.skipped).map((r) => r.check));
    for (const c of ["first-label", "relabel-same", "relabel-opposite", "removal", "deletion", "label-rename", "unlisted-reviewer", "app-applied", "verdict-before-seed", "pagination", "idempotent-publish", "checkpoint-round-trip", "transient-faults"]) expect(checks).toContain(c);
  });
});

describe("github-issues publishDraws (FR4.1)", () => {
  it("opens one issue per drawn change in draw order, creates the labels, and records the index; a repeat draw reuses its change's issue", async () => {
    const fake = new FakeGitHubIssues();
    const dir = tmp();
    const l = await githubIssues.create({ repo: "acme/audit" }, { cwd: dir, windowDir: dir, env: { GITHUB_TOKEN: "t" }, log: () => {}, fetch: fake.fetch });
    await l.publishDraws!([draw(3, 103), draw(1, 101), draw(2, 102), draw(4, 101, false)], PUB);
    const creates = fake.writes().filter((r) => r.url.endsWith("/repos/acme/audit/issues"));
    expect(creates.map((r) => (r.body as { title: string }).title)).toEqual(["pr-rla draw #1: json:acme/widgets#101", "pr-rla draw #2: json:acme/widgets#102", "pr-rla draw #3: json:acme/widgets#103"]);
    expect(fake.writes().filter((r) => r.url.endsWith("/labels")).map((r) => (r.body as { name: string }).name)).toEqual([PASS, FAIL, "pr-rla:draw"]);
    const body = (creates[0]!.body as { body: string }).body;
    expect(body).toContain(`Review protocol SHA-256: \`${"ab".repeat(32)}\``);
    expect(body).toContain("<!-- pr-rla:draw window=2026-q3 draw=1 change=json:acme/widgets#101 -->");
    const index = JSON.parse(readFileSync(join(dir, "ledger-index.json"), "utf8"));
    expect(index).toMatchObject({ schema: "pr-rla/ledger-index/v1", ledger: "github-issues", tracker: "https://api.github.com/repos/acme/audit", window: "2026-q3", protocolSha256: "ab".repeat(32), registrationSha256: "cd".repeat(32), repeats: [{ draw: 4, changeId: "json:acme/widgets#101", sameAs: 1 }] });
    expect(index.issues.map((i: { draw: number; number: number }) => [i.draw, i.number])).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(Object.values(index.labels).every((x) => typeof (x as { id: unknown }).id === "string")).toBe(true);
    // A verdict on the repeat draw lands on its change's first issue.
    await l.appendVerdict({ draw: 4, changeId: "json:acme/widgets#101", verdict: "fail", protocolSha256: PUB.protocolSha256, reviewer: "x", recordedAt: "2026-10-21T03:00:00Z", note: "breaks the parser" });
    expect(fake.writes().slice(-2).map((r) => r.url)).toEqual(["https://api.github.com/repos/acme/audit/issues/1/labels", "https://api.github.com/repos/acme/audit/issues/1/comments"]);
    const v = await l.readVerdicts();
    expect(v).toEqual([expect.objectContaining({ draw: 1, verdict: "fail", reviewer: "reviewer-a", provenance: expect.objectContaining({ level: "account", source: "scm-label-event", actorId: "501", viaApp: null }) })]);
  });

  it("after a lost response (the issue was created, the 502 hid it) it finds the issue by its marker instead of opening a second", async () => {
    const fake = new FakeGitHubIssues();
    const dir = tmp();
    const ctx = { cwd: dir, windowDir: dir, env: { GITHUB_TOKEN: "t" }, log: () => {}, fetch: fake.fetch };
    fake.loseNextCreate = 502;
    // The broker never retries a write after a 5xx; the ledger looks for the marker, finds the issue, and goes on.
    await (await githubIssues.create({ repo: "acme/audit" }, ctx)).publishDraws!(DRAWS, PUB);
    expect(fake.issues.size).toBe(3);
    expect(JSON.parse(readFileSync(join(dir, "ledger-index.json"), "utf8")).issues).toHaveLength(3);
    // A crash before the index was written: the next run rebuilds it from the markers and writes nothing.
    rmSync(join(dir, "ledger-index.json"));
    const before = fake.writes().length;
    await (await githubIssues.create({ repo: "acme/audit" }, ctx)).publishDraws!(DRAWS, PUB);
    expect(fake.writes().length - before).toBe(0);
    expect(fake.issues.size).toBe(3);
  });
});

describe("github-issues on GitHub Enterprise Server (FR4.8) and through the broker", () => {
  const GHES = "https://ghe.example.com/api/v3";

  it("publishes and reads verdicts at the GHES base URL, inherits base_url from a github provider, writes only under its writePaths, and gets GitHub's budget for the GHES host", async () => {
    const { parseConfig } = await import("../src/config.js");
    const cfg = parseConfig("provider: { use: github, options: { base_url: https://ghe.example.com } }\nrepo: corp/app\nwindow: { name: w, start: 2026-07-01, end: 2026-09-30 }\nledger: { use: github-issues, options: { repo: corp/audit } }\n", "/x/.pr-rla.yml");
    expect(cfg.ledger.options).toEqual({ repo: "corp/audit", base_url: "https://ghe.example.com" });
    expect(githubIssues.hosts!(cfg.ledger.options as never)).toEqual(["ghe.example.com"]);
    expect(githubIssues.writePaths!(cfg.ledger.options as never)).toEqual(["ghe.example.com/api/v3/repos/corp/audit/"]);

    const fake = new FakeGitHubIssues(GHES, "corp/audit");
    const dir = tmp();
    const actx = createAuditContext({ mode: "read-write", fetch: fake.fetch, env: { GH_ENTERPRISE_TOKEN: "ghe-token" } });
    const l = await openLedger(actx, cfg.ledger, dir, dir);
    await l.publishDraws!(DRAWS, PUB);
    expect(fake.writes().every((r) => r.url.startsWith(`${GHES}/repos/corp/audit/`))).toBe(true);
    fake.label(fake.issueByDraw(2).number, PASS, alice);
    expect((await l.readVerdicts()).map((v) => [v.draw, v.verdict, v.reviewer])).toEqual([[2, "pass", "alice"]]);
    expect(actx.broker.policy.budgets.get("ghe.example.com")?.service).toBe("GitHub");
    // The broker refuses a ledger write outside the audit repo, before it is sent.
    const n = fake.requests.length;
    await expect(actx.broker.bind("ledger:github-issues")(`${GHES}/repos/corp/app/issues`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(WritePathNotAllowed);
    expect(fake.requests.length).toBe(n);
  });

  it("in read-only mode reads verdicts and refuses to publish or record", async () => {
    const { fake, windowDir, options } = await scenario((g, i) => g.label(i(1), FAIL, alice));
    const ro = createAuditContext({ mode: "read-only", fetch: fake.fetch, env: { GITHUB_TOKEN: "t" } });
    const l = await openLedger(ro, { use: "github-issues", options }, windowDir, windowDir);
    expect((await l.readVerdicts()).map((v) => v.verdict)).toEqual(["fail"]);
    expect(typeof l.readHistory).toBe("function");
    await expect(l.publishDraws!(DRAWS, PUB)).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    await expect(l.appendVerdict({ draw: 1, changeId: DRAWS[0]!.changeId, verdict: "pass", protocolSha256: PUB.protocolSha256, reviewer: "x", recordedAt: "2026-10-21T03:00:00Z" })).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    expect(existsSync(join(windowDir, "ledger-index.json"))).toBe(true);
  });

  it("refuses a placeholder or malformed audit repo by name", async () => {
    expect(() => githubIssues.hosts!({ repo: "<owner>/<audit-repo>" })).toThrow(/options\.repo must be the audit repo as "owner\/name" \(replace the placeholder\)/);
    expect(() => githubIssues.writePaths!({} as never)).toThrow(/options\.repo/);
  });
});
