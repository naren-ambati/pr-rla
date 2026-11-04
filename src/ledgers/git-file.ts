import { execFileSync } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson } from "../core/canonical.js";
import { confinedPath, currentConfinement, gitCeilingDirectories, readTextConfinedAsync } from "../io/confine.js";
import { GIT_READ_CONFIG, gitReadEnv } from "../io/git-read.js";
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

/** The file the git-file ledger reads and appends to: `file` (default verdicts.jsonl) joined to the window directory. */
export const gitFilePath = (windowDir: string, options?: GitFileLedgerOptions) => join(windowDir, options?.file ?? "verdicts.jsonl");

/**
 * Verdicts appended, one JSON object per line, to `audit/<window>/verdicts.jsonl`.
 * Commit it after each verdict: git history is the tamper trail, and
 * `verifyIntegrity` checks that every committed version extends the previous one.
 * Works on any SCM that hosts a git repo.
 */
export class GitFileLedger implements Ledger {
  readonly apiVersion = LEDGER_API_VERSION;
  readonly name = "git-file";
  constructor(readonly file: string) {}

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

  async readVerdicts(): Promise<VerdictEvent[]> {
    if (!existsSync(this.file)) return [];
    return GitFileLedger.parse(await readTextConfinedAsync(this.file, "the git-file ledger's file"), this.file);
  }

  async appendVerdict(event: VerdictEvent): Promise<void> {
    const p = verdictEventProblems(event);
    if (p.length) throw new Error(`invalid verdict: ${p.join("; ")}`);
    await mkdir(dirname(this.file), { recursive: true });
    const line = { schema: "pr-rla/verdict/v1", ...event };
    await appendFile(this.file, `${canonicalJson(line)}\n`);
  }

  async verifyIntegrity(): Promise<LedgerIntegrityReport> {
    // Reads only: no lazy fetch on a partial clone, no optional locks or housekeeping, no repository above the roots (src/io/git-read.ts).
    const env = gitReadEnv();
    const git = (args: string[], cwd: string) => execFileSync("git", [...GIT_READ_CONFIG, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    const dir = dirname(this.file);
    let top: string;
    // A .git file can point anywhere ("gitdir: …"): in a confined call, the repository git would read is checked before git runs.
    confineGitDir(existsSync(dir) ? dir : process.cwd());
    try {
      top = git(["rev-parse", "--show-toplevel"], existsSync(dir) ? dir : process.cwd()).trim();
      for (const d of git(["rev-parse", "--git-dir", "--git-common-dir"], top).split("\n").filter(Boolean)) confinedPath(isAbsolute(d) ? d : resolve(top, d), "the git-file ledger's git directory");
    } catch (e) {
      if ((e as { code?: unknown }).code === "ROOT_ESCAPE") throw e;
      return { ok: true, tamperTrail: false, findings: ["verdicts are not in a git repository: there is no tamper trail"] };
    }
    // Resolve symlinks (e.g. macOS /var -> /private/var) so the path is relative to git's real toplevel.
    const realFile = existsSync(dir) ? join(realpathSync(dir), basename(this.file)) : this.file;
    const rel = relative(realpathSync(top), realFile).split("\\").join("/");
    const findings: string[] = [];
    let ok = true;
    let commits: string[] = [];
    try {
      commits = git(["log", "--format=%H", "--reverse", "--", rel], top).split("\n").filter(Boolean);
    } catch {
      commits = [];
    }
    let prev = "";
    for (const sha of commits) {
      let content: string;
      try {
        content = git(["show", `${sha}:${rel}`], top);
      } catch {
        ok = false;
        // A path the commit's tree has but whose object this clone lacks (a partial clone) is missing, not deleted.
        let listed: string | null;
        try {
          listed = git(["ls-tree", sha, "--", rel], top).trim();
        } catch {
          listed = null;
        }
        findings.push(listed === "" ? `${rel} was deleted in commit ${sha.slice(0, 10)}` : `${rel} at commit ${sha.slice(0, 10)} cannot be read: its object is not in this clone (a partial or shallow clone?); verify from a full clone`);
        prev = "";
        continue;
      }
      if (!content.startsWith(prev)) {
        ok = false;
        findings.push(`${rel} was rewritten (not appended) in commit ${sha.slice(0, 10)}`);
      }
      prev = content;
    }
    const current = existsSync(this.file) ? await readTextConfinedAsync(this.file, "the git-file ledger's file") : "";
    if (!current.startsWith(prev)) {
      ok = false;
      findings.push(`${rel} in the working tree rewrites its committed history`);
    } else {
      const pending = current.slice(prev.length).split("\n").filter((l) => l.trim()).length;
      if (pending > 0) findings.push(`${pending} verdict line(s) not yet committed (no tamper trail for them until committed)`);
    }
    if (commits.length === 0 && current.trim()) findings.push(`${rel} has never been committed`);
    return { ok, tamperTrail: commits.length > 0, findings };
  }
}

export default defineLedger<GitFileLedgerOptions>({
  ledgerApiVersion: LEDGER_API_VERSION,
  name: "git-file",
  description: "verdicts.jsonl in the audit repo; git history is the tamper trail",
  create: (options: GitFileLedgerOptions, ctx: LedgerContext) => new GitFileLedger(gitFilePath(ctx.windowDir, options)),
});
