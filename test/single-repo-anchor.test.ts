import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { computeDraws } from "../src/core/seed.js";
import { loadOrCreateKey } from "../src/core/signing.js";
import { recordedBeacon } from "./helpers/fixtures.js";

/**
 * A single repo is a pool of one, and existing single-repo audits behave as master does (FR5.1; test-design U8; the
 * review's anchor finding). This test builds the master build itself: `git archive` of the commit this branch left
 * master at (`git merge-base HEAD master`), extracted into a temp dir with this checkout's node_modules, and runs the
 * same scenarios on both builds in child vitest runs at a fixed clock with one signing key: register, status, freeze,
 * verify (the report and verify's own output), sample, status. It compares every command's result and stdout, and the
 * registration, manifest and commitment bodies (signatures aside: ECDSA signatures are randomised).
 *
 * The fakes (test/helpers/fake-org.ts, fake-github.ts) are this checkout's, copied into the master tree, so both builds
 * read the same synthetic data. Fixture kind: synthetic. The intended differences for single repos are listed below:
 * U8's (a repo deleted after freeze is INCOMPLETE) and time round B's (`timeRoundB`, which rewrites master's results
 * into what this branch must print, rule by rule, so that nothing else may differ).
 */
type Dump = Record<string, Record<string, unknown>>;
type Step = { value?: unknown; threw?: string; exitCode?: number | null; out: string[] };
type VerifyValue = { ok: boolean; mode: string; checks: [number, string, string, string[]][] };

/** Each scenario's record digests replaced by placeholders (the registration's differs by design, and the two after it hash it). */
function placeholders(d: Dump): Dump {
  let text = JSON.stringify(d);
  for (const rec of Object.values(d)) {
    for (const [f, tag] of [["audit/2026-q3/registration.json", "REG"], ["audit/2026-q3.manifest.json", "MANIFEST"], ["audit/2026-q3/manifest-commitment.json", "COMMITMENT"]] as const) {
      const sha = (rec[f] as { sha256?: string } | null)?.sha256;
      if (sha) text = text.split(sha).join(`<${tag}>`).split(sha.slice(0, 12)).join(`<${tag}12>`);
    }
  }
  return JSON.parse(text) as Dump;
}

const UNPROVEN_R = "        INCOMPLETE R is derived from the registration time 2026-10-20T00:00:00Z, which no trusted evidence bounds (fewer than k timestamp authorities agree): it could have been written after round 33,245,812 was public, to choose R";
const BELOW_MIN = (N: number) => `population ${N} < the registered minimum 150: the registration says review all ${N} instead (no draws)`;

/**
 * Time round B's single-repo changes, applied to master's (placeholder) dump; the result must be this branch's:
 *  1. the registration names its signing key (`publicKeyPem`, inside the signed bytes), so its digest, and the
 *     manifest's and commitment's after it, differ (placeholders hide that; the key is removed here and checked apart);
 *  2. unproven times are not established: checks 1 and 2 WARN → INCOMPLETE ("not shown to precede R"), check 3 → INCOMPLETE
 *     with the reason, the verdict INCOMPLETE (exit 6, `ok` false) instead of VERIFIED, and the INCOMPLETE line;
 *  3. check 6 says why there are no draws when N is below the minimum;
 *  4. the draws: bound to the registration, not the manifest (the draw lines are compared apart, against computeDraws).
 */
