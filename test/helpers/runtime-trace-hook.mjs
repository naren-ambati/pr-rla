// Preloaded (node --import) by test/api-read-runtime.test.ts: records, in globalThis.__trace,
// every module this process loads (whatever imported it: a literal import, a namespace import,
// a computed import()), every call that would write a file (sync, callback or promise fs), and
// every child process started. Nothing here changes what the calls do.
import childProcess from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";

const trace = (globalThis.__trace = { loaded: [], writes: [], spawns: [] });
registerHooks({
  load(url, ctx, next) {
    trace.loaded.push(url);
    return next(url, ctx);
  },
});
const W = fs.constants;
const writing = (flags) => (typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" ? (flags & (W.O_WRONLY | W.O_RDWR | W.O_CREAT | W.O_APPEND | W.O_TRUNC)) !== 0 : false);
const ALWAYS = ["writeFile", "appendFile", "mkdir", "rename", "rm", "unlink", "rmdir", "copyFile", "symlink", "link", "truncate", "chmod", "chown", "utimes", "lutimes", "mkdtemp", "cp", "createWriteStream", "write", "writev"];
const wrap = (obj, name, check) => {
  const orig = obj[name];
  if (typeof orig !== "function") return;
  obj[name] = function (...args) {
    if (check(args)) trace.writes.push(`${name} ${String(args[0])}`);
    return orig.apply(this, args);
  };
};
for (const n of ALWAYS) {
  wrap(fs, n, () => true);
  wrap(fs, `${n}Sync`, () => true);
  wrap(fsp, n, () => true);
}
wrap(fs, "open", (a) => writing(a[1]));
wrap(fs, "openSync", (a) => writing(a[1]));
wrap(fsp, "open", (a) => writing(a[1]));
for (const n of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const orig = childProcess[n];
  childProcess[n] = function (...args) {
    const opts = args.find((a, i) => i > 0 && a && typeof a === "object" && !Array.isArray(a));
    trace.spawns.push({ fn: n, file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [], env: opts?.env ? Object.fromEntries(Object.entries(opts.env).filter(([k]) => k.startsWith("GIT_"))) : null });
    return orig.apply(this, args);
  };
}
syncBuiltinESMExports();
