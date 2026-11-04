import { describe, expect, it } from "vitest";
import { applySelector, DEFAULT_SELECTOR, hasHumanDecision, normalizeSelector, sameAccount } from "../src/core/selector.js";
import type { Actor, ChangeRecord, Review } from "../src/sdk/provider.js";

// Finding 4 of the master review: a review counts as a human decision only if it was submitted at or
// before mergedAt, by a non-bot account that is not the change's author (docs/design/spec.md).
const human = (login: string, id?: string): Actor => ({ login, kind: "human", ...(id ? { id } : {}) });
const bot = (login: string): Actor => ({ login, kind: "bot" });
const MERGED = "2026-01-02T00:00:00Z";
const change = (author: Actor, reviews: Review[]): ChangeRecord => ({
  id: "github:o/r#1",
  kind: "pull_request",
  repo: "o/r",
  url: "u",
  mergeSha: "a".repeat(40),
  mergedAt: MERGED,
  author,
  mergedBy: author,
  reviews,
  changedLines: 1,
  labels: [],
});
const rev = (author: Actor, submittedAt: string, state: Review["state"] = "APPROVED"): Review => ({ author, state, submittedAt });
const select = (c: ChangeRecord, cutoff = "2026-01-10T00:00:00Z") => applySelector([c], DEFAULT_SELECTOR, cutoff).selected.length;

describe("selector review rules (finding 4)", () => {
  it("an author's own approval dated after the merge does not hide the change (the reproduction)", () => {
    expect(select(change(human("alice"), [rev(human("alice"), "2026-01-09T00:00:00Z")]))).toBe(1);
  });

  it("an approval after mergedAt does not count, one at mergedAt does", () => {
    const bob = human("bob", "2");
    expect(select(change(human("alice", "1"), [rev(bob, "2026-01-02T00:00:01Z")]))).toBe(1);
    expect(select(change(human("alice", "1"), [rev(bob, MERGED)]))).toBe(0);
    expect(select(change(human("alice", "1"), [rev(bob, "2026-01-01T23:59:59Z", "CHANGES_REQUESTED")]))).toBe(0);
  });

  it("the author's own approval before the merge does not count either", () => {
    expect(select(change(human("alice"), [rev(human("Alice"), "2026-01-01T00:00:00Z")]))).toBe(1);
  });

  it("accounts are compared by id where both have one, by login otherwise", () => {
    const a = human("alice", "1");
    expect(sameAccount(a, human("alice-renamed", "1"))).toBe(true); // a renamed author is still the author
    expect(sameAccount(a, human("alice", "2"))).toBe(false); // a login re-used by another account is not
    expect(sameAccount(a, human("ALICE"))).toBe(true); // one side has no id: login, case-insensitively
    expect(select(change(a, [rev(human("alice-renamed", "1"), "2026-01-01T00:00:00Z")]))).toBe(1);
    expect(select(change(a, [rev(human("alice", "2"), "2026-01-01T00:00:00Z")]))).toBe(0);
  });

  it("bot reviews, COMMENTED and DISMISSED stay non-decisions; a real prior human approval still hides the change", () => {
    const c = change(human("alice", "1"), [rev(bot("copilot[bot]"), "2026-01-01T00:00:00Z"), rev(human("bob", "2"), "2026-01-01T00:00:00Z", "COMMENTED"), rev(human("bob", "2"), "2026-01-01T00:00:00Z", "DISMISSED")]);
    expect(select(c)).toBe(1);
    expect(select({ ...c, reviews: [...c.reviews, rev(human("bob", "2"), "2026-01-01T12:00:00Z")] })).toBe(0);
  });

  it("the post-merge review is still kept on the change (only the stratum moves), and unreviewed:no-review is unchanged", () => {
    const c = change(human("alice"), [rev(human("alice"), "2026-01-09T00:00:00Z")]);
    expect(applySelector([c], normalizeSelector({ unreviewed: "no-review" }), "2026-01-10T00:00:00Z").selected).toHaveLength(0);
    expect(applySelector([c], DEFAULT_SELECTOR, "2026-01-10T00:00:00Z").selected[0]!.reviews).toHaveLength(1);
    expect(hasHumanDecision(c, c.reviews)).toBe(false);
  });
});
