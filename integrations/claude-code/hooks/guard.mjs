#!/usr/bin/env node
// pr-rla guard: a pre-tool-use hook that keeps an AI assistant from acting as the reviewer.
//
// It reads one hook payload (JSON) on stdin and blocks the tool call when it would:
//   - write a verdict: `pr-rla record` (and `--sign`), or sign one with `ssh-keygen -Y sign -n pr-rla-verdict@v1`;
//   - run pr-rla's other write commands: `register`, `freeze`, `sample`, `init`, `checkpoint --push`, `--submit`;
//   - give consent: `pr-rla plugin approve|add|lock`, `--accept-lock-grants`, `PR_RLA_ACCEPT_LOCK_GRANTS`,
//     `PR_RLA_APPROVALS_FILE`;
//   - apply or remove a verdict label: `gh`/`glab` label edits, `gh api`/`glab api`, `curl`, `wget` or HTTPie writes
//     to label endpoints, or another MCP server's tool carrying a verdict label;
//   - change an audit record: Write/Edit/MultiEdit/apply_patch, shell redirects and file commands on
//     registration.json, manifest-commitment.json, *.manifest.json, draws.json, verdicts.jsonl, ledger-index.json,
//     ledger-publication.json, ledger-checkpoints.jsonl, ledger-history/, pr-rla.lock.json, .pr-rla.yml and the
//     approvals file; or git commands that commit verdicts.jsonl, force-push, or discard records in an audit repo;
//   - read the audit's signing key.
//
// One adapter per client: Claude Code (PreToolUse), Codex (PreToolUse) and Cursor (beforeShellExecution,
// beforeMCPExecution, beforeReadFile, preToolUse). The client is taken from --client, else guessed from the payload.
// A block exits 2 with the reason (contracts.md §7: 2 is an assistant hook block); anything it cannot read is
// blocked too. This is a speed bump, not a security boundary: see docs/assistants/guard.md.
//
// No dependencies: Node's built-ins only, so the file can be copied into a Codex or Cursor project as is.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const GUARD_VERSION = "0.1.0";

// ---------------------------------------------------------------------------------------------------------------
// What is protected
// ---------------------------------------------------------------------------------------------------------------

/** Audit record names, protected inside an audit repo (a directory tree with a `.pr-rla.yml` above it). */
const RECORD_NAMES = new Set(["registration.json", "manifest-commitment.json", "draws.json", "verdicts.jsonl", "ledger-index.json", "ledger-publication.json", "ledger-checkpoints.jsonl"]);
/** pr-rla's own file names, protected anywhere. */
const ALWAYS_NAMES = new Set(["pr-rla.lock.json", ".pr-rla.yml"]);
/** Default verdict labels (github-issues, gitlab-issues; a GitLab scoped spelling too). */
const DEFAULT_LABELS = ["pr-rla:pass", "pr-rla:fail", "pr-rla-pass", "pr-rla-fail", "pr-rla::pass", "pr-rla::fail"];
const LABEL_SHAPE = /^pr-rla\s*(?:::|:|-|_|\/)\s*(?:pass|fail)$/i;
const VERDICT_NAMESPACE = "pr-rla-verdict@v1";

/** pr-rla subcommands that only read (or, for `status --checkpoint` and plain `checkpoint`, append pr-rla's own local checkpoint line). */
const PRRLA_READ = new Set(["status", "verify", "draw-context", "simulate", "help"]);

const MAX_DEPTH = 8;
/** Variables whose value a program runs as a command line. */
const COMMAND_VARS = new Set(["GIT_PAGER", "PAGER", "GIT_EDITOR", "EDITOR", "VISUAL", "GIT_SEQUENCE_EDITOR", "GIT_SSH_COMMAND", "LESSOPEN", "MANPAGER"]);
/** git configuration keys whose value git runs as a command. */
const GIT_COMMAND_KEYS = /^(core\.(pager|editor|sshcommand|hookspath|fsmonitor|askpass)|sequence\.editor|diff\.external|credential\.helper|alias\.[^=]+|(diff|filter|merge)\.[^.]+\.(textconv|clean|smudge|process|driver)|pager\.[^=]+|gpg\.program|gpg\.ssh\.program)$/i;
/** Programs that print, search or compare their arguments and never run them. */
const NON_RUNNERS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "ack", "cat", "less", "more", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "jq", "yq", "ls", "which", "type", "man", "whatis", "apropos", "file", "stat", "diff", "cmp", "comm", "column", "nl", "od", "xxd", "hexdump", "strings", "base64", "shasum", "sha256sum", "md5", "md5sum", "test", "[", "printenv", "history", "help", "read", "basename", "dirname", "realpath", "readlink", "say", "tldr", "open"]);
const MAX_FILE = 256 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Shell tokenizer
// ---------------------------------------------------------------------------------------------------------------
//
// A word is a list of parts:
//   { t: "lit", s, q }   literal text (q: quoted)
//   { t: "var", name, q, alt? }   $NAME / ${NAME} / ${NAME:-alt}
//   { t: "dyn", q }      anything whose value the guard cannot know ($(...), `...`, $1, $((...)), ${x#y}, <(...))
//   { t: "glob", s }     an unquoted * ? [
//   { t: "brace", s }    an unquoted { , }
//   { t: "tilde" }       an unquoted leading ~
// Command substitutions are parsed too: their commands run, so they are checked like any other.

const OPS = ["&&", "||", ";;&", ";;", ";&", "|&", "|", ";", "&", "(", ")"];

class Tokenizer {
  constructor(src, depth) {
    this.src = src;
    this.i = 0;
    this.depth = depth;
    this.tokens = [];
    this.subs = []; // scripts found in substitutions, in order
    this.pendingHeredocs = [];
  }

  run() {
    const s = this.src;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === " " || c === "\t" || c === "\r") {
        this.i++;
        continue;
      }
      if (c === "\\" && s[this.i + 1] === "\n") {
        this.i += 2;
        continue;
      }
      if (c === "\n") {
        this.tokens.push({ k: "op", v: "\n" });
        this.i++;
        this.readHeredocBodies();
        continue;
      }
      if (c === "#") {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
        continue;
      }
      // Arithmetic command (( ... )): no command runs inside, skip it.
      if (c === "(" && s[this.i + 1] === "(") {
        const end = s.indexOf("))", this.i + 2);
        this.i = end < 0 ? s.length : end + 2;
        continue;
      }
      if ((c === "<" || c === ">") && s[this.i + 1] === "(") {
        this.tokens.push(this.readWord());
        continue;
      }
      const redir = this.matchRedirect();
      if (redir) {
        this.tokens.push(redir);
        continue;
      }
      const op = OPS.find((o) => s.startsWith(o, this.i));
      if (op) {
        this.tokens.push({ k: "op", v: op });
        this.i += op.length;
        continue;
      }
      this.tokens.push(this.readWord());
    }
    this.readHeredocBodies();
    return this;
  }

  matchRedirect() {
    const m = /^(\d*)(&>>|&>|<<<|<<-|<<|<>|<&|>&|>>|>\||<|>)/.exec(this.src.slice(this.i, this.i + 8));
    if (!m) return null;
    if (m[1] && /[^\s;&|()<>]/.test(this.src[this.i - 1] ?? " ")) return null; // digits inside a word
    this.i += m[0].length;
    const op = m[2];
    this.skipBlanks();
    const target = this.i < this.src.length && !"\n;&|()".includes(this.src[this.i]) ? this.readWord() : null;
    const tok = { k: "redir", op, fd: m[1] ? Number(m[1]) : null, target };
    if ((op === "<<" || op === "<<-") && target) {
      const delim = wordLiteral(target) ?? "";
      this.pendingHeredocs.push({ tok, delim, strip: op === "<<-" });
    }
    return tok;
  }

  skipBlanks() {
    while (this.src[this.i] === " " || this.src[this.i] === "\t") this.i++;
  }

  readHeredocBodies() {
    if (!this.pendingHeredocs.length) return;
    const s = this.src;
    for (const h of this.pendingHeredocs) {
      let body = "";
      while (this.i < s.length) {
        let end = s.indexOf("\n", this.i);
        if (end < 0) end = s.length;
        let line = s.slice(this.i, end);
        this.i = Math.min(end + 1, s.length);
        if (h.strip) line = line.replace(/^\t+/, "");
        if (line === h.delim) break;
        body += `${line}\n`;
      }
      h.tok.heredoc = body;
    }
    this.pendingHeredocs = [];
  }

  /** A word, up to unquoted blank or operator. */
  readWord() {
    const s = this.src;
    const start = this.i;
    const parts = [];
    let lit = "";
    let litQ = false;
    const flush = () => {
      if (lit) parts.push({ t: "lit", s: lit, q: litQ });
      lit = "";
      litQ = false;
    };
    const addLit = (text, q) => {
      if (lit && litQ !== q) flush();
      litQ = q;
      lit += text;
    };
    while (this.i < s.length) {
      const c = s[this.i];
      if (" \t\r\n;&|()".includes(c)) {
        // `<(`/`>(` process substitution is handled below; a lone ( or ) ends the word.
        break;
      }
      if ((c === "<" || c === ">") && s[this.i + 1] === "(") {
        flush();
        const inner = this.matchParen(this.i + 1);
        this.sub(inner.text);
        parts.push({ t: "dyn", q: false });
        this.i = inner.end;
        continue;
      }
      if (c === "<" || c === ">") break;
      if (c === "\\") {
        if (s[this.i + 1] === "\n") {
          this.i += 2;
          continue;
        }
        addLit(s[this.i + 1] ?? "", true);
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        const stop = end < 0 ? s.length : end;
        addLit(s.slice(this.i + 1, stop), true);
        this.i = stop + 1;
        continue;
      }
      if (c === "$" && s[this.i + 1] === "'") {
        const r = readAnsiC(s, this.i + 2);
        addLit(r.text, true);
        this.i = r.end;
        continue;
      }
      if (c === '"' || (c === "$" && s[this.i + 1] === '"')) {
        flush();
        this.i += c === "$" ? 2 : 1;
        this.readDouble(parts);
        continue;
      }
      if (c === "$") {
        flush();
        this.readDollar(parts, false);
        continue;
      }
      if (c === "`") {
        flush();
        this.readBacktick(parts, false);
        continue;
      }
      if (c === "~" && this.i === start) {
        flush();
        parts.push({ t: "tilde" });
        this.i++;
        continue;
      }
      if (c === "*" || c === "?" || c === "[") {
        flush();
        parts.push({ t: "glob", s: c });
        this.i++;
        continue;
      }
      if (c === "{" || c === "," || c === "}") {
        flush();
        parts.push({ t: "brace", s: c });
        this.i++;
        continue;
      }
      addLit(c, false);
      this.i++;
    }
    flush();
    const raw = s.slice(start, this.i);
    return { k: "word", parts, raw };
  }

  readDouble(parts) {
    const s = this.src;
    let lit = "";
    const flush = () => {
      if (lit) parts.push({ t: "lit", s: lit, q: true });
      lit = "";
    };
    while (this.i < s.length && s[this.i] !== '"') {
      const c = s[this.i];
      if (c === "\\" && '$`"\\\n'.includes(s[this.i + 1] ?? "")) {
        if (s[this.i + 1] !== "\n") lit += s[this.i + 1];
        this.i += 2;
        continue;
      }
      if (c === "$" && /[A-Za-z_{(0-9@*#?$!-]/.test(s[this.i + 1] ?? "")) {
        flush();
        this.readDollar(parts, true);
        continue;
      }
      if (c === "`") {
        flush();
        this.readBacktick(parts, true);
        continue;
      }
      lit += c;
      this.i++;
    }
    flush();
    if (!parts.length || parts[parts.length - 1].t !== "lit") parts.push({ t: "lit", s: "", q: true });
    this.i++; // closing quote
  }

  readDollar(parts, q) {
    const s = this.src;
    const n = s[this.i + 1];
    if (n === "(" && s[this.i + 2] === "(") {
      const end = s.indexOf("))", this.i + 3);
      this.i = end < 0 ? s.length : end + 2;
      parts.push({ t: "dyn", q });
      return;
    }
    if (n === "(") {
      const inner = this.matchParen(this.i + 1);
      this.sub(inner.text);
      parts.push({ t: "dyn", q });
      this.i = inner.end;
      return;
    }
    if (n === "{") {
      const end = matchBrace(s, this.i + 1);
      const body = s.slice(this.i + 2, end);
      this.i = end + 1;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-=])(.*))?$/s.exec(body);
      if (m && (m[2] === undefined || !/[$`]/.test(m[3] ?? ""))) parts.push({ t: "var", name: m[1], q, alt: m[2] ? unquoteSimple(m[3] ?? "") : undefined });
      else {
        if (/\$\(|`/.test(body)) this.sub(body.replace(/^[^$`]*/, ""));
        parts.push({ t: "dyn", q });
      }
      return;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(this.i + 1, this.i + 200));
    if (m) {
      parts.push({ t: "var", name: m[0], q });
      this.i += 1 + m[0].length;
      return;
    }
    if (n !== undefined && /[0-9@*#?$!-]/.test(n)) {
      parts.push({ t: "dyn", q });
      this.i += 2;
      return;
    }
    parts.push({ t: "lit", s: "$", q });
    this.i++;
  }

  readBacktick(parts, q) {
    const s = this.src;
    let j = this.i + 1;
    let inner = "";
    while (j < s.length && s[j] !== "`") {
      if (s[j] === "\\" && j + 1 < s.length) {
        inner += s[j + 1];
        j += 2;
        continue;
      }
      inner += s[j++];
    }
    this.sub(inner);
    parts.push({ t: "dyn", q });
    this.i = j + 1;
  }

  /** The text between the ( at `open` and its matching ), quotes and nesting respected. */
  matchParen(open) {
    const s = this.src;
    let depth = 0;
    let j = open;
    while (j < s.length) {
      const c = s[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "'") {
        const e = s.indexOf("'", j + 1);
        j = e < 0 ? s.length : e + 1;
        continue;
      }
      if (c === '"') {
        j = skipDouble(s, j + 1);
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) return { text: s.slice(open + 1, j), end: j + 1 };
      }
      j++;
    }
    return { text: s.slice(open + 1), end: s.length };
  }

  sub(text) {
    if (this.depth < MAX_DEPTH) this.subs.push(text);
  }
}

function skipDouble(s, j) {
  while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
  return j + 1;
}

function matchBrace(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return j;
  }
  return s.length;
}

function readAnsiC(s, j) {
  let text = "";
  while (j < s.length && s[j] !== "'") {
    if (s[j] !== "\\") {
      text += s[j++];
      continue;
    }
    const n = s[j + 1];
    const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
    if (n !== undefined && n in simple) {
      text += simple[n];
      j += 2;
    } else if (n === "x") {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(j + 2));
      text += m ? String.fromCharCode(parseInt(m[0], 16)) : "x";
      j += 2 + (m ? m[0].length : 0);
    } else if (n === "u" || n === "U") {
      const m = new RegExp(`^[0-9a-fA-F]{1,${n === "u" ? 4 : 8}}`).exec(s.slice(j + 2));
      text += m ? String.fromCodePoint(parseInt(m[0], 16)) : n;
      j += 2 + (m ? m[0].length : 0);
    } else if (n !== undefined && /[0-7]/.test(n)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(j + 1));
      text += String.fromCharCode(parseInt(m[0], 8));
      j += 1 + m[0].length;
    } else {
      text += `\\${n ?? ""}`;
      j += 2;
    }
  }
  return { text, end: j + 1 };
}

