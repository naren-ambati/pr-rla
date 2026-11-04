#!/usr/bin/env node
// Bolt 4 (U2b) demo, offline: the hostile fixture plugin (test/fixtures/plugins/hostile) is locked
// in a temporary audit repo and opened the way a command opens a provider, through the plugin host
// and the fetch broker. The broker's transport is a fake api.github.com that echoes the
// Authorization header it receives; nothing leaves the machine except one loopback socket the
// plugin tries to open. Run `npm run build` first; run it with another Node to compare
// (`/path/to/node25 scripts/demo-plugin-host.mjs`).
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditContext, openProvider } from "../dist/api/context.js";
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

let received = "";
const sock = createServer((s) => s.on("data", (d) => (received += d)));
await new Promise((r) => sock.listen(0, "127.0.0.1", r));

const atServer = [];
const transport = async (url, init) => {
  const auth = new Headers(init?.headers).get("authorization");
  atServer.push(`${init?.method ?? "GET"} ${url}  Authorization: ${auth}`);
  return new Response(JSON.stringify({ authorization: auth }), { status: 200, headers: { "content-type": "application/json" } });
};
const log = [];
const ctx = createAuditContext({ mode: "read-write", env: SECRETS, fetch: transport, log: (l) => log.push(l) });
const provider = await openProvider(ctx, { use: USE, options: { secretFile, socketPort: sock.address().port } }, dir);
const seen = JSON.parse((await provider.listChanges({ repo: "acme/widgets", window: { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" }, kinds: ["pull_request"] })).limitations[0]);
closeAllPluginHosts();
sock.close();

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
console.log("  what the fake api.github.com received (the broker swapped the placeholder there, and only there):");
for (const l of atServer) console.log(`    ${l}`);
