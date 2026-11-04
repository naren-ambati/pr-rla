import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { runVerify } from "../src/commands/verify.js";
import { obtainTimestamps } from "../src/api/write/timestamps.js";
import { trustFor } from "../src/api/session.js";
import { manifestSha256, type CommitmentRecordV2, type DrawsFile, type ManifestV2, type RegistrationRecordV2, type SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import gitHub, { GITHUB_LABELS_LIMITATION } from "../src/providers/github/index.js";
import { makeChanges, REPO, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { fakeGitHub, type FakeCommit, type FakePr } from "./helpers/fake-github.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * P5, "draws that cannot be steered", finding 4 (the second review's `rvp2-label-grind`). Before, a `labels:` stratum was
 * read as of the freeze with only a WARN: relabelling between freezes, choosing after R and relabelling back gave a
 * CERTIFIED, VERIFIED audit from a chosen N. Now a labels stratum needs each change's labels at landing, from label
 * history: GitHub replays each pull request's issue events up to its merge (REST keeps a label's name as it was applied);
 * a provider without label history is refused at register, and a registration made with one anyway is INCOMPLETE.
 * Synthetic: the json-file export, a fake GitHub with issue events, mock authorities, the recorded beacon.
 */
const W = "audit/2026-q3";
let tsa: MockTsaServer;
beforeAll(async () => {
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
});
afterAll(async () => tsa.stop());
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const oid = (n: number, tag = "m") => (BigInt(n + 1) * 0x9e3779b97f4a7c15n + (tag === "m" ? 0n : 7n)).toString(16).padStart(40, "0").slice(-40);

/**
 * A synthetic GitHub repo (acme/widgets) with `n` bot PRs merged into main in Q3 2026, one a day-ish, unreviewed. Every
 * second PR carried the `copilot` label when it merged; `relabel` returns the label history after the merges as the
 * auditee rewrites it (labels the PR has now, and its events).
 */
function scenarioRepo(n: number) {
  const opens = T("2026-07-01T00:00:00Z");
  const step = Math.floor((T("2026-09-30T00:00:00Z") - opens) / n);
  const base: FakeCommit = { oid: oid(9999, "b"), date: "2026-06-30T00:00:00Z", parents: [] };
  const commits: FakeCommit[] = [base];
  const prs: FakePr[] = [];
  let prev = base.oid;
  for (let i = 0; i < n; i++) {
    const t = opens + 3600_000 + i * step;
    const sha = oid(i);
    commits.push({ oid: sha, date: iso(t), parents: [prev], prs: [{ number: 100 + i, merged: true, baseRefName: "main" }], lines: 5 });
    prev = sha;
    const labelled = i % 2 === 0;
    prs.push({
      number: 100 + i,
      base: "main",
      mergedAt: iso(t),
      updatedAt: iso(t + 1000),
      mergeCommit: sha,
      author: { __typename: "Bot", login: "copilot-swe-agent" },
      mergedBy: { __typename: "User", login: "maint" },
      reviews: [],
      additions: 3,
      deletions: 1,
      labels: labelled ? ["copilot"] : [],
      labelEvents: labelled ? [{ at: iso(t - 3600_000), action: "labeled", name: "copilot" }] : [],
    });
  }
  return { head: prev, commits, prs };
}

/** After landing (all in October): `drop` PRs lose the copilot label, `add` PRs gain it, `rename` renames it to agent. */
function relabel(prs: FakePr[], o: { drop?: number[]; add?: number[]; rename?: boolean; at: string }): FakePr[] {
  return prs.map((p) => {
    const events = [...(p.labelEvents ?? [])];
    let labels = [...(p.labels ?? [])];
    if (o.drop?.includes(p.number) && labels.includes("copilot")) {
      events.push({ at: o.at, action: "unlabeled", name: "copilot" });
      labels = labels.filter((l) => l !== "copilot");
    }
    if (o.add?.includes(p.number) && !labels.includes("copilot")) {
      events.push({ at: o.at, action: "labeled", name: "copilot" });
      labels.push("copilot");
    }
    // A rename keeps the events' names (REST, as recorded on rust-lang/rust) and renames the label the PR carries now.
    if (o.rename) labels = labels.map((l) => (l === "copilot" ? "agent" : l));
    return { ...p, labels, labelEvents: events };
  });
}

/** A labels-stratum audit of the synthetic repo on the github provider, served by a fake GitHub the test can relabel. */
function githubAudit(n: number) {
  const repo = scenarioRepo(n);
  const state = { prs: repo.prs };
  let fake = fakeGitHub(REPO, repo.head, repo.commits, state.prs, { pageSize: 100 });
  const route = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).hostname === "api.github.com" ? fake.fetch(input, init) : globalThis.fetch(input, init);
  }) as typeof fetch;
  const s = setupAuditRepo({ changes: [], provider: "github", fetch: route, tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
  s.ctx.env = { GITHUB_TOKEN: "synthetic-token-not-real" };
  const yml = join(s.dir, ".pr-rla.yml");
  writeFileSync(yml, readFileSync(yml, "utf8").replace("selector: { kinds: [pull_request, direct_push], authors: any, unreviewed: no-human-review }", "selector: { kinds: [pull_request], authors: any, unreviewed: no-human-review, labels: [copilot] }"));
  s.git("commit", "-qam", "a labels stratum on github");
  const setPrs = (prs: FakePr[]) => {
    state.prs = prs;
    fake = fakeGitHub(REPO, repo.head, repo.commits, prs, { pageSize: 100 });
  };
  return { s, repo, state, setPrs, served: () => fake.served() };
}

describe("P5 finding 4: a labels stratum is read as at landing", () => {
  it("rvp2-label-grind: on a provider without label history (json-file) the labels stratum is refused at register; nothing is written", async () => {
    const changes = makeChanges(400, { bad: 50 }).map((c) => ({ ...c, labels: [...c.labels, "copilot"].sort() }));
    const s = setupAuditRepo({ changes, tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
    writeFileSync(join(s.dir, ".pr-rla.yml"), readFileSync(join(s.dir, ".pr-rla.yml"), "utf8").replace("unreviewed: no-human-review", "unreviewed: no-human-review, labels: [copilot]"));
    s.git("commit", "-qam", "label stratum");
    at(s, "2026-06-20T00:00:00Z");
    await expect(registerCommand(s.ctx, {})).rejects.toThrow("the stratum selects by labels (copilot), and provider json-file reads no label history: labels can be changed after a change lands, so read as they are at freeze they would let whoever relabels choose N, and so the draws. Nothing was written: register a stratum without labels, or use a provider that reads each change's labels at landing (github)");
    expect(() => readJ(s, `${W}/registration.json`)).toThrow();
  });

  it("on GitHub: relabelling after landing, between freezes, after R and back, moves no change in or out: one N, one sample; VERIFIED", async () => {
    const g = githubAudit(400);
    const s = g.s;
    at(s, "2026-06-20T00:00:00Z");
    s.out.length = 0;
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(s.out).toContain("ERR note: the stratum selects by labels (copilot); provider github reads each change's labels as they were when it landed, from its label history (on GitHub, one request per pull request), so nothing done after landing moves a change in or out");
    // Freeze 1 with the honest history; freeze 2 after the auditee took the label off 30 PRs and put it on 30 others.
    at(s, "2026-10-01T06:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const first = readJ<ManifestV2>(s, `${W}.manifest.json`);
    expect(first.N).toBe(200);
    expect(first.limitations).toContain(GITHUB_LABELS_LIMITATION);
    const labelled = g.repo.prs.filter((p) => p.labels!.length).map((p) => p.number);
    const unlabelled = g.repo.prs.filter((p) => !p.labels!.length).map((p) => p.number);
    g.setPrs(relabel(g.repo.prs, { drop: labelled.slice(0, 30), add: unlabelled.slice(0, 30), at: "2026-10-01T07:00:00Z" }));
    at(s, "2026-10-01T08:00:00Z");
    expect(await freezeCommand(s.ctx, { force: true })).toBe(0);
    const second = readJ<ManifestV2>(s, `${W}.manifest.json`);
    expect(second.N).toBe(first.N);
    expect(second.changes.map((c) => c.id)).toEqual(first.changes.map((c) => c.id));
    expect(second.changes.every((c) => c.labels.includes("copilot"))).toBe(true);
    // R publishes; the auditee relabels again (and renames the label), then samples and has the draws reviewed.
    g.setPrs(relabel(relabel(g.state.prs, { drop: labelled.slice(30, 60), add: unlabelled.slice(30, 60), at: "2026-10-02T07:00:00Z" }), { rename: true, at: "2026-10-02T07:30:00Z" }));
    at(s, "2026-10-02T08:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    const d = readJ<DrawsFile>(s, `${W}/draws.json`);
    for (const x of d.draws.slice(0, 36)) if (x.firstOccurrence) await recordCommand(s.ctx, String(x.draw), "pass", { reviewer: "r" });
    s.git("add", "-A");
    s.git("commit", "-qm", "verdicts");
    const r = await runVerify(s.ctx, {});
    expect(r.checks.map((c) => `${c.n}:${c.status}`).slice(0, 6)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:PASS", "6:PASS"]);
    expect(r.checks[4]!.summary).toBe("population 200/200 match");
  }, 300_000);

  it("the same relabelling between freezes, read as of the freeze (what the old rule did), would have given another N: the history is what holds it", async () => {
    const g = githubAudit(240);
    const p = await gitHub.create({}, { cwd: g.s.dir, env: { GITHUB_TOKEN: "t" }, log: () => {}, fetch: (async (i: string | URL | Request, init?: RequestInit) => g.s.fetch(i, init)) as typeof fetch });
    const labelled = g.repo.prs.filter((x) => x.labels!.length).map((x) => x.number);
    g.setPrs(relabel(g.repo.prs, { drop: labelled.slice(0, 30), at: "2026-10-01T07:00:00Z" }));
    const req = { repo: REPO, window: { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" }, kinds: ["pull_request" as const] };
    const now = await p.listChanges(req);
    const landing = await p.listChanges({ ...req, labelsAt: "landing" });
    expect(now.labelsAt).toBeUndefined();
    expect(landing.labelsAt).toBe("landing");
    expect(now.changes.filter((c) => c.labels.includes("copilot"))).toHaveLength(90);
    expect(landing.changes.filter((c) => c.labels.includes("copilot"))).toHaveLength(120);
    // One issue-events request per pull request, only when asked.
    expect(g.served()).toBeGreaterThan(240);
  });

  it("a labels registration on a provider without label history (written before P5): freeze refuses it; check 2 INCOMPLETE offline, check 5 INCOMPLETE online", async () => {
    const changes = makeChanges(400).map((c, i) => ({ ...c, labels: i % 2 ? ["copilot"] : [] }));
    const s = setupAuditRepo({ changes, tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    // The audit as one registered before the refusal would be: the selector a labels stratum, everything signed again.
    const key = loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem"));
    const regPath = join(s.dir, W, "registration.json");
    const reg0 = JSON.parse(readFileSync(regPath, "utf8")) as SignedRecord<RegistrationRecordV2>;
    const record = { ...reg0.record, selector: { ...reg0.record.selector, labels: ["copilot"] } };
    let reg = signRecord(record, key);
    at(s, record.registeredAt); // stamped when it says it was made, as the authorities would have stamped it then
    reg = { ...reg, timestamps: (await obtainTimestamps(s.ctx, reg, record.registeredAt, record.timestamping, trustFor(s.ctx))).timestamps };
    writeFileSync(regPath, JSON.stringify(reg, null, 2));
    const m0 = readJ<ManifestV2>(s, `${W}.manifest.json`);
    const kept = m0.changes.filter((c) => c.labels.includes("copilot"));
    const { sha256: _m, ...body0 } = m0;
    const body = { ...body0, registrationSha256: reg.sha256, selector: record.selector, changes: kept, N: kept.length };
    const m = { ...body, sha256: manifestSha256(body as never) } as ManifestV2;
    writeFileSync(join(s.dir, `${W}.manifest.json`), JSON.stringify(m, null, 2));
    const cmPath = join(s.dir, W, "manifest-commitment.json");
    const cm0 = JSON.parse(readFileSync(cmPath, "utf8")) as SignedRecord<CommitmentRecordV2>;
    let cm = signRecord({ ...cm0.record, manifestSha256: m.sha256, N: m.N, registrationSha256: reg.sha256 }, key);
    at(s, cm0.record.frozenAt);
    cm = { ...cm, timestamps: (await obtainTimestamps(s.ctx, cm, cm0.record.frozenAt, record.timestamping, trustFor(s.ctx))).timestamps };
    writeFileSync(cmPath, JSON.stringify(cm, null, 2));
    writeFileSync(join(s.dir, ".pr-rla.yml"), readFileSync(join(s.dir, ".pr-rla.yml"), "utf8").replace("unreviewed: no-human-review", "unreviewed: no-human-review, labels: [copilot]"));
    const offline = await runVerify(s.ctx, { offline: true });
    expect(offline.checks[1]!.status).toBe("INCOMPLETE");
    expect(offline.checks[1]!.details).toContain("INCOMPLETE the registered stratum selects by labels (copilot), and the provider reads no label history: labels can change after a change lands, and read as they are at freeze they would let whoever relabels choose N, and so the draws");
    const online = await runVerify(s.ctx, {});
    expect(online.checks[4]!.status).toBe("INCOMPLETE");
    expect(online.checks[4]!.details).toContain(`INCOMPLETE the stratum selects by labels (copilot), and provider json-file did not give the labels the changes of 1 repo(s) had when they landed (${REPO}): it reads no label history, so the stratum read from labels as they are now is not established`);
    // A new freeze of it is refused: it would read the labels as they are now.
    await expect(freezeCommand(s.ctx, { force: true })).rejects.toThrow(/provider json-file did not give the labels each change had when it landed \(it reads no label history\).*Nothing was written/);
  });
});

describe("P5 finding 4: GitHub's labels at landing, case by case (synthetic fake GitHub)", () => {
  const prOf = (labelEvents: FakePr["labelEvents"], labels: string[]): FakePr => ({ number: 7, base: "main", mergedAt: "2026-08-01T12:00:00Z", updatedAt: "2026-08-01T12:00:05Z", mergeCommit: "a".repeat(40), author: { __typename: "User", login: "bob" }, mergedBy: null, reviews: [], additions: 1, deletions: 1, labels, labelEvents });
  const commits: FakeCommit[] = [{ oid: "a".repeat(40), date: "2026-08-01T12:00:00Z", parents: [], prs: [{ number: 7, merged: true, baseRefName: "main" }] }];
  const list = async (pr: FakePr) => {
    const fake = fakeGitHub("o/r", "a".repeat(40), commits, [pr], { pageSize: 100 });
    const p = await gitHub.create({ page_size: 2 }, { cwd: "/", env: {}, log: () => {}, fetch: fake.fetch });
    return (await p.listChanges({ repo: "o/r", window: { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" }, kinds: ["pull_request"], labelsAt: "landing" })).changes[0]!.labels;
  };

  it("replays labeled and unlabeled up to the merge second, across pages; later events change nothing", async () => {
    const ev = (at: string, action: "labeled" | "unlabeled", name: string) => ({ at, action, name });
    expect(await list(prOf([ev("2026-08-01T09:00:00Z", "labeled", "a"), ev("2026-08-01T10:00:00Z", "labeled", "b"), ev("2026-08-01T11:00:00Z", "unlabeled", "a"), ev("2026-08-01T12:00:00Z", "labeled", "c"), ev("2026-08-01T12:00:01Z", "labeled", "late"), ev("2026-08-02T00:00:00Z", "unlabeled", "b")], ["c", "late"]))).toEqual(["b", "c"]);
  });

  it("a label event that names no label is refused, never guessed", async () => {
    const fake = fakeGitHub("o/r", "a".repeat(40), commits, [prOf([], [])], { pageSize: 100 });
    const broken = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/issues/7/events")) return new Response(JSON.stringify([{ id: 1, event: "labeled", created_at: "2026-08-01T09:00:00Z", label: null }]), { status: 200, headers: { "content-type": "application/json" } });
      return fake.fetch(input, init);
    }) as typeof fetch;
    const p = await gitHub.create({}, { cwd: "/", env: {}, log: () => {}, fetch: broken });
    await expect(p.listChanges({ repo: "o/r", window: { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" }, kinds: ["pull_request"], labelsAt: "landing" })).rejects.toThrow("github: github:o/r#7: issue event 1 (labeled) names no label or no time; its labels at landing cannot be read");
  });
});
