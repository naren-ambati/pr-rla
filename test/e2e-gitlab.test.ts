import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import { manifestSha256, type DrawsFile, type Manifest, type ManifestCommitmentRecord, type SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { RekorClient, buildHashedRekord } from "../src/translog/rekor.js";
import { cloneScenario, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { fakeGitLab, GL_BASE } from "./helpers/fake-gitlab.js";
import { generatedGitLabScenario } from "./helpers/gitlab-population.js";
import { MockRekor } from "./helpers/mock-rekor.js";

/**
 * The e2e audit again, with the GitLab provider swapped in for json-file: a fake
 * self-managed GitLab serves 400 Q3 changes (squash, merge-commit and fast-forward
 * MRs, direct pushes). register -> freeze -> sample -> record -> status -> verify,
 * and tamper fixture 1, with no change to the core.
 */
const R = 33245812;
const W = "audit/2026-q3";
const log = new MockRekor();
const sc = generatedGitLabScenario();
const gitlab = fakeGitLab(sc, { pageSize: 100 });
const viaGitLab = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith(GL_BASE) ? gitlab.fetch(input, init) : globalThis.fetch(input, init);
}) as typeof fetch;
let honest: Scenario;

const readJ = <T>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as T;
const writeJ = (s: Scenario, p: string, v: unknown) => writeFileSync(join(s.dir, p), `${JSON.stringify(v, null, 2)}\n`);
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  log.now = Math.floor(T(iso) / 1000);
};

beforeAll(async () => {
  await log.start();
  honest = setupAuditRepo({ changes: [], log, provider: `{ use: gitlab, options: { base_url: "${GL_BASE}", batch_size: 20 } }`, fetch: viaGitLab });
  at(honest, "2026-10-20T00:00:00Z");
  expect(await registerCommand(honest.ctx, { submit: true })).toBe(0);
  at(honest, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(honest.ctx, { submit: true })).toBe(0);
  at(honest, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(honest.ctx, {})).toBe(0);
  at(honest, "2026-10-21T03:00:00Z");
  const draws = readJ<DrawsFile>(honest, `${W}/draws.json`);
  for (const d of draws.draws.slice(0, 36)) if (d.firstOccurrence) await recordCommand(honest.ctx, String(d.draw), "pass", { reviewer: "outside-reviewer" });
  honest.git("add", "-A");
  honest.git("commit", "-qm", "verdicts through 36");
}, 120_000);
afterAll(async () => log.stop());

describe("end-to-end audit with the GitLab provider (fake self-managed instance, mock Rekor, recorded beacon, git-file ledger)", () => {
  it("freeze lists 400 changes through GitLab's APIs: MRs of three merge methods and direct pushes", () => {
    const m = readJ<Manifest>(honest, `${W}.manifest.json`);
    expect(m.provider).toEqual({ name: "gitlab", apiVersion: 1 });
    expect(m.N).toBe(400);
    expect(m.changes.filter((c) => c.kind === "direct_push")).toHaveLength(40);
    expect(m.changes.every((c) => c.id.startsWith("gitlab:acme/widgets"))).toBe(true);
    expect(manifestSha256(m)).toBe(m.sha256);
    expect(readJ<SignedRecord<ManifestCommitmentRecord>>(honest, `${W}/manifest-commitment.json`).record.seedRound).toBe(R);
    expect(m.limitations.join(" ")).toMatch(/GitLab's commit API does not link commits to accounts/);
  });

  it("status: 36 passes certify claim D", async () => {
    const s = cloneScenario(honest);
    expect(await statusCommand(s.ctx, {})).toBe(0);
    expect(s.out[0]).toMatch(/^prefix 36\/36 · fails 0 · claim D .*LLR 3\.066 \/ target 2\.996 · CERTIFIED \(risk 5%\) · RETROSPECTIVE$/);
  });

  it("verify: all seven checks pass; check 5 rebuilt the population from GitLab", async () => {
    const s = cloneScenario(honest);
    const before = gitlab.served();
    const report = await runVerify(s.ctx, {});
    expect(report.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:PASS", "6:PASS", "7:PASS"]);
    expect(gitlab.served() - before).toBeGreaterThan(100);
    expect(await verifyCommand(s.ctx, {})).toBe(0);
    expect(s.out.join("\n")).toMatch(/population 400\/400 match ✓ · 36\/36 draws reproduce ✓/);
  });

  it("tamper fixture 1 on GitLab: a manifest with the known-bad MRs removed fails check 5, and only check 5", async () => {
    const s = cloneScenario(honest);
    const m = readJ<Manifest>(s, `${W}.manifest.json`);
    const pruned = m.changes.filter((c) => !c.labels.includes("known-bad"));
    // 72, not 80: 8 of the first 80 generated changes are direct pushes, and commits carry no labels on GitLab.
    expect(m.changes.length - pruned.length).toBe(72);
    const body = { ...m, changes: pruned, N: pruned.length } as Partial<Manifest>;
    delete body.sha256;
    const tampered = { ...body, sha256: manifestSha256(body as Manifest) } as Manifest;
    writeJ(s, `${W}.manifest.json`, tampered);
    const c = readJ<SignedRecord<ManifestCommitmentRecord>>(s, `${W}/manifest-commitment.json`).record;
    log.now = Math.floor(T("2026-10-20T12:00:00Z") / 1000);
    const signed = signRecord({ ...c, manifestSha256: tampered.sha256, N: tampered.N }, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem")));
    writeJ(s, `${W}/manifest-commitment.json`, { ...signed, log: await new RekorClient(log.url).submit(buildHashedRekord(signed)) });
    at(s, "2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    const report = await runVerify(s.ctx, {});
    const c5 = report.checks.find((x) => x.n === 5)!;
    expect(c5.status).toBe("FAIL");
    expect(c5.summary).toMatch(/^population: 72 changes on gitlab are missing from the manifest/);
    expect(report.checks.filter((x) => x.status === "FAIL").map((x) => x.n)).toEqual([5]);
  });
});
