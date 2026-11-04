import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify, verifyCommand } from "../src/commands/verify.js";
import { configFor, ledgerFor } from "../src/commands/context.js";
import { PRESENCE_LABEL, PRESENCE_LIMIT } from "../src/core/presence/index.js";
import type { DrawsFile, RegistrationRecordV2, SignedRecord } from "../src/core/records.js";
import { verifyAudit } from "../src/core/verify.js";
import { ledgerTraits, maxProvenanceOf } from "../src/ledger-traits.js";
import { mergeTrust, SHIPPED_TRUST_BUNDLE } from "../src/timestamp/bundle.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { recordedBeacon } from "./helpers/fixtures.js";
import { commitAll } from "./helpers/signed-commits.js";
import { makeTestKey, type TestKey } from "./helpers/sshsig-signer.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * U9 end to end (FR3.8, FR9.1–FR9.6): a git-file audit whose registration lists the reviewers'
 * SSH keys, requires `presence` and signed verdict commits, and whose reviewer signs each verdict
 * commit through a software-emulated authenticator (test/helpers/sshsig-signer.ts; D7). Then the
 * same audit with one verdict made each wrong way, the registration refusals, the default git-file
 * provenance, the ceiling issue ledgers stay under, and the real `git commit -S` path with an
 * ssh-keygen software key.
 */
const W = "audit/2026-q3";
let tsa: MockTsaServer;
let base: Scenario;
let honest: Scenario;
let bob: TestKey;
let alice: TestKey;
let mallory: TestKey;
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const check = (r: Awaited<ReturnType<typeof runVerify>>, n: number) => r.checks.find((c) => c.n === n)!;
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};

type Signing = { sign: ((payload: string) => string) | null; reviewer: string; uncommitted?: boolean };
/** The reviewer's loop: `pr-rla record`, then a signed commit of the ledger file, one per drawn change. */
async function review(s: Scenario, how: (draw: number, i: number) => Signing): Promise<number[]> {
  at(s, "2026-10-21T03:00:00Z");
  const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
  const reviewed: number[] = [];
  let i = 0;
  for (const d of draws.draws.slice(0, 36)) {
    if (!d.firstOccurrence) continue;
    const h = how(d.draw, i++);
    await recordCommand(s.ctx, String(d.draw), "pass", { reviewer: h.reviewer });
    if (!h.uncommitted) commitAll(s.dir, `verdict: draw #${d.draw}`, h.sign, { unix: 1792551600 + i * 60 });
    reviewed.push(d.draw);
  }
  return reviewed;
}
const bobSigns = (counter: number, flags = 0x01): Signing => ({ reviewer: "bob", sign: (p) => bob.sign(p, { flags, counter }) });
/** A copy of the sampled audit, reviewed as `how` says. */
async function reviewed(how: (draw: number, i: number) => Signing): Promise<{ s: Scenario; draws: number[] }> {
  const s = cloneScenario(base);
  return { s, draws: await review(s, how) };
}

beforeAll(async () => {
  bob = makeTestKey("sk-ssh-ed25519@openssh.com");
  alice = makeTestKey("ssh-ed25519");
  mallory = makeTestKey("sk-ssh-ed25519@openssh.com");
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  base = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
  appendFileSync(
    join(base.dir, ".pr-rla.yml"),
    `ledger: { use: git-file, options: { require_signed: true } }\nverdicts: { min_provenance: presence, reviewers: ["${bob.allowedSigner("bob")}", "${alice.allowedSigner("alice")}"] }\n`,
  );
  base.git("commit", "-qam", "signed verdicts");
  at(base, "2026-10-20T00:00:00Z");
  expect(await registerCommand(base.ctx, {})).toBe(0);
  at(base, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(base.ctx, {})).toBe(0);
  at(base, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(base.ctx, {})).toBe(0);
  base.git("add", "-A");
  base.git("commit", "-qm", "registration, manifest, draws");
  honest = (await reviewed((_d, i) => bobSigns(i + 1))).s;
}, 120_000);
afterAll(async () => {
  await tsa.stop();
});

