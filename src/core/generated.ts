/**
 * `linguist-generated` from a `.gitattributes` file (functional-design.md §U5; FR3.4): which
 * changed files `draw-context` drops when the registration's selector has `exclude_generated`.
 *
 * Pure. It follows gitattributes(5):
 * - one `pattern attr…` per line; blank lines and `#` comments are ignored; a pattern may be
 *   C-quoted (`"a b.txt"`); `[attr]name attr…` defines a macro, which a later line that sets
 *   `name` expands (the built-in `binary` macro sets none of Linguist's attributes);
 * - `attr` and `attr=true` set it, `-attr` and `attr=false` unset it, `!attr` makes it unspecified;
 *   the last line that mentions the attribute for a path wins;
 * - patterns match as in gitignore(5), except that negative patterns are forbidden and a pattern
 *   that names a directory (`dir/`) does not match the files inside it (`dir/**` does). A pattern
 *   with a `/` at its start or in its middle is anchored at the repository root; otherwise it
 *   matches the file name at any depth. `*` and `?` stop at `/`; `**` crosses it as `**\/`,
 *   `/**` and `/**\/`.
 *
 * Only the root `.gitattributes` is read (the one `describeChange` returns); files in
 * subdirectories and Linguist's built-in heuristics (vendored, minified) are not.
 */

export type AttrState = true | false | "unspecified" | string;

export interface AttrRule {
  /** The pattern as written (unquoted). */
  pattern: string;
  /** Matches a repository-relative, `/`-separated path. */
  match: (path: string) => boolean;
  /** Attributes this line mentions. */
  attrs: Map<string, AttrState>;
  line: number;
}

/** C-style unquoting for a quoted pattern (`"a\tb"`). */
function unquote(q: string): string {
  let out = "";
  for (let i = 1; i < q.length - 1; i++) {
    const c = q[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = q[++i] ?? "";
    if (/[0-7]/.test(n)) {
      const oct = q.slice(i, i + 3);
      out += String.fromCharCode(parseInt(oct, 8));
      i += oct.length - 1;
    } else out += ({ n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" } as Record<string, string>)[n] ?? n;
  }
  return out;
}

/** Splits a line into its pattern and the rest (the attributes). */
function splitLine(line: string): { pattern: string; rest: string } | null {
  if (line.startsWith('"')) {
    let i = 1;
    for (; i < line.length; i++) {
      if (line[i] === "\\") i++;
      else if (line[i] === '"') break;
    }
    if (i >= line.length) return null;
    return { pattern: unquote(line.slice(0, i + 1)), rest: line.slice(i + 1) };
  }
  const m = /^(\S+)(.*)$/.exec(line);
  return m ? { pattern: m[1]!, rest: m[2]! } : null;
}

const RE_SPECIAL = /[.+^${}()|\\]/;

/** One glob segment run (no `**` handling) to a regular expression source. */
function globToRegex(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "\\" && i + 1 < glob.length) {
      const n = glob[++i]!;
      re += RE_SPECIAL.test(n) || n === "*" || n === "?" || n === "[" || n === "]" ? `\\${n}` : n;
    } else if (c === "*") {
      while (glob[i + 1] === "*") i++; // other runs of asterisks are one "*"
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close < 0) {
        re += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      const negate = body.startsWith("!") || body.startsWith("^");
      if (negate) body = body.slice(1);
      re += `[${negate ? "^" : ""}${body.replace(/\\/g, "\\\\").replace(/\//g, "")}]`;
      i = close;
    } else re += RE_SPECIAL.test(c) ? `\\${c}` : c;
  }
  return re;
}

/** A gitattributes pattern as a matcher for repository-relative file paths, or null if it can match no file. */
export function patternMatcher(pattern: string): ((path: string) => boolean) | null {
  if (pattern.length === 0 || pattern.startsWith("!")) return null; // negative patterns are forbidden in gitattributes
  if (pattern.endsWith("/")) return null; // names a directory, which does not match the files inside it
  let p = pattern;
  const anchoredBySlash = p.startsWith("/") || p.slice(0, -1).includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  const parts = p.split("/");
  let re = "";
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    const last = i === parts.length - 1;
    if (seg === "**") {
      if (last) re += i === 0 ? ".*" : ".*"; // "**" alone, or a trailing "/**": everything inside
      else re += "(?:.*/)?"; // "**/" or "/**/": zero or more directories
      continue;
    }
    re += globToRegex(seg);
    if (!last) re += "/";
  }
  // A trailing "/**" needs at least one character after the directory.
  if (parts.length > 1 && parts[parts.length - 1] === "**") re = `${re.slice(0, -2)}.+`;
  const prefix = anchoredBySlash || parts[0] === "**" ? "" : "(?:.*/)?";
  const rx = new RegExp(`^${prefix}${re}$`);
  return (path) => rx.test(path);
}

/** Parses a `.gitattributes` file into its rules, in order. */
function parseAttrs(rest: string, macros: ReadonlyMap<string, Map<string, AttrState>>): Map<string, AttrState> {
  const attrs = new Map<string, AttrState>();
  for (const tok of rest.trim().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith("-")) attrs.set(tok.slice(1), false);
    else if (tok.startsWith("!")) attrs.set(tok.slice(1), "unspecified");
    else if (tok.includes("=")) {
      const [k, ...v] = tok.split("=");
      attrs.set(k!, v.join("="));
    } else {
      attrs.set(tok, true);
      for (const [k, v] of macros.get(tok) ?? []) attrs.set(k, v);
    }
  }
  return attrs;
}

export function parseGitattributes(text: string): AttrRule[] {
  const rules: AttrRule[] = [];
  const macros = new Map<string, Map<string, AttrState>>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const macro = /^\[attr\](\S+)(.*)$/.exec(line);
    if (macro) return void macros.set(macro[1]!, parseAttrs(macro[2]!, macros));
    const split = splitLine(line);
    if (!split) return;
    const match = patternMatcher(split.pattern);
    if (!match) return;
    rules.push({ pattern: split.pattern, match, attrs: parseAttrs(split.rest, macros), line: i + 1 });
  });
  return rules;
}

/** The state of one attribute for a path: the last rule that matches and mentions it. */
export function attributeFor(rules: readonly AttrRule[], path: string, attr: string): AttrState {
  let state: AttrState = "unspecified";
  for (const r of rules) if (r.attrs.has(attr) && r.match(path)) state = r.attrs.get(attr)!;
  return state;
}

/** True when `.gitattributes` marks the path `linguist-generated` (set, or `=true`). */
export function isLinguistGenerated(rules: readonly AttrRule[], path: string): boolean {
  const s = attributeFor(rules, path, "linguist-generated");
  return s === true || (typeof s === "string" && s.toLowerCase() === "true");
}
