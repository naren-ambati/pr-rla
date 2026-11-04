import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify } from "../src/commands/verify.js";
import { parsePublicKeyBlob, parsePublicKeyText, verifySshsig } from "../src/core/presence/index.js";
import type { DrawsFile } from "../src/core/records.js";
import { createLedger } from "../src/registry.js";
import { gitSafeText } from "../src/io/git-safe.js";
import { verdictIneligibility } from "../src/sdk/ledger.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { lockPlugin } from "./helpers/plugin-lock.js";
import { commitAll } from "./helpers/signed-commits.js";
import { makeTestKey, type TestKey } from "./helpers/sshsig-signer.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";
import { signedVerdictsYaml } from "./helpers/u9-config.js";
import { bindingOf, signedLine } from "./helpers/verdict-lines.js";

/**
 * The independent review of bolt 10 (U9) at 0cf8af1, finding by finding: each reproduction the
 * reviewer ran (scratchpad attack.test.ts, exp1–exp7) and each plausible attack it traced, as a test
 * of the outcome a verifier must see. Every test here failed on 0cf8af1 (the attack succeeded) and
 * passes after the fix round, except the two marked "held before", which guard what the review found
 * sound. The audits are built only through public commands and src APIs that exist on both sides, and
 * through test/helpers/u9-config.ts, the one place the key setting's shape changed.
 *
 * Honest verdicts are made both ways at once: each line carries its own signature (the new
 * mechanism) and its commit is signed by the same key (the old one), so the old code would credit
 * them too and an attack is tested against both. Software keys and an emulated authenticator only (D7).
 */
