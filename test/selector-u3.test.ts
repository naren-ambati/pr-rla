import { describe, expect, it } from "vitest";
import { statusLine, stratumChoices } from "../src/commands/status.js";
import { buildPopulation } from "../src/core/population.js";
import { actorMatches, applyBotList, applySelector, BOT_LIST_STEP, normalizeSelector, VIA_MERGE_STEP } from "../src/core/selector.js";
import { landedViaMerges } from "../src/providers/landed-via.js";
import type { ChangeRecord, ListChangesRequest, ScmProvider } from "../src/sdk/provider.js";

const sha = (c: string) => c.repeat(40);
const W = { opensAt: "2026-08-01T00:00:00Z", closesAt: "2026-08-02T00:00:00Z" };
const human = (login: string, id?: string) => ({ login, kind: "human" as const, ...(id ? { id } : {}) });
const pr = (n: number, approver: ReturnType<typeof human>, author = human("bob", "1")): ChangeRecord => ({
  id: `x:o/r#${n}`,
  kind: "pull_request",
  repo: "o/r",
  url: `u${n}`,
  mergeSha: sha(String(n)),
  mergedAt: "2026-08-01T10:00:00Z",
  author,
  mergedBy: human("maint", "2"),
  reviews: [{ author: approver, state: "APPROVED", submittedAt: "2026-08-01T09:00:00Z" }],
  changedLines: 10,
  labels: [],
});
const push = (c: string, landedVia?: string): ChangeRecord => ({ id: `x:o/r@${sha(c)}`, kind: "direct_push", repo: "o/r", url: c, mergeSha: sha(c), mergedAt: "2026-08-01T11:00:00Z", author: human("git:a@example.com"), mergedBy: null, reviews: [], changedLines: 1, labels: [], ...(landedVia ? { landedVia } : {}) });

describe("selector.bots (FR7.1): registered, applied by the core to every actor", () => {
  it("is validated, trimmed, de-duplicated and sorted; id:<n> entries are allowed", () => {
    expect(normalizeSelector({ bots: [" gitlab-bot", "Gitlab-Bot", "id:1786152", "marge-bot", "id:1786152"] }).bots).toEqual(["gitlab-bot", "id:1786152", "marge-bot"]);
    expect(normalizeSelector({}).bots).toEqual([]);
    expect(() => normalizeSelector({ bots: ["ok", ""] })).toThrow(/selector.bots must be a list of logins or "id:<account id>" entries/);
    expect(() => normalizeSelector({ bots: ["id:"] })).toThrow(/selector.bots/);
    expect(() => normalizeSelector({ bots: "gitlab-bot" })).toThrow(/selector.bots/);
  });

  it("re-labels author, merger and reviews on copies, keeping logins; the funnel counts the re-labelled entries", () => {
    const changes = [pr(1, human("gitlab-bot", "1786152")), pr(2, human("carol", "3")), pr(3, human("GITLAB-BOT"), human("gitlab-bot", "1786152"))];
    const { changes: out, relabelled } = applyBotList(changes, ["gitlab-bot"]);
    expect(relabelled).toBe(3);
    expect(out[0]!.reviews[0]!.author).toEqual({ login: "gitlab-bot", kind: "bot", id: "1786152" });
    expect(out[2]!.author.kind).toBe("bot");
    expect(changes[0]!.reviews[0]!.author.kind).toBe("human"); // the provider's records are untouched
    const sel = applySelector(changes, normalizeSelector({ kinds: ["pull_request"], unreviewed: "no-human-review", bots: ["gitlab-bot"] }), "2026-08-02T00:00:00Z");
    expect(sel.funnel[1]).toEqual({ step: BOT_LIST_STEP, count: 3 });
    expect(sel.selected.map((c) => c.id)).toEqual(["x:o/r#1", "x:o/r#3"]);
    // No list, no step: phase-2 funnels are unchanged.
    expect(applySelector(changes, normalizeSelector({ kinds: ["pull_request"] }), "2026-08-02T00:00:00Z").funnel.map((s) => s.step)).not.toContain(BOT_LIST_STEP);
  });

  it("id:<n> matches Actor.id, never a login; a login matches by the registered account id, or as a login when none is registered", () => {
    expect(actorMatches(human("gitlab-bot", "1786152"), "id:1786152")).toBe(true);
    expect(actorMatches(human("1786152"), "id:1786152")).toBe(false);
    // No account map registered: the login, case-insensitively, and nothing else.
    expect(actorMatches(human("Alice"), "alice")).toBe(true);
    expect(actorMatches(human("alice-renamed", "42"), "alice")).toBe(false);
    // P5: with the registration's map (login -> id), by that id only: a rename matches, another account using the login does not.
    const accounts = new Map([["alice", "42"]]);
    expect(actorMatches(human("alice-renamed", "42"), "alice", accounts)).toBe(true);
    expect(actorMatches(human("alice", "43"), "ALICE", accounts)).toBe(false);
    expect(actorMatches(human("alice"), "alice", accounts)).toBe(false); // a git identity with no account never matches a bound login
    const renamed = [pr(1, human("carol", "3"), human("alice-renamed", "42"))];
    const sel = normalizeSelector({ kinds: ["pull_request"], authors: ["alice"], unreviewed: "any" });
    expect(applySelector(renamed, sel, W.closesAt).selected).toHaveLength(0);
    expect(applySelector(renamed, sel, W.closesAt, { accounts }).selected).toHaveLength(1);
    expect(applySelector(renamed, normalizeSelector({ kinds: ["pull_request"], authors: ["id:42"], unreviewed: "any" }), W.closesAt).selected).toHaveLength(1);
  });
});

