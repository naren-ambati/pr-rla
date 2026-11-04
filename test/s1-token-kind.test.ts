import { describe, expect, it } from "vitest";
import * as read from "pr-rla/api/read";
import { builtinEnv, createAuditContext } from "../src/api/context.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { runVerify } from "../src/commands/verify.js";
import { fakeOrg, orgSpec, type FakeOrg } from "./helpers/fake-org.js";
import { setupPoolAudit, type PoolScenario } from "./helpers/pool-scenario.js";

/**
 * Round S1 (integration seams), item 1: what depends on a token's value is derived from the real value, so the CLI
 * and read-only mode (pr-rla/api/read, the MCP server), where a built-in holds only `prrla-cred:<ENV>`, decide alike.
 * Before S1, P3's OAuth App rule read the placeholder's prefix: an OAuth App token without the org's count was
 * INCOMPLETE in the CLI and PASS through read.verify (rv-seams/test/zz-seam-oauth.test.ts). Synthetic: U8's fake org.
 */

const org30 = () => fakeOrg(orgSpec({ eligible: 30, archived: 2, forks: 1, scale: 2 }));

async function frozen(org: FakeOrg): Promise<PoolScenario> {
  const s = setupPoolAudit(org);
  expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
  await s.advance(12 * 3600_000);
  expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
  return s;
}

type Check5 = { status: string; details: string[] };
/**
 * Check 5's lines; read-only lines quote the provider's reasons through `untrusted.errors` (S1, finding 2), so they are
 * resolved here to compare them with the CLI's, which quotes them in place.
 */
const c5 = (r: { checks: { n: number; status: string; details: unknown[] }[]; untrusted?: { errors: string[] } }): Check5 => {
  const c = r.checks.find((x) => x.n === 5)!;
  const errors = r.untrusted?.errors ?? [];
  return { status: c.status, details: c.details.map((d) => String(d).replace(/(?:the provider's reason|the account the freeze's token was); what it said is in untrusted\.errors\[(\d+)\]/g, (_m, i: string) => errors[Number(i)]!)) };
};
/** Check 5's lines about what the token can see (one per non-public visibility). */
const visibility = (c: Check5) => c.details.filter((d) => /repositor(y|ies) under acme-org/.test(d) && /private|internal/.test(d));

/** Check 5 of the CLI's verify and of read.verify (read-only mode) on the same audit, with `token` as GITHUB_TOKEN. */
async function both(s: PoolScenario, org: FakeOrg, token: string): Promise<{ cli: Check5; ro: Check5; verdicts: [string, string] }> {
  const env = { GITHUB_TOKEN: token };
  const cli = await s.clock.run(runVerify({ ...s.ctx, env }, { offline: false }));
  const ro = await s.clock.run(read.verify({ dir: s.dir, offline: false }, { nowMs: () => s.clock.now(), sleep: (ms) => s.clock.sleep(ms), fetch: org.fetch, env }));
  // Read-only says pr-rla's words: the reason itself is only in untrusted.errors.
  const raw = ro.checks.find((x) => x.n === 5)!.details.filter((d) => /under acme-org/.test(d) && /private|internal/.test(d));
  for (const l of raw) expect(l).not.toMatch(/OAuth App|X-OAuth-Scopes|classic token|auditor/);
  return { cli: c5(cli), ro: c5(ro), verdicts: [cli.verdict, ro.verdict] };
}

