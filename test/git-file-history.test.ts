import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { gitSafeArgs, gitSafeEnv, gitSafeText } from "../src/io/git-safe.js";
import { readFileHistory } from "../src/ledgers/git-history.js";
import { createLedger } from "../src/registry.js";
import type { Ledger } from "../src/sdk/ledger.js";
import { commitAll } from "./helpers/signed-commits.js";

/**
 * The git-file ledger's append-only walk (U9, after review): every version of verdicts.jsonl, in
 * every commit reachable from HEAD through the parents its raw commit object names, must extend each
 * parent's version. Objects are read by `git cat-file --batch` and checked to hash to their names;
 * no `git log`, rev-list simplification, blame, rename following, textconv, commit-graph, graft or
 * replace ref is trusted, and a shallow repository is refused. Local repositories only (D8).
 */
const P = "cd".repeat(32);
const REL = "audit/w/verdicts.jsonl";
const line = (draw: number, verdict = "pass") => `${JSON.stringify({ changeId: `json:acme/widgets#${100 + draw}`, draw, protocolSha256: P, recordedAt: "2026-10-21T03:00:00Z", reviewer: "bob", schema: "pr-rla/verdict/v1", verdict })}\n`;
let dir: string;
const git = (d: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=user-1a2b3c4d@example.invalid", ...args], { cwd: d, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const ledgerIn = (d: string, opts: Record<string, unknown> = {}): Promise<Ledger> => createLedger({ use: "git-file", options: opts }, { cwd: d, windowDir: join(d, "audit/w"), env: {}, log: () => {}, fetch: globalThis.fetch });
const append = (d: string, ...lines: string[]) => appendFileSync(join(d, REL), lines.join(""));
const write = (d: string, ...lines: string[]) => writeFileSync(join(d, REL), lines.join(""));
const integrity = async (d: string) => (await ledgerIn(d)).verifyIntegrity!();
function newRepo(objectFormat?: string): string {
  const d = mkdtempSync(join(tmpdir(), "prrla-walk-"));
  mkdirSync(join(d, "audit/w"), { recursive: true });
  git(d, "init", "-q", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []));
  writeFileSync(join(d, "README"), "audit\n");
  commitAll(d, "audit repo", null);
  return d;
}

beforeEach(() => {
  dir = newRepo();
});

describe("git-file reads lines, and credits none to a commit", () => {
  it("a level a line claims for itself is dropped; the signature fields it carries are kept for the core to check", async () => {
    writeFileSync(join(dir, REL), `${JSON.stringify({ ...JSON.parse(line(1)), provenance: { level: "presence", source: "verdict-signature" }, registrationSha256: "ab".repeat(32), sshsig: "U1NIU0lH" })}\n`);
    const [v] = await (await ledgerIn(dir)).readVerdicts();
    expect(v!.provenance).toBeUndefined();
    expect(v).toMatchObject({ draw: 1, registrationSha256: "ab".repeat(32), sshsig: "U1NIU0lH" });
  });

  it("outside a git repository there is no tamper trail", async () => {
    const bare = mkdtempSync(join(tmpdir(), "prrla-nogit-"));
    mkdirSync(join(bare, "audit/w"), { recursive: true });
    writeFileSync(join(bare, REL), line(1));
    expect((await integrity(bare)).findings).toEqual(["verdicts are not in a git repository: there is no tamper trail"]);
  });

  it("options: require_signed must be true or false; file must be a name", async () => {
    await expect(ledgerIn(dir, { require_signed: "yes" })).rejects.toThrow(/option require_signed must be true or false/);
    await expect(ledgerIn(dir, { file: 3 })).rejects.toThrow(/option file must be a file name/);
    await expect(ledgerIn(dir, { require_signed: true })).resolves.toMatchObject({ name: "git-file" });
  });
});

