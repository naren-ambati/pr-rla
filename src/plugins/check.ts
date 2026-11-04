import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { INDEX_FILE } from "../ledgers/issue-index.js";
import { HostNotAllowed } from "../net/contract.js";
import type { DrawForLedger } from "../sdk/ledger.js";
import { runProviderConformance, type ConformanceFixture, type ConformanceReport } from "../testing/conformance.js";
import { LEDGER_CASES, runLedgerConformance, type CountedVerdict, type LedgerCase, type LedgerFixture } from "../testing/ledger-conformance.js";
import { describePlugin, hostedLedger, hostedProvider, startPluginHost, type HostOptions, type PluginHost } from "./host.js";
import { readGrants, type ResolvedPlugin } from "./lock.js";
import { ledgerIndexStore } from "./open.js";

/**
 * The conformance kit run through the plugin host (FR2.7): each instance the kit makes is a
 * fresh child, fed recorded responses by the parent. This is a correctness gate, never a
 * safety gate: a malicious plugin can pass it.
 */
export const CORRECTNESS_NOT_SAFETY = "conformance = correctness, not safety: a malicious plugin can pass it";

/** A recorded fixture, as scripts/record-fixture.mjs writes it (data only: no plugin code runs in the parent). */
export interface RecordedFixture {
  repo: string;
  window: { opensAt: string; closesAt: string };
  options?: Record<string, unknown>;
  kinds?: ("pull_request" | "direct_push")[];
  recordedAt?: string;
  exchanges: { method?: string; url: string; bodySha256: string | null; status: number; headers: Record<string, string>; response: unknown }[];
  /** Any of the kit's expectations (ids, pullRequests, directPushes, reviewStates, …); other keys are ignored. */
  expected: Record<string, unknown>;
}

/** The kit's expectations, by shape: a recording's other keys (or a count where the kit wants a list) are not expectations. */
const EXPECT_LISTS = ["ids", "pullRequests", "directPushes", "bots", "humans"] as const;
const EXPECT_MAPS = ["reviewStates", "reviewers", "actors", "changedLines", "prCommits", "mergeShas", "actorIds", "revokedApprovals"] as const;

function expectations(expected: Record<string, unknown>): ConformanceFixture["expect"] {
  const out: Record<string, unknown> = {};
  for (const k of EXPECT_LISTS) if (Array.isArray(expected[k])) out[k] = expected[k];
  for (const k of EXPECT_MAPS) if (expected[k] && typeof expected[k] === "object" && !Array.isArray(expected[k])) out[k] = expected[k];
  if (typeof expected.minPages === "number") out.minPages = expected.minPages;
  if (typeof expected.reviewGranularity === "string") out.reviewGranularity = expected.reviewGranularity;
  return out as ConformanceFixture["expect"];
}

/** Serves recorded exchanges by method, URL and body hash, in recorded order; an unrecorded request throws, so a check stays offline. */
export function replayFetch(rec: Pick<RecordedFixture, "exchanges">): typeof fetch & { served: () => number } {
  const queue = rec.exchanges.map((e) => ({ e, used: false }));
  let served = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body;
    const key = typeof body === "string" ? createHash("sha256").update(body).digest("hex") : body instanceof Uint8Array ? createHash("sha256").update(body).digest("hex") : null;
    const hit = queue.find((q) => !q.used && (q.e.method ?? "GET").toUpperCase() === method && q.e.url === url && q.e.bodySha256 === key);
    if (!hit) throw new Error(`unrecorded request ${method} ${url} (the fixture has no such exchange)`);
    hit.used = true;
    served++;
    return new Response(JSON.stringify(hit.e.response), { status: hit.e.status, headers: { "content-type": "application/json", ...hit.e.headers } });
  }) as typeof fetch & { served: () => number };
  f.served = () => served;
  return f;
}

export function readRecordedFixture(path: string): RecordedFixture {
  const rec = JSON.parse(readFileSync(path, "utf8")) as Partial<RecordedFixture>;
  if (typeof rec.repo !== "string" || !rec.window || !Array.isArray(rec.exchanges) || !rec.expected || typeof rec.expected !== "object") throw new Error(`${path}: not a recorded fixture (needs repo, window, exchanges and expected)`);
  return rec as RecordedFixture;
}

/**
 * Runs the provider kit through the host on recorded fixtures. Requests to hosts the plugin did not
 * declare are refused, as the broker would. The definition's traits (U3's `review-granularity`
 * check reads `reviewGranularity`) come from the child's `describe`, never from an import here.
 */
export async function hostedProviderConformance(plugin: ResolvedPlugin, label: string, fixtures: { name: string; rec: RecordedFixture }[], host: Partial<HostOptions> = {}): Promise<ConformanceReport> {
  const started: PluginHost[] = [];
  try {
    const first = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label, ...host });
    started.push(first);
    const { traits } = await describePlugin(first, fixtures[0]?.rec.options ?? {});
    first.close();
    const recs = new Map(fixtures.map((f) => [f.name, f.rec]));
    let last: ReturnType<typeof replayFetch> | null = null;
    const kit: ConformanceFixture[] = fixtures.map(({ name, rec }) => ({
      name,
      request: { repo: rec.repo, window: rec.window, kinds: rec.kinds ?? ["pull_request", "direct_push"] },
      expect: expectations(rec.expected),
      pagesServed: () => last?.served() ?? 0,
      http: true,
    }));
    return await runProviderConformance(async (f, harness) => {
      const rec = recs.get(f.name)!;
      const h = await startPluginHost({ kind: "provider", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label, ...host });
      started.push(h);
      const declared = (await describePlugin(h, rec.options ?? {})).hosts;
      const replay = (last = replayFetch(rec));
      const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (!declared.includes(u.host) && !declared.includes(u.hostname)) throw new HostNotAllowed(u.host, `provider:${String(h.ready.name)}`, declared);
        return replay(input, init);
      }) as typeof fetch;
      return hostedProvider(h, rec.options ?? {}, harness.context({ fetch: guarded, cwd: "." }));
    }, kit, { definition: { reviewGranularity: traits.reviewGranularity } });
  } finally {
    for (const h of started) h.close();
  }
}