function unquoteSimple(t) {
  return t.replace(/^(['"])(.*)\1$/s, "$2");
}

/** A word's text when it is all literal (quoted or not), else null. */
function wordLiteral(w) {
  if (!w) return null;
  let out = "";
  for (const p of w.parts) {
    if (p.t === "lit" || p.t === "glob" || p.t === "brace") out += p.s;
    else return null;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Parser: tokens to simple commands, in order, with pipelines and subshell scopes
// ---------------------------------------------------------------------------------------------------------------

const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "esac", "[[", "]]", "time", "coproc"]);

/** A script's items: { cmd } in source order, and { open } / { close } around subshells. */
function parseItems(tokens) {
  const items = [];
  let cur = null;
  let pipeline = null;
  const startCmd = () => {
    if (!cur) {
      cur = { words: [], assigns: [], redirs: [], pipeline: null, stage: 0 };
      if (!pipeline) pipeline = [];
      cur.pipeline = pipeline;
      cur.stage = pipeline.length;
      pipeline.push(cur);
      items.push({ cmd: cur });
    }
    return cur;
  };
  const endCmd = (pipeContinues) => {
    cur = null;
    if (!pipeContinues) pipeline = null;
  };
  let skipUntil = null; // "for"/"select"/"case" lists: words that are not commands
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.k === "op") {
      if (tok.v === "|" || tok.v === "|&") {
        endCmd(true);
        continue;
      }
      if (tok.v === "(") {
        // `name ( )` is a function definition: drop the parentheses.
        if (cur && cur.words.length === 1 && tokens[t + 1]?.k === "op" && tokens[t + 1].v === ")") {
          t++;
          cur.words = [];
          endCmd(false);
          continue;
        }
        endCmd(false);
        items.push({ open: true });
        continue;
      }
      if (tok.v === ")") {
        endCmd(false);
        if (skipUntil === "case-pattern") {
          skipUntil = null;
          continue;
        }
        items.push({ close: true });
        continue;
      }
      if (tok.v === ";;" || tok.v === ";&" || tok.v === ";;&") {
        endCmd(false);
        if (skipUntil === "case-body") skipUntil = "case-pattern";
        continue;
      }
      endCmd(false);
      if (skipUntil === "list") skipUntil = null;
      continue;
    }
    if (tok.k === "redir") {
      startCmd().redirs.push(tok);
      continue;
    }
    const lit = wordLiteral(tok);
    if (skipUntil === "list") continue;
    if (skipUntil === "case-word") {
      if (lit === "in") skipUntil = "case-pattern";
      continue;
    }
    if (skipUntil === "case-pattern") {
      if (lit === "esac") {
        skipUntil = null;
        endCmd(false);
      }
      continue;
    }
    const atStart = !cur || (cur.words.length === 0);
    if (atStart && lit !== null && RESERVED.has(lit)) continue;
    if (atStart && (lit === "for" || lit === "select")) {
      skipUntil = "list";
      continue;
    }
    if (atStart && lit === "case") {
      skipUntil = "case-word";
      continue;
    }
    if (atStart && lit === "function") {
      t++; // the name
      continue;
    }
    if (atStart) {
      const a = assignmentOf(tok);
      if (a) {
        startCmd().assigns.push(a);
        continue;
      }
    }
    startCmd().words.push(tok);
  }
  return items;
}

/** NAME=value (or NAME+=value) when NAME is unquoted. */
function assignmentOf(w) {
  const first = w.parts[0];
  if (!first || first.t !== "lit" || first.q) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(first.s);
  if (!m) return null;
  const rest = first.s.slice(m[0].length);
  const valueParts = [...(rest ? [{ t: "lit", s: rest, q: false }] : []), ...w.parts.slice(1)];
  if (valueParts[0]?.t === "lit" && !valueParts[0].q && valueParts[0].s.startsWith("~")) valueParts.splice(0, 1, { t: "tilde" }, ...(valueParts[0].s.length > 1 ? [{ t: "lit", s: valueParts[0].s.slice(1), q: false }] : []));
  return { name: m[1], value: { k: "word", parts: valueParts, raw: w.raw.slice(m[0].length) } };
}

// ---------------------------------------------------------------------------------------------------------------
// Word expansion: braces, tilde, known variables, word splitting; globs are kept as patterns
// ---------------------------------------------------------------------------------------------------------------

/**
 * A word's values. Each arg: { s, dyn, glob, pattern, tail, quoted }. `s` is the text (null when dynamic);
 * `pattern` keeps unquoted glob characters and escapes quoted ones; `tail` is the literal text after the last
 * dynamic part (so `$DIR/verdicts.jsonl` still shows its file name).
 */
function expandWord(w, scope) {
  const seqs = braceExpand(w.parts);
  const out = [];
  for (const seq of seqs) {
    let s = "";
    let pattern = "";
    let dyn = false;
    let glob = false;
    let tail = "";
    let quoted = true;
    let split = false;
    for (const p of seq) {
      if (p.t === "lit") {
        s += p.s;
        pattern += p.q ? p.s.replace(/[*?[\]\\]/g, "\\$&") : p.s;
        tail += p.s;
        if (!p.q) quoted = false;
      } else if (p.t === "glob" || p.t === "brace") {
        s += p.s;
        pattern += p.s;
        tail += p.s;
        quoted = false;
        if (p.t === "glob") glob = true;
      } else if (p.t === "tilde") {
        const h = scope.home;
        s += h;
        pattern += h.replace(/[*?[\]\\]/g, "\\$&");
        tail += h;
        quoted = false;
      } else if (p.t === "var") {
        const v = scope.vars.has(p.name) ? scope.vars.get(p.name) : p.alt;
        if (v === undefined || v === null) {
          dyn = true;
          tail = "";
          if (!p.q) quoted = false;
        } else {
          s += v;
          pattern += v.replace(/[*?[\]\\]/g, "\\$&");
          tail += v;
          if (!p.q) {
            quoted = false;
            if (/\s/.test(v)) split = true;
          }
        }
      } else {
        dyn = true;
        tail = "";
        if (!p.q) quoted = false;
      }
    }
    if (!dyn && split) {
      for (const piece of s.split(/\s+/).filter(Boolean)) out.push({ s: piece, dyn: false, glob, pattern: piece, tail: piece, quoted: false, raw: w.raw });
      continue;
    }
    out.push({ s: dyn ? null : s, dyn, glob: glob && !dyn, pattern, tail, quoted, raw: w.raw });
  }
  return out;
}

/** Bash brace expansion over a word's parts ({a,b} only; {1..3} and unbalanced braces stay literal). */
function braceExpand(parts) {
  const open = parts.findIndex((p) => p.t === "brace" && p.s === "{");
  if (open < 0) return [parts];
  let depth = 0;
  const commas = [];
  let close = -1;
  for (let k = open; k < parts.length; k++) {
    const p = parts[k];
    if (p.t !== "brace") continue;
    if (p.s === "{") depth++;
    else if (p.s === "}") {
      depth--;
      if (depth === 0) {
        close = k;
        break;
      }
    } else if (p.s === "," && depth === 1) commas.push(k);
  }
  const asLit = (k) => ({ t: "lit", s: parts[k].s, q: false });
  if (close < 0 || commas.length === 0) {
    // Not an expansion: the { is literal; expand what follows it.
    const rest = braceExpand(parts.slice(open + 1));
    return rest.map((r) => [...parts.slice(0, open), asLit(open), ...r]);
  }
  const pre = parts.slice(0, open);
  const post = parts.slice(close + 1);
  const bounds = [open, ...commas, close];
  const out = [];
  for (let b = 0; b < bounds.length - 1; b++) {
    const alt = parts.slice(bounds[b] + 1, bounds[b + 1]);
    for (const a of braceExpand(alt)) for (const tail of braceExpand(post)) out.push([...pre, ...a, ...tail]);
    if (out.length > 256) break;
  }
  return out;
}

function expandWords(words, scope) {
  return words.flatMap((w) => expandWord(w, scope));
}

/** Paths a glob pattern matches now (bounded), relative to cwd. */
function globMatches(pattern, cwd) {
  const absolute = pattern.startsWith("/");
  const segs = pattern.split("/").filter((x, k) => x !== "" || k === 0);
  let bases = [absolute ? "/" : cwd];
  const out = [];
  for (let k = absolute ? 1 : 0; k < segs.length; k++) {
    const seg = segs[k];
    const next = [];
    const hasGlob = /(^|[^\\])[*?[]/.test(seg);
    for (const b of bases) {
      if (!hasGlob) {
        next.push(join(b, seg.replace(/\\(.)/g, "$1")));
        continue;
      }
      let names = [];
      try {
        names = readdirSync(b);
      } catch {
        continue;
      }
      const re = globRegex(seg);
      for (const n of names) if (re.test(n) && (n[0] !== "." || seg[0] === ".")) next.push(join(b, n));
      if (next.length > 2000) break;
    }
    bases = next;
    if (!bases.length) break;
  }
  for (const b of bases) if (existsSync(b)) out.push(b);
  return out;
}

function globRegex(seg) {
  let re = "^";
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k];
    if (c === "\\") re += escapeRe(seg[++k] ?? "");
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = seg.indexOf("]", k + 2);
      if (end < 0) re += "\\[";
      else {
        let cls = seg.slice(k + 1, end);
        if (cls[0] === "!") cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, "\\\\")}]`;
        k = end;
      }
    } else re += escapeRe(c);
  }
  return new RegExp(`${re}$`, "i");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// ---------------------------------------------------------------------------------------------------------------
// Files: audit roots, protected records, the signing key
// ---------------------------------------------------------------------------------------------------------------

function readText(p, max = MAX_FILE) {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

class Files {
  constructor(env, home, cwd) {
    this.env = env;
    this.home = home;
    this.cwd = cwd;
    this.rootCache = new Map();
    this.configCache = new Map();
  }

  /** The nearest directory at or above `dir` that holds a .pr-rla.yml, or null. */
  auditRootOf(dir) {
    let d = resolve(dir);
    const seen = [];
    for (let k = 0; k < 64; k++) {
      if (this.rootCache.has(d)) {
        const r = this.rootCache.get(d);
        for (const s of seen) this.rootCache.set(s, r);
        return r;
      }
      seen.push(d);
      if (existsSync(join(d, ".pr-rla.yml"))) {
        for (const s of seen) this.rootCache.set(s, d);
        return d;
      }
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
    for (const s of seen) this.rootCache.set(s, null);
    return null;
  }

  /** What an audit repo's .pr-rla.yml names: the ledger's file, verdict labels, the signing key. */
  configOf(root) {
    if (this.configCache.has(root)) return this.configCache.get(root);
    const text = readText(join(root, ".pr-rla.yml")) ?? "";
    const files = new Set();
    for (const m of text.matchAll(/\bfile\s*:\s*["']?([^"'\s,}#]+)/g)) files.add(basename(m[1]).toLowerCase());
    const labels = new Set();
    for (const m of text.matchAll(/\b(?:pass|fail)\s*:\s*["']?([^"'\s,}#]+)/g)) labels.add(m[1].toLowerCase());
    const key = /^\s*signing_key\s*:\s*["']?([^"'\s#]+)/m.exec(text)?.[1];
    // Labels as the ledger published them (ledger-index.json in each window directory).
    const auditDir = /^\s*audit_dir\s*:\s*["']?([^"'\s#]+)/m.exec(text)?.[1] ?? "audit";
    try {
      for (const w of readdirSync(resolve(root, auditDir))) {
        const idx = readText(join(resolve(root, auditDir), w, "ledger-index.json"), 4 * 1024 * 1024);
        if (!idx) continue;
        try {
          const j = JSON.parse(idx);
          for (const k of ["pass", "fail"]) if (typeof j?.labels?.[k]?.name === "string") labels.add(j.labels[k].name.toLowerCase());
        } catch {
          /* not JSON: nothing to learn */
        }
      }
    } catch {
      /* no audit directory yet */
    }
    const cfg = { files, labels, signingKey: resolve(root, key ?? ".pr-rla/signing-key.pem") };
    this.configCache.set(root, cfg);
    return cfg;
  }

  approvalsFiles() {
    const pick = (k) => (this.env[k] ? this.env[k] : undefined);
    const out = new Set();
    const explicit = pick("PR_RLA_APPROVALS_FILE");
    if (explicit) out.add(resolve(explicit));
    const xdg = pick("XDG_CONFIG_HOME");
    if (xdg && isAbsolute(xdg)) out.add(join(xdg, "pr-rla", "approvals.json"));
    out.add(join(this.home, ".config", "pr-rla", "approvals.json"));
    return out;
  }

  /** Why writing `abs` is refused, as "<path>, <what it is>", or null. */
  protectedReason(abs) {
    for (const p of new Set([resolve(abs), safeRealpath(resolve(abs))])) {
      const r = this.protectedOne(p);
      if (r) return r;
    }
    return null;
  }

  protectedOne(p) {
    const base = basename(p).toLowerCase();
    const approvals = this.approvalsFiles();
    if ([...approvals].some((a) => a.toLowerCase() === p.toLowerCase()) || /[\\/]pr-rla[\\/]approvals\.json$/i.test(p)) return `${this.show(p)}, the pr-rla approvals file, which holds your consent (only you give it)`;
    if (ALWAYS_NAMES.has(base)) return `${this.show(p)}, pr-rla's ${base === ".pr-rla.yml" ? "audit configuration" : "plugin lock"}`;
    const root = this.auditRootOf(dirname(p));
    if (!root) return null;
    const cfg = this.configOf(root);
    const rel = relative(root, p);
    if (RECORD_NAMES.has(base) || base.endsWith(".manifest.json") || cfg.files.has(base)) return `${this.show(p)}, an audit record`;
    if (rel.split(/[\\/]/).some((seg) => seg.toLowerCase() === "ledger-history")) return `${this.show(p)}, in the ledger's history (an audit record)`;
    if (this.isSigningKey(p)) return `${this.show(p)}, the audit's signing key`;
    if (rel.split(/[\\/]/)[0] === ".git") return `${this.show(p)}, in the audit repo's git directory (its hooks and config run commands as you)`;
    return null;
  }

  isSigningKey(p) {
    const abs = resolve(p);
    const segs = abs.split(/[\\/]/);
    if (/\.pem$/i.test(abs) && segs.slice(0, -1).some((s) => s === ".pr-rla")) return true;
    const root = this.auditRootOf(dirname(abs));
    if (!root) return false;
    const key = this.configOf(root).signingKey;
    return key === abs || key === safeRealpath(abs);
  }

  /** The first protected path inside a directory (bounded walk), or null. */
  protectedInside(dir, budget = { n: 5000 }) {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return null;
    }
    if (!st.isDirectory()) return null;
    // Removing or moving a directory that holds an audit repo removes its records.
    if (existsSync(join(dir, ".pr-rla.yml"))) return this.protectedReason(join(dir, ".pr-rla.yml"));
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    for (const n of names) {
      if (--budget.n < 0) return null;
      if (n === "node_modules" || n === ".git") continue;
      const p = join(dir, n);
      const r = this.protectedReason(p);
      if (r) return r;
      let child;
      try {
        child = lstatSync(p);
      } catch {
        continue;
      }
      if (child.isDirectory()) {
        const inner = this.protectedInside(p, budget);
        if (inner) return inner;
      }
    }
    return null;
  }

  isVerdictLabel(name, roots) {
    const n = decodeSafe(String(name)).trim().toLowerCase();
    if (!n) return false;
    if (DEFAULT_LABELS.includes(n) || LABEL_SHAPE.test(n)) return true;
    for (const r of roots) if (r && this.configOf(r).labels.has(n)) return true;
    return false;
  }

  /** A path as the user would write it: relative to the working directory inside it, else from ~, else absolute. */
  show(p) {
    const c = this.cwd;
    if (c && (p === c || p.startsWith(c + sep))) return relative(c, p) || ".";
    const h = this.home;
    return h && (p === h || p.startsWith(h + sep)) ? `~${p.slice(h.length)}` : p;
  }
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The analysis of one shell command line
// ---------------------------------------------------------------------------------------------------------------