describe("the append-only walk over the whole history", () => {
  it("linear appends pass; an uncommitted line is noted; findings read as before U9", async () => {
    append(dir, line(1));
    commitAll(dir, "draw 1", null);
    append(dir, line(2), line(3));
    commitAll(dir, "draws 2 and 3", null);
    append(dir, line(4));
    expect(await integrity(dir)).toEqual({ ok: true, tamperTrail: true, findings: ["1 verdict line(s) not yet committed (no tamper trail for them until committed)"] });
  });

  it("a rewrite, a deletion, and a working tree that rewrites history all FAIL, naming the commit", async () => {
    append(dir, line(1, "fail"));
    commitAll(dir, "draw 1", null);
    write(dir, line(1, "pass"));
    const rewrite = commitAll(dir, "flip", null);
    expect(await integrity(dir)).toMatchObject({ ok: false, findings: [`${REL} was rewritten (not appended) in commit ${rewrite.slice(0, 10)}`] });
    git(dir, "rm", "-q", REL);
    const del = commitAll(dir, "delete", null);
    expect((await integrity(dir)).findings).toContain(`${REL} was deleted in commit ${del.slice(0, 10)}`);
    const d2 = newRepo();
    append(d2, line(1), line(2));
    commitAll(d2, "two", null);
    write(d2, line(2));
    expect(await integrity(d2)).toMatchObject({ ok: false, findings: [`${REL} in the working tree rewrites its committed history`] });
  });

  it("a line merged in from another branch passes: the merge extends both parents", async () => {
    append(dir, line(1));
    commitAll(dir, "draw 1", null);
    git(dir, "checkout", "-q", "-b", "side");
    append(dir, line(2));
    commitAll(dir, "draw 2 on a branch", null);
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "side");
    expect(await integrity(dir)).toEqual({ ok: true, tamperTrail: true, findings: [] });
  });

  it("finding 2: a removal on a branch merged in FAILs, even when the merge hides it from `git log -- path`", async () => {
    // exp3: the ledger moves away on a side branch, a merge into a branch cut before any verdict is TREESAME for the path, and it comes back without the FAIL.
    const root = git(dir, "rev-parse", "HEAD");
    append(dir, line(1));
    commitAll(dir, "draw 1", null);
    append(dir, line(2, "fail"));
    commitAll(dir, "draw 2 fail", null);
    git(dir, "checkout", "-q", "-b", "side");
    git(dir, "mv", REL, "audit/w/tmp.jsonl");
    const moved = commitAll(dir, "move", null);
    git(dir, "checkout", "-q", "-b", "clean", root);
    git(dir, "merge", "-q", "--no-ff", "-m", "merge", "side");
    git(dir, "mv", "audit/w/tmp.jsonl", REL);
    write(dir, line(1));
    commitAll(dir, "restore", null);
    expect(git(dir, "log", "--format=%s", "--", REL).split("\n")).toEqual(["restore"]); // what the old walk saw
    const r = await integrity(dir);
    expect(r.ok).toBe(false);
    expect(r.findings).toContain(`${REL} was deleted in commit ${moved.slice(0, 10)}`);
  });

  it("two branches that each appended, merged, FAIL: no version of the merge extends both (record on one branch)", async () => {
    append(dir, line(1));
    commitAll(dir, "draw 1", null);
    git(dir, "checkout", "-q", "-b", "side");
    append(dir, line(2));
    commitAll(dir, "draw 2", null);
    git(dir, "checkout", "-q", "main");
    append(dir, line(3));
    commitAll(dir, "draw 3", null);
    try {
      git(dir, "merge", "-q", "-m", "merge", "side");
    } catch {
      write(dir, line(1), line(3), line(2));
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "merge, both kept");
    }
    expect(git(dir, "rev-list", "--parents", "-1", "HEAD").split(" ")).toHaveLength(3);
    const r = await integrity(dir);
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([expect.stringMatching(/was rewritten \(not appended\) in commit/)]);
  });

  it("a path that is not a regular file in some commit FAILs", async () => {
    writeFileSync(join(dir, "elsewhere"), line(1));
    symlinkSync("../../elsewhere", join(dir, REL));
    const c = commitAll(dir, "a symlink", null);
    expect(await integrity(dir)).toMatchObject({ ok: false, findings: expect.arrayContaining([`${REL} is not a regular file in commit ${c.slice(0, 10)}`]) });
  });

  it("works in a SHA-256 repository", async () => {
    const d = newRepo("sha256");
    append(d, line(1));
    const c1 = commitAll(d, "one", null);
    expect(c1).toMatch(/^[0-9a-f]{64}$/);
    append(d, line(2));
    commitAll(d, "two", null);
    expect(await integrity(d)).toEqual({ ok: true, tamperTrail: true, findings: [] });
    write(d, line(2));
    const c3 = commitAll(d, "drop one", null);
    expect((await integrity(d)).findings).toEqual([`${REL} was rewritten (not appended) in commit ${c3.slice(0, 10)}`]);
  });
});

