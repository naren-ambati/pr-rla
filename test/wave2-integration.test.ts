import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as read from "pr-rla/api/read";
import { recordCommand } from "../src/commands/record.js";
import { checkpointCommand } from "../src/commands/checkpoint.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyExitCode } from "../src/commands/verify.js";
import { canonicalJson, sha256Hex } from "../src/core/canonical.js";
import { checkpointRecord, type LedgerCheckpointLine } from "../src/core/checkpoint.js";
import { buildPooledPopulation } from "../src/core/population.js";
import { rebuildRepo } from "../src/core/rebuild.js";
import { hostedProvider, startPluginHost } from "../src/plugins/host.js";
import { readGrants, resolvePlugin } from "../src/plugins/lock.js";
import { approveBuiltin } from "../src/plugins/approvals.js";
import { normalizeSelector } from "../src/core/selector.js";
import type { ScmProvider } from "../src/sdk/provider.js";
import type { DrawsFile, ManifestV2, TimestampEvidence } from "../src/core/records.js";
import { ledgerIndexSha256, type LedgerIndex } from "../src/ledgers/issue-index.js";
import { isoMs, readToken } from "../src/timestamp/verify.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { FakeGitHubIssues } from "./helpers/fake-issue-trackers.js";
import { fakeOrg, orgSpec, ORG, type FakeOrg } from "./helpers/fake-org.js";
import { setupPoolAudit, type PoolScenario } from "./helpers/pool-scenario.js";
import { MockTsaServer, makeTestAuthority, mintResponse, tokenOf, type TestAuthority } from "./helpers/test-tsa.js";
import { classificationScenario, fakeGitHub } from "./helpers/fake-github.js";
import { commitAll } from "./helpers/signed-commits.js";
import { makeTestKey, type TestKey } from "./helpers/sshsig-signer.js";
import { NAMESPACE } from "./helpers/verdict-lines.js";
import { PRESENCE_LIMIT } from "../src/core/presence/index.js";

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
 *
 * bolt/u5-audit-api-mcp × the rest, through `pr-rla/api/read` (the functions the MCP tools call; the
 * MCP package's own wave-2 test drives the tools themselves): U9's per-verdict signatures in status and
 * the draw context, and read-only mode under this machine's approvals (the plugins round).
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
    expect(d).toMatch(/WARN no time-stamped ledger checkpoint post-dates the last counted verdict \(2026-10-21T02:[0-9:]+Z\); the latest checkpoint is 2026-10-21T03:00:00Z \(2026-10-21T03:00:00Z carries tokens, but they do not prove, by k registered authorities, that it existed at or after the last verdict\)/);
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
    expect(d).toMatch(/FAIL the ledger in \.pr-rla\.yml is not the registered one \(name github-issues → git-file/);
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
    // The binding passes; the one line about the mapping is P1's: this pool registers no authority, so its publication is not time-stamped.
    expect(c7.details.filter((d) => /ledger-index|draw → issue/.test(d))).toEqual([expect.stringMatching(/^WARN the ledger publication records are not time-stamped \(the registration names no timestamp authority\)/)]);
    // Time round B: the pool's times are self-asserted (no timestamp authority), so checks 1–3 are INCOMPLETE and the
    // verdict is INCOMPLETE; every other check passes.
    expect(r.checks.filter((c) => c.status === "INCOMPLETE" || c.status === "SKIP" || c.status === "FAIL").map((c) => `${c.n}:${c.status}`)).toEqual(["1:INCOMPLETE", "2:INCOMPLETE", "3:INCOMPLETE"]);
    expect(r.verdict).toBe("INCOMPLETE");
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

describe("per-verdict signatures through pr-rla/api/read: status and the draw context (bolt/u5-audit-api-mcp × bolt/u9-presence-verdicts)", () => {
  const keys: Record<string, TestKey> = {};
  let keysDir: string;
  let s: Scenario;
  let signedDraws: number[];
  const readOpts = () => ({ nowMs: () => s.clock.now, fetch: s.fetch, env: s.ctx.env });

  beforeAll(async () => {
    keysDir = mkdtempSync(join(tmpdir(), "prrla-wave2-keys-"));
    for (const [name, type] of [["bob", "sk-ssh-ed25519@openssh.com"], ["alice", "ssh-ed25519"]] as const) {
      keys[name] = makeTestKey(type);
      writeFileSync(join(keysDir, `${name}.pub`), `${keys[name].publicText} ${name}\n`); // public halves only
    }
    s = setupAuditRepo({ changes: makeChanges(200) });
    appendFileSync(join(s.dir, ".pr-rla.yml"), `ledger: git-file\nverdicts: { min_provenance: account, allowed_signers: [${JSON.stringify(keys.bob!.allowedSigner("bob", `namespaces="${NAMESPACE}"`))}, ${JSON.stringify(keys.alice!.allowedSigner("alice"))}] }\n`);
    s.git("commit", "-qam", "signed verdicts");
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    s.git("add", "-A");
    s.git("commit", "-qm", "registration, manifest, draws");
    // The reviewers sign one verdict each with record --sign (a software-emulated authenticator stands in for ssh-keygen, D7).
    s.ctx.signVerdict = async (payload, path) => keys[basename(path)]!.sign(payload, { namespace: NAMESPACE, flags: 0x01, counter: 1 });
    s.clock.now = T("2026-10-21T03:00:00Z");
    const first = readJ<DrawsFile>(s, "audit/2026-q3/draws.json").draws.filter((d) => d.firstOccurrence).slice(0, 3);
    signedDraws = first.slice(0, 2).map((d) => d.draw);
    expect(await recordCommand(s.ctx, String(first[0]!.draw), "pass", { sign: join(keysDir, "bob") })).toBe(0);
    commitAll(s.dir, "verdict by bob", null);
    expect(await recordCommand(s.ctx, String(first[1]!.draw), "pass", { sign: join(keysDir, "alice") })).toBe(0);
    commitAll(s.dir, "verdict by alice", null);
    s.out.length = 0;
    expect(await recordCommand(s.ctx, String(first[2]!.draw), "pass", { reviewer: "carol" })).toBe(0);
    // record says what status then does with the line: it is ignored, with the rule (min_provenance account and registered keys).
    expect(s.out).toContainEqual(expect.stringMatching(/^this verdict is not signed, so it is ignored and does not count: the registration counts only verdicts signed with their reviewer's registered key \(min_provenance is account\); record it again with --sign /));
    commitAll(s.dir, "an unsigned verdict", null);
  }, 120_000);

  it("status counts each signed verdict at the level its signature proves, ignores the unsigned one with its reason, and carries no signature field", async () => {
    const r = await read.status({ dir: s.dir }, readOpts());
    expect(r).toMatchObject({ phase: "sampled", verdictsRead: true, minProvenance: "account" });
    if (r.phase !== "sampled" || !r.verdictsRead) throw new Error("not sampled");
    // Keys are registered and the minimum is above self-asserted, so carol's unsigned line is
    // ineligible (fix/p4-ledger-path): ignored with its reason, not counted below the minimum.
    expect(Object.fromEntries(r.provenance.map((p) => [p.level, p.count]))).toEqual({ presence: 1, account: 1 });
    expect(r.belowMinimum).toEqual([]);
    expect(r.ignored.filter((i) => i.event.reviewer === "carol")).toEqual([{ event: expect.objectContaining({ reviewer: "carol", verdict: "pass" }), reason: "carries no signature, and the registration counts only verdicts signed with their reviewer's registered key" }]);
    expect(r.verdictNotes).toContain(PRESENCE_LIMIT); // the T16 limit, wherever presence is counted
    expect(JSON.stringify(r)).not.toMatch(/sshsig|registrationSha256":"[0-9a-f]{64}","reviewer/);
  });

  it("the draw context shows a signed verdict's level, keeps who recorded it in the fence, and carries no signature", async () => {
    const bob = await read.drawContext({ dir: s.dir, draw: signedDraws[0]! }, readOpts());
    expect(bob.state).toMatchObject({ read: true, verdict: "pass", provenance: "presence" });
    expect(bob.untrusted.verdict).toMatchObject({ reviewer: "bob" });
    const alice = await read.drawContext({ dir: s.dir, draw: signedDraws[1]! }, readOpts());
    expect(alice.state).toMatchObject({ read: true, verdict: "pass", provenance: "account" });
    for (const c of [bob, alice]) expect(JSON.stringify(c)).not.toMatch(/sshsig|U1NIU0lH/); // no SSHSIG blob ("SSHSIG" in base64) anywhere
  });
});

describe("read-only mode honours this machine's approvals (bolt/u5-audit-api-mcp × fix/plugins-broker)", () => {
  it("a GitHub Enterprise Server audit read through pr-rla/api/read: unapproved, it runs anonymously; approved, the token reaches ghe.example.com and nowhere else", async () => {
    const sc = classificationScenario();
    const ghe = fakeGitHub(sc.repo, sc.head, sc.commits, sc.prs, { restBase: "https://ghe.example.com/api/v3" });
    const seen: { url: string; auth: string | null }[] = [];
    const fetch = (async (input: string | URL, init?: RequestInit) => (seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") }), ghe.fetch(input as never, init as never))) as typeof globalThis.fetch;
    const s = setupAuditRepo({ changes: [] });
    const yml = join(s.dir, ".pr-rla.yml");
    writeFileSync(yml, readFileSync(yml, "utf8").replace("provider: { use: json-file, options: { path: changes.json } }", "provider: { use: github, options: { base_url: https://ghe.example.com } }").replace("window: { name: 2026-q3, start: 2026-07-01, end: 2026-09-30 }", "window: { name: 2026-08-01, start: 2026-08-01, end: 2026-08-01 }"));
    s.git("commit", "-qam", "a GitHub Enterprise Server audit");
    const file = join(mkdtempSync(join(tmpdir(), "prrla-wave2-approvals-")), "approvals.json");
    const log: string[] = [];
    const opts = { nowMs: () => T("2026-08-03T00:00:00Z"), fetch, env: { GH_ENTERPRISE_TOKEN: "ghe_OPERATOR_SECRET", PR_RLA_APPROVALS_FILE: file }, log: (l: string) => log.push(l) };

    const anonymous = await read.freezePreview({ dir: s.dir }, opts);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((x) => x.auth !== null)).toEqual([]);
    expect(log.join("\n")).toMatch(/GH_ENTERPRISE_TOKEN -> https:\/\/ghe\.example\.com is not approved on this machine, so withheld .*pr-rla plugin approve github/);

    approveBuiltin(file, "GH_ENTERPRISE_TOKEN", "https://ghe.example.com", "2026-08-03T00:00:00Z");
    seen.length = 0;
    const approved = await read.freezePreview({ dir: s.dir }, opts);
    expect(approved.N).toBe(anonymous.N);
    expect([...new Set(seen.map((x) => x.auth))]).toEqual(["Bearer ghe_OPERATOR_SECRET"]);
    expect([...new Set(seen.map((x) => new URL(x.url).host))]).toEqual(["ghe.example.com"]);
    expect(JSON.stringify(approved)).not.toContain("ghe_OPERATOR_SECRET");
  });
});

describe("check 7's git-file gate through pr-rla/api/read: status withholds CERTIFIED where verify FAILs (bolt/u5-audit-api-mcp × fix/p4-ledger-path)", () => {
  it("a committed ledger line removed later: the sequence certifies, but read.status withholds the certificate, naming check 7, and read.verify FAILs check 7 (exit 1)", async () => {
    // Two registered timestamp authorities. The CLI's context trusts their roots, so there the times are proven and only
    // check 7 can withhold; pr-rla/api/read trusts only the shipped anchors, so there the times stay unproven (time round B).
    const s = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
    appendFileSync(join(s.dir, ".pr-rla.yml"), "ledger: git-file\n");
    s.git("commit", "-qam", "a git-file ledger");
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-21T01:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    s.git("add", "-A");
    s.git("commit", "-qm", "registration, manifest, draws");
    const ledger = join(s.dir, W, "verdicts.jsonl");
    const protocolSha256 = readJ<{ record: { protocolSha256: string } }>(s, `${W}/registration.json`).record.protocolSha256;
    const line = (d: { draw: number; changeId: string }) => `${JSON.stringify({ schema: "pr-rla/verdict/v1", draw: d.draw, changeId: d.changeId, verdict: "pass", protocolSha256, reviewer: "bob", recordedAt: "2026-10-21T03:00:00Z" })}\n`;
    const first = readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, 36).filter((d) => d.firstOccurrence);
    for (const d of first) appendFileSync(ledger, line(d));
    commitAll(s.dir, "bob's verdicts", null);
    at(s, "2026-10-21T04:00:00Z");
    const opts = { nowMs: () => s.clock.now, fetch: s.fetch, env: s.ctx.env };

    const UNPROVEN = [
      { verdict: "INCOMPLETE", reason: "registration time unproven (TIMESTAMP NOT TAMPER-PROOF (0 of 2))" },
      { verdict: "INCOMPLETE", reason: "manifest commitment time unproven (TIMESTAMP NOT TAMPER-PROOF (0 of 2))" },
    ];
    const cliStatus = async () => {
      const from = s.out.length;
      const code = await statusCommand(s.ctx, { json: true });
      return { code, json: JSON.parse(s.out.slice(from).join("\n")) as { certified: boolean; certificate: unknown; line: string } };
    };

    const honest = await read.status({ dir: s.dir }, opts);
    if (honest.phase !== "sampled" || !honest.verdictsRead) throw new Error("not sampled");
    expect(honest.sequence.state).toBe("CERTIFIED");
    expect(honest).toMatchObject({ certified: false, certificate: { state: "WITHHELD", withheld: UNPROVEN }, certificateWithheld: [], ledgerIntegrity: { ok: true, fails: [] } });
    const honestCli = await cliStatus();
    expect(honestCli.code).toBe(0);
    expect(honestCli.json).toMatchObject({ certified: true, certificate: { state: "CERTIFIED", withheld: [] } });
    expect(honestCli.json.line).toMatch(/· CERTIFIED \(risk /);
    // A context that trusts nothing beyond the shipped bundle proves the times only with the anchors given to status
    // as --tsa-trust, as verify's (the wave-2 integration added the option: a certificate needs its times proven).
    const trustFile = join(mkdtempSync(join(tmpdir(), "prrla-wave2-trust-")), "tsa-trust.json");
    writeFileSync(trustFile, JSON.stringify(tsa.trust()));
    const bare = { ...s.ctx, tsaTrust: [] };
    const bareStatus = async (o: { tsaTrust?: string[] }) => {
      const from = s.out.length;
      const code = await statusCommand(bare, { json: true, ...o });
      return { code, json: JSON.parse(s.out.slice(from).join("\n")) as { certified: boolean; certificate: { state: string } } };
    };
    expect(await bareStatus({})).toMatchObject({ code: 6, json: { certified: false, certificate: { state: "WITHHELD" } } });
    expect(await bareStatus({ tsaTrust: [trustFile] })).toMatchObject({ code: 0, json: { certified: true, certificate: { state: "CERTIFIED" } } });

    // A second line is appended and committed, then taken out again: the committed history is rewritten.
    appendFileSync(ledger, line(first[0]!));
    commitAll(s.dir, "a second pass for the first draw", null);
    writeFileSync(ledger, first.map(line).join(""));
    const rewrite = commitAll(s.dir, "the line taken out again", null);

    const r = await read.status({ dir: s.dir }, opts);
    if (r.phase !== "sampled" || !r.verdictsRead) throw new Error("not sampled");
    expect(r.sequence.state).toBe("CERTIFIED"); // the SPRT's raw state: the counting alone would certify
    expect(r.certificateWithheld).toEqual(["the ledger's integrity check FAILs"]);
    expect(r.ledgerIntegrity).toMatchObject({ ok: false, fails: [`${W}/verdicts.jsonl was rewritten (not appended) in commit ${rewrite.slice(0, 10)}`] });
    // P4's gate through time round B's one certificate: withheld as FAILED, the reason naming check 7, beside the times.
    const CHECK7 = { verdict: "FAILED", reason: "verify check 7 would FAIL: the ledger's integrity check FAILs" };
    expect(r).toMatchObject({ certified: false, certificate: { state: "WITHHELD", withheld: [...UNPROVEN, CHECK7] } });
    expect(r.line).toMatch(/target reached · CERTIFICATE WITHHELD \(.*verify check 7 would FAIL: the ledger's integrity check FAILs\)/);
    const tamperedCli = await cliStatus();
    expect(tamperedCli.code).toBe(1); // a withholding a check would FAIL exits as verify would
    expect(tamperedCli.json).toMatchObject({ certified: false, certificate: { state: "WITHHELD", withheld: [CHECK7] } });
    expect(tamperedCli.json.line).toMatch(/target reached · CERTIFICATE WITHHELD \(verify check 7 would FAIL: the ledger's integrity check FAILs\)/);

    const v = await read.verify({ dir: s.dir, offline: true }, opts);
    expect(v).toMatchObject({ ok: false, verdict: "FAILED", exitCode: 1 });
    expect(v.checks.find((c) => c.n === 7)).toMatchObject({ status: "FAIL" });
  }, 120_000);
});

describe("P3's push-log proof and verify's per-repo lines through pr-rla/api/read (bolt/u5-audit-api-mcp × fix/p3-pool-head)", () => {
  it("a public-only rule over a 30-repo GitHub org: the write API records every head's push-log evidence; read.verify, in read-only mode, proves each head from the log and carries check 5's per-repo lines in `verbose` (the MCP verify tool's object)", async () => {
    const org = fakeOrg(orgSpec({ eligible: 30, archived: 2, forks: 1, scale: 2 }));
    const s = setupPoolAudit(org, { repos: `{ owner: ${ORG}, visibility: [public] }` });
    expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
    await s.advance(12 * 3600_000);
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    const m = JSON.parse(readFileSync(join(s.dir, "audit/2026-q3.manifest.json"), "utf8")) as ManifestV2;
    expect(m.headEvidence!.map((e) => [e.repo, e.headSha, e.status])).toEqual(m.repos.map((r) => [r.repo, r.headSha, "tip"]));

    const seen: { method: string; path: string; auth: string | null }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      seen.push({ method: init?.method ?? "GET", path: url.pathname, auth: new Headers(init?.headers).get("authorization") });
      return org.fetch(input, init);
    }) as typeof globalThis.fetch;
    const r = await s.clock.run(read.verify({ dir: s.dir, offline: false }, { nowMs: () => s.clock.now(), sleep: (ms) => s.clock.sleep(ms), fetch, env: s.ctx.env }));
    const c5 = r.checks.find((c) => c.n === 5)!;
    expect(c5.details).toContain(`push log: ${m.repos.length} of ${m.repos.length} frozen head(s) were their default branch's tip at freeze`);
    const hidden = org.spec.repos.filter((x) => (x.visibility ?? "public") !== "public" && !x.archived && !x.fork).map((x) => `${ORG}/${x.name}`);
    expect(c5.details.filter((d) => d.startsWith("WARN "))).toHaveLength(1);
    expect(c5.verbose!.map((l) => /^WARN repo (\S+)/.exec(l)![1]).sort()).toEqual(hidden.sort());
    // Read-only: every request was a read, each push log among them, with the default token swapped in on its origin.
    expect(seen.filter((x) => x.method !== "GET" && !(x.method === "POST" && x.path === "/graphql"))).toEqual([]);
    expect(seen.filter((x) => /\/activity$/.test(x.path)).length).toBeGreaterThanOrEqual(m.repos.length);
    expect(new Set(seen.map((x) => x.auth))).toEqual(new Set(["Bearer synthetic-token-not-real"]));
    expect(JSON.stringify(r)).not.toContain("synthetic-token-not-real");
  }, 180_000);
});
