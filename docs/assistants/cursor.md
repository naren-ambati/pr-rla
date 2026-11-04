# Cursor: setup

Cursor gets the same three pieces, as files you copy into the audit repo: the MCP server in `.cursor/mcp.json`, the `review-draw` skill in `.agents/skills/`, the standing rules as a Cursor rule (or the AGENTS.md block), and the guard in `.cursor/hooks.json`. The formats are from Cursor's docs, read on 2026-11-04 ([README](README.md#formats-and-where-they-come-from)). Nothing here has run in Cursor yet: that is the founder's manual check ([manual-acceptance.md](manual-acceptance.md)).

## 1. The MCP server

[`integrations/cursor/mcp.json`](../../integrations/cursor/mcp.json), for `<audit repo>/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pr-rla": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "pr-rla-mcp@0.1.0", "--root", "${workspaceFolder}"],
      "env": {
        "GITHUB_TOKEN": "${env:PR_RLA_READONLY_GITHUB_TOKEN}",
        "GH_TOKEN": "${env:PR_RLA_READONLY_GITHUB_TOKEN}",
        "GITLAB_TOKEN": "${env:PR_RLA_READONLY_GITLAB_TOKEN}",
        "BITBUCKET_TOKEN": "${env:PR_RLA_READONLY_BITBUCKET_TOKEN}",
        "BITBUCKET_USERNAME": "${env:PR_RLA_READONLY_BITBUCKET_USERNAME}"
      }
    }
  }
}
```

- **`${workspaceFolder}`** is the folder that holds `.cursor/mcp.json`, so the server's root is the audit repo.
- **Tokens.** `${env:NAME}` reads Cursor's environment: set `PR_RLA_READONLY_GITHUB_TOKEN` (and its siblings) where Cursor starts, never your own token ([README](README.md#the-read-only-token)). The server's `GITHUB_TOKEN` is then that token, or empty.
- **Approvals.** Cursor asks before each MCP tool call by default; its run modes can approve allowlisted tools without asking.

**Before release**, from a checkout ([README](README.md#before-release-running-from-a-checkout)), replace the server's `command` and `args` with:

```json
"command": "node",
"args": ["/path/to/pr-rla/packages/pr-rla-mcp/dist/bin.js", "--root", "${workspaceFolder}"],
```

## 2. The skill and the standing rules

```sh
cd /path/to/audit-repo
mkdir -p .agents/skills .cursor/rules
cp -R /path/to/pr-rla/integrations/agents/skills/review-draw .agents/skills/
cp /path/to/pr-rla/integrations/cursor/rules/pr-rla.mdc .cursor/rules/
```

Cursor loads skills from `.agents/skills/` (and `.cursor/skills/`); the skill's `name` matches its folder, as Cursor requires. Invoke it with `/review-draw`, or ask for a draw review. Its body is the Claude Code skill's, word for word.

[`.cursor/rules/pr-rla.mdc`](../../integrations/cursor/rules/pr-rla.mdc) is always applied (`alwaysApply: true`) and carries the same text as the [AGENTS.md block](../../integrations/agents/AGENTS-block.md). Cursor also reads `AGENTS.md`, so if the audit repo's `AGENTS.md` already has the block (for Codex), skip the rule.

## 3. The guard

```sh
mkdir -p .cursor/hooks
cp /path/to/pr-rla/integrations/claude-code/hooks/guard.mjs .cursor/hooks/pr-rla-guard.mjs
cp /path/to/pr-rla/integrations/cursor/hooks.json .cursor/hooks.json
```

[`integrations/cursor/hooks.json`](../../integrations/cursor/hooks.json):

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{ "command": "node .cursor/hooks/pr-rla-guard.mjs --client cursor", "timeout": 30, "failClosed": true }],
    "beforeMCPExecution": [{ "command": "node .cursor/hooks/pr-rla-guard.mjs --client cursor", "timeout": 30, "failClosed": true }],
    "beforeReadFile": [{ "command": "node .cursor/hooks/pr-rla-guard.mjs --client cursor", "timeout": 30, "failClosed": true }],
    "preToolUse": [{ "command": "node .cursor/hooks/pr-rla-guard.mjs --client cursor", "matcher": "Write|Delete", "timeout": 30, "failClosed": true }]
  }
}
```

- **Four hooks.** `beforeShellExecution` (the command and its working directory), `beforeMCPExecution` (every MCP call, with its input as a JSON string), `beforeReadFile` (the signing key) and `preToolUse` filtered to `Write|Delete` (Cursor has no hook before a file edit other than this).
- **`failClosed: true`** makes a guard that crashes, times out or exits with another code block the action. Without it Cursor lets the action through.
- **Answers.** The guard prints `{"permission":"allow"}` for what it allows, as Cursor's own examples do, and `{"permission":"deny","user_message":…,"agent_message":…}` with exit 2 for a block. Cursor runs project hooks only in a trusted workspace, from the project root (hence the relative path).
- **Claude Code hooks in Cursor.** Cursor can load hooks configured for Claude Code (its "third-party" setting, on by default). If it runs the Claude Code plugin's guard, the guard sees Cursor's payload (it carries `cursor_version`) and answers in Cursor's form, whatever `--client` says.

### The payload

Cursor's docs give the input of `beforeShellExecution` (`command`, `cwd`, `sandbox`), `beforeMCPExecution` (`tool_name`, `tool_input` as a string, `mcp_server_name`), `beforeReadFile` (`file_path`) and `preToolUse` (`tool_name`, `tool_input`, `cwd`), with the common fields (`conversation_id`, `hook_event_name`, `cursor_version`, `workspace_roots`, …). They do not give the fields of a `Write` or `Delete` tool's `tool_input`, so the guard checks every path-like field (`file_path`, `path`, `target_file`, …) and, failing those, every short one-line string in it. Unverified until the founder's run records one (`--record`, [guard.md](guard.md#checking-it-by-hand)).

## Not settled by the docs

- Whether `{"permission":"allow"}` from a hook skips Cursor's own approval for a shell command or an MCP call, or only lets it go on to that approval. The guard allows nothing it would not leave to you; the manual run checks that Cursor still asks.
- The `Write`/`Delete` `tool_input` fields (above).
