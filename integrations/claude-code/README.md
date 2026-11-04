# pr-rla for Claude Code

A Claude Code plugin for reviewing pr-rla audit draws. It brings:

- **the pr-rla MCP server** (`.mcp.json`): `pr-rla-mcp` at an exact version, read-only, rooted at the project;
- **`/pr-rla:review-draw`** (`skills/review-draw/SKILL.md`): one draw's diff without generated files, its CI results and the protocol's checklist, ending with the reviewer's own `record` command or the label to apply;
- **the guard** (`hooks/`): `PreToolUse` hooks that block verdict writes, verdict labels, signing, consent and edits to audit records from the assistant.

The reviewer records every verdict. Setup, the read-only token, running it from a checkout before release, and what it does not guarantee: [`docs/assistants/claude-code.md`](../../docs/assistants/claude-code.md).
