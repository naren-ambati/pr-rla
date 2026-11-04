import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { registerCommand } from "../src/commands/register.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import { canonicalJson, sha256Hex } from "../src/core/canonical.js";
import { manifestSha256, type CommitmentRecordV2, type ManifestV2, type SignedRecord } from "../src/core/records.js";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { BrokerRetriesExhausted } from "../src/net/contract.js";
import github from "../src/providers/github/index.js";
import { isRepoUnavailable } from "../src/sdk/provider.js";
import { setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { fakeBitbucketCloud } from "./helpers/fake-bitbucket-cloud.js";
import { fakeOrg, orgSpec, ORG, type FakeOrg } from "./helpers/fake-org.js";
import { setupPoolAudit, type PoolScenario } from "./helpers/pool-scenario.js";
import { scmScenario } from "./helpers/scm-scenario.js";

/**
 * Regression tests for the independent review of bolt U8 (2026-11-04). Each attack the review reproduced (its scratch
 * tests rt/soundness, rt/more, rt/bbhead) is here as a test that failed on b76a9e4 and passes after the fix round; the
 * finding number is in each describe. Fixture kind: synthetic (test/helpers/fake-org.ts and the SCM fakes).
 */
const W = "audit/2026-q3";
const MANIFEST = `${W}.manifest.json`;
const CM = `${W}/manifest-commitment.json`;
const readManifest = (s: { dir: string }) => JSON.parse(readFileSync(join(s.dir, MANIFEST), "utf8")) as ManifestV2;
const org30 = () => fakeOrg(orgSpec({ eligible: 30, archived: 2, forks: 1, scale: 2 }));
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
type Report = Awaited<ReturnType<typeof runVerify>>;
const check = (r: Report, n: number) => r.checks.find((x) => x.n === n)!;
const lines = (r: Report, n: number) => check(r, n).details.join("\n");

async function registered(org: FakeOrg, o: Parameters<typeof setupPoolAudit>[1] = {}) {
  const s = setupPoolAudit(org, o);
  expect(await s.clock.run(registerCommand(s.ctx, {}))).toBe(0);
  await s.advance(12 * 3600_000); // 2026-10-20T12:00Z: the window is closed, R (10-21T00:00Z) is not yet public
  return s;
}
async function frozen(org: FakeOrg, before?: () => void, o: Parameters<typeof setupPoolAudit>[1] = {}) {
  const s = await registered(org, o);
  before?.();
  expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
  return s;
}
const verify = (s: PoolScenario, ctx = s.ctx) => s.clock.run(runVerify(ctx, { offline: false }));

/** What an auditee who holds the audit's signing key can do before R: rewrite the manifest and re-sign the commitment. */
function resign(s: { dir: string }, edit: (m: ManifestV2) => ManifestV2) {
  const m = edit(readManifest(s));
  const { sha256: _old, ...body } = m;
  const sha = manifestSha256(body as never);
  writeFileSync(join(s.dir, MANIFEST), JSON.stringify({ ...body, sha256: sha }, null, 2));
  const cm = JSON.parse(readFileSync(join(s.dir, CM), "utf8")) as SignedRecord<CommitmentRecordV2>;
  writeFileSync(join(s.dir, CM), JSON.stringify(signRecord({ ...cm.record, manifestSha256: sha, N: m.N }, loadOrCreateKey(join(s.dir, ".pr-rla/signing-key.pem"))), null, 2));
}
/**
 * What U8 asserted as VERIFIED for an honest frozen pool: since time round B a frozen, unsampled audit on self-asserted
 * times is never VERIFIED. The honest one FAILs nothing and is INCOMPLETE only for that: checks 1–3 (times nobody
 * proves) and 4, 6 and 7 (not sampled), never check 5, the pool's own check.
 */
function honestButUnsampled(r: { verdict: string; checks: { n: number; status: string }[] }): void {
  expect(r.checks.filter((c) => c.status === "FAIL")).toEqual([]);
  expect(r.verdict).toBe("INCOMPLETE");
  expect(r.checks.filter((c) => c.status === "INCOMPLETE" || c.status === "SKIP").map((c) => c.n)).toEqual([1, 2, 3, 4, 6, 7]);
}

const dropRepos = (gone: Set<string>) => (m: ManifestV2): ManifestV2 => {
  const changes = m.changes.filter((x) => !gone.has(x.repo));
  return { ...m, repos: m.repos.filter((r) => !gone.has(r.repo)), changes, N: changes.length };
};

describe("finding 1: an attribute changed after registration cannot take a repo out of the pool", () => {
  it("a registered repo archived between window close and freeze is frozen anyway; a manifest without it FAILs checks 2 and 5", async () => {
    const org = org30();
    const victim = `${ORG}/svc-07`;
    const s = await frozen(org, () => org.updateRepo("svc-07", { archived: true }));
    const m = readManifest(s);
    expect(m.repos.map((r) => r.repo)).toContain(victim);
    expect(m.changes.filter((x) => x.repo === victim).length).toBeGreaterThan(100);
    expect(m.repoListing!.repos.find((r) => r.repo === victim)).toMatchObject({ archived: true, excludedBy: ["archived"] });
    const honest = await verify(s);
    expect(check(honest, 5).status).toBe("PASS");
    honestButUnsampled(honest);
    resign(s, dropRepos(new Set([victim])));
    const pruned = await verify(s);
    expect(check(pruned, 2).status).toBe("FAIL");
    expect(lines(pruned, 2)).toMatch(/manifest drops 1 registered repo\(s\) \(e\.g\. acme-org\/svc-07\)/);
    expect(check(pruned, 5).status).toBe("FAIL");
    expect(lines(pruned, 5)).toMatch(/FAIL registered repo acme-org\/svc-07 is not in the manifest \(\d+ changes landed in the window\)/);
    expect(pruned.verdict).toBe("FAILED");
  });

  it("renamed out of the include glob, made private under a public-only rule, or transferred out of the org: all frozen, by repo id", async () => {
    const org = org30();
    const s = await frozen(
      org,
      () => {
        org.renameRepo("svc-01", "legacy-01");
        org.updateRepo("svc-02", { visibility: "private" });
        org.transferRepo("svc-04", "elsewhere");
      },
      { repos: `{ owner: ${ORG}, include: ["svc-*"], visibility: [public] }` },
    );
    const repos = readManifest(s).repos.map((r) => r.repo);
    expect(repos).toEqual(expect.arrayContaining([`${ORG}/legacy-01`, `${ORG}/svc-02`, "elsewhere/svc-04"]));
    const r = await verify(s);
    expect(check(r, 2).status).not.toBe("FAIL");
    honestButUnsampled(r);
    // The three are rebuilt; the only warnings are for the repos that were never public, so the public-only rule never had
    // them: one summary line (P3, pass 2 finding 10), each repo behind it in `verbose`.
    expect(check(r, 5).details.filter((d) => d.startsWith("WARN "))).toHaveLength(1);
    const warned = (check(r, 5).verbose ?? []).map((d) => /^WARN repo (\S+)/.exec(d)?.[1]);
    expect(warned.sort()).toEqual(org.spec.repos.filter((x) => (x.visibility ?? "public") !== "public").map((x) => `${ORG}/${x.name}`).sort());
    expect(lines(r, 5)).toContain("history walked from the frozen heads of 23 repo(s)");
  });

  it("retrospective: a repo archived before registration is out of the pool, and verify WARNs with its change count", async () => {
    const org = org30();
    org.updateRepo("svc-07", { archived: true });
    const s = await frozen(org);
    expect(readManifest(s).repos.map((r) => r.repo)).not.toContain(`${ORG}/svc-07`);
    const r = await verify(s);
    expect(check(r, 5).status).toBe("WARN");
    expect(lines(r, 5)).toMatch(/WARN 1 repo\(s\) excluded only by attributes their owners can change \(name, archive state, visibility\) have \d+ changes in the window that are not in the population \(e\.g\. acme-org\/svc-07\): the registration came after the window opened/);
    expect(check(r, 5).verbose!.join("\n")).toMatch(/WARN repo acme-org\/svc-07 is excluded by archived now, an attribute its owners can change, and has \d+ changes in the window that are not in the population \(the registration came after the window opened, so a change made before it cannot be detected\)/);
  });
});

describe("finding 8: a rename after freeze is matched by repo id", () => {
  it("a repo of a registered list (no ids) renamed after freeze is found through GitHub's redirect, and PASSes", async () => {
    const org = org30();
    const s = await frozen(org, undefined, { repos: `[${ORG}/svc-01, ${ORG}/svc-02, ${ORG}/svc-03]` });
    org.renameRepo("svc-02", "renamed-02");
    const r = await verify(s);
    expect(check(r, 5).status).toBe("PASS");
    expect(lines(r, 5)).toContain("acme-org/svc-02 is named acme-org/renamed-02 now (matched by repo id): rebuilt under its new name");
  });

  it("check 5 rebuilds the renamed repo under its new name and PASSes", async () => {
    const org = org30();
    const s = await frozen(org);
    org.renameRepo("svc-05", "renamed-05");
    const r = await verify(s);
    expect(check(r, 5).status).toBe("PASS");
    expect(lines(r, 5)).toContain("acme-org/svc-05 is named acme-org/renamed-05 now (matched by repo id): rebuilt under its new name");
    honestButUnsampled(r);
  });
});

describe("finding 2: what the verifier can see decides whether the pool is complete", () => {
  const nonPublic = (org: FakeOrg) => org.spec.repos.filter((r) => (r.visibility ?? "public") !== "public").map((r) => `${ORG}/${r.name}`);

  it("a fine-grained token that cannot see the private and internal repos: INCOMPLETE (exit 6), never VERIFIED", async () => {
    const org = org30();
    const s = await frozen(org);
    // GitHub's realistic answer: the listing leaves them out and every endpoint answers 404.
    for (const r of nonPublic(org)) org.control.invisible.add(r);
    org.control.viewer.scopes = null;
    const r = await verify(s);
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE cannot establish that this token sees every private repository under acme-org: the token sends no X-OAuth-Scopes header, so it is a fine-grained personal access token or a GitHub App token/);
    expect(lines(r, 5)).toMatch(/INCOMPLETE cannot establish that this token sees every internal repository/);
    expect(lines(r, 5)).toMatch(/INCOMPLETE acme-org\/svc-03: gone: not in acme-org's listing, and its repo-level metadata answers HTTP 404 \(deleted, or hidden from this token\): its \d+ changes in the manifest were not rebuilt/);
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.ok).toBe(false);
    expect(await s.clock.run(verifyCommand(s.ctx, {}))).toBe(6);
  });

  it("the same verifier on a manifest pruned of every private and internal repo: FAILED (the registered repos), where it used to pass", async () => {
    const org = org30();
    const s = await frozen(org);
    const hidden = new Set(nonPublic(org));
    resign(s, dropRepos(hidden));
    for (const r of hidden) org.control.invisible.add(r);
    org.control.viewer.scopes = null;
    const r = await verify(s);
    expect(check(r, 2).status).toBe("FAIL");
    expect(r.verdict).toBe("FAILED");
  });

  it("an org member who is not an owner, or not a member at all: INCOMPLETE for private and internal; an owner: complete", async () => {
    const org = org30();
    const s = await frozen(org);
    org.control.viewer.role = "member";
    const member = await verify(s);
    expect(check(member, 5).status).toBe("INCOMPLETE");
    expect(lines(member, 5)).toMatch(/auditor is a member of acme-org, not an owner: GitHub shows a member only the private repositories they were granted/);
    org.control.viewer.role = null;
    expect(lines(await verify(s), 5)).toMatch(/auditor is not a member of acme-org/);
    org.control.viewer.role = "admin";
    const owner = await verify(s);
    expect(check(owner, 5).status).toBe("PASS");
    expect(lines(owner, 5)).toMatch(/private repositories under acme-org: listed completely \(auditor is an owner \(admin\) of acme-org/);
  });
});

describe("finding 3: the pinned head cannot hide window landings", () => {
  const base = (repo: string) => sha1(`${repo}:base`);

  it("pooled: a head rewound to before the window, with that repo's direct pushes dropped, FAILs check 5", async () => {
    const s = await frozen(org30());
    const byRepo = new Map<string, number>();
    for (const x of readManifest(s).changes) if (x.kind === "direct_push") byRepo.set(x.repo, (byRepo.get(x.repo) ?? 0) + 1);
    const [victim] = [...byRepo].sort((a, b) => b[1] - a[1])[0]!;
    resign(s, (m) => {
      const changes = m.changes.filter((x) => !(x.repo === victim && x.kind === "direct_push"));
      return { ...m, repos: m.repos.map((r) => (r.repo === victim ? { ...r, headSha: base(victim) } : r)), changes, N: changes.length };
    });
    const r = await verify(s);
    expect(check(r, 5).status).toBe("FAIL");
    // P3: by the push log (the frozen head was not the branch's tip at freeze) and the stopgap, never by commit dates.
    expect(lines(r, 5)).toMatch(new RegExp(`FAIL ${victim}: the frozen head [0-9a-f]{12}… was not the default branch's tip at freeze`));
    expect(lines(r, 5)).toMatch(new RegExp(`FAIL ${victim}: \\d+ pull request\\(s\\) merged in the window have a merge commit that is not reachable from the frozen head`));
  });

  it("a single repo: the same rewind FAILs (master trusted the frozen head too)", async () => {
    const org = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 120, pushes: 25, after: 3 }] });
    const s = setupAuditRepo({ changes: [], provider: "github", fetch: org.fetch });
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    resign(s, (m) => {
      const changes = m.changes.filter((x) => x.kind !== "direct_push");
      return { ...m, repos: m.repos.map((r) => ({ ...r, headSha: base("acme/widgets") })), changes, N: changes.length };
    });
    const r = await runVerify(s.ctx, { offline: false });
    expect(check(r, 5).status).toBe("FAIL");
    expect(lines(r, 5)).toMatch(/FAIL the frozen head [0-9a-f]{12}… was not the default branch's tip at freeze/);
  });

  it("FR7.2 still holds: a merge pushed after freeze that brings in work dated in the window is not a failure", async () => {
    const org = org30();
    const s = await frozen(org);
    const h = org.history("svc-03");
    const parentOfHead = h.commits.find((c) => c.oid === h.head)!.parents[0]!;
    const lc = { oid: sha1("late-work"), date: "2026-09-30T12:00:00Z", parents: [parentOfHead], author: { name: "Late", email: "late@example.invalid", login: "late" } };
    const lm = { oid: sha1("late-merge"), date: "2026-10-25T09:00:00Z", parents: [h.head, lc.oid] };
    org.pushCommits("svc-03", [lc, lm]); // GitHub records the push when it happens: here, at the merge's date
    const r = await verify(s);
    expect(check(r, 5).status).toBe("PASS");
    expect(lines(r, 5)).toMatch(/1 commit\(s\) dated in the window reached the default branch after the window closed, not through the frozen head .*\(FR7\.2\)/);
  });

  it("a commit dated in the window pushed straight onto the frozen head after freeze is FR7.2 too (P3: this test used to pin it as a FAIL)", async () => {
    const org = org30();
    const s = await frozen(org);
    const h = org.history("svc-03");
    org.pushCommits("svc-03", [{ oid: sha1("backdated"), date: "2026-09-30T20:00:00Z", parents: [h.head] }], { at: "2026-10-20T15:00:00Z" });
    const r = await verify(s);
    expect(check(r, 5).status).toBe("PASS");
    // Frozen, not sampled, no timestamp authority: nothing FAILs, and time round B makes it INCOMPLETE, not VERIFIED.
    honestButUnsampled(r);
  });

  it("an edited checkpoint is listed again, one that breaks the contract is refused, and one re-hashed to rewind a head is caught by verify", async () => {
    const org = org30();
    const s = await registered(org);
    const stop = async (force = false) => {
      org.control.stuck.add(`${ORG}/svc-29`);
      let runId = "";
      await s.clock.run(freezeCommand(s.ctx, force ? { force: true } : {})).catch((e) => (runId = /--resume ([0-9a-f]{64})/.exec((e as Error).message)?.[1] ?? ""));
      org.control.stuck.clear();
      expect(runId).toMatch(/^[0-9a-f]{64}$/);
      const dir = join(s.dir, ".pr-rla/cache/2026-q3", runId, "repos");
      for (const f of readdirSync(dir)) {
        const marker = JSON.parse(readFileSync(join(dir, f), "utf8")) as { repo: string; listed: { headSha: string; changes: { id: string; kind: string; mergeSha: string; mergedAt: string }[] } };
        if (marker.listed.changes.some((x) => x.kind === "direct_push")) return { runId, path: join(dir, f), marker };
      }
      throw new Error("no checkpointed repo with direct pushes");
    };
    const rewind = (m: Awaited<ReturnType<typeof stop>>["marker"]) => {
      m.listed.headSha = base(m.repo);
      m.listed.changes = m.listed.changes.filter((x) => x.kind !== "direct_push");
    };
    // 1. Edited, digest left as it was: not trusted, listed again; the manifest records the real head.
    const a = await stop();
    const realHead = a.marker.listed.headSha;
    rewind(a.marker);
    writeFileSync(a.path, JSON.stringify(a.marker));
    expect(await s.clock.run(freezeCommand(s.ctx, { resume: a.runId }))).toBe(0);
    expect(readManifest(s).repos.find((r) => r.repo === a.marker.repo)!.headSha).toBe(realHead);
    // 2. Re-hashed, but with a change from outside the window: the contract check on the checkpoint refuses it.
    const b = await stop(true);
    const extra = { ...b.marker.listed.changes[0]!, id: `${b.marker.listed.changes[0]!.id}999`, mergeSha: "f".repeat(40), mergedAt: "2025-01-01T00:00:00Z" };
    b.marker.listed.changes.push(extra);
    writeFileSync(b.path, JSON.stringify({ ...b.marker, sha256: sha256Hex(canonicalJson(b.marker.listed)) }));
    s.out.length = 0;
    expect(await s.clock.run(freezeCommand(s.ctx, { force: true, resume: b.runId }))).toBe(0); // the command a stopped --force run prints
    expect(readManifest(s).changes.some((x) => x.id === extra.id)).toBe(false);
    expect(s.out.join("\n")).toMatch(/the checkpoint for acme-org\/svc-\d\d is not usable \(.*outside the window\); listing it again/);
    // 3. Re-hashed and contract-valid, with a rewound head: freeze cannot tell, verify can.
    const c = await stop(true);
    rewind(c.marker);
    writeFileSync(c.path, JSON.stringify({ ...c.marker, sha256: sha256Hex(canonicalJson(c.marker.listed)) }));
    expect(await s.clock.run(freezeCommand(s.ctx, { force: true, resume: c.runId }))).toBe(0);
    const r = await verify(s);
    expect(check(r, 5).status).toBe("FAIL");
    expect(lines(r, 5)).toMatch(new RegExp(`FAIL ${c.marker.repo}: the frozen head [0-9a-f]{12}… was not the default branch's tip at freeze`));
  });
});

