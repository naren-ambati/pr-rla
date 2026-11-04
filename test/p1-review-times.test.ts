import { describe, expect, it } from "vitest";
import { applySelector, DEFAULT_SELECTOR, isHumanDecision } from "../src/core/selector.js";
import { buildReviews as bitbucketCloudReviews } from "../src/providers/bitbucket-cloud/normalize.js";
import { buildReviews as dataCenterReviews } from "../src/providers/bitbucket-data-center/normalize.js";
import { buildReviews as gitlabReviews } from "../src/providers/gitlab/normalize.js";
import { changeRecordProblems, type ChangeRecord, type Review } from "../src/sdk/provider.js";

/**
 * P1, unknown review times (pass-2 review #4): the ledger round's rule "a review counts only if submitted at or
 * before the merge" read an unknown time as the merge time, so it counted. A review whose time the SCM does not give
 * is kept on the record with `timeUnknown` and is never a human decision: a GitLab approval without `approved_at`, a
 * GitLab reviewer state whose only time is its assignment, a Bitbucket Data Center final status (and a Bitbucket
 * Cloud one without `participated_on`). An unreadable GitLab approvals reset dismisses every approval standing before it.
 * Synthetic inputs in each SCM's own shapes.
 */
const MERGED = "2026-08-01T12:00:00Z";
const glActor = (u: { username: string } | null) => ({ login: u?.username ?? "ghost", kind: "human" as const });
const carol = { username: "carol", bot: false };
const dave = { username: "dave", bot: false };
const change = (reviews: Review[]): ChangeRecord => ({ id: "gitlab:acme/widgets#1", kind: "pull_request", repo: "acme/widgets", url: "u", mergeSha: "a".repeat(40), mergedAt: MERGED, author: { login: "bob", kind: "human" }, mergedBy: { login: "bob", kind: "human" }, reviews, changedLines: 3, labels: [] });
/** Whether the change stays in the default stratum (no human decision before the merge). */
const selected = (reviews: Review[]) => applySelector([change(reviews)], DEFAULT_SELECTOR, "2026-08-10T00:00:00Z").selected.length === 1;

describe("GitLab", () => {
  it("an approval with no approved_at is kept, timeUnknown, and is no decision: the change stays in the population (it used to be hidden)", () => {
    const r = gitlabReviews({ mrAuthor: "bob", notes: [], approvals: { approved_by: [{ user: carol }] }, reviewers: [], mergedAt: MERGED, actor: glActor });
    expect(r).toEqual([{ author: { login: "carol", kind: "human" }, state: "APPROVED", submittedAt: MERGED, timeUnknown: true }]);
    expect(isHumanDecision(change(r), r[0]!)).toBe(false);
    expect(selected(r)).toBe(true);
    // With its time, the same approval is a decision before the merge.
    const dated = gitlabReviews({ mrAuthor: "bob", notes: [], approvals: { approved_by: [{ user: carol, approved_at: "2026-08-01T11:00:00Z" }] }, reviewers: [], mergedAt: MERGED, actor: glActor });
    expect(selected(dated)).toBe(false);
  });

  it("a reviewer state with only its assignment time (created_at) is kept, timeUnknown, and is no decision", () => {
    const r = gitlabReviews({ mrAuthor: "bob", notes: [], approvals: null, reviewers: [{ user: carol, state: "requested_changes", created_at: "2026-08-01T09:00:00Z" }, { user: dave, state: "reviewed", created_at: "2026-08-01T09:00:00Z" }], mergedAt: MERGED, actor: glActor });
    expect(r.map((x) => [x.author.login, x.state, x.submittedAt, x.timeUnknown])).toEqual([
      ["carol", "CHANGES_REQUESTED", "2026-08-01T09:00:00Z", true],
      ["dave", "COMMENTED", "2026-08-01T09:00:00Z", true],
    ]);
    expect(selected(r)).toBe(true);
  });

  it("an approvals reset whose approvers cannot be read dismisses every approval standing before it, and approved_by approvals dated before it", () => {
    const notes = [
      { system: true, body: "approved this merge request", createdAt: "2026-08-01T09:00:00Z", author: carol, systemNoteMetadata: { action: "approved" } },
      // GitLab's tag says reset; the body (another language, or no @references) does not say whose.
      { system: true, body: "Genehmigungen zurückgesetzt", createdAt: "2026-08-01T10:00:00Z", author: { username: "pusher", bot: false }, systemNoteMetadata: { action: "approvals_reset" } },
    ];
    let unreadable = 0;
    const r = gitlabReviews({ mrAuthor: "bob", notes, approvals: { approved_by: [{ user: dave, approved_at: "2026-08-01T09:30:00Z" }] }, reviewers: [], mergedAt: MERGED, actor: glActor, onUnreadableReset: () => unreadable++ });
    expect(unreadable).toBe(1);
    // Before P1: carol's approval stood (the reset was only counted), and the change was hidden from the population.
    expect(r.map((x) => [x.author.login, x.state])).toEqual([["carol", "DISMISSED"], ["dave", "DISMISSED"]]);
    expect(selected(r)).toBe(true);
    // An approval after the reset stands.
    const later = gitlabReviews({ mrAuthor: "bob", notes: [...notes, { system: true, body: "approved this merge request", createdAt: "2026-08-01T11:00:00Z", author: carol, systemNoteMetadata: { action: "approved" } }], approvals: null, reviewers: [], mergedAt: MERGED, actor: glActor });
    expect(later.map((x) => x.state)).toEqual(["DISMISSED", "APPROVED"]);
    expect(selected(later)).toBe(false);
  });
});