const W = "audit/2026-q3";
const REL = `${W}/verdicts.jsonl`;
let tsa: MockTsaServer;
let base: Scenario;
let bob: TestKey;
let alice: TestKey;
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};
const c7 = (r: Awaited<ReturnType<typeof runVerify>>) => r.checks.find((c) => c.n === 7)!;
const firstDraws = (s: Scenario) => readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, 36).filter((d) => d.firstOccurrence);
const reg = (s: Scenario) => readJ<{ sha256: string; record: { protocolSha256: string } }>(s, `${W}/registration.json`);
let counter = 0;
const bobCommit = (p: string) => bob.sign(p, { flags: 0x01, counter: ++counter });
/** One verdict, as a line in the ledger: signed by `key` for this audit (or for `forRegistration`), or unsigned. */
function line(s: Scenario, d: { draw: number; changeId: string }, verdict: "pass" | "fail", o: { key?: TestKey; reviewer?: string; forRegistration?: string } = {}): string {
  const f = { draw: d.draw, changeId: d.changeId, verdict, protocolSha256: reg(s).record.protocolSha256, reviewer: o.reviewer ?? "bob", recordedAt: "2026-10-21T03:00:00Z" };
  if (!o.key) return `${JSON.stringify({ schema: "pr-rla/verdict/v1", ...f })}\n`;
  return signedLine(bindingOf(join(s.dir, W)), f, o.key, { flags: 0x01, counter: ++counter, ...(o.forRegistration ? { bytesFor: { registrationSha256: o.forRegistration } } : {}) });
}
/** An honest reviewer: each verdict signed, each commit signed. `verdictFor` picks pass or fail per draw. */
function honestReview(s: Scenario, verdictFor: (draw: number) => "pass" | "fail" = () => "pass") {
  let i = 0;
  for (const d of firstDraws(s)) {
    appendFileSync(join(s.dir, REL), line(s, d, verdictFor(d.draw), { key: bob }));
    commitAll(s.dir, `verdict ${d.draw}`, bobCommit, { unix: 1792551600 + ++i * 60 });
  }
}
/** A copy of `s` whose .git is a `git clone --depth 1` of it: the same working tree, a shallow history. */
function shallowCopy(s: Scenario): Scenario {
  const sh = join(mkdtempSync(join(tmpdir(), "prrla-shallow-")), "c");
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${s.dir}`, sh], { stdio: "ignore" });
  const v = cloneScenario(s);
  rmSync(join(v.dir, ".git"), { recursive: true, force: true });
  cpSync(join(sh, ".git"), join(v.dir, ".git"), { recursive: true });
  return v;
}
const noPresence = (r: Awaited<ReturnType<typeof runVerify>>) => !r.status?.provenance.some((p) => p.level === "presence");
/**
 * Since P4 a line without a valid registered signature is ineligible under this audit's rules
 * (presence, require_signed): the forged lines are ignored, so they certify nothing, and check 7
 * WARNs them as ignored instead of counting and FAILing them.
 */
const forgeriesIgnored = (r: Awaited<ReturnType<typeof runVerify>>) => r.status!.provenance.length === 0 && r.status!.sequence.state !== "CERTIFIED" && c7(r).status !== "PASS" && c7(r).details.some((d) => /^ignored verdict on draw #\d+: /.test(d));

beforeAll(async () => {
  bob = makeTestKey("sk-ssh-ed25519@openssh.com");
  alice = makeTestKey("ssh-ed25519");
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  base = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
  appendFileSync(join(base.dir, ".pr-rla.yml"), signedVerdictsYaml({ min: "presence", requireSigned: true, signers: [{ principal: "bob", key: bob }, { principal: "alice", key: alice }] }));
  base.git("commit", "-qam", "signed verdicts");
  at(base, "2026-10-20T00:00:00Z");
  expect(await registerCommand(base.ctx, {}), base.out.join("\n")).toBe(0);
  at(base, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(base.ctx, {}), base.out.join("\n")).toBe(0);
  at(base, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(base.ctx, {}), base.out.join("\n")).toBe(0);
  base.git("add", "-A");
  base.git("commit", "-qm", "registration, manifest, draws");
}, 120_000);
afterAll(async () => {
  await tsa.stop();
});

describe("finding 1 (CRITICAL): one signed commit no longer vouches for every line, however the history is cut", () => {
  /** attack A: 35 unsigned verdicts naming bob; bob signs only the last commit (`tipSignedReadme`: an unrelated README commit instead, exp7). */
  function attackA(tipSignedReadme = false): Scenario {
    const s = cloneScenario(base);
    const ds = firstDraws(s);
    ds.forEach((d, i) => {
      appendFileSync(join(s.dir, REL), line(s, d, "pass"));
      const last = i === ds.length - 1 && !tipSignedReadme;
      commitAll(s.dir, `verdict ${d.draw}`, last ? bobCommit : null, { unix: 1792551600 + i * 60 });
    });
    if (tipSignedReadme) {
      writeFileSync(join(s.dir, "README"), "docs\n");
      commitAll(s.dir, "docs", bobCommit, { unix: 1792560000 });
    }
    return s;
  }

  it("attack A: in the full clone the forged lines count for nothing (ignored since P4), and a depth-1 clone FAILs (it is refused), with nothing counted at presence", async () => {
    const s = attackA();
    const full = await runVerify(s.ctx, {});
    expect(forgeriesIgnored(full)).toBe(true);
    const shallow = await runVerify(shallowCopy(s).ctx, {});
    expect(c7(shallow).status).toBe("FAIL");
    expect(shallow.ok).toBe(false);
    expect(noPresence(shallow)).toBe(true);
    expect(c7(shallow).details.join("\n")).toMatch(/shallow clone/);
  });

  it("exp1: a grafts file or a hand-written .git/shallow in a full clone is refused too", async () => {
    for (const file of [".git/info/grafts", ".git/shallow"]) {
      const s = cloneScenario(attackA());
      writeFileSync(join(s.dir, file), `${s.git("rev-parse", "HEAD").trim()}\n`);
      const r = await runVerify(s.ctx, {});
      expect(c7(r).status, file).toBe("FAIL");
      expect(noPresence(r), file).toBe(true);
    }
  });

  it("exp7: a shallow clone whose tip is bob's signed README commit (it never touches the ledger) counts nothing above self-asserted", async () => {
    const r = await runVerify(shallowCopy(attackA(true)).ctx, {});
    expect(c7(r).status).toBe("FAIL");
    // Since P4 the unsigned lines are not even counted as self-asserted: they are ignored.
    expect(r.status!.provenance.map((p) => p.level)).toEqual([]);
  });
});

describe("finding 2 (HIGH): a rename hidden behind a merge cannot drop a signed FAIL", () => {
  it("attack B: bob signs a FAIL and a relabel PASS; the attacker's hidden-rename merge drops the FAIL; verify FAILs check 7", async () => {
    const s = cloneScenario(base);
    const ds = firstDraws(s);
    const victim = ds[4]!;
    honestReview(s, (d) => (d === victim.draw ? "fail" : "pass"));
    appendFileSync(join(s.dir, REL), line(s, victim, "pass", { key: bob }));
    commitAll(s.dir, `relabel ${victim.draw}`, bobCommit, { unix: 1792560000 });
    const before = await runVerify(s.ctx, {});
    expect(c7(before).details.join("\n")).toMatch(/relabel: .* first fail \(counts\), later pass/);
    const regCommit = s.git("log", "--format=%H", "-1", "--grep=registration, manifest, draws").trim();
    s.git("checkout", "-q", "-b", "side");
    s.git("mv", REL, `${W}/tmp.jsonl`);
    s.git("commit", "-qm", "move");
    s.git("checkout", "-q", "-b", "p1", regCommit);
    s.git("merge", "-q", "--no-ff", "-m", "merge", "side");
    const text = readFileSync(join(s.dir, W, "tmp.jsonl"), "utf8").split("\n").filter((l) => !l.includes('"verdict":"fail"')).join("\n");
    s.git("mv", `${W}/tmp.jsonl`, REL);
    writeFileSync(join(s.dir, REL), text);
    s.git("add", "-A");
    s.git("commit", "-qm", "restore");
    expect(s.git("log", "--format=%s", "--", REL).trim()).toBe("restore");
    const after = await runVerify(s.ctx, {});
    expect(c7(after).status).toBe("FAIL");
    expect(after.ok).toBe(false);
    expect(c7(after).details.join("\n")).toMatch(new RegExp(`${REL} was deleted in commit`));
  });

  it("exp2(a), held before: attacker-committed .gitattributes (binary, -diff, -text) credit no forged line", async () => {
    for (const attr of ["*.jsonl binary", "*.jsonl -diff", "*.jsonl -text"]) {
      const s = cloneScenario(base);
      writeFileSync(join(s.dir, ".gitattributes"), `${attr}\n`);
      const ds = firstDraws(s);
      ds.forEach((d, i) => {
        appendFileSync(join(s.dir, REL), line(s, d, "pass"));
        commitAll(s.dir, `verdict ${d.draw}`, i === ds.length - 1 ? bobCommit : null);
      });
      const r = await runVerify(s.ctx, {});
      expect(forgeriesIgnored(r), attr).toBe(true);
      // P4 (second-pass review): exactly none, not "at most one".
      expect(r.status!.provenance.find((p) => p.level === "presence")?.count ?? 0, attr).toBe(0);
    }
  });
});

describe("finding 3 (HIGH): verify compares the loaded ledger with the registered one", () => {
  it("exp2(b): a renamed copy without the FAIL, read through a changed `file` option, FAILs check 7 (options differ)", async () => {
    const s = cloneScenario(base);
    const victim = firstDraws(s)[2]!;
    honestReview(s, (d) => (d === victim.draw ? "fail" : "pass"));
    appendFileSync(join(s.dir, REL), line(s, victim, "pass", { key: bob }));
    commitAll(s.dir, "relabel", bobCommit);
    const text = readFileSync(join(s.dir, REL), "utf8").split("\n").filter((l) => !l.includes('"verdict":"fail"')).join("\n");
    s.git("mv", REL, `${W}/v2.jsonl`);
    writeFileSync(join(s.dir, W, "v2.jsonl"), text);
    commitAll(s.dir, "attacker: rename and drop the FAIL", null);
    const cfg = join(s.dir, ".pr-rla.yml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("options: { require_signed: true }", "options: { require_signed: true, file: v2.jsonl }"));
    const r = await runVerify(s.ctx, {});
    expect(c7(r).status).toBe("FAIL");
    expect(c7(r).details.join("\n")).toMatch(/the ledger verify loaded is not the registered one \(optionsSha256 [0-9a-f]{12}… → [0-9a-f]{12}…\)/);
  });

  it("a locally locked external ledger, swapped in at verify, that reports every draw as a signed PASS at account, FAILs check 7", async () => {
    const s = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
    appendFileSync(join(s.dir, ".pr-rla.yml"), signedVerdictsYaml({ min: "account", requireSigned: true, signers: [{ principal: "alice", key: alice }] }));
    s.git("commit", "-qam", "signed verdicts");
    at(s, "2026-10-20T00:00:00Z");
    expect(await registerCommand(s.ctx, {})).toBe(0);
    at(s, "2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    at(s, "2026-10-21T01:00:00Z");
    await sampleCommand(s.ctx, {});
    s.git("add", "-A");
    s.git("commit", "-qm", "audit");
    writeFileSync(
      join(s.dir, "evil-ledger.mjs"),
      `import { readFileSync } from "node:fs";
import { join } from "node:path";
export default {
  ledgerApiVersion: 1, name: "evil", provenance: "account",
  create: (_o, ctx) => ({
    apiVersion: 1, name: "evil",
    readVerdicts: async () => {
      const draws = JSON.parse(readFileSync(join(ctx.windowDir, "draws.json"), "utf8")).draws;
      const protocolSha256 = JSON.parse(readFileSync(join(ctx.windowDir, "registration.json"), "utf8")).record.protocolSha256;
      return draws.map((d) => ({ draw: d.draw, changeId: d.changeId, verdict: "pass", protocolSha256, reviewer: "alice", recordedAt: "2026-10-21T03:00:00Z", provenance: { level: "account", source: "git-signed-commit", signer: "alice" } }));
    },
    appendVerdict: async () => {},
    verifyIntegrity: async () => ({ ok: true, tamperTrail: true, findings: [] }),
  }),
};
`,
    );
    await lockPlugin(s.dir, "./evil-ledger.mjs", { kind: "ledger", trust: "full" });
    const cfg = join(s.dir, ".pr-rla.yml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("ledger: { use: git-file, options: { require_signed: true } }", "ledger: { use: ./evil-ledger.mjs }"));
    // fix/plugins-broker: a trust: full plugin nobody approved on this machine is not loaded at all.
    await expect(runVerify(s.ctx, {})).rejects.toMatchObject({ code: "NOT_APPROVED" });
    // Locked locally means approved locally (plugin add and plugin lock record it); then check 7 judges what it reports.
    await lockPlugin(s.dir, "./evil-ledger.mjs", { kind: "ledger", trust: "full", approve: true });
    const r = await runVerify(s.ctx, {});
    expect(c7(r).status).toBe("FAIL");
    expect(r.ok).toBe(false);
    expect(c7(r).details.join("\n")).toMatch(/the ledger verify loaded is not the registered one \(name git-file → evil; source builtin → path; integrity none → [0-9a-f]{12}…/);
  });
});

describe("findings 4 and 8 (MEDIUM, LOW): one touch signs one verdict, for one draw of one registration", () => {
  it("finding 4: an assistant appends every verdict; the reviewer's one touch signs the commit; none of its lines counts", async () => {
    const s = cloneScenario(base);
    for (const d of firstDraws(s)) appendFileSync(join(s.dir, REL), line(s, d, "pass"));
    commitAll(s.dir, "verdicts", bobCommit); // one touch
    const r = await runVerify(s.ctx, {});
    expect(forgeriesIgnored(r)).toBe(true);
    expect(noPresence(r)).toBe(true);
  });

  it("finding 8: bob's genuine signatures made for another audit's registration do not count in this one", async () => {
    const s = cloneScenario(base);
    const other = createHash("sha256").update("another audit, same protocol").digest("hex");
    for (const d of firstDraws(s)) {
      appendFileSync(join(s.dir, REL), line(s, d, "pass", { key: bob, forRegistration: other }));
      commitAll(s.dir, `verdict ${d.draw}`, bobCommit);
    }
    const r = await runVerify(s.ctx, {});
    expect(forgeriesIgnored(r)).toBe(true);
    expect(noPresence(r)).toBe(true);
  });
});

describe("finding 5 (LOW-MEDIUM): the verifier's git configuration and environment change nothing", () => {
  it("exp4: textconv in .git/config and info/attributes does not credit a flipped line to alice's signed FAIL", async () => {
    const s = cloneScenario(base);
    const [d, ...rest] = firstDraws(s);
    appendFileSync(join(s.dir, REL), line(s, d!, "fail", { key: alice, reviewer: "alice" }));
    commitAll(s.dir, "alice fail", (p) => alice.sign(p));
    writeFileSync(join(s.dir, REL), readFileSync(join(s.dir, REL), "utf8").replace('"verdict":"fail"', '"verdict":"pass"'));
    commitAll(s.dir, "attacker flips", null);
    for (const x of rest) {
      appendFileSync(join(s.dir, REL), line(s, x, "pass", { key: bob }));
      commitAll(s.dir, `verdict ${x.draw}`, bobCommit);
    }
    writeFileSync(join(s.dir, ".git/info/attributes"), "*.jsonl diff=x\n");
    writeFileSync(join(s.dir, "tc.sh"), "#!/bin/sh\nsed 's/\"pass\"/\"fail\"/' \"$1\"\n");
    s.git("config", "diff.x.textconv", `sh ${join(s.dir, "tc.sh")}`);
    const r = await runVerify(s.ctx, {});
    expect(c7(r).status).toBe("FAIL");
    // The flipped line's signature no longer verifies: it is ignored (P4), so nothing is credited to alice's signed FAIL.
    expect(r.status!.firstVerdicts.some((v) => v.draw === d!.draw)).toBe(false);
    expect(r.status!.ignored.find((i) => i.event.draw === d!.draw)?.reason).toMatch(/has a signature that does not verify for this audit/);
  });

  /** A ledger whose FAIL was removed by a commit that a lie would hide. */
  function removal(): { dir: string; removed: string; skip: string; tip: string } {
    const dir = mkdtempSync(join(tmpdir(), "prrla-lie-"));
    const g = (...a: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=user-1a2b3c4d@example.invalid", ...a], { cwd: dir, encoding: "utf8" }).trim();
    g("init", "-q", "-b", "main");
    mkdirSync(join(dir, "audit/w"), { recursive: true });
    const v = (draw: number, verdict: string) => `${JSON.stringify({ changeId: `json:acme/widgets#${draw}`, draw, protocolSha256: "cd".repeat(32), recordedAt: "2026-10-21T03:00:00Z", reviewer: "bob", schema: "pr-rla/verdict/v1", verdict })}\n`;
    const f = join(dir, "audit/w/verdicts.jsonl");
    writeFileSync(f, v(1, "pass"));
    const skip = commitAll(dir, "draw 1", null);
    appendFileSync(f, v(2, "fail"));
    commitAll(dir, "draw 2 fail", null);
    writeFileSync(f, v(1, "pass"));
    const removed = commitAll(dir, "drop the fail", null);
    appendFileSync(f, v(2, "pass"));
    const tip = commitAll(dir, "draw 2 pass", null);
    return { dir, removed, skip, tip };
  }
  const integrity = async (dir: string) => (await createLedger({ use: "git-file", options: {} }, { cwd: dir, windowDir: join(dir, "audit/w"), env: {}, log: () => {}, fetch: globalThis.fetch })).verifyIntegrity!();

  it("a lying commit-graph that skips the removal is not believed", async () => {
    const { dir, removed, skip, tip } = removal();
    execFileSync("git", ["commit-graph", "write", "--reachable"], { cwd: dir });
    const f = join(dir, ".git/objects/info/commit-graph");
    chmodSync(f, 0o644);
    const b = readFileSync(f);
    const chunk = (id: string) => {
      for (let i = 0; i <= b[6]!; i++) if (b.subarray(8 + i * 12, 12 + i * 12).toString("latin1") === id) return Number(b.readBigUInt64BE(12 + i * 12));
      throw new Error(id);
    };
    const oids = Array.from({ length: (chunk("CDAT") - chunk("OIDL")) / 20 }, (_, i) => b.subarray(chunk("OIDL") + i * 20, chunk("OIDL") + i * 20 + 20).toString("hex"));
    b.writeUInt32BE(oids.indexOf(skip), chunk("CDAT") + oids.indexOf(tip) * 36 + 20);
    createHash("sha1").update(b.subarray(0, b.length - 20)).digest().copy(b, b.length - 20);
    writeFileSync(f, b);
    const r = await integrity(dir);
    expect(r.ok).toBe(false);
    expect(r.findings).toContain(`audit/w/verdicts.jsonl was rewritten (not appended) in commit ${removed.slice(0, 10)}`);
    // P4: plain git believes the graph, git under the guard does not; without the guard's `-c core.commitGraph=false` this fails.
    expect(execFileSync("git", ["log", "--format=%P", "-1", tip], { cwd: dir, encoding: "utf8" }).trim()).toBe(skip);
    expect(gitSafeText(["log", "--format=%P", "-1", tip], { cwd: dir }).trim()).toBe(removed);
  });

  describe("an inherited GIT_DIR, GIT_OBJECT_DIRECTORY or GIT_GRAFT_FILE", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    });
    it("cannot point the walk at another repository or graft the history", async () => {
      const { dir, removed, tip } = removal();
      const decoy = removal().dir;
      execFileSync("git", ["reset", "-q", "--hard", "HEAD~3"], { cwd: decoy });
      writeFileSync(join(decoy, "grafts"), `${tip}\n`);
      process.env.GIT_DIR = join(decoy, ".git");
      process.env.GIT_OBJECT_DIRECTORY = join(decoy, ".git/objects");
      process.env.GIT_GRAFT_FILE = join(decoy, "grafts");
      expect((await integrity(dir)).findings).toContain(`audit/w/verdicts.jsonl was rewritten (not appended) in commit ${removed.slice(0, 10)}`);
    });
  });

  it("a partial clone (--filter=blob:none) is refused and nothing is fetched: the pack count does not change", async () => {
    const { dir } = removal();
    const bare = join(mkdtempSync(join(tmpdir(), "prrla-origin-")), "o.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    execFileSync("git", ["push", "-q", bare, "main"], { cwd: dir });
    execFileSync("git", ["config", "uploadpack.allowfilter", "true"], { cwd: bare });
    const c = join(mkdtempSync(join(tmpdir(), "prrla-partial-")), "c");
    execFileSync("git", ["clone", "-q", "--filter=blob:none", `file://${bare}`, c], { stdio: "ignore" });
    const packs = () => readdirSync(join(c, ".git/objects/pack")).filter((f) => f.endsWith(".pack")).length;
    const before = packs();
    const r = await integrity(c);
    expect(packs()).toBe(before);
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/partial clone/);
    expect(r.findings.join("\n")).not.toMatch(/was deleted/);
  });
});

