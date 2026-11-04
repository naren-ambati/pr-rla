import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import { NAMESPACE, signedLine } from "./helpers/verdict-lines.js";
import { claimsIn, jsonSentences, unlabelledPresence } from "./helpers/wording.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";

/**
 * U9 end to end (FR3.8, FR9.1–FR9.6), as changed after review: a git-file audit whose registration
 * lists the reviewers' SSH keys in verdicts.allowed_signers, requires `presence` and signed verdicts,
 * and whose reviewer signs each verdict with `pr-rla record --sign` (one signature per verdict; the
 * test's software-emulated authenticator stands in for ssh-keygen, D7). Then each way a verdict can
 * fall short, the registration refusals and warnings, the default git-file provenance, the ceilings,
 * and the real paths: `record --sign` through ssh-keygen, and the README's manual recipe.
 */
const W = "audit/2026-q3";
const UP = PRESENCE_LABEL.replace(/[()]/g, "\\$&");
let tsa: MockTsaServer;
let base: Scenario;
let honest: Scenario;
let keysDir: string;
const keys: Record<string, TestKey> = {};
const keyPath = (name: string) => join(keysDir, name);
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const check = (r: Awaited<ReturnType<typeof runVerify>>, n: number) => r.checks.find((c) => c.n === n)!;
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};

type How = { key?: string; flags?: number; counter?: number; reviewer?: string; uncommitted?: boolean };
/** The emulated authenticator ssh-keygen would drive: it signs with the key the path names, with the flags and counter the test chose. */
function authenticator(s: Scenario, current: () => How) {
  s.ctx.signVerdict = async (payload, path) => keys[basename(path)]!.sign(payload, { namespace: NAMESPACE, flags: current().flags ?? 0x01, counter: current().counter ?? 1 });
}
/** The reviewer's loop: `pr-rla record --sign`, then a plain commit of the ledger file, one per drawn change. */
async function review(s: Scenario, how: (draw: number, i: number) => How): Promise<number[]> {
  at(s, "2026-10-21T03:00:00Z");
  let current: How = {};
  authenticator(s, () => current);
  const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
  const reviewed: number[] = [];
  let i = 0;
  for (const d of draws.draws.slice(0, 36)) {
    if (!d.firstOccurrence) continue;
    current = how(d.draw, i++);
    await recordCommand(s.ctx, String(d.draw), "pass", { ...(current.key ? { sign: keyPath(current.key) } : {}), ...(current.reviewer ? { reviewer: current.reviewer } : {}) });
    if (!current.uncommitted) commitAll(s.dir, `verdict: draw #${d.draw}`, null, { unix: 1792551600 + i * 60 });
    reviewed.push(d.draw);
  }
  return reviewed;
}
const bobSigns = (counter: number, flags = 0x01): How => ({ key: "bob", flags, counter });
/** A copy of the sampled audit, reviewed as `how` says. */
async function reviewed(how: (draw: number, i: number) => How): Promise<{ s: Scenario; draws: number[] }> {
  const s = cloneScenario(base);
  return { s, draws: await review(s, how) };
}
const regOf = (s: Scenario) => readJ<SignedRecord<RegistrationRecordV2>>(s, `${W}/registration.json`);

