/**
 * `linguist-generated` from `.gitattributes` files, with git's own semantics (functional-design.md
 * §U5; FR3.4; U5 fix round): which changed files `draw-context` drops when the registration's
 * selector has `exclude_generated`. Pure.
 *
 * It follows git's attr.c and wildmatch.c (checked against `git check-attr` by
 * `test/generated-git.test.ts`), not a regular-expression translation:
 * - **Lines.** Blank lines and lines whose first non-blank character is `#` are comments. The pattern
 *   is the first blank-separated token, or a C-quoted string (`"a b.txt"`; a malformed quote is taken
 *   literally). Each attribute is `name` (set), `-name` (unset), `!name` (unspecified) or
 *   `name=value`. A line with any invalid attribute name (`#`, `a,b`, a lone `-`, `builtin_*`) is
 *   ignored whole, as git ignores it; so is a line of 2,048 bytes or more, and a negative pattern.
 * - **Macros.** `[attr]name attr…` defines a macro, in the root file only (git ignores it elsewhere);
 *   the last definition wins wherever it is; `binary` is built in (`-diff -merge -text`). A macro set
 *   to true expands, recursively, at its place on its line.
 * - **Precedence.** For a path, the deeper `.gitattributes` beats the shallower, and a later line beats
 *   an earlier one; an attribute is decided by the first line that mentions it in that order.
 * - **Patterns.** A pattern with no `/` (a trailing one aside) matches the file name at any depth;
 *   otherwise it is matched, with its leading `/` removed, against the path relative to the
 *   attribute file's directory (WM_PATHNAME). A trailing `/` names a directory, which matches no
 *   file. `*` and `?` stop at `/`; `**` crosses it at the start (`**` + `/`), the end (`/**`), between
 *   slashes or alone, and is a plain `*` anywhere else. Classes follow wildmatch: `!` or `^` negates,
 *   `a-z` ranges (a reversed one matches nothing), `[:alpha:]` and the other POSIX names, `\`
 *   escapes, a leading `]` is literal, and no class matches `/`. An unclosed class, a malformed
 *   `[:name:]` or a trailing `\` makes the pattern match nothing. Matching is on UTF-8 bytes.
 *
 * Matching is a linear-time automaton over the pattern (no backtracking: a hostile pattern costs at
 * most its length times the path's), and a work budget bounds a whole draw context. Whatever cannot
 * be decided (a directory whose file was not read, a file over the size limit, the budget run out)
 * is null: the caller treats it as not generated, so the file is shown.
 */

export type AttrState = true | false | "unspecified" | string;

/** git's limit: a line this long or longer is ignored (attr.c, ATTR_MAX_LINE_LENGTH). */
export const ATTR_MAX_LINE_BYTES = 2048;
/** pr-rla's limit on one `.gitattributes` file: a larger one decides nothing (the paths under it are shown). */
export const ATTR_MAX_FILE_BYTES = 1024 * 1024;
/** Automaton steps one draw context may spend on attribute matching before it gives up (and shows the rest). */
export const ATTR_WORK_BUDGET = 50_000_000;

export interface AttrBudget {
  left: number;
}
export const attrBudget = (n = ATTR_WORK_BUDGET): AttrBudget => ({ left: n });

const BLANK = new Set([0x20, 0x09, 0x0d, 0x0a]);
const SLASH = 0x2f;

// ---------------------------------------------------------------------------
// wildmatch, as an automaton
// ---------------------------------------------------------------------------

type Tok =
  | { t: "lit"; b: number }
  | { t: "one" }
  | { t: "class"; set: Uint8Array }
  /** `*`: any run of bytes, with no `/` under WM_PATHNAME. */
  | { t: "star" }
  /** `**`: any run of bytes, `/` included. */
  | { t: "any" }
  /** The start of a `**` + `/` group: it may be skipped whole (zero directories), to `skip` tokens on. */
  | { t: "opt"; skip: number };

