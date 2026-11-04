import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import githubIssues from "../src/ledgers/github-issues/index.js";
import gitlabIssues from "../src/ledgers/gitlab-issues/index.js";
import { indexProblems, ledgerIndexSha256, type LedgerIndex } from "../src/ledgers/issue-index.js";
import type { Ledger } from "../src/sdk/ledger.js";
import { FakeGitHubIssues, FakeGitLabIssues } from "./helpers/fake-issue-trackers.js";
import { PUB, draw } from "./helpers/ledger-draws.js";

// Findings 3, 7 and the 404 item of finding 10 of the master review, at the ledger: the index is a
// hint and the tracker's answer must agree with it; case-only renames are not silent; a token that
// cannot see the audit repo is not "issue deleted".
const DRAWS = [draw(1, 101), draw(2, 102), draw(3, 103)];
const alice = { login: "alice", id: 11, type: "User" as const };
const bob = { login: "bob", id: 12, type: "User" as const };

async function github() {
  const fake = new FakeGitHubIssues();
  const windowDir = mkdtempSync(join(tmpdir(), "prrla-bind-"));
  const open = () => githubIssues.create({ repo: "acme/audit" }, { cwd: windowDir, windowDir, env: { GITHUB_TOKEN: "t" }, log: () => {}, fetch: fake.fetch }) as Promise<Ledger>;
  await (await open()).publishDraws!(DRAWS, PUB);
  return { fake, windowDir, open, issue: (d: number) => fake.issueByDraw(d) };
}
const editIndex = (windowDir: string, f: (i: LedgerIndex) => void) => {
  const p = join(windowDir, "ledger-index.json");
  const i = JSON.parse(readFileSync(p, "utf8")) as LedgerIndex;
  f(i);
  writeFileSync(p, JSON.stringify(i, null, 2));
};
const integrity = async (l: Ledger) => (await l.verifyIntegrity!());

