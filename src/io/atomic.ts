import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writes `data` to a temporary file next to `path`, flushes it, then renames it
 * into place. A reader sees the old file or the new one, never a partial write,
 * and an interrupted command leaves the previous file whole (NFR15).
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", opts.mode ?? 0o644);
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
}