export interface CompiledPattern {
  /** null: the pattern can match nothing (git aborts on it). */
  toks: Tok[] | null;
  pathname: boolean;
}

const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const POSIX: Record<string, (c: number) => boolean> = {
  alnum: (c) => isAlpha(c) || isDigit(c),
  alpha: isAlpha,
  blank: (c) => c === 0x20 || c === 0x09,
  cntrl: (c) => c < 0x20 || c === 0x7f,
  digit: isDigit,
  graph: (c) => c > 0x20 && c < 0x7f,
  lower: (c) => c >= 0x61 && c <= 0x7a,
  print: (c) => c >= 0x20 && c < 0x7f,
  punct: (c) => c > 0x20 && c < 0x7f && !isAlpha(c) && !isDigit(c),
  space: (c) => c === 0x20 || (c >= 0x09 && c <= 0x0d),
  upper: (c) => c >= 0x41 && c <= 0x5a,
  xdigit: (c) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66),
};

/** A `[...]` class whose body starts at p (just after `[`): its byte set and the index after its `]`, or null when git aborts on it. */
function parseClass(pat: Uint8Array, p: number, pathname: boolean): { set: Uint8Array; next: number } | null {
  const set = new Uint8Array(256);
  let negated = false;
  if (pat[p] === 0x21 /* ! */ || pat[p] === 0x5e /* ^ */) {
    negated = true;
    p++;
  }
  let prev = -1; // the previous member byte, a range's low end (wildmatch's prev_ch; -1 for none)
  let first = true;
  for (;;) {
    if (p >= pat.length) return null;
    let c = pat[p]!;
    if (c === 0x5d /* ] */ && !first) break;
    first = false;
    if (c === 0x5c /* \ */) {
      p++;
      if (p >= pat.length) return null;
      c = pat[p]!;
      set[c] = 1;
      prev = c;
      p++;
      continue;
    }
    if (c === 0x2d /* - */ && prev >= 0 && p + 1 < pat.length && pat[p + 1] !== 0x5d) {
      p++;
      let hi = pat[p]!;
      if (hi === 0x5c) {
        p++;
        if (p >= pat.length) return null;
        hi = pat[p]!;
      }
      for (let x = prev; x <= hi; x++) set[x] = 1;
      prev = -1;
      p++;
      continue;
    }
    if (c === 0x5b /* [ */ && pat[p + 1] === 0x3a /* : */) {
      let q = p + 2;
      while (q < pat.length && pat[q] !== 0x5d) q++;
      if (q >= pat.length) return null;
      if (q - (p + 2) - 1 < 0 || pat[q - 1] !== 0x3a) {
        // No ":]": the "[" is a member, and the scan goes on after it.
        set[0x5b] = 1;
        prev = 0x5b;
        p++;
        continue;
      }
      const fn = POSIX[Buffer.from(pat.subarray(p + 2, q - 1)).toString("latin1")];
      if (!fn) return null;
      for (let x = 0; x < 256; x++) if (fn(x)) set[x] = 1;
      prev = -1;
      p = q + 1;
      continue;
    }
    set[c] = 1;
    prev = c;
    p++;
  }
  if (negated) for (let x = 0; x < 256; x++) set[x] = set[x] ? 0 : 1;
  if (pathname) set[SLASH] = 0;
  return { set, next: p + 1 };
}