describe("the index must agree with the tracker (finding 3)", () => {
  it("a clean publish verifies, and the index hash is the canonical JSON's", async () => {
    const { open, windowDir } = await github();
    const r = await integrity(await open());
    expect(r.ok, r.findings.join("\n")).toBe(true);
    const doc = JSON.parse(readFileSync(join(windowDir, "ledger-index.json"), "utf8"));
    expect(ledgerIndexSha256(doc)).toMatch(/^[0-9a-f]{64}$/);
    expect(ledgerIndexSha256(JSON.parse(JSON.stringify(doc, null, 4)))).toBe(ledgerIndexSha256(doc)); // whitespace does not matter
    expect(ledgerIndexSha256({ ...doc, window: "x" })).not.toBe(ledgerIndexSha256(doc));
  });

  it("draw 3 re-pointed at another draw's issue number (the reproduction) is refused: the issue is not the one the index names", async () => {
    const { open, windowDir, issue } = await github();
    const other = issue(1);
    editIndex(windowDir, (i) => {
      i.issues.find((x) => x.draw === 3)!.number = other.number;
    });
    const l = await open();
    const r = await integrity(l);
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/draw #3: .* answered issue 1 \(id .*\) for the index's 1 \(id .*\); the index does not describe this issue|issue 1 .* does not describe/);
    expect((await l.readVerdicts()).filter((v) => v.draw === 3)).toHaveLength(0);
  });

  it("re-pointing both the number and the id still fails: the issue's body says it is another draw", async () => {
    const { open, windowDir, issue, fake } = await github();
    fake.label(issue(1).number, "pr-rla:pass", alice);
    const one = issue(1);
    editIndex(windowDir, (i) => {
      const e = i.issues.find((x) => x.draw === 3)!;
      e.number = one.number;
      e.id = String(one.id);
    });
    const l = await open();
    const r = await integrity(l);
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/draw #3 issue .* says in its body that it is draw #1 \(json:acme\/widgets#101\), not draw #3 \(json:acme\/widgets#103\)/);
    expect((await l.readVerdicts()).filter((v) => v.draw === 3)).toHaveLength(0);
  });

  it("two draws sharing one issue number FAIL, and an issue whose body lost its marker FAILs", async () => {
    const { open, windowDir, issue } = await github();
    editIndex(windowDir, (i) => {
      const a = i.issues.find((x) => x.draw === 1)!;
      const b = i.issues.find((x) => x.draw === 2)!;
      b.number = a.number;
      b.id = a.id;
    });
    const r = await integrity(await open());
    expect(r.findings.join("\n")).toMatch(/draws #1 and #2 the same issue number 1: one verdict would count for both/);
    expect(r.ok).toBe(false);
    const g = await github();
    g.issue(2).body = "edited: no marker";
    const r2 = await integrity(await g.open());
    expect(r2.ok).toBe(false);
    expect(r2.findings.join("\n")).toMatch(/draw #2 issue .* carries no pr-rla marker for window 2026-q3/);
    void issue;
  });

  it("indexProblems reports duplicate numbers, ids, draws, changes and dangling repeats", () => {
    const e = (draw: number, number: number | string, id: string, changeId = `c${draw}`) => ({ draw, changeId, number, id, url: "u", createdAt: "t" });
    expect(indexProblems({ issues: [e(1, 5, "a"), e(2, "5", "b")], repeats: [] })).toEqual([expect.stringMatching(/same issue number 5/)]);
    expect(indexProblems({ issues: [e(1, 5, "a"), e(2, 6, "a")], repeats: [] })).toEqual([expect.stringMatching(/same issue id a/)]);
    expect(indexProblems({ issues: [e(1, 5, "a"), e(1, 6, "b")], repeats: [] })[0]).toMatch(/draw #1 twice/);
    expect(indexProblems({ issues: [e(1, 5, "a", "x"), e(2, 6, "b", "x")], repeats: [] })[0]).toMatch(/two issues .* for x/);
    expect(indexProblems({ issues: [e(1, 5, "a")], repeats: [{ draw: 2, changeId: "c1", sameAs: 9 }] })[0]).toMatch(/points at draw #9, which has no issue/);
    expect(indexProblems({ issues: [e(1, 5, "a")], repeats: [{ draw: 2, changeId: "other", sameAs: 1 }] })[0]).toMatch(/is other but draw #1's issue is for c1/);
    expect(indexProblems({ issues: [e(1, 5, "a"), e(2, 6, "b")], repeats: [{ draw: 3, changeId: "c1", sameAs: 1 }] })).toEqual([]);
  });

  it("GitLab: the iid, the id and the marker are checked the same way", async () => {
    const fake = new FakeGitLabIssues();
    const windowDir = mkdtempSync(join(tmpdir(), "prrla-bind-"));
    const open = () => gitlabIssues.create({ project: "acme/audit", base_url: "https://gitlab.example.com" }, { cwd: windowDir, windowDir, env: { GITLAB_TOKEN: "t" }, log: () => {}, fetch: fake.fetch }) as Promise<Ledger>;
    await (await open()).publishDraws!(DRAWS, PUB);
    expect((await integrity(await open())).ok).toBe(true);
    editIndex(windowDir, (i) => {
      i.issues.find((x) => x.draw === 3)!.number = 1;
    });
    const r = await integrity(await open());
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/draw #3: .* answered issue 1 .* does not describe this issue/);
    const g = new FakeGitLabIssues();
    const w2 = mkdtempSync(join(tmpdir(), "prrla-bind-"));
    const open2 = () => gitlabIssues.create({ project: "acme/audit", base_url: "https://gitlab.example.com" }, { cwd: w2, windowDir: w2, env: { GITLAB_TOKEN: "t" }, log: () => {}, fetch: g.fetch }) as Promise<Ledger>;
    await (await open2()).publishDraws!(DRAWS, PUB);
    g.issueByDraw(2).description = "edited";
    const r2 = await integrity(await open2());
    expect(r2.ok).toBe(false);
    expect(r2.findings.join("\n")).toMatch(/draw #2 issue .* carries no pr-rla marker/);
  });
});

describe("case-only label renames and stray labels (finding 7)", () => {
  it("a fail label whose case was renamed still counts as a FAIL event: the relabel is reported, and so is the rename", async () => {
    const { fake, open, issue } = await github();
    const n = issue(1).number;
    fake.label(n, "pr-rla:pass", alice);
    fake.renameLabel("pr-rla:fail", "PR-RLA:fail"); // the fake creates the label on first use; do it explicitly
    const l = await open();
    fake.label(n, "PR-RLA:fail", bob); // REST events keep the name as applied
    const r = await integrity(await open());
    expect(r.warnings?.join("\n")).toMatch(/draw #1: relabel pass→fail/);
    void l;
  });

  it("warns when the live label's name differs from the index's, case only", async () => {
    const { fake, open, issue } = await github();
    fake.label(issue(1).number, "pr-rla:fail", alice);
    fake.renameLabel("pr-rla:fail", "PR-RLA:fail");
    const r = await integrity(await open());
    expect(r.ok, r.findings.join("\n")).toBe(true);
    expect(r.warnings?.join("\n")).toMatch(/verdict label "pr-rla:fail" is named "PR-RLA:fail" in acme\/audit now \(renamed, case only/);
  });

  it("warns on a label event that is not the pass, fail or draw label (a beyond-case rename looks like this), once per label", async () => {
    const { fake, open, issue } = await github();
    const n = issue(2).number;
    fake.label(n, "pr-rla:pass", alice);
    fake.label(n, "pr-rla:fial", bob); // a typo'd verdict label
    fake.unlabel(n, "pr-rla:fial", bob);
    fake.label(n, "pr-rla:fial", bob);
    const r = await integrity(await open());
    expect(r.warnings).toEqual([expect.stringMatching(/draw #2: 3 label event\(s\) for "pr-rla:fial", which is not the pr-rla:pass, pr-rla:fail or pr-rla:draw label; not counted/)]);
  });

  it("the draw label's own events are not strays", async () => {
    const { open } = await github();
    const r = await integrity(await open());
    expect(r.warnings ?? []).toEqual([]);
  });
});

describe("a 404 from a token that cannot read the audit repo is not 'issue deleted' (finding 10)", () => {
  it("GitHub: a token without access gets a token finding; a real deletion still says deleted", async () => {
    const { fake, open, issue } = await github();
    fake.unauthorized = true;
    const r = await integrity(await open());
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/draw #1 issue .* answered HTTP 404, and the token cannot read acme\/audit either: the token has no access/);
    expect(r.findings.join("\n")).not.toMatch(/deleted \(/);
    const g = await github();
    g.fake.deleteIssue(g.issue(1).number, 404);
    const r2 = await integrity(await g.open());
    expect(r2.findings.join("\n")).toMatch(/draw #1 issue .* deleted \(HTTP 404\); its history is gone/);
    void issue;
  });

  it("GitHub: only the issues answer 404 for the token (repo and labels readable): deleted; repo unreadable: token", async () => {
    const g = await github();
    const real = g.fake.fetch;
    // labels answer, the repo and the issues do not: a token with Issues scope missing
    const l = await githubIssues.create({ repo: "acme/audit" }, { cwd: g.windowDir, windowDir: g.windowDir, env: { GITHUB_TOKEN: "t" }, log: () => {}, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      if (/\/issues\/\d+/.test(url.pathname) || url.pathname === "/repos/acme/audit") return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return real(input, init);
    }) as typeof fetch });
    const r = await (l as Ledger).verifyIntegrity!();
    expect(r.ok).toBe(false);
    expect(r.findings.join("\n")).toMatch(/draw #1 issue .* answered HTTP 404, and the token cannot read acme\/audit either: the token has no access/);
    expect(r.findings.join("\n")).not.toMatch(/deleted \(/);
  });

  it("GitLab: the same split", async () => {
    const fake = new FakeGitLabIssues();
    const windowDir = mkdtempSync(join(tmpdir(), "prrla-bind-"));
    const real = fake.fetch;
    const mk = (blind: boolean) => gitlabIssues.create({ project: "acme/audit", base_url: "https://gitlab.example.com" }, { cwd: windowDir, windowDir, env: { GITLAB_TOKEN: "t" }, log: () => {}, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      if (blind && (/\/issues\/\d+/.test(url.pathname) || url.pathname.endsWith("/projects/acme%2Faudit"))) return new Response(JSON.stringify({ message: "404 Not found" }), { status: 404 });
      return real(input, init);
    }) as typeof fetch }) as Promise<Ledger>;
    await (await mk(false)).publishDraws!(DRAWS, PUB);
    expect((await (await mk(true)).verifyIntegrity!()).findings.join("\n")).toMatch(/draw #1 issue .* answered HTTP 404, and the token cannot read acme\/audit either/);
    fake.deleteIssue(fake.issueByDraw(1).iid);
    expect((await (await mk(false)).verifyIntegrity!()).findings.join("\n")).toMatch(/draw #1 issue .* deleted \(HTTP 404\)/);
  });
});
