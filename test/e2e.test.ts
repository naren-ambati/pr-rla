import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProgram } from "../src/cli.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import { manifestSha256, type DrawsFile, type LoggedEntry, type Manifest, type ManifestCommitmentRecord, type SignedRecord } from "../src/core/records.js";
import { computeDraws, roundPublishTime } from "../src/core/seed.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { RekorClient, buildHashedRekord } from "../src/translog/rekor.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { recordedBeacon } from "./helpers/fixtures.js";
import { MockRekor } from "./helpers/mock-rekor.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

const R = 33245812; // first quicknet round >= 24 h after a registration logged 2026-10-20T00:00:00Z
const OTHER = 33244800;
const W = "audit/2026-q3";

const log = new MockRekor();
let tsa: MockTsaServer;
let honest: Scenario;

const readJ = <T>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as T;
const writeJ = (s: Scenario, p: string, v: unknown) => writeFileSync(join(s.dir, p), `${JSON.stringify(v, null, 2)}\n`);
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  log.now = Math.floor(T(iso) / 1000);
  tsa.nowMs = T(iso);
};

async function reviewDraws(s: Scenario, through: number, failAt: number[] = []) {
  const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
  let done = new Set<string>();
  try {
    done = new Set(readFileSync(join(s.dir, W, "verdicts.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { changeId: string }).changeId));
  } catch {
    /* no verdicts yet */
  }
  for (const d of draws.draws.slice(0, through)) {
    if (!d.firstOccurrence || done.has(d.changeId)) continue;
    await recordCommand(s.ctx, String(d.draw), failAt.includes(d.draw) ? "fail" : "pass", { reviewer: "outside-reviewer" });
  }
  s.git("add", "-A");
  s.git("commit", "-qm", `verdicts through ${through}`);
}

/** Re-sign and re-log a (tampered) manifest commitment as the audit's own signer would. */
async function relogCommitment(s: Scenario, record: ManifestCommitmentRecord, logAt: string) {
  log.now = Math.floor(T(logAt) / 1000);
  const signed = signRecord(record, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem")));
  const entry = await new RekorClient(log.url).submit(buildHashedRekord(signed));
  writeJ(s, `${W}/manifest-commitment.json`, { ...signed, log: entry } satisfies SignedRecord<ManifestCommitmentRecord>);
}

beforeAll(async () => {
  await log.start();
  // Two mock timestamp authorities of two operators (k = 2): schema-v2 records need tokens to be tamper-evident.
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  honest = setupAuditRepo({ changes: makeChanges(400, { bad: 80 }), log, tsa: { ids: ["test-a", "test-b"], server: tsa } });
  at(honest, "2026-10-20T00:00:00Z");
  expect(await registerCommand(honest.ctx, { submit: true })).toBe(0);
  at(honest, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(honest.ctx, { submit: true })).toBe(0);
  at(honest, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(honest.ctx, {})).toBe(0);
  at(honest, "2026-10-21T03:00:00Z");
  await reviewDraws(honest, 36);
});
afterAll(async () => {
  await log.stop();
  await tsa.stop();
});

describe("an honest retrospective audit, end to end (json-file provider, mock timestamp authorities, mock Rekor log, recorded beacon, git-file ledger)", () => {
  it("register derives R from the logged registration time", () => {
    expect(honest.out.join("\n")).toMatch(/RETROSPECTIVE/);
    expect(honest.out.join("\n")).toMatch(new RegExp(`seed round R = ${R}`));
    const reg = readJ<SignedRecord<unknown> & { log: LoggedEntry | null }>(honest, `${W}/registration.json`);
    expect(reg.log?.integratedTime).toBe(T("2026-10-20T00:00:00Z") / 1000);
  });

  it("freeze writes a sorted manifest with its hash and N, naming R", () => {
    const m = readJ<Manifest>(honest, `${W}.manifest.json`);
    expect(m.N).toBe(400);
    expect(manifestSha256(m)).toBe(m.sha256);
    expect(m.changes.map((c) => c.id)).toEqual([...m.changes.map((c) => c.id)].sort());
    expect(m.limitations.join(" ")).toMatch(/commit author != pusher/);
    expect(readJ<SignedRecord<ManifestCommitmentRecord>>(honest, `${W}/manifest-commitment.json`).record.seedRound).toBe(R);
  });

  it("sample draws reproducibly from the verified beacon", () => {
    const d = readJ<DrawsFile>(honest, `${W}/draws.json`);
    const m = readJ<Manifest>(honest, `${W}.manifest.json`);
    expect(d.round).toBe(R);
    expect(d.issued).toBe(36);
    expect(d.draws).toHaveLength(144);
    // Time round B: schema v2 draws are bound to the registration's sha256, not the manifest's.
    const reg = readJ<SignedRecord<unknown>>(honest, `${W}/registration.json`);
    expect(d.draws.map((x) => x.index)).toEqual(computeDraws(recordedBeacon(R).randomness, reg.sha256, 400, 144).map((x) => x.index));
  });

  it("status: 36 passes certify claim D", async () => {
    const s = cloneScenario(honest);
    expect(await statusCommand(s.ctx, {})).toBe(0);
    expect(s.out[0]).toMatch(/^prefix 36\/36 · fails 0 · claim D \(detected-defect rate ≤ 10%.*LLR 3\.066 \/ target 2\.996 · CERTIFIED \(risk 5%\) · RETROSPECTIVE$/);
  });

  it("verify: all seven checks pass, timestamps are tamper-evident", async () => {
    const s = cloneScenario(honest);
    // The verifier passes the log's key (--log-key); the audit repo only names the log's URL.
    const report = await runVerify(s.ctx, { logKey: s.logKeyArgs });
    expect(report.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:PASS", "6:PASS", "7:PASS"]);
    expect(report.timestampTamperProof).toBe(true);
    // pass-2 review #6: the verifier's key counts for its own log only, under a neutral operator name, never "Sigstore".
    expect(report.checks[0]!.details.join("\n")).toMatch(/registration logged at .* \(SET and inclusion proof verified under the verifier's --log-key for http:\/\/127\.0\.0\.1:\d+; operator log at 127\.0\.0\.1:\d+\)/);
    expect(await verifyCommand(s.ctx, { logKey: s.logKeyArgs })).toBe(0);
    const text = s.out.join("\n");
    expect(text).toMatch(/registration after window close → RETROSPECTIVE \(a demonstration\) · manifest logged .* before R ✓ · R = 33,245,812: first round ≥ 24 h after registration ✓ · BLS ✓ · population 400\/400 match ✓ · 36\/36 draws reproduce ✓ · labels/);
    expect(text).toMatch(/VERIFIED$/);
  });
});

describe("tamper fixtures: verify must FAIL", () => {
  it("(1) a manifest with the 80 known-bad changes removed fails check 5", async () => {
    const s = cloneScenario(honest);
    const m = readJ<Manifest>(s, `${W}.manifest.json`);
    const pruned = m.changes.filter((c) => !c.labels.includes("known-bad"));
    expect(m.changes.length - pruned.length).toBe(80);
    const body = { ...m, changes: pruned, N: pruned.length } as Partial<Manifest>;
    delete body.sha256;
    const tampered = { ...body, sha256: manifestSha256(body as Manifest) } as Manifest;
    writeJ(s, `${W}.manifest.json`, tampered);
    const c = readJ<SignedRecord<ManifestCommitmentRecord>>(s, `${W}/manifest-commitment.json`).record;
    await relogCommitment(s, { ...c, manifestSha256: tampered.sha256, N: tampered.N }, "2026-10-20T12:00:00Z");
    at(s, "2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    const report = await runVerify(s.ctx, {});
    const c5 = report.checks.find((x) => x.n === 5)!;
    expect(c5.status).toBe("FAIL");
    expect(c5.summary).toBe("population: 80 changes on json-file are missing from the manifest (e.g. " + c5.summary.split("(e.g. ")[1]);
    expect(report.checks.filter((x) => x.status === "FAIL").map((x) => x.n)).toEqual([5]);
    expect(report.ok).toBe(false);
  });

  it("(2) a commitment naming a different round fails check 3", async () => {
    const s = cloneScenario(honest);
    const c = readJ<SignedRecord<ManifestCommitmentRecord>>(s, `${W}/manifest-commitment.json`).record;
    await relogCommitment(s, { ...c, seedRound: OTHER, seedRoundPublishesAt: new Date(roundPublishTime(OTHER) * 1000).toISOString() }, "2026-10-20T12:00:00Z");
    // The tamperer also redraws from the round they named.
    const m = readJ<Manifest>(s, `${W}.manifest.json`);
    const d = readJ<DrawsFile>(s, `${W}/draws.json`);
    const redrawn = computeDraws(recordedBeacon(OTHER).randomness, m.sha256, m.N, 144).map((x) => ({ ...x, changeId: m.changes[x.index]!.id, url: m.changes[x.index]!.url, mergeSha: m.changes[x.index]!.mergeSha, firstOccurrence: true }));
    writeJ(s, `${W}/draws.json`, { ...d, round: OTHER, beacon: recordedBeacon(OTHER), draws: redrawn });
    const report = await runVerify(s.ctx, {});
    const c3 = report.checks.find((x) => x.n === 3)!;
    expect(c3.status).toBe("FAIL");
    expect(c3.details).toContain("FAIL seed round 33,244,800 ≠ derived round 33,245,812 (commitment)");
    expect(c3.details).toContain("FAIL seed round 33,244,800 ≠ derived round 33,245,812 (draws)");
    expect(report.checks.find((x) => x.n === 6)!.status).toBe("FAIL"); // the redrawn draws do not reproduce from R
    expect(report.ok).toBe(false);
  });

  it("(3) a manifest logged after R fails check 2", async () => {
    const s = cloneScenario(honest);
    const c = readJ<SignedRecord<ManifestCommitmentRecord>>(s, `${W}/manifest-commitment.json`).record;
    await relogCommitment(s, { ...c, frozenAt: "2026-10-22T00:00:00Z" }, "2026-10-22T00:00:00Z");
    const report = await runVerify(s.ctx, {});
    const c2 = report.checks.find((x) => x.n === 2)!;
    expect(c2.status).toBe("FAIL");
    expect(c2.summary).toBe("manifest logged after the seed was public");
    expect(report.checks.filter((x) => x.status === "FAIL").map((x) => x.n)).toEqual([2]);
  });

  it("freeze itself refuses once R is public", async () => {
    const s = cloneScenario(honest);
    at(s, "2026-10-22T00:00:00Z");
    await expect(freezeCommand(s.ctx, {})).rejects.toThrow(/seed round 33245812 published .* after the seed was public/);
  });

  it("an edited integratedTime (SET no longer verifies) fails", async () => {
    const s = cloneScenario(honest);
    const reg = readJ<SignedRecord<unknown> & { log: { integratedTime: number } }>(s, `${W}/registration.json`);
    reg.log.integratedTime -= 30 * 86400; // pretend it was registered before the window
    writeJ(s, `${W}/registration.json`, reg);
    const report = await runVerify(s.ctx, { logKey: s.logKeyArgs });
    expect(report.checks[0]!.status).toBe("FAIL");
    expect(report.checks[0]!.details.join(" ")).toMatch(/signedEntryTimestamp does not verify/);
  });

  it("a changed review protocol fails check 1", async () => {
    const s = cloneScenario(honest);
    writeFileSync(join(s.dir, "review-protocol.md"), "# Protocol\nOnly crashes count.\n");
    expect((await runVerify(s.ctx, {})).checks[0]!.details.join(" ")).toMatch(/review protocol changed/);
  });

  it("a rewritten verdicts.jsonl (git history) fails check 7", async () => {
    const s = cloneScenario(honest);
    const p = join(s.dir, W, "verdicts.jsonl");
    const lines = readFileSync(p, "utf8").trim().split("\n");
    writeFileSync(p, `${lines.slice(1).join("\n")}\n`);
    s.git("commit", "-qam", "drop a verdict");
    const c7 = (await runVerify(s.ctx, {})).checks[6]!;
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join(" ")).toMatch(/rewritten \(not appended\)/);
  });

  it("a verdict recorded before the seed was public fails check 7", async () => {
    const s = cloneScenario(honest);
    const p = join(s.dir, W, "verdicts.jsonl");
    const lines = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { recordedAt: string });
    lines[0]!.recordedAt = "2026-10-20T13:00:00Z";
    writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const c7 = (await runVerify(s.ctx, {})).checks[6]!;
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join(" ")).toMatch(/before the seed was public/);
  });
});

describe("local-only registration (no transparency log)", () => {
  it("verify is INCOMPLETE with TIMESTAMP NOT TAMPER-PROOF, and no certificate is printed (time round B)", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    at(s, "2026-10-20T00:00:00Z");
    await registerCommand(s.ctx, {});
    expect(s.out.join("\n")).toMatch(/TIMESTAMP NOT TAMPER-PROOF/);
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    at(s, "2026-10-21T01:00:00Z");
    await sampleCommand(s.ctx, {});
    await reviewDraws(s, 36);
    s.out.length = 0;
    // Before time round B this was VERIFIED, exit 0, and CERTIFIED: on times nothing but the signer's clock vouches for.
    expect(await verifyCommand(s.ctx, {})).toBe(6);
    const text = s.out.join("\n");
    expect(text).toMatch(/1\. INCOMPLETE registration/);
    expect(text).toMatch(/2\. INCOMPLETE manifest before seed: manifest written \(signed time, unproven\) .*: not shown to precede R/);
    expect(text).toMatch(/3\. INCOMPLETE seed round: R = 33,245,812: first round ≥ 24 h after registration, but the registration time it rests on is unproven/);
    expect(text).toMatch(/TIMESTAMP NOT TAMPER-PROOF/);
    expect(text).toMatch(/· target reached · CERTIFICATE WITHHELD \(verify check 1 \(registration\) incomplete; verify check 2 \(manifest before seed\) incomplete; verify check 3 \(seed round\) incomplete\) ·/);
    expect(text).not.toMatch(/CERTIFIED \(risk|\nVERIFIED$/);
    expect(s.out.at(-1)).toBe("INCOMPLETE: check 1 (registration), check 2 (manifest before seed), check 3 (seed round) could not be established; nothing failed, but this is not a verification (exit 6)");
    // status says the same, and exits 6 with the reasons
    s.out.length = 0;
    expect(await statusCommand(s.ctx, {})).toBe(6);
    expect(s.out[0]).toMatch(/· target reached · CERTIFICATE WITHHELD \(registration time unproven \(TIMESTAMP NOT TAMPER-PROOF\); manifest commitment time unproven \(TIMESTAMP NOT TAMPER-PROOF\)\) · RETROSPECTIVE · TIMESTAMP NOT TAMPER-PROOF$/);
    expect(s.out).toContain("  certificate withheld (INCOMPLETE): registration time unproven (TIMESTAMP NOT TAMPER-PROOF)");
  });
});

describe("status variants and refusals", () => {
  it("one failure: 20 more passing draws needed (56 total), then certify at 56", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    at(s, "2026-10-20T00:00:00Z");
    await registerCommand(s.ctx, {});
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    at(s, "2026-10-21T01:00:00Z");
    await sampleCommand(s.ctx, {});
    // Fail one change that is drawn only once in the first 56 draws (a duplicate would count its fail twice).
    const all = readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, 56);
    const once = all.slice(0, 36).find((d) => all.filter((x) => x.changeId === d.changeId).length === 1)!.draw;
    await reviewDraws(s, 36, [once]);
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out[0]).toMatch(/fails 1 .* NOT CERTIFIED · 20 more passing draws needed \(56 total\)/);
    await sampleCommand(s.ctx, { through: 56 });
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out[0]).toMatch(/prefix 36\/56 .* NOT CERTIFIED/);
    expect(s.out[1]).toMatch(/blocking draw: #37 /);
    await reviewDraws(s, 56, [once]);
    s.out.length = 0;
    // The SPRT certifies at 56; with no timestamp authority the certificate is withheld (time round B), exit 6.
    expect(await statusCommand(s.ctx, {})).toBe(6);
    expect(s.out[0]).toMatch(/prefix 56\/56 · fails 1 .* target reached · CERTIFICATE WITHHELD \(registration time unproven/);
  });

  it("the prefix rule: a gap blocks later labels", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    at(s, "2026-10-20T00:00:00Z");
    await registerCommand(s.ctx, {});
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    at(s, "2026-10-21T01:00:00Z");
    await sampleCommand(s.ctx, {});
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
    for (const d of draws.draws.slice(1, 36)) if (d.firstOccurrence && d.changeId !== draws.draws[0]!.changeId) await recordCommand(s.ctx, String(d.draw), "pass", { reviewer: "r" });
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out[0]).toMatch(/^prefix 0\/36 /);
    expect(s.out[1]).toMatch(/blocking draw: #1 /);
  });

  it("escalates when failures exceed what the cap can absorb", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    at(s, "2026-10-20T00:00:00Z");
    await registerCommand(s.ctx, {});
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    at(s, "2026-10-21T01:00:00Z");
    await sampleCommand(s.ctx, {});
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
    const firsts = draws.draws.slice(0, 36).filter((d) => d.firstOccurrence).slice(0, 6).map((d) => d.draw);
    await reviewDraws(s, Math.max(...firsts), firsts);
    s.out.length = 0;
    expect(await statusCommand(s.ctx, {})).toBe(2);
    expect(s.out[0]).toMatch(/ESCALATE: review all 400 or narrow the claim/);
  });

  it("below 150 changes: review all N instead", async () => {
    const s = setupAuditRepo({ changes: makeChanges(12) });
    at(s, "2026-10-20T00:00:00Z");
    await registerCommand(s.ctx, {});
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    expect(s.out.join("\n")).toMatch(/population 12 < 150: review all 12 instead/);
    at(s, "2026-10-21T01:00:00Z");
    s.out.length = 0;
    expect(await sampleCommand(s.ctx, {})).toBe(3);
    expect(s.out[0]).toBe("population 12 < 150: review all 12 instead");
  });

  it("sample before R publishes says when to come back", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    at(s, "2026-10-20T00:00:00Z");
    await registerCommand(s.ctx, {});
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    s.out.length = 0;
    expect(await sampleCommand(s.ctx, {})).toBe(2);
    expect(s.out[0]).toMatch(/seed round 33245812 publishes 2026-10-21T00:00:00Z \(in 12\.0 h\)/);
  });

  it("status while the window is open (prospective registration)", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    at(s, "2026-06-20T00:00:00Z");
    await registerCommand(s.ctx, {});
    expect(s.out.join("\n")).toMatch(/PROSPECTIVE/);
    expect(s.out.join("\n")).toMatch(/seed round R = 32698612 .* 24 h after the window close/);
    at(s, "2026-07-12T12:00:00Z");
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out[0]).toMatch(/^PROSPECTIVE · window open, day 12 of 92 · N so far \d+ · seed round 32698612 not yet published · TIMESTAMP NOT TAMPER-PROOF$/);
  });
});

describe("CLI wiring", () => {
  it("parses commands and maps errors to exit codes", async () => {
    const s = cloneScenario(honest);
    let code = -1;
    await buildProgram(() => s.ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", "status"]);
    expect(code).toBe(0);
    expect(s.out[0]).toMatch(/CERTIFIED/);
    await buildProgram(() => s.ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", "record", "1", "maybe", "--reviewer", "x"]);
    expect(code).toBe(1);
    expect(s.out.at(-1)).toMatch(/verdict must be "pass" or "fail"/);
    await buildProgram(() => s.ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", "simulate", "--population", "400", "--defects", "40", "--runs", "2000"]);
    expect(code).toBe(0);
  });
});
