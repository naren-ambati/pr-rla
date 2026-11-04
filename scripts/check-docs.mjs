// The doc check (FR8.2 and the accuracy pass, U10). `npm run docs:check` runs it; test/docs.test.ts
// runs the same functions in `npm test`. It reads the repository's Markdown and, to re-run the
// generated output blocks and to read the CLI's commands and options, the built dist/ (npm run build).
//
// It fails on:
//   - a fenced block in the docs with no language, or one it does not know;
//   - an output block whose caption (the line before it) does not say when it was run
//     (`run YYYY-MM-DD` or `recorded YYYY-MM-DD`), or names a date in the future;
//   - a block that looks like pr-rla's output but is not marked as output;
//   - a generated block that no longer matches a fresh run (scripts/docs-outputs.mjs);
//   - a relative link or anchor that does not resolve (offline: http and mailto links are not fetched);
//   - a `pr-rla` command or option the CLI does not have;
//   - an exit-code table that disagrees with contracts.md §7 or src/cli/exit-codes.ts, or an exit code
//     outside 0–6 named for pr-rla.
// It lists the `pending` hooks (`<!-- pending P1: … -->`, `<!-- pending S1: … -->`) still in the docs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OUTPUTS, generatedBlocks, masked, runOutput } from "./docs-outputs.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every Markdown file git tracks or would track (not ignored), relative to the repository. */
export function markdownFiles(root = ROOT) {
  return spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], { cwd: root, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
}

/**
 * The docs the output and command rules apply to: everything a reader is pointed at. The design record
 * (docs/design), the build log (BUILD-NOTES.md, docs/build-notes) and fixture data (test/fixtures, the
 * hashed review protocols) are records of their own dates, and are only link-checked.
 */
export const isUserDoc = (f) => !/^BUILD-NOTES\.md$|^docs\/design\/|^docs\/build-notes\/|^test\/fixtures\/|(^|\/)review-protocol\.md$/.test(f);

const LANGS = new Set(["sh", "bash", "zsh", "console", "yaml", "yml", "json", "jsonc", "toml", "ts", "typescript", "js", "javascript", "mjs", "text", "mermaid", "diff", "ini", "output"]);