class Scope {
  constructor(cwd, vars, home) {
    this.cwd = cwd;
    this.vars = vars;
    this.home = home;
  }
  child() {
    return new Scope(this.cwd, new Map(this.vars), this.home);
  }
}

class ShellCheck {
  constructor(ctx) {
    this.ctx = ctx; // { files, env, cwd, home, git }
    this.findings = [];
    this.written = new Map(); // path -> content written earlier in this command line
    this.runsPrRla = false;
    this.setsConfigHome = false;
    this.aliases = new Map();
  }

  block(reason) {
    if (!this.findings.includes(reason)) this.findings.push(reason);
  }

  /** Analyse a script in a scope (the caller's, for `source`/`eval`; a copy for a subshell). */
  script(src, scope, depth = 0) {
    if (depth > MAX_DEPTH) return;
    const tk = new Tokenizer(src, depth).run();
    for (const sub of tk.subs) this.script(sub, scope.child(), depth + 1);
    const items = parseItems(tk.tokens);
    const stack = [scope];
    for (const it of items) {
      const top = stack[stack.length - 1];
      if (it.open) stack.push(top.child());
      else if (it.close) {
        if (stack.length > 1) stack.pop();
      } else this.simple(it.cmd, top, depth);
    }
  }

  simple(cmd, scope, depth) {
    const env = new Map();
    for (const a of cmd.assigns) {
      const v = expandWord(a.value, scope)[0];
      this.assignment(a.name, v, scope, depth);
      env.set(a.name, v?.s ?? null);
    }
    if (!cmd.words.length) {
      for (const [k, v] of env) scope.vars.set(k, v);
      this.redirects(cmd, scope, []);
      return;
    }
    const args = expandWords(cmd.words, scope);
    this.redirects(cmd, scope, args);
    this.command(args, scope, depth, { cmd, env });
  }

  assignment(name, value, scope, depth = 0) {
    if (name === "PR_RLA_ACCEPT_LOCK_GRANTS") this.block("setting PR_RLA_ACCEPT_LOCK_GRANTS accepts the repo's lock grants without your consent; only you may run pr-rla that way, in your own terminal");
    else if (name === "PR_RLA_APPROVALS_FILE") this.block("setting PR_RLA_APPROVALS_FILE points pr-rla at another approvals file, which would stand in for your consent");
    else if (name === "XDG_CONFIG_HOME" || name === "HOME") this.setsConfigHome = true;
    else if (COMMAND_VARS.has(name) && scope && value?.s) this.script(value.s, scope.child(), depth + 1); // a pager or editor variable is a command line
  }

  redirects(cmd, scope, args) {
    for (const r of cmd.redirs) {
      if (!r.target) continue;
      const t = expandWord(r.target, scope)[0];
      if (!t) continue;
      const isFd = (r.op === ">&" || r.op === "<&") && (t.s === "-" || /^\d+$/.test(t.s ?? ""));
      if (isFd || r.op === "<<" || r.op === "<<-" || r.op === "<<<") continue;
      if (r.op === "<" || r.op === "<&") {
        this.readTarget(t, scope, "a redirect reads");
        continue;
      }
      this.writeTarget(t, scope, "a redirect writes", { content: this.textOf(args, cmd) });
    }
  }

  /** What a command writes to stdout, as far as the guard can tell: echo/printf/cat text, for `> file` and `| sh`. */
  textOf(args, cmd) {
    const prog = args[0]?.s ? basename(args[0].s) : null;
    if (prog === "echo") return args.slice(1).filter((a, k) => !(k === 0 && /^-[neE]+$/.test(a.s ?? ""))).map((a) => a.s ?? "").join(" ");
    if (prog === "printf") return (args[1]?.s ?? "").replace(/\\n/g, "\n").replace(/%s/g, () => "") + args.slice(2).map((a) => a.s ?? "").join(" ");
    if (prog === "cat") {
      const here = cmd?.redirs.find((r) => r.heredoc !== undefined)?.heredoc;
      if (here !== undefined) return here;
      const hs = cmd?.redirs.find((r) => r.op === "<<<");
      if (hs?.target) return wordLiteral(hs.target) ?? "";
      return args.slice(1).map((a) => (a.s ? (readText(resolve(this.ctx.cwd, a.s)) ?? "") : "")).join("\n");
    }
    const here = cmd?.redirs.find((r) => r.heredoc !== undefined)?.heredoc;
    return here ?? null;
  }

  abs(arg, scope) {
    return resolve(scope.cwd, arg.s);
  }

  /** Check a path some command writes (or removes, moves, truncates). */
  writeTarget(arg, scope, what, opt = {}) {
    if (!arg) return;
    if (arg.dyn) {
      const tail = basename(arg.tail || "").toLowerCase();
      if (tail && (RECORD_NAMES.has(tail) || ALWAYS_NAMES.has(tail) || tail.endsWith(".manifest.json") || tail === "approvals.json")) this.block(`${what} a path ending in ${tail} that the guard cannot resolve; it may be an audit record`);
      return;
    }
    const paths = arg.glob ? globMatches(arg.pattern, scope.cwd) : [this.abs(arg, scope)];
    if (arg.glob && !paths.length) {
      const base = basename(arg.s).toLowerCase();
      if (!/[*?[]/.test(base) && (RECORD_NAMES.has(base) || ALWAYS_NAMES.has(base) || base.endsWith(".manifest.json"))) this.block(`${what} ${arg.s}, which names an audit record`);
    }
    for (const p of paths) {
      const r = this.ctx.files.protectedReason(p);
      if (r) {
        this.block(`${what} ${r}`);
        continue;
      }
      if (opt.recursive !== false && opt.dirMatters !== false) {
        const inside = this.ctx.files.protectedInside(p);
        if (inside) this.block(`${what} a directory holding audit records: ${inside}`);
      }
      if (opt.content !== undefined && opt.content !== null) this.written.set(p, opt.content);
    }
  }

  readTarget(arg, scope, what) {
    if (!arg || arg.dyn || !arg.s) return;
    const paths = arg.glob ? globMatches(arg.pattern, scope.cwd) : [this.abs(arg, scope)];
    for (const p of paths) if (this.ctx.files.isSigningKey(p)) this.block(`${what} ${this.ctx.files.show(p)}, the audit's signing key`);
  }

  /** A script file's text: what this command line wrote to it, else what is on disk. */
  scriptText(arg, scope) {
    if (!arg?.s) return null;
    const p = this.abs(arg, scope);
    return this.written.get(p) ?? readText(p);
  }

  // --- one command, after its words are expanded --------------------------------------------------------------

  command(args, scope, depth, info) {
    if (!args.length) return;
    const head = args[0];
    if (head.dyn) {
      this.dynamicCommand(args, scope, depth);
      return;
    }
    if (head.glob) return; // a glob as the command: nothing the guard can name
    const name = head.s;
    const prog = basename(name);

    // Aliases defined earlier in the line.
    if (this.aliases.has(name) && depth < MAX_DEPTH) {
      this.script(`${this.aliases.get(name)} ${args.slice(1).map(shq).join(" ")}`, scope, depth + 1);
      return;
    }

    // Reading the signing key, whatever reads it.
    if (!["ls", "stat", "test", "[", "file"].includes(prog)) for (const a of args.slice(1)) if (a.s && !a.s.startsWith("-")) this.readTarget(a, scope, `${prog} reads`);

    const rest = args.slice(1);
    switch (prog) {
      case "cd":
      case "pushd": {
        const target = rest.find((a) => !/^-[LPe@]*$/.test(a.s ?? ""));
        if (!target) scope.cwd = scope.home;
        else if (target.s && target.s !== "-") scope.cwd = resolve(scope.cwd, target.s);
        return;
      }
      case "export":
      case "declare":
      case "typeset":
      case "local":
      case "readonly":
        for (const a of rest) {
          if (!a.s || a.s.startsWith("-")) continue;
          const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=(.*))?$/s.exec(a.s);
          if (!m) continue;
          this.assignment(m[1], { s: m[3] ?? null }, scope, depth);
          if (m[2] !== undefined) scope.vars.set(m[1], m[3]);
        }
        return;
      case "unset":
        for (const a of rest) if (a.s) scope.vars.delete(a.s);
        return;
      case "setenv": // csh
        if (rest[0]?.s) this.assignment(rest[0].s, rest[1]);
        return;
      case "alias":
        for (const a of rest) {
          const m = /^([^=\s]+)=(.*)$/s.exec(a.s ?? "");
          if (!m) continue;
          this.aliases.set(m[1], m[2]);
          this.script(m[2], scope.child(), depth + 1);
        }
        return;
      case "eval":
        return this.evalLike(rest, scope, depth, "eval");
      case "source":
      case ".": {
        const text = this.scriptText(rest[0], scope);
        if (text !== null) this.script(text, scope, depth + 1);
        return;
      }
      case "env":
        return this.envCommand(rest, scope, depth, info);
      case "command":
        if (rest[0]?.s && /^-[a-zA-Z]*[vV]/.test(rest[0].s)) return; // command -v: a lookup
        return this.command(skipOpts(rest, ""), scope, depth, info);
      case "builtin":
      case "exec":
      case "nohup":
      case "time":
      case "chronic":
      case "unbuffer":
        return this.command(skipOpts(rest, prog === "exec" ? "a" : ""), scope, depth, info);
      case "nice":
        return this.command(skipOpts(rest.filter((a, k) => !(k === 0 && /^-\d+$/.test(a.s ?? ""))), "n"), scope, depth, info);
      case "ionice":
        return this.command(skipOpts(rest, "cnp"), scope, depth, info);
      case "stdbuf":
        return this.command(skipOpts(rest, "ioe"), scope, depth, info);
      case "caffeinate":
        return this.command(skipOpts(rest, "tw"), scope, depth, info);
      case "sudo":
      case "doas":
        return this.command(skipOpts(rest, prog === "sudo" ? "ugCDhprtTU" : "uC"), scope, depth, info);
      case "timeout": {
        const after = skipOpts(rest, "sk");
        return this.command(after.slice(1), scope, depth, info);
      }
      case "xargs":
        return this.command(skipOpts(rest, "IiLlnPdEeas"), scope, depth, { ...info, viaXargs: true });
      case "watch":
        return this.evalLike(skipOpts(rest, "nd"), scope, depth, "watch");
      case "ssh":
        return this.evalLike(skipOpts(rest, "bcDEeFIiJLlmOopQRSWw").slice(1), scope, depth, "ssh");
      case "find":
        return this.findExec(rest, scope, depth, info);
      case "busybox":
        return this.command(rest, scope, depth, info);
      case "npx":
      case "bunx":
        return this.packageRunner(rest, scope, depth, info);
      case "npm":
      case "pnpm":
      case "yarn":
      case "bun":
        return this.packageManager(prog, rest, scope, depth, info);
      case "node":
      case "nodejs":
      case "tsx":
      case "ts-node":
      case "deno":
        return this.nodeLike(prog, rest, scope, depth, info);
      case "python":
      case "python3":
      case "perl":
      case "ruby":
      case "php":
      case "osascript":
        return this.interpreter(prog, rest, scope, depth);
      case "pr-rla":
        return this.prRla(rest, info, true);
      case "pr-rla-mcp":
        return;
      case "ssh-keygen":
        return this.sshKeygen(rest);
      case "gh":
        return this.gh(rest, scope, depth);
      case "glab":
        return this.glab(rest, scope);
      case "curl":
        return this.curl(rest, scope);
      case "wget":
        return this.wget(rest, scope);
      case "http":
      case "https":
      case "xh":
      case "xhs":
        return this.httpie(rest, scope);
      case "git":
        return this.git(rest, scope, depth, info);
      case "tee":
        for (const a of nonOptions(rest, "")) this.writeTarget(a, scope, "tee writes", { content: null });
        return;
      case "cp":
      case "gcp":
      case "install":
      case "ginstall":
        return this.copyLike(prog, rest, scope, false);
      case "mv":
      case "gmv":
        return this.copyLike(prog, rest, scope, true);
      case "ln":
        return this.ln(rest, scope);
      case "rsync":
        return this.rsync(rest, scope);
      case "rm":
      case "grm":
      case "unlink":
      case "shred":
      case "srm":
      case "trash":
      case "rmdir":
        for (const a of nonOptions(rest, prog === "shred" ? "nsu" : "")) this.writeTarget(a, scope, `${prog} removes`);
        return;
      case "truncate":
        for (const a of nonOptions(rest, "sr")) this.writeTarget(a, scope, "truncate empties");
        return;
      case "touch":
        for (const a of nonOptions(rest, "drt")) this.writeTarget(a, scope, "touch writes", { recursive: false });
        return;
      case "dd":
        for (const a of rest) if (a.s?.startsWith("of=")) this.writeTarget({ ...a, s: a.s.slice(3), tail: a.tail.slice(3) }, scope, "dd writes");
        return;
      case "sed":
      case "gsed":
        return this.inPlace(prog, rest, scope, "efl", /^(-[a-zA-Z]*i|--in-place)/);
      case "sponge":
        for (const a of nonOptions(rest, "")) this.writeTarget(a, scope, "sponge writes");
        return;
      case "patch":
        return this.patchCommand(rest, scope, info);
      case "sh":
      case "bash":
      case "zsh":
      case "dash":
      case "ksh":
      case "mksh":
      case "yash":
      case "ash":
      case "fish":
        return this.shell(prog, rest, scope, depth, info);
      case "pwsh":
      case "powershell":
      case "powershell.exe":
      case "pwsh.exe":
        return this.powershellHost(rest, scope, depth);
      case "script": {
        const c = rest.findIndex((a) => a.s === "-c" || a.s === "--command");
        if (c >= 0) return this.script(rest[c + 1]?.s ?? "", scope.child(), depth + 1);
        const after = skipOpts(rest, "tTFI");
        return this.command(after.slice(1), scope, depth, info); // macOS: script [file [command …]]
      }
      case "arch": {
        let j = 0;
        while (j < rest.length && (rest[j].s ?? "").startsWith("-")) j += rest[j].s === "-arch" || rest[j].s === "-e" ? 2 : 1;
        return this.command(rest.slice(j), scope, depth, info);
      }
      case "setsid":
      case "systemd-run":
      case "flatpak-spawn":
        return this.command(skipOpts(rest, "pu"), scope, depth, info);
      case "direnv":
        if (rest[0]?.s === "exec") return this.command(rest.slice(2), scope, depth, info);
        return;
      case "parallel": {
        const end = rest.findIndex((a) => a.s === ":::" || a.s === "::::");
        return this.command(skipOpts(end < 0 ? rest : rest.slice(0, end), "jS"), scope, depth, info);
      }
      case "at":
      case "batch":
        return this.shell("sh", [], scope, depth, info); // reads its job from stdin
      case "make":
      case "gmake":
      case "just":
      case "task": {
        let dir = scope.cwd;
        let file = null;
        for (let j = 0; j < rest.length; j++) {
          if (rest[j].s === "-C" || rest[j].s === "--directory") dir = resolve(dir, rest[++j]?.s ?? ".");
          else if (rest[j].s === "-f" || rest[j].s === "--file" || rest[j].s === "--justfile" || rest[j].s === "--taskfile") file = resolve(dir, rest[++j]?.s ?? "");
        }
        const names = prog === "just" ? ["justfile", "Justfile", ".justfile"] : prog === "task" ? ["Taskfile.yml", "Taskfile.yaml"] : ["GNUmakefile", "makefile", "Makefile"];
        const text = file ? readText(file) : names.map((n) => readText(join(dir, n))).find((t) => t !== null) ?? null;
        if (text !== null) for (const f of codeFindings(text, { records: false })) this.block(`${prog} would run a recipe with ${f.replace(/^code that /, "")}`);
        return;
      }
      case "tar":
      case "gtar":
      case "bsdtar":
      case "unzip":
        return this.extract(prog, rest, scope);
      default:
        break;
    }
    if (/^(set-content|add-content|out-file|clear-content|remove-item|move-item|copy-item|new-item|rename-item)$/i.test(prog)) return this.powershellCmdlet(prog, rest, scope);
    // A program the guard does not know that is handed pr-rla as an argument (`direnv exec`, `nix develop -c`, …).
    if (!NON_RUNNERS.has(prog)) {
      const j = rest.findIndex((a) => a.s !== null && (basename(a.s) === "pr-rla" || packageName(a.s) === "pr-rla"));
      if (j >= 0) this.prRla(rest.slice(j + 1), info, false);
    }
    // A script a known CLI path names (dist/cli.js, src/cli.ts) run directly.
    if (/^cli\.(m|c)?[jt]s$/.test(prog)) return this.prRla(rest, info, false);
    // Running an executable script file: read it.
    if (name.includes("/")) {
      const text = this.scriptText(head, scope);
      if (text !== null) this.codeOrShell(text, scope, depth, true);
    }
  }

