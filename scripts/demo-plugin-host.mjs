#!/usr/bin/env node
// Bolt 4 (U2b) demo, offline: the hostile fixture plugin (test/fixtures/plugins/hostile) is locked
// in a temporary audit repo and opened the way a command opens a provider, through the plugin host
// and the fetch broker. The broker's transport is a fake api.github.com that echoes the
// Authorization header it receives; nothing leaves the machine except one loopback socket the
// plugin tries to open. Run `npm run build` first; run it with another Node to compare
// (`/path/to/node25 scripts/demo-plugin-host.mjs`).
//
// The person who locks a plugin approves it on their machine (`plugin add` does); the demo does so in
// its own temporary approvals file, never ~/.config/pr-rla. It ends with a third party's run of the
// same audit, on a machine that has not approved the plugin: its credentials are withheld.
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditContext, openProvider } from "../dist/api/context.js";
import { approvePlugin } from "../dist/plugins/approvals.js";
import { buildLockEntry } from "../dist/plugins/entry.js";
import { closeAllPluginHosts } from "../dist/plugins/host.js";
import { readLock, writeLock } from "../dist/plugins/lock.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const USE = "./plugins/hostile/index.mjs";
const SECRETS = { GITHUB_TOKEN: "ghp_DEMO0123456789secret", GITHUB_USER: "alice", AWS_SECRET_ACCESS_KEY: "aws-demo-secret" };

const dir = mkdtempSync(join(tmpdir(), "prrla-u2b-demo-"));
cpSync(join(ROOT, "test", "fixtures", "plugins", "hostile"), join(dir, "plugins", "hostile"), { recursive: true });
const secretFile = join(dir, "..", `prrla-u2b-demo-secret-${process.pid}.txt`);
writeFileSync(secretFile, "top secret");
const entry = await buildLockEntry("provider", USE, dir, {});
writeLock(dir, { ...readLock(dir), plugins: { [USE]: entry } });
const approvals = join(dir, "..", `prrla-u2b-demo-approvals-${process.pid}.json`);
approvePlugin(approvals, USE, entry, new Date().toISOString());

let received = "";
const sock = createServer((s) => s.on("data", (d) => (received += d)));
await new Promise((r) => sock.listen(0, "127.0.0.1", r));

const atServer = [];
const transport = async (url, init) => {
  const auth = new Headers(init?.headers).get("authorization");
  atServer.push(`${init?.method ?? "GET"} ${url}  Authorization: ${auth}`);
  const path = new URL(url).pathname;
  const token = (auth ?? "").replace(/^token /, "");
  if (path === "/downgrade") return new Response(null, { status: 302, headers: { location: "http://api.github.com/landing" } });
  if (path === "/echo-forms") return new Response(JSON.stringify({ raw: token, pct: encodeURIComponent(token), b64: Buffer.from(token).toString("base64") }), { status: 200, headers: { "content-type": "application/json", "x-echo": token } });
  return new Response(JSON.stringify({ authorization: auth }), { status: 200, headers: { "content-type": "application/json" } });
};
const WINDOW = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };
const log = [];
const ctx = createAuditContext({ mode: "read-write", env: SECRETS, fetch: transport, log: (l) => log.push(l), approvalsFile: approvals });
const provider = await openProvider(ctx, { use: USE, options: { secretFile, socketPort: sock.address().port } }, dir);
const seen = JSON.parse((await provider.listChanges({ repo: "acme/widgets", window: WINDOW, kinds: ["pull_request"] })).limitations[0]);
closeAllPluginHosts();
sock.close();

// A third party runs the same audit on their machine: same lock, same secrets in the environment, no approval.
const theirs = [];
const theirServer = atServer.length;
const third = createAuditContext({ mode: "read-only", env: SECRETS, fetch: transport, log: (l) => theirs.push(l), approvalsFile: join(dir, "..", `prrla-u2b-demo-third-party-${process.pid}.json`) });
const seenByThird = JSON.parse((await (await openProvider(third, { use: USE, options: { secretFile } }, dir)).listChanges({ repo: "acme/widgets", window: WINDOW, kinds: ["pull_request"] })).limitations[0]);
closeAllPluginHosts();

