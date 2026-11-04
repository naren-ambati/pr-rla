import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A hash of a directory tree: every file's path, mode and content, every symlink's target, every
 * directory's name, including `.git`. Two equal hashes mean nothing under the directory changed.
 */
export function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      const rel = relative(dir, p);
      if (st.isSymbolicLink()) h.update(`l ${rel} ${readlinkSync(p)}\n`);
      else if (st.isDirectory()) {
        h.update(`d ${rel}\n`);
        walk(p);
      } else h.update(`f ${rel} ${st.mode.toString(8)} ${createHash("sha256").update(readFileSync(p)).digest("hex")}\n`);
    }
  };
  walk(dir);
  return h.digest("hex");
}
