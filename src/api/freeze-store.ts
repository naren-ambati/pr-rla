import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../core/canonical.js";
import type { GoneRepo, PluginIdentity, RepoListing } from "../core/records.js";
import type { ResolvedRepo } from "../core/repo-set.js";
import { writeFileAtomic } from "../io/atomic.js";
import type { ListChangesResult } from "../sdk/provider.js";

/**
 * The FreezeCheckpointStore (functional-design.md §U8; components.md): the resumable cache of a
 * pooled freeze, at `<audit repo>/.pr-rla/cache/<window>/<runId>/`.
 *
 * - `run.json` holds the run's inputs, its start time, and what the resolution recorded at the start
 *   (the owner's listing, the registered repos found gone). The start time is the manifest's as-of
 *   time, so a killed and resumed run writes the same manifest as an uninterrupted one. The run id
 *   covers all of it: a header whose content does not hash to its directory's id is not used.
 * - `repos/<hash>.json` is one repo's done-marker: the provider's checked listing for that repo (its
 *   `headSha` is the head it walked) and the SHA-256 of that listing, or, for a repo of a registered
 *   list, the probe that found it gone. A resumed run reads it instead of listing the repo again, so
 *   it sees the same history, after checking the digest and the provider contract again.
 *
 * Every write is atomic (a temporary file, then a rename), so a kill leaves whole markers only;
 * a repo that was mid-listing simply starts again. `verify` never reads this directory: its only
 * reader is `freeze`, and a test keeps it that way.
 */

export const FREEZE_RUN_SCHEMA = "pr-rla/freeze-run/v2";
export const FREEZE_REPO_SCHEMA = "pr-rla/freeze-repo/v2";

/** What decides whether two invocations are the same run (FR5.4): a resume refuses if any of it differs. */
export interface FreezeRunInputs {
  registrationSha256: string;
  /** The pool the set resolved to at the start, sorted. */
  repos: ResolvedRepo[];
  /** The registered repos the resolution found gone, sorted. */
  gone: { repo: string; repoId: string | null }[];
  prRlaVersion: string;
  provider: PluginIdentity;
}

export interface FreezeRunHeader {
  schema: typeof FREEZE_RUN_SCHEMA;
  runId: string;
  inputs: FreezeRunInputs;
  /** ISO 8601 UTC. The manifest's `frozenAt` and the cutoff reviews are read as of. */
  startedAt: string;
  /** A rule's owner listing at the start (null for a list); it is what the manifest records. */
  listing: RepoListing | null;
  /** The gone repos, with the probes' evidence, as found at the start. */
  gone: GoneRepo[];
}

/** One repo's done-marker: its checked listing and the listing's digest, or the probe that found it gone. */
export type FreezeRepoMarker = { schema: typeof FREEZE_REPO_SCHEMA; repo: string; listed: ListChangesResult; sha256: string } | { schema: typeof FREEZE_REPO_SCHEMA; repo: string; gone: GoneRepo };

/** What a done-marker holds, once read and checked. */
export type RepoCheckpoint = { listed: ListChangesResult } | { gone: GoneRepo };

/**
 * runId = SHA-256 of (registration digest, resolved repo list, gone repos, pr-rla version, provider identity, start
 * time, the recorded listing and gone evidence). The start time and the recorded state are in it so that editing them
 * makes the header unusable (the review's finding 11), as editing the inputs always did.
 */
