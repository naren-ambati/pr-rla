import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkpointCommand } from "../src/commands/checkpoint.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { runVerify } from "../src/commands/verify.js";
import { canonicalJson, sha256Hex } from "../src/core/canonical.js";
import { checkpointRecord, type LedgerCheckpointLine } from "../src/core/checkpoint.js";
import type { DrawsFile, TimestampEvidence } from "../src/core/records.js";
import { isoMs, readToken } from "../src/timestamp/verify.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { MockTsaServer, makeTestAuthority, mintResponse, tokenOf, type TestAuthority } from "./helpers/test-tsa.js";

/**
 * Integration: wave 2. Where two merged branches' contracts meet, end to end on the CLI's own
 * command functions over local fixtures (synthetic: a fake GitHub issue tracker, mock timestamp
 * authorities, a local bare audit repo).
 *
 * fix/ledgers-selector × fix/trusted-time: the ledger checkpoints (the chain, the index anchor and
 * the coverage rule) are time-stamped records, so their tokens are judged by the trusted-time rules:
 * only the registration's own authorities count, and the checkpoint's bytes (its index hash too)
 * are what the tokens sign.
 *
 * bolt/u9-presence-verdicts × fix/ledgers-selector: check 7's ledger identity (U9) sits beside the
 * ledger anchors (the index binding is a local file, judged whatever ledger is loaded).
 */
const W = "audit/2026-q3";
let tsa: MockTsaServer;
let unregistered: TestAuthority;
let fake: FakeGitHubIssues;
let labelled: Scenario;
const alice = { login: "alice", id: 11, type: "User" as const };

const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};
const withToken = (s: Scenario): Scenario => ((s.ctx.env = { GITHUB_TOKEN: "test-token" }), s);
const clone = (s: Scenario) => withToken(cloneScenario(s));
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const check7 = async (s: Scenario) => (await runVerify(s.ctx, {})).checks.find((c) => c.n === 7)!;
const cpFile = (s: Scenario) => join(s.dir, W, "ledger-checkpoints.jsonl");
const lines = (s: Scenario) => readFileSync(cpFile(s), "utf8").split("\n").filter(Boolean);

/** A token from `a` over the checkpoint line's time-stamped bytes (the line without its tokens). */
async function tokenFor(a: TestAuthority, line: LedgerCheckpointLine, nonceHex: string): Promise<TimestampEvidence> {
  const der = tokenOf(await mintResponse(a, { digestHex: sha256Hex(canonicalJson(checkpointRecord(line))), nonceHex, genTime: new Date(line.takenAt) }));
  const { facts } = readToken(der);
  return { kind: "rfc3161", tsa: a.id, url: tsa.urlFor(a.id), tokenDer: Buffer.from(der).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce: nonceHex };
}

/** Replaces the newest checkpoint line (it has no successor, so the chain does not object). */
function rewriteNewest(s: Scenario, edit: (line: LedgerCheckpointLine) => LedgerCheckpointLine | Promise<LedgerCheckpointLine>) {
  return (async () => {
    const l = lines(s);
    const newest = await edit(JSON.parse(l.at(-1)!) as LedgerCheckpointLine);
    writeFileSync(cpFile(s), `${[...l.slice(0, -1), JSON.stringify(newest)].join("\n")}\n`);
  })();
}

beforeAll(async () => {
  // test-d is trusted (its root is in the verifier's --tsa-trust) but the registration names only test-a and test-b.
  unregistered = await makeTestAuthority({ id: "test-d", operator: "Operator D" });
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" }), unregistered]).start();
  fake = new FakeGitHubIssues();
  labelled = withToken(
    setupAuditRepo({
      changes: makeChanges(400),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url.startsWith("https://api.github.com/") ? fake.fetch(input, init) : globalThis.fetch(input, init);
      }) as typeof fetch,
      tsa: { ids: ["test-a", "test-b"], server: tsa },
    }),
  );
  appendFileSync(join(labelled.dir, ".pr-rla.yml"), "ledger: { use: github-issues, options: { repo: acme/audit } }\n");
  labelled.git("commit", "-qam", "ledger: github-issues");
  at(labelled, "2026-10-20T00:00:00Z");
  expect(await registerCommand(labelled.ctx, {})).toBe(0);
  at(labelled, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(labelled.ctx, {})).toBe(0);
  at(labelled, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(labelled.ctx, {})).toBe(0);
  fake.setTime("2026-10-21T02:00:00Z");
  for (const d of readJ<DrawsFile>(labelled, `${W}/draws.json`).draws.slice(0, 36)) if (d.firstOccurrence) fake.label(fake.issueByDraw(d.draw).number, "pr-rla:pass", alice);
  labelled.git("add", "-A");
  labelled.git("commit", "-qm", "draws and ledger index");
  at(labelled, "2026-10-21T03:00:00Z"); // after the last verdict (02:00)
  expect(await checkpointCommand(labelled.ctx, {})).toBe(0);
}, 120_000);
afterAll(async () => {
  await tsa.stop();
});

