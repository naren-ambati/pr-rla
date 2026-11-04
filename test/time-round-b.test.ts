import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../src/beacon/drand.js";
import type { CommandContext } from "../src/commands/context.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import type { CommitmentRecordV2, DrawsFile, ManifestV2, RegistrationRecordV2, SignedRecord } from "../src/core/records.js";
import { QUICKNET, computeDraws, roundPublishTime } from "../src/core/seed.js";
import { ephemeralKey, loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FIXTURES, recordedBeacon } from "./helpers/fixtures.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * Time round B: regression tests made from the reviewers' reproductions (synthetic: mock authorities on loopback,
 * the recorded drand rounds, json-file over generated changes; nothing leaves the machine).
 *  - time review #2 (rvtime-grind): one registration frozen many times before R gave different draws each time;
 *  - time review #6 (rvtime-late, rvtime-small): VERIFIED / CERTIFIED / exit 0 on unproven times and on skipped checks;
 *  - time review #7 (rvtime-small): a population below the minimum certified through hand-made draws;
 *  - pass-2 review #2 (rv2-v1-steer): a v1 envelope's unverified integratedTime chose R, and check 3 PASSed;
 *  - time review #9: the small verify items.
 * Each fails on integrate/wave2 at 0fa9ad8 and passes after the round (BUILD-NOTES, "P2 time round B").
 */
const W = "audit/2026-q3";
const PROSPECTIVE_R = 32698612; // first round ≥ 24 h after window close (2026-10-01): 2026-10-02T00:00:03Z
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
const writeJ = (s: Scenario, p: string, v: unknown) => writeFileSync(join(s.dir, p), JSON.stringify(v, null, 2));
const proven = (changes = makeChanges(400)) => setupAuditRepo({ changes, tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
async function passAll(s: Scenario, through = 36) {
  for (const d of readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, through)) if (d.firstOccurrence) await recordCommand(s.ctx, String(d.draw), "pass", { reviewer: "r" });
  s.git("add", "-A");
  s.git("commit", "-qm", "verdicts");
}

describe("time review #2: freezing again cannot move a draw (the draws are bound to the registration)", () => {
  it("twelve honest, PROVEN freezes of one registration between close and R give twelve different manifests and identical draws", async () => {
    // 400 changes, the first 40 "known-bad"; the auditee would keep the freeze whose first 36 draws miss them.
    const base = proven(makeChanges(400, { bad: 40 }));
    at(base, "2026-06-20T00:00:00Z"); // prospective
    expect(await registerCommand(base.ctx, {})).toBe(0);
    const runs: { manifest: string; draws: DrawsFile["draws"]; checks: string[]; byManifest: number[] }[] = [];
    for (let i = 0; i < 12; i++) {
      const s = cloneScenario(base);
      at(s, new Date(T("2026-10-01T06:00:00Z") + i * 3_600_000).toISOString()); // one freeze an hour, all before R
      expect(await freezeCommand(s.ctx, {})).toBe(0);
      at(s, "2026-10-02T06:00:00Z"); // R published
      expect(await sampleCommand(s.ctx, {})).toBe(0);
      const m = readJ<ManifestV2>(s, `${W}.manifest.json`);
      const r = await runVerify(s.ctx, { offline: true });
      // What the old derivation would have drawn from this manifest (to show the manifests really differ in what matters).
      const byManifest = computeDraws(recordedBeacon(PROSPECTIVE_R).randomness, m.sha256, m.N, 36).map((d) => d.index);
      runs.push({ manifest: m.sha256, draws: readJ<DrawsFile>(s, `${W}/draws.json`).draws, checks: r.checks.map((c) => `${c.n}:${c.status}`), byManifest });
    }
    expect(new Set(runs.map((r) => r.manifest)).size).toBe(12); // frozenAt differs: twelve manifests
    expect(new Set(runs.map((r) => JSON.stringify(r.byManifest))).size).toBe(12); // the old binding: twelve different draws
    for (const r of runs) expect(r.draws).toEqual(runs[0]!.draws); // the new binding: one set of draws
    for (const r of runs) expect(r.checks.filter((c) => /^[12346]:/.test(c))).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "6:PASS"]);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(base, `${W}/registration.json`);
    expect(runs[0]!.draws.map((d) => d.index)).toEqual(computeDraws(recordedBeacon(PROSPECTIVE_R).randomness, reg.sha256, 400, 144).map((d) => d.index));
  });

  it("unreviewed: no-review: a review object added after landing, between two freezes, changes neither N nor the draws", async () => {
    // The generated PRs carry a bot COMMENTED review at their merge time; a quarter of them get none, so they are in the stratum.
    const changes = makeChanges(200).map((c, i) => (c.kind === "pull_request" && i % 4 === 0 ? { ...c, reviews: [] } : c));
    const s = setupAuditRepo({ changes });
    writeFileSync(join(s.dir, ".pr-rla.yml"), readFileSync(join(s.dir, ".pr-rla.yml"), "utf8").replace("unreviewed: no-human-review", "unreviewed: no-review"));
    s.git("commit", "-qam", "no-review stratum");
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T06:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const first = readJ<ManifestV2>(s, `${W}.manifest.json`);
    expect(first.N).toBeGreaterThan(0);
    // After landing (and before the second freeze), someone leaves a comment on a change in the stratum.
    const target = first.changes.find((c) => c.kind === "pull_request")!.id;
    const cf = readJ<{ changes: typeof changes }>(s, "changes.json");
    cf.changes.find((c) => c.id === target)!.reviews.push({ author: { login: "late", kind: "human" }, state: "COMMENTED", submittedAt: "2026-10-20T08:00:00Z" });
    writeJ(s, "changes.json", cf);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, { force: true })).toBe(0);
    const second = readJ<ManifestV2>(s, `${W}.manifest.json`);
    expect(second.frozenAt).not.toBe(first.frozenAt);
    expect(second.N).toBe(first.N);
    expect(second.changes.map((c) => c.id)).toEqual(first.changes.map((c) => c.id));
  });
});

