import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import { makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { fakeOrg } from "./helpers/fake-org.js";

/**
 * A single repo is a pool of one, and existing single-repo audits behave byte-identically (FR5.1; test-design U8).
 *
 * The values below were produced by running the same two scenarios on the master build a360348 (before U8: the code in
 * git archive a360348), at the same fixed clock, and by this build: every section of the manifest and the commitment
 * record, the keys of every record in their order, and the registered `repos` field matched. They pin the population
 * (`changes`, `funnel`, `limitations`, `repos`) rather than whole-file hashes, so a later change to the registration
 * (which the manifest names by hash) or a version bump does not move them. Fixture kind: synthetic.
 */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const read = (s: Scenario, p: string) => readFileSync(join(s.dir, p), "utf8");

async function freezeAt(s: Scenario) {
  s.clock.now = T("2026-10-20T00:00:00Z");
  await registerCommand(s.ctx, {});
  s.clock.now = T("2026-10-20T12:00:00Z");
  expect(await freezeCommand(s.ctx, {})).toBe(0);
  const m = JSON.parse(read(s, "audit/2026-q3.manifest.json")) as Record<string, unknown> & { repos: unknown };
  const part = (k: string) => sha(JSON.stringify(m[k]));
  return {
    m,
    cm: (JSON.parse(read(s, "audit/2026-q3/manifest-commitment.json")) as { record: Record<string, unknown> }).record,
    reg: (JSON.parse(read(s, "audit/2026-q3/registration.json")) as { record: Record<string, unknown> }).record,
    sections: { changes: part("changes"), funnel: part("funnel"), limitations: part("limitations"), selector: part("selector"), parameters: part("parameters"), window: part("window") },
  };
}

const MANIFEST_KEYS = ["schema", "registrationSha256", "repos", "provider", "window", "frozenAt", "selector", "parameters", "protocolSha256", "funnel", "limitations", "N", "changes", "prRlaVersion", "sha256"];
const COMMITMENT_KEYS = ["schema", "window", "manifestSha256", "N", "registrationSha256", "frozenAt", "seedRound", "seedRoundPublishesAt", "prRlaVersion"];
const REGISTRATION_KEYS = ["schema", "repos", "window", "selector", "protocolSha256", "parameters", "beacon", "registeredAt", "timestamping", "plugins", "verdicts", "prRlaVersion"];
const COMMON = {
  selector: "e381d1db2c49bb41da0bc537d29e72608fbd7ff3fb2ad95d3341a41beff09b53",
  parameters: "62b7dd0cb85dff956cf8f0e1da38d39736f76e34de89553b3f27e4d2e1abce69",
  window: "003cc559ab6f9d44570e37728fb946ec49407458358531fcfebf537216b11e59",
};

describe("single-repo audits are unchanged by U8 (a pool of one, byte for byte)", () => {
  it("json-file provider, 400 changes: the manifest, commitment and registration are what master wrote", async () => {
    const s = setupAuditRepo({ changes: makeChanges(400) });
    const r = await freezeAt(s);
    expect(Object.keys(r.m)).toEqual(MANIFEST_KEYS);
    expect(Object.keys(r.cm)).toEqual(COMMITMENT_KEYS);
    expect(Object.keys(r.reg)).toEqual(REGISTRATION_KEYS);
    expect(r.reg.repos).toEqual({ kind: "repo", repo: "acme/widgets" });
    expect(r.m.repos).toEqual([{ repo: "acme/widgets", repoId: null, defaultBranch: "main", headSha: null }]);
    expect(r.m.N).toBe(400);
    expect(r.m.frozenAt).toBe("2026-10-20T12:00:00Z");
    expect(r.cm.frozenAt).toBe("2026-10-20T12:00:00Z");
    expect(r.sections).toEqual({
      ...COMMON,
      changes: "66795f74c42f8c0a614d925893fd0dafa66e225fcbf1a6aac158c864b14e91e4",
      funnel: "88be69a89a2d4b899a63df0c7947102cfdad9c037f922bf3395af06478c6d030",
      limitations: "f06ae9dc6b24bf0c2d9789b8aa4e2387ff7d387c22e24360e94545b99059f3ff",
    });
    expect(s.out.join("\n")).not.toMatch(/freeze: /); // no pooled progress lines
    expect(existsSyncCache(s)).toBe(false);
    const v = await runVerify(s.ctx, { offline: false });
    expect(v.checks.map((c) => [c.n, c.status])).toEqual([[1, "WARN"], [2, "WARN"], [3, "PASS"], [4, "SKIP"], [5, "PASS"], [6, "SKIP"], [7, "SKIP"]]);
    expect(v.checks.find((c) => c.n === 5)!.summary).toBe("population 400/400 match");
  });

  it("GitHub provider, one repo of a synthetic org: the pinned head and every section are what master wrote", async () => {
    const org = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 120, pushes: 25, after: 3 }] });
    const s = setupAuditRepo({ changes: [], provider: "github", fetch: org.fetch });
    const r = await freezeAt(s);
    expect(Object.keys(r.m)).toEqual(MANIFEST_KEYS);
    expect(r.m.repos).toEqual([{ repo: "acme/widgets", repoId: null, defaultBranch: "main", headSha: "29791b4e876b9ec17c0392c6208ab7f64bdcdbec" }]);
    expect(r.m.N).toBe(104);
    expect(r.sections).toEqual({
      ...COMMON,
      changes: "e73b1eb438126da16ce7896fb4d635f5cb5049de487d3bcfee7132c796e0600e",
      funnel: "90332e104561708262a4fcba4991848bd56d7e51757964c67a114d39883f802a",
      limitations: "d1460793ec0499e0569e079d51d62945213a1f5baf202a38394226a15c04edc0",
    });
    const v = await runVerify(s.ctx, { offline: false });
    expect(v.checks.find((c) => c.n === 5)!.status).toBe("PASS");
    expect(v.checks.find((c) => c.n === 5)!.details).toContain("history walked from the frozen head 29791b4e876b…");
  });
});

const existsSyncCache = (s: Scenario) => existsSync(join(s.dir, ".pr-rla", "cache"));
