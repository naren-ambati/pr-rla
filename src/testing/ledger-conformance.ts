import { canonicalJson, sha256Hex } from "../core/canonical.js";
import {
  PROVENANCE_LEVELS,
  SUPPORTED_LEDGER_API_VERSIONS,
  canonicalHistory,
  historyDiff,
  historyEventProblems,
  verdictEventProblems,
  verdictIneligibility,
  type DrawForLedger,
  type Ledger,
  type LedgerContext,
  type LedgerHistoryEvent,
  type LedgerIntegrityReport,
  type PublishContext,
  type Verdict,
  type VerdictEvent,
} from "../sdk/ledger.js";
import { INJECTED_RETRY_AFTER_SECONDS, makeHarness, type ConformanceHarness, type ConformanceReport, type ConformanceResult, type Fault, type Harness } from "./conformance.js";

/**
 * The ledger conformance kit (`runLedgerConformance`, FR4.6; contracts.md §1). Framework-agnostic,
 * like the provider kit: it returns a report, and `assertLedgerConformance` throws.
 *
 * A ledger author wires the ledger to recorded or fake tracker data and declares, per fixture,
 * which case of the design it exercises and what must come out: the verdict that counts per draw
 * and the integrity result. The kit checks the declaration against the design's rule for the case
 * (a removal after counting must FAIL, a same-verdict relabel must WARN, …) and the ledger against
 * the declaration, then re-runs the reads under injected transient faults.
 */

export const LEDGER_CASES = [
  "first-label",
  "relabel-same",
  "relabel-opposite",
  "removal",
  "deletion",
  "label-rename",
  "unlisted-reviewer",
  "app-applied",
  "verdict-before-seed",
  "pagination",
  "idempotent-publish",
  "checkpoint-round-trip",
] as const;
export type LedgerCase = (typeof LEDGER_CASES)[number];

export const LEDGER_CONFORMANCE_CHECKS = ["api-version", "normalization", "first-label", "integrity", ...LEDGER_CASES.filter((c) => c !== "first-label"), "transient-faults"] as const;
export type LedgerConformanceCheck = (typeof LEDGER_CONFORMANCE_CHECKS)[number];

/** The integrity result the design requires for each case (functional-design.md §U4, FR4.3). */
const REQUIRED: Partial<Record<LedgerCase, LedgerFixture["expect"]["integrity"]>> = {
  "first-label": "PASS",
  "relabel-same": "WARN",
  "relabel-opposite": "WARN",
  removal: "FAIL",
  deletion: "FAIL",
  "label-rename": "FAIL",
};

export interface CountedVerdict {
  verdict: Verdict;
  reviewer: string;
  recordedAt: string;
}

export interface LedgerFixture {
  name: string;
  case: LedgerCase;
  /** Where the tracker data comes from (FR4.7): a read-only recording of a public tracker, or synthetic. */
  source: "recorded" | "synthetic";
  /** The registered reviewers the ledger is opened with (null: any account that is not a bot or an app). */
  reviewers?: string[] | null;
  /** The draws the fixture's index covers (and, for idempotent-publish, the draws to publish). */
  draws: DrawForLedger[];
  expect: {
    /** Per draw number: the verdict that counts (the first eligible one), or null for none. */
    counted: Record<number, CountedVerdict | null>;
    integrity: "PASS" | "WARN" | "FAIL";
    /** Each must match one of the integrity findings or warnings. */
    messages?: (string | RegExp)[];
    /** pagination: at least this many history events (default 101). */
    minHistory?: number;
    /** verdict-before-seed: the seed's publish time; the counted verdict must carry the tracker's earlier time. */
    seedPublishedAt?: string;
  };
  /** The ledger talks HTTP: its requests must go through the harness, and the transient-fault check runs. */
  http?: boolean;
  /** checkpoint-round-trip: the factory, in phase "after-erasure", serves the tracker without this event. */
  erasedEventId?: string;
  /** idempotent-publish: the publish context, and how to drop the ledger's local index between runs 2 and 3. */
  publish?: PublishContext;
  forgetLocalState?: () => void | Promise<void>;
}