  /** The program's name is computed: its arguments may be pr-rla's, or a script for a computed shell. */
  dynamicCommand(args, scope, depth) {
    const words = args.slice(1).map((a) => a.s ?? "");
    if (words.some((w) => ["record", "register", "freeze", "sample", "approve", "init"].includes(w) || ["--push", "--sign", "--submit", "--accept-lock-grants"].includes(w))) this.block(`the guard cannot tell which program runs (the command name is computed), and its arguments (${words.filter(Boolean).slice(0, 4).join(" ")}) look like a pr-rla write; run pr-rla commands with a literal name`);
    if (codeFindings(args.map((a) => a.s ?? a.raw ?? "").join(" "), { records: false }).length) this.block("a computed program would run text that looks like a pr-rla write; run commands with a literal name");
    for (const w of words) if (/\s/.test(w)) this.script(w, scope.child(), depth + 1);
  }

  evalLike(rest, scope, depth, what) {
    if (rest.some((a) => a.dyn)) {
      const source = rest.map((a) => (a.dyn ? (a.raw ?? a.tail) : a.s)).join(" ");
      if (codeFindings(source, { records: true }).length) this.block(`${what} runs text the guard cannot fully read, and it looks like a pr-rla write`);
    }
    this.script(rest.map((a) => a.s ?? "").join(" "), scope, depth + 1);
  }