describe("item 1: the GitHub token kind is derived from the real value in read-only mode too", () => {
  it("an OAuth App token (gho_) without the org's total_private_repos: INCOMPLETE in the CLI and through read.verify, on the same reason (P3's test, read-only twin)", async () => {
    const org = org30();
    const s = await frozen(org);
    const r = await both(s, org, "gho_synthetic000000000000000000000000000");
    expect(r.cli.status).toBe("INCOMPLETE");
    expect(r.ro.status).toBe("INCOMPLETE");
    expect(r.verdicts).toEqual(["INCOMPLETE", "INCOMPLETE"]);
    for (const c of [r.cli, r.ro]) {
      expect(visibility(c)).toHaveLength(2);
      for (const l of visibility(c)) expect(l).toMatch(/^INCOMPLETE cannot establish that this token sees every (private|internal) repository under acme-org: .*the token is an OAuth App token \(gho_\), which the org's OAuth App access restrictions can limit to public repositories/);
    }
    // With the org's count, both PASS.
    org.control.orgTotalPrivate = "auto";
    const counted = await both(s, org, "gho_synthetic000000000000000000000000000");
    expect([counted.cli.status, counted.ro.status]).toEqual(["PASS", "PASS"]);
    for (const c of [counted.cli, counted.ro]) for (const l of visibility(c)) expect(l).toMatch(/with a OAuth App token holding the repo scope: GitHub shows org owners every repository of the org, and the listing is held to the org's total_private_repos/);
  }, 240_000);

  it("a classic token (ghp_): complete in both, and both name it a classic token", async () => {
    const org = org30();
    const s = await frozen(org);
    const r = await both(s, org, "ghp_synthetic000000000000000000000000000");
    expect([r.cli.status, r.ro.status]).toEqual(["PASS", "PASS"]);
    for (const c of [r.cli, r.ro]) {
      expect(visibility(c)).toHaveLength(2);
      for (const l of visibility(c)) expect(l).toMatch(/^(private|internal) repositories under acme-org: listed completely \(auditor is an owner \(admin\) of acme-org, with a classic token holding the repo scope/);
    }
    expect(visibility(r.ro)).toEqual(visibility(r.cli));
  }, 240_000);

  it("a fine-grained token (github_pat_, no X-OAuth-Scopes): INCOMPLETE in both, on the same reason", async () => {
    const org = org30();
    const s = await frozen(org);
    org.control.viewer.scopes = null;
    const r = await both(s, org, "github_pat_synthetic0000000000000000000000");
    expect([r.cli.status, r.ro.status]).toEqual(["INCOMPLETE", "INCOMPLETE"]);
    for (const c of [r.cli, r.ro]) for (const l of visibility(c)) expect(l).toMatch(/the token sends no X-OAuth-Scopes header, so it is a fine-grained personal access token or a GitHub App token/);
    expect(visibility(r.ro)).toEqual(visibility(r.cli));
  }, 240_000);

  it("the credential layer passes the kind beside the placeholder, never the value; a placeholder without a kind proves nothing", async () => {
    const ctx = createAuditContext({ mode: "read-only", env: { GITHUB_TOKEN: "gho_REAL_VALUE_0123", GH_TOKEN: "ghp_OTHER_0123" } });
    const b = builtinEnv(ctx, "provider", "github", "github", {});
    expect(b.env).toEqual({ GITHUB_TOKEN: "prrla-cred:GITHUB_TOKEN", GH_TOKEN: "prrla-cred:GH_TOKEN" });
    expect(b.kinds).toEqual({ GITHUB_TOKEN: "oauth-app", GH_TOKEN: "classic" });
    expect(JSON.stringify(b)).not.toMatch(/REAL_VALUE|OTHER_0123/);
    // A GitHub provider given only the placeholder (no kind) refuses to call its listing complete.
    const { GitHubProvider } = await import("../src/providers/github/index.js");
    const p = new GitHubProvider({}, { cwd: ".", env: { GITHUB_TOKEN: "prrla-cred:GITHUB_TOKEN" }, log: () => {}, fetch: (async () => new Response("{}")) as typeof fetch });
    const seen = await p.listingVisibility({ kind: "rule", owner: "acme-org", include: ["*"], exclude: [], visibility: ["public", "private"], archived: false, forks: false } as never);
    expect(seen.visibilities.private).toEqual({ complete: false, reason: expect.stringMatching(/^pr-rla holds only a placeholder for the token and was not told its kind/) });
  });
});