function timeRoundB(master: Dump): Dump {
  const d = JSON.parse(JSON.stringify(master)) as Dump;
  for (const [name, rec] of Object.entries(d)) {
    const steps = rec.steps as Record<string, Step>;
    const N = (rec["audit/2026-q3.manifest.json"] as { N?: number } | null)?.N ?? null;
    const below = N !== null && N < 150;
    const v = steps.verify!.value as VerifyValue;
    v.ok = false;
    for (const c of v.checks) {
      if (c[0] === 1 && c[1] === "WARN") c[1] = "INCOMPLETE";
      if (c[0] === 2 && c[1] === "WARN") [c[1], c[2]] = ["INCOMPLETE", c[2].replace(/, before R$/, ": not shown to precede R")];
      if (c[0] === 3 && c[1] === "PASS") [c[1], c[2]] = ["INCOMPLETE", `${c[2]}, but the registration time it rests on is unproven`];
      if (c[0] === 6 && below) c[2] = BELOW_MIN(N);
    }
    const vc = steps.verifyCommand!;
    const failed = vc.value === 1;
    vc.value = failed ? 1 : 6;
    vc.out = vc.out.flatMap((l) => {
      if (l.startsWith("1. WARN registration:")) return [l.replace("1. WARN", "1. INCOMPLETE")];
      if (l.startsWith("2. WARN manifest before seed:")) return [l.replace("2. WARN", "2. INCOMPLETE").replace(/, before R$/, ": not shown to precede R")];
      if (l.startsWith("3. PASS seed round:")) return [`${l.replace("3. PASS", "3. INCOMPLETE")}, but the registration time it rests on is unproven`, UNPROVEN_R];
      if (l === "6. SKIP draws: not sampled yet" && below) return [`6. SKIP draws: ${BELOW_MIN(N)}`];
      if (l.startsWith("registration after window close → ")) {
        let x = l.replace(/, before R \(warn\)/, ": not shown to precede R (incomplete)").replace("first round ≥ 24 h after registration ✓", "first round ≥ 24 h after registration, but the registration time it rests on is unproven (incomplete)");
        if (below) x = x.replace("not sampled yet (skipped)", `${BELOW_MIN(N)} (skipped)`);
        return [x];
      }
      if (l === "VERIFIED") return ["INCOMPLETE: check 1 (registration), check 2 (manifest before seed), check 3 (seed round) could not be established; check 4 (BLS), check 6 (draws), check 7 (labels) skipped; nothing failed, but this is not a verification (exit 6)"];
      return [l];
    });
    void name;
  }
  return d;
}

/** The draw lines of sample's and status's output, with what they draw replaced (compared against computeDraws apart). */
function hideDraws(d: Dump): { dump: Dump; drawn: Record<string, string[]> } {
  const out = JSON.parse(JSON.stringify(d)) as Dump;
  const drawn: Record<string, string[]> = {};
  for (const [name, rec] of Object.entries(out)) {
    const steps = rec.steps as Record<string, Step>;
    drawn[name] = [];
    for (const k of ["sample", "status"]) {
      steps[k]!.out = steps[k]!.out.map((l) => {
        // A draw that repeats an earlier change says so ("drawn before"). The draws differ from run to run (the key, and
        // so the registration the draws are bound to, is made per run), so a repeat comes and goes: it is drawn, and
        // its line is hidden like any other.
        const m = /^  #\s+(\d+)  (\S+)  \S+(?:  \(drawn before: reuses its verdict\))?$/.exec(l) ?? /^  blocking draw: #(\d+) (\S+) \S+$/.exec(l);
        if (!m) return l;
        if (k === "sample") drawn[name]!.push(m[2]!);
        return l.replace(m[2]!, "<drawn>").replace(/https:\S+.*$/, "<url>");
      });
    }
  }
  return { dump: out, drawn };
}

const ROOT = join(__dirname, "..");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