  envCommand(rest, scope, depth, info) {
    let k = 0;
    let cwd = scope.cwd;
    const sub = scope.child();
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null) break;
      if (s === "--") {
        k++;
        break;
      }
      if (s === "-i" || s === "-0" || s === "--ignore-environment" || s === "--null" || s === "-v" || s === "--debug") continue;
      if (s === "-u" || s === "--unset") {
        k++;
        continue;
      }
      if (s.startsWith("--unset=") || /^-u./.test(s)) continue;
      if (s === "-C" || s === "--chdir") {
        if (rest[k + 1]?.s) cwd = resolve(cwd, rest[k + 1].s);
        k++;
        continue;
      }
      if (s.startsWith("--chdir=")) {
        cwd = resolve(cwd, s.slice(8));
        continue;
      }
      if (s === "-S" || s === "--split-string" || s.startsWith("--split-string=") || /^-S./.test(s)) {
        const str = s === "-S" || s === "--split-string" ? (rest[++k]?.s ?? "") : s.replace(/^--split-string=|^-S/, "");
        sub.cwd = cwd;
        this.script(`${str} ${rest.slice(k + 1).map(shq).join(" ")}`, sub, depth + 1);
        return;
      }
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(s);
      if (m) {
        this.assignment(m[1], { s: m[2] }, scope, depth);
        sub.vars.set(m[1], m[2]);
        continue;
      }
      if (s.startsWith("-")) continue;
      break;
    }
    sub.cwd = cwd;
    this.command(rest.slice(k), sub, depth, info);
  }

  findExec(rest, scope, depth, info) {
    for (let k = 0; k < rest.length; k++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(rest[k].s ?? "")) continue;
      let e = k + 1;
      while (e < rest.length && rest[e].s !== ";" && rest[e].s !== "+") e++;
      this.command(rest.slice(k + 1, e), scope, depth, info);
      k = e;
    }
    if (rest.some((a) => a.s === "-delete")) {
      const firstExpr = rest.findIndex((a) => /^[-(!]/.test(a.s ?? "-"));
      const starts = firstExpr < 0 ? rest : rest.slice(0, firstExpr);
      const names = [];
      for (let k = 0; k < rest.length; k++) if (["-name", "-iname"].includes(rest[k].s ?? "") && rest[k + 1]) names.push(rest[k + 1]);
      if (names.length) {
        for (const n of names) {
          const re = n.s === null ? null : globRegex(n.s);
          const hit = re === null || [...RECORD_NAMES, ...ALWAYS_NAMES, "approvals.json"].some((r) => re.test(r)) || re.test("x.manifest.json");
          if (hit) this.block(`find -delete removes files named ${n.s ?? "(computed)"}, which can be audit records`);
        }
      } else for (const a of starts.length ? starts : [{ s: ".", dyn: false, glob: false, tail: "." }]) this.writeTarget(a, scope, "find -delete removes");
    }
  }

  packageRunner(rest, scope, depth, info) {
    let k = 0;
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null) break;
      if (s === "--") {
        k++;
        break;
      }
      if (s === "-c" || s === "--call") {
        this.script(rest[k + 1]?.s ?? "", scope, depth + 1);
        return;
      }
      if (s.startsWith("--call=")) {
        this.script(s.slice(7), scope, depth + 1);
        return;
      }
      if (s === "-p" || s === "--package" || s === "-w" || s === "--workspace") {
        k++;
        continue;
      }
      if (s.startsWith("-")) continue;
      break;
    }
    const spec = rest[k];
    if (!spec) return;
    const name = spec.s ? packageName(spec.s) : null;
    this.command([{ ...spec, s: name }, ...rest.slice(k + 1)], scope, depth, info);
  }

  packageManager(prog, rest, scope, depth, info) {
    const sub = rest[0]?.s;
    if (sub === "exec" || sub === "x" || sub === "dlx") return this.packageRunner(rest.slice(1), scope, depth, info);
    if (prog === "bun" && sub === "x") return this.packageRunner(rest.slice(1), scope, depth, info);
    let script = null;
    if (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn") script = rest.slice(1).find((a) => !(a.s ?? "").startsWith("-"))?.s ?? null;
    else if (["test", "t", "tst", "start", "stop", "restart"].includes(sub ?? "")) script = sub === "t" || sub === "tst" ? "test" : sub;
    else if ((prog === "yarn" || prog === "pnpm" || prog === "bun") && sub && !sub.startsWith("-") && !["install", "add", "remove", "i", "ci", "update", "upgrade", "init", "create", "publish", "link", "why", "list", "ls", "outdated", "audit"].includes(sub)) script = sub;
    if (!script) return;
    const pkg = findUp(scope.cwd, "package.json");
    let scripts = {};
    try {
      scripts = JSON.parse((pkg ? readText(pkg) : null) ?? "{}").scripts ?? {};
    } catch {
      scripts = {};
    }
    if (typeof scripts[script] !== "string") {
      // `yarn pr-rla …`, `pnpm pr-rla …`: no script by that name, so the package manager runs the bin.
      if (prog !== "npm" && sub === script) this.command(rest, scope, depth, info);
      return;
    }
    for (const n of [`pre${script}`, script, `post${script}`]) if (typeof scripts[n] === "string") this.script(scripts[n], scope.child(), depth + 1);
  }

  nodeLike(prog, rest, scope, depth, info) {
    let k = 0;
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null) break;
      if (["-e", "--eval", "-p", "--print"].includes(s)) {
        this.code(rest[k + 1]?.s ?? "", rest[k + 1]);
        return;
      }
      if (/^--(eval|print)=/.test(s)) {
        this.code(s.replace(/^--(eval|print)=/, ""));
        return;
      }
      if (["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "-C", "--conditions", "--input-type"].includes(s)) {
        k++;
        continue;
      }
      if (prog === "deno" && ["run", "eval"].includes(s)) {
        if (s === "eval") {
          this.code(rest[k + 1]?.s ?? "", rest[k + 1]);
          return;
        }
        continue;
      }
      if (s === "--") {
        k++;
        break;
      }
      if (s.startsWith("-")) continue;
      break;
    }
    const script = rest[k];
    if (script?.dyn) return this.dynamicCommand(rest.slice(k), scope, depth);
    if (!script?.s) return;
    const b = basename(script.s);
    if (/^cli\.(m|c)?[jt]s$/.test(b) || /^pr-rla(\.(m|c)?js)?$/.test(b)) return this.prRla(rest.slice(k + 1), info, /pr-rla/.test(script.s) || /^pr-rla/.test(b));
    const text = this.scriptText(script, scope);
    if (text !== null) this.code(text, undefined, { file: true, scope });
  }

  interpreter(prog, rest, scope, depth) {
    const flag = { python: ["-c"], python3: ["-c"], perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"], osascript: ["-e"] }[prog] ?? [];
    for (let k = 0; k < rest.length; k++) {
      const s = rest[k].s ?? "";
      if (flag.includes(s)) {
        this.code(rest[k + 1]?.s ?? "", rest[k + 1]);
        if (prog === "perl" || prog === "ruby") this.perlInPlace(rest, scope);
        return;
      }
      const attached = flag.find((f) => s.startsWith(f) && s.length > f.length && !s.startsWith("--"));
      if (attached) {
        this.code(s.slice(attached.length));
        return;
      }
      if (/^-[a-zA-Z]*[eE]$/.test(s) && (prog === "perl" || prog === "ruby")) {
        this.code(rest[k + 1]?.s ?? "", rest[k + 1]);
        this.perlInPlace(rest, scope);
        return;
      }
      if (s.startsWith("-")) continue;
      const text = this.scriptText(rest[k], scope);
      if (text !== null) this.codeOrShell(text, scope, depth, true);
      return;
    }
  }

  perlInPlace(rest, scope) {
    if (!rest.some((a) => /^-[a-zA-Z]*i/.test(a.s ?? ""))) return;
    let skipNext = false;
    for (const a of rest) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if ((a.s ?? "").startsWith("-")) {
        if (/[eE]$/.test(a.s ?? "")) skipNext = true;
        continue;
      }
      this.writeTarget(a, scope, "an in-place edit writes");
    }
  }

  codeOrShell(text, scope, depth, file) {
    const first = text.split("\n", 1)[0];
    const looksLikeCode = /\b(import|require|def|function|const|let|var)\b/.test(text) && !/^\s*(pr-rla|git|gh|glab|curl)\b/m.test(text);
    if (/^#!.*\b(ba|z|da|k|mk|a)?sh\b/.test(first) || (!first.startsWith("#!") && !looksLikeCode)) this.script(text, scope.child(), depth + 1);
    else this.code(text, undefined, { file, scope });
  }

  /**
   * Code in another language. A script file (as opposed to `-e`/`-c` code) is checked for writes to records only
   * inside an audit repo: elsewhere, a program that mentions record names (pr-rla's own tests, say) is not the risk.
   */
  code(text, arg, o = {}) {
    if (arg?.dyn) {
      if (codeFindings(arg.raw ?? arg.tail ?? "", { records: true }).length) this.block("code the guard cannot fully read (it is computed) looks like a pr-rla write");
      return;
    }
    const records = !o.file || Boolean(this.ctx.files.auditRootOf((o.scope ?? { cwd: this.ctx.cwd }).cwd));
    for (const f of codeFindings(text, { records })) this.block(f);
  }

  shell(prog, rest, scope, depth, info) {
    let k = 0;
    let script = null;
    let file = null;
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null) break;
      if (s === "--") {
        k++;
        break;
      }
      if (prog === "fish" && (s === "-c" || s === "--command")) {
        script = rest[k + 1]?.s ?? "";
        break;
      }
      if (prog === "fish" && s.startsWith("--command=")) {
        script = s.slice(10);
        break;
      }
      if (["-o", "-O", "+o", "+O", "--rcfile", "--init-file"].includes(s)) {
        k++;
        continue;
      }
      if (/^[-+][a-zA-Z]*c[a-zA-Z]*$/.test(s) && !s.startsWith("--")) {
        const after = rest.slice(k + 1).find((a) => !/^[-+]/.test(a.s ?? ""));
        script = after ? (after.s ?? "") : "";
        if (after?.dyn) this.code("", after);
        else if (after) script = after.s ?? "";
        break;
      }
      if (s.startsWith("-") || s.startsWith("+")) continue;
      file = rest[k];
      break;
    }
    if (script !== null) {
      this.script(script, scope.child(), depth + 1);
      return;
    }
    if (file) {
      const text = this.scriptText(file, scope);
      if (text !== null) this.script(text, scope.child(), depth + 1);
      return;
    }
    // The shell reads its script from stdin: a heredoc, a here-string, or what the pipeline feeds it.
    const cmd = info.cmd;
    const parts = [];
    for (const r of cmd?.redirs ?? []) {
      if (r.heredoc !== undefined) parts.push(r.heredoc);
      if (r.op === "<<<" && r.target) parts.push(expandWord(r.target, scope)[0]?.s ?? "");
      if (r.op === "<" && r.target) {
        const t = expandWord(r.target, scope)[0];
        const text = t ? this.scriptText(t, scope) : null;
        if (text !== null) parts.push(text);
      }
    }
    if (cmd?.pipeline && cmd.stage > 0) {
      for (const up of cmd.pipeline.slice(0, cmd.stage)) {
        const upArgs = expandWords(up.words, scope);
        const t = this.textOf(upArgs, up);
        if (t !== null) parts.push(t);
      }
    }
    if (parts.length) this.script(parts.join("\n"), scope.child(), depth + 1);
  }

  powershellHost(rest, scope, depth) {
    for (let k = 0; k < rest.length; k++) {
      const s = (rest[k].s ?? "").toLowerCase();
      if (s === "-command" || s === "-c") {
        this.script(rest.slice(k + 1).map((a) => a.s ?? "").join(" "), scope.child(), depth + 1);
        return;
      }
      if (s === "-encodedcommand" || s === "-enc" || s === "-e" || s === "-ec") {
        try {
          this.script(Buffer.from(rest[k + 1]?.s ?? "", "base64").toString("utf16le"), scope.child(), depth + 1);
        } catch {
          /* not base64 */
        }
        return;
      }
      if (s === "-file" || s === "-f") {
        const text = this.scriptText(rest[k + 1], scope);
        if (text !== null) this.script(text, scope.child(), depth + 1);
        return;
      }
    }
  }

  powershellCmdlet(prog, rest, scope) {
    const p = prog.toLowerCase();
    const targets = [];
    for (let k = 0; k < rest.length; k++) {
      const s = (rest[k].s ?? "").toLowerCase();
      if (["-path", "-literalpath", "-filepath", "-destination", "-name"].includes(s)) {
        targets.push(rest[k + 1]);
        k++;
      } else if (s.startsWith("-")) {
        if (["-value", "-encoding", "-itemtype", "-newname", "-filter", "-include", "-exclude"].includes(s)) k++;
      } else targets.push(rest[k]);
    }
    const what = p.startsWith("remove") ? "Remove-Item removes" : `${prog} writes`;
    for (const t of p === "copy-item" ? targets.slice(-1) : targets) this.writeTarget(t, scope, what);
  }

  inPlace(prog, rest, scope, valueShort, flagRe) {
    if (!rest.some((a) => flagRe.test(a.s ?? ""))) return;
    const hasScriptFlag = rest.some((a) => /^(-[a-zA-Z]*[ef]|--expression|--file)/.test(a.s ?? ""));
    let scriptSeen = hasScriptFlag;
    for (let k = 0; k < rest.length; k++) {
      const s = rest[k].s ?? "";
      if (s.startsWith("-")) {
        if (/^-[a-zA-Z]*[ef]$/.test(s) || s === "--expression" || s === "--file" || s === "-l") k++;
        continue;
      }
      if (!scriptSeen) {
        scriptSeen = true;
        continue;
      }
      this.writeTarget(rest[k], scope, `${prog} -i edits`);
    }
    void valueShort;
  }

  copyLike(prog, rest, scope, isMove) {
    const valueShort = prog.endsWith("install") ? "tmogS" : "tS";
    let targetDir = null;
    const pos = [];
    let recursive = false;
    for (let k = 0; k < rest.length; k++) {
      const s = rest[k].s ?? "";
      if (s === "--") {
        pos.push(...rest.slice(k + 1));
        break;
      }
      if (s === "-t" || s === "--target-directory") {
        targetDir = rest[++k];
        continue;
      }
      if (s.startsWith("--target-directory=")) {
        targetDir = { ...rest[k], s: s.slice(19), tail: s.slice(19) };
        continue;
      }
      if (/^-[a-zA-Z]+$/.test(s)) {
        if (/[rRa]/.test(s)) recursive = true;
        const last = s[s.length - 1];
        if (valueShort.includes(last) && s.length === 2) k++;
        continue;
      }
      if (s.startsWith("--")) {
        if (s === "--recursive" || s === "--archive") recursive = true;
        continue;
      }
      pos.push(rest[k]);
    }
    const dest = targetDir ?? pos[pos.length - 1];
    const sources = targetDir ? pos : pos.slice(0, -1);
    const verb = isMove ? `${prog} moves onto` : `${prog} overwrites`;
    if (!dest) return;
    this.writeTarget(dest, scope, verb, { dirMatters: isMove });
    if (dest.s && !dest.dyn) {
      const destAbs = this.abs(dest, scope);
      let destIsDir = Boolean(targetDir);
      try {
        destIsDir = destIsDir || statSync(destAbs).isDirectory();
      } catch {
        /* a new file */
      }
      for (const src of sources) {
        if (!src.s || src.dyn) continue;
        const srcAbs = this.abs(src, scope);
        if (destIsDir) {
          const into = join(destAbs, basename(srcAbs));
          const r = this.ctx.files.protectedReason(into);
          if (r) this.block(`${verb} ${r}`);
        }
        if (recursive || isMove) {
          // A directory copied or moved in may carry files named like records.
          const walk = (d, rel, budget) => {
            let names = [];
            try {
              names = readdirSync(d);
            } catch {
              return;
            }
            for (const n of names) {
              if (--budget.n < 0) return;
              const p = join(d, n);
              const target = join(destIsDir ? join(destAbs, basename(srcAbs)) : destAbs, rel, n);
              const r = this.ctx.files.protectedReason(target);
              if (r) this.block(`${verb} ${r}`);
              try {
                if (lstatSync(p).isDirectory()) walk(p, join(rel, n), budget);
              } catch {
                /* gone */
              }
            }
          };
          try {
            if (statSync(srcAbs).isDirectory()) walk(srcAbs, "", { n: 2000 });
          } catch {
            /* missing source */
          }
        }
      }
    }
    if (isMove) for (const src of sources) this.writeTarget(src, scope, `${prog} moves away`);
  }

  /** tar -x / unzip: the archive's names, when it unpacks into an audit repo. */
  extract(prog, rest, scope) {
    const words = rest.map((a) => a.s ?? "");
    let archive = null;
    let dest = scope.cwd;
    let extracting = false;
    if (prog === "unzip") {
      if (words.some((w) => /^-[a-zA-Z]*[lvtZ]/.test(w))) return; // listing or testing
      extracting = true;
      for (let j = 0; j < rest.length; j++) {
        if (words[j] === "-d") dest = resolve(scope.cwd, words[++j] ?? ".");
        else if (words[j] === "-x") break;
        else if (!words[j].startsWith("-") && archive === null) archive = rest[j];
      }
    } else {
      const first = words[0] ?? "";
      const cluster = first.startsWith("-") ? first.slice(1) : first;
      extracting = words.includes("--extract") || words.includes("--get") || (/^[a-zA-Z]+$/.test(cluster) && cluster.includes("x")) || words.some((w) => /^-[a-zA-Z]*x/.test(w));
      if (!extracting) return;
      for (let j = 0; j < rest.length; j++) {
        const w = words[j];
        if (w === "-C" || w === "--directory") dest = resolve(scope.cwd, words[++j] ?? ".");
        else if (w.startsWith("--directory=")) dest = resolve(scope.cwd, w.slice(12));
        else if (w === "-f" || w === "--file") archive = rest[++j] ?? null;
        else if (w.startsWith("--file=")) archive = { ...rest[j], s: w.slice(7) };
        else if (/^-?[a-zA-Z]*f$/.test(w) && j === 0) archive = rest[++j] ?? null;
        else if (/^-[a-zA-Z]*f$/.test(w)) archive = rest[++j] ?? null;
      }
    }
    if (!extracting) return;
    if (!this.ctx.files.auditRootOf(dest)) return;
    if (!archive || archive.dyn || !archive.s || archive.s === "-") {
      this.block(`${prog} unpacks an archive the guard cannot read into the audit repo; it may overwrite audit records`);
      return;
    }
    const abs = resolve(scope.cwd, archive.s);
    let names = null;
    try {
      const r = spawnSync(prog === "unzip" ? "unzip" : "tar", prog === "unzip" ? ["-Z1", abs] : ["-tf", abs], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      if (r.status === 0) names = r.stdout.split("\n").filter(Boolean);
    } catch {
      names = null;
    }
    if (names === null) {
      this.block(`${prog} unpacks ${archive.s}, which the guard cannot list, into the audit repo; it may overwrite audit records`);
      return;
    }
    for (const n of names) {
      const r = this.ctx.files.protectedReason(resolve(dest, n));
      if (r) {
        this.block(`${prog} would unpack onto ${r}`);
        return;
      }
    }
  }

  ln(rest, scope) {
    const pos = nonOptions(rest, "tS");
    if (pos.length < 1) return;
    const sources = pos.length === 1 ? pos : pos.slice(0, -1);
    for (const s of sources) {
      if (!s.s || s.dyn) continue;
      const r = this.ctx.files.protectedReason(this.abs(s, scope));
      if (r) this.block(`ln links to ${r}, so a later write through the link would change it`);
    }
    if (pos.length > 1) this.writeTarget(pos[pos.length - 1], scope, "ln writes", { recursive: false });
  }

  rsync(rest, scope) {
    const pos = nonOptions(rest, "efT");
    if (pos.length < 2) return;
    this.writeTarget(pos[pos.length - 1], scope, "rsync writes into", { dirMatters: rest.some((a) => /^--(delete|del\b|remove-source-files)/.test(a.s ?? "")) });
    if (rest.some((a) => a.s === "--remove-source-files")) for (const s of pos.slice(0, -1)) this.writeTarget(s, scope, "rsync removes");
  }

  patchCommand(rest, scope, info) {
    let patchText = null;
    const pos = [];
    for (let k = 0; k < rest.length; k++) {
      const s = rest[k].s ?? "";
      if (s === "-i" || s === "--input") {
        patchText = this.scriptText(rest[++k], scope);
        continue;
      }
      if (s.startsWith("--input=")) {
        patchText = readText(resolve(scope.cwd, s.slice(8)));
        continue;
      }
      if (/^-[pdDBrozFV]$/.test(s)) {
        k++;
        continue;
      }
      if (s.startsWith("-")) continue;
      pos.push(rest[k]);
    }
    if (pos[0]) this.writeTarget(pos[0], scope, "patch edits");
    if (patchText === null) {
      const r = info.cmd?.redirs.find((x) => x.op === "<" && x.target);
      const t = r ? expandWord(r.target, scope)[0] : null;
      patchText = t ? this.scriptText(t, scope) : null;
    }
    if (patchText) for (const p of diffPaths(patchText)) this.writeTarget({ s: p, dyn: false, glob: false, tail: p }, scope, "the patch edits");
  }

  // --- pr-rla --------------------------------------------------------------------------------------------------

  prRla(rest, info, definite) {
    this.runsPrRla = true;
    const env = this.ctx.env;
    const valueOpts = new Set(["-C", "--dir", "-c", "--config", "--from-file", "--plugins"]);
    const valueAfter = new Set(["--window", "--max-patch-bytes", "--log-key", "--tsa-trust", "--beacon-file", "--population", "--defects", "--runs", "--seed", "--p0", "--p1", "--alpha", "--cap", "--fixture", "--kind", "--trust", "--reviewer", "--note", "--sign", "--rekor-url", "--rekor-api", "--key", "--out", "--through", "--remote", "--branch", "--repo", "--provider", "--resume", "--env", "--origin"]);
    const isValue = (j) => valueOpts.has(rest[j - 1]?.s ?? "") || valueAfter.has(rest[j - 1]?.s ?? "");
    // --help or --version anywhere (but not as another option's value, such as --note --help) prints and exits.
    const helpOnly = rest.some((a, j) => ["-h", "--help", "-V", "--version"].includes(a.s ?? "") && !isValue(j)) && !rest.some((a) => a.s === "--accept-lock-grants" || a.s === "--submit");
    if (!helpOnly && env.PR_RLA_ACCEPT_LOCK_GRANTS) this.block("this session's environment sets PR_RLA_ACCEPT_LOCK_GRANTS, so any pr-rla command run here would take the repo's lock grants without your consent; unset it before starting the assistant");
    if (info.env?.has("XDG_CONFIG_HOME") || info.env?.has("HOME")) this.block("pr-rla run with HOME or XDG_CONFIG_HOME changed would read another approvals file, which would stand in for your consent");
    if (rest.some((a) => a.s === "--accept-lock-grants" || (a.s ?? "").startsWith("--accept-lock-grants="))) this.block("--accept-lock-grants takes the repo's credential grants and trust without your consent; only you may run pr-rla that way, in your own terminal");
    if (rest.some((a) => a.s === "--submit")) this.block("--submit writes a public, permanent transparency-log entry; only you may submit, in your own terminal");
    if (info.viaXargs) {
      this.block("pr-rla run through xargs takes its arguments from its input, which the guard cannot see; run the exact pr-rla command instead");
      return;
    }
    if (helpOnly && !rest.some((a) => a.dyn)) return; // --help and --version print and exit
    // Global options, then the subcommand.
    let k = 0;
    for (; k < rest.length; k++) {
      const a = rest[k];
      if (a.s === null) break;
      if (valueOpts.has(a.s)) {
        k++;
        continue;
      }
      if (/^-(C|c).+/.test(a.s) || /^--(dir|config|from-file|plugins)=/.test(a.s)) continue;
      if (a.s.startsWith("-")) continue;
      break;
    }
    const sub = rest[k];
    if (!sub) return;
    if (sub.dyn) {
      this.block("the pr-rla subcommand is computed, so the guard cannot tell whether it writes; run the exact pr-rla command");
      return;
    }
    const args = rest.slice(k + 1);
    const dynamicFlag = rest.some((a, j) => a.dyn && j !== k && !isValue(j));
    const s = sub.s;
    const has = (f) => args.some((a) => a.s === f || (a.s ?? "").startsWith(`${f}=`));
    const human = "a person's own command, in their own terminal";
    switch (s) {
      case "record":
        if (has("--sign")) this.block(`pr-rla record --sign makes the reviewer's signature over a verdict; the reviewer signs their own verdict (${human})`);
        this.block(`pr-rla record writes a verdict, and a verdict is the reviewer's: they run "pr-rla record …" themselves (${human}), or apply the label in the tracker`);
        return;
      case "register":
      case "freeze":
      case "sample":
      case "init":
        this.block(`pr-rla ${s} writes the audit's records (${s === "sample" ? "it issues draws" : s === "init" ? "the configuration and protocol" : "a signed, time-stamped record"}); it is ${human}${s === "freeze" ? ", and the MCP tool freeze_preview shows a dry run read-only" : ""}`);
        return;
      case "checkpoint":
        if (has("--push") || has("--remote") || has("--branch")) this.block("pr-rla checkpoint --push commits and pushes to the audit repo; it is a person's own command");
        else if (dynamicFlag) this.block("a computed argument could add --push to pr-rla checkpoint; run the exact command");
        return;
      case "plugin": {
        const what = args[0];
        if (!what || what.dyn) {
          if (definite) this.block("pr-rla plugin with a computed subcommand: the guard cannot tell whether it gives consent");
          return;
        }
        if (what.s === "check") return;
        if (["approve", "add", "lock"].includes(what.s ?? "")) {
          this.block(`pr-rla plugin ${what.s} records your consent to a plugin (its credentials, trust and lock entry); only you may give it`);
          return;
        }
        if (definite && !["-h", "--help", "help"].includes(what.s ?? "")) this.block(`pr-rla plugin ${what.s} is not a pr-rla command the guard knows to be read-only`);
        return;
      }
      default:
        if (PRRLA_READ.has(s ?? "")) {
          if (dynamicFlag) this.block(`a computed argument to pr-rla ${s} could be a flag that writes or consents; run the exact command`);
          return;
        }
        if (definite) this.block(`pr-rla ${s} is not a pr-rla command the guard knows to be read-only`);
    }
  }

  // --- ssh-keygen -Y sign --------------------------------------------------------------------------------------

  sshKeygen(rest) {
    const withValue = "CDEFIJKMNOPRSUVWYZabjmnrstuwz";
    let op = null;
    let ns;
    let nsDynamic = false;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      const s = a.s ?? "";
      if (!s.startsWith("-") || s === "-") continue;
      for (let c = 1; c < s.length; c++) {
        const ch = s[c];
        if (!withValue.includes(ch)) continue;
        const attached = s.slice(c + 1);
        const v = attached ? { s: attached, dyn: a.dyn } : rest[++k] ?? { s: null, dyn: true };
        if (ch === "Y") op = v.s;
        if (ch === "n") {
          ns = v.s;
          nsDynamic = v.dyn || v.s === null;
        }
        break;
      }
    }
    if (op === "sign" && (ns === VERDICT_NAMESPACE || nsDynamic)) this.block(`ssh-keygen -Y sign -n ${VERDICT_NAMESPACE} signs a pr-rla verdict; the reviewer signs their own verdict, with their own key`);
    if (op === null && rest.some((a) => a.dyn)) {
      /* unknown operation: nothing to say */
    }
  }

  // --- gh ------------------------------------------------------------------------------------------------------

  gh(rest, scope, depth) {
    const roots = this.roots(scope);
    const label = (v) => v && (v.dyn || v.s === null || splitLabels(v.s).some((x) => this.ctx.files.isVerdictLabel(x, roots)));
    const words = rest.map((a) => a.s);
    let k = 0;
    while (k < rest.length && (rest[k].s ?? "").startsWith("-")) k += ["-R", "--repo", "--hostname"].includes(rest[k].s ?? "") ? 2 : 1;
    const area = words[k];
    const verb = words[k + 1];
    const tail = rest.slice(k + 2);
    if (area === "api") return this.ghApi(rest.slice(k + 1), scope, "gh api");
    if (area === "alias" && verb === "set") {
      const expansion = tail.filter((a) => !(a.s ?? "").startsWith("-"))[1];
      if (expansion?.s) {
        if (expansion.s.startsWith("!")) this.script(expansion.s.slice(1), scope.child(), depth + 1);
        else this.gh(expandWords(new Tokenizer(expansion.s, depth + 1).run().tokens.filter((t) => t.k === "word"), scope), scope, depth + 1);
      }
      return;
    }
    if ((area === "issue" || area === "pr") && (verb === "edit" || verb === "create")) {
      const flags = verb === "edit" ? ["--add-label", "--remove-label"] : ["-l", "--label"];
      for (let j = 0; j < tail.length; j++) {
        const s = tail[j].s ?? "";
        for (const f of flags) {
          if (s === f && label(tail[j + 1])) this.block(`gh ${area} ${verb} ${f} applies or removes a pr-rla verdict label; the reviewer applies it themselves, in the tracker`);
          else if (s.startsWith(`${f}=`) && label({ s: s.slice(f.length + 1), dyn: tail[j].dyn })) this.block(`gh ${area} ${verb} ${f} applies or removes a pr-rla verdict label; the reviewer applies it themselves, in the tracker`);
        }
        if (verb === "edit" && (s === "--remove-label" || s.startsWith("--remove-label=")) && /^(\*|all)$/i.test((s.includes("=") ? s.split("=")[1] : tail[j + 1]?.s) ?? "")) this.block("gh removing every label would remove a verdict label");
      }
      return;
    }
    if (area === "label" && (verb === "edit" || verb === "delete")) {
      const nameArg = tail.find((a) => !(a.s ?? "").startsWith("-"));
      if (label(nameArg)) this.block(`gh label ${verb} changes a pr-rla verdict label, which the ledger's history depends on`);
      const rename = tail.findIndex((a) => a.s === "--name" || a.s === "-n");
      if (rename >= 0 && label(tail[rename + 1])) this.block("gh label edit --name renames a label to a pr-rla verdict label");
    }
  }

  /** `gh api` / `glab api`: a non-read request to a label endpoint, an issue update carrying labels, or a GraphQL label mutation. */
  ghApi(args, scope, what) {
    let method = null;
    const fields = [];
    let endpoint = null;
    const body = [];
    for (let k = 0; k < args.length; k++) {
      const s = args[k].s;
      if (s === null) {
        if (!endpoint) endpoint = args[k];
        continue;
      }
      if (s === "-X" || s === "--method") {
        method = (args[++k]?.s ?? "?").toUpperCase();
        continue;
      }
      if (/^-X./.test(s)) {
        method = s.slice(2).toUpperCase();
        continue;
      }
      if (s.startsWith("--method=")) {
        method = s.slice(9).toUpperCase();
        continue;
      }
      if (["-f", "-F", "--field", "--raw-field"].includes(s)) {
        fields.push(args[++k]);
        continue;
      }
      if (/^--(raw-)?field=/.test(s)) {
        fields.push({ ...args[k], s: s.replace(/^--(raw-)?field=/, "") });
        continue;
      }
      if (s === "--input") {
        const f = args[++k];
        body.push(!f || f.s === "-" ? null : this.scriptText(f, scope));
        continue;
      }
      if (["-H", "--header", "-p", "--preview", "--hostname", "-q", "--jq", "-t", "--template", "--cache"].includes(s)) {
        k++;
        continue;
      }
      if (s.startsWith("-")) continue;
      if (!endpoint) endpoint = args[k];
    }
    if (!method) method = fields.length || body.length ? "POST" : "GET";
    for (const f of fields) {
      if (!f || f.s === null) {
        body.push(null);
        continue;
      }
      const m = /^([^=]*)=(.*)$/s.exec(f.s);
      const key = m ? m[1] : f.s;
      const value = m ? m[2] : "";
      if (!value.startsWith("@")) body.push(`${key}=${value}`);
      else {
        const text = value === "@-" ? null : this.scriptText({ s: value.slice(1) }, scope);
        body.push(text === null ? null : `${key}=${text}`);
      }
    }
    const ep = endpoint?.s ?? null;
    if (ep === null) {
      if (method !== "GET" && method !== "HEAD") this.block(`${what} with a computed endpoint and method ${method}: the guard cannot tell whether it writes a verdict label`);
      return;
    }
    const r = labelWrite(method, ep, body);
    if (r) this.block(`${what} ${r}`);
  }

  // --- glab ----------------------------------------------------------------------------------------------------

  glab(rest, scope) {
    const roots = this.roots(scope);
    const label = (v) => v && (v.dyn || v.s === null || splitLabels(v.s).some((x) => this.ctx.files.isVerdictLabel(x, roots)));
    let k = 0;
    while (k < rest.length && (rest[k].s ?? "").startsWith("-")) k += ["-R", "--repo"].includes(rest[k].s ?? "") ? 2 : 1;
    const area = rest[k]?.s;
    const verb = rest[k + 1]?.s;
    const tail = rest.slice(k + 2);
    if (area === "api") return this.ghApi(rest.slice(k + 1), scope, "glab api");
    if ((area === "issue" || area === "mr") && (verb === "update" || verb === "create" || verb === "edit")) {
      const flags = ["-l", "--label", "-u", "--unlabel"];
      for (let j = 0; j < tail.length; j++) {
        const s = tail[j].s ?? "";
        for (const f of flags) {
          if ((s === f && label(tail[j + 1])) || (s.startsWith(`${f}=`) && label({ s: s.slice(f.length + 1), dyn: tail[j].dyn }))) this.block(`glab ${area} ${verb} ${f} applies or removes a pr-rla verdict label; the reviewer applies it themselves, in GitLab`);
        }
      }
      return;
    }
    if (area === "label" && (verb === "delete" || verb === "edit" || verb === "update")) {
      const nameArg = tail.find((a) => !(a.s ?? "").startsWith("-"));
      if (label(nameArg)) this.block(`glab label ${verb} changes a pr-rla verdict label, which the ledger's history depends on`);
    }
  }

  // --- curl, wget, HTTPie ----------------------------------------------------------------------------------------

  curl(rest, scope) {
    const valueShort = new Set("AbcCdDeEFHKmoPQrTtuUwxXyYz".split(""));
    const valueLong = new Set(["--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "--form", "--form-string", "--request", "--header", "--url", "--upload-file", "--user", "--output", "--config", "--cookie", "--cookie-jar", "--user-agent", "--referer", "--max-time", "--connect-timeout", "--retry", "--proxy", "--cacert", "--cert", "--key", "--write-out", "--range", "--resolve", "--connect-to", "--oauth2-bearer", "--variable", "--expand-data", "--expand-url"]);
    let method = null;
    let get = false;
    const urls = [];
    const body = [];
    let upload = false;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      const s = a.s;
      if (s === null) {
        urls.push(a);
        continue;
      }
      let opt = null;
      let val;
      if (s.startsWith("--")) {
        const eq = s.indexOf("=");
        opt = eq > 0 ? s.slice(0, eq) : s;
        if (valueLong.has(opt)) val = eq > 0 ? { ...a, s: s.slice(eq + 1) } : rest[++k];
      } else if (s.startsWith("-") && s.length > 1) {
        opt = `-${s[1]}`;
        if (valueShort.has(s[1])) val = s.length > 2 ? { ...a, s: s.slice(2) } : rest[++k];
        else if (s.length > 2) {
          // a cluster of flags such as -sSL; a value flag at its end takes the next word
          for (const ch of s.slice(1)) if (ch === "G") get = true;
          const last = s[s.length - 1];
          if (valueShort.has(last)) {
            opt = `-${last}`;
            val = rest[++k];
          }
        }
      }
      if (opt === null) {
        urls.push(a);
        continue;
      }
      if (opt === "-X" || opt === "--request") method = (val?.s ?? "?").toUpperCase();
      else if (opt === "-G" || opt === "--get") get = true;
      else if (opt === "-I" || opt === "--head") method = method ?? "HEAD";
      else if (["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string"].includes(opt)) {
        if (!val || val.s === null) body.push(null);
        else if (val.s.startsWith("@") && opt !== "--data-raw") body.push(val.s === "@-" ? null : this.scriptText({ s: val.s.slice(1) }, scope));
        else body.push(val.s);
      } else if (opt === "-T" || opt === "--upload-file") {
        upload = true;
        body.push(val?.s ? this.scriptText(val, scope) : null);
      } else if (opt === "--url") urls.push(val);
      else if (opt === "-K" || opt === "--config") {
        const text = val?.s ? this.scriptText(val, scope) : null;
        if (text === null || /labels|graphql/i.test(text)) this.block("curl --config reads its request from a file the guard cannot fully check, and it names labels or GraphQL");
      }
    }
    if (!method) method = get ? "GET" : body.length ? (upload ? "PUT" : "POST") : "GET";
    if (get && method === "POST") method = "GET";
    for (const u of urls) {
      if (!u) continue;
      if (u.s === null) {
        if (method !== "GET" && method !== "HEAD") this.block(`curl ${method} to a computed URL: the guard cannot tell whether it writes a verdict label`);
        continue;
      }
      if (!/^(https?:\/\/|[\w.-]+\.[a-z]{2,}\/|\/)/i.test(u.s)) continue;
      const r = labelWrite(method, u.s, body);
      if (r) this.block(`curl ${r}`);
    }
  }

  wget(rest, scope) {
    let method = "GET";
    const body = [];
    const urls = [];
    for (let k = 0; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null) {
        urls.push(rest[k]);
        continue;
      }
      if (s.startsWith("--method=")) method = s.slice(9).toUpperCase();
      else if (s === "--method") method = (rest[++k]?.s ?? "?").toUpperCase();
      else if (s.startsWith("--post-data=") || s.startsWith("--body-data=")) {
        body.push(s.slice(s.indexOf("=") + 1));
        if (method === "GET") method = "POST";
      } else if (s.startsWith("--post-file=") || s.startsWith("--body-file=")) {
        body.push(readText(resolve(scope.cwd, s.slice(s.indexOf("=") + 1))));
        if (method === "GET") method = "POST";
      } else if (s === "-O" || s === "-o" || s === "--header" || s === "-U") k++;
      else if (!s.startsWith("-")) urls.push(rest[k]);
    }
    for (const u of urls) {
      if (!u?.s) continue;
      const r = labelWrite(method, u.s, body);
      if (r) this.block(`wget ${r}`);
    }
  }

  httpie(rest, scope) {
    const pos = rest.filter((a) => !(a.s ?? "").startsWith("-"));
    let k = 0;
    let method = null;
    if (pos[0]?.s && /^[A-Z]+$/.test(pos[0].s)) {
      method = pos[0].s;
      k = 1;
    }
    const url = pos[k];
    const items = pos.slice(k + 1).map((a) => a.s);
    const data = items.filter((i) => i === null || /^[^:=]+(:=|=|@)/.test(i)).map((i) => (i === null ? null : i.replace(/@(.+)$/, (_m, f) => `=${readText(resolve(scope.cwd, f)) ?? ""}`)));
    if (!method) method = data.length ? "POST" : "GET";
    if (!url?.s) return;
    const r = labelWrite(method, url.s, data);
    if (r) this.block(`HTTPie ${r}`);
  }

  // --- git -----------------------------------------------------------------------------------------------------

  git(rest, scope, depth, info) {
    let cwd = scope.cwd;
    let k = 0;
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null) return;
      if (s === "-C") {
        if (rest[k + 1]?.s) cwd = resolve(cwd, rest[k + 1].s);
        k++;
        continue;
      }
      if (s === "-c") {
        const cfg = rest[++k]?.s ?? "";
        const m = /^([^=]+)=(.*)$/s.exec(cfg);
        if (m && GIT_COMMAND_KEYS.test(m[1])) {
          const value = m[2].startsWith("!") ? m[2].slice(1) : m[2];
          if (!/^alias\./i.test(m[1]) || m[2].startsWith("!")) this.script(value, scope.child(), depth + 1);
        }
        continue;
      }
      if (["--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"].includes(s)) {
        k++;
        continue;
      }
      if (s.startsWith("-")) continue;
      break;
    }
    const sub = rest[k]?.s;
    if (!sub) return;
    const args = rest.slice(k + 1);
    const gitScope = Object.assign(scope.child(), { cwd });
    const auditRoot = this.ctx.files.auditRootOf(cwd);
    const known = new Set(["add", "am", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "checkout", "cherry", "cherry-pick", "clean", "clone", "commit", "config", "describe", "diff", "diff-tree", "fetch", "filter-branch", "filter-repo", "format-patch", "fsck", "gc", "grep", "help", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mv", "notes", "pull", "push", "range-diff", "rebase", "reflog", "remote", "replace", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "sparse-checkout", "stage", "stash", "status", "submodule", "switch", "tag", "update-index", "update-ref", "version", "whatchanged", "worktree"]);
    if (!known.has(sub)) {
      const alias = runGit(["config", "--get", `alias.${sub}`], cwd);
      if (alias !== null && depth < MAX_DEPTH) {
        const a = alias.trim();
        if (a.startsWith("!")) this.script(`${a.slice(1)} ${args.map(shq).join(" ")}`, gitScope, depth + 1);
        else this.script(`git ${a} ${args.map(shq).join(" ")}`, gitScope, depth + 1);
      }
      return;
    }
    const opts = args.map((a) => a.s ?? "");
    const ledgerFiles = () => {
      const names = new Set(["verdicts.jsonl"]);
      if (auditRoot) for (const f of this.ctx.files.configOf(auditRoot).files) names.add(f);
      return names;
    };
    const isLedgerFile = (p) => ledgerFiles().has(basename(p).toLowerCase());
    const top = () => runGit(["rev-parse", "--show-toplevel"], cwd)?.trim() ?? cwd;
    const protectedChanged = (extraArgs = []) => {
      const out = runGit(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...extraArgs], cwd);
      if (out === null) return null;
      const t = top();
      const paths = out.split("\0").filter(Boolean).map((l) => l.slice(3)).filter(Boolean);
      for (const p of paths) {
        const r = this.ctx.files.protectedReason(resolve(t, p));
        if (r) return r;
      }
      return null;
    };
    switch (sub) {
      case "config": {
        if (opts.some((o) => ["--get", "--get-all", "--get-regexp", "-l", "--list", "--unset", "--unset-all", "--show-origin", "get", "list", "unset"].includes(o))) return;
        const positional = args.filter((a, j) => !opts[j].startsWith("-") && !["set", "--file", "-f"].includes(opts[j]) && !["--file", "-f", "--type", "--default", "--comment"].includes(opts[j - 1] ?? ""));
        const key = positional[0]?.s ?? "";
        const value = positional[1]?.s ?? "";
        if (!GIT_COMMAND_KEYS.test(key)) return;
        if (/^alias\./i.test(key) && !value.startsWith("!")) return;
        this.script(value.startsWith("!") ? value.slice(1) : value, scope.child(), depth + 1);
        if (auditRoot && !/^alias\./i.test(key)) this.block(`git config ${key} in the audit repo makes git run a command as you later (when you commit, diff or log); only you may set it`);
        return;
      }
      case "commit": {
        const valueOpts = new Set(["-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message", "--fixup", "--squash", "--author", "--date", "-t", "--template", "--cleanup", "--trailer", "--pathspec-from-file"]);
        let all = false;
        let amend = false;
        const paths = [];
        let afterDashes = false;
        for (let j = 0; j < args.length; j++) {
          const s = opts[j];
          if (afterDashes) {
            paths.push(s);
            continue;
          }
          if (s === "--") {
            afterDashes = true;
            continue;
          }
          if (valueOpts.has(s)) {
            j++;
            continue;
          }
          if (s === "--amend") amend = true;
          else if (s === "--all" || s === "--include" || s === "--only" || s === "-i" || s === "-o") all = true;
          else if (/^-[a-zA-Z]+$/.test(s)) {
            if (s.includes("a")) all = true;
            if (/[mFCct]$/.test(s)) j++;
          } else if (s.startsWith("-")) continue;
          else paths.push(s);
        }
        const candidates = new Set((runGit(["diff", "--cached", "--name-only", "-z"], cwd) ?? "").split("\0").filter(Boolean));
        if (all || paths.length || this.ctx.stagesEarlier) {
          for (const p of (runGit(["diff", "--name-only", "-z"], cwd) ?? "").split("\0").filter(Boolean)) candidates.add(p);
          for (const p of (runGit(["ls-files", "--others", "--exclude-standard", "-z"], cwd) ?? "").split("\0").filter(Boolean)) candidates.add(p);
          for (const p of paths) candidates.add(relative(top(), resolve(cwd, p)));
        }
        if (amend) for (const p of (runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"], cwd) ?? "").split("\0").filter(Boolean)) candidates.add(p);
        const hit = [...candidates].find(isLedgerFile);
        if (hit) this.block(`git commit would ${amend ? "rewrite a commit that holds" : "commit"} ${hit}, the verdict ledger; the reviewer commits their own verdict`);
        return;
      }
      case "add":
      case "stage":
        this.ctx.stagesEarlier = true;
        return;
      case "push": {
        if (!auditRoot) return;
        const force = opts.some((s) => /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--delete|-d|--prune)$/.test(s) || (/^-[a-zA-Z]+$/.test(s) && /[fd]/.test(s)));
        const refspecs = opts.filter((s) => !s.startsWith("-"));
        const rewrite = refspecs.slice(1).some((r) => r.startsWith("+") || r.startsWith(":"));
        if (force || rewrite) this.block("a forced or deleting git push to the audit repo could rewrite or remove its history (verdicts and checkpoints); only a person may do that");
        return;
      }
      case "reset": {
        if (!auditRoot) return;
        if (!opts.some((s) => s === "--hard" || s === "--merge" || s === "--keep")) return;
        const changed = protectedChanged();
        if (changed) {
          this.block(`git reset ${opts.find((s) => s.startsWith("--"))} would discard an uncommitted change to ${changed}`);
          return;
        }
        const target = opts.find((s) => !s.startsWith("-"));
        if (target && target !== "HEAD") {
          const diff = runGit(["diff", "--name-only", "-z", target, "HEAD"], cwd);
          if (diff === null || diff.split("\0").filter(Boolean).some((p) => this.ctx.files.protectedReason(resolve(top(), p)))) this.block(`git reset to ${target} would drop commits that change audit records`);
        }
        return;
      }
      case "checkout":
      case "restore":
      case "rm":
      case "mv": {
        const dashes = opts.indexOf("--");
        const valueOpts = new Set(["-s", "--source", "-b", "-B", "--orphan", "--conflict", "--pathspec-from-file"]);
        let pathArgs = [];
        if (dashes >= 0) pathArgs = args.slice(dashes + 1);
        else if (sub === "checkout") pathArgs = args.filter((a, j) => !opts[j].startsWith("-") && !valueOpts.has(opts[j - 1] ?? "") && a.s && existsSync(resolve(cwd, a.s)));
        else pathArgs = args.filter((a, j) => !opts[j].startsWith("-") && !valueOpts.has(opts[j - 1] ?? ""));
        if (sub === "restore" && opts.includes("--staged") && !opts.includes("--worktree") && !opts.includes("-W")) return;
        if ((sub === "checkout" || sub === "switch") && dashes < 0 && pathArgs.length === 0) {
          if (auditRoot && opts.some((s) => s === "-f" || s === "--force" || s === "--discard-changes")) {
            const changed = protectedChanged();
            if (changed) this.block(`git checkout --force would discard an uncommitted change to ${changed}`);
          }
          return;
        }
        for (const a of pathArgs) {
          if (!a.s || a.dyn) continue;
          const abs = resolve(cwd, a.s);
          const r = this.ctx.files.protectedReason(abs);
          if (r) {
            this.block(`git ${sub} would change ${r}`);
            continue;
          }
          let isDir = false;
          try {
            isDir = statSync(abs).isDirectory();
          } catch {
            /* pathspec */
          }
          if (isDir) {
            if (sub === "rm" || sub === "mv") {
              const inside = this.ctx.files.protectedInside(abs);
              if (inside) this.block(`git ${sub} would remove or move a directory holding audit records: ${inside}`);
            } else {
              const changed = protectedChanged([relative(cwd, abs) || "."]);
              if (changed) this.block(`git ${sub} would discard an uncommitted change to ${changed}`);
            }
          }
        }
        return;
      }
      case "clean": {
        if (!auditRoot) return;
        if (!opts.some((s) => s === "--force" || /^-[a-zA-Z]*f/.test(s))) return;
        const ignored = opts.some((s) => /^-[a-zA-Z]*[xX]/.test(s));
        const out = runGit(["ls-files", "--others", ...(ignored ? [] : ["--exclude-standard"]), "-z"], cwd);
        const hit = (out ?? "").split("\0").filter(Boolean).find((p) => this.ctx.files.protectedReason(resolve(cwd, p)));
        if (hit) this.block(`git clean would delete ${hit}, an untracked audit record`);
        return;
      }
      case "stash": {
        if (!auditRoot) return;
        const verb = opts.find((s) => !s.startsWith("-"));
        if (verb && !["push", "save"].includes(verb)) return;
        const changed = protectedChanged();
        if (changed) this.block(`git stash would take an uncommitted change to ${changed} out of the working tree`);
        return;
      }
      case "apply":
      case "am": {
        if (opts.includes("--check") || opts.includes("--stat") || opts.includes("--numstat") || opts.includes("--summary")) return;
        const files = args.filter((a) => !(a.s ?? "").startsWith("-"));
        const texts = files.map((f) => this.scriptText(f, gitScope));
        if (!files.length) {
          const r = info.cmd?.redirs.find((x) => x.op === "<" && x.target);
          const t = r ? expandWord(r.target, scope)[0] : null;
          if (t) texts.push(this.scriptText(t, scope));
        }
        const t = top();
        for (const text of texts) for (const p of diffPaths(text ?? "")) {
          const r = this.ctx.files.protectedReason(resolve(t, p));
          if (r) this.block(`git ${sub} would change ${r}`);
        }
        return;
      }
      case "rebase":
      case "filter-branch":
      case "filter-repo":
      case "replace":
        if (auditRoot && !opts.some((s) => ["--abort", "--quit", "--show-current-patch", "-h", "--help"].includes(s))) this.block(`git ${sub} rewrites the audit repo's history, which holds its verdicts and checkpoints; only a person may do that`);
        return;
      default:
        return;
    }
  }

  roots(scope) {
    const out = new Set([this.ctx.files.auditRootOf(scope.cwd), this.ctx.files.auditRootOf(this.ctx.cwd)]);
    return [...out].filter(Boolean);
  }
}

