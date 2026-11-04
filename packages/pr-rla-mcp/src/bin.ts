#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPrRlaMcp } from "./server.js";
import { PR_RLA_MCP_VERSION } from "./version.js";

const USAGE = `pr-rla-mcp ${PR_RLA_MCP_VERSION}: a read-only MCP server for pr-rla audits, over stdio.

usage: pr-rla-mcp [--root <dir>]... [--plugins builtin-only]

  --root <dir>              a directory the tools may open (repeatable; default: the working directory)
  --plugins builtin-only    refuse every external provider and ledger (as PR_RLA_PLUGINS=builtin-only does)
  --handoff-ms <n>          for tests: hand a long call off as a job after n ms (1..25000; default 25000)

Tokens come from the environment: give the server a read-only token (GITHUB_TOKEN, GITLAB_TOKEN, …).`;

function parse(argv: string[]): { roots: string[]; plugins?: "builtin-only"; handoffMs?: number } {
  const roots: string[] = [];
  let plugins: "builtin-only" | undefined;
  let handoffMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--root") roots.push(value());
    else if (a === "--plugins") {
      const v = value();
      if (v !== "builtin-only") throw new Error(`--plugins ${v}: the only value is builtin-only`);
      plugins = v;
    } else if (a === "--handoff-ms") handoffMs = Number(value());
    else if (a === "--version") {
      process.stdout.write(`${PR_RLA_MCP_VERSION}\n`);
      process.exit(0);
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}\n\n${USAGE}`);
  }
  return { roots, ...(plugins ? { plugins } : {}), ...(handoffMs !== undefined ? { handoffMs } : {}) };
}

try {
  const args = parse(process.argv.slice(2));
  const mcp = createPrRlaMcp({ roots: args.roots, env: process.env, ...(args.plugins ? { plugins: args.plugins } : {}), ...(args.handoffMs !== undefined ? { limits: { handoffMs: args.handoffMs } } : {}) });
  serveStdio(mcp.factory, { onerror: (e) => process.stderr.write(`[pr-rla-mcp] ${e.message}\n`) });
  // The client closed stdin: stop the jobs' requests, so the process can exit.
  process.stdin.on("close", () => mcp.close());
} catch (e) {
  process.stderr.write(`pr-rla-mcp: ${(e as Error).message}\n`);
  process.exit(1);
}
