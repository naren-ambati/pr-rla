import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as read from "pr-rla/api/read";
import { status as apiStatus, statusExitCode } from "../src/api/read/status.js";
import { checkpointCommand } from "../src/commands/checkpoint.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify } from "../src/commands/verify.js";
import { check7Gate } from "../src/api/read/ledger-gate.js";
import { configFor, trustFor } from "../src/api/session.js";
import { indexExtensionProblems, issueOrderProblems, publicationFindings, type LedgerPublicationsFile, type SignedPublication } from "../src/core/ledger-publication.js";
import type { DrawsFile, RegistrationRecordV2, SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { ledgerIndexSha256, type LedgerIndex } from "../src/ledgers/issue-index.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * P1, the ledger publication record (pass-2 review #1, the coordinator's decision): `sample` signs the draw → issue
 * index it published and has the registered authorities time-stamp it, before any verdict can exist; check 7 holds
 * the index to it. The reviewer's remap attack (scratchpad rv-pass2-a/integ/test/rv2/remap.test.ts) as tests: 75
 * draws, FAILs on the 5th, 15th and 25th first occurrences; the attacker swaps those three issues with three late
 * passing ones in ledger-index.json. Before P1, B, C and D ended CERTIFIED with checks 1–7 PASS; each FAILs now.
 * Synthetic: a fake GitHub tracker and two mock authorities (test-a ECDSA, test-b RSA).
 */
const W = "audit/2026-q3";
const alice = { login: "alice", id: 11, type: "User" as const };
let tsa: MockTsaServer;
let fake: FakeGitHubIssues;
let honest: Scenario;
let failDraws: number[];
let lateDraws: number[];
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};
const withToken = (s: Scenario): Scenario => ((s.ctx.env = { GITHUB_TOKEN: "test-token" }), s);
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const writeJ = (s: Scenario, p: string, v: unknown) => writeFileSync(join(s.dir, p), JSON.stringify(v, null, 2));
const c7 = async (s: Scenario) => (await runVerify(s.ctx, {})).checks.find((c) => c.n === 7)!;

/** A clone with its own copy of the tracker (the attack edits issue bodies). */
function clone(): Scenario & { fake: FakeGitHubIssues } {
  const s = withToken(cloneScenario(honest));
  const f = fake.clone();
  (s as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith("https://api.github.com/") ? f.fetch(input, init) : globalThis.fetch(input, init);
  }) as typeof fetch;
  s.ctx.fetch = s.fetch;
  return Object.assign(s, { fake: f });
}

beforeAll(async () => {
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  fake = new FakeGitHubIssues();
  honest = withToken(
    setupAuditRepo({
      changes: makeChanges(400),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url.startsWith("https://api.github.com/") ? fake.fetch(input, init) : globalThis.fetch(input, init);
      }) as typeof fetch,
      tsa: { ids: ["test-a", "test-b"], server: tsa },
    }),
  );
  appendFileSync(join(honest.dir, ".pr-rla.yml"), "ledger: { use: github-issues, options: { repo: acme/audit } }\n");
  honest.git("commit", "-qam", "ledger");
  at(honest, "2026-10-20T00:00:00Z");
  expect(await registerCommand(honest.ctx, {})).toBe(0);
  at(honest, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(honest.ctx, {})).toBe(0);
  at(honest, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(honest.ctx, { through: 75 })).toBe(0);
  fake.setTime("2026-10-21T02:00:00Z");
  const draws = readJ<DrawsFile>(honest, `${W}/draws.json`);
  const firsts = draws.draws.slice(0, 75).filter((d) => d.firstOccurrence);
  failDraws = [firsts[4]!.draw, firsts[14]!.draw, firsts[24]!.draw];
  lateDraws = firsts.slice(-3).map((d) => d.draw);
  for (const d of firsts) fake.label(fake.issueByDraw(d.draw).number, failDraws.includes(d.draw) ? "pr-rla:fail" : "pr-rla:pass", alice);
  at(honest, "2026-10-21T03:00:00Z");
  expect(await checkpointCommand(honest.ctx, {})).toBe(0);
  honest.git("add", "-A");
  honest.git("commit", "-qm", "honest");
}, 180_000);
afterAll(async () => {
  await tsa.stop();
});

