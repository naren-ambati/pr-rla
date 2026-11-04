import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import type { DrawsFile } from "../src/core/records.js";
import { approveBuiltin } from "../src/plugins/approvals.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { classificationScenario, fakeGitHub } from "./helpers/fake-github.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * Time round B, the CI round's finding (synthetic: a fake GitHub Enterprise Server tracker, mock authorities, the
 * recorded beacon). In CI on a self-hosted tracker with no local approval, the verifier's GITHUB_TOKEN is withheld (the
 * local-consent model), the ledger reads anonymously, and the private tracker answers 404. Before, `status` printed
 * `NOT CERTIFIED` with exit 0 (the only sign one stderr line). Now a read the audit needs, refused to a plugin running
 * without its credential (withheld or not set), is INCOMPLETE (exit 6) in status and in verify's check 7, and the reason
 * names the credential and the command that approves it.
 */
const W = "audit/2026-q3";
const GHE = "https://ghe.example.com";
const APPROVE = `pr-rla plugin approve --env GITHUB_TOKEN --origin ${GHE}`;
const alice = { login: "alice", id: 11, type: "User" as const };
let tsa: MockTsaServer;
let tracker: FakeGitHubIssues;
let audit: Scenario;
const approvals = (approved: boolean) => {
  const file = join(mkdtempSync(join(tmpdir(), "prrla-access-approvals-")), "approvals.json");
  if (approved) approveBuiltin(file, "GITHUB_TOKEN", GHE, "2026-10-20T00:00:00Z");
  return file;
};
/** The tracker is private: an anonymous request gets GitHub's 404, as for a private repository. */
const privateTracker = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(`${GHE}/`)) return globalThis.fetch(input, init);
  if (!new Headers(init?.headers).has("authorization")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  return tracker.fetch(input, init);
}) as typeof fetch;
/** What a command printed on stdout (the scenario's context also collects stderr, as "ERR …" lines). */
const stdout = (s: Scenario) => s.out.filter((l) => !l.startsWith("ERR "));
/** A clone of the audit as a verifier runs it, with this environment. */
const as = (env: Record<string, string>) => {
  const s = cloneScenario(audit);
  s.ctx.env = env;
  return s;
};

beforeAll(async () => {
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  tracker = new FakeGitHubIssues(`${GHE}/api/v3`, "acme/audit");
  audit = setupAuditRepo({ changes: makeChanges(400), fetch: privateTracker, tsa: { ids: ["test-a", "test-b"], server: tsa } });
  audit.ctx.env = { GITHUB_TOKEN: "auditee-token", PR_RLA_APPROVALS_FILE: approvals(true) };
  appendFileSync(join(audit.dir, ".pr-rla.yml"), `ledger: { use: github-issues, options: { repo: acme/audit, base_url: ${GHE} } }\n`);
  audit.git("commit", "-qam", "ledger: github-issues on GHES");
  const at = (iso: string) => ((audit.clock.now = T(iso)), (tsa.nowMs = T(iso)));
  at("2026-10-20T00:00:00Z");
  expect(await registerCommand(audit.ctx, {})).toBe(0);
  at("2026-10-20T12:00:00Z");
  expect(await freezeCommand(audit.ctx, {})).toBe(0);
  at("2026-10-21T01:00:00Z");
  expect(await sampleCommand(audit.ctx, {})).toBe(0);
  tracker.setTime("2026-10-21T02:00:00Z");
  const draws = JSON.parse(readFileSync(join(audit.dir, W, "draws.json"), "utf8")) as DrawsFile;
  for (const d of draws.draws.slice(0, 36)) if (d.firstOccurrence) tracker.label(tracker.issueByDraw(d.draw).number, "pr-rla:pass", alice);
  at("2026-10-21T03:00:00Z");
  audit.git("add", "-A");
  audit.git("commit", "-qm", "draws and ledger index");
}, 180_000);
afterAll(async () => tsa.stop());

describe("control: the verifier approved GITHUB_TOKEN for the tracker's origin", () => {
  it("status certifies (exit 0) and verify is VERIFIED (exit 0)", async () => {
    const s = as({ GITHUB_TOKEN: "verifier-token", PR_RLA_APPROVALS_FILE: approvals(true) });
    expect(await statusCommand(s.ctx, {})).toBe(0);
    expect(s.out[0]).toMatch(/· CERTIFIED \(risk 5%\) · RETROSPECTIVE$/);
    const r = await runVerify(s.ctx, {});
    expect(r).toMatchObject({ verdict: "VERIFIED", exitCode: 0, certificate: { state: "CERTIFIED" } });
  });
});

