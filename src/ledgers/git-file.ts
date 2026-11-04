import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../core/canonical.js";
import { describeMode, extendsBytes, fileAtHead, readFileHistory } from "./git-history.js";
import { FULL_CLONE, gitSafeText, historyRefusal } from "../io/git-safe.js";
import { confinedPath, currentConfinement, gitCeilingDirectories, readConfined, readTextConfinedAsync } from "../io/confine.js";
import { ExecutableNotFound } from "../io/executables.js";
import {
  LEDGER_API_VERSION,
  defineLedger,
  verdictEventProblems,
  type Ledger,
  type LedgerContext,
  type LedgerIntegrityReport,
  type VerdictEvent,
} from "../sdk/ledger.js";

export interface GitFileLedgerOptions {
  /** File name inside the window directory (default verdicts.jsonl). */
  file?: string;
  /**
   * Every counted verdict must carry a valid signature by the registered key of the reviewer it
   * names (FR9.1, U9). `register` fixes it in `verdicts.require_signed`, and check 7 enforces the
   * registered value, not this option.
   */
  require_signed?: boolean;
}

/** The ledger file a git-file ledger with these options keeps in `windowDir`. */
export const gitFileLedgerFile = (windowDir: string, options: GitFileLedgerOptions | undefined): string => join(windowDir, options?.file ?? "verdicts.jsonl");

/** Where a git-file ledger is (P4): its repository, and its path there as the configuration spells it. */
export interface GitFileLocation {
  /** git's toplevel. */
  top: string;
  /** The file's path from the toplevel: lexical, normalised, "/"-separated, as the configuration names it (`audit_dir/window/file`). */
  rel: string;
  /** The window directory's path from the toplevel, the same way (where the registration sits beside the ledger). */
  windowRel: string | null;
  /** True when no directory on the file's path is the toplevel: a symbolic link leads out of the repository, and `rel` is only where it leads. */
  outside: boolean;
  /**
   * Why the file on disk is not exactly at `rel`: a symbolic link on the way, a component that
   * exists only under another spelling (a case-insensitive or normalising filesystem), a component
   * that is not a directory. Empty: every component that exists is a real directory or file of
   * exactly its name.
   */
  problems: string[];
}

const posix = (p: string) => p.split(sep).join("/");

/**
 * The repository and lexical path of a git-file ledger's `file` (P4, second-pass review findings 1
 * and 3), or null outside a git repository. The path is computed from the toplevel as the file's
 * own path spells it, never through `realpath` below the toplevel, and each component is checked
 * on disk: not a symbolic link, and present under exactly its name in its directory's listing.
 */
export function gitFileLocation(file: string, windowDir?: string): GitFileLocation | null {
  const abs = resolve(file);
  // The nearest directory that exists (the window directory, unless the ledger's was removed), never the process's cwd.
  let dir = dirname(abs);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  let top: string;
  // A .git file can point anywhere ("gitdir: …"): in a confined call (U5), the repository git would read is checked before git runs.
  confineGitDir(dir);
  try {
    // Discovery finds the audit repository's toplevel; every later call runs there, with git's ceiling at it.
    top = gitSafeText(["rev-parse", "--show-toplevel"], { cwd: dir, root: parse(dir).root }).trim();
  } catch (e) {
    if (e instanceof ExecutableNotFound) throw e;
    return null;
  }
  // The toplevel as the file's path spells it: the first ancestor that is the toplevel on disk. Symbolic
  // links above it (macOS's /var -> /private/var) are the machine's, not the audit's, and are allowed.
  const realTop = realpathSync.native(top);
  let base: string | null = null;
  for (let a = dirname(abs), chain: string[] = []; ; a = dirname(a)) {
    chain.unshift(a);
    if (dirname(a) === a) {
      for (const c of chain) {
        let real: string;
        try {
          real = realpathSync.native(c);
        } catch {
          break;
        }
        if (real === realTop) {
          base = c;
          break;
        }
      }
      break;
    }
  }
  const problems: string[] = [];
  if (base === null) {
    const real = join(realpathSync.native(dir), relative(dir, abs));
    return { top, rel: posix(relative(realTop, real)), windowRel: null, outside: true, problems: [`the ledger file ${abs} is not inside the repository git found for it (${top}): a symbolic link on its path leads elsewhere`] };
  }
  const rel = posix(relative(base, abs));
  const parts = rel.split("/");
  let parent = base;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    const here = parts.slice(0, i + 1).join("/");
    const path = join(parent, name);
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      break;
    }
    if (!names.includes(name)) {
      // Absent, or found only through the filesystem folding case or Unicode form.
      if (existsSync(path)) {
        const fold = (s: string) => s.normalize("NFC").toLowerCase();
        const other = names.find((n) => fold(n) === fold(name));
        problems.push(`${here} exists on disk only as ${other ?? "another spelling"} (the filesystem folds case or Unicode form): the ledger must be at exactly its configured path`);
      }
      break;
    }
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      problems.push(`${here} is a symbolic link: the ledger must be reached through real directories, at exactly its configured path`);
      break;
    }
    if (i < parts.length - 1 && !st.isDirectory()) {
      problems.push(`${here} is not a directory`);
      break;
    }
    if (i === parts.length - 1 && !st.isFile()) problems.push(`${here} is not a regular file`);
    parent = path;
  }
  const w = windowDir ? posix(relative(base, resolve(windowDir))) : null;
  return { top, rel, windowRel: w === null || w.startsWith("..") ? null : w, outside: false, problems };
}

