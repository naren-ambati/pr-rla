import { PRESENCE_LABEL, PRESENCE_LIMIT } from "../../src/core/presence/index.js";

/**
 * The FR9.6 / NFR23 wording checks (U9, after review finding 9), shared by the text check over the
 * repository and the output checks of the end-to-end tests.
 */

interface Claim {
  re: RegExp;
  /** The claim is itself a negation ("cannot forge"), so a negation near it does not withdraw it. */
  negative?: boolean;
}

/** Claims of hardware-verified presence, of a human proven present, or of presence that cannot be forged. */
export const CLAIMS: readonly Claim[] = [
  { re: /hardware[- ](?:verified|attested|backed|proven)\s+(?:user[- ])?presence/i },
  { re: /presence\s+(?:is\s+|was\s+)?(?:verified|attested|proven|guaranteed)\s+(?:by|with|on|in)\s+(?:the\s+|a\s+)?hardware/i },
  // What pr-rla's artifacts are said to prove (a touch itself is a person's act; a signature or a level is not).
  { re: /\b(?:signatures?|signed|verdicts?|presence|pr-rla|levels?|certificates?|flags?|it|this)\b[^.;:!?]{0,40}?\b(?<verb>proves?|guarantees?|attests?|confirms?|establish(?:es)?|shows?)\s+(?:that\s+)?(?:a\s+)?(?:human|person|reviewer|someone)\s+(?:physically\s+)?(?:touched|was present|is present)/di },
  { re: /key hardware (?:is |was )?(?:verified|attested|checked)/i },
  { re: /\bhardware\s+presence\b/i },
  { re: /(?:security|hardware) key (?:is |was )?(?:verified|attested|checked) (?:to be |as )?hardware/i },
  // Added after review (finding 9).
  { re: /\bpresence(?:\s+(?:verdicts?|levels?|signatures?))?\s+(?:is|are|was|were|being)\s+(?:always\s+)?hardware[- ](?:verified|attested|backed|proven|checked)/i },
  { re: /\bphysical(?:ly)?\s+presen(?:ce|t)\b[^.;:!?]{0,20}?\b(?:verified|attested|proven|confirmed|checked|guaranteed)\b/i },
  { re: /\bpresence\s+(?:means|shows|proves|implies|indicates|guarantees|confirms)\s+(?:that\s+)?(?:the\s+|a\s+)?(?:reviewer|human|person|user|someone)\s+(?:physically\s+)?(?:touched|pressed|was present)/i },
  { re: /\b(?:cannot|can ?not|can't)\s+(?:be\s+)?forge[ds]?\b|\bunforgeable\b|\bimpossible to forge\b/i, negative: true },
];

/** A negation in the few words before a claim, or inside it, withdraws it ("does not prove that a human touched…"). */
const NEGATION = /\b(?:no|not|never|cannot|can't|doesn't|isn't|aren't|without|nor|neither)\b/i;
/** A negation of a claim's verb ("does not prove", "never shows", "does not claim it proves"); "no" and "without" negate nouns, not the verb. */
const VERB_NEGATION = /\b(?:not|never|cannot|can't|doesn't|don't|won't|isn't)\b/i;
/** A condition in the few words after a claim limits it ("…hardware presence only if the key is hardware-backed"). */
const CONDITION = /\b(?:only if|only when|unless|until|would need|provided that)\b/i;

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** The sentences of `text` that make a claim, its negation or condition not scoped to the claim itself. */
export function claimsIn(text: string): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\n\s*\n/);
  paragraphs.forEach((para, i) => {
    // A passage the design record marks superseded right after it is history, not a claim; the note is its correction.
    if (/^\s*>\s*\*\*Superseded/.test(paragraphs[i + 1] ?? "") || /^\s*>\s*\*\*Superseded/.test(para)) return;
    const flat = para.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ");
    for (const sentence of flat.split(/(?<=[.!?;:])\s+|\s+[-*]\s+|\|/)) {
      const claimed = CLAIMS.some(({ re, negative }) => {
        const m = re.exec(sentence);
        if (!m) return false;
        if (negative) return true;
        // The few words before the claim, or before its verb when the claim names a subject ("it does not prove that…").
        const verbAt = m.indices?.groups?.verb?.[0];
        const negated = verbAt !== undefined ? VERB_NEGATION.test(words(sentence.slice(0, verbAt)).slice(-4).join(" ")) : NEGATION.test(words(sentence.slice(0, m.index)).slice(-6).join(" "));
        const after = words(sentence.slice(m.index + m[0].length)).slice(0, 8).join(" ");
        return !negated && !CONDITION.test(after);
      });
      if (claimed) out.push(sentence.trim());
    }
  });
  return out;
}

/**
 * Printed text that names the presence level without its label (FR9.6: "presence" is always
 * printed as `presence (user-presence flag verified; key hardware not attested)`). The label, the
 * T16 limit and the words "user-presence" are not bare uses.
 */
export function unlabelledPresence(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /\bpresence\b/.test(l.split(PRESENCE_LABEL).join("").split(PRESENCE_LIMIT).join("").replace(/user-presence/g, "")));
}