describe("the credential withheld (set, not approved for the self-hosted origin): the private tracker's 404s are INCOMPLETE, exit 6", () => {
  const env = () => ({ GITHUB_TOKEN: "verifier-token", PR_RLA_APPROVALS_FILE: approvals(false) });

  it("status (text): INCOMPLETE, exit 6, naming GITHUB_TOKEN and the approve command (was NOT CERTIFIED 0/36, exit 0)", async () => {
    const s = as(env());
    expect(await statusCommand(s.ctx, {})).toBe(6);
    const out = stdout(s);
    expect(out[0]).toMatch(/^prefix 0\/36 · .* · INCOMPLETE: not established \(ledger github-issues read \d+ time\(s\) without a credential and was answered HTTP 404 \(e\.g\. GET ghe\.example\.com\/api\/v3\/repos\/acme\/audit/);
    expect(out[0]).toContain(`GITHUB_TOKEN is withheld (not approved for ${GHE} on this machine); approve it: ${APPROVE}`);
    expect(out.join("\n")).not.toMatch(/NOT CERTIFIED|CERTIFIED \(risk/);
    expect(out).toContain(`  not established (INCOMPLETE): ${(out[0]!.match(/not established \((ledger github-issues read .*)\) · RETROSPECTIVE$/) ?? [])[1]}`);
  });

  it("status --json: exit 6, certificate INCOMPLETE with the reason", async () => {
    const s = as(env());
    expect(await statusCommand(s.ctx, { json: true })).toBe(6);
    const r = JSON.parse(stdout(s).join("\n")) as { certificate: { state: string; withheld: { verdict: string; reason: string }[] } };
    expect(r.certificate.state).toBe("INCOMPLETE");
    expect(r.certificate.withheld[0]!.verdict).toBe("INCOMPLETE");
    expect(r.certificate.withheld[0]!.reason).toContain(APPROVE);
  });

  it("verify (text and --json): check 7 INCOMPLETE with the same reason, verdict INCOMPLETE, exit 6, never VERIFIED", async () => {
    const s = as(env());
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, {})).toBe(6);
    const text = stdout(s).join("\n");
    expect(text).toMatch(/^7\. INCOMPLETE labels: not established: read without its credential \(its FAIL findings below may be the refused reads\)$/m);
    expect(text).toContain(`INCOMPLETE ledger github-issues read`);
    expect(text).toContain(APPROVE);
    expect(stdout(s).at(-1)).toMatch(/^INCOMPLETE: check 7 \(labels\) could not be established; .*\(exit 6\)$|^INCOMPLETE: check 7 \(labels\) could not be established; nothing failed, but this is not a verification \(exit 6\)$/);
    expect(text).not.toMatch(/^VERIFIED$/m);
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, { json: true })).toBe(6);
    const j = JSON.parse(stdout(s).join("\n")) as { verdict: string; ok: boolean; exitCode: number; checks: { n: number; status: string; details: string[] }[] };
    expect(j).toMatchObject({ verdict: "INCOMPLETE", ok: false, exitCode: 6 });
    expect(j.checks.find((c) => c.n === 7)!.status).toBe("INCOMPLETE");
    expect(j.checks.find((c) => c.n === 7)!.details[0]).toContain(APPROVE);
  });
});

describe("the credential not set at all: the same, naming the variables", () => {
  it("status and verify: INCOMPLETE, exit 6, '… are not set'", async () => {
    const s = as({ PR_RLA_APPROVALS_FILE: approvals(false) });
    expect(await statusCommand(s.ctx, {})).toBe(6);
    expect(stdout(s)[0]).toMatch(/GITHUB_TOKEN, GH_TOKEN, GH_ENTERPRISE_TOKEN are not set\. A private tracker or repository answers an anonymous read that way/);
    const r = await runVerify(s.ctx, {});
    expect(r).toMatchObject({ verdict: "INCOMPLETE", exitCode: 6 });
    expect(r.checks.find((c) => c.n === 7)!.status).toBe("INCOMPLETE");
  });
});

