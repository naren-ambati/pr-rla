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
