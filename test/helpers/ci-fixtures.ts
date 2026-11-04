import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { freezeCommand } from "../../src/commands/freeze.js";
import { registerCommand } from "../../src/commands/register.js";
import { sampleCommand } from "../../src/commands/sample.js";
import type { DrawsFile } from "../../src/core/records.js";
import { makeChanges, setupAuditRepo, T, type Scenario } from "./audit-scenario.js";
import { FakeGitHubIssues, FakeGitLabIssues } from "./fake-issue-trackers.js";
import { fixturePath } from "./fixtures.js";
import { MockTsaServer, makeTestAuthority } from "./test-tsa.js";
import { unsignedLine } from "./verdict-lines.js";

/**
 * Audit directories for the CI harness (FR6.5; D8). Every one is a local directory built by this
 * file, with no scratch repository and no real tracker.
 *
 * Provenance of the data (README.md in test/fixtures/ci/ says the same):
 *  - github-issues and gitlab-issues audits: synthetic. A 400-change json-file population
 *    (makeChanges), the recorded drand round 33,245,812, and an in-memory fake tracker that holds
 *    the issues and label events (test/helpers/fake-issue-trackers.ts, synthetic).
 *  - git-file audit (the Bitbucket row): the recorded gh-aw Q3 audit (test/fixtures/audits/
 *    gh-aw-q3-recorded: recorded population and beacon, synthetic times and key) with synthetic
 *    verdict lines.
 *
 * Since time round B a certificate needs its registration and commitment times proven by k
 * timestamp authorities. Every audit here is registered and frozen with two mock authorities
 * (test/helpers/test-tsa.ts, synthetic) that the shipped bundle does not hold; `tsaTrust` is a
 * trust file for them, which the CI job passes as `--tsa-trust` (the `tsa-trust` input). Without
 * it the same audit's certificate is withheld (exit 6). Status and verify check the stored tokens
 * offline; a checkpoint asks the authorities again, so their server (`tsa`) stays up until the test
 * file stops it (afterAll), with `nowMs` set to the time the checkpoint is taken.
 */

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=ci-fixture", "-c", "user.email=ci-fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const alice = { login: "alice", id: 11, type: "User" as const };
export const aliceGitLab = { id: 11, username: "alice" };

export interface TrackerAudit<F> {
  dir: string;
  /** A trust file for the two mock authorities that time-stamped the audit (pass it as --tsa-trust). */
  tsaTrust: string;
  /** Their server, still up (a checkpoint asks them again); the test file stops it. */
  tsa: MockTsaServer;
  /** The tracker as it stands after `sample`: one issue per drawn change, no verdicts yet. */
  fake: F;
  draws: DrawsFile;
  /** The first-occurrence draws, in draw order. */
  firstDraws: number[];
}

const W = "audit/2026-q3";

/** Two mock authorities for one audit, and a trust file for them outside the audit directory. */
async function authorities(): Promise<{ server: MockTsaServer; tsaTrust: string }> {
  const server = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  const tsaTrust = join(mkdtempSync(join(tmpdir(), "prrla-ci-trust-")), "tsa-trust.json");
  writeFileSync(tsaTrust, `${JSON.stringify(server.trust(), null, 2)}\n`);
  return { server, tsaTrust };
}

/** register, freeze and sample on the scenario's clock, each record time-stamped by the two authorities at that time. */
async function registerFreezeSample(s: Scenario, server: MockTsaServer): Promise<void> {
  const at = (iso: string) => void ((s.clock.now = T(iso)), (server.nowMs = T(iso)));
  at("2026-10-20T00:00:00Z");
  if ((await registerCommand(s.ctx, {})) !== 0) throw new Error(`fixture register failed: ${s.out.join("\n")}`);
  at("2026-10-20T12:00:00Z");
  if ((await freezeCommand(s.ctx, {})) !== 0) throw new Error(`fixture freeze failed: ${s.out.join("\n")}`);
  at("2026-10-21T01:00:00Z");
  if ((await sampleCommand(s.ctx, {})) !== 0) throw new Error(`fixture sample failed: ${s.out.join("\n")}`);
}