const r = (x) => (x === null ? "not tried" : x.ok ? `allowed: ${JSON.stringify(x.value)}` : `refused: ${x.code}`);
console.log(`U2b demo: a hostile provider through pr-rla's plugin host (this Node ${process.version})`);
console.log(`  the parent's environment has GITHUB_TOKEN=${SECRETS.GITHUB_TOKEN.slice(0, 8)}…, GITHUB_USER and AWS_SECRET_ACCESS_KEY`);
console.log(`  lock entry: ${USE} · trust ${entry.trust} · treeSha256 ${entry.treeSha256.slice(0, 16)}… · hosts ${entry.hosts.join(", ")} · credentials ${entry.credentials.map((c) => `${c.env} -> ${c.hosts.join(",")}`).join("; ")}`);
for (const l of log) console.log(`  [pr-rla] ${l}`);
console.log("  what the plugin got, inside the host:");
console.log(`    process.env.GITHUB_TOKEN                 ${seen.envToken}`);
console.log(`    process.env.AWS_SECRET_ACCESS_KEY        ${seen.otherSecret}`);
console.log(`    its whole environment                    ${seen.envKeys.join(", ")}`);
console.log(`    read ~/.npmrc                            ${r(seen.npmrc)}`);
console.log(`    read a file outside the plugin           ${r(seen.secretFile)}`);
console.log(`    read /proc/<parent>/environ              ${r(seen.procEnviron)}`);
console.log(`    write a file (own dir / tmp)             ${r(seen.writeOwnDir)} / ${r(seen.writeTmp)}`);
console.log(`    start a process                          ${r(seen.spawn)}`);
console.log(`    token to its declared host, echoed back  ${r(seen.echo)}`);
console.log(`    Basic auth to it, echoed back            ${r(seen.basicEcho)}`);
console.log(`    the placeholder to another declared host ${r(seen.placeholderToOtherDeclaredHost)}`);
console.log(`    the placeholder to an undeclared host    ${r(seen.placeholderToUndeclaredHost)}`);
console.log(`    prrla-basic: to an undeclared host       ${r(seen.basicToUndeclaredHost)}`);
console.log(`    global fetch() to an undeclared host     ${r(seen.globalFetch)}`);
console.log(`    POST (provider requests are read-only)   ${r(seen.post)}`);
console.log(`    open a socket to 127.0.0.1               ${r(seen.socket)}${received ? ` (the server received "${received}")` : ""}`);
console.log(`    the token over http / to port 8443       ${r(seen.httpDowngrade)} / ${r(seen.otherPort)}`);
console.log(`    after a redirect from https to http      ${r(seen.redirectDowngrade)}`);
console.log(`    the placeholder in X-Echo                ${r(seen.otherHeader)}`);
console.log(`    a mutation in a GraphQL URL (POST / GET) ${r(seen.graphqlPostUrl)} / ${r(seen.graphqlGetMutation)}`);
console.log(`    GET with X-HTTP-Method-Override: DELETE  ${r(seen.methodOverride)}`);
console.log(`    the token echoed raw, %-encoded, base64  ${r(seen.echoForms)}`);
console.log("  what the fake api.github.com received (the broker swapped the placeholder there, and only there):");
for (const l of atServer.slice(0, theirServer)) console.log(`    ${l}`);
console.log("  a third party runs the same audit, with the same secrets set, without approving the plugin on their machine:");
for (const l of theirs) console.log(`    [pr-rla] ${l}`);
console.log(`    process.env.GITHUB_TOKEN in the plugin   ${seenByThird.envToken}`);
console.log(`    the token to its declared host           ${r(seenByThird.echo)}`);
console.log(`    requests that reached the server         ${atServer.length - theirServer}, ${atServer.slice(theirServer).some((l) => l.includes(SECRETS.GITHUB_TOKEN)) ? "one carried the token" : "none carrying the token"}`);
