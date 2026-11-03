// A bring-your-own pr-rla provider, loadable from .pr-rla.yml:
//
//   provider:
//     use: ./examples/provider-template.mjs     # or a package name, e.g. pr-rla-provider-gitlab
//     options: { changes: [...] }
//
// A real adapter (GitLab, Bitbucket, Gitea, Gerrit...) replaces listChanges() with API calls:
//   1. list merge requests merged into the default branch in [opensAt, closesAt) (paginate fully);
//   2. read every review/approval with its state, author and time; map to APPROVED / CHANGES_REQUESTED /
//      COMMENTED / DISMISSED, authors to { login, kind: "human" | "bot" } (bots carry a "[bot]" suffix);
//   3. read the default branch's history in the window (all ancestors, not only first parents: a pushed
//      `git pull` merge puts the real mainline on the second parent); a commit that no merged MR into that
//      branch introduced (check both the SCM's commit->MR link and each MR's merge/squash commit SHA)
//      is a direct_push with reviews: [] and mergedBy: null;
//   4. never return the same commit for two changes (rebase merges: all rebased commits belong to one MR).
// Then run the conformance kit against recorded API responses:
//   import { assertProviderConformance } from "pr-rla/testing";
import { defineProvider } from "pr-rla/provider";

export default defineProvider({
  providerApiVersion: 1,
  name: "example",
  description: "Template provider serving ChangeRecords from options.changes",
  create(options) {
    const changes = options.changes ?? [];
    return {
      apiVersion: 1,
      name: "example",
      async listChanges(req) {
        const opens = Date.parse(req.window.opensAt);
        const closes = Date.parse(req.window.closesAt);
        return {
          changes: changes.filter((c) => c.repo === req.repo && req.kinds.includes(c.kind) && Date.parse(c.mergedAt) >= opens && Date.parse(c.mergedAt) < closes),
          defaultBranch: "main",
          limitations: ["example: in-memory data, for illustration"],
        };
      },
    };
  },
});
