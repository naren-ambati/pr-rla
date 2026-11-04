import { describe, expect, it } from "vitest";
import { GitHubProvider } from "../src/providers/github/index.js";
import { GitLabProvider } from "../src/providers/gitlab/index.js";
import type { ChangeRecord } from "../src/sdk/provider.js";
import { readJsonFixture } from "./helpers/fixtures.js";
import { recordedWalkClock, replayFetch, type Recording } from "./helpers/replay-fetch.js";

/**
 * P1 (pass-2 review, "tests that cannot fail"): the four recorded GraphQL fixtures had only their request hashes
 * updated when the ledger round's queries began selecting paging fields and GitLab's note tags, so the responses
 * lacked them and the new code never ran on recorded data. The GitLab responses now carry GitLab's own tags
 * (systemNoteMetadata) and the user pages' pageInfo, taken from one anonymous read-only GET of the same query per
 * recorded POST on 2026-11-04 (see each file's graphqlQueryNote; the October one is read on its walk clock); the GitHub one carries totalCount and pageInfo,
 * derived from its recorded node counts (each page held fewer nodes than it asked for). These tests show the providers
 * read those fields on the recordings: change one, and what the provider does changes.
 */
type Rec = Recording & { options: Record<string, unknown>; window: { opensAt: string; closesAt: string }; repo: string; graphqlQueryNote: string };
type Gql = { method: string; url: string; response?: { data?: { project?: { mergeRequests?: { nodes: GlMr[] }; mergeRequest?: GlMr } } } };
type GlMr = { iid: string; notes?: { nodes: { system: boolean; body: string; systemNoteMetadata?: { action: string | null } | null }[] }; approvedBy?: { pageInfo?: unknown }; reviewers?: { pageInfo?: unknown } };
const kinds: ("pull_request" | "direct_push")[] = ["pull_request", "direct_push"];
const reviewsOf = (changes: readonly ChangeRecord[]) => Object.fromEntries(changes.map((c) => [c.id, c.reviews.map((r) => `${r.author.login} ${r.state} ${r.submittedAt}${r.timeUnknown ? " ?" : ""}`)]));

const gitlab = (name: string, walk = false) => {
  const rec = readJsonFixture<Rec>("gitlab", name);
  const clock = walk ? recordedWalkClock(rec) : Date.parse(rec.recordedAt);
  const list = (r: Rec = rec) => new GitLabProvider(r.options as never, { cwd: ".", env: {}, log: () => {}, fetch: replayFetch(r), now: () => clock }).listChanges({ repo: r.repo, window: r.window, kinds });
  const mrs = (r: Rec) => (r.exchanges as Gql[]).filter((e) => e.method === "POST").flatMap((e) => e.response?.data?.project?.mergeRequests?.nodes ?? (e.response?.data?.project?.mergeRequest ? [e.response.data.project.mergeRequest] : []));
  return { rec, list, mrs };
};

