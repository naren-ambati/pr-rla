# Running pr-rla in Docker

pr-rla is not published to npm yet. The [`Dockerfile`](../Dockerfile) at the repository root builds an image with both commands, `pr-rla` and `pr-rla-mcp`, from this checkout: Node 22, git (the `git-file` ledger reads its history) and ssh-keygen (signed verdicts). The base image is pinned by digest, the image runs as the unprivileged `node` user, and nothing in it is fetched from the npm registry at run time.

## Build

```sh
git clone https://github.com/naren-ambati/pr-rla.git && cd pr-rla
docker build -t pr-rla .
docker run --rm pr-rla --version
```

## Run the CLI on an audit repository

Mount the audit repository at `/audit` (the image's working directory) and pass the command:

```sh
cd ~/my-audit
docker run --rm -v "$PWD:/audit" -e GITHUB_TOKEN pr-rla status
docker run --rm -v "$PWD:/audit" -e GITHUB_TOKEN pr-rla verify
```

- **Tokens.** Pass them by name (`-e GITHUB_TOKEN`, `-e GITLAB_TOKEN`, `-e BITBUCKET_TOKEN`): Docker copies the value from your shell and it never appears on the command line. A read-only token is enough for everything but `sample` with an issue ledger and `record`.
- **Writing commands** (`init`, `register`, `freeze`, `sample`, `record`, `checkpoint`) write into the mounted directory. On Linux, add `--user "$(id -u):$(id -g)"` so the files belong to you; on macOS with Docker Desktop or Colima they do already. Mount read-only (`-v "$PWD:/audit:ro"`) for `status`, `verify` and `draw-context`.
- **Keys.** `register --key`, `freeze --key`, `sample --key` and `record --sign` take a path inside the container: mount the key's directory too, for example `-v "$HOME/keys:/keys:ro"` and `--key /keys/registration.pem`.
- **A subdirectory.** `-w /audit/<dir>` runs in a subdirectory of the mount, or use `-C <dir>`.
- **On macOS with Colima**, only your home directory is shared with the VM by default: keep audit repositories under it.

## Run the MCP server for an assistant

The server speaks MCP over stdio, so run it with `-i`, and mount the audit read-only:

```sh
docker run --rm -i -v "$PWD:/audit:ro" --entrypoint pr-rla-mcp pr-rla --root /audit
```

In an assistant's MCP configuration (Claude Code's `.mcp.json`, Codex, Cursor), the server entry becomes:

```json
{
  "mcpServers": {
    "pr-rla": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-v", "${CLAUDE_PROJECT_DIR}:/audit:ro", "-e", "GITHUB_TOKEN", "--entrypoint", "pr-rla-mcp", "pr-rla", "--root", "/audit"],
      "env": { "GITHUB_TOKEN": "${PR_RLA_READONLY_GITHUB_TOKEN:-}" }
    }
  }
}
```

Give it a read-only token: the server never writes, and a verdict is the reviewer's (see [the guard](assistants/guard.md)). The Claude Code plugin's own `.mcp.json` starts the server with `npx pr-rla-mcp@0.1.0`, which needs the npm package; until it is published, use the entry above or the plugin built from a checkout ([`assistants/claude-code.md`](assistants/claude-code.md)).

## What was checked (2026-11-14)

Built on macOS (Colima, Linux aarch64) and run against the two live audits of the [sandbox showcase](../examples/sandbox-showcase/README.md): `verify --offline` (the git-file ledger's history and the signed verdicts, checked with the image's ssh-keygen), an online `verify` with `GITHUB_TOKEN` passed by name (seven checks PASS, exit 2 for ESCALATE, as on the host), `init` into a mounted directory (files owned by the host user), and `pr-rla-mcp` over stdio (initialize, the eight tools, `status`). The image is about 530 MB, most of it the Node base image and git.