/** Which tracker state the factory must serve. */
export type LedgerPhase = "clean" | "repeat" | "faults" | "after-erasure" | "publish-1" | "publish-2" | "publish-3";

export interface LedgerHarness extends Omit<ConformanceHarness, "context"> {
  readonly phase: LedgerPhase;
  /** A LedgerContext whose fetch is the harness's and whose sleep records waits. */
  context(base: { fetch: typeof fetch; windowDir: string } & Partial<LedgerContext>): LedgerContext;
  /** Requests through the harness that were not GET or HEAD. */
  writes(): number;
}

export type LedgerUnderTest = (fixture: LedgerFixture, harness: LedgerHarness) => Ledger | Promise<Ledger>;

function ledgerHarness(phase: LedgerPhase, reviewers: readonly string[] | null | undefined, faults: readonly Fault[] = []): LedgerHarness & { inner: Harness } {
  const h = makeHarness(faults);
  return {
    inner: h,
    phase,
    wrapFetch: h.wrapFetch,
    sleep: h.sleep,
    requests: h.requests,
    writes: () => h.log.filter((x) => x.method !== "GET" && x.method !== "HEAD").length,
    context: (base) => ({ cwd: ".", env: {}, log: () => {}, ...(reviewers !== undefined ? { reviewers } : {}), ...base, fetch: h.wrapFetch(base.fetch), sleep: h.sleep }),
  };
}

type Reads = { verdicts: VerdictEvent[]; integrity: LedgerIntegrityReport | null; history: LedgerHistoryEvent[] | null };

async function readAll(l: Ledger): Promise<Reads> {
  return { verdicts: await l.readVerdicts(), integrity: l.verifyIntegrity ? await l.verifyIntegrity() : null, history: l.readHistory ? await l.readHistory() : null };
}

const integrityOf = (r: LedgerIntegrityReport | null): "PASS" | "WARN" | "FAIL" => (!r ? "WARN" : !r.ok ? "FAIL" : r.warnings?.length || !r.tamperTrail ? "WARN" : "PASS");

/** The first eligible verdict per draw, as the core counts it. */
export function countedVerdicts(verdicts: readonly VerdictEvent[], reviewers?: readonly string[] | null): Map<number, VerdictEvent> {
  const out = new Map<number, VerdictEvent>();
  for (const v of verdicts) if (!out.has(v.draw) && !verdictIneligibility(v, reviewers)) out.set(v.draw, v);
  return out;
}

const matches = (msgs: readonly string[], p: string | RegExp) => msgs.some((m) => (typeof p === "string" ? m.includes(p) : p.test(m)));

