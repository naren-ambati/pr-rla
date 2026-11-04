import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, parse, relative } from "node:path";
import { canonicalJson } from "../core/canonical.js";
import { extendsBytes, readFileHistory } from "./git-history.js";
import { FULL_CLONE, gitSafeText, historyRefusal } from "../io/git-safe.js";
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
    // A line's own claim about its provenance never counts: only its signature does, checked by the core.
    return GitFileLedger.parse(await readFile(this.file, "utf8"), this.file).map(({ provenance: _claimed, ...v }) => v);
  }

  async appendVerdict(event: VerdictEvent): Promise<void> {
    const p = verdictEventProblems(event);
    if (p.length) throw new Error(`invalid verdict: ${p.join("; ")}`);
    await mkdir(dirname(this.file), { recursive: true });
    const line = { schema: "pr-rla/verdict/v1", ...event };
    await appendFile(this.file, `${canonicalJson(line)}\n`);
  }

  /** The git toplevel and the file's path relative to it, or null outside a repository. */
  private repo(): { top: string; rel: string } | null {
    // The nearest directory that exists (the window directory, unless the ledger's was removed), never the process's cwd.
    let dir = dirname(this.file);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    let top: string;
    try {
      // Discovery finds the audit repository's toplevel; every later call runs there, with git's ceiling at it.
      top = gitSafeText(["rev-parse", "--show-toplevel"], { cwd: dir, root: parse(dir).root }).trim();
    } catch {
      return null;
    }
    // Resolve symlinks (e.g. macOS /var -> /private/var) so the path is relative to git's real toplevel.
    const realFile = join(realpathSync(dir), relative(dir, this.file));
    return { top, rel: relative(realpathSync(top), realFile).split("\\").join("/") };
  }

  /**
   * The append-only check over the file's whole history (U9, after review): every version of the
   * file, in every commit reachable from HEAD, must extend the version in each of that commit's
   * parents, so a line removed or changed anywhere, on any branch merged in, is found. The history is
   * read from hash-checked raw objects (src/ledgers/git-history.ts); a shallow or grafted repository
   * is refused.
   */
  async verifyIntegrity(): Promise<LedgerIntegrityReport> {
    const repo = this.repo();
    if (!repo) return { ok: true, tamperTrail: false, findings: ["verdicts are not in a git repository: there is no tamper trail"] };
    const { top, rel } = repo;
    const refusal = historyRefusal(top);
    if (refusal) return { ok: false, tamperTrail: false, findings: [`${rel}: ${refusal}`] };
    const h = await readFileHistory(top, rel);
    if (h.problems.length) return { ok: false, tamperTrail: false, findings: [...h.problems.map((p) => `${rel}: ${p}`), `${rel}: ${FULL_CLONE}`] };
    const findings: string[] = [];
    let ok = true;
    for (const c of h.commits) {
      const mine = h.versions.get(c) ?? null;
      if (mine === "not-a-file") {
        ok = false;
        findings.push(`${rel} is not a regular file in commit ${c.slice(0, 10)}`);
        continue;
      }
      for (const p of h.parents.get(c) ?? []) {
        const theirs = h.versions.get(p) ?? null;
        if (!(theirs instanceof Buffer)) continue;
        if (mine === null || !extendsBytes(mine, theirs)) {
          ok = false;
          findings.push(mine === null ? `${rel} was deleted in commit ${c.slice(0, 10)}` : `${rel} was rewritten (not appended) in commit ${c.slice(0, 10)}`);
          break;
        }
      }
    }
    const committed = [...h.versions.values()].some((v) => v instanceof Buffer);
    const atHead = h.head ? (h.versions.get(h.head) ?? null) : null;
    const prev = atHead instanceof Buffer ? atHead : Buffer.alloc(0);
    const current = existsSync(this.file) ? await readFile(this.file) : Buffer.alloc(0);
    if (!extendsBytes(current, prev)) {
      ok = false;
      findings.push(`${rel} in the working tree rewrites its committed history`);
    } else {
      const pending = current.subarray(prev.length).toString("utf8").split("\n").filter((l) => l.trim()).length;
      if (pending > 0) findings.push(`${pending} verdict line(s) not yet committed (no tamper trail for them until committed)`);
    }
    if (!committed && current.toString("utf8").trim()) findings.push(`${rel} has never been committed`);
    return { ok, tamperTrail: committed, findings };
  }
}

export default defineLedger<GitFileLedgerOptions>({
  ledgerApiVersion: LEDGER_API_VERSION,
  name: "git-file",
  description: "verdicts.jsonl in the audit repo; git history is the tamper trail, and verdicts signed one by one with registered SSH keys give account or presence provenance",
  create: (options: GitFileLedgerOptions, ctx: LedgerContext) => {
    if (options?.require_signed !== undefined && typeof options.require_signed !== "boolean") throw new Error("option require_signed must be true or false");
    if (options?.file !== undefined && typeof options.file !== "string") throw new Error("option file must be a file name");
    return new GitFileLedger(join(ctx.windowDir, options?.file ?? "verdicts.jsonl"));
  },
});
