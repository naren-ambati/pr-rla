#!/usr/bin/env bash
# Step "prepare" of action.yml: checks the inputs, then records the credential approvals the job's
# owner asked for, in a file in the runner's temp directory (never in the workspace).
#
# Inputs arrive as INPUT_* environment variables (action.yml maps each one), never spliced into this
# script's text. The approvals are what this job's owner wrote; nothing here reads the audited repo's
# configuration, because the repo being audited is not the party that may grant itself a credential.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=exit-map.sh
. "$here/exit-map.sh"

bad() {
  echo "::error title=pr-rla action input::$*"
  exit 1
}
bool() { [ "$2" = "true" ] || [ "$2" = "false" ] || bad "input $1 must be true or false"; }

case "$INPUT_COMMAND" in
  status | verify | checkpoint | sample) ;;
  *) bad "input command must be status, verify, checkpoint or sample" ;;
esac
bool offline "$INPUT_OFFLINE"
bool comment "$INPUT_COMMENT"
bool allow-writes "$INPUT_ALLOW_WRITES"
bool accept-lock-grants "$INPUT_ACCEPT_LOCK_GRANTS"
case "$INPUT_PLUGINS" in
  builtin-only | allow) ;;
  *) bad "input plugins must be builtin-only or allow" ;;
esac
[ -n "$INPUT_DIR" ] || bad "input dir must not be empty"
msg=$(prrla_check_fail_on "$INPUT_FAIL_ON" 2>&1) || bad "$msg"

# Writes are a decision the job's owner makes in the workflow file, not a default.
if { [ "$INPUT_COMMAND" = checkpoint ] || [ "$INPUT_COMMAND" = sample ]; } && [ "$INPUT_ALLOW_WRITES" != "true" ]; then
  bad "command $INPUT_COMMAND writes to the audit repository: set allow-writes: true (and, for checkpoint, grant contents: write)"
fi
if [ -n "$INPUT_COMMENT_ISSUE" ] && ! [[ "$INPUT_COMMENT_ISSUE" =~ ^[0-9]+$ ]]; then
  bad "input comment-issue must be an issue number"
fi

# The approvals file belongs to the runner, not the repository: refuse a path inside the workspace.
approvals="${PR_RLA_APPROVALS_FILE:?}"
case "$approvals" in
  /*) ;;
  *) bad "the approvals file must be an absolute path" ;;
esac
if [ -n "${GITHUB_WORKSPACE:-}" ]; then
  # Compared as physical paths, so a symlink cannot move the file into the workspace.
  where=$(cd "$(dirname "$approvals")" 2>/dev/null && pwd -P) || bad "the approvals file's directory does not exist"
  workspace=$(cd "$GITHUB_WORKSPACE" && pwd -P)
  case "$where" in
    "$workspace" | "$workspace"/*) bad "the approvals file must not be inside the workspace" ;;
  esac
fi

bin="$ACTION_PATH/node_modules/.bin/pr-rla"
[ -x "$bin" ] || bad "pr-rla is not installed at $bin (the install step did not run)"

# tsa-trust: anchor files the job's owner trusts, paths relative to the workspace, separated by commas or newlines.
set -f
for f in $(printf '%s' "${INPUT_TSA_TRUST:-}" | tr ',\r\n\t' '    '); do
  [ -f "$f" ] || bad "tsa-trust: $f is not a file"
done
set +f

# approve-origins: "ENV=https://host" entries separated by spaces, commas or newlines. Each one is
# `pr-rla plugin approve --env ENV --origin https://host --yes`, the same consent a person gives locally.
list=$(printf '%s' "$INPUT_APPROVE_ORIGINS" | tr ',\r\n\t' '    ')
for entry in $list; do
  env_name=${entry%%=*}
  origin=${entry#*=}
  [ "$entry" != "$env_name" ] || bad "approve-origins entries look like ENV_VAR=https://host"
  [[ "$env_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || bad "approve-origins: '$env_name' is not an environment variable name"
  [[ "$origin" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]] || bad "approve-origins: the origin for $env_name must look like https://host or https://host:port"
  mkdir -p "$(dirname "$approvals")"
  "$bin" -C "$INPUT_DIR" plugin approve --env "$env_name" --origin "$origin" --yes
done
