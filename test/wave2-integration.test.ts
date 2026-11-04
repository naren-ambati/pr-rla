import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointCommand } from "../src/commands/checkpoint.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { runVerify, verifyExitCode } from "../src/commands/verify.js";
import { canonicalJson, sha256Hex } from "../src/core/canonical.js";
import { checkpointRecord, type LedgerCheckpointLine } from "../src/core/checkpoint.js";
import { buildPooledPopulation } from "../src/core/population.js";
import { rebuildRepo } from "../src/core/rebuild.js";
import { hostedProvider, startPluginHost } from "../src/plugins/host.js";
import { readGrants, resolvePlugin } from "../src/plugins/lock.js";
import { normalizeSelector } from "../src/core/selector.js";
import type { ScmProvider } from "../src/sdk/provider.js";
import type { DrawsFile, TimestampEvidence } from "../src/core/records.js";
import { ledgerIndexSha256, type LedgerIndex } from "../src/ledgers/issue-index.js";
import { isoMs, readToken } from "../src/timestamp/verify.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { fakeOrg, orgSpec, type FakeOrg } from "./helpers/fake-org.js";
import { setupPoolAudit, type PoolScenario } from "./helpers/pool-scenario.js";
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
 *
 * bolt/u8-org-pooled-freeze × fix/ledgers-selector: the ledger index binds pooled draws (repo-qualified
 * change ids across the org's repos), and a FAIL in check 7 outranks U8's INCOMPLETE in check 5.
 *
 * fix/plugins-broker × bolt/u8-org-pooled-freeze: U8's error fields (status, rateLimited) cross the
 * plugin host on pr-rla/ipc/v2, so check 5's rebuild tells a rate limit from a missing repository.
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

describe("the ledger index anchor with pooled draws (bolt/u8-org-pooled-freeze × fix/ledgers-selector)", () => {
  let org: FakeOrg;
  let tracker: FakeGitHubIssues;
  let pool: PoolScenario;
  const IDX = "audit/2026-q3/ledger-index.json";
  const readP = <X>(p: string) => JSON.parse(readFileSync(join(pool.dir, p), "utf8")) as X;
  /** `github:acme-org/svc-01#12` or `github:acme-org/svc-01@<sha>` → `acme-org/svc-01`. */
  const repoOf = (changeId: string) => changeId.replace(/^[^:]+:/, "").replace(/[#@].*$/, "");
  const verifyPool = () => pool.clock.run(runVerify(pool.ctxFor(route), { offline: false }));
  /** The org's repos go to the synthetic org; the audit repo's issues to the fake tracker (both api.github.com). */
  const route = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).pathname.startsWith("/repos/acme/audit") ? tracker.fetch(input, init) : org.fetch(input, init);
  }) as typeof fetch;

  beforeAll(async () => {
    org = fakeOrg(orgSpec({ eligible: 8 }));
    tracker = new FakeGitHubIssues();
    pool = setupPoolAudit(org, { extra: "ledger: { use: github-issues, options: { repo: acme/audit } }" });
    const ctx = pool.ctxFor(route);
    expect(await pool.clock.run(registerCommand(ctx, {}))).toBe(0);
    await pool.advance(12 * 3600_000);
    expect(await pool.clock.run(freezeCommand(ctx, {}))).toBe(0);
    await pool.advance(13 * 3600_000); // 2026-10-21T01:00Z: R has published
    expect(await pool.clock.run(sampleCommand(ctx, { through: 30 }))).toBe(0);
    tracker.setTime("2026-10-21T02:00:00Z");
    for (const d of readP<DrawsFile>("audit/2026-q3/draws.json").draws.slice(0, 30)) if (d.firstOccurrence) tracker.label(tracker.issueByDraw(d.draw).number, "pr-rla:pass", alice);
    pool.git("add", "-A");
    pool.git("commit", "-qm", "pooled draws and ledger index");
  }, 180_000);

  it("a pooled build refuses a pinned head that is not a commit id, before asking the provider (the ledger round's headSha rule, now in U8's per-repo listing)", async () => {
    let asked = 0;
    const provider = { name: "github", listChanges: async () => (asked++, { changes: [], defaultBranch: "main", limitations: [] }) } as unknown as ScmProvider;
    const args = { window: { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" }, selector: normalizeSelector({ kinds: ["pull_request"], unreviewed: "no-human-review" }), cutoffIso: "2026-10-20T00:00:00Z" };
    await expect(buildPooledPopulation(provider, { repos: [{ repo: "acme-org/svc-00", head: "HEAD~1" }], ...args })).rejects.toThrow(/the pinned default-branch head "HEAD~1" is not a commit id/);
    expect(asked).toBe(0);
    await buildPooledPopulation(provider, { repos: [{ repo: "acme-org/svc-00", head: "0".repeat(40) }], ...args });
    expect(asked).toBe(1);
  });

  it("sample binds the index to draws across the pool's repos, and check 7's binding and check 5 both pass", async () => {
    const draws = readP<DrawsFile>("audit/2026-q3/draws.json");
    const index = readP<LedgerIndex>(IDX);
    expect(draws.ledgerIndexSha256).toBe(ledgerIndexSha256(index));
    expect(new Set(index.issues.map((i) => repoOf(i.changeId))).size).toBeGreaterThan(1); // the draws span the pool's repos
    const r = await verifyPool();
    const c5 = r.checks.find((c) => c.n === 5)!;
    const c7 = r.checks.find((c) => c.n === 7)!;
    expect(c5.status).toBe("PASS");
    expect(c7.status).not.toBe("FAIL");
    expect(c7.details.join("\n")).not.toMatch(/ledger-index|draw → issue/);
    expect(r.verdict).toBe("VERIFIED");
  });

  it("an index edited across repos FAILs check 7 even while a gone repo makes check 5 INCOMPLETE: the verdict is FAILED, exit 1", async () => {
    const idxPath = join(pool.dir, IDX);
    const original = readFileSync(idxPath, "utf8");
    try {
      const index = JSON.parse(original) as LedgerIndex;
      const a = index.issues[0]!;
      const b = index.issues.find((i) => repoOf(i.changeId) !== repoOf(a.changeId))!;
      [a.changeId, b.changeId] = [b.changeId, a.changeId]; // two draws' changes swapped between repos
      writeFileSync(idxPath, JSON.stringify(index, null, 2));
      const gone = readP<{ changes: { repo: string }[] }>("audit/2026-q3.manifest.json").changes[0]!.repo.split("/")[1]!;
      org.removeRepo(gone);
      const r = await verifyPool();
      expect(r.checks.find((c) => c.n === 5)!.status).toBe("INCOMPLETE");
      const c7 = r.checks.find((c) => c.n === 7)!;
      expect(c7.status).toBe("FAIL");
      expect(c7.details.join("\n")).toMatch(/FAIL ledger-index\.json \(sha256 [0-9a-f]{12}…\) is not the index draws\.json bound at sample time/);
      expect(r.verdict).toBe("FAILED");
      expect(r.ok).toBe(false);
      expect(verifyExitCode(r)).toBe(1);
    } finally {
      writeFileSync(idxPath, original);
    }
  });
});

describe("U8's error fields over pr-rla/ipc/v2 (fix/plugins-broker × bolt/u8-org-pooled-freeze)", () => {
  const PLUGIN = `import { defineProvider } from "pr-rla/provider";
if (process.env.PR_RLA_HOST !== "1") throw new Error("imported outside the plugin host");
export default defineProvider({
  providerApiVersion: 1,
  name: "limited",
  hosts: () => [],
  create: () => ({
    apiVersion: 1,
    name: "limited",
    async listChanges() {
      throw Object.assign(new Error("API rate limit exceeded"), { code: "HTTP_ERROR", status: 403, rateLimited: true });
    },
    async describeRepo(ref) {
      return { repo: ref.repo, id: "7", defaultBranch: "main", archived: false, fork: false, visibility: "public" };
    },
  }),
});
`;

  it("an isolated provider's rate-limited 403 reaches the rebuild with its status and flag: INCOMPLETE (run verify again), not a FAIL or a gone repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-wave2-limited-"));
    mkdirSync(join(dir, "limited"));
    writeFileSync(join(dir, "limited", "package.json"), JSON.stringify({ name: "limited-provider", version: "0.0.1", type: "module" }));
    writeFileSync(join(dir, "limited", "index.mjs"), PLUGIN);
    const plugin = resolvePlugin("./limited/index.mjs", dir);
    const host = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label: "limited" });
    try {
      const provider = await hostedProvider(host, {}, { cwd: dir, fetch: globalThis.fetch, log: () => {} });
      const window = { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" };
      await expect(provider.listChanges({ repo: "acme/a", window, kinds: ["pull_request"] })).rejects.toMatchObject({ status: 403, rateLimited: true });
      const r = await rebuildRepo(provider, { repo: "acme/a", frozenHead: "a".repeat(40), frozenEmpty: false, window, selector: normalizeSelector({ kinds: ["pull_request"], unreviewed: "no-human-review" }) });
      expect(r.fail).toEqual([]);
      expect(r.incomplete).toEqual([expect.stringMatching(/^could not be listed \(.*API rate limit exceeded.*\): a rate limit or an outage, not a missing repository; run verify again$/)]);
    } finally {
      host.close();
    }
  });
});