export async function runLedgerConformance(ledger: LedgerUnderTest, fixtures: readonly LedgerFixture[]): Promise<ConformanceReport> {
  const results: ConformanceResult[] = [];
  for (const f of fixtures) {
    const push = (check: LedgerConformanceCheck, ok: boolean, message?: string) => results.push({ fixture: f.name, check, ok, ...(message && !ok ? { message } : {}) });
    const skip = (check: LedgerConformanceCheck, message: string) => results.push({ fixture: f.name, check, ok: true, skipped: true, message });
    if (f.source !== "recorded" && f.source !== "synthetic") {
      push("normalization", false, `fixture source must be "recorded" or "synthetic" (FR4.7), got ${JSON.stringify(f.source)}`);
      continue;
    }

    if (f.case === "idempotent-publish") {
      results.push(...(await idempotentPublish(ledger, f)));
      continue;
    }

    const h1 = ledgerHarness("clean", f.reviewers);
    const l1 = await ledger(f, h1);
    push("api-version", SUPPORTED_LEDGER_API_VERSIONS.includes(l1.apiVersion) && /^[a-z0-9][a-z0-9-]*$/.test(l1.name), `apiVersion ${l1.apiVersion} / name ${l1.name}`);
    let clean: Reads;
    try {
      clean = await readAll(l1);
    } catch (e) {
      push("normalization", false, `a read threw: ${(e as Error).message}`);
      continue;
    }
    const cleanRequests = h1.requests();

    const np: string[] = [];
    const draws = new Set(f.draws.map((d) => d.draw));
    for (const v of clean.verdicts) {
      const p = verdictEventProblems(v);
      if (p.length) np.push(`verdict on draw #${v.draw}: ${p.join("; ")}`);
      if (!draws.has(v.draw)) np.push(`verdict on draw #${v.draw}, which the fixture does not index`);
      if (!v.provenance || !PROVENANCE_LEVELS.includes(v.provenance.level) || typeof v.provenance.source !== "string") np.push(`verdict on draw #${v.draw} has no provenance { level, source }`);
    }
    if (!clean.history) np.push("the ledger has no readHistory(), so it cannot be checkpointed");
    for (const e of clean.history ?? []) {
      const p = historyEventProblems(e);
      if (p.length) np.push(`history event ${e.id}: ${p.join("; ")}`);
    }
    if (!clean.integrity) np.push("the ledger has no verifyIntegrity()");
    push("normalization", np.length === 0, np.join("; "));

    const counted = countedVerdicts(clean.verdicts, f.reviewers);
    const fl: string[] = [];
    for (const [draw, want] of Object.entries(f.expect.counted)) {
      const got = counted.get(Number(draw));
      const shape = (x: CountedVerdict | VerdictEvent | null | undefined) => (x ? canonicalJson({ verdict: x.verdict, reviewer: x.reviewer, recordedAt: x.recordedAt }) : "none");
      if (shape(got) !== shape(want)) fl.push(`draw #${draw}: counted ${shape(got)}, expected ${shape(want)}`);
    }
    push("first-label", fl.length === 0, fl.join("; "));

    const ip: string[] = [];
    const required = REQUIRED[f.case];
    if (required && f.expect.integrity !== required) ip.push(`the fixture declares ${f.expect.integrity}, but the design requires ${required} for ${f.case}`);
    const got = integrityOf(clean.integrity);
    if (got !== f.expect.integrity) ip.push(`integrity ${got}, expected ${f.expect.integrity}: ${[...(clean.integrity?.findings ?? []), ...(clean.integrity?.warnings ?? [])].join(" | ") || "no findings"}`);
    const msgs = [...(clean.integrity?.findings ?? []), ...(clean.integrity?.warnings ?? [])];
    for (const p of f.expect.messages ?? []) if (!matches(msgs, p)) ip.push(`no finding matches ${String(p)} (findings: ${msgs.join(" | ") || "none"})`);
    if (clean.integrity && clean.integrity.tamperTrail !== true && f.http) ip.push("an issue-tracker ledger has an external tamper trail (tamperTrail: true)");
    push("integrity", ip.length === 0, ip.join("; "));

    const cp: string[] = [];
    switch (f.case) {
      case "first-label":
      case "relabel-same":
      case "relabel-opposite":
      case "removal":
      case "deletion":
      case "label-rename":
        if (f.case !== "first-label") push(f.case, ip.length === 0 && fl.length === 0, "see the integrity and first-label results");
        break;
      case "unlisted-reviewer": {
        if (!f.reviewers) cp.push("the fixture registers no reviewers");
        const unlisted = clean.verdicts.filter((v) => verdictIneligibility(v, f.reviewers)?.includes("not a registered reviewer"));
        if (!unlisted.length) cp.push("no verdict event by an unlisted account came back from readVerdicts (the ledger must return it, so it is reported as ignored)");
        if (unlisted.some((u) => counted.get(u.draw) === u)) cp.push("an unlisted reviewer's verdict counted");
        push("unlisted-reviewer", cp.length === 0, cp.join("; "));
        break;
      }
      case "app-applied": {
        const apps = clean.verdicts.filter((v) => /^applied by (app|bot)/.test(verdictIneligibility(v, null) ?? ""));
        if (!apps.length) cp.push("no verdict event applied by an app or bot account came back (it must be returned with a [bot] reviewer or viaApp, so it is reported as ignored)");
        if (apps.some((a) => counted.get(a.draw) === a)) cp.push("an app-applied verdict counted");
        push("app-applied", cp.length === 0, cp.join("; "));
        break;
      }
      case "verdict-before-seed": {
        const seed = f.expect.seedPublishedAt;
        const early = [...counted.values()].filter((v) => seed && Date.parse(v.recordedAt) < Date.parse(seed));
        if (!seed) cp.push("the fixture gives no seedPublishedAt");
        else if (!early.length) cp.push(`no counted verdict is dated before ${seed}: recordedAt must be the tracker's own event time, so check 7 can FAIL it`);
        push("verdict-before-seed", cp.length === 0, cp.join("; "));
        break;
      }
      case "pagination": {
        const want = f.expect.minHistory ?? 101;
        if ((clean.history?.length ?? 0) < want) cp.push(`history has ${clean.history?.length ?? 0} events < ${want}`);
        if (f.http && cleanRequests < 2) cp.push(`only ${cleanRequests} request(s): the fixture does not page`);
        push("pagination", cp.length === 0, cp.join("; "));
        break;
      }
      case "checkpoint-round-trip": {
        const again = await readAll(await ledger(f, ledgerHarness("repeat", f.reviewers))).catch(() => null);
        const hash = (h: LedgerHistoryEvent[] | null) => (h ? sha256Hex(canonicalJson(canonicalHistory(h))) : "none");
        if (!again || hash(again.history) !== hash(clean.history)) cp.push("two reads of an unchanged tracker gave different canonical histories (eventsSha256 is not stable)");
        const ids = new Set((clean.history ?? []).map((e) => e.id));
        for (const v of counted.values()) if (v.provenance?.eventId && !ids.has(v.provenance.eventId)) cp.push(`the counted verdict on draw #${v.draw} (event ${v.provenance.eventId}) is not in the history a checkpoint would hash`);
        if (!f.erasedEventId) cp.push("the fixture names no erasedEventId");
        else {
          const after = await readAll(await ledger(f, ledgerHarness("after-erasure", f.reviewers))).catch((e: Error) => e);
          if (after instanceof Error) cp.push(`reading the tracker after the erasure threw: ${after.message}`);
          else if (!historyDiff(clean.history ?? [], after.history ?? []).missing.includes(f.erasedEventId)) cp.push(`an admin erasing event ${f.erasedEventId} does not show as missing against the checkpointed history`);
        }
        push("checkpoint-round-trip", cp.length === 0, cp.join("; "));
        break;
      }
    }

    if (cleanRequests === 0) {
      if (f.http) push("transient-faults", false, "fixture says http: true but no request went through the harness: build the ledger's context with harness.context()");
      else skip("transient-faults", "the ledger made no requests through the harness (not an HTTP ledger)");
    } else push("transient-faults", ...(await transientFaults(ledger, f, clean, cleanRequests)));
  }
  return { ok: results.every((r) => r.ok), results };
}