beforeAll(async () => {
  keysDir = mkdtempSync(join(tmpdir(), "prrla-pubkeys-"));
  for (const [name, type] of [["bob", "sk-ssh-ed25519@openssh.com"], ["alice", "ssh-ed25519"], ["mallory", "sk-ssh-ed25519@openssh.com"]] as const) {
    keys[name] = makeTestKey(type);
    writeFileSync(join(keysDir, `${name}.pub`), `${keys[name].publicText} ${name}\n`); // public halves only: the private keys live in the test's memory
  }
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  base = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
  appendFileSync(
    join(base.dir, ".pr-rla.yml"),
    `ledger: { use: git-file, options: { require_signed: true } }\nverdicts: { min_provenance: presence, allowed_signers: ["${keys.bob!.allowedSigner("bob", `namespaces="${NAMESPACE}"`).replace(/"/g, '\\"')}", "${keys.alice!.allowedSigner("alice")}"] }\n`,
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

describe("a presence audit, end to end (git-file, require_signed, one signature per verdict)", () => {
  it("register fixes the allowed signers, presence and require_signed, and prints the keys and the T16 limit", () => {
    const reg = regOf(base);
    expect(reg.record.verdicts).toEqual({ minProvenance: "presence", reviewers: null, require_signed: true, allowed_signers: [keys.alice!.allowedSigner("alice"), keys.bob!.allowedSigner("bob", `namespaces="${NAMESPACE}"`)] });
    const out = base.out.join("\n");
    expect(out).toMatch(new RegExp(`ledger git-file · verdict provenance ${UP} · signed verdicts required \\(require_signed\\) · keys alice \\(ssh-ed25519 SHA256:\\S+\\), bob \\(sk-ssh-ed25519@openssh.com SHA256:\\S+\\)`));
    expect(out).toContain(PRESENCE_LIMIT);
    expect(out).not.toMatch(/warning: verdicts/);
  });

  it("record --sign signs the one verdict: the touch notice, then the level its signature gives", () => {
    const out = honest.out.join("\n");
    expect(out).toMatch(/ERR touch your security key to sign this one verdict \(SHA256:\S+\)/);
    expect(out).toMatch(new RegExp(`signed: the verdict is signed by bob's sk-ssh-ed25519@openssh.com key SHA256:\\S+ with the user-presence flag: ${UP}`));
    const line = readFileSync(join(honest.dir, W, "verdicts.jsonl"), "utf8").split("\n")[0]!;
    expect(JSON.parse(line)).toMatchObject({ reviewer: "bob", registrationSha256: regOf(honest).sha256, sshsig: expect.stringMatching(/^U1NIU0lH/) });
  });

  it("status: CERTIFIED, every counted verdict presence, printed with its limit (FR3.8, FR9.6)", async () => {
    const s = cloneScenario(honest);
    expect(await statusCommand(s.ctx, {})).toBe(0);
    const out = s.out.join("\n");
    expect(out).toMatch(/prefix 36\/36 · fails 0 .* CERTIFIED \(risk 5%\)/);
    expect(out).toMatch(new RegExp(`VERDICT PROVENANCE: ${UP} \\(\\d+\\) · registered minimum ${UP} · signed verdicts required \\(require_signed\\)`));
    expect(out).toContain(PRESENCE_LIMIT);
    expect(out).not.toMatch(/will FAIL/);
  });

  it("the demo: verify 7/7, check 7 counts presence verdicts and says the key hardware is not attested", async () => {
    const s = cloneScenario(honest);
    const r = await runVerify(s.ctx, {});
    expect(r.checks.map((c) => `${c.n}:${c.status}`)).toEqual(["1:PASS", "2:PASS", "3:PASS", "4:PASS", "5:PASS", "6:PASS", "7:PASS"]);
    const c7 = check(r, 7).details.join("\n");
    expect(c7).toMatch(new RegExp(`VERDICT PROVENANCE: ${UP} \\(\\d+\\) \\(registered minimum: ${UP} · signed verdicts required \\(require_signed\\)\\)`));
    expect(c7).toContain(PRESENCE_LIMIT);
    expect(check(r, 1).details.join("\n")).toMatch(new RegExp(`ledger git-file · verdict provenance ${UP} · signed verdicts required`));
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
    expect(c7.details).toContain(`verdict on draw #${draws[4]} (${r.status!.firstVerdicts.find((v) => v.draw === draws[4])!.changeId}) is account; the registration requires ${PRESENCE_LABEL}`);
    expect(c7.details.join("\n")).toMatch(/without the user-presence flag \(no touch\): account$/m);
    expect(c7.details.join("\n")).toMatch(/VERDICT PROVENANCE: account \(1\) · presence/);
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out.join("\n")).toMatch(new RegExp(`1 counted verdict\\(s\\) are below the registered ${UP} provenance; verify check 7 will FAIL them \\(draws #${draws[4]}\\)`));
    expect(await verifyCommand(s.ctx, {})).toBe(1);
  });

  it("FR9.3: record --sign refuses a key nobody registered; a line signed by it by hand fails, and the key is named", async () => {
    const s = cloneScenario(base);
    authenticator(s, () => ({}));
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`).draws.filter((d) => d.firstOccurrence);
    await expect(recordCommand(s.ctx, String(draws[0]!.draw), "pass", { sign: keyPath("mallory") })).rejects.toThrow(/--sign \S+mallory: key SHA256:\S+ \(sk-ssh-ed25519@openssh.com\) is not among this registration's allowed signers/);
    const { s: t, draws: reviewedDraws } = await reviewed((_d, i) => (i === 2 ? { reviewer: "bob" } : bobSigns(i + 1)));
    // Draw #3's line, replaced by one signed with mallory's key (an unsigned line was recorded; rewrite it before committing anything else would show in the walk, so append to a fresh copy).
    const victim = readJ<DrawsFile>(t, `${W}/draws.json`).draws.find((d) => d.draw === reviewedDraws[2])!;
    const lines = readFileSync(join(t.dir, W, "verdicts.jsonl"), "utf8").split("\n").filter(Boolean);
    const forged = signedLine(regOf(t).sha256, { draw: victim.draw, changeId: victim.changeId, verdict: "pass", protocolSha256: regOf(t).record.protocolSha256, reviewer: "bob", recordedAt: "2026-10-21T03:00:00Z" }, keys.mallory!);
    const u = cloneScenario(base);
    writeFileSync(join(u.dir, W, "verdicts.jsonl"), lines.map((l) => (JSON.parse(l).draw === victim.draw ? forged.trim() : l)).join("\n") + "\n");
    commitAll(u.dir, "verdicts", null);
    const c7 = check(await runVerify(u.ctx, {}), 7);
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${victim.draw} \\(\\S+\\) is self-asserted; the registration requires ${UP}`));
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${victim.draw} \\(\\S+\\) carries no valid signature by the registered key of reviewer bob; the registration requires signed verdicts \\(require_signed\\)`));
    expect(c7.details.join("\n")).toMatch(/is signed by key SHA256:\S+ \(sk-ssh-ed25519@openssh.com\), which no registered reviewer holds: self-asserted/);
  });

  it("FR9.1: an unsigned verdict fails under require_signed, and record says how to sign it", async () => {
    const { s, draws } = await reviewed((_d, i) => (i === 7 ? { reviewer: "bob" } : bobSigns(i + 1)));
    expect(s.out.join("\n")).toMatch(/this verdict is not signed, so it counts as self-asserted: record it with --sign <your registered key> \(pr-rla runs ssh-keygen -Y sign -n pr-rla-verdict@v1\)/);
    const c7 = check(await runVerify(s.ctx, {}), 7);
    expect(c7.status).toBe("FAIL");
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${draws[7]} \\(\\S+\\) carries no valid signature by the registered key of reviewer bob; the registration requires signed verdicts \\(require_signed\\)`));
    expect(c7.details).toContain(`1 verdict line(s) carry no signature (draws #${draws[7]}): self-asserted`);
    s.out.length = 0;
    await statusCommand(s.ctx, {});
    expect(s.out.join("\n")).toMatch(new RegExp(`1 counted verdict\\(s\\) carry no valid signature by the registered key of the reviewer they name; verify check 7 will FAIL them under require_signed \\(draws #${draws[7]}\\)`));
  });

  it("a signed verdict not committed yet still counts at its level; the walk notes it has no tamper trail yet", async () => {
    const reviewedDraws = readJ<DrawsFile>(base, `${W}/draws.json`).draws.slice(0, 36).filter((d) => d.firstOccurrence);
    const lastDraw = reviewedDraws.at(-1)!.draw;
    const { s } = await reviewed((d, i) => ({ ...bobSigns(i + 1), uncommitted: d === lastDraw }));
    const c7 = check(await runVerify(s.ctx, {}), 7);
    expect(c7.status).toBe("PASS");
    expect(c7.details).toContain("1 verdict line(s) not yet committed (no tamper trail for them until committed)");
  });

  it("record refuses --reviewer naming someone else than the key's principal; a hand-written mismatch is self-asserted and reported", async () => {
    const s = cloneScenario(base);
    authenticator(s, () => ({}));
    const d = readJ<DrawsFile>(s, `${W}/draws.json`).draws.find((x) => x.firstOccurrence)!;
    await expect(recordCommand(s.ctx, String(d.draw), "pass", { sign: keyPath("bob"), reviewer: "alice" })).rejects.toThrow(/--reviewer alice, but key SHA256:\S+ is registered to bob/);
    const line = signedLine(regOf(s).sha256, { draw: d.draw, changeId: d.changeId, verdict: "pass", protocolSha256: regOf(s).record.protocolSha256, reviewer: "alice", recordedAt: "2026-10-21T03:00:00Z" }, keys.bob!);
    writeFileSync(join(s.dir, W, "verdicts.jsonl"), line);
    commitAll(s.dir, "verdict", null);
    const c7 = check(await runVerify(s.ctx, {}), 7);
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${d.draw} \\(\\S+\\) names reviewer alice but is signed by bob's key SHA256:\\S+: self-asserted`));
    expect(c7.details.join("\n")).toMatch(new RegExp(`verdict on draw #${d.draw} \\(\\S+\\) is self-asserted; the registration requires ${UP}`));
  });

  it("a decreasing counter is a WARN, never a FAIL", async () => {
    const { s } = await reviewed((_d, i) => bobSigns(i === 10 ? 3 : 100 + i));
    const r = await runVerify(s.ctx, {});
    expect(check(r, 7).status).toBe("WARN");
    expect(check(r, 7).details.join("\n")).toMatch(/security key SHA256:\S+ \(bob\): its signature counter went down from 109 \(draw #\d+\) to 3 \(draw #\d+\); authenticators differ in counter behaviour, so this is a warning, not a failure/);
    expect(r.ok).toBe(true);
  });

  it("a line that claims presence for itself is self-asserted; the signed lines before it keep their level", async () => {
    const s = cloneScenario(honest);
    const forged = { changeId: "json:acme/widgets#forged", draw: 1, protocolSha256: regOf(s).record.protocolSha256, recordedAt: "2026-10-21T04:00:00Z", reviewer: "bob", verdict: "pass", provenance: { level: "presence", source: "verdict-signature", signer: "bob" } };
    appendFileSync(join(s.dir, W, "verdicts.jsonl"), `${JSON.stringify(forged)}\n`);
    commitAll(s.dir, "a forged line", null);
    const r = await runVerify(s.ctx, {});
    expect(r.status!.firstVerdicts.find((v) => v.changeId === forged.changeId)?.provenance).toBeUndefined();
    const { config, paths } = configFor(s.ctx);
    expect((await (await ledgerFor(s.ctx, config, paths)).readVerdicts()).find((v) => v.changeId === forged.changeId)!.provenance).toBeUndefined();
  });
});

