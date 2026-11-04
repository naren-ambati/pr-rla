# CI integrations

pr-rla runs in CI to keep a certificate honest between humans: on every verdict event or schedule it reads the ledger, prints where the audit stands, and fails the job when it ESCALATEs, refuses, has too few trusted timestamps, or cannot show completeness. It never makes a verdict, and by default it never writes.

| SCM | Integration | Ledger that completes the audit | Guide |
|---|---|---|---|
| GitHub | Composite action, `integrations/github-action/` | `github-issues` | [github.md](github.md) |
| GitLab | CI/CD component, `integrations/gitlab/templates/pr-rla.yml`, and a plain snippet | `gitlab-issues` | [gitlab.md](gitlab.md) |
| Bitbucket Cloud | A Pipelines script step, no Docker pipe | `git-file`, or the Jira example where the team uses Jira | [bitbucket.md](bitbucket.md) |

## What all three do

- **Pin pr-rla** by exact version (FR6.4, NFR18): the Action by version and integrity in its own lockfile, GitLab and Bitbucket by an exact `version` the script checks (and an optional integrity).
- **Run `--plugins builtin-only`** unless the owner opts in with `plugins: allow`.
- **Map the exit code** the same way:

  | Code | Meaning | The job |
  |---|---|---|
  | 0 | success | passes |
  | 1 | a check failed, a precondition was not met, usage | always fails |
  | 2 | ESCALATE, or the seed round is not yet published | fails when `fail-on` includes `escalate` |
  | 3 | population below the registered minimum | fails when it includes `refusal` |
  | 4 | stopped before finishing; run the printed command again | always fails, with the command in the summary |
  | 5 | a record written with too few timestamps | fails when it includes `timestamps` |
  | 6 | INCOMPLETE: `verify` could not establish something, or `status` withholds a certificate the sequential test reached (a time not proven by enough timestamp authorities) | fails when it includes `incomplete` |

  The default `fail-on` is `escalate,refusal,timestamps,incomplete`. Any other code fails.
- **Follow the local-consent model for credentials.** The defaults are pre-approved: `GITHUB_TOKEN` to `api.github.com`, `GITLAB_TOKEN` to `gitlab.com`, `BITBUCKET_TOKEN` and `BITBUCKET_USERNAME` to `api.bitbucket.org`. A self-hosted SCM (GitHub Enterprise Server, GitLab self-managed, Bitbucket Data Center) or a non-default `token_env` needs an approval written by whoever owns the CI configuration, as `pr-rla plugin approve --env <VAR> --origin <https://host> --yes`: the `approve-origins` input of the Action and the component, `PRRLA_APPROVE_ORIGINS` in Bitbucket and the plain snippet. It never comes from the audited repository's config. `--accept-lock-grants` is off, and exists only as an opt-in documented as "only for an audit repository you control". The approvals file lives in the runner's temporary directory, never the workspace.
- **Prove the times with the owner's anchors.** A certificate needs its registration and commitment times proven by enough timestamp authorities, and `status` and `verify` prove only what they trust: the bundle pr-rla ships, plus anchor files named by whoever owns the CI configuration (the `tsa-trust` input of the Action and the component, `PRRLA_TSA_TRUST` in Bitbucket and the plain snippet, passed as `--tsa-trust`). Needed only for an authority outside the shipped bundle. Without them such an audit's status is `WITHHELD` and exits 6, or 1 with an issue ledger: `sample`'s draw → issue publication is time-stamped by the same authorities, and check 7 FAILs a publication it cannot prove (P1). They are the CI owner's trust, never the audited repository's, and prove nothing to a third party, who verifies with their own.
- **Treat what pr-rla prints as data.** The Action escapes it before it reaches markdown and defangs `::` lines.
- **Stay read-only by default.** `status` and `verify` read. Only the Action's `checkpoint` and `sample` write, and only with `allow-writes: true`.

## Scopes

What each integration needs, by SCM. Every row is **unverified against the live service**: the build exercises the integrations on mock servers only (D8).

| SCM | `status` and `verify` (read) | `checkpoint` (write) | Comment on the audit issue | Verified |
|---|---|---|---|---|
| GitHub | `contents: read`; a token that can read the audit repository's issues (`issues: read`) | `contents: write`, and `allow-writes: true` | `issues: write` | unverified: mock server only |
| GitLab | A masked `GITLAB_TOKEN` with `read_api` | Not offered in the component | Not offered | unverified: mock server only |
| Bitbucket Cloud | An access token with Repositories: Read and Pull requests: Read, or an API token with `read:repository:bitbucket` and `read:pullrequest:bitbucket` | Not offered in the step | Not offered | unverified: mock server only |

Nothing here writes to a public service. The only writes are the Action's opt-in `checkpoint` and `sample`, and the Action's opt-in comment, each to the audit repository.

## Rate limits

pr-rla paces every request to a host with one shared budget whose defaults are the smallest limit the service publishes for the request's auth state; the limit a server reports in its rate-limit headers replaces a primary rule's default for the rest of the run (secondary rules, such as GitHub's per-minute points, always apply), and `rate_limits:` in `.pr-rla.yml` can raise or lower any rule. The defaults and their sources are in BUILD-NOTES, "Bolt 2 (U2a)" (GitLab's issue- and note-creation limits were added in "Bolt 3 (U4)") and `src/net/rate-limits.ts`. What a CI job meets:

