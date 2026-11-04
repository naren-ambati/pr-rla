import { existsSync } from "node:fs";
import { readTextConfined } from "../io/confine.js";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../core/canonical.js";
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
  /** The tracker's own numeric id, as a string (GitHub's issue `id`, not its node id; GitLab's `id`; Jira's id). */
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
  // (P1) No `foreignIssues`: issues pr-rla did not open are a test-only ledger option now (`foreign_issues`),
  // never an index field, and an audit index that carries one FAILs check 7.
}

export function indexPath(windowDir: string): string {
  return join(windowDir, INDEX_FILE);
}

export function readIndex(windowDir: string): LedgerIndex | null {
  const p = indexPath(windowDir);
  if (!existsSync(p)) return null;
  let v: LedgerIndex;
  try {
    v = JSON.parse(readTextConfined(p, "the ledger index")) as LedgerIndex;
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`${p}: not valid JSON`);
    throw e;
  }
  if (v.schema !== "pr-rla/ledger-index/v1") throw new Error(`${p}: not a pr-rla ledger index (schema ${String(v.schema)})`);
  return v;
}

/**
 * `sha256` of the index as a document: the canonical JSON (sorted keys, no whitespace) of the file's
 * parsed content, so line endings and indentation do not matter. `sample` records it in draws.json
 * and `checkpoint` in each checkpoint line; `verify` compares both with the file as it is now
 * (contracts.md §5). Any ledger's index counts, the built-in schema or an external ledger's own.
 */
export function ledgerIndexSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * The window's `ledger-index.json` as parsed JSON with its hash, or null when there is none. Does not check
 * the schema (an external ledger keeps its own). A file that is not JSON comes back with `error` set and
 * the hash of its bytes, so `verify` can FAIL on it instead of crashing.
 */
export function readIndexDocument(windowDir: string): { sha256: string; value: unknown; error?: string } | null {
  const p = indexPath(windowDir);
  if (!existsSync(p)) return null;
  // Confined in a read-only call (src/io/confine.ts); the parse error is not quoted, as it would carry the file's bytes.
  const text = readTextConfined(p, "the ledger index");
  try {
    const value: unknown = JSON.parse(text);
    return { sha256: ledgerIndexSha256(value), value };
  } catch {
    return { sha256: sha256Hex(text), value: null, error: `${INDEX_FILE} is not valid JSON` };
  }
}

/**
 * What is wrong with the index on its own, before any tracker is read (finding 3): two draws
 * sharing one issue (a verdict would count for both), an issue listed twice by number or id, a
 * change with two issues, a repeat that points nowhere. Issue numbers compare as text, so `7` and
 * `"7"` are one number. Each string is a FAIL.
 */
export function indexProblems(index: Pick<LedgerIndex, "issues" | "repeats">): string[] {
  const out: string[] = [];
  const dup = <T>(items: readonly T[], key: (t: T) => string, what: (k: string, a: T, b: T) => string) => {
    const seen = new Map<string, T>();
    for (const t of items) {
      const k = key(t);
      const prior = seen.get(k);
      if (prior !== undefined) out.push(what(k, prior, t));
      else seen.set(k, t);
    }
  };
  dup(index.issues, (i) => String(i.draw), (k) => `ledger index lists draw #${k} twice`);
  dup(index.issues, (i) => String(i.number), (k, a, b) => `ledger index gives draws #${a.draw} and #${b.draw} the same issue number ${k}: one verdict would count for both`);
  dup(index.issues, (i) => String(i.id), (k, a, b) => `ledger index gives draws #${a.draw} and #${b.draw} the same issue id ${k}`);
  dup(index.issues, (i) => i.changeId, (k, a, b) => `ledger index opens two issues (draws #${a.draw} and #${b.draw}) for ${k}; a change drawn twice has one issue`);
  const byDraw = new Map(index.issues.map((i) => [i.draw, i]));
  const repeated = new Set<number>();
  for (const r of index.repeats) {
    if (repeated.has(r.draw)) out.push(`ledger index lists repeated draw #${r.draw} twice`);
    repeated.add(r.draw);
    const first = byDraw.get(r.sameAs);
    if (byDraw.has(r.draw)) out.push(`ledger index lists draw #${r.draw} as both an issue and a repeat`);
    if (!first) out.push(`ledger index: repeated draw #${r.draw} points at draw #${r.sameAs}, which has no issue`);
    else if (first.changeId !== r.changeId) out.push(`ledger index: repeated draw #${r.draw} is ${r.changeId} but draw #${r.sameAs}'s issue is for ${first.changeId}`);
  }
  return out;
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
