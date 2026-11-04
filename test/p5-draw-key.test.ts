import { describe, expect, it } from "vitest";
import { canonicalOrder, drawOrder } from "../src/core/draw-key.js";
import type { ManifestV2, RegistrationRecordV2, SignedRecord } from "../src/core/records.js";

/** P5 finding 1: the draw key (src/core/draw-key.ts; contracts.md §5, "Draws"), unit by unit. Synthetic records. */
describe("P5 finding 1: the draw key, byte for byte (contracts.md §5)", () => {
  const change = (id: string, repo: string) => ({ id, repo, kind: id.includes("#") ? ("pull_request" as const) : ("direct_push" as const), url: "u", mergeSha: "a".repeat(40), mergedAt: "2026-08-01T00:00:00Z", author: { login: "x", kind: "human" as const }, mergedBy: null, reviews: [], changedLines: 1, labels: [] });
  const sha = "b".repeat(40);

  it("a rule pool: scheme, the repo's id, then #n or @sha; names move nothing", () => {
    const set = { kind: "rule" as const, owner: "o", include: ["*"], exclude: [], archived: false, forks: false, visibility: ["public" as const] };
    const repos = [
      { repo: "o/zeta", repoId: "12" },
      { repo: "o/alpha", repoId: "123" },
    ];
    const changes = [change("github:o/alpha#2", "o/alpha"), change("github:o/zeta#10", "o/zeta"), change(`github:o/zeta@${sha}`, "o/zeta"), change("github:o/zeta#9", "o/zeta")];
    const o = canonicalOrder(set, repos, changes);
    expect(o.problems).toEqual([]);
    // The space after the repo id keeps a repository's changes together (repo id 12 before 123), pull requests before pushes.
    expect(o.keys).toEqual(["github:id:12 #10", "github:id:12 #9", `github:id:12 @${sha}`, "github:id:123 #2"]);
    // Renaming o/alpha to o/aaa changes the change ids but not one key, so not the order.
    const renamed = canonicalOrder(set, [repos[0]!, { repo: "o/aaa", repoId: "123" }], changes.map((c) => (c.repo === "o/alpha" ? { ...c, repo: "o/aaa", id: c.id.replace("o/alpha", "o/aaa") } : c)));
    expect(renamed.keys).toEqual(o.keys);
  });

  it("a repo or a list: the registered path, so a single repo keeps its change-id order; another spelling has no key", () => {
    const list = { kind: "list" as const, repos: ["github:o/App", "o/lib"] };
    const ok = canonicalOrder(list, [{ repo: "o/App", repoId: null }, { repo: "o/lib", repoId: null }], [change("github:o/lib#1", "o/lib"), change("github:o/App#3", "o/App")]);
    expect(ok.keys).toEqual(["github:o/App #3", "github:o/lib #1"]);
    const respelled = canonicalOrder(list, [{ repo: "o/app", repoId: null }, { repo: "o/lib", repoId: null }], [change("github:o/lib#1", "o/lib"), change("github:o/app#3", "o/app")]);
    expect(respelled.problems).toEqual(['manifest names 1 repo(s) that are not spelled byte for byte as the registered list does (e.g. "o/app"): a draw key takes the registered path, never another spelling']);
    expect(canonicalOrder({ kind: "repo", repo: "o/App" }, [{ repo: "O/App", repoId: null }], []).problems[0]).toMatch(/not the registered "o\/App" byte for byte/);
  });

  it("refuses ids that do not name their repo, a repo id a key cannot carry, two keys alike and two schemes", () => {
    const set = { kind: "rule" as const, owner: "o", include: ["*"], exclude: [], archived: false, forks: false, visibility: ["public" as const] };
    expect(canonicalOrder(set, [{ repo: "o/a", repoId: "1" }], [change("github:O/a#1", "o/a")]).problems[0]).toMatch(/whose id is not <scheme>:<repo>#<n>/);
    expect(canonicalOrder(set, [{ repo: "o/a", repoId: "1#2" }], []).problems[0]).toMatch(/no usable repo id/);
    expect(canonicalOrder(set, [{ repo: "o/a", repoId: "1" }, { repo: "o/b", repoId: "1" }], []).problems).toContain("manifest gives two repos of the rule pool the same repo id");
    expect(canonicalOrder(set, [{ repo: "o/a", repoId: "1" }, { repo: "o/b", repoId: "2" }], [change("github:o/a#1", "o/a"), change("gitlab:o/b#1", "o/b")]).problems[0]).toMatch(/2 id schemes/);
    expect(canonicalOrder(set, [{ repo: "o/a", repoId: "1" }], [change("github:o/b#1", "o/b")]).problems[0]).toMatch(/from a repo it does not list/);
  });

  it("schema v1 keeps the change-id order it was drawn with", () => {
    const v1 = { record: { schema: "pr-rla/registration/v1" } } as unknown as SignedRecord<RegistrationRecordV2>;
    const m = { schema: "pr-rla/manifest/v1", repo: "o/a", changes: [change("github:o/a#2", "o/a"), change("github:o/a#10", "o/a")] } as unknown as ManifestV2;
    const o = drawOrder(v1, m);
    expect(o.basis).toBe("id");
    expect(o.keys).toEqual(["github:o/a#10", "github:o/a#2"]); // v1: the ids themselves
  });
});