describe("finding 4: only a repo-level probe decides that a repo is gone", () => {
  it("Bitbucket Cloud: a frozen head the server does not know (404, as Bitbucket answers an unknown revision) FAILs; the repo is not 'unavailable'", async () => {
    const sc = scmScenario();
    const fake = fakeBitbucketCloud(sc, { pageLen: 3 });
    const BOGUS = "0".repeat(40);
    const fetch404 = ((input: string | URL | Request, init?: RequestInit) => (String(input).includes(`/commits/${BOGUS}`) ? Promise.resolve(new Response(JSON.stringify({ type: "error", error: { message: "Commit not found" } }), { status: 404 })) : fake.fetch(input, init))) as typeof fetch;
    const s = setupAuditRepo({ changes: [], provider: "bitbucket-cloud", fetch: fetch404 });
    writeFileSync(join(s.dir, ".pr-rla.yml"), readFileSync(join(s.dir, ".pr-rla.yml"), "utf8").replace("repo: acme/widgets", "repos: [acme/widgets]"));
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    expect(await freezeCommand(s.ctx, {})).toBe(0);
    resign(s, (m) => ({ ...m, repos: m.repos.map((r) => ({ ...r, headSha: BOGUS })) }));
    const r = await runVerify(s.ctx, { offline: false });
    expect(check(r, 5).status).toBe("FAIL");
    expect(lines(r, 5)).toMatch(/FAIL acme\/widgets: frozen head 000000000000… not found \(HTTP 404: .*\); the repository itself exists/);
    expect(r.verdict).toBe("FAILED");
  });

  it("a 404 on part of a GitHub repo that exists is a FAIL; a repo whose own metadata answers 404 is gone (INCOMPLETE)", async () => {
    const org = org30();
    const s = await frozen(org);
    const subresource = ((input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).pathname === `/repos/${ORG}/svc-06/pulls` ? Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 })) : org.fetch(input, init))) as typeof fetch;
    const r = await verify(s, s.ctxFor(subresource));
    expect(check(r, 5).status).toBe("FAIL");
    expect(lines(r, 5)).toMatch(/FAIL acme-org\/svc-06: HTTP 404 on part of the repository although it exists/);
    org.removeRepo("svc-06");
    const gone = await verify(s);
    expect(check(gone, 5).status).toBe("INCOMPLETE");
    expect(lines(gone, 5)).toMatch(/INCOMPLETE acme-org\/svc-06: gone: not in acme-org's listing, and its repo-level metadata answers HTTP 404/);
  });
});