describe("Bitbucket", () => {
  it("Data Center: a final status with no activity of its own is timeUnknown (dated at the merge), never a decision", () => {
    const alice = { slug: "alice", type: "NORMAL", id: 7 };
    const r = dataCenterReviews({ author: { slug: "bob", type: "NORMAL" }, activities: [], finals: [{ user: alice, status: "APPROVED" }, { user: { slug: "erin", type: "NORMAL" }, status: "NEEDS_WORK" }], mergedAtMs: Date.parse(MERGED) });
    expect(r.map((x) => [x.author.login, x.state, x.submittedAt, x.timeUnknown])).toEqual([
      ["alice", "APPROVED", MERGED, true],
      ["erin", "CHANGES_REQUESTED", MERGED, true],
    ]);
    expect(selected(r)).toBe(true);
    // An APPROVED activity gives the time: then it is a decision.
    const timed = dataCenterReviews({ author: { slug: "bob", type: "NORMAL" }, activities: [{ createdDate: Date.parse("2026-08-01T10:00:00Z"), user: alice, action: "APPROVED" }], finals: [{ user: alice, status: "APPROVED" }], mergedAtMs: Date.parse(MERGED) });
    expect(timed.map((x) => x.timeUnknown)).toEqual([undefined]);
    expect(selected(timed)).toBe(false);
  });

  it("Cloud: a participant's final approval with no participated_on is timeUnknown; with it, it keeps that time", () => {
    const u = { uuid: "{a}", nickname: "alice", type: "user" };
    const none = bitbucketCloudReviews({ author: { uuid: "{b}", nickname: "bob", type: "user" }, activity: [], participants: [{ state: "approved", user: u }], mergedAt: MERGED });
    expect(none.map((x) => [x.state, x.timeUnknown])).toEqual([["APPROVED", true]]);
    expect(selected(none)).toBe(true);
    const dated = bitbucketCloudReviews({ author: { uuid: "{b}", nickname: "bob", type: "user" }, activity: [], participants: [{ state: "approved", user: u, participated_on: "2026-08-01T10:00:00Z" }], mergedAt: MERGED });
    expect(dated.map((x) => [x.state, x.submittedAt, x.timeUnknown])).toEqual([["APPROVED", "2026-08-01T10:00:00Z", undefined]]);
    expect(selected(dated)).toBe(false);
  });
});

it("the SDK's record check accepts timeUnknown: true and nothing else", () => {
  const ok = change([{ author: { login: "carol", kind: "human" }, state: "APPROVED", submittedAt: MERGED, timeUnknown: true }]);
  expect(changeRecordProblems(ok)).toEqual([]);
  const bad = change([{ author: { login: "carol", kind: "human" }, state: "APPROVED", submittedAt: MERGED, timeUnknown: false as unknown as true }]);
  expect(changeRecordProblems(bad)).toEqual(["reviews[0].timeUnknown must be true when present"]);
});
