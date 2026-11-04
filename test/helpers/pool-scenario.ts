import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../../src/commands/context.js";
import { setupAuditRepo, T } from "./audit-scenario.js";
import { fakeClock } from "./fake-clock.js";
import { ORG, type FakeOrg } from "./fake-org.js";

/**
 * An audit repo for a pooled GitHub audit over a synthetic org (fake-org.ts). The context runs on a shared fake clock
 * (parallel waits wake at their own times), carries a synthetic token so the authenticated budgets apply, and sends
 * everything to the org mock. No timestamp authority is configured: the suite reaches none.
 */
export const REPOS_RULE = `{ owner: ${ORG} }`;

export function setupPoolAudit(org: FakeOrg, o: { repos?: string; extra?: string; start?: string; window?: string } = {}) {
  const s = setupAuditRepo({ changes: [], provider: "github", fetch: org.fetch });
  const clock = fakeClock(T(o.start ?? "2026-10-20T00:00:00Z"));
  const config = [
    "provider: github",
    `repos: ${o.repos ?? REPOS_RULE}`,
    `window: ${o.window ?? "{ name: 2026-q3, start: 2026-07-01, end: 2026-09-30 }"}`,
    "selector: { kinds: [pull_request, direct_push], authors: any, unreviewed: no-human-review }",
    "audit: { p0: 0.10, p1: 0.02, alpha: 0.05 }",
    "timestamping: { authorities: [], min_tokens: 2 }",
    ...(o.extra ? [o.extra] : []),
    "",
  ].join("\n");
  writeFileSync(join(s.dir, ".pr-rla.yml"), config);
  const ctxFor = (fetch: typeof globalThis.fetch = org.fetch, clk = clock): CommandContext => ({
    ...s.ctx,
    env: { GITHUB_TOKEN: "synthetic-token-not-real" },
    nowMs: () => clk.now(),
    sleep: (ms) => clk.sleep(ms),
    fetch,
    out: (l) => s.out.push(l),
    err: (l) => s.out.push(`ERR ${l}`),
  });
  return { dir: s.dir, git: s.git, out: s.out, clock, ctx: ctxFor(), ctxFor, config: () => readFileSync(join(s.dir, ".pr-rla.yml"), "utf8"), setConfig: (text: string) => writeFileSync(join(s.dir, ".pr-rla.yml"), text) };
}

export type PoolScenario = ReturnType<typeof setupPoolAudit>;
