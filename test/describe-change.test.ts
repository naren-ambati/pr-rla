import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAuditContext, openProvider } from "../src/api/context.js";
import { countPatch, splitUnifiedDiff } from "../src/providers/diff.js";
import bitbucketCloud from "../src/providers/bitbucket-cloud/index.js";
import bitbucketDc from "../src/providers/bitbucket-data-center/index.js";
import github from "../src/providers/github/index.js";
import { checkRunState, commitStatusState, githubFileStatus } from "../src/providers/github/describe.js";
import gitlab from "../src/providers/gitlab/index.js";
import { pipelineState } from "../src/providers/gitlab/describe.js";
import { HttpClient } from "../src/sdk/http.js";
import { changeDescriptionProblems, type ChangeDescription, type ChangeRecord, type ScmProvider } from "../src/sdk/provider.js";
import { fixturePath, readJsonFixture } from "./helpers/fixtures.js";
import { replayFetch, type Recording } from "./helpers/replay-fetch.js";

/**
 * describeChange on the built-in providers (functional-design.md §U5; FR3.4): recorded GitHub
 * responses (github/gh-aw, read-only, 2026-11-04) and synthetic servers built from each SCM's
 * documented response shapes. Every request is a GET.
 */

const AUDIT = fixturePath("audits", "gh-aw-q3-recorded");
const manifest = JSON.parse(readFileSync(`${AUDIT}/audit/2026-q3.manifest.json`, "utf8")) as { changes: ChangeRecord[] };
const changesFile = JSON.parse(readFileSync(`${AUDIT}/changes.json`, "utf8")) as { descriptions: Record<string, ChangeDescription> };
const byId = new Map(manifest.changes.map((c) => [c.id, c]));

