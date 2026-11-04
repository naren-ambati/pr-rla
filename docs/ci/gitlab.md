# pr-rla on GitLab CI/CD

A CI/CD component (`integrations/gitlab/templates/pr-rla.yml`) with typed `spec:inputs`, and the same job as a plain snippet for instances that cannot reach the component. It runs `pr-rla status` (or `verify`) when a push changes the audit directory, on a schedule, on a pipeline trigger and on a manual run, then fails the job by the exit-code table below.

**Not published.** The component is not in the CI/CD Catalog and nothing in this repository publishes it (FR6.6). Publishing to gitlab.com's Catalog is a public write that waits for the founder. Until then, mirror the repository where your instance can reach it, or use the plain snippet.

The ledger on GitLab is `gitlab-issues`: the reviewer's label on the draw's issue is the verdict. See [the end-to-end matrix](README.md#end-to-end-matrix).

## The component

```yaml
include:
  - component: $CI_SERVER_FQDN/<group>/<project>/pr-rla@<exact ref>
    inputs:
      version: "0.1.0"
```

Components work only from the same GitLab instance, so a self-managed instance mirrors the project that holds the template. `<group>/<project>` and `<exact ref>` are yours to fill in; they are not known until the repository has an address.

| Input | Default | Meaning |
|---|---|---|
| `version` | `0.1.0` | The exact pr-rla version to install. The input's regex rejects a range or a tag |
| `integrity` | empty | Optional `sha512-…`; the job stops unless npm reports that integrity for `version` |
| `command` | `status` | `status` or `verify` |
| `dir` | `.` | The audit repository directory (where `.pr-rla.yml` is) |
| `audit-path` | `audit/**/*` | A push that changes a file matching this starts the job |
| `offline` | `"true"` | Pass `--offline`: no provider calls, no population rebuild |
| `fail-on` | `escalate,refusal,timestamps,incomplete` | Which of exits 2, 3, 5 and 6 fail the job |
| `plugins` | `builtin-only` | `allow` lets the audit's locked plugins load |
| `approve-origins` | empty | `ENV_VAR=https://host` entries; see Credentials |
| `accept-lock-grants` | `"false"` | Only for an audit repository you control |
| `image` | `node:24-alpine@sha256:…` | A Node 24 image pinned by digest (the tag's index digest on 2026-11-04) |
| `stage` | `test` | |

Booleans are strings with `options`, so they can sit in `variables:` without GitLab turning them into booleans.

## When it runs

- **A push** that changes files matching `audit-path` (the ledger's `git-file` verdicts, the registration, the draws).
- **A schedule.** Create one in CI/CD, Schedules, hourly. It notices the window closing and the seed round publishing, and it picks up label changes (below).
- **A pipeline trigger**, and a manual run from the web UI.

**Label changes.** GitLab has no native trigger for an issue label. The default is the hourly schedule. The option is a project webhook (issue events) that calls the pipeline-trigger endpoint, which sets `$CI_PIPELINE_SOURCE` to `trigger`; the job already runs on that. That webhook route is described from GitLab's documentation and is unverified here.

## The plain snippet

For an instance that cannot reach the component, or if you would rather read the whole job in your own `.gitlab-ci.yml`. It is the component's job with its inputs written out, and `test/ci-job-scripts.test.ts` keeps its script identical to the component's.

```yaml .gitlab-ci.yml
stages: [test]

pr-rla-status:
  stage: test
  image: node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
  variables:
    PRRLA_VERSION: "0.1.0"        # one exact version, never a range or a tag
    PRRLA_INTEGRITY: ""           # optional: the sha512-... integrity npm reports for that version
    PRRLA_COMMAND: "status"       # status or verify
    PRRLA_DIR: "."
    PRRLA_OFFLINE: "true"
    PRRLA_FAIL_ON: "escalate,refusal,timestamps,incomplete"
    PRRLA_PLUGINS: "builtin-only" # allow lets the audit's locked plugins load
    PRRLA_APPROVE_ORIGINS: ""     # e.g. "GITLAB_TOKEN=https://gitlab.example.com" for GitLab self-managed
    PRRLA_ACCEPT_LOCK_GRANTS: "false"
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule" || $CI_PIPELINE_SOURCE == "trigger" || $CI_PIPELINE_SOURCE == "web"
    - if: $CI_PIPELINE_SOURCE == "push"
      changes:
        - "audit/**/*"
  script:
    - |
      set -e
      # 1. The exit-code mapping (identical in integrations/github-action/scripts/exit-map.sh).
      # >>> pr-rla exit map
      prrla_check_fail_on() {
        prrla_list=$(printf '%s' "$1" | tr -d ' \t\r\n')
        prrla_oldifs=$IFS
        IFS=,
        for prrla_name in $prrla_list; do
          case "$prrla_name" in
            escalate | refusal | timestamps | incomplete | "") ;;
            *)
              IFS=$prrla_oldifs
              echo "fail-on: unknown name '$prrla_name' (use escalate, refusal, timestamps, incomplete)" >&2
              return 1
              ;;
          esac
        done
        IFS=$prrla_oldifs
        return 0
      }

      prrla_decide() {
        prrla_rc=$1
        prrla_on=",$(printf '%s' "$2" | tr -d ' \t\r\n'),"
        PRRLA_RESULT=fail
        case "$prrla_rc" in
          0)
            PRRLA_RESULT=pass
            PRRLA_REASON="exit 0"
            return 0
            ;;
          1)
            PRRLA_REASON="exit 1: a check failed, a precondition was not met, or pr-rla refused the command"
            return 1
            ;;
          4)
            PRRLA_REASON="exit 4: pr-rla stopped before it finished; running the printed command again finishes it"
            return 1
            ;;
          2)
            prrla_name=escalate
            prrla_what="exit 2: ESCALATE (the sequential test cannot certify), or the seed round is not yet published"
            ;;
          3)
            prrla_name=refusal
            prrla_what="exit 3: the population is below the registered minimum (review every change instead)"
            ;;
          5)
            prrla_name=timestamps
            prrla_what="exit 5: a record was written with too few trusted timestamps"
            ;;
          6)
            prrla_name=incomplete
            prrla_what="exit 6: INCOMPLETE (nothing failed, but part of the population could not be rebuilt or shown complete)"
            ;;
          *)
            PRRLA_REASON="exit $prrla_rc: not a pr-rla exit code (pr-rla did not run to its end)"
            return 1
            ;;
        esac
        case "$prrla_on" in
          *",$prrla_name,"*)
            PRRLA_REASON="$prrla_what; fail-on includes $prrla_name"
            return 1
            ;;
        esac
        PRRLA_RESULT=pass
        PRRLA_REASON="$prrla_what; fail-on does not include $prrla_name, so the job passes"
        return 0
      }
      # <<< pr-rla exit map

      # 2. Inputs, checked. The approvals file lives in the runner's temp directory, never in the project.
      case "$PRRLA_VERSION" in
        "" | *[!0-9.]*) prrla_ok=0 ;;
        [0-9]*.[0-9]*.[0-9]*) prrla_ok=1 ;;
        *) prrla_ok=0 ;;
      esac
      [ "$prrla_ok" = 1 ] || { echo "PRRLA_VERSION must be one exact version such as 0.1.0, not a range or a tag" >&2; exit 1; }
      case "$PRRLA_COMMAND" in status | verify) ;; *) echo "PRRLA_COMMAND must be status or verify" >&2; exit 1 ;; esac
      case "$PRRLA_PLUGINS" in builtin-only | allow) ;; *) echo "PRRLA_PLUGINS must be builtin-only or allow" >&2; exit 1 ;; esac
      prrla_check_fail_on "$PRRLA_FAIL_ON"
      prrla_tmp=$(cd "${TMPDIR:-/tmp}" && pwd -P) || { echo "TMPDIR is not a directory" >&2; exit 1; }
      prrla_here=$(pwd -P)
      case "$prrla_tmp" in "$prrla_here" | "$prrla_here"/*) echo "the approvals file must be outside the project directory" >&2; exit 1 ;; esac
      export PR_RLA_APPROVALS_FILE="$prrla_tmp/pr-rla-approvals.json"

      # 3. Install the pinned version. PRRLA_BIN skips the install (an image that already has it); the version is checked either way.
      if [ -z "${PRRLA_BIN:-}" ]; then
        PRRLA_HOME="${TMPDIR:-/tmp}/pr-rla-tool"
        if [ -n "${PRRLA_INTEGRITY:-}" ]; then
          prrla_seen=$(npm view "pr-rla@$PRRLA_VERSION" dist.integrity)
          [ "$prrla_seen" = "$PRRLA_INTEGRITY" ] || { echo "pr-rla@$PRRLA_VERSION has integrity $prrla_seen, not the $PRRLA_INTEGRITY you pinned" >&2; exit 1; }
        fi
        npm install --prefix "$PRRLA_HOME" --ignore-scripts --no-audit --no-fund --no-package-lock "pr-rla@$PRRLA_VERSION"
        PRRLA_BIN="$PRRLA_HOME/node_modules/.bin/pr-rla"
      fi
      [ "$("$PRRLA_BIN" --version)" = "$PRRLA_VERSION" ] || { echo "the pr-rla at $PRRLA_BIN is not version $PRRLA_VERSION" >&2; exit 1; }

      # 4. Credential approvals the owner of this CI configuration asks for: ENV_VAR=https://host entries.
      #    The same consent a person gives with "pr-rla plugin approve"; never read from the audited repository.
      set -f
      for prrla_entry in $(printf '%s' "${PRRLA_APPROVE_ORIGINS:-}" | tr ',\r\n\t' '    '); do
        prrla_env=${prrla_entry%%=*}
        prrla_origin=${prrla_entry#*=}
        [ "$prrla_entry" != "$prrla_env" ] || { echo "approve-origins entries look like ENV_VAR=https://host" >&2; exit 1; }
        case "$prrla_env" in "" | [0-9]* | *[!A-Za-z0-9_]*) echo "approve-origins: '$prrla_env' is not an environment variable name" >&2; exit 1 ;; esac
        case "$prrla_origin" in https://*) ;; *) echo "approve-origins: the origin for $prrla_env must start with https://" >&2; exit 1 ;; esac
        case "${prrla_origin#https://}" in "" | *[!A-Za-z0-9.:-]*) echo "approve-origins: the origin for $prrla_env must be https://host or https://host:port" >&2; exit 1 ;; esac
        "$PRRLA_BIN" -C "$PRRLA_DIR" plugin approve --env "$prrla_env" --origin "$prrla_origin" --yes
      done
      set +f

      # 5. Run. --plugins builtin-only unless the owner opted out. Global options come before the subcommand.
      set -- -C "$PRRLA_DIR"
      if [ "$PRRLA_PLUGINS" = builtin-only ]; then set -- --plugins builtin-only "$@"; fi
      if [ "${PRRLA_ACCEPT_LOCK_GRANTS:-false}" = true ]; then set -- --accept-lock-grants "$@"; fi
      set -- "$@" "$PRRLA_COMMAND" --json
      if [ "$PRRLA_OFFLINE" = true ]; then set -- "$@" --offline; fi
      set +e
      "$PRRLA_BIN" "$@" > pr-rla.json
      PRRLA_RC=$?
      set -e

      # 6. Report and map the exit code.
      node -e '
      const { readFileSync } = require("node:fs");
      const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
      try {
        const j = JSON.parse(readFileSync("pr-rla.json", "utf8"));
        console.log(j.error ? `pr-rla error ${clean(j.error.code)}: ${clean(j.error.message)}` : clean(j.verdict ? `${j.verdict}: ${j.statusLine ?? ""}` : j.line));
      } catch {
        console.log("pr-rla printed no JSON result");
      }'
      prrla_decide "$PRRLA_RC" "$PRRLA_FAIL_ON" || true
      echo "pr-rla: $PRRLA_RESULT ($PRRLA_REASON)"
      [ "$PRRLA_RESULT" = pass ]
  artifacts:
    paths:
      - pr-rla.json
    when: always
    expire_in: 30 days
```

## Credentials

pr-rla reads credentials from the environment and sends each only where a local approval allows. Here the approver is whoever owns this pipeline's configuration; the audited repository is never asked.

| You use | Set as a masked CI/CD variable | Sent to | Approval |
|---|---|---|---|
| gitlab.com | `GITLAB_TOKEN` with `read_api` | `https://gitlab.com` | Built in |
| GitLab self-managed | `GITLAB_TOKEN` | your host | `approve-origins: "GITLAB_TOKEN=https://gitlab.example.com"` |
| A different variable name (`token_env` in `.pr-rla.yml`) | that name | wherever you say | `approve-origins: "NAME=https://host"` |

- **`CI_JOB_TOKEN` cannot call the issues API**, so the `gitlab-issues` ledger needs its own token: a project access token (Premium and Ultimate on gitlab.com) or a personal or service account's PAT (on Free). `read_api` is enough to read; the draw issues are opened by a person with a write token, not by this job.
- Each `approve-origins` entry runs `pr-rla plugin approve --env ENV_VAR --origin https://host --yes` in the job, with the approvals file in the container's temporary directory (`PR_RLA_APPROVALS_FILE`), never in the project.
- `accept-lock-grants: "true"` takes the grants and trust in the audit repository's `pr-rla.lock.json` as given. Use it only for an audit repository you control.
- If the log says `is not approved on this machine, so withheld`, a credential did not reach its host and the run was anonymous: add the origin.

## Exit codes

| Code | The job |
|---|---|
| 0 | Passes |
| 1 | Always fails |
| 2 | Fails when `fail-on` includes `escalate` |
| 3 | Fails when it includes `refusal` |
| 4 | Always fails; run the printed command again |
| 5 | Fails when it includes `timestamps` |
| 6 | Fails when it includes `incomplete` |

Any other code (the binary missing, a signal) fails the job. The job prints the certificate line and keeps `pr-rla.json`, the command's `--json` output, as an artifact (`when: always`).

## Pinning

`version` is exact and the script checks the installed `pr-rla --version` against it. Packages install with `--ignore-scripts`. There is no lockfile in a component, so transitive dependencies resolve on the day; a release that ships `npm-shrinkwrap.json` would pin them too (open for the release checklist).

## What is not here

- `checkpoint` and `sample`. They write to the repository, and a component job has no credential to push with. Run them from a clone with push rights.
- A test on a real GitLab pipeline. The component is tested against GitLab's published CI schema, with its inputs interpolated by the test harness, and its script runs on fixture audit directories with a mock GitLab; that a GitLab instance interpolates and runs it the same way is unverified. GitLab's lint API was not called.