describe("finding 9: every printed level is labelled, and no output claims hardware-verified presence (text and --json)", () => {
  it("register, record, status and verify, passing and failing, in text and in --json", async () => {
    const texts: string[] = [base.out.join("\n"), honest.out.join("\n")];
    const jsons: unknown[] = [];
    const { s: upClear } = await reviewed((_d, i) => bobSigns(i + 1, i === 4 ? 0x00 : 0x01));
    const { s: unsigned } = await reviewed((_d, i) => (i === 7 ? { reviewer: "bob" } : bobSigns(i + 1)));
    for (const src of [honest, upClear, unsigned]) {
      const s = cloneScenario(src);
      await statusCommand(s.ctx, {});
      await verifyCommand(s.ctx, {});
      texts.push(src.out.join("\n"), s.out.join("\n"));
      s.out.length = 0;
      await statusCommand(s.ctx, { json: true });
      jsons.push(JSON.parse(s.out.join("\n")));
      s.out.length = 0;
      await verifyCommand(s.ctx, { json: true });
      jsons.push(JSON.parse(s.out.join("\n")));
    }
    // The refusals' messages.
    for (const yaml of [`verdicts: { min_provenance: presence, allowed_signers: ["${keys.alice!.allowedSigner("alice")}"] }\n`, "ledger: { use: github-issues, options: { repo: acme/audit } }\nverdicts: { min_provenance: presence }\n"]) {
      const s = setupAuditRepo({ changes: makeChanges(200) });
      appendFileSync(join(s.dir, ".pr-rla.yml"), yaml);
      texts.push(await registerCommand(s.ctx, { dryRun: true }).then(() => "", (e: Error) => e.message));
    }
    const all = texts.join("\n");
    expect(all).toContain(PRESENCE_LABEL);
    expect(unlabelledPresence(all)).toEqual([]);
    expect(claimsIn(all)).toEqual([]);
    const sentences = jsons.flatMap(jsonSentences);
    expect(sentences.some((x) => x.includes(PRESENCE_LABEL))).toBe(true);
    expect(unlabelledPresence(sentences.join("\n"))).toEqual([]);
    expect(claimsIn(sentences.join("\n"))).toEqual([]);
  });
});

