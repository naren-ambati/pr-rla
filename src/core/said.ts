import { escapeControls } from "./text.js";

/**
 * Text from outside pr-rla, carried as structured `{ words, foreign }` from where it enters (S1, the seam review's
 * finding 2): an SCM's or a tracker's response, a plugin's or a ledger's answer, an error body.
 *
 * - `Foreign` is one such piece: `foreign` is the text as it came, `words` pr-rla's own name for it ("the provider's
 *   reason"). A `Said` is a line pr-rla reports: its own text with foreign pieces in it, built with the `said` tag.
 * - Converted to a string without being rendered (a plain template, `String()`, `join()`, `JSON.stringify`), either
 *   gives pr-rla's words only, never the foreign text: a line that misses its rendering loses detail, it does not
 *   speak someone else's words in pr-rla's voice.
 * - Each read result is rendered once, at the API boundary, by the mode (`render`): read-only (pr-rla/api/read, the
 *   MCP server) says pr-rla's words and puts each foreign piece in `untrusted.errors[i]`; the CLI quotes it in place,
 *   its control characters escaped.
 */

/**
 * pr-rla's own errors (AuditError, BrokerError and PluginError extend it). `said()` is how a line quotes one: its
 * message is pr-rla's words, unless the error carries another party's text (the broker giving up with the service's
 * last answer, a plugin host's failure with the plugin's output): then pr-rla's words name it and the message is
 * foreign. The core asks the error itself, so it needs no network or plugin module to tell.
 */
export class PrRlaError extends Error {
  said(): { own: string } | { words: string; foreign: string } {
    return { own: this.message };
  }
}

/** At most this many bytes of one foreign text are kept in `untrusted`. */
export const MAX_UNTRUSTED_BYTES = 2048;

/** Foreign text as `untrusted` keeps it: control characters escaped, cut to MAX_UNTRUSTED_BYTES with an ellipsis. */
export function untrustedText(s: string): string {
  const b = Buffer.from(escapeControls(s), "utf8");
  return b.length <= MAX_UNTRUSTED_BYTES ? b.toString("utf8") : `${b.subarray(0, MAX_UNTRUSTED_BYTES).toString("utf8").replace(/\uFFFD$/, "")}…`;
}

/** One piece of text from outside pr-rla, with pr-rla's words for it. */
export class Foreign {
  constructor(
    readonly words: string,
    readonly foreign: string,
  ) {}
  /** pr-rla's words: an unrendered piece never speaks the foreign text. */
  toString(): string {
    return this.words;
  }
  toJSON(): string {
    return this.words;
  }
}

/** A line pr-rla reports: its own text and foreign pieces, in order. */
export class Said {
  readonly parts: readonly (string | Foreign)[];
  constructor(parts: readonly (string | Foreign)[]) {
    const out: (string | Foreign)[] = [];
    for (const p of parts) {
      if (typeof p === "string" && typeof out.at(-1) === "string") out[out.length - 1] = `${out.at(-1) as string}${p}`;
      else if (p !== "") out.push(p);
    }
    this.parts = out;
  }
  /** pr-rla's words, each foreign piece named by its words. */
  get words(): string {
    return this.parts.map((p) => (typeof p === "string" ? p : p.words)).join("");
  }
  /** The foreign pieces, in order. */
  get pieces(): Foreign[] {
    return this.parts.filter((p): p is Foreign => p instanceof Foreign);
  }
  toString(): string {
    return this.words;
  }
  toJSON(): string {
    return this.words;
  }
}

/** A line: pr-rla's text alone, or with foreign pieces. */
export type Line = string | Said;

/**
 * Builds a line from a template: Foreign values (and the pieces of a Said) stay structured, anything else is pr-rla's
 * (numbers, identifiers pr-rla checked, its own words). Without a foreign piece the line is a plain string.
 */
export function said(strings: TemplateStringsArray, ...values: unknown[]): Line {
  const parts: (string | Foreign)[] = [strings[0]!];
  values.forEach((v, i) => {
    if (v instanceof Foreign) parts.push(v);
    else if (v instanceof Said) parts.push(...v.parts);
    else parts.push(String(v));
    parts.push(strings[i + 1]!);
  });
  const line = new Said(parts);
  return line.parts.some((p) => p instanceof Foreign) ? line : line.words;
}

/** Text from outside pr-rla, as a piece of a line. Anything but a string is shown as JSON. */
export function foreign(words: string, text: unknown): Foreign {
  return new Foreign(words, typeof text === "string" ? text : (safeJson(text) ?? String(text)));
}

const safeJson = (v: unknown): string | undefined => {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
};

/** Plugin refusals pr-rla makes itself (its own text); the rest of PluginError's codes carry a plugin's output. */
export const PLUGIN_REFUSALS: ReadonlySet<string> = new Set(["NOT_LOCKED", "LOCK_MISMATCH", "BUILTIN_ONLY", "TREE_ESCAPE", "PLUGIN_UNRESOLVED", "FULL_TRUST_REFUSED", "NODE_TOO_OLD"]);
/** Broker refusals of a request pr-rla would not send (its own text). */
export const BROKER_REFUSALS: ReadonlySet<string> = new Set(["HOST_NOT_ALLOWED", "WRITE_PATH_NOT_ALLOWED", "CREDENTIAL_HOST_MISMATCH", "TOO_MANY_REDIRECTS", "RETRY_HINT_INVALID", "READ_ONLY_VIOLATION", "BROKER_TIMEOUT"]);

