import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRng } from "../src/core/simulate.js";
import { attrFiles, linguistGenerated, matchCompiled, compilePattern, attrBudget } from "../src/core/generated.js";

/**
 * pr-rla's linguist-generated matcher (src/core/generated.ts) against git's own: `git check-attr`
 * on the same .gitattributes files and paths, in a scratch repository with no global or system
 * attributes. Every difference is a failure. (U5 fix round: the hand-rolled matcher it replaced
 * disagreed with git on [!x] and "/", [!], lines git rejects, unclosed classes, a trailing "\" and
 * nested files.)
 */

const GIT_ENV = { PATH: process.env.PATH ?? "", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", LC_ALL: "C" };

/** git's verdict for each path: linguist-generated set or "true". */
function gitGenerated(files: Record<string, string>, paths: string[]): boolean[] {
  const dir = mkdtempSync(join(tmpdir(), "prrla-attr-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, env: GIT_ENV });
  for (const [d, text] of Object.entries(files)) {
    const p = join(dir, d, ".gitattributes");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const out = execFileSync("git", ["-c", "core.attributesFile=/dev/null", "check-attr", "-z", "--stdin", "linguist-generated"], { cwd: dir, env: GIT_ENV, input: paths.map((p) => `${p}\0`).join(""), maxBuffer: 64 * 1024 * 1024 });
  const f = out.toString("utf8").split("\0");
  const res = new Map<string, string>();
  for (let i = 0; i + 2 < f.length; i += 3) res.set(f[i]!, f[i + 2]!);
  return paths.map((p) => {
    const v = res.get(p);
    if (v === undefined) throw new Error(`git check-attr said nothing for ${JSON.stringify(p)}`);
    return v === "set" || v.toLowerCase() === "true";
  });
}

function ours(files: Record<string, string>, paths: string[]): boolean[] {
  // Every directory the paths pass through is read; a directory with no file is null.
  const texts: Record<string, string | null> = {};
  for (const p of paths) {
    const parts = p.split("/").slice(0, -1);
    for (let i = 0; i <= parts.length; i++) texts[parts.slice(0, i).join("/")] ??= null;
  }
  Object.assign(texts, files);
  const parsed = attrFiles(texts);
  return paths.map((p) => linguistGenerated(parsed, p) === true);
}

const agree = (files: Record<string, string>, paths: string[]) => {
  const g = gitGenerated(files, paths);
  const o = ours(files, paths);
  const diffs = paths.flatMap((p, i) => (g[i] !== o[i] ? [`${JSON.stringify(p)}: git ${g[i]}, pr-rla ${o[i]}`] : []));
  expect(diffs, JSON.stringify(files)).toEqual([]);
};

describe("linguist-generated agrees with git check-attr", () => {
  it("the patterns the old matcher got wrong: [!x] and /, [!], unclosed [, a trailing \\, a reversed range", () => {
    const paths = ["a/b", "ab", "a!b", "a]b", "a[b", "x\\", "x", "z", "m", "a-b", "q/r/s"];
    agree({ "": "a[!x]b linguist-generated\n" }, paths);
    agree({ "": "a[!]b linguist-generated\n" }, paths);
    agree({ "": "a[!]]b linguist-generated\n" }, paths);
    agree({ "": "a[b linguist-generated\n" }, paths);
    agree({ "": "x\\ linguist-generated\n" }, paths);
    agree({ "": "[z-a] linguist-generated\n" }, paths);
    agree({ "": "[]a]b linguist-generated\n" }, paths);
    agree({ "": "a[[:alpha:]-]b linguist-generated\n" }, paths);
    agree({ "": "a[[:nope:]]b linguist-generated\n[[:digit:]] linguist-generated\n" }, paths);
    agree({ "": "q/[!s]/s linguist-generated\nq/?/s linguist-generated\n" }, paths);
  });

  it("lines git rejects are ignored whole: a trailing # comment, a comma, a lone -, builtin_, a negative pattern, 2,048 bytes", () => {
    const paths = ["x.lock.yml", "y.gen", "z.c", "w.txt", "!w.txt", "v.md"];
    agree({ "": "*.lock.yml linguist-generated # compiled\n" }, paths);
    agree({ "": "*.gen linguist-generated,binary\n*.c - linguist-generated\n*.txt builtin_objectmode linguist-generated\n" }, paths);
    agree({ "": "* linguist-generated\n!w.txt -linguist-generated\n\\!w.txt -linguist-generated\n" }, paths);
    // git ignores a line of 2,048 bytes or more: the unset on a 2,047-byte line counts, on a 2,048-byte one it does not.
    const line = (n: number) => `${"v.md".padEnd(n - "-linguist-generated".length, " ")}-linguist-generated`;
    expect([line(2047).length, line(2048).length]).toEqual([2047, 2048]);
    agree({ "": `* linguist-generated\n${line(2047)}\n` }, paths);
    agree({ "": `* linguist-generated\n${line(2048)}\n` }, paths);
    expect(ours({ "": `* linguist-generated\n${line(2047)}\n` }, ["v.md"])).toEqual([false]);
    expect(ours({ "": `* linguist-generated\n${line(2048)}\n` }, ["v.md"])).toEqual([true]);
    agree({ "": "# * linguist-generated\n   # also\n\t*.c\tlinguist-generated\r\n" }, paths);
  });

  it("states, values and precedence: the last line wins, =true and =false, ! unspecifies", () => {
    const paths = ["a.js", "keep.js", "lib/x.js", "with space.js", "odd.js", "x.out", "plain.cfg", "a.ts", "lib/deep/y.js"];
    agree({ "": ["*.js linguist-generated", "keep.js -linguist-generated", "lib/*.js linguist-generated=false", '"with space.js" linguist-generated=true', "odd.js !linguist-generated", "x.out linguist-generated=TRUE", "plain.cfg linguist-generated=yes", ""].join("\n") }, paths);
    agree({ "": ["*.js -linguist-generated linguist-generated", "keep.js linguist-generated -linguist-generated", "lib/** linguist-generated=true", "lib/deep/y.js !linguist-generated linguist-generated"].join("\n") }, paths);
  });

  it("macros: defined after use, redefined, nested, set or not, and ignored outside the root file", () => {
    const paths = ["a.gen", "b.gen", "c.both", "d.unset", "sub/e.gen", "sub/f.local", "g.bin"];
    agree({ "": ["*.gen gen", "[attr]gen linguist-generated", "c.both outer", "[attr]outer gen -diff", "d.unset -gen", "b.gen gen=false", "g.bin binary"].join("\n") }, paths);
    agree({ "": ["[attr]gen linguist-generated", "[attr]gen -linguist-generated", "*.gen gen"].join("\n"), sub: ["[attr]local linguist-generated", "*.local local", "e.gen -gen"].join("\n") }, paths);
    agree({ "": ["[attr]binary linguist-generated", "*.bin binary"].join("\n") }, paths);
  });

  it("nested .gitattributes: deeper files win, patterns are relative to their directory", () => {
    const paths = ["x.lock.yml", "sub/x.lock.yml", "sub/keep.lock.yml", "sub/deep/x.lock.yml", "other/x.lock.yml", "sub/deep/z.txt", "sub/z.txt"];
    agree({ "": "*.lock.yml linguist-generated\n", sub: "keep.lock.yml -linguist-generated\n/deep/*.txt linguist-generated\n" }, paths);
    agree({ "": "*.lock.yml linguist-generated\n", sub: "* -linguist-generated\n", "sub/deep": "*.lock.yml linguist-generated\n" }, paths);
    agree({ "": "sub/*.lock.yml linguist-generated\n", sub: "/x.lock.yml -linguist-generated\n" }, paths);
  });

  it("** at the start, the end, between slashes, alone; elsewhere a plain *", () => {
    const paths = ["foo", "a/foo", "a/b/foo", "docs/slides/a.pdf", "docs/slides/x/y.pptx", "docs/slides", "a/b", "a/x/b", "a/x/y/b", "b", "ab", "a/b/c", "x/a**b", "axxb"];
    for (const p of ["**/foo", "docs/slides/**", "a/**/b", "a**b", "**", "a/**", "**/", "/**/foo", "a/**/**/b", "a/***/b", "x/a\\*\\*b", "**\\/b", "a*/b", "*/b", "*/*/foo"]) agree({ "": `${p} linguist-generated\n` }, paths);
  });

  it("quoted patterns, escapes and UTF-8 bytes", () => {
    const paths = ["a b.txt", "café.txt", "cafe.txt", "x\"y", "tab\there", "n.c", "é", "ab"];
    agree({ "": ['"a b.txt" linguist-generated', '"caf\\303\\251.txt" linguist-generated', '"x\\"y" linguist-generated', '"tab\\there" linguist-generated', '"bad\\q" linguist-generated', '"n.c"linguist-generated', "? linguist-generated", "?? -linguist-generated"].join("\n") }, paths);
  });

  it("a seeded fuzz of 2,000 patterns from a small alphabet, against git, agrees everywhere", () => {
    const rng = makeRng(20261104);
    const pick = <T>(a: readonly T[]) => a[Math.floor(rng() * a.length)]!;
    const patAtoms = ["a", "b", "/", "*", "**", "?", "[ab]", "[!a]", "[a-b]", "[^/]", "\\*", ".", "-", "["] as const;
    const pathAtoms = ["a", "b", "/", ".", "-", "ab", "*", "["] as const;
    const paths = new Set<string>();
    while (paths.size < 120) {
      let s = "";
      const n = 1 + Math.floor(rng() * 8);
      for (let i = 0; i < n; i++) s += pick(pathAtoms);
      s = s.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
      if (s && !s.split("/").some((x) => x === "." || x === ".." || x === "")) paths.add(s);
    }
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      let p = "";
      const n = 1 + Math.floor(rng() * 6);
      for (let k = 0; k < n; k++) p += pick(patAtoms);
      lines.push(`${p} ${rng() < 0.8 ? "linguist-generated" : "-linguist-generated"}`);
    }
    // In blocks of 40 lines, so each block's precedence is exercised too.
    for (let i = 0; i < lines.length; i += 40) agree({ "": `${lines.slice(i, i + 40).join("\n")}\n` }, [...paths]);
  }, 120_000);
});

describe("the matcher is linear: hostile patterns cost little", () => {
  it("*a*a*a*a*a*a*b against 200 a's (13.8 s and over 100 s with the regex matcher) takes milliseconds", () => {
    for (const k of [6, 8, 12, 30]) {
      const t0 = performance.now();
      expect(matchCompiled(compilePattern(`${"*a".repeat(k)}*b`, true), Buffer.from("a".repeat(200)))).toBe(false);
      expect(performance.now() - t0).toBeLessThan(200);
    }
    const t0 = performance.now();
    expect(matchCompiled(compilePattern(`${"**/".repeat(8)}x`, true), Buffer.from(`${"a/".repeat(60)}y`))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("a budget bounds the work: when it runs out, the answer is null (undecided), never a guess", () => {
    expect(matchCompiled(compilePattern(`${"*a".repeat(40)}*b`, true), Buffer.from("a".repeat(4000)), attrBudget(1000))).toBeNull();
  });
});
