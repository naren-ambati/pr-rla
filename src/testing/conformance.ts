import { canonicalJson } from "../core/canonical.js";
import {
  SUPPORTED_PROVIDER_API_VERSIONS,
  changeRecordProblems,
  type Actor,
  type ChangeKind,
  type ChangeRecord,
  type ListChangesRequest,
  type ReviewState,
  type ScmProvider,
} from "../sdk/provider.js";

/**
 * Provider conformance kit (`pr-rla/testing`). Framework-agnostic: it returns a
 * report, and `assertProviderConformance` throws, so it runs under vitest, jest,
 * node:test or a plain script. A third-party provider author wires their adapter
 * to recorded or fake SCM data and declares what that data must normalize to.
 */
export interface ConformanceFixture {
  name: string;
  request: ListChangesRequest;
  expect: {
    /** The exact set of change ids the provider must return (covers pagination: make the data span pages). */
    ids?: string[];
    pullRequests?: string[];
    directPushes?: string[];
    /** Review states per change id, in submittedAt order. */
    reviewStates?: Record<string, ReviewState[]>;
    actors?: Record<string, { author?: Actor; mergedBy?: Actor | null }>;
    changedLines?: Record<string, number>;
    /** With `pagesServed`: the transport must have served at least this many requests. */
    minPages?: number;
  };
  /** How many requests/pages the fixture transport has served (pagination check). */
  pagesServed?: () => number;
}

export type ProviderUnderTest = ScmProvider | ((fixture: ConformanceFixture) => ScmProvider | Promise<ScmProvider>);

export interface ConformanceResult {
  fixture: string;
  check: string;
  ok: boolean;
  message?: string;
}

export interface ConformanceReport {
  ok: boolean;
  results: ConformanceResult[];
}

export const CONFORMANCE_CHECKS = [
  "api-version",
  "normalization",
  "window-and-kinds",
  "classification",
  "no-double-counting",
  "stable-sorted-ids",
  "review-state-mapping",
  "actors",
  "pagination",
  "kind-filtering",
] as const;

