import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../../src/beacon/drand.js";
import type { CommandContext } from "../../src/commands/context.js";
import { makeRng } from "../../src/core/simulate.js";
import type { ChangeRecord } from "../../src/sdk/provider.js";
import { recordedBeacon } from "./fixtures.js";
import type { MockRekor } from "./mock-rekor.js";

export const REPO = "acme/widgets";
export const T = (iso: string) => Date.parse(iso);

/** N deterministic changes in Q3 2026; the first `bad` carry the label known-bad (narrative for tamper fixture 1). */
export function makeChanges(N: number, opts: { bad?: number; seed?: number } = {}): ChangeRecord[] {
  const rng = makeRng(opts.seed ?? 7);
  const opens = T("2026-07-01T00:00:00Z");
  const span = T("2026-10-01T00:00:00Z") - opens;
  return Array.from({ length: N }, (_, i) => {
    const sha = (BigInt(i + 1) * 0x9e3779b97f4a7c15n).toString(16).padStart(40, "0").slice(-40);
    const direct = i % 10 === 9;
    const mergedAt = new Date(opens + Math.floor(rng() * span / 1000) * 1000).toISOString().replace(".000Z", "Z");
    const base = { repo: REPO, mergeSha: sha, mergedAt, changedLines: 1 + Math.floor(rng() * 400), labels: i < (opts.bad ?? 0) ? ["known-bad"] : [] };
    return direct
      ? { ...base, id: `gitea:${REPO}@${sha}`, kind: "direct_push", url: `https://git.example.com/${REPO}/commit/${sha}`, author: { login: "maint", kind: "human" }, mergedBy: null, reviews: [] }
      : {
          ...base,
          id: `gitea:${REPO}#${1000 + i}`,
          kind: "pull_request",
          url: `https://git.example.com/${REPO}/pulls/${1000 + i}`,
          author: { login: i % 3 === 0 ? "claude[bot]" : "copilot-swe-agent[bot]", kind: "bot" },
          mergedBy: { login: "maint", kind: "human" },
          reviews: [{ author: { login: "copilot-pull-request-reviewer[bot]", kind: "bot" }, state: "COMMENTED", submittedAt: mergedAt }],
        };
  });
}

export interface Scenario {
  dir: string;
  clock: { now: number };
  out: string[];
  ctx: CommandContext;
  git: (...args: string[]) => string;
  fetch: typeof fetch;
}

/**
 * An audit repo in a temp dir. By default its provider is json-file over `changes`;
 * `provider` (a YAML flow value) and `fetch` swap in another provider and its transport.
 */
export function setupAuditRepo(opts: { changes: ChangeRecord[]; log?: MockRekor; logKeyFile?: boolean; provider?: string; fetch?: typeof fetch }): Scenario {
  const dir = mkdtempSync(join(tmpdir(), "prrla-audit-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  writeFileSync(join(dir, "changes.json"), JSON.stringify({ schema: "pr-rla/changes/v1", repo: REPO, defaultBranch: "main", changes: opts.changes }, null, 1));
  writeFileSync(join(dir, "review-protocol.md"), "# Protocol\nA change fails if it introduces a user-visible bug or a security weakness.\n");
  if (opts.log) writeFileSync(join(dir, "rekor.pub"), opts.log.publicKeyPem);
  writeFileSync(
    join(dir, ".pr-rla.yml"),
    [
      `provider: ${opts.provider ?? "{ use: json-file, options: { path: changes.json } }"}`,
      `repo: ${REPO}`,
      "window: { name: 2026-q3, start: 2026-07-01, end: 2026-09-30 }",
      "selector: { kinds: [pull_request, direct_push], authors: any, unreviewed: no-human-review }",
      "audit: { p0: 0.10, p1: 0.02, alpha: 0.05 }",
      ...(opts.log ? [`transparency_log: { url: "${opts.log.url}", public_key_file: rekor.pub }`] : []),
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, ".gitignore"), ".pr-rla/\n");
  git("add", "-A");
  git("commit", "-qm", "audit repo");
  const clock = { now: T("2026-10-20T00:00:00Z") };
  const out: string[] = [];
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const ctx = makeCtx(dir, clock, out, fetchImpl);
  return { dir, clock, out, ctx, git, fetch: fetchImpl };
}

function makeCtx(dir: string, clock: { now: number }, out: string[], fetchImpl: typeof fetch): CommandContext {
  return {
    cwd: dir,
    env: {},
    nowMs: () => clock.now,
    fetch: fetchImpl,
    out: (l) => out.push(l),
    err: (l) => out.push(`ERR ${l}`),
    beacon: async (round) => {
      const publishes = 1692803367 + 3 * (round - 1);
      if (clock.now / 1000 < publishes) throw new RoundNotYetPublished(round, publishes);
      const b = recordedBeacon(round);
      if (!(await verifyQuicknetBeacon(b, round))) throw new Error("bad beacon");
      return b;
    },
  };
}

export function cloneScenario(s: Scenario): Scenario {
  const dir = mkdtempSync(join(tmpdir(), "prrla-tamper-"));
  cpSync(s.dir, dir, { recursive: true });
  const out: string[] = [];
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const clock = { ...s.clock };
  return { dir, clock, out, git, fetch: s.fetch, ctx: makeCtx(dir, clock, out, s.fetch) };
}
