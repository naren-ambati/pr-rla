import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditContext, openLedger } from "../src/api/context.js";
import gitlabIssues from "../src/ledgers/gitlab-issues/index.js";
import { approvalsFile, approveBuiltin } from "../src/plugins/approvals.js";
import type { DrawForLedger, Ledger } from "../src/sdk/ledger.js";
import { formatLedgerConformanceReport, runLedgerConformance, type LedgerFixture, type LedgerHarness } from "../src/testing/index.js";
import { FakeGitLabIssues } from "./helpers/fake-issue-trackers.js";
import { PUB, draw } from "./helpers/ledger-draws.js";

/**
 * gitlab-issues on a synthetic self-managed GitLab (FR4.1–FR4.3, FR4.8). Every fixture is
 * `source: "synthetic"`: GitLab serves resource_label_events only to a token, even on public
 * projects (HTTP 401 anonymously, checked 2026-11-03), so no public timeline could be recorded.
 * The scoped-label swap's shape is taken from GitLab's own rendering of a recorded public issue
 * (test/fixtures/ledgers/gitlab/scoped-swap-gitlab-org-gitlab-633165.json, `recorded`).
 */
const BASE = "https://gitlab.example.com";
const DRAWS = [draw(1, 101), draw(2, 102), draw(3, 103)];
const alice = { id: 21, username: "alice" };
const bob = { id: 22, username: "bob" };
const tokenBot = { id: 99, username: "project_123_bot_0a1b" };
const PASS = "pr-rla-pass";
const FAIL = "pr-rla-fail";
const tmp = () => mkdtempSync(join(tmpdir(), "prrla-gli-"));
const OPTIONS = { project: "acme/audit", base_url: BASE };

async function scenario(setup: (fake: FakeGitLabIssues, iid: (d: number) => number) => void, labels?: { pass: string; fail: string }) {
  const fake = new FakeGitLabIssues(BASE, "acme/audit");
  const windowDir = tmp();
  const options = { ...OPTIONS, ...(labels ? { labels } : {}) };
  const l = await gitlabIssues.create(options, { cwd: windowDir, windowDir, env: { GITLAB_TOKEN: "t" }, log: () => {}, fetch: fake.fetch });
  await l.publishDraws!(DRAWS, PUB);
  setup(fake, (d) => fake.issueByDraw(d).iid);
  return { fake, windowDir, options };
}
const at = (fake: FakeGitLabIssues, id: number) => [...fake.issues.values()].flatMap((i) => i.events).find((e) => e.id === id)!.created_at;
type Setup = Parameters<typeof scenario>[0];

