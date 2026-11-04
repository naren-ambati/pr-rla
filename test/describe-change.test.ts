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

describe("GitHub describeChange on recorded gh-aw draws (github/gh-aw, read-only, recorded 2026-11-04)", () => {
  const rec = readJsonFixture<Recording & { changes: string[]; source: string }>("github", "gh-aw-q3-draws-2026-11-04.json");
  /** A recorded response body, by the end of its URL. */
  const raw = <T>(tail: string) => rec.exchanges.find((e) => e.url.endsWith(tail))!.response as T;
  const file = (b64: { content: string }) => Buffer.from(b64.content, "base64").toString("utf8");

  it("is marked recorded, and covers four of the audit's issued draws", () => {
    expect(rec.source).toBe("recorded");
    expect(rec.changes).toHaveLength(4);
    for (const id of rec.changes) expect(byId.has(id)).toBe(true);
  });

  it("replays, every recorded GET used once, to the descriptions the audit's changes.json holds (the recording and the export agree)", async () => {
    const replay = replayFetch(rec);
    const p = (await github.create({}, ctx(replay))) as ScmProvider;
    for (const id of rec.changes) {
      const d = await p.describeChange!(byId.get(id)!);
      valid(d, id);
      expect(d).toEqual(changesFile.descriptions[id]);
    }
    expect(replay.served()).toBe(rec.exchanges.length);
    expect(replay.unused()).toEqual([]);
    expect(rec.exchanges.every((e) => e.method === "GET")).toBe(true);
  });

  it("maps PR #42597 as GitHub's raw responses say (expected values written by hand from the recorded JSON)", async () => {
    const pr = raw<{ title: string; body: string; head: { sha: string }; base: { sha: string } }>("/pulls/42597");
    const files = raw<{ filename: string; patch: string }[]>("/pulls/42597/files?per_page=100");
    const head = "30b3a152ecda66706632abcaf228fd7e2cdf3b03"; // the merge commit (the manifest's mergeSha)
    const base = "eaef881ecdb70de471a8f737fb13f7799032620a"; // pr.base.sha
    expect(pr.base.sha).toBe(base);
    expect(byId.get("github:github/gh-aw#42597")!.mergeSha).toBe(head);
    const p = (await github.create({}, ctx(replayFetch(rec)))) as ScmProvider;
    const d = await p.describeChange!(byId.get("github:github/gh-aw#42597")!);
    expect(d).toEqual({
      changeId: "github:github/gh-aw#42597",
      title: "Add `tone_variant` A/B campaign to `breaking-change-checker` workflow",
      body: pr.body,
      files: [
        { path: ".github/workflows/breaking-change-checker.lock.yml", status: "modified", additions: 121, deletions: 1, patch: files[0]!.patch },
        { path: ".github/workflows/breaking-change-checker.md", status: "modified", additions: 33, deletions: 1, patch: files[1]!.patch },
        { path: ".github/workflows/pr-code-quality-reviewer.lock.yml", status: "modified", additions: 1, deletions: 1, patch: files[2]!.patch },
      ],
      gitattributes: file(raw(`/contents/.gitattributes?ref=${head}`)),
      // The root at both commits; the lock files' directories (both 404) because the root marks them generated at both.
      attributes: { baseSha: base, base: { "": file(raw(`/contents/.gitattributes?ref=${base}`)), ".github": null, ".github/workflows": null }, head: { "": file(raw(`/contents/.gitattributes?ref=${head}`)), ".github": null, ".github/workflows": null } },
      checks: [],
      truncated: false,
    });
    expect(d.gitattributes).toMatch(/^\*\.lock\.yml linguist-generated=true merge=ours$/m);
  });
});