describe("register refuses rules no verdict could meet, and warns about rules that enforce nothing", () => {
  const fresh = (yaml: string) => {
    const s = setupAuditRepo({ changes: makeChanges(200) });
    appendFileSync(join(s.dir, ".pr-rla.yml"), yaml);
    s.clock.now = T("2026-06-20T00:00:00Z");
    return s;
  };

  it("presence with only software keys", async () => {
    const s = fresh(`verdicts: { min_provenance: presence, allowed_signers: ["${keys.alice!.allowedSigner("alice")}"] }\n`);
    await expect(registerCommand(s.ctx, { dryRun: true })).rejects.toThrow(/no key in verdicts.allowed_signers is a FIDO security key/);
  });

  it("require_signed without keys", async () => {
    const s = fresh("ledger: { use: git-file, options: { require_signed: true } }\nverdicts: { reviewers: [alice] }\n");
    await expect(registerCommand(s.ctx, { dryRun: true })).rejects.toThrow(/ledger git-file: require_signed needs the reviewers' SSH keys in verdicts.allowed_signers/);
  });

  it("issue ledgers top out at account: presence, SSH keys, or require_signed with github-issues", async () => {
    await expect(registerCommand(fresh("ledger: { use: github-issues, options: { repo: acme/audit } }\nverdicts: { min_provenance: presence }\n").ctx, { dryRun: true })).rejects.toThrow(/but ledger github-issues records account verdicts, so no verdict could count; it needs the git-file ledger/);
    await expect(registerCommand(fresh(`ledger: { use: github-issues, options: { repo: acme/audit } }\nverdicts: { allowed_signers: ["${keys.bob!.allowedSigner("bob")}"] }\n`).ctx, { dryRun: true })).rejects.toThrow(
      /verdicts.allowed_signers lists SSH keys \(bob \(sk-ssh-ed25519@openssh.com SHA256:\S+\)\), but ledger github-issues reads accounts, not signed verdicts/,
    );
  });

  it("malformed keys, principals equal ignoring case, and one key twice are refused when the configuration is read", async () => {
    await expect(registerCommand(fresh('verdicts: { allowed_signers: ["bob sk-ssh-ed25519@openssh.com AAAA!!"] }\n').ctx, { dryRun: true })).rejects.toThrow(/verdicts.allowed_signers: allowed-signers entry for bob: the sk-ssh-ed25519@openssh.com key is not base64/);
    await expect(registerCommand(fresh(`verdicts: { allowed_signers: ["${keys.bob!.allowedSigner("Bob")}", "${keys.alice!.allowedSigner("bob")}"] }\n`).ctx, { dryRun: true })).rejects.toThrow(/allowed signers "Bob" and "bob" are the same principal ignoring case/);
    await expect(registerCommand(fresh(`verdicts: { allowed_signers: ["${keys.bob!.allowedSigner("bob")}", "${keys.bob!.allowedSigner("robert")}"] }\n`).ctx, { dryRun: true })).rejects.toThrow(/allowed signers bob and robert hold the same key/);
  });

  it("account with registered software keys read from an allowed_signers file, and the dry run says so", async () => {
    const s = fresh("ledger: { use: git-file, options: { require_signed: true } }\nverdicts: { min_provenance: account, allowed_signers: keys/allowed_signers }\n");
    execFileSync("mkdir", ["-p", join(s.dir, "keys")]);
    writeFileSync(join(s.dir, "keys/allowed_signers"), `# the audit's reviewers\n${keys.alice!.allowedSigner("alice")} alice@laptop\n\n`);
    expect(await registerCommand(s.ctx, { dryRun: true })).toBe(0);
    expect(s.out.join("\n")).toMatch(/ledger git-file · verdict provenance account · signed verdicts required \(require_signed\) · keys alice \(ssh-ed25519 SHA256:\S+\)/);
    expect(s.out.join("\n")).not.toContain(PRESENCE_LIMIT);
  });

  it("finding 12: keys with neither require_signed nor a minimum above self-asserted are a warning", async () => {
    const s = fresh(`verdicts: { allowed_signers: ["${keys.alice!.allowedSigner("alice")}"] }\n`);
    expect(await registerCommand(s.ctx, { dryRun: true })).toBe(0);
    expect(s.out.join("\n")).toMatch(/warning: verdicts.allowed_signers registers SSH keys, but neither require_signed nor a min_provenance above self-asserted is set/);
  });
});

describe("FR3.8: the default provenance with git-file, and the ceilings", () => {
  it("a git-file audit with no keys prints VERDICT PROVENANCE: self-asserted, the registered default", async () => {
    const s = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    expect(regOf(s).record.verdicts).toEqual({ minProvenance: "self-asserted", reviewers: null });
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    at(s, "2026-10-21T01:00:00Z");
    await sampleCommand(s.ctx, {});
    s.git("add", "-A");
    s.git("commit", "-qm", "audit");
    await review(s, () => ({ reviewer: "outside-reviewer" }));
    expect(s.out.join("\n")).not.toMatch(/--sign/);
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
    const reg = regOf(s);
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`);
    const claims = draws.draws.slice(0, 36).filter((d) => d.firstOccurrence).map((d) => ({ draw: d.draw, changeId: d.changeId, verdict: "pass" as const, protocolSha256: reg.record.protocolSha256, reviewer: "bob", recordedAt: "2026-10-21T03:00:00Z", provenance: { level: "presence" as const, source: "scm-label-event" } }));
    const tracker = { apiVersion: 1, name: "tracker", readVerdicts: async () => claims, appendVerdict: async () => {}, verifyIntegrity: async () => ({ ok: true, tamperTrail: true, findings: [] }) };
    const r = await verifyAudit(
      { registration: reg, manifest: readJ(s, `${W}.manifest.json`), commitment: readJ(s, `${W}/manifest-commitment.json`), draws, currentProtocolSha256: reg.record.protocolSha256 },
      { provider: null, ledger: tracker, beacon: async (round) => recordedBeacon(round), logKey: async () => null, trustBundle: mergeTrust(SHIPPED_TRUST_BUNDLE, s.tsaTrust), provenanceCeiling: "account" },
    );
    const c7 = check(r, 7);
    expect(c7.details).toContain(`ledger tracker reported ${PRESENCE_LABEL} for the verdict on draw #${claims[0]!.draw}, more than it can attest; counted as account`);
    expect(c7.details.join("\n")).toMatch(new RegExp(`is account; the registration requires ${UP}`));
    expect(c7.status).toBe("FAIL");
    expect(r.status!.provenance).toEqual([{ level: "account", count: r.status!.distinctReviewed }]);
  });
});

const SKIP_REAL = process.env.PR_RLA_SKIP_ORACLE === "1";
const hasSshKeygen = spawnSync("ssh-keygen", ["-?"], { encoding: "utf8" }).error === undefined;
describe.skipIf(SKIP_REAL)("the real paths: record --sign through ssh-keygen, and the README's manual recipe", () => {
  it("ssh-keygen is installed (set PR_RLA_SKIP_ORACLE=1 to skip these knowingly)", () => {
    expect(hasSshKeygen).toBe(true);
  });

  it.skipIf(!hasSshKeygen)("a software ed25519 key: record --sign runs ssh-keygen -Y sign, the README's printf recipe signs by hand; both count as account, verify 7/7 under min account and require_signed", async () => {
    const kd = mkdtempSync(join(tmpdir(), "prrla-keys-"));
    const env = { PATH: process.env.PATH, HOME: kd };
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "carol", "-f", join(kd, "carol")], { stdio: "ignore", env });
    const pub = readFileSync(join(kd, "carol.pub"), "utf8").trim().split(" ").slice(0, 2).join(" ");
    const s = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
    appendFileSync(join(s.dir, ".pr-rla.yml"), `ledger: { use: git-file, options: { require_signed: true } }\nverdicts: { min_provenance: account, allowed_signers: ["carol ${pub}"] }\n`);
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
    const draws = readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, 36).filter((x) => x.firstOccurrence);
    const reg = regOf(s);
    for (const [i, d] of draws.entries()) {
      if (i % 2 === 0) await recordCommand(s.ctx, String(d.draw), "pass", { sign: join(kd, "carol") });
      else {
        // The README's manual path, verbatim: printf the bytes, ssh-keygen -Y sign them, printf the line.
        const script = [
          `printf 'pr-rla-verdict/v1\\nregistrationSha256 %s\\nprotocolSha256 %s\\ndraw %s\\nchangeId %s\\nverdict %s\\nreviewer %s\\nrecordedAt %s\\n' "$REG" "$PROTO" "$DRAW" "$CHANGE" pass carol "$AT" > "verdict-$DRAW.txt"`,
          `ssh-keygen -Y sign -n pr-rla-verdict@v1 -f "$KEY" "verdict-$DRAW.txt"`,
          `SIG=$(sed '1d;$d' "verdict-$DRAW.txt.sig" | tr -d '\\n')`,
          `printf '{"changeId":"%s","draw":%s,"protocolSha256":"%s","recordedAt":"%s","registrationSha256":"%s","reviewer":"%s","schema":"pr-rla/verdict/v1","sshsig":"%s","verdict":"%s"}\\n' "$CHANGE" "$DRAW" "$PROTO" "$AT" "$REG" carol "$SIG" pass >> "$LEDGER"`,
        ].join("\n");
        execFileSync("sh", ["-c", script], { cwd: kd, stdio: "ignore", env: { ...env, REG: reg.sha256, PROTO: reg.record.protocolSha256, DRAW: String(d.draw), CHANGE: d.changeId, AT: "2026-10-21T03:00:00Z", KEY: join(kd, "carol"), LEDGER: join(s.dir, W, "verdicts.jsonl") } });
      }
      commitAll(s.dir, `verdict: draw #${d.draw}`, null, { unix: 1792551600 + i * 60 });
    }
    expect(s.out.join("\n")).toMatch(/signed: the verdict is signed by carol's ssh-ed25519 key SHA256:\S+: account/);
    expect(s.out.join("\n")).toMatch(/ERR ssh-keygen: Signing file /);
    const r = await runVerify(s.ctx, {});
    expect(r.checks.map((c) => c.status), check(r, 7).details.join("\n")).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    expect(check(r, 7).details.join("\n")).toMatch(/VERDICT PROVENANCE: account \(\d+\) \(registered minimum: account · signed verdicts required \(require_signed\)\)/);
    expect(r.status!.firstVerdicts.every((v) => v.provenance?.source === "verdict-signature" && v.provenance.signer === "carol")).toBe(true);
  });
});
