import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ToolError } from "./errors.js";

/**
 * The directories tools may open (contracts.md §4): `--root <dir>`, repeatable, default the
 * working directory. A `dir` argument, and every file the audit API opens for it (the config,
 * the audit directory, the protocol, a json-file export), must resolve inside a root after
 * `realpath`, or the tool returns ROOT_ESCAPE. The server does not ask the client for roots.
 */
export class Roots {
  readonly list: readonly string[];

  constructor(dirs: readonly string[]) {
    if (!dirs.length) throw new Error("pr-rla-mcp needs at least one root");
    this.list = dirs.map((d) => {
      const abs = resolve(d);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`--root ${d}: not a directory`);
      return realpathSync(abs);
    });
  }

  /** True when `real` (an absolute, symlink-free path) is a root or lies under one. */
  private inside(real: string): boolean {
    return this.list.some((r) => {
      const rel = relative(r, real);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  }

  /** The real path of `p`, or for a path that does not exist, of its nearest existing ancestor plus the rest. */
  private real(p: string): string {
    let cur = resolve(p);
    const rest: string[] = [];
    while (!existsSync(cur)) {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.unshift(basename(cur));
      cur = parent;
    }
    return join(realpathSync(cur), ...rest);
  }

  /** The audit directory a tool works on: `dir` (relative to the first root), or the first root. */
  resolveDir(dir: string | undefined): string {
    if (dir === undefined) return this.list[0]!;
    if (dir.includes("\0")) throw new ToolError("ROOT_ESCAPE", "dir contains a NUL character");
    const abs = isAbsolute(dir) ? resolve(dir) : resolve(this.list[0]!, dir);
    // The real path decides: a symlink inside a root that points out of it is an escape.
    const real = this.real(abs);
    if (!this.inside(real)) throw new ToolError("ROOT_ESCAPE", `${dir} resolves to ${real}, outside the roots this server may open (${this.list.join(", ")})`, "pass a dir inside a root, or start pr-rla-mcp with --root <dir>");
    if (!existsSync(real) || !statSync(real).isDirectory()) throw new ToolError("NO_AUDIT", `${dir} is not a directory`, "pass the directory holding .pr-rla.yml");
    return real;
  }

  /** For the audit API's `confine`: refuses a file outside the roots. */
  readonly confine = (path: string, what: string): void => {
    const real = this.real(path);
    if (!this.inside(real)) throw new ToolError("ROOT_ESCAPE", `${what} (${path}) resolves to ${real}, outside the roots this server may open`, "keep the audit's files inside a root, or start pr-rla-mcp with --root <dir>");
  };
}
