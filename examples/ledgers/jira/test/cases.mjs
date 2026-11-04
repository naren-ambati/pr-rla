// The Jira example's ledger-kit fixtures: two recorded (hibernate.atlassian.net, read-only) and the
// rest synthetic, on FakeJira. Shared by the package's own node:test run and pr-rla's vitest suite.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeJira, FIELD } from "./fake-jira.mjs";

const BASE = "https://acme.atlassian.net";
export const OPTIONS = { base_url: BASE, project: "AUD", field: FIELD };
export const PUB = { window: "2026-q3", protocolSha256: "ab".repeat(32), registrationSha256: "cd".repeat(32), repo: "acme/widgets" };
const sha = (n) => n.toString(16).padStart(40, "0");
export const draw = (d, n, firstOccurrence = true) => ({ draw: d, changeId: `json:acme/widgets#${n}`, url: `https://git.example.com/acme/widgets/pulls/${n}`, mergeSha: sha(n), firstOccurrence });
const DRAWS = [draw(1, 101), draw(2, 102), draw(3, 103)];
const tmp = () => mkdtempSync(join(tmpdir(), "prrla-jira-kit-"));
const iso = (jiraTime) => new Date(Date.parse(jiraTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))).toISOString().replace(".000Z", "Z");

/** A replaying fetch over a recording (method + URL); an unrecorded request throws, so the kit stays offline. */
export function replay(rec) {
  const queue = rec.exchanges.map((e) => ({ e, used: false }));
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.href ?? input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const hit = queue.find((q) => !q.used && q.e.method === method && q.e.url === url);
    if (!hit) throw new Error(`unrecorded request ${method} ${url}`);
    hit.used = true;
    return new Response(JSON.stringify(hit.e.response), { status: hit.e.status, headers: { "content-type": "application/json" } });
  };
}

export function recordings() {
  const read = (f) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8"));
  return { first: read("hibernate-first-verdicts.json"), removal: read("hibernate-removal-HHH-14722.json") };
}