const DUMP = String.raw`import { it } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const R = process.env.ANCHOR_ROOT, OUT = process.env.ANCHOR_OUT, KEY = process.env.ANCHOR_KEY;
const strip = (v) => (Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "signature").map(([k, x]) => [k, strip(x)])) : v);
it("dump", async () => {
  const { freezeCommand } = await import(R + "/src/commands/freeze.ts");
  const { registerCommand } = await import(R + "/src/commands/register.ts");
  const { runVerify, verifyCommand } = await import(R + "/src/commands/verify.ts");
  const { sampleCommand } = await import(R + "/src/commands/sample.ts");
  const { statusCommand } = await import(R + "/src/commands/status.ts");
  const { makeChanges, setupAuditRepo, T } = await import(R + "/test/helpers/audit-scenario.ts");
  const { fakeOrg } = await import(R + "/test/helpers/fake-org.ts");
  const result = {};
  const scenario = async (name, s, after) => {
    const rec = { steps: {} };
    mkdirSync(join(s.dir, ".pr-rla"), { recursive: true });
    copyFileSync(KEY, join(s.dir, ".pr-rla/signing-key.pem"));
    const step = async (label, f) => {
      const from = s.out.length;
      try {
        rec.steps[label] = { value: await f() };
      } catch (e) {
        rec.steps[label] = { threw: e.message, exitCode: e.exitCode ?? null };
      }
      rec.steps[label].out = s.out.slice(from);
    };
    const report = async () => { const v = await runVerify(s.ctx, { offline: false }); return { ok: v.ok, mode: v.mode, checks: v.checks.map((c) => [c.n, c.status, c.summary, c.details.filter((d) => !/signature|by \d{4}-|written/.test(d))]) }; };
    s.clock.now = T("2026-10-20T00:00:00Z");
    await step("register", () => registerCommand(s.ctx, {}));
    // P4: a branch registration signs the git-file ledger's path in (ledgerPath), which master's never did. Re-signed
    // without it (same key), the registration and everything derived from it (manifest, draws) compare with master's.
    const regFile = join(s.dir, "audit/2026-q3/registration.json");
    if (existsSync(regFile)) {
      const signed = JSON.parse(readFileSync(regFile, "utf8"));
      if (signed.record.ledgerPath !== undefined) {
        const { loadOrCreateKey, signRecord } = await import(R + "/src/core/signing.ts");
        const { ledgerPath, ...record } = signed.record;
        rec.ledgerPath = ledgerPath;
        writeFileSync(regFile, JSON.stringify({ ...signed, ...signRecord(record, loadOrCreateKey(KEY)) }, null, 2) + "\n");
      }
    }
    s.clock.now = T("2026-10-20T06:00:00Z");
    await step("statusBeforeFreeze", () => statusCommand(s.ctx, {}));
    s.clock.now = T("2026-10-20T12:00:00Z");
    await step("freeze", () => freezeCommand(s.ctx, {}));
    for (const f of ["audit/2026-q3/registration.json", "audit/2026-q3.manifest.json", "audit/2026-q3/manifest-commitment.json"]) rec[f] = existsSync(join(s.dir, f)) ? strip(JSON.parse(readFileSync(join(s.dir, f), "utf8"))) : null;
    await step("verify", report);
    await step("verifyCommand", () => verifyCommand(s.ctx, {}));
    s.clock.now = T("2026-10-21T01:00:00Z");
    await step("sample", () => sampleCommand(s.ctx, { through: 5 }));
    await step("status", () => statusCommand(s.ctx, {}));
    if (after) await step("after", () => after(s, report));
    result[name] = rec;
  };
  await scenario("json400", setupAuditRepo({ changes: makeChanges(400) }));
  const org1 = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 120, pushes: 25, after: 3 }] });
  await scenario("github1", setupAuditRepo({ changes: [], provider: "github", fetch: org1.fetch }), async (s, report) => {
    org1.removeRepo("widgets");
    return report();
  });
  const org2 = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 0, pushes: 0, empty: true }] });
  await scenario("githubEmpty", setupAuditRepo({ changes: [], provider: "github", fetch: org2.fetch }));
  // P3: the head moves after freeze, by every honest shape the second review listed (GitHub records each push when it
  // happens, after the freeze at 12:00); verify runs a week later.
  const shapes = {
    postWindowLinear: (org) => { const h = org.history("widgets").head; org.pushCommits("widgets", [{ oid: sha1("p1"), date: "2026-10-22T09:00:00Z", parents: [h] }, { oid: sha1("p2"), date: "2026-10-23T09:00:00Z", parents: [sha1("p1")] }], { at: "2026-10-23T09:05:00Z" }); },
    fr72LateMerge: (org) => { const h = org.history("widgets"); const ph = h.commits.find((c) => c.oid === h.head).parents[0]; org.pushCommits("widgets", [{ oid: sha1("lc"), date: "2026-09-30T12:00:00Z", parents: [ph] }, { oid: sha1("lm"), date: "2026-10-25T09:00:00Z", parents: [h.head, sha1("lc")] }], { at: "2026-10-25T09:00:00Z" }); },
    backdatedPush: (org) => { const h = org.history("widgets").head; org.pushCommits("widgets", [{ oid: sha1("bd"), date: "2026-09-30T20:00:00Z", parents: [h] }], { at: "2026-10-20T15:00:00Z" }); },
    foxtrotPull: (org) => { const h = org.history("widgets"); const old = h.commits.find((c) => c.oid === h.head).parents[0]; const old2 = h.commits.find((c) => c.oid === old).parents[0]; org.pushCommits("widgets", [{ oid: sha1("local"), date: "2026-09-30T21:00:00Z", parents: [old2] }, { oid: sha1("pull"), date: "2026-10-26T09:00:00Z", parents: [sha1("local"), h.head] }], { at: "2026-10-26T09:00:00Z" }); },
    foxtrotPullAfterDated: (org) => { const h = org.history("widgets"); const old = h.commits.find((c) => c.oid === h.head).parents[0]; org.pushCommits("widgets", [{ oid: sha1("local2"), date: "2026-10-21T21:00:00Z", parents: [old] }, { oid: sha1("pull2"), date: "2026-10-26T09:00:00Z", parents: [sha1("local2"), h.head] }], { at: "2026-10-26T09:00:00Z" }); },
    ffLocal: (org) => { const h = org.history("widgets").head; org.pushCommits("widgets", [{ oid: sha1("ff1"), date: "2026-09-29T10:00:00Z", parents: [h] }, { oid: sha1("ff2"), date: "2026-09-30T10:00:00Z", parents: [sha1("ff1")] }], { at: "2026-10-27T10:00:00Z" }); },
  };
  result.moved = {};
  for (const [name, push] of Object.entries(shapes)) {
    const org = fakeOrg({ owner: "acme", seed: 5, repos: [{ name: "widgets", prs: 120, pushes: 25, after: 3 }] });
    const s = setupAuditRepo({ changes: [], provider: "github", fetch: org.fetch });
    mkdirSync(join(s.dir, ".pr-rla"), { recursive: true });
    copyFileSync(KEY, join(s.dir, ".pr-rla/signing-key.pem"));
    s.clock.now = T("2026-10-20T00:00:00Z");
    await registerCommand(s.ctx, {});
    s.clock.now = T("2026-10-20T12:00:00Z");
    await freezeCommand(s.ctx, {});
    push(org);
    s.clock.now = T("2026-10-28T00:00:00Z");
    const v = await runVerify(s.ctx, { offline: false });
    const from = s.out.length;
    const code = await verifyCommand(s.ctx, {});
    result.moved[name] = { ok: v.ok, statuses: v.checks.map((c) => [c.n, c.status]), c5: v.checks.find((c) => c.n === 5).details, code, last: s.out.slice(from).at(-1) };
  }
  writeFileSync(OUT, JSON.stringify(result).replace(/\/(private\/)?(var|tmp)\/[^"\s]*?prrla-audit-[A-Za-z0-9]+/g, "<DIR>"));
});
`;