/**
 * Whose words an error's message is (the one classification; pr-rla/api/read's readError builds on it). Classes
 * decide, never a `code` or a `name`: an isolated plugin's error crosses the IPC as a plain Error with any of both.
 * - pr-rla's: its own errors (PrRlaError, AuditError among them), the broker's refusals and timeouts, the plugin
 *   host's refusals, and a stopped call (the runtime's own AbortError or TimeoutError, a DOMException: the caller
 *   knows why; an error that only names itself so, as one from across the plugin host can, is foreign);
 * - foreign, with pr-rla's words for it: anything else, as an SCM's HTTP error with its body, a provider's or a
 *   ledger's exception, a plugin's message, the broker giving up with the service's last answer.
 */
export function errorWords(e: unknown): { own: string } | { words: string; foreign: string } {
  const err = e as { name?: unknown; message?: unknown } | null;
  const message = typeof err?.message === "string" ? err.message : String(e);
  if (e instanceof PrRlaError) return e.said();
  if ((err?.name === "AbortError" || err?.name === "TimeoutError") && e instanceof DOMException) return { own: message };
  return { words: `the provider, the ledger or a plugin failed (${errorLabel(e)})`, foreign: message };
}

/**
 * An error's class name and HTTP status, as pr-rla's words name a foreign error: `GitHubHttpError, HTTP 422`. The
 * name crosses the plugin host as the plugin chose it, so only an identifier of up to 64 characters is shown; anything
 * else is `Error`. The status only as a whole number from 100 to 599.
 */
export function errorLabel(e: unknown): string {
  const err = e as { name?: unknown; status?: unknown } | null;
  const name = typeof err?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(err.name) ? err.name : "Error";
  const status = typeof err?.status === "number" && Number.isInteger(err.status) && err.status >= 100 && err.status <= 599 ? `, HTTP ${err.status}` : "";
  return `${name}${status}`;
}

/**
 * An error, as a piece of a line: pr-rla's own message as it is, anything else foreign. `words` names a foreign
 * error where the default would say less (the beacon relays).
 */
export function foreignError(e: unknown, words?: string): string | Foreign {
  const w = errorWords(e);
  return "own" in w ? w.own : new Foreign(words ?? w.words, w.foreign);
}

/** The CLI's form of a line: each foreign piece quoted in place, its control characters escaped. */
export function quoted(l: Line | Foreign): string {
  if (l instanceof Foreign) return escapeControls(l.foreign);
  if (typeof l === "string") return l;
  return l.parts.map((p) => (typeof p === "string" ? p : escapeControls(p.foreign))).join("");
}

/**
 * Read-only rendering: each foreign piece becomes its words and a pointer into `errors`, where the text is kept
 * (escaped and bounded; the same text once).
 */
export class Fence {
  readonly errors: string[];
  private readonly at = new Map<string, number>();
  constructor(errors: string[] = []) {
    this.errors = errors;
    errors.forEach((t, i) => this.at.set(t, i));
  }
  /** `<words>; what it said is in untrusted.errors[i]`. */
  ref(f: Foreign): string {
    const text = untrustedText(f.foreign);
    let i = this.at.get(text);
    if (i === undefined) {
      i = this.errors.push(text) - 1;
      this.at.set(text, i);
    }
    return `${f.words}; what it said is in untrusted.errors[${i}]`;
  }
  line(l: Line | Foreign): string {
    if (l instanceof Foreign) return this.ref(l);
    if (typeof l === "string") return l;
    return l.parts.map((p) => (typeof p === "string" ? p : this.ref(p))).join("");
  }
}

/**
 * Renders every line and foreign piece inside a result (plain objects and arrays, at any depth) by the mode: through
 * `fence` in read-only mode, quoted in place without one. Everything else is returned as it is.
 */
export function render<T>(value: T, fence: Fence | null): T {
  const walk = (v: unknown): unknown => {
    if (v instanceof Said || v instanceof Foreign) return fence ? fence.line(v) : quoted(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The line as pr-rla's words, for tests and decisions on a line's prefix (`FAIL `, `INCOMPLETE `, `WARN `). */
export const wordsOf = (l: Line | Foreign): string => (typeof l === "string" ? l : l.words);

/** A line without `prefix` (a decided line's `FAIL ` or `INCOMPLETE `), when it starts with it. */
export function dropPrefix(l: Line, prefix: string): Line {
  if (typeof l === "string") return l.startsWith(prefix) ? l.slice(prefix.length) : l;
  const [first, ...rest] = l.parts;
  return typeof first === "string" && first.startsWith(prefix) ? new Said([first.slice(prefix.length), ...rest]) : l;
}

/**
 * An identifier another party gave (an account id, an event id, a key type): shown in pr-rla's words when it is one
 * (letters, digits and `._:@+/=-`, at most 128, starting with a letter or a digit; no space, so no sentence), else
 * carried as foreign text.
 */
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+/=-]{0,127}$/;
export const ident = (words: string, v: unknown): string | Foreign => (typeof v === "string" && IDENTIFIER.test(v) ? v : foreign(words, v));
/** A time another party gave, as pr-rla prints times when it parses (pr-rla's words then), else foreign text. */
export const isoOrForeign = (words: string, t: unknown): string | Foreign => {
  const ms = typeof t === "string" ? Date.parse(t) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000Z", "Z") : foreign(words, t);
};
/** Items joined with `sep` into one line (each a line or a piece). */
export function joinLines(items: readonly (Line | Foreign)[], sep: string): Line {
  const parts: (string | Foreign)[] = [];
  items.forEach((x, i) => {
    if (i) parts.push(sep);
    if (x instanceof Said) parts.push(...x.parts);
    else parts.push(x);
  });
  return said`${new Said(parts)}`;
}
