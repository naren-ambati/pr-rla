import { canonicalJson, sha256Hex } from "./canonical.js";
import { identityDiffs } from "./plugin-binding.js";
import type { PluginIdentity, SignedRecord, TimestampEvidence } from "./records.js";
import { verifySignedRecord } from "./signing.js";

/**
 * The ledger publication record (P1; pass-2 review #1, the coordinator's decision): what binds an issue
 * ledger's draw → issue mapping by time, before any verdict can exist on the issues.
 *
 * `ledger-index.json` is the auditee's file: it names, for each draw, the issue its verdict is read from.
 * Nothing stops an edit that points a failing draw at a passing draw's issue, and the issue bodies are
 * editable too. So `sample`, right after the ledger opens the issues, signs the index it left and has the
 * registered authorities time-stamp it (SHA-256 digests only, like every other record), and appends that
 * record to `audit/<window>/ledger-publication.json`. Each later `sample --through` appends a record whose
 * index extends the previous one (append-only: the same entries for every earlier draw).
 *
 * Check 7 (and status, through src/core/ledger-gate.ts) then FAILs when the current index is not an
 * extension of the latest publication, when an issue a verdict was read from is in no proven publication,
 * and when no proven publication listing an issue was time-stamped at or before the earliest counted
 * verdict on it. The requirement is keyed on the signed registration (schema v2 and a registered ledger
 * that publishes draws), never on a field of an unsigned file.
 *
 * Pure: the API reads and writes the file (src/api/read/publications.ts, src/api/write/sample.ts).
 */

export const PUBLICATION_FILE = "ledger-publication.json";

/** What the authorities time-stamp: one publication of the index. */
export interface LedgerPublicationRecord {
  schema: "pr-rla/ledger-publication/v1";
  window: string;
  registrationSha256: string;
  /** The manifest whose draws the index publishes. */
  manifestSha256: string;
  /** The registered ledger (P1: sample runs no other). */
  ledger: PluginIdentity;
  /** 1 for the first record in the file, then 2, 3, … */
  sequence: number;
  /** `sha256` of the previous record in the file; null for the first. */
  previousSha256: string | null;
  /** The issued draws this publication covers: draws 1 to `through`. */
  draws: { through: number };
  /** `ledgerIndexSha256` of `index`: the index exactly as the ledger left it. */
  ledgerIndexSha256: string;
  /** The index itself: for each draw its issue (number or key, id and url), the repeats, the labels or options. */
  index: unknown;
  /** The signed time; the tokens bound it. */
  publishedAt: string;
  prRlaVersion: string;
}

export type SignedPublication = SignedRecord<LedgerPublicationRecord> & { timestamps: TimestampEvidence[] };

export interface LedgerPublicationsFile {
  schema: "pr-rla/ledger-publications/v1";
  publications: SignedPublication[];
}

/** The file as read: its publications in order, and what makes it unreadable (each a FAIL). */
export interface ReadPublications {
  publications: SignedPublication[];
  problems: string[];
}

export function parsePublications(text: string): ReadPublications {
  let v: Partial<LedgerPublicationsFile>;
  try {
    v = JSON.parse(text) as Partial<LedgerPublicationsFile>;
  } catch {
    return { publications: [], problems: [`${PUBLICATION_FILE} is not valid JSON`] };
  }
  if (!v || v.schema !== "pr-rla/ledger-publications/v1" || !Array.isArray(v.publications)) return { publications: [], problems: [`${PUBLICATION_FILE} is not a pr-rla/ledger-publications/v1 file`] };
  const problems: string[] = [];
  const publications: SignedPublication[] = [];
  v.publications.forEach((p, i) => {
    const r = (p as Partial<SignedPublication> | null)?.record as Partial<LedgerPublicationRecord> | undefined;
    if (!p || typeof p !== "object" || !r || r.schema !== "pr-rla/ledger-publication/v1" || typeof p.sha256 !== "string" || typeof p.signature !== "string" || typeof p.publicKeyPem !== "string") {
      problems.push(`${PUBLICATION_FILE}: publication ${i + 1} is not a signed pr-rla/ledger-publication/v1 record`);
      return;
    }
    publications.push({ ...(p as SignedPublication), timestamps: Array.isArray(p.timestamps) ? p.timestamps : [] });
  });
  return { publications, problems };
}

