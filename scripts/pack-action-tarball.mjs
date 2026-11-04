// Maintainer tool: re-pins the GitHub Action's pr-rla. pr-rla is not published, so the action's lockfile
// pins a tarball made by `npm pack` from this checkout (integrations/github-action/vendor/), and
// package-lock.json records that tarball's sha512 integrity.
//
// Usage: node scripts/pack-action-tarball.mjs        (builds, packs, rewrites package.json and the lockfile)
//
// A release replaces this with the published version; docs/ci/github.md ("Re-pinning at release") lists
// the exact changes. This script never publishes anything and makes no request but npm's own reads of the
// registry for the dependencies the lockfile already names.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const action = join(root, "integrations", "github-action");
const vendor = join(action, "vendor");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
run("npm", ["run", "build"], root);
mkdirSync(vendor, { recursive: true });
for (const f of existsSync(vendor) ? readdirSync(vendor) : []) if (/^pr-rla-.*\.tgz$/.test(f)) rmSync(join(vendor, f));
run("npm", ["pack", "--pack-destination", vendor], root);

const file = `vendor/pr-rla-${version}.tgz`;
const pkgPath = join(action, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.dependencies = { "pr-rla": `file:${file}` };
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
// npm keeps a stale integrity for a file: dependency whose bytes changed (from the lockfile, and from
// node_modules' hidden lockfile), so both go before the lockfile is rebuilt.
rmSync(join(action, "package-lock.json"), { force: true });
rmSync(join(action, "node_modules"), { recursive: true, force: true });
run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], action);

const lock = JSON.parse(readFileSync(join(action, "package-lock.json"), "utf8"));
const entry = lock.packages["node_modules/pr-rla"];
const sri = `sha512-${createHash("sha512").update(readFileSync(join(action, file))).digest("base64")}`;
if (entry.integrity !== sri) throw new Error(`the lockfile records ${entry.integrity}, but ${file} is ${sri}`);
console.log(`pinned pr-rla ${entry.version} from ${entry.resolved}\n  ${entry.integrity}`);
