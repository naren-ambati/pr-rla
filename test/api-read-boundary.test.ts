import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as read from "pr-rla/api/read";

/**
 * The import-graph guard of `pr-rla/api/read` (functional-design.md §U5; test-design.md §5):
 * the read-only subpath, the only part of pr-rla the MCP server imports, never reaches a write
 * function. The graph is the runtime one: every `import`/`export … from`/`import()` except the
 * `import type` statements the compiler erases.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(import|export)(\s+type\b)?([^;()=]*?)\bfrom\s*(["'])([^"']+)\4/g)) if (!m[2]) out.push(m[5]!);
  for (const m of text.matchAll(/(?:^|\n)\s*import\s*(["'])([^"']+)\1/g)) out.push(m[2]!);
  for (const m of text.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g)) out.push(m[2]!);
  return out;
}

function resolveSpecifier(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // node: builtins and packages are not pr-rla modules
  const base = resolve(dirname(from), spec);
  for (const c of [base.replace(/\.js$/, ".ts"), base, `${base}.ts`, join(base, "index.ts")]) if (existsSync(c) && c.endsWith(".ts")) return c;
  if (base.endsWith(".json") && existsSync(base)) return base;
  throw new Error(`${rel(from)}: cannot resolve ${spec}`);
}

function graph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    const deps = f.endsWith(".json") ? [] : runtimeImports(f).map((s) => resolveSpecifier(f, s)).filter((x): x is string => x !== null);
    seen.set(f, deps);
    todo.push(...deps);
  }
  return seen;
}

const ENTRY = join(SRC, "api", "read", "index.ts");
const reached = graph(ENTRY);
const files = [...reached.keys()].map(rel).sort();

/** A path from the entry to `target`, for the failure message. */
function pathTo(target: string): string {
  const prev = new Map<string, string>();
  const q = [ENTRY];
  const seen = new Set(q);
  while (q.length) {
    const f = q.shift()!;
    if (f === target) break;
    for (const d of reached.get(f) ?? []) if (!seen.has(d)) (seen.add(d), prev.set(d, f), q.push(d));
  }
  const chain = [target];
  while (prev.has(chain[0]!)) chain.unshift(prev.get(chain[0]!)!);
  return chain.map(rel).join(" -> ");
}

describe("pr-rla/api/read: the import graph (FR3.2, the read-only subpath)", () => {
  it("holds only the seven read functions, at runtime", () => {
    expect(Object.keys(read).sort()).toEqual(["auditList", "drawContext", "draws", "freezePreview", "simulate", "status", "verify"]);
  });

  it("the guard sees the graph: it reaches the read API, the core and the providers", () => {
    expect(files).toContain("src/api/read/status.ts");
    expect(files).toContain("src/core/draw-context.ts");
    expect(files).toContain("src/providers/github/describe.ts");
    expect(files.length).toBeGreaterThan(60);
  });

  it("never reaches src/api/write/, the git transport, the commands or the CLI", () => {
    const banned = files.filter((f) => f.startsWith("src/api/write/") || f === "src/io/git-transport.ts" || f.startsWith("src/commands/") || f === "src/cli.ts" || f === "src/api/checkpoint.ts" || f === "src/api/plugin-check.ts");
    expect(banned.map((f) => pathTo(join(ROOT, f)))).toEqual([]);
  });

  it("never imports a write entry point: no module reachable from it imports a writer by name", () => {
    // The writers of audit records, keys, locks and the audit repo's git history.
    const WRITERS = ["writeJson", "appendCheckpoint", "buildCheckpoint", "commitAndPush", "loadOrCreateKey", "writeLock", "obtainTimestamps", "submitSigned", "submitSignedV2", "register", "freeze", "sample", "record", "checkpoint", "initAudit", "commitPluginLock"];
    const offenders: string[] = [];
    for (const f of reached.keys()) {
      if (f.endsWith(".json")) continue;
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:^|\n)\s*import\s+(?!type\b)\{([^}]*)\}\s*from\s*["'][^"']+["']/g))
        for (const name of m[1]!.split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!))
          if (WRITERS.includes(name) && !m[0].includes("import type")) offenders.push(`${rel(f)} imports ${name}`);
    }
    expect(offenders).toEqual([]);
  });

  it("every module in the graph that can write a file is one whose writes the read-only mode cannot reach", () => {
    // The writing calls pr-rla makes. A module in this graph that uses one must be listed below with
    // the reason no read-only call reaches the write; a new one fails the test until it is reviewed.
    const WRITE_CALL = /\b(writeFileSync|appendFileSync|writeFile|appendFile|writeFileAtomic|writeIndex|mkdirSync|renameSync|rmSync|unlinkSync|createWriteStream|copyFileSync|writeSync)\b/;
    const ALLOWED: Record<string, string> = {
      "src/io/atomic.ts": "the primitive itself (temporary file, then rename); its callers are below",
      "src/plugins/lock.ts": "writeLock: called only by `plugin add` and `plugin lock` (src/api/write/plugin.ts), never imported by this graph",
      "src/plugins/open.ts": "ledgerIndexStore.write: refuses in a read-only context before writing (READ_ONLY_VIOLATION)",
      "src/ledgers/issue-index.ts": "writeIndex: called only by the issue ledgers' publishDraws and appendVerdict, which the read-only ledger view does not have",
      "src/ledgers/issue-ledger.ts": "publishDraws and appendVerdict: not on the read-only ledger view (openLedger in read-only mode)",
      "src/ledgers/git-file.ts": "appendVerdict: not on the read-only ledger view",
      "src/core/signing.ts": "loadOrCreateKey: called only by register and freeze (src/api/write/), never imported by this graph",
    };
    const writers = files.filter((f) => !f.endsWith(".json") && WRITE_CALL.test(readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
    expect(writers.filter((f) => !(f in ALLOWED))).toEqual([]);
    // And the list is not stale: each entry is still in the graph and still writes.
    expect(Object.keys(ALLOWED).filter((f) => !writers.includes(f))).toEqual([]);
  });

  it("the write side does exist, so the guard is not vacuous", () => {
    const write = readdirSync(join(SRC, "api", "write")).filter((f) => f.endsWith(".ts")).sort();
    expect(write).toEqual(expect.arrayContaining(["checkpoint.ts", "freeze.ts", "record.ts", "register.ts", "sample.ts"]));
    // The CLI does reach them: the graph from src/cli.ts includes every write function.
    const cli = [...graph(join(SRC, "cli.ts")).keys()].map(rel);
    for (const f of write) expect(cli).toContain(`src/api/write/${f}`);
  });
});