describe("time review #2's input audit: a label stratum is the one registered input read as of the freeze", () => {
  // This test enshrined check 2's WARN. P5 (finding 4) decided the input must be read at landing: a provider without label
  // history (json-file here) is refused at register; github reads it (test/p5-labels.test.ts).
  it("on a provider without label history the stratum is refused at register (it was a note, and check 2 WARNed)", async () => {
    const s = proven(makeChanges(400, { bad: 40 }));
    writeFileSync(join(s.dir, ".pr-rla.yml"), readFileSync(join(s.dir, ".pr-rla.yml"), "utf8").replace("unreviewed: no-human-review", "unreviewed: no-human-review, labels: [known-bad]"));
    s.git("commit", "-qam", "a label stratum");
    at(s, "2026-10-20T00:00:00Z");
    await expect(registerCommand(s.ctx, {})).rejects.toThrow(/^the stratum selects by labels \(known-bad\), and provider json-file reads no label history: labels can be changed after a change lands/);
    expect(existsSync(join(s.dir, W, "registration.json"))).toBe(false);
  });
});

describe("time review #6: unproven means not certified, and a skipped check is not a verification", () => {
  it("a commitment written after R with its tokens stripped: INCOMPLETE, exit 6, ok false, no CERTIFIED (was VERIFIED, exit 0, CERTIFIED · PROSPECTIVE)", async () => {
    const s = proven();
    at(s, "2026-06-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0); // honest, PROVEN, prospective
    // Real time is after R; the auditee backdates its clock and the authorities are unreachable.
    tsa.behaviour["test-a"] = { fail: 1e9 };
    tsa.behaviour["test-b"] = { fail: 1e9 };
    try {
      s.clock.now = T("2026-10-01T06:00:00Z");
      expect(await freezeCommand(s.ctx, {})).toBe(5);
    } finally {
      delete tsa.behaviour["test-a"];
      delete tsa.behaviour["test-b"];
    }
    s.clock.now = T("2026-10-02T06:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    await passAll(s);
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, {})).toBe(6);
    const text = s.out.join("\n");
    expect(text).toMatch(/^2\. INCOMPLETE manifest before seed: manifest written \(signed time, unproven\) 2026-10-01T06:00:00Z: not shown to precede R$/m);
    expect(text).toMatch(/· target reached · CERTIFICATE WITHHELD \(verify check 2 \(manifest before seed\) incomplete\) · PROSPECTIVE$/m);
    expect(text).not.toMatch(/CERTIFIED \(risk|^VERIFIED$/m);
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, { json: true })).toBe(6);
    const rep = JSON.parse(s.out.join("\n")) as { ok: boolean; verdict: string; exitCode: number; certificate: { state: string; withheld: { verdict: string }[] } };
    expect(rep).toMatchObject({ ok: false, verdict: "INCOMPLETE", exitCode: 6, certificate: { state: "WITHHELD", withheld: [{ verdict: "INCOMPLETE" }] } });
    // status says the same offline, from the commitment's own tokens
    s.out.length = 0;
    expect(await statusCommand(s.ctx, { json: true })).toBe(6);
    expect(JSON.parse(s.out.join("\n"))).toMatchObject({ certificate: { state: "WITHHELD", withheld: [{ verdict: "INCOMPLETE", reason: "manifest commitment time unproven (TIMESTAMP NOT TAMPER-PROOF (0 of 2))" }, { verdict: "INCOMPLETE", reason: "population not verified: run `pr-rla verify`" }] } });
  });

  it("verify --offline before sample: checks 4–7 skip, so INCOMPLETE, exit 6 (was VERIFIED, exit 0)", async () => {
    const s = proven();
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, { offline: true })).toBe(6);
    expect(s.out.slice(0, 1)).toEqual(["1. PASS registration: registration after window close → RETROSPECTIVE (a demonstration)"]);
    expect(s.out.at(-1)).toBe("INCOMPLETE: check 4 (BLS), check 5 (population), check 6 (draws), check 7 (labels) skipped; nothing failed, but this is not a verification (exit 6)");
    const r = await runVerify(s.ctx, { offline: true });
    expect(r).toMatchObject({ ok: false, verdict: "INCOMPLETE", exitCode: 6, certificate: null });
  });

  it("offline after sample: only check 5's rebuild is skipped, and that alone is INCOMPLETE; online the same audit is VERIFIED and CERTIFIED", async () => {
    const s = proven();
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    await passAll(s);
    const off = await runVerify(s.ctx, { offline: true });
    expect(off.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:SKIP", "6:PASS", "7:PASS"]);
    expect(off).toMatchObject({ verdict: "INCOMPLETE", exitCode: 6, certificate: { state: "WITHHELD", withheld: [{ verdict: "INCOMPLETE", reason: "verify check 5 (population) skipped" }] } });
    const on = await runVerify(s.ctx, {});
    expect(on).toMatchObject({ verdict: "VERIFIED", ok: true, exitCode: 0, certificate: { state: "CERTIFIED", withheld: [] } });
    expect(on.statusLine).toMatch(/· CERTIFIED \(risk 5%\) · RETROSPECTIVE$/);
    // status never rebuilds the population, so the same audit, with nothing else withholding it, is not certified there (final fix round).
    s.out.length = 0;
    expect(await statusCommand(s.ctx, {})).toBe(6);
    expect(s.out[0]).toMatch(/target reached · CERTIFICATE WITHHELD \(population not verified: run `pr-rla verify`\) · RETROSPECTIVE$/);
    expect(s.out[0]).not.toMatch(/CERTIFIED \(risk/);
  });
});

