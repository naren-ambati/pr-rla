# Assistants: Claude Code, Codex and Cursor

An AI assistant can help a person review an audit draw. It cannot record the verdict. pr-rla gives each of the three clients the same three pieces:

1. **The read-only MCP server**, [`pr-rla-mcp`](../../packages/pr-rla-mcp): eight tools that read audits, draws and draw contexts, and write nothing.
2. **The `review-draw` skill**, which walks the person through one draw: the change's diff with generated files left out, its CI results and the protocol's checklist. It ends by printing the person's own `record` command, or the label to apply on an issue ledger. It never records, labels or signs.
3. **The guard**, [`guard.mjs`](../../integrations/claude-code/hooks/guard.mjs), a pre-tool-use hook that blocks verdict writes, verdict labels, signing, consent and edits to audit records from the assistant ([guard.md](guard.md)).

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| Setup | [claude-code.md](claude-code.md): one plugin | [codex.md](codex.md): four files to copy | [cursor.md](cursor.md): four files to copy |
| MCP server | the plugin's `.mcp.json` | `~/.codex/config.toml` | `.cursor/mcp.json` |
| `review-draw` | the plugin's skill, `/pr-rla:review-draw` | `.agents/skills/review-draw`, `$review-draw` | `.agents/skills/review-draw`, `/review-draw` |
| Standing rules | in the skill | the [AGENTS.md block](../../integrations/agents/AGENTS-block.md) | [`.cursor/rules/pr-rla.mdc`](../../integrations/cursor/rules/pr-rla.mdc), or the AGENTS.md block |
| Guard | the plugin's `PreToolUse` hooks | `.codex/hooks.json` (`PreToolUse`) | `.cursor/hooks.json` (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse`) |
| Checked by hand | pending ([manual-acceptance.md](manual-acceptance.md)) | pending | pending |

## What holds, and what does not

The verdict-authority guarantee is built in three tiers ([`docs/security-model.md`](../security-model.md)). Only the first two are guarantees.

1. **pr-rla's own surfaces never write.** The MCP server has no tool that records, issues draws or submits, and its read-only mode refuses every write before it starts. Tested in `packages/pr-rla-mcp/test/mcp-readonly.test.mjs`.
2. **With the recommended setup, a verdict from an assistant does not count.** That is the ledger's and `verify`'s doing, not the client's:
   - give the assistant only a read-only token (below);
   - record verdicts where the assistant cannot: the tracker's web UI for an issue ledger, or your own terminal and signing key for `git-file`;
   - register the reviewers whose verdicts count (`verdicts.reviewers`), and keep the issue-ledger default `minProvenance: account`.
3. **The guard and the skill's rules are a speed bump.** An assistant with your shell and your credentials can act as you, and client hooks are not a security boundary: Codex's docs call its hooks "a useful guardrail, not a complete enforcement boundary", Claude Code's call a hook's `if` filter best-effort, and Cursor's hooks let an action through when they fail unless `failClosed` is set.

## The read-only token

Each client's MCP configuration hands the server a token you keep for the assistant, never your own:

| Variable you set | Becomes the server's |
|---|---|
| `PR_RLA_READONLY_GITHUB_TOKEN` | `GITHUB_TOKEN` and `GH_TOKEN` |
| `PR_RLA_READONLY_GITLAB_TOKEN` | `GITLAB_TOKEN` |
| `PR_RLA_READONLY_BITBUCKET_TOKEN`, `PR_RLA_READONLY_BITBUCKET_USERNAME` | `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME` |

Unset, the server reads anonymously (pr-rla treats an empty token as none), which is enough for an audit whose provider is a JSON export and for a few draws of a public repo. Use a fine-grained GitHub token with read-only access to the audited repo and the audit repo, a GitLab token with the `read_api` scope, or a Bitbucket credential with read scopes only.

The assistant's shell is a second door: `gh` and `glab` use `GH_TOKEN`/`GITHUB_TOKEN` and `GITLAB_TOKEN` before any stored login. Start the review session with the read-only token there too, so a label edit the guard missed fails at the tracker:

```sh
export PR_RLA_READONLY_GITHUB_TOKEN=github_pat_…      # read-only
GH_TOKEN=$PR_RLA_READONLY_GITHUB_TOKEN GITHUB_TOKEN=$PR_RLA_READONLY_GITHUB_TOKEN claude
```

## Before release: running from a checkout

`pr-rla` and `pr-rla-mcp` are not published yet, so `npx -y pr-rla-mcp@0.1.0` cannot install anything. Until they are, each client runs the server from a checkout:

```sh
git clone <pr-rla> && cd pr-rla
npm ci && npm run build
npm --prefix packages/pr-rla-mcp ci && npm --prefix packages/pr-rla-mcp run build
node packages/pr-rla-mcp/dist/bin.js --help          # the server, as each client will start it
```

- **Claude Code:** `node scripts/local-claude-plugin.mjs <dir>` writes a copy of the plugin whose `.mcp.json` runs this checkout's server; start Claude Code with `claude --plugin-dir <dir>` ([claude-code.md](claude-code.md#before-release-a-local-checkout)).
- **Codex and Cursor:** the guides give the local form of the MCP configuration: `node <checkout>/packages/pr-rla-mcp/dist/bin.js` in place of `npx -y pr-rla-mcp@0.1.0`.

**What a release changes.** The plugin and the configuration files pin `pr-rla-mcp` to one exact version, never a range or `latest`: `0.1.0` today, the version in `packages/pr-rla-mcp/package.json`, which is released together with `pr-rla` at the same version (`contracts.md`, versioning). A release that bumps the version changes it in `packages/pr-rla-mcp/package.json`, `package.json`, `integrations/claude-code/.claude-plugin/plugin.json`, the three MCP configurations (`integrations/claude-code/.mcp.json`, `integrations/codex/config.toml`, `integrations/cursor/mcp.json`) and these guides. `test/assistants/integrations.test.ts` fails until every pin and the plugin version agree. Once published, the plugin installs from the public repository's marketplace and the local copy is no longer needed.

## Formats, and where they come from

Every file follows its client's official documentation, read on 2026-11-04 (read-only):

| Client | Pages |
|---|---|
| Claude Code (2.1.267 installed) | [Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference), [plugin components](https://code.claude.com/docs/en/plugins/components), [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference), [hooks reference](https://code.claude.com/docs/en/hooks), [skills](https://code.claude.com/docs/en/skills), [MCP](https://code.claude.com/docs/en/mcp) |
| Codex | [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp), [Hooks](https://learn.chatgpt.com/docs/hooks), [Build skills](https://learn.chatgpt.com/docs/build-skills), [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md) (developers.openai.com/codex redirects there) |
| Cursor | [MCP](https://cursor.com/docs/mcp), [Hooks](https://cursor.com/docs/hooks), [Third-party hooks](https://cursor.com/docs/reference/third-party-hooks), [Skills](https://cursor.com/docs/skills), [Rules](https://cursor.com/docs/rules) |

What the documentation does not settle is listed in each guide and in [manual-acceptance.md](manual-acceptance.md), the founder's checks in the three clients.