| SCM | Authenticated | Anonymous | Checked |
|---|---|---|---|
| GitHub | `GITHUB_TOKEN`: 1,000 REST requests an hour per repository, and 1,000 GraphQL points an hour; a personal token reports 5,000 and is paced to that. Secondary limits: 900 REST points a minute, 80 content-creating requests a minute and 500 an hour, 100 at once | 60 requests an hour | anonymous: live, from the response headers (2026-11-03); the `GITHUB_TOKEN` budgets from GitHub's documentation only (only Actions issues that token) |
| GitLab.com | 2,000 requests a minute per user; issue creation 200 a minute and notes 60 a minute | 500 requests a minute per IP | anonymous: live, from the `RateLimit-*` headers (2026-11-03); the rest from GitLab's documentation |
| Bitbucket Cloud | 1,000 requests an hour on `/2.0/repositories/*` | 60 an hour (seen at about 50 to 60, as HTTP 429 with no `Retry-After`) | from Atlassian's documentation; anonymous answers carry no rate-limit header (live, 2026-11-03), so the defaults bind for the whole run |
| Bitbucket Data Center | the instance's token bucket, by default 60 at once refilled 5 a second | n/a | from Atlassian's documentation; unverified against a live server |

So run `status` and `verify --offline` on events, and an online `verify` on a schedule with a token whose budget fits the population (the gh-aw Q3 audit needs thousands of requests).

## Checkpoints in CI need an issue ledger

`checkpoint --push` time-stamps a hash of the ledger's verdict-event history and pushes it, so a deleted issue or label shows up in `verify`. It needs a ledger that can return that history: `github-issues`, `gitlab-issues` or the Jira example. The `git-file` ledger cannot be checkpointed (`checkpoint` says `ledger git-file has no readHistory, so it cannot be checkpointed …` and exits 1): git history is its trail already, and `verify` walks it. Only the Action offers `command: checkpoint` (with `allow-writes: true`); in GitLab and Bitbucket, run `pr-rla checkpoint --push` from a clone with push rights.

## Platforms

The Action's scripts need `bash` and Node 24; the GitLab and Bitbucket jobs run in Linux containers (`node:24-alpine`, `node:24`). The tests ran on macOS here. Linux runners are what the integrations target, and a run on one is unverified. Windows runners are untested.

## End-to-end matrix

Intent metric 3 asks for one ledger that completes the audit on each SCM. Every cell runs on fixtures and mock servers in this phase. **H** marks the steps a human does by design: deep review, and recording the verdict.

| | GitHub | GitLab | Bitbucket Cloud |
|---|---|---|---|
| **Ledger** | `github-issues` | `gitlab-issues` | `git-file`, or the Jira example where the team uses Jira |
| **CLI** | register, freeze, sample, issues opened, verdict by label (H), `status`, `checkpoint`, `verify` 7/7: `test/e2e-github-issues.test.ts` | the same on the GitLab fixture: `test/e2e-gitlab.test.ts` and `test/gitlab-issues-ledger.test.ts` | `record` (H), `status`, `verify` on `git-file`: `test/e2e.test.ts`, `test/bitbucket-cloud-provider.test.ts` |
| **CI** | The Action: a label-event fixture gives the status summary, an ESCALATE fixture fails the job, `checkpoint --push` reaches a local bare repo: `test/ci-github-action.test.ts` | The component job: a push to `audit/**` and a schedule run select the job and it leaves the status artifact; ESCALATE fails it: `test/ci-job-scripts.test.ts` | The step: a push to `main` that changes `audit/` runs it, the custom pipeline runs `verify`; ESCALATE fails it: `test/ci-job-scripts.test.ts` |
| **Assistant (MCP)** | Claude Code: `review-draw` on a recorded draw | Codex: the same flow | Cursor: the same flow (bolt U6) |

How the CI row is exercised: the real `pr-rla` CLI runs against a fixture audit directory. The ledger's host is a mock HTTP server on `127.0.0.1` that answers as `api.github.com` or `gitlab.com` from an in-memory fake tracker, and the child process reaches it through a preload that swaps only the last hop of `fetch`, so the grants, read-only guard and pacing run unchanged. `test/helpers/ci-harness.ts` runs the Action's steps from `action.yml` with bash (a `${{ }}` evaluator for the subset the Action uses, `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY` on temporary files) and the GitLab and Bitbucket script lines in one shell. No `act`, no real repository, no GitLab lint API.

## What is verified, and what is not

Verified in `npm test`: each template against its published schema (vendored with its URL and date in `test/fixtures/schemas/SOURCES.json`); the exact-version and integrity pins; every exit code against the mapping in all three; the summary text, outputs and comment; the credential approvals; `checkpoint --push` to a local bare repo; hostile input and output; no socket leaves the machine.

Not verified: a run on a real GitHub runner, GitLab instance or Bitbucket pipeline; GitLab's interpolation of `spec:inputs` on a live instance; Bitbucket's handling of the YAML anchor; Bitbucket Data Center; the webhook route for GitLab label events; the `dash` the harness uses as POSIX `sh` is not Alpine's `ash`.