describe("offline verify with a tracker ledger (the CI round's second case)", () => {
  it("check 7 is skipped (the tracker is not read offline), so INCOMPLETE, exit 6: never VERIFIED with check 7 skipped", async () => {
    const s = as({ GITHUB_TOKEN: "verifier-token", PR_RLA_APPROVALS_FILE: approvals(true) });
    const r = await runVerify(s.ctx, { offline: true });
    expect(r.checks.find((c) => c.n === 7)).toMatchObject({ status: "SKIP", summary: "offline: ledger github-issues lives in ghe.example.com; run verify without --offline to check the verdicts" });
    expect(r).toMatchObject({ verdict: "INCOMPLETE", ok: false, exitCode: 6 });
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, { offline: true })).toBe(6);
    expect(stdout(s).at(-1)).toBe("INCOMPLETE: check 5 (population), check 7 (labels) skipped; nothing failed, but this is not a verification (exit 6)");
  });
});

describe("the provider's reads in check 5: the same rule", () => {
  it("a GitHub Enterprise Server repo, private: the verifier's GH_ENTERPRISE_TOKEN withheld, so check 5 is INCOMPLETE with the approve command, exit 6", async () => {
    const sc = classificationScenario();
    const ghe = fakeGitHub(sc.repo, sc.head, sc.commits, sc.prs, { restBase: `${GHE}/api/v3` });
    const privateScm = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!new Headers(init?.headers).has("authorization")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
      return ghe.fetch(input as never, init as never);
    }) as typeof fetch;
    const s = setupAuditRepo({ changes: [], fetch: privateScm });
    const yml = join(s.dir, ".pr-rla.yml");
    writeFileSync(yml, readFileSync(yml, "utf8").replace("provider: { use: json-file, options: { path: changes.json } }", `provider: { use: github, options: { base_url: ${GHE} } }`).replace("window: { name: 2026-q3, start: 2026-07-01, end: 2026-09-30 }", "window: { name: 2026-08-01, start: 2026-08-01, end: 2026-08-01 }"));
    s.git("commit", "-qam", "a GitHub Enterprise Server audit");
    const file = join(mkdtempSync(join(tmpdir(), "prrla-access-ghe-")), "approvals.json");
    approveBuiltin(file, "GH_ENTERPRISE_TOKEN", GHE, "2026-08-03T00:00:00Z");
    s.ctx.env = { GH_ENTERPRISE_TOKEN: "ghe_AUDITEE", PR_RLA_APPROVALS_FILE: file };
    s.clock.now = T("2026-08-03T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-08-03T06:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const approved = await runVerify(s.ctx, {});
    expect(approved.checks[4]!.status).toBe("PASS");
    const v = cloneScenario(s);
    v.ctx.env = { GH_ENTERPRISE_TOKEN: "ghe_VERIFIER", PR_RLA_APPROVALS_FILE: join(mkdtempSync(join(tmpdir(), "prrla-access-none-")), "approvals.json") };
    const r = await runVerify(v.ctx, {});
    const c5 = r.checks[4]!;
    expect(c5.status).toBe("INCOMPLETE");
    expect(c5.details[0]).toMatch(/^INCOMPLETE provider github read \d+ time\(s\) without a credential and was answered HTTP 404 \(e\.g\. (GET|POST) ghe\.example\.com\/api\//);
    expect(c5.details[0]).toContain(`GH_ENTERPRISE_TOKEN is withheld (not approved for ${GHE} on this machine); approve it: pr-rla plugin approve --env GH_ENTERPRISE_TOKEN --origin ${GHE}`);
    expect(r).toMatchObject({ verdict: "INCOMPLETE", ok: false, exitCode: 6 });
    v.out.length = 0;
    expect(await verifyCommand(v.ctx, { json: true })).toBe(6);
    expect(JSON.parse(stdout(v).join("\n"))).toMatchObject({ verdict: "INCOMPLETE", exitCode: 6 });
  });
});

describe("a public tracker read without a credential: its 404s are the server's answers, and still FAIL", () => {
  it("an issue deleted on a tracker that answers anonymous reads: check 7 FAILs (deleted), not INCOMPLETE", async () => {
    const s = as({ PR_RLA_APPROVALS_FILE: approvals(false) });
    const copy = tracker.clone();
    copy.issues.get(1)!.gone = 404;
    const publicTracker = (async (input: string | URL | Request, init?: RequestInit) => copy.fetch(input, init)) as typeof fetch;
    const r = await runVerify({ ...s.ctx, fetch: publicTracker }, {});
    const c7 = r.checks.find((c) => c.n === 7)!;
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join("\n")).toMatch(/draw #1 issue .* deleted \(HTTP 404\); its history is gone/);
    expect(c7.details.join("\n")).not.toMatch(/without a credential/);
    expect(r.verdict).toBe("FAILED");
  });
});
