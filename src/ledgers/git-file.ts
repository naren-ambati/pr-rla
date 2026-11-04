import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { canonicalJson } from "../core/canonical.js";
import { allowedSignersOf, analyzeSignedVerdicts, type AllowedSigner, type SignedVerdictAnalysis } from "../core/presence/index.js";
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
   * Every counted verdict must come from a commit signed (git commit -S, SSH format) by the
   * registered reviewer it names (FR9.1). `register` fixes it in `verdicts.require_signed`, and
   * check 7 enforces the registered value, not this option.
   */
  require_signed?: boolean;
}

// --no-replace-objects: a replace ref must not stand in for a verdict commit (or any object this ledger reads).
const git = (args: string[], cwd: string, input?: string): Buffer =>
  execFileSync("git", ["--no-replace-objects", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
const gitText = (args: string[], cwd: string) => git(args, cwd).toString("utf8");

/**
 * Verdicts appended, one JSON object per line, to `audit/<window>/verdicts.jsonl`.
 * Commit it after each verdict: git history is the tamper trail, and
 * `verifyIntegrity` checks that every committed version extends the previous one.
 * Works on any SCM that hosts a git repo.
 *
 * With the reviewers' SSH keys registered (`verdicts.reviewers` as allowed-signers lines, U9), each
 * line's provenance comes from the commit that added it (git blame), checked by the core's
 * PresenceVerifier: signed by the reviewer it names, `account`; by that reviewer's security key
 * with the user-presence flag set, `presence`; otherwise `self-asserted`. A level a line claims
 * for itself never counts.
 */
export class GitFileLedger implements Ledger {
  readonly apiVersion = LEDGER_API_VERSION;
  readonly name = "git-file";
  private analysis: Promise<SignedVerdictAnalysis> | null = null;
  constructor(
    readonly file: string,
    readonly signers: readonly AllowedSigner[] = [],
  ) {}

  static parse(text: string, where: string): VerdictEvent[] {
    return GitFileLedger.parseLines(text, where).map((l) => l.event);
  }

  /** The verdict lines with their 1-based line numbers. */
  static parseLines(text: string, where: string): { line: number; event: VerdictEvent }[] {
    const out: { line: number; event: VerdictEvent }[] = [];
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
      out.push({ line: i + 1, event: v as VerdictEvent });
    });
    return out;
  }

  async readVerdicts(): Promise<VerdictEvent[]> {
    if (!existsSync(this.file)) return [];
    if (this.signers.length) return (await this.signed()).events;
    // With no keys registered every line is self-asserted, whatever it says about itself.
    return GitFileLedger.parse(await readFile(this.file, "utf8"), this.file).map(({ provenance: _claimed, ...v }) => v);
  }

  async appendVerdict(event: VerdictEvent): Promise<void> {
    const p = verdictEventProblems(event);
    if (p.length) throw new Error(`invalid verdict: ${p.join("; ")}`);
    await mkdir(dirname(this.file), { recursive: true });
    const line = { schema: "pr-rla/verdict/v1", ...event };
    await appendFile(this.file, `${canonicalJson(line)}\n`);
    this.analysis = null;
  }

  /** The git toplevel and the file's path relative to it, or null outside a repository. */
  private repo(): { top: string; rel: string } | null {
    const dir = dirname(this.file);
    let top: string;
    try {
      top = gitText(["rev-parse", "--show-toplevel"], existsSync(dir) ? dir : process.cwd()).trim();
    } catch {
      return null;
    }
    // Resolve symlinks (e.g. macOS /var -> /private/var) so the path is relative to git's real toplevel.
    const realFile = existsSync(dir) ? join(realpathSync(dir), basename(this.file)) : this.file;
    return { top, rel: relative(realpathSync(top), realFile).split("\\").join("/") };
  }

  /** Each line's provenance from the commit that added it; kept until the next append. */
  private signed(): Promise<SignedVerdictAnalysis> {
    this.analysis ??= (async () => {
      const lines = GitFileLedger.parseLines(await readFile(this.file, "utf8"), this.file);
      const repo = this.repo();
      const addedBy = repo ? blame(repo.top, repo.rel) : new Map<number, string>();
      const shas = [...new Set(addedBy.values())];
      return analyzeSignedVerdicts(
        lines.map((l) => ({ event: l.event, commit: addedBy.get(l.line) ?? null })),
        repo && shas.length ? catFileCommits(repo.top, shas) : new Map(),
        this.signers,
      );
    })();
    return this.analysis;
  }

  async verifyIntegrity(): Promise<LedgerIntegrityReport> {
    const repo = this.repo();
    if (!repo) return { ok: true, tamperTrail: false, findings: ["verdicts are not in a git repository: there is no tamper trail"] };
    const { top, rel } = repo;
    const findings: string[] = [];
    let ok = true;
    let commits: string[] = [];
    try {
      commits = gitText(["log", "--format=%H", "--reverse", "--", rel], top).split("\n").filter(Boolean);
    } catch {
      commits = [];
    }
    let prev = "";
    for (const sha of commits) {
      let content: string;
      try {
        content = gitText(["show", `${sha}:${rel}`], top);
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
    if (!this.signers.length || !existsSync(this.file)) return { ok, tamperTrail: commits.length > 0, findings };
    // U9: what the signatures on the verdict commits say. WARNs: an invalid or unknown signature, a signer who is not the named reviewer, a counter going down.
    const signed = await this.signed();
    return { ok, tamperTrail: commits.length > 0, findings: [...findings, ...signed.findings], warnings: signed.warnings };
  }
}

/** Working-tree line number (1-based) → the commit that added that line. Lines not committed yet are absent. */
function blame(top: string, rel: string): Map<number, string> {
  const out = new Map<number, string>();
  let text: string;
  try {
    // An ignore-revs list in the verifier's git configuration would move lines to other commits: drop it
    // (--no-ignore-revs-file clears the configured list; an empty blame.ignoreRevsFile does not, as git sorts that list).
    text = gitText(["blame", "--no-ignore-revs-file", "--porcelain", "--", rel], top);
  } catch {
    return out; // never committed, or no HEAD yet: every line is uncommitted
  }
  for (const m of text.matchAll(/^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/gm)) if (!/^0+$/.test(m[1]!)) out.set(Number(m[2]), m[1]!);
  return out;
}

/**
 * Raw commit objects, read in one `git cat-file --batch`, each checked to hash to its name. A commit
 * git cannot read, or whose content is not the object named, is left out (and then counts as unverifiable).
 */
function catFileCommits(top: string, shas: readonly string[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let buf: Buffer;
  try {
    buf = git(["cat-file", "--batch"], top, `${shas.join("\n")}\n`);
  } catch {
    return out;
  }
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const head = buf.subarray(at, nl).toString("utf8").split(" ");
    at = nl + 1;
    if (head.length < 3) continue; // "<sha> missing"
    const size = Number(head[2]);
    const body = buf.subarray(at, at + size);
    const name = head[0]!;
    const hash = createHash(name.length === 64 ? "sha256" : "sha1").update(`commit ${size}\0`).update(body).digest("hex");
    if (head[1] === "commit" && hash === name) out.set(name, new Uint8Array(body));
    at += size + 1;
  }
  return out;
}

export default defineLedger<GitFileLedgerOptions>({
  ledgerApiVersion: LEDGER_API_VERSION,
  name: "git-file",
  description: "verdicts.jsonl in the audit repo; git history is the tamper trail, and verdict commits signed with registered SSH keys give account or presence provenance",
  create: (options: GitFileLedgerOptions, ctx: LedgerContext) => {
    if (options?.require_signed !== undefined && typeof options.require_signed !== "boolean") throw new Error("option require_signed must be true or false");
    if (options?.file !== undefined && typeof options.file !== "string") throw new Error("option file must be a file name");
    return new GitFileLedger(join(ctx.windowDir, options?.file ?? "verdicts.jsonl"), allowedSignersOf(ctx.reviewers));
  },
});
