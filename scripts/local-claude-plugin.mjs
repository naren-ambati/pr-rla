#!/usr/bin/env node
// Builds a copy of the Claude Code plugin (integrations/claude-code) that runs pr-rla-mcp from this checkout,
// for using the plugin before pr-rla and pr-rla-mcp are published (docs/assistants/claude-code.md, "Before release").
//
// usage: node scripts/local-claude-plugin.mjs <out-dir> [--bin <pr-rla-mcp bin.js>]
//   then: claude --plugin-dir <out-dir>
//
// Only .mcp.json differs from the plugin in the repo: `npx -y pr-rla-mcp@<version>` becomes this Node and
// <checkout>/packages/pr-rla-mcp/dist/bin.js. Every other file is copied byte for byte, so the skill, the hooks and
// the MCP tool names (mcp__plugin_pr-rla_pr-rla__*) are the released plugin's. Writes only inside <out-dir>.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "integrations", "claude-code");
const DEFAULT_BIN = join(ROOT, "packages", "pr-rla-mcp", "dist", "bin.js");
const MARKER = ".pr-rla-local-plugin.json";

function fail(message) {
  process.stderr.write(`local-claude-plugin: ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
  process.stdout.write("usage: node scripts/local-claude-plugin.mjs <out-dir> [--bin <pr-rla-mcp bin.js>]\n  then: claude --plugin-dir <out-dir>\n");
  process.exit(argv.length ? 0 : 1);
}
let arg = null;
let BIN = DEFAULT_BIN;
for (let k = 0; k < argv.length; k++) {
  if (argv[k] === "--bin") BIN = resolve(argv[++k] ?? "");
  else if (arg === null) arg = argv[k];
  else fail(`unexpected argument ${argv[k]}`);
}
if (arg === null) fail("give the directory to write the plugin copy to");
const out = resolve(arg);
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);
if (inside(out, realpathSync(PLUGIN)) || inside(out, PLUGIN) || inside(PLUGIN, out)) fail(`${out} overlaps the plugin in the repository; choose a directory outside ${PLUGIN}`);
if (!existsSync(BIN)) fail(`${relative(process.cwd(), BIN)} is missing: run "npm ci && npm run build" at the root and "npm --prefix packages/pr-rla-mcp ci && npm --prefix packages/pr-rla-mcp run build" first`);
if (existsSync(out) && readdirSync(out).length > 0) {
  // Rebuild a copy this script made; refuse anything else.
  if (!existsSync(join(out, MARKER))) fail(`${out} is not empty and was not made by this script; choose an empty or new directory`);
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });
cpSync(PLUGIN, out, { recursive: true });

const mcpPath = join(out, ".mcp.json");
const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
const server = mcp.mcpServers?.["pr-rla"];
if (!server || server.command !== "npx") fail("integrations/claude-code/.mcp.json no longer launches pr-rla-mcp through npx; update this script");
const pin = server.args.find((a) => /^pr-rla-mcp@/.test(a));
const rest = server.args.slice(server.args.indexOf(pin) + 1);
server.command = process.execPath;
server.args = [BIN, ...rest];
writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
writeFileSync(join(out, MARKER), `${JSON.stringify({ madeBy: "scripts/local-claude-plugin.mjs", checkout: ROOT, replaces: pin, node: process.execPath, bin: BIN }, null, 2)}\n`);

process.stdout.write(
  [
    `local plugin written to ${out}`,
    `  .mcp.json runs ${process.execPath} ${BIN} (in place of npx -y ${pin})`,
    "  everything else is integrations/claude-code as committed",
    "",
    "next:",
    `  claude plugin validate ${out}`,
    `  cd <your audit repo> && claude --plugin-dir ${out}`,
    "",
  ].join("\n"),
);