/** Every human-readable string in a JSON output (a string with a space in it); enum values such as "presence" are data. */
export function jsonSentences(json: unknown): string[] {
  if (typeof json === "string") return /\s/.test(json) ? [json] : [];
  if (Array.isArray(json)) return json.flatMap(jsonSentences);
  if (json && typeof json === "object") return Object.values(json).flatMap(jsonSentences);
  return [];
}

/*
 * The allow-list (P4, second-pass review finding 7). The deny-list above missed 9 of the reviewer's
 * 12 direct claims, so the text check now works the other way round: every sentence that mentions
 * presence, the UP flag, a touch (of a key), hardware, a security key or a YubiKey must also carry
 * the limit wording, or be on the vetted list (test/fixtures/wording/vetted.json), which a person
 * extends deliberately. The deny-list still runs beside it, so a sentence that carries the limit
 * wording and also claims hardware-verified presence still fails.
 */

const MENTION_ALWAYS = /\bpresence\b|\bhardware\b|\bsecurity[- ]keys?\b|\byubikeys?\b/i;
const MENTION_UP = /\bUP\b/;
const MENTION_TOUCH = /\btouch(?:es|ed|ing)?\b/i;
/** "touch" counts as a mention when the sentence is about keys or people, not "touches no file". */
const KEYISH = /\bkeys?\b|authenticator|\bFIDO\b|presence|\bUP\b|\bhuman\b|\bperson\b|\breviewers?\b|\bsign(?:s|ed|ing|ature|atures)?\b/i;

/** True when the sentence mentions what the presence limit is about. */
export function mentionsPresence(sentence: string): boolean {
  return MENTION_ALWAYS.test(sentence) || MENTION_UP.test(sentence) || (MENTION_TOUCH.test(sentence) && KEYISH.test(sentence));
}

/**
 * The limit wording: what presence does not prove (threat T16). A sentence carrying one of these
 * states the limit itself.
 */
export const LIMIT_WORDING: readonly RegExp[] = [
  /key hardware not attested/i, // the printed label
  /\bT16\b/,
  /software[- ]emulated (?:authenticator|security key)/i,
  /\bnot hardware[- ](?:attested|backed|verified|checked)\b|\bhardware (?:is )?not attested\b/i,
  /\b(?:does not|doesn't|never|cannot|can't) (?:check|verify|attest)\b[^.]{0,60}\bhardware/i,
  /\bhardware[^.]{0,60}\b(?:which|that) pr-rla does not check\b/i,
  /\b(?:does not|doesn't|cannot|can't|never) prove\b[^.]{0,40}\b(?:a |the )?(?:human|person|reviewer|someone)\b/i,
  /\b(?:with |using )?software keys only\b|\btested only with software keys\b|\bonly software keys\b/i,
  /\bhardware\b[^.]{0,80}\bpr-rla does not check\b/i,
  /\brel(?:y|ies) on\b[^.]{0,60}\bhardware-backed\b/i,
  /\bno\b[^.]{0,30}\bclaims?\b[^.]{0,12}\bhardware-verified presence\b/i,
];

export const carriesLimit = (sentence: string): boolean => LIMIT_WORDING.some((re) => re.test(sentence));