describe("a presence audit, end to end (git-file, require_signed, a software-emulated authenticator)", () => {
  it("register fixes the allowed signers, presence and require_signed, and prints the T16 limit", () => {
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(base, `${W}/registration.json`);
    expect(reg.record.verdicts).toEqual({ minProvenance: "presence", reviewers: [alice.allowedSigner("alice"), bob.allowedSigner("bob")].sort(), require_signed: true });
    const out = base.out.join("\n");
    expect(out).toMatch(new RegExp(`ledger git-file · verdict provenance presence \\(user-presence flag verified; key hardware not attested\\) · signed verdict commits required \\(require_signed\\) · reviewers alice \\(ssh-ed25519 SHA256:\\S+\\), bob \\(sk-ssh-ed25519@openssh.com SHA256:\\S+\\)`));
    expect(out).toContain(PRESENCE_LIMIT);
  });

  it("record tells a git-file reviewer to sign the commit with the registered key", () => {
    expect(honest.out.join("\n")).toMatch(/sign that commit with your registered key \(git commit -S, with gpg.format=ssh and user.signingkey set\)/);
  });

  it("status: CERTIFIED, every counted verdict presence, printed with its limit (FR3.8, FR9.6)", async () => {
    const s = cloneScenario(honest);
    expect(await statusCommand(s.ctx, {})).toBe(0);
    const out = s.out.join("\n");
    expect(out).toMatch(/prefix 36\/36 · fails 0 .* CERTIFIED \(risk 5%\)/);
    expect(out).toMatch(/VERDICT PROVENANCE: presence \(user-presence flag verified; key hardware not attested\) \(\d+\) · registered minimum presence \(user-presence flag verified; key hardware not attested\) · signed verdict commits required \(require_signed\)/);
    expect(out).toContain(PRESENCE_LIMIT);
    expect(out).not.toMatch(/will FAIL/);
  });

  it("the demo: verify 7/7, check 7 counts presence verdicts and says the key hardware is not attested", async () => {
    const s = cloneScenario(honest);
    const r = await runVerify(s.ctx, {});
    expect(r.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:PASS", "6:PASS", "7:PASS"]);
    const c7 = check(r, 7).details.join("\n");
    expect(c7).toMatch(new RegExp(`VERDICT PROVENANCE: presence \\(user-presence flag verified; key hardware not attested\\) \\(\\d+\\) \\(registered minimum: presence \\(user-presence flag verified; key hardware not attested\\) · signed verdict commits required \\(require_signed\\)\\)`));
    expect(c7).toContain(PRESENCE_LIMIT);
    expect(check(r, 1).details.join("\n")).toMatch(/ledger git-file · verdict provenance presence \(user-presence flag verified; key hardware not attested\) · signed verdict commits required/);
    expect(r.status!.provenance).toEqual([{ level: "presence", count: r.status!.distinctReviewed }]);
    expect(await verifyCommand(s.ctx, {})).toBe(0);
    expect(s.out.join("\n")).toMatch(/VERIFIED$/);
  });
});

describe("each way a verdict can fall short (FR9.1, FR9.3, FR9.4, FR9.5)", () => {
  it("FR9.5: a verdict whose security-key signature has UP clear fails at presence; it counts as account", async () => {
    const { s, draws } = await reviewed((_d, i) => bobSigns(i + 1, i === 4 ? 0x00 : 0x01));
    const r = await runVerify(s.ctx, {});
    const c7 = check(r, 7);
    expect(c7.status).toBe("FAIL");
    expect(c7.details).toContain(`verdict on draw #${draws[4]} (${r.status!.firstVerdicts.find((v) => v.draw === draws[4])!.changeId}) is account; the registration requires presence`);
    expect(c7.details.join("\n")).toMatch(/without the user-presence flag \(no touch\): account, not presence/);
    expect(c7.details.join("\n")).toMatch(/VERDICT PROVENANCE: account \(1\) · presence/);
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out.join("\n")).toMatch(new RegExp(`1 counted verdict\\(s\\) are below the registered presence provenance; verify check 7 will FAIL them \\(draws #${draws[4]}\\)`));
    expect(await verifyCommand(s.ctx, {})).toBe(1);
  });

  it("FR9.3: a verdict signed by an unlisted key fails, and the key is named", async () => {
    const { s, draws } = await reviewed((_d, i) => (i === 2 ? { reviewer: "bob", sign: (p) => mallory.sign(p, { counter: 100 }) } : bobSigns(i + 1)));
    const c7 = check(await runVerify(s.ctx, {}), 7);
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${draws[2]} \\(\\S+\\) is self-asserted; the registration requires presence`));
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${draws[2]} \\(\\S+\\) was added in commit [0-9a-f]{10}, which its registered reviewer did not sign; the registration requires signed verdict commits \\(require_signed\\)`));
    expect(c7.details.join("\n")).toMatch(/signed by key SHA256:\S+ \(sk-ssh-ed25519@openssh.com\), which no registered reviewer holds: self-asserted/);
  });

  it("FR9.1: an unsigned verdict commit fails under require_signed", async () => {
    const { s, draws } = await reviewed((_d, i) => (i === 7 ? { reviewer: "bob", sign: null } : bobSigns(i + 1)));
    const c7 = check(await runVerify(s.ctx, {}), 7);
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${draws[7]} \\(\\S+\\) was added in commit [0-9a-f]{10}, which its registered reviewer did not sign; the registration requires signed verdict commits \\(require_signed\\)`));
    expect(c7.details.join("\n")).toMatch(new RegExp(`commit [0-9a-f]{10} \\(draw #${draws[7]}\\): not signed: self-asserted`));
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out.join("\n")).toMatch(new RegExp(`1 counted verdict\\(s\\) are not in commits signed by the registered reviewer they name; verify check 7 will FAIL them under require_signed \\(draws #${draws[7]}\\)`));
  });

  it("a verdict recorded but never committed fails under require_signed", async () => {
    const reviewedDraws = readJ<DrawsFile>(base, `${W}/draws.json`).draws.slice(0, 36).filter((d) => d.firstOccurrence);
    const lastDraw = reviewedDraws.at(-1)!.draw;
    const { s } = await reviewed((d, i) => ({ ...bobSigns(i + 1), uncommitted: d === lastDraw }));
    const c7 = check(await runVerify(s.ctx, {}), 7);
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join("\n")).toMatch(/1 verdict line\(s\) not yet committed/);
    expect(c7.details).toContainEqual(expect.stringMatching(new RegExp(`^verdict on draw #${lastDraw} \\(\\S+\\) is not committed; the registration requires signed verdict commits \\(require_signed\\)$`)));
  });

  it("a reviewer/principal mismatch is reported, and the verdict is self-asserted", async () => {
    const { s, draws } = await reviewed((_d, i) => (i === 3 ? { reviewer: "alice", sign: (p) => bob.sign(p, { counter: 500 }) } : bobSigns(i + 1)));
    const c7 = check(await runVerify(s.ctx, {}), 7);
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${draws[3]} names reviewer alice but commit [0-9a-f]{10} was signed by bob: self-asserted`));
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${draws[3]} \\(\\S+\\) is self-asserted; the registration requires presence`));
  });

  it("a decreasing counter is a WARN, never a FAIL", async () => {
    const { s } = await reviewed((_d, i) => bobSigns(i === 10 ? 3 : 100 + i));
    const r = await runVerify(s.ctx, {});
    expect(check(r, 7).status).toBe("WARN");
    expect(check(r, 7).details.join("\n")).toMatch(/security key SHA256:\S+ \(bob\): its signature counter went down from 109 \(commit [0-9a-f]{10}\) to 3 \(commit [0-9a-f]{10}\); authenticators differ in counter behaviour, so this is a warning, not a failure/);
    expect(r.ok).toBe(true);
  });

  it("a line that claims presence for itself is self-asserted", async () => {
    const s = cloneScenario(honest);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
    const forged = { changeId: "json:acme/widgets#forged", draw: 1, protocolSha256: reg.record.protocolSha256, recordedAt: "2026-10-21T04:00:00Z", reviewer: "bob", verdict: "pass", provenance: { level: "presence", source: "git-signed-commit", signer: "bob" } };
    appendFileSync(join(s.dir, W, "verdicts.jsonl"), `${JSON.stringify(forged)}\n`);
    commitAll(s.dir, "a forged line", null);
    const { config, paths } = configFor(s.ctx);
    const read = await (await ledgerFor(s.ctx, config, paths)).readVerdicts();
    expect(read.find((v) => v.changeId === forged.changeId)!.provenance).toMatchObject({ level: "self-asserted", source: "git-commit" });
    // The honest lines before it keep their signatures.
    expect(read.filter((v) => v.provenance?.level === "presence")).toHaveLength(read.length - 1);
  });
});

