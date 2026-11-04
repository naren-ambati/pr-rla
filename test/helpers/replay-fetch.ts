import { createHash } from "node:crypto";

/** One recorded HTTP exchange. Bodies are JSON (trimmed to the fields pr-rla reads where noted). */
export interface RecordedExchange {
  method: string;
  url: string;
  /** SHA-256 of the request body (GraphQL), or null. */
  bodySha256: string | null;
  /** The GraphQL variables, for readability. */
  variables?: Record<string, unknown>;
  status: number;
  headers: Record<string, string>;
  response: unknown;
}

export interface Recording {
  description: string;
  recordedAt: string;
  exchanges: RecordedExchange[];
}

export const bodyKey = (body: unknown): string | null => (typeof body === "string" ? createHash("sha256").update(body).digest("hex") : null);

/**
 * A fetch that serves recorded exchanges. Requests are matched by method, URL
 * (auth never recorded) and body hash; repeated identical requests are served
 * in recorded order. An unrecorded request throws, so tests stay offline.
 */
export function replayFetch(rec: Recording): typeof fetch & { served: () => number; unused: () => RecordedExchange[] } {
  const queue = rec.exchanges.map((e) => ({ e, used: false }));
  let served = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const key = bodyKey(init?.body);
    const hit = queue.find((q) => !q.used && q.e.method === method && q.e.url === url && q.e.bodySha256 === key);
    if (!hit) throw new Error(`replayFetch: unrecorded request ${method} ${url}${key ? ` body ${key.slice(0, 12)}` : ""}`);
    hit.used = true;
    served++;
    return new Response(JSON.stringify(hit.e.response), { status: hit.e.status, headers: { "content-type": "application/json", ...hit.e.headers } });
  }) as typeof fetch & { served: () => number; unused: () => RecordedExchange[] };
  f.served = () => served;
  f.unused = () => queue.filter((q) => !q.used).map((q) => q.e);
  return f;
}

/**
 * The clock a recorded listing walk ran on. A CLI-mode recording (scripts/record-fixture.mjs --cli) takes
 * recordedAt when the script starts, but the provider re-scans the head of its listing from its own walk
 * start minus 60 s: the latest `updated_after` in the recording, plus 60 s and half a second.
 */
export function recordedWalkClock(rec: Recording): number {
  const latest = rec.exchanges.map((e) => /[?&]updated_after=([^&]+)/.exec(e.url)?.[1]).filter((x): x is string => !!x).map(decodeURIComponent).sort().at(-1);
  return latest ? Date.parse(latest) + 60_500 : Date.parse(rec.recordedAt);
}