describe("finding 5: anything that could not be rebuilt is INCOMPLETE, exit 6", () => {
  it("a verifier whose token reads nothing (SSO not authorised): INCOMPLETE with every reason, exit 6, never VERIFIED", async () => {
    const org = org30();
    const s = await frozen(org);
    const m = readManifest(s);
    const sso = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/orgs/") || url.pathname.startsWith("/user")) return new Response('{"message":"Resource protected by organization SAML enforcement."}', { status: 403 });
      for (const r of m.repos) org.control.gone.set(r.repo, 403);
      try {
        return await org.fetch(input, init);
      } finally {
        org.control.gone.clear();
      }
    }) as typeof fetch;
    const ctx = s.ctxFor(sso);
    const r = await verify(s, ctx);
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(check(r, 5).summary).toMatch(/^population 0\/0 match · [\d,]+ changes in 30 repo\(s\) could not be rebuilt · completeness not established/);
    expect(lines(r, 5)).toMatch(/INCOMPLETE cannot re-list the repositories under acme-org \(.*HTTP 403/);
    expect(lines(r, 5)).toMatch(/INCOMPLETE acme-org\/svc-00: no access: its repo-level metadata answers HTTP 403/);
    expect(r).toMatchObject({ ok: false, verdict: "INCOMPLETE" });
    s.out.length = 0;
    expect(await s.clock.run(verifyCommand(ctx, { json: true }))).toBe(6);
    expect(JSON.parse(s.out.join("\n"))).toMatchObject({ ok: false, verdict: "INCOMPLETE" });
    s.out.length = 0;
    expect(await s.clock.run(verifyCommand(ctx, {}))).toBe(6);
    expect(s.out.at(-1)).toBe("INCOMPLETE: check 1 (registration), check 2 (manifest before seed), check 3 (seed round), check 5 (population) could not be established; check 4 (BLS), check 6 (draws), check 7 (labels) skipped; nothing failed, but this is not a verification (exit 6)");
  });
});

