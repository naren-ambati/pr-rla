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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  test: { include: [${JSON.stringify(`${name}.anchor.test.ts`)}], setupFiles: [R + "/test/setup/network-deny.ts"], testTimeout: 120_000 },
});
`,
  );
  execFileSync(process.execPath, [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", cfg, "--root", work], { cwd: work, env: { ...process.env, ANCHOR_ROOT: root, ANCHOR_OUT: out, ANCHOR_KEY: key }, stdio: "pipe", timeout: 170_000 });
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, Record<string, unknown>>;
}

describe("single-repo audits behave as master does (a pool of one), against the master build itself", () => {
  it("json-file (400 changes), a GitHub repo, and an empty GitHub repo: every output, record and verify result is master's, but for the listed U8 changes", { timeout: 180_000 }, () => {
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

      // The intended single-repo changes of the U8 fix round and of P4, and nothing else:
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
      for (const name of Object.keys(now)) {
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
      // 3. nothing else: commands, their stdout, the records and verify's results are byte for byte master's.
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