const sortById = (cs: readonly ChangeRecord[]) => [...cs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const sameSet = (a: readonly string[], b: readonly string[]) => canonicalJson([...a].sort()) === canonicalJson([...b].sort());
const diff = (want: readonly string[], got: readonly string[]) => {
  const g = new Set(got);
  const w = new Set(want);
  const missing = want.filter((x) => !g.has(x));
  const extra = got.filter((x) => !w.has(x));
  return `missing ${missing.length} (${missing.slice(0, 3).join(", ")}), extra ${extra.length} (${extra.slice(0, 3).join(", ")})`;
};

async function instantiate(p: ProviderUnderTest, f: ConformanceFixture): Promise<ScmProvider> {
  return typeof p === "function" ? p(f) : p;
}

export async function runProviderConformance(provider: ProviderUnderTest, fixtures: readonly ConformanceFixture[]): Promise<ConformanceReport> {
  const results: ConformanceResult[] = [];
  for (const f of fixtures) {
    const push = (check: (typeof CONFORMANCE_CHECKS)[number], ok: boolean, message?: string) => results.push({ fixture: f.name, check, ok, ...(message && !ok ? { message } : {}) });
    const p1 = await instantiate(provider, f);
    push("api-version", SUPPORTED_PROVIDER_API_VERSIONS.includes(p1.apiVersion) && /^[a-z0-9][a-z0-9-]*$/.test(p1.name), `apiVersion ${p1.apiVersion} / name ${p1.name}`);
    let first: ChangeRecord[];
    try {
      first = (await p1.listChanges(f.request)).changes;
    } catch (e) {
      push("normalization", false, `listChanges threw: ${(e as Error).message}`);
      continue;
    }
    const pages = f.pagesServed?.();

    const bad = first.map((c) => ({ c, p: changeRecordProblems(c) })).filter((x) => x.p.length > 0);
    const wrongRepo = first.filter((c) => c.repo !== f.request.repo);
    push("normalization", bad.length === 0 && wrongRepo.length === 0, bad.length ? `${bad[0]!.c.id}: ${bad[0]!.p.join("; ")}` : `${wrongRepo[0]?.id} has repo ${wrongRepo[0]?.repo}`);

    const opens = Date.parse(f.request.window.opensAt);
    const closes = Date.parse(f.request.window.closesAt);
    const outside = first.filter((c) => Date.parse(c.mergedAt) < opens || Date.parse(c.mergedAt) >= closes);
    const wrongKind = first.filter((c) => !f.request.kinds.includes(c.kind));
    push("window-and-kinds", outside.length === 0 && wrongKind.length === 0, outside.length ? `${outside[0]!.id} landed ${outside[0]!.mergedAt}, outside the window` : `${wrongKind[0]?.id} is kind ${wrongKind[0]?.kind}`);

    const classProblems: string[] = [];
    for (const c of first) {
      if (c.kind === "direct_push" && !c.id.endsWith(`@${c.mergeSha}`)) classProblems.push(`${c.id}: a direct_push id must end in @<mergeSha>`);
      if (c.kind === "pull_request" && !/#[1-9][0-9]*$/.test(c.id)) classProblems.push(`${c.id}: a pull_request id must end in #<number>`);
    }
    const byKind = (k: ChangeKind) => first.filter((c) => c.kind === k).map((c) => c.id);
    if (f.expect.pullRequests && !sameSet(f.expect.pullRequests, byKind("pull_request"))) classProblems.push(`pull requests: ${diff(f.expect.pullRequests, byKind("pull_request"))}`);
    if (f.expect.directPushes && !sameSet(f.expect.directPushes, byKind("direct_push"))) classProblems.push(`direct pushes: ${diff(f.expect.directPushes, byKind("direct_push"))}`);
    push("classification", classProblems.length === 0, classProblems.join("; "));

    const ids = first.map((c) => c.id);
    const shas = first.map((c) => c.mergeSha);
    const dupId = ids.find((x, i) => ids.indexOf(x) !== i);
    const dupSha = shas.find((x, i) => shas.indexOf(x) !== i);
    push("no-double-counting", !dupId && !dupSha, dupId ? `id ${dupId} returned twice` : `commit ${dupSha} counted by two changes`);

    let second: ChangeRecord[] | null = null;
    try {
      second = (await (await instantiate(provider, f)).listChanges(f.request)).changes;
    } catch (e) {
      push("stable-sorted-ids", false, `second listChanges threw: ${(e as Error).message}`);
    }
    if (second) {
      const a = canonicalJson(sortById(first));
      const b = canonicalJson(sortById(second));
      push("stable-sorted-ids", a === b, "two identical requests returned different records or ids");
    }

    const rs: string[] = [];
    for (const [id, states] of Object.entries(f.expect.reviewStates ?? {})) {
      const c = first.find((x) => x.id === id);
      const got = c?.reviews.map((r) => r.state) ?? null;
      if (canonicalJson(got) !== canonicalJson(states)) rs.push(`${id}: expected [${states.join(",")}] got [${got?.join(",") ?? "missing"}]`);
    }
    push("review-state-mapping", rs.length === 0, rs.join("; "));

    const ac: string[] = [];
    for (const [id, exp] of Object.entries(f.expect.actors ?? {})) {
      const c = first.find((x) => x.id === id);
      if (!c) ac.push(`${id} missing`);
      else {
        if (exp.author && canonicalJson(c.author) !== canonicalJson(exp.author)) ac.push(`${id} author ${canonicalJson(c.author)}`);
        if (exp.mergedBy !== undefined && canonicalJson(c.mergedBy) !== canonicalJson(exp.mergedBy)) ac.push(`${id} mergedBy ${canonicalJson(c.mergedBy)}`);
      }
    }
    for (const [id, n] of Object.entries(f.expect.changedLines ?? {})) {
      const c = first.find((x) => x.id === id);
      if (c?.changedLines !== n) ac.push(`${id} changedLines ${c?.changedLines} ≠ ${n}`);
    }
    push("actors", ac.length === 0, ac.join("; "));

    const pg: string[] = [];
    if (f.expect.ids && !sameSet(f.expect.ids, ids)) pg.push(`ids: ${diff(f.expect.ids, ids)}`);
    if (f.expect.minPages !== undefined && pages !== undefined && pages < f.expect.minPages) pg.push(`transport served ${pages} requests < ${f.expect.minPages}: the fixture does not exercise pagination`);
    push("pagination", pg.length === 0, pg.join("; "));

    if (f.request.kinds.length > 1) {
      const kp: string[] = [];
      for (const k of f.request.kinds) {
        try {
          const only = (await (await instantiate(provider, f)).listChanges({ ...f.request, kinds: [k] })).changes;
          if (only.some((c) => c.kind !== k)) kp.push(`kinds [${k}] returned another kind`);
          if (!sameSet(only.map((c) => c.id), byKind(k))) kp.push(`kinds [${k}]: ${diff(byKind(k), only.map((c) => c.id))}`);
        } catch (e) {
          kp.push(`kinds [${k}] threw: ${(e as Error).message}`);
        }
      }
      push("kind-filtering", kp.length === 0, kp.join("; "));
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

export function formatConformanceReport(r: ConformanceReport): string {
  return r.results.map((x) => `${x.ok ? "ok  " : "FAIL"} ${x.fixture} › ${x.check}${x.message ? `: ${x.message}` : ""}`).join("\n");
}

export async function assertProviderConformance(provider: ProviderUnderTest, fixtures: readonly ConformanceFixture[]): Promise<ConformanceReport> {
  const r = await runProviderConformance(provider, fixtures);
  if (!r.ok) throw new Error(`provider conformance failed:\n${formatConformanceReport(r)}`);
  return r;
}
