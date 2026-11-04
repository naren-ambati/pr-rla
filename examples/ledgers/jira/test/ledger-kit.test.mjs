// The example's own test: pr-rla's ledger conformance kit under node:test, on two recorded public
// changelogs (hibernate.atlassian.net, read-only) and a synthetic Jira. Run it with
// `npm ci && npm test` in this directory; pr-rla must be built (`npm run build` at the repo root).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLedgerConformanceReport, runLedgerConformance } from "pr-rla/testing";
import jira from "../index.mjs";
import { jiraCases } from "./cases.mjs";

test("the ledger kit: recorded hibernate.atlassian.net changelogs and a synthetic Jira Cloud", async () => {
  const { fixtures, factory } = await jiraCases(jira);
  const report = await runLedgerConformance(factory, fixtures);
  assert.equal(report.ok, true, formatLedgerConformanceReport(report));
  assert.equal(fixtures.filter((f) => f.source === "recorded").length, 2);
  const ran = new Set(report.results.filter((r) => !r.skipped).map((r) => r.check));
  for (const c of ["first-label", "relabel-same", "relabel-opposite", "removal", "deletion", "label-rename", "unlisted-reviewer", "app-applied", "verdict-before-seed", "pagination", "idempotent-publish", "checkpoint-round-trip", "transient-faults"]) assert.ok(ran.has(c), `check ${c} ran`);
});
