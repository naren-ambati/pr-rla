#!/usr/bin/env bash
# Step "run" of action.yml: runs the pinned pr-rla, maps its exit code, writes the job summary and
# the step's outputs. It never fails the step itself; the last step of the action applies the mapping.
#
# Inputs arrive as INPUT_* environment variables (see action.yml).
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=exit-map.sh
. "$here/exit-map.sh"

temp="${RUNNER_TEMP:?}"
bin="$ACTION_PATH/node_modules/.bin/pr-rla"
json="$temp/pr-rla.json"
text="$temp/pr-rla.txt"
errs="$temp/pr-rla.err"
rm -f "$json" "$text" "$errs" "$temp/pr-rla-comment.md"

# Global options come before the subcommand. --plugins builtin-only is the default (FR6.4); "allow" is the opt-in.
args=()
[ "$INPUT_PLUGINS" = builtin-only ] && args+=(--plugins builtin-only)
[ "$INPUT_ACCEPT_LOCK_GRANTS" = true ] && args+=(--accept-lock-grants)
args+=(-C "$INPUT_DIR")

out="$text"
case "$INPUT_COMMAND" in
  status | verify)
    args+=("$INPUT_COMMAND" --json)
    [ "$INPUT_OFFLINE" = true ] && args+=(--offline)
    out="$json"
    ;;
  checkpoint)
    args+=(checkpoint --push)
    # A runner has no git identity, and the checkpoint is a commit: use the actions bot's unless the repository sets one.
    [ -n "$(git -C "$INPUT_DIR" config user.name 2>/dev/null)" ] || export GIT_AUTHOR_NAME="github-actions[bot]" GIT_COMMITTER_NAME="github-actions[bot]"
    [ -n "$(git -C "$INPUT_DIR" config user.email 2>/dev/null)" ] || export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
    ;;
  sample) args+=(sample) ;; # never --submit; a sample needs allow-writes
esac

"$bin" "${args[@]}" >"$out" 2>"$errs"
rc=$?

# What pr-rla printed goes to the log with a leading space on any line that starts with "::", so the
# audit's text can never be read as a workflow command.
show() { [ -s "$1" ] && sed 's/^::/ ::/' "$1"; return 0; }
echo "pr-rla ${args[*]} -> exit $rc"
# A --json result is in $json (and summarised below); the text commands print what they printed.
[ "$out" = "$json" ] || show "$out"
show "$errs" >&2

prrla_decide "$rc" "$INPUT_FAIL_ON" || true

{
  echo "exit-code=$rc"
  echo "result=$PRRLA_RESULT"
  echo "reason=$PRRLA_REASON"
} >>"${GITHUB_OUTPUT:?}"
case "$INPUT_COMMAND" in
  status | verify) echo "json=$json" >>"$GITHUB_OUTPUT" ;;
esac

# The summary and the other outputs (state, prefix, llr) come from the report script.
PRRLA_RC="$rc" PRRLA_RESULT="$PRRLA_RESULT" PRRLA_REASON="$PRRLA_REASON" PRRLA_COMMAND_LINE="pr-rla ${args[*]}" \
  PRRLA_JSON="$json" PRRLA_TEXT="$text" PRRLA_ERRS="$errs" PRRLA_COMMENT_FILE="$temp/pr-rla-comment.md" \
  node "$here/report.mjs" || echo "::warning title=pr-rla summary::the summary could not be written"
exit 0