/** Compiles a wildmatch pattern (`pathname`: WM_PATHNAME, as git uses for patterns with a slash). */
export function compilePattern(pattern: Uint8Array | string, pathname: boolean): CompiledPattern {
  const pat = typeof pattern === "string" ? Buffer.from(pattern, "utf8") : pattern;
  const toks: Tok[] = [];
  for (let p = 0; p < pat.length; ) {
    const c = pat[p]!;
    if (c === 0x5c) {
      if (p + 1 >= pat.length) return { toks: null, pathname }; // a trailing backslash matches nothing
      toks.push({ t: "lit", b: pat[p + 1]! });
      p += 2;
    } else if (c === 0x3f) {
      toks.push({ t: "one" });
      p++;
    } else if (c === 0x5b) {
      const k = parseClass(pat, p + 1, pathname);
      if (!k) return { toks: null, pathname };
      toks.push({ t: "class", set: k.set });
      p = k.next;
    } else if (c === 0x2a) {
      const start = p;
      while (pat[p] === 0x2a) p++;
      if (p - start >= 2) {
        const atStart = start === 0 || pat[start - 1] === SLASH;
        const next = pat[p];
        const special = atStart && (next === undefined || next === SLASH || (next === 0x5c && pat[p + 1] === SLASH));
        if (!special) toks.push({ t: pathname ? "star" : "any" });
        else if (next === SLASH) {
          // "**/": zero directories (the group skipped whole), or any run that ends in "/".
          toks.push({ t: "opt", skip: 3 }, { t: "any" }, { t: "lit", b: SLASH });
          p++;
        } else toks.push({ t: "any" });
      } else toks.push({ t: pathname ? "star" : "any" });
    } else {
      toks.push({ t: "lit", b: c });
      p++;
    }
  }
  return { toks, pathname };
}

/**
 * Whether `text` matches the compiled pattern, by simulating the automaton: at most (tokens + 1)
 * states per byte, charged to the budget. Returns null when the budget runs out.
 */
export function matchCompiled(cp: CompiledPattern, text: Uint8Array, budget: AttrBudget = attrBudget()): boolean | null {
  const toks = cp.toks;
  if (!toks) return false;
  const n = toks.length;
  let cur = new Uint8Array(n + 1);
  let nxt = new Uint8Array(n + 1);
  const add = (set: Uint8Array, i: number, out: number[]) => {
    // The epsilon closure: a star may repeat zero times, an "opt" group may be skipped.
    const stack = [i];
    while (stack.length) {
      const j = stack.pop()!;
      if (set[j]) continue;
      set[j] = 1;
      out.push(j);
      if (j < n) {
        const tk = toks[j]!;
        if (tk.t === "star" || tk.t === "any") stack.push(j + 1);
        else if (tk.t === "opt") stack.push(j + 1, j + tk.skip);
      }
    }
  };
  let states: number[] = [];
  add(cur, 0, states);
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    const out: number[] = [];
    budget.left -= states.length + 1;
    if (budget.left < 0) return null;
    for (const j of states) {
      if (j >= n) continue;
      const tk = toks[j]!;
      switch (tk.t) {
        case "lit":
          if (tk.b === c) add(nxt, j + 1, out);
          break;
        case "one":
          if (!(cp.pathname && c === SLASH)) add(nxt, j + 1, out);
          break;
        case "class":
          if (tk.set[c]) add(nxt, j + 1, out);
          break;
        case "star":
          if (!(cp.pathname && c === SLASH)) add(nxt, j, out);
          break;
        case "any":
          add(nxt, j, out);
          break;
        case "opt":
          break;
      }
    }
    for (const j of states) cur[j] = 0;
    if (!out.length) return false;
    [cur, nxt] = [nxt, cur];
    states = out;
  }
  return cur[n] === 1;
}

// ---------------------------------------------------------------------------
// .gitattributes files
// ---------------------------------------------------------------------------

/** One attribute setting on a line, as git parses it. */
export interface AttrSetting {
  name: string;
  state: AttrState;
}

/** One pattern line (not a macro), with its matcher. */
export interface AttrRule {
  /** The pattern as written (unquoted, without a trailing "/"). */
  pattern: string;
  settings: AttrSetting[];
  line: number;
  /** A trailing "/": it names a directory, so it matches no file. */
  mustBeDir: boolean;
  /** No "/" in the pattern: it matches the file name. */
  basename: boolean;
  compiled: CompiledPattern;
}

