# Bitbucket Cloud provider (`bitbucket-cloud`)

Built in; alias `bitbucket`. Verified live, read-only, on atlassian/bamboo-specs (2026-10-27..31, no token). Tested with the conformance kit on the recorded responses of that run and on a synthetic repository.

## Configuration

```yaml
provider: bitbucket-cloud
repo: atlassian/bamboo-specs            # workspace/repo_slug
```

```yaml
provider:
  use: bitbucket-cloud
  options:
    token_env: BITBUCKET_TOKEN          # default; sent as Bearer
    username_env: BITBUCKET_USERNAME    # default; when set, the token is an Atlassian API token sent with Basic auth
    listing_slack_hours: 24
```

Change ids are `bitbucket-cloud:<workspace>/<slug>#<id>` and `bitbucket-cloud:<workspace>/<slug>@<sha>`.

## Authentication

- **Anonymous access works for public repositories, but is limited to roughly 50–60 requests per hour per IP.** The limit answers HTTP 429 with a plain-text body and no `Retry-After`. That covers only small windows: a 12-day window on bamboo-specs needed about 52 requests and ran out after 50, on the third of its four direct-push diffstats, while the 5-day window below needed 27. Use a token for anything larger:
  - a repository, project or workspace **access token** with the **Repositories: Read** and **Pull requests: Read** scopes, in `BITBUCKET_TOKEN` (Bearer); or
  - an Atlassian **API token** with the `read:repository:bitbucket` and `read:pullrequest:bitbucket` scopes, in `BITBUCKET_TOKEN`, with your Atlassian account e-mail in `BITBUCKET_USERNAME` (Basic auth). App passwords are being retired by Atlassian.
  - The scope names follow Atlassian's documentation. They were not tested: every live run here was anonymous.
- `freeze` and `verify` only read; pr-rla never writes to Bitbucket.

## How merges and direct pushes are detected

