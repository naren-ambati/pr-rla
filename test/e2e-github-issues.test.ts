import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkpointCommand } from "../src/commands/checkpoint.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify } from "../src/commands/verify.js";
import type { DrawsFile, RegistrationRecordV2, SignedRecord } from "../src/core/records.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * The end-to-end matrix's GitHub CLI cell (test-design.md §3) on synthetic data: json-file
 * population, the github-issues ledger on a fake GitHub (FR4.1: issues opened in draw order),
 * verdicts applied as labels by a reviewer (H, simulated), status, checkpoint (FR4.4) and an
 * online verify 7/7; then tampering an issue-ledger history, and FR3.8's provenance rule.
 */
const W = "audit/2026-q3";
let tsa: MockTsaServer;
let fake: FakeGitHubIssues;
let honest: Scenario;
const alice = { login: "alice", id: 11, type: "User" as const };

function routed(f: () => FakeGitHubIssues): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith("https://api.github.com/") ? f().fetch(input, init) : globalThis.fetch(input, init);
  }) as typeof fetch;
}
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};
/** A token for api.github.com: anonymous reads are paced at 60/h, which 36 issues' timelines exceed (third-party verifiers need any token). */
const withToken = (s: Scenario): Scenario => ((s.ctx.env = { GITHUB_TOKEN: "test-token" }), s);
const clone = (s: Scenario) => withToken(cloneScenario(s));
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const check = (r: Awaited<ReturnType<typeof runVerify>>, n: number) => r.checks.find((c) => c.n === n)!;

beforeAll(async () => {
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  fake = new FakeGitHubIssues();
  let current = fake;
  honest = withToken(setupAuditRepo({ changes: makeChanges(400), fetch: routed(() => current), tsa: { ids: ["test-a", "test-b"], server: tsa } }));
  (honest as Scenario & { use: (f: FakeGitHubIssues) => void }).use = (f) => (current = f);
  appendFileSync(join(honest.dir, ".pr-rla.yml"), "ledger: { use: github-issues, options: { repo: acme/audit } }\n");
  honest.git("commit", "-qam", "ledger: github-issues");
  at(honest, "2026-10-20T00:00:00Z");
  expect(await registerCommand(honest.ctx, {})).toBe(0);
  at(honest, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(honest.ctx, {})).toBe(0);
  at(honest, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(honest.ctx, {})).toBe(0);
  // H: the reviewer reviews each draw and applies the verdict label in GitHub's web UI.
  fake.setTime("2026-10-21T02:00:00Z");
  const draws = readJ<DrawsFile>(honest, `${W}/draws.json`);
  for (const d of draws.draws.slice(0, 36)) if (d.firstOccurrence) fake.label(fake.issueByDraw(d.draw).number, "pr-rla:pass", alice);
  at(honest, "2026-10-21T03:00:00Z");
  honest.git("add", "-A");
  honest.git("commit", "-qm", "draws and ledger index");
}, 120_000);
afterAll(async () => {
  await tsa.stop();
});

