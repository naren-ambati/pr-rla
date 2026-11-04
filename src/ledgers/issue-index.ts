import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../io/atomic.js";
import type { DrawForLedger, PublishContext, Verdict } from "../sdk/ledger.js";

/**
 * The draw → issue index (functional-design.md §U4, kept from the draft's `05` §U4):
 * `audit/<window>/ledger-index.json`, committed with `draws.json`. An indexed issue that is
 * later deleted or moved cannot vanish silently: verify reads every indexed issue.
 *
 * A change drawn twice reuses its first verdict, so it gets one issue: the first draw's.
 * Later draws of it are listed under `repeats`.
 */
export const INDEX_FILE = "ledger-index.json";

export interface IndexedLabel {
  name: string;
  /** The tracker's label id when the label was created or found; a different id later means it was renamed or deleted and re-created. */
  id: string | null;
}

export interface IndexedIssue {
  draw: number;
  changeId: string;
  /** GitHub issue number or GitLab iid (as a string for Jira keys). */
  number: number | string;
  /** The tracker's global id (GitHub node id, GitLab id, Jira id). */
  id: string;
  url: string;
  createdAt: string;
}

export interface LedgerIndex {
  schema: "pr-rla/ledger-index/v1";
  ledger: string;
  /** Where the issues live, e.g. `https://api.github.com/repos/acme/audit`. */
  tracker: string;
  window: string;
  protocolSha256: string;
  registrationSha256: string | null;
  labels: Record<Verdict | "draw", IndexedLabel>;
  issues: IndexedIssue[];
  repeats: { draw: number; changeId: string; sameAs: number }[];
}

export function indexPath(windowDir: string): string {
  return join(windowDir, INDEX_FILE);
}

export function readIndex(windowDir: string): LedgerIndex | null {
  const p = indexPath(windowDir);
  if (!existsSync(p)) return null;
  const v = JSON.parse(readFileSync(p, "utf8")) as LedgerIndex;
  if (v.schema !== "pr-rla/ledger-index/v1") throw new Error(`${p}: not a pr-rla ledger index (schema ${String(v.schema)})`);
  return v;
}

export function writeIndex(windowDir: string, index: LedgerIndex): void {
  const sorted: LedgerIndex = { ...index, issues: [...index.issues].sort((a, b) => a.draw - b.draw), repeats: [...index.repeats].sort((a, b) => a.draw - b.draw) };
  writeFileAtomic(indexPath(windowDir), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** Starts or checks the index for a publish: one index per tracker, window and protocol. */
export function openIndex(windowDir: string, base: Omit<LedgerIndex, "issues" | "repeats" | "schema">): LedgerIndex {
  const existing = readIndex(windowDir);
  if (!existing) return { schema: "pr-rla/ledger-index/v1", ...base, issues: [], repeats: [] };
  for (const k of ["ledger", "tracker", "window", "protocolSha256"] as const)
    if (existing[k] !== base[k]) throw new Error(`${indexPath(windowDir)} was written for ${k} ${existing[k]}, not ${base[k]}; draws of one audit live in one tracker under one protocol`);
  return { ...existing, labels: { ...base.labels, ...existing.labels } };
}

/** The body marker that finds an issue created before a lost response (idempotent publishDraws). */
export function drawMarker(window: string, draw: number, changeId: string): string {
  return `<!-- pr-rla:draw window=${window} draw=${draw} change=${changeId} -->`;
}

export function findMarker(body: string | null | undefined, window: string): { draw: number; changeId: string } | null {
  const m = /<!-- pr-rla:draw window=(\S+) draw=(\d+) change=(\S+) -->/.exec(body ?? "");
  return m && m[1] === window ? { draw: Number(m[2]), changeId: m[3]! } : null;
}

export function issueTitle(d: DrawForLedger): string {
  return `pr-rla draw #${d.draw}: ${d.changeId}`;
}

/** The issue body: what to review, under which protocol, how to record the verdict, and the marker. */
export function issueBody(d: DrawForLedger, ctx: PublishContext | undefined, labels: { pass: string; fail: string }): string {
  return [
    `Draw **#${d.draw}** of the pr-rla audit${ctx ? ` window \`${ctx.window}\`` : ""}${ctx?.repo ? ` of ${ctx.repo}` : ""}.`,
    "",
    `- Change: ${d.url}`,
    `- Landed as: \`${d.mergeSha}\``,
    ...(ctx ? [`- Review protocol SHA-256: \`${ctx.protocolSha256}\``] : []),
    ...(ctx?.registrationSha256 ? [`- Registration SHA-256: \`${ctx.registrationSha256}\``] : []),
    "",
    `Review the change under the registered protocol, then apply exactly one label: \`${labels.pass}\` or \`${labels.fail}\`.`,
    "The first verdict label applied by a registered reviewer counts. Removing it later, or applying the other one, is reported by `pr-rla verify`.",
    "",
    drawMarker(ctx?.window ?? "", d.draw, d.changeId),
  ].join("\n");
}

/** Assigns each draw its issue: first occurrences get their own, repeats point at the first draw of the change. */
export function planIssues(draws: readonly DrawForLedger[], index: LedgerIndex): { create: DrawForLedger[]; repeats: LedgerIndex["repeats"] } {
  const firstByChange = new Map<string, number>(index.issues.map((i) => [i.changeId, i.draw]));
  const create: DrawForLedger[] = [];
  const repeats: LedgerIndex["repeats"] = [];
  for (const d of [...draws].sort((a, b) => a.draw - b.draw)) {
    const first = firstByChange.get(d.changeId);
    if (first !== undefined && first !== d.draw) {
      if (!index.repeats.some((r) => r.draw === d.draw)) repeats.push({ draw: d.draw, changeId: d.changeId, sameAs: first });
      continue;
    }
    if (first === d.draw) continue;
    firstByChange.set(d.changeId, d.draw);
    create.push(d);
  }
  return { create, repeats };
}