export async function jiraCases(jira) {
  const scenario = async (setup) => {
    const fake = new FakeJira(BASE, "AUD");
    const windowDir = tmp();
    const l = await jira.create(OPTIONS, { cwd: windowDir, windowDir, env: {}, log: () => {}, fetch: fake.fetch });
    await l.publishDraws(DRAWS, PUB);
    const ids = setup(fake, (d) => fake.byDraw(d)) ?? {};
    return { fake, windowDir, ids };
  };
  const at = (fake, id) => iso([...fake.issues.values()].flatMap((i) => i.changelog).find((h) => h.id === id).created);
  const app = { accountId: "557058:automation", accountType: "app" };
  const human = (n) => ({ accountId: `557058:${n}`, accountType: "atlassian" });
  const defs = [];
  const add = async (name, kase, setup, expect, extra = {}) => {
    const probe = await scenario(setup);
    defs.push({ name, setup, fixture: { name, case: kase, source: "synthetic", http: true, draws: DRAWS, ...extra.fixture, expect: expect(probe.fake, probe.ids) }, erase: extra.erase });
  };
  await add("synthetic jira first-label", "first-label", (g, k) => ({ a: g.set(k(1), "pass", human("alice")), b: g.set(k(2), "fail", human("bob")) }), (g, ids) => ({ counted: { 1: { verdict: "pass", reviewer: "557058:alice", recordedAt: at(g, ids.a) }, 2: { verdict: "fail", reviewer: "557058:bob", recordedAt: at(g, ids.b) }, 3: null }, integrity: "PASS" }));
  await add("synthetic jira relabel-same", "relabel-same", (g, k) => {
    const a = g.set(k(1), "pass", human("alice"));
    g.touch(k(1));
    g.set(k(1), null, human("alice"));
    g.set(k(1), "pass", human("alice"));
    return { a };
  }, (g, ids) => ({ counted: { 1: { verdict: "pass", reviewer: "557058:alice", recordedAt: at(g, ids.a) } }, integrity: "WARN" }));
  await add("synthetic jira relabel-opposite", "relabel-opposite", (g, k) => ({ a: g.set(k(1), "pass", human("alice")), b: g.set(k(1), "fail", human("bob")) }), (g, ids) => ({ counted: { 1: { verdict: "pass", reviewer: "557058:alice", recordedAt: at(g, ids.a) } }, integrity: "WARN", messages: [/draw #1: relabel pass→fail; the first verdict/] }));
  await add("synthetic jira removal", "removal", (g, k) => ({ a: g.set(k(1), "fail", human("alice")), b: g.set(k(1), null, human("mallory")) }), (g, ids) => ({ counted: { 1: { verdict: "fail", reviewer: "557058:alice", recordedAt: at(g, ids.a) } }, integrity: "FAIL" }));
  await add("synthetic jira deleted and moved issues", "deletion", (g, k) => (g.set(k(1), "pass", human("alice")), g.deleteIssue(k(1)), g.moveIssue(k(2), "OTHER-9"), {}), () => ({ counted: { 1: null, 2: null }, integrity: "FAIL", messages: [/draw #1 issue AUD-1 deleted \(HTTP 404\)/, /draw #2 issue AUD-2 moved \(now OTHER-9\)/] }));
  await add("synthetic jira verdict field deleted", "label-rename", (g, k) => ({ a: g.set(k(1), "pass", human("alice")), x: g.deleteField() }), (g, ids) => ({ counted: { 1: { verdict: "pass", reviewer: "557058:alice", recordedAt: at(g, ids.a) } }, integrity: "FAIL", messages: [/verdict field customfield_10050 no longer exists/] }));
  await add("synthetic jira unlisted reviewer", "unlisted-reviewer", (g, k) => (g.set(k(1), "pass", human("intruder")), { a: g.set(k(1), "fail", human("alice")) }), (g, ids) => ({ counted: { 1: { verdict: "fail", reviewer: "557058:alice", recordedAt: at(g, ids.a) } }, integrity: "PASS", messages: [/557058:intruder is not a registered reviewer/] }), { fixture: { reviewers: ["557058:alice"] } });
  await add("synthetic jira app account", "app-applied", (g, k) => (g.set(k(1), "pass", app), {}), () => ({ counted: { 1: null }, integrity: "PASS", messages: [/applied by bot account 557058:automation\[bot\]/] }));
  await add("synthetic jira verdict before seed", "verdict-before-seed", (g, k) => (g.setTime("2026-10-21T00:30:00Z"), { a: g.set(k(1), "pass", human("alice")) }), (g, ids) => ({ counted: { 1: { verdict: "pass", reviewer: "557058:alice", recordedAt: at(g, ids.a) } }, integrity: "PASS", seedPublishedAt: "2026-10-22T00:00:00Z" }));
  await add("synthetic jira 121 changelog entries", "pagination", (g, k) => {
    const a = g.set(k(1), "pass", human("alice"));
    for (let n = 0; n < 60; n++) {
      g.touch(k(1));
      g.touch(k(1));
    }
    return { a };
  }, (g, ids) => ({ counted: { 1: { verdict: "pass", reviewer: "557058:alice", recordedAt: at(g, ids.a) } }, integrity: "PASS", minHistory: 1 }));
  await add("synthetic jira checkpoint round trip", "checkpoint-round-trip", (g, k) => ({ a: g.set(k(1), "pass", human("alice")) }), (g, ids) => ({ counted: { 1: { verdict: "pass", reviewer: "557058:alice", recordedAt: at(g, ids.a) } }, integrity: "PASS" }), { erase: (g, ids) => g.eraseHistory(ids.a) });
  const cp = defs.at(-1);
  cp.fixture.erasedEventId = `${(await scenario(cp.setup)).ids.a}:0:add`;

  const pubFake = new FakeJira(BASE, "AUD");
  const pubDir = tmp();
  const rec = recordings();
  const recorded = [
    { name: "recorded hibernate HHH-17005 (Approved) and HHH-16971 (Rejected)", rec: rec.first, case: "first-label", expect: { counted: { 1: { verdict: "pass", reviewer: "557058:99e61e65-956b-4a21-b29c-06057642e9ea", recordedAt: "2023-07-28T10:43:22.045Z" }, 2: { verdict: "fail", reviewer: "557058:db1a3420-e3e5-4207-9989-5d434a8152e9", recordedAt: "2023-07-24T19:23:03.408Z" } }, integrity: "PASS" } },
    { name: "recorded hibernate HHH-14722 (Approved, then Undecided)", rec: rec.removal, case: "removal", expect: { counted: { 1: { verdict: "pass", reviewer: "557058:99e61e65-956b-4a21-b29c-06057642e9ea", recordedAt: "2021-07-18T20:06:36.666Z" } }, integrity: "FAIL", messages: [/the counted customfield_11702=Approved verdict was removed at 2021-07-18T20:06:44\.470Z and nothing replaced it/] } },
  ];
  const fixtures = [
    ...recorded.map((r) => ({ name: r.name, case: r.case, source: "recorded", http: true, draws: r.rec.index.issues.map((i) => ({ draw: i.draw, changeId: i.changeId, url: i.url, mergeSha: "0".repeat(40), firstOccurrence: true })), expect: r.expect })),
    ...defs.map((d) => d.fixture),
    { name: "synthetic jira idempotent publish", case: "idempotent-publish", source: "synthetic", http: true, draws: [...DRAWS, draw(4, 101, false)], publish: PUB, forgetLocalState: () => rmSync(join(pubDir, "ledger-index.json")), expect: { counted: {}, integrity: "PASS" } },
  ];
  const byName = new Map(defs.map((d) => [d.name, d]));
  const recByName = new Map(recorded.map((r) => [r.name, r]));
  const factory = async (f, h) => {
    if (f.case === "idempotent-publish") return jira.create(OPTIONS, h.context({ fetch: pubFake.fetch, windowDir: pubDir }));
    const r = recByName.get(f.name);
    if (r) {
      const windowDir = tmp();
      writeFileSync(join(windowDir, "ledger-index.json"), JSON.stringify(r.rec.index));
      return jira.create(r.rec.options, h.context({ fetch: replay(r.rec), windowDir }));
    }
    const d = byName.get(f.name);
    const s = await scenario(d.setup);
    if (h.phase === "after-erasure") d.erase?.(s.fake, s.ids);
    return jira.create(OPTIONS, h.context({ fetch: s.fake.fetch, windowDir: s.windowDir }));
  };
  return { fixtures, factory };
}
