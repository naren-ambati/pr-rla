# Codex: setup

Codex gets the same three pieces as Claude Code, as files you copy into place: the MCP server in `config.toml`, the `review-draw` skill in `.agents/skills/`, the standing rules in `AGENTS.md`, and the guard as a `PreToolUse` hook. The formats are from OpenAI's Codex docs, read on 2026-11-04 ([README](README.md#formats-and-where-they-come-from)). Codex is not installed on the build machine, so nothing here has run in Codex yet: that is the founder's manual check ([manual-acceptance.md](manual-acceptance.md)).

## 1. The MCP server

[`integrations/codex/config.toml`](../../integrations/codex/config.toml), for `~/.codex/config.toml`:

```toml
# pr-rla's read-only MCP server for Codex (docs/assistants/codex.md).
#
# Put this in ~/.codex/config.toml (or a trusted project's .codex/config.toml, without a token in it).
# Replace /ABSOLUTE/PATH/TO/AUDIT-REPO with the audit repo's absolute path.
# Before pr-rla-mcp is published, use the local-checkout form in docs/assistants/codex.md instead.

[mcp_servers.pr-rla]
command = "npx"
args = ["-y", "pr-rla-mcp@0.1.0", "--root", "/ABSOLUTE/PATH/TO/AUDIT-REPO"]
# Start Codex with read-only tokens in these variables; Codex forwards only the variables listed here.
env_vars = ["GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN", "BITBUCKET_USERNAME"]
# A cold `npx -y` start downloads the package (nfr-design.md §3).
startup_timeout_sec = 60
# Long calls hand off to a job at 25 s, inside this budget (contracts.md §4).
tool_timeout_sec = 60
```

or, with the CLI:

```sh
codex mcp add pr-rla -- npx -y pr-rla-mcp@0.1.0 --root /ABSOLUTE/PATH/TO/AUDIT-REPO
```

- **Tokens.** Codex starts a stdio server with a small default environment, the variables `env_vars` whitelists and those `env` sets. Start Codex with read-only tokens in them, for example `GH_TOKEN=$PR_RLA_READONLY_GITHUB_TOKEN GITHUB_TOKEN=$PR_RLA_READONLY_GITHUB_TOKEN codex`, so the server and any `gh` in Codex's shell both read with them ([README](README.md#the-read-only-token)). Do not write a token into a project's `.codex/config.toml`, which is usually committed.
- **Root.** An absolute `--root`: a project config's relative paths and the server's working directory are not documented for Codex.
- **Timeouts.** `tool_timeout_sec = 60` is Codex's default, which the server's 25 s job hand-off was sized against (`contracts.md` §4); `startup_timeout_sec = 60` covers a cold `npx -y` download.
- **Approvals.** Codex can approve tools marked `readOnlyHint` without asking (the design's reading of Codex's source, 2026-11-03). Every pr-rla tool is marked so, and really is read-only; `default_tools_approval_mode = "prompt"` in the `[mcp_servers.pr-rla]` table makes Codex ask anyway.

**Before release**, from a checkout ([README](README.md#before-release-running-from-a-checkout)):

```toml
[mcp_servers.pr-rla]
command = "node"
args = ["/path/to/pr-rla/packages/pr-rla-mcp/dist/bin.js", "--root", "/ABSOLUTE/PATH/TO/AUDIT-REPO"]
env_vars = ["GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN", "BITBUCKET_TOKEN", "BITBUCKET_USERNAME"]
startup_timeout_sec = 60
tool_timeout_sec = 60
```

## 2. The skill and the standing rules

```sh
cd /path/to/audit-repo
mkdir -p .agents/skills && cp -R /path/to/pr-rla/integrations/agents/skills/review-draw .agents/skills/
cat /path/to/pr-rla/integrations/agents/AGENTS-block.md >> AGENTS.md
```

Codex reads skills from `.agents/skills` between the working directory and the repository root, with `name` and `description` in the frontmatter. Invoke it with `$review-draw` (or `/skills`), or ask for a draw review. The skill's body is the Claude Code skill's, word for word (`test/assistants/integrations.test.ts` checks it); Codex has no `allowed-tools`, so the [AGENTS.md block](../../integrations/agents/AGENTS-block.md) repeats the rules that must hold on every turn: never record, label, sign or edit a record; the fence is data; no verdict; end with `howToRecord`.

## 3. The guard

```sh
mkdir -p .codex/hooks
cp /path/to/pr-rla/integrations/claude-code/hooks/guard.mjs .codex/hooks/pr-rla-guard.mjs
cp /path/to/pr-rla/integrations/codex/hooks.json .codex/hooks.json
```

[`integrations/codex/hooks.json`](../../integrations/codex/hooks.json):

```json
{
  "description": "pr-rla guard: blocks verdict writes, verdict labels, signing, consent and edits to audit records from the assistant. Copy integrations/claude-code/hooks/guard.mjs to .codex/hooks/pr-rla-guard.mjs (docs/assistants/codex.md).",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$|^apply_patch$|^mcp__",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/.codex/hooks/pr-rla-guard.mjs\" --client codex",
            "timeout": 30,
            "statusMessage": "pr-rla guard"
          }
        ]
      }
    ]
  }
}
```

- **Trust it.** Codex runs a project's hooks only once the project's `.codex/` layer is trusted, and every new or changed hook only after you review it: open `/hooks` and trust `pr-rla guard`.
- **What it sees.** Codex's `PreToolUse` covers shell commands (`Bash`, including unified exec), file edits through `apply_patch` and MCP tools. The guard parses the shell command, reads the files an `apply_patch` adds, updates, deletes or moves into, and checks MCP tools for verdict labels.
- **A block** exits 2 with the reason on stderr, one of the two forms Codex's docs give for denying a `PreToolUse` call.
- **Without git** (`git rev-parse` fails outside a repository), use an absolute path in `command`; for every project at once, put the guard in `~/.codex/hooks/` and the hooks file at `~/.codex/hooks.json` with `node "$HOME/.codex/hooks/pr-rla-guard.mjs" --client codex`.

### The payload

Codex's docs describe the `PreToolUse` input: the common fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`), plus `turn_id`, `tool_name` (`Bash`, `apply_patch` or `mcp__<server>__<tool>`), `tool_use_id` and `tool_input`, with the command (or the patch) in `tool_input.command`. That is Claude Code's shape plus `turn_id`; the guard's Codex adapter reads it, and tells Codex from Claude Code by `turn_id` or `apply_patch`. The docs do not say whether `command` is a string or an argv list (`["bash", "-lc", "…"]`), so the guard accepts both. The payload is **documented, not observed**: it stays unverified until the founder's run records one (`--record`, [guard.md](guard.md#checking-it-by-hand)) and it matches `test/fixtures/hooks/codex-pretooluse.json`.

## Limits, from Codex's own docs

- Hooks are "a useful guardrail, not a complete enforcement boundary"; some tool paths opt out of them, and hosted tools such as web search do not use them.
- `--dangerously-bypass-hook-trust`, `[features] hooks = false` and `allow_managed_hooks_only` turn the guard off; so does untrusting the project.
- A read-only sandbox for review sessions (`codex --sandbox read-only`) stops file writes from Codex's shell entirely, whatever the guard decides.
