import { createHash } from "node:crypto";
import { makeChanges } from "./audit-scenario.js";
import { BOT, U, buildScenario, type ScCommit, type ScPr, type ScUser } from "./scm-scenario.js";

/**
 * A Q3 2026 GitLab population for the end-to-end audit: the same 400 changes the
 * json-file e2e uses (makeChanges(400, { bad: 80 })), now as merged MRs (squash,
 * merge commit and fast-forward in turn, the first 80 labelled known-bad) and direct
 * pushes on one default-branch history, served by fake-gitlab.
 */
export function generatedGitLabScenario(N = 400, bad = 80) {
  const sha = (tag: string) => createHash("sha1").update(tag).digest("hex");
  const at = (iso: string, deltaSeconds: number) => new Date(Date.parse(iso) + deltaSeconds * 1000).toISOString().replace(".000Z", "Z");
  const changes = makeChanges(N, { bad }).sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : a.id < b.id ? -1 : 1));
  const root: ScCommit = { oid: sha("root"), date: "2026-06-30T00:00:00Z", authorDate: "2026-06-30T00:00:00Z", parents: [], author: { name: "Maint", email: "maint@example.com", user: U("maint") }, additions: 1, deletions: 0, subject: "root" };
  const commits: ScCommit[] = [root];
  const prs: ScPr[] = [];
  const maint = U("maint");
  const reviewer = BOT("copilot-pull-request-reviewer");
  let prev = root.oid;
  const commit = (tag: string, date: string, parents: string[], lines: number, who: ScUser = maint): ScCommit => {
    const c: ScCommit = { oid: sha(tag), date, authorDate: date, parents, author: { name: who.login, email: `${who.login}@example.com`, user: who }, additions: lines, deletions: 0, subject: tag };
    commits.push(c);
    return c;
  };
  changes.forEach((ch, i) => {
    const t = ch.mergedAt;
    if (ch.kind === "direct_push") {
      prev = commit(`push-${i}`, t, [prev], ch.changedLines).oid;
      return;
    }
    const number = Number(ch.id.split("#")[1]);
    const author: ScUser = { login: ch.author.login.replace(/\[bot\]$/, ""), bot: ch.author.kind === "bot" };
    const strategy = (["squash", "merge", "fast-forward"] as const)[i % 3]!;
    const base: Omit<ScPr, "strategy" | "mergeCommit" | "squashCommit" | "head" | "landed" | "listed"> = {
      number,
      base: "main",
      createdAt: at(t, -3600),
      updatedAt: at(t, 5),
      mergedAt: t,
      author,
      mergedBy: maint,
      events: ch.reviews.map((r) => ({ user: reviewer, kind: "comment" as const, at: r.submittedAt })),
      additions: ch.changedLines,
      deletions: 0,
      labels: ch.labels,
      title: `MR ${number}`,
    };
    if (strategy === "squash") {
      const s = commit(`squash-${number}`, at(t, -1), [prev], ch.changedLines);
      prs.push({ ...base, strategy, mergeCommit: null, squashCommit: s.oid, head: sha(`src-${number}`), landed: [s.oid], listed: [sha(`src-${number}`)] });
      prev = s.oid;
    } else if (strategy === "merge") {
      const f = commit(`branch-${number}`, at(t, -1800), [prev], ch.changedLines);
      const m = commit(`merge-${number}`, at(t, -1), [prev, f.oid], ch.changedLines);
      prs.push({ ...base, strategy, mergeCommit: m.oid, squashCommit: null, head: f.oid, landed: [f.oid, m.oid], listed: [f.oid] });
      prev = m.oid;
    } else {
      const a = commit(`ff-a-${number}`, at(t, -2), [prev], 1);
      const b = commit(`ff-b-${number}`, at(t, -1), [a.oid], ch.changedLines - 1);
      prs.push({ ...base, strategy, mergeCommit: null, squashCommit: null, head: b.oid, landed: [a.oid, b.oid], listed: [a.oid, b.oid] });
      prev = b.oid;
    }
  });
  return buildScenario({ repo: "acme/widgets", head: prev, window: { opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" }, commits, prs });
}
