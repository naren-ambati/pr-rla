import { describe, expect, it } from "vitest";
import { attributeCommits } from "../src/providers/attribution.js";

describe("lazy commit attribution", () => {
  const commits = ["aaa1", "bbb2", "ccc3", "ddd4"].map((sha) => ({ sha, key: `k-${sha}` }));
  const lists: Record<number, { sha: string; key?: string }[]> = { 1: [{ sha: "bbb2" }], 2: [{ sha: "zzz9", key: "k-ccc3" }], 3: [{ sha: "eee5" }] };

  it("claims by known SHA, then by listed SHA, then by rebase key; stops reading once nothing is unclaimed", async () => {
    const read: number[] = [];
    const r = await attributeCommits({
      commits: commits.slice(0, 3),
      sha: (c) => c.sha,
      known: new Map([["aaa1", 7]]),
      prs: [1, 2, 3],
      readCommits: async (pr) => (read.push(pr), lists[pr]!),
      rebaseKey: (c) => c.key,
    });
    expect(r).toMatchObject({ pushes: [], linked: 3, byRebase: 1, listsRead: 2 });
    expect(read).toEqual([1, 2]); // PR 3 is never read
  });

  it("gives the same direct pushes whatever the reading order; abbreviated known SHAs match by prefix", async () => {
    const run = (prs: number[]) => attributeCommits({ commits, sha: (c) => c.sha, known: new Map([["aa", 7]]), prefixLength: 2, prs, readCommits: async (pr) => lists[pr]!, rebaseKey: (c) => c.key });
    const a = await run([1, 2, 3]);
    const b = await run([3, 2, 1]);
    expect(a.pushes.map((c) => c.sha)).toEqual(["ddd4"]);
    expect(b.pushes).toEqual(a.pushes);
  });
});
