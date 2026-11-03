// Records live RFC 3161 responses for the offline tests, and runs the bolt-1 demo once, live.
// Usage (after `npm run build`):
//   node scripts/record-tsa-fixtures.mjs [out.json]      (default test/fixtures/tsa/recorded-<date>.json)
//
// 1. Copies test/fixtures/audits/tsa-demo to a temporary directory and runs `pr-rla register` there,
//    live, against its four default authorities, with a recording fetch. Each authority receives one
//    TimeStampReq: the SHA-256 digest of the registration record and a random 64-bit nonce. Nothing else.
// 2. Requests one token over the same digest from the other four bundled authorities (GitHub, SwissSign,
//    Sectigo, FreeTSA), so every bundled authority has a recorded token.
// 3. Runs `pr-rla verify --offline` on the result, then forges one token's genTime and runs it again.
// The fixture holds the record, its digest, the nonces, and each request and response (base64). Tests
// replay `register` from it with the same clock and nonces, which reproduces the same digest offline.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram } from "../dist/cli.js";
import { nodeContext } from "../dist/commands/context.js";
import { canonicalJson, sha256Hex } from "../dist/core/canonical.js";
import { createMinimalBroker } from "../dist/net/minimal-adapter.js";
import { SHIPPED_TRUST_BUNDLE } from "../dist/timestamp/bundle.js";
import { newNonce, requestTimestamps } from "../dist/timestamp/client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const day = new Date().toISOString().slice(0, 10);
const out = process.argv[2] ?? join(ROOT, `test/fixtures/tsa/recorded-${day}.json`);
const dir = mkdtempSync(join(tmpdir(), "prrla-tsa-demo-"));
cpSync(join(ROOT, "test/fixtures/audits/tsa-demo"), dir, { recursive: true });

const exchanges = {};
const nonces = {};
const recordingFetch = async (input, init) => {
  const url = String(input);
  const t0 = Date.now();
  const res = await fetch(input, init);
  const body = Buffer.from(await res.arrayBuffer());
  const id = Object.entries(SHIPPED_TRUST_BUNDLE.authorities).find(([, a]) => new URL(a.url).href === new URL(url).href)?.[0] ?? url;
  exchanges[id] = {
    url,
    request: Buffer.from(init.body).toString("base64"),
    status: res.status,
    contentType: res.headers.get("content-type"),
    elapsedMs: Date.now() - t0,
    response: body.toString("base64"),
  };
  return new Response(body, { status: res.status, headers: res.headers });
};
const nonceFor = (tsa) => {
  const n = newNonce();
  nonces[tsa] = Buffer.from(n).toString("hex");
  return n;
};

const run = async (argv) => {
  const lines = [];
  let code = -1;
  const clean = (l) => l.split(dir).join("<audit>");
  const ctx = nodeContext({ cwd: dir, fetch: recordingFetch, nonceFor, out: (l) => (lines.push(clean(l)), console.log(clean(l))), err: (l) => (lines.push(clean(l)), console.error(clean(l))) });
  await buildProgram(() => ctx, (c) => (code = c)).parseAsync(["node", "pr-rla", ...argv]);
  console.log(`(exit ${code})`);
  return { lines, code };
};

const startedAt = new Date().toISOString();
console.log(`$ pr-rla -C <copy of test/fixtures/audits/tsa-demo> register    (live, ${startedAt})`);
const register = await run(["register"]);
const regPath = join(dir, "audit/demo-2026-q4/registration.json");
const signed = JSON.parse(readFileSync(regPath, "utf8"));
const digest = sha256Hex(canonicalJson(signed.record));
if (digest !== signed.sha256) throw new Error("registration digest mismatch");

const others = Object.keys(SHIPPED_TRUST_BUNDLE.authorities).filter((id) => !signed.record.timestamping.authorities.includes(id));
console.log(`\nother bundled authorities, same digest: ${others.join(", ")}`);
const data = new Uint8Array(Buffer.from(canonicalJson(signed.record)));
const outcomes = await requestTimestamps({
  authorities: others,
  bundle: SHIPPED_TRUST_BUNDLE,
  digestHex: digest,
  data,
  signedTimeIso: signed.record.registeredAt,
  toleranceSeconds: 600,
  defaultAccuracySeconds: 60,
  broker: createMinimalBroker({ fetch: recordingFetch }),
  nonceFor,
});
for (const o of outcomes) console.log(`  ${o.tsa}: ${o.check ? (o.check.accepted ? `accepted · genTime ${o.evidence.genTime} · ${o.check.signatureAlgorithm}` : `REJECTED ${o.check.problems.join("; ")}`) : `no token (${o.error})`}`);

console.log(`\n$ pr-rla -C <copy> verify --offline`);
const verify = await run(["verify", "--offline"]);

// Forge: move the first token's genTime one minute earlier, in the token and in the record's copy of it.
const forged = structuredClone(signed);
const t = forged.timestamps[0];
const der = Buffer.from(t.tokenDer, "base64");
const iso = new Date(Date.parse(t.genTime) - 60_000).toISOString();
const gt = (s) => s.replace(/[-:T]/g, "").replace(/\.\d+Z$|Z$/, "");
const from = Buffer.from(gt(t.genTime));
const at = der.indexOf(from);
if (at < 0) throw new Error("genTime not found in the token");
Buffer.from(gt(iso)).copy(der, at);
t.tokenDer = der.toString("base64");
t.genTime = iso.replace(".000Z", "Z");
writeFileSync(regPath, `${JSON.stringify(forged, null, 2)}\n`);
console.log(`\nforged ${t.tsa}'s genTime to ${t.genTime}`);
console.log(`$ pr-rla -C <copy> verify --offline`);
const forgedVerify = await run(["verify", "--offline"]);

const fixture = {
  source: "recorded",
  recordedAt: startedAt,
  note: "Live RFC 3161 responses from all eight bundled authorities over one registration digest (hash only). register used the four defaults; the other four were asked for the same digest. Recorded by scripts/record-tsa-fixtures.mjs.",
  registeredAt: signed.record.registeredAt,
  digest,
  record: signed.record,
  nonces,
  authorities: exchanges,
  demo: { register: register.lines, verify: verify.lines, forgedVerify: forgedVerify.lines },
};
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`\nwrote ${out}`);