/** The new file with `p` appended. */
export function appendPublicationFile(prior: readonly SignedPublication[], p: SignedPublication): LedgerPublicationsFile {
  return { schema: "pr-rla/ledger-publications/v1", publications: [...prior, p] };
}

/** SHA-256 of an index as a document (the same as src/ledgers/issue-index.ts `ledgerIndexSha256`). */
export const indexDigest = (value: unknown): string => sha256Hex(canonicalJson(value));

type Entry = { draw?: unknown } & Record<string, unknown>;
const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const entries = (v: unknown, k: "issues" | "repeats"): Entry[] | null => {
  const o = asObject(v);
  return o && Array.isArray(o[k]) ? (o[k] as Entry[]) : null;
};
const header = (v: unknown): string => {
  const o = asObject(v);
  if (!o) return canonicalJson(v);
  const { issues: _i, repeats: _r, ...rest } = o;
  return canonicalJson(rest);
};
/** How an issue is named in messages: its number, or a Jira-style key. */
export const issueName = (e: Entry | undefined): string => {
  if (!e) return "no issue";
  const n = e.number ?? e.key;
  return typeof n === "number" || typeof n === "string" ? `#${String(n).replace(/^#/, "")}` : "an issue";
};

/**
 * What makes `next` not an append-only extension of `prev` (each a FAIL): any field besides the issues and
 * repeats changed (the labels, a Jira field's option ids, the tracker); an issue `prev` lists is gone or
 * different in any field (number, id, url, change); a repeat likewise. An index without an `issues` list
 * (an external ledger's own shape) must be unchanged.
 */
export function indexExtensionProblems(prev: unknown, next: unknown, what: { prev: string; next: string }): string[] {
  const out: string[] = [];
  const pi = entries(prev, "issues");
  const ni = entries(next, "issues");
  if (pi === null || ni === null) {
    if (canonicalJson(prev) !== canonicalJson(next)) out.push(`${what.next} is not ${what.prev}: an index with no issues list can only be published once`);
    return out;
  }
  if (header(prev) !== header(next)) {
    const p = asObject(prev) ?? {};
    const n = asObject(next) ?? {};
    const keys = [...new Set([...Object.keys(p), ...Object.keys(n)])].filter((k) => k !== "issues" && k !== "repeats" && canonicalJson(p[k] ?? null) !== canonicalJson(n[k] ?? null)).sort();
    out.push(`${what.next} changes ${keys.map((k) => `"${k}"`).join(", ")} from ${what.prev}: the labels, options and tracker an index was published with are fixed`);
  }
  const byDraw = new Map(ni.map((e) => [String(e.draw), e]));
  for (const e of pi) {
    const now = byDraw.get(String(e.draw));
    if (!now) out.push(`draw #${String(e.draw)}: ${what.prev} lists issue ${issueName(e)}, and ${what.next} lists none`);
    else if (canonicalJson(now) !== canonicalJson(e)) out.push(`draw #${String(e.draw)}: ${what.prev} lists issue ${issueName(e)} (${canonicalJson(pickIssue(e))}), but ${what.next} has ${issueName(now)} (${canonicalJson(pickIssue(now))})`);
  }
  const pr = entries(prev, "repeats") ?? [];
  const nr = new Map((entries(next, "repeats") ?? []).map((e) => [String(e.draw), e]));
  for (const e of pr) {
    const now = nr.get(String(e.draw));
    if (!now || canonicalJson(now) !== canonicalJson(e)) out.push(`repeated draw #${String(e.draw)}: ${what.prev} records it as ${canonicalJson(e)}, ${what.next} as ${now ? canonicalJson(now) : "nothing"}`);
  }
  return out;
}

