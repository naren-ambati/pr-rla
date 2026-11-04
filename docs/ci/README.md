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
  | 6 | `verify` INCOMPLETE | fails when it includes `incomplete` |

  The default `fail-on` is `escalate,refusal,timestamps,incomplete`. Any other code fails.
- **Follow the local-consent model for credentials.** The defaults are pre-approved: `GITHUB_TOKEN` to `api.github.com`, `GITLAB_TOKEN` to `gitlab.com`, `BITBUCKET_TOKEN` and `BITBUCKET_USERNAME` to `api.bitbucket.org`. A self-hosted SCM (GitHub Enterprise Server, GitLab self-managed, Bitbucket Data Center) or a non-default `token_env` needs an approval written by whoever owns the CI configuration, as `pr-rla plugin approve --env <VAR> --origin <https://host> --yes`: the `approve-origins` input of the Action and the component, `PRRLA_APPROVE_ORIGINS` in Bitbucket and the plain snippet. It never comes from the audited repository's config. `--accept-lock-grants` is off, and exists only as an opt-in documented as "only for an audit repository you control". The approvals file lives in the runner's temporary directory, never the workspace.
- **Treat what pr-rla prints as data.** The Action escapes it before it reaches markdown and defangs `::` lines.
- **Stay read-only by default.** `status` and `verify` read. Only the Action's `checkpoint` and `sample` write, and only with `allow-writes: true`.

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
