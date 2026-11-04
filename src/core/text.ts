/**
 * Escaping text pr-rla did not write before it is rendered (U5 fix round, M4): C0 controls other
 * than newline and tab, DEL, C1 controls, and the bidirectional controls (Trojan Source), as a
 * visible `\uXXXX`. A terminal then cannot be steered by an ESC or CR sequence in a patch (moving
 * the cursor, erasing pr-rla's own lines), and text cannot be reordered on screen.
 *
 * The same `\uXXXX` form is a valid escape inside a JSON string, so the CLI applies it to every
 * line it prints, `--json` output included (JSON.stringify leaves DEL, C1 and bidi controls raw).
 */

// C0 except \t (09) and \n (0a), DEL and C1 (7f-9f), ALM (061c), LRM/RLM (200e-200f), the line and
// paragraph separators (2028-2029), LRE/RLE/PDF/LRO/RLO (202a-202e), LRI/RLI/FSI/PDI (2066-2069).
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const CONTROLS_AND_NEWLINES = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const hex = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** Text that may span lines (a body, a patch): controls escaped, newlines and tabs kept. */
export const escapeControls = (s: string): string => s.replace(CONTROLS, hex);

/** Text that must stay on one line (a title, a path, a name): newlines escaped too. */
export const escapeLine = (s: string): string => s.replace(CONTROLS_AND_NEWLINES, hex);

/** True when the text holds anything escapeControls would change. */
export const hasControls = (s: string): boolean => {
  CONTROLS.lastIndex = 0;
  return CONTROLS.test(s);
};