/** The fenced blocks of a Markdown text: `{ line, info, lang, body, caption }` (line is 1-based; caption is the last non-blank line before it). */
export function fencedBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) continue;
    const fence = open[2];
    let end = i + 1;
    while (end < lines.length && !(lines[end].trimStart().startsWith(fence) && lines[end].trim().replace(/[`~]/g, "") === "")) end++;
    let c = i - 1;
    while (c >= 0 && lines[c].trim() === "") c--;
    const info = open[3].trim();
    out.push({ line: i + 1, info, lang: info.split(/\s+/)[0] ?? "", body: lines.slice(i + 1, end).join("\n"), caption: c >= 0 ? lines[c] : "" });
    i = end;
  }
  return out;
}

/** Lines pr-rla prints that no command, config or code block contains: a block holding one shows output. */
const OUTPUT_SHAPES = [
  /^\s*[1-7]\. (PASS|WARN|FAIL|SKIP|INCOMPLETE) \S/,
  /^(VERIFIED|INCOMPLETE|FAILED)(: | ·|$)/,
  /^\s*prefix \d+\/\d+ · fails \d+ ·/,
  /^\[dry run\] /,
  /^\s*timestamps: (\d+ of \d+ TSAs|not requested|no authority)/,
  /^\s*certified [\d.]+% of [\d,]+ simulated audits/,
  /^\s*estimate: \d+ repos/,
  /^(blocked|allowed):?$/,
  /^\s*\(exit \d+\)$/,
  /^\s*pr-rla: stopped after \d+ of \d+ repos/,
  /^\s*registration [0-9a-f]{12}… · /,
];

const DATE = /\b(run|recorded) (\d{4}-\d{2}-\d{2})\b/i;

/** Problems with one doc's fenced blocks (classification, dated output, output-shaped blocks not marked as output). */
export function blockProblems(file, text, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const problems = [];
  for (const b of fencedBlocks(text)) {
    const at = `${file}:${b.line}`;
    if (!b.lang) {
      problems.push(`${at}: a fenced block has no language (use output for what a command printed, text for anything else)`);
      continue;
    }
    if (!LANGS.has(b.lang)) problems.push(`${at}: unknown block language "${b.lang}"`);
    if (b.lang === "output") {
      const d = DATE.exec(b.caption);
      if (!d) problems.push(`${at}: an output block must be introduced by a line that says when it was run ("run YYYY-MM-DD" or "recorded YYYY-MM-DD"); found: ${JSON.stringify(b.caption.slice(0, 120))}`);
      else if (Number.isNaN(Date.parse(d[2])) || d[2] > today || d[2] < "2026-10-01") problems.push(`${at}: output block dated ${d[2]}, which is not a date it could have been run`);
      continue;
    }
    const shaped = b.body.split("\n").find((l) => !/^\s*#/.test(l) && OUTPUT_SHAPES.some((re) => re.test(l)));
    if (shaped) problems.push(`${at}: this ${b.lang} block looks like pr-rla's output (${JSON.stringify(shaped.trim().slice(0, 80))}): mark it output, with the date it was run, or rewrite it`);
  }
  return problems;
}

/** Generated blocks (scripts/docs-outputs.mjs) whose text no longer matches a fresh run. */
export function staleOutputs(files, root = ROOT, cache = new Map()) {
  const problems = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    for (const b of generatedBlocks(text)) {
      if (!OUTPUTS[b.id]) {
        problems.push(`${f}:${b.start + 1}: names generated output "${b.id}", which scripts/docs-outputs.mjs does not define`);
        continue;
      }
      if (!cache.has(b.id)) cache.set(b.id, runOutput(b.id));
      const fresh = masked(b.id, cache.get(b.id));
      const have = masked(b.id, b.body);
      if (fresh === have) continue;
      const a = have.split("\n");
      const z = fresh.split("\n");
      const n = a.findIndex((l, i) => l !== z[i]);
      const k = n === -1 ? a.length : n;
      problems.push(`${f}:${b.start + 2 + k}: generated output "${b.id}" differs from a fresh run (doc: ${JSON.stringify((a[k] ?? "").slice(0, 80))}, now: ${JSON.stringify((z[k] ?? "").slice(0, 80))}); run npm run docs:outputs`);
    }
  }
  return problems;
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens, repeats numbered. */
export function headingAnchors(text) {
  const anchors = new Set();
  const seen = new Map();
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const slug = h[1].replace(/<[^>]+>/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
      const n = seen.get(slug) ?? 0;
      seen.set(slug, n + 1);
      anchors.add(n ? `${slug}-${n}` : slug);
    }
    for (const a of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(a[1]);
  }
  return anchors;
}

/** Every relative link and anchor in the given Markdown files resolves, offline. */
export function linkProblems(files, root = ROOT) {
  const problems = [];
  const anchorCache = new Map();
  const anchorsOf = (p) => {
    if (!anchorCache.has(p)) anchorCache.set(p, headingAnchors(readFileSync(p, "utf8")));
    return anchorCache.get(p);
  };
  let count = 0;
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    let fence = null;
    text.split("\n").forEach((line, i) => {
      const fm = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fm) {
        if (!fence) fence = fm[1];
        else if (line.trim().startsWith(fence)) fence = null;
        return;
      }
      if (fence) return;
      const prose = line.replace(/`[^`]*`/g, "");
      const targets = [...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), ...prose.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/g)].map((m) => m[1]);
      for (const t of targets) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(t)) continue; // https:, mailto:, … (not fetched: offline)
        count++;
        const hash = t.indexOf("#");
        const path = hash === -1 ? t : t.slice(0, hash);
        const anchor = hash === -1 ? null : decodeURIComponent(t.slice(hash + 1));
        const target = path ? normalize(join(root, dirname(f), decodeURIComponent(path))) : join(root, f);
        if (!target.startsWith(root)) problems.push(`${f}:${i + 1}: link ${t} leaves the repository`);
        else if (!existsSync(target)) problems.push(`${f}:${i + 1}: link ${t}: ${normalize(join(dirname(f), path))} does not exist`);
        else if (anchor !== null && anchor !== "" && statSync(target).isFile() && target.endsWith(".md") && !anchorsOf(target).has(anchor)) problems.push(`${f}:${i + 1}: link ${t}: no heading #${anchor} in ${normalize(join(dirname(f), path || f.split("/").pop()))}`);
      }
    });
  }
  return { problems, count };
}

/** The CLI's commands and options, read from the program the CLI builds (dist/cli.js). */
export async function cliSurface(root = ROOT) {
  const { buildProgram } = await import(pathToFileURL(join(root, "dist", "cli.js")).href);
  const program = buildProgram(() => ({}), () => {});
  const longs = (cmd) => new Set([...cmd.options.map((o) => o.long).filter(Boolean), "--help"]);
  const commands = new Map();
  for (const c of program.commands) {
    commands.set(c.name(), { options: longs(c), subcommands: new Map(c.commands.map((s) => [s.name(), longs(s)])) });
  }
  return { global: new Set([...longs(program), "--version"]), globalShort: new Set(["-C", "-c", "-V", "-h"]), commands };
}

