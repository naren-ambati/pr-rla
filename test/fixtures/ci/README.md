# CI fixtures (U7)

Everything the CI tests run on is local. No scratch repository, no real tracker, no hosted runner.

| What | Kind | Where it comes from |
|---|---|---|
| `issues-labeled.json` | synthetic | The shape of GitHub's `issues` webhook payload for `action: labeled`. Only `issue.number` is read. Written 2026-11-04. |
| GitHub audit (`github-issues` ledger) | synthetic | `test/helpers/ci-fixtures.ts` builds it at test time: a 400-change json-file population, the recorded drand round 33,245,812, and an in-memory fake GitHub (`test/helpers/fake-issue-trackers.ts`). Verdict labels are applied by the fake. |
| GitLab audit (`gitlab-issues` ledger) | synthetic | The same, against the fake GitLab at `https://gitlab.com`. |
| git-file audit (the Bitbucket row) | recorded + synthetic | `test/fixtures/audits/gh-aw-q3-recorded` (recorded population and beacon, synthetic times and key) plus synthetic verdict lines. |
| Small-population audit | synthetic | 12 changes, registered and frozen, so `sample` refuses with exit 3. |
| `../schemas/*.json` | recorded | See `../schemas/SOURCES.json`: URL, date and sha256 of each published schema. |

The child processes (the real `pr-rla` CLI and the action's own scripts) reach the mock servers through `test/helpers/ci-preload.cjs`, which swaps only the last hop of `fetch` and refuses every other socket.
