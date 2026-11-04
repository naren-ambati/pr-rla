import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { freezeCommand } from "../src/commands/freeze.js";
import { recordCommand } from "../src/commands/record.js";
import { registerCommand } from "../src/commands/register.js";
import { sampleCommand } from "../src/commands/sample.js";
import { statusCommand } from "../src/commands/status.js";
import { runVerify } from "../src/commands/verify.js";
import type { CommandContext } from "../src/commands/context.js";
import type { DrawsFile } from "../src/core/records.js";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../src/beacon/drand.js";
import { sshKeygenSign } from "../src/io/ssh-sign.js";
import { createLedger } from "../src/registry.js";
import { cloneScenario, makeChanges, setupAuditRepo, T, type Scenario } from "./helpers/audit-scenario.js";
import { recordedBeacon } from "./helpers/fixtures.js";
import { commitAll } from "./helpers/signed-commits.js";
import { makeTestKey, unarmor, type TestKey } from "./helpers/sshsig-signer.js";
import { MockTsaServer, makeTestAuthority } from "./helpers/test-tsa.js";
import { signedVerdictsYaml } from "./helpers/u9-config.js";
import { NAMESPACE, bindingOf, signedLine } from "./helpers/verdict-lines.js";

/**
 * The second-pass review of U9 at 5fe1072, finding by finding (P4: the git-file ledger path and
 * verdict binding). Each reproduction the reviewer ran (scratchpad rv-pass2-u9: zz-pass2 E1, E1b,
 * E1c, E2, E3; zz-attack; zz-wording; the bare-name spawns) is a test of what a verifier must see,
 * made through the public commands and a fresh `git clone` of the audit, as a third party verifies.
 * Every test here failed on integrate/wave2 at 66e3f54 (the attack succeeded) and passes after the
 * round, except the one marked "held before". Software keys and an emulated authenticator only (D7).
 */