describe("finding 6: a rate limit is never a gone repo", () => {
  it("a rate-limited give-up that carries status 403 is not unavailability", () => {
    expect(isRepoUnavailable(new BrokerRetriesExhausted("api.github.com", 7, 1000, "HTTP 403", 403, true))).toBe(false);
    expect(isRepoUnavailable(Object.assign(new Error("x"), { status: 403, code: "BROKER_RETRIES_EXHAUSTED" }))).toBe(false);
    expect(isRepoUnavailable(Object.assign(new Error("x"), { status: 404 }))).toBe(true);
  });

  it("a GitHub secondary-limit 403 with no rate-limit header: freeze stops (exit 4, resumable); verify is INCOMPLETE, not 'gone'", async () => {
    const org = org30();
    const s = await registered(org);
    const limited = ((input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === `/repos/${ORG}/svc-04/pulls`
        ? Promise.resolve(new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }), { status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4000" } }))
        : org.fetch(input, init)) as typeof fetch;
    let err: { exitCode?: number; message?: string } | null = null;
    await s.clock.run(freezeCommand(s.ctxFor(limited), {})).catch((e) => (err = e));
    expect(err!.exitCode).toBe(4);
    expect(err!.message).toMatch(/secondary rate limit.*Continue with: pr-rla freeze --resume [0-9a-f]{64}$/);
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    const r = await verify(s, s.ctxFor(limited));
    expect(check(r, 5).status).toBe("INCOMPLETE");
    expect(lines(r, 5)).toMatch(/INCOMPLETE acme-org\/svc-04: could not be listed \(.*secondary rate limit.*\): a rate limit or an outage, not a missing repository; run verify again/);
  });
});

describe("finding 7: an empty repository", () => {
  it("a single-repo audit of an empty repo stops at freeze with master's message, and writes nothing", async () => {
    const org = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 0, pushes: 0, empty: true }] });
    const s = setupAuditRepo({ changes: [], provider: "github", fetch: org.fetch });
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T12:00:00Z");
    await expect(freezeCommand(s.ctx, {})).rejects.toThrow(/^acme\/widgets has no default branch$/);
    expect(existsSync(join(s.dir, MANIFEST))).toBe(false);
  });

  it("inside a pool it is a repo with nothing in it; verify says it is empty, not that the provider does not pin history", async () => {
    const org = fakeOrg(orgSpec({ eligible: 6 }));
    org.addRepo({ name: "svc-empty", prs: 0, pushes: 0, empty: true });
    const s = await frozen(org);
    expect(readManifest(s).repos.find((r) => r.repo === `${ORG}/svc-empty`)).toMatchObject({ defaultBranch: "", headSha: null });
    const r = await verify(s);
    expect(check(r, 5).status).toBe("PASS");
    expect(lines(r, 5)).toContain("1 repo(s) are empty (no default branch), as the manifest records (e.g. acme-org/svc-empty)");
    expect(lines(r, 5)).not.toMatch(/does not pin history/);
  });
});

