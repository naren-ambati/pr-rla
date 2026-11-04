# GitHub provider (`github`)

Built in, and the default. Works with github.com and GitHub Enterprise Server (GHES). Verified live on github/gh-aw (Q3 2026, 3,944 changes); GHES is tested against a fake server only.

## Configuration

```yaml
provider: github
repo: github/gh-aw
```

```yaml
provider:
  use: github
  options:
    base_url: https://ghe.example.com   # GHES: REST at /api/v3, GraphQL at /api/graphql
    token_env: GITHUB_TOKEN             # default: GITHUB_TOKEN, then GH_TOKEN (and GH_ENTERPRISE_TOKEN with base_url)
    page_size: 100                      # REST pulls per page
    batch_size: 40                      # PRs per GraphQL query (100 drew HTTP 502 on gh-aw)
    history_page_size: 50               # commits per history page; halves while GitHub 5xx's
repo: platform/api
```

`api_url` and `graphql_url` can still be set separately. When the REST root ends in `/api/v3`, GraphQL defaults to the same host's `/api/graphql`. Before phase 2 it defaulted to `<api_url>/graphql`, which is wrong for GHES.

Change ids are `github:<owner>/<repo>#<number>` and `github:<owner>/<repo>@<sha>`.

## Authentication

- Env var: `GITHUB_TOKEN` (or `GH_TOKEN`; for GHES also `GH_ENTERPRISE_TOKEN`), or the one named by `token_env`. `GITHUB_TOKEN=$(gh auth token)` works.
- GraphQL needs a token even for public repositories.
- Minimum permissions:
  - fine-grained token: repository **Contents: read**, **Pull requests: read** and **Metadata: read**;
  - classic token: `public_repo` for public repositories, `repo` for private ones (classic scopes have no read-only variant).
- `freeze` and `verify` only read; pr-rla never writes to GitHub.

## How merges and direct pushes are detected

1. **PRs.** REST `GET /repos/{o}/{r}/pulls?state=closed&sort=updated&direction=desc`, filtered by `merged_at` in the window and `base.ref` = the default branch. The head of the list is read again after the walk, because a PR updated mid-walk jumps to page 1. PRs merged into other branches are excluded and counted.
2. **Reviews, authors, mergers, sizes.** GraphQL, 40 PRs per query by aliases; more than 100 reviews, and more than 50 labels, are paged.
3. **Direct pushes.** GraphQL `history(since:)` from a pinned head oid lists every ancestor (not only first parents) dated in the window. A commit is a PR's when `associatedPullRequests` has a merged PR into the default branch, or when it is a merged PR's `merge_commit_sha`: GitHub's association was missing for the merge commit of gh-aw #73884. Otherwise it is a `direct_push`.

| Merge method | Commits on the default branch | Attributed by |
|---|---|---|
| Merge commit | merge commit + the PR's commits | association (all of them) |
| Squash | one squash commit | association, or `merge_commit_sha` |
| Rebase | rebased copies | association (GitHub links each rebased commit) |
| Fast-forward (pushed locally, or a merge queue) | the PR's commits | association |

A `git pull` merge pushed to the default branch ("foxtrot", 8 on gh-aw in Q3) puts the real mainline on the second parent. That is why history is walked over all parents.

## Reviews and approvals

GraphQL review states map one to one: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`. `PENDING` (unsubmitted) reviews are dropped. Reviews are kept as of `frozenAt`; `verify` lists later ones.

## Bot detection

GraphQL `__typename: "Bot"` or a `[bot]` suffix makes a bot, normalized to `login[bot]` (`copilot-swe-agent[bot]`). A deleted account is `ghost`, human. A commit author with no linked account is `git:<email>`, human, unless its name ends in `[bot]`.

## Rate limits

Retries 5xx, 429, secondary rate limits (403 with `Retry-After` or `x-ratelimit-remaining: 0`, waiting until `x-ratelimit-reset`), truncated 200 bodies and transient GraphQL errors ("Something went wrong … timeout"). The history page size halves after repeated 5xx, from the same cursor.

## Verified

- Live, read-only: github/gh-aw Q3 2026 → 3,944 changes (3,883 PRs, 61 direct pushes), matching GitHub search once 2 PRs merged into other branches are removed (`BUILD-NOTES.md`).
- Recorded gh-aw responses and a synthetic graph (squash, merge commit, rebase, direct pushes, foxtrot, a missing association) pass the conformance kit, including the injected-fault check with GitHub's 403 rate-limit response.
- GHES: endpoint derivation unit-tested, and the synthetic graph served under `/api/v3` + `/api/graphql` passes the kit. **Not run against a real GHES instance.**

## Known limitations

- **Pusher identity.** GitHub's commit APIs do not expose who pushed; `author` is the commit author and the window uses `committedDate`.
- **Accounts that are bots but report as users.** The `Copilot` commit-author account is a `User` to GitHub, so a commit it authors directly is classified human.
- **Review states at freeze time.** Labels can change afterwards, so a label-based stratum may not re-verify.

## Caps

The history query reads two parents and five associated PRs per commit and asks for their totals. A commit with more is completed by a query of its own: associated PRs are paged to the end (a commit in more than five PRs is not mislabelled a direct push because its merged PR was the sixth), parents up to 100; a commit with more than 100 parents is refused, never classified from a truncated list.
