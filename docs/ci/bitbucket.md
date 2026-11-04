# pr-rla on Bitbucket Pipelines

A script step, with no Docker pipe. Publishing an image is a public write, and a script step does the same job from `npm`. It runs `pr-rla status` when a push to `main` changes `audit/`, and `pr-rla verify` when you start the custom pipeline (attach a schedule in Repository settings, Schedules).

The ledger on Bitbucket Cloud is `git-file`: Bitbucket has no issue ledger in this scope. A team that tracks its audit in Jira can use the Jira example ledger (`examples/ledgers/jira`) instead; it needs the plugin lock and `plugins: allow`, so it is not what this page sets up. See [the end-to-end matrix](README.md#end-to-end-matrix).

## The step

Copy this into `bitbucket-pipelines.yml`. It is tested as written (`test/ci-job-scripts.test.ts`): it passes Bitbucket's published pipelines schema, and its script runs against fixture audit directories.

```yaml bitbucket-pipelines.yml
image: node:24@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413
pipelines:
  branches:
    main:
      - step:
          name: pr-rla status
          condition:
            changesets:
              includePaths:
                - "audit/**"
          script: &pr-rla-script
            - |
              set -e
              # 0. Settings: change them here, or set them as repository or pipeline variables.
              PRRLA_VERSION="${PRRLA_VERSION-0.1.0}"
              PRRLA_INTEGRITY="${PRRLA_INTEGRITY-}"
              PRRLA_COMMAND="${PRRLA_COMMAND-status}"
              PRRLA_DIR="${PRRLA_DIR-.}"
              PRRLA_OFFLINE="${PRRLA_OFFLINE-true}"
              PRRLA_FAIL_ON="${PRRLA_FAIL_ON-escalate,refusal,timestamps,incomplete}"
              PRRLA_PLUGINS="${PRRLA_PLUGINS-builtin-only}"
              PRRLA_APPROVE_ORIGINS="${PRRLA_APPROVE_ORIGINS-}"
              PRRLA_TSA_TRUST="${PRRLA_TSA_TRUST-}"
              PRRLA_ACCEPT_LOCK_GRANTS="${PRRLA_ACCEPT_LOCK_GRANTS-false}"
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
                    prrla_what="exit 6: INCOMPLETE (nothing failed, but something was not established: a time not proven by enough timestamp authorities, the population not rebuilt or shown complete, or a check skipped)"
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
              # The timestamp-authority anchors the owner of this CI configuration trusts beyond the shipped bundle
              # (PRRLA_TSA_TRUST: files, relative to the project): a certificate needs its times proven.
              set -f
              for prrla_f in $(printf '%s' "${PRRLA_TSA_TRUST:-}" | tr ',\r\n\t' '    '); do
                [ -f "$prrla_f" ] || { echo "tsa-trust: $prrla_f is not a file" >&2; exit 1; }
                case "$prrla_f" in /*) ;; *) prrla_f="$(pwd -P)/$prrla_f" ;; esac
                set -- "$@" --tsa-trust "$prrla_f"
              done
              set +f
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
            - pr-rla.json
  custom:
    pr-rla-verify:
      - variables:
          - name: PRRLA_COMMAND
            default: verify
            allowed-values: [status, verify]
          - name: PRRLA_OFFLINE
            default: "false"
            allowed-values: ["true", "false"]
      - step:
          name: pr-rla verify
          script: *pr-rla-script
          artifacts:
            - pr-rla.json
```

- **Pinned.** `PRRLA_VERSION` is one exact version. The script refuses a range or a tag, and refuses an installed `pr-rla` whose `--version` is not that exact version. `PRRLA_INTEGRITY` (the `sha512-…` that `npm view pr-rla@<version> dist.integrity` reports, copied from the release notes) makes the step stop unless npm reports the same value. Packages install with `--ignore-scripts`. Transitive dependencies are whatever npm resolves on the day, because there is no lockfile here: the Action has one, and a release that ships `npm-shrinkwrap.json` would close this gap (open for the release checklist).
- **Built-ins only.** The step runs `pr-rla --plugins builtin-only …`. `PRRLA_PLUGINS=allow` is the opt-in.
- **Image.** `node:24`, pinned by the digest of the tag on 2026-11-04. Re-pin it when you update Node.
- **Artifact.** `pr-rla.json` is the command's `--json` output. The step prints the certificate line.

## Credentials

pr-rla reads credentials from the environment and sends each one only where a local approval allows. In a pipeline the person who writes `bitbucket-pipelines.yml` is the one who approves; the audited repository is never asked.

| You use | Set as a secured repository variable | Sent to | Approval |
|---|---|---|---|
| Bitbucket Cloud, access token (repository, project or workspace) with Repositories: Read and Pull requests: Read | `BITBUCKET_TOKEN` | `https://api.bitbucket.org` | Built in |
| Bitbucket Cloud, Atlassian API token with `read:repository:bitbucket` and `read:pullrequest:bitbucket` | `BITBUCKET_TOKEN`, and the Atlassian account e-mail in `BITBUCKET_USERNAME` | `https://api.bitbucket.org` (Basic) | Built in |
| Bitbucket Data Center (unverified against a live server) | `BITBUCKET_DC_TOKEN` | your host | `PRRLA_APPROVE_ORIGINS="BITBUCKET_DC_TOKEN=https://bitbucket.example.com"` |
| A different variable name (`token_env` in `.pr-rla.yml`) | that name | wherever you say | `PRRLA_APPROVE_ORIGINS="NAME=https://host"` |

- App passwords can no longer be created (Atlassian stopped on 2025-09-09). Use an API token or an access token.
- `PRRLA_APPROVE_ORIGINS` takes `ENV_VAR=https://host` entries separated by spaces or commas. Each one runs `pr-rla plugin approve --env ENV_VAR --origin https://host --yes` in the job, with the approvals file in the container's temporary directory (`PR_RLA_APPROVALS_FILE`), never in the clone.
- `PRRLA_TSA_TRUST` names timestamp-authority anchor files you trust beyond the shipped bundle (relative to the clone, separated by spaces or commas), passed as `--tsa-trust`. It is needed only for an authority outside the shipped bundle: without it such an audit's certificate is withheld (exit 6).
- `PRRLA_ACCEPT_LOCK_GRANTS=true` takes the grants and trust in the audit repository's `pr-rla.lock.json` as given. Use it only for an audit repository you control.
- If the log says `is not approved on this machine, so withheld`, a credential did not reach its host and the run was anonymous; a private host that refused every read leaves the check unestablished, so pr-rla exits 6 (INCOMPLETE). Add the origin to `PRRLA_APPROVE_ORIGINS`.

## Exit codes

| Code | The step |
|---|---|
| 0 | Passes |
| 1 | Always fails |
| 2 | Fails when `PRRLA_FAIL_ON` includes `escalate` |
| 3 | Fails when it includes `refusal` |
| 4 | Always fails; run the printed command again |
| 5 | Fails when it includes `timestamps` |
| 6 | Fails when it includes `incomplete` (`verify` could not rebuild the population or show it complete) |

The default is `escalate,refusal,timestamps,incomplete`; a `PRRLA_FAIL_ON` that is set and empty tolerates 2, 3, 5 and 6. Any other code (the binary missing, a signal) fails the step.

## Budget

Bitbucket Cloud allows 1,000 requests an hour on `/2.0/repositories/*`, and about 50 to 60 unauthenticated. Online `verify` of a large window is a scheduled job, not a per-push one, which is why the custom pipeline sets `PRRLA_OFFLINE` to `false` and the push step leaves it on.

## What is not here

- `checkpoint` and `sample`. They write to the repository, and this step has no credential to push with. Run them from a clone with push rights.
- A test on a real Bitbucket pipeline. The step is tested on a fixture audit directory and a mock server (`test/ci-job-scripts.test.ts`); that Bitbucket accepts the anchor and runs the step as the harness did is unverified.