/** Publishes the fixture's draws three times: twice with the index, once after forgetting it. Runs 2 and 3 must write nothing. */
async function idempotentPublish(ledger: LedgerUnderTest, f: LedgerFixture): Promise<ConformanceResult[]> {
  const out: ConformanceResult[] = [];
  const res = (check: LedgerConformanceCheck, ok: boolean, message?: string) => out.push({ fixture: f.name, check, ok, ...(message && !ok ? { message } : {}) });
  const p: string[] = [];
  if (!f.publish) p.push("the fixture gives no publish context");
  if (!f.forgetLocalState) p.push("the fixture gives no forgetLocalState() (run 3 checks that a lost index is rebuilt from the tracker's markers)");
  const writes: number[] = [];
  for (const phase of ["publish-1", "publish-2", "publish-3"] as const) {
    if (p.length) break;
    if (phase === "publish-3") await f.forgetLocalState!();
    const h = ledgerHarness(phase, f.reviewers);
    const l = await ledger(f, h);
    if (!l.publishDraws) {
      p.push("the ledger has no publishDraws()");
      break;
    }
    try {
      await l.publishDraws(f.draws, f.publish);
      const after = await readAll(l);
      if (after.integrity && !after.integrity.ok) p.push(`${phase}: integrity FAIL after publishing: ${after.integrity.findings.join(" | ")}`);
    } catch (e) {
      p.push(`${phase} threw: ${(e as Error).message}`);
      break;
    }
    writes.push(h.writes());
  }
  if (!p.length) {
    if (writes[0]! < f.draws.length) p.push(`run 1 made ${writes[0]} write(s) for ${f.draws.length} draws`);
    if (writes[1]) p.push(`run 2 (index present) made ${writes[1]} write(s); it must make none`);
    if (writes[2]) p.push(`run 3 (index forgotten) made ${writes[2]} write(s); it must find the issues by their markers and make none`);
  }
  res("idempotent-publish", p.length === 0, p.join("; "));
  return out;
}