/** The reviewer's remap: three failing draws' issues swapped (number, id, url) with three late passing ones; draws.json rebound. */
function remap(s: Scenario & { fake: FakeGitHubIssues }, o: { editBodies: boolean; foreign: boolean; rehash?: boolean }) {
  const p = join(s.dir, W, "ledger-index.json");
  const idx = JSON.parse(readFileSync(p, "utf8")) as LedgerIndex & { foreignIssues?: true };
  for (let k = 0; k < 3; k++) {
    const a = idx.issues.find((i) => i.draw === failDraws[k])!;
    const b = idx.issues.find((i) => i.draw === lateDraws[k])!;
    for (const f of ["number", "id", "url"] as const) [(a as unknown as Record<string, unknown>)[f], (b as unknown as Record<string, unknown>)[f]] = [(b as unknown as Record<string, unknown>)[f], (a as unknown as Record<string, unknown>)[f]];
    if (o.editBodies) {
      // The repo admin swaps the two issue bodies (GitHub's REST issue and timeline show no body edit).
      const ia = s.fake.issues.get(a.number as number)!;
      const ib = s.fake.issues.get(b.number as number)!;
      [ia.body, ib.body] = [ib.body, ia.body];
    }
  }
  if (o.foreign) idx.foreignIssues = true;
  writeFileSync(p, JSON.stringify(idx, null, 2));
  if (o.rehash === false) return;
  const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
  writeJ(s, `${W}/draws.json`, { ...draws, ledgerIndexSha256: ledgerIndexSha256(idx) });
}
/** The rest of the attack: the checkpoints that would show the remap deleted, and a fresh one taken. */
async function retakeCheckpoints(s: Scenario) {
  rmSync(join(s.dir, W, "ledger-checkpoints.jsonl"));
  rmSync(join(s.dir, W, "ledger-history"), { recursive: true, force: true });
  at(s, "2026-10-22T00:00:00Z");
  expect(await checkpointCommand(s.ctx, {})).toBe(0);
}

describe("the honest audit", () => {
  it("sample wrote one publication record, signed with the registration's key, both tokens over its digest; check 7 does not FAIL", async () => {
    const f = readJ<LedgerPublicationsFile>(honest, `${W}/ledger-publication.json`);
    expect(f.schema).toBe("pr-rla/ledger-publications/v1");
    expect(f.publications).toHaveLength(1);
    const p = f.publications[0]!;
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(honest, `${W}/registration.json`);
    expect(p.publicKeyPem).toBe(reg.publicKeyPem);
    expect(p.record).toMatchObject({ schema: "pr-rla/ledger-publication/v1", sequence: 1, previousSha256: null, draws: { through: 75 }, registrationSha256: reg.sha256, ledgerIndexSha256: ledgerIndexSha256(readJ(honest, `${W}/ledger-index.json`)), publishedAt: "2026-10-21T01:00:00Z" });
    expect(p.record.ledger).toEqual(reg.record.plugins.ledger);
    expect(p.timestamps.map((t) => t.tsa).sort()).toEqual(["test-a", "test-b"]);
    // Hashes only: each authority got a request naming the record's SHA-256, and nothing else of it.
    const s = withToken(cloneScenario(honest));
    const c = await c7(s);
    expect(c.status).not.toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/ledger publication #1 timestamps: 2 of 2 TSAs \(test-a, test-b\) · k = 2 · PROVEN/);
  });

  it("the sequence escalates (three FAILs), as the reviewer's honest run", async () => {
    const r = await runVerify(withToken(cloneScenario(honest)).ctx, {});
    expect(r.status?.sequence.state).not.toBe("CERTIFIED");
  });
});