async function build<F>(ledgerYaml: string, route: (url: string) => boolean, fake: F & { fetch: typeof fetch }, env: Record<string, string>): Promise<TrackerAudit<F>> {
  const routed = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return route(url) ? fake.fetch(input, init) : globalThis.fetch(input, init);
  }) as typeof fetch;
  const { server, tsaTrust } = await authorities();
  const s: Scenario = setupAuditRepo({ changes: makeChanges(400), fetch: routed, tsa: { ids: ["test-a", "test-b"], server } });
  s.ctx.env = env;
  appendFileSync(join(s.dir, ".pr-rla.yml"), `${ledgerYaml}\n`);
  s.git("commit", "-qam", "ledger");
  await registerFreezeSample(s, server);
  s.git("add", "-A");
  s.git("commit", "-qm", "draws and ledger index");
  const draws = JSON.parse(readFileSync(join(s.dir, W, "draws.json"), "utf8")) as DrawsFile;
  return { dir: s.dir, tsaTrust, tsa: server, fake, draws, firstDraws: draws.draws.slice(0, draws.issued).filter((d) => d.firstOccurrence).map((d) => d.draw) };
}

/** A GitHub audit on `github-issues`; with `baseUrl`, a GitHub Enterprise Server at that origin (REST under /api/v3). */
export async function githubIssuesAudit(o: { baseUrl?: string; tokenEnv?: string } = {}): Promise<TrackerAudit<FakeGitHubIssues>> {
  const fake = new FakeGitHubIssues(o.baseUrl ? `${o.baseUrl}/api/v3` : "https://api.github.com", "acme/audit");
  // With `tokenEnv`, the ledger is registered with that token_env (the registration signs every option: P1).
  return build(`ledger: { use: github-issues, options: { repo: acme/audit${o.baseUrl ? `, base_url: ${o.baseUrl}` : ""}${o.tokenEnv ? `, token_env: ${o.tokenEnv}` : ""} } }`, (u) => u.startsWith(`${fake.api}/`), fake, { GITHUB_TOKEN: "test-token", ...(o.tokenEnv ? { [o.tokenEnv]: "test-token" } : {}) });
}

/** A GitLab audit on `gitlab-issues` at gitlab.com; with `baseUrl`, a self-managed instance at that origin. */
export async function gitlabIssuesAudit(o: { baseUrl?: string } = {}): Promise<TrackerAudit<FakeGitLabIssues>> {
  const base = o.baseUrl ?? "https://gitlab.com";
  const fake = new FakeGitLabIssues(base, "acme/audit");
  return build(`ledger: { use: gitlab-issues, options: { project: acme/audit${o.baseUrl ? `, base_url: ${o.baseUrl}` : ""} } }`, (u) => u.startsWith(`${base}/`), fake, { GITLAB_TOKEN: "test-token" });
}

/** An independent copy of a tracker, so one test's labels never reach another's. */
export function cloneFake<F extends object>(f: F): F {
  const copy = Object.create(Object.getPrototypeOf(f)) as F;
  return Object.assign(copy, structuredClone({ ...f, requests: [] }));
}

/** Applies reviewers' verdict labels to the first `pass + fail` first-occurrence draws, fails first. */
export function labelGithub(audit: TrackerAudit<FakeGitHubIssues>, v: { pass?: number; fail?: number }): FakeGitHubIssues {
  const fake = cloneFake(audit.fake);
  fake.setTime("2026-10-21T02:00:00Z");
  const order = [...Array(v.fail ?? 0).fill("pr-rla:fail"), ...Array(v.pass ?? 0).fill("pr-rla:pass")] as string[];
  order.forEach((label, i) => fake.label(fake.issueByDraw(audit.firstDraws[i]!).number, label, alice));
  return fake;
}
export function labelGitlab(audit: TrackerAudit<FakeGitLabIssues>, v: { pass?: number; fail?: number }): FakeGitLabIssues {
  const fake = cloneFake(audit.fake);
  fake.setTime("2026-10-21T02:00:00Z");
  const order = [...Array(v.fail ?? 0).fill("pr-rla-fail"), ...Array(v.pass ?? 0).fill("pr-rla-pass")] as string[];
  order.forEach((label, i) => fake.label(fake.issueByDraw(audit.firstDraws[i]!).iid, label, aliceGitLab));
  return fake;
}

