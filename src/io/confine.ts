import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Where a read-only call may read (U5 fix round, M1). A read call of pr-rla/api/read runs inside
 * `withConfinement`; every file pr-rla's read side opens for it (the records, the window's files,
 * the ledger's files, checkpoints, the ledger index, the protocol, the config, a json-file export)
 * is opened through `readConfined`, which resolves the path with realpath, checks the real path,
 * and opens exactly that path (with O_NOFOLLOW, so its last component cannot be swapped for a
 * symlink in between). The path checked is the path opened.
 *
 * With no confinement in force (the CLI), these are plain reads.
 */

export interface Confinement {
  /** Throws for a real path the call may not open. */
  confine: (realPath: string, what: string) => void;
  /** git never looks for a repository above these directories (GIT_CEILING_DIRECTORIES). */
  gitCeilings: readonly string[];
}

const store = new AsyncLocalStorage<Confinement>();

/** Runs `fn` with `c` in force for every read it makes (no-op without `c`). */
export function withConfinement<T>(c: Confinement | undefined, fn: () => T): T {
  return c ? store.run(c, fn) : fn();
}

/** The confinement in force, if any. */
export const currentConfinement = (): Confinement | undefined => store.getStore();

/** The real path of `path`, after checking it against the confinement in force. */
export function confinedPath(path: string, what: string): string {
  const c = store.getStore();
  if (!c) return path;
  const real = realpathSync(path);
  c.confine(real, what);
  return real;
}

function openChecked(path: string, what: string): { fd: number } | { plain: string } {
  const c = store.getStore();
  if (!c) return { plain: path };
  const real = confinedPath(path, what);
  const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error(`${what} is not a regular file`), { code: "EISDIR" });
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return { fd };
}

/** Reads a file, confined. */
export function readConfined(path: string, what: string): Buffer {
  const o = openChecked(path, what);
  if ("plain" in o) return readFileSync(o.plain);
  try {
    return readFileSync(o.fd);
  } finally {
    closeSync(o.fd);
  }
}

export const readTextConfined = (path: string, what: string): string => readConfined(path, what).toString("utf8");

/** Reads a file, confined (async; the check and the open happen together, before the read). */
export async function readTextConfinedAsync(path: string, what: string): Promise<string> {
  const o = openChecked(path, what);
  if ("plain" in o) return readFile(o.plain, "utf8");
  try {
    return readFileSync(o.fd, "utf8");
  } finally {
    closeSync(o.fd);
  }
}

/** The git ceiling directories for the confinement in force: the parents of its roots (git may enter a root, never go above it). */
export function gitCeilingDirectories(): string[] {
  const c = store.getStore();
  return c ? [...new Set(c.gitCeilings.map((r) => dirname(r)))] : [];
}