const W = "audit/2026-q3";
const REL = `${W}/verdicts.jsonl`;
let tsa: MockTsaServer;
let base: Scenario;
let bob: TestKey;
const readJ = <X>(s: Scenario, p: string) => JSON.parse(readFileSync(join(s.dir, p), "utf8")) as X;
const at = (s: Scenario, iso: string) => {
  s.clock.now = T(iso);
  tsa.nowMs = T(iso);
};
type Verify = Awaited<ReturnType<typeof runVerify>>;
const c7 = (r: Verify) => r.checks.find((c) => c.n === 7)!;
const firstDraws = (s: Scenario) => readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, 36).filter((d) => d.firstOccurrence);
const reg = (s: Scenario) => readJ<{ sha256: string; record: { protocolSha256: string } }>(s, `${W}/registration.json`);
let counter = 0;
/** One verdict line naming bob: signed with `key` for this audit, or unsigned. */
function line(s: Scenario, d: { draw: number; changeId: string }, verdict: "pass" | "fail", o: { key?: TestKey } = {}): string {
  const f = { draw: d.draw, changeId: d.changeId, verdict, protocolSha256: reg(s).record.protocolSha256, reviewer: "bob", recordedAt: "2026-10-21T03:00:00Z" };
  if (!o.key) return `${JSON.stringify({ schema: "pr-rla/verdict/v1", ...f })}\n`;
  return signedLine(bindingOf(join(s.dir, W)), f, o.key, { flags: 0x01, counter: ++counter });
}
/** Bob reviews every first draw, one signed verdict and one plain commit each; `verdictFor` picks pass or fail. */
function honestReview(s: Scenario, verdictFor: (draw: number) => "pass" | "fail" = () => "pass") {
  let i = 0;
  for (const d of firstDraws(s)) {
    appendFileSync(join(s.dir, REL), line(s, d, verdictFor(d.draw), { key: bob }));
    commitAll(s.dir, `verdict ${d.draw}`, null, { unix: 1792551600 + ++i * 60 });
  }
}
/** Bob fails one draw, then appends a signed relabel PASS for it: the FAIL counts, as long as it stays. */
function reviewWithRelabel(s: Scenario): { draw: number; changeId: string } {
  const victim = firstDraws(s)[4]!;
  honestReview(s, (d) => (d === victim.draw ? "fail" : "pass"));
  appendFileSync(join(s.dir, REL), line(s, victim, "pass", { key: bob }));
  commitAll(s.dir, `relabel ${victim.draw}`, null, { unix: 1792560000 });
  return victim;
}
function ctxFor(dir: string, s: Scenario, out: string[]): CommandContext {
  const clock = { ...s.clock };
  return {
    cwd: dir,
    env: {},
    nowMs: () => clock.now,
    sleep: async (ms) => void (clock.now += ms),
    tsaTrust: s.tsaTrust,
    fetch: s.fetch,
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
/** What a third party does: a full `git clone` of the audit repo, then verify and status there. */
async function freshClone(s: Scenario): Promise<{ r: Verify; status: string; dir: string }> {
  const dir = join(mkdtempSync(join(tmpdir(), "prrla-p4-clone-")), "c");
  execFileSync("git", ["clone", "-q", `file://${s.dir}`, dir], { stdio: "ignore" });
  const vout: string[] = [];
  const r = await runVerify(ctxFor(dir, s, vout), {});
  const out: string[] = [];
  await statusCommand(ctxFor(dir, s, out), {});
  return { r, status: out.join("\n"), dir };
}
const certified = (status: string) => /CERTIFIED \(risk/.test(status) && !/NOT CERTIFIED/.test(status.split("\n")[0]!);
const dropFail = (text: string) => text.split("\n").filter((l) => !l.includes('"verdict":"fail"')).join("\n");
/** True where this machine's temp directory folds case (macOS's default APFS): finding 3 needs one. */
function caseInsensitiveTmp(): boolean {
  const d = mkdtempSync(join(tmpdir(), "prrla-case-"));
  writeFileSync(join(d, "a"), "");
  return existsSync(join(d, "A"));
}

beforeAll(async () => {
  bob = makeTestKey("sk-ssh-ed25519@openssh.com");
  tsa = await new MockTsaServer([await makeTestAuthority({ id: "test-a" }), await makeTestAuthority({ id: "test-b", alg: "RSA" })]).start();
  base = setupAuditRepo({ changes: makeChanges(200), tsa: { ids: ["test-a", "test-b"], server: tsa } });
  appendFileSync(join(base.dir, ".pr-rla.yml"), signedVerdictsYaml({ min: "presence", requireSigned: true, signers: [{ principal: "bob", key: bob }] }));
  base.git("commit", "-qam", "signed verdicts");
  at(base, "2026-10-20T00:00:00Z");
  expect(await registerCommand(base.ctx, {}), base.out.join("\n")).toBe(0);
  at(base, "2026-10-20T12:00:00Z");
  expect(await freezeCommand(base.ctx, {}), base.out.join("\n")).toBe(0);
  at(base, "2026-10-21T01:00:00Z");
  expect(await sampleCommand(base.ctx, {}), base.out.join("\n")).toBe(0);
  base.git("add", "-A");
  base.git("commit", "-qm", "registration, manifest, draws");
}, 180_000);
afterAll(async () => {
  await tsa.stop();
});

describe("finding 1 (HIGH): the walked ledger path is the registered one", () => {
  it("E1: the window directory moved, a symlink left at its old name, bob's signed FAIL dropped: a fresh clone FAILs check 7 and status does not certify", async () => {
    const s = cloneScenario(base);
    reviewWithRelabel(s);
    const before = await freshClone(s);
    expect(c7(before.r).details.join("\n")).toMatch(/relabel: .* first fail \(counts\), later pass/);
    // The attacker, in one unsigned commit.
    s.git("mv", W, "audit/real");
    writeFileSync(join(s.dir, "audit/real/verdicts.jsonl"), dropFail(readFileSync(join(s.dir, "audit/real/verdicts.jsonl"), "utf8")));
    symlinkSync("real", join(s.dir, W));
    s.git("add", "-A");
    s.git("commit", "-qm", "tidy audit directory");
    expect(s.git("ls-tree", "HEAD", `${W}`)).toMatch(/^120000 /);
    const after = await freshClone(s);
    expect(c7(after.r).status).toBe("FAIL");
    expect(after.r.ok).toBe(false);
    expect(c7(after.r).details.join("\n")).toMatch(/audit\/2026-q3 is a symbolic link/);
    expect(certified(after.status), after.status).toBe(false);
    expect(after.status).toMatch(/NOT CERTIFIED/);
  });

  it("E1b: the audit copied to another audit_dir without bob's FAIL, the original removed: check 7 FAILs on the registered path", async () => {
    const s = cloneScenario(base);
    reviewWithRelabel(s);
    execFileSync("cp", ["-R", join(s.dir, "audit"), join(s.dir, "audit2")]);
    const f = join(s.dir, "audit2/2026-q3/verdicts.jsonl");
    writeFileSync(f, dropFail(readFileSync(f, "utf8")));
    s.git("rm", "-rq", "audit");
    appendFileSync(join(s.dir, ".pr-rla.yml"), "audit_dir: audit2\n");
    s.git("add", "-A");
    s.git("commit", "-qm", "move the audit");
    const after = await freshClone(s);
    expect(c7(after.r).status).toBe("FAIL");
    expect(after.r.ok).toBe(false);
    expect(c7(after.r).details.join("\n")).toMatch(/the ledger read is audit2\/2026-q3\/verdicts\.jsonl, but the registration places it at audit\/2026-q3\/verdicts\.jsonl/);
    expect(certified(after.status), after.status).toBe(false);
  });

  it("E1c, held before: the window copied under another name and renamed in the configuration does not verify", async () => {
    const s = cloneScenario(base);
    reviewWithRelabel(s);
    execFileSync("cp", ["-R", join(s.dir, W), join(s.dir, "audit/2026-q3x")]);
    const f = join(s.dir, "audit/2026-q3x/verdicts.jsonl");
    writeFileSync(f, dropFail(readFileSync(f, "utf8")));
    const cfg = join(s.dir, ".pr-rla.yml");
    writeFileSync(cfg, readFileSync(cfg, "utf8").replace("name: 2026-q3,", "name: 2026-q3x,"));
    s.git("add", "-A");
    s.git("commit", "-qm", "copy");
    const after = await freshClone(s);
    expect(after.r.ok).toBe(false);
    expect(certified(after.status), after.status).toBe(false);
  });
});

describe("finding 3 (MEDIUM-LOW): a ledger committed under another case", () => {
  it.runIf(caseInsensitiveTmp())("E2: the attacker commits an empty Verdicts.jsonl; record refuses to write into it, and verify FAILs once a FAIL is dropped", async () => {
    const s = cloneScenario(base);
    const upper = `${W}/Verdicts.jsonl`;
    writeFileSync(join(s.dir, upper), "");
    s.git("add", "-A");
    s.git("commit", "-qm", "prepare ledger");
    at(s, "2026-10-21T03:00:00Z");
    const d0 = firstDraws(s)[0]!;
    await expect(recordCommand(s.ctx, String(d0.draw), "pass", { reviewer: "bob" })).rejects.toThrow(/verdicts\.jsonl .*Verdicts\.jsonl/);
    // Bob's verdicts land in the file anyway (as `record` wrote them before the round), committed as Verdicts.jsonl.
    const ds = firstDraws(s);
    const victim = ds[4]!;
    let i = 0;
    for (const d of ds) {
      appendFileSync(join(s.dir, REL), line(s, d, d.draw === victim.draw ? "fail" : "pass", { key: bob }));
      commitAll(s.dir, `verdict ${d.draw}`, null, { unix: 1792551600 + ++i * 60 });
    }
    appendFileSync(join(s.dir, REL), line(s, victim, "pass", { key: bob }));
    commitAll(s.dir, "relabel", null);
    writeFileSync(join(s.dir, upper), dropFail(readFileSync(join(s.dir, upper), "utf8")));
    s.git("add", "-A");
    s.git("commit", "-qm", "attacker drops the fail");
    const after = await freshClone(s);
    expect(c7(after.r).status).toBe("FAIL");
    expect(c7(after.r).details.join("\n")).toMatch(/audit\/2026-q3\/verdicts\.jsonl exists on disk only as Verdicts\.jsonl/);
    expect(certified(after.status), after.status).toBe(false);
  });

  it("a ledger with lines that was never committed, beside a committed registration, FAILs (not 'not yet committed')", async () => {
    const s = cloneScenario(base);
    for (const d of firstDraws(s)) appendFileSync(join(s.dir, REL), line(s, d, "pass", { key: bob }));
    const r = await runVerify(s.ctx, {});
    expect(c7(r).status).toBe("FAIL");
    expect(c7(r).details.join("\n")).toMatch(/audit\/2026-q3\/verdicts\.jsonl has never been committed, but the registration beside it is/);
  });
});

describe("finding 2 (MEDIUM): unsigned lines appended first do not poison the reviewer's signed verdicts", () => {
  it("E3: record --sign records over an assistant's unsigned lines without --force; bob's signed FAIL counts; status agrees with verify", async () => {
    const s = cloneScenario(base);
    const kd = mkdtempSync(join(tmpdir(), "prrla-p4-keys-"));
    writeFileSync(join(kd, "bob"), "private (emulated)\n");
    writeFileSync(join(kd, "bob.pub"), `${bob.publicText}\n`);
    s.ctx.signVerdict = async (payload) => bob.sign(payload, { namespace: NAMESPACE, flags: 0x01, counter: ++counter });
    const ds = firstDraws(s);
    for (const d of ds) appendFileSync(join(s.dir, REL), line(s, d, "pass")); // the assistant, holding no key
    commitAll(s.dir, "assistant", null);
    at(s, "2026-10-21T03:00:00Z");
    for (const d of ds) expect(await recordCommand(s.ctx, String(d.draw), d === ds[0] ? "fail" : "pass", { sign: join(kd, "bob") })).toBe(0);
    commitAll(s.dir, "bob", null);
    const r = await freshClone(s);
    expect(c7(r.r).status).not.toBe("FAIL");
    // Bob's signed FAIL is the verdict that counts for its change (once per draw of it), at presence; the assistant's lines are ignored.
    const failing = r.r.status!.firstVerdicts.find((v) => v.changeId === ds[0]!.changeId)!;
    expect(failing).toMatchObject({ verdict: "fail", provenance: { level: "presence", signer: "bob" } });
    const fails = readJ<DrawsFile>(s, `${W}/draws.json`).draws.slice(0, r.r.status!.sequence.draws).filter((d) => d.changeId === ds[0]!.changeId).length;
    expect(r.r.status!.sequence.fails).toBe(fails);
    expect(fails).toBeGreaterThanOrEqual(1);
    expect(c7(r.r).details.filter((d) => /^ignored verdict on draw #\d+: carries no signature/.test(d))).toHaveLength(ds.length);
    expect(r.status).toMatch(new RegExp(`fails ${fails} `));
    expect(certified(r.status), r.status).toBe(false);
  });
});

describe("INFO: status never says CERTIFIED where verify FAILs check 7 (it walks the git-file history)", () => {
  it("attack B (a rename hidden behind a merge drops bob's signed FAIL): status prints NOT CERTIFIED and the integrity FAIL", async () => {
    const s = cloneScenario(base);
    reviewWithRelabel(s);
    const regCommit = s.git("log", "--format=%H", "-1", "--grep=registration, manifest, draws").trim();
    s.git("checkout", "-q", "-b", "side");
    s.git("mv", REL, `${W}/tmp.jsonl`);
    s.git("commit", "-qm", "move");
    s.git("checkout", "-q", "-b", "p1", regCommit);
    s.git("merge", "-q", "--no-ff", "-m", "merge", "side");
    const text = dropFail(readFileSync(join(s.dir, W, "tmp.jsonl"), "utf8"));
    s.git("mv", `${W}/tmp.jsonl`, REL);
    writeFileSync(join(s.dir, REL), text);
    s.git("add", "-A");
    s.git("commit", "-qm", "restore");
    const after = await freshClone(s);
    expect(c7(after.r).status).toBe("FAIL");
    expect(certified(after.status), after.status).toBe(false);
    expect(after.status).toMatch(/NOT CERTIFIED: verify check 7 would FAIL \(the ledger's integrity check FAILs\); run "pr-rla verify"/);
    expect(after.status).toMatch(/ledger integrity FAILs: audit\/2026-q3\/verdicts\.jsonl was deleted in commit/);
    // --json says the same.
    const out: string[] = [];
    await statusCommand(ctxFor(after.dir, s, out), { json: true });
    const json = JSON.parse(out.join("\n")) as { sequence: { state: string }; ledgerIntegrity: { ok: boolean; fails: string[] }; certificateWithheld: string[] };
    expect(json.sequence.state).toBe("CERTIFIED");
    expect(json.certificateWithheld).toEqual(["the ledger's integrity check FAILs"]);
    expect(json.ledgerIntegrity.ok).toBe(false);
    expect(json.ledgerIntegrity.fails.join("\n")).toMatch(/was deleted in commit/);
  });
});

describe("finding 5 (LOW): a verdict signature binds the manifest and the seed", () => {
  it("signatures over the v1 bytes (no manifest, no beacon: pre-signable before the seed) count for nothing", async () => {
    const s = cloneScenario(base);
    const r0 = reg(s);
    let i = 0;
    for (const d of firstDraws(s)) {
      const f = { draw: d.draw, changeId: d.changeId, verdict: "pass" as const, protocolSha256: r0.record.protocolSha256, reviewer: "bob", recordedAt: "2026-10-21T03:00:00Z" };
      const v1 = `pr-rla-verdict/v1\nregistrationSha256 ${r0.sha256}\nprotocolSha256 ${f.protocolSha256}\ndraw ${f.draw}\nchangeId ${f.changeId}\nverdict ${f.verdict}\nreviewer ${f.reviewer}\nrecordedAt ${f.recordedAt}\n`;
      const sig = bob.sign(v1, { namespace: NAMESPACE, flags: 0x01, counter: ++counter });
      appendFileSync(join(s.dir, REL), `${JSON.stringify({ schema: "pr-rla/verdict/v1", ...f, registrationSha256: r0.sha256, sshsig: unarmor(sig) })}\n`);
      commitAll(s.dir, `verdict ${d.draw}`, null, { unix: 1792551600 + ++i * 60 });
    }
    const after = await freshClone(s);
    expect(after.r.status!.provenance.some((p) => p.level === "presence")).toBe(false);
    expect(certified(after.status), after.status).toBe(false);
  });
});

describe("finding 6 (LOW): git and ssh-keygen run by absolute path, never found through the audit repository", () => {
  /** An executable `name` in `dir` that leaves a marker file when it runs. */
  function trap(dir: string, name: string): string {
    const marker = join(dir, `${name}.ran`);
    writeFileSync(join(dir, name), `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`);
    chmodSync(join(dir, name), 0o755);
    return marker;
  }

  it.runIf(process.platform !== "win32")("a git committed in the audit repository, reached through a relative PATH entry, never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-p4-trap-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    mkdirSync(join(dir, "audit/w"), { recursive: true });
    const marker = trap(dir, "git");
    const saved = process.env.PATH;
    process.env.PATH = `.:${saved}`;
    try {
      const l = await createLedger({ use: "git-file", options: {} }, { cwd: dir, windowDir: join(dir, "audit/w"), env: {}, log: () => {}, fetch: globalThis.fetch });
      await l.verifyIntegrity!();
    } finally {
      process.env.PATH = saved;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform !== "win32")("ssh-keygen is not looked up through a relative PATH entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-p4-trap-"));
    const marker = trap(dir, "ssh-keygen");
    const key = join(mkdtempSync(join(tmpdir(), "prrla-p4-key-")), "k");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const sig = await sshKeygenSign(new TextEncoder().encode("bytes\n"), key, { PATH: `${relative(process.cwd(), dir)}:${process.env.PATH}` }, () => {}).catch((e: Error) => e.message);
    expect(existsSync(marker)).toBe(false);
    expect(sig).toMatch(/^-----BEGIN SSH SIGNATURE-----/);
  });
});