1. **PRs.** `GET /2.0/repositories/{ws}/{slug}/pullrequests?sort=-updated_on&q=state="MERGED" AND updated_on >= <window open − 24 h>`. After a multi-page walk the first page is read again, for PRs updated mid-walk; a single page is one snapshot and needs no second read. **`state` must be inside `q`:** Bitbucket ignores the `state` parameter when `q` is present, and the listing then returns open PRs too (seen live on atlassian/aui). The participants come in the same listing through `fields`, which saves a request per PR.
2. **Merge time and merger** come from the PR's activity (`GET …/pullrequests/{id}/activity`): the `update` with `state: MERGED`, its `date` and its `author`. **Bitbucket leaves `closed_on` empty on merged PRs**, so the activity is read for every merged PR into the main branch updated since the window opened. A PR with no MERGED event falls back to `updated_on`, which is counted in a diagnostic.
3. **Commits.** `merge_commit.hash` is abbreviated to 12 characters. It is matched against the history to get the full SHA, and fetched (`/commit/{hash}`) only when it is not in the history.

   | Strategy | Commits on the main branch | Attributed by |
   |---|---|---|
   | Merge commit | merge commit + the PR's commits | merge commit + `GET …/pullrequests/{id}/commits` |
   | Squash | one squash commit (the PR's commits list shows it, seen on #745) | the merge commit |
   | Fast forward | the PR's commits; `merge_commit` is the source head | the merge commit + the listed commits |
   | Rebase, merge / Rebase, fast forward | rebased copies with new SHAs | the merge commit + the copies: commits on the first-parent chain from the merge commit (or from its second parent), at most as many as the PR lists, whose author and first message line match a listed commit |

4. **Direct pushes.** The main branch's head is pinned (`/refs/branches/{name}`). `GET /commits/{head}` then walks every ancestor, all parents, newest first. The order is git's default date order; it matched `git log` on a clone of bamboo-specs. The walk stops once a whole page is older than the window. Bitbucket's commit `date` is the **committer** date (checked against git for bamboo-specs 614ea18d: author 13:30:45, committer 13:30:55, API 11:30:55Z). Commits no PR claims are `direct_push`es; their size is the commit's `diffstat`.

   PR commit lists are read only while some commit in the window is unclaimed. The commit → PR endpoint (`/commit/{sha}/pullrequests`) is not used, because it needs the "Pull Request Commit Links" app to have indexed the repository.

   **Why the chain bound.** Matching rebased copies on author + message anywhere in the history (the first version) claimed two genuine direct pushes on bamboo-specs. The Maven release plugin writes identical "prepare for next development iteration" commits, author `bambooagent`, on master and on the 13.0 release branch that PR #738 merged. Bitbucket exposes no author date to tell them apart.

## Reviews and approvals

| Bitbucket Cloud | pr-rla `state` |
|---|---|
| activity `approval` | `APPROVED`, at its date |
| activity `changes_requested` | `CHANGES_REQUESTED`, at its date |
| activity `comment` by anyone but the author | one `COMMENTED` per user, at the first |
| participant with final `state: approved` / `changes_requested` and no such activity | that state, at `participated_on`; without `participated_on`, with `timeUnknown` (dated at the merge; P1), which is no human decision |

Bitbucket removes an approval from the activity when it is withdrawn, so a revoked approval leaves no `DISMISSED` record. `changedLines` is the sum of `lines_added` + `lines_removed` over `GET …/pullrequests/{id}/diffstat`.

## Bot detection

Accounts of `type: "app_user"` are bots: workspace, project and repository access tokens (`kind: workspace_access_token`, e.g. `atlassian-renovate-bot`) and Connect/Forge apps. So are `type: "team"` accounts. Bots are normalized to `display_name[bot]`. People (`type: "user"`) are human under their `nickname`. Nicknames are public but neither unique nor permanent (see the open questions in `BUILD-NOTES.md`). A commit with no linked account is a bot if its e-mail is `@bots.bitbucket.org`; otherwise it is `git:<email>`, human.

## Rate limits

5xx responses are retried with exponential backoff (1, 2, 4 … 32 s; 6 retries), waiting for `Retry-After` when present. A 429 that says nothing about when to come back (Bitbucket's anonymous limit) is retried only twice, because backoff cannot outlast an hourly budget and only spends more of it. The error then says to set `BITBUCKET_TOKEN` or retry in an hour. Requests per window:
- 1–3 for the PR listing;
- 1 activity read per merged PR updated since the window opened;
- 1 diffstat read per PR merged in the window, plus a commit-list read while commits are unclaimed;
- 1 history read per 100 commits;
- 1 diffstat read per direct push.

## Known limitations

- **Pusher identity** is not exposed; `author` is the commit author, and the window uses the committer date.
- **Accounts used as bots but of type `user`** count as human. On bamboo-specs, `bamboo_hg_user` (git author `bambooagent`), which pushes the Maven release plugin's commits, is one.
- **Release-branch merges pushed directly.** A merge of a release branch into the main branch that is pushed rather than merged through a PR brings that branch's commits in as direct pushes, one per commit. The PRs that were merged into the release branch do not count, because their target was not the main branch. On bamboo-specs, `Tardigrade`'s "[bamboo] Automated branch merge" of 2026-10-06 is such a push. It shows in the history but falls outside the live window. When the same merge goes through a PR, as #738 did, every commit belongs to that PR. Each such commit carries `landedVia` (the pushed merge's SHA), and `selector.direct_push_via_merge: exclude` leaves them out of the stratum, keeping the merge itself. The recording `test/fixtures/bitbucket-cloud/bamboo-specs-2026-10-06.json` holds that day: 5 direct pushes, 4 of them via `a9f178ae03`.
- **PRs into other branches** are counted by update time (their merge time would cost an activity read each).
- **Anonymous budget.** At roughly 50–60 requests per hour, anonymous runs suit only small windows.

## Verified

- Live, read-only, no token: atlassian/bamboo-specs, 2026-10-27..31 → 8 changes: 4 PRs and 4 direct pushes, from 14 commits, in 14 s with 27 requests (`BUILD-NOTES.md`, Phase 2). It matches a git clone of `master` exactly:
  - 14 commits on `master` in the window: 4 PR merge commits, 6 commits brought in by PR #738 (a merge of the 13.0 release branch), and 4 direct pushes (Maven release-plugin commits by `bamboo_hg_user`, git author `bambooagent`, 24 lines each).
- Recorded fixture of that run: `test/fixtures/bitbucket-cloud/bamboo-specs-2026-10-27.json`.
- Synthetic repository: every merge strategy, including a rebase whose PR lists only its original commits; app-user bots; activity pagination past 100 comments; a PR merged 2 s after the window opened.

## Draw context (`describeChange`)

`pr-rla draw-context <n>` and the MCP `draw_context` tool read, with GETs only: the pull request, its `diffstat` (paginated) and its `diff` (one unified diff, split per file, its paths plain or git-quoted such as `"caf\303\251.txt"`; both answer with a 302 that the fetch broker follows), the `.gitattributes` files at the PR's destination commit and at its landed commit (`src/<sha>/<dir>/.gitattributes`, as text; 404 means none: the root, and the directories above the files the root marks generated), and the commit statuses at the PR's source commit, paginated (`STOPPED` counts as a failure). A direct push reads `commit/<sha>`, `diffstat/<sha>` and `diff/<sha>`; its base is its first parent. A listing that repeats a page, or runs past 100 pages, stops and is reported as incomplete (`truncated`, `checksTruncated`). Recorded anonymously from atlassian/bamboo-specs #745 on 2026-11-04, and again at 04:52 UTC with the base commit's `.gitattributes` (`test/fixtures/bitbucket-cloud/describe-bamboo-specs-745-2026-11-04.json`).

In read-only mode (the MCP server) the provider gets `BITBUCKET_TOKEN` and `BITBUCKET_USERNAME` only as placeholders, which the fetch broker swaps (building the Basic header itself) on `api.bitbucket.org` alone; an `api_url`, `token_env` or `username_env` in `.pr-rla.yml` needs the operator's approval (`pr-rla plugin approve bitbucket-cloud`, the same approvals file the CLI asks); unapproved, the credential is withheld.
