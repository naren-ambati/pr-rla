import { describe, expect, it } from "vitest";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAuditContext, openLedger } from "../src/api/context.js";
import { registerCommand } from "../src/commands/register.js";
import { parseConfig } from "../src/config.js";
import { CredentialHostMismatch } from "../src/net/contract.js";
// In process and unlocked, as a plugin's author tests it; the last two tests open it locked.
import { unsafeLoadLedgerDefinition as loadLedgerDefinition } from "../src/registry.js";
import type { DrawForLedger, LedgerDefinition, PublishContext } from "../src/sdk/ledger.js";
import { formatLedgerConformanceReport, runLedgerConformance, type LedgerFixture, type LedgerUnderTest } from "../src/testing/index.js";
import { makeChanges, setupAuditRepo, T } from "./helpers/audit-scenario.js";
import { auditDirWith, lockPlugin } from "./helpers/plugin-lock.js";

/**
 * The Jira example (examples/ledgers/jira, its own package, importing only pr-rla/ledger) is an
 * EXTERNAL ledger: loaded here from .pr-rla.yml through the registry, in-process (trust: full).
 * An external plugin loads only when locked (bolt 4), so the last two tests lock a copy of it in a
 * temp audit directory with trust: full; test/wave1-integration.test.ts runs it isolated, in the
 * plugin host. Its fixtures: two recorded public changelogs (hibernate.atlassian.net, Jira Cloud,
 * read-only) and a synthetic Jira.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EX = join(ROOT, "examples/ledgers/jira");
type FakeJira = { fetch: typeof fetch; requests: { method: string; url: string; authorization: string | null }[]; writes(): { method: string; url: string }[]; byDraw(d: number): string; set(key: string, v: string | null): string };
const fakeJira = async (): Promise<FakeJira> => new ((await import(pathToFileURL(join(EX, "test/fake-jira.mjs")).href)) as { FakeJira: new () => FakeJira }).FakeJira();
const cases = async () => ((await import(pathToFileURL(join(EX, "test/cases.mjs")).href)) as { jiraCases: (j: LedgerDefinition) => Promise<{ fixtures: LedgerFixture[]; factory: LedgerUnderTest }>; draw: (d: number, n: number) => DrawForLedger; PUB: PublishContext });
const CONFIG = "ledger:\n  use: ./examples/ledgers/jira/index.mjs\n  options: { base_url: https://acme.atlassian.net, project: AUD, field: customfield_10050 }\n";
const OPTIONS = { base_url: "https://acme.atlassian.net", project: "AUD", field: "customfield_10050" };
/** The example's module and package.json, copied to `<dir>/jira/`. */
const JIRA_FILES = { "jira/index.mjs": join(EX, "index.mjs"), "jira/package.json": join(EX, "package.json") };