describe("finding 1: a cut history is refused, not trusted", () => {
  const full = () => {
    append(dir, line(1, "fail"));
    commitAll(dir, "draw 1 fail", null);
    write(dir, line(2));
    commitAll(dir, "remove the fail", null);
    writeFileSync(join(dir, "README"), "docs\n");
    return commitAll(dir, "unrelated tip", null);
  };

  it("a depth-1 clone (a CI checkout's default) FAILs with what to run instead", async () => {
    full();
    const sh = join(mkdtempSync(join(tmpdir(), "prrla-shallow-")), "c");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, sh], { stdio: "ignore" });
    const r = await integrity(sh);
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([expect.stringMatching(/^audit\/w\/verdicts.jsonl: the repository is a shallow clone \(.*shallow\): its history is cut, .*; verify in a full clone: run `git fetch --unshallow` here, or `git clone` without `--depth` or `--filter`$/)]);
  });

  it("a hand-written .git/shallow and a grafts file are refused too", async () => {
    const tip = full();
    writeFileSync(join(dir, ".git/shallow"), `${tip}\n`);
    expect((await integrity(dir)).findings[0]).toMatch(/the repository is a shallow clone/);
    renameSync(join(dir, ".git/shallow"), join(dir, ".git/info/grafts"));
    expect((await integrity(dir)).findings[0]).toMatch(/the repository has a grafts file \(.*grafts\), which makes git present other commit parents than the objects hold/);
  });

  it("a parent missing from the object store makes the history incomplete", async () => {
    append(dir, line(1));
    const first = commitAll(dir, "one", null);
    append(dir, line(2));
    commitAll(dir, "two", null);
    // Hide the first commit's object (a partial copy of a repository), with no shallow file to say so.
    const loose = join(dir, ".git/objects", first.slice(0, 2), first.slice(2));
    renameSync(loose, `${loose}.hidden`);
    const r = await integrity(dir);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatch(new RegExp(`names parent ${first.slice(0, 10)}, which is not in this repository: the history is incomplete`));
  });
});