function dump(root: string, work: string, key: string, name: string): Record<string, Record<string, unknown>> {
  const cfg = join(work, `${name}.config.mts`);
  const test = join(work, `${name}.anchor.test.ts`);
  const out = join(work, `${name}.json`);
  writeFileSync(test, DUMP);
  writeFileSync(
    cfg,
    `import { defineConfig } from "vitest/config";
const R = ${JSON.stringify(root)};
export default defineConfig({
  resolve: { alias: { "pr-rla/provider": R + "/src/sdk/provider.ts", "pr-rla/ledger": R + "/src/sdk/ledger.ts", "pr-rla/testing": R + "/src/testing/index.ts" } },
  server: { fs: { strict: false } },
  test: { include: [${JSON.stringify(`${name}.anchor.test.ts`)}], setupFiles: [R + "/test/setup/network-deny.ts"], testTimeout: 280_000 },
});
`,
  );
  execFileSync(process.execPath, [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", cfg, "--root", work], { cwd: work, env: { ...process.env, ANCHOR_ROOT: root, ANCHOR_OUT: out, ANCHOR_KEY: key }, stdio: "pipe", timeout: 290_000 });
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, Record<string, unknown>>;
}

it("hideDraws counts a repeated draw and hides its line like any other (the comparison below flaked when a run drew a repeat)", () => {
  const rec = (lines: string[]) => ({ steps: { sample: { out: lines }, status: { out: [] } } });
  const h = hideDraws({
    a: rec(["  #  1  json:acme/widgets#7  https://x/7", "  #  2  json:acme/widgets#7  https://x/7  (drawn before: reuses its verdict)"]),
    b: rec(["  #  1  json:acme/widgets#7  https://x/7", "  #  2  json:acme/widgets#9  https://x/9"]),
  });
  expect(h.drawn).toEqual({ a: ["json:acme/widgets#7", "json:acme/widgets#7"], b: ["json:acme/widgets#7", "json:acme/widgets#9"] });
  expect((h.dump.a!.steps as Record<string, Step>).sample!.out).toEqual((h.dump.b!.steps as Record<string, Step>).sample!.out);
});

describe("single-repo audits behave as master does (a pool of one), against the master build itself", () => {
  it("json-file (400 changes), a GitHub repo, an empty GitHub repo, and a GitHub repo whose head moved after freeze in six honest ways: every output, record and verify result is master's, but for the listed U8 and P3 changes", { timeout: 300_000 }, () => {
    // master here, or origin/master in a fresh clone of this branch.
    const commit = (name: string) => {
      try {
        return git("rev-parse", "--verify", "-q", `${name}^{commit}`);
      } catch {
        return "";
      }
    };
    const master = commit("master") || commit("origin/master");
    expect(master).toMatch(/^[0-9a-f]{40}$/);
    const base = git("merge-base", "HEAD", master);
    const work = mkdtempSync(join(tmpdir(), "prrla-anchor-"));
    symlinkSync(join(ROOT, "node_modules"), join(work, "node_modules"));
    try {
      const baseRoot = join(work, "master");
      mkdirSync(baseRoot);
      execFileSync("sh", ["-c", `git -C ${JSON.stringify(ROOT)} archive ${base} | tar -x -C ${JSON.stringify(baseRoot)}`]);
      symlinkSync(join(ROOT, "node_modules"), join(baseRoot, "node_modules"));
      for (const f of ["test/helpers/fake-org.ts", "test/helpers/fake-github.ts"]) copyFileSync(join(ROOT, f), join(baseRoot, f));
      const key = join(work, "signing-key.pem");
      loadOrCreateKey(key);
      const before = dump(baseRoot, work, key, "master");
      const now = dump(ROOT, work, key, "branch");

      // The intended single-repo changes of the U8 fix round, of P4, of P3 and of time round B, and nothing else:
      // 1. a single repo deleted after freeze: master's verify threw the provider's error; it is now INCOMPLETE (exit 6);
      const after = (now.github1!.steps as Record<string, { value?: { ok: boolean; checks: unknown[][] } }>).after!.value!;
      expect((before.github1!.steps as Record<string, { threw?: string }>).after!.threw).toMatch(/^GitHub POST \/graphql: HTTP 404/);
      expect(after.ok).toBe(false);
      //    P1: verify runs on its own read-only context (as a separate `pr-rla verify` does), so only its own reads count
      //    for time round B's access rule: both were anonymous and answered 404, which a private repo answers too.
      expect(after.checks.find((c) => c[0] === 5)!.slice(1, 3)).toEqual(["INCOMPLETE", "population 0/0 match · 104 changes in 1 repo(s) could not be rebuilt · not established: read without its credential"]);
      delete (before.github1!.steps as Record<string, unknown>).after;
      delete (now.github1!.steps as Record<string, unknown>).after;
      // 2. P4: register signs the git-file ledger's path in and prints it (so its first line's hash covers the path), and
      //    status WARNs on the re-signed registration that lacks it (see DUMP). Each is checked, then set aside.
      type Steps = Record<string, { out: string[] }>;
      // (P3's moved-head shapes, `moved`, are compared on their verdicts in step 4.)
      for (const name of Object.keys(now).filter((n) => n !== "moved")) {
        expect(now[name]!.ledgerPath, name).toBe("audit/2026-q3/verdicts.jsonl");
        delete now[name]!.ledgerPath;
        const reg = (now[name]!.steps as Steps).register!;
        expect(reg.out, name).toContain("  ledger path audit/2026-q3/verdicts.jsonl (signed in: verify reads the ledger only there)");
        reg.out = reg.out.filter((l) => !l.startsWith("  ledger path "));
        for (const d of [now, before]) {
          const r = (d[name]!.steps as Steps).register!;
          r.out = r.out.map((l) => l.replace(/^registration [0-9a-f]{12}…/, "registration <sha256>…"));
        }
        const status = (now[name]!.steps as Steps).status;
        const warn = /^ {2}WARN the registration does not record the git-file ledger's path/;
        // Only the status of a sampled audit reads the ledger, and so prints the line.
        if (status?.out.some((l) => /^prefix /.test(l))) expect(status.out, name).toContainEqual(expect.stringMatching(warn));
        if (status) status.out = status.out.filter((l) => !warn.test(l));
      }
      expect(((now.json400!.steps as Steps).status!.out ?? []).length).toBeGreaterThan(0);
      // 3. P3: a GitHub manifest records what the push log showed about its head (headEvidence), so its sha and the
      // commitment's differ; verify says so in one line of check 5.
      const m = now.github1!["audit/2026-q3.manifest.json"] as { headEvidence?: unknown; sha256: string };
      expect(m.headEvidence).toEqual([{ repo: "acme/widgets", headSha: "29791b4e876b9ec17c0392c6208ab7f64bdcdbec", status: "tip", since: "2026-10-04T00:00:00Z", event: expect.stringMatching(/^\d+$/), detail: expect.stringMatching(/^it became the default branch's tip at 2026-10-04T00:00:00Z \(update \d+, fast-forward\)$/) }]);
      const unhash = (r: Record<string, unknown>) => {
        const x = structuredClone(r) as Record<string, Record<string, unknown>> & { steps: Record<string, { out: string[]; value?: { checks: unknown[][] } }> };
        delete x["audit/2026-q3.manifest.json"]?.headEvidence;
        delete x["audit/2026-q3.manifest.json"]?.sha256;
        const c = x["audit/2026-q3/manifest-commitment.json"] as { record?: { manifestSha256?: string }; sha256?: string } | null;
        if (c?.record) delete c.record.manifestSha256;
        if (c) delete c.sha256;
        for (const st of Object.values(x.steps)) {
          st.out = st.out.filter((l) => !/^ *push log: /.test(l)).map((l) => l.replace(/^manifest [0-9a-f]{64} /, "manifest <sha> "));
          for (const ch of st.value?.checks ?? []) if (Array.isArray(ch[3])) ch[3] = (ch[3] as string[]).filter((d) => !d.startsWith("push log: "));
        }
        return x;
      };
      now.github1 = unhash(now.github1!);
      before.github1 = unhash(before.github1!);
      // 4. P3, moved heads: every honest shape is VERIFIED on master; here, with no timestamp authority in these
      // scenarios, time round B's rules make checks 1-3 INCOMPLETE (unproven times), and nothing else differs check by
      // check (P3: the push log places the window commits the frozen head does not reach; U8 had FAILed three of them).
      const moved = (r: Record<string, unknown>) => r.moved as Record<string, { ok: boolean; statuses: [number, string][]; c5: string[]; code: number; last: string }>;
      const roundB = (statuses: [number, string][]) => statuses.map(([n, st]) => [n, (n === 1 || n === 2) && st === "WARN" ? "INCOMPLETE" : n === 3 && st === "PASS" ? "INCOMPLETE" : st]);
      expect(Object.keys(moved(now))).toHaveLength(6);
      for (const [name, b] of Object.entries(moved(now))) {
        const a = moved(before)[name]!;
        expect({ name, ok: a.ok, code: a.code, last: a.last }).toEqual({ name, ok: true, code: 0, last: "VERIFIED" });
        expect({ name, ok: b.ok, statuses: b.statuses, code: b.code }).toEqual({ name, ok: false, statuses: roundB(a.statuses), code: 6 });
        expect(b.statuses.filter(([, st]) => st === "FAIL")).toEqual([]);
        expect(b.last).toMatch(/^INCOMPLETE: check 1 \(registration\), check 2 \(manifest before seed\), check 3 \(seed round\) could not be established; .*nothing failed, but this is not a verification \(exit 6\)$/);
        if (["fr72LateMerge", "backdatedPush", "foxtrotPull", "ffLocal"].includes(name)) expect(b.c5.join("\n")).toMatch(/reached the default branch after the window closed, not through the frozen head .*\(FR7\.2\)/);
      }
      delete now.moved;
      delete before.moved;
      // 5. time round B: the registration names its signing key (the one the scenarios share), inside its signed bytes.
      const pem = (k: string) => createPublicKey(readFileSync(k, "utf8")).export({ type: "spki", format: "pem" }).toString();
      for (const rec of Object.values(now)) {
        const reg = rec["audit/2026-q3/registration.json"] as { record: Record<string, unknown>; publicKeyPem: string };
        expect(reg.record.publicKeyPem).toBe(pem(key));
        expect(reg.publicKeyPem).toBe(pem(key));
        delete reg.record.publicKeyPem;
      }
      // ... and the draws are bound to it: each build draws as its contract says (v1/master: the manifest's hash).
      const a = hideDraws(placeholders(before));
      const b = hideDraws(placeholders(now));
      const ids = (dump: Dump, which: "manifest" | "registration") => {
        const rec = dump.json400!;
        const m = rec["audit/2026-q3.manifest.json"] as { sha256: string; changes: { id: string }[] };
        const binding = which === "manifest" ? m.sha256 : (rec["audit/2026-q3/registration.json"] as { sha256: string }).sha256;
        return computeDraws(recordedBeacon(33245812).randomness, binding, m.changes.length, 5).map((x) => m.changes[x.index]!.id);
      };
      expect(a.drawn.json400).toEqual(ids(before, "manifest"));
      expect(b.drawn.json400).toEqual(ids(now, "registration"));
      expect(b.drawn.json400).not.toEqual(a.drawn.json400);
      // 6. nothing else: commands, their stdout, the records and verify's results are master's, after time round B's rules.
      expect(b.dump).toEqual(timeRoundB(a.dump));
      // And the scenarios really ran: master's own outputs, checked here so that an empty dump cannot pass.
      const steps = (s: string) => now[s]!.steps as Record<string, { value?: unknown; threw?: string; out: string[] }>;
      expect(steps("json400").freeze!.value).toBe(0);
      expect((now.json400!["audit/2026-q3.manifest.json"] as { N: number }).N).toBe(400);
      expect(steps("github1").verifyCommand!.out.at(-1)).toMatch(/^INCOMPLETE: check 1 \(registration\)/);
      expect((before.github1!.steps as Record<string, { out: string[] }>).verifyCommand!.out.at(-1)).toBe("VERIFIED");
      expect((now.github1!["audit/2026-q3.manifest.json"] as { repos: unknown[] }).repos).toEqual([{ repo: "acme/widgets", repoId: null, defaultBranch: "main", headSha: "29791b4e876b9ec17c0392c6208ab7f64bdcdbec" }]);
      expect(steps("githubEmpty").freeze!.threw).toBe("acme/widgets has no default branch");
      expect(steps("githubEmpty").statusBeforeFreeze!.threw).toBe("acme/widgets has no default branch");
      expect(now.githubEmpty!["audit/2026-q3.manifest.json"]).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