describe("external Jira example ledger, loaded from .pr-rla.yml through the registry", () => {
  it("passes the ledger kit (recorded Jira Cloud changelogs and a synthetic Jira)", async () => {
    const config = parseConfig(`repo: acme/widgets\nwindow: { name: w, start: 2026-07-01, end: 2026-09-30 }\n${CONFIG}`, join(ROOT, ".pr-rla.yml"));
    const def = await loadLedgerDefinition(config.ledger.use, config.dir);
    expect(def).toMatchObject({ name: "jira", ledgerApiVersion: 1, provenance: "account" });
    const { fixtures, factory } = await (await cases()).jiraCases(def);
    expect(fixtures.filter((f) => f.source === "recorded").map((f) => f.name)).toEqual(["recorded hibernate HHH-17005 (Approved) and HHH-16971 (Rejected)", "recorded hibernate HHH-14722 (Approved, then Undecided)"]);
    const report = await runLedgerConformance(factory, fixtures);
    expect(report.ok, formatLedgerConformanceReport(report)).toBe(true);
  });

  it("authenticates with prrla-basic: the broker builds Basic auth for the site only, and the ledger writes only under /rest/api/3/issue", async () => {
    const audit = auditDirWith(JIRA_FILES);
    await lockPlugin(audit, "./jira/index.mjs", { kind: "ledger", options: OPTIONS, trust: "full", approve: true });
    const fake = await fakeJira();
    const dir = mkdtempSync(join(tmpdir(), "prrla-jira-"));
    const actx = createAuditContext({ mode: "read-write", fetch: fake.fetch, env: { JIRA_EMAIL: "me@acme.example", JIRA_TOKEN: "tok-123" } });
    const l = await openLedger(actx, { use: "./jira/index.mjs", options: OPTIONS }, audit, dir);
    const { draw, PUB } = await cases();
    await l.publishDraws!([draw(1, 101), draw(2, 102)], PUB);
    await l.appendVerdict({ draw: 2, changeId: draw(2, 102).changeId, verdict: "fail", protocolSha256: PUB.protocolSha256, reviewer: "x", recordedAt: "2026-10-21T03:00:00Z" });
    const basic = `Basic ${Buffer.from("me@acme.example:tok-123").toString("base64")}`;
    expect(fake.writes().map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["POST /rest/api/3/issue", "POST /rest/api/3/issue", "PUT /rest/api/3/issue/AUD-2"]);
    expect((await l.readVerdicts()).map((v) => [v.draw, v.verdict, v.reviewer, v.provenance?.source])).toEqual([[2, "fail", "557058:writer", "jira-field-change"]]);
    // Every request, reads and writes, carried Basic auth built by the broker from the placeholder.
    expect(fake.requests.length).toBeGreaterThan(6);
    expect(fake.requests.every((r) => r.authorization === basic)).toBe(true);
    // The credential goes to the declared site only.
    await expect(actx.broker.bind("ledger:jira")("https://evil.example/rest/api/3/myself", { headers: { authorization: "prrla-basic:JIRA_EMAIL:JIRA_TOKEN" } })).rejects.toBeInstanceOf(CredentialHostMismatch);
  });

  it("register takes account provenance from the ledger, and records it as an external path plugin at trust full (in-process until bolt 4)", async () => {
    const s = setupAuditRepo({ changes: makeChanges(160) });
    for (const [to, from] of Object.entries(JIRA_FILES)) cpSync(from, join(s.dir, to), { recursive: true });
    appendFileSync(join(s.dir, ".pr-rla.yml"), `ledger:\n  use: ./jira/index.mjs\n  options: { base_url: https://acme.atlassian.net, project: AUD, field: customfield_10050 }\nverdicts: { reviewers: ["557058:alice"] }\n`);
    await lockPlugin(s.dir, "./jira/index.mjs", { kind: "ledger", options: OPTIONS, trust: "full", approve: true });
    s.clock.now = T("2026-06-20T00:00:00Z");
    expect(await registerCommand(s.ctx, { dryRun: true })).toBe(0);
    expect(s.out.join("\n")).toMatch(/ledger jira · verdict provenance account · reviewers 557058:alice/);
    expect(s.out.join("\n")).toMatch(/PROSPECTIVE/);
  });
});

/**
 * Finding 5 of the master review: the Jira example matched the changelog by display name, ignored
 * its index fields and the issue id, and compared string ids. Run in-process on the synthetic Jira.
 */