/** The form a sentence is vetted in: whitespace collapsed, change ids, fingerprints, long hex and numbers replaced, so a printed line with a key, a change or a draw number matches. */
export function vettedKey(sentence: string): string {
  return sentence
    .replace(/\b[a-z][\w-]*:[\w.-]+\/[\w.-]+(?:#\d+|@[0-9a-f]{7,64})/g, "<change>")
    .replace(/SHA256:[A-Za-z0-9+/=]+/g, "SHA256:<fp>")
    .replace(/\b[0-9a-f]{10,64}\b/g, "<hex>")
    .replace(/\d+/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

/** Markdown prose as sentences: paragraphs, list items, table cells and headings apart; a fenced code line is one sentence. */
export function markdownSentences(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  const prose: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      prose.push("");
      continue;
    }
    if (fenced) {
      if (line.trim()) out.push(line.trim());
      continue;
    }
    // A list item, a heading or a table row starts a new paragraph.
    if (/^\s*(?:[-*+]|\d+\.)\s|^\s*#|^\s*\|/.test(line)) prose.push("");
    prose.push(line);
  }
  const paragraphs = prose.join("\n").split(/\n\s*\n/);
  paragraphs.forEach((para, i) => {
    // As in claimsIn: a passage the design record marks superseded right after it is history, and the note is its correction.
    if (/^\s*>\s*\*\*Superseded/.test(paragraphs[i + 1] ?? "") || /^\s*>\s*\*\*Superseded/.test(para)) return;
    const flat = para.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
    if (!flat) return;
    for (const cell of flat.split(/\s\|\s|^\||\|$/)) for (const s of cell.split(/(?<=[.!?])\s+(?=[A-Z0-9("'`[])/)) if (s.trim().replace(/^[-*+|#\s]+/, "")) out.push(s.trim().replace(/^[-*+]\s+|^#+\s*|^\d+\.\s+/, ""));
  });
  return out;
}

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "of", "void", "throw", "delete", "new", "else", "do", "yield", "await"]);

/**
 * The prose of a TypeScript or JavaScript file: its comments (a run of line comments as one text)
 * and every string or template literal holding a space (a message; `${…}` reads as `<x>`). Code
 * itself (identifiers such as `presenceRank`, the enum value "presence") is not prose.
 */
export function sourceProse(source: string): string[] {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(run.join("\n"));
    run = [];
  };
  let prev = ""; // the last significant code character, or word
  let i = 0;
  const n = source.length;
  const readQuoted = (q: string): string => {
    let s = "";
    i++;
    while (i < n && source[i] !== q && source[i] !== "\n") {
      if (source[i] === "\\") {
        s += source[i + 1] === "n" ? "\n" : (source[i + 1] ?? "");
        i += 2;
      } else s += source[i++];
    }
    i++;
    return s;
  };
  const skipExpression = () => {
    // From just after "${" to its "}", strings and nested templates included.
    let depth = 1;
    while (i < n && depth) {
      const c = source[i]!;
      if (c === '"' || c === "'") readQuoted(c);
      else if (c === "`") readTemplate();
      else {
        if (c === "{") depth++;
        else if (c === "}") depth--;
        i++;
      }
    }
  };
  const readTemplate = (): string => {
    let s = "";
    i++;
    while (i < n && source[i] !== "`") {
      if (source[i] === "\\") {
        s += source[i + 1] === "n" ? "\n" : (source[i + 1] ?? "");
        i += 2;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        i += 2;
        skipExpression();
        s += "<x>";
      } else s += source[i++];
    }
    i++;
    return s;
  };
  while (i < n) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      run.push(source.slice(i + 2, end < 0 ? n : end).replace(/^ /, ""));
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      flush();
      const end = source.indexOf("*/", i + 2);
      out.push(
        source
          .slice(i + 2, end < 0 ? n : end)
          .split("\n")
          .map((l) => l.replace(/^\s*\*\s?/, ""))
          .join("\n"),
      );
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (c === "\n" && run.length && /^\n\s*\n/.test(source.slice(i, i + 3))) flush();
      i++;
      continue;
    }
    flush();
    if (c === '"' || c === "'") {
      const s = readQuoted(c);
      if (/\s/.test(s)) out.push(s);
      prev = c;
      continue;
    }
    if (c === "`") {
      const s = readTemplate();
      if (/\s/.test(s)) out.push(s);
      prev = "`";
      continue;
    }
    if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || REGEX_AFTER_WORD.has(prev))) {
      // A regular expression literal: skip it, classes and escapes included.
      i++;
      let inClass = false;
      while (i < n && source[i] !== "\n") {
        const r = source[i]!;
        if (r === "\\") i += 2;
        else {
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) break;
          i++;
        }
      }
      i++;
      while (i < n && /[a-z]/i.test(source[i]!)) i++;
      prev = "/re/";
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let w = "";
      while (i < n && /[\w$]/.test(source[i]!)) w += source[i++];
      prev = w;
      continue;
    }
    prev = c;
    i++;
  }
  flush();
  return out;
}

/** The sentences of a source file's prose (comments and messages). */
export const sourceSentences = (source: string): string[] => sourceProse(source).flatMap(markdownSentences);

/** The vetted sentences (test/fixtures/wording/vetted.json): by reason, each in its vetted form. */
export interface VettedList {
  about: string;
  reasons: Record<string, string[]>;
}

/** Sentences that mention presence but carry no limit wording and are not vetted: the allow-list's failures. */
export function uncoveredSentences(sentences: readonly string[], vetted: ReadonlySet<string>): string[] {
  return sentences.filter((s) => mentionsPresence(s) && !carriesLimit(s) && !vetted.has(vettedKey(s)));
}

/**
 * The deny-list over a whole text, beside the allow-list: claims of hardware-verified presence,
 * whatever limit wording surrounds them. The printed label and the T16 line are read as bare
 * `presence` first, so the label's own "not" cannot read as negating a claim made around it.
 */
export const claimsInText = (text: string): string[] => claimsIn(text.split(PRESENCE_LABEL).join("presence").split(PRESENCE_LIMIT).join(""));

export const vettedSet = (list: VettedList): Set<string> => new Set(Object.values(list.reasons).flat().map(vettedKey));