describe("a partial clone is refused, and nothing is fetched (review of U5)", () => {
  const packs = (d: string) => readdirSync(join(d, ".git/objects/pack")).filter((f) => f.endsWith(".pack")).length;
  /** A bare origin holding a ledger history whose older versions a blob:none clone lacks. */
  function origin(): string {
    append(dir, line(1, "fail"));
    commitAll(dir, "draw 1 fail", null);
    write(dir, line(1, "pass"));
    commitAll(dir, "flip", null);
    append(dir, line(2));
    commitAll(dir, "draw 2", null);
    const bare = join(mkdtempSync(join(tmpdir(), "prrla-origin-")), "audit.git");
    git(dir, "init", "-q", "--bare", "-b", "main", bare);
    git(dir, "push", "-q", bare, "main");
    git(bare, "config", "uploadpack.allowfilter", "true");
    return bare;
  }
  const partialClone = (bare: string) => {
    const c = join(mkdtempSync(join(tmpdir(), "prrla-partial-")), "c");
    execFileSync("git", ["clone", "-q", "--filter=blob:none", `file://${bare}`, c], { stdio: "ignore" });
    return c;
  };

  it("--filter=blob:none: verify refuses with what to run instead, and the pack count does not change", async () => {
    const c = partialClone(origin());
    const before = packs(c);
    expect(git(c, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/);
    const r = await integrity(c);
    expect(r.ok).toBe(false);
    expect(r.findings).toEqual([expect.stringMatching(/^audit\/w\/verdicts.jsonl: the repository is a partial clone \(.*\): objects it lacks would be fetched from its remote, so its history cannot be read here as it is; verify in a full clone: .*`git clone` without `--depth` or `--filter`$/)]);
    expect(r.findings.join("\n")).not.toMatch(/deleted/);
    expect(packs(c)).toBe(before);
  });

  it("the walk itself fetches nothing: a missing object is reported as missing, never as a deletion", async () => {
    const c = partialClone(origin());
    const before = packs(c);
    const h = await readFileHistory(c, REL);
    expect(h.problems.length).toBeGreaterThan(0);
    for (const p of h.problems) expect(p).toMatch(/^blob [0-9a-f]{10} \(commit [0-9a-f]{10}\) is missing or does not hash to its name$/);
    expect(packs(c)).toBe(before);
    // Plain git, by contrast, fetches the missing blob from the origin: the hazard the guard closes.
    execFileSync("git", ["cat-file", "-p", `HEAD~2:${REL}`], { cwd: c, stdio: "ignore" });
    expect(packs(c)).toBeGreaterThan(before);
  });
});

describe("finding 5: what the verifier's git could be told does not change what the objects say", () => {
  /** A FAIL recorded, removed, and a PASS appended: the removal is in commit `removed`. */
  function removal(d: string): { removed: string; skip: string; tip: string } {
    append(d, line(1));
    const skip = commitAll(d, "draw 1", null);
    append(d, line(2, "fail"));
    commitAll(d, "draw 2 fail", null);
    write(d, line(1));
    const removed = commitAll(d, "drop the fail", null);
    append(d, line(2, "pass"));
    const tip = commitAll(d, "draw 2 pass", null);
    return { removed, skip, tip };
  }

  it("a lying commit-graph (it skips the removal) is never read", async () => {
    const { removed, skip, tip } = removal(dir);
    git(dir, "commit-graph", "write", "--reachable");
    const f = join(dir, ".git/objects/info/commit-graph");
    chmodSync(f, 0o644);
    const b = readFileSync(f);
    const chunk = (id: string) => {
      for (let i = 0; i <= b[6]!; i++) if (b.subarray(8 + i * 12, 12 + i * 12).toString("latin1") === id) return Number(b.readBigUInt64BE(12 + i * 12));
      throw new Error(id);
    };
    const oids = Array.from({ length: (chunk("CDAT") - chunk("OIDL")) / 20 }, (_, i) => b.subarray(chunk("OIDL") + i * 20, chunk("OIDL") + i * 20 + 20).toString("hex"));
    b.writeUInt32BE(oids.indexOf(skip), chunk("CDAT") + oids.indexOf(tip) * 36 + 20); // the tip's first parent: draw 1
    createHash("sha1").update(b.subarray(0, b.length - 20)).digest().copy(b, b.length - 20);
    writeFileSync(f, b);
    expect(git(dir, "log", "--format=%s").split("\n")).toEqual(["draw 2 pass", "draw 1", "audit repo"]); // git believes it
    expect((await integrity(dir)).findings).toContain(`${REL} was rewritten (not appended) in commit ${removed.slice(0, 10)}`);
  });

  it("a replace ref that swaps the removing commit for an innocent one is ignored", async () => {
    const { removed } = removal(dir);
    const innocent = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: dir, input: git(dir, "cat-file", "commit", `${removed}^`), encoding: "utf8" }).trim();
    git(dir, "replace", "-f", removed, innocent);
    expect(git(dir, "log", "--format=%s", "-1", removed)).toBe("draw 2 fail");
    expect((await integrity(dir)).findings).toContain(`${REL} was rewritten (not appended) in commit ${removed.slice(0, 10)}`);
  });

  it("textconv in .git/config and info/attributes (exp4) changes nothing: blobs are read raw", async () => {
    append(dir, line(1, "fail"));
    commitAll(dir, "draw 1 fail", null);
    write(dir, line(1, "pass"));
    const flip = commitAll(dir, "flip", null);
    writeFileSync(join(dir, ".git/info/attributes"), "*.jsonl diff=x\n");
    writeFileSync(join(dir, "tc.sh"), "#!/bin/sh\nsed 's/\"pass\"/\"fail\"/' \"$1\"\n");
    git(dir, "config", "diff.x.textconv", `sh ${join(dir, "tc.sh")}`);
    expect((await integrity(dir)).findings).toEqual([`${REL} was rewritten (not appended) in commit ${flip.slice(0, 10)}`]);
  });

  it("an object whose content does not hash to its name is refused", async () => {
    append(dir, line(1, "fail"));
    commitAll(dir, "draw 1 fail", null);
    write(dir, line(1, "pass"));
    commitAll(dir, "flip", null);
    // Overwrite the first version's blob with the second's content under the first's name: plain git would show "pass" twice.
    const first = git(dir, "rev-parse", `HEAD~1:${REL}`);
    const loose = join(dir, ".git/objects", first.slice(0, 2), first.slice(2));
    chmodSync(loose, 0o644);
    writeFileSync(loose, deflateSync(Buffer.concat([Buffer.from(`blob ${line(1, "pass").length}\0`), Buffer.from(line(1, "pass"))])));
    const r = await integrity(dir);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatch(new RegExp(`blob ${first.slice(0, 10)} \\(commit [0-9a-f]{10}\\) is missing or does not hash to its name`));
  });

  describe("inherited GIT_* variables are dropped", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    });

    it("GIT_DIR, GIT_OBJECT_DIRECTORY, GIT_GRAFT_FILE and GIT_CONFIG_PARAMETERS cannot point git elsewhere", async () => {
      const { removed, tip } = removal(dir);
      const decoy = newRepo();
      writeFileSync(join(decoy, "grafts"), `${tip}\n`);
      process.env.GIT_DIR = join(decoy, ".git");
      process.env.GIT_OBJECT_DIRECTORY = join(decoy, ".git/objects");
      process.env.GIT_GRAFT_FILE = join(decoy, "grafts");
      process.env.GIT_CONFIG_PARAMETERS = "'core.commitgraph'='true'";
      expect((await integrity(dir)).findings).toContain(`${REL} was rewritten (not appended) in commit ${removed.slice(0, 10)}`);
    });
  });
});

