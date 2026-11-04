import type { VerdictEvent } from "../sdk/ledger.js";
import { manifestRepos, type AnyManifest } from "./records.js";

/**
 * The descriptive per-repo table of a pooled audit (FR5.3): how many of the pool's N changes sit in each
 * repo, how many counted draws landed there, and how many of those failed. The risk limit applies to the pool;
 * these counts say where the draws fell and carry no claim of their own.
 */
export interface RepoRow {
  repo: string;
  /** Changes in the manifest from this repo. */
  N: number;
  /** Counted draws that landed in this repo (a change drawn twice counts twice). */
  draws: number;
  /** Distinct drawn changes from this repo whose first eligible verdict is a fail. */
  fails: number;
}

export const PER_REPO_NOTE = "per-repo counts are descriptive; the risk limit applies to the pool";

export function perRepoRows(manifest: AnyManifest, counted: readonly { changeId: string }[], firstVerdicts: readonly VerdictEvent[]): RepoRow[] {
  const repoOf = new Map(manifest.changes.map((c) => [c.id, c.repo]));
  const rows = new Map(manifestRepos(manifest).map((r) => [r.repo, { repo: r.repo, N: 0, draws: 0, fails: 0 }]));
  for (const c of manifest.changes) rows.get(c.repo)!.N++;
  for (const d of counted) {
    const r = repoOf.get(d.changeId);
    if (r !== undefined) rows.get(r)!.draws++;
  }
  const drawn = new Set(counted.map((d) => d.changeId));
  for (const v of firstVerdicts) {
    const r = repoOf.get(v.changeId);
    if (r !== undefined && v.verdict === "fail" && drawn.has(v.changeId)) rows.get(r)!.fails++;
  }
  return [...rows.values()];
}

/** Table lines for status: repos a counted draw landed in (most first), then a count of the rest. */
export function perRepoLines(rows: readonly RepoRow[], limit = 25): string[] {
  const hit = rows.filter((r) => r.draws > 0).sort((a, b) => b.draws - a.draws || (a.repo < b.repo ? -1 : 1));
  const width = Math.max(4, ...hit.slice(0, limit).map((r) => r.repo.length));
  const out = [`  ${PER_REPO_NOTE}`, `  ${"repo".padEnd(width)}  ${"N".padStart(6)}  ${"draws".padStart(5)}  ${"fails".padStart(5)}`];
  for (const r of hit.slice(0, limit)) out.push(`  ${r.repo.padEnd(width)}  ${String(r.N).padStart(6)}  ${String(r.draws).padStart(5)}  ${String(r.fails).padStart(5)}`);
  if (hit.length > limit) out.push(`  … and ${hit.length - limit} more repos with draws`);
  const rest = rows.length - hit.length;
  if (rest > 0) out.push(`  ${rest} of ${rows.length} repos had no counted draw`);
  return out;
}