describe("GitLab: the recorded responses carry GitLab's note tags and the user pages' pageInfo, and the provider reads them", () => {
  for (const [name, walk] of [["gitlab-org-cli-2026-11-02.json", false], ["freedesktop-xserver-2026-10-05.json", false], ["gitlab-org-cli-2026-10.json", true]] as const) {
    it(`${name}: every note is tagged, and an approval read by its tag survives a body in another language`, async () => {
      const g = gitlab(name, walk);
      const notes = g.mrs(g.rec).flatMap((m) => m.notes?.nodes ?? []);
      expect(g.rec.graphqlQueryNote).toMatch(/\(P1\): every note in the recorded responses gained GitLab's own tag/);
      const untagged = notes.filter((n) => !("systemNoteMetadata" in n));
      // gitlab-org/cli: 4 comments in a second they share with another, scrubbed to "(comment)", stay untagged (read as comments).
      expect(untagged.every((n) => !n.system && n.body === "(comment)")).toBe(true);
      expect(g.mrs(g.rec).every((m) => !m.approvedBy || m.approvedBy.pageInfo) && g.mrs(g.rec).every((m) => !m.reviewers || m.reviewers.pageInfo)).toBe(true);
      const tags = new Set(notes.map((n) => n.systemNoteMetadata?.action).filter(Boolean));
      const before = reviewsOf((await g.list()).changes);
      // Every tagged approval, unapproval and reset rewritten into French: read by the tag, the reviews do not change.
      const french = structuredClone(g.rec);
      let rewritten = 0;
      for (const m of g.mrs(french))
        for (const n of m.notes?.nodes ?? [])
          if (n.system && ["approved", "unapproved", "approvals_reset", "requested_changes"].includes(n.systemNoteMetadata?.action ?? "")) {
            n.body = `${n.body.includes("@") ? n.body.replace(/^[^@]*/, "a réinitialisé les approbations de ") : "a approuvé cette demande de fusion"}`;
            rewritten++;
          }
      if (rewritten) expect(reviewsOf((await g.list(french)).changes)).toEqual(before);
      // And with the tags taken away, the same French bodies are read as nothing: the tag is what the provider used.
      const untaggedFrench = structuredClone(french);
      for (const m of g.mrs(untaggedFrench)) for (const n of m.notes?.nodes ?? []) delete n.systemNoteMetadata;
      if (rewritten) expect(reviewsOf((await g.list(untaggedFrench)).changes)).not.toEqual(before);
      expect(tags.size).toBeGreaterThan(1);
      if (name.startsWith("gitlab-org-cli")) expect(rewritten).toBeGreaterThan(0);
    });
  }
});

describe("GitHub: the recorded responses carry totalCount and pageInfo, and the provider pages by them", () => {
  const rec = readJsonFixture<Rec>("github", "gh-aw-2026-11-02.json");
  const list = (r: Rec) => new GitHubProvider(r.options as never, { cwd: ".", env: {}, log: () => {}, fetch: replayFetch(r), now: () => Date.parse(rec.recordedAt) }).listChanges({ repo: r.repo, window: r.window, kinds });
  type GhRepo = Record<string, { labels?: { totalCount?: number; pageInfo?: { hasNextPage: boolean } }; history?: { nodes: { parents: { totalCount?: number }; associatedPullRequests: { totalCount?: number; pageInfo?: { hasNextPage: boolean } } }[] } }>;
  const repos = (r: Rec) => (r.exchanges as { method: string; response?: { data?: { repository?: GhRepo } } }[]).filter((e) => e.method === "POST").map((e) => e.response?.data?.repository ?? {});

  it("every PR's labels and every commit's parents and associated PRs say how many there are", () => {
    const prs = repos(rec).flatMap((r) => Object.values(r).filter((v) => v?.labels));
    const commits = repos(rec).flatMap((r) => (r as { object?: { history?: { nodes: unknown[] } } }).object?.history?.nodes ?? []) as { parents: { totalCount?: number }; associatedPullRequests: { totalCount?: number; pageInfo?: unknown } }[];
    expect(prs.length).toBeGreaterThan(30);
    expect(prs.every((p) => typeof p.labels!.totalCount === "number" && p.labels!.pageInfo)).toBe(true);
    expect(commits.length).toBeGreaterThan(100);
    expect(commits.every((c) => typeof c.parents.totalCount === "number" && typeof c.associatedPullRequests.totalCount === "number" && c.associatedPullRequests.pageInfo)).toBe(true);
    expect(rec.graphqlQueryNote).toMatch(/\(P1\): the responses now carry the fields the queries select, derived from the recorded nodes/);
  });

  it("a labels page that says it has more makes the provider ask for the rest; a commit with more parents than it holds makes it read them", async () => {
    expect((await list(rec)).changes.length).toBeGreaterThan(0);
    const moreLabels = structuredClone(rec);
    const pr = repos(moreLabels).flatMap((r) => Object.values(r).filter((v) => v?.labels))[0]!;
    pr.labels!.pageInfo = { hasNextPage: true, endCursor: "x" } as never;
    pr.labels!.totalCount = 99;
    // The MORE_LABELS request was never recorded: the provider asking for it is what the replay refuses.
    await expect(list(moreLabels)).rejects.toThrow(/replayFetch: unrecorded request POST https:\/\/api\.github\.com\/graphql/);
    const moreParents = structuredClone(rec);
    const commit = repos(moreParents).flatMap((r) => (r as { object?: { history?: { nodes: { parents: { totalCount?: number } }[] } } }).object?.history?.nodes ?? [])[0]!;
    commit.parents.totalCount = 3;
    await expect(list(moreParents)).rejects.toThrow(/replayFetch: unrecorded request POST https:\/\/api\.github\.com\/graphql/);
  });
});
