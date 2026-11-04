// Records the Jira example's fixtures from a PUBLIC Jira Cloud site, read-only (FR4.7; D8):
// hibernate.atlassian.net serves the REST v3 changelog anonymously. Its single-select custom field
// "backportDecision" (customfield_11702; values Approved, Rejected, Undecided) stands in for the
// "pr-rla verdict" field: Approved is mapped to pass and Rejected to fail.
//
//   npm --prefix examples/ledgers/jira install && node examples/ledgers/jira/scripts/record.mjs
//
// Every request goes through pr-rla's fetch broker in READ-ONLY mode, so nothing can be written.
// Author objects are cut to accountId and accountType (no names, no avatars).
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBroker } from "pr-rla";
import jira from "../index.mjs";

const SITE = "https://hibernate.atlassian.net";
const FIELD = "customfield_11702";
const OPTIONS = { base_url: SITE, project: "HHH", field: FIELD, values: { pass: "Approved", fail: "Rejected" } };
const recordedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
const hash = (s) => createHash("sha256").update(s).digest("hex");
const pick = (o, keys) => (o == null ? o : Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])));

function trim(url, body) {
  const p = new URL(url).pathname;
  if (p === "/rest/api/3/field") return body.filter((f) => f.id === FIELD).map((f) => pick(f, ["id", "name", "custom", "schema"]));
  if (/\/changelog$/.test(p)) return { ...pick(body, ["startAt", "maxResults", "total", "isLast"]), values: body.values.map((h) => ({ id: h.id, created: h.created, author: pick(h.author, ["accountId", "accountType"]), items: h.items.map((i) => pick(i, ["field", "fieldtype", "fieldId", "from", "fromString", "to", "toString"])) })) };
  if (/\/issue\/[^/]+$/.test(p)) return { id: body.id, key: body.key, fields: { project: pick(body.fields?.project, ["key"]) } };
  return body;
}

async function record(file, kase, keys, why) {
  const exchanges = [];
  const transport = async (input, init) => {
    const url = typeof input === "string" ? input : input.href ?? input.url;
    const res = await fetch(input, init);
    const text = await res.text();
    let body = JSON.parse(text);
    if (res.ok) body = trim(url, body);
    exchanges.push({ method: (init?.method ?? "GET").toUpperCase(), url, bodySha256: typeof init?.body === "string" ? hash(init.body) : null, status: res.status, headers: {}, response: body });
    return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json" } });
  };
  const broker = createBroker({ mode: "read-only" }, { fetch: transport, log: (m) => console.error(m) });
  const issues = [];
  for (const [n, key] of keys.entries()) {
    const r = await (await fetch(`${SITE}/rest/api/3/issue/${key}?fields=created`, { headers: { accept: "application/json" } })).json();
    issues.push({ draw: n + 1, changeId: `jira:hibernate#${key}`, key, id: r.id, url: `${SITE}/browse/${key}`, createdAt: r.fields.created });
  }
  const index = { schema: "pr-rla-ledger-jira/index/v1", ledger: "jira", tracker: `${SITE}/projects/HHH`, window: "recorded", protocolSha256: "0".repeat(64), field: FIELD, issues, repeats: [] };
  const windowDir = mkdtempSync(join(tmpdir(), "prrla-jira-"));
  writeFileSync(join(windowDir, "ledger-index.json"), JSON.stringify(index));
  const ledger = await jira.create(OPTIONS, { cwd: windowDir, windowDir, env: {}, log: () => {}, fetch: broker.bind("ledger:jira") });
  const observed = { verdicts: await ledger.readVerdicts(), integrity: await ledger.verifyIntegrity(), history: await ledger.readHistory() };
  const header = { description: `Public Jira Cloud changelogs (${SITE}, ${keys.join(", ")}), recorded read-only and anonymously through the example ledger. ${why}`, source: "recorded", tracker: "jira-cloud", case: kase, recordedAt, options: OPTIONS, index, observed };
  const text = JSON.stringify({ ...header, exchanges: [] }, null, 1).replace(/"exchanges": \[\]\n}$/, `"exchanges": [\n${exchanges.map((e) => JSON.stringify(e)).join(",\n")}\n ]\n}`);
  writeFileSync(new URL(`../fixtures/${file}`, import.meta.url), `${text}\n`);
  console.error(`wrote fixtures/${file}: ${exchanges.length} exchanges`);
}

await record("hibernate-first-verdicts.json", "first-label", ["HHH-17005", "HHH-16971"], "HHH-17005: backportDecision set to Approved once (pass); HHH-16971: set to Rejected once (fail). A single-select change is one changelog item with fieldtype custom, the field's id, option ids in from/to and the values in fromString/toString, and a created time with a local offset.");
await record("hibernate-removal-HHH-14722.json", "removal", ["HHH-14722"], "HHH-14722: Approved, then 8 s later changed to Undecided by the same account: the counted verdict removed with no verdict in its place, a FAIL (removal after counting).");
