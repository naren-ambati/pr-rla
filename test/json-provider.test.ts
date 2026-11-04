import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jsonFile, { JsonFileProvider } from "../src/providers/json-file.js";
import { runProviderConformance, formatConformanceReport } from "../src/testing/index.js";
import { fixturePath } from "./helpers/fixtures.js";

const W = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };
const file = fixturePath("changes", "acme-2026-08-01.json");

describe("json-file provider", () => {
  it("passes the conformance kit", async () => {
    const report = await runProviderConformance(new JsonFileProvider(file), [
      {
        name: "acme export",
        request: { repo: "acme/widgets", window: W, kinds: ["pull_request", "direct_push"] },
        expect: {
          ids: ["gitea:acme/widgets#11", "gitea:acme/widgets#12", "gitea:acme/widgets#13", "gitea:acme/widgets@4444444444444444444444444444444444444444"],
          directPushes: ["gitea:acme/widgets@4444444444444444444444444444444444444444"],
          reviewStates: { "gitea:acme/widgets#12": ["CHANGES_REQUESTED", "APPROVED"], "gitea:acme/widgets#13": [] },
          actors: { "gitea:acme/widgets#11": { author: { login: "renovate[bot]", kind: "bot" } } },
        },
      },
    ], { skipChecks: { "merge-strategies": "json-file passes on what the export says: merge strategies are the SCM providers' to map", "bot-detection": "the export's actor kinds are passed through as given (actors checks them)", "revoked-approval": "the export carries the review states it records (review-state-mapping checks them)" } });
    expect(report.ok, formatConformanceReport(report)).toBe(true);
  });

  it("passes the extended kit with its definition: review-granularity runs; it pins no head and the export carries no ids, so those skip", async () => {
    const report = await runProviderConformance(new JsonFileProvider(file), [{ name: "acme export", request: { repo: "acme/widgets", window: W, kinds: ["pull_request", "direct_push"] }, expect: { ids: ["gitea:acme/widgets#11", "gitea:acme/widgets#12", "gitea:acme/widgets#13", "gitea:acme/widgets@4444444444444444444444444444444444444444"], reviewGranularity: "submission" } }], { definition: jsonFile, skipChecks: { classification: "this run is about review-granularity; the run above exercises the rest", "merge-strategies": "as for classification", "review-state-mapping": "as for classification", actors: "as for classification", "bot-detection": "as for classification", "revoked-approval": "as for classification" } });
    expect(report.ok, formatConformanceReport(report)).toBe(true);
    expect(report.results.find((r) => r.check === "review-granularity")).toEqual({ fixture: "acme export", check: "review-granularity", ok: true });
    expect(report.results.filter((r) => r.skipped && r.fixture === "acme export").map((r) => r.check)).toEqual(["classification", "merge-strategies", "review-state-mapping", "actors", "bot-detection", "transient-faults", "pinned-head", "actor-ids", "revoked-approval"]);
    // P1: and each check no fixture exercised is named as such, with its reason.
    expect(report.results.filter((r) => r.fixture === "(check coverage)").map((r) => [r.check, r.skipped])).toEqual(["classification", "merge-strategies", "review-state-mapping", "actors", "bot-detection", "revoked-approval"].map((c) => [c, true]));
  });

  it("filters by window and kinds, and carries the export's limitations", async () => {
    const r = await new JsonFileProvider(file).listChanges({ repo: "acme/widgets", window: W, kinds: ["pull_request"] });
    expect(r.changes.map((c) => c.id)).toEqual(["gitea:acme/widgets#11", "gitea:acme/widgets#12", "gitea:acme/widgets#13"]);
    expect(r.limitations.join(" ")).toMatch(/self-hosted SCM/);
  });

  const tmp = (body: unknown) => {
    const p = join(mkdtempSync(join(tmpdir(), "prrla-json-")), "c.json");
    writeFileSync(p, JSON.stringify(body));
    return p;
  };
  const ok = { id: "x:o/r#1", kind: "pull_request", repo: "o/r", url: "u", mergeSha: "a".repeat(40), mergedAt: "2026-08-01T01:00:00Z", author: { login: "a", kind: "human" }, mergedBy: null, reviews: [], changedLines: 1, labels: [] };

  it("accepts a bare array", async () => {
    expect((await new JsonFileProvider(tmp([ok])).listChanges({ repo: "o/r", window: W, kinds: ["pull_request"] })).changes).toHaveLength(1);
  });

  it("rejects malformed records, duplicates, another repo and direct pushes with reviews", async () => {
    const run = (body: unknown, repo = "o/r") => new JsonFileProvider(tmp(body)).listChanges({ repo, window: W, kinds: ["pull_request", "direct_push"] });
    await expect(run([{ ...ok, mergeSha: "XYZ" }])).rejects.toThrow(/mergeSha/);
    await expect(run([{ ...ok, reviews: [{ author: { login: "b", kind: "human" }, state: "LGTM", submittedAt: "2026-08-01T00:00:00Z" }] }])).rejects.toThrow(/state/);
    await expect(run([ok, ok])).rejects.toThrow(/duplicate/);
    await expect(run({ schema: "pr-rla/changes/v1", repo: "o/other", changes: [ok] })).rejects.toThrow(/export of o\/other/);
    await expect(run([{ ...ok, id: `x:o/r@${"b".repeat(40)}`, kind: "direct_push", mergeSha: "b".repeat(40), reviews: [{ author: { login: "b", kind: "human" }, state: "APPROVED", submittedAt: "2026-08-01T00:00:00Z" }] }])).rejects.toThrow(/direct_push has no reviews/);
  });
});
