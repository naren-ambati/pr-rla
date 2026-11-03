import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { canonicalJson } from "../core/canonical.js";
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
    return GitFileLedger.parse(await readFile(this.file, "utf8"), this.file);
  }

  async appendVerdict(event: VerdictEvent): Promise<void> {
    const p = verdictEventProblems(event);
    if (p.length) throw new Error(`invalid verdict: ${p.join("; ")}`);
    await mkdir(dirname(this.file), { recursive: true });
    const line = { schema: "pr-rla/verdict/v1", ...event };
    await appendFile(this.file, `${canonicalJson(line)}\n`);
  }

  async verifyIntegrity(): Promise<LedgerIntegrityReport> {
    const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    const dir = dirname(this.file);
    let top: string;
    try {
      top = git(["rev-parse", "--show-toplevel"], existsSync(dir) ? dir : process.cwd()).trim();
    } catch {
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
        findings.push(`${rel} was deleted in commit ${sha.slice(0, 10)}`);
        prev = "";
        continue;
      }
      if (!content.startsWith(prev)) {
        ok = false;
        findings.push(`${rel} was rewritten (not appended) in commit ${sha.slice(0, 10)}`);
      }
      prev = content;
    }
    const current = existsSync(this.file) ? await readFile(this.file, "utf8") : "";
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
  create: (options: GitFileLedgerOptions, ctx: LedgerContext) => new GitFileLedger(join(ctx.windowDir, options?.file ?? "verdicts.jsonl")),
});
