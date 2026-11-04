import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCheckpoints } from "../src/api/checkpoint.js";
import { checkpointCommand } from "../src/commands/checkpoint.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { runVerify } from "../src/commands/verify.js";
import { sha256Hex } from "../src/core/canonical.js";
import { lineSha256 } from "../src/core/checkpoint.js";
import type { DrawsFile } from "../src/core/records.js";
import { ledgerIndexSha256, type LedgerIndex } from "../src/ledgers/issue-index.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * Findings 3 and 9 of the master review, end to end on a fake GitHub: the draw → issue index is
 * bound to draws.json and checked by verify; checkpoints are chained, must exist after the last
 * counted verdict, and a weaker copy of a checkpoint line never shadows a stronger one.
 */
const W = "audit/2026-q3";
let tsa: MockTsaServer;
let fake: FakeGitHubIssues;
let honest: Scenario;
const alice = { login: "alice", id: 11, type: "User" as const };

const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};
const withToken = (s: Scenario): Scenario => ((s.ctx.env = { GITHUB_TOKEN: "test-token" }), s);
const clone = (s: Scenario) => withToken(cloneScenario(s));
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const check7 = async (s: Scenario) => (await runVerify(s.ctx, {})).checks.find((c) => c.n === 7)!;
const lines = (s: Scenario) => readFileSync(join(s.dir, W, "ledger-checkpoints.jsonl"), "utf8").split("\n").filter(Boolean);

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
  honest.git("commit", "-qam", "ledger: github-issues");
  at(honest, "2026-10-20T00:00:00Z");
  expect(await registerCommand(honest.ctx, {})).toBe(0);
  at(honest, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(honest.ctx, {})).toBe(0);
  at(honest, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(honest.ctx, {})).toBe(0);
  fake.setTime("2026-10-21T02:00:00Z");
  const draws = readJ<DrawsFile>(honest, `${W}/draws.json`);
  for (const d of draws.draws.slice(0, 36)) if (d.firstOccurrence) fake.label(fake.issueByDraw(d.draw).number, "pr-rla:pass", alice);
  honest.git("add", "-A");
  honest.git("commit", "-qm", "draws and ledger index");
}, 120_000);
afterAll(async () => {
  await tsa.stop();
});