export interface AttrFile {
  rules: AttrRule[];
  /** `[attr]` macro definitions (the root file only), by name, the last one winning. */
  macros: Map<string, AttrSetting[]>;
  /** Set when the file is over pr-rla's size limit: it then decides nothing. */
  problem: string | null;
}

/** git's attr_name_valid and attr_name_reserved. */
function attrNameValid(name: Uint8Array): boolean {
  if (name.length === 0 || name[0] === 0x2d) return false;
  for (const c of name) if (!(c === 0x2d || c === 0x2e || c === 0x5f || isDigit(c) || isAlpha(c))) return false;
  return !Buffer.from(name).toString("latin1").startsWith("builtin_");
}

const spanBlank = (b: Uint8Array, i: number) => {
  while (i < b.length && BLANK.has(b[i]!)) i++;
  return i;
};
const spanToken = (b: Uint8Array, i: number) => {
  while (i < b.length && !BLANK.has(b[i]!)) i++;
  return i;
};

/** git's unquote_c_style on a quoted pattern (b[0] is '"'): its bytes and the index after the closing quote, or null when malformed. */
function unquoteC(b: Uint8Array): { bytes: Uint8Array; end: number } | null {
  const out: number[] = [];
  const ESC: Record<number, number> = { 0x61: 7, 0x62: 8, 0x66: 12, 0x6e: 10, 0x72: 13, 0x74: 9, 0x76: 11, 0x5c: 0x5c, 0x22: 0x22 };
  for (let i = 1; i < b.length; i++) {
    const c = b[i]!;
    if (c === 0x22) return { bytes: Uint8Array.from(out), end: i + 1 };
    if (c !== 0x5c) {
      out.push(c);
      continue;
    }
    const e = b[++i];
    if (e === undefined) return null;
    if (e >= 0x30 && e <= 0x33) {
      const d1 = b[i + 1];
      const d2 = b[i + 2];
      if (d1 === undefined || d2 === undefined || d1 < 0x30 || d1 > 0x37 || d2 < 0x30 || d2 > 0x37) return null;
      out.push(((e - 0x30) << 6) | ((d1 - 0x30) << 3) | (d2 - 0x30));
      i += 2;
    } else if (ESC[e] !== undefined) out.push(ESC[e]!);
    else return null;
  }
  return null;
}

/** git's parse_attr over the states part of a line: the settings, or null when any name is invalid (git then ignores the line). */
function parseStates(b: Uint8Array, i: number): AttrSetting[] | null {
  const out: AttrSetting[] = [];
  i = spanBlank(b, i);
  while (i < b.length) {
    const ep = spanToken(b, i);
    let eq = -1;
    for (let k = i; k < ep; k++)
      if (b[k] === 0x3d) {
        eq = k;
        break;
      }
    const prefix = b[i];
    const negOrUnset = prefix === 0x2d || prefix === 0x21;
    const name = b.subarray(negOrUnset ? i + 1 : i, eq >= 0 ? eq : ep);
    if (!attrNameValid(name)) return null;
    const n = Buffer.from(name).toString("latin1");
    if (negOrUnset) out.push({ name: n, state: prefix === 0x2d ? false : "unspecified" });
    else if (eq < 0) out.push({ name: n, state: true });
    else out.push({ name: n, state: Buffer.from(b.subarray(eq + 1, ep)).toString("utf8") });
    i = spanBlank(b, ep);
  }
  return out;
}

const MACRO = Buffer.from("[attr]", "latin1");
const startsWith = (b: Uint8Array, p: Uint8Array) => b.length >= p.length && p.every((x, k) => b[k] === x);

