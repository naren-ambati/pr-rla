import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateKey } from "../src/core/signing.js";

/**
 * A single repo is a pool of one, and existing single-repo audits behave as master does (FR5.1; test-design U8; the
 * review's anchor finding). This test builds the master build itself: `git archive` of the commit this branch left
 * master at (`git merge-base HEAD master`), extracted into a temp dir with this checkout's node_modules, and runs the
 * same scenarios on both builds in child vitest runs at a fixed clock with one signing key: register, status, freeze,
 * verify (the report and verify's own output), sample, status. It compares every command's result and stdout, and the
 * registration, manifest and commitment bodies (signatures aside: ECDSA signatures are randomised).
 *
 * The fakes (test/helpers/fake-org.ts, fake-github.ts) are this checkout's, copied into the master tree, so both builds
 * read the same synthetic data. Fixture kind: synthetic. The intended differences for single repos are listed below.
 */
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

      // The intended single-repo changes of the U8 fix round, of P4 and of P3, and nothing else:
      // 1. a single repo deleted after freeze: master's verify threw the provider's error; it is now INCOMPLETE (exit 6);
      const after = (now.github1!.steps as Record<string, { value?: { ok: boolean; checks: unknown[][] } }>).after!.value!;
      expect((before.github1!.steps as Record<string, { threw?: string }>).after!.threw).toMatch(/^GitHub POST \/graphql: HTTP 404/);
      expect(after.ok).toBe(false);
      expect(after.checks.find((c) => c[0] === 5)!.slice(1, 3)).toEqual(["INCOMPLETE", "population 0/0 match · 104 changes in 1 repo(s) could not be rebuilt"]);
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
      // 4. P3, moved heads: every honest shape is VERIFIED on both builds, check by check (P3: the push log places the
      // window commits the frozen head does not reach; U8 had FAILed three of them).
      const moved = (r: Record<string, unknown>) => r.moved as Record<string, { ok: boolean; statuses: unknown[]; c5: string[]; code: number; last: string }>;
      expect(Object.keys(moved(now))).toHaveLength(6);
      for (const [name, b] of Object.entries(moved(now))) {
        const a = moved(before)[name]!;
        expect({ name, ok: b.ok, statuses: b.statuses, code: b.code, last: b.last }).toEqual({ name, ok: a.ok, statuses: a.statuses, code: a.code, last: a.last });
        expect(b.last).toBe("VERIFIED");
        if (["fr72LateMerge", "backdatedPush", "foxtrotPull", "ffLocal"].includes(name)) expect(b.c5.join("\n")).toMatch(/reached the default branch after the window closed, not through the frozen head .*\(FR7\.2\)/);
      }
      delete now.moved;
      delete before.moved;
      // 5. nothing else: commands, their stdout, the records and verify's results are byte for byte master's.
      expect(now).toEqual(before);
      // And the scenarios really ran: master's own outputs, checked here so that an empty dump cannot pass.
      const steps = (s: string) => now[s]!.steps as Record<string, { value?: unknown; threw?: string; out: string[] }>;
      expect(steps("json400").freeze!.value).toBe(0);
      expect((now.json400!["audit/2026-q3.manifest.json"] as { N: number }).N).toBe(400);
      expect(steps("github1").verifyCommand!.out.at(-1)).toBe("VERIFIED");
      expect((now.github1!["audit/2026-q3.manifest.json"] as { repos: unknown[] }).repos).toEqual([{ repo: "acme/widgets", repoId: null, defaultBranch: "main", headSha: "29791b4e876b9ec17c0392c6208ab7f64bdcdbec" }]);
      expect(steps("githubEmpty").freeze!.threw).toBe("acme/widgets has no default branch");
      expect(steps("githubEmpty").statusBeforeFreeze!.threw).toBe("acme/widgets has no default branch");
      expect(now.githubEmpty!["audit/2026-q3.manifest.json"]).toBeNull();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