/** Option-skipping for wrappers: drops leading options (and the values of those in `valueShort`). */
function skipOpts(args, valueShort) {
  let k = 0;
  for (; k < args.length; k++) {
    const s = args[k].s;
    if (s === null) break;
    if (s === "--") {
      k++;
      break;
    }
    if (!s.startsWith("-") || s === "-") break;
    if (s.length === 2 && valueShort.includes(s[1])) k++;
  }
  return args.slice(k);
}

/** The non-option arguments (with the values of `valueShort` options skipped). */
function nonOptions(args, valueShort) {
  const out = [];
  let dashes = false;
  for (let k = 0; k < args.length; k++) {
    const s = args[k].s;
    if (dashes || s === null) {
      out.push(args[k]);
      continue;
    }
    if (s === "--") {
      dashes = true;
      continue;
    }
    if (s.startsWith("-") && s !== "-") {
      if (s.length === 2 && valueShort.includes(s[1])) k++;
      continue;
    }
    out.push(args[k]);
  }
  return out;
}

function shq(a) {
  const s = typeof a === "string" ? a : (a.s ?? "");
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

function packageName(spec) {
  if (spec.startsWith("@")) {
    const at = spec.indexOf("@", 1);
    return at > 0 ? spec.slice(0, at) : spec;
  }
  const at = spec.indexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function findUp(dir, name) {
  let d = resolve(dir);
  for (let k = 0; k < 64; k++) {
    if (existsSync(join(d, name))) return join(d, name);
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

function splitLabels(s) {
  return String(s).split(",").map((x) => x.trim()).filter(Boolean);
}

/** The file paths a unified diff or a Codex apply_patch changes. */
function diffPaths(text) {
  const out = new Set();
  for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.add(m[1].trim());
  for (const m of text.matchAll(/^\*\*\* Move to: (.+)$/gm)) out.add(m[1].trim());
  for (const m of text.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+?)(?:\t.*)?$/gm)) if (m[1] !== "/dev/null") out.add(m[1].trim());
  for (const m of text.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)) {
    out.add(m[1]);
    out.add(m[2]);
  }
  for (const m of text.matchAll(/^rename (?:from|to) (.+)$/gm)) out.add(m[1].trim());
  return [...out];
}

const LABEL_MUTATION = /\b(addLabelsToLabelable|removeLabelsFromLabelable|clearLabelsFromLabelable|createLabel|updateLabel|deleteLabel)\b|\b(updateIssue|createIssue|updatePullRequest|createPullRequest)\b[\s\S]*\blabelIds\b/;

/** Why an HTTP request writes a verdict label, or null. `body` entries are null when unknown. */
function labelWrite(method, url, body) {
  const m = String(method).toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  let path = url;
  let query = "";
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://host/${url.replace(/^\/+/, "")}`);
    path = decodeSafe(u.pathname);
    query = decodeSafe(u.search);
  } catch {
    const q = url.indexOf("?");
    if (q >= 0) {
      query = url.slice(q);
      path = url.slice(0, q);
    }
  }
  const segs = path.split("/").filter(Boolean);
  const unknownBody = body.some((b) => b === null);
  const text = body.filter((b) => b !== null).join("\n");
  if (segs.includes("labels")) return `${m} ${path} writes to a label endpoint; the reviewer applies verdict labels themselves, in the tracker`;
  if (/\/graphql\/?$/.test(path)) {
    if (LABEL_MUTATION.test(text)) return "sends a GraphQL label mutation; the reviewer applies verdict labels themselves";
    if (unknownBody) return "sends a GraphQL document the guard cannot read; it may change labels";
    return null;
  }
  if (/(^|\/)(issues|pulls|merge_requests)\/[^/]+\/?$/.test(path)) {
    if (/\b(add_labels|remove_labels|labels)\b/.test(`${query}\n${text}`)) return `${m} ${path} changes an issue's labels; the reviewer applies verdict labels themselves`;
    if (unknownBody) return `${m} ${path} updates an issue with a body the guard cannot read; it may change labels`;
  }
  return null;
}

