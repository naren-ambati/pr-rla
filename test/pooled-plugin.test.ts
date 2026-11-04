import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import { configFor, providerFor } from "../src/commands/context.js";
import type { ManifestV2 } from "../src/core/records.js";
import { fakeOrg, orgSpec } from "./helpers/fake-org.js";
import { lockPlugin } from "./helpers/plugin-lock.js";
import { setupPoolAudit } from "./helpers/pool-scenario.js";

/**
 * Pooled freezes through external providers run in the isolated plugin host (U2b; delivery plan, bolt 9). The plugin
 * here is SYNTHETIC: it lists 12 repos (one archived) and builds each repo's changes from its name, so the host's
 * listRepos and concurrent listChanges calls are exercised with no data file (an isolated plugin reads only its own files).
 * It refuses to be imported outside the host, so a pr-rla that loaded it in-process would fail loudly.
 */
const PLUGIN = `import { defineProvider } from "pr-rla/provider";
import { createHash } from "node:crypto";
if (process.env.PR_RLA_HOST !== "1") throw new Error("pooled plugin: imported outside the plugin host");
let inflight = 0;
let peak = 0;
const names = Array.from({ length: 12 }, (_, i) => "svc-" + String(i).padStart(2, "0"));
const sha = (s) => createHash("sha1").update(s).digest("hex");
export default defineProvider({
  providerApiVersion: 1,
  name: "pooled",
  hosts: () => [],
  populationOptions: [],
  create() {
    return {
      apiVersion: 1,
      name: "pooled",
      async listRepos(rule) {
        return names.map((n, i) => ({ repo: rule.owner + "/" + n, id: String(500 + i), defaultBranch: "main", archived: i === 11, fork: false, visibility: "public" }));
      },
      // U8 fix round: what the token sees (every repository here is public) and one repo's metadata, over IPC.
      async listingVisibility() {
        const all = { complete: true, reason: "synthetic: every repository is public" };
        return { identity: "synthetic", visibilities: { public: all, private: all, internal: all } };
      },
      async describeRepo(ref) {
        const i = names.indexOf(ref.repo.split("/")[1]);
        if (i < 0) throw Object.assign(new Error(ref.repo + ": HTTP 404"), { code: "REPO_UNAVAILABLE", status: 404 });
        return { repo: ref.repo, id: String(500 + i), defaultBranch: "main", archived: i === 11, fork: false, visibility: "public" };
      },
      async estimateRequests(req) {
        return { requests: 7 + Number(req.repo.slice(-2)), graphql: 2, probed: 1 };
      },
      // P3: the default branch's push log, over IPC: created at its head before the window closed, never moved since.
      async pushLog(req) {
        if (req.branch !== "main" || typeof req.since !== "string" || !req.signal) throw new Error("pooled plugin: pushLog got " + JSON.stringify(req));
        return { events: [{ id: "1", at: "2026-08-31T10:00:00Z", before: "0".repeat(40), after: sha("head" + req.repo), kind: "created" }], limitations: ["synthetic push log"] };
      },
      async listChanges(req) {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 20));
        inflight--;
        const idx = Number(req.repo.slice(-2));
        // The archived repo (svc-11) was archived before the window: nothing landed in it.
        const changes = Array.from({ length: idx === 11 ? 0 : 10 + idx * 3 }, (_, k) => {
          const day = 1 + ((k * 7 + idx) % 27);
          return {
            id: "pooled:" + req.repo + "#" + (k + 1),
            kind: "pull_request",
            repo: req.repo,
            url: "https://example.invalid/" + req.repo + "/pull/" + (k + 1),
            mergeSha: sha(req.repo + k),
            mergedAt: "2026-08-" + String(day).padStart(2, "0") + "T10:00:00Z",
            author: { login: "bob", kind: "human" },
            mergedBy: { login: "maint", kind: "human" },
            reviews: [],
            changedLines: k + 1,
            labels: [],
          };
        });
        return { changes, defaultBranch: "main", limitations: ["peak in flight so far: " + peak], headSha: sha("head" + req.repo) };
      },
    };
  },
});
`;
const USE = "./plugins/pooled/index.mjs";