describe("register refuses rules no verdict could meet", () => {
  const fresh = (yaml: string) => {
    const s = setupAuditRepo({ changes: makeChanges(200) });
    appendFileSync(join(s.dir, ".pr-rla.yml"), yaml);
    s.clock.now = T("2026-06-20T00:00:00Z");
    return s;
  };

  it("presence with only software keys", async () => {
    const s = fresh(`verdicts: { min_provenance: presence, reviewers: ["${alice.allowedSigner("alice")}"] }\n`);
    await expect(registerCommand(s.ctx, { dryRun: true })).rejects.toThrow(/verdicts.min_provenance is presence, but no key in verdicts.reviewers is a FIDO security key/);
  });

  it("require_signed without keys", async () => {
    const s = fresh("ledger: { use: git-file, options: { require_signed: true } }\nverdicts: { reviewers: [alice] }\n");
    await expect(registerCommand(s.ctx, { dryRun: true })).rejects.toThrow(/ledger git-file: require_signed needs the reviewers' SSH keys in verdicts.reviewers/);
  });

  it("issue ledgers top out at account: presence, or SSH keys, with github-issues", async () => {
    await expect(registerCommand(fresh("ledger: { use: github-issues, options: { repo: acme/audit } }\nverdicts: { min_provenance: presence }\n").ctx, { dryRun: true })).rejects.toThrow(
      /verdicts.min_provenance is presence, but ledger github-issues records account verdicts, so no verdict could count; presence needs the git-file ledger/,
    );
    await expect(registerCommand(fresh(`ledger: { use: github-issues, options: { repo: acme/audit } }\nverdicts: { reviewers: ["${bob.allowedSigner("bob")}"] }\n`).ctx, { dryRun: true })).rejects.toThrow(
      /verdicts.reviewers lists SSH keys \(bob \(sk-ssh-ed25519@openssh.com SHA256:\S+\)\), but ledger github-issues reads accounts, not signed commits/,
    );
  });

  it("a malformed key line is refused when the configuration is read", async () => {
    const s = fresh('verdicts: { reviewers: ["bob sk-ssh-ed25519@openssh.com AAAA!!"] }\n');
    await expect(registerCommand(s.ctx, { dryRun: true })).rejects.toThrow(/verdicts.reviewers: allowed-signers entry for bob: the sk-ssh-ed25519@openssh.com key is not base64/);
  });

  it("account with registered software keys and require_signed, and the dry run says so", async () => {
    const s = fresh(`ledger: { use: git-file, options: { require_signed: true } }\nverdicts: { min_provenance: account, reviewers: ["${alice.allowedSigner("alice")}"] }\n`);
    expect(await registerCommand(s.ctx, { dryRun: true })).toBe(0);
    expect(s.out.join("\n")).toMatch(/ledger git-file · verdict provenance account · signed verdict commits required \(require_signed\) · reviewers alice \(ssh-ed25519 SHA256:\S+\)/);
    expect(s.out.join("\n")).not.toContain(PRESENCE_LIMIT);
  });
});

describe("FR3.8: the default provenance with git-file, and the ceilings", () => {
  it("a git-file audit with no keys prints VERDICT PROVENANCE: self-asserted, the registered default", async () => {
    const s = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`).record.verdicts).toEqual({ minProvenance: "self-asserted", reviewers: null });
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    at(s, "2026-10-21T01:00:00Z");
    await sampleCommand(s.ctx, {});
    s.git("add", "-A");
    s.git("commit", "-qm", "audit");
    await review(s, () => ({ reviewer: "outside-reviewer", sign: null }));
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out.join("\n")).toMatch(/VERDICT PROVENANCE: self-asserted \(\d+\) · registered minimum self-asserted/);
    const r = await runVerify(s.ctx, {});
    expect(check(r, 7)).toMatchObject({ status: "PASS" });
    expect(check(r, 7).details.join("\n")).toMatch(/VERDICT PROVENANCE: self-asserted \(\d+\) \(registered minimum: self-asserted\)/);
    expect(check(r, 7).details.join("\n")).not.toContain(PRESENCE_LABEL);
  });

  it("issue ledgers top out at account; git-file reaches presence; an external ledger never above account", async () => {
    expect((await ledgerTraits({ use: "github-issues", options: { repo: "acme/audit" } }, base.dir)).maxProvenance).toBe("account");
    expect((await ledgerTraits({ use: "gitlab-issues", options: { project: "acme/audit" } }, base.dir)).maxProvenance).toBe("account");
    expect((await ledgerTraits({ use: "git-file", options: {} }, base.dir)).maxProvenance).toBe("presence");
    expect(maxProvenanceOf(false, "tracker", "presence")).toBe("account");
    expect(maxProvenanceOf(false, "tracker", "self-asserted")).toBe("self-asserted");
  });

  it("check 7 counts a ledger's claim above its ceiling at the ceiling, and WARNs", async () => {
    const s = cloneScenario(honest);
    const reg = readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
    const claims = draws.draws.slice(0, 36).filter((d) => d.firstOccurrence).map((d) => ({ draw: d.draw, changeId: d.changeId, verdict: "pass" as const, protocolSha256: reg.record.protocolSha256, reviewer: "bob", recordedAt: "2026-10-21T03:00:00Z", provenance: { level: "presence" as const, source: "scm-label-event" } }));
    const tracker = { apiVersion: 1, name: "tracker", readVerdicts: async () => claims, appendVerdict: async () => {}, verifyIntegrity: async () => ({ ok: true, tamperTrail: true, findings: [] }) };
    const r = await verifyAudit(
      { registration: reg, manifest: readJ(s, `${W}.manifest.json`), commitment: readJ(s, `${W}/manifest-commitment.json`), draws, currentProtocolSha256: reg.record.protocolSha256 },
      { provider: null, ledger: tracker, beacon: async (round) => recordedBeacon(round), logKey: async () => null, trustBundle: mergeTrust(SHIPPED_TRUST_BUNDLE, s.tsaTrust), provenanceCeiling: "account" },
    );
    const c7 = check(r, 7);
    expect(c7.details).toContain(`ledger tracker reported presence for the verdict on draw #${claims[0]!.draw}, more than it can attest; counted as account`);
    expect(c7.details.join("\n")).toMatch(/is account; the registration requires presence/);
    expect(c7.status).toBe("FAIL");
    expect(r.status!.provenance).toEqual([{ level: "account", count: r.status!.distinctReviewed }]);
  });
});

const hasSshKeygen = spawnSync("ssh-keygen", ["-?"], { encoding: "utf8" }).error === undefined;
describe.skipIf(!hasSshKeygen)("the real path: git commit -S with an ssh-keygen software key (FR9.1)", () => {
  it("a software ed25519 key gives account; verify 7/7 under min account and require_signed", async () => {
    const keys = mkdtempSync(join(tmpdir(), "prrla-keys-"));
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "carol", "-f", join(keys, "carol")], { stdio: "ignore", env: { ...process.env, HOME: keys } });
    const pub = readFileSync(join(keys, "carol.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
    const s = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
    appendFileSync(join(s.dir, ".pr-rla.yml"), `ledger: { use: git-file, options: { require_signed: true } }\nverdicts: { min_provenance: account, reviewers: ["carol ${pub}"] }\n`);
    s.git("commit", "-qam", "signed verdicts");
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    at(s, "2026-10-21T01:00:00Z");
    await sampleCommand(s.ctx, {});
    s.git("add", "-A");
    s.git("commit", "-qm", "audit");
    at(s, "2026-10-21T03:00:00Z");
    // The reviewer's own git, isolated from this machine's configuration: gpg.format=ssh and git commit -S.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: keys };
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
    for (const d of draws.draws.slice(0, 36).filter((x) => x.firstOccurrence)) {
      await recordCommand(s.ctx, String(d.draw), "pass", { reviewer: "carol" });
      execFileSync("git", ["add", "-A"], { cwd: s.dir, env, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=carol", "-c", "user.email=user-c4a1b2c3@example.invalid", "-c", "gpg.format=ssh", "-c", `user.signingkey=${join(keys, "carol")}`, "commit", "-S", "-qm", `verdict: draw #${d.draw}`], { cwd: s.dir, env, stdio: "ignore" });
    }
    const r = await runVerify(s.ctx, {});
    expect(r.checks.map((c) => c.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    expect(check(r, 7).details.join("\n")).toMatch(/VERDICT PROVENANCE: account \(\d+\) \(registered minimum: account · signed verdict commits required \(require_signed\)\)/);
    expect(r.status!.firstVerdicts.every((v) => v.provenance?.source === "git-signed-commit" && v.provenance.signer === "carol")).toBe(true);
  });
});
