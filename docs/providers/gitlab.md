# GitLab provider (`gitlab`)

Built in. Works with gitlab.com and self-managed GitLab (tested on recorded gitlab.com and gitlab.freedesktop.org responses, and live on gitlab.com).

## Configuration

```yaml
provider: gitlab                       # gitlab.com
repo: gitlab-org/cli                   # the project path, groups and subgroups included
```

```yaml
provider:
  use: gitlab
  options:
    base_url: https://gitlab.example.com   # self-managed: the instance root (not /api/v4)
    token_env: GITLAB_TOKEN                # default
    page_size: 100                         # REST page size (max 100)
    batch_size: 20                         # MRs per GraphQL query
    listing_slack_hours: 24                # see "How merges are found"
repo: platform/backend/api
```

Change ids are `gitlab:<path>#<iid>` for an MR and `gitlab:<path>@<sha>` for a direct push.

## Authentication

- Env var: `GITLAB_TOKEN` (or the one named by `token_env`), sent as `Authorization: Bearer`.
- Minimum scope: **`read_api`** (a personal, group or project access token). For a private project the token's user needs at least the Reporter role to read MRs and approvals (not tested against a private project). `freeze` and `verify` only read; pr-rla never writes to GitLab.
- Public projects need no token. Without one, gitlab.com allows about 500 API requests per minute per IP, which was enough for a 205-MR month (below).
- REST notes need a token even on public projects (HTTP 401 without one), so pr-rla reads review notes through GraphQL, which public projects serve anonymously.

## How merges and direct pushes are detected

1. **MRs.** `GET /projects/:id/merge_requests?state=merged&order_by=updated_at&sort=desc&updated_after=…`, then the head of the list again, because an MR updated during the walk moves to page 1 and could be skipped. An MR counts when `target_branch` is the default branch and `merged_at` is in the window. MRs merged into other branches are excluded and counted as a diagnostic.
   - Listing starts `listing_slack_hours` (24) before the window opens. GitLab can stamp `merged_at` after `updated_at`: gitlab-org/cli !4285 has `updated_at` 14:24:14.764 and `merged_at` 14:24:19.170. An MR merged just after the window opened could otherwise be missed.
2. **What each MR brought in.** `mergeSha` is `merge_commit_sha`, else `squash_commit_sha`, else `sha` (the head):

   | Merge method | `merge_commit_sha` | `squash_commit_sha` | Commits on the default branch | Attributed to the MR by |
   |---|---|---|---|---|
   | Merge commit | set | null | the merge commit + the MR's commits | the merge SHA + `GET …/merge_requests/:iid/commits` |
   | Merge commit + squash | set | set | the merge commit + the squash commit | both SHAs |
   | Squash (fast-forward) | null | set | the squash commit | the squash SHA |
   | Fast-forward / semi-linear rebase | null (fast-forward) | null | the MR's (rebased) commits, unchanged | `GET …/merge_requests/:iid/commits` (GitLab rebases the source branch itself, so these are the SHAs that land) |

   MRs merged *after* the window are read too: their commits can be dated inside it (rebased the day before), and they are not direct pushes. Commit lists are read lazily: merge and squash SHAs from the listing claim most commits for free, and an MR's list is read only while some commit in the window is unclaimed.
3. **Direct pushes.** The default branch's head is pinned, then `GET /repository/commits?ref_name=<head sha>&since&until&with_stats=true` lists every ancestor (all parents, not `first_parent`) dated in the window. A commit that no MR above claims is checked with `GET /repository/commits/:sha/merge_requests`; if no merged MR into the default branch contains it, it is a `direct_push` with `reviews: []` and `mergedBy: null`. `changedLines` are GitLab's commit stats (against the first parent for a merge commit).

## Reviews and approvals

Review events come from the MR's system notes (GraphQL `notes`), then are reconciled with `GET …/approvals` (`approved_by`, with `approved_at`) and `GET …/reviewers` (reviewer state):

| GitLab | pr-rla `state` |
|---|---|
| system note "approved this merge request" | `APPROVED` |
| system note "requested changes" (reviewer state `requested_changes`, GitLab 17+) | `CHANGES_REQUESTED` |
| "unapproved this merge request", or "reset approvals from @user by pushing to the branch" | that user's last approval becomes `DISMISSED` (it no longer stood at merge) |
| a non-system note by anyone but the MR author | one `COMMENTED` per user, at their first note |
| an `approved_by` entry with no note | `APPROVED` at `approved_at` |
| reviewer state `requested_changes` / `reviewed` with no note | `CHANGES_REQUESTED` / `COMMENTED`, dated at the review request (`created_at`), because GitLab exposes no review time |