describe("src/io/git-safe.ts: the one way the read paths run git", () => {
  it("drops every inherited GIT_* variable and adds the guards; --no-textconv where a command would apply a driver", () => {
    const env = gitSafeEnv("/srv/audit", { PATH: "/bin", GIT_DIR: "/x", git_object_directory: "/y", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: "/srv" });
    expect(gitSafeArgs(["log", "--format=%H"])).toEqual(["--no-replace-objects", "-c", "core.commitGraph=false", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "log", "--no-textconv", "--format=%H"]);
    expect(gitSafeArgs(["cat-file", "--batch"]).slice(-2)).toEqual(["cat-file", "--batch"]);
    // git accepts them all.
    append(dir, line(1));
    commitAll(dir, "draw 1", null);
    expect(gitSafeText(["log", "--format=%s", "--", REL], { cwd: dir }).trim()).toBe("draw 1");
    expect(gitSafeText(["show", `HEAD:${REL}`], { cwd: dir })).toBe(line(1));
  });

  it("GIT_CEILING_DIRECTORIES at the audit root: git looks up to it and never above, into another repository", () => {
    const inner = join(dir, "audit-root", "window");
    mkdirSync(inner, { recursive: true });
    expect(() => gitSafeText(["rev-parse", "--show-toplevel"], { cwd: inner, root: join(dir, "audit-root") })).toThrow();
    expect(gitSafeText(["rev-parse", "--show-toplevel"], { cwd: inner, root: dir }).trim()).toMatch(/prrla-walk-/);
  });
});