/**
 * Splits shell text into simple commands (outside quotes, on `;`, `&&`, `||`, `|`, `&`, parentheses,
 * `$(` and backticks), each a list of words, with leading `VAR=value` words and the wrappers `env`,
 * `time`, `exec` and `nohup` dropped.
 */
export function simpleCommands(text) {
  const commands = [[]];
  let word = null;
  const push = () => {
    if (word !== null) commands[commands.length - 1].push(word);
    word = null;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      const j = close === -1 ? text.length : close;
      word = (word ?? "") + text.slice(i + 1, j);
      i = j;
    } else if (/\s/.test(c)) push();
    else if (";&|()`".includes(c) || (c === "$" && text[i + 1] === "(")) {
      push();
      if (c === "$") i++;
      commands.push([]);
    } else word = (word ?? "") + c;
  }
  push();
  return commands
    .map((w) => {
      let k = 0;
      while (k < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k]) || ["env", "time", "exec", "nohup"].includes(w[k]))) k++;
      return w.slice(k);
    })
    .filter((w) => w.length);
}

/** `pr-rla …` invocations in a doc, in command position: in shell blocks, in output blocks' `$` lines, and in inline code. */
export function cliMentions(text) {
  const out = [];
  const take = (segment, line) => {
    for (const words of simpleCommands(segment)) {
      const isCli = words[0] === "pr-rla" || (words[0] === "node" && /(^|\/)dist\/cli\.js$/.test(words[1] ?? ""));
      if (!isCli) continue;
      const args = words.slice(words[0] === "pr-rla" ? 1 : 2);
      // `pr-rla guard` is the guard hook's name (its status message and block reason), not a command.
      if (args[0] === "guard") continue;
      out.push({ line, args });
    }
  };
  let fence = null;
  let lang = "";
  text.split("\n").forEach((raw, i) => {
    const fm = /^\s*(`{3,}|~{3,})(\S*)/.exec(raw);
    if (fm) {
      if (!fence) {
        fence = fm[1];
        lang = fm[2];
      } else if (raw.trim().startsWith(fence)) fence = null;
      return;
    }
    if (fence) {
      if (["sh", "bash", "zsh", "console"].includes(lang)) take(raw.replace(/(^|\s)#.*$/, ""), i + 1);
      else if (lang === "output" && /^\$ /.test(raw)) take(raw.slice(2), i + 1);
      return;
    }
    for (const code of raw.matchAll(/`([^`]+)`/g)) take(code[1], i + 1);
  });
  return out;
}

const placeholder = (t) => /^[<[{…]|^\.\.\.|…/.test(t) || /^\$/.test(t);

/** Problems with the commands and options the docs name, against the CLI's own definition. */
export function cliProblems(file, text, surface) {
  const problems = [];
  for (const { line, args: t } of cliMentions(text)) {
    const args = t.join(" ");
    let i = 0;
    const flag = (tok, allowed) => {
      const name = tok.split("=")[0];
      if (!allowed.has(name)) problems.push(`${file}:${line}: pr-rla ${args.slice(0, 60)}: no option ${name}`);
    };
    // Global options, then the command.
    while (i < t.length && t[i].startsWith("-")) {
      const tok = t[i];
      if (tok.startsWith("--")) {
        flag(tok, surface.global);
        if (["--dir", "--config", "--from-file", "--plugins"].includes(tok.split("=")[0]) && !tok.includes("=")) i++;
      } else if (surface.globalShort.has(tok)) {
        if (tok === "-C" || tok === "-c") i++;
      } else problems.push(`${file}:${line}: pr-rla ${args.slice(0, 60)}: no option ${tok}`);
      i++;
    }
    const name = t[i];
    if (name === undefined || placeholder(name) || /^\d/.test(name) || /^[A-Z]/.test(name)) continue;
    const cmd = surface.commands.get(name);
    if (!cmd) {
      problems.push(`${file}:${line}: pr-rla ${args.slice(0, 60)}: no command "${name}"`);
      continue;
    }
    let allowed = cmd.options;
    i++;
    if (cmd.subcommands.size && t[i] !== undefined && !t[i].startsWith("-") && !placeholder(t[i])) {
      const sub = cmd.subcommands.get(t[i]);
      if (!sub) {
        problems.push(`${file}:${line}: pr-rla ${args.slice(0, 60)}: no command "${name} ${t[i]}"`);
        continue;
      }
      allowed = sub;
      i++;
    }
    for (; i < t.length; i++) if (t[i].startsWith("--")) flag(t[i], new Set([...allowed, ...surface.global]));
  }
  return problems;
}

/** The rows of a Markdown table whose first cell is an exit code: code → the row's text. */
function codeRows(text) {
  const rows = new Map();
  for (const l of text.split("\n")) {
    const m = /^\|\s*(\d+)\s*\|(.*)\|\s*$/.exec(l);
    if (m) rows.set(Number(m[1]), m[2]);
  }
  return rows;
}

/** What each code means, by the word every table must carry for it. */
export const EXIT_KEYWORDS = { 0: /success/i, 1: /FAIL/, 2: /ESCALATE/, 3: /minimum/i, 4: /stopped/i, 5: /timestamps/i, 6: /INCOMPLETE/ };

/** The compatibility table's exit codes against contracts.md §7 and src/cli/exit-codes.ts; and no doc naming a pr-rla exit code outside them. */
export async function exitCodeProblems(files, root = ROOT) {
  const problems = [];
  const { EXIT } = await import(pathToFileURL(join(root, "dist", "cli", "exit-codes.js")).href);
  const codes = Object.values(EXIT).sort((a, b) => a - b);
  const contracts = readFileSync(join(root, "docs", "design", "phase-3-4", "contracts.md"), "utf8");
  const s7 = contracts.slice(contracts.indexOf("## 7. CLI exit codes"), contracts.indexOf("**`--json`:**"));
  const compat = readFileSync(join(root, "docs", "compatibility.md"), "utf8");
  const table = compat.slice(compat.indexOf("## Exit codes"));
  for (const [name, rows] of [["contracts.md §7", codeRows(s7)], ["docs/compatibility.md", codeRows(table.slice(0, table.indexOf("\n## ", 5) === -1 ? undefined : table.indexOf("\n## ", 5)))]]) {
    const have = [...rows.keys()].sort((a, b) => a - b);
    if (JSON.stringify(have) !== JSON.stringify(codes)) problems.push(`${name}: exit codes ${have.join(", ")}; src/cli/exit-codes.ts has ${codes.join(", ")}`);
    for (const c of codes) if (rows.has(c) && !EXIT_KEYWORDS[c].test(rows.get(c))) problems.push(`${name}: exit ${c}'s row does not say ${EXIT_KEYWORDS[c]}`);
  }
  for (const f of files.filter(isUserDoc)) {
    readFileSync(join(root, f), "utf8").split("\n").forEach((l, i) => {
      for (const m of l.matchAll(/\bexits? (?:with )?(?:code )?(\d+)\b|\(exit (\d+)\)|\bexit code (\d+)\b/g)) {
        const n = Number(m[1] ?? m[2] ?? m[3]);
        if (!codes.includes(n)) problems.push(`${f}:${i + 1}: names exit code ${n}, which pr-rla does not have`);
      }
    });
  }
  return problems;
}

/**
 * The hooks a later round completes: `<!-- pending P1: … -->` and `<!-- pending S1: … -->` comments. The same
 * text quoted in inline code or in a fenced block (a page describing the convention) is not a hook.
 */
export function pendingHooks(files, root = ROOT) {
  const out = [];
  for (const f of files) {
    let fence = null;
    readFileSync(join(root, f), "utf8").split("\n").forEach((l, i) => {
      const fm = /^\s*(`{3,}|~{3,})/.exec(l);
      if (fm) {
        if (!fence) fence = fm[1];
        else if (l.trim().startsWith(fence)) fence = null;
        return;
      }
      if (fence) return;
      for (const m of l.replace(/`[^`]*`/g, "").matchAll(/<!-- pending ([A-Za-z0-9]+): (.*?) -->/g)) out.push({ at: `${f}:${i + 1}`, round: m[1], what: m[2] });
    });
  }
  return out;
}

/** Every check, for every file: `{ problems, pending, links }`. */
export async function checkDocs({ root = ROOT, today, rerun = true } = {}) {
  const files = markdownFiles(root);
  const user = files.filter(isUserDoc);
  const surface = await cliSurface(root);
  const problems = [];
  for (const f of user) {
    const text = readFileSync(join(root, f), "utf8");
    problems.push(...blockProblems(f, text, today ? { today } : {}), ...cliProblems(f, text, surface));
  }
  const links = linkProblems(files, root);
  problems.push(...links.problems, ...(await exitCodeProblems(files, root)));
  if (rerun) problems.push(...staleOutputs(user, root));
  return { problems, pending: pendingHooks(files, root), links: links.count };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!existsSync(join(ROOT, "dist", "cli.js"))) {
    console.error("docs:check: run npm run build first (it reads the CLI's commands from dist/)");
    process.exit(1);
  }
  const { problems, pending, links } = await checkDocs();
  for (const p of problems) console.log(`FAIL ${p}`);
  for (const p of pending) console.log(`pending (${p.round}) ${p.at}: ${p.what}`);
  console.log(`docs:check: ${problems.length} problem(s), ${links} relative links checked, ${pending.length} pending hook(s)`);
  process.exitCode = problems.length ? 1 : 0;
}