`mergedBy` is `merge_user` (falling back to the deprecated `merged_by`). For "merge when pipeline succeeds" and merge trains that is the user who set it, not GitLab's own merge job.

`changedLines` is the MR's diff stats (GraphQL `diffStatsSummary`: additions + deletions), the same quantity as GitHub's PR additions + deletions. It is *not* `changes_count`, which counts files (and is `null` on large MRs). If GraphQL has no stats, pr-rla counts `+`/`-` lines of `GET …/merge_requests/:iid/diffs`, which GitLab truncates for very large files.

## Bot detection

A user is a bot, and its login gets the `[bot]` suffix (`GitLabDuo[bot]`), when any of these holds:
- GitLab's `bot` flag (GraphQL, on every user; REST shows it only on an MR's `author`). This covers GitLab Duo, project and group access-token users and service accounts.
- The username is an access-token or service-account user: `project_<id>_bot_<hash>`, `group_<id>_bot_<hash>`, `service_account_…`.
- For a direct push (GitLab links no account to a commit): the author e-mail is an access-token address (`project_<id>_bot_…@noreply.<host>`), or the author name ends in `[bot]`. Other commit authors become `git:<email>`, human.

Deleted users are GitLab's `ghost`, counted as human (as on GitHub).

## Rate limits

Every request retries network errors, HTTP 5xx, 429 and truncated bodies with exponential backoff (6 retries). It waits as long as `Retry-After` and `RateLimit-Reset` (epoch seconds) say. A success with `RateLimit-Remaining: 0` delays the next request until the reset. Requests per window: 2 per MR (approvals, reviewers) and 1 GraphQL query per 20 MRs. Unsquashed MRs' commit lists are read only while some commit in the window is still unclaimed, and each direct push costs 1 commit → MR lookup.

## Verified

- Live, read-only, no token: gitlab-org/cli, October 2026 → 205 MRs, 414 default-branch commits, all linked to MRs, 0 direct pushes, 3 min 25 s (`BUILD-NOTES.md`, Phase 2).
- Recorded fixtures (conformance kit): gitlab-org/cli 2026-11-02 (merge commit + squash, GitLab Duo reviews, requested changes, a revoked approval) and gitlab.freedesktop.org xorg/xserver 2026-10-05..07 (self-managed, fast-forward: `merge_commit_sha` null, 3 and 12 rebased commits).
- Synthetic instance: every merge method, an MR merged after the window, `merged_at` after `updated_at` across the window edge, a project-bot direct push, note pagination past 100.

## Known limitations

- **Pusher identity.** The commits API does not say who pushed. `author` is the git author, the window uses `committed_date`, and every manifest says so. (GitLab's Events API, `action=pushed`, does record pushers. pr-rla does not use it yet; see the open questions in `BUILD-NOTES.md`.)
- **Service accounts on regular users.** Accounts GitLab reports as `bot: false` are human. On gitlab.com, `gitlab-bot` (triage automation) approves MRs, and `gitlab-dependency-update-bot` authored 33 of gitlab-org/cli's 205 October MRs. On gitlab.freedesktop.org, `marge-bot` merges almost every xorg/xserver MR. If `gitlab-bot` were a bot, 4 of the 205 October MRs would have had no human approval or change request instead of 0. Registering it does exactly that: with `selector.bots: ["gitlab-bot"]` (or `["id:1786152"]`), !4191, !4247, !4251 and !4253 move into the no-human-review stratum (recorded in `test/fixtures/gitlab/gitlab-org-cli-2026-10.json`; `node scripts/demo-sdk-carry-overs.mjs`).
- **Review times without notes.** A reviewer state with no matching system note is dated at the review request.
- **`since`/`until` are git's.** GitLab filters history like `git log --since`, by committer date. A rebased commit carries its rebase time.

## Draw context (`describeChange`)

`pr-rla draw-context <n>` and the MCP `draw_context` tool read, with GETs only: the merge request and `merge_requests/:iid/diffs` (paginated; a diff GitLab marks `too_large` has no patch, and its line counts are 0); `repository/files/.gitattributes/raw?ref=<landed commit>` (as text; 404 means none); and `pipelines?sha=<head commit>`, one check per pipeline. A direct push reads `repository/commits/:sha` and its `/diff`. Recorded anonymously from gitlab-org/cli !4191 on 2026-11-04 (`test/fixtures/gitlab/describe-gitlab-org-cli-4191-2026-11-04.json`); self-managed instances are unverified.