describe("finding 9: a user account's own pool includes its private repositories", () => {
  it("when the owner is the token's account, GitHub's /user/repos?affiliation=owner is listed, not the public-only /users/{owner}/repos", async () => {
    const seen: string[] = [];
    const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      seen.push(u.pathname + u.search);
      if (u.pathname.startsWith("/orgs/")) return json({ message: "Not Found" }, 404);
      if (u.pathname === "/user") return json({ login: "Alice" }, 200, { "x-oauth-scopes": "repo" });
      if (u.pathname === "/user/repos") return json([{ full_name: "alice/dotfiles", id: 7, default_branch: "main", visibility: "public" }, { full_name: "alice/secret", id: 8, default_branch: "main", visibility: "private" }]);
      return json([{ full_name: "alice/dotfiles", id: 7, default_branch: "main", visibility: "public" }]);
    }) as typeof fetch;
    const p = await github.create({}, { cwd: ".", env: { GITHUB_TOKEN: "synthetic" }, log: () => {}, fetch: f });
    const refs = await p.listRepos!({ kind: "rule", owner: "alice", include: ["*"], exclude: [], archived: false, forks: false, visibility: ["internal", "private", "public"] });
    expect(refs.map((r) => [r.repo, r.visibility])).toEqual([["alice/dotfiles", "public"], ["alice/secret", "private"]]);
    expect(seen).toEqual(["/orgs/alice/repos?type=all&per_page=100", "/user", "/user/repos?affiliation=owner&per_page=100"]);
  });
});