/**
 * Re-runs the reads with faults injected through the harness: a 503 on the first request, a 429
 * with Retry-After, a 502, and a 503 on the last request of the clean run. The ledger must retry
 * each (directly or by speaking the broker contract), wait at least as long as the header says,
 * and return exactly what the clean run returned.
 */
async function transientFaults(ledger: LedgerUnderTest, f: LedgerFixture, clean: Reads, cleanRequests: number): Promise<[boolean, string]> {
  const text = (status: number, body: string, headers: Record<string, string> = {}) => () => new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });
  const faults: Fault[] = [
    { call: 1, response: text(503, "service unavailable"), minWaitMs: 0, label: "503" },
    { call: 2, response: text(429, "too many requests", { "retry-after": String(INJECTED_RETRY_AFTER_SECONDS) }), minWaitMs: INJECTED_RETRY_AFTER_SECONDS * 1000, label: `429 with Retry-After: ${INJECTED_RETRY_AFTER_SECONDS}` },
    { call: 3, response: text(502, "<html>bad gateway</html>", { "content-type": "text/html" }), minWaitMs: 0, label: "502" },
  ];
  if (cleanRequests >= 2) faults.push({ call: cleanRequests + faults.length, response: text(503, "service unavailable"), minWaitMs: 0, label: "503 on the last request" });
  const h = ledgerHarness("faults", f.reviewers, faults);
  let got: Reads;
  try {
    got = await readAll(await ledger(f, h));
  } catch (e) {
    return [false, `a read threw under transient faults (${faults.map((x) => x.label).join(", ")}): ${(e as Error).message}`];
  }
  const problems: string[] = [];
  for (const fault of faults) {
    const at = h.inner.log[fault.call - 1];
    const next = h.inner.log[fault.call];
    if (!at) continue;
    if (!next) {
      problems.push(`no request after the injected ${fault.label}: not retried`);
      continue;
    }
    if (next.url !== at.url || next.method !== at.method) problems.push(`after the injected ${fault.label} on ${at.method} ${at.url} the ledger sent ${next.method} ${next.url} instead of retrying`);
    const waited = Math.max(at.sleptAfter, next.at - at.at);
    if (waited < fault.minWaitMs) problems.push(`after the injected ${fault.label} the ledger waited ${waited} ms < ${fault.minWaitMs} ms`);
  }
  const same = (r: Reads) => canonicalJson({ v: r.verdicts, h: canonicalHistory(r.history ?? []), i: integrityOf(r.integrity) });
  if (same(got) !== same(clean)) problems.push("verdicts, history or the integrity result differ from the clean run");
  return [problems.length === 0, problems.join("; ")];
}

export function formatLedgerConformanceReport(r: ConformanceReport): string {
  return r.results.map((x) => `${x.ok ? (x.skipped ? "skip" : "ok  ") : "FAIL"} ${x.fixture} › ${x.check}${x.message ? `: ${x.message}` : ""}`).join("\n");
}

export async function assertLedgerConformance(ledger: LedgerUnderTest, fixtures: readonly LedgerFixture[]): Promise<ConformanceReport> {
  const r = await runLedgerConformance(ledger, fixtures);
  if (!r.ok) throw new Error(`ledger conformance failed:\n${formatLedgerConformanceReport(r)}`);
  return r;
}