describe("time review #7: a population below the registered minimum never certifies", () => {
  it("N = 100 < 150: sample refuses; hand-made draws make verify FAIL check 6 (exit 1) and status refuse (exit 3, in --json too)", async () => {
    const s = proven(makeChanges(100));
    at(s, "2026-06-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-01T06:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-02T06:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(3);
    // The auditee writes the draws itself, correctly derived, and records 36 passes.
    const m = readJ<ManifestV2>(s, `${W}.manifest.json`);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
    const beacon = recordedBeacon(PROSPECTIVE_R);
    const seen = new Set<string>();
    const draws = computeDraws(beacon.randomness, reg.sha256, m.N, 144).map((d) => {
      const c = m.changes[d.index]!;
      const firstOccurrence = !seen.has(c.id);
      seen.add(c.id);
      return { draw: d.draw, index: d.index, changeId: c.id, url: c.url, mergeSha: c.mergeSha, firstOccurrence };
    });
    const file: DrawsFile = { schema: "pr-rla/draws/v1", repo: "acme/widgets", window: "2026-q3", manifestSha256: m.sha256, N: m.N, round: PROSPECTIVE_R, beacon, chainHash: QUICKNET.chainHash, issued: 36, cap: 144, draws };
    writeJ(s, `${W}/draws.json`, file);
    at(s, "2026-10-02T08:00:00Z");
    await passAll(s);
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, {})).toBe(1);
    expect(s.out.join("\n")).toMatch(/^6\. FAIL draws: population 100 < the registered minimum 150: the registration says review all 100 instead; no draw may count$/m);
    expect(s.out.join("\n")).not.toMatch(/CERTIFIED \(risk|^VERIFIED$/m);
    expect(s.out.at(-1)).toBe("FAILED: check 6 (draws)");
    const t = cloneScenario(s);
    expect(await statusCommand(t.ctx, { json: true })).toBe(3);
    expect(JSON.parse(t.out.join("\n"))).toMatchObject({ refusal: "population 100 < 150: review all 100 instead", certificate: { state: "REFUSED" } });
    const u = cloneScenario(s);
    expect(await statusCommand(u.ctx, {})).toBe(3);
    expect(u.out).toEqual(["population 100 < 150: review all 100 instead"]);
  });

  it("below the minimum and never sampled: check 6 says why there are no draws, and nothing certifies", async () => {
    const s = proven(makeChanges(100));
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const r = await runVerify(s.ctx, {});
    expect(r.checks[5]).toMatchObject({ status: "SKIP", summary: "population 100 < the registered minimum 150: the registration says review all 100 instead (no draws)" });
    expect(r.verdict).toBe("INCOMPLETE");
  });
});