export const fixtureName = (path: string) => basename(path);

/**
 * A recorded ledger fixture (FR4.7), data only, for `plugin check` on a ledger (finding 15): a
 * public tracker's responses as the ledger fetched them, the ledger's local index at the start
 * (LedgerContext.index, when it keeps one), and what the kit must find. Fixtures that need a
 * tracker to change between reads (an erasure, a publish) need code, so they stay in the ledger's
 * own test; `plugin check` runs the kit's cases a recording can show.
 */
export interface RecordedLedgerFixture {
  source: "recorded";
  case: LedgerCase;
  options?: Record<string, unknown>;
  index?: unknown;
  reviewers?: string[] | null;
  exchanges: RecordedFixture["exchanges"];
  expected: {
    draws: DrawForLedger[];
    counted: Record<string, CountedVerdict | null>;
    integrity: "PASS" | "WARN" | "FAIL";
    /** Each must be part of one of the integrity findings or warnings. */
    messages?: string[];
    minHistory?: number;
    seedPublishedAt?: string;
  };
}

const REPLAYABLE: readonly LedgerCase[] = LEDGER_CASES.filter((c) => c !== "idempotent-publish" && c !== "checkpoint-round-trip");

export function readRecordedLedgerFixture(path: string): RecordedLedgerFixture {
  const rec = JSON.parse(readFileSync(path, "utf8")) as Partial<RecordedLedgerFixture>;
  const e = rec.expected;
  if (rec.source !== "recorded" || !REPLAYABLE.includes(rec.case as LedgerCase) || !Array.isArray(rec.exchanges) || !e || !Array.isArray(e.draws) || !e.counted || typeof e.counted !== "object" || !["PASS", "WARN", "FAIL"].includes(e.integrity as string))
    throw new Error(`${path}: not a recorded ledger fixture (needs source "recorded", a case of ${REPLAYABLE.join(", ")}, exchanges and expected { draws, counted, integrity })`);
  return rec as RecordedLedgerFixture;
}

/**
 * Runs the ledger kit through the host on recorded ledger fixtures, as hostedProviderConformance
 * does for providers: every instance the kit makes is a fresh child, fed the recording by the
 * parent; requests to hosts the ledger did not declare are refused; its index is kept here.
 */
export async function hostedLedgerConformance(plugin: ResolvedPlugin, label: string, fixtures: { name: string; rec: RecordedLedgerFixture }[], host: Partial<HostOptions> = {}): Promise<ConformanceReport> {
  const started: PluginHost[] = [];
  const dirs: string[] = [];
  try {
    const recs = new Map(fixtures.map((f) => [f.name, f.rec]));
    const kit: LedgerFixture[] = fixtures.map(({ name, rec }) => ({
      name,
      case: rec.case,
      source: "recorded",
      http: true,
      draws: rec.expected.draws,
      ...(rec.reviewers !== undefined ? { reviewers: rec.reviewers } : {}),
      expect: {
        counted: Object.fromEntries(Object.entries(rec.expected.counted).map(([k, v]) => [Number(k), v])),
        integrity: rec.expected.integrity,
        ...(rec.expected.messages ? { messages: rec.expected.messages } : {}),
        ...(rec.expected.minHistory !== undefined ? { minHistory: rec.expected.minHistory } : {}),
        ...(rec.expected.seedPublishedAt !== undefined ? { seedPublishedAt: rec.expected.seedPublishedAt } : {}),
      },
    }));
    return await runLedgerConformance(async (f, harness) => {
      const rec = recs.get(f.name)!;
      const h = await startPluginHost({ kind: "ledger", entry: plugin.entry, readPaths: readGrants(plugin), env: { PR_RLA_HOST: "1" }, label, ...host });
      started.push(h);
      const declared = (await describePlugin(h, rec.options ?? {})).hosts;
      const windowDir = mkdtempSync(join(tmpdir(), "prrla-check-ledger-"));
      dirs.push(windowDir);
      if (rec.index !== undefined) writeFileSync(join(windowDir, INDEX_FILE), JSON.stringify(rec.index));
      const replay = replayFetch(rec);
      const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (!declared.includes(u.host) && !declared.includes(u.hostname)) throw new HostNotAllowed(u.host, `ledger:${String(h.ready.name)}`, declared);
        return replay(input, init);
      }) as typeof fetch;
      const lctx = harness.context({ fetch: guarded, windowDir });
      return hostedLedger(h, rec.options ?? {}, { cwd: windowDir, windowDir, fetch: lctx.fetch, log: lctx.log, ...(lctx.sleep ? { sleep: lctx.sleep } : {}), ...(f.reviewers !== undefined ? { reviewers: f.reviewers } : {}), index: ledgerIndexStore({ mode: "read-write" }, windowDir) });
    }, kit);
  } finally {
    for (const h of started) h.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
}