describe("findings 6, 7, 11 and 12 (LOW, INFO)", () => {
  it("exp5 (finding 6): a non-empty SSHSIG reserved field is refused, as ssh-keygen would refuse what it signs over", () => {
    const k = makeTestKey("ssh-ed25519");
    expect(verifySshsig(k.sign("hello verdict\n", { reservedBlob: "X", reservedSigned: "X" }), new TextEncoder().encode("hello verdict\n"), "git").ok).toBe(false);
    expect(verifySshsig(k.sign("hello verdict\n"), new TextEncoder().encode("hello verdict\n"), "git").ok).toBe(true);
  });

  it("exp6 (finding 12): RSA e = 1 and e = 2 are refused, e = 3 accepted; an off-curve P-256 point refused", () => {
    const str = (b: Uint8Array) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(b.length);
      return Buffer.concat([len, Buffer.from(b)]);
    };
    const n = Buffer.from(makeTestKey("ssh-rsa").blob).subarray(-257);
    const rsa = (e: number) => new Uint8Array(Buffer.concat([str(Buffer.from("ssh-rsa")), str(Uint8Array.of(e)), str(n)]));
    expect(() => parsePublicKeyBlob(rsa(1))).toThrow();
    expect(() => parsePublicKeyBlob(rsa(2))).toThrow();
    expect(parsePublicKeyBlob(rsa(3)).type).toBe("ssh-rsa");
    const p = Buffer.from(makeTestKey("ecdsa-sha2-nistp256").blob);
    p[p.length - 1]! ^= 1;
    expect(() => parsePublicKeyBlob(new Uint8Array(p))).toThrow();
  });

  it("finding 12: a small-order Ed25519 key and a security key whose application is not ssh: are refused", () => {
    const identity = Buffer.alloc(32);
    identity[0] = 1;
    expect(() => parsePublicKeyBlob(new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), identity])))).toThrow();
    expect(() => parsePublicKeyText("sk-ssh-ed25519@openssh.com", makeTestKey("sk-ssh-ed25519@openssh.com", { application: "https://example.org" }).publicText.split(" ")[1]!)).toThrow();
  });

  it("exp6 and finding 7: register refuses principals equal ignoring case, and one key under two principals", async () => {
    const fresh = (signers: { principal: string; key: TestKey }[]) => {
      const s = setupAuditRepo({ changes: makeChanges(200) });
      appendFileSync(join(s.dir, ".pr-rla.yml"), signedVerdictsYaml({ min: "account", requireSigned: true, signers }));
      s.clock.now = T("2026-06-20T00:00:00Z");
      return s;
    };
    await expect(registerCommand(fresh([{ principal: "Alice", key: alice }, { principal: "alice", key: makeTestKey("ssh-ed25519") }]).ctx, { dryRun: true })).rejects.toThrow(/same principal ignoring case/);
    await expect(registerCommand(fresh([{ principal: "alice", key: alice }, { principal: "carol", key: alice }]).ctx, { dryRun: true })).rejects.toThrow(/hold the same key/);
  });

  it("finding 11(b): a reviewer whose name has a space loads again as a plain name", () => {
    const s = setupAuditRepo({ changes: makeChanges(10) });
    const cfg = join(s.dir, ".pr-rla.yml");
    appendFileSync(cfg, 'verdicts: { reviewers: ["Alice Smith", bob] }\n');
    const c = loadConfig(cfg);
    expect(c.verdicts.reviewers).toEqual(["Alice Smith", "bob"]);
    expect(verdictIneligibility({ reviewer: "alice smith" }, c.verdicts.reviewers)).toBeNull();
    expect(verdictIneligibility({ reviewer: "Alice" }, c.verdicts.reviewers)).toBe("Alice is not a registered reviewer");
  });

  it("finding 12: register warns when keys are registered but neither require_signed nor a minimum above self-asserted is set", async () => {
    const s = setupAuditRepo({ changes: makeChanges(200) });
    appendFileSync(join(s.dir, ".pr-rla.yml"), signedVerdictsYaml({ signers: [{ principal: "alice", key: alice }] }));
    s.clock.now = T("2026-06-20T00:00:00Z");
    expect(await registerCommand(s.ctx, { dryRun: true })).toBe(0);
    expect(s.out.join("\n")).toMatch(/warning: .*registers SSH keys, but neither require_signed nor a min_provenance above self-asserted is set/);
  });

  it("held before: recording a verdict and status still work for an audit with keys registered", async () => {
    const s = cloneScenario(base);
    at(s, "2026-10-21T03:00:00Z");
    expect(await recordCommand(s.ctx, String(firstDraws(s)[0]!.draw), "pass", { reviewer: "bob" })).toBe(0);
    expect(await statusCommand(s.ctx, {})).toBe(0);
  });
});