describe("the ledger index is bound to the draws (finding 3)", () => {
  it("sample records the index's hash in draws.json", () => {
    const draws = readJ<DrawsFile>(honest, `${W}/draws.json`);
    expect(draws.ledgerIndexSha256).toBe(ledgerIndexSha256(readJ(honest, `${W}/ledger-index.json`)));
  });

  it("an untouched index passes the binding (only the missing checkpoint is reported)", async () => {
    const s = clone(honest);
    at(s, "2026-10-21T03:00:00Z");
    const c = await check7(s);
    expect(c.details.join("\n")).not.toMatch(/ledger-index|draw → issue/);
  });

  it("an edited index (draw 3 pointed at another draw's issue) is a FAIL: the hash differs from the one sample bound", async () => {
    const s = clone(honest);
    const p = join(s.dir, W, "ledger-index.json");
    const idx = JSON.parse(readFileSync(p, "utf8")) as LedgerIndex;
    const one = idx.issues.find((i) => i.draw === 1)!;
    const three = idx.issues.find((i) => i.draw === 3)!;
    three.number = one.number;
    three.id = one.id;
    writeFileSync(p, JSON.stringify(idx, null, 2));
    const c = await check7(s);
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/FAIL ledger-index\.json \(sha256 [0-9a-f]{12}…\) is not the index draws\.json bound at sample time \([0-9a-f]{12}…\): the draw → issue mapping was edited/);
    expect(c.details.join("\n")).toMatch(/same issue number/);
  });

  it("re-binding the edited index in draws.json does not help: the issue's own marker and the draws disagree", async () => {
    const s = clone(honest);
    const p = join(s.dir, W, "ledger-index.json");
    const idx = JSON.parse(readFileSync(p, "utf8")) as LedgerIndex;
    const a = idx.issues.find((i) => i.draw === 2)!;
    const b = idx.issues.find((i) => i.draw === 3)!;
    [a.changeId, b.changeId] = [b.changeId, a.changeId]; // swap which change each issue is for
    writeFileSync(p, JSON.stringify(idx, null, 2));
    const dp = join(s.dir, W, "draws.json");
    const draws = JSON.parse(readFileSync(dp, "utf8")) as DrawsFile;
    draws.ledgerIndexSha256 = ledgerIndexSha256(idx);
    writeFileSync(dp, JSON.stringify(draws, null, 2));
    const c = await check7(s);
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/ledger index: draw #2 is .*, but draws\.json draws .* there/);
  });

  it("a deleted index FAILs; an index draws.json never bound only WARNs", async () => {
    const gone = clone(honest);
    rmSync(join(gone.dir, W, "ledger-index.json"));
    const c = await check7(gone);
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/FAIL ledger-index\.json is missing, but draws\.json bound it at sample time/);
    const old = clone(honest);
    const dp = join(old.dir, W, "draws.json");
    const draws = JSON.parse(readFileSync(dp, "utf8")) as DrawsFile;
    delete draws.ledgerIndexSha256;
    writeFileSync(dp, JSON.stringify(draws, null, 2));
    const c2 = await check7(old);
    expect(c2.details.join("\n")).toMatch(/WARN draws\.json does not record the ledger index's hash/);
  });

  it("the binding is checked offline too (check 7 SKIPs the tracker, not the local hash)", async () => {
    const s = clone(honest);
    const p = join(s.dir, W, "ledger-index.json");
    writeFileSync(p, readFileSync(p, "utf8").replace('"window": "2026-q3"', '"window": "2026-q4"'));
    const r = await runVerify(s.ctx, { offline: true });
    const c = r.checks.find((x) => x.n === 7)!;
    expect(c.status).toBe("FAIL");
    expect(c.details.join("\n")).toMatch(/is not the index draws\.json bound at sample time/);
  });
});