describe("an isolated external provider freezes a pool through the plugin host (U2b + U8)", () => {
  it("lists the owner's repos and lists up to four at once in the child; the manifest is the same shape and verify rebuilds it", async () => {
    const s = setupPoolAudit(fakeOrg(orgSpec({ eligible: 1 })), { provider: `{ use: ${USE}, options: {} }` });
    mkdirSync(join(s.dir, "plugins", "pooled"), { recursive: true });
    writeFileSync(join(s.dir, "plugins", "pooled", "package.json"), JSON.stringify({ name: "pooled-provider", version: "0.0.1", type: "module" }));
    writeFileSync(join(s.dir, "plugins", "pooled", "index.mjs"), PLUGIN);
    await lockPlugin(s.dir, USE, { options: {} });
    // The child waits in real time: the context's clock is fixed and its sleep is real.
    const ctx = { ...s.ctx, nowMs: () => Date.parse("2026-10-20T00:00:00Z"), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
    expect(await registerCommand(ctx, {})).toBe(0);
    expect(s.out.join("\n")).toMatch(/provider pooled \(path 0\.0\.1\) · ledger git-file/);
    expect(s.out.join("\n")).toMatch(/resolves to 11 now/); // the archived repo is out by default
    const at = (iso: string) => ({ ...ctx, nowMs: () => Date.parse(iso) });
    expect(await freezeCommand(at("2026-10-20T12:00:00Z"), {})).toBe(0);
    const m = JSON.parse(readFileSync(join(s.dir, "audit/2026-q3.manifest.json"), "utf8")) as ManifestV2;
    expect(m.provider).toMatchObject({ name: "pooled", source: "path", trust: "isolated" });
    expect(m.repos.map((r) => [r.repo, r.repoId])).toEqual(Array.from({ length: 11 }, (_, i) => [`acme-org/svc-${String(i).padStart(2, "0")}`, String(500 + i)]));
    expect(m.N).toBe(Array.from({ length: 11 }, (_, i) => 10 + i * 3).reduce((a, b) => a + b, 0));
    const peaks = m.limitations.map((l) => /peak in flight so far: (\d+)/.exec(l)?.[1]).filter(Boolean).map(Number);
    expect(Math.max(...peaks)).toBeGreaterThanOrEqual(2); // calls overlapped in the child
    expect(Math.max(...peaks)).toBeLessThanOrEqual(4); // and never beyond P = 4
    // --estimate reaches the plugin's estimateRequests through the host, for every repo (all probed).
    s.out.length = 0;
    expect(await freezeCommand(at("2026-10-20T12:30:00Z"), { estimate: true, json: true, dryRun: true })).toBe(0);
    const est = (JSON.parse(s.out.find((l) => l.startsWith("{"))!) as { estimate: { supported: boolean; repos: number; requests: { repos: number; graphql: number; probed: number } } }).estimate;
    expect(est).toMatchObject({ supported: true, repos: 11 });
    // P3: plus one push log read per repo.
    expect(est.requests).toMatchObject({ repos: Array.from({ length: 11 }, (_, i) => 7 + i).reduce((a, b) => a + b, 0) + 11, graphql: 22, probed: 11 });
    const report = await runVerify(at("2026-10-20T13:00:00Z"), { offline: false });
    const c5 = report.checks.find((c) => c.n === 5)!;
    expect(c5.status).toBe("PASS");
    expect(c5.summary).toBe(`population ${m.N}/${m.N} match`);
    // listingVisibility crossed the host: the private and internal visibilities are proven complete, not INCOMPLETE.
    expect(c5.details).toContain("private repositories under acme-org: listed completely (synthetic: every repository is public)");
    expect(m.repoListing!.identity).toBe("synthetic");
    // P3: pushLog crossed the host too (with the call's abort signal): every frozen head is proven, at freeze and at verify.
    expect(m.headEvidence!.map((e) => e.status)).toEqual(Array(11).fill("tip"));
    expect(c5.details).toContain("push log: 11 of 11 frozen head(s) were their default branch's tip at freeze");
    // Nothing fails; before sampling, and on self-asserted times (no timestamp authority), it is not a verification (time round B).
    expect(report.checks.filter((c) => c.status === "FAIL")).toEqual([]);
    expect(report.verdict).toBe("INCOMPLETE");
    // describeRepo crosses the host too, and a RepoUnavailableError keeps its code and status over IPC.
    const hosted = await providerFor(at("2026-10-20T13:00:00Z"), configFor(at("2026-10-20T13:00:00Z")).config);
    expect(await hosted.describeRepo!({ repo: "acme-org/svc-03" })).toMatchObject({ repo: "acme-org/svc-03", id: "503" });
    await expect(hosted.describeRepo!({ repo: "acme-org/nope" })).rejects.toMatchObject({ code: "REPO_UNAVAILABLE", status: 404 });
  });
});