/** Parses one `.gitattributes` file. `root`: the repository's top-level file, the only one whose macros count. */
export function parseAttrFile(text: string, opts: { root: boolean } = { root: true }): AttrFile {
  const all = Buffer.from(text, "utf8");
  const file: AttrFile = { rules: [], macros: new Map(), problem: null };
  if (all.length > ATTR_MAX_FILE_BYTES) {
    file.problem = `a .gitattributes of ${all.length.toLocaleString("en-US")} bytes, over pr-rla's ${ATTR_MAX_FILE_BYTES.toLocaleString("en-US")}-byte limit`;
    return file;
  }
  let start = 0;
  let lineNo = 0;
  for (let k = 0; k <= all.length; k++) {
    if (k < all.length && all[k] !== 0x0a) continue;
    const line = all.subarray(start, k);
    start = k + 1;
    lineNo++;
    if (line.length >= ATTR_MAX_LINE_BYTES) continue;
    const cp = spanBlank(line, 0);
    if (cp >= line.length || line[cp] === 0x23 /* # */) continue;
    let name: Uint8Array;
    let states: number;
    const q = line[cp] === 0x22 ? unquoteC(line.subarray(cp)) : null;
    if (q) {
      name = q.bytes;
      states = cp + q.end;
    } else {
      const end = spanToken(line, cp);
      name = line.subarray(cp, end);
      states = end;
    }
    if (name.length > MACRO.length && startsWith(name, MACRO)) {
      if (!opts.root) continue; // macros are allowed in the top-level file only
      let m = name.subarray(MACRO.length);
      m = m.subarray(spanBlank(m, 0));
      m = m.subarray(0, spanToken(m, 0));
      if (!attrNameValid(m)) continue;
      const settings = parseStates(line, states);
      if (settings) file.macros.set(Buffer.from(m).toString("latin1"), settings);
      continue;
    }
    if (name[0] === 0x21 /* ! */) continue; // negative patterns are ignored in git attributes
    const settings = parseStates(line, states);
    if (!settings) continue;
    let pat = name;
    let mustBeDir = false;
    if (pat.length && pat[pat.length - 1] === SLASH) {
      pat = pat.subarray(0, pat.length - 1);
      mustBeDir = true;
    }
    const basename = !pat.includes(SLASH);
    const forMatch = !basename && pat[0] === SLASH ? pat.subarray(1) : pat;
    file.rules.push({ pattern: Buffer.from(pat).toString("utf8"), settings, line: lineNo, mustBeDir, basename, compiled: compilePattern(forMatch, !basename) });
  }
  return file;
}

/** git's built-in macro. */
const BUILTIN_MACROS: ReadonlyMap<string, AttrSetting[]> = new Map([["binary", [{ name: "diff", state: false }, { name: "merge", state: false }, { name: "text", state: false }]]]);

/** Whether a rule of the attribute file in `dir` matches the repository path `path` (bytes; `dir` "" is the root). */
function ruleMatches(r: AttrRule, dir: string, path: Uint8Array, budget: AttrBudget): boolean | null {
  if (r.mustBeDir) return false;
  const rel = path.subarray(dir === "" ? 0 : Buffer.byteLength(dir, "utf8") + 1);
  if (r.basename) {
    let s = rel.length;
    while (s > 0 && rel[s - 1] !== SLASH) s--;
    return matchCompiled(r.compiled, rel.subarray(s), budget);
  }
  return matchCompiled(r.compiled, rel, budget);
}