export function freezeRunId(header: Pick<FreezeRunHeader, "inputs" | "startedAt" | "listing" | "gone">): string {
  return sha256Hex(canonicalJson({ inputs: header.inputs, startedAt: header.startedAt, listing: header.listing, gone: header.gone }));
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
  if (canonicalJson(a.gone ?? []) !== canonicalJson(b.gone ?? [])) out.push("the registered repos found gone");
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
    return existsSync(d) ? readdirSync(d).filter((n) => /^[0-9a-f]{64}$/.test(n) && existsSync(join(d, n, "run.json"))).sort() : [];
  }

  /** The newest usable run of this window with exactly these inputs, or null. */
  static find(base: string, window: string, inputs: FreezeRunInputs): FreezeCheckpointStore | null {
    const want = canonicalJson(inputs);
    const matches = FreezeCheckpointStore.runs(base, window)
      .map((id) => new FreezeCheckpointStore(base, window, id))
      .map((s) => ({ s, h: s.header() }))
      .filter((x): x is { s: FreezeCheckpointStore; h: FreezeRunHeader } => x.h !== null && canonicalJson(x.h.inputs) === want)
      .sort((x, y) => (x.h.startedAt < y.h.startedAt ? 1 : x.h.startedAt > y.h.startedAt ? -1 : 0));
    return matches[0]?.s ?? null;
  }

  /**
   * Starts a new run with these inputs and returns its store. With `fresh` (`freeze --force`) every earlier run with
   * the same inputs is discarded first, so a plain re-run cannot continue one of them.
   */
  static begin(base: string, window: string, h: Omit<FreezeRunHeader, "schema" | "runId">, opts: { fresh?: boolean } = {}): FreezeCheckpointStore {
    if (opts.fresh) {
      const want = canonicalJson(h.inputs);
      for (const id of FreezeCheckpointStore.runs(base, window)) {
        const old = new FreezeCheckpointStore(base, window, id);
        const oh = old.header();
        if (!oh || canonicalJson(oh.inputs) === want) rmSync(old.dir, { recursive: true, force: true });
      }
    }
    const header: FreezeRunHeader = { schema: FREEZE_RUN_SCHEMA, runId: freezeRunId(h), ...h };
    const store = new FreezeCheckpointStore(base, window, header.runId);
    if (existsSync(store.dir)) rmSync(store.dir, { recursive: true, force: true });
    mkdirSync(store.reposDir, { recursive: true });
    writeFileAtomic(store.headerPath, `${JSON.stringify(header, null, 2)}\n`);
    return store;
  }

  private get headerPath() {
    return join(this.dir, "run.json");
  }
  private markerPath(repo: string) {
    return join(this.reposDir, `${sha256Hex(repo).slice(0, 24)}.json`);
  }

  /** The run's header, or null if there is none, it is not this run's, or its content does not hash to this run's id. */
  header(): FreezeRunHeader | null {
    if (!existsSync(this.headerPath)) return null;
    try {
      const h = JSON.parse(readFileSync(this.headerPath, "utf8")) as unknown;
      if (!isObject(h) || h.schema !== FREEZE_RUN_SCHEMA || h.runId !== this.runId || typeof h.startedAt !== "string" || !isObject(h.inputs) || !Array.isArray(h.gone) || (h.listing !== null && !isObject(h.listing))) return null;
      if (freezeRunId(h as unknown as FreezeRunHeader) !== this.runId) return null;
      return h as unknown as FreezeRunHeader;
    } catch {
      return null;
    }
  }

  /**
   * The repo's done-marker, or null if it has none or it cannot be used: damaged, foreign, or a listing that does not
   * hash to its recorded digest (an edited marker is listed again, never signed).
   */
  readRepo(repo: string): RepoCheckpoint | null {
    const p = this.markerPath(repo);
    if (!existsSync(p)) return null;
    try {
      const m = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (!isObject(m) || m.schema !== FREEZE_REPO_SCHEMA || m.repo !== repo) return null;
      if (isObject(m.gone)) return { gone: m.gone as unknown as GoneRepo };
      if (!isObject(m.listed) || !Array.isArray(m.listed.changes) || typeof m.sha256 !== "string" || sha256Hex(canonicalJson(m.listed)) !== m.sha256) return null;
      return { listed: m.listed as unknown as ListChangesResult };
    } catch {
      return null;
    }
  }

  /** Records that the repo is listed. Atomic, so a kill leaves the previous state whole. */
  writeRepo(repo: string, listed: ListChangesResult): void {
    const marker: FreezeRepoMarker = { schema: FREEZE_REPO_SCHEMA, repo, listed, sha256: sha256Hex(canonicalJson(listed)) };
    writeFileAtomic(this.markerPath(repo), `${JSON.stringify(marker)}\n`);
  }

  /** Records that a repo of a registered list is gone, with the probe's evidence. */
  writeGone(repo: string, gone: GoneRepo): void {
    const marker: FreezeRepoMarker = { schema: FREEZE_REPO_SCHEMA, repo, gone };
    writeFileAtomic(this.markerPath(repo), `${JSON.stringify(marker)}\n`);
  }

  /** How many of these repos have a done-marker file (not parsed: for a progress line over a large org). */
  present(repos: readonly string[]): number {
    return repos.filter((r) => existsSync(this.markerPath(r))).length;
  }

  /** How many of these repos already have a usable done-marker. */
  done(repos: readonly string[]): number {
    return repos.filter((r) => this.readRepo(r) !== null).length;
  }
}
