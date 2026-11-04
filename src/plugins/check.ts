import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { HostNotAllowed } from "../net/contract.js";
import { runProviderConformance, type ConformanceFixture, type ConformanceReport } from "../testing/conformance.js";
import { describePlugin, hostedProvider, startPluginHost, type HostOptions, type PluginHost } from "./host.js";
import { readGrants, type ResolvedPlugin } from "./lock.js";

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
const EXPECT_MAPS = ["reviewStates", "reviewers", "actors", "changedLines", "prCommits", "mergeShas"] as const;

function expectations(expected: Record<string, unknown>): ConformanceFixture["expect"] {
  const out: Record<string, unknown> = {};
  for (const k of EXPECT_LISTS) if (Array.isArray(expected[k])) out[k] = expected[k];
  for (const k of EXPECT_MAPS) if (expected[k] && typeof expected[k] === "object" && !Array.isArray(expected[k])) out[k] = expected[k];
  if (typeof expected.minPages === "number") out.minPages = expected.minPages;
  return out as ConformanceFixture["expect"];
}

/** Serves recorded exchanges by method, URL and body hash, in recorded order; an unrecorded request throws, so a check stays offline. */
export function replayFetch(rec: RecordedFixture): typeof fetch & { served: () => number } {
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

/** Runs the provider kit through the host on recorded fixtures. Requests to hosts the plugin did not declare are refused, as the broker would. */
export async function hostedProviderConformance(plugin: ResolvedPlugin, label: string, fixtures: { name: string; rec: RecordedFixture }[], host: Partial<HostOptions> = {}): Promise<ConformanceReport> {
  const started: PluginHost[] = [];
  try {
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
    }, kit);
  } finally {
    for (const h of started) h.close();
  }
}

export const fixtureName = (path: string) => basename(path);