describe("finding 10: a freeze never writes after R", () => {
  it("refuses to start when the commitment's tokens could be issued after R (within the authorities' retry deadline)", async () => {
    const s = setupPoolAudit(fakeOrg(orgSpec({ eligible: 3 })), { timestamping: "{ authorities: [sigstore], min_tokens: 1 }" });
    await s.clock.run(registerCommand(s.ctx, {})); // no authority answers (exit 5); the registration is written
    await s.advance(24 * 3600_000 - 4 * 60_000); // 2026-10-20T23:56Z: R publishes at 00:00
    await expect(s.clock.run(freezeCommand(s.ctx, {}))).rejects.toThrow(/within the timestamp authorities' 5-minute retry deadline/);
    expect(existsSync(join(s.dir, MANIFEST))).toBe(false);
  });

  it("a single repo whose listing runs into R writes nothing (the end check)", async () => {
    const org = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 120, pushes: 25, after: 3 }] });
    let s!: Scenario;
    const slow = ((input: string | URL | Request, init?: RequestInit) => ((s.clock.now += 2 * 60_000), org.fetch(input, init))) as typeof fetch;
    s = setupAuditRepo({ changes: [], provider: "github", fetch: slow });
    s.clock.now = T("2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    s.clock.now = T("2026-10-20T23:50:00Z"); // R publishes at 2026-10-21T00:00Z; the listing takes longer than 10 minutes
    await expect(freezeCommand(s.ctx, {})).rejects.toThrow(/the freeze finished 2026-10-21T.*, after seed round \d+ published \(2026-10-21T00:00:00Z\).*Register a new audit/);
    expect(existsSync(join(s.dir, MANIFEST))).toBe(false);
    expect(existsSync(join(s.dir, CM))).toBe(false);
  });
});