describe("Jira example hardening (finding 5)", () => {
  type JiraFake = FakeJira & { renameOption(which: "pass" | "fail", to: string): void; setOption(key: string, id: string, name: string): string; unauthorized: boolean; issues: Map<string, { id: string }> };
  const open = async (windowDir: string, fake: JiraFake) => {
    const mod = (await import(pathToFileURL(join(EX, "index.mjs")).href)) as { default: LedgerDefinition };
    return mod.default.create(OPTIONS, { cwd: windowDir, windowDir, env: {}, log: () => {}, fetch: fake.fetch });
  };
  const setup = async () => {
    const { draw, PUB } = await cases();
    const fake = (await fakeJira()) as JiraFake;
    const windowDir = mkdtempSync(join(tmpdir(), "prrla-jira-h-"));
    await (await open(windowDir, fake)).publishDraws!([draw(1, 101), draw(2, 102), draw(3, 103)], PUB);
    return { fake, windowDir, fresh: () => open(windowDir, fake) };
  };
  const readIndex = (dir: string) => JSON.parse(readFileSync(join(dir, "ledger-index.json"), "utf8")) as Record<string, any>;
  const writeIndex = (dir: string, i: unknown) => writeFileSync(join(dir, "ledger-index.json"), JSON.stringify(i));

  it("publish records the option ids; a FAIL set after the option was renamed is still a FAIL (it used to be dropped)", async () => {
    const { fake, windowDir, fresh } = await setup();
    expect(readIndex(windowDir).options).toEqual({ pass: "10001", fail: "10002" });
    fake.set("AUD-1", "pass");
    fake.renameOption("fail", "Fail");
    fake.set("AUD-2", "fail"); // the changelog entry now says "Fail"
    const l = await fresh();
    expect((await l.readVerdicts()).map((v) => [v.draw, v.verdict])).toEqual([[1, "pass"], [2, "fail"]]);
    const r = await l.verifyIntegrity!();
    expect(r.ok, r.findings.join("\n")).toBe(true);
  });

  it("an option the ledger does not know is a FAIL naming it, never a silent drop", async () => {
    const { fake, windowDir, fresh } = await setup();
    fake.setOption("AUD-1", "10099", "Maybe");
    void windowDir;
    const r = await (await fresh()).verifyIntegrity!();
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/draw #1: the verdict field was set to "Maybe" \(option id 10099\) at .*, which is neither the pass option \(10001\) nor the fail option \(10002\)/);
  });

  it("an index with other fields than the settings, or no option ids, fails before any issue is read", async () => {
    const { fake, windowDir, fresh } = await setup();
    const good = readIndex(windowDir);
    for (const [edit, msg] of [
      [(i: any) => (i.field = "customfield_99999"), /ledger index was written for field customfield_99999, not customfield_10050/],
      [(i: any) => (i.tracker = "https://forged.example/projects/AUD"), /ledger index was written for https:\/\/forged\.example\/projects\/AUD/],
      [(i: any) => delete i.options, /records no distinct option ids/],
      [(i: any) => (i.issues[1].key = i.issues[0].key), /gives draws #1 and #2 the same issue key AUD-1/],
      [(i: any) => (i.issues[1].id = i.issues[0].id), /the same issue id/],
    ] as const) {
      writeIndex(windowDir, structuredClone(good));
      const i = readIndex(windowDir);
      edit(i);
      writeIndex(windowDir, i);
      fake.requests.length = 0;
      const r = await (await fresh()).verifyIntegrity!();
      expect(r.ok).toBe(false);
      expect(r.findings.join("\n")).toMatch(msg);
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("the issue's id must be the one the index records", async () => {
    const { windowDir, fresh } = await setup();
    const i = readIndex(windowDir);
    i.issues[2].id = "99999"; // the index says draw 3 is another Jira issue than the one at that key
    writeIndex(windowDir, i);
    const r = await (await fresh()).verifyIntegrity!();
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/draw #3: acme\.atlassian\.net answered issue AUD-3 with id 10003 for the index's id 99999; the index does not describe this issue/);
  });

  it("history ids are compared as numbers: history 99 is before history 100 at the same second", async () => {
    const { fake, fresh } = await setup();
    const key = "AUD-1";
    const pass = fake.set(key, "pass");
    const failId = fake.set(key, "fail");
    const issue = (fake as unknown as { issues: Map<string, { changelog: { id: string; created: string }[] }> }).issues.get(key)!;
    const [p, f] = issue.changelog.slice(-2) as [{ id: string; created: string }, { id: string; created: string }];
    p.id = "100";
    f.id = "99";
    f.created = p.created; // the same second; the lexically first id is "100", the numerically first is "99"
    void pass;
    void failId;
    const v = await (await fresh()).readVerdicts();
    expect(v.find((x) => x.draw === 1)?.verdict).toBe("fail");
  });

  it("a 404 from credentials that cannot see the project is reported as that, not as a deleted issue", async () => {
    const { fake, fresh } = await setup();
    fake.unauthorized = true;
    const r = await (await fresh()).verifyIntegrity!();
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/draw #1 issue AUD-1 answered HTTP 404, and the token cannot read project AUD either/);
    expect(r.findings.join("\n")).not.toMatch(/deleted \(HTTP 404\)/);
  });
});

/**
 * P1 (pass-2 review #3): the option ids came from the unauthenticated index, so swapping options.pass and
 * options.fail inverted every verdict with integrity ok (the reviewer's jira-swap.test.ts). Every read now
 * learns again from Jira what each id is (GET /rest/api/3/customFieldOption/{id}), and a changelog entry
 * whose id is one verdict while its toString names the other FAILs. And Jira, unlike GitHub's REST API,
 * records summary edits, so the summary marker the issues carry is checked, with its edit history.
 */
describe("P1: the Jira example learns its option ids again and checks its summary marker", () => {
  type JiraFake = FakeJira & { renameOption(which: "pass" | "fail", to: string): void; editSummary(key: string, to: string): void; options: { pass: string; fail: string } };
  const open = async (windowDir: string, fake: JiraFake, options: Record<string, unknown> = OPTIONS) => {
    const mod = (await import(pathToFileURL(join(EX, "index.mjs")).href)) as { default: LedgerDefinition };
    return mod.default.create(options, { cwd: windowDir, windowDir, env: {}, log: () => {}, fetch: fake.fetch });
  };
  const setup = async () => {
    const { draw, PUB } = await cases();
    const fake = (await fakeJira()) as JiraFake;
    const windowDir = mkdtempSync(join(tmpdir(), "prrla-jira-p1-"));
    await (await open(windowDir, fake)).publishDraws!([draw(1, 101), draw(2, 102), draw(3, 103)], PUB);
    return { fake, windowDir, fresh: (o?: Record<string, unknown>) => open(windowDir, fake, o) };
  };
  const readIndex = (dir: string) => JSON.parse(readFileSync(join(dir, "ledger-index.json"), "utf8")) as Record<string, any>;
  const writeIndex = (dir: string, i: unknown) => writeFileSync(join(dir, "ledger-index.json"), JSON.stringify(i));

  it("the reviewer's swap: options.pass and options.fail exchanged in ledger-index.json FAILs integrity, on the field and on the changelog's own words", async () => {
    const { fake, windowDir, fresh } = await setup();
    fake.set("AUD-1", "fail");
    fake.set("AUD-2", "fail");
    fake.set("AUD-3", "pass");
    expect((await (await fresh()).readVerdicts()).map((v) => [v.draw, v.verdict])).toEqual([[1, "fail"], [2, "fail"], [3, "pass"]]);
    const idx = readIndex(windowDir);
    idx.options = { pass: idx.options.fail, fail: idx.options.pass };
    writeIndex(windowDir, idx);
    const l = await fresh();
    const r = await l.verifyIntegrity!();
    // Before P1: verdicts inverted to pass, pass, fail; integrity ok, no finding.
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/the index names option 10002 as the pass verdict, but on acme\.atlassian\.net it is "fail", not "pass": the index's option ids are swapped; the field's options disagree with the index/);
    expect(r.findings.join("\n")).toMatch(/the index names option 10001 as the fail verdict, but on acme\.atlassian\.net it is "pass"/);
    expect(r.findings.join("\n")).toMatch(/draw #1: the changelog entry at .* sets option 10002, which the index names the pass verdict, but Jira wrote its value as "fail", the other verdict/);
  });

  it("an option renamed beyond its case, or deleted, disagrees with the index: FAIL", async () => {
    const { fake, fresh } = await setup();
    fake.renameOption("fail", "Rejected");
    expect((await (await fresh()).verifyIntegrity!()).findings.join("\n")).toMatch(/the index names option 10002 as the fail verdict, but on acme\.atlassian\.net it is "Rejected", not "fail"; the field's options disagree with the index/);
    fake.options.fail = "20002"; // the option the index names is gone from the field
    expect((await (await fresh()).verifyIntegrity!()).findings.join("\n")).toMatch(/the index's fail option id 10002 is no option of field customfield_10050 on acme\.atlassian\.net now \(deleted\)/);
  });

  it("the summary is the marker: an edited summary FAILs, and so does an entry pointed at another draw's issue", async () => {
    const { fake, windowDir, fresh } = await setup();
    fake.set("AUD-1", "pass");
    expect((await (await fresh()).verifyIntegrity!()).ok).toBe(true);
    fake.editSummary("AUD-2", "pr-rla draw #2 (2026-q3): json:acme/widgets#102 (edited)");
    let r = await (await fresh()).verifyIntegrity!();
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/draw #2 issue AUD-2's summary is "pr-rla draw #2 \(2026-q3\): json:acme\/widgets#102 \(edited\)", not "pr-rla draw #2 \(2026-q3\): json:acme\/widgets#102"/);
    expect(r.findings.join("\n")).toMatch(/draw #2 issue AUD-2's summary, where its draw marker lives, was edited at .*; pr-rla never edits it/);
    // Draws 1 and 3 swap issues (key, id and url, both sides): each issue's own summary names the other draw.
    const idx = readIndex(windowDir);
    const [one, , three] = idx.issues;
    const keep = { key: one.key, id: one.id, url: one.url };
    Object.assign(one, { key: three.key, id: three.id, url: three.url });
    Object.assign(three, keep);
    writeIndex(windowDir, idx);
    r = await (await fresh()).verifyIntegrity!();
    expect(r.findings.join("\n")).toMatch(/draw #3 issue AUD-1's summary is "pr-rla draw #1 \(2026-q3\): json:acme\/widgets#101", not "pr-rla draw #3 \(2026-q3\): json:acme\/widgets#103"/);
    expect(r.findings.join("\n")).toMatch(/draw #1 issue AUD-3's summary is "pr-rla draw #3 /);
  });

  it("foreign_issues (test only) skips the summary marker, as the recorded hibernate changelogs need; the option check still runs", async () => {
    const { fake, windowDir, fresh } = await setup();
    fake.editSummary("AUD-1", "a summary pr-rla did not write");
    expect((await (await fresh({ ...OPTIONS, foreign_issues: true })).verifyIntegrity!()).ok).toBe(true);
    const idx = readIndex(windowDir);
    idx.options = { pass: idx.options.fail, fail: idx.options.pass };
    writeIndex(windowDir, idx);
    expect((await (await fresh({ ...OPTIONS, foreign_issues: true })).verifyIntegrity!()).findings.join("\n")).toMatch(/the index's option ids are swapped/);
  });
});

describe("P1: a Jira audit's draw → issue mapping is bound by sample's publication record, as an issue ledger's", () => {
  it("sample publishes the Jira index (keys, ids, option ids), and a two-sided remap of two issues FAILs check 7", async () => {
    const { MockTsaServer, makeTestAuthority } = await import("./helpers/test-tsa.js");
    const tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
    try {
      const fake = (await fakeJira()) as FakeJira & { issues: Map<string, { summary: string }>; setTime(iso: string): void };
      const s = setupAuditRepo({
        changes: makeChanges(400),
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          return url.startsWith("https://acme.atlassian.net/") ? fake.fetch(input, init) : globalThis.fetch(input, init);
        }) as typeof fetch,
        tsa: { ids: ["test-a", "test-b"], server: tsa },
      });
      for (const [to, from] of Object.entries(JIRA_FILES)) cpSync(from, join(s.dir, to), { recursive: true });
      appendFileSync(join(s.dir, ".pr-rla.yml"), `ledger:\n  use: ./jira/index.mjs\n  options: { base_url: https://acme.atlassian.net, project: AUD, field: customfield_10050 }\n`);
      await lockPlugin(s.dir, "./jira/index.mjs", { kind: "ledger", options: OPTIONS, trust: "full", approve: true });
      s.git("add", "-A");
      s.git("commit", "-qm", "jira ledger");
      const at = (iso: string) => ((s.clock.now = T(iso)), (tsa.nowMs = T(iso)));
      at("2026-10-20T00:00:00Z");
      expect(await registerCommand(s.ctx, {})).toBe(0);
      const { freezeCommand } = await import("../src/commands/freeze.js");
      const { sampleCommand } = await import("../src/commands/sample.js");
      const { runVerify } = await import("../src/commands/verify.js");
      at("2026-10-20T12:00:00Z");
      expect(await freezeCommand(s.ctx, {})).toBe(0);
      at("2026-10-21T01:00:00Z");
      expect(await sampleCommand(s.ctx, {})).toBe(0);
      const pub = JSON.parse(readFileSync(join(s.dir, "audit/2026-q3/ledger-publication.json"), "utf8")) as { publications: { record: { index: { issues: { key: string }[]; options: unknown } } }[] };
      expect(pub.publications).toHaveLength(1);
      expect(pub.publications[0]!.record.index.options).toEqual({ pass: "10001", fail: "10002" });
      expect(pub.publications[0]!.record.index.issues.slice(0, 2).map((i) => i.key)).toEqual(["AUD-1", "AUD-2"]);
      fake.setTime("2026-10-21T02:00:00Z");
      const index = JSON.parse(readFileSync(join(s.dir, "audit/2026-q3/ledger-index.json"), "utf8")) as { issues: { draw: number; key: string; id: string; url: string }[] };
      for (const i of index.issues) fake.set(i.key, i === index.issues[1] ? "fail" : "pass");
      at("2026-10-21T03:00:00Z");
      const honest = (await runVerify(s.ctx, {})).checks.find((c) => c.n === 7)!;
      expect(honest.details.filter((d) => /publication|append-only|draw order/.test(d) && d.startsWith("FAIL"))).toEqual([]);
      // Draw 2 (fail) and the last draw (pass) exchange issues in the index (Jira would also show any summary edit: see above).
      const a = index.issues[1]!;
      const b = index.issues.at(-1)!;
      const keep = { key: a.key, id: a.id, url: a.url };
      Object.assign(a, { key: b.key, id: b.id, url: b.url });
      Object.assign(b, keep);
      writeFileSync(join(s.dir, "audit/2026-q3/ledger-index.json"), JSON.stringify(index, null, 2));
      const c7 = (await runVerify(s.ctx, {})).checks.find((c) => c.n === 7)!;
      expect(c7.status).toBe("FAIL");
      expect(c7.details.join("\n")).toMatch(new RegExp(`FAIL the ledger index is not an append-only extension of what was published: draw #${a.draw}: publication #1 lists issue #${keep.key}`));
      expect(c7.details.join("\n")).toMatch(/pr-rla opens issues in draw order, so issue numbers rise with the draws/);
    } finally {
      await tsa.stop();
    }
  }, 180_000);
});