describe("end-to-end audit with the github-issues ledger (fake GitHub, mock authorities, recorded beacon)", () => {
  it("register fixes the ledger and account provenance (FR3.8's default with an issue ledger)", () => {
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(honest, `${W}/registration.json`);
    expect(reg.record.plugins.ledger).toMatchObject({ name: "github-issues", source: "builtin", trust: "builtin" });
    expect(reg.record.verdicts).toEqual({ minProvenance: "account", reviewers: null });
    expect(honest.out.join("\n")).toMatch(/ledger github-issues · verdict provenance account/);
  });

  it("sample opens one issue per drawn change, in draw order, under the audit repo only (FR4.1)", () => {
    const draws = readJ<DrawsFile>(honest, `${W}/draws.json`);
    const firsts = draws.draws.slice(0, draws.issued).filter((d) => d.firstOccurrence).map((d) => d.draw);
    const creates = fake.writes().filter((r) => r.url === "https://api.github.com/repos/acme/audit/issues").map((r) => Number(/^pr-rla draw #(\d+):/.exec((r.body as { title: string }).title)![1]));
    expect(creates).toEqual(firsts);
    expect(fake.writes().every((r) => r.url.startsWith("https://api.github.com/repos/acme/audit/"))).toBe(true);
    const index = readJ<{ issues: { draw: number }[]; repeats: { draw: number }[] }>(honest, `${W}/ledger-index.json`);
    expect(index.issues.length + index.repeats.length).toBe(draws.issued);
    expect(honest.out.join("\n")).toMatch(/ledger github-issues: one issue per drawn change/);
  });

  it("status reads the label events: target reached (certificate withheld until verify), account provenance, and asks for a checkpoint", async () => {
    honest.out.length = 0;
    expect(await statusCommand(honest.ctx, {})).toBe(6);
    const out = honest.out.join("\n");
    expect(out).toMatch(/prefix 36\/36 · fails 0 .* target reached · CERTIFICATE WITHHELD \(population not verified: run `pr-rla verify`\)/);
    expect(out).not.toMatch(/CERTIFIED \(risk/);
    expect(out).toMatch(/VERDICT PROVENANCE: account \(\d+\) · registered minimum account/);
    expect(out).toMatch(/target reached: run "pr-rla checkpoint" and commit it to anchor the verdict history/);
  });

  it("checkpoint hashes the history, time-stamps it with both authorities, and appends it; status stops asking", async () => {
    honest.out.length = 0;
    expect(await checkpointCommand(honest.ctx, {})).toBe(0);
    const out = honest.out.join("\n");
    expect(out).toMatch(/checkpoint 2026-10-21T03:00:00Z · ledger github-issues · \d+ event\(s\) · \d+ first verdict\(s\) · eventsSha256 [0-9a-f]{12}…/);
    expect(out).toMatch(/timestamps: 2 of 2 TSAs \(test-a, test-b\) · k = 2 · PROVEN/);
    expect(out).toMatch(/commit it: git add audit\/2026-q3\/ledger-checkpoints\.jsonl audit\/2026-q3\/ledger-history\/20261021T030000Z-[0-9a-f]{12}\.json/);
    const line = JSON.parse(readFileSync(join(honest.dir, W, "ledger-checkpoints.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ schema: "pr-rla/ledger-checkpoint/v1", window: "2026-q3", takenAt: "2026-10-21T03:00:00Z", ledger: { name: "github-issues" } });
    expect(line.timestamps).toHaveLength(2);
    honest.git("add", "-A");
    honest.git("commit", "-qm", "checkpoint");
    honest.out.length = 0;
    await statusCommand(honest.ctx, {});
    expect(honest.out.join("\n")).not.toMatch(/run "pr-rla checkpoint"/);
  });

  it("verify online: 7/7, check 7 reads the tracker and finds the checkpointed history intact", async () => {
    const r = await runVerify(honest.ctx, {});
    expect(r.checks.map((c) => c.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    expect(check(r, 1).details.join("\n")).toMatch(/ledger github-issues · verdict provenance account/);
    const c7 = check(r, 7).details.join("\n");
    expect(c7).toMatch(/VERDICT PROVENANCE: account \(\d+\) \(registered minimum: account\)/);
    expect(c7).toMatch(/checkpoint 2026-10-21T03:00:00Z: \d+ events, all still present/);
    expect(c7).toMatch(/checkpoint 2026-10-21T03:00:00Z timestamps: 2 of 2 TSAs/);
    expect(r.ok).toBe(true);
  });

  it("verify --offline does not read the tracker: check 7 SKIPs and says why", async () => {
    const r = await runVerify(honest.ctx, { offline: true });
    expect(check(r, 7)).toMatchObject({ status: "SKIP", summary: "offline: ledger github-issues lives in api.github.com; run verify without --offline to check the verdicts" });
  });
});

describe("tampering with an issue-ledger history", () => {
  const tampered = (mutate: (f: FakeGitHubIssues) => void) => {
    const s = clone(honest);
    const copy = fake.clone();
    mutate(copy);
    (honest as Scenario & { use: (f: FakeGitHubIssues) => void }).use(copy);
    return s;
  };
  afterAll(() => (honest as Scenario & { use: (f: FakeGitHubIssues) => void }).use(fake));

  it("an admin deletes a counted draw's issue: check 7 FAILs (deleted, and missing against the checkpoint)", async () => {
    const draws = readJ<DrawsFile>(honest, `${W}/draws.json`);
    const s = tampered((f) => f.deleteIssue(f.issueByDraw(draws.draws[0]!.draw).number, 410));
    const r = await runVerify(s.ctx, {});
    const c7 = check(r, 7);
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join("\n")).toMatch(new RegExp(`draw #${draws.draws[0]!.draw} issue https://github.example/acme/audit/issues/\\d+ deleted \\(HTTP 410\\); its history is gone`));
    expect(c7.details.join("\n")).toMatch(/FAIL history rewritten after checkpoint 2026-10-21T03:00:00Z: 1 event\(s\) missing \(\d+\), 0 changed/);
    expect(r.ok).toBe(false);
  });

  it("an admin erases one label event: the checkpoint catches it", async () => {
    const s = tampered((f) => {
      const i = f.issueByDraw(readJ<DrawsFile>(honest, `${W}/draws.json`).draws[0]!.draw);
      f.eraseEvent(i.events.find((e) => e.event === "labeled" && e.label?.name === "pr-rla:pass")!.id);
    });
    const r = await runVerify(s.ctx, {});
    expect(check(r, 7).status).toBe("FAIL");
    expect(check(r, 7).details.join("\n")).toMatch(/FAIL history rewritten after checkpoint 2026-10-21T03:00:00Z: 1 event\(s\) missing \(\d+\), 0 changed/);
    expect(check(r, 7).details.join("\n")).toMatch(/label history incomplete/);
  });

  it("the tracker cannot be read: check 7 FAILs with the error, never passes silently", async () => {
    const s = clone(honest);
    s.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith("https://api.github.com/") ? new Response("down", { status: 502 }) : globalThis.fetch(input, init);
    }) as typeof fetch;
    const r = await runVerify(s.ctx, {});
    expect(check(r, 7).status).toBe("FAIL");
    expect(check(r, 7).details.join("\n")).toMatch(/ledger github-issues: readVerdicts failed: github-issues GET https:\/\/api\.github\.com\/repos\/acme\/audit\/labels\/pr-rla%3Apass: gave up after 7 attempts \(HTTP 502\)/);
  });

  it("the verdict label is removed after it counted: FAIL", async () => {
    const s = tampered((f) => f.unlabel(f.issueByDraw(readJ<DrawsFile>(honest, `${W}/draws.json`).draws[0]!.draw).number, "pr-rla:pass", { login: "mallory", id: 66, type: "User" }));
    const r = await runVerify(s.ctx, {});
    expect(check(r, 7).details.join("\n")).toMatch(/the counted pr-rla:pass verdict was removed at .* and nothing replaced it \(removal after counting\)/);
    expect(r.ok).toBe(false);
  });
});

describe("FR3.8: an issue-ledger audit rejects self-asserted verdicts", () => {
  // P1: before, the ledger was switched to git-file in .pr-rla.yml and `record` wrote self-asserted lines there; now
  // every command runs the registered ledger only. The lines an assistant appends by hand still never count.
  it("with the ledger switched to git-file, record and status refuse, and verify FAILs check 7 without reading the unregistered ledger", async () => {
    const s = clone(honest);
    const cfg = readFileSync(join(s.dir, ".pr-rla.yml"), "utf8").replace("ledger: { use: github-issues, options: { repo: acme/audit } }\n", "ledger: git-file\n");
    writeFileSync(join(s.dir, ".pr-rla.yml"), cfg);
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
    await expect(recordCommand(s.ctx, String(draws.draws[0]!.draw), "pass", { reviewer: "alice" })).rejects.toThrow(/^record refused: the ledger in \.pr-rla\.yml is not the registered one \(name github-issues → git-file; optionsSha256 [0-9a-f]{12}… → [0-9a-f]{12}…\)\. The registration names ledger github-issues \(builtin, trust builtin, options [0-9a-f]{12}…\)/);
    await expect(statusCommand(s.ctx, {})).rejects.toThrow(/^status refused: the ledger in \.pr-rla\.yml is not the registered one/);
    const lines = draws.draws.slice(0, 36).filter((d) => d.firstOccurrence).map((d) => JSON.stringify({ draw: d.draw, changeId: d.changeId, verdict: "pass", protocolSha256: readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`).record.protocolSha256, reviewer: "alice", recordedAt: "2026-10-21T02:30:00Z" }));
    writeFileSync(join(s.dir, W, "verdicts.jsonl"), `${lines.join("\n")}\n`);
    s.git("add", "-A");
    s.git("commit", "-qm", "self-asserted verdicts");
    const r = await runVerify(s.ctx, {});
    expect(check(r, 7).status).toBe("FAIL");
    expect(check(r, 7).details.join("\n")).toMatch(/FAIL the ledger in \.pr-rla\.yml is not the registered one \(name github-issues → git-file; optionsSha256 [0-9a-f]{12}… → [0-9a-f]{12}…\): verify did not read it/);
    // The unregistered ledger is not read at all, so none of its self-asserted lines is counted, or even looked at.
    expect(check(r, 7).details.join("\n")).not.toMatch(/VERDICT PROVENANCE/);
  });

  it("register refuses min_provenance account with a ledger that records only self-asserted verdicts", async () => {
    const s = setupAuditRepo({ changes: makeChanges(160) });
    appendFileSync(join(s.dir, ".pr-rla.yml"), "verdicts: { min_provenance: account }\n");
    await expect(registerCommand(s.ctx, { dryRun: true })).rejects.toThrow(/verdicts\.min_provenance is account, but ledger git-file records self-asserted verdicts, so no verdict could count/);
  });
});

describe("checkpoint shortfall and refusals", () => {
  it("1 of 2 tokens: the line is written, TIMESTAMP NOT TAMPER-PROOF (1 of 2), exit 5; status --checkpoint appends too", async () => {
    const s = clone(honest);
    tsa.behaviour["test-b"] = { status: 2 };
    try {
      s.out.length = 0;
      expect(await checkpointCommand(s.ctx, {})).toBe(5);
      expect(s.out.join("\n")).toMatch(/TIMESTAMP NOT TAMPER-PROOF \(1 of 2\)/);
      expect(s.out.join("\n")).toMatch(/take another checkpoint \(lines are only ever added\): pr-rla checkpoint/);
    } finally {
      delete tsa.behaviour["test-b"];
    }
    at(s, "2026-10-21T04:00:00Z");
    // status's own exit is 6 (the target is reached, the certificate withheld until verify); the checkpoint's is 0.
    expect(await statusCommand(s.ctx, { checkpoint: true })).toBe(6);
    expect(readFileSync(join(s.dir, W, "ledger-checkpoints.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("a ledger without readHistory cannot be checkpointed (exit 1)", async () => {
    const s = setupAuditRepo({ changes: makeChanges(160) });
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    await expect(checkpointCommand(s.ctx, {})).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/ledger git-file has no readHistory, so it cannot be checkpointed/) });
  });
});