describe("finding 11: the checkpoint store", () => {
  it("the run id covers the start time: an edited run.json is not resumed, and a re-run starts a new run", async () => {
    const org = org30();
    const s = await registered(org);
    org.control.stuck.add(`${ORG}/svc-29`);
    let runId = "";
    await s.clock.run(freezeCommand(s.ctx, {})).catch((e) => (runId = /--resume ([0-9a-f]{64})/.exec((e as Error).message)![1]!));
    org.control.stuck.clear();
    const header = join(s.dir, ".pr-rla/cache/2026-q3", runId, "run.json");
    const h = JSON.parse(readFileSync(header, "utf8")) as { startedAt: string };
    writeFileSync(header, JSON.stringify({ ...h, startedAt: "2026-10-20T15:00:00Z" }));
    await expect(s.clock.run(freezeCommand(s.ctx, { resume: runId }))).rejects.toThrow(/cannot resume: its header is damaged or was edited/);
    await s.advance(60_000);
    expect(await s.clock.run(freezeCommand(s.ctx, {}))).toBe(0);
    expect(readManifest(s).frozenAt).not.toBe("2026-10-20T15:00:00Z");
  });

  it("writes no completion marker (nothing read it) and a dry run that stops says nothing was checkpointed", async () => {
    const org = org30();
    const s = await frozen(org);
    for (const id of readdirSync(join(s.dir, ".pr-rla/cache/2026-q3"))) expect(existsSync(join(s.dir, ".pr-rla/cache/2026-q3", id, "complete"))).toBe(false);
    org.control.stuck.add(`${ORG}/svc-03`);
    await expect(s.clock.run(freezeCommand(s.ctx, { dryRun: true }))).rejects.toThrow(/Nothing was checkpointed \(a dry run writes nothing\); no manifest was written\. Run the same command again$/);
  });
});

