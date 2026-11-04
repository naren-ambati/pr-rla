import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../core/canonical.js";
import type { PluginIdentity } from "../core/records.js";
import type { ResolvedRepo } from "../core/repo-set.js";
import { writeFileAtomic } from "../io/atomic.js";
import type { ListChangesResult } from "../sdk/provider.js";

/**
 * The FreezeCheckpointStore (functional-design.md §U8; components.md): the resumable cache of a
 * pooled freeze, at `<audit repo>/.pr-rla/cache/<window>/<runId>/`.
 *
 * - `run.json` holds the run's inputs and its start time. The start time is the manifest's as-of
 *   time, so a killed and resumed run writes the same manifest as an uninterrupted one.
 * - `repos/<hash>.json` is one repo's done-marker: the provider's checked listing for that repo,
 *   whose `headSha` is the head it walked. A resumed run reads that listing instead of listing the
 *   repo again, so it sees the same history.
 *
 * Every write is atomic (a temporary file, then a rename), so a kill leaves whole markers only;
 * a repo that was mid-listing simply starts again. `verify` never reads this directory: its only
 * reader is `freeze`, and a test keeps it that way.
 */

export const FREEZE_RUN_SCHEMA = "pr-rla/freeze-run/v1";
export const FREEZE_REPO_SCHEMA = "pr-rla/freeze-repo/v1";

/** Everything the run's identity is made of (FR5.4): a resume refuses if any of it differs. */
export interface FreezeRunInputs {
  registrationSha256: string;
  /** The repos the rule resolved to at the start, sorted. */
  repos: ResolvedRepo[];
  prRlaVersion: string;
  provider: PluginIdentity;
}

export interface FreezeRunHeader {
  schema: typeof FREEZE_RUN_SCHEMA;
  runId: string;
  inputs: FreezeRunInputs;
  /** ISO 8601 UTC. The manifest's `frozenAt` and the cutoff reviews are read as of. */
  startedAt: string;
}

/** The repo's checked listing, as listed. */
export interface FreezeRepoMarker {
  schema: typeof FREEZE_REPO_SCHEMA;
  repo: string;
  listed: ListChangesResult;
}

/** runId = SHA-256 of (registration digest, resolved repo list, pr-rla version, provider identity). */
export function freezeRunId(inputs: FreezeRunInputs): string {
  return sha256Hex(canonicalJson(inputs));
}

/** Which of two runs' inputs differ, by name, for the refusal a `--resume` gives. */
export function differingInputs(a: FreezeRunInputs, b: FreezeRunInputs): string[] {
  const out: string[] = [];
  if (a.registrationSha256 !== b.registrationSha256) out.push("the registration");
  if (canonicalJson(a.repos) !== canonicalJson(b.repos)) {
    const was = new Set(a.repos.map((r) => r.repo));
    const now = new Set(b.repos.map((r) => r.repo));
    const added = [...now].filter((r) => !was.has(r)).length;
    const removed = [...was].filter((r) => !now.has(r)).length;
    out.push(`the resolved repo list (${added} added, ${removed} removed since that run started)`);
  }
  if (a.prRlaVersion !== b.prRlaVersion) out.push(`the pr-rla version (${a.prRlaVersion} then, ${b.prRlaVersion} now)`);
  if (canonicalJson(a.provider) !== canonicalJson(b.provider)) out.push("the provider (its version, files or options)");
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export class FreezeCheckpointStore {
  readonly dir: string;
  private readonly reposDir: string;

  /** `base` is the audit repo directory; the cache lives under `.pr-rla/cache/<window>/<runId>`. */
  constructor(base: string, window: string, readonly runId: string) {
    this.dir = join(base, ".pr-rla", "cache", window, runId);
    this.reposDir = join(this.dir, "repos");
  }

  /** The directory holding every run of a window. */
  static windowDir(base: string, window: string): string {
    return join(base, ".pr-rla", "cache", window);
  }

  /** The run ids that have a header under this window (newest unknown: ids are hashes). */
  static runs(base: string, window: string): string[] {
    const d = FreezeCheckpointStore.windowDir(base, window);
    return existsSync(d) ? readdirSync(d).filter((n) => /^[0-9a-f]{64}$/.test(n) && existsSync(join(d, n, "run.json"))) : [];
  }

  private get headerPath() {
    return join(this.dir, "run.json");
  }
  private get completePath() {
    return join(this.dir, "complete");
  }
  private markerPath(repo: string) {
    return join(this.reposDir, `${sha256Hex(repo).slice(0, 24)}.json`);
  }

  /** The run's header, or null if there is none (or it is not this run's). */
  header(): FreezeRunHeader | null {
    if (!existsSync(this.headerPath)) return null;
    try {
      const h = JSON.parse(readFileSync(this.headerPath, "utf8")) as unknown;
      if (!isObject(h) || h.schema !== FREEZE_RUN_SCHEMA || h.runId !== this.runId || typeof h.startedAt !== "string" || !isObject(h.inputs)) return null;
      if (freezeRunId(h.inputs as unknown as FreezeRunInputs) !== this.runId) return null;
      return h as unknown as FreezeRunHeader;
    } catch {
      return null;
    }
  }

  /**
   * Starts the run, or continues it: an existing header for this run id is kept (its `startedAt` stands),
   * unless `fresh`, which discards what the run cached and starts over (`freeze --force`, a re-freeze).
   * Returns the header in force and whether it continues an earlier start.
   */
  begin(inputs: FreezeRunInputs, startedAt: string, opts: { fresh?: boolean } = {}): { header: FreezeRunHeader; resumed: boolean } {
    const had = opts.fresh ? null : this.header();
    if (had) return { header: had, resumed: true };
    if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.reposDir, { recursive: true });
    const header: FreezeRunHeader = { schema: FREEZE_RUN_SCHEMA, runId: this.runId, inputs, startedAt };
    writeFileAtomic(this.headerPath, `${JSON.stringify(header, null, 2)}\n`);
    return { header, resumed: false };
  }

  /** The repo's done-marker, or null if it has none or the file is damaged (the repo then starts again). */
  readRepo(repo: string): ListChangesResult | null {
    const p = this.markerPath(repo);
    if (!existsSync(p)) return null;
    try {
      const m = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (!isObject(m) || m.schema !== FREEZE_REPO_SCHEMA || m.repo !== repo || !isObject(m.listed) || !Array.isArray(m.listed.changes)) return null;
      return m.listed as unknown as ListChangesResult;
    } catch {
      return null;
    }
  }

  /** Records that the repo is listed. Atomic, so a kill leaves the previous state whole. */
  writeRepo(repo: string, listed: ListChangesResult): void {
    const marker: FreezeRepoMarker = { schema: FREEZE_REPO_SCHEMA, repo, listed };
    writeFileAtomic(this.markerPath(repo), `${JSON.stringify(marker)}\n`);
  }

  /** How many of these repos already have a done-marker. */
  done(repos: readonly string[]): number {
    return repos.filter((r) => this.readRepo(r) !== null).length;
  }

  markComplete(): void {
    writeFileAtomic(this.completePath, "complete\n");
  }

  get complete(): boolean {
    return existsSync(this.completePath);
  }
}