describe("direct_push_via_merge (FR7.6): include by default, exclude drops landedVia records", () => {
  const changes = [push("m"), push("a", sha("m")), push("b", sha("m")), pr(1, human("carol", "3"))];
  it("include keeps every direct push and adds no funnel step", () => {
    const sel = applySelector(changes, normalizeSelector({ unreviewed: "any" }), W.closesAt);
    expect(sel.selected).toHaveLength(4);
    expect(sel.funnel.map((s) => s.step)).not.toContain(VIA_MERGE_STEP);
  });
  it("exclude removes the commits a pushed merge brought in, and keeps the merge itself", () => {
    const sel = applySelector(changes, normalizeSelector({ unreviewed: "any", direct_push_via_merge: "exclude" }), W.closesAt);
    expect(sel.selected.map((c) => c.id)).toEqual([`x:o/r@${sha("m")}`, "x:o/r#1"]);
    expect(sel.funnel[2]).toEqual({ step: VIA_MERGE_STEP, count: 2 });
    expect(() => normalizeSelector({ direct_push_via_merge: "drop" })).toThrow(/include or exclude/);
  });
  it("the certificate names the choice and the bot list", () => {
    expect(stratumChoices(normalizeSelector({ direct_push_via_merge: "exclude", bots: ["gitlab-bot"] }))).toBe(", registered bots gitlab-bot, direct pushes via a pushed merge excluded");
    expect(stratumChoices(normalizeSelector({}))).toBe(", direct pushes via a pushed merge included");
    expect(stratumChoices(normalizeSelector({ kinds: ["pull_request"] }))).toBe("");
    expect(stratumChoices({ kinds: ["pull_request", "direct_push"] })).toBe(""); // a v1 selector names neither
    const report = { N: 400, labelledPrefix: 36, drawsIssued: 36, sequence: { fails: 0, llr: 3.066, target: 2.996, state: "CERTIFIED", draws: 36 } } as never;
    expect(statusLine(report, { p0: 0.1, alpha: 0.05, protocol: "abcd1234", maxLines: 200, mode: "RETROSPECTIVE", selector: normalizeSelector({ direct_push_via_merge: "exclude" }) })).toMatch(/claim D \(detected-defect rate ≤ 10%, protocol abcd…, stratum ≤ 200 lines, direct pushes via a pushed merge excluded\) .* CERTIFIED \(risk 5%\)/);
  });
});

describe("pinned head (FR7.2) in the population builder", () => {
  it("passes request.head through and records the head the provider walked", async () => {
    const seen: ListChangesRequest[] = [];
    const provider: ScmProvider = { apiVersion: 1, name: "x", listChanges: async (req) => (seen.push(req), { changes: [], defaultBranch: "main", limitations: [], headSha: req.head ?? sha("f") }) };
    const args = { repo: "o/r", window: W, selector: normalizeSelector({}), cutoffIso: W.closesAt };
    expect((await buildPopulation(provider, args)).headSha).toBe(sha("f"));
    expect((await buildPopulation(provider, { ...args, head: sha("e") })).headSha).toBe(sha("e"));
    expect(seen.map((r) => r.head)).toEqual([undefined, sha("e")]);
    const old: ScmProvider = { apiVersion: 1, name: "old", listChanges: async () => ({ changes: [], defaultBranch: "main", limitations: [] }) };
    expect((await buildPopulation(old, { ...args, head: sha("e") })).headSha).toBeNull();
  });
});

describe("landedVia from the walked history (pure)", () => {
  // main (first parents): T -> m0. T is a pushed merge of a release branch: R2 -> R1 (a release-branch PR merge) -> r.
  const g = new Map<string, string[]>([
    ["T", ["m0", "R2"]],
    ["m0", ["base"]],
    ["R2", ["base", "R1"]],
    ["R1", ["rb", "r"]],
    ["r", ["rb"]],
    ["rb", ["base"]],
    ["base", []],
    ["F", ["L", "O"]], // a foxtrot merge: L is local work, O the real mainline
    ["L", ["T"]],
    ["O", ["T"]],
  ]);
  it("names the outermost pushed merge for nested release merges; the merge itself and first-parent commits get none", () => {
    const via = landedViaMerges(g, ["T", "R2", "R1", "r", "rb", "m0"]);
    expect([...via].sort()).toEqual([["R1", "T"], ["R2", "T"], ["r", "T"], ["rb", "T"]]);
  });
  it("only pushed merges count: a PR's merge commit (not a direct push) names nothing", () => {
    expect(landedViaMerges(g, ["r", "rb"]).size).toBe(0);
  });
  it("a foxtrot merge reports the mainline behind its second parent (the stated limitation)", () => {
    expect([...landedViaMerges(g, ["F", "L", "O"])]).toEqual([["O", "F"]]);
  });
});
