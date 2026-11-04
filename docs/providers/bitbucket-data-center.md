# Bitbucket Data Center / Server provider (`bitbucket-data-center`)

Built in; aliases `bitbucket-server`, `bitbucket-dc`.

> **Unverified against a live server.** There is no public Bitbucket Data Center instance to record from. This provider was written from Atlassian's documented REST 1.0 response shapes and is tested only against a fake server built from them (`test/helpers/fake-bitbucket-dc.ts`), with the conformance kit. Run `pr-rla freeze --dry-run` against your server and compare its counts with the UI before relying on it. Every manifest it produces says so in its limitations.

## Configuration

```yaml
provider:
  use: bitbucket-data-center
  options:
    base_url: https://bitbucket.example.com   # required: the server root (not /rest/api/1.0)
    token_env: BITBUCKET_DC_TOKEN             # default
    page_size: 100                            # `limit` per page
repo: PROJ/repo-slug                          # project key / repository slug
```

Change ids are `bitbucket-data-center:<KEY>/<slug>#<id>` and `bitbucket-data-center:<KEY>/<slug>@<sha>`.

## Authentication

- Env var: `BITBUCKET_DC_TOKEN` (or `token_env`), sent as `Authorization: Bearer`.
- Use an HTTP access token (personal, project or repository) with **Repository read** permission (project read for a project token). `freeze` and `verify` only read; pr-rla never writes to the server.
- Anonymous access works only if the server allows public access to the repository.

## How merges and direct pushes are detected

1. **Default branch.** `GET /rest/api/1.0/projects/{key}/repos/{slug}/default-branch`, falling back to `/branches/default` on servers older than 7.6.
2. **PRs.** `GET …/pull-requests?state=MERGED&at=refs/heads/<default>&withProperties=true`, every page (`start`/`limit`, `isLastPage`, `nextPageStart`). The API has no date filter, so the whole merged list for the branch is read and filtered by `closedDate`; on a busy repository that is many pages. The merge commit is `properties.mergeCommit.id`, or the `commit` of the PR's `MERGED` activity (older servers).
3. **What each PR brought in.** The merge commit, plus `GET …/pull-requests/{id}/commits` for PRs merged since the window opened (after it closed too). A list is read only while some commit in the window is still unclaimed:

   | Merge strategy | Commits on the default branch | Attributed by |
   |---|---|---|
   | Merge commit (`no-ff`, `ff`) | merge commit + the PR's commits | merge commit + listed commits |
   | Fast-forward only (`ff-only`) | the PR's commits, unchanged | listed commits |
   | Squash (`squash`, `squash-ff-only`) | one squash commit | the merge commit (= the squash commit) |
   | Rebase (`rebase-no-ff`, `rebase-ff-only`) | rebased copies with new SHAs | the merge commit, and any commit with the same author e-mail, author time and first message line as a listed commit (a rebase keeps all three) |

4. **Direct pushes.** `GET …/commits?until=<pinned head>` lists the default branch newest first in git's date order (all parents) until a whole page is older than the window. A commit dated in the window (`committerTimestamp`) that no PR claims is a `direct_push`; its `changedLines` count the `ADDED`/`REMOVED` lines of `GET …/commits/{id}/diff?contextLines=0`.

## Reviews and approvals

From `GET …/pull-requests/{id}/activities`, reconciled with the PR's `reviewers` and `participants`:

| Bitbucket Data Center | pr-rla `state` |
|---|---|
| `APPROVED` activity | `APPROVED` |
| `UNAPPROVED` activity after an approval by the same user | that approval becomes `DISMISSED` |
| `REVIEWED` activity (the reviewer set "Needs work") | `CHANGES_REQUESTED` |
| `COMMENTED` (comment added) by anyone but the author | one `COMMENTED` per user |
| final status `APPROVED` / `NEEDS_WORK` with no matching activity | `APPROVED` / `CHANGES_REQUESTED` at the merge time |

`mergedBy` is the user of the `MERGED` activity. `mergedAt` is `closedDate`. `changedLines` counts the `ADDED` and `REMOVED` lines of `GET …/pull-requests/{id}/diff?contextLines=0`, because the REST API has no numeric diff stats. The server truncates very large diffs; a PR (or direct push) whose diff came back truncated is marked `changedLinesUnknown` instead of being undercounted: a `max_changed_lines` stratum keeps it, the funnel reports how many were kept as size unknown, and a diagnostic counts them.

## Bot detection

Users with `type: "SERVICE"` (access-token users and other service accounts) are bots, normalized to `slug[bot]`. Users with `type: "NORMAL"` are human under their slug. A commit author that the server matched to an account carries the account's `type`; an unmatched author becomes `git:<email>`, human.

## Rate limits

Bitbucket Data Center's optional rate limiting answers 429; the client waits for `Retry-After` when present and otherwise backs off exponentially (6 retries). 5xx responses and truncated bodies are retried the same way. Requests per window: the merged-PR list for the branch, then 2 per PR in the window (activities, diff), the PR commit lists while some commit is unclaimed, and 1 per direct push.

## Known limitations

- **Unverified** against a live server (see the top of this page). The field names, the `REVIEWED` action for "needs work", the `properties.mergeCommit` property, commit-author account matching and the PR commits endpoint after a merge are all taken from the documentation.
- **Pusher identity** is not exposed by the commits API; `author` is the commit author and the window uses the committer time.
- **Full PR listing.** There is no merged-after filter, so every merged PR into the branch is read.
- **Truncated diffs** undercount `changedLines`.
- **Cherry-picks** of a PR's commit pushed directly would be attributed to that PR by the rebase rule (same author, author time and message).

## Draw context (`describeChange`)

`pr-rla draw-context <n>` and the MCP `draw_context` tool read, with GETs only: the pull request, its `changes` (paginated; a `COPY` is an added file with its source as `previousPath`) and its `diff` (REST 1.0's JSON diff, turned into unified hunks; its `truncated` flag is passed on), the `.gitattributes` files at the PR's target commit (`toRef.latestCommit`) and at its landed commit (`raw/<dir>/.gitattributes?at=`, as text; 404 means none), and the build statuses at the PR's source commit (`/rest/build-status/1.0/commits/<sha>`, paginated). A direct push reads `commits/<sha>`, its `changes` and `diff`; its base is its first parent. A page that is not the last but gives no next start, a repeated one, or a 101st page stops the listing, reported as incomplete. **Unverified against a live server**, like the rest of this provider: built and tested from Atlassian's documented response shapes; `toRef.latestCommit` of a merged pull request in particular.

Data Center is self-hosted, so it has no default origin: in read-only mode (the MCP server) its token needs the operator's consent, and is withheld for now.
