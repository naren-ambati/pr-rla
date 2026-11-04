import { writeFileAtomic } from "../../io/atomic.js";

/** Every audit file is written atomically: a temporary file, then a rename (NFR15). Write side only. */
export function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