/**
 * The path `register` records for a git-file ledger (P4): its lexical path from the audit
 * repository's toplevel, which check 7 then requires the ledger to be read at. Throws when the path on
 * disk is not exactly that path (a symbolic link, another spelling); outside a git repository the
 * path is null, with the reason.
 */
export function gitFileRegisteredPath(windowDir: string, options: GitFileLedgerOptions | undefined): { path: string } | { path: null; why: string } {
  const where = gitFileLocation(gitFileLedgerFile(windowDir, options), windowDir);
  if (!where) return { path: null, why: "the git-file ledger is not in a git repository, so its path cannot be registered and it has no tamper trail; register from a clone of the audit repository" };
  if (where.problems.length) throw new Error(`the git-file ledger's path cannot be registered: ${where.problems.join("; ")}`);
  return { path: where.rel };
}

/**
 * In a confined call (src/io/confine.ts), the repository git would find from `start` must be inside
 * the roots: a `.git` file's gitdir, and a worktree's commondir, are checked before git reads them.
 * With no confinement in force (the CLI) it does nothing.
 */
function confineGitDir(start: string): void {
  if (!currentConfinement()) return;
  // As git does with GIT_CEILING_DIRECTORIES: never look in a ceiling (a root's parent) or above it.
  const ceilings = new Set(gitCeilingDirectories());
  for (let d = realpathSync(resolve(start)); !ceilings.has(d); d = dirname(d)) {
    const dotGit = join(d, ".git");
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      if (statSync(dotGit).isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
        if (!m) return;
        gitDir = resolve(d, m[1]!);
      }
      confinedPath(gitDir, "the git-file ledger's git directory");
      const common = join(gitDir, "commondir");
      if (existsSync(common)) confinedPath(resolve(gitDir, readFileSync(common, "utf8").trim()), "the git-file ledger's git directory");
      return;
    }
    if (dirname(d) === d) return;
  }
}


/**
 * Verdicts appended, one JSON object per line, to `audit/<window>/verdicts.jsonl`.
 * Commit it after each verdict: git history is the tamper trail, and
 * `verifyIntegrity` checks that every committed version extends each of its parents' versions.
 * Works on any SCM that hosts a git repo.
 *
 * A line may carry its reviewer's per-verdict signature (`registrationSha256` and `sshsig`, U9);
 * the core checks it against the registration's allowed signers. The ledger credits no line to any
 * commit, and a level a line claims for itself (`provenance`) is dropped when it is read.
 */
export class GitFileLedger implements Ledger {
  readonly apiVersion = LEDGER_API_VERSION;
  readonly name = "git-file";
  readonly file: string;
  readonly windowDir: string | undefined;
  constructor(file: string, windowDir?: string) {
    this.file = file;
    this.windowDir = windowDir;
  }

