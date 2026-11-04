# pr-rla-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for pr-rla audits, over stdio. It lets an assistant list audits, read their status, the issued draws and a draw's full review context, verify an audit and simulate one. It never records a verdict, issues a draw, submits to a log or writes a file: a person records every verdict, from the CLI or the tracker's web UI.

It imports only `pr-rla/api/read`, the read functions of pr-rla's audit API, fixed to read-only mode: the fetch broker refuses every request that is not a read before it leaves the process.

## Run it

In this repository:

```sh
npm ci && npm run build                                   # pr-rla itself (the server links its dist/)
npm --prefix packages/pr-rla-mcp ci && npm --prefix packages/pr-rla-mcp run build
node packages/pr-rla-mcp/dist/bin.js --root /path/to/audit-repo
```

The package depends on pr-rla through `"pr-rla": "file:../.."`: npm links the repository's own package, so the server always runs the pr-rla next to it, and `npm ci` works offline once npm's cache holds the MCP SDK and zod. The two are released together with one version; the release pins pr-rla to that exact version instead of the link. After a change to pr-rla's own dependencies, run `npm install` here once to refresh the lockfile.

An MCP client starts it as a stdio server, for example:

```json
{ "command": "node", "args": ["/path/to/pr-rla/packages/pr-rla-mcp/dist/bin.js", "--root", "/path/to/audit-repo"], "env": { "GITHUB_TOKEN": "<a read-only token>" } }
```

| Option | Meaning |
|---|---|
| `--root <dir>` | A directory the tools may open (repeatable; default: the working directory). Every `dir` argument, and every file the audit names (config, protocol, export, audit directory), must resolve inside a root after `realpath`, or the tool returns `ROOT_ESCAPE`. |
| `--plugins builtin-only` | Refuse every external provider and ledger (`PR_RLA_PLUGINS=builtin-only` does the same). |
| `--handoff-ms <n>` | For tests: hand long calls off as jobs after `n` ms (1 to 25,000; default 25,000). |

Tokens come from the server's environment. Give it a **read-only** token: the second tier of the verdict-authority guarantee rests on the assistant having no credential that can record a verdict ([`docs/security-model.md`](../../docs/security-model.md)).

## Tools

Every tool is annotated `readOnlyHint: true`. Every result is `structuredContent` and the same JSON as text.

| Tool | Input | Output | `openWorldHint` |
|---|---|---|---|
| `audit_list` | `dir?` | `{ dir, windows: [{ name, phase, configured, mode, N?, drawsIssued?, certified?, line }] }` | false |
| `status` | `dir?`, `window?`, `offline` (default `true`) | the status result of the window's phase, with its certificate line; never appends a checkpoint | true |
| `draws` | `dir?`, `window?`, `from?`, `limit?` (≤ 200) | the issued draws with their verdict state, and the blocking draw | false |
| `draw_context` | `dir?`, `window?`, `draw`, `maxPatchBytes?` (≤ 1 MiB, default 200 KiB) | the draw context: `untrusted` holds the change's own text, and `text` fences it | true |
| `verify` | `dir?`, `window?`, `offline` (default `true`) | the seven checks | true |
| `simulate` | `population`, `defects`, `runs?` (≤ 20,000), `p0?`, `p1?`, `alpha?`, `seed?` | the simulation report | false |
| `freeze_preview` | `dir?`, `window?`, `estimate?` | the population a freeze would write now (`freeze --dry-run`) | true |
| `job_status` | `jobId` | `{ state: running \| done \| failed \| unknown, progress?, result?, error? }` | false |

`draw_context` drops `linguist-generated` files when the registration's `exclude_generated` is on, and puts everything the change's author wrote (title, description, patches, file and check names) between `<<<UNTRUSTED-CHANGE-CONTENT <id>>>>` and `<<<END <id>>>`, with a new random 128-bit id per call. The server passes the core's fence through and adds none. `freeze_preview`'s `estimate` belongs to the org-pooled freeze and is refused (`UNSUPPORTED`) until that lands.

**Long calls.** `status` and `verify` with `offline: false`, `draw_context` and `freeze_preview` can reach the network. One still running after 25 s returns `{ jobId, state: "running" }` and keeps running in the server; poll `job_status`. While the call is open, its progress goes out as MCP progress notifications (when the client asks for them); after the hand-off, the job keeps its latest progress for `job_status`. At most four such calls run at once (a fifth gets `TOO_MANY_JOBS`), a result over 8 MiB is refused (`RESULT_TOO_LARGE`), and a finished job is kept 600 s. Jobs live in memory: after a restart `job_status` answers `unknown` with `run <tool> again`. A finished `freeze_preview` is cached in memory for 600 s, by window, registration digest and `estimate`.

**Errors** are `isError: true` with `{ code, message, next? }`: `ROOT_ESCAPE`, `NO_AUDIT`, `BAD_WINDOW`, `DRAW_OUT_OF_RANGE`, `READ_ONLY_VIOLATION`, `PROVIDER_ERROR`, `TIMEOUT`, `TOO_MANY_JOBS`, `RESULT_TOO_LARGE`, and `UNSUPPORTED` for `estimate`. Arguments that do not fit a tool's schema are refused by the MCP SDK before any handler runs.

The server never asks the client anything: no elicitation, no sampling, no roots request.

## Tests

`npm test` builds the server and runs `test/*.test.mjs` with `node:test`. They start the server over stdio with the MCP SDK's own client, under Node's permission model with no fs-write grant and a preloaded guard that reports any write call and refuses any socket beyond loopback, on the recorded gh-aw audit (`test/fixtures/audits/gh-aw-q3-recorded`) and on a mock GitHub Enterprise Server on 127.0.0.1. `scripts/demo-draw-context.mjs` is the demo: `draw_context` on a recorded gh-aw draw, with the audit directory's tree hash before and after.