const pickIssue = (e: Entry) => Object.fromEntries(["number", "key", "id", "url", "changeId"].filter((k) => k in e).map((k) => [k, e[k]]));

/** An issue's place in the tracker's own order: its number, or the number in a `KEY-123` key. */
export function issueOrdinal(e: Entry): bigint | null {
  const n = e.number ?? e.key;
  if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) return BigInt(n);
  if (typeof n === "string") {
    const m = /^(?:[A-Z][A-Z0-9_]*-)?(\d{1,18})$/.exec(n);
    if (m) return BigInt(m[1]!);
  }
  return null;
}

/**
 * pr-rla opens a window's issues in draw order, so their numbers rise strictly with the draw number (P1):
 * any permutation of issues between draws breaks it. Each string is a FAIL. An index with no issues list is
 * not ordered.
 */
export function issueOrderProblems(index: unknown, what = "the ledger index"): string[] {
  const list = entries(index, "issues");
  if (!list) return [];
  const out: string[] = [];
  const sorted = [...list].sort((a, b) => Number(a.draw) - Number(b.draw));
  let prev: { draw: unknown; n: bigint; e: Entry } | null = null;
  for (const e of sorted) {
    const n = issueOrdinal(e);
    if (n === null) {
      out.push(`${what}: draw #${String(e.draw)}'s issue ${issueName(e)} has no number to order it by (pr-rla opens issues in draw order, so each must be a positive number or a KEY-number)`);
      continue;
    }
    if (prev && n <= prev.n) out.push(`${what}: draw #${String(e.draw)} is issue ${issueName(e)}, not after draw #${String(prev.draw)}'s ${issueName(prev.e)}: pr-rla opens issues in draw order, so issue numbers rise with the draws; these were swapped or re-pointed`);
    prev = { draw: e.draw, n, e };
  }
  return out;
}

/** The issue entry a verdict for `draw` is read from in `index` (a repeat reads its first draw's issue); the whole index for an index with no issues list. */
export function issueEntryFor(index: unknown, draw: number): { draw: number; entry: unknown } | null {
  const list = entries(index, "issues");
  if (!list) return index === null || index === undefined ? null : { draw, entry: index };
  const first = (entries(index, "repeats") ?? []).find((r) => r.draw === draw)?.sameAs;
  const d = typeof first === "number" ? first : draw;
  const e = list.find((x) => x.draw === d);
  return e ? { draw: d, entry: e } : null;
}

/** Whether publication `p` lists exactly `entry` for `draw`. */
const lists = (p: LedgerPublicationRecord, draw: number, entry: unknown): boolean => {
  const e = issueEntryFor(p.index, draw);
  return !!e && e.draw === draw && canonicalJson(e.entry) === canonicalJson(entry);
};

/** A publication's time as check 7 counts it: proven (U_k of the registered authorities) or, with none registered, its signed time. */
export interface PublicationTime {
  /** The upper bound on when the record existed (ms): U_k, or the signed time when no authority is registered. */
  boundMs: number | null;
  /** True when k registered authorities agree (U_k); false when it rests on the signer's clock. */
  proven: boolean;
  /** Tokens from registered authorities that fail rules 1–7 (verify FAILs these with the token lines). */
  failed: number;
}

export interface PublicationInput {
  /** Keyed on the signed registration (schema v2, and a registered ledger that publishes draws). */
  required: boolean;
  /** The registration names timestamp authorities (k ≥ 1): a publication counts only when proven. */
  authoritiesRegistered: boolean;
  registration: { sha256: string; publicKeyPem: string; window: string; ledger: PluginIdentity | null };
  manifestSha256: string;
  file: ReadPublications | null;
  times: readonly PublicationTime[];
  /** The window's ledger-index.json now (null: none). */
  index: { value: unknown; sha256: string } | null;
  /** The issued draws (verified ones in verify). */
  draws: readonly { draw: number; changeId: string; firstOccurrence: boolean }[];
  issued: number;
  /** Every verdict event read (null: the ledger was not read). */
  verdictsRead: readonly { draw: number; changeId: string; recordedAt: string }[] | null;
  /** The counted first verdicts (one per counted change). */
  counted: readonly { draw: number; changeId: string; recordedAt: string }[] | null;
}