describe("checkpoints (finding 9)", () => {
  it("WARNs when no time-stamped checkpoint post-dates the last counted verdict, and stops when one does", async () => {
    const s = clone(honest);
    at(s, "2026-10-21T03:00:00Z");
    const c = await check7(s);
    expect(c.status).toBe("WARN");
    expect(c.details.join("\n")).toMatch(/WARN no time-stamped ledger checkpoint post-dates the last counted verdict \(2026-10-21T0[0-9]:[0-9:]+Z\); there is none\./);
    expect(await checkpointCommand(s.ctx, {})).toBe(0);
    const c2 = await check7(s);
    expect(c2.status).toBe("PASS");
  });

  it("a checkpoint taken BEFORE the last verdict does not cover it", async () => {
    const s = clone(honest);
    at(s, "2026-10-21T01:30:00Z"); // after sample, before the labels at 02:00
    expect(await checkpointCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-21T03:00:00Z");
    const c = await check7(s);
    expect(c.details.join("\n")).toMatch(/no time-stamped ledger checkpoint post-dates the last counted verdict .*the latest checkpoint is 2026-10-21T01:30:00Z/);
  });

  describe("with three checkpoints", () => {
    let three: Scenario;
    beforeAll(async () => {
      three = clone(honest);
      for (const t of ["2026-10-21T03:00:00Z", "2026-10-21T04:00:00Z", "2026-10-21T05:00:00Z"]) {
        at(three, t);
        expect(await checkpointCommand(three.ctx, {})).toBe(0);
      }
    }, 60_000);

    it("each line carries the hash of the line before it, and the index hash", () => {
      const l = lines(three);
      expect(l).toHaveLength(3);
      const parsed = l.map((x) => JSON.parse(x) as { prevLineSha256?: string | null; ledgerIndexSha256?: string });
      expect(parsed[0]!.prevLineSha256).toBeNull();
      expect(parsed[1]!.prevLineSha256).toBe(lineSha256(l[0]!));
      expect(parsed[2]!.prevLineSha256).toBe(sha256Hex(l[1]!));
      expect(parsed.every((p) => p.ledgerIndexSha256 === ledgerIndexSha256(readJ(three, `${W}/ledger-index.json`)))).toBe(true);
    });

    it("an intact chain passes", async () => {
      const c = await check7(clone(three));
      expect(c.status).toBe("PASS");
    });

    it("deleting the middle line (and its history file) breaks the chain: FAIL", async () => {
      const s = clone(three);
      const l = lines(s);
      writeFileSync(join(s.dir, W, "ledger-checkpoints.jsonl"), `${[l[0], l[2]].join("\n")}\n`);
      const c = await check7(s);
      expect(c.status).toBe("FAIL");
      expect(c.details.join("\n")).toMatch(/FAIL checkpoint file: ledger-checkpoints\.jsonl:2: the chain is broken/);
    });

    it("editing a line breaks the next line's link", async () => {
      const s = clone(three);
      const l = lines(s);
      const edited = JSON.stringify({ ...JSON.parse(l[0]!), count: 0 });
      writeFileSync(join(s.dir, W, "ledger-checkpoints.jsonl"), `${[edited, l[1], l[2]].join("\n")}\n`);
      const c = await check7(s);
      expect(c.status).toBe("FAIL");
      expect(c.details.join("\n")).toMatch(/the chain is broken/);
    });

    it("deleting only the newest line cannot be seen by the chain (the documented limit); the coverage rule is what remains", async () => {
      const s = clone(three);
      const l = lines(s);
      writeFileSync(join(s.dir, W, "ledger-checkpoints.jsonl"), `${[l[0], l[1]].join("\n")}\n`);
      const c = await check7(s);
      expect(c.details.join("\n")).not.toMatch(/chain is broken/);
      expect(c.status).toBe("PASS"); // an earlier checkpoint still post-dates the last verdict
    });

    it("lines written before the chain existed stay readable and are counted as unchained, not as a break", () => {
      const s = clone(three);
      // (Their time-stamp tokens covered the record without the field, so this checks reading, not the tokens.)
      const old = lines(s).map((x) => {
        const o = JSON.parse(x) as Record<string, unknown>;
        delete o.prevLineSha256;
        return JSON.stringify(o);
      });
      writeFileSync(join(s.dir, W, "ledger-checkpoints.jsonl"), `${old.join("\n")}\n`);
      const r = readCheckpoints(join(s.dir, W));
      expect(r.problems).toEqual([]);
      expect(r.unchained).toBe(3);
      expect(r.checkpoints).toHaveLength(3);
    });

    it("a checkpoint line with its time-stamp tokens stripped WARNs, and (being edited) breaks the next link", async () => {
      const s = clone(three);
      const l = lines(s);
      const stripped = JSON.stringify({ ...JSON.parse(l[2]!), timestamps: [] });
      writeFileSync(join(s.dir, W, "ledger-checkpoints.jsonl"), `${[l[0], l[1], stripped].join("\n")}\n`);
      const c = await check7(s);
      expect(c.details.join("\n")).toMatch(/WARN checkpoint 2026-10-21T05:00:00Z carries no time-stamp tokens/);
    });

    it("a changed index since the latest checkpoint WARNs", async () => {
      const s = clone(three);
      const p = join(s.dir, W, "ledger-checkpoints.jsonl");
      const l = lines(s);
      const other = JSON.stringify({ ...JSON.parse(l[2]!), ledgerIndexSha256: "0".repeat(64) });
      // the edited last line has no successor, so the chain does not object; the index hash does
      writeFileSync(p, `${[l[0], l[1], other].join("\n")}\n`);
      const c = await check7(s);
      expect(c.details.join("\n")).toMatch(/WARN the ledger index changed since the latest checkpoint \(2026-10-21T05:00:00Z/);
    });
  });
});
