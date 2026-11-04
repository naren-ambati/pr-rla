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
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
/** Inputs larger than these are blocked rather than read: a guard that runs out of time fails open in some clients. */
const MAX_COMMAND = 512 * 1024;
const MAX_CODE = 1024 * 1024;
/** The whole decision must fit well inside the hooks' 30 s timeout. */
const TIME_BUDGET_MS = 8000;
/** Variables whose value a program runs as a command line. */
const COMMAND_VARS = new Set(["GIT_PAGER", "PAGER", "GIT_EDITOR", "EDITOR", "VISUAL", "GIT_SEQUENCE_EDITOR", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EXTERNAL_DIFF", "LESSOPEN", "MANPAGER", "BASH_ENV", "ENV", "PROMPT_COMMAND", "PS0", "PS4"]);
/** git configuration keys whose value git runs as a command. */
const GIT_COMMAND_KEYS = /^(core\.(pager|editor|sshcommand|hookspath|fsmonitor|askpass)|sequence\.editor|diff\.external|credential\.helper|alias\.[^=]+|(diff|filter|merge)\.[^.]+\.(textconv|clean|smudge|process|driver)|pager\.[^=]+|gpg\.program|gpg\.ssh\.program)$/i;
/** Programs that only read the files they are given (beyond the ones handled one by one). */
const READERS = new Set(["cat", "less", "more", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "ack", "jq", "diff", "cmp", "comm", "file", "stat", "ls", "test", "[", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "cksum", "od", "hexdump", "strings", "cut", "tr", "column", "nl", "fold", "fmt", "tac", "rev", "paste", "join", "look", "bat", "echo", "realpath", "readlink", "basename", "dirname", "du", "tree", "open", "code", "subl", "xdg-open", "which", "type", "man", "printenv", "wc", "json_pp", "csvlook", "glow", "mdcat", "pbcopy"]);
/** Programs that print, search or compare their arguments and never run them. */
const NON_RUNNERS = new Set(["echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "ack", "cat", "less", "more", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "jq", "yq", "ls", "which", "type", "man", "whatis", "apropos", "file", "stat", "diff", "cmp", "comm", "column", "nl", "od", "xxd", "hexdump", "strings", "base64", "shasum", "sha256sum", "md5", "md5sum", "test", "[", "printenv", "history", "help", "read", "basename", "dirname", "realpath", "readlink", "say", "tldr", "open"]);
const MAX_FILE = 256 * 1024;
/** File names that mean "read standard input". */
const STDIN_FILES = new Set(["-", "/dev/stdin", "/dev/fd/0"]);

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
      // Arithmetic command (( ... )): bash and zsh run the substitutions inside, then evaluate it. `((cmd) )` is two subshells.
      if (c === "(" && s[this.i + 1] === "(") {
        const end = arithmeticEnd(s, this.i);
        if (end > 0) {
          this.subsIn(s.slice(this.i + 2, end - 2));
          this.i = end;
          continue;
        }
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
      this.pendingHeredocs.push({ tok, delim, strip: op === "<<-", expand: !target.parts.some((p) => p.q) });
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
      if (h.expand) this.subsIn(body);
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
        const m = /^~([A-Za-z0-9._-]*)/.exec(s.slice(this.i, this.i + 64));
        parts.push({ t: "tilde", user: m[1] });
        this.i += m[0].length;
        continue;
      }
      if (c === "=" && s[this.i + 1] === "(" && this.i === start) {
        // zsh =( … ): a temporary file holding the command's output
        const inner = this.matchParen(this.i + 1);
        this.sub(inner.text);
        parts.push({ t: "dyn", q: false });
        this.i = inner.end;
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
      const end = arithmeticEnd(s, this.i + 1);
      if (end > 0) {
        this.subsIn(s.slice(this.i + 3, end - 2));
        this.i = end;
        parts.push({ t: "dyn", q });
        return;
      }
    }
    if (n === "[") {
      // $[ … ]: old-style arithmetic
      const end = s.indexOf("]", this.i + 2);
      this.subsIn(s.slice(this.i + 2, end < 0 ? s.length : end));
      this.i = end < 0 ? s.length : end + 1;
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
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[@*0-9]+\])?(?:(:?[-=])(.*))?$/s.exec(body);
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
    this.subs.push(text);
  }

  /** The substitutions in text the shell expands without splitting it into words (an unquoted heredoc's body, arithmetic): bash and zsh run each one. */
  subsIn(text) {
    const t = new Tokenizer(text, this.depth);
    const parts = [];
    while (t.i < text.length) {
      const c = text[t.i];
      if (c === "\\") t.i += 2;
      else if (c === "$") t.readDollar(parts, true);
      else if (c === "`") t.readBacktick(parts, true);
      else t.i++;
    }
    this.subs.push(...t.subs);
  }
}

/** The index just past the `))` that closes the `((` at `open`, when it is arithmetic; -1 when it is `( (…) )`. */
function arithmeticEnd(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === "\n" && depth <= 2) return -1;
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 1) return s[j + 1] === ")" ? j + 2 : -1;
    }
  }
  return -1;
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

/**
 * A script's items in source order: { cmd }, { open } / { close } around subshells, and { forVar, words } where a
 * `for NAME in WORDS` loop binds NAME for the commands that follow.
 */
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
  // Words that are not commands: a for/select list, a case word and its patterns, a [[ … ]] test.
  let skip = null;
  let forItem = null;
  let caseDepth = 0;
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (skip === "test") {
      if (tok.k === "word" && wordLiteral(tok) === "]]") skip = null;
      continue;
    }
    if (tok.k === "op") {
      if (skip === "for-words" || skip === "for-name") {
        if (tok.v === ";" || tok.v === "\n") {
          if (forItem) items.push(forItem);
          forItem = null;
          skip = null;
        }
        continue;
      }
      if (skip === "case-word") continue;
      if (tok.v === "|" || tok.v === "|&") {
        endCmd(true);
        continue;
      }
      if (tok.v === "(") {
        if (skip === "case-pattern") continue; // an optional ( before a pattern
        // `name ( )` is a function definition: drop the parentheses.
        if (cur && cur.words.length === 1 && cur.assigns.length === 0 && tokens[t + 1]?.k === "op" && tokens[t + 1].v === ")") {
          t++;
          cur.words = [];
          endCmd(false);
          continue;
        }
        // NAME=( … ): an array.
        const last = cur?.assigns[cur.assigns.length - 1];
        if (cur && cur.words.length === 0 && last && last.value.parts.length === 0) {
          const words = [];
          for (t++; t < tokens.length && !(tokens[t].k === "op" && tokens[t].v === ")"); t++) if (tokens[t].k === "word") words.push(tokens[t]);
          last.array = words;
          continue;
        }
        endCmd(false);
        items.push({ open: true });
        continue;
      }
      if (tok.v === ")") {
        endCmd(false);
        if (skip === "case-pattern") {
          skip = null;
          continue;
        }
        items.push({ close: true });
        continue;
      }
      if (tok.v === ";;" || tok.v === ";&" || tok.v === ";;&") {
        endCmd(false);
        if (caseDepth > 0) skip = "case-pattern";
        continue;
      }
      endCmd(false);
      continue;
    }
    if (skip === "case-word" || skip === "case-pattern") {
      if (tok.k === "word") {
        const lit = wordLiteral(tok);
        if (skip === "case-word" && lit === "in") skip = "case-pattern";
        else if (skip === "case-pattern" && lit === "esac") {
          skip = null;
          caseDepth--;
        }
      }
      continue;
    }
    if (skip === "for-name") {
      if (tok.k === "word") {
        forItem = { forVar: wordLiteral(tok) ?? "", words: [] };
        skip = "for-in";
      }
      continue;
    }
    if (skip === "for-in") {
      const lit = tok.k === "word" ? wordLiteral(tok) : null;
      if (lit === "in") skip = "for-words";
      else {
        // `for NAME; do` or `for NAME do`: the positional parameters
        if (forItem) items.push({ ...forItem, words: null });
        forItem = null;
        skip = null;
        if (lit !== "do") t--;
      }
      continue;
    }
    if (skip === "for-words") {
      const lit = tok.k === "word" ? wordLiteral(tok) : null;
      if (lit === "do") {
        if (forItem) items.push(forItem);
        forItem = null;
        skip = null;
      } else if (tok.k === "word") forItem?.words.push(tok);
      continue;
    }
    if (tok.k === "redir") {
      startCmd().redirs.push(tok);
      continue;
    }
    const lit = wordLiteral(tok);
    const atStart = !cur || cur.words.length === 0;
    if (atStart && lit === "[[") {
      skip = "test";
      continue;
    }
    if (atStart && lit === "esac" && caseDepth > 0) {
      caseDepth--;
      continue;
    }
    if (atStart && lit !== null && RESERVED.has(lit)) continue;
    if (atStart && (lit === "for" || lit === "select")) {
      skip = "for-name";
      continue;
    }
    if (atStart && lit === "case") {
      skip = "case-word";
      caseDepth++;
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
  if (forItem) items.push(forItem);
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
    let anyQuoted = false;
    let split = false;
    for (const p of seq) {
      if (p.t === "lit") {
        s += p.s;
        pattern += p.q ? p.s.replace(/[*?[\]\\]/g, "\\$&") : p.s;
        tail += p.s;
        if (!p.q) quoted = false;
        else anyQuoted = true;
      } else if (p.t === "glob" || p.t === "brace") {
        s += p.s;
        pattern += p.s;
        tail += p.s;
        quoted = false;
        if (p.t === "glob") glob = true;
      } else if (p.t === "tilde") {
        const h = !p.user || p.user === scope.vars.get("USER") || p.user === scope.vars.get("LOGNAME") ? scope.home : `/Users/${p.user}`;
        s += h;
        pattern += h.replace(/[*?[\]\\]/g, "\\$&");
        tail += h;
        quoted = false;
      } else if (p.t === "var") {
        if (p.q) anyQuoted = true;
        if (scope.arrays?.has(p.name)) split = true;
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
            if (ifsRegex(scope).test(v)) split = true;
          }
        }
      } else {
        dyn = true;
        tail = "";
        if (!p.q) quoted = false;
      }
    }
    if (!dyn && split) {
      for (const piece of s.split(new RegExp(`${ifsRegex(scope).source}+`)).filter(Boolean)) out.push({ s: piece, dyn: false, glob, pattern: piece, tail: piece, quoted: false, raw: w.raw });
      continue;
    }
    if (!dyn && s === "" && !anyQuoted) continue; // an empty unquoted word (an empty variable, a {a,} brace) is no word
    out.push({ s: dyn ? null : s, dyn, glob: glob && !dyn, pattern, tail, quoted, raw: w.raw });
  }
  return out;
}

function ifsRegex(scope) {
  const ifs = scope.vars.get("IFS");
  return typeof ifs === "string" && ifs !== "" ? new RegExp(`[${ifs.replace(/[\]\\^-]/g, "\\$&")}]`) : /\s/;
}

/** Bash brace expansion over a word's parts: {a,b}, and {x..y} for single characters and small integers. */
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
  if (close >= 0 && commas.length === 0) {
    const inner = parts.slice(open + 1, close);
    const text = inner.every((p) => p.t === "lit" && !p.q) ? inner.map((p) => p.s).join("") : null;
    const m = text === null ? null : /^(-?\d{1,4}|[A-Za-z])\.\.(-?\d{1,4}|[A-Za-z])$/.exec(text);
    if (m) {
      const num = /\d/.test(m[1]);
      const a = num ? Number(m[1]) : m[1].charCodeAt(0);
      const z = num ? Number(m[2]) : m[2].charCodeAt(0);
      const step = a <= z ? 1 : -1;
      const out = [];
      for (let v = a; step > 0 ? v <= z : v >= z; v += step) {
        const item = { t: "lit", s: num ? String(v) : String.fromCharCode(v), q: false };
        for (const tail of braceExpand(parts.slice(close + 1))) out.push([...parts.slice(0, open), item, ...tail]);
        if (out.length > 256) break;
      }
      return out;
    }
  }
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

/** find -path: a glob over the whole path, where * also matches /. */
function pathGlobRegex(pattern) {
  let re = "^";
  for (const c of pattern) re += c === "*" ? ".*" : c === "?" ? "." : escapeRe(c);
  return new RegExp(`${re}$`, "i");
}