/** A copy of an audit directory as a job's workspace; with `remote`, a clone of a new local bare repository, pushed. */
export function workspace(auditDir: string, o: { remote?: boolean; edit?: (dir: string) => void } = {}): { dir: string; remote: string | null } {
  const root = mkdtempSync(join(tmpdir(), "prrla-workspace-"));
  const dir = join(root, "ws");
  if (o.remote) {
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(root, "clone", "-q", remote, dir);
    cpSync(auditDir, dir, { recursive: true, filter: (s) => !s.endsWith("/.git") && !s.includes("/.git/") });
    o.edit?.(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "audit");
    git(dir, "push", "-q", "-u", "origin", "main");
    return { dir, remote };
  }
  cpSync(auditDir, dir, { recursive: true });
  o.edit?.(dir);
  return { dir, remote: null };
}

export type Verdicts = "continue" | "certified" | "escalate";

export interface GitFileAudit {
  dir: string;
  /** A trust file for the two mock authorities that time-stamped it (pass it as --tsa-trust). */
  tsaTrust: string;
  /** Their server, still up; the test file stops it. */
  tsa: MockTsaServer;
}

/**
 * The recorded gh-aw audit's population (git-file ledger), registered, frozen and sampled again with
 * two mock authorities, with synthetic verdict lines: 0, 36 passes, or 6 fails, committed as a
 * reviewer would. Its configuration, protocol and changes are the recorded fixture's; only the
 * timestamping names the two authorities, so the registration, and with it the draws, are its own.
 */
export async function gitFileAudit(kind: Verdicts): Promise<GitFileAudit> {
  const { server, tsaTrust } = await authorities();
  {
    const s = setupAuditRepo({ changes: [], tsa: { ids: ["test-a", "test-b"], server } });
    const recorded = fixturePath("audits", "gh-aw-q3-recorded");
    cpSync(recorded, s.dir, { recursive: true });
    rmSync(join(s.dir, "audit"), { recursive: true, force: true });
    const yml = join(s.dir, ".pr-rla.yml");
    const config = readFileSync(yml, "utf8");
    if (!config.includes("timestamping: { authorities: [] }")) throw new Error("the recorded fixture's timestamping line moved");
    writeFileSync(yml, config.replace("timestamping: { authorities: [] }", "timestamping: { authorities: [test-a, test-b], min_tokens: 2 }"));
    s.git("add", "-A");
    s.git("commit", "-qm", "the recorded gh-aw audit, time-stamped by two authorities");
    await registerFreezeSample(s, server);
    const dir = s.dir;
    const draws = JSON.parse(readFileSync(join(dir, W, "draws.json"), "utf8")) as DrawsFile;
    const protocolSha256 = createHash("sha256").update(readFileSync(join(dir, "review-protocol.md"))).digest("hex");
    const firsts = draws.draws.filter((d) => d.firstOccurrence);
    const n = kind === "certified" ? 36 : kind === "escalate" ? 6 : 0;
    const lines = firsts.slice(0, n).map((d, i) => unsignedLine({ draw: d.draw, changeId: d.changeId, verdict: kind === "escalate" ? "fail" : "pass", protocolSha256, reviewer: "ci-fixture", recordedAt: new Date(Date.parse("2026-10-21T03:00:00Z") + i * 1000).toISOString().replace(".000Z", "Z") }));
    if (lines.length) {
      mkdirSync(join(dir, W), { recursive: true });
      writeFileSync(join(dir, W, "verdicts.jsonl"), lines.join(""));
    }
    s.git("add", "-A");
    s.git("commit", "-qm", "registration, manifest, draws and verdicts");
    return { dir, tsaTrust, tsa: server };
  }
}

/** A registered and frozen audit of only 12 changes: below the registered minimum of 150, so `sample` refuses with exit 3. */
export async function smallPopulationAudit(): Promise<string> {
  const s = setupAuditRepo({ changes: makeChanges(12) });
  s.clock.now = T("2026-10-20T00:00:00Z");
  if ((await registerCommand(s.ctx, {})) !== 0) throw new Error(`fixture register failed: ${s.out.join("\n")}`);
  s.clock.now = T("2026-10-20T12:00:00Z");
  if ((await freezeCommand(s.ctx, {})) !== 0) throw new Error(`fixture freeze failed: ${s.out.join("\n")}`);
  s.git("add", "-A");
  s.git("commit", "-qm", "registered and frozen");
  return s.dir;
}
