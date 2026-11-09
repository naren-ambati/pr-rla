/**
 * The docs (U10; FR8.1, FR8.2, the accuracy pass; NFR1, NFR8, NFR16, NFR18, NFR19, NFR21).
 *
 * - FR8.1: every document the requirement lists exists, the index links them, and each says what it must.
 * - FR8.2: every block that shows output is marked so and names the date it was run; the generated ones
 *   (scripts/docs-outputs.mjs) still match a fresh run of their command on their fixture.
 * - The accuracy pass: every relative link and anchor resolves offline; every `pr-rla` command and option
 *   a doc names exists in the CLI; the exit-code tables agree with contracts.md §7 and src/cli/exit-codes.ts.
 * Each checker is shown to catch what it is for, on text made for the purpose.
 *
 * The generated commands run in temporary copies of their fixtures, with no credential and a preload that
 * refuses every socket beyond loopback (NFR11). They need dist/ (npm run build).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs maintainer script, no type declarations
import { IMAGE_BUDGET_BYTES, blockProblems, checkDocs, cliMentions, cliProblems, cliSurface, exitCodeProblems, imageProblems, isUserDoc, linkProblems, markdownFiles, pendingHooks, simpleCommands } from "../scripts/check-docs.mjs";
// @ts-expect-error: a plain .mjs maintainer script, no type declarations
import { OUTPUTS, generatedBlocks, masked, regenerate } from "../scripts/docs-outputs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
type Surface = Awaited<ReturnType<typeof cliSurface>>;

let surface: Surface;
let all: { problems: string[]; pending: { at: string; round: string; what: string }[]; links: number };
beforeAll(async () => {
  surface = await cliSurface(ROOT);
  all = await checkDocs({ root: ROOT });
}, 180_000);

describe("FR8.1: the doc set", () => {
  const REQUIRED: [string, string][] = [
    ["README.md", "README"],
    ["docs/concepts.md", "concepts"],
    ["docs/statistics.md", "statistics explainer"],
    ["docs/writing-a-provider.md", "write a provider"],
    ["docs/writing-a-ledger.md", "write a ledger"],
    ["docs/ci/github.md", "CI guide: GitHub"],
    ["docs/ci/gitlab.md", "CI guide: GitLab"],
    ["docs/ci/bitbucket.md", "CI guide: Bitbucket"],
    ["docs/assistants/claude-code.md", "Claude Code setup"],
    ["docs/assistants/codex.md", "Codex setup"],
    ["docs/assistants/cursor.md", "Cursor setup"],
    ["docs/security-model.md", "security model"],
    ["docs/compatibility.md", "compatibility table"],
    ["CONTRIBUTING.md", "CONTRIBUTING"],
    ["CHANGELOG.md", "CHANGELOG"],
    ["SECURITY.md", "SECURITY.md"],
  ];

  it("every document FR8.1 lists exists, and docs/README.md links each one", () => {
    const index = read("docs", "README.md");
    for (const [f, what] of REQUIRED) {
      expect(() => read(f), `${what}: ${f}`).not.toThrow();
      const fromDocs = f.startsWith("docs/") ? f.slice(5) : `../${f}`;
      expect(index, `docs/README.md links ${f}`).toContain(`](${fromDocs})`);
    }
    for (const f of ["trusted-time.md", "release-checklist.md", "org-pooled-audits.md", "gh-aw-prospective.md", "ci/README.md", "assistants/README.md", "assistants/guard.md", "assistants/manual-acceptance.md"]) expect(index, f).toContain(`](${f})`);
  });

  it("SECURITY.md carries the placeholder contact (D10), and no address of anyone's", () => {
    const s = read("SECURITY.md");
    expect(s).toContain("**Contact: to be decided before public release.**");
    expect(s).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(s).toContain("docs/security-model.md");
  });

  it("the CHANGELOG has the 0.1.0 entry, unreleased, and CONTRIBUTING names the verification command", () => {
    expect(read("CHANGELOG.md")).toMatch(/^## 0\.1\.0(: unreleased| \(\d{4}-\d{2}-\d{2}\))$/m);
    const c = read("CONTRIBUTING.md");
    for (const s of ["npm ci && npm run build && npm run typecheck && npm test", "npm run docs:outputs", "npm run docs:check", "recorded", "synthetic"]) expect(c, s).toContain(s);
  });

  it("the security model gives every threat, T1 to T18, its mitigation and its stated limit", () => {
    const sm = read("docs", "security-model.md");
    const rows = sm.split("\n").filter((l) => /^\| T\d+ \|/.test(l)).map((l) => l.split("|").map((c) => c.trim()));
    expect(rows.map((r) => r[1])).toEqual(Array.from({ length: 18 }, (_, i) => `T${i + 1}`));
    for (const r of rows) {
      expect(r.length, r[1]).toBe(6);
      for (const cell of r.slice(2, 5)) expect(cell.length, `${r[1]}: an empty cell`).toBeGreaterThan(10);
    }
    // The pieces the threat table and its sections must cover (the brief's list).
    for (const s of ["local consent", "read-only mode", "per-verdict signatures", "push log", "INCOMPLETE", "twin-certificate", "trust on first use", "key hardware not attested", "**not mitigated**"]) expect(sm, s).toContain(s);
  });

  it("the compatibility table states the Node versions, the platforms and every SCM's live or fixture status", () => {
    const c = read("docs", "compatibility.md");
    for (const s of ["| 22.15 or later | **Required**", "| 22.23.2 | **Tested**", "| 24.20.0 | **Tested**", "| 26.8.2 | **Tested**", "| macOS", "| Linux | **Untested.**", "| Windows | **Untested**"]) expect(c, s).toContain(s);
    for (const p of ["`github` (github.com)", "`github` (Enterprise Server)", "`gitlab` (gitlab.com)", "`gitlab` (self-managed)", "`bitbucket-cloud`", "`bitbucket-data-center`", "`json-file`", "`gitea` (the example plugin)"]) {
      const row = c.split("\n").find((l) => l.startsWith(`| ${p} |`));
      expect(row, p).toBeDefined();
      expect(row!, p).toMatch(/live|recorded|fake|synthetic|unverified|n\/a/);
    }
    for (const l of ["`git-file`", "`github-issues`", "`gitlab-issues`", "Jira (the example plugin)"]) expect(c, l).toContain(`| ${l} |`);
  });

  it("NFR19: the README states the Windows status, and that Linux is untested here", () => {
    const r = read("README.md");
    expect(r).toMatch(/\*\*Windows is untested\*\*/);
    expect(r).toMatch(/\*\*Linux is untested\*\*/);
    expect(r).toContain("](docs/compatibility.md)");
  });

  it("NFR8: the compatibility table states each versioning rule", () => {
    const c = read("docs", "compatibility.md");
    const v = c.slice(c.indexOf("## Versioning"));
    for (const s of ["The first public release is 0.1.0", "Below 1.0, a change to the CLI, an output or a record is a minor version", "two releases in which pr-rla loads both", "`HTTP_HELPER_VERSION`", "Versioned on its own", "`pr-rla/<kind>/vN`", "`verify` reads every schema ever written", "`pr-rla/ipc/v2`", "only added"]) expect(v, s).toContain(s);
  });

  it("NFR1: every row of the CI scope table is marked verified or unverified", () => {
    const ci = read("docs", "ci", "README.md");
    const table = ci.slice(ci.indexOf("## Scopes"), ci.indexOf("## Rate limits"));
    const rows = table.split("\n").filter((l) => /^\| (GitHub|GitLab|Bitbucket)/.test(l));
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.split("|").map((x) => x.trim()).at(-2), r).toMatch(/^(verified|unverified)\b/);
    expect(ci).toContain("## Rate limits");
  });

  it("the CI docs say that checkpoint --push needs an issue ledger, because git-file cannot be checkpointed", () => {
    const ci = read("docs", "ci", "README.md");
    expect(ci).toContain("## Checkpoints in CI need an issue ledger");
    expect(ci).toMatch(/The `git-file` ledger cannot be checkpointed/);
    expect(read("docs", "ci", "github.md")).toMatch(/`git-file` has the git history itself as its trail and refuses/);
  });

  it("the release checklist is ordered, gives every step an owner, and holds the founder's steps, the re-pin, the shrinkwrap decision, provenance (NFR18) and the trust-bundle diff (NFR21)", () => {
    const cl = read("docs", "release-checklist.md");
    const table = cl.split("\n").filter((l) => /^\| \d+ \|/.test(l)).map((l) => l.split("|").map((c) => c.trim()));
    expect(table.map((r) => Number(r[1]))).toEqual(table.map((_, i) => i + 1));
    expect(table.length).toBeGreaterThanOrEqual(15);
    const sections = cl.split(/^## (?=\d+\. )/m).slice(1);
    expect(sections.length).toBe(table.length);
    sections.forEach((s, i) => {
      const [n, title, owner] = [table[i]![1], table[i]![2], table[i]![3]];
      expect(s.startsWith(`${n}. ${title}\n`), `section ${n} is "${title}"`).toBe(true);
      expect(["founder", "maintainer"], `step ${n}'s owner`).toContain(owner);
      expect(s, `step ${n} names its owner`).toMatch(new RegExp(`^\\*\\*Owner: ${owner}`, "m"));
    });
    const founder = (re: RegExp) => expect(table.find((r) => re.test(r[2]!))?.[3], String(re)).toBe("founder");
    founder(/licence/i);
    founder(/security contact/i);
    founder(/npm names/i);
    founder(/naren-ambati\/pr-rla/);
    founder(/trust-on-first-use anchors/i);
    founder(/manual assistant runs/i);
    founder(/visibility proof and the push log/i);
    founder(/CI\/CD Catalog/);
    founder(/gh-aw/);
    founder(/shrinkwrap/i);
    expect(table.find((r) => /Re-pin the GitHub Action/.test(r[2]!))).toBeDefined();
    expect(table.find((r) => /Re-pin `pr-rla-mcp`/.test(r[2]!))).toBeDefined();
    for (const a of ["Microsoft", "SwissSign", "FreeTSA"]) expect(cl, a).toContain(a);
    // U7's "Re-pinning at release", all seven steps, in order.
    const repin = cl.slice(cl.indexOf("## 19. "), cl.indexOf("## 20. "));
    expect([...repin.matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const u7 = read("docs", "ci", "github.md");
    for (const step of [...u7.slice(u7.indexOf("### Re-pinning at release")).matchAll(/^\d\. (.*)$/gm)].map((m) => m[1]!)) expect(repin, step.slice(0, 50)).toContain(step);
    expect(cl).toMatch(/\*\*Recommended: publish both packages with one/);
    expect(cl).toMatch(/--provenance/);
    expect(cl).toMatch(/NFR21/);
    expect(cl).toMatch(/No step in the build publishes anything/);
  });
});

describe("FR8.2: every block that shows output is real output, with the date it was run", () => {
  it("every fenced block in the docs has a language, and every output block names its date", () => {
    expect(all.problems.filter((p) => /block/.test(p) && !/generated output/.test(p))).toEqual([]);
    // The rule covers what a reader is pointed at; the design record and the build log are excluded.
    const user = (markdownFiles(ROOT) as string[]).filter(isUserDoc);
    expect(user).toContain("docs/concepts.md");
    expect(user).not.toContain("BUILD-NOTES.md");
    expect(user.filter((f) => f.startsWith("docs/design/"))).toEqual([]);
  });

  it("the check catches an untagged block, an undated or future-dated output block, and output passed off as a shell block", () => {
    const probe = [
      "Some text.", "", "```", "anything", "```", "",
      "This output has no date:", "", "```output", "VERIFIED", "```", "",
      "Run 2999-01-01:", "", "```output", "VERIFIED", "```", "",
      "```sh", "pr-rla verify --offline", "1. PASS registration: fine", "```", "",
      "```txt", "x", "```", "",
      "Run 2026-11-04:", "", "```output", "$ pr-rla status", "```",
    ].join("\n");
    const problems = blockProblems("probe.md", probe, { today: "2026-11-04" }) as string[];
    expect(problems.map((p) => p.replace(/^probe\.md:\d+: /, "").slice(0, 40))).toEqual([
      "a fenced block has no language (use outp",
      "an output block must be introduced by a ",
      "output block dated 2999-01-01, which is ",
      "this sh block looks like pr-rla's output",
      "unknown block language \"txt\"",
    ]);
  });

  it("every generated block matches a fresh run of its command on its fixture, offline", () => {
    expect(all.problems.filter((p) => /generated output/.test(p))).toEqual([]);
    // Every generator is used, and every block names a generator that exists.
    const used = new Set<string>();
    for (const f of (markdownFiles(ROOT) as string[]).filter(isUserDoc)) for (const b of generatedBlocks(read(f))) used.add(b.id);
    expect([...used].sort()).toEqual(Object.keys(OUTPUTS).sort());
  });

  it("a generated block that drifts is caught, and docs:outputs rewrites it with the date of the run", () => {
    const text = read("docs", "statistics.md");
    const [b] = (generatedBlocks(text) as { id: string; body: string }[]).filter((x) => x.id === "simulate-tolerance");
    expect(b).toBeDefined();
    const drifted = text.replace(b!.body, b!.body.replace(/certified [\d.]+%/, "certified 1.23%"));
    expect(drifted).not.toBe(text);
    const { text: fixed, changed } = regenerate(drifted, { today: "2026-11-05" }) as { text: string; changed: string[] };
    expect(changed).toEqual(["simulate-tolerance"]);
    expect(masked("simulate-tolerance", (generatedBlocks(fixed) as { id: string; body: string }[]).find((x) => x.id === "simulate-tolerance")!.body)).toBe(masked("simulate-tolerance", b!.body));
    expect(fixed).toContain("Run 2026-11-05, offline (`npm run docs:outputs` regenerates it): <!-- docs-output: simulate-tolerance -->");
  }, 60_000);

  it("a mask hides only what the clock moves: the register dry run's hash and seed round", () => {
    const a = "[dry run] registration 3148c0b677b5… · github/gh-aw\n  seed round R = 33692004 (drand quicknet), publishes 2026-11-05T11:49:36Z: 24 h";
    const b = "[dry run] registration 0000c0b677b5… · github/gh-aw\n  seed round R = 33692111 (drand quicknet), publishes 2026-11-05T12:00:00Z: 24 h";
    expect(masked("register-dry-run", a)).toBe(masked("register-dry-run", b));
    expect(masked("register-dry-run", a)).not.toBe(masked("register-dry-run", b.replace("github/gh-aw", "acme/x")));
  });
});

describe("the accuracy pass", () => {
  it("every relative link and anchor in every Markdown file resolves, offline", () => {
    expect(all.problems.filter((p) => /: link /.test(p))).toEqual([]);
    expect(all.links).toBeGreaterThan(200);
  });

  it("the link check catches a missing file, a missing anchor and a link out of the repository", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-rla-links-"));
    try {
      mkdirSync(join(root, "docs"));
      writeFileSync(join(root, "docs", "a.md"), "# Title\n\n## Second heading\n");
      writeFileSync(join(root, "docs", "b.md"), "[ok](a.md) [ok](a.md#second-heading) [ok](#local) [bad](nope.md) [bad](a.md#nope) [out](../../etc/passwd) [web](https://example.com)\n\n## Local\n\n```sh\n[not a link](inside-a-fence.md)\n```\n");
      const r = linkProblems(["docs/a.md", "docs/b.md"], root) as { problems: string[]; count: number };
      expect(r.count).toBe(6);
      expect(r.problems.map((p) => p.replace(/^docs\/b\.md:1: link /, "").split(/[: ]/)[0])).toEqual(["nope.md", "a.md#nope", "../../etc/passwd"]);
      expect(r.problems[2]).toMatch(/leaves the repository$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("every image in the docs has alt text, a caption and an existing PNG under docs/images, and the images stay under 3 MB", () => {
    expect(all.problems.filter((p) => /image|docs\/images/.test(p))).toEqual([]);
    const refs = ["README.md", "docs/tour.md", "docs/ci/github.md", "docs/assistants/claude-code.md", "docs/security-model.md"];
    for (const f of refs) expect(read(f), f).toMatch(/!\[[^\]]+\]\([^)]*docs\/images\/[^)]+\.png\)|!\[[^\]]+\]\((?:\.\.\/)*images\/[^)]+\.png\)/);
    expect(IMAGE_BUDGET_BYTES).toBe(3 * 1024 * 1024);
  });

  it("the image check catches no alt text, a missing file, a non-PNG, a missing caption, an unused image and a blown budget", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-rla-images-"));
    try {
      mkdirSync(join(root, "docs", "images"), { recursive: true });
      writeFileSync(join(root, "docs", "images", "ok.png"), "x");
      writeFileSync(join(root, "docs", "images", "unused.png"), "x");
      writeFileSync(join(root, "docs", "images", "big.png"), Buffer.alloc(IMAGE_BUDGET_BYTES));
      writeFileSync(join(root, "docs", "a.md"), ["![fine](images/ok.png)", "", "*A caption.*", "", "![](images/ok.png)", "*Caption.*", "", "![gone](images/gone.png)", "*Caption.*", "", "![svg](images/x.svg)", "*Caption.*", "", "![nocaption](images/ok.png)", "", "text", "", "```sh", "![in a block](nope.png)", "```", ""].join("\n"));
      const problems = imageProblems(["docs/a.md"], root) as string[];
      const short = problems.map((p) => p.replace(/^docs\/a\.md:\d+: /, "").replace(/^docs\/images\//, ""));
      for (const want of ["image images/ok.png has no alt text", "image images/gone.png does not exist", "image images/x.svg is not a PNG directly under docs/images", "image images/ok.png needs a one-line italic caption (*...*) on the next line", "unused.png: no doc uses this image", "big.png: no doc uses this image"]) expect(short, want).toContain(want);
      expect(short.some((p) => /^docs\/images: the images weigh .* MB, over the 3 MB budget$/.test(p))).toBe(true);
      expect(problems).toHaveLength(7);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("every pr-rla command and option the docs name exists in the CLI", () => {
    expect(all.problems.filter((p) => /pr-rla .*: no (command|option)/.test(p))).toEqual([]);
    let mentions = 0;
    for (const f of (markdownFiles(ROOT) as string[]).filter(isUserDoc)) mentions += (cliMentions(read(f)) as unknown[]).length;
    expect(mentions).toBeGreaterThan(100);
  });

  it("the command check catches an unknown command or option, and reads only the command position", () => {
    const probe = [
      "Run `pr-rla verify --offlne` and `pr-rla frobnicate`, or `pr-rla plugin remove x`.",
      "```sh",
      "GITHUB_TOKEN=$(gh auth token) pr-rla -C examples/gh-aw-q3 freeze --dry-run --estimate",
      "codex mcp add pr-rla -- npx -y pr-rla-mcp@0.1.0",
      "pr-rla record 7 pass --sign ~/keys/k   # a comment: pr-rla --bogus",
      "```",
      "The guard's status message is `pr-rla guard`; an error reads `this pr-rla supports 1`.",
    ].join("\n");
    const p = (cliProblems("probe.md", probe, surface) as string[]).map((x) => x.replace(/^probe\.md:\d+: /, ""));
    expect(p).toEqual(["pr-rla verify --offlne: no option --offlne", "pr-rla frobnicate: no command \"frobnicate\"", "pr-rla plugin remove x: no command \"plugin remove\""]);
    expect(simpleCommands("A=1 B=2 pr-rla status; cd x && node dist/cli.js verify | tee y")).toEqual([["pr-rla", "status"], ["cd", "x"], ["node", "dist/cli.js", "verify"], ["tee", "y"]]);
  });

  it("the CLI surface the check reads is the program's own: each command's --help lists its options", () => {
    const cli = join(ROOT, "dist", "cli.js");
    for (const [name, cmd] of surface.commands as Map<string, { options: Set<string>; subcommands: Map<string, Set<string>> }>) {
      const help = execFileSync(process.execPath, [cli, name, "--help"], { encoding: "utf8" });
      for (const o of cmd.options) expect(help, `${name} ${o}`).toContain(o);
      for (const s of cmd.subcommands.keys()) expect(help, `${name} ${s}`).toContain(s);
    }
    expect([...surface.commands.keys()].sort()).toEqual(["checkpoint", "draw-context", "freeze", "init", "plugin", "record", "register", "sample", "simulate", "status", "verify"]);
  });

  it("NFR16: the exit codes in docs/compatibility.md and contracts.md §7 are src/cli/exit-codes.ts's, and no doc names another", async () => {
    expect(await exitCodeProblems(markdownFiles(ROOT), ROOT)).toEqual([]);
    expect(all.problems.filter((p) => /exit code|exit codes/.test(p))).toEqual([]);
  });

  it("the exit-code check catches a missing code and one pr-rla does not have", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-rla-exit-"));
    try {
      for (const d of ["docs/design/phase-3-4", "dist/cli"]) mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, "dist", "cli", "exit-codes.js"), read("dist", "cli", "exit-codes.js").replace(/^\/\/# sourceMappingURL=.*$/m, ""));
      writeFileSync(join(root, "docs", "design", "phase-3-4", "contracts.md"), read("docs", "design", "phase-3-4", "contracts.md"));
      writeFileSync(join(root, "docs", "compatibility.md"), read("docs", "compatibility.md").replace(/^\| 5 \|.*\n/m, ""));
      writeFileSync(join(root, "docs", "x.md"), "verify then exits 9 on Tuesdays.\n");
      const p = (await exitCodeProblems(["docs/compatibility.md", "docs/x.md"], root)) as string[];
      expect(p).toEqual(["docs/compatibility.md: exit codes 0, 1, 2, 3, 4, 6; src/cli/exit-codes.ts has 0, 1, 2, 3, 4, 5, 6", "docs/x.md:1: names exit code 9, which pr-rla does not have"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hooks left for the rounds still running", () => {
  it("every pending hook names the round that completes it (P1 audit binding, S1 integration seams, or a later P or S round), and none may remain at release", () => {
    const hooks = pendingHooks(markdownFiles(ROOT), ROOT) as { at: string; round: string }[];
    expect(hooks.filter((h) => !/^[PS]\d+$/.test(h.round))).toEqual([]);
    expect(all.pending).toEqual(hooks);
  });

  it("a hook is an HTML comment in the text: the same words quoted in inline code or a fenced block are not one", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-rla-hooks-"));
    try {
      writeFileSync(join(root, "a.md"), ["Real: <!-- pending P1: describe the record -->", "Quoted: `<!-- pending S1: … -->`", "```text", "<!-- pending S1: inside a fence -->", "```", ""].join("\n"));
      expect((pendingHooks(["a.md"], root) as { at: string; round: string }[]).map((h) => [h.at, h.round])).toEqual([["a.md:1", "P1"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("npm run docs:check", () => {
  it("is wired, and passes", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["docs:check"]).toBe("node scripts/check-docs.mjs");
    expect(pkg.scripts["docs:outputs"]).toBe("node scripts/docs-outputs.mjs");
    const out = execFileSync(process.execPath, [join(ROOT, "scripts", "check-docs.mjs")], { cwd: ROOT, encoding: "utf8" });
    expect(out).toMatch(/docs:check: 0 problem\(s\), \d+ relative links checked/);
  }, 180_000);
});