/** The directories whose `.gitattributes` apply to `path`, the root ("") first. */
export function attributeDirs(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

/**
 * The named attributes of `path`, git's way, from the attribute files of a commit (`files.get(dir)`:
 * the parsed file, or null when that directory has none; a directory missing from the map was not
 * read). Null when it cannot be decided: a directory not read, a file over the limit, the budget
 * run out.
 */
export function attributesFor(files: ReadonlyMap<string, AttrFile | null>, path: string, names: readonly string[], budget: AttrBudget = attrBudget()): Map<string, AttrState> | null {
  const stack: { dir: string; file: AttrFile }[] = [];
  for (const d of attributeDirs(path)) {
    if (!files.has(d)) return null;
    const f = files.get(d);
    if (!f) continue;
    if (f.problem) return null;
    stack.push({ dir: d, file: f });
  }
  const macros = new Map(BUILTIN_MACROS);
  for (const [k, v] of files.get("")?.macros ?? []) macros.set(k, v);
  // The attributes that matter: the asked ones, and every macro that can set one, transitively.
  const relevant = new Set(names);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [m, defs] of macros)
      if (!relevant.has(m) && defs.some((d) => relevant.has(d.name))) {
        relevant.add(m);
        grew = true;
      }
  }
  const decided = new Map<string, AttrState>();
  const fill = (settings: readonly AttrSetting[], depth: number) => {
    for (let k = settings.length - 1; k >= 0; k--) {
      const s = settings[k]!;
      if (!relevant.has(s.name) || decided.has(s.name)) continue;
      decided.set(s.name, s.state);
      const def = s.state === true && depth < 64 ? macros.get(s.name) : undefined;
      if (def) fill(def, depth + 1);
    }
  };
  const bytes = Buffer.from(path, "utf8");
  for (let i = stack.length - 1; i >= 0; i--) {
    const { dir, file } = stack[i]!;
    for (let k = file.rules.length - 1; k >= 0; k--) {
      const r = file.rules[k]!;
      if (!r.settings.some((s) => relevant.has(s.name) && !decided.has(s.name))) continue;
      const m = ruleMatches(r, dir, bytes, budget);
      if (m === null) return null;
      if (m) fill(r.settings, 0);
    }
  }
  return new Map(names.map((n) => [n, decided.get(n) ?? "unspecified"]));
}

/** Linguist's reading: `linguist-generated` set, or `=true` (any case). */
export const isGeneratedState = (s: AttrState | undefined): boolean => s === true || (typeof s === "string" && s.toLowerCase() === "true");

/** `linguist-generated` for a path from a commit's attribute files, or null when it cannot be decided. */
export function linguistGenerated(files: ReadonlyMap<string, AttrFile | null>, path: string, budget: AttrBudget = attrBudget()): boolean | null {
  const a = attributesFor(files, path, ["linguist-generated"], budget);
  return a === null ? null : isGeneratedState(a.get("linguist-generated"));
}

/** Parsed attribute files from a provider's map (directory → text, or null when that directory has none). */
export function attrFiles(texts: Readonly<Record<string, string | null>>): Map<string, AttrFile | null> {
  return new Map(Object.entries(texts).map(([dir, t]) => [dir, t === null ? null : parseAttrFile(t, { root: dir === "" })]));
}

/** True for a `.gitattributes` file at any depth: never generated, and a change touching one drops nothing. */
export const isAttributesFile = (path: string) => path === ".gitattributes" || path.endsWith("/.gitattributes");

// ---------------------------------------------------------------------------
// One root file alone (tests, and the providers' choice of directories to read)
// ---------------------------------------------------------------------------

/** One root `.gitattributes`, parsed. */
export function parseGitattributes(text: string): AttrFile {
  return parseAttrFile(text, { root: true });
}

/** The state of one attribute for a path under a single root file (no file in any subdirectory). */
export function attributeFor(file: AttrFile, path: string, attr: string): AttrState {
  const dirs = attributeDirs(path);
  return attributesFor(new Map<string, AttrFile | null>(dirs.map((d) => [d, d === "" ? file : null])), path, [attr])?.get(attr) ?? "unspecified";
}

/** True when a single root `.gitattributes` marks the path `linguist-generated` (no file in any subdirectory). */
export function isLinguistGenerated(file: AttrFile, path: string): boolean {
  return isGeneratedState(attributeFor(file, path, "linguist-generated"));
}

/** A root-level pattern as a matcher (tests), or null when it can match no file (a directory pattern, a negative one). */
export function patternMatcher(pattern: string): ((path: string) => boolean) | null {
  const file = parseAttrFile(`${pattern} x`);
  const r = file.rules[0];
  if (!r || r.mustBeDir) return null;
  return (path) => ruleMatches(r, "", Buffer.from(path, "utf8"), attrBudget()) === true;
}