describe("ledger checkpoints under the trusted-time rules (fix/ledgers-selector × fix/trusted-time)", () => {
  it("control: a checkpoint after the last verdict, time-stamped by both registered authorities, covers it and check 7 PASSes", async () => {
    const c = await check7(clone(labelled));
    expect(c.status).toBe("PASS");
    expect(c.details.join("\n")).toMatch(/checkpoint 2026-10-21T03:00:00Z timestamps: 2 of 2 TSAs \(test-a, test-b\) · k = 2 · PROVEN/);
    expect(c.details.join("\n")).not.toMatch(/post-dates the last counted verdict/);
  });

  it("a checkpoint whose only token is from an authority the registration does not name is ignored, so it does not cover the last verdict", async () => {
    const s = clone(labelled);
    await rewriteNewest(s, async (line) => ({ ...line, timestamps: [await tokenFor(unregistered, line, "a1a2a3a4a5a6a7a8")] }));
    const c = await check7(s);
    const d = c.details.join("\n");
    expect(c.status).toBe("WARN");
    expect(c.details).toContain("checkpoint 2026-10-21T03:00:00Z token from test-d ignored (not registered: the registration names test-a, test-b)");
    expect(d).toMatch(/checkpoint 2026-10-21T03:00:00Z timestamps: 0 of 2 TSAs · k = 2 · TIMESTAMP NOT TAMPER-PROOF \(0 of 2\)/);
    // ledgers' coverage rule takes trusted-time's verdict on the tokens, not their presence
    expect(d).toMatch(/WARN no time-stamped ledger checkpoint post-dates the last counted verdict \(2026-10-21T02:[0-9:]+Z\); the latest checkpoint is 2026-10-21T03:00:00Z \(2026-10-21T03:00:00Z carries tokens, but none from a registered authority verified\)/);
  });

  it("the index anchor is inside the time-stamped bytes: editing the newest line's ledgerIndexSha256 FAILs its tokens, not just the index WARN", async () => {
    const s = clone(labelled);
    await rewriteNewest(s, (line) => ({ ...line, ledgerIndexSha256: "0".repeat(64) }));
    const c = await check7(s);
    const d = c.details.join("\n");
    expect(c.status).toBe("FAIL");
    expect(d).toMatch(/FAIL checkpoint 2026-10-21T03:00:00Z token from test-a: rule 2: message imprint .* is not the record digest/);
    expect(d).toMatch(/FAIL checkpoint 2026-10-21T03:00:00Z token from test-b: rule 2: message imprint .* is not the record digest/);
    expect(d).toMatch(/WARN the ledger index changed since the latest checkpoint \(2026-10-21T03:00:00Z/);
    // the edited line's tokens no longer count, so it covers nothing either
    expect(d).toMatch(/WARN no time-stamped ledger checkpoint post-dates the last counted verdict/);
  });
});

describe("the registered ledger and the ledger anchors (bolt/u9-presence-verdicts × fix/ledgers-selector)", () => {
  it("swapping the registered issue ledger for git-file FAILs check 7 on identity, and an edited index still FAILs its binding", async () => {
    const s = clone(labelled);
    const yml = join(s.dir, ".pr-rla.yml");
    writeFileSync(yml, readFileSync(yml, "utf8").replace("ledger: { use: github-issues, options: { repo: acme/audit } }\n", ""));
    const idx = join(s.dir, W, "ledger-index.json");
    writeFileSync(idx, readFileSync(idx, "utf8").replace('"window": "2026-q3"', '"window": "2026-q4"'));
    const c = await check7(s);
    const d = c.details.join("\n");
    expect(c.status).toBe("FAIL");
    expect(d).toMatch(/FAIL the ledger verify loaded is not the registered one \(name github-issues → git-file/);
    expect(d).toMatch(/FAIL ledger-index\.json \(sha256 [0-9a-f]{12}…\) is not the index draws\.json bound at sample time/);
    // git-file has no history to checkpoint, so the issue ledger's coverage rule does not apply to it
    expect(d).not.toMatch(/post-dates the last counted verdict/);
  });
});