async function cases() {
  const ids: Record<string, number> = {};
  const defs: { fixture: Omit<LedgerFixture, "source" | "draws" | "http">; setup: Setup; labels?: { pass: string; fail: string }; erase?: (g: FakeGitLabIssues) => void }[] = [];
  const probe = async (setup: Setup, labels?: { pass: string; fail: string }) => (await scenario(setup, labels)).fake;

  const first: Setup = (g, i) => {
    ids.a = g.label(i(1), PASS, alice)[0]!;
    ids.b = g.label(i(2), FAIL, bob)[0]!;
  };
  let f = await probe(first);
  defs.push({ fixture: { name: "synthetic gitlab first-label", case: "first-label", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.a!).replace(".000Z", "Z") }, 2: { verdict: "fail", reviewer: "bob", recordedAt: at(f, ids.b!).replace(".000Z", "Z") }, 3: null }, integrity: "PASS" } }, setup: first });

  const same: Setup = (g, i) => {
    ids.s = g.label(i(1), PASS, alice)[0]!;
    g.unlabel(i(1), PASS, alice);
    g.label(i(1), PASS, alice);
  };
  f = await probe(same);
  defs.push({ fixture: { name: "synthetic gitlab relabel-same", case: "relabel-same", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.s!).replace(".000Z", "Z") } }, integrity: "WARN" } }, setup: same });

  // Scoped labels: applying pr-rla::fail removes pr-rla::pass at the same instant (one remove, one add).
  const SCOPED = { pass: "pr-rla::pass", fail: "pr-rla::fail" };
  const swap: Setup = (g, i) => {
    ids.sw = g.label(i(1), SCOPED.pass, alice)[0]!;
    g.label(i(1), SCOPED.fail, bob);
  };
  f = await probe(swap, SCOPED);
  defs.push({ labels: SCOPED, fixture: { name: "synthetic gitlab scoped-label swap", case: "relabel-opposite", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.sw!).replace(".000Z", "Z") } }, integrity: "WARN", messages: [/draw #1: relabel pass→fail; the first verdict \(pass/] } }, setup: swap });

  const removal: Setup = (g, i) => {
    ids.r = g.label(i(1), FAIL, alice)[0]!;
    g.unlabel(i(1), FAIL, tokenBot);
  };
  f = await probe(removal);
  defs.push({ fixture: { name: "synthetic gitlab removal after counting", case: "removal", expect: { counted: { 1: { verdict: "fail", reviewer: "alice", recordedAt: at(f, ids.r!).replace(".000Z", "Z") } }, integrity: "FAIL" } }, setup: removal });

  defs.push({ fixture: { name: "synthetic gitlab deleted and moved issues", case: "deletion", expect: { counted: { 1: null, 2: null }, integrity: "FAIL", messages: [/draw #1 issue .* deleted \(HTTP 404\)/, /draw #2 issue .* moved \(moved to issue id 4999999\)/] } }, setup: (g, i) => (g.label(i(1), PASS, alice), g.deleteIssue(i(1)), g.moveIssue(i(2))) });

  // GitLab today nulls a deleted label on past events: the verdict is gone from the history.
  defs.push({ fixture: { name: "synthetic gitlab verdict label deleted", case: "label-rename", expect: { counted: { 1: null }, integrity: "FAIL", messages: [/verdict label "pr-rla-pass" no longer exists/, /no longer names its label/] } }, setup: (g, i) => (g.label(i(1), PASS, alice), g.deleteLabel(PASS)) });
  // A rename keeps the id: the verdict still counts (events follow the id), and verify reports the rename.
  const rename: Setup = (g, i) => {
    ids.rn = g.label(i(1), PASS, alice)[0]!;
    g.renameLabel(PASS, "verdict-pass");
  };
  f = await probe(rename);
  defs.push({ fixture: { name: "synthetic gitlab verdict label renamed", case: "label-rename", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.rn!).replace(".000Z", "Z") } }, integrity: "FAIL" } }, setup: rename });

  const unlisted: Setup = (g, i) => {
    g.label(i(1), PASS, { id: 77, username: "intruder" });
    ids.u = g.label(i(1), FAIL, alice)[0]!;
  };
  f = await probe(unlisted);
  defs.push({ fixture: { name: "synthetic gitlab unlisted reviewer", case: "unlisted-reviewer", reviewers: ["id:21"], expect: { counted: { 1: { verdict: "fail", reviewer: "alice", recordedAt: at(f, ids.u!).replace(".000Z", "Z") } }, integrity: "PASS" } }, setup: unlisted });

  defs.push({ fixture: { name: "synthetic gitlab access-token bot", case: "app-applied", expect: { counted: { 1: null }, integrity: "PASS", messages: [/applied by bot account project_123_bot_0a1b\[bot\]/] } }, setup: (g, i) => void g.label(i(1), PASS, tokenBot) });

  const paged: Setup = (g, i) => {
    ids.p = g.label(i(1), PASS, alice)[0]!;
    for (let k = 0; k < 60; k++) {
      g.unlabel(i(1), PASS, alice);
      g.label(i(1), PASS, alice);
    }
  };
  f = await probe(paged);
  defs.push({ fixture: { name: "synthetic gitlab 121 label events", case: "pagination", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.p!).replace(".000Z", "Z") } }, integrity: "WARN", minHistory: 121 } }, setup: paged });

  const cp: Setup = (g, i) => {
    ids.c = g.label(i(1), PASS, alice)[0]!;
  };
  f = await probe(cp);
  defs.push({ fixture: { name: "synthetic gitlab checkpoint round trip", case: "checkpoint-round-trip", erasedEventId: String(ids.c), expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.c!).replace(".000Z", "Z") } }, integrity: "PASS" } }, setup: cp, erase: (g) => g.eraseEvent(ids.c!) });

  const early: Setup = (g, i) => {
    g.setTime("2026-10-21T00:30:00Z");
    ids.ea = g.label(i(1), PASS, alice)[0]!;
  };
  f = await probe(early);
  defs.push({ fixture: { name: "synthetic gitlab verdict before seed", case: "verdict-before-seed", expect: { counted: { 1: { verdict: "pass", reviewer: "alice", recordedAt: at(f, ids.ea!).replace(".000Z", "Z") } }, integrity: "PASS", seedPublishedAt: "2026-10-22T00:00:00Z" } }, setup: early });

  const pubFake = new FakeGitLabIssues(BASE, "acme/audit");
  const pubDir = tmp();
  // The write-fault phases get a tracker of their own: "publish-faults" starts fresh, "publish-recover" continues where it left off.
  const wfFake = new FakeGitLabIssues(BASE, "acme/audit");
  const wfDir = tmp();
  const fixtures: LedgerFixture[] = [
    ...defs.map((d) => ({ draws: DRAWS, ...d.fixture, source: "synthetic" as const, http: true })),
    { name: "synthetic gitlab idempotent publish", case: "idempotent-publish", source: "synthetic", http: true, draws: DRAWS, publish: PUB, forgetLocalState: () => rmSync(join(pubDir, "ledger-index.json")), expect: { counted: {}, integrity: "PASS" } },
  ];
  const byName = new Map(defs.map((d) => [d.fixture.name, d]));
  const factory = async (fx: LedgerFixture, h: LedgerHarness): Promise<Ledger> => {
    if (fx.case === "idempotent-publish") {
      const faulty = h.phase === "publish-faults" || h.phase === "publish-recover";
      return gitlabIssues.create(OPTIONS, h.context({ fetch: (faulty ? wfFake : pubFake).fetch, windowDir: faulty ? wfDir : pubDir, env: { GITLAB_TOKEN: "t" } }));
    }
    const d = byName.get(fx.name)!;
    const s = await scenario(d.setup, d.labels);
    if (h.phase === "after-erasure") d.erase?.(s.fake);
    return gitlabIssues.create(s.options, h.context({ fetch: s.fake.fetch, windowDir: s.windowDir, env: { GITLAB_TOKEN: "t" } }));
  };
  return { fixtures, factory };
}

