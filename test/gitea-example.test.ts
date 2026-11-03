import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.js";
import { createProvider } from "../src/registry.js";
import type { ScmProvider } from "../src/sdk/provider.js";
import { formatConformanceReport, runProviderConformance, type ConformanceHarness } from "../src/testing/index.js";
import { fakeGitea, GITEA_BASE } from "./helpers/fake-gitea.js";
import { replayFetch, type Recording } from "./helpers/replay-fetch.js";
import { OID, scenarioExpectations, scmScenario } from "./helpers/scm-scenario.js";

/**
 * The Gitea/Forgejo provider is an EXTERNAL plugin (examples/providers/gitea, its own
 * package.json, importing only pr-rla/provider). It is loaded here exactly as a user
 * would: from .pr-rla.yml, through the registry.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bot = (login: string) => ({ login: `${login}[bot]`, kind: "bot" as const });
const human = (login: string) => ({ login, kind: "human" as const });

const CONFIG = `
provider:
  use: ./examples/providers/gitea/index.mjs
  options: { base_url: ${GITEA_BASE}, page_size: 3, bots: [agent-bot, review-bot, merge-bot] }
repo: acme/widgets
window: { name: 2026-08-01, start: 2026-08-01, end: 2026-08-01 }
`;

async function fromConfig(fetch: typeof globalThis.fetch, h?: ConformanceHarness): Promise<ScmProvider> {
  const config = parseConfig(CONFIG, join(ROOT, ".pr-rla.yml"));
  expect(config.provider.use).toBe("./examples/providers/gitea/index.mjs");
  const base = { cwd: config.dir, env: {}, log: () => {}, fetch };
  return createProvider(config.provider, { ...(h ? h.context(base) : base), now: () => Date.parse("2026-08-03T00:00:00Z") } as never);
}

describe("external Gitea/Forgejo plugin, loaded from .pr-rla.yml through the registry", () => {
  const sc = scmScenario();
  const x = scenarioExpectations("gitea");

  it("passes the conformance kit on a synthetic Forgejo: squash, merge commit, rebase (new SHAs), fast-forward, direct pushes", async () => {
    let fake = fakeGitea(sc, { limit: 3 });
    const report = await runProviderConformance(
      async (_f, h) => fromConfig((fake = fakeGitea(sc, { limit: 3 })).fetch, h),
      [
        {
          name: "synthetic gitea acme/widgets 2026-08-01",
          request: { repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] },
          expect: {
            ids: x.all,
            pullRequests: x.pullRequests,
            directPushes: x.directPushes,
            prCommits: x.prCommits,
            mergeShas: x.mergeShas,
            changedLines: x.changedLines,
            reviewStates: {
              [x.ids.squash]: Array(150).fill("COMMENTED"),
              [x.ids.rebase]: ["CHANGES_REQUESTED", "DISMISSED"],
              [x.ids.merge]: ["APPROVED"],
              [x.ids.ff]: ["APPROVED"],
              [x.ids.squash5]: [],
              [x.ids.squashMerge]: ["DISMISSED", "APPROVED"],
              [x.ids.atOpen]: [],
            },
            reviewers: { [x.ids.rebase]: [human("dave"), human("erin")], [x.ids.ff]: [bot("review-bot")], [x.ids.squashMerge]: [human("carol"), bot("review-bot")] },
            actors: {
              [x.ids.squash]: { author: bot("agent-bot"), mergedBy: human("maint") },
              [x.ids.rebase]: { author: human("bob"), mergedBy: bot("merge-bot") },
              [x.ids.alice]: { author: human("alice"), mergedBy: null },
              [x.ids.bot]: { author: bot("forgejo-actions"), mergedBy: null },
            },
            bots: ["agent-bot[bot]", "review-bot[bot]", "merge-bot[bot]", "forgejo-actions[bot]"],
            humans: ["maint", "bob", "dave", "erin", "carol", "alice"],
            minPages: 40,
          },
          pagesServed: () => fake.served(),
          http: true,
          rateLimitFault: { status: 429, headers: () => ({ ratelimit: '"baseline";r=0;t=45', "ratelimit-policy": '"baseline";q=2000;w=600' }), minWaitMs: 45_000 },
        },
      ],
    );
    expect(report.ok, formatConformanceReport(report)).toBe(true);
    expect(report.results.filter((r) => r.skipped)).toEqual([]);
  });

  it("links the rebased copies by author, date and message; PR 9's commits (merged after the window) are not direct pushes", async () => {
    const r = await (await fromConfig(fakeGitea(sc, { limit: 3 }).fetch)).listChanges({ repo: sc.repo, window: sc.window, kinds: ["pull_request", "direct_push"] });
    expect(r.diagnostics).toEqual([
      { label: "PRs merged into other branches in window (excluded)", value: 1 },
      { label: "default-branch commits in window", value: x.inWindowCommits },
      { label: "commits linked to a merged PR", value: 14 },
      { label: "rebased commits linked by author, author date and message", value: 2 },
      { label: "direct pushes that are merge commits", value: 0 },
    ]);
    expect(r.changes.map((c) => c.id)).not.toContain(`gitea:${sc.repo}@${OID("P9a")}`);
  });

  it("is a standalone package that imports only the public SDK, and the core never imports it", () => {
    const dir = join(ROOT, "examples", "providers", "gitea");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; private: boolean; license: string };
    expect(pkg).toMatchObject({ name: "pr-rla-provider-gitea", private: true, license: "UNLICENSED" });
    const specs = [...readFileSync(join(dir, "index.mjs"), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specs).toEqual(["pr-rla/provider"]);
    const testSpecs = [...readFileSync(join(dir, "test", "conformance.test.mjs"), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!).filter((s) => s.startsWith("pr-rla"));
    expect(new Set(testSpecs)).toEqual(new Set(["pr-rla/testing"]));
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const imports = (f: string) => [...readFileSync(f, "utf8").matchAll(/(?:from\s+|import\()\s*"([^"]+)"/g)].map((m) => m[1]!);
    const offenders = walk(join(ROOT, "src")).filter((f) => imports(f).some((spec) => /examples\/|pr-rla-provider-gitea/.test(spec)));
    expect(offenders).toEqual([]);
  });
});

describe("external Gitea plugin on recorded Codeberg responses: forgejo/docs, 2026-10-01..07", () => {
  type Rec = Recording & { options: Record<string, unknown>; repo: string; window: { opensAt: string; closesAt: string }; expected: { ids: string[]; diagnostics: unknown[] } };
  const rec = JSON.parse(readFileSync(join(ROOT, "examples", "providers", "gitea", "fixtures", "codeberg-forgejo-docs-2026-10-01.json"), "utf8")) as Rec;
  const id = (n: number) => `gitea:forgejo/docs#${n}`;
  const config = parseConfig(`provider: { use: ./examples/providers/gitea/index.mjs, options: ${JSON.stringify(rec.options)} }\nrepo: ${rec.repo}\nwindow: { start: 2026-10-01, end: 2026-10-07 }\n`, join(ROOT, ".pr-rla.yml"));
  let last = replayFetch(rec);
  const make = (h?: ConformanceHarness) => {
    last = replayFetch(rec);
    const base = { cwd: config.dir, env: {}, log: () => {}, fetch: last as typeof fetch };
    return createProvider(config.provider, { ...(h ? h.context(base) : base), now: () => Date.parse(rec.recordedAt) } as never);
  };

  it("passes the conformance kit on real Forgejo data, loaded from .pr-rla.yml", async () => {
    expect(config.window).toMatchObject({ opensAt: rec.window.opensAt, closesAt: rec.window.closesAt });
    const report = await runProviderConformance((_f, h) => make(h), [
      {
        name: "codeberg forgejo/docs",
        request: { repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] },
        expect: {
          ids: rec.expected.ids,
          directPushes: [],
          // Forgejo reports 0 additions/deletions on #2219 and #2221; their files list 7+3 and 4+6 (checked by hand).
          changedLines: { [id(2219)]: 10, [id(2221)]: 10, [id(2218)]: 73 },
          reviewStates: { [id(2070)]: ["CHANGES_REQUESTED", "APPROVED"] },
          reviewers: { [id(2070)]: [human("limiting-factor"), human("mahlzahn")] },
          actors: { [id(2070)]: { author: human("Colin"), mergedBy: human("Gusted") }, [id(2215)]: { author: bot("forgejo-actions"), mergedBy: human("mahlzahn") } },
          // #2206 landed as afacb6e4e8…, a commit with no "(#2206)" in its message: matched by merge_commit_sha.
          mergeShas: { [id(2206)]: (rec.exchanges.find((e) => e.url.endsWith("/pulls/2206"))!.response as { merge_commit_sha: string }).merge_commit_sha },
          bots: ["viceice-bot[bot]", "forgejo-actions[bot]"],
          humans: ["mahlzahn", "Gusted", "aahlenst"],
          minPages: 20,
        },
        pagesServed: () => last.served(),
        http: true,
      },
    ]);
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });

  it("9 PRs into next, 6 into release branches (excluded), 9 commits all from PRs", async () => {
    const r = await (await make()).listChanges({ repo: rec.repo, window: rec.window, kinds: ["pull_request", "direct_push"] });
    expect(r.diagnostics).toEqual(rec.expected.diagnostics);
    expect(r.diagnostics).toContainEqual({ label: "PRs merged into other branches in window (excluded)", value: 6 });
    expect(r.defaultBranch).toBe("next");
  });
});