function safeRegex(src) {
  try {
    return src.length > 400 ? null : new RegExp(src);
  } catch {
    return null;
  }
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

/** A compiled program (a NUL byte in its first 4 KiB), not a script. */
function isCompiled(p) {
  let fd;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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

const STARTUP_FILES = new Set([".zshenv", ".zshrc", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".kshrc", ".envrc", ".env", "config.fish", "environment"]);

/** A shell startup file (or .envrc/.env) given pr-rla's consent: every later shell would carry it. */
function consentInStartupFile(p, content) {
  if (!STARTUP_FILES.has(basename(p).toLowerCase()) || typeof content !== "string") return null;
  return /PR_RLA_ACCEPT_LOCK_GRANTS|PR_RLA_APPROVALS_FILE|accept-lock-grants/.test(content) ? "it would give every later shell pr-rla's consent (PR_RLA_ACCEPT_LOCK_GRANTS, PR_RLA_APPROVALS_FILE or --accept-lock-grants), which only you give" : null;
}

class Files {
  constructor(env, home, cwd) {
    this.env = env;
    this.home = home;
    this.cwd = cwd;
    this.walkBudget = { n: 20000 };
    this.customNames = new Set();
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
    for (const m of text.matchAll(/\b(?:pass|fail)\s*:\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^"'\s,}#]+))/g)) labels.add((m[1] ?? m[2] ?? m[3]).toLowerCase());
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
    for (const f of files) this.customNames.add(f);
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
    if ([...approvals].some((a) => dirname(a).toLowerCase() === p.toLowerCase())) return `${this.show(p)}, the directory of the pr-rla approvals file, which holds your consent (only you give it)`;
    if ([...approvals].some((a) => a.toLowerCase() === p.toLowerCase()) || /[\\/]pr-rla[\\/]approvals\.json$/i.test(p)) return `${this.show(p)}, the pr-rla approvals file, which holds your consent (only you give it)`;
    if (ALWAYS_NAMES.has(base)) return `${this.show(p)}, pr-rla's ${base === ".pr-rla.yml" ? "audit configuration" : "plugin lock"}`;
    const root = this.auditRootOf(dirname(p));
    if (!root) return null;
    const cfg = this.configOf(root);
    const rel = relative(root, p);
    if (RECORD_NAMES.has(base) || base.endsWith(".manifest.json") || cfg.files.has(base)) return `${this.show(p)}, an audit record`;
    if (rel.split(/[\\/]/).some((seg) => seg.toLowerCase() === "ledger-history")) return `${this.show(p)}, in the ledger's history (an audit record)`;
    if (this.isSigningKey(p)) return `${this.show(p)}, the audit's signing key`;
    if (rel.split(/[\\/]/)[0]?.toLowerCase() === ".git") return `${this.show(p)}, in the audit repo's git directory (its hooks and config run commands as you)`;
    return null;
  }

  /** The `.pr-rla` directory, which holds the signing key. */
  isKeyDir(p) {
    if (basename(p).toLowerCase() !== ".pr-rla") return false;
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  isSigningKey(p) {
    const abs = resolve(p);
    const segs = abs.split(/[\\/]/);
    if (/\.pem$/i.test(abs) && segs.slice(0, -1).some((s) => s.toLowerCase() === ".pr-rla")) return true;
    const root = this.auditRootOf(dirname(abs));
    if (!root) return false;
    const key = this.configOf(root).signingKey;
    return key === abs || key === safeRealpath(abs);
  }

  /** Whether a file name can be protected at all (so the walk calls protectedReason only for those). */
  mightBeProtected(name) {
    const n = name.toLowerCase();
    return RECORD_NAMES.has(n) || ALWAYS_NAMES.has(n) || n.endsWith(".manifest.json") || n === "ledger-history" || n === "approvals.json" || n.endsWith(".pem") || n === ".git" || this.customNames.has(n);
  }

  /**
   * Why a glob pattern may name a protected path, as "<pattern>, <what it is>", or null. It does not depend on what exists
   * now: each segment becomes a regex, and the pattern is protected when its last segment can match a protected file
   * name in a directory it can reach (`verdicts.json?l`, `regis[t]ration.json`, `*`), or the whole pattern can match the
   * approvals file or its directory (`~/.config/pr-r?a/approvals.js[o]n`, `~/.config/pr-rla/*`).
   */
  protectedGlob(pattern, cwd) {
    const absolute = pattern.startsWith("/");
    const segs = pattern.split("/").filter((x, k) => x !== "" || k === 0);
    const segRes = segs.map((sg) => (/(^|[^\\])[*?[]/.test(sg) ? globRegex(sg) : null));
    const literal = (sg) => sg.replace(/\\(.)/g, "$1");
    // 1. The approvals file, or the directory that holds it, matched segment by segment (the path need not exist).
    for (const a of this.approvalsFiles()) {
      for (const [target, what] of [[a, "the pr-rla approvals file, which holds your consent (only you give it)"], [dirname(a), "the directory of the pr-rla approvals file, which holds your consent (only you give it)"]]) {
        const parts = target.split("/").filter((x, k) => x !== "" || k === 0);
        const mine = absolute ? segs : resolve(cwd, pattern).split("/").filter((x, k) => x !== "" || k === 0);
        const re = absolute ? segRes : mine.map((sg) => (/(^|[^\\])[*?[]/.test(sg) ? globRegex(sg) : null));
        if (parts.length === mine.length && mine.every((sg, k) => (re[k] ? re[k].test(parts[k]) : literal(sg).toLowerCase() === parts[k].toLowerCase()))) return `${pattern}, ${what}`;
      }
    }
    if (segs.length === 0) return null;
    const last = segs.length - 1;
    // 2. The directories the leading segments can reach (existing ones), then the last segment against protected names there.
    let dirs = [absolute ? "/" : cwd];
    for (let k = absolute ? 1 : 0; k < last; k++) {
      const next = [];
      for (const b of dirs) {
        if (!segRes[k]) {
          next.push(join(b, literal(segs[k])));
          continue;
        }
        let names = [];
        try {
          names = readdirSync(b);
        } catch {
          continue;
        }
        for (const n of names) if (segRes[k].test(n) && (n[0] !== "." || segs[k][0] === ".")) next.push(join(b, n));
        if (next.length > 2000) break;
      }
      dirs = next;
      if (!dirs.length) return null;
    }
    const lastSeg = segs[last];
    for (const d of dirs) {
      const root = this.auditRootOf(d);
      const cfg = root ? this.configOf(root) : null;
      const names = new Set([...RECORD_NAMES, ...ALWAYS_NAMES, "approvals.json", "x.manifest.json", "x.pem", "x"]);
      if (cfg) {
        for (const f of cfg.files) names.add(f);
        names.add(basename(cfg.signingKey));
      }
      const candidates = segRes[last] ? [...names].filter((n) => segRes[last].test(n)) : [literal(lastSeg)];
      for (const n of candidates) {
        const r = this.protectedReason(join(d, n));
        if (r) return segRes[last] ? `${pattern}, which can match ${r}` : r;
      }
    }
    return null;
  }

  /** The first protected path inside a directory (a walk bounded for the whole evaluation), or null. */
  protectedInside(dir, budget = this.walkBudget) {
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
      if (this.mightBeProtected(n)) {
        const r = this.protectedReason(p);
        if (r) return r;
      }
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
    this.arrays = new Set();
    this.oldpwd = null;
    this.dirs = [];
    this.cwdUnknown = false; // after a `cd` to a computed directory
  }
  child() {
    const c = new Scope(this.cwd, new Map(this.vars), this.home);
    c.arrays = new Set(this.arrays);
    c.oldpwd = this.oldpwd;
    c.dirs = [...this.dirs];
    c.cwdUnknown = this.cwdUnknown;
    return c;
  }
}

class ShellCheck {
  constructor(ctx) {
    this.ctx = ctx; // { files, env, cwd, home }
    this.findings = [];
    this.written = new Map(); // path -> content written earlier in this command line
    this.runsPrRla = false;
    this.setsConfigHome = false;
    this.aliases = new Map();
    this.expandingAliases = new Set();
    this.links = new Map(); // link path -> what it points to, for links made earlier in this command line
    this.pkgScripts = new Map(); // package.json -> its scripts, with any `npm pkg set` earlier in the line
    this.gitAliases = new Map(); // git aliases set earlier in this command line
    this.unsetVars = new Set(); // variables `unset` earlier in this command line
    this.addedPaths = null; // paths an earlier `git add` in this line staged ("all" for -A, ., -u)
    this.prRlaPaths = new Set(); // paths made to run pr-rla earlier in this command line
    this.deadline = Date.now() + TIME_BUDGET_MS;
  }

  checkTime() {
    if (Date.now() > this.deadline) throw new GuardTimeout();
  }

  block(reason) {
    if (!this.findings.includes(reason)) this.findings.push(reason);
  }

  /** Analyse a script in a scope (the caller's, for `source`/`eval`; a copy for a subshell). */
  script(src, scope, depth = 0) {
    if (depth > MAX_DEPTH) {
      this.block(`commands nested more than ${MAX_DEPTH} deep are more than the guard reads; it blocks what it cannot read`);
      return;
    }
    this.checkTime();
    if (src.length > MAX_COMMAND) {
      this.block(`a command over ${MAX_COMMAND / 1024} KiB is more than the guard reads; it blocks what it cannot read`);
      return;
    }
    const tk = new Tokenizer(src, depth).run();
    for (const sub of tk.subs) this.script(sub, scope.child(), depth + 1);
    const items = parseItems(tk.tokens);
    const stack = [scope];
    for (const it of items) {
      const top = stack[stack.length - 1];
      if (it.open) stack.push(top.child());
      else if (it.close) {
        if (stack.length > 1) stack.pop();
      } else if (it.forVar !== undefined) this.forLoop(it, top);
      else this.simple(it.cmd, top, depth);
    }
  }

  /**
   * `for NAME in WORDS`: NAME takes, for the commands after it, the value that matters most: a word naming a
   * protected path if there is one (so `mv "$f.tmp" "$f"` is seen writing it), else the first.
   */
  forLoop(it, scope) {
    if (!it.forVar) return;
    if (it.words === null) {
      scope.vars.set(it.forVar, null);
      return;
    }
    const values = [];
    for (const a of expandWords(it.words, scope)) {
      if (a.dyn) {
        values.push(null);
        continue;
      }
      if (a.glob) values.push(...globMatches(a.pattern, scope.cwd).map((p) => relative(scope.cwd, p) || "."));
      else values.push(a.s);
    }
    const known = values.filter((v) => v !== null);
    const pick = known.find((v) => this.ctx.files.protectedReason(resolve(scope.cwd, v))) ?? known[0] ?? null;
    scope.vars.set(it.forVar, values.includes(null) && !known.some((v) => this.ctx.files.protectedReason(resolve(scope.cwd, v))) ? null : pick);
  }

  simple(cmd, scope, depth) {
    this.checkTime();
    const env = new Map();
    for (const a of cmd.assigns) {
      if (a.array) {
        const vals = expandWords(a.array, scope);
        const v = vals.some((x) => x.dyn) ? null : vals.map((x) => x.s).join(" ");
        this.assignment(a.name, { s: v }, scope, depth);
        env.set(a.name, v);
        scope.arrays.add(a.name);
        continue;
      }
      const v = a.value.parts.length === 0 ? { s: "", dyn: false } : expandWord(a.value, scope)[0] ?? { s: "", dyn: false };
      this.assignment(a.name, v, scope, depth);
      env.set(a.name, v.dyn ? null : v.s);
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
      this.writeTarget(t, scope, "a redirect writes", { content: this.textOf(args, cmd, scope) });
    }
  }

  /** What a command writes to stdout, as far as the guard can tell: echo/printf/cat text, for `> file` and `| sh`. */
  textOf(args, cmd, scope) {
    const prog = args[0]?.s ? basename(args[0].s) : null;
    if (prog === "echo") return args.slice(1).filter((a, k) => !(k === 0 && /^-[neE]+$/.test(a.s ?? ""))).map((a) => a.s ?? "").join(" ");
    if (prog === "printf") {
      const pa = args.slice(1).filter((a, k) => !(k === 0 && a.s === "--"));
      return (pa[0]?.s ?? "").replace(/\\([ntr\\])/g, (_m, c) => ({ n: "\n", t: "\t", r: "\r", "\\": "\\" })[c]).replace(/%s/g, () => "") + pa.slice(1).map((a) => a.s ?? "").join(" ");
    }
    if (prog === "find") {
      const found = this.findMatches(args.slice(1), scope ?? new Scope(this.ctx.cwd, new Map(), this.ctx.home));
      return found.complete ? found.matches.join("\n") : null;
    }
    if (prog === "cat") {
      const here = cmd?.redirs.find((r) => r.heredoc !== undefined)?.heredoc;
      if (here !== undefined) return here;
      const hs = cmd?.redirs.find((r) => r.op === "<<<");
      if (hs?.target) return wordLiteral(hs.target) ?? "";
      const texts = args.slice(1).filter((a) => !(a.s ?? "").startsWith("-")).map((a) => (a.s && !a.dyn ? (this.written.get(resolve((scope ?? this.ctx).cwd, a.s)) ?? readText(resolve((scope ?? this.ctx).cwd, a.s))) : null));
      return texts.includes(null) ? null : texts.join("\n");
    }
    const here = cmd?.redirs.find((r) => r.heredoc !== undefined)?.heredoc;
    return here ?? null;
  }

  abs(arg, scope) {
    return resolve(scope.cwd, arg.s);
  }

  /** A path, with any link this command line made earlier resolved (`ln -s ../audit /tmp/w; echo >> /tmp/w/…`). */
  linked(p) {
    for (const [link, target] of this.links) if (p === link || p.startsWith(link + sep)) return target + p.slice(link.length);
    return p;
  }

  /**
   * Check a path some command writes (or removes, moves, truncates). `dirMatters`: the command also removes or
   * moves what a directory holds (rm -r, mv, rsync --delete), so a directory holding records counts.
   */
  writeTarget(arg, scope, what, opt = {}) {
    if (!arg) return;
    if (!arg.dyn && arg.s === "") return; // an empty word names no file
    const unresolved = arg.dyn || (scope.cwdUnknown && !isAbsolute(arg.s ?? ""));
    if (unresolved) {
      const tail = basename((arg.dyn ? arg.tail : arg.s) || "").toLowerCase();
      if (tail && (RECORD_NAMES.has(tail) || ALWAYS_NAMES.has(tail) || tail.endsWith(".manifest.json") || tail === "approvals.json" || this.ctx.files.customNames.has(tail))) this.block(`${what} a path ending in ${tail} that the guard cannot resolve; it may be an audit record`);
      return;
    }
    const paths = arg.glob ? globMatches(arg.pattern, scope.cwd) : [this.linked(this.abs(arg, scope))];
    if (arg.glob) {
      // A glob is judged by what it CAN match, never only by what exists now: `verdicts.json?l`, `appr?vals.json`, `*`.
      const g = this.ctx.files.protectedGlob(arg.pattern, scope.cwd);
      if (g) this.block(`${what} ${g}`);
      else if (!paths.length) {
        const base = basename(arg.s).toLowerCase();
        if (!/[*?[]/.test(base) && (RECORD_NAMES.has(base) || ALWAYS_NAMES.has(base) || base.endsWith(".manifest.json"))) this.block(`${what} ${arg.s}, which names an audit record`);
      }
    }
    for (const p of paths) {
      const r = this.ctx.files.protectedReason(p);
      if (r) {
        this.block(`${what} ${r}`);
        continue;
      }
      if (opt.dirMatters) {
        const inside = this.ctx.files.protectedInside(p);
        if (inside) this.block(`${what} a directory holding audit records: ${inside}`);
      }
      if (opt.content !== undefined && opt.content !== null) {
        this.written.set(p, opt.content);
        const c = consentInStartupFile(p, opt.content);
        if (c) this.block(`${what} ${this.ctx.files.show(p)}: ${c}`);
      }
    }
  }

  /** A path some command reads: blocked when it is the signing key or, for `anyForm`, the directory that holds it. */
  readTarget(arg, scope, what, o = {}) {
    if (!arg) return;
    const files = this.ctx.files;
    if (arg.dyn) {
      if (o.anyForm && /\.pr-rla[\\/]/i.test(arg.raw ?? "")) this.block(`${what} a computed path in the audit's .pr-rla directory, which holds its signing key`);
      return;
    }
    if (!arg.s) return;
    const forms = new Set([arg.s]);
    if (o.anyForm) {
      const eq = arg.s.indexOf("=");
      if (eq >= 0) forms.add(arg.s.slice(eq + 1));
      for (const f of [...forms]) {
        if (f.startsWith("@")) forms.add(f.slice(1));
        const c = f.indexOf(":");
        if (c > 0 && /\.pr-rla/i.test(f.slice(c + 1))) forms.add(f.slice(c + 1));
      }
    }
    for (const f of forms) {
      if (!f || (f === arg.s && f.startsWith("-"))) continue;
      const paths = arg.glob && f === arg.s ? globMatches(arg.pattern, scope.cwd) : [this.linked(resolve(scope.cwd, f))];
      for (const p of paths) {
        if (files.isSigningKey(p)) this.block(`${what} ${files.show(p)}, the audit's signing key`);
        else if (o.anyForm && files.isKeyDir(p)) this.block(`${what} ${files.show(p)}, the directory that holds the audit's signing key`);
      }
    }
  }

  /** An awk program: its system() and pipe commands, and the files its print and printf redirect to. */
  awk(rest, scope, depth) {
    let program = null;
    for (let j = 0; j < rest.length; j++) {
      const s = rest[j].s ?? "";
      if (s === "-f") {
        program = this.runText(rest[++j], scope, "awk");
        break;
      }
      if (s === "-v" || s === "-F") {
        j++;
        continue;
      }
      if (s.startsWith("-")) continue;
      if (rest[j].dyn) return void this.code("", rest[j]);
      program = s;
      break;
    }
    if (program === null) return;
    this.code(program, undefined, { scope, depth });
    for (const m of program.matchAll(/\bprintf?\b[^;}\n]{0,400}?>{1,2}\s*"([^"]+)"/g)) this.writeTarget({ s: m[1], dyn: false, glob: false, tail: m[1] }, scope, "awk writes");
  }

  /** A script file's text: what this command line wrote to it, else what is on disk. */
  scriptText(arg, scope) {
    if (!arg?.s) return null;
    const p = this.abs(arg, scope);
    return this.written.get(p) ?? readText(p);
  }

  /**
   * The text of a script a command runs (up to the 1 MiB the guard reads of code). In an audit repo, a script it
   * cannot read (missing when the line is checked, unreadable, or larger) is blocked: it blocks code it cannot read.
   * A compiled program is not code the guard reads, here or anywhere (a documented limit).
   */
  runText(arg, scope, prog) {
    if (!arg?.s) return null;
    const p = this.abs(arg, scope);
    const text = this.written.get(p) ?? readText(p, MAX_CODE);
    if (text !== null) return text;
    const files = this.ctx.files;
    if (!files.auditRootOf(scope.cwd) && !files.auditRootOf(dirname(p))) return null;
    if (isCompiled(p)) return null;
    this.block(`${prog} runs ${files.show(p)}, which the guard cannot read (missing when the line is checked, unreadable, or over ${MAX_CODE / 1024 / 1024} MiB); in an audit repo it blocks code it cannot read`);
    return null;
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
    let name = head.s;
    if (/^=[\w./-]+$/.test(name)) name = name.slice(1); // zsh =cmd: the path of cmd
    // A link made earlier in this line that stands for pr-rla, or that points elsewhere.
    if (name.includes("/") && this.prRlaPaths.has(this.abs({ s: name }, scope))) return this.prRla(args.slice(1), info, true);
    const prog = basename(name);

    // Aliases defined earlier in the line.
    if (this.aliases.has(name) && !this.expandingAliases.has(name)) {
      // As in bash and zsh, an alias is not expanded again inside its own expansion (`alias ls='ls -G'`).
      this.expandingAliases.add(name);
      try {
        this.script(`${this.aliases.get(name)} ${args.slice(1).map(shq).join(" ")}`, scope, depth + 1);
      } finally {
        this.expandingAliases.delete(name);
      }
      return;
    }

    // Reading the signing key, whatever reads it (a path, `@path`, `--opt=path`, `REV:path`, or the key's directory).
    if (!["ls", "stat", "test", "[", "file", "rm", "rmdir", "unlink", "trash", "shred"].includes(prog)) for (const a of args.slice(1)) this.readTarget(a, scope, `${prog} reads`, { anyForm: true });

    const rest = args.slice(1);
    switch (prog) {
      case "cd":
      case "pushd": {
        const target = rest.find((a) => a.dyn || !/^-[LPe@]+$/.test(a.s ?? ""));
        const prev = scope.cwd;
        if (!target) scope.cwd = scope.home;
        else if (target.dyn) scope.cwdUnknown = true;
        else if (target.s === "-") {
          if (scope.oldpwd) scope.cwd = scope.oldpwd;
          else scope.cwdUnknown = true;
        } else {
          scope.cwd = resolve(scope.cwd, target.s);
          scope.cwdUnknown = false;
        }
        if (prog === "pushd") scope.dirs.push(prev);
        scope.oldpwd = prev;
        return;
      }
      case "popd": {
        const d = scope.dirs.pop();
        scope.oldpwd = scope.cwd;
        if (d) scope.cwd = d;
        else scope.cwdUnknown = true;
        return;
      }
      case "trap":
        if (rest[0]?.s && !rest[0].s.startsWith("-")) this.script(rest[0].s, scope.child(), depth + 1);
        else if (rest[0]?.dyn && codeFindings(rest[0].raw ?? "", { records: true }).length) this.block("trap runs a computed command that looks like a pr-rla write");
        return;
      case "nocorrect":
      case "noglob":
      case "-":
        return this.command(rest, scope, depth, info);
      case "export":
      case "declare":
      case "typeset":
      case "local":
      case "readonly":
        for (const a of rest) {
          if (!a.s || a.s.startsWith("-")) continue;
          const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=(.*))?$/s.exec(a.s);
          if (!m || m[2] === undefined) continue; // `export -n X`, `declare -p X`: no value set
          this.assignment(m[1], { s: m[3] }, scope, depth);
          scope.vars.set(m[1], m[3]);
        }
        return;
      case "unset":
        for (const a of rest) {
          if (!a.s) continue;
          scope.vars.delete(a.s);
          this.unsetVars.add(a.s);
        }
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
        if (rest[0]?.dyn) {
          if (codeFindings(rest[0].raw ?? "", { records: true }).length) this.block(`${prog} runs a script built by a command the guard cannot fully read, and it looks like a pr-rla write`);
          return;
        }
        const text = STDIN_FILES.has(rest[0]?.s ?? "") ? this.stdinText(info, scope) : this.runText(rest[0], scope, prog);
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
      case "timeout":
      case "gtimeout": {
        const after = skipOpts(rest, "sk");
        return this.command(after.slice(1), scope, depth, info);
      }
      case "flock": {
        const after = skipOpts(rest, "wE");
        const c = after.findIndex((a) => a.s === "-c" || a.s === "--command");
        if (c >= 0) return this.script(after[c + 1]?.s ?? "", scope.child(), depth + 1);
        return this.command(after.slice(1), scope, depth, info);
      }
      case "printf":
        if (rest[0]?.s === "-v" && rest[1]?.s) scope.vars.set(rest[1].s, rest[2] && !rest[2].dyn ? rest[2].s.replace(/\\n/g, "\n") : null);
        return;
      case "awk":
      case "gawk":
      case "mawk":
      case "nawk":
        return this.awk(rest, scope, depth);
      case "sort":
      case "gsort": {
        for (let j = 0; j < rest.length; j++) {
          const s = rest[j].s ?? "";
          if (s === "-o" || s === "--output") this.writeTarget(rest[++j], scope, "sort -o writes");
          else if (/^-o./.test(s)) this.writeTarget({ ...rest[j], s: s.slice(2), tail: s.slice(2) }, scope, "sort -o writes");
          else if (s.startsWith("--output=")) this.writeTarget({ ...rest[j], s: s.slice(9), tail: s.slice(9) }, scope, "sort -o writes");
        }
        return;
      }
      case "uniq":
      case "xxd": {
        const pos = nonOptions(rest, prog === "uniq" ? "fs" : "cglosC");
        if (pos[1]) this.writeTarget(pos[1], scope, `${prog} writes its output to`);
        return;
      }
      case "base64":
      case "gbase64": {
        for (let j = 0; j < rest.length; j++) if (rest[j].s === "-o" || rest[j].s === "--output") this.writeTarget(rest[++j], scope, "base64 -o writes");
        return;
      }
      case "yq":
        if (rest.some((a) => /^(-i|--inplace|-[a-zA-Z]*i)$/.test(a.s ?? ""))) for (const a of nonOptions(rest, "").slice(1)) this.writeTarget(a, scope, "yq -i edits");
        return;
      case "link":
        return this.ln(rest, scope);
      case "apply_patch": {
        const text = rest.length && rest[0].s !== null ? rest.map((a) => a.s ?? "").join(" ") : this.stdinText(info, scope);
        if (text === null || rest.some((a) => a.dyn)) {
          if (this.roots(scope).length) this.block("apply_patch with a patch the guard cannot read, in an audit repo");
          return;
        }
        for (const path of diffPaths(text)) this.writeTarget({ s: path, dyn: false, glob: false, tail: path }, scope, "apply_patch edits");
        return;
      }
      case "xargs":
        return this.xargs(rest, scope, depth, info);
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
        return this.interpreter(prog, rest, scope, depth, info);
      case "pr-rla":
        return this.prRla(rest, info, true);
      case "pr-rla-mcp":
        return;
      case "ssh-keygen":
        return this.sshKeygen(rest);
      case "gh":
        return this.gh(rest, scope, depth, info);
      case "glab":
        return this.glab(rest, scope, depth, info);
      case "curl":
        return this.curl(rest, scope, info);
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
        for (const a of nonOptions(rest, prog === "shred" ? "nsu" : "")) this.writeTarget(a, scope, `${prog} removes`, { dirMatters: true });
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
        return this.sed(prog, rest, scope, depth);
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
        const after = skipOpts(rest, "tTFIc");
        if (after[0]) this.writeTarget(after[0], scope, "script writes its transcript to");
        if (c >= 0) return this.script(rest[c + 1]?.s ?? "", scope.child(), depth + 1);
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
      case "task":
        return this.make(prog, rest, scope, depth);
      case "tar":
      case "gtar":
      case "bsdtar":
      case "unzip":
        return this.extract(prog, rest, scope);
      default:
        break;
    }
    if (/^(set-content|add-content|out-file|clear-content|remove-item|move-item|copy-item|new-item|rename-item)$/i.test(prog)) return this.powershellCmdlet(prog, rest, scope);
    if (!NON_RUNNERS.has(prog)) {
      // A program the guard does not know that is handed pr-rla as an argument (`direnv exec`, `nix develop -c`, …).
      const j = rest.findIndex((a) => a.s !== null && (basename(a.s) === "pr-rla" || packageName(a.s) === "pr-rla"));
      if (j >= 0) this.prRla(rest.slice(j + 1), info, false);
      // …or a command line as one argument (`su -c '…'`, `tmux new-window '…'`).
      for (const a of rest) if (a.s && /\s/.test(a.s.trim()) && !/^-/.test(a.s)) this.script(a.s, scope.child(), depth + 1);
      // In an audit repo, a program not known to only read its files is not handed a record.
      if (!READERS.has(prog)) for (const a of rest) this.unknownWriter(prog, a, scope);
    }
    // A script this line wrote, or one an in-line PATH points at, run by name.
    if (!name.includes("/")) {
      const text = this.scriptOnPath(name, scope, info);
      if (text !== null) return this.codeOrShell(text, scope, depth, true);
    }
    // A script a known CLI path names (dist/cli.js, src/cli.ts) run directly.
    if (/^cli\.(m|c)?[jt]s$/.test(prog)) return this.prRla(rest, info, false);
    // Running an executable script file: read it.
    if (name.includes("/")) {
      const text = this.runText(head, scope, prog);
      if (text !== null) this.codeOrShell(text, scope, depth, true);
    }
  }

  /** The program's name is computed: its arguments may be pr-rla's, or a script for a computed shell. */
  /** An argument of a program the guard does not know: blocked when it names a record (as a path, `--opt=path` or `@path`). */
  unknownWriter(prog, a, scope) {
    if (a.dyn || !a.s) return;
    const forms = [a.s];
    const eq = a.s.indexOf("=");
    if (eq > 0 && a.s.startsWith("-")) forms.push(a.s.slice(eq + 1));
    if (a.s.startsWith("@")) forms.push(a.s.slice(1));
    for (const f of forms) {
      if (!f || (f === a.s && f.startsWith("-"))) continue;
      // Many programs expand a quoted glob themselves (prettier "audit/**/*.json").
      const globbed = (a.glob && f === a.s) || /[*?[]/.test(f);
      if (globbed) {
        const g = this.ctx.files.protectedGlob(a.glob && f === a.s ? a.pattern : f, scope.cwd);
        if (g) {
          this.block(`${prog} is given ${g}, and the guard does not know ${prog} to only read the files it is given`);
          return;
        }
      }
      const paths = globbed ? globMatches(a.glob && f === a.s ? a.pattern : f, scope.cwd) : [this.linked(resolve(scope.cwd, f))];
      for (const p of paths) {
        const r = this.ctx.files.protectedReason(p);
        if (r) {
          this.block(`${prog} is given ${r}, and the guard does not know ${prog} to only read the files it is given`);
          return;
        }
      }
    }
  }

  /** The text of a script run by name: one this line wrote (to any directory), or one in a directory an in-line PATH adds. */
  scriptOnPath(name, scope, info) {
    for (const [p, text] of this.written) if (basename(p) === name) return text;
    const path = info?.env?.get("PATH") ?? (scope.vars.has("PATH") ? scope.vars.get("PATH") : null);
    if (!path) return null;
    const original = new Set(String(this.ctx.env.PATH ?? "").split(":"));
    for (const dir of path.split(":")) {
      if (!dir || original.has(dir)) continue;
      const text = readText(join(resolve(scope.cwd, dir), name));
      if (text !== null) return text;
    }
    return null;
  }

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
    const unset = new Set(info.unset ?? []);
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
      if (s === "-i" || s === "--ignore-environment") {
        unset.add("*");
        continue;
      }
      if (s === "-0" || s === "--null" || s === "-v" || s === "--debug") continue;
      if (s === "-u" || s === "--unset") {
        unset.add(rest[++k]?.s ?? "");
        continue;
      }
      if (s.startsWith("--unset=") || /^-u./.test(s)) {
        unset.add(s.replace(/^--unset=|^-u/, ""));
        continue;
      }
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
    this.command(rest.slice(k), sub, depth, { ...info, unset });
  }

  /** The files a find command would match (its -name, -iname, -path and -type tests, under its start paths), bounded. */
  findMatches(rest, scope) {
    const firstExpr = rest.findIndex((x) => x.dyn || /^[-(!]/.test(x.s ?? "-"));
    const starts = (firstExpr < 0 ? rest : rest.slice(0, firstExpr)).filter((x) => x.s);
    const roots = starts.length ? starts.map((x) => this.linked(resolve(scope.cwd, x.s))) : [scope.cwd];
    const tests = [];
    let unknownTest = false;
    let maxdepth = Infinity;
    const or = rest.some((x) => x.s === "-o" || x.s === "-or");
    for (let k = firstExpr < 0 ? rest.length : firstExpr; k < rest.length; k++) {
      const t = rest[k].s;
      if (["-name", "-iname", "-path", "-ipath", "-wholename", "-regex"].includes(t ?? "")) {
        const v = rest[++k];
        if (!v || v.s === null) unknownTest = true;
        else tests.push(t === "-regex" ? { path: true, re: safeRegex(v.s) } : { path: /path|wholename/.test(t), re: t.includes("path") || t === "-wholename" ? pathGlobRegex(v.s) : globRegex(v.s) });
      } else if (t === "-type") tests.push({ type: rest[++k]?.s });
      else if (t === "-maxdepth") maxdepth = Number(rest[++k]?.s ?? "Infinity");
      else if (["-exec", "-execdir", "-ok", "-okdir"].includes(t ?? "")) {
        while (k < rest.length && rest[k].s !== ";" && rest[k].s !== "+") k++;
      }
    }
    const matches = [];
    let complete = true;
    let budget = 20000;
    const test = (p, isDir) => {
      const results = tests.map((x) => (x.type ? (x.type === "d" ? isDir : x.type === "f" ? !isDir : true) : x.re === null ? true : x.re.test(x.path ? p : basename(p))));
      return !results.length || (or ? results.some(Boolean) : results.every(Boolean));
    };
    const walk = (p, d) => {
      if (--budget < 0) {
        complete = false;
        return;
      }
      let st;
      try {
        st = lstatSync(p);
      } catch {
        return;
      }
      if (test(p, st.isDirectory())) matches.push(p);
      if (st.isDirectory() && d < maxdepth && basename(p) !== ".git") {
        let names = [];
        try {
          names = readdirSync(p);
        } catch {
          return;
        }
        for (const n of names) walk(join(p, n), d + 1);
      }
    };
    for (const r of roots) walk(r, 0);
    return { matches, complete: complete && !unknownTest, roots };
  }

  findExec(rest, scope, depth, info) {
    const found = this.findMatches(rest, scope);
    const protectedFirst = [...found.matches.filter((m) => this.ctx.files.protectedReason(m)), ...found.matches].slice(0, 3);
    for (let k = 0; k < rest.length; k++) {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(rest[k].s ?? "")) continue;
      let e = k + 1;
      while (e < rest.length && rest[e].s !== ";" && rest[e].s !== "+") e++;
      const cmd = rest.slice(k + 1, e);
      if (!cmd.some((x) => (x.s ?? "").includes("{}"))) this.command(cmd, scope, depth, info);
      else for (const m of protectedFirst.length ? protectedFirst : [join(scope.cwd, "x")]) this.command(cmd.map((x) => (x.s?.includes("{}") ? { ...x, s: x.s.replaceAll("{}", m), tail: m, glob: false } : x)), scope, depth, info);
      k = e;
    }
    if (rest.some((x) => x.s === "-delete")) {
      const hit = found.matches.map((m) => this.ctx.files.protectedReason(m)).find(Boolean);
      if (hit) this.block(`find -delete removes ${hit}`);
      else if (!found.complete && found.roots.some((r) => this.ctx.files.auditRootOf(r))) this.block("find -delete in an audit repo over more files than the guard can check, or with a test it cannot read; it may remove audit records");
    }
  }

  /** xargs: the command, given the words its input holds when the guard can read them (find's matches, echo's text). */
  xargs(rest, scope, depth, info) {
    let k = 0;
    let repl = null;
    let nul = false;
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null || !s.startsWith("-") || s === "-") break;
      if (s === "--") {
        k++;
        break;
      }
      if (s === "-I") repl = rest[++k]?.s ?? "{}";
      else if (/^-I./.test(s)) repl = s.slice(2);
      else if (s === "-i" || s === "--replace") repl = "{}";
      else if (/^-i./.test(s) || s.startsWith("--replace=")) repl = s.replace(/^-i|^--replace=/, "");
      else if (s === "-0" || s === "--null") nul = true;
      else if (["-L", "-n", "-P", "-d", "-E", "-a", "-s"].includes(s)) k++;
    }
    const cmd = rest.slice(k);
    if (!cmd.length) return;
    const text = this.stdinText(info, scope);
    if (text === null) return this.command(cmd, scope, depth, { ...info, viaXargs: true });
    const words = text.split(nul ? /[\0\n]+/ : repl !== null ? /\n+/ : /\s+/).map((w) => w.trim()).filter(Boolean).slice(0, 200);
    const lit = (w) => ({ s: w, dyn: false, glob: false, tail: w, pattern: w, quoted: true, raw: w });
    if (repl !== null) {
      const picks = [...words.filter((w) => this.ctx.files.protectedReason(resolve(scope.cwd, w))), ...words].slice(0, 3);
      for (const w of picks) {
        const replaced = cmd.map((x) => (x.s?.includes(repl) ? { ...x, s: x.s.replaceAll(repl, w), glob: false } : x));
        // `xargs -I{} sh -c '{}'`: the input is the command
        this.command(replaced, scope, depth, info);
      }
      return;
    }
    this.command([...cmd, ...words.map(lit)], scope, depth, info);
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
    if (prog === "bun" && rest.some((a) => ["-e", "--eval", "-p", "--print"].includes(a.s ?? ""))) return this.nodeLike("bun", rest, scope, depth, info);
    // Global options first (npm --silent, --prefix DIR, -w NAME).
    let k = 0;
    let dir = scope.cwd;
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null || !s.startsWith("-")) break;
      if (["--prefix", "-C", "--dir", "--cwd", "-w", "--workspace", "--filter", "-F", "--loglevel", "--userconfig"].includes(s)) {
        if (s === "--prefix" || s === "-C" || s === "--dir" || s === "--cwd") dir = resolve(scope.cwd, rest[k + 1]?.s ?? ".");
        k++;
      } else if (/^--(prefix|dir|cwd)=/.test(s)) dir = resolve(scope.cwd, s.replace(/^--(prefix|dir|cwd)=/, ""));
    }
    rest = rest.slice(k);
    const sub = rest[0]?.s;
    if (prog === "bun" && ["-e", "--eval", "-p", "--print"].includes(sub ?? "")) return this.nodeLike("bun", rest, scope, depth, info);
    if (sub === "exec" || sub === "x" || sub === "dlx") return this.packageRunner(rest.slice(1), scope, depth, info);
    const pkgFile = findUp(dir, "package.json");
    if (!this.pkgScripts.has(pkgFile ?? "")) {
      let scripts = {};
      try {
        scripts = JSON.parse((pkgFile ? readText(pkgFile) : null) ?? "{}").scripts ?? {};
      } catch {
        scripts = {};
      }
      this.pkgScripts.set(pkgFile ?? "", { ...scripts });
    }
    const scripts = this.pkgScripts.get(pkgFile ?? "");
    const run = (name) => {
      for (const n of [`pre${name}`, name, `post${name}`]) if (typeof scripts[n] === "string") this.script(scripts[n], Object.assign(scope.child(), { cwd: pkgFile ? dirname(pkgFile) : dir }), depth + 1);
    };
    // npm pkg set scripts.NAME=VALUE: the script is checked now, and kept for a later `npm run NAME` in this line.
    if (sub === "pkg" && rest[1]?.s === "set") {
      for (const a of rest.slice(2)) {
        const m = /^scripts\.([^=]+)=(.*)$/s.exec(a.s ?? "");
        if (!m) continue;
        scripts[m[1]] = m[2];
        this.script(m[2], scope.child(), depth + 1);
      }
      return;
    }
    if (["install", "i", "ci", "add", "rebuild", "install-test", "it", "link"].includes(sub ?? "") || (sub === undefined && (prog === "yarn" || prog === "pnpm" || prog === "bun"))) {
      for (const n of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]) if (typeof scripts[n] === "string") this.script(scripts[n], scope.child(), depth + 1);
      if (sub === "install-test" || sub === "it") run("test");
      return;
    }
    let script = null;
    if (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn") script = rest.slice(1).find((a) => !(a.s ?? "").startsWith("-"))?.s ?? null;
    else if (["test", "t", "tst", "start", "stop", "restart"].includes(sub ?? "")) script = sub === "t" || sub === "tst" ? "test" : sub;
    else if ((prog === "yarn" || prog === "pnpm" || prog === "bun") && sub && !sub.startsWith("-") && !["remove", "update", "upgrade", "init", "create", "publish", "why", "list", "ls", "outdated", "audit"].includes(sub)) script = sub;
    if (!script) return;
    if (typeof scripts[script] !== "string") {
      // `yarn pr-rla …`, `pnpm pr-rla …`: no script by that name, so the package manager runs the bin.
      if (prog !== "npm" && sub === script) this.command(rest, scope, depth, info);
      return;
    }
    run(script);
  }

  /** make, just, task: the recipes the requested targets (and their prerequisites) would run, read as shell. */
  make(prog, rest, scope, depth) {
    let dir = scope.cwd;
    let file = null;
    const evals = [];
    const targets = [];
    for (let j = 0; j < rest.length; j++) {
      const s = rest[j].s ?? "";
      if (s === "-C" || s === "--directory") dir = resolve(dir, rest[++j]?.s ?? ".");
      else if (s === "-f" || s === "--file" || s === "--makefile" || s === "--justfile" || s === "--taskfile") file = resolve(dir, rest[++j]?.s ?? "");
      else if (s.startsWith("--eval=")) evals.push(s.slice(7));
      else if (s === "--eval") evals.push(rest[++j]?.s ?? "");
      else if (/^-[jlo]$/.test(s)) j++;
      else if (!s.startsWith("-") && !s.includes("=")) targets.push(s);
    }
    const names = prog === "just" ? ["justfile", "Justfile", ".justfile"] : prog === "task" ? ["Taskfile.yml", "Taskfile.yaml"] : ["GNUmakefile", "makefile", "Makefile"];
    const read = (p) => this.written.get(p) ?? readText(p);
    let text = file ? read(file) : (names.map((n) => read(join(dir, n))).find((t) => t !== null) ?? null);
    if (evals.length) text = `${evals.join("\n")}\n${text ?? ""}`;
    if (text === null) return;
    const mscope = Object.assign(scope.child(), { cwd: dir });
    if (prog === "task") {
      for (const f of codeFindings(text, { records: false })) this.block(`${prog} would run a task with ${f.replace(/^code that /, "")}`);
      for (const m of text.matchAll(/^\s*-\s*(?:cmd:\s*)?(.+)$/gm)) this.script(unquoteSimple(m[1]), mscope.child(), depth + 1);
      return;
    }
    const rules = parseRecipes(text, prog === "just");
    const wanted = targets.length ? targets : rules.first ? [rules.first] : [];
    const seen = new Set();
    const visit = (t) => {
      if (seen.has(t) || seen.size > 200) return;
      seen.add(t);
      const rule = rules.map.get(t);
      if (!rule) return;
      for (const pre of rule.prereqs) visit(pre);
      for (const line of rule.recipe) this.script(line.replace(/^[@+-]+/, "").replace(/\$\$/g, "$"), mscope.child(), depth + 1);
    };
    for (const t of wanted) visit(t);
    if (!wanted.length || [...wanted].some((t) => !rules.map.has(t))) {
      // A target the guard cannot find (a pattern rule, an include): fall back to the whole file's text.
      for (const f of codeFindings(text, { records: false })) this.block(`${prog} would run a recipe with ${f.replace(/^code that /, "")}`);
    }
  }

  /** Whether any argument names a protected path (a script given a record may write it through argv). */
  givesRecord(args, scope) {
    return args.some((x) => x.s && !x.dyn && !x.s.startsWith("-") && this.ctx.files.protectedReason(this.linked(resolve(scope.cwd, x.s))));
  }

  nodeLike(prog, rest, scope, depth, info) {
    const o = { scope, depth };
    let k = 0;
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null) break;
      if (["-e", "--eval", "-p", "--print"].includes(s) || /^-[a-zA-Z]*[ep]$/.test(s)) {
        return void this.code(rest[k + 1]?.s ?? "", rest[k + 1], o);
      }
      if (/^--(eval|print)=/.test(s)) return void this.code(s.replace(/^--(eval|print)=/, ""), undefined, o);
      if (s === "--env-file" || s.startsWith("--env-file=")) {
        const f = s === "--env-file" ? rest[++k] : { ...rest[k], s: s.slice(11) };
        const text = f?.s ? this.scriptText(f, scope) : null;
        if (text !== null && /PR_RLA_(ACCEPT_LOCK_GRANTS|APPROVALS_FILE)\s*=/.test(text)) this.block(`${prog} --env-file ${f.s} sets pr-rla's consent (PR_RLA_ACCEPT_LOCK_GRANTS or PR_RLA_APPROVALS_FILE), which only you give`);
        continue;
      }
      if (["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--input-type"].includes(s)) {
        k++;
        continue;
      }
      if (prog === "deno" && ["run", "eval"].includes(s)) {
        if (s === "eval") return void this.code(rest[k + 1]?.s ?? "", rest[k + 1], o);
        continue;
      }
      if (s === "--") {
        k++;
        break;
      }
      if (s.startsWith("-") && s !== "-") continue;
      break;
    }
    const script = rest[k];
    // No script, or "-": the program reads it from stdin.
    if (!script || STDIN_FILES.has(script.s ?? "")) {
      const text = this.stdinText(info, scope);
      if (text !== null) this.code(text, undefined, o);
      return;
    }
    if (script.dyn) return this.dynamicCommand(rest.slice(k), scope, depth);
    const b = basename(script.s);
    if (/^cli\.(m|c)?[jt]s$/.test(b) || /^pr-rla(\.(m|c)?js)?$/.test(b)) return this.prRla(rest.slice(k + 1), info, /pr-rla/.test(script.s) || /^pr-rla/.test(b));
    const text = this.runText(script, scope, prog);
    if (text !== null) this.code(text, undefined, { ...o, file: true, recordArgs: this.givesRecord(rest.slice(k + 1), scope) });
  }

  interpreter(prog, rest, scope, depth, info) {
    const o = { scope, depth };
    const flag = { python: ["-c"], python3: ["-c"], perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"], osascript: ["-e"] }[prog] ?? [];
    const letters = flag.map((f) => f.slice(1)).join("");
    for (let k = 0; k < rest.length; k++) {
      const s = rest[k].s ?? "";
      if (flag.includes(s) || (letters && new RegExp(`^-[a-zA-Z]*[${letters}]$`).test(s))) {
        this.code(rest[k + 1]?.s ?? "", rest[k + 1], o);
        if (prog === "perl" || prog === "ruby") this.perlInPlace(rest, scope);
        return;
      }
      const attached = flag.find((f) => s.startsWith(f) && s.length > f.length && !s.startsWith("--"));
      if (attached) return void this.code(s.slice(attached.length), undefined, o);
      if ((prog === "python" || prog === "python3") && s === "-m") {
        const mod = rest[k + 1]?.s ?? "";
        const pos = nonOptions(rest.slice(k + 2), "");
        if (mod === "json.tool" && pos[1]) this.writeTarget(pos[1], scope, "python -m json.tool writes");
        else if (mod !== "json.tool") for (const x of rest.slice(k + 2)) this.unknownWriter(`python -m ${mod}`, x, scope);
        return;
      }
      if (s === "-" || (s.startsWith("-") && s !== "-")) {
        if (s !== "-") continue;
      }
      if (STDIN_FILES.has(s)) {
        const text = this.stdinText(info, scope);
        if (text !== null) this.code(text, undefined, o);
        return;
      }
      const text = this.runText(rest[k], scope, prog);
      if (text !== null) {
        if (this.givesRecord(rest.slice(k + 1), scope)) this.code(text, undefined, { ...o, file: true, recordArgs: true });
        else this.codeOrShell(text, scope, depth, true);
      }
      return;
    }
    // No script: the interpreter reads its program from stdin (`python3 <<'PY'`).
    const text = this.stdinText(info, scope);
    if (text !== null) this.code(text, undefined, o);
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
    else this.code(text, undefined, { file, scope, depth });
  }

  /**
   * Code in another language. A script file (as opposed to `-e`/`-c` code) is checked for writes to records only
   * inside an audit repo, or when a record is among its arguments: elsewhere, a program that mentions record names
   * (pr-rla's own tests, say) is not the risk. The string literals that hold a command line (os.system,
   * execSync, subprocess, awk's system) are read as shell commands too.
   */
  code(text, arg, o = {}) {
    if (arg?.dyn) {
      if (codeFindings(arg.raw ?? arg.tail ?? "", { records: true }).length) this.block("code the guard cannot fully read (it is computed) looks like a pr-rla write");
      return;
    }
    const scope = o.scope ?? new Scope(this.ctx.cwd, new Map(), this.ctx.home);
    const records = !o.file || o.recordArgs || Boolean(this.ctx.files.auditRootOf(scope.cwd));
    for (const f of codeFindings(text, { records })) this.block(f);
    if (o.recordArgs && WRITE_TO_VARIABLE.test(text)) this.block("a program given an audit record as an argument writes to a path it is handed; it may write the record");
    for (const lit of commandLiterals(text)) this.script(lit, scope.child(), (o.depth ?? 0) + 1);
  }

  shell(prog, rest, scope, depth, info) {
    let k = 0;
    let script = null;
    let file = null;
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null) {
        file = rest[k];
        break;
      }
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
    if (file && !STDIN_FILES.has(file.s ?? "")) {
      if (file.dyn) {
        // `bash <(echo …)`, `source =(…)`: a script the guard can only read in the source of the line.
        if (codeFindings(file.raw ?? "", { records: true }).length) this.block(`${prog} runs a script built by a command the guard cannot fully read, and it looks like a pr-rla write`);
        return;
      }
      const text = this.runText(file, scope, prog);
      if (text !== null) this.script(text, scope.child(), depth + 1);
      return;
    }
    // The shell reads its script from stdin: a heredoc, a here-string, a file, or what the pipeline feeds it.
    const text = this.stdinText(info, scope);
    if (text !== null) this.script(text, scope.child(), depth + 1);
    else if (info.cmd?.pipeline && info.cmd.stage > 0 && this.roots(scope).length) this.block(`${prog} runs a script piped in from a command the guard cannot read, in an audit repo; it may write audit records`);
  }

  /** What a command reads on stdin, as far as the guard can tell: heredocs, here-strings, a `<` file, the pipeline's earlier stages. Null when unknown. */
  stdinText(info, scope) {
    const cmd = info?.cmd;
    const parts = [];
    let unknown = false;
    for (const r of cmd?.redirs ?? []) {
      if (r.heredoc !== undefined) parts.push(r.heredoc);
      if (r.op === "<<<" && r.target) parts.push(expandWord(r.target, scope)[0]?.s ?? "");
      if (r.op === "<" && r.target) {
        const t = expandWord(r.target, scope)[0];
        const text = t && !t.dyn ? this.scriptText(t, scope) : null;
        if (text !== null) parts.push(text);
        else unknown = true;
      }
    }
    if (cmd?.pipeline && cmd.stage > 0 && !parts.length) {
      // Only the stage just before this one feeds it (`echo … | base64 -d | sh` runs base64's output).
      const up = cmd.pipeline[cmd.stage - 1];
      const t = this.textOf(expandWords(up.words, scope), up, scope);
      if (t !== null) parts.push(t);
      else unknown = true;
    }
    return parts.length && !unknown ? parts.join("\n") : null;
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
        const text = this.runText(rest[k + 1], scope, "PowerShell");
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
    for (const t of p === "copy-item" ? targets.slice(-1) : targets) this.writeTarget(t, scope, what, { dirMatters: p.startsWith("remove") || p.startsWith("move") });
  }

  /** sed: -i edits its files; a `w FILE` command or flag writes FILE; an `e COMMAND` runs COMMAND. */
  sed(prog, rest, scope, depth) {
    const scripts = [];
    const files = [];
    let inPlace = false;
    let scriptGiven = false;
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      const s = a.s ?? "";
      if (a.s === null) {
        if (scriptGiven || scripts.length) files.push(a);
        else scripts.push(null);
        continue;
      }
      if (s === "-e" || s === "--expression") {
        scripts.push(rest[++k]?.s ?? null);
        scriptGiven = true;
        continue;
      }
      if (s.startsWith("--expression=")) {
        scripts.push(s.slice(13));
        scriptGiven = true;
        continue;
      }
      if (s === "-f" || s === "--file") {
        scripts.push(this.runText(rest[++k], scope, prog));
        scriptGiven = true;
        continue;
      }
      if (s === "-i" || s === "--in-place") {
        inPlace = true;
        // BSD/macOS sed takes the backup suffix as the next word, often '' (empty).
        if (rest[k + 1]?.s === "") k++;
        continue;
      }
      if (/^(-i\S+|--in-place=.*)$/.test(s)) {
        inPlace = true;
        continue;
      }
      if (/^-[a-zA-Z]+$/.test(s)) {
        if (s.includes("i")) inPlace = true;
        if (/[ef]$/.test(s)) {
          const v = rest[++k];
          scripts.push(s.endsWith("f") ? this.runText(v, scope, prog) : (v?.s ?? null));
          scriptGiven = true;
        }
        continue;
      }
      if (s.startsWith("-")) continue;
      if (!scriptGiven && !scripts.length) scripts.push(s);
      else files.push(a);
    }
    if (inPlace) for (const f of files) this.writeTarget(f, scope, `${prog} -i edits`);
    for (const text of scripts) {
      if (text === null) {
        if (this.roots(scope).length) this.block(`${prog} with a computed script, in an audit repo: it may write audit records (a w command)`);
        continue;
      }
      for (const m of text.matchAll(/(?:^|[;\n{}]|\/[a-zA-Z0-9]*)\s*\d*\s*[wW]\s+([^;\n}]+)/g)) {
        const path = m[1].trim();
        if (path && path !== "/dev/stdout" && path !== "/dev/stderr") this.writeTarget({ s: path, dyn: false, glob: false, tail: path }, scope, `${prog}'s w command writes`);
      }
      for (const m of text.matchAll(/(?:^|[;\n])\s*\d*\s*e\s+([^;\n]+)/g)) this.script(m[1], scope.child(), depth + 1);
    }
  }

  copyLike(prog, rest, scope, isMove) {
    const valueShort = prog.endsWith("install") ? "tmogS" : "tS";
    let targetDir = null;
    const pos = [];
    let recursive = false;
    let links = false;
    for (let k = 0; k < rest.length; k++) {
      const s = rest[k].s ?? "";
      if (rest[k].s === null) {
        pos.push(rest[k]);
        continue;
      }
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
        if (!prog.endsWith("install") && /[ls]/.test(s)) links = true;
        const last = s[s.length - 1];
        if (valueShort.includes(last) && s.length === 2) k++;
        continue;
      }
      if (s.startsWith("--")) {
        if (s === "--recursive" || s === "--archive") recursive = true;
        if (s === "--link" || s === "--symbolic-link") links = true;
        continue;
      }
      pos.push(rest[k]);
    }
    const dest = targetDir ?? pos[pos.length - 1];
    const sources = targetDir ? pos : pos.slice(0, -1);
    const verb = isMove ? `${prog} moves onto` : `${prog} overwrites`;
    if (!dest) return;
    let destIsDir = Boolean(targetDir);
    const destAbs = dest.s && !dest.dyn ? this.linked(this.abs(dest, scope)) : null;
    if (destAbs) {
      try {
        destIsDir = destIsDir || statSync(destAbs).isDirectory();
      } catch {
        /* a new file */
      }
    }
    // Into an existing directory, only the names the sources land as matter (checked below).
    if (!destIsDir) this.writeTarget(dest, scope, verb);
    if (links) for (const src of sources) {
      if (!src.s || src.dyn) continue;
      const r = this.ctx.files.protectedReason(this.linked(this.abs(src, scope)));
      if (r) this.block(`${prog} -l/-s links to ${r}, so a later write through the link would change it`);
    }
    if (destAbs) {
      for (const src of sources) {
        if (!src.s || src.dyn) continue;
        const srcAbs = this.linked(this.abs(src, scope));
        // `cp -R src/ dest` and `cp -R src/. dest` copy what src holds; `cp -R src dest` copies src itself.
        const contents = /\/\.?$/.test(src.s);
        const base = destIsDir && !contents ? join(destAbs, basename(srcAbs)) : destAbs;
        if (destIsDir && !contents) {
          const r = this.ctx.files.protectedReason(base);
          if (r) this.block(`${verb} ${r}`);
        }
        if (recursive || isMove || prog === "rsync") this.walkInto(srcAbs, base, verb);
      }
    }
    if (isMove) for (const src of sources) this.writeTarget(src, scope, `${prog} moves away`, { dirMatters: true });
  }

  /** The files a directory copied or moved to `base` would land as: blocked if any is a record. */
  walkInto(srcAbs, base, verb, budget = { n: 2000 }) {
    let st;
    try {
      st = statSync(srcAbs);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    const walk = (d, rel) => {
      let names = [];
      try {
        names = readdirSync(d);
      } catch {
        return;
      }
      for (const n of names) {
        if (--budget.n < 0) return;
        const target = join(base, rel, n);
        if (this.ctx.files.mightBeProtected(n)) {
          const r = this.ctx.files.protectedReason(target);
          if (r) {
            this.block(`${verb} ${r}`);
            return;
          }
        }
        try {
          if (lstatSync(join(d, n)).isDirectory()) walk(join(d, n), join(rel, n));
        } catch {
          /* gone */
        }
      }
    };
    walk(srcAbs, "");
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
      const creating = words.some((w) => ["--create", "--append", "--update"].includes(w)) || (/^[a-zA-Z]+$/.test(cluster) && /[cru]/.test(cluster)) || words.some((w) => /^-[a-zA-Z]*[cru]/.test(w) && !w.startsWith("--"));
      if (creating && !extracting) {
        // The archive (-f FILE, or the word after an old-style cluster ending in f) is written.
        for (let j = 0; j < rest.length; j++) {
          const w = words[j];
          if (w === "-f" || w === "--file" || (j === 0 && /^-?[a-zA-Z]*f$/.test(w)) || /^-[a-zA-Z]*f$/.test(w)) {
            this.writeTarget(rest[j + 1], scope, `${prog} writes its archive to`);
            break;
          }
          if (w.startsWith("--file=")) {
            this.writeTarget({ ...rest[j], s: w.slice(7), tail: w.slice(7) }, scope, `${prog} writes its archive to`);
            break;
          }
        }
        return;
      }
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

  /**
   * ln (and link): a link to a record, or to a directory that holds records, is a door to writing them; a link
   * the line makes is remembered, so later paths through it resolve to what it points at.
   */
  ln(rest, scope) {
    const pos = nonOptions(rest, "tS");
    if (pos.length < 1) return;
    const sources = pos.length === 1 ? pos : pos.slice(0, -1);
    const dest = pos.length > 1 ? pos[pos.length - 1] : null;
    if (dest) this.writeTarget(dest, scope, "ln writes"); // before the new link is remembered
    for (const s of sources) {
      if (s.dyn) {
        if (/pr-rla/.test(s.raw ?? "") && dest?.s) this.prRlaPaths.add(this.abs(dest, scope));
        continue;
      }
      if (!s.s) continue;
      const target = this.linked(this.abs(s, scope));
      const r = this.ctx.files.protectedReason(target);
      if (r) this.block(`ln links to ${r}, so a later write through the link would change it`);
      const inside = this.ctx.files.protectedInside(target);
      if (inside) this.block(`ln links to a directory holding audit records (${inside}), so a later write through the link would change them`);
      if (basename(s.s) === "pr-rla" && dest?.s) this.prRlaPaths.add(this.abs(dest, scope));
      if (dest?.s && !dest.dyn) {
        const destAbs = this.abs(dest, scope);
        let into = destAbs;
        try {
          if (statSync(destAbs).isDirectory()) into = join(destAbs, basename(target));
        } catch {
          /* a new link */
        }
        this.links.set(into, target);
      }
    }
  }

  rsync(rest, scope) {
    const pos = nonOptions(rest, "efT");
    if (pos.length < 2) return;
    const deletes = rest.some((a) => /^--(delete|del\b|remove-source-files)/.test(a.s ?? ""));
    const dest = pos[pos.length - 1];
    this.writeTarget(dest, scope, "rsync writes into", { dirMatters: deletes });
    if (dest.s && !dest.dyn) {
      const destAbs = this.linked(this.abs(dest, scope));
      for (const src of pos.slice(0, -1)) {
        if (!src.s || src.dyn) continue;
        const srcAbs = this.linked(this.abs(src, scope));
        // rsync copies what src/ holds, or src itself without the slash.
        this.walkInto(srcAbs, /\/$/.test(src.s) ? destAbs : join(destAbs, basename(srcAbs)), "rsync writes");
        if (!/\/$/.test(src.s)) {
          const r = this.ctx.files.protectedReason(join(destAbs, basename(srcAbs)));
          if (r) this.block(`rsync writes ${r}`);
        }
      }
    }
    if (rest.some((a) => a.s === "--remove-source-files")) for (const s of pos.slice(0, -1)) this.writeTarget(s, scope, "rsync removes", { dirMatters: true });
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
    if (patchText === null) patchText = this.stdinText(info, scope);
    if (patchText === null && !pos.length && this.roots(scope).length) this.block("patch with a patch the guard cannot read, in an audit repo");
    if (patchText) for (const p of diffPaths(patchText)) this.writeTarget({ s: p, dyn: false, glob: false, tail: p }, scope, "the patch edits");
  }

  // --- pr-rla --------------------------------------------------------------------------------------------------

  prRla(rest, info, definite) {
    this.runsPrRla = true;
    const env = this.ctx.env;
    const valueOpts = new Set(["-C", "--dir", "-c", "--config", "--from-file", "--plugins"]);
    const valueAfter = new Set(["--window", "--max-patch-bytes", "--log-key", "--tsa-trust", "--registration", "--beacon-file", "--population", "--defects", "--runs", "--seed", "--p0", "--p1", "--alpha", "--cap", "--fixture", "--kind", "--trust", "--reviewer", "--note", "--sign", "--rekor-url", "--rekor-api", "--key", "--out", "--through", "--remote", "--branch", "--repo", "--provider", "--resume", "--env", "--origin"]);
    const isValue = (j) => valueOpts.has(rest[j - 1]?.s ?? "") || valueAfter.has(rest[j - 1]?.s ?? "");
    // --help or --version anywhere (but not as another option's value, such as --note --help) prints and exits.
    const helpOnly = rest.some((a, j) => ["-h", "--help", "-V", "--version"].includes(a.s ?? "") && !isValue(j)) && !rest.some((a) => a.s === "--accept-lock-grants" || a.s === "--submit");
    const cleared = info.unset?.has("*") || info.unset?.has("PR_RLA_ACCEPT_LOCK_GRANTS") || this.unsetVars.has("PR_RLA_ACCEPT_LOCK_GRANTS");
    if (!helpOnly && env.PR_RLA_ACCEPT_LOCK_GRANTS && !cleared) this.block("this session's environment sets PR_RLA_ACCEPT_LOCK_GRANTS, so any pr-rla command run here would take the repo's lock grants without your consent; unset it before starting the assistant");
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

  // --- labels: gh, glab, curl, wget, HTTPie -----------------------------------------------------------------------

  /** Whether text (a label name, a request body, a query) carries a verdict label: the defaults, their shape, or the audit's own. */
  hasVerdictLabel(text, scope) {
    if (text === null || text === undefined || text === "") return false;
    const files = this.ctx.files;
    const roots = this.roots(scope);
    const t = decodeJsonEscapes(decodeSafe(String(text)));
    if (/pr-rla\s*(?:::|:|-|_|\/)\s*(?:pass|fail)\b/i.test(t)) return true;
    for (const tok of t.split(/[\s"'`[\]{},=&;()~<>|]+/)) if (tok && files.isVerdictLabel(tok.replace(/^[:/]+|[:/,.]+$/g, ""), roots)) return true;
    const lower = t.toLowerCase();
    for (const r of roots) for (const l of files.configOf(r).labels) if (/\s/.test(l) && lower.includes(l)) return true;
    return false;
  }

  /** A GitLab quick action (`/label ~x`, `/unlabel`, `/relabel`) that names a verdict label. */
  quickActionLabel(text, scope) {
    if (!text) return false;
    for (const m of decodeJsonEscapes(String(text)).matchAll(QUICK_ACTION)) if (this.hasVerdictLabel(m[1], scope)) return true;
    return false;
  }

  labelArg(v, scope) {
    return Boolean(v) && (v.dyn || v.s === null || splitLabels(v.s).some((x) => this.hasVerdictLabel(x, scope)));
  }

  /** gh and glab take their persistent flags anywhere: the first two words that are not flags or flag values. */
  subcommandPath(rest, valueFlags) {
    const words = [];
    for (let k = 0; k < rest.length && words.length < 2; k++) {
      const s = rest[k].s ?? "";
      if (s.startsWith("-")) {
        if (valueFlags.includes(s)) k++;
        continue;
      }
      words.push({ s, k });
    }
    return { area: words[0]?.s, verb: words[1]?.s, after: words[1] ? words[1].k + 1 : rest.length, areaAt: words[0]?.k ?? -1 };
  }

  gh(rest, scope, depth, info = {}) {
    const { area, verb, after, areaAt } = this.subcommandPath(rest, ["-R", "--repo", "--hostname"]);
    if (area === "api") return this.ghApi(rest.slice(areaAt + 1), scope, "gh api", info);
    if (area === "alias" && verb === "set") {
      const tail = rest.slice(after);
      const shell = tail.some((a) => a.s === "--shell" || a.s === "-s");
      const positional = tail.filter((a) => !(a.s ?? "").startsWith("-"));
      const expansion = positional[1];
      if (expansion?.dyn) this.block("gh alias set with a computed expansion: the guard cannot tell what the alias would run");
      else if (expansion?.s) this.ghAliasExpansion(expansion.s, shell, scope, depth);
      return;
    }
    if (area === "alias" && verb === "import") {
      const file = rest.slice(after).find((a) => !(a.s ?? "").startsWith("-") || a.s === "-");
      const text = !file || file.s === "-" ? this.stdinText(info, scope) : this.scriptText(file, scope);
      if (text === null) {
        this.block("gh alias import of a file the guard cannot read: its aliases may edit verdict labels");
        return;
      }
      for (const m of text.matchAll(/^\s*[\w.-]+\s*:\s*(.+?)\s*$/gm)) this.ghAliasExpansion(unquoteSimple(m[1]), false, scope, depth);
      return;
    }
    if ((area === "issue" || area === "pr") && (verb === "edit" || verb === "create")) {
      const flags = verb === "edit" ? ["--add-label", "--remove-label"] : ["-l", "--label"];
      for (let j = 0; j < rest.length; j++) {
        const s = rest[j].s ?? "";
        for (const f of flags) {
          const hit = (s === f && this.labelArg(rest[j + 1], scope)) || (s.startsWith(`${f}=`) && this.labelArg({ s: s.slice(f.length + 1), dyn: rest[j].dyn }, scope)) || (f === "-l" && /^-l./.test(s) && this.labelArg({ s: s.slice(2), dyn: rest[j].dyn }, scope));
          if (hit) this.block(`gh ${area} ${verb} ${f} applies or removes a pr-rla verdict label; the reviewer applies it themselves, in the tracker`);
        }
      }
      return;
    }
    if (area === "issue" && (verb === "delete" || verb === "transfer") && this.roots(scope).length) {
      this.block(`gh issue ${verb} in an audit repo can take a draw's issue, and its verdict, out of the ledger; only a person may do that`);
      return;
    }
    if (area === "label" && (verb === "edit" || verb === "delete")) {
      const nameArg = rest.slice(after).find((a) => !(a.s ?? "").startsWith("-"));
      if (this.labelArg(nameArg, scope)) this.block(`gh label ${verb} changes a pr-rla verdict label, which the ledger's history depends on`);
      const rename = rest.findIndex((a) => a.s === "--name" || a.s === "-n");
      if (rename >= 0 && this.labelArg(rest[rename + 1], scope)) this.block("gh label edit --name renames a label to a pr-rla verdict label");
    }
  }

  /** What a gh alias would run: a shell command (`--shell`, or `!…`), or gh's own arguments. */
  ghAliasExpansion(text, shell, scope, depth) {
    if (shell || text.startsWith("!")) this.script(text.replace(/^!/, ""), scope.child(), depth + 1);
    else this.script(`gh ${text.replace(/^gh\s+/, "")}`, scope.child(), depth + 1);
  }

  /** `gh api` / `glab api`: a non-read request carrying a verdict label, changing one, a GraphQL label mutation, or a body the guard cannot read. */
  ghApi(args, scope, what, info = {}) {
    let method = null;
    const fields = [];
    let endpoint = null;
    const body = [];
    for (let k = 0; k < args.length; k++) {
      const s = args[k].s;
      if (s === null) {
        if (!endpoint) endpoint = args[k];
        else body.push(null);
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
        fields.push({ raw: s === "-f" || s === "--raw-field", arg: args[++k] });
        continue;
      }
      if (/^--(raw-)?field=/.test(s) || /^-[fF]./.test(s)) {
        fields.push({ raw: /^(-f|--raw-field)/.test(s), arg: { ...args[k], s: s.replace(/^--(raw-)?field=|^-[fF]/, "") } });
        continue;
      }
      if (s === "--input" || s.startsWith("--input=")) {
        const f = s === "--input" ? args[++k] : { ...args[k], s: s.slice(8) };
        body.push(!f || f.dyn ? null : f.s === "-" ? this.stdinText(info, scope) : this.scriptText(f, scope));
        continue;
      }
      if (["-H", "--header", "-p", "--preview", "--hostname", "-q", "--jq", "-t", "--template", "--cache"].includes(s)) {
        k++;
        continue;
      }
      if (s.startsWith("-")) continue;
      if (!endpoint) endpoint = args[k];
    }
    for (const { raw, arg } of fields) {
      if (!arg || arg.s === null) {
        body.push(null);
        continue;
      }
      const m = /^([^=]*)=(.*)$/s.exec(arg.s);
      const key = m ? m[1] : arg.s;
      const value = m ? m[2] : "";
      if (raw || !value.startsWith("@")) body.push(`${key}=${value}`);
      else {
        const text = value === "@-" ? this.stdinText(info, scope) : this.scriptText({ s: value.slice(1) }, scope);
        body.push(text === null ? null : `${key}=${text}`);
      }
    }
    if (!method) method = fields.length || body.length ? "POST" : "GET";
    const ep = endpoint?.s ?? null;
    if (ep === null) {
      if (method !== "GET" && method !== "HEAD") this.block(`${what} with a computed endpoint and method ${method}: the guard cannot tell whether it writes a verdict label`);
      return;
    }
    const r = this.labelWrite(method, ep, body, scope);
    if (r) this.block(`${what} ${r}`);
  }

  /** Why an HTTP request writes a verdict label, or null. `body` entries are null when the guard cannot read them. */
  labelWrite(method, url, body, scope) {
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
    const unknown = body.some((b) => b === null);
    const text = body.filter((b) => b !== null).map((b) => decodeJsonEscapes(String(b))).join("\n");
    const comment = /\/(notes|comments|discussions)(\/[^/]+)?\/?$/.test(path);
    if (comment) {
      if (this.quickActionLabel(text, scope) || this.quickActionLabel(query, scope)) return `${m} ${path} posts a GitLab quick action that applies or removes a pr-rla verdict label; the reviewer applies it themselves`;
      return unknown ? `${m} ${path} posts a comment the guard cannot read; a quick action in it could apply a verdict label` : null;
    }
    if (this.hasVerdictLabel(query, scope) || this.hasVerdictLabel(text, scope)) return `${m} ${path} sends a pr-rla verdict label; the reviewer applies verdict labels themselves, in the tracker`;
    const li = segs.lastIndexOf("labels");
    if (li >= 0) {
      const name = segs.slice(li + 1).join("/");
      if (name && this.hasVerdictLabel(name, scope)) return `${m} ${path} changes the verdict label ${name}`;
      return unknown ? `${m} ${path} with a body the guard cannot read: it may set a verdict label` : null;
    }
    if (/\/graphql\/?$/.test(path)) {
      if (LABEL_MUTATION.test(text)) return "sends a GraphQL label mutation; the reviewer applies verdict labels themselves";
      return unknown ? "sends a GraphQL document the guard cannot read; it may change labels" : null;
    }
    if (/(^|\/)(issues|pulls|merge_requests)(\/[^/]+)?\/?$/.test(path) && unknown) return `${m} ${path} sends a body the guard cannot read; it may set labels`;
    return null;
  }

  glab(rest, scope, depth, info = {}) {
    const { area, verb, after, areaAt } = this.subcommandPath(rest, ["-R", "--repo"]);
    if (area === "api") return this.ghApi(rest.slice(areaAt + 1), scope, "glab api", info);
    if ((area === "issue" || area === "mr") && ["update", "create", "edit"].includes(verb ?? "")) {
      for (let j = 0; j < rest.length; j++) {
        const s = rest[j].s ?? "";
        for (const f of ["-l", "--label", "-u", "--unlabel"]) {
          if ((s === f && this.labelArg(rest[j + 1], scope)) || (s.startsWith(`${f}=`) && this.labelArg({ s: s.slice(f.length + 1), dyn: rest[j].dyn }, scope))) this.block(`glab ${area} ${verb} ${f} applies or removes a pr-rla verdict label; the reviewer applies it themselves, in GitLab`);
        }
      }
      return;
    }
    if ((area === "issue" || area === "mr") && verb === "note") {
      for (let j = after; j < rest.length; j++) {
        const s = rest[j].s ?? "";
        const msg = s === "-m" || s === "--message" ? rest[j + 1] : s.startsWith("--message=") ? { ...rest[j], s: s.slice(10) } : null;
        if (msg && (msg.dyn || this.quickActionLabel(msg.s, scope))) this.block(`glab ${area} note posts a quick action that applies or removes a pr-rla verdict label${msg.dyn ? " (or a computed message the guard cannot read)" : ""}; the reviewer applies it themselves`);
      }
      return;
    }
    if (area === "label" && ["delete", "edit", "update"].includes(verb ?? "")) {
      const nameArg = rest.slice(after).find((a) => !(a.s ?? "").startsWith("-"));
      if (this.labelArg(nameArg, scope)) this.block(`glab label ${verb} changes a pr-rla verdict label, which the ledger's history depends on`);
    }
  }

  curl(rest, scope, info = {}) {
    const valueShort = new Set("AbcCdDeEFHKmoPQrTtuUwxXyYz".split(""));
    const valueLong = new Set(["--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "--form", "--form-string", "--request", "--header", "--url", "--upload-file", "--user", "--output", "--config", "--cookie", "--cookie-jar", "--user-agent", "--referer", "--max-time", "--connect-timeout", "--retry", "--proxy", "--cacert", "--cert", "--key", "--write-out", "--range", "--resolve", "--connect-to", "--oauth2-bearer", "--variable", "--expand-data", "--expand-url", "--expand-header", "--url-query", "--output-dir", "--dump-header", "--trace", "--trace-ascii", "--stderr", "--etag-save"]);
    let method = null;
    let get = false;
    let globoff = false;
    const urls = [];
    const body = [];
    const queries = [];
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
        opt = eq > 0 && !valueLong.has(s) ? s.slice(0, eq) : s;
        if (valueLong.has(opt)) val = eq > 0 && opt !== s ? { ...a, s: s.slice(eq + 1) } : rest[++k];
      } else if (s.startsWith("-") && s.length > 1) {
        let c = 1;
        for (; c < s.length; c++) {
          const ch = s[c];
          if (ch === "G") get = true;
          if (ch === "g") globoff = true;
          if (ch === "I") method = method ?? "HEAD";
          if (valueShort.has(ch)) {
            opt = `-${ch}`;
            val = c + 1 < s.length ? { ...a, s: s.slice(c + 1) } : rest[++k];
            break;
          }
        }
        if (opt === null) continue;
      }
      if (opt === null) {
        urls.push(a);
        continue;
      }
      if (opt === "-X" || opt === "--request") method = (val?.s ?? "?").toUpperCase();
      else if (opt === "--get") get = true;
      else if (opt === "--globoff") globoff = true;
      else if (opt === "--head") method = method ?? "HEAD";
      else if (["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string"].includes(opt)) {
        if (!val || val.s === null) body.push(null);
        else {
          const v = val.s;
          const at = /^(?:[^=@]*=)?@(.+)$/.exec(v);
          if (at && opt !== "--data-raw" && opt !== "--form-string") {
            const file = at[1].replace(/;.*$/, "");
            this.readTarget({ s: file, dyn: false, glob: false, tail: file }, scope, "curl sends");
            body.push(file === "-" ? this.stdinText(info, scope) : this.scriptText({ s: file }, scope));
          } else body.push(v);
        }
      } else if (opt === "--expand-data") body.push(null);
      else if (opt === "--url-query") queries.push(val?.s ?? null);
      else if (opt === "-T" || opt === "--upload-file") {
        upload = true;
        if (val?.s) this.readTarget(val, scope, "curl uploads");
        body.push(val?.s ? this.scriptText(val, scope) : null);
      } else if (opt === "--url") urls.push(val);
      else if (opt === "-o" || opt === "--output") this.writeTarget(val, scope, "curl -o writes");
      else if (opt === "-K" || opt === "--config") {
        const text = val?.s ? this.scriptText(val, scope) : null;
        if (text === null || /labels|graphql|\/notes|quick/i.test(text) || this.hasVerdictLabel(text, scope)) this.block("curl --config reads its request from a file the guard cannot fully check, and it names labels or GraphQL");
      }
    }
    if (!method) method = get ? "GET" : body.length ? (upload ? "PUT" : "POST") : "GET";
    if (get && method === "POST") method = "GET";
    for (const q of queries) {
      if (q === null || this.hasVerdictLabel(q, scope)) if (method !== "GET" || q === null) body.push(q);
    }
    for (const u of urls) {
      if (!u) continue;
      if (u.s === null) {
        if (method !== "GET" && method !== "HEAD") this.block(`curl ${method} to a computed URL: the guard cannot tell whether it writes a verdict label`);
        continue;
      }
      if (!/^(https?:\/\/|[\w.-]+\.[a-z]{2,}\/|\/)/i.test(u.s)) continue;
      for (const one of globoff ? [u.s] : curlGlobs(u.s)) {
        const r = this.labelWrite(method, one, body, scope);
        if (r) {
          this.block(`curl ${r}`);
          break;
        }
      }
    }
  }

  wget(rest, scope) {
    let method = "GET";
    const body = [];
    const urls = [];
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k];
      const s = a.s;
      if (s === null) {
        urls.push(a);
        continue;
      }
      const eq = s.indexOf("=");
      const name = s.startsWith("--") && eq > 0 ? s.slice(0, eq) : s;
      const value = () => (s.startsWith("--") && eq > 0 ? s.slice(eq + 1) : (rest[++k]?.s ?? null));
      if (name === "--method") method = (value() ?? "?").toUpperCase();
      else if (name === "--post-data" || name === "--body-data") {
        body.push(value());
        if (method === "GET") method = "POST";
      } else if (name === "--post-file" || name === "--body-file") {
        const f = value();
        body.push(f ? readText(resolve(scope.cwd, f)) : null);
        if (method === "GET") method = "POST";
      } else if (name === "-O" || name === "--output-document") {
        const f = value();
        if (f && f !== "-") this.writeTarget({ s: f, dyn: false, glob: false, tail: f }, scope, "wget -O writes");
      } else if (/^-O./.test(s)) this.writeTarget({ s: s.slice(2), dyn: false, glob: false, tail: s.slice(2) }, scope, "wget -O writes");
      else if (["-o", "--output-file", "-a", "--append-output", "--header", "-U", "--user-agent", "--user", "--password", "-P", "--directory-prefix", "-e", "--execute", "-t", "--tries", "-T", "--timeout"].includes(name)) {
        if (!(s.startsWith("--") && eq > 0)) k++;
      } else if (!s.startsWith("-")) urls.push(a);
    }
    for (const u of urls) {
      if (!u?.s) continue;
      const r = this.labelWrite(method, u.s, body, scope);
      if (r) this.block(`wget ${r}`);
    }
  }

  httpie(rest, scope) {
    const valueOpts = new Set(["-a", "--auth", "-A", "--auth-type", "-o", "--output", "--session", "--session-read-only", "-p", "--print", "--pretty", "-s", "--style", "--verify", "--cert", "--cert-key", "--proxy", "--timeout", "--max-redirects", "--boundary", "--format-options", "--unsorted"]);
    const pos = [];
    for (let k = 0; k < rest.length; k++) {
      const s = rest[k].s ?? "";
      if (s.startsWith("-") && rest[k].s !== null) {
        if (valueOpts.has(s)) k++;
        continue;
      }
      pos.push(rest[k]);
    }
    let k = 0;
    let method = null;
    if (pos[0]?.s && /^[A-Z]+$/.test(pos[0].s)) {
      method = pos[0].s;
      k = 1;
    }
    const url = pos[k];
    const items = pos.slice(k + 1).map((a) => a.s);
    const data = items.filter((i) => i === null || /^[^:=@]+(:=|=|@)/.test(i)).map((i) => (i === null ? null : i.replace(/(?::?=)?@(.+)$/, (_m, f) => `=${readText(resolve(scope.cwd, f)) ?? ""}`)));
    const query = items.filter((i) => i !== null && /^[^=]+==/.test(i)).join("&");
    if (!method) method = data.length ? "POST" : "GET";
    if (!url?.s) return;
    const r = this.labelWrite(method, query ? `${url.s}${url.s.includes("?") ? "&" : "?"}${query}` : url.s, data, scope);
    if (r) this.block(`HTTPie ${r}`);
  }

  // --- git -----------------------------------------------------------------------------------------------------

  git(rest, scope, depth, info = {}) {
    let cwd = scope.cwd;
    let cwdUnknown = scope.cwdUnknown;
    let gitDir = null;
    let workTree = null;
    let forceFromConfig = false;
    let hooksPath = null;
    const oneShotAliases = new Map();
    const envGit = (name) => info.env?.get(name) ?? (scope.vars.has(name) ? scope.vars.get(name) : undefined);
    const configFinding = (key, value, source) => {
      if (/^alias\./i.test(key)) {
        oneShotAliases.set(key.slice(6), value);
        return;
      }
      if (/^remote\.[^.]+\.push$/i.test(key) && String(value ?? "").trim().startsWith("+")) forceFromConfig = true;
      if (/^include(if\.[^.]*)?\.path$/i.test(key) || /^includeif\./i.test(key)) this.block(`git ${source} include.path loads another configuration file into this command, which can set aliases, pagers or hooks; only a person may do that`);
      if (/^core\.hookspath$/i.test(key)) hooksPath = value;
      else if (GIT_COMMAND_KEYS.test(key) && typeof value === "string") this.script(value.replace(/^!/, ""), scope.child(), depth + 1);
      else if (GIT_COMMAND_KEYS.test(key) && value === null) this.block(`git ${source} sets ${key} to a value the guard cannot read`);
    };
    // The environment: GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_COUNT/KEY_n/VALUE_n.
    if (envGit("GIT_DIR")) gitDir = resolve(cwd, envGit("GIT_DIR"));
    if (envGit("GIT_WORK_TREE")) workTree = resolve(cwd, envGit("GIT_WORK_TREE"));
    const count = Number(envGit("GIT_CONFIG_COUNT") ?? 0);
    for (let n = 0; n < Math.min(count, 50); n++) {
      const key = envGit(`GIT_CONFIG_KEY_${n}`);
      if (key) configFinding(key, envGit(`GIT_CONFIG_VALUE_${n}`) ?? null, "GIT_CONFIG_*");
    }
    let k = 0;
    for (; k < rest.length; k++) {
      const s = rest[k].s;
      if (s === null) return this.block("git with a computed option or subcommand: the guard cannot tell what it does");
      if (s === "-C") {
        const d = rest[++k];
        if (d?.dyn) cwdUnknown = true;
        else if (d?.s) {
          cwd = resolve(cwd, d.s);
          cwdUnknown = false;
        }
        continue;
      }
      if (s === "-c") {
        const cfg = rest[++k];
        if (cfg?.dyn) {
          this.block("git -c with a computed setting: the guard cannot tell what it sets");
          continue;
        }
        const m = /^([^=]+)=(.*)$/s.exec(cfg?.s ?? "");
        if (m) configFinding(m[1], m[2], "-c");
        continue;
      }
      if (s.startsWith("--config-env=") || s === "--config-env") {
        const v = s === "--config-env" ? (rest[++k]?.s ?? "") : s.slice(13);
        const m = /^([^=]+)=(.*)$/.exec(v);
        if (m) {
          const value = info.env?.get(m[2]) ?? (scope.vars.has(m[2]) ? scope.vars.get(m[2]) : this.ctx.env[m[2]]) ?? null;
          configFinding(m[1], value, "--config-env");
        }
        continue;
      }
      if (s === "--git-dir" || s.startsWith("--git-dir=")) {
        const v = s === "--git-dir" ? rest[++k] : { ...rest[k], s: s.slice(10) };
        if (v?.dyn) cwdUnknown = true;
        else if (v?.s) gitDir = resolve(cwd, v.s);
        continue;
      }
      if (s === "--work-tree" || s.startsWith("--work-tree=")) {
        const v = s === "--work-tree" ? rest[++k] : { ...rest[k], s: s.slice(12) };
        if (v?.dyn) cwdUnknown = true;
        else if (v?.s) workTree = resolve(cwd, v.s);
        continue;
      }
      if (["--namespace", "--exec-path", "--super-prefix"].includes(s)) {
        k++;
        continue;
      }
      if (s.startsWith("-")) continue;
      break;
    }
    const sub = rest[k]?.s;
    if (!sub) return;
    const args = rest.slice(k + 1);
    // The repository this command acts on.
    if (workTree) cwd = workTree;
    else if (gitDir && basename(gitDir) === ".git") cwd = dirname(gitDir);
    const repoArgs = [...(gitDir ? [`--git-dir=${gitDir}`] : []), ...(workTree ? [`--work-tree=${workTree}`] : [])];
    const g = (a) => runGit([...repoArgs, ...a], cwd);
    const gitScope = Object.assign(scope.child(), { cwd });
    const auditRoot = this.ctx.files.auditRootOf(cwd);
    const risky = new Set(["commit", "push", "reset", "checkout", "restore", "switch", "rm", "mv", "clean", "stash", "rebase", "filter-branch", "filter-repo", "update-ref", "revert", "cherry-pick", "apply", "am", "replace", "branch"]);
    if (cwdUnknown && risky.has(sub)) {
      this.block(`git ${sub} in a repository the guard cannot resolve (a computed -C, --git-dir or --work-tree, or cd): it may be an audit repo`);
      return;
    }
    const known = new Set(["add", "am", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "checkout", "cherry", "cherry-pick", "clean", "clone", "commit", "commit-tree", "config", "describe", "diff", "diff-tree", "fetch", "filter-branch", "filter-repo", "format-patch", "fsck", "gc", "grep", "hash-object", "help", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mktree", "mv", "notes", "pull", "push", "range-diff", "read-tree", "rebase", "reflog", "remote", "replace", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "sparse-checkout", "stage", "stash", "status", "submodule", "switch", "symbolic-ref", "tag", "update-index", "update-ref", "version", "whatchanged", "worktree", "write-tree"]);
    if (!known.has(sub)) {
      const alias = oneShotAliases.get(sub) ?? this.gitAliases.get(sub) ?? g(["config", "--get", `alias.${sub}`]);
      if (alias !== null && alias !== undefined) {
        const a = String(alias).trim();
        const prefix = [...(gitDir ? [`--git-dir=${shq(gitDir)}`] : []), ...(workTree ? [`--work-tree=${shq(workTree)}`] : [])].join(" ");
        if (a.startsWith("!")) this.script(`${a.slice(1)} ${args.map(shq).join(" ")}`, gitScope, depth + 1);
        else this.script(`git ${prefix} ${a} ${args.map(shq).join(" ")}`, gitScope, depth + 1);
      }
      return;
    }
    // Hooks this command would run from a one-shot core.hooksPath.
    if (hooksPath) {
      const dir = resolve(cwd, hooksPath);
      const texts = [];
      for (const [p, text] of this.written) if (dirname(p) === dir) texts.push(text);
      try {
        for (const n of readdirSync(dir)) {
          const t = readText(join(dir, n));
          if (t !== null) texts.push(t);
        }
      } catch {
        /* no directory yet */
      }
      for (const t of texts) this.script(t, gitScope.child(), depth + 1);
    }
    const opts = args.map((a) => a.s ?? "");
    const ledgerFiles = () => {
      const names = new Set(["verdicts.jsonl"]);
      if (auditRoot) for (const f of this.ctx.files.configOf(auditRoot).files) names.add(f);
      return names;
    };
    const isLedgerFile = (p) => ledgerFiles().has(basename(p).toLowerCase());
    const top = () => g(["rev-parse", "--show-toplevel"])?.trim() ?? cwd;
    const lines = (out) => (out ?? "").split("\0").flatMap((x) => x.split("\n")).filter(Boolean);
    const protectedIn = (paths) => {
      const t = top();
      for (const p of paths) {
        const r = this.ctx.files.protectedReason(resolve(t, p));
        if (r) return r;
      }
      return null;
    };
    const protectedChanged = (extraArgs = []) => {
      const out = g(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...extraArgs]);
      if (out === null) return null;
      return protectedIn(out.split("\0").filter(Boolean).map((l) => l.slice(3)).filter(Boolean));
    };
    /** The commits between `rev` and HEAD (both ways) change a record. */
    const dropsRecords = (rev) => {
      const out = g(["diff", "--name-only", "-z", rev, "HEAD"]);
      return out === null ? "unknown" : protectedIn(lines(out));
    };
    /** A revision's own changes touch a record (revert, cherry-pick). */
    const commitTouches = (rev) => {
      const out = rev.includes("..") ? g(["diff", "--name-only", "-z", ...rev.split(/\.\.\.?/)]) : g(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--root", rev]);
      return out === null ? null : protectedIn(lines(out));
    };
    const pathspecs = () => {
      const d = opts.indexOf("--");
      return d >= 0 ? args.slice(d + 1) : [];
    };
    switch (sub) {
      case "config": {
        if (opts.some((o) => ["--get", "--get-all", "--get-regexp", "-l", "--list", "--unset", "--unset-all", "--show-origin", "get", "list", "unset"].includes(o))) return;
        const positional = args.filter((a, j) => !opts[j].startsWith("-") && !["set", "--file", "-f"].includes(opts[j]) && !["--file", "-f", "--type", "--default", "--comment"].includes(opts[j - 1] ?? ""));
        const keyArg = positional[0];
        const valueArg = positional[1];
        if (!keyArg?.s) return;
        const key = keyArg.s;
        const value = valueArg ? (valueArg.dyn ? null : valueArg.s) : "";
        if (/^alias\./i.test(key)) {
          if (value === null) return this.block(`git config ${key} with a computed value: the guard cannot tell what the alias would run`);
          this.gitAliases.set(key.slice(6), value);
          // What the alias would do is checked now: a shell alias as a command, another as git's own arguments.
          if (value.startsWith("!")) this.script(value.slice(1), gitScope, depth + 1);
          else this.script(`git ${value}`, gitScope, depth + 1);
          return;
        }
        if (!auditRoot) {
          if (GIT_COMMAND_KEYS.test(key) && value) this.script(value.replace(/^!/, ""), scope.child(), depth + 1);
          return;
        }
        if (/^remote\.[^.]+\.push$/i.test(key) && String(value ?? "").trim().startsWith("+")) return this.block(`git config ${key} with a + refspec makes every later push to the audit repo a forced push`);
        if (/^include(if\.[^.]*)?\.path$/i.test(key) || /^includeif\./i.test(key)) return this.block(`git config ${key} loads another configuration file into the audit repo's git, which can set aliases, pagers or hooks`);
        if (/^core\.hookspath$/i.test(key)) return this.block("git config core.hooksPath in the audit repo makes git run other hooks as you later (when you commit); only you may set it");
        if (GIT_COMMAND_KEYS.test(key)) {
          if (value === null) return this.block(`git config ${key} with a computed value, in the audit repo`);
          this.script(value.replace(/^!/, ""), scope.child(), depth + 1);
        }
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
          if (s === "--pathspec-from-file" || s.startsWith("--pathspec-from-file=")) {
            const f = s === "--pathspec-from-file" ? args[++j] : { ...args[j], s: s.slice(22) };
            const text = f?.s === "-" ? this.stdinText(info, scope) : f?.s ? this.scriptText(f, gitScope) : null;
            if (text === null) return this.block("git commit --pathspec-from-file with a list the guard cannot read: it may commit the verdict ledger");
            paths.push(...text.split(/[\n\0]/).map((x) => x.trim()).filter(Boolean));
            continue;
          }
          if (valueOpts.has(s)) {
            j++;
            continue;
          }
          if (s === "--amend") amend = true;
          else if (s === "--all" || s === "-i" || s === "--include") all = true;
          else if (/^-[a-zA-Z]+$/.test(s)) {
            if (s.includes("a")) all = true;
            if (/[mFCct]$/.test(s)) j++;
          } else if (s.startsWith("-")) continue;
          else paths.push(s);
        }
        const t = top();
        const candidates = new Set(lines(g(["diff", "--cached", "--name-only", "-z"])));
        const modified = () => [...lines(g(["diff", "--name-only", "-z"])), ...lines(g(["ls-files", "--others", "--exclude-standard", "-z"]))];
        if (all) for (const p of lines(g(["diff", "--name-only", "-z"]))) candidates.add(p);
        if (paths.length) {
          // A pathspec commits what it names, staged or not: only those.
          const specs = paths.map((p) => relative(t, resolve(cwd, p)));
          for (const p of modified()) if (specs.some((sp) => sp === "" || sp === "." || p === sp || p.startsWith(`${sp}/`))) candidates.add(p);
          for (const sp of specs) candidates.add(sp);
        }
        if (this.addedPaths !== null) {
          for (const p of modified()) if (this.addedPaths === "all" || [...this.addedPaths].some((sp) => p === sp || p.startsWith(`${sp}/`))) candidates.add(p);
        }
        if (amend) for (const p of lines(g(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"]))) candidates.add(p);
        const hit = [...candidates].find(isLedgerFile);
        if (hit) this.block(`git commit would ${amend ? "rewrite a commit that holds" : "commit"} ${hit}, the verdict ledger; the reviewer commits their own verdict`);
        return;
      }
      case "add":
      case "stage": {
        const t = top();
        const named = args.filter((a, j) => !opts[j].startsWith("-") && a.s);
        if (opts.some((o) => /^(-A|--all|-u|--update|--no-ignore-removal)$/.test(o) || /^-[a-zA-Z]*[Au]/.test(o)) || named.some((a) => a.s === "." || a.s === "*")) this.addedPaths = "all";
        else if (this.addedPaths !== "all") {
          this.addedPaths = this.addedPaths ?? new Set();
          for (const a of named) this.addedPaths.add(relative(t, resolve(cwd, a.s)));
        }
        return;
      }
      case "push": {
        if (!auditRoot) return;
        const force = opts.some((s) => /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--delete|-d|--prune)$/.test(s) || (/^-[a-zA-Z]+$/.test(s) && /[fd]/.test(s)));
        const refspecs = opts.filter((s) => !s.startsWith("-"));
        const rewrite = refspecs.slice(1).some((r) => r.startsWith("+") || r.startsWith(":"));
        const configured = forceFromConfig || lines(g(["config", "--get-regexp", "^remote\\..*\\.push$"])).some((l) => /\s\+/.test(l));
        if (force || rewrite || (configured && refspecs.length <= 1)) this.block("a forced or deleting git push to the audit repo could rewrite or remove its history (verdicts and checkpoints); only a person may do that");
        return;
      }
      case "reset": {
        if (!auditRoot) return;
        const hard = opts.some((s) => s === "--hard" || s === "--merge" || s === "--keep");
        if (hard) {
          const changed = protectedChanged();
          if (changed) return this.block(`git reset ${opts.find((s) => s.startsWith("--"))} would discard an uncommitted change to ${changed}`);
        }
        const target = args.find((a, j) => !opts[j].startsWith("-") && opts[j] !== "--" && (j === 0 || opts[j - 1] !== "--"));
        // `git reset <rev>` moves the branch: it drops the commits after <rev>, whatever the mode.
        if (target && target.s && target.s !== "HEAD" && !existsSync(resolve(cwd, target.s))) {
          const d = dropsRecords(target.s);
          if (d) this.block(`git reset to ${target.s} would drop commits that change audit records${d === "unknown" ? " (or names a revision the guard cannot read)" : `: ${d}`}`);
        } else if (target?.dyn) this.block("git reset to a computed revision, in the audit repo");
        return;
      }
      case "checkout":
      case "switch":
      case "restore": {
        const dashes = opts.indexOf("--");
        const force = opts.some((s) => s === "-f" || s === "--force" || s === "--discard-changes");
        const forceBranch = opts.findIndex((s) => s === "-B" || (sub === "switch" && (s === "-C" || s === "--force-create")));
        let source = null;
        for (let j = 0; j < args.length; j++) {
          if (opts[j] === "-s" || opts[j] === "--source") source = args[j + 1]?.s ?? null;
          else if (opts[j].startsWith("--source=")) source = opts[j].slice(9);
        }
        if (forceBranch >= 0 && auditRoot) {
          const start = args.slice(forceBranch + 2).find((a, j) => !(a.s ?? "").startsWith("-"));
          if (start?.s) {
            const d = dropsRecords(start.s);
            if (d) return this.block(`git ${sub} ${opts[forceBranch]} resets a branch to ${start.s}, dropping commits that change audit records`);
          }
        }
        const valueOpts = new Set(["-s", "--source", "-b", "-B", "-c", "-C", "--orphan", "--conflict", "--pathspec-from-file"]);
        const positional = args.filter((a, j) => (dashes < 0 || j < dashes) && !opts[j].startsWith("-") && !valueOpts.has(opts[j - 1] ?? ""));
        let pathArgs = [];
        if (dashes >= 0) pathArgs = args.slice(dashes + 1);
        else if (sub === "restore") pathArgs = positional;
        else if (sub === "checkout") pathArgs = positional.filter((a) => a.s && existsSync(resolve(cwd, a.s)));
        // `git checkout <rev> -- paths` / `git checkout <rev> paths`: the revision's content over the paths.
        if (sub === "checkout" && !source) {
          const revs = positional.filter((a) => !pathArgs.includes(a) && a.s);
          if (revs.length && pathArgs.length) source = revs[0].s;
        }
        if (sub === "restore" && opts.includes("--staged") && !opts.includes("--worktree") && !opts.includes("-W")) return;
        if (pathArgs.length === 0) {
          if (auditRoot && force) {
            const changed = protectedChanged();
            if (changed) this.block(`git ${sub} --force would discard an uncommitted change to ${changed}`);
          }
          return;
        }
        for (const a of pathArgs) {
          if (a.dyn) {
            if (auditRoot) this.block(`git ${sub} of a computed path, in the audit repo`);
            continue;
          }
          if (!a.s) continue;
          const abs = resolve(cwd, a.s);
          const r = this.ctx.files.protectedReason(abs);
          if (r) {
            this.block(`git ${sub} would change ${r}`);
            continue;
          }
          const rel = relative(cwd, abs) || ".";
          if (source) {
            const out = g(["diff", "--name-only", "-z", source, "--", rel]);
            const hit = out === null ? (auditRoot ? "unknown" : null) : protectedIn(lines(out));
            if (hit) this.block(`git ${sub} from ${source} would change ${hit === "unknown" ? "files in the audit repo from a revision the guard cannot read" : hit}`);
          } else {
            const changed = protectedChanged([rel]);
            if (changed) this.block(`git ${sub} would discard an uncommitted change to ${changed}`);
          }
        }
        return;
      }
      case "rm":
      case "mv": {
        const dashes = opts.indexOf("--");
        const pathArgs = dashes >= 0 ? args.slice(dashes + 1) : args.filter((a, j) => !opts[j].startsWith("-"));
        for (const a of pathArgs) {
          if (!a.s || a.dyn) continue;
          const abs = resolve(cwd, a.s);
          const r = this.ctx.files.protectedReason(abs);
          if (r) {
            this.block(`git ${sub} would change ${r}`);
            continue;
          }
          const inside = this.ctx.files.protectedInside(abs);
          if (inside) this.block(`git ${sub} would remove or move a directory holding audit records: ${inside}`);
        }
        return;
      }
      case "clean": {
        if (!auditRoot) return;
        if (!opts.some((s) => s === "--force" || /^-[a-zA-Z]*f/.test(s))) return;
        const ignored = opts.some((s) => /^-[a-zA-Z]*[xX]/.test(s));
        const out = g(["ls-files", "--others", ...(ignored ? [] : ["--exclude-standard"]), "-z"]);
        const hit = lines(out).find((p) => this.ctx.files.protectedReason(resolve(cwd, p)));
        if (hit) this.block(`git clean would delete ${hit}, an untracked audit record`);
        return;
      }
      case "stash": {
        if (!auditRoot) return;
        const verb = opts.find((s) => !s.startsWith("-"));
        if (verb === "pop" || verb === "apply") {
          const ref = args.filter((a, j) => !opts[j].startsWith("-") && opts[j] !== verb)[0]?.s;
          const hit = protectedIn([...lines(g(["stash", "show", "--name-only", ...(ref ? [ref] : [])])), ...lines(g(["stash", "show", "--name-only", "--only-untracked", ...(ref ? [ref] : [])]))]);
          if (hit) this.block(`git stash ${verb} would change ${hit}`);
          return;
        }
        if (verb && !["push", "save"].includes(verb)) return;
        const specs = pathspecs().filter((a) => a.s).map((a) => relative(cwd, resolve(cwd, a.s)) || ".");
        const changed = protectedChanged(specs);
        if (changed) this.block(`git stash would take an uncommitted change to ${changed} out of the working tree`);
        return;
      }
      case "revert":
      case "cherry-pick": {
        if (!auditRoot) return;
        if (opts.some((s) => ["--continue", "--abort", "--skip", "--quit"].includes(s))) return;
        for (const a of args.filter((x, j) => !opts[j].startsWith("-"))) {
          if (!a.s) continue;
          const hit = commitTouches(a.s);
          if (hit) return this.block(`git ${sub} ${a.s} would commit a change to ${hit}`);
        }
        return;
      }
      case "update-ref":
        if (auditRoot) this.block("git update-ref in the audit repo can move or delete a branch, dropping commits that hold verdicts; only a person may do that");
        return;
      case "archive":
        for (let j = 0; j < args.length; j++) {
          if (opts[j] === "-o" || opts[j] === "--output") this.writeTarget(args[++j], gitScope, "git archive writes");
          else if (opts[j].startsWith("--output=")) this.writeTarget({ ...args[j], s: opts[j].slice(9), tail: opts[j].slice(9) }, gitScope, "git archive writes");
        }
        return;
      case "apply":
      case "am": {
        if (opts.includes("--check") || opts.includes("--stat") || opts.includes("--numstat") || opts.includes("--summary")) return;
        const files = args.filter((a) => !(a.s ?? "").startsWith("-") || a.s === "-");
        const texts = files.filter((f) => f.s !== "-").map((f) => this.scriptText(f, gitScope));
        if (!files.length || files.some((f) => f.s === "-")) texts.push(this.stdinText(info, scope));
        const t = top();
        for (const text of texts) {
          if (text === null) {
            if (auditRoot) this.block(`git ${sub} of a patch the guard cannot read, in the audit repo`);
            continue;
          }
          for (const p of diffPaths(text)) {
            const r = this.ctx.files.protectedReason(resolve(t, p));
            if (r) this.block(`git ${sub} would change ${r}`);
          }
        }
        return;
      }
      case "rebase": {
        if (!auditRoot || opts.some((s) => ["--abort", "--quit", "--show-current-patch", "--continue", "--skip", "-h", "--help"].includes(s))) return;
        // A plain rebase replays local commits onto the upstream; these options let it drop or rewrite them.
        if (opts.some((s) => /^(-i|--interactive|--onto|--root|--exec|-x|--edit-todo|--autosquash|-r|--rebase-merges|--empty=drop|--drop-empty)$/.test(s) || /^-[a-zA-Z]*i/.test(s))) this.block(`git rebase ${opts.find((s) => s.startsWith("-"))} rewrites the audit repo's history, which holds its verdicts and checkpoints; only a person may do that`);
        return;
      }
      case "filter-branch":
      case "filter-repo":
      case "replace":
        if (auditRoot && !opts.some((s) => ["-h", "--help", "-l", "--list"].includes(s))) this.block(`git ${sub} rewrites the audit repo's history, which holds its verdicts and checkpoints; only a person may do that`);
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

/**
 * A Makefile's (or justfile's) explicit rules: target → prerequisites and recipe lines (tab-indented for make,
 * indented for just; `target: prereqs ; recipe` too). `first` is the default goal.
 */
function parseRecipes(text, just) {
  const map = new Map();
  let first = null;
  let current = null;
  for (const raw of text.replace(/\\\n/g, " ").split("\n")) {
    if (current && (just ? /^[ \t]+\S/.test(raw) : raw.startsWith("\t"))) {
      current.recipe.push(raw.trim());
      continue;
    }
    const m = /^([^\s:#=][^:#=]*?)\s*::?(?!=)\s*([^;#]*?)\s*(?:;\s*(.*))?$/.exec(raw);
    if (m && !raw.startsWith("\t") && !/^\s*(export|include|define|ifeq|ifneq|ifdef|ifndef|else|endif|override)\b/.test(raw)) {
      const names = m[1].trim().split(/\s+/);
      current = { prereqs: m[2].split(/\s+/).filter(Boolean).filter((x) => !x.startsWith("$")), recipe: m[3] ? [m[3]] : [] };
      for (const n of names) {
        map.set(n, current);
        if (first === null && !n.startsWith(".") && !n.includes("%")) first = n;
      }
      continue;
    }
    if (raw.trim() && !raw.startsWith("\t")) current = null;
  }
  return { map, first };
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

const LABEL_MUTATION = /\b(addLabelsToLabelable|removeLabelsFromLabelable|clearLabelsFromLabelable|createLabel|updateLabel|deleteLabel|issueSetLabels|mergeRequestSetLabels|labelCreate|labelUpdate|labelDelete)\b|\b(updateIssue|createIssue|updatePullRequest|createPullRequest|updateMergeRequest|createMergeRequest|issueUpdate)\b[\s\S]{0,4000}?\b(labelIds|addLabelIds|removeLabelIds|labels)\b/;
/** A GitLab quick action that applies or removes labels, at the start of a line of a comment. */
const QUICK_ACTION = /(?:^|\n|\\n|[=:"])\s*\/(?:label|unlabel|relabel)\b([^\n\\]{0,400})/gi;

function decodeJsonEscapes(t) {
  return t.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** The URLs a curl URL glob stands for ({a,b} and [x-y]), at most 64. */
function curlGlobs(url) {
  let out = [url];
  for (let guard = 0; guard < 8; guard++) {
    const next = [];
    let changed = false;
    for (const u of out) {
      const brace = /\{([^{}]*)\}/.exec(u);
      const range = /\[([0-9a-zA-Z])-([0-9a-zA-Z])\]/.exec(u);
      const m = brace && (!range || brace.index < range.index) ? brace : range;
      if (!m) {
        next.push(u);
        continue;
      }
      changed = true;
      const alts = m === brace ? brace[1].split(",") : (() => {
        const a = m[1].charCodeAt(0);
        const z = m[2].charCodeAt(0);
        const r = [];
        for (let c = a; c <= z && r.length < 64; c++) r.push(String.fromCharCode(c));
        return r;
      })();
      for (const alt of alts) next.push(u.slice(0, m.index) + alt + u.slice(m.index + m[0].length));
    }
    out = next.slice(0, 64);
    if (!changed) break;
  }
  return out;
}

/** A string literal (in any of the usual quotes) that names an audit record. */
const RECORD_NAME_RE = String.raw`(?:registration\.json|manifest-commitment\.json|draws\.json|verdicts\.jsonl|ledger-index\.json|ledger-publication\.json|ledger-checkpoints\.jsonl|ledger-history|pr-rla\.lock\.json|\.pr-rla\.yml|approvals\.json|\.manifest\.json)`;
const RECORD_LIT = String.raw`['"` + "`" + String.raw`][^'"` + "`" + String.raw`\n]{0,300}?` + RECORD_NAME_RE + String.raw`[^'"` + "`" + String.raw`\n]{0,60}['"` + "`" + "]";
/** Calls that write, remove, move or truncate the path they are given first (node, Python, Ruby, Deno, Bun). */
const WRITE_FIRST = String.raw`(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync|symlink|symlinkSync|link|linkSync|writeTextFile|remove|removedirs|rmtree|write_text|write_bytes|move|IO\.write|File\.write|File\.delete|os\.remove|os\.unlink|os\.rename|os\.replace|os\.truncate|Bun\.write)`;
const RECORD_WRITES = [
  new RegExp(String.raw`\b${WRITE_FIRST}\s*\(\s*(?:[\w.]{1,40}\s*\(\s*)?` + RECORD_LIT, "i"),
  // copy and move: the record as the destination
  new RegExp(String.raw`\b(?:copyFile|copyFileSync|cp|cpSync|copy|copy2|copyfile|copytree|move|rename|renameSync|FileUtils\.\w+)\s*\([^,()\n]{0,300},\s*(?:[\w.]{1,40}\s*\(\s*)?` + RECORD_LIT, "i"),
  // open() with a mode that writes
  new RegExp(String.raw`\bopen(?:Sync)?\s*\(\s*(?:[\w.]{1,40}\s*\(\s*)?` + RECORD_LIT + String.raw`\s*\)?\s*,\s*(?:mode\s*=\s*|flags\s*:\s*)?['"][^'"]{0,6}[wax+]`, "i"),
  // pathlib
  new RegExp(String.raw`Path\(\s*` + RECORD_LIT + String.raw`\s*\)\s*\.\s*(?:open\s*\(\s*(?:mode\s*=\s*)?['"][^'"]{0,6}[wax+]|write_text|write_bytes|unlink|rename|replace|touch|rmdir)`, "i"),
  // Perl: open my $fh, ">>", "record" and open(FH, ">>record")
  new RegExp(String.raw`\bopen\s*\(?\s*(?:my\s+)?[$\w]{0,40}\s*,\s*['"](?:>|>>|\+<|\+>)['"]\s*,\s*` + RECORD_LIT),
  new RegExp(String.raw`\bopen\s*\(?\s*(?:my\s+)?[$\w]{0,40}\s*,\s*['"]\s*(?:>|>>|\+<|\+>)\s*[^'"\n]{0,300}?` + RECORD_NAME_RE),
];
/** A write call whose target is a variable: with a record name elsewhere in the code, it is counted as a write. */
const WRITE_TO_VARIABLE = new RegExp(String.raw`\b(?:${WRITE_FIRST})\s*\(\s*[A-Za-z_$][\w$.]{0,60}\s*[,)]|\bopen(?:Sync)?\s*\(\s*[A-Za-z_$][\w$.]{0,60}\s*,\s*(?:mode\s*=\s*|flags\s*:\s*)?['"][^'"]{0,6}[wax+]|Path\(\s*[A-Za-z_$][\w$.]{0,60}\s*\)\s*\.\s*(?:write_text|write_bytes|unlink|open\s*\(\s*['"][^'"]{0,6}[wax+])`, "i");

/**
 * Findings for code in another language (node -e, python -c, a script file, an awk program): a pr-rla write
 * command or API call, consent, signing in pr-rla's namespace, a verdict label sent anywhere, and (with
 * `records`) a write to a file named like an audit record. Every pattern is bounded, so no input makes it slow.
 */
function codeFindings(text, ctx) {
  const out = [];
  if (!text) return out;
  if (text.length > MAX_CODE) return [`code over ${MAX_CODE / 1024 / 1024} MiB is more than the guard reads; it blocks what it cannot read`];
  if (/\bpr-rla\b[^\n;|&]{0,80}?\b(record|register|freeze|sample|init)\b/.test(text) || /\bpr-rla\b[^\n;|&]{0,80}?\bplugin\b[^\n;|&]{0,40}?\b(approve|add|lock)\b/.test(text) || /\bpr-rla\b[^\n;|&]{0,120}?(--push|--sign|--submit)\b/.test(text)) out.push("code that runs a pr-rla write command (record, register, freeze, sample, init, plugin approve/add/lock, checkpoint --push, --sign, --submit); it is a person's own command");
  if (/(?:from\s*|require\(\s*|import\(\s*)['"]pr-rla(?:\/api\/write)?['"]/.test(text) && /\b(record|register|freeze|sample|checkpoint|initAudit|publishDraws|appendCheckpoint|commitPluginLock|approve|openLedger|ledgerFor|append|appendVerdict|writeJson)\s*\(/.test(text)) out.push("code that calls pr-rla's write functions; recording, registering, freezing and sampling are a person's own commands");
  if (/--accept-lock-grants|PR_RLA_(?:ACCEPT_LOCK_GRANTS|APPROVALS_FILE)['"\]]{0,2}\s*(?:=(?!=)|:)/.test(text)) out.push("code that sets pr-rla's consent (--accept-lock-grants, PR_RLA_ACCEPT_LOCK_GRANTS, PR_RLA_APPROVALS_FILE); only you give consent");
  if (text.includes(VERDICT_NAMESPACE) && /\bsign\b/i.test(text)) out.push(`code that signs in the ${VERDICT_NAMESPACE} namespace; the reviewer signs their own verdict`);
  const lower = text.toLowerCase();
  const labelHit = DEFAULT_LABELS.some((l) => lower.includes(l)) || /pr-rla['"\s+]{0,6}(?:::|:|-)['"\s+]{0,6}(?:pass|fail)\b/i.test(text);
  if (labelHit && (/\b(?:POST|PUT|PATCH|DELETE|add_labels|remove_labels|addLabels|removeLabels|addLabelsToLabelable|issueSetLabels|mergeRequestSetLabels)\b|--(?:add|remove)-label\b/.test(text) || /\bmethod\s*[:=]\s*['"](?:post|put|patch|delete)['"]/i.test(text) || /\brequests\.(?:post|put|patch|delete)\s*\(/i.test(text))) out.push("code that sends a pr-rla verdict label; the reviewer applies it themselves");
  if (ctx.records && (RECORD_WRITES.some((re) => re.test(text)) || (new RegExp(RECORD_NAME_RE, "i").test(text) && WRITE_TO_VARIABLE.test(text)))) out.push("code that writes a file named like a pr-rla audit record");
  return out;
}

/** String literals in code that hold a command line, and lists of literals (argv) joined into one. */
function commandLiterals(text) {
  const out = [];
  if (text.length > MAX_CODE) return out;
  for (const m of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n]){3,4000})\1/g)) if (/\s/.test(m[2])) out.push(m[2].replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n"));
  for (const m of text.matchAll(/\[\s*((?:(['"])[^'"\n]{0,400}\2\s*,\s*){1,40}(['"])[^'"\n]{0,400}\3)\s*,?\s*\]/g)) {
    const items = [...m[1].matchAll(/(['"])([^'"\n]{0,400})\1/g)].map((x) => x[2]);
    out.push(items.map((x) => shq(x)).join(" "));
  }
  return out.slice(0, 200);
}

/** Thrown when the decision runs past its time budget; the call is then blocked. */
class GuardTimeout extends Error {}

const gitCache = new Map();
function runGit(args, cwd) {
  const key = `${cwd}\0${args.join("\0")}`;
  if (gitCache.has(key)) return gitCache.get(key);
  const out = runGitNow(args, cwd);
  gitCache.set(key, out);
  return out;
}

function runGitNow(args, cwd) {
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
  gitCache.clear(); // one evaluation sees one state of each repository
  // zsh glob qualifiers run code: *(e:'cmd':)
  for (const m of text.slice(0, MAX_COMMAND).matchAll(/\(e:(['"])(.{1,2000}?)\1:?\)/g)) sh.script(m[2], new Scope(ctx.cwd, new Map(vars), ctx.home), 1);
  try {
    sh.script(text, new Scope(ctx.cwd, vars, ctx.home));
  } catch (e) {
    if (e instanceof GuardTimeout) sh.block(`reading this command took the guard more than ${TIME_BUDGET_MS / 1000} s; it blocks what it could not finish reading`);
    else sh.block(`the guard could not read this command (${e?.message ?? e}); it blocks what it cannot read`);
  }
  if (sh.runsPrRla && sh.setsConfigHome) sh.block("the command changes HOME or XDG_CONFIG_HOME and runs pr-rla, which would then read another approvals file");
  return sh.findings;
}

/** A Codex-style argv (["bash", "-lc", "…"]) as one script. */
function argvToScript(argv) {
  if (argv.length >= 3 && /(^|\/)(ba|z|da|k)?sh$/.test(String(argv[0])) && /^-[a-z]*c[a-z]*$/.test(String(argv[1]))) return String(argv[2]);
  return argv.map((a) => shq(String(a))).join(" ");
}

export function checkWritePaths(paths, { cwd = process.cwd(), env = process.env } = {}, verb = "writes", content = null) {
  const ctx = makeCtx(cwd, env);
  const out = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    const abs = resolve(ctx.cwd, p.startsWith("~/") ? join(ctx.home, p.slice(2)) : p);
    const r = ctx.files.protectedReason(abs);
    if (r) out.push(`this edit ${verb} ${r}; only pr-rla's own commands, run by a person, change audit records`);
    const c = consentInStartupFile(abs, content);
    if (c) out.push(`this edit ${verb} ${ctx.files.show(abs)}: ${c}`);
  }
  return out;
}

export function checkReadPaths(paths, { cwd = process.cwd(), env = process.env } = {}) {
  const ctx = makeCtx(cwd, env);
  const out = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    const abs = resolve(ctx.cwd, p.startsWith("~/") ? join(ctx.home, p.slice(2)) : p);
    if (ctx.files.isSigningKey(abs)) out.push(`reading ${ctx.files.show(abs)}, the audit's signing key, would let the assistant sign audit records`);
    else if (ctx.files.isKeyDir(abs)) out.push(`reading ${ctx.files.show(abs)}, the directory that holds the audit's signing key, would let the assistant sign audit records`);
  }
  return out;
}

/**
 * Another MCP server's tool: a verdict label in its input (a label field, a quick action, a request body), a write
 * to a record, a shell command or code it would run (`command` with `args`, `cmd`, `script`, `code`), or an HTTP
 * request that writes a label.
 */
export function checkMcp(toolName, input, { cwd = process.cwd(), env = process.env } = {}) {
  const ctx = makeCtx(cwd, env);
  const sh = new ShellCheck(ctx);
  const scope = new Scope(ctx.cwd, new Map([["HOME", ctx.home]]), ctx.home);
  const out = [];
  const roots = [ctx.files.auditRootOf(ctx.cwd)].filter(Boolean);
  const short = String(toolName).split(/__|:/).pop() ?? String(toolName);
  const writes = /(write|edit|create|update|delete|remove|move|rename|append|put|patch|push|commit|upload|set|add|label|replace|save|store|copy|cp|mv|rm|del|unlink|touch|truncate|link|sync|restore|reset|apply|post|send)/i.test(short);
  let visited = 0;
  const visit = (v, key, depth) => {
    if (depth > 12 || ++visited > 5000) return;
    if (typeof v === "string") {
      const labelKey = /label/i.test(key ?? "");
      if (ctx.files.isVerdictLabel(v, roots) || (labelKey && splitLabels(v).some((x) => sh.hasVerdictLabel(x, scope)))) out.push(`${toolName} carries the pr-rla verdict label "${v.trim()}"; the reviewer applies it themselves, in the tracker`);
      if (sh.quickActionLabel(v, scope)) out.push(`${toolName} posts a GitLab quick action that applies or removes a pr-rla verdict label; the reviewer applies it themselves`);
      if (/^(command|cmd|script|shell|bash|sh)$/i.test(key ?? "")) for (const f of checkShell(v, { cwd: ctx.cwd, env })) out.push(`${toolName} would run a command that ${f}`);
      if (/^(code|source|program|python|javascript|js|cell)$/i.test(key ?? "")) {
        sh.code(v, undefined, { scope });
        for (const f of sh.findings.splice(0)) out.push(`${toolName} would run code that ${f.replace(/^code that /, "")}`);
      }
      if (writes && v.length < 4096 && !v.includes("\n") && (/[\\/]/.test(v) || /\.(jsonl?|ya?ml|pem)$/i.test(v))) {
        const r = ctx.files.protectedReason(resolve(ctx.cwd, v.startsWith("~/") ? join(ctx.home, v.slice(2)) : v));
        if (r) out.push(`${toolName} would change ${r}`);
      }
      // A JSON document passed as a string (an HTTP body): read it too.
      if (/^\s*[[{]/.test(v) && v.length < MAX_CODE) {
        try {
          visit(JSON.parse(v), key, depth + 1);
        } catch {
          /* not JSON */
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      // A shell tool that takes argv: { command: "pr-rla", args: ["record", …] }
      const cmd = typeof v.command === "string" ? v.command : typeof v.cmd === "string" ? v.cmd : null;
      const argv = Array.isArray(v.args) ? v.args : Array.isArray(v.argv) ? v.argv : null;
      if (cmd !== null && argv) for (const f of checkShell([cmd, ...argv.map(String)], { cwd: ctx.cwd, env })) out.push(`${toolName} would run a command that ${f}`);
      // An HTTP request tool: { method, url, body }
      if (typeof v.url === "string" && typeof v.method === "string") {
        const body = v.body ?? v.data ?? v.json ?? null;
        const r = sh.labelWrite(v.method, v.url, [body === null ? "" : typeof body === "string" ? body : JSON.stringify(body)], scope);
        if (r) out.push(`${toolName} ${r}`);
      }
      for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
    }
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

/** The text a file edit writes (Write's content, Edit's new_string, MultiEdit's edits), for the startup-file check. */
function newContent(input) {
  if (!input || typeof input !== "object") return null;
  const parts = [input.content, input.contents, input.new_string, input.new_source, input.code_edit, ...(Array.isArray(input.edits) ? input.edits.map((e) => e?.new_string) : [])].filter((x) => typeof x === "string");
  return parts.length ? parts.join("\n") : null;
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
      else if (/write|edit|delete|patch|replace|create|move|rename|append/i.test(tool)) {
        const paths = pathFields(input);
        if (!paths.length && input && typeof input === "object") for (const v of Object.values(input)) if (typeof v === "string" && !v.includes("\n") && v.length < 4096) paths.push(v);
        reasons = checkWritePaths(paths, opts(), /delete/i.test(tool) ? "removes" : "writes", newContent(input));
        if (typeof input?.patch === "string") reasons.push(...checkWritePaths(diffPaths(input.patch), opts()));
      }
    }
  } else if (c === "codex") {
    if (tool === "Bash" || tool === "shell" || tool === "exec_command" || tool === "local_shell") reasons = checkShell(input?.command ?? input?.cmd ?? "", { cwd: input?.workdir ?? cwd, env });
    else if (tool === "apply_patch") reasons = checkWritePaths(diffPaths(String(input?.command ?? input?.patch ?? input?.input ?? "")), opts());
    else if (tool.startsWith("mcp__")) reasons = checkMcp(tool, input, opts());
  } else {
    if (tool === "Bash" || tool === "PowerShell" || tool === "Monitor") reasons = checkShell(input?.command ?? "", opts());
    else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) reasons = checkWritePaths(pathFields(input), opts(), "writes", newContent(input));
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