describe("gitlab-issues on a synthetic self-managed GitLab: the ledger kit", () => {
  it("passes every case, including a scoped-label swap and a deleted label nulled on past events", async () => {
    const { fixtures, factory } = await cases();
    const report = await runLedgerConformance(factory, fixtures);
    expect(report.ok, formatLedgerConformanceReport(report)).toBe(true);
    expect(report.results.filter((r) => r.skipped)).toEqual([]);
    expect(report.results.filter((r) => r.check === "transient-write-faults").map((r) => r.ok)).toEqual([true]);
  });
});

describe("gitlab-issues details", () => {
  it("publishes at the self-managed base URL, inherits base_url from a gitlab provider, and writes only under the project", async () => {
    const { parseConfig } = await import("../src/config.js");
    const cfg = parseConfig(`provider: { use: gitlab, options: { base_url: ${BASE} } }\nrepo: corp/app\nwindow: { name: w, start: 2026-07-01, end: 2026-09-30 }\nledger: { use: gitlab-issues, options: { project: acme/audit } }\n`, "/x/.pr-rla.yml");
    expect(cfg.ledger.options).toEqual({ project: "acme/audit", base_url: BASE });
    expect(gitlabIssues.writePaths!(cfg.ledger.options as never)).toEqual(["gitlab.example.com/api/v4/projects/acme%2Faudit/"]);
    const fake = new FakeGitLabIssues(BASE, "acme/audit");
    const dir = tmp();
    // A token for a self-managed instance is not a default grant: approved here, as `pr-rla plugin approve gitlab-issues` would.
    approveBuiltin(approvalsFile(), "GITLAB_TOKEN", BASE, "2026-11-04T00:00:00Z");
    const actx = createAuditContext({ mode: "read-write", fetch: fake.fetch, env: { GITLAB_TOKEN: "t" } });
    const l = await openLedger(actx, cfg.ledger, dir, dir);
    await l.publishDraws!(DRAWS, PUB);
    expect(fake.writes().map((r) => r.method + " " + r.url.replace(fake.projectUrl, ""))).toEqual(["POST /labels", "POST /labels", "POST /labels", "POST /issues", "POST /issues", "POST /issues"]);
    expect(fake.writes().filter((r) => r.url.endsWith("/issues")).map((r) => (r.body as { title: string }).title)).toEqual(DRAWS.map((d) => `pr-rla draw #${d.draw}: ${d.changeId}`));
    expect(actx.broker.policy.budgets.get("gitlab.example.com")?.rules.map((r) => r.id)).toEqual(["api", "api_anonymous", "issue_create", "note_create"]);
    await l.appendVerdict({ draw: 2, changeId: DRAWS[1]!.changeId, verdict: "pass", protocolSha256: PUB.protocolSha256, reviewer: "x", recordedAt: "2026-10-21T03:00:00Z" });
    expect(fake.writes().at(-1)).toMatchObject({ method: "PUT", body: { add_labels: PASS } });
    expect((await l.readVerdicts()).map((v) => [v.draw, v.verdict, v.reviewer, v.provenance?.actorId])).toEqual([[2, "pass", "reviewer-a", "801"]]);
    const index = JSON.parse(readFileSync(join(dir, "ledger-index.json"), "utf8"));
    expect(index.tracker).toBe("https://gitlab.example.com/api/v4/projects/acme%2Faudit");
  });

  it("an older instance whose issue carries a verdict label with no label event: WARN, and the verdict does not count", async () => {
    const { fake, windowDir, options } = await scenario((g, i) => g.labelWithoutEvent(i(1), PASS));
    const l = await gitlabIssues.create(options, { cwd: windowDir, windowDir, env: {}, log: () => {}, fetch: fake.fetch });
    expect(await l.readVerdicts()).toEqual([]);
    const integ = await l.verifyIntegrity!();
    expect(integ.ok).toBe(true);
    expect(integ.warnings).toEqual([expect.stringMatching(/draw #1: the issue carries pr-rla-pass but its label history has no event adding it \(label history incomplete\)/)]);
  });

  it("a scoped swap reads as a remove and an add at one instant, as GitLab's recorded note shows it", async () => {
    const rec = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/ledgers/gitlab/scoped-swap-gitlab-org-gitlab-633165.json"), "utf8"));
    expect(rec.source).toBe("recorded");
    const note = rec.notes.find((n: { note: string }) => /added .* label and removed .* label/.test(n.note));
    expect(note).toMatchObject({ system: true, author: "ifrenkel", created_at: "2026-10-09T17:42:45.113Z", labels: { added: ["workflow::in dev"], removed: ["workflow::refinement"] } });
    const fake = new FakeGitLabIssues(BASE, "acme/audit");
    const dir = tmp();
    const l = await gitlabIssues.create({ ...OPTIONS, labels: { pass: "workflow::refinement", fail: "workflow::in dev" } }, { cwd: dir, windowDir: dir, env: {}, log: () => {}, fetch: fake.fetch });
    await l.publishDraws!([DRAWS[0]!], PUB);
    fake.setTime("2026-10-09T09:00:00Z");
    fake.label(1, "workflow::refinement", alice);
    const swapIds = fake.label(1, "workflow::in dev", { id: 1, username: "ifrenkel" }, "2026-10-09T17:42:45Z");
    const evs = fake.issues.get(1)!.events.filter((e) => swapIds.includes(e.id));
    expect(evs.map((e) => [e.action, e.label?.name, e.user?.username, e.created_at])).toEqual([
      ["remove", "workflow::refinement", "ifrenkel", "2026-10-09T17:42:45.000Z"],
      ["add", "workflow::in dev", "ifrenkel", "2026-10-09T17:42:45.000Z"],
    ]);
    expect((await l.verifyIntegrity!()).warnings).toEqual([expect.stringMatching(/relabel pass→fail; the first verdict/)]);
  });
});
