import { describe, expect, it } from "vitest";
import { appendFileSync, cpSync, mkdtempSync } from "node:fs";
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