/** Findings for code in another language (node -e, python -c, a script file): pr-rla writes, signing, consent, labels, record writes. */
function codeFindings(text, ctx) {
  const out = [];
  if (!text) return out;
  if (/\bpr-rla\b[^\n;|&]{0,80}?\b(record|register|freeze|sample|init)\b/.test(text) || /\bpr-rla\b[^\n;|&]{0,80}?\bplugin\b[^\n;|&]{0,40}?\b(approve|add|lock)\b/.test(text) || /\bpr-rla\b[^\n;|&]{0,120}?(--push|--sign|--submit)\b/.test(text)) out.push("code that runs a pr-rla write command (record, register, freeze, sample, init, plugin approve/add/lock, checkpoint --push, --sign, --submit); it is a person's own command");
  if (/accept-lock-grants|PR_RLA_ACCEPT_LOCK_GRANTS|PR_RLA_APPROVALS_FILE/.test(text)) out.push("code that touches pr-rla's consent (--accept-lock-grants, PR_RLA_ACCEPT_LOCK_GRANTS, PR_RLA_APPROVALS_FILE); only you give consent");
  if (text.includes(VERDICT_NAMESPACE) && /\bsign\b/i.test(text)) out.push(`code that signs in the ${VERDICT_NAMESPACE} namespace; the reviewer signs their own verdict`);
  const labelHit = DEFAULT_LABELS.some((l) => text.toLowerCase().includes(l)) || /\bpr-rla\s*(?:::|:|-)\s*(?:pass|fail)\b/i.test(text);
  if (labelHit && /\b(labels?|POST|PUT|PATCH|DELETE)\b/.test(text)) out.push("code that sends a pr-rla verdict label; the reviewer applies it themselves");
  const names = [...RECORD_NAMES, ...ALWAYS_NAMES, "approvals.json", "ledger-history", ".manifest.json"];
  const mentions = names.some((n) => text.toLowerCase().includes(n));
  const writes = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|renameSync|rename|unlinkSync|unlink|rmSync|rmdirSync|copyFileSync|copyFile|cpSync|truncateSync|truncate|symlinkSync|linkSync|write_text|write_bytes|os\.remove|os\.rename|os\.replace|shutil\.(move|copy\w*|rmtree)|File\.write|FileUtils)\b|\bopen(Sync)?\s*\([^)]*,\s*['"][^'"]*[wax+]|\bopen\s*\(?\s*[A-Za-z_]*\s*,?\s*['"]\s*(>|>>|\+<|\+>)/.test(text);
  if (ctx.records && mentions && writes) out.push("code that writes a file named like a pr-rla audit record");
  return out;
}

