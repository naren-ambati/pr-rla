import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { runVerify } from "../src/commands/verify.js";
import { obtainTimestamps } from "../src/api/write/timestamps.js";
import { trustFor } from "../src/api/session.js";
import { manifestSha256, compareChangeIds, type CommitmentRecordV2, type ManifestV2, type RegistrationRecordV2, type SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import gitHub from "../src/providers/github/index.js";
import jsonFile from "../src/providers/json-file.js";
import type { ChangeRecord } from "../src/sdk/provider.js";
import { makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { classificationScenario, fakeGitHub } from "./helpers/fake-github.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * P5, "draws that cannot be steered", finding 2 (the second review's `rvp2-alias`, synthetic: the json-file export and a
 * fake GitHub, mock authorities, the recorded beacon). Before, verify matched the selector's logins through aliases it
 * read from the manifest's own change records: a manifest naming a copilot change's author `claude[bot]` under copilot's
 * account id widened N from 120 to 360 and check 5 PASSed; the same worked on `bots:`. Now `register` resolves every login
 * the selector names to an account id through the provider and signs the map (`accounts`); selection and verify match
 * those entries by id only, and check 2 re-applies the registered selector to the manifest's own records.
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
const setSelector = (s: Scenario, selector: string) => {
  const path = join(s.dir, ".pr-rla.yml");
  writeFileSync(path, readFileSync(path, "utf8").replace(/^selector: .*$/m, `selector: ${selector}`));
  s.git("commit", "-qam", "selector");
};

/** makeChanges with account ids: claude[bot] is 1001, copilot-swe-agent[bot] 2002, maint 5 (a merger) and the reviewer bot 79. */
const withIds = (changes: ChangeRecord[]) => {
  const ids: Record<string, string> = { "claude[bot]": "1001", "copilot-swe-agent[bot]": "2002", maint: "5", "copilot-pull-request-reviewer[bot]": "79" };
  const id = (a: ChangeRecord["author"]) => (ids[a.login] ? { ...a, id: ids[a.login] } : a);
  return changes.map((c) => ({ ...c, author: c.kind === "pull_request" ? id(c.author) : c.author, mergedBy: c.mergedBy ? id(c.mergedBy) : null, reviews: c.reviews.map((r) => ({ ...r, author: id(r.author) })) }));
};

/** The auditee's second manifest, re-committed and re-stamped before R: `extra` added, the manifest re-hashed. */
async function widen(s: Scenario, extra: ChangeRecord[]): Promise<ManifestV2> {
  const honest = readJ<ManifestV2>(s, `${W}.manifest.json`);
  const all = [...honest.changes, ...extra].sort((a, b) => compareChangeIds(a.id, b.id));
  const { sha256: _o, ...body0 } = honest;
  const body = { ...body0, changes: all, N: all.length };
  const m = { ...body, sha256: manifestSha256(body as never) } as ManifestV2;
  writeFileSync(join(s.dir, `${W}.manifest.json`), JSON.stringify(m, null, 2));
  const cmPath = join(s.dir, W, "manifest-commitment.json");
  const cm0 = JSON.parse(readFileSync(cmPath, "utf8")) as SignedRecord<CommitmentRecordV2>;
  const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
  let signed = signRecord({ ...cm0.record, manifestSha256: m.sha256, N: m.N }, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem")));
  signed = { ...signed, timestamps: (await obtainTimestamps(s.ctx, signed, cm0.record.frozenAt, reg.record.timestamping, trustFor(s.ctx))).timestamps };
  writeFileSync(cmPath, JSON.stringify(signed, null, 2));
  return m;
}

describe("P5 finding 2: the selector's logins are bound to account ids at register, never read from a manifest", () => {
  it("rvp2-alias (authors): a copilot change re-attributed to claude[bot] under copilot's id: check 2 and check 5 FAIL (was PASS, N 120 -> 360)", async () => {
    const changes = withIds(makeChanges(400));
    const s = setupAuditRepo({ changes, tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
    setSelector(s, '{ kinds: [pull_request], authors: ["claude[bot]"], unreviewed: no-human-review }');
    at(s, "2026-06-20T00:00:00Z"); // prospective
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(s.out).toContain("  accounts: claude[bot] = id 1001 (signed in: the selector matches them by account id only)");
    expect(readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`).record.accounts).toEqual([{ login: "claude[bot]", id: "1001" }]);
    at(s, "2026-10-01T06:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const honest = readJ<ManifestV2>(s, `${W}.manifest.json`);
    expect(honest.N).toBe(120);
    // The reviewer's second manifest: copilot's changes too, the first of them naming its author "claude[bot]".
    const extra = changes.filter((c) => c.kind === "pull_request" && c.author.id === "2002").map((c, i) => (i === 0 ? { ...c, author: { ...c.author, login: "claude[bot]" } } : c));
    const m = await widen(s, extra);
    expect(m.N).toBe(360);
    at(s, "2026-10-02T06:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    const r = await runVerify(s.ctx, {});
    expect(r.checks[1]!.status).toBe("FAIL");
    expect(r.checks[1]!.details).toContain(`manifest lists 240 change(s) the registered selector does not select, applied to the manifest's own records with the registration's account ids (e.g. ${extra.map((c) => c.id).sort(compareChangeIds).slice(0, 3).join(", ")})`);
    expect(r.checks[4]!.status).toBe("FAIL");
    expect(r.checks[4]!.summary).toBe(`population: 240 changes in the manifest are not in the rebuilt population (e.g. ${extra.map((c) => c.id).sort(compareChangeIds).slice(0, 3).join(", ")})`);
    expect(r.verdict).toBe("FAILED");
  });

  it("the same trick on bots: a human merger re-labelled with the registered bot's login: check 5 FAILs (was PASS)", async () => {
    // Every PR merged by maint (5) except the last 40, merged by a human, carol (6).
    const changes = withIds(makeChanges(400)).map((c, i) => (c.kind === "pull_request" && i >= 360 ? { ...c, mergedBy: { login: "carol", kind: "human" as const, id: "6" } } : c));
    const s = setupAuditRepo({ changes, tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
    setSelector(s, '{ kinds: [pull_request], authors: any, unreviewed: any, merged_by: bot, bots: ["maint"] }');
    at(s, "2026-06-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`).record.accounts).toEqual([{ login: "maint", id: "5" }]);
    at(s, "2026-10-01T06:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const honest = readJ<ManifestV2>(s, `${W}.manifest.json`);
    // carol's PRs, their merger named "maint" (kind bot, as the bot list would have made it) under carol's account id.
    const extra = changes.filter((c) => c.mergedBy?.id === "6").map((c) => ({ ...c, mergedBy: { login: "maint", kind: "bot" as const, id: "6" } }));
    expect(extra.length).toBeGreaterThan(0);
    const m = await widen(s, extra);
    expect(m.N).toBe(honest.N + extra.length);
    at(s, "2026-10-02T06:00:00Z");
    expect(await sampleCommand(s.ctx, {})).toBe(0);
    const r = await runVerify(s.ctx, {});
    // Offline, check 2 cannot see it: the manifest's own record calls the merger a bot. The rebuild matches "maint" by the
    // signed id 5 only, so carol (6) stays human and her changes are not in the stratum.
    expect(r.checks[4]!.status).toBe("FAIL");
    expect(r.checks[4]!.summary).toMatch(new RegExp(`^population: ${extra.length} changes in the manifest are not in the rebuilt population`));
    expect(r.verdict).toBe("FAILED");
  });

  it("an account renamed after registration still matches by the signed id; check 5 says so", async () => {
    const s = setupAuditRepo({ changes: withIds(makeChanges(400)) });
    setSelector(s, '{ kinds: [pull_request, direct_push], authors: ["claude[bot]"], unreviewed: no-human-review }');
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const N = readJ<ManifestV2>(s, `${W}.manifest.json`).N;
    const cf = readJ<{ changes: ChangeRecord[] }>(s, "changes.json");
    writeFileSync(join(s.dir, "changes.json"), JSON.stringify({ ...cf, changes: cf.changes.map((c) => (c.author.id === "1001" ? { ...c, author: { ...c.author, login: "claude-code[bot]" } } : c)) }));
    const c5 = (await runVerify(s.ctx, { offline: false })).checks[4]!;
    expect(c5.status).toBe("PASS");
    expect(c5.summary).toBe(`population ${N}/${N} match`);
    expect(c5.details).toContain("1 account(s) renamed since registration, matched by the account id the registration signed: claude[bot] → claude-code[bot]");
  });

  it("a provider that cannot resolve a login: a prospective registration is refused, nothing written; a retrospective one WARNs at register and in check 2", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400), tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } }); // no account ids in the export
    setSelector(s, '{ kinds: [pull_request], authors: ["claude[bot]"], unreviewed: no-human-review }');
    at(s, "2026-06-20T00:00:00Z");
    await expect(registerCommand(s.ctx, {})).rejects.toThrow(/^a prospective registration binds every login its selector names to an account id, so that no login written onto another account's change, and no account renamed, can move a change in or out of the stratum; claude\[bot\]: .*changes\.json records no account id for claude\[bot\]\. Nothing was written: name those accounts by id \("id:<account id>" entries in authors or bots\), or use a provider that resolves logins$/);
    expect(readFileSync(join(s.dir, ".pr-rla.yml"), "utf8")).toContain("claude[bot]");
    expect(() => readJ(s, `${W}/registration.json`)).toThrow();
    at(s, "2026-10-20T00:00:00Z"); // retrospective
    s.out.length = 0;
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(s.out.some((l) => l.startsWith("  WARNING: the selector's logins (claude[bot]) are not bound to account ids (claude[bot]: "))).toBe(true);
    expect(readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`).record.accounts).toBeUndefined();
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const c2 = (await runVerify(s.ctx, { offline: true })).checks[1]!;
    expect(c2.status).toBe("WARN");
    expect(c2.details).toContain("WARN the registration does not bind its selector's logins (claude[bot]) to account ids (no accounts field: its provider could not resolve them, or it was written before P5), so they match as logins: an account renamed before the freeze, or a login written onto another account's change, could move a change in or out of the stratum (a retrospective audit: register warned)");
  });

  it("an id: entry needs no resolving, and a prospective registration without the field (hand-made) is INCOMPLETE in check 2", async () => {
    const s = setupAuditRepo({ changes: withIds(makeChanges(400)), tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
    setSelector(s, '{ kinds: [pull_request], authors: ["id:1001"], unreviewed: no-human-review }');
    at(s, "2026-06-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`).record.accounts).toBeUndefined();
    at(s, "2026-10-01T06:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    expect(readJ<ManifestV2>(s, `${W}.manifest.json`).N).toBe(120);
    expect((await runVerify(s.ctx, { offline: true })).checks[1]!.status).toBe("PASS");
    // A registration naming a login with no accounts field, prospective and PROVEN (as one written before P5 would be).
    const s2 = setupAuditRepo({ changes: withIds(makeChanges(400)), tsa: { ids: ["test-a", "test-b"], k: 2, server: tsa } });
    setSelector(s2, '{ kinds: [pull_request], authors: ["claude[bot]"], unreviewed: no-human-review }');
    at(s2, "2026-06-20T00:00:00Z");
    expect(await registerCommand(s2.ctx, {})).toBe(0);
    const regPath = join(s2.dir, W, "registration.json");
    const reg = JSON.parse(readFileSync(regPath, "utf8")) as SignedRecord<RegistrationRecordV2>;
    const { accounts: _a, ...record } = reg.record;
    let signed = signRecord(record as RegistrationRecordV2, loadOrCreateKey(join(s2.dir, ".pr-rla/signing-key.pem")));
    signed = { ...signed, timestamps: (await obtainTimestamps(s2.ctx, signed, record.registeredAt, record.timestamping, trustFor(s2.ctx))).timestamps };
    writeFileSync(regPath, JSON.stringify(signed, null, 2));
    at(s2, "2026-10-01T06:00:00Z");
    expect(await freezeCommand(s2.ctx, {})).toBe(0);
    const c2 = (await runVerify(s2.ctx, { offline: true })).checks[1]!;
    expect(c2.status).toBe("INCOMPLETE");
    expect(c2.details.some((d) => d.startsWith("INCOMPLETE the registration does not bind its selector's logins (claude[bot]) to account ids") && d.endsWith("a prospective audit's population is not established without them"))).toBe(true);
  });

  it("check 2 FAILs an accounts field that does not bind exactly the selector's logins", async () => {
    const s = setupAuditRepo({ changes: withIds(makeChanges(400)) });
    setSelector(s, '{ kinds: [pull_request], authors: ["claude[bot]"], unreviewed: no-human-review }');
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    const regPath = join(s.dir, W, "registration.json");
    const reg = JSON.parse(readFileSync(regPath, "utf8")) as SignedRecord<RegistrationRecordV2>;
    const rewrite = (accounts: unknown) => writeFileSync(regPath, JSON.stringify(signRecord({ ...reg.record, accounts } as RegistrationRecordV2, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem"))), null, 2));
    rewrite([{ login: "claude[bot]", id: "1001" }, { login: "copilot-swe-agent[bot]", id: "2002" }]);
    expect((await runVerify(s.ctx, { offline: true })).checks[1]!.details).toContain("the registration's accounts bind 1 login(s) its selector does not name (copilot-swe-agent[bot])");
    rewrite([]);
    expect((await runVerify(s.ctx, { offline: true })).checks[1]!.details).toContain("the registration's accounts do not bind 1 login(s) its selector names (claude[bot])");
    rewrite([{ login: "claude[bot]", id: "" }]);
    expect((await runVerify(s.ctx, { offline: true })).checks[1]!.details).toContain("the registration's accounts are malformed: each is { login, id } with a non-empty id");
  });
});

describe("P5 finding 2: resolveAccounts in the built-in providers", () => {
  it("github: GET /users/{login}, a bot by its [bot] login; 404 is no account (synthetic fake GitHub)", async () => {
    const sc = classificationScenario();
    const fake = fakeGitHub(sc.repo, sc.head, sc.commits, sc.prs);
    const p = await gitHub.create({}, { cwd: "/", env: { GITHUB_TOKEN: "t" }, log: () => {}, fetch: fake.fetch });
    const got = await p.resolveAccounts!(["copilot-swe-agent[bot]", "carol", "copilot-swe-agent", "nobody-at-all"]);
    expect(got.map((g) => [g.login, g.id === null ? null : "id"])).toEqual([["copilot-swe-agent[bot]", "id"], ["carol", "id"], ["copilot-swe-agent", null], ["nobody-at-all", null]]);
    expect(got[3]!.detail).toBe("GitHub has no account nobody-at-all (HTTP 404 on /users/nobody-at-all)");
    // The id is the one GraphQL gives the same account (databaseId), which Actor.id carries.
    const listed = await p.listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request"], head: sc.frozenHead });
    const author = listed.changes.find((c) => c.author.login === "copilot-swe-agent[bot]")!.author;
    expect(got[0]!.id).toBe(author.id);
  });

  it("json-file: from the export's actors; none, or two ids, resolve to none", async () => {
    const dir = setupAuditRepo({ changes: withIds(makeChanges(20)).map((c, i) => (i === 3 && c.kind === "pull_request" ? { ...c, author: { ...c.author, id: "9999" } } : c)) }).dir;
    const p = await jsonFile.create({ path: "changes.json" }, { cwd: dir, env: {}, log: () => {}, fetch: globalThis.fetch });
    const got = await p.resolveAccounts!(["MAINT", "copilot-swe-agent[bot]", "claude[bot]", "dev"]);
    expect(got).toEqual([
      { login: "MAINT", id: "5" },
      { login: "copilot-swe-agent[bot]", id: "2002" },
      { login: "claude[bot]", id: null, detail: `${join(dir, "changes.json")} gives claude[bot] 2 account ids (1001, 9999)` },
      { login: "dev", id: null, detail: `${join(dir, "changes.json")} records no account id for dev` },
    ]);
  });
});