describe("pass-2 review #2: a v1 envelope's unverified integratedTime cannot choose R", () => {
  const LOG_KEY = join(FIXTURES, "log-keys", "v1-retrospective-mock-rekor.pub");
  function v1Audit(): { dir: string; ctx: CommandContext; git: (...a: string[]) => void } {
    const dir = mkdtempSync(join(tmpdir(), "prrla-v1s-"));
    cpSync(join(FIXTURES, "audits", "v1-retrospective-2026-q3"), dir, { recursive: true });
    const git = (...a: string[]) => void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    const ctx: CommandContext = {
      cwd: dir,
      env: {},
      nowMs: () => T("2026-11-03T00:00:00Z"),
      fetch: globalThis.fetch,
      out: () => {},
      err: () => {},
      beacon: async (round) => {
        if (T("2026-11-03T00:00:00Z") / 1000 < roundPublishTime(round)) throw new RoundNotYetPublished(round, 0);
        const b = recordedBeacon(round);
        if (!(await verifyQuicknetBeacon(b, round))) throw new Error("bad beacon");
        return b;
      },
    };
    return { dir, ctx, git };
  }

  it("R moved from 33,245,812 to 33,244,800 by editing the envelope and re-signing: without the log's key, check 3 is INCOMPLETE and nothing certifies (it was PASS, CERTIFIED, VERIFIED, exit 0); with it, FAIL", async () => {
    const a = v1Audit();
    const NEW = 33244800;
    const rj = (p: string) => JSON.parse(readFileSync(join(a.dir, p), "utf8"));
    const wj = (p: string, v: unknown) => writeFileSync(join(a.dir, p), JSON.stringify(v, null, 2));
    const reg = rj(`${W}/registration.json`);
    reg.log.integratedTime = roundPublishTime(NEW) - 86400; // the unsigned envelope's time
    const key = ephemeralKey();
    wj(`${W}/registration.json`, { ...signRecord(reg.record, key), log: reg.log });
    const cm = rj(`${W}/manifest-commitment.json`);
    wj(`${W}/manifest-commitment.json`, { ...signRecord({ ...cm.record, seedRound: NEW, seedRoundPublishesAt: new Date(roundPublishTime(NEW) * 1000).toISOString().replace(".000Z", "Z") }, key), log: cm.log });
    const draws = rj(`${W}/draws.json`);
    const m = rj("audit/2026-q3.manifest.json");
    const b = recordedBeacon(NEW);
    const seen = new Set<string>();
    draws.round = NEW;
    draws.beacon = b;
    // v1 keeps the old derivation (the manifest's hash), as the v1 audit was drawn.
    draws.draws = computeDraws(b.randomness, m.sha256, m.N, draws.cap).map((d) => {
      const c = m.changes[d.index];
      const f = !seen.has(c.id);
      seen.add(c.id);
      return { draw: d.draw, index: d.index, changeId: c.id, url: c.url, mergeSha: c.mergeSha, firstOccurrence: f };
    });
    wj(`${W}/draws.json`, draws);
    const protocolSha256 = reg.record.protocolSha256;
    const lines = draws.draws.slice(0, draws.issued).filter((d: { firstOccurrence: boolean }) => d.firstOccurrence).map((d: { changeId: string; draw: number }) => JSON.stringify({ changeId: d.changeId, draw: d.draw, protocolSha256, recordedAt: "2026-10-21T03:00:00Z", reviewer: "outside-reviewer", schema: "pr-rla/verdict/v1", verdict: "pass" }));
    writeFileSync(join(a.dir, W, "verdicts.jsonl"), `${lines.join("\n")}\n`);
    a.git("add", "-A");
    a.git("commit", "-qm", "v1 audit, steered before the first commit");
    const r = await runVerify(a.ctx, {});
    expect(r.derivedRound).toBe(NEW);
    // Check 6 is INCOMPLETE too since P5: a v1 audit's draws are bound to the manifest (legacy schema).
    expect(r.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:INCOMPLETE", "2:INCOMPLETE", "3:INCOMPLETE", "4:PASS", "5:PASS", "6:INCOMPLETE", "7:PASS"]);
    expect(r.checks[2]!.details.join("\n")).toMatch(/INCOMPLETE R is derived from the registration time .*\(no transparency-log entry verified under a trusted key\): it could have been written after round 33,244,800 was public, to choose R/);
    expect(r).toMatchObject({ ok: false, verdict: "INCOMPLETE", exitCode: 6, certificate: { state: "WITHHELD" } });
    expect(r.statusLine).not.toMatch(/CERTIFIED \(/);
    const withKey = await runVerify(a.ctx, { logKey: [`http://127.0.0.1:61085=${LOG_KEY}`] });
    expect(withKey.checks.slice(0, 2).map((c) => c.status)).toEqual(["FAIL", "FAIL"]);
    expect(withKey.verdict).toBe("FAILED");
  });
});

describe("time review #9: the small verify items", () => {
  async function sampled(s = proven()): Promise<Scenario> {
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    return s;
  }
  let base: Scenario;
  beforeAll(async () => {
    base = await sampled();
  });

  it("check 2 names how many operators time-stamped the commitment, and k (it said 'by k of n', swapped)", async () => {
    // k = 1 with both authorities accepted: 2 operators, k = 1.
    const s = setupAuditRepo({ changes: makeChanges(400), tsa: { ids: ["test-a", "test-b"], k: 1, server: tsa } });
    await sampled(s);
    const c2 = (await runVerify(s.ctx, { offline: true })).checks[1]!;
    expect(c2.summary).toMatch(/^manifest logged by 2 operators \(k = 1\) by 2026-10-20T12:00:\d\dZ, before R$/);
  });

  it("check 6 compares every entry and needs every issued draw: an empty draws[], a dropped issued draw, a duplicate or a changed entry FAIL", async () => {
    const good = (await runVerify(cloneScenario(base).ctx, { offline: true })).checks[5]!;
    expect(good).toMatchObject({ status: "PASS", summary: "36/36 draws reproduce" });
    expect(good.details).toEqual(["144 draw(s) in the file compared, every one reproduces: SHA-256(randomness ‖ registrationSha256 ‖ uint64be(i)) mod N over the 400 changes in canonical order (by draw key: the registered path, or a rule pool's repo id)"]);
    const edit = async (f: (d: DrawsFile) => void) => {
      const s = cloneScenario(base);
      const d = readJ<DrawsFile>(s, `${W}/draws.json`);
      f(d);
      writeJ(s, `${W}/draws.json`, d);
      return (await runVerify(s.ctx, { offline: true })).checks[5]!;
    };
    const empty = await edit((d) => (d.draws = []));
    expect(empty.status).toBe("FAIL");
    expect(empty.details).toContain("FAIL draws file lists no draws");
    expect(empty.details).toContain("FAIL draws file lists 0 of the 36 issued draws (missing #1, #2, #3, #4, #5, …)");
    const dropped = await edit((d) => (d.draws = d.draws.filter((x) => x.draw !== 7)));
    expect(dropped).toMatchObject({ status: "FAIL", summary: "draws file lists 35 of the 36 issued draws (missing #7)" });
    const twice = await edit((d) => d.draws.push({ ...d.draws[0]! }));
    expect(twice.details).toContain("FAIL draws file lists draw #1 twice");
    const changed = await edit((d) => (d.draws[3]!.url = "https://example.invalid/"));
    expect(changed).toMatchObject({ status: "FAIL", summary: "1 draws do not reproduce" });
    const none = await edit((d) => (d.issued = 0));
    expect(none.details).toContain("FAIL draws file issues 0 draws: sample issues at least one");
  });

  it("check 2 compares the manifest's frozenAt with the commitment's: a single repo signs both at one time", async () => {
    const s = cloneScenario(base);
    const p = `${W}/manifest-commitment.json`;
    const cm = readJ<SignedRecord<CommitmentRecordV2>>(s, p);
    const later = "2026-10-20T13:00:00Z";
    writeJ(s, p, { ...signRecord({ ...cm.record, frozenAt: later }, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem"))), timestamps: cm.timestamps });
    const c2 = (await runVerify(s.ctx, { offline: true })).checks[1]!;
    expect(c2.status).toBe("FAIL");
    expect(c2.details).toContain(`commitment dated ${later}, but a single-repo freeze signs it at the manifest's own time 2026-10-20T12:00:00Z`);
  });

  it("check 1 re-derives the window's opensAt and closesAt from its days", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    const p = `${W}/registration.json`;
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, p);
    const key = loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem"));
    writeJ(s, p, { ...signRecord({ ...reg.record, window: { ...reg.record.window, closesAt: "2026-09-01T00:00:00Z" } }, key), timestamps: [] });
    const c1 = (await runVerify(s.ctx, { offline: true })).checks[0]!;
    expect(c1.status).toBe("FAIL");
    expect(c1.details).toContain("FAIL the registered window 2026-q3 says 2026-07-01T00:00:00Z..2026-09-01T00:00:00Z, but its days 2026-07-01..2026-09-30 resolve to 2026-07-01T00:00:00Z..2026-10-01T00:00:00Z");
  });

  it("the registration names its signing key inside its signed, time-stamped bytes: re-signing it under another key FAILs check 1", async () => {
    const s = cloneScenario(base);
    const p = `${W}/registration.json`;
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, p);
    expect(reg.record.publicKeyPem).toBe(reg.publicKeyPem);
    // The same record (so the same digest, and the same tokens still match it), signed by someone else.
    const other = ephemeralKey();
    writeJ(s, p, { ...signRecord(reg.record, other), timestamps: reg.timestamps });
    const r = await runVerify(s.ctx, { offline: true });
    expect(r.checks[0]!.status).toBe("FAIL");
    expect(r.checks[0]!.details).toContain("FAIL the registration was re-signed: its envelope's key is not the signing key the registration names (publicKeyPem, inside the signed and time-stamped bytes)");
    expect(r.timestamps.registration!.proven).toBe(true); // the tokens are over the same digest: only the key binding catches it
    // A registration without the field can be re-keyed: since P5 (finding 10) check 1 FAILs it (it WARNed).
    const { publicKeyPem: _k, ...old } = reg.record;
    writeJ(s, p, { ...signRecord(old, other), timestamps: [] });
    const w = (await runVerify(s.ctx, { offline: true })).checks[0]!;
    expect(w.status).toBe("FAIL");
    expect(w.details).toContain("FAIL the registration does not name its signing key (publicKeyPem, inside the signed and time-stamped bytes): anyone can re-sign it under another key, and the commitment's key is then checked only against this envelope");
    // P5: the field stripped while the old tokens are kept: the tokens no longer match the digest, and the key is missing.
    const stripped = signRecord(old, other);
    writeJ(s, p, { ...stripped, timestamps: reg.timestamps });
    const k = (await runVerify(s.ctx, { offline: true })).checks[0]!;
    expect(k.status).toBe("FAIL");
    expect(k.details).toContain("FAIL the registration does not name its signing key (publicKeyPem, inside the signed and time-stamped bytes): anyone can re-sign it under another key, and the commitment's key is then checked only against this envelope");
    expect(k.details.filter((d) => /^FAIL registration token from test-[ab]: rule 2/.test(d))).toHaveLength(2);
  });
});

describe("seam review: one display decision for CERTIFIED (status, verify's line, audit_list, the MCP objects, --json)", () => {
  it("verify FAILED with the SPRT at its target: the line is WITHHELD naming the failed check, certified false; sequence.state stays the raw SPRT state", async () => {
    const s = proven();
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    await passAll(s);
    // A rewritten git-file history (a line taken out and put back): check 7 FAILs, while every verdict still reads pass.
    const p = join(s.dir, W, "verdicts.jsonl");
    const lines = readFileSync(p, "utf8");
    writeFileSync(p, lines.split("\n").slice(1).join("\n"));
    s.git("commit", "-qam", "a line taken out");
    writeFileSync(p, lines);
    s.git("commit", "-qam", "and put back");
    const r = await runVerify(s.ctx, {});
    expect(r.verdict).toBe("FAILED");
    expect(r.status!.sequence.state).toBe("CERTIFIED"); // the SPRT's own state, documented as raw
    expect(r.certified).toBe(false);
    expect(r.certificate).toEqual({ state: "WITHHELD", withheld: [{ verdict: "FAILED", reason: "verify check 7 (labels) FAILED" }] });
    expect(r.statusLine).toMatch(/· target reached · CERTIFICATE WITHHELD \(verify check 7 \(labels\) FAILED\) · RETROSPECTIVE$/);
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, {})).toBe(1);
    expect(s.out.join("\n")).not.toMatch(/CERTIFIED \(risk/);
    s.out.length = 0;
    expect(await verifyCommand(s.ctx, { json: true })).toBe(1);
    expect(JSON.parse(s.out.join("\n"))).toMatchObject({ verdict: "FAILED", certified: false, certificate: { state: "WITHHELD" } });
  });

  it("audit_list's certified is status's certified: false while the times are unproven AND when they are proven (status never rebuilds the population); only verify certifies", async () => {
    // Through the audit API with the scenario's context (it carries the mock authorities' trust, as --tsa-trust would).
    const { status } = await import("../src/api/read/status.js");
    const { auditList } = await import("../src/api/read/audit-list.js");
    for (const [scenario, timesProven] of [[setupAuditRepo({ changes: makeChanges(400) }), false], [proven(), true]] as const) {
      at(scenario, "2026-10-20T00:00:00Z");
      expect(await registerCommand(scenario.ctx, {})).toBe(0);
      at(scenario, "2026-10-20T12:00:00Z");
      expect(await freezeCommand(scenario.ctx, {})).toBe(0);
      at(scenario, "2026-10-21T01:00:00Z");
      expect(await sampleCommand(scenario.ctx, {})).toBe(0);
      await passAll(scenario);
      const st = (await status(scenario.ctx, { offline: true })) as { certified: boolean; sequence: { state: string }; certificate: { state: string; withheld: { reason: string }[] } };
      const al = await auditList(scenario.ctx);
      expect(st.sequence.state).toBe("CERTIFIED");
      expect(st.certified).toBe(false);
      expect(st.certificate.state).toBe("WITHHELD");
      expect(st.certificate.withheld.map((w) => w.reason)).toContain("population not verified: run `pr-rla verify`");
      // The times: proven only in the scenario that carries the authorities' trust, and then the standing reason is the only one.
      expect(st.certificate.withheld).toHaveLength(timesProven ? 1 : 3);
      expect(al.windows[0]!.certified).toBe(false);
      // verify is where CERTIFIED comes from: online, with the times proven.
      const v = await runVerify(scenario.ctx, {});
      expect(v.certified).toBe(timesProven);
    }
  });
});
