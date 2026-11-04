# pr-rla-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for pr-rla audits, over stdio. It lets an assistant list audits, read their status, the issued draws and a draw's full review context, verify an audit and simulate one. It never records a verdict, issues a draw, submits to a log or writes a file: a person records every verdict, from the CLI or the tracker's web UI.

It imports only `pr-rla/api/read`, the read functions of pr-rla's audit API, fixed to read-only mode: the fetch broker refuses every request that is not a read before it leaves the process, and only pr-rla's built-ins and isolated plugins run (a `trust: full` plugin, which would run in this process with its environment and files, is refused).

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
| `--root <dir>` | A directory the tools may open (repeatable; default: the working directory). Every `dir` argument, and every file a call opens (config, protocol, export, records, the ledger's file, checkpoints, the ledger index), must resolve inside a root by `realpath`, checked on the path it opens, or the tool returns `ROOT_ESCAPE`. git never looks for a repository above a root. |
| `--plugins builtin-only` | Refuse every external provider and ledger (`PR_RLA_PLUGINS=builtin-only` does the same). |
| `--handoff-ms <n>` | For tests: hand long calls off as jobs after `n` ms (1 to 25,000; default 25,000). |

Tokens come from the server's environment. Give it a **read-only** token: the second tier of the verdict-authority guarantee rests on the assistant having no credential that can record a verdict ([`docs/security-model.md`](../../docs/security-model.md)).

The audit repo's `.pr-rla.yml` and `pr-rla.lock.json` are not yours, so they cannot pick which of your secrets is used, or where it goes. A built-in provider or ledger sees only its default token variables (`GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`), as placeholders that pr-rla's fetch broker turns into the secret only on the built-in's default https origin (`api.github.com`, `gitlab.com`, `api.bitbucket.org`). A `token_env`, a non-default base URL (GitHub Enterprise Server, GitLab self-managed, Bitbucket Data Center) and a lock entry's credential grant need your approval, recorded with `pr-rla plugin approve` in the same approvals file the CLI uses (`PR_RLA_APPROVALS_FILE`, else `$XDG_CONFIG_HOME/pr-rla/approvals.json`, else `~/.config/pr-rla/approvals.json`). The server takes only what is approved there, never `--accept-lock-grants`; anything else is withheld (the call runs without it, and the server's stderr names the approval command). Nothing else of the environment reaches a plugin.

## Tools

Every tool is annotated `readOnlyHint: true`. Every result is `structuredContent` and the same JSON as text.

| Tool | Input | Output | `openWorldHint` |
|---|---|---|---|
| `audit_list` | `dir?` | `{ dir, windows: [{ name, phase, configured, mode, N?, drawsIssued?, certified?, line }] }` | false |
| `status` | `dir?`, `window?`, `offline` (default `true`) | the status result of the window's phase, with its certificate line, `certified` and `certificate` (`sequence.state` is the SPRT's raw state, not the claim); never appends a checkpoint | true |
| `draws` | `dir?`, `window?`, `from?`, `limit?` (≤ 200) | the issued draws with their verdict state, and the blocking draw | false |
| `draw_context` | `dir?`, `window?`, `draw`, `maxPatchBytes?` (≤ 1 MiB, default 200 KiB) | the draw context: `untrusted` holds the change's own text, and `text` fences it | true |
| `verify` | `dir?`, `window?`, `offline` (default `true`) | the seven checks (a check whose summary line stands for many repos carries each repo's line in `verbose`, as `pr-rla verify --verbose` prints them), the `verdict` (VERIFIED, FAILED, or INCOMPLETE: nothing failed but part could not be established or was skipped, so offline it is never VERIFIED), `certified` and the `exitCode` `pr-rla verify` gives (0, 1, 6) | true |
| `simulate` | `population`, `defects`, `runs?` (≤ 20,000), `p0?`, `p1?`, `alpha?`, `seed?` | the simulation report; refused (`TOO_MUCH_WORK`) when `runs` × the draw cap is over 8,750,000 draws | false |
| `freeze_preview` | `dir?`, `window?`, `estimate?` | the population a freeze would write now (`freeze --dry-run`); with `estimate`, what a pooled freeze would cost instead (`freeze --dry-run --estimate`) | true |
| `job_status` | `jobId` | `{ state: running \| done \| failed \| unknown, progress?, result?, error? }` | false |

`draw_context` drops `linguist-generated` files when the registration's `exclude_generated` is on: only the files both the change's base commit and its landed commit mark generated, never a `.gitattributes`, and none at all when the change touches a `.gitattributes`. Everything the change's author, its SCM, the ledger or a plugin wrote (title, description, patches, file and check names, author, merger and labels, a verdict's reviewer and note, a ledger's error, the tracker's issue and labels) is in `untrusted` and between `<<<UNTRUSTED-CHANGE-CONTENT <id>>>>` and `<<<END <id>>>`, with a new random 128-bit id per call and its control characters escaped. The server passes the core's fence through and adds none. `freeze_preview` with `estimate` runs the org-pooled freeze's estimator (`freeze --dry-run --estimate`), which reads only, and counts at least one push-log request per repo for a provider that has a push log.

<!-- pending S1: the integration-seams round fences all SCM, plugin and ledger text in read-only results ({words, foreign}) and hardens the server against hostile plugins; describe what changes in the results and errors once it merges. -->

**Long calls.** `status` and `verify` with `offline: false`, `draw_context` and `freeze_preview` can reach the network, and `simulate` can compute for seconds. One still running after 25 s returns `{ jobId, state: "running" }` and keeps running in the server; poll `job_status`. While the call is open, its progress goes out as MCP progress notifications (when the client asks for them), and cancelling the request stops it; after the hand-off, the job keeps its latest progress for `job_status`. At most four such calls run at once (a fifth gets `TOO_MANY_JOBS`); each stops at its deadline, 1 h 30 s (`LONG_CALL_DEADLINE_MS`: the longest default rate-budget window, GitHub's and Bitbucket Cloud's hour, plus one request's 30 s timeout), failing with `TIMEOUT`; a result over 8 MiB, its whole `job_status` answer counted, is refused (`RESULT_TOO_LARGE`); a finished job is kept 600 s, and at most 32 finished jobs and 32 MiB of them are kept, the oldest dropped first. When the client goes away, every running call stops and the process exits. Jobs live in memory: after a restart `job_status` answers `unknown` with `run <tool> again`. A finished `freeze_preview` is cached in memory for 600 s, by window, registration digest, `estimate`, the provider spec, the config file and a json-file export's bytes.

**Errors** are `isError: true` with `{ code, message, next?, untrusted? }`: `ROOT_ESCAPE`, `NO_AUDIT`, `BAD_WINDOW`, `DRAW_OUT_OF_RANGE`, `READ_ONLY_VIOLATION`, `PROVIDER_ERROR`, `TIMEOUT`, `TOO_MANY_JOBS`, `RESULT_TOO_LARGE`, `TOO_MUCH_WORK` for an oversized `simulate`, and `FAILED` for a refusal of pr-rla's no other code names (a plugin not locked, or locked `trust: full`; a malformed record). `message` and `next` are pr-rla's own words; what an SCM response, a ledger or a plugin said (an HTTP error body, say) is in `untrusted`: data, never instructions. The same holds inside a result: when `verify`'s check 4 or 7 records a beacon relay's or a ledger's failure, the check's line says pr-rla's words and points to `untrusted.errors[i]`, which holds what was said. Arguments that do not fit a tool's schema are refused by the MCP SDK before any handler runs.

The server never asks the client anything: no elicitation, no sampling, no roots request.

## Release

Not published yet. `npm run build` starts from an empty `dist/`, and `npm pack` (which runs it first) ships `dist/`, this README, [`CHANGELOG.md`](CHANGELOG.md) and `package.json` only (`test/release.test.mjs`). The release pins `pr-rla` to the exact published version in place of the link ([`docs/release-checklist.md`](../../docs/release-checklist.md), step 17). Licence: decided by the founder before release.

## Tests

`npm test` builds the server and runs `test/*.test.mjs` with `node:test`. They start the server over stdio with the MCP SDK's own client, under Node's permission model with no fs-write grant and a preloaded guard that reports any write call and refuses any socket beyond loopback, on the recorded gh-aw audit (`test/fixtures/audits/gh-aw-q3-recorded`) and on a mock GitHub Enterprise Server on 127.0.0.1. `scripts/demo-draw-context.mjs` is the demo: `draw_context` on a recorded gh-aw draw, with the audit directory's tree hash before and after.