describe("GitLab and Bitbucket Cloud describeChange on recorded public changes (anonymous, read-only, recorded 2026-11-04)", () => {
  for (const [scm, file] of [["gitlab", "describe-gitlab-org-cli-4191-2026-11-04.json"], ["bitbucket-cloud", "describe-bamboo-specs-745-2026-11-04.json"]] as const) {
    it(`${scm}: the recorded responses replay, through the read-only broker (redirects followed by hand), every one used`, async () => {
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

  it("gitlab-org/cli !4191 maps as GitLab's raw responses say (expected written by hand from the recorded JSON)", async () => {
    const rec = readJsonFixture<Recording & { change: ChangeRecord }>("gitlab", "describe-gitlab-org-cli-4191-2026-11-04.json");
    const mr = rec.exchanges[0]!.response as { description: string };
    const diffs = rec.exchanges[1]!.response as { diff: string }[];
    const p = await openProvider(createAuditContext({ mode: "read-only", fetch: replayFetch(rec) }), { use: "gitlab", options: {} }, process.cwd());
    const d = await p.describeChange!(rec.change);
    expect(d).toEqual({
      changeId: "gitlab:gitlab-org/cli#4191",
      title: "fix(mr issue): limit concurrent lookups in bulk commands",
      body: mr.description,
      files: [
        { path: "internal/api/default.go", status: "modified", additions: 3, deletions: 0, patch: diffs[0]!.diff },
        { path: "internal/commands/issue/issueutils/utils.go", status: "modified", additions: 4, deletions: 2, patch: diffs[1]!.diff },
        { path: "internal/commands/issue/issueutils/utils_test.go", status: "modified", additions: 50, deletions: 0, patch: diffs[2]!.diff },
        { path: "internal/commands/mr/mrutils/mrutils.go", status: "modified", additions: 1, deletions: 0, patch: diffs[3]!.diff },
        { path: "internal/commands/mr/mrutils/mrutils_test.go", status: "modified", additions: 49, deletions: 0, patch: diffs[4]!.diff },
      ],
      // Both .gitattributes lookups were 404s: the merge commit (74ed9d6…) and diff_refs.base_sha (3cfa787…).
      gitattributes: null,
      attributes: { baseSha: "3cfa7871e3809f1bc58254abfce6387c662b5ce2", base: { "": null }, head: { "": null } },
      // The one pipeline at diff_refs.head_sha, source duo_workflow; changes_count "5" = the 5 diffs listed.
      checks: [{ name: "pipeline #2997205784 (duo_workflow)", state: "success", url: "https://gitlab.com/gitlab-org/cli/-/pipelines/2997205784" }],
      truncated: false,
    });
  });

  it("atlassian/bamboo-specs #745 maps as Bitbucket's raw responses say (expected written by hand; two of them 302s)", async () => {
    const rec = readJsonFixture<Recording & { change: ChangeRecord }>("bitbucket-cloud", "describe-bamboo-specs-745-2026-11-04.json");
    expect(rec.exchanges.filter((e) => e.status === 302).map((e) => new URL(e.url).pathname)).toEqual(["/2.0/repositories/atlassian/bamboo-specs/pullrequests/745/diffstat", "/2.0/repositories/atlassian/bamboo-specs/pullrequests/745/diff"]);
    const pr = rec.exchanges[0]!.response as { description: string };
    const p = await openProvider(createAuditContext({ mode: "read-only", fetch: replayFetch(rec) }), { use: "bitbucket-cloud", options: {} }, process.cwd());
    const d = await p.describeChange!(rec.change);
    expect(d).toEqual({
      changeId: "bitbucket-cloud:atlassian/bamboo-specs#745",
      title: "BUMP: Update dependency net.bytebuddy:byte-buddy-agent to v1.18.16-jdk5",
      body: pr.description,
      files: [
        {
          path: "bamboo-specs-java-agent/pom.xml",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: ["@@ -24,7 +24,7 @@", "         <dependency>", "             <groupId>net.bytebuddy</groupId>", "             <artifactId>byte-buddy-agent</artifactId>", "-            <version>1.18.15-jdk5</version>", "+            <version>1.18.16-jdk5</version>", "         </dependency>", "     </dependencies>", " "].join("\n"),
        },
      ],
      gitattributes: null,
      attributes: { baseSha: "c2cef06b7807", base: { "": null }, head: { "": null } },
      checks: [
        { name: "renovate/stability-days", state: "success", url: "https://docs.renovatebot.com/key-concepts/minimum-release-age/" },
        { name: "+core+ Bamboo Specs - A Bamboo Specs - dependency-bump-net.bytebuddy-byte-buddy-agent-1.x", state: "success", url: "https://tardigrade-bamboo.internal.atlassian.com/browse/BS-SPECS831-1" },
        { name: "Pipeline - default", state: "success", url: "https://bitbucket.org/atlassian/bamboo-specs/pipelines/results/2220" },
        { name: "Pipeline - custom: trust-greenlight-pipeline", state: "success", url: "https://bitbucket.org/atlassian/bamboo-specs/pipelines/results/2221" },
      ],
      truncated: false,
    });
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
      "GET /repos/acme/widgets/pulls/7/files?per_page=100&page=2": () => [{ filename: "new.ts", previous_filename: "old.ts", status: "renamed", additions: 0, deletions: 0 }, { filename: "c.ts", previous_filename: "b.ts", status: "copied", additions: 2, deletions: 0 }],
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
      // A copy is an added file, its source the previousPath (it was a rename before the fix round).
      { path: "c.ts", previousPath: "b.ts", status: "added", additions: 2, deletions: 0, patch: null },
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
    expect(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"].map(githubFileStatus)).toEqual(["added", "removed", "modified", "renamed", "added", "modified", "modified"]);
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
    // A diff GitLab marks too_large has no patch and unknown counts: the description says truncated.
    expect(d).toMatchObject({ title: "Add", body: "Body", gitattributes: "big linguist-generated=true\n", truncated: true });
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
      [`GET /rest/build-status/1.0/commits/${"2".repeat(40)}?start=0&limit=1000`]: () => ({ values: [{ key: "ci", name: "CI", state: "FAILED", url: "https://ci/x" }], isLastPage: true }),
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

describe("describeChange: base attributes, truncation evidence and bounded paging (U5 fix round)", () => {
  const gh = (kind: ChangeRecord["kind"], sha = "a".repeat(40)): ChangeRecord =>
    kind === "pull_request"
      ? { id: "github:acme/widgets#7", kind, repo: "acme/widgets", url: "https://github.com/acme/widgets/pull/7", mergeSha: sha, mergedAt: "2026-08-01T00:00:00Z", author: { login: "dev", kind: "human" }, mergedBy: { login: "lead", kind: "human" }, reviews: [], changedLines: 3, labels: [] }
      : { id: `github:acme/widgets@${sha}`, kind, repo: "acme/widgets", url: "https://github.com/acme/widgets/commit/x", mergeSha: sha, mergedAt: "2026-08-01T00:00:00Z", author: { login: "dev", kind: "human" }, mergedBy: null, reviews: [], changedLines: 3, labels: [] };
  const b64 = (t: string) => ({ type: "file", encoding: "base64", content: Buffer.from(t).toString("base64") });
  const json = (v: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json", ...headers } });
  const H = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);

  it("GitHub: reads the .gitattributes at the PR's base and landed commits, and the directories above the files the root marks generated (only those)", async () => {
    const s = fakeScm({
      "GET /repos/acme/widgets/pulls/7": () => ({ title: "t", body: "", head: { sha: C }, base: { sha: B }, changed_files: 2 }),
      "GET /repos/acme/widgets/pulls/7/files?per_page=100": () => [{ filename: "gen/deep/x.lock.yml", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x" }, { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+a" }],
      [`GET /repos/acme/widgets/contents/.gitattributes?ref=${H}`]: () => b64("*.lock.yml linguist-generated\n"),
      [`GET /repos/acme/widgets/contents/.gitattributes?ref=${B}`]: () => b64("*.lock.yml linguist-generated\n"),
      [`GET /repos/acme/widgets/contents/gen/.gitattributes?ref=${B}`]: () => b64("deep/x.lock.yml -linguist-generated\n"),
      [`GET /repos/acme/widgets/commits/${C}/check-runs?per_page=100`]: () => ({ total_count: 0, check_runs: [] }),
      [`GET /repos/acme/widgets/commits/${C}/status?per_page=100`]: () => ({ total_count: 0, statuses: [] }),
    });
    const p = (await github.create({}, ctx(s.fetch))) as ScmProvider;
    const d = await p.describeChange!(gh("pull_request"));
    valid(d, "github:acme/widgets#7");
    expect(d.attributes).toEqual({ baseSha: B, base: { "": "*.lock.yml linguist-generated\n", gen: "deep/x.lock.yml -linguist-generated\n", "gen/deep": null }, head: { "": "*.lock.yml linguist-generated\n", gen: null, "gen/deep": null } });
    // src/ is never read: the root does not mark src/a.ts generated.
    expect(s.seen.some((r) => r.url.includes("/contents/src/"))).toBe(false);
    expect(s.seen.every((r) => r.method === "GET")).toBe(true);
  });

  it("GitHub direct push: its first parent is the base; truncated when its stats count more lines than listed, or at GitHub's 3,000-file cap", async () => {
    const commit = (files: unknown[], stats: unknown) => ({ commit: { message: "m" }, parents: [{ sha: B }], stats, files });
    const routes = (c: unknown) => ({
      [`GET /repos/acme/widgets/commits/${H}`]: () => c,
      [`GET /repos/acme/widgets/commits/${H}/check-runs?per_page=100`]: () => ({ total_count: 0, check_runs: [] }),
      [`GET /repos/acme/widgets/commits/${H}/status?per_page=100`]: () => ({ total_count: 0, statuses: [] }),
    });
    const one = [{ filename: "x", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }];
    const desc = async (c: unknown) => ((await github.create({}, ctx(fakeScm(routes(c)).fetch))) as ScmProvider).describeChange!(gh("direct_push"));
    expect(await desc(commit(one, { additions: 1, deletions: 1 }))).toMatchObject({ truncated: false, attributes: { baseSha: B } });
    expect((await desc(commit(one, { additions: 40, deletions: 1 }))).truncated).toBe(true);
    const many = Array.from({ length: 3000 }, (_, k) => ({ filename: `f${k}`, status: "added", additions: 0, deletions: 0 }));
    expect((await desc(commit(many, { additions: 0, deletions: 0 }))).truncated).toBe(true);
  });

  it("GitHub: the combined status is paged to its end, and check runs short of their total_count say checksTruncated", async () => {
    const api = "https://api.github.com/repos/acme/widgets";
    const s = fakeScm({
      "GET /repos/acme/widgets/pulls/7": () => ({ title: "t", body: "", head: { sha: C }, changed_files: 0 }),
      "GET /repos/acme/widgets/pulls/7/files?per_page=100": () => [],
      [`GET /repos/acme/widgets/commits/${C}/check-runs?per_page=100`]: () => ({ total_count: 5, check_runs: [{ name: "a", status: "completed", conclusion: "success", html_url: null }] }),
      [`GET /repos/acme/widgets/commits/${C}/status?per_page=100`]: () => json({ total_count: 2, statuses: [{ context: "s1", state: "success", target_url: null }] }, { link: `<${api}/commits/${C}/status?per_page=100&page=2>; rel="next"` }),
      [`GET /repos/acme/widgets/commits/${C}/status?per_page=100&page=2`]: () => ({ total_count: 2, statuses: [{ context: "s2", state: "failure", target_url: null }] }),
    });
    const d = await ((await github.create({}, ctx(s.fetch))) as ScmProvider).describeChange!(gh("pull_request"));
    expect(d.checks.map((c) => c.name)).toEqual(["a", "s1", "s2"]);
    expect(d.checksTruncated).toBe(true);
  });

  it("GitHub: a server that repeats its next page stops the walk, reported as truncated, instead of looping", async () => {
    const api = "https://api.github.com/repos/acme/widgets";
    const s = fakeScm({
      "GET /repos/acme/widgets/pulls/7": () => ({ title: "t", body: "", head: { sha: C }, changed_files: 1 }),
      "GET /repos/acme/widgets/pulls/7/files?per_page=100": () => json([{ filename: "x", status: "modified", additions: 1, deletions: 0 }], { link: `<${api}/pulls/7/files?per_page=100>; rel="next"` }),
      [`GET /repos/acme/widgets/commits/${C}/check-runs?per_page=100`]: () => ({ total_count: 0, check_runs: [] }),
      [`GET /repos/acme/widgets/commits/${C}/status?per_page=100`]: () => ({ total_count: 0, statuses: [] }),
    });
    const d = await ((await github.create({}, ctx(s.fetch))) as ScmProvider).describeChange!(gh("pull_request"));
    expect(d.files).toHaveLength(1);
    expect(d.truncated).toBe(true);
    expect(s.seen.filter((r) => r.url.includes("/files")).length).toBe(1);
  });

  it("the page cap stops an endless listing at 100 pages", async () => {
    const { followPages, MAX_DESCRIBE_PAGES } = await import("../src/providers/paging.js");
    let calls = 0;
    const r = await followPages(0, async (k: number) => (calls++, { items: [k], next: k + 1 }));
    expect(calls).toBe(MAX_DESCRIBE_PAGES);
    expect(r.complete).toBe(false);
    expect((await followPages(0, async () => ({ items: [1], next: null }))).complete).toBe(true);
  });

  it("GitLab: a collapsed diff, a changes_count past the listing, and a commit whose stats count more lines are truncated; base_sha is the base", async () => {
    const mrRoutes = (changesCount: string, diff: unknown) => ({
      "GET /api/v4/projects/g%2Fp/merge_requests/1": () => ({ title: "t", description: "", sha: C, diff_refs: { head_sha: C, base_sha: B }, changes_count: changesCount }),
      "GET /api/v4/projects/g%2Fp/merge_requests/1/diffs?per_page=100": () => [diff],
      [`GET /api/v4/projects/g%2Fp/pipelines?sha=${C}&per_page=100`]: () => [],
    });
    const mr: ChangeRecord = { id: "gitlab:g/p#1", kind: "pull_request", repo: "g/p", url: "https://gitlab.com/g/p/-/merge_requests/1", mergeSha: H, mergedAt: "2026-08-01T00:00:00Z", author: { login: "d", kind: "human" }, mergedBy: null, reviews: [], changedLines: 1, labels: [] };
    const ok = { old_path: "a", new_path: "a", diff: "@@ -1 +1 @@\n-x\n+y", new_file: false, renamed_file: false, deleted_file: false };
    const desc = async (r: Record<string, Handler>) => ((await gitlab.create({}, ctx(fakeScm(r).fetch))) as ScmProvider).describeChange!(mr);
    expect(await desc(mrRoutes("1", ok))).toMatchObject({ truncated: false, attributes: { baseSha: B } });
    expect((await desc(mrRoutes("1", { ...ok, diff: "", collapsed: true }))).truncated).toBe(true);
    expect((await desc(mrRoutes("1000+", ok))).truncated).toBe(true);
    const push = { ...mr, id: `gitlab:g/p@${H}`, kind: "direct_push" as const };
    const d = await ((await gitlab.create({}, ctx(fakeScm({
      [`GET /api/v4/projects/g%2Fp/repository/commits/${H}`]: () => ({ title: "t", message: "t", parent_ids: [B], stats: { additions: 9, deletions: 1 } }),
      [`GET /api/v4/projects/g%2Fp/repository/commits/${H}/diff?per_page=100`]: () => [ok],
      [`GET /api/v4/projects/g%2Fp/pipelines?sha=${H}&per_page=100`]: () => [],
    }).fetch))) as ScmProvider).describeChange!(push);
    expect(d).toMatchObject({ truncated: true, attributes: { baseSha: B } });
  });

  it("Bitbucket Cloud: a git-quoted path in the diff matches the diffstat's plain path; a repeated next page stops", async () => {
    const diff = ['diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"', "index 1..2 100644", '--- "a/caf\\303\\251.txt"', '+++ "b/caf\\303\\251.txt"', "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
    const sha = "f".repeat(40);
    const pr: ChangeRecord = { id: "bitbucket-cloud:ws/repo#3", kind: "pull_request", repo: "ws/repo", url: "https://bitbucket.org/ws/repo/pull-requests/3", mergeSha: sha, mergedAt: "2026-08-01T00:00:00Z", author: { login: "dev", kind: "human" }, mergedBy: null, reviews: [], changedLines: 2, labels: [] };
    const s = fakeScm({
      "GET /2.0/repositories/ws/repo/pullrequests/3": () => ({ title: "PR", description: "", source: { commit: { hash: "9".repeat(12) } }, destination: { commit: { hash: "8".repeat(12) } } }),
      "GET /2.0/repositories/ws/repo/pullrequests/3/diffstat?pagelen=500": () => ({ values: [{ status: "modified", lines_added: 1, lines_removed: 1, old: { path: "café.txt" }, new: { path: "café.txt" } }], next: "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/3/diffstat?pagelen=500" }),
      "GET /2.0/repositories/ws/repo/pullrequests/3/diff": () => diff,
      [`GET /2.0/repositories/ws/repo/commit/${"9".repeat(12)}/statuses?pagelen=100`]: () => ({ values: [] }),
    });
    const d = await ((await bitbucketCloud.create({}, ctx(s.fetch))) as ScmProvider).describeChange!(pr);
    expect(d.files).toEqual([{ path: "café.txt", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" }]);
    expect(d.truncated).toBe(true);
    expect(d.attributes?.baseSha).toBe("8".repeat(12));
  });

  it("Data Center: a COPY is an added file with its source; build statuses are paged; a missing nextPageStart stops the walk", async () => {
    const r = "/rest/api/1.0/projects/PROJ/repos/repo";
    const sha = "1".repeat(40);
    const pr: ChangeRecord = { id: "bitbucket-data-center:PROJ/repo#5", kind: "pull_request", repo: "PROJ/repo", url: "https://bb.example.com/projects/PROJ/repos/repo/pull-requests/5", mergeSha: sha, mergedAt: "2026-08-01T00:00:00Z", author: { login: "dev", kind: "human" }, mergedBy: null, reviews: [], changedLines: 3, labels: [] };
    const s = fakeScm({
      [`GET ${r}/pull-requests/5`]: () => ({ title: "DC", description: "", fromRef: { latestCommit: "2".repeat(40) }, toRef: { latestCommit: "3".repeat(40) } }),
      [`GET ${r}/pull-requests/5/changes?start=0&limit=1000`]: () => ({ values: [{ path: { toString: "copy.txt" }, srcPath: { toString: "orig.txt" }, type: "COPY" }], isLastPage: false }),
      [`GET ${r}/pull-requests/5/diff?contextLines=3`]: () => ({ diffs: [] }),
      [`GET /rest/build-status/1.0/commits/${"2".repeat(40)}?start=0&limit=1000`]: () => ({ values: [{ key: "a", state: "SUCCESSFUL" }], isLastPage: false, nextPageStart: 1 }),
      [`GET /rest/build-status/1.0/commits/${"2".repeat(40)}?start=1&limit=1000`]: () => ({ values: [{ key: "b", state: "FAILED" }], isLastPage: true }),
    });
    const d = await ((await bitbucketDc.create({ base_url: "https://bb.example.com" }, ctx(s.fetch))) as ScmProvider).describeChange!(pr);
    expect(d.files).toEqual([{ path: "copy.txt", previousPath: "orig.txt", status: "added", additions: 0, deletions: 0, patch: null }]);
    expect(d.checks.map((c) => [c.name, c.state])).toEqual([["a", "success"], ["b", "failure"]]);
    expect(d.checksTruncated).toBeUndefined();
    // The changes listing said "not the last page" but gave no next start: the walk stops, and the files are reported as truncated.
    expect(d.truncated).toBe(true);
    expect(d.attributes?.baseSha).toBe("3".repeat(40));
  });

  it("splitUnifiedDiff reads git-quoted paths in diff, rename and copy headers", () => {
    const d = splitUnifiedDiff(['diff --git "a/sp ace\\t.txt" "b/sp ace\\t.txt"', "new file mode 100644", "Binary files /dev/null and \"b/sp ace\\t.txt\" differ", 'diff --git "a/\\303\\251" "b/\\303\\250"', "similarity index 100%", 'rename from "\\303\\251"', 'rename to "\\303\\250"', ""].join("\n"));
    expect(d.map((f) => [f.path, f.oldPath, f.newPath])).toEqual([["sp ace\t.txt", null, "sp ace\t.txt"], ["è", "é", "è"]]);
  });

  it("describeChange stops when its signal aborts", async () => {
    const ac = new AbortController();
    ac.abort(new Error("stopped by the caller"));
    const scm = fakeScm({});
    // A transport that honours signals, as fetch and the broker do.
    const f = (async (u: string | URL | Request, init: RequestInit = {}) => (init.signal?.throwIfAborted(), scm.fetch(u, init))) as typeof fetch;
    const p = (await github.create({}, ctx(f))) as ScmProvider;
    await expect(p.describeChange!(gh("pull_request"), { signal: ac.signal })).rejects.toThrow("stopped by the caller");
    expect(scm.seen).toEqual([]);
  });
});