function runGit(args, cwd) {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tool calls: shell, file writes, file reads, MCP tools, patches
// ---------------------------------------------------------------------------------------------------------------

function makeCtx(cwd, env) {
  const home = env.HOME || homedir();
  return { cwd: resolve(cwd), env, home, files: new Files(env, home, resolve(cwd)) };
}

/** Findings for a shell command line run in `cwd`. */
export function checkShell(command, { cwd = process.cwd(), env = process.env } = {}) {
  const ctx = makeCtx(cwd, env);
  const sh = new ShellCheck(ctx);
  const text = Array.isArray(command) ? argvToScript(command) : String(command ?? "");
  // The shell sees the environment too: the variables that name paths resolve from it.
  const vars = new Map([["PWD", ctx.cwd], ["HOME", ctx.home]]);
  for (const k of ["XDG_CONFIG_HOME", "PR_RLA_APPROVALS_FILE", "TMPDIR", "USER", "LOGNAME"]) if (typeof env[k] === "string") vars.set(k, env[k]);
  try {
    sh.script(text, new Scope(ctx.cwd, vars, ctx.home));
  } catch (e) {
    sh.block(`the guard could not read this command (${e?.message ?? e}); it blocks what it cannot read`);
  }
  if (sh.runsPrRla && sh.setsConfigHome) sh.block("the command changes HOME or XDG_CONFIG_HOME and runs pr-rla, which would then read another approvals file");
  return sh.findings;
}

/** A Codex-style argv (["bash", "-lc", "…"]) as one script. */
function argvToScript(argv) {
  if (argv.length >= 3 && /(^|\/)(ba|z|da|k)?sh$/.test(String(argv[0])) && /^-[a-z]*c[a-z]*$/.test(String(argv[1]))) return String(argv[2]);
  return argv.map((a) => shq(String(a))).join(" ");
}

export function checkWritePaths(paths, { cwd = process.cwd(), env = process.env } = {}, verb = "writes") {
  const ctx = makeCtx(cwd, env);
  const out = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    const abs = resolve(ctx.cwd, p.startsWith("~/") ? join(ctx.home, p.slice(2)) : p);
    const r = ctx.files.protectedReason(abs);
    if (r) out.push(`this edit ${verb} ${r}; only pr-rla's own commands, run by a person, change audit records`);
  }
  return out;
}

export function checkReadPaths(paths, { cwd = process.cwd(), env = process.env } = {}) {
  const ctx = makeCtx(cwd, env);
  const out = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    const abs = resolve(ctx.cwd, p);
    if (ctx.files.isSigningKey(abs)) out.push(`reading ${ctx.files.show(abs)}, the audit's signing key, would let the assistant sign audit records`);
  }
  return out;
}

/** Another MCP server's tool: a verdict label in its input, a write to a record, or a shell command it would run. */
export function checkMcp(toolName, input, { cwd = process.cwd(), env = process.env } = {}) {
  const ctx = makeCtx(cwd, env);
  const out = [];
  const roots = [ctx.files.auditRootOf(ctx.cwd)].filter(Boolean);
  const short = String(toolName).split("__").pop() ?? String(toolName);
  const writes = /(write|edit|create|update|delete|remove|move|rename|append|put|patch|push|commit|upload|set|add|label|replace|save)/i.test(short);
  const seen = new Set();
  const visit = (v, key, depth) => {
    if (depth > 12 || seen.size > 5000) return;
    if (typeof v === "string") {
      seen.add(v);
      const labelKey = /label/i.test(key ?? "");
      if (ctx.files.isVerdictLabel(v, roots) || (labelKey && splitLabels(v).some((x) => ctx.files.isVerdictLabel(x, roots)))) out.push(`${toolName} carries the pr-rla verdict label "${v.trim()}"; the reviewer applies it themselves, in the tracker`);
      if (/^(command|cmd|script|shell|bash)$/i.test(key ?? "")) for (const f of checkShell(v, { cwd: ctx.cwd, env })) out.push(`${toolName} would run a command that ${f}`);
      if (writes && v.length < 4096 && !v.includes("\n") && (/[\\/]/.test(v) || /\.(jsonl?|ya?ml|pem)$/i.test(v))) {
        const r = ctx.files.protectedReason(resolve(ctx.cwd, v));
        if (r) out.push(`${toolName} would change ${r}`);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
  };
  visit(input, null, 0);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------------------------------------------
// Clients: Claude Code, Codex, Cursor
// ---------------------------------------------------------------------------------------------------------------

const CURSOR_EVENTS = new Set(["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "preToolUse", "beforeTabFileRead"]);

/** Which client sent this payload, when --client does not say. */
export function detectClient(p) {
  if (p && typeof p === "object") {
    if ("cursor_version" in p || CURSOR_EVENTS.has(p.hook_event_name) || "workspace_roots" in p) return "cursor";
    if ("turn_id" in p || p.tool_name === "apply_patch") return "codex";
  }
  return "claude-code";
}

const PATH_KEYS = ["file_path", "path", "target_file", "filePath", "targetFile", "notebook_path", "target", "destination", "new_path", "old_path"];

function pathFields(input) {
  if (!input || typeof input !== "object") return [];
  const out = [];
  for (const k of PATH_KEYS) if (typeof input[k] === "string") out.push(input[k]);
  if (Array.isArray(input.edits)) for (const e of input.edits) for (const k of PATH_KEYS) if (typeof e?.[k] === "string") out.push(e[k]);
  return out;
}

/**
 * The decision for one payload: { client, decision: "block" | "allow", reasons }. A payload that carries a
 * client's own markers (Cursor's cursor_version, Codex's turn_id) is read as that client's, whatever --client
 * says: Cursor can load Claude Code hook configurations, and must get its own answer form back.
 */
export function evaluate(payload, { client, env = process.env } = {}) {
  const detected = detectClient(payload);
  const c = detected !== "claude-code" ? detected : (client ?? detected);
  if (!payload || typeof payload !== "object") return { client: c, decision: "block", reasons: ["the hook input is not a JSON object; the guard blocks what it cannot read"] };
  let cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : Array.isArray(payload.workspace_roots) && typeof payload.workspace_roots[0] === "string" ? payload.workspace_roots[0] : process.cwd();
  const tool = String(payload.tool_name ?? "");
  let input = payload.tool_input;
  const opts = () => ({ cwd, env });
  let reasons = [];
  if (c === "cursor") {
    const ev = payload.hook_event_name;
    if (ev === "beforeShellExecution") reasons = checkShell(payload.command ?? "", opts());
    else if (ev === "beforeMCPExecution") {
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          /* a plain string: scan it as is */
        }
      }
      reasons = checkMcp(`${payload.mcp_server_name ?? "mcp"}:${tool}`, input, opts());
    } else if (ev === "beforeReadFile" || ev === "beforeTabFileRead") reasons = checkReadPaths([payload.file_path], opts());
    else if (ev === "preToolUse") {
      if (input && typeof input === "object" && typeof input.working_directory === "string") cwd = input.working_directory;
      if (tool === "Shell") reasons = checkShell(input?.command ?? "", opts());
      else if (tool === "Read") reasons = checkReadPaths(pathFields(input), opts());
      else if (/^MCP:/.test(tool)) reasons = checkMcp(tool, input, opts());
      else if (/^(Write|Edit|Delete|MultiEdit|StrReplace|ApplyPatch)$/i.test(tool)) {
        const paths = pathFields(input);
        if (!paths.length && input && typeof input === "object") for (const v of Object.values(input)) if (typeof v === "string" && !v.includes("\n") && v.length < 4096) paths.push(v);
        reasons = checkWritePaths(paths, opts(), tool === "Delete" ? "removes" : "writes");
        if (typeof input?.patch === "string") reasons.push(...checkWritePaths(diffPaths(input.patch), opts()));
      }
    }
  } else if (c === "codex") {
    if (tool === "Bash" || tool === "shell" || tool === "exec_command" || tool === "local_shell") reasons = checkShell(input?.command ?? input?.cmd ?? "", { cwd: input?.workdir ?? cwd, env });
    else if (tool === "apply_patch") reasons = checkWritePaths(diffPaths(String(input?.command ?? input?.patch ?? input?.input ?? "")), opts());
    else if (tool.startsWith("mcp__")) reasons = checkMcp(tool, input, opts());
  } else {
    if (tool === "Bash" || tool === "PowerShell") reasons = checkShell(input?.command ?? "", opts());
    else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) reasons = checkWritePaths(pathFields(input), opts());
    else if (tool === "Read" || tool === "Grep") reasons = checkReadPaths(pathFields(input), opts());
    else if (tool.startsWith("mcp__")) reasons = checkMcp(tool, input, opts());
  }
  return { client: c, decision: reasons.length ? "block" : "allow", reasons };
}

/** What the hook prints and its exit code, in the client's own form. */
export function render(result) {
  const lines = result.reasons.map((r) => `pr-rla guard blocked this: ${r}.`);
  const message = `${lines.join("\n")}${lines.length ? "\n(pr-rla's guard keeps the verdict with the person reviewing: see docs/assistants/guard.md in pr-rla.)" : ""}`;
  if (result.client === "cursor") {
    if (result.decision === "allow") return { exitCode: 0, stdout: `${JSON.stringify({ permission: "allow" })}\n`, stderr: "" };
    return { exitCode: 2, stdout: `${JSON.stringify({ permission: "deny", user_message: lines[0] ?? "pr-rla guard blocked this", agent_message: message })}\n`, stderr: `${message}\n` };
  }
  if (result.decision === "allow") return { exitCode: 0, stdout: "", stderr: "" };
  return { exitCode: 2, stdout: "", stderr: `${message}\n` };
}

// ---------------------------------------------------------------------------------------------------------------
// The hook process
// ---------------------------------------------------------------------------------------------------------------

const USAGE = `pr-rla guard ${GUARD_VERSION}: a pre-tool-use hook that blocks verdict writes from an AI assistant.

usage: node guard.mjs [--client claude-code|codex|cursor] [--record <dir>]   (reads one hook payload on stdin)
       node guard.mjs --check-shell '<command>' [--cwd <dir>]                  (prints what the guard decides)

  --client   the payload's format (default: guessed from the payload)
  --record   also save each payload, as received, in <dir> (for checking a client's payload by hand)`;

async function main(argv) {
  const opt = { client: undefined, record: undefined, checkShell: undefined, cwd: process.cwd() };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === "--client") opt.client = argv[++k];
    else if (a === "--record") opt.record = argv[++k];
    else if (a === "--check-shell") opt.checkShell = argv[++k];
    else if (a === "--cwd") opt.cwd = argv[++k];
    else if (a === "--version") {
      process.stdout.write(`${GUARD_VERSION}\n`);
      return 0;
    } else if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    } else {
      process.stderr.write(`pr-rla guard: unknown argument ${a}\n${USAGE}\n`);
      return 2;
    }
  }
  if (opt.client !== undefined && !["claude-code", "codex", "cursor"].includes(opt.client)) {
    process.stderr.write(`pr-rla guard: --client must be claude-code, codex or cursor, not ${opt.client}\n`);
    return 2;
  }
  if (opt.checkShell !== undefined) {
    const f = checkShell(opt.checkShell, { cwd: opt.cwd });
    process.stdout.write(f.length ? `blocked:\n${f.map((x) => `  - ${x}`).join("\n")}\n` : "allowed\n");
    return f.length ? 2 : 0;
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  if (opt.record) {
    try {
      mkdirSync(opt.record, { recursive: true });
      const ev = String(payload?.hook_event_name ?? "unknown").replace(/[^\w-]/g, "_");
      const tool = String(payload?.tool_name ?? "").replace(/[^\w-]/g, "_").slice(0, 60);
      writeFileSync(join(opt.record, `${opt.client ?? detectClient(payload)}-${ev}${tool ? `-${tool}` : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`), raw);
    } catch {
      /* recording never changes the decision */
    }
  }
  const result = evaluate(payload, opt.client ? { client: opt.client } : {});
  const out = render(result);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  return out.exitCode;
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      // Fail closed: a guard that crashed has not checked the call.
      const msg = `pr-rla guard failed (${e?.message ?? e}); it blocks what it could not check`;
      if (process.argv.includes("cursor")) process.stdout.write(`${JSON.stringify({ permission: "deny", user_message: msg, agent_message: msg })}\n`);
      process.stderr.write(`${msg}\n`);
      process.exitCode = 2;
    },
  );
}
