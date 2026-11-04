// Loaded into the pr-rla-mcp process under test (node --import). It reports, on stderr:
//   PRRLA-WRITE-ATTEMPT <function> <path>  for every call that would create, change or remove a file;
//   PRRLA-NET-DENIED <host>                 for every socket to a host other than loopback (refused).
// The server also runs under Node's permission model with no fs-write grant, so a write would fail
// even if this spy missed it; the spy proves that none was attempted, even one some code caught.
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const say = (line) => {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* stderr closed */
  }
};
const W = fs.constants;
const writes = (flags) => (typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" ? (flags & (W.O_WRONLY | W.O_RDWR | W.O_CREAT | W.O_APPEND | W.O_TRUNC)) !== 0 : false);
const ALWAYS = ["writeFile", "appendFile", "mkdir", "rename", "rm", "unlink", "rmdir", "copyFile", "symlink", "link", "truncate", "chmod", "chown", "utimes", "lutimes", "mkdtemp", "cp", "createWriteStream"];
const wrap = (obj, name, check) => {
  const orig = obj[name];
  if (typeof orig !== "function") return;
  obj[name] = function (...args) {
    if (check(args)) say(`PRRLA-WRITE-ATTEMPT ${name} ${String(args[0])}`);
    return orig.apply(this, args);
  };
};
for (const n of ALWAYS) {
  wrap(fs, n, () => true);
  wrap(fs, `${n}Sync`, () => true);
  wrap(fsp, n, () => true);
}
wrap(fs, "open", (a) => writes(a[1]));
wrap(fs, "openSync", (a) => writes(a[1]));
wrap(fsp, "open", (a) => writes(a[1]));
syncBuiltinESMExports();

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  const host = typeof a === "object" && a && !a.path ? (a.host ?? "localhost") : typeof a === "number" ? (typeof args[1] === "string" ? args[1] : "localhost") : null;
  if (host !== null && !LOOPBACK.has(String(host).replace(/^\[|\]$/g, ""))) {
    say(`PRRLA-NET-DENIED ${host}`);
    throw new Error(`pr-rla-mcp test: no network beyond loopback (asked for ${host})`);
  }
  return connect.apply(this, args);
};
