import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * The programs pr-rla runs (git, ssh-keygen), found on PATH once and then run by their absolute
 * path (P4, second-pass review finding 6).
 *
 * A bare name given to spawn is looked up by the operating system in the child's working directory
 * terms: on Windows the child's cwd (the audit repository) is searched before PATH, so a `git.exe`
 * committed to the audit repository would run; on every platform a relative or empty PATH entry
 * ("", ".", "bin") names a directory relative to the cwd. Here only absolute PATH entries are
 * searched, and the result is what is spawned, so no directory the audit repository controls can
 * supply the program. Windows is untested (BUILD-NOTES, P4).
 */

export class ExecutableNotFound extends Error {
  constructor(readonly program: string) {
    super(`${program} was not found on PATH (only absolute PATH entries are searched; an entry such as "." or "bin" is relative to the working directory and is skipped)`);
    this.name = "ExecutableNotFound";
  }
}

const found = new Map<string, string>();

function runnable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of `program` from the absolute entries of `pathValue` (default: this process's
 * PATH), in order; on Windows `.exe` and `.com` are tried (a `.bat` or `.cmd` cannot be spawned
 * without a shell). Throws ExecutableNotFound. Cached per program, PATH and platform.
 */
export function resolveExecutable(program: string, pathValue: string = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): string {
  const key = `${platform}\0${program}\0${pathValue}`;
  const hit = found.get(key);
  if (hit) return hit;
  const names = platform === "win32" && !/\.(?:exe|com)$/i.test(program) ? [`${program}.exe`, `${program}.com`] : [program];
  for (const dir of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const file = join(dir, name);
      if (runnable(file, platform)) {
        found.set(key, file);
        return file;
      }
    }
  }
  throw new ExecutableNotFound(program);
}

/** git, by absolute path from this process's PATH. */
export const gitExecutable = (): string => resolveExecutable("git");