describe("finding 12", () => {
  it("status before freeze lists nothing for a pool and says what N would cost", async () => {
    const org = org30();
    const s = await registered(org);
    const before = org.requests();
    s.out.length = 0;
    expect(await s.clock.run(statusCommand(s.ctx, {}))).toBe(0);
    expect(org.requests()).toBe(before);
    expect(s.out.join("\n")).toMatch(/N so far: not computed for a pool \(rule acme-org: .*\): it lists every repo, about as many requests as the freeze/);
  });

  it("a repo created after the window closed that imports window-dated history does not FAIL check 5 (the SCM's creation time)", async () => {
    const org = org30();
    const s = await frozen(org);
    org.addRepo({ name: "svc-imported", prs: 20, pushes: 4, createdAt: "2026-10-25T00:00:00Z" });
    const r = await verify(s);
    expect(check(r, 5).status).toBe("PASS");
    expect(lines(r, 5)).toContain("repo acme-org/svc-imported matches the registered rule but is not in the manifest; it was created 2026-10-25T00:00:00Z, after the window closed, so it cannot hold a window landing");
  });

  it("src/sdk is erasable TypeScript: pr-rla/http loads under Node's type stripping, as the plugin host runs it", () => {
    const file = join(__dirname, "..", "src", "sdk", "http.ts");
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", `await import(${JSON.stringify(file)}); console.log("loaded")`], { encoding: "utf8" });
    expect(out.trim()).toBe("loaded");
  });
});
