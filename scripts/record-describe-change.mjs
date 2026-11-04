// Records what a built-in provider's describeChange reads for one change, read-only: through pr-rla's
// fetch broker in READ-ONLY mode (it refuses anything that is not a read), with any token from the
// environment. Writes a replayable recording: JSON bodies as `response`, other bodies as `responseText`,
// with Link and Location headers. E-mail addresses in recorded text become user-<hash>@example.invalid.
//
// Usage: node scripts/record-describe-change.mjs <provider> '<options json>' '<ChangeRecord json>' <out.json> [description]
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createAuditContext, openProvider } from "../dist/api/context.js";
import { changeDescriptionProblems } from "../dist/sdk/provider.js";

const [use, optionsJson, changeJson, out, what] = process.argv.slice(2);
if (!use || !optionsJson || !changeJson || !out) throw new Error("usage: record-describe-change.mjs <provider> '<options json>' '<ChangeRecord json>' <out.json> [description]");
const KEEP = /(noreply\.github\.com|@example\.(com|org|net|invalid))$/i;
const scrub = (s) => s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (e) => (KEEP.test(e) ? e : `user-${createHash("sha256").update(e.toLowerCase()).digest("hex").slice(0, 8)}@example.invalid`));
const exchanges = [];
const recordingFetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") throw new Error(`refusing ${method} ${url}: this recorder reads only`);
  const res = await fetch(input, init);
  const text = scrub(await res.text());
  const headers = {};
  for (const h of ["link", "location", "content-type"]) if (res.headers.get(h)) headers[h] = res.headers.get(h);
  let body;
  try {
    body = { response: JSON.parse(text) };
  } catch {
    body = { responseText: text };
  }
  exchanges.push({ method, url, bodySha256: null, status: res.status, headers, ...body });
  return new Response(res.status === 204 || res.status === 304 ? null : text, { status: res.status, headers });
};
const recordedAt = new Date();
const actx = createAuditContext({ mode: "read-only", env: process.env, fetch: recordingFetch, log: (l) => console.error(l) });
const change = JSON.parse(changeJson);
const provider = await openProvider(actx, { use, options: JSON.parse(optionsJson) }, process.cwd());
const description = await provider.describeChange(change);
const problems = changeDescriptionProblems(description, change.id);
if (problems.length) throw new Error(problems.join("; "));
writeFileSync(
  out,
  JSON.stringify({ description: what ?? `${use} describeChange for ${change.id}, recorded read-only`, source: "recorded", recordedAt: recordedAt.toISOString(), provider: use, options: JSON.parse(optionsJson), change, expected: description, exchanges }, null, 1),
);
console.error(`${change.id}: ${description.files.length} file(s), ${description.checks.length} check(s), gitattributes ${description.gitattributes === null ? "none" : "yes"}; ${exchanges.length} exchanges`);
