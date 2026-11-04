import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import githubIssues from "../src/ledgers/github-issues/index.js";
import { formatLedgerConformanceReport, runLedgerConformance, type LedgerCase, type LedgerFixture } from "../src/testing/index.js";
import { replayFetch, type Recording } from "./helpers/replay-fetch.js";

/**
 * github-issues on recorded public timelines (FR4.7: every fixture here is `source: "recorded"`,
 * read-only, 2026-11-03, re-recorded 2026-11-04 after the repo probe was added, by scripts/record-ledger-fixtures.mjs). The timelines are mapped to
 * verdict labels through the ledger's `labels` option, so a real reviewer's remove-and-re-add,
 * a GitHub App's label, a deleted issue and two label renames each meet the rules.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/ledgers/github");
interface LedgerRecording extends Recording {
  source: "recorded";
  case: LedgerCase;
  options: { repo: string; labels: { pass: string; fail: string } };
  index: { issues: { draw: number; changeId: string }[] };
  observed: { verdicts: { draw: number; verdict: "pass" | "fail"; reviewer: string; recordedAt: string }[]; integrity: { ok: boolean; findings: string[]; warnings: string[] } };
}
const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as LedgerRecording;
const timelines = readdirSync(DIR).filter((f) => !f.startsWith("evidence-"));

/** What each recording must give: the counted verdict per draw, the integrity result, and the finding that explains it. */
const EXPECT: Record<string, Pick<LedgerFixture["expect"], "counted" | "integrity" | "messages">> = {
  "relabel-same-nodejs-node-67038.json": { counted: { 1: { verdict: "pass", reviewer: "RafaelGSS", recordedAt: "2026-11-03T14:06:04Z" } }, integrity: "WARN", messages: [/draw #1: commit-queue-squash removed and added again \(relabel, same verdict\); the first event \(2026-11-03T14:06:04Z\) counts/] },
  "first-label-microsoft-vscode-345779.json": { counted: { 1: { verdict: "pass", reviewer: "ulugbekna", recordedAt: "2026-11-03T10:24:29Z" } }, integrity: "PASS" },
  "app-applied-microsoft-vscode-345652.json": { counted: { 1: null }, integrity: "PASS", messages: [/unreleased applied by bot account vs-code-engineering\[bot\]/] },
  "deleted-microsoft-vscode-345635.json": { counted: { 1: null }, integrity: "FAIL", messages: [/draw #1 issue https:\/\/github\.com\/microsoft\/vscode\/issues\/345635 deleted \(HTTP 404\); its history is gone/] },
  "label-renamed-rust-lang-rust-30010.json": { counted: { 1: { verdict: "pass", reviewer: "steveklabnik", recordedAt: "2015-11-23T20:13:53Z" } }, integrity: "FAIL", messages: [/verdict label "I-enhancement" no longer exists in rust-lang\/rust/] },
  "label-renamed-and-reused-rust-lang-rust-30003.json": { counted: { 1: { verdict: "pass", reviewer: "brson", recordedAt: "2017-05-04T16:51:21Z" } }, integrity: "FAIL", messages: [/verdict label "T-libs" in rust-lang\/rust is not the label the draws were published with \(id 211668062, now 2011781731\)/, /relabel pass→fail/] },
};

describe("github-issues on recorded public timelines", () => {
  it("records exactly the timelines listed, each marked recorded", () => {
    expect(timelines.sort()).toEqual(Object.keys(EXPECT).sort());
    for (const f of timelines) expect(load(f).source).toBe("recorded");
  });

  it("passes the ledger kit on every recording, including the transient-fault re-runs", async () => {
    const recs = new Map(timelines.map((f) => [f, load(f)]));
    const fixtures: LedgerFixture[] = timelines.map((f) => {
      const r = recs.get(f)!;
      return { name: f, case: r.case, source: "recorded", http: true, draws: r.index.issues.map((i) => ({ draw: i.draw, changeId: i.changeId, url: `https://github.com/${r.options.repo}`, mergeSha: "0".repeat(40), firstOccurrence: true })), expect: EXPECT[f]! };
    });
    const report = await runLedgerConformance(async (fx, h) => {
      const r = recs.get(fx.name)!;
      const windowDir = mkdtempSync(join(tmpdir(), "prrla-rec-"));
      writeFileSync(join(windowDir, "ledger-index.json"), JSON.stringify(r.index));
      return githubIssues.create(r.options, h.context({ fetch: replayFetch(r), windowDir }));
    }, fixtures);
    expect(report.ok, formatLedgerConformanceReport(report)).toBe(true);
  });

  it("gives today what the recorder observed live (the recording is the live answer, replayed)", async () => {
    for (const f of timelines) {
      const r = load(f);
      const windowDir = mkdtempSync(join(tmpdir(), "prrla-rec-"));
      writeFileSync(join(windowDir, "ledger-index.json"), JSON.stringify(r.index));
      const l = await githubIssues.create(r.options, { cwd: windowDir, windowDir, env: {}, log: () => {}, fetch: replayFetch(r) });
      expect((await l.readVerdicts()).map((v) => ({ draw: v.draw, verdict: v.verdict, reviewer: v.reviewer, recordedAt: v.recordedAt }))).toEqual(r.observed.verdicts.map((v) => ({ draw: v.draw, verdict: v.verdict, reviewer: v.reviewer, recordedAt: v.recordedAt })));
      const i = await l.verifyIntegrity!();
      expect({ ok: i.ok, findings: i.findings, warnings: i.warnings }).toEqual({ ok: r.observed.integrity.ok, findings: r.observed.integrity.findings, warnings: r.observed.integrity.warnings });
    }
  });
});

describe("the design's unverified items, settled on recorded public data", () => {
  it("GitHub REST keeps a label's name as applied; GraphQL follows the rename (rust-lang/rust #30003, #30010)", () => {
    const ev = load("evidence-label-rename-rust-lang-rust.json");
    expect(ev.source).toBe("recorded");
    const rest = ev.exchanges.filter((e) => e.method === "GET" && /\/events/.test(e.url)).flatMap((e) => (e.response as { event: string; created_at: string; actor: { login: string }; label?: { name: string } }[]).filter((x) => x.event === "labeled"));
    const gql = ev.exchanges.filter((e) => e.method === "POST").flatMap((e) => (e.response as { data: { repository: { issueOrPullRequest: { timelineItems: { nodes: { __typename: string; createdAt: string; actor: { login: string }; label: { name: string; id: string } }[] } } } } }).data.repository.issueOrPullRequest.timelineItems.nodes.filter((n) => n.__typename === "LabeledEvent"));
    const sameEvent = (name: string, at: string) => gql.filter((n) => n.createdAt === at && rest.some((r) => r.created_at === at && r.label?.name === name && r.actor.login === n.actor.login)).map((n) => n.label.name);
    expect(sameEvent("T-libs", "2017-05-04T16:51:21Z")).toEqual(["T-libs-api"]);
    expect(sameEvent("I-enhancement", "2015-11-23T20:13:53Z")).toContain("C-enhancement");
    const label = (name: string) => ev.exchanges.find((e) => e.url.endsWith(`/labels/${name}`))!;
    expect(label("I-enhancement").status).toBe(404);
    expect((label("T-libs").response as { id: number }).id).toBe(2011781731);
    expect((label("T-libs-api").response as { id: number }).id).toBe(211668062);
  });

  it("GitHub leaves performed_via_github_app null on label events, even for GitHub Apps; it fills it on other events (github/gh-aw)", () => {
    const ev = load("evidence-performed-via-app-github-gh-aw.json");
    const events = ev.exchanges.flatMap((e) => e.response as { event: string; actor: { type: string } | null; performed_via_github_app: { slug: string } | null }[]);
    const labelEvents = events.filter((e) => e.event === "labeled" || e.event === "unlabeled");
    expect(labelEvents.length).toBeGreaterThan(20);
    expect(labelEvents.filter((e) => e.actor?.type === "Bot").length).toBeGreaterThan(0);
    expect(labelEvents.every((e) => e.performed_via_github_app === null)).toBe(true);
    const withApp = events.filter((e) => e.performed_via_github_app !== null);
    expect(withApp.length).toBeGreaterThan(0);
    expect(new Set(withApp.map((e) => e.event))).toEqual(new Set(["copilot_work_started", "copilot_work_finished"]));
  });
});