  static parse(text: string, where: string): VerdictEvent[] {
    const out: VerdictEvent[] = [];
    text.split("\n").forEach((line, i) => {
      if (line.trim() === "") return;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        throw new Error(`${where}:${i + 1}: not JSON`);
      }
      const p = verdictEventProblems(v);
      if (p.length) throw new Error(`${where}:${i + 1}: ${p.join("; ")}`);
      out.push(v as VerdictEvent);
    });
    return out;
  }

  /** The ledger's repository and lexical path (P4), or null outside a git repository. */
  location(): GitFileLocation | null {
    return gitFileLocation(this.file, this.windowDir);
  }

  async readVerdicts(): Promise<VerdictEvent[]> {
    if (!existsSync(this.file)) return [];
    // A line's own claim about its provenance never counts: only its signature does, checked by the core.
    return GitFileLedger.parse(await readTextConfinedAsync(this.file, "the git-file ledger's file"), this.file).map(({ provenance: _claimed, ...v }) => v);
  }

  async appendVerdict(event: VerdictEvent): Promise<void> {
    const p = verdictEventProblems(event);
    if (p.length) throw new Error(`invalid verdict: ${p.join("; ")}`);
    // Never write through a symbolic link or into a file of another spelling (P4): verify reads only the configured path.
    const where = this.location();
    if (where?.problems.length) throw new Error(`the verdict was not recorded: ${where.problems.join("; ")}`);
    await mkdir(dirname(this.file), { recursive: true });
    const line = { schema: "pr-rla/verdict/v1", ...event };
    await appendFile(this.file, `${canonicalJson(line)}\n`);
  }

  /**
   * The append-only check over the file's whole history (U9, after review): every version of the
   * file, in every commit reachable from HEAD, must extend the version in each of that commit's
   * parents, so a line removed or changed anywhere, on any branch merged in, is found. The history is
   * read from hash-checked raw objects (src/ledgers/git-history.ts); a shallow or grafted repository
   * is refused.
   *
   * The path walked is the lexical one (P4): `location` in the report, which check 7 compares with
   * the registered `ledgerPath`. A symbolic link or another spelling on the way FAILs.
   */
  async verifyIntegrity(): Promise<LedgerIntegrityReport> {
    const where = this.location();
    if (!where) return { ok: true, tamperTrail: false, findings: ["verdicts are not in a git repository: there is no tamper trail"] };
    const { top, rel } = where;
    // The path on disk is not the one walked: FAIL, and still walk the history the configured path has in git.
    const pathFindings = where.problems.map((p) => `ledger path: ${p}`);
    if (where.outside) return { ok: false, tamperTrail: false, location: rel, findings: pathFindings };
    const refusal = historyRefusal(top);
    if (refusal) return { ok: false, tamperTrail: false, location: rel, findings: [...pathFindings, `${rel}: ${refusal}`] };
    const h = await readFileHistory(top, rel);
    if (h.problems.length) return { ok: false, tamperTrail: false, location: rel, findings: [...pathFindings, ...h.problems.map((p) => `${rel}: ${p}`), `${rel}: ${FULL_CLONE}`] };
    const findings: string[] = [...pathFindings];
    let ok = !pathFindings.length;
    h.commits.forEach((c, i) => {
      const mine = h.versions[i]!;
      if (mine === "not-a-file") {
        ok = false;
        findings.push(`${rel} is not a regular file in commit ${c.slice(0, 10)}`);
        return;
      }
      for (const p of h.parents[i]!) {
        const theirs = h.versions[p];
        if (!(theirs instanceof Buffer)) continue;
        if (mine === null || !extendsBytes(mine, theirs)) {
          ok = false;
          const through = h.blocked.get(i);
          findings.push(
            mine === null
              ? `${rel} was deleted in commit ${c.slice(0, 10)}${through ? ` (${through.path} is ${describeMode(through.mode)} there, not a directory)` : ""}`
              : `${rel} was rewritten (not appended) in commit ${c.slice(0, 10)}`,
          );
          break;
        }
      }
    });
    const committed = h.versions.some((v) => v instanceof Buffer);
    const atHead = h.head ? (h.versions[h.commits.length - 1] ?? null) : null;
    const prev = atHead instanceof Buffer ? atHead : Buffer.alloc(0);
    const current = existsSync(this.file) ? readConfined(this.file, "the git-file ledger's file") : Buffer.alloc(0);
    if (!extendsBytes(current, prev)) {
      ok = false;
      findings.push(`${rel} in the working tree rewrites its committed history`);
    } else {
      const pending = current.subarray(prev.length).toString("utf8").split("\n").filter((l) => l.trim()).length;
      if (pending > 0) findings.push(`${pending} verdict line(s) not yet committed (no tamper trail for them until committed)`);
    }
    if (!committed && current.toString("utf8").trim()) {
      // Never committed under exactly this path, while the registration beside it is: the verdicts went somewhere else (P4).
      const registration = h.head && where.windowRel !== null ? `${where.windowRel}/registration.json` : null;
      if (registration && (await fileAtHead(top, registration)) instanceof Buffer) {
        ok = false;
        findings.push(`${rel} has never been committed, but the registration beside it is (${registration} in HEAD): verdicts recorded since have no tamper trail at the configured path; commit the ledger file there (git add ${rel})`);
      } else findings.push(`${rel} has never been committed`);
    }
    return { ok, tamperTrail: committed, location: rel, findings };
  }
}

export default defineLedger<GitFileLedgerOptions>({
  ledgerApiVersion: LEDGER_API_VERSION,
  name: "git-file",
  description: "verdicts.jsonl in the audit repo; git history is the tamper trail, and verdicts signed one by one with registered SSH keys give account or presence (user-presence flag verified; key hardware not attested) provenance",
  create: (options: GitFileLedgerOptions, ctx: LedgerContext) => {
    if (options?.require_signed !== undefined && typeof options.require_signed !== "boolean") throw new Error("option require_signed must be true or false");
    if (options?.file !== undefined && typeof options.file !== "string") throw new Error("option file must be a file name");
    return new GitFileLedger(gitFileLedgerFile(ctx.windowDir, options), ctx.windowDir);
  },
});