describe("the remap attack (pass-2 review #1): B, C and D each end in FAIL", () => {
  it("B: bodies swapped, index swapped and rebound, checkpoints replaced: check 7 FAILs, the index is not an extension of what was published", async () => {
    const s = clone();
    remap(s, { editBodies: true, foreign: false });
    await retakeCheckpoints(s);
    const r = await runVerify(s.ctx, {});
    const c = r.checks.find((x) => x.n === 7)!;
    // Before P1: "B: CERTIFIED 36, checks 1–7 PASS, VERIFIED".
    expect(c.status).toBe("FAIL");
    expect(r.verdict).toBe("FAILED");
    expect(c.details.join("\n")).toMatch(new RegExp(`FAIL the ledger index is not an append-only extension of what was published: draw #${failDraws[0]}: publication #1 lists issue #\\d+ .*, but ledger-index\\.json has #\\d+`));
    expect(c.details.join("\n")).toMatch(/pr-rla opens issues in draw order, so issue numbers rise with the draws; these were swapped or re-pointed/);
  });

  it("C: foreignIssues set, index swapped and rebound, checkpoints replaced: FAIL (the index carries foreignIssues, and is not what was published)", async () => {
    const s = clone();
    remap(s, { editBodies: false, foreign: true });
    await retakeCheckpoints(s);
    const c = await c7(s);
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/FAIL the ledger index carries foreignIssues/);
    expect(c.details.join("\n")).toMatch(/FAIL the ledger index is not an append-only extension of what was published: ledger-index\.json changes "foreignIssues" from publication #1/);
  });

  it("D: foreignIssues and the swap, then `pr-rla sample` (which used to rebind draws.json itself): sample refuses; without foreignIssues too", async () => {
    const s = clone();
    remap(s, { editBodies: false, foreign: true, rehash: false });
    at(s, "2026-10-22T00:00:00Z");
    await expect(sampleCommand(s.ctx, { through: 75 })).rejects.toThrow(/ledger-index\.json carries foreignIssues/);
    const t = clone();
    remap(t, { editBodies: true, foreign: false, rehash: false });
    at(t, "2026-10-22T00:00:00Z");
    await expect(sampleCommand(t.ctx, { through: 75 })).rejects.toThrow(/ledger-index\.json is not an append-only extension of the index ledger-publication\.json published \(draw #\d+: publication #1 lists issue #\d+/);
    // Nothing was rebound or published by the refused runs.
    expect(readJ<DrawsFile>(t, `${W}/draws.json`).ledgerIndexSha256).toBe(readJ<DrawsFile>(honest, `${W}/draws.json`).ledgerIndexSha256);
    expect(readJ<LedgerPublicationsFile>(t, `${W}/ledger-publication.json`).publications).toHaveLength(1);
  });

  it("A (the control): with the honest checkpoint kept, check 7 FAILs too (the checkpoint shows the history changed)", async () => {
    const s = clone();
    remap(s, { editBodies: true, foreign: false });
    const c = await c7(s);
    expect(c.status).toBe("FAIL");
  });
});

describe("rewriting the publication record does not help", () => {
  it("removing ledger-publication.json: the registration requires it, so check 7 FAILs", async () => {
    const s = clone();
    remap(s, { editBodies: true, foreign: false });
    rmSync(join(s.dir, W, "ledger-publication.json"));
    await retakeCheckpoints(s);
    const c = await c7(s);
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/FAIL the registration requires a time-stamped ledger publication record \(ledger-publication\.json\) for this ledger, and there is none/);
  });

  it("a publication made after the verdicts (the file removed, then sample run again): every counted verdict came before it, so each FAILs", async () => {
    // The tool's own path for a publication made late: with no record on file and draws.json bound to the index,
    // sample publishes it now (2026-10-22), after the verdicts (2026-10-21T02:00).
    const s = clone();
    rmSync(join(s.dir, W, "ledger-publication.json"));
    at(s, "2026-10-22T00:00:00Z");
    expect(await sampleCommand(s.ctx, { through: 75 })).toBe(0);
    const p = readJ<LedgerPublicationsFile>(s, `${W}/ledger-publication.json`).publications;
    expect(p.map((x) => x.record.publishedAt)).toEqual(["2026-10-22T00:00:00Z"]);
    const c = await c7(s);
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/FAIL the counted verdict on draw #\d+ \(.*, issue #\d+\) was recorded 2026-10-21T02:\d\d:\d\dZ, but the first publication listing that issue \(#1\) was proven to exist only by 2026-10-22T00:00:/);
  });

  it("a fresh publication of the swapped index: sample will not make it (the issues are out of draw order), and one signed by hand proves nothing", async () => {
    const s = clone();
    remap(s, { editBodies: true, foreign: false });
    rmSync(join(s.dir, W, "ledger-publication.json"));
    at(s, "2026-10-22T00:00:00Z");
    await expect(sampleCommand(s.ctx, { through: 75 })).rejects.toThrow(/not in draw order .*pr-rla opens issues in draw order/);
    expect(existsSync(join(s.dir, W, "ledger-publication.json"))).toBe(false);
    // By hand, with the audit's own key (no authority will vouch for a time before the verdicts).
    const key = loadOrCreateKey(join(s.dir, ".pr-rla", "signing-key.pem"));
    const index = readJ<LedgerIndex>(s, `${W}/ledger-index.json`);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
    const record = { schema: "pr-rla/ledger-publication/v1" as const, window: "2026-q3", registrationSha256: reg.sha256, manifestSha256: draws.manifestSha256, ledger: reg.record.plugins.ledger, sequence: 1, previousSha256: null, draws: { through: 75 }, ledgerIndexSha256: ledgerIndexSha256(index), index, publishedAt: "2026-10-21T01:00:00Z", prRlaVersion: "0.1.0" };
    writeJ(s, `${W}/ledger-publication.json`, { schema: "pr-rla/ledger-publications/v1", publications: [{ ...signRecord(record, key), timestamps: [] }] });
    await retakeCheckpoints(s);
    const c = await c7(s);
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/FAIL ledger-publication\.json publication #1: draw #\d+ is issue #\d+, not after draw #\d+'s #\d+/);
    expect(c.details.join("\n")).toMatch(/FAIL a verdict on draw #\d+ was read from issue #\d+, which no proven \(time-stamped\) publication record lists/);
  });

  it("appending a forged publication #2 holding the swapped index: #2 is not an extension of #1", async () => {
    const s = clone();
    remap(s, { editBodies: true, foreign: false });
    const f = readJ<LedgerPublicationsFile>(s, `${W}/ledger-publication.json`);
    const key = loadOrCreateKey(join(s.dir, ".pr-rla", "signing-key.pem"));
    const index = readJ<LedgerIndex>(s, `${W}/ledger-index.json`);
    const first = f.publications[0]!;
    const forged = { ...signRecord({ ...first.record, sequence: 2, previousSha256: first.sha256, index, ledgerIndexSha256: ledgerIndexSha256(index), publishedAt: "2026-10-22T00:00:00Z" }, key), timestamps: [] };
    writeJ(s, `${W}/ledger-publication.json`, { ...f, publications: [first, forged] });
    const c = await c7(s);
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/FAIL ledger-publication\.json: draw #\d+: publication #1 lists issue #\d+ .*, but publication #2 has #\d+/);
  });

  it("deleting a middle publication or editing one breaks the chain", async () => {
    const s = clone();
    at(s, "2026-10-21T01:30:00Z");
    expect(await sampleCommand(s.ctx, { through: 80 })).toBe(0); // publication #2 (draws 76–80)
    const f = readJ<LedgerPublicationsFile>(s, `${W}/ledger-publication.json`);
    expect(f.publications.map((p) => p.record.sequence)).toEqual([1, 2]);
    writeJ(s, `${W}/ledger-publication.json`, { ...f, publications: [f.publications[1]] });
    expect((await c7(s)).details.join("\n")).toMatch(/FAIL ledger-publication\.json is not append-only: publication #1 says it is #2/);
    writeJ(s, `${W}/ledger-publication.json`, { ...f, publications: [{ ...f.publications[0]!, record: { ...f.publications[0]!.record, draws: { through: 74 } } }, f.publications[1]] });
    expect((await c7(s)).details.join("\n")).toMatch(/FAIL ledger-publication\.json publication #1: signature: record hash/);
  });
});

describe("the legitimate paths", () => {
  it("sample --through more draws appends publication #2, an extension of #1; re-running with nothing new appends nothing", async () => {
    const s = clone();
    at(s, "2026-10-21T01:30:00Z");
    expect(await sampleCommand(s.ctx, { through: 90 })).toBe(0);
    expect(s.out.join("\n")).toMatch(/ledger publication #2: draws 1–90 → audit\/2026-q3\/ledger-publication\.json/);
    expect(await sampleCommand(s.ctx, { through: 90 })).toBe(0);
    const f = readJ<LedgerPublicationsFile>(s, `${W}/ledger-publication.json`);
    expect(f.publications.map((p) => p.record.draws.through)).toEqual([75, 90]);
    expect(f.publications[1]!.record.previousSha256).toBe(f.publications[0]!.sha256);
    expect(indexExtensionProblems(f.publications[0]!.record.index, f.publications[1]!.record.index, { prev: "#1", next: "#2" })).toEqual([]);
    const c = await c7(s);
    expect(c.details.filter((d) => /^FAIL .*publication|append-only/.test(d))).toEqual([]);
  });

  it("a publication short of tokens: sample exits 5 and says to publish again; what it alone binds is INCOMPLETE (not shown false), and a failing token FAILs", async () => {
    const s = clone();
    at(s, "2026-10-21T01:30:00Z");
    tsa.behaviour["test-b"] = { status: 2 };
    try {
      expect(await sampleCommand(s.ctx, { through: 80 })).toBe(5);
    } finally {
      delete tsa.behaviour["test-b"];
    }
    expect(s.out.join("\n")).toMatch(/to make it tamper-proof, publish again \(records are only ever added\) before anyone records a verdict on these issues: pr-rla sample/);
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
    const newFirst = draws.draws.slice(75, 80).find((d) => d.firstOccurrence)!;
    // A reviewer labels the new issues before anyone publishes again.
    s.fake.setTime("2026-10-21T01:40:00Z");
    for (const d of draws.draws.slice(75, 80)) if (d.firstOccurrence) s.fake.label(s.fake.issueByDraw(d.draw).number, "pr-rla:pass", alice);
    const r = await runVerify(s.ctx, {});
    expect(r.status!.sequence.draws).toBeGreaterThanOrEqual(newFirst.draw); // the new verdict is counted
    let c = r.checks.find((x) => x.n === 7)!;
    // Publication #2 has one token of the two required, and none failing: it proves nothing, but shows nothing false.
    expect(c.status).toBe("INCOMPLETE");
    expect(c.details.join("\n")).toMatch(new RegExp(`INCOMPLETE a verdict on draw #${newFirst.draw} was read from issue #\\d+, which only publication #2 lists, and too few registered authorities time-stamped it`));
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.exitCode).toBe(6);
    // The same through check 7's local gate on its own: the audit directory, the registration and the loaded ledger.
    const { config, paths } = configFor(s.ctx);
    const gate = await check7Gate(paths, readJ(s, `${W}/registration.json`), { identity: readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`).record.plugins.ledger, read: null }, trustFor(s.ctx));
    expect(config.ledger.use).toBe("github-issues");
    expect(gate.fails).toEqual([]);
    // (Not read, so no verdict is bound to anything yet: the issues it alone lists are only a WARN.)
    expect(gate.warns.join("\n")).toMatch(/no proven publication record lists/);
    // A token of #2 that fails a rule is shown false: FAIL, as check 1 judges a registration's token.
    const pubs = readJ<{ publications: { timestamps: { tokenDer: string }[] }[] }>(s, `${W}/ledger-publication.json`);
    const t = pubs.publications[1]!.timestamps[0]!;
    t.tokenDer = t.tokenDer.slice(0, 40) + (t.tokenDer[40] === "A" ? "B" : "A") + t.tokenDer.slice(41);
    writeJ(s, `${W}/ledger-publication.json`, pubs);
    c = await c7(s);
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/FAIL ledger publication #2 token from test-a/);
    expect(c.details.join("\n")).toMatch(new RegExp(`FAIL a verdict on draw #${newFirst.draw} was read from issue #\\d+, which no proven \\(time-stamped\\) publication record lists`));
  });

  it("a short publication, then a proven one after the verdict: the order is not established (INCOMPLETE)", async () => {
    const s = clone();
    at(s, "2026-10-21T01:30:00Z");
    tsa.behaviour["test-b"] = { status: 2 };
    try {
      expect(await sampleCommand(s.ctx, { through: 80 })).toBe(5);
    } finally {
      delete tsa.behaviour["test-b"];
    }
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
    const newFirst = draws.draws.slice(75, 80).find((d) => d.firstOccurrence)!;
    s.fake.setTime("2026-10-21T01:40:00Z");
    for (const d of draws.draws.slice(75, 80)) if (d.firstOccurrence) s.fake.label(s.fake.issueByDraw(d.draw).number, "pr-rla:pass", alice);
    at(s, "2026-10-21T01:50:00Z");
    expect(await sampleCommand(s.ctx, { through: 80 })).toBe(0); // publication #3, proven
    const c = await c7(s);
    // Its verdict (01:40) came before the first proven publication listing its issue (#3, 01:50); #2 (signed 01:30) lists it, unproven.
    expect(c.status).toBe("INCOMPLETE");
    expect(c.details.join("\n")).toMatch(new RegExp(`INCOMPLETE the counted verdict on draw #${newFirst.draw} .* was recorded 2026-10-21T01:40:\\d\\dZ, before the first proven publication listing that issue \\(#3, .*\\); publication #2, signed 2026-10-21T01:30:00Z, lists it too`));
  });
});

describe("status shows what verify FAILs, and withholds CERTIFIED (pass-2 review #7; the seam review of 45f1c9d)", () => {
  /** A small audit on its own fake tracker: 40 draws, the 36 counted all PASS but draw 3's FAIL (unless `allPass`); four PASSes beyond the stop. */
  async function seamAudit(o: { allPass?: boolean } = {}) {
    const f2 = new FakeGitHubIssues();
    const s = withToken(
      setupAuditRepo({
        changes: makeChanges(400),
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          return url.startsWith("https://api.github.com/") ? f2.fetch(input, init) : globalThis.fetch(input, init);
        }) as typeof fetch,
        tsa: { ids: ["test-a", "test-b"], server: tsa },
      }),
    );
    appendFileSync(join(s.dir, ".pr-rla.yml"), "ledger: { use: github-issues, options: { repo: acme/audit } }\n");
    s.git("commit", "-qam", "ledger");
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, { through: 40 })).toBe(0);
    f2.setTime("2026-10-21T02:00:00Z");
    const all = readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, 40);
    const ds = all.filter((d) => d.firstOccurrence);
    const third = all.filter((d) => d.firstOccurrence && d.draw <= 36)[2]!;
    for (const d of ds) f2.label(f2.issueByDraw(d.draw).number, d === third && !o.allPass ? "pr-rla:fail" : "pr-rla:pass", alice);
    at(s, "2026-10-21T03:00:00Z");
    expect(await checkpointCommand(s.ctx, {})).toBe(0);
    return { s, fake: f2, third, beyond: ds.filter((d) => d.draw > 36)[0]! };
  }

  it("the seam review's repro (draw 3 pointed at draw 4's issue, foreignIssues in the index): the marker check can no longer be turned off, and status shows check 7's FAILs", async () => {
    const { s, third } = await seamAudit();
    const p = join(s.dir, W, "ledger-index.json");
    const index = JSON.parse(readFileSync(p, "utf8")) as LedgerIndex & { foreignIssues?: true };
    const failing = index.issues.find((i) => i.draw === third.draw)!;
    const passing = index.issues[index.issues.indexOf(failing) + 1]!;
    Object.assign(failing, { number: passing.number, id: passing.id, url: passing.url });
    index.foreignIssues = true;
    writeFileSync(p, JSON.stringify(index, null, 2));
    const st = (await apiStatus(s.ctx, {})) as Extract<Awaited<ReturnType<typeof apiStatus>>, { verdictsRead: true }>;
    // Before P1: "CERTIFIED (risk 5%)" with certificateWithheld [] while verify FAILed check 7.
    expect(st.line).not.toMatch(/CERTIFIED \(risk/);
    expect(st.ledgerGate.fails.join("\n")).toMatch(/the ledger index carries foreignIssues/);
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out.join("\n")).toMatch(/ {2}FAIL the ledger index carries foreignIssues/);
    expect((await runVerify(s.ctx, {})).verdict).toBe("FAILED");
  }, 180_000);

  it("where the sequence certifies but check 7 FAILs locally (a two-sided swap with bodies swapped, rebound): CLI status and read.status withhold the certificate as FAILED, with the lines verify prints", async () => {
    const { s, fake: f2, third, beyond } = await seamAudit();
    const p = join(s.dir, W, "ledger-index.json");
    const index = JSON.parse(readFileSync(p, "utf8")) as LedgerIndex;
    const a = index.issues.find((i) => i.draw === third.draw)!;
    const b = index.issues.find((i) => i.draw === beyond.draw)!;
    for (const k of ["number", "id", "url"] as const) [(a as unknown as Record<string, unknown>)[k], (b as unknown as Record<string, unknown>)[k]] = [(b as unknown as Record<string, unknown>)[k], (a as unknown as Record<string, unknown>)[k]];
    const ia = f2.issues.get(a.number as number)!;
    const ib = f2.issues.get(b.number as number)!;
    [ia.body, ib.body] = [ib.body, ia.body];
    writeFileSync(p, JSON.stringify(index, null, 2));
    writeJ(s, `${W}/draws.json`, { ...readJ<DrawsFile>(s, `${W}/draws.json`), ledgerIndexSha256: ledgerIndexSha256(index) });
    const st = (await apiStatus(s.ctx, {})) as Extract<Awaited<ReturnType<typeof apiStatus>>, { verdictsRead: true }>;
    expect(st.sequence.state).toBe("CERTIFIED");
    // The one certificate rule (time round B): each kind of FAIL the gate finds is a FAILED withholding (exit 1).
    expect(st.line).toMatch(/target reached · CERTIFICATE WITHHELD \(.*verify check 7 would FAIL: the draw → issue publication record FAILs.*\)/);
    expect(st.certificateWithheld).toEqual(expect.arrayContaining(["the draw → issue publication record FAILs", "a ledger checkpoint FAILs"]));
    expect(st.certified).toBe(false);
    expect(st.certificate).toMatchObject({ state: "WITHHELD", withheld: expect.arrayContaining([{ verdict: "FAILED", reason: "verify check 7 would FAIL: the draw → issue publication record FAILs" }]) });
    expect(statusExitCode(st)).toBe(1);
    const rs = (await read.status({ dir: s.dir, offline: false }, { env: s.ctx.env, fetch: s.fetch, nowMs: () => s.clock.now })) as typeof st;
    expect(rs.line).toMatch(/CERTIFICATE WITHHELD \(.*verify check 7 would FAIL: the draw → issue publication record FAILs/);
    expect(rs.certified).toBe(false);
    expect(rs.certificateWithheld).toEqual(st.certificateWithheld);
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    const text = s.out.join("\n");
    expect(text).toMatch(/CERTIFICATE WITHHELD \(.*verify check 7 would FAIL: the draw → issue publication record FAILs/);
    expect(text).toMatch(/ {2}FAIL the ledger index is not an append-only extension of what was published/);
    const v = await runVerify(s.ctx, {});
    expect(v.verdict).toBe("FAILED");
    // The same FAILs, from the same gate.
    const c7d = v.checks.find((c) => c.n === 7)!.details.map((d) => d.replace(/^FAIL /, ""));
    for (const f of st.ledgerGate.fails) expect(c7d).toContain(f);
  }, 180_000);

  it("a certifying audit whose publication is short of tokens: status withholds the certificate as INCOMPLETE (exit 6), and verify's check 7 is INCOMPLETE", async () => {
    const { s } = await seamAudit({ allPass: true });
    const st0 = (await apiStatus(s.ctx, {})) as Extract<Awaited<ReturnType<typeof apiStatus>>, { verdictsRead: true }>;
    expect(st0.certificate.state).toBe("CERTIFIED");
    // One of the publication's two tokens taken away (tokens are outside the signed record): it is short, nothing in it is false.
    const pubs = readJ<{ publications: { timestamps: { tsa: string }[] }[] }>(s, `${W}/ledger-publication.json`);
    pubs.publications[0]!.timestamps = pubs.publications[0]!.timestamps.filter((t) => t.tsa !== "test-b");
    writeJ(s, `${W}/ledger-publication.json`, pubs);
    const st = (await apiStatus(s.ctx, {})) as typeof st0;
    expect(st.sequence.state).toBe("CERTIFIED");
    expect(st.ledgerGate.fails).toEqual([]);
    expect(st.ledgerGate.incompletes.length).toBeGreaterThan(0);
    expect(st.certificate).toMatchObject({ state: "WITHHELD", withheld: [{ verdict: "INCOMPLETE", reason: "verify check 7 would be INCOMPLETE: the draw → issue mapping is not established (a publication short of tokens)" }] });
    expect(st.certified).toBe(false);
    expect(statusExitCode(st)).toBe(6);
    const v = await runVerify(s.ctx, {});
    expect(v.checks.find((c) => c.n === 7)!.status).toBe("INCOMPLETE");
    expect(v.verdict).toBe("INCOMPLETE");
    // The same findings, from the same gate.
    const c7d = v.checks.find((c) => c.n === 7)!.details.map((d) => d.replace(/^INCOMPLETE /, ""));
    for (const f of st.ledgerGate.incompletes) expect(c7d).toContain(f);
  }, 180_000);

  it("offline status (the MCP status tool's default) still runs the local rules", async () => {
    const s = clone();
    remap(s, { editBodies: false, foreign: true });
    const r = await read.status({ dir: s.dir }, { nowMs: () => s.clock.now });
    expect(r).toMatchObject({ phase: "sampled", verdictsRead: false });
    expect((r as unknown as { ledgerGate: { fails: string[] } }).ledgerGate.fails.join("\n")).toMatch(/the ledger index carries foreignIssues/);
  });
});

describe("the rules, unit by unit", () => {
  const issue = (draw: number, number: number) => ({ draw, changeId: `c${draw}`, number, id: String(1000 + number), url: `u${number}`, createdAt: "2026-10-21T01:00:00Z" });
  it("issue numbers rise strictly with the draws; a permutation breaks it, a Jira key is read by its number", () => {
    expect(issueOrderProblems({ issues: [issue(1, 10), issue(2, 11), issue(4, 15)] })).toEqual([]);
    expect(issueOrderProblems({ issues: [issue(1, 10), issue(2, 15), issue(4, 11)] })[0]).toMatch(/draw #4 is issue #11, not after draw #2's #15/);
    expect(issueOrderProblems({ issues: [{ draw: 1, key: "AUD-9" }, { draw: 2, key: "AUD-10" }] })).toEqual([]);
    expect(issueOrderProblems({ issues: [{ draw: 1, key: "AUD-10" }, { draw: 2, key: "AUD-9" }] })).toHaveLength(1);
    expect(issueOrderProblems({ issues: [{ draw: 1, key: "no number" }] })[0]).toMatch(/has no number to order it by/);
  });

  it("an extension keeps every published entry and the header; anything else is listed", () => {
    const a = { ledger: "x", labels: { pass: { id: "1" } }, issues: [issue(1, 10)], repeats: [] };
    expect(indexExtensionProblems(a, { ...a, issues: [issue(1, 10), issue(2, 11)] }, { prev: "p", next: "n" })).toEqual([]);
    expect(indexExtensionProblems(a, { ...a, labels: { pass: { id: "2" } } }, { prev: "p", next: "n" })[0]).toMatch(/n changes "labels" from p/);
    expect(indexExtensionProblems(a, { ...a, issues: [] }, { prev: "p", next: "n" })[0]).toMatch(/draw #1: p lists issue #10, and n lists none/);
  });

  it("a verdict only a publication short of tokens binds is INCOMPLETE; a failing token, or a short listing signed after the verdict, FAILs", () => {
    const key = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "prrla-pub-")), "k.pem"));
    const index = { issues: [issue(1, 10)], repeats: [] };
    const mk = (sequence: number, previousSha256: string | null, publishedAt: string): SignedPublication =>
      ({ ...signRecord({ schema: "pr-rla/ledger-publication/v1" as const, window: "w", registrationSha256: "r", manifestSha256: "m", ledger: null, sequence, previousSha256, draws: { through: 1 }, ledgerIndexSha256: ledgerIndexSha256(index as never), index, publishedAt, prRlaVersion: "0.1.0" }, key), timestamps: [] }) as never;
    const p1 = mk(1, null, "2026-10-21T01:30:00Z");
    const p2 = mk(2, p1.sha256, "2026-10-21T01:50:00Z");
    const verdict = { draw: 1, changeId: "c1", recordedAt: "2026-10-21T01:40:00Z" };
    const base = { required: true, authoritiesRegistered: true, registration: { sha256: "r", publicKeyPem: p1.publicKeyPem, window: "w", ledger: null }, manifestSha256: "m", index: { value: index, sha256: ledgerIndexSha256(index as never) }, draws: [{ draw: 1, changeId: "c1", firstOccurrence: true }], issued: 1, verdictsRead: [verdict], counted: [verdict] };
    const short = { proven: false, boundMs: null, failed: 0 };
    const proven = (at: string) => ({ proven: true, boundMs: Date.parse(at), failed: 0 });
    // #1 short (signed 01:30, before the verdict), #2 proven at 01:50, after it: when the mapping existed is not established.
    let f = publicationFindings({ ...base, file: { publications: [p1, p2], problems: [] }, times: [short, proven("2026-10-21T01:50:00Z")] });
    expect(f.fails).toEqual([]);
    expect(f.incompletes).toEqual([expect.stringMatching(/^the counted verdict on draw #1 \(c1, issue #10\) was recorded 2026-10-21T01:40:00Z, before the first proven publication listing that issue \(#2, 2026-10-21T01:50:00Z\); publication #1, signed 2026-10-21T01:30:00Z, lists it too/)]);
    // Only #1, short: nothing proven lists the issue.
    f = publicationFindings({ ...base, file: { publications: [p1], problems: [] }, times: [short] });
    expect(f.fails).toEqual([]);
    expect(f.incompletes).toEqual([expect.stringMatching(/^a verdict on draw #1 was read from issue #10, which only publication #1 lists, and too few registered authorities time-stamped it/)]);
    // #1 with a failing token: shown false.
    f = publicationFindings({ ...base, file: { publications: [p1], problems: [] }, times: [{ ...short, failed: 1 }] });
    expect(f.incompletes).toEqual([]);
    expect(f.fails).toEqual([expect.stringMatching(/^a verdict on draw #1 was read from issue #10, which no proven \(time-stamped\) publication record lists/)]);
    // #1 short but signed after the verdict, #2 proven after it: the mapping was published after the verdict.
    const late1 = mk(1, null, "2026-10-21T01:45:00Z");
    const late2 = mk(2, late1.sha256, "2026-10-21T01:50:00Z");
    f = publicationFindings({ ...base, file: { publications: [late1, late2], problems: [] }, times: [short, proven("2026-10-21T01:50:00Z")] });
    expect(f.incompletes).toEqual([]);
    expect(f.fails).toEqual([expect.stringMatching(/^the counted verdict on draw #1 \(c1, issue #10\) was recorded 2026-10-21T01:40:00Z, but the first publication listing that issue \(#2\)/)]);
    // A short publication with a problem of its own (another registration) is only wrong, never short.
    f = publicationFindings({ ...base, registration: { ...base.registration, sha256: "other" }, file: { publications: [p1], problems: [] }, times: [short] });
    expect(f.incompletes).toEqual([]);
    expect(f.fails).toEqual(expect.arrayContaining([expect.stringMatching(/names a different registration/), expect.stringMatching(/which no proven \(time-stamped\) publication record lists/)]));
  });

  it("no proven publication: every verdict read FAILs; the registration does not name authorities: a WARN and the signed time", () => {
    const base = {
      required: true,
      registration: { sha256: "r", publicKeyPem: "k", window: "w", ledger: null },
      manifestSha256: "m",
      index: { value: { issues: [issue(1, 10)], repeats: [] }, sha256: "x" },
      draws: [{ draw: 1, changeId: "c1", firstOccurrence: true }],
      issued: 1,
      verdictsRead: [{ draw: 1, changeId: "c1", recordedAt: "2026-10-21T02:00:00Z" }],
      counted: [{ draw: 1, changeId: "c1", recordedAt: "2026-10-21T02:00:00Z" }],
    };
    const none = publicationFindings({ ...base, authoritiesRegistered: true, file: null, times: [] });
    expect(none.fails[0]).toMatch(/requires a time-stamped ledger publication record/);
  });
});

it("an audit sampled before P1 (no publication on file, draws.json bound): sample refuses an index that is not the bound one", async () => {
  const s = clone();
  rmSync(join(s.dir, W, "ledger-publication.json"));
  const p = join(s.dir, W, "ledger-index.json");
  writeFileSync(p, readFileSync(p, "utf8").replace('"window": "2026-q3"', '"window": "2026-q4"'));
  await expect(sampleCommand(s.ctx, { through: 75 })).rejects.toThrow(/ledger-index\.json \(sha256 [0-9a-f]{12}…\) is not the index draws\.json bound/);
  expect(existsSync(join(s.dir, W, "ledger-publication.json"))).toBe(false);
});