type Handler = (url: URL, init: RequestInit) => unknown;
/** A fake SCM: routes by method and path (with the query), records every request. */
function fakeScm(routes: Record<string, Handler>) {
  const seen: { method: string; url: string }[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    seen.push({ method, url: url.href });
    const key = `${method} ${url.pathname}${url.search}`;
    const hit = Object.entries(routes).find(([k]) => k === key || (k.endsWith("*") && key.startsWith(k.slice(0, -1))));
    if (!hit) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    const r = hit[1](url, init);
    if (r instanceof Response) return r;
    if (typeof r === "string") return new Response(r, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, seen };
}

const ctx = (f: typeof fetch) => ({ cwd: process.cwd(), env: {}, log: () => {}, fetch: f });
const valid = (d: ChangeDescription, id: string) => expect(changeDescriptionProblems(d, id)).toEqual([]);

describe("GitHub describeChange on recorded gh-aw draws (github/gh-aw, read-only, 2026-11-04)", () => {
  const rec = readJsonFixture<Recording & { changes: string[]; source: string }>("github", "gh-aw-q3-draws-2026-11-04.json");

  it("is marked recorded, and covers four of the audit's issued draws", () => {
    expect(rec.source).toBe("recorded");
    expect(rec.changes).toHaveLength(4);
    for (const id of rec.changes) expect(byId.has(id)).toBe(true);
  });

  it("replays to exactly the descriptions the audit's changes.json recorded, five GETs per PR", async () => {
    const replay = replayFetch(rec);
    const p = (await github.create({}, ctx(replay))) as ScmProvider;
    for (const id of rec.changes) {
      const d = await p.describeChange!(byId.get(id)!);
      valid(d, id);
      expect(d).toEqual(changesFile.descriptions[id]);
    }
    expect(replay.served()).toBe(20);
    expect(replay.unused()).toEqual([]);
    expect(rec.exchanges.every((e) => e.method === "GET")).toBe(true);
  });

  it("reads gh-aw's .gitattributes at the merge commit, with its linguist-generated lines", () => {
    const d = changesFile.descriptions["github:github/gh-aw#42597"]!;
    expect(d.gitattributes).toMatch(/^\*\.lock\.yml linguist-generated=true merge=ours$/m);
    expect(d.files.map((f) => f.path)).toEqual(expect.arrayContaining([".github/workflows/breaking-change-checker.lock.yml"]));
  });
});

describe("GitLab and Bitbucket Cloud describeChange on recorded public changes (anonymous, read-only, 2026-11-04)", () => {
  for (const [scm, file] of [["gitlab", "describe-gitlab-org-cli-4191-2026-11-04.json"], ["bitbucket-cloud", "describe-bamboo-specs-745-2026-11-04.json"]] as const) {
    it(`${scm}: the recorded responses replay, through the read-only broker (redirects followed by hand), to the recorded description`, async () => {
      const rec = readJsonFixture<Recording & { source: string; provider: string; options: Record<string, unknown>; change: ChangeRecord; expected: ChangeDescription }>(scm, file);
      expect(rec.source).toBe("recorded");
      const replay = replayFetch(rec);
      const actx = createAuditContext({ mode: "read-only", fetch: replay });
      const p = await openProvider(actx, { use: rec.provider, options: rec.options }, process.cwd());
      const d = await p.describeChange!(rec.change);
      valid(d, rec.change.id);
      expect(d).toEqual(rec.expected);
      expect(replay.unused()).toEqual([]);
      expect(rec.exchanges.every((e) => e.method === "GET")).toBe(true);
    });
  }

  it("what the recordings show: GitLab's MR diffs and its pipeline at the head; Bitbucket's 302s to the diffstat and diff, and four statuses", () => {
    const gl = readJsonFixture<{ expected: ChangeDescription }>("gitlab", "describe-gitlab-org-cli-4191-2026-11-04.json").expected;
    expect(gl.files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ["internal/api/default.go", 3, 0],
      ["internal/commands/issue/issueutils/utils.go", 4, 2],
      ["internal/commands/issue/issueutils/utils_test.go", 50, 0],
      ["internal/commands/mr/mrutils/mrutils.go", 1, 0],
      ["internal/commands/mr/mrutils/mrutils_test.go", 49, 0],
    ]);
    expect(gl.gitattributes).toBeNull();
    expect(gl.checks).toEqual([{ name: "pipeline #2997205784 (duo_workflow)", state: "success", url: expect.stringMatching(/^https:\/\/gitlab\.com\//) }]);
    const bb = readJsonFixture<Recording & { expected: ChangeDescription }>("bitbucket-cloud", "describe-bamboo-specs-745-2026-11-04.json");
    expect(bb.exchanges.filter((e) => e.status === 302).map((e) => new URL(e.url).pathname)).toEqual(["/2.0/repositories/atlassian/bamboo-specs/pullrequests/745/diffstat", "/2.0/repositories/atlassian/bamboo-specs/pullrequests/745/diff"]);
    expect(bb.expected.files).toEqual([{ path: "bamboo-specs-java-agent/pom.xml", status: "modified", additions: 1, deletions: 1, patch: expect.stringMatching(/^@@ /) }]);
    expect(bb.expected.checks.map((c) => c.state)).toEqual(["success", "success", "success", "success"]);
  });
});

describe("GitHub describeChange, synthetic", () => {
  const change = (kind: ChangeRecord["kind"]): ChangeRecord =>
    kind === "pull_request"
      ? { id: "github:acme/widgets#7", kind, repo: "acme/widgets", url: "https://github.com/acme/widgets/pull/7", mergeSha: "a".repeat(40), mergedAt: "2026-08-01T00:00:00Z", author: { login: "dev", kind: "human" }, mergedBy: { login: "lead", kind: "human" }, reviews: [], changedLines: 3, labels: [] }
      : { id: `github:acme/widgets@${"b".repeat(40)}`, kind, repo: "acme/widgets", url: "https://github.com/acme/widgets/commit/bbb", mergeSha: "b".repeat(40), mergedAt: "2026-08-01T00:00:00Z", author: { login: "dev", kind: "human" }, mergedBy: null, reviews: [], changedLines: 3, labels: [] };
  const link = (next: string) => ({ link: `<${next}>; rel="next"` });

  it("pages the files, maps statuses and checks, and says truncated when GitHub lists fewer files than the PR has", async () => {
    const api = "https://api.github.com/repos/acme/widgets";
    const s = fakeScm({
      "GET /repos/acme/widgets/pulls/7": () => ({ title: "Fix", body: null, head: { sha: "c".repeat(40) }, changed_files: 5 }),
      "GET /repos/acme/widgets/pulls/7/files?per_page=100": () => new Response(JSON.stringify([{ filename: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }, { filename: "img.png", status: "added", additions: 0, deletions: 0 }]), { headers: { "content-type": "application/json", ...link(`${api}/pulls/7/files?per_page=100&page=2`) } }),
      "GET /repos/acme/widgets/pulls/7/files?per_page=100&page=2": () => [{ filename: "new.ts", previous_filename: "old.ts", status: "renamed", additions: 0, deletions: 0 }, { filename: "c.ts", status: "copied", additions: 2, deletions: 0 }],
      [`GET /repos/acme/widgets/commits/${"c".repeat(40)}/check-runs?per_page=100`]: () => ({ total_count: 3, check_runs: [{ name: "build", status: "completed", conclusion: "success", html_url: "https://ci/1" }, { name: "lint", status: "in_progress", conclusion: null, html_url: null }, { name: "e2e", status: "completed", conclusion: "cancelled", html_url: null }] }),
      [`GET /repos/acme/widgets/commits/${"c".repeat(40)}/status?per_page=100`]: () => ({ state: "failure", statuses: [{ context: "ci/legacy", state: "error", target_url: "https://legacy/1" }] }),
    });
    const p = (await github.create({}, ctx(s.fetch))) as ScmProvider;
    const d = await p.describeChange!(change("pull_request"));
    valid(d, "github:acme/widgets#7");
    expect(d).toMatchObject({ title: "Fix", body: "", gitattributes: null, truncated: true });
    expect(d.files).toEqual([
      { path: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
      { path: "img.png", status: "added", additions: 0, deletions: 0, patch: null },
      { path: "new.ts", previousPath: "old.ts", status: "renamed", additions: 0, deletions: 0, patch: null },
      { path: "c.ts", status: "renamed", additions: 2, deletions: 0, patch: null },
    ]);
    expect(d.checks).toEqual([
      { name: "build", state: "success", url: "https://ci/1" },
      { name: "lint", state: "pending", url: null },
      { name: "e2e", state: "failure", url: null },
      { name: "ci/legacy", state: "failure", url: "https://legacy/1" },
    ]);
    expect(s.seen.every((r) => r.method === "GET")).toBe(true);
    // The .gitattributes lookup 404s: no file there, so null, not an error.
    expect(s.seen.some((r) => r.url.includes("/contents/.gitattributes?ref=" + "a".repeat(40)))).toBe(true);
  });

  it("describes a direct push from its commit: the message's first line is the title, its files paged", async () => {
    const sha = "b".repeat(40);
    const api = "https://api.github.com/repos/acme/widgets";
    const s = fakeScm({
      [`GET /repos/acme/widgets/commits/${sha}`]: () => new Response(JSON.stringify({ commit: { message: "Bump x\n\nBecause y." }, files: [{ filename: "x", status: "modified", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x" }] }), { headers: { "content-type": "application/json", link: `<${api}/commits/${sha}?page=2>; rel="next"` } }),
      [`GET /repos/acme/widgets/commits/${sha}?page=2`]: () => ({ commit: { message: "Bump x\n\nBecause y." }, files: [{ filename: "y", status: "removed", additions: 0, deletions: 4 }] }),
      [`GET /repos/acme/widgets/contents/.gitattributes?ref=${sha}`]: () => ({ type: "file", encoding: "base64", content: Buffer.from("*.gen linguist-generated\n").toString("base64") }),
      [`GET /repos/acme/widgets/commits/${sha}/check-runs?per_page=100`]: () => ({ total_count: 0, check_runs: [] }),
      [`GET /repos/acme/widgets/commits/${sha}/status?per_page=100`]: () => ({ state: "pending", statuses: [] }),
    });
    const p = (await github.create({}, ctx(s.fetch))) as ScmProvider;
    const d = await p.describeChange!(change("direct_push"));
    valid(d, `github:acme/widgets@${sha}`);
    expect(d).toMatchObject({ title: "Bump x", body: "Because y.", gitattributes: "*.gen linguist-generated\n", checks: [], truncated: false });
    expect(d.files.map((f) => [f.path, f.status])).toEqual([["x", "modified"], ["y", "removed"]]);
  });

  it("maps every check-run conclusion and commit state", () => {
    expect([["queued", null], ["completed", "success"], ["completed", "failure"], ["completed", "timed_out"], ["completed", "neutral"], ["completed", "skipped"], ["completed", "action_required"], ["completed", "stale"]].map(([s, c]) => checkRunState(s!, c ?? null))).toEqual(["pending", "success", "failure", "failure", "neutral", "skipped", "pending", "unknown"]);
    expect(["success", "failure", "error", "pending", "weird"].map(commitStatusState)).toEqual(["success", "failure", "failure", "pending", "unknown"]);
    expect(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"].map(githubFileStatus)).toEqual(["added", "removed", "modified", "renamed", "renamed", "modified", "modified"]);
  });
});

describe("GitLab describeChange, synthetic (documented REST v4 shapes)", () => {
  const sha = "d".repeat(40);
  const head = "e".repeat(40);
  const mr: ChangeRecord = { id: "gitlab:group/proj#12", kind: "pull_request", repo: "group/proj", url: "https://gitlab.com/group/proj/-/merge_requests/12", mergeSha: sha, mergedAt: "2026-08-01T00:00:00Z", author: { login: "dev", kind: "human" }, mergedBy: { login: "lead", kind: "human" }, reviews: [], changedLines: 3, labels: [] };

  it("pages the MR diffs, counts their lines, reads the raw .gitattributes as text and the pipelines at the head", async () => {
    const base = "https://gitlab.com/api/v4/projects/group%2Fproj";
    const s = fakeScm({
      "GET /api/v4/projects/group%2Fproj/merge_requests/12": () => ({ title: "Add", description: "Body", sha: head, diff_refs: { head_sha: head } }),
      "GET /api/v4/projects/group%2Fproj/merge_requests/12/diffs?per_page=100": () => new Response(JSON.stringify([{ old_path: "a", new_path: "a", diff: "@@ -1,2 +1,2 @@\n-x\n+y\n z", new_file: false, renamed_file: false, deleted_file: false }]), { headers: { "content-type": "application/json", link: `<${base}/merge_requests/12/diffs?per_page=100&page=2>; rel="next"` } }),
      "GET /api/v4/projects/group%2Fproj/merge_requests/12/diffs?per_page=100&page=2": () => [
        { old_path: "o", new_path: "n", diff: "", new_file: false, renamed_file: true, deleted_file: false },
        { old_path: "gone", new_path: "gone", diff: "@@ -1 +0,0 @@\n-bye", new_file: false, renamed_file: false, deleted_file: true },
        { old_path: "big", new_path: "big", diff: "", new_file: true, renamed_file: false, deleted_file: false, too_large: true },
      ],
      [`GET /api/v4/projects/group%2Fproj/repository/files/.gitattributes/raw?ref=${sha}`]: () => "big linguist-generated=true\n",
      [`GET /api/v4/projects/group%2Fproj/pipelines?sha=${head}&per_page=100`]: () => [
        { id: 9, status: "success", source: "merge_request_event", web_url: "https://gitlab.com/p/9" },
        { id: 8, status: "canceled", web_url: null },
        { id: 7, status: "manual", web_url: null },
      ],
    });
    const p = (await gitlab.create({}, ctx(s.fetch))) as ScmProvider;
    const d = await p.describeChange!(mr);
    valid(d, mr.id);
    expect(d).toMatchObject({ title: "Add", body: "Body", gitattributes: "big linguist-generated=true\n", truncated: false });
    expect(d.files).toEqual([
      { path: "a", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n-x\n+y\n z" },
      { path: "n", previousPath: "o", status: "renamed", additions: 0, deletions: 0, patch: null },
      { path: "gone", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-bye" },
      { path: "big", status: "added", additions: 0, deletions: 0, patch: null },
    ]);
    expect(d.checks).toEqual([
      { name: "pipeline #9 (merge_request_event)", state: "success", url: "https://gitlab.com/p/9" },
      { name: "pipeline #8", state: "failure", url: null },
      { name: "pipeline #7", state: "pending", url: null },
    ]);
    expect(s.seen.every((r) => r.method === "GET")).toBe(true);
  });

  it("describes a direct push from the commit and its diff; a missing .gitattributes is null", async () => {
    const s = fakeScm({
      [`GET /api/v4/projects/group%2Fproj/repository/commits/${sha}`]: () => ({ title: "Hotfix", message: "Hotfix\n\nDetails." }),
      [`GET /api/v4/projects/group%2Fproj/repository/commits/${sha}/diff?per_page=100`]: () => [{ old_path: "f", new_path: "f", diff: "@@ -1 +1 @@\n-1\n+2", new_file: false, renamed_file: false, deleted_file: false }],
      [`GET /api/v4/projects/group%2Fproj/pipelines?sha=${sha}&per_page=100`]: () => [],
    });
    const p = (await gitlab.create({}, ctx(s.fetch))) as ScmProvider;
    const d = await p.describeChange!({ ...mr, id: `gitlab:group/proj@${sha}`, kind: "direct_push", mergedBy: null });
    expect(d).toMatchObject({ title: "Hotfix", body: "Details.", gitattributes: null, checks: [] });
  });

  it("maps every pipeline status", () => {
    expect(["success", "failed", "canceled", "skipped", "running", "pending", "created", "manual", "scheduled", "odd"].map(pipelineState)).toEqual(["success", "failure", "failure", "skipped", "pending", "pending", "pending", "pending", "pending", "unknown"]);
  });
});

describe("Bitbucket Cloud describeChange, synthetic (documented 2.0 shapes)", () => {
  const sha = "f".repeat(40);
  const pr: ChangeRecord = { id: "bitbucket-cloud:ws/repo#3", kind: "pull_request", repo: "ws/repo", url: "https://bitbucket.org/ws/repo/pull-requests/3", mergeSha: sha, mergedAt: "2026-08-01T00:00:00Z", author: { login: "dev", kind: "human" }, mergedBy: { login: "lead", kind: "human" }, reviews: [], changedLines: 3, labels: [] };
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " same",
    "diff --git a/old.txt b/new.txt",
    "similarity index 90%",
    "rename from old.txt",
    "rename to new.txt",
    "diff --git a/logo.png b/logo.png",
    "new file mode 100644",
    "Binary files /dev/null and b/logo.png differ",
    "",
  ].join("\n");

  it("joins the diffstat (paged) with the unified diff, split per file, and maps the commit statuses", async () => {
    const s = fakeScm({
      "GET /2.0/repositories/ws/repo/pullrequests/3": () => ({ title: "PR", description: "desc", source: { commit: { hash: "9".repeat(12) } } }),
      "GET /2.0/repositories/ws/repo/pullrequests/3/diffstat?pagelen=500": () => ({ values: [{ status: "modified", lines_added: 1, lines_removed: 1, old: { path: "src/a.ts" }, new: { path: "src/a.ts" } }], next: "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/3/diffstat?pagelen=500&page=2" }),
      "GET /2.0/repositories/ws/repo/pullrequests/3/diffstat?pagelen=500&page=2": () => ({ values: [{ status: "renamed", lines_added: 0, lines_removed: 0, old: { path: "old.txt" }, new: { path: "new.txt" } }, { status: "added", lines_added: 0, lines_removed: 0, old: null, new: { path: "logo.png" } }] }),
      "GET /2.0/repositories/ws/repo/pullrequests/3/diff": () => diff,
      [`GET /2.0/repositories/ws/repo/src/${sha}/.gitattributes`]: () => "*.png -diff\n",
      [`GET /2.0/repositories/ws/repo/commit/${"9".repeat(12)}/statuses?pagelen=100`]: () => ({ values: [{ key: "build", name: "Build", state: "SUCCESSFUL", url: "https://ci/b" }, { key: "deploy", state: "STOPPED" }, { key: "test", name: "", state: "INPROGRESS" }] }),
    });
    const p = (await bitbucketCloud.create({}, ctx(s.fetch))) as ScmProvider;
    const d = await p.describeChange!(pr);
    valid(d, pr.id);
    expect(d.files).toEqual([
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n-old\n+new\n same" },
      { path: "new.txt", previousPath: "old.txt", status: "renamed", additions: 0, deletions: 0, patch: null },
      { path: "logo.png", status: "added", additions: 0, deletions: 0, patch: null },
    ]);
    expect(d.checks).toEqual([
      { name: "Build", state: "success", url: "https://ci/b" },
      { name: "deploy", state: "failure", url: null },
      { name: "test", state: "pending", url: null },
    ]);
    expect(d).toMatchObject({ title: "PR", body: "desc", gitattributes: "*.png -diff\n" });
    expect(s.seen.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("Bitbucket Data Center describeChange, synthetic (documented REST 1.0 shapes; unverified against a live server)", () => {
  const sha = "1".repeat(40);
  const pr: ChangeRecord = { id: "bitbucket-data-center:PROJ/repo#5", kind: "pull_request", repo: "PROJ/repo", url: "https://bb.example.com/projects/PROJ/repos/repo/pull-requests/5", mergeSha: sha, mergedAt: "2026-08-01T00:00:00Z", author: { login: "dev", kind: "human" }, mergedBy: { login: "lead", kind: "human" }, reviews: [], changedLines: 3, labels: [] };

  it("turns the JSON diff into unified hunks, pages the changes, and reads the build statuses", async () => {
    const r = "/rest/api/1.0/projects/PROJ/repos/repo";
    const s = fakeScm({
      [`GET ${r}/pull-requests/5`]: () => ({ title: "DC", description: "text", fromRef: { latestCommit: "2".repeat(40) } }),
      [`GET ${r}/pull-requests/5/changes?start=0&limit=1000`]: () => ({ values: [{ path: { toString: "a.txt" }, type: "MODIFY" }], isLastPage: false, nextPageStart: 1 }),
      [`GET ${r}/pull-requests/5/changes?start=1&limit=1000`]: () => ({ values: [{ path: { toString: "b.txt" }, srcPath: { toString: "c.txt" }, type: "MOVE" }, { path: { toString: "d.txt" }, type: "DELETE" }], isLastPage: true }),
      [`GET ${r}/pull-requests/5/diff?contextLines=3`]: () => ({
        diffs: [
          { source: { toString: "a.txt" }, destination: { toString: "a.txt" }, hunks: [{ sourceLine: 1, sourceSpan: 2, destinationLine: 1, destinationSpan: 2, segments: [{ type: "CONTEXT", lines: [{ line: "same" }] }, { type: "REMOVED", lines: [{ line: "x" }] }, { type: "ADDED", lines: [{ line: "y" }] }] }] },
          { source: { toString: "d.txt" }, destination: null, hunks: [{ sourceLine: 1, sourceSpan: 1, destinationLine: 0, destinationSpan: 0, segments: [{ type: "REMOVED", lines: [{ line: "gone" }] }] }] },
        ],
      }),
      [`GET ${r}/raw/.gitattributes?at=${sha}`]: () => "*.txt text\n",
      [`GET /rest/build-status/1.0/commits/${"2".repeat(40)}`]: () => ({ values: [{ key: "ci", name: "CI", state: "FAILED", url: "https://ci/x" }] }),
    });
    const p = (await bitbucketDc.create({ base_url: "https://bb.example.com" }, ctx(s.fetch))) as ScmProvider;
    const d = await p.describeChange!(pr);
    valid(d, pr.id);
    expect(d.files).toEqual([
      { path: "a.txt", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n same\n-x\n+y" },
      { path: "b.txt", previousPath: "c.txt", status: "renamed", additions: 0, deletions: 0, patch: null },
      { path: "d.txt", status: "removed", additions: 0, deletions: 1, patch: "@@ -1,1 +0,0 @@\n-gone" },
    ]);
    expect(d.checks).toEqual([{ name: "CI", state: "failure", url: "https://ci/x" }]);
    expect(d).toMatchObject({ title: "DC", body: "text", gitattributes: "*.txt text\n", truncated: false });
  });
});

describe("describeChange through the read-only fetch broker (as the MCP server runs it)", () => {
  it("sends only GETs, and a raw text body is not checked as JSON", async () => {
    const rec = readJsonFixture<Recording>("github", "gh-aw-q3-draws-2026-11-04.json");
    const replay = replayFetch(rec);
    const methods: string[] = [];
    const actx = createAuditContext({ mode: "read-only", fetch: (async (u: string | URL | Request, init?: RequestInit) => (methods.push((init?.method ?? "GET").toUpperCase()), replay(u, init))) as typeof fetch });
    const p = await openProvider(actx, { use: "github", options: {} }, process.cwd());
    const d = await p.describeChange!(byId.get("github:github/gh-aw#49685")!);
    expect(d).toEqual(changesFile.descriptions["github:github/gh-aw#49685"]);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });

  it("HttpClient.getText returns the body as sent, null on 404, and asks the broker for no JSON check", async () => {
    const inits: RequestInit[] = [];
    const f = (async (u: string | URL | Request, init?: RequestInit) => {
      inits.push(init!);
      return String(u).endsWith("/missing") ? new Response("nope", { status: 404 }) : new Response("not { json", { status: 200 });
    }) as typeof fetch;
    const http = new HttpClient({ provider: "x", baseUrl: "https://scm.example.com", fetch: f, maxRetries: 0 });
    expect(await http.getText("/raw")).toBe("not { json");
    expect(await http.getText("/missing")).toBeNull();
    expect((inits[0] as { retry?: { acceptJson?: unknown } }).retry?.acceptJson).toBeUndefined();
    // Through the broker too: a non-JSON 200 passes, unretried.
    const actx = createAuditContext({ mode: "read-only", fetch: f });
    const viaBroker = new HttpClient({ provider: "x", baseUrl: "https://scm.example.com", fetch: actx.broker.bind("provider:x"), maxRetries: 0 });
    expect(await viaBroker.getText("/raw")).toBe("not { json");
  });
});

describe("diff helpers and the description validator", () => {
  it("countPatch counts only hunk lines", () => {
    expect(countPatch("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n+b\n c\n--- not a header")).toEqual({ additions: 1, deletions: 2 });
  });

  it("splitUnifiedDiff handles new, deleted, renamed and binary files", () => {
    const d = splitUnifiedDiff(["diff --git a/n b/n", "new file mode 100644", "--- /dev/null", "+++ b/n", "@@ -0,0 +1 @@", "+hi", "diff --git a/g b/g", "deleted file mode 100644", "--- a/g", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", "diff --git a/b.bin b/b.bin", "deleted file mode 100644", "Binary files a/b.bin and /dev/null differ", ""].join("\n"));
    expect(d.map((f) => [f.path, f.oldPath, f.newPath, f.patch !== null, f.additions, f.deletions])).toEqual([
      ["n", null, "n", true, 1, 0],
      ["g", "g", null, true, 0, 1],
      ["b.bin", "b.bin", null, false, 0, 0],
    ]);
  });

  it("changeDescriptionProblems names each malformed field", () => {
    expect(changeDescriptionProblems({ changeId: "x", title: 1, body: "", files: [{ path: "", status: "moved", additions: -1, deletions: 0, patch: 3 }], gitattributes: 5, checks: [{ name: "c", state: "green", url: 1 }], truncated: "no" }, "y")).toEqual([
      'changeId "x" is not the described change y',
      "title must be a string",
      "gitattributes must be a string or null",
      "truncated must be true or false",
      "files[0].path must be a non-empty string",
      "files[0].status must be one of added, modified, removed, renamed",
      "files[0].additions must be a non-negative integer",
      "files[0].patch must be a string or null",
      "checks[0].state must be one of success, failure, neutral, pending, skipped, unknown",
      "checks[0].url must be a string or null",
    ]);
  });
});
