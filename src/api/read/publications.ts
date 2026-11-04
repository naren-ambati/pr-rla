import { existsSync } from "node:fs";
import { join } from "node:path";
import { readTextConfined } from "../../io/confine.js";
import { PUBLICATION_FILE, parsePublications, type ReadPublications } from "../../core/ledger-publication.js";

/** `audit/<window>/ledger-publication.json` (P1): where `sample` appends each publication of the ledger index. */
export const publicationsPath = (windowDir: string): string => join(windowDir, PUBLICATION_FILE);

/** The window's ledger publication records, in file order, or null when the file does not exist. Confined in a read-only call. */
export function readPublications(windowDir: string): ReadPublications | null {
  const p = publicationsPath(windowDir);
  if (!existsSync(p)) return null;
  return parsePublications(readTextConfined(p, PUBLICATION_FILE));
}