export interface PublicationFindings {
  fails: string[];
  warns: string[];
  notes: string[];
}

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** Check 7's publication rules (P1). Pure. */
export function publicationFindings(i: PublicationInput): PublicationFindings {
  const out: PublicationFindings = { fails: [], warns: [], notes: [] };
  const pubs = i.file?.publications ?? [];
  for (const p of i.file?.problems ?? []) out.fails.push(p);
  if (!pubs.length) {
    if (i.issued > 0 && (i.required || i.index)) {
      if (i.required) out.fails.push(`the registration requires a time-stamped ledger publication record (${PUBLICATION_FILE}) for this ledger, and there is none: the draw → issue mapping is bound to nothing the auditee could not rewrite after the verdicts; "pr-rla sample" writes it when it opens the issues`);
      else out.warns.push(`the draw → issue mapping is bound by no ledger publication record (${PUBLICATION_FILE}): it was sampled by an earlier pr-rla, or the registration (schema v1) does not require one`);
    }
    return out;
  }
  // The file's own integrity: each record signed by the registration's key, for this audit, chained and append-only.
  let prev: SignedPublication | null = null;
  pubs.forEach((p, n) => {
    const r = p.record;
    const what = `publication #${n + 1}`;
    const sig = verifySignedRecord(p);
    if (!sig.ok) out.fails.push(`${PUBLICATION_FILE} ${what}: signature: ${sig.reason}`);
    if (p.publicKeyPem.trim() !== i.registration.publicKeyPem.trim()) out.fails.push(`${PUBLICATION_FILE} ${what} is signed by a different key than the registration`);
    if (r.registrationSha256 !== i.registration.sha256) out.fails.push(`${PUBLICATION_FILE} ${what} names a different registration`);
    if (r.manifestSha256 !== i.manifestSha256) out.fails.push(`${PUBLICATION_FILE} ${what} names a different manifest`);
    if (r.window !== i.registration.window) out.fails.push(`${PUBLICATION_FILE} ${what} is for window ${r.window}, not ${i.registration.window}`);
    if (i.registration.ledger) {
      const d = identityDiffs(i.registration.ledger, r.ledger);
      if (d.length) out.fails.push(`${PUBLICATION_FILE} ${what} was made for a ledger that is not the registered one (${d.join("; ")})`);
    }
    if (r.sequence !== n + 1 || r.previousSha256 !== (prev ? prev.sha256 : null)) out.fails.push(`${PUBLICATION_FILE} is not append-only: ${what} ${r.sequence !== n + 1 ? `says it is #${r.sequence}` : `does not follow #${n} (previousSha256 ${String(r.previousSha256).slice(0, 12)}…)`}; a publication was removed, reordered or edited`);
    if (r.ledgerIndexSha256 !== indexDigest(r.index)) out.fails.push(`${PUBLICATION_FILE} ${what}: its ledgerIndexSha256 is not the hash of the index it holds`);
    out.fails.push(...issueOrderProblems(r.index, `${PUBLICATION_FILE} ${what}`));
    if (prev) {
      if (r.draws.through < prev.record.draws.through) out.fails.push(`${PUBLICATION_FILE} ${what} covers draws 1–${r.draws.through}, fewer than #${n} (1–${prev.record.draws.through})`);
      out.fails.push(...indexExtensionProblems(prev.record.index, r.index, { prev: `publication #${n}`, next: what }).map((x) => `${PUBLICATION_FILE}: ${x}`));
    }
    prev = p;
  });
  // The index now must extend the latest publication.
  const latest = pubs.at(-1)!;
  if (!i.index) out.fails.push(`ledger-index.json is missing, but ${PUBLICATION_FILE} published it (sha256 ${latest.record.ledgerIndexSha256.slice(0, 12)}…)`);
  else {
    const ext = indexExtensionProblems(latest.record.index, i.index.value, { prev: `publication #${pubs.length}`, next: "ledger-index.json" });
    if (ext.length) out.fails.push(...ext.map((x) => `the ledger index is not an append-only extension of what was published: ${x}`));
    out.fails.push(...issueOrderProblems(i.index.value));
  }
  // Which publications count, and from when.
  const counts = (n: number) => {
    const t = i.times[n];
    return !!t && t.failed === 0 && t.boundMs !== null && (t.proven || !i.authoritiesRegistered);
  };
  if (!i.authoritiesRegistered) out.warns.push(`the ledger publication records are not time-stamped (the registration names no timestamp authority): TIMESTAMP NOT TAMPER-PROOF; the draw → issue mapping rests on the auditee's own signature and clock`);
  else {
    const unproven = pubs.map((_, n) => n).filter((n) => !counts(n));
    if (unproven.length) out.notes.push(`${PUBLICATION_FILE}: publication${unproven.length > 1 ? "s" : ""} ${unproven.map((n) => `#${n + 1}`).join(", ")} ${unproven.length > 1 ? "are" : "is"} not proven (too few timestamps, or a failing token) and count${unproven.length > 1 ? "" : "s"} for nothing`);
  }
  if (!i.index) return out;
  // Every issue a verdict was read from is in a counted publication; the earliest counted verdict on it came after one.
  const firstListing = (draw: number, entry: unknown): { n: number; boundMs: number } | null => {
    for (let n = 0; n < pubs.length; n++) if (counts(n) && lists(pubs[n]!.record, draw, entry)) return { n, boundMs: i.times[n]!.boundMs! };
    return null;
  };
  const unpublished = new Map<number, string>();
  for (const v of i.verdictsRead ?? []) {
    const e = issueEntryFor(i.index.value, v.draw);
    if (!e) continue;
    if (!firstListing(e.draw, e.entry)) unpublished.set(e.draw, issueName(e.entry as Entry));
  }
  for (const [draw, name] of unpublished)
    out.fails.push(`a verdict on draw #${draw} was read from issue ${name}, which no ${i.authoritiesRegistered ? "proven (time-stamped) " : ""}publication record lists: run "pr-rla sample" to publish the issues before anyone records a verdict on them`);
  const earliest = new Map<number, { at: number; v: { changeId: string; recordedAt: string } }>();
  for (const v of i.counted ?? []) {
    const e = issueEntryFor(i.index.value, v.draw);
    if (!e) continue;
    const at = Date.parse(v.recordedAt);
    const cur = earliest.get(e.draw);
    if (!cur || at < cur.at) earliest.set(e.draw, { at, v });
  }
  for (const [draw, { at, v }] of earliest) {
    if (unpublished.has(draw)) continue;
    const e = issueEntryFor(i.index.value, draw)!;
    const first = firstListing(e.draw, e.entry)!;
    if (first.boundMs > at)
      out.fails.push(`the counted verdict on draw #${draw} (${v.changeId}, issue ${issueName(e.entry as Entry)}) was recorded ${v.recordedAt}, but the first publication listing that issue (#${first.n + 1}) ${i.authoritiesRegistered ? "was proven to exist only by" : "was signed at"} ${iso(first.boundMs)}: the mapping it was read through was published after the verdict existed`);
  }
  const extra = (entries(i.index.value, "issues") ?? []).filter((e) => typeof e.draw === "number" && !firstListing(e.draw as number, e)).map((e) => Number(e.draw));
  const notRead = extra.filter((d) => !unpublished.has(d));
  if (notRead.length) out.warns.push(`draw${notRead.length > 1 ? "s" : ""} ${notRead.slice(0, 10).map((d) => `#${d}`).join(", ")}${notRead.length > 10 ? ", …" : ""} ${notRead.length > 1 ? "have issues" : "has an issue"} in the ledger index that no ${i.authoritiesRegistered ? "proven " : ""}publication record lists: run "pr-rla sample" again to publish ${notRead.length > 1 ? "them" : "it"} before anyone records a verdict there`);
  return out;
}
