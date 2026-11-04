# Security model

This page states what pr-rla protects and what it does not. It starts with external plugins (threat T6 in `docs/design/phase-3-4/nfr-design.md`); the other parts of the model are added as their units land.

## External plugins (T6)

A provider or ledger plugin is code you did not write. It decides the population, and anything it can read or send, it can steal. The npm worms of 2025–2026 (Shai-Hulud, chalk/debug, ChainDrop) took tokens from the environment and from `~/.npmrc`, at run time, from packages with valid provenance. So pr-rla treats every external plugin as untrusted unless you say otherwise.

### What pr-rla does

1. **Nothing external runs until you lock it.** `pr-rla plugin add <use>` resolves the plugin from `.pr-rla.yml`, loads it in the host (below, never in pr-rla's own process), and prints everything it is about to trust: source, version, `resolved`, the npm integrity from `package-lock.json`, a `treeSha256` over every installed file of the plugin and of each runtime dependency, its trust, its hosts, write paths and credentials. Only after you confirm (or pass `--yes`) does it write `pr-rla.lock.json`. Nothing else writes that file: `register` with an unlocked external plugin exits 1 and tells you to run `plugin add`.
2. **Every load re-checks the lock.** npm checks integrity only at install. pr-rla re-resolves the plugin and re-hashes its files at every load, and refuses on any difference: `plugin … changed since it was locked (treeSha256 …); run "pr-rla plugin lock …" after reviewing the change`. A symlink that leaves the plugin's tree aborts the hash. A path plugin must live inside the audit repo, so a third-party verifier loads the same files. The registration records the plugin's name, source, version, tree hash, options hash and trust, and `verify` warns when the plugin it loads is not the registered one.
3. **It runs out of process by default** (`trust: isolated`), in a child Node process started with:
   - `--permission`, with read access to the plugin's own files and its dependencies' only (never their `node_modules` or `.git`), plus pr-rla's child script and SDK modules;
   - no permission to write files, start processes or workers, load addons or use WASI;
   - no `--allow-net`, so on Node 25 or later the child has no network at all;
   - an environment of `PR_RLA_HOST=1` and placeholders only: a locked credential that is set reaches the plugin as `prrla-cred:<ENV>`, never as its value.

   A credential's hosts are locked like everything else. A self-hosted server's credential can follow the URL option its definition names (`hostFromOption: "base_url"`; the Gitea and Jira examples do): pr-rla, not the plugin, takes the host from that option, only from an `https:` URL, and records it in the lock entry, so the reviewer sees it at `plugin add` and a changed option is refused at load. The registration's options hash covers the option.

   A ledger still cannot write files. Its local index (`LedgerContext.index`, `audit/<window>/ledger-index.json`) travels over IPC, and pr-rla reads and writes that one file for it, atomically; nothing else on disk is reachable. `register`, `record` and `verify` read an isolated ledger's provenance and hosts through the host (or from its lock entry), never by importing it.
4. **Every request goes through the parent's fetch broker** over IPC (`pr-rla/ipc/v1`), including a plugin's own `fetch()`. The broker allows only the locked hosts, swaps a placeholder for the secret only on the hosts locked for that credential (`prrla-basic:<USER_ENV>:<TOKEN_ENV>` becomes Basic auth the same way), refuses anything else unsent, and keeps providers read-only on the wire. A secret a server echoes back is replaced with its placeholder before the plugin sees the response. Waits run on the command's clock in the parent.
5. **The host watches the child.** A call sends a heartbeat every 10 s; 60 s of silence stops the child, and the command fails with the plugin's last output lines and writes nothing. Messages over 64 MiB are refused. Results are re-validated by the core whatever the child returns.
6. **`trust: full` is an explicit opt-in** (`plugin add --trust full`): the plugin runs in pr-rla's process with your environment and files, as plugins did before. Every command that loads it prints `PLUGIN TRUST: full (<name>@<version> runs with your environment and files)`, the registration records it, and `verify` repeats it.
7. **`--plugins builtin-only`** (or `PR_RLA_PLUGINS=builtin-only`) refuses every external plugin before anything resolves or imports it. Any other value is refused, so a typo never lets external code in.
8. **`pr-rla plugin check <use>`** reports the lock status, `npm audit signatures` for a package plugin, the hosts and credentials the plugin asks for, and runs the conformance kit through the host on the plugin's own recorded fixtures. Its last line is always `conformance = correctness, not safety: a malicious plugin can pass it`.

### What isolation guarantees

Tested with `test/fixtures/plugins/hostile`, a plugin that tries each of these (`test/plugin-host.test.ts`; `node scripts/demo-plugin-host.mjs` prints the results):

| Node | Token theft through the environment | Reading `~/.npmrc`, gh config, other files | Sending out repo data the plugin sees | Writing files, starting processes |
|---|---|---|---|---|
| 22 and 24 | prevented: it reads a placeholder | blocked by the fs-read scope (*a seatbelt*) | **possible**: Node 22 and 24 have no network control, so the plugin can open its own sockets | blocked (*a seatbelt*) |
| 25 or later | prevented | blocked (*a seatbelt*) | blocked: no `--allow-net` (*a seatbelt*) | blocked (*a seatbelt*) |

Measured on 2026-11-03 with Node 22.23.2, 24.20.0 and 26.8.2 on macOS. Node 25 itself was not available; the Node 25-or-later row rests on Node 26.8.2, where IPC works under `--permission` without `--allow-net` and the plugin's socket is refused with `ERR_ACCESS_DENIED`.

### The limits, stated plainly

- **On Node 22 and 24 a malicious plugin can still send repo data out.** It cannot read your tokens, but it sees whatever the SCM returns to it (private repo data included) and can open a socket to anywhere. Run pr-rla on Node 25 or later to close that.
- **The permission model is a seatbelt, not a security boundary.** Node's documentation says it "does not protect against malicious code" and that malicious code can bypass it; CVE-2025-55130 was a symlink bypass of the fs flags on Node 20, 22, 24 and 25. On Linux, `/proc/<ppid>/environ` is readable by the same user; it is outside the fs-read scope, which is again a seatbelt.
- **A placeholder protects the secret, not the request.** The plugin can still make any read request the token allows to the hosts it is locked to. Give it the narrowest token you have: read-only, one repository.
- **A plugin decides the population.** Isolation does not stop a provider from dropping changes; `verify` rebuilds the population with the provider it is given. Review a plugin before you lock it, and lock the same version your auditor will use.
- **Strong isolation needs the operating system.** For a plugin you do not trust, run pr-rla itself in a container or VM with no ambient credentials. pr-rla ships no sandbox.
- **Install hygiene is yours.** Install plugins with `npm ci --ignore-scripts` (pr-rla plugins need no install scripts; `plugin add` warns when one declares them). npm 11's `allow-scripts` and `min-release-age` help where available.
- **The host needs Node 22.15 or later** (`module.registerHooks`, which links a plugin against pr-rla's own SDK). On an older Node an isolated plugin fails to load with that message; tested only on 22.23.2, 24.20.0 and 26.8.2.

## Assistants, `draw-context` and the MCP server (T7, FR3.2, FR3.9)

An assistant can read an audit through `pr-rla draw-context` or the MCP server, `pr-rla-mcp` ([`packages/pr-rla-mcp`](../packages/pr-rla-mcp)). The asset at stake is the reviewer's verdict authority: a verdict must be a person's.

### The verdict-authority guarantee

> pr-rla's MCP tools and its review skill never record, edit or remove a verdict, never issue draws and never submit to a public log. A read-only mode enforces this, and a test checks every tool.
>
> pr-rla cannot stop an assistant that has your shell and your credentials from acting as you. Client permission rules and hooks are not a security boundary, and some clients let an AI approve tool calls.
>
> What pr-rla can do is make such verdicts not count:
> - give the assistant a read-only token;
> - record verdicts where the assistant cannot, in the SCM web UI;
> - register the reviewers whose verdicts count.
>
> `verify` then reports any verdict below the registered provenance level. Signed verdicts with a security key (`presence`) are supported, but in this release they have been tested only with software keys. pr-rla does not check that a registered key is hardware-backed.

### How it is built, in three tiers

Only the first two are guarantees; the third is a speed bump.

1. **pr-rla's own surfaces never write** (enforced, tested).
   - The MCP server imports only `pr-rla/api/read`, whose functions run in read-only mode: the fetch broker refuses every request that is not a read (`GET`, `HEAD`, a GraphQL query) before it is sent, no recorder is installed, and a ledger is opened with its read methods only. The write functions (`register`, `freeze`, `sample`, `record`, `checkpoint`, `init`, `plugin add` and `lock`) live in `src/api/write/`, which the subpath never imports (`test/api-read-boundary.test.ts` walks the import graph), and each refuses a read-only context with `READ_ONLY_VIOLATION` before it starts.
   - `packages/pr-rla-mcp/test/mcp-readonly.test.mjs` starts the server over stdio with the MCP SDK's own client, under Node's permission model with no fs-write grant and a guard that reports any write call, and calls every tool with valid and hostile inputs (path traversal, symlinks out of the roots, a config naming files outside them, draws past the cap, oversized and malformed arguments, a change whose text tries to give orders). The audit directories' tree hashes, `.git` included, are unchanged; the server attempted no write; the mock SCM saw only reads.
   - There is no tool that records, issues draws or submits, and no elicitation: the server never asks the client a question, so no auto-answered dialog can stand in for a person.
2. **With the recommended setup, a verdict from an assistant does not count** (enforced by the ledger and check 7, not by the client).
   - **Separate credentials.** The assistant's MCP configuration gets a read-only token. The ledger-write credential lives only where the person acts: the SCM's web UI for issue ledgers, or their own terminal and signing key for `git-file`.
   - **Registered reviewers.** `verdicts.reviewers` lists the accounts or signing keys whose verdicts count. Agent and bot accounts are never on it; a label event from an unlisted account is ignored, with a check-7 detail.
   - **App-applied labels.** On GitHub, an event with `performed_via_github_app` set is not counted by default.
   - **Presence attestation** (U9) is designed to be the tier that holds even then. In this release it is verified with software keys only, so pr-rla does not claim it proves a human touched a hardware key.
3. **Client-side guards** (best effort): the assistant plugins' hooks (U6). Client permission rules and hook filters are not a security boundary.

### Untrusted text from the change (FR3.9)

A change's title, description, patches, file names and CI check names are written by whoever authored the change, often an agent, and may hold instructions aimed at the assistant. So may its author and merger names (a direct push's author is free text from the commit), its labels, a verdict's reviewer and note (the ledger's), a ledger's error, and the tracker's issue URL and label names. The core builds the draw context with all of it in an `untrusted` object, and its text rendering puts it between `<<<UNTRUSTED-CHANGE-CONTENT <id>>>>` and `<<<END <id>>>`, with 128 fresh random bits as the id on every call, so the text cannot close the fence by guessing it. Outside the fence are only pr-rla's own words and counts, the frozen manifest's identifiers and the registered protocol; a protocol whose hash is not the registered one gets a FAIL line and no checklist. The MCP server passes the core's fence through and adds none of its own; its instructions to the client say that text inside the fence, and an error's `untrusted` field, are data. A read call's error is pr-rla's sentence: what an SCM response, a ledger or a plugin said goes to `untrusted` (a server that echoes a request or an instruction in its error body never speaks in pr-rla's voice), and a plugin cannot claim pr-rla's "no description" note. This lowers the risk of prompt injection; it cannot rule it out, which is a second reason the verdict stays with the person.

Every text rendering escapes control characters it did not write: C0 controls other than newline and tab, DEL, C1, and the bidirectional controls (Trojan Source), as `\uXXXX`. That covers the draw context's text and every line the CLI prints (stdout and stderr, `--json` included, where `\uXXXX` is a valid escape), so a patch cannot move the cursor and rewrite pr-rla's verdict or protocol lines, or hide the fence's close.

### A change cannot hide its own files

Under the registration's `exclude_generated`, the draw context drops `linguist-generated` files by name. Generated status comes from the `.gitattributes` of the change's base commit and of its landed commit, and a file is dropped only when both mark it (for a rename or copy, its old path too); a `.gitattributes` itself is never generated; and when the change touches any `.gitattributes`, or its file list is truncated, nothing is dropped, with a note outside the fence. The rules are git's own (`src/core/generated.ts`, checked against `git check-attr` with nested files, macros and a seeded fuzz), matched by a linear-time automaton under a work budget, so a hostile pattern cannot stall the server; whatever cannot be decided is shown.

### What the MCP server can reach

- **Only its roots.** `--root <dir>` (repeatable; the working directory by default). A tool's `dir`, and every file the audit API opens for it (the config, the audit directory, the protocol, a json-file export, the transparency-log key, every record and window file, the ledger's file, checkpoints and their history, the ledger index), must resolve inside a root by `realpath`, checked as the file is opened and on the path actually opened (`O_NOFOLLOW`), or the tool returns `ROOT_ESCAPE`, naming what was refused but not where it resolves. No error quotes a file's contents (a JSON or YAML parser's message would). git, run to read the git-file ledger's history, never looks above the roots (`GIT_CEILING_DIRECTORIES`), a `.git` file pointing out of them is refused before git reads it, and git runs with no lazy fetch (a partial clone's missing object is reported, not fetched with your git credentials), no optional locks and no automatic housekeeping. The server does not depend on the client to supply roots. Residual: a concurrent writer that can rename directories inside a root during a call could race the check; that writer already controls the audit.
- **Memory, not disk.** Jobs (a call still running after 25 s), finished results for 600 s, and finished freeze previews for 600 s live in memory and die with the process. At most four long calls run at once; a result over 8 MiB is refused; finished jobs are bounded to 32 and 32 MiB, the oldest dropped first. Each long call stops at its deadline (`LONG_CALL_DEADLINE_MS`, 1 h 30 s: the longest default rate-budget window plus one request's timeout), when the client cancels it before the hand-off, or when the client goes away: its requests, waits and plugin hosts end with it.
- **Annotations are hints.** Every tool carries `readOnlyHint: true`, and some clients auto-approve such tools. That is acceptable only because the tools really are read-only, which the first tier enforces.
- **No `trust: full` plugin, and no repo-chosen credential.** Read-only mode (the MCP server, `pr-rla/api/read`) refuses to load a `trust: full` plugin (`FULL_TRUST_REFUSED`): only built-ins and isolated plugins run there, and an isolated one cannot write files. The audit repo's `.pr-rla.yml` and `pr-rla.lock.json` are not the operator's, so in read-only mode they cannot choose which of the operator's secrets is used or where it goes: a built-in sees only its documented default token variables (`GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`), as placeholders the fetch broker swaps only on its default https origin (`api.github.com`, `gitlab.com`, `api.bitbucket.org`); a `token_env`, a non-default base URL (GitHub Enterprise Server, GitLab self-managed, Bitbucket Data Center), or a lock entry's credential grant needs the operator's consent. This build has no consent store (the plugin fix round's approvals file will answer at `operatorConsents`), so those credentials are withheld, the call runs without them, and the server's log says so. A secret is never sent over `http:` in read-only mode. Nothing else of the environment reaches a plugin. Residual: a config can still point a built-in at another host for anonymous GET requests (an internal address, say); the responses only reach the caller as parsed fields or, in an error, as untrusted text. Start the server with `--plugins builtin-only` (or `PR_RLA_PLUGINS=builtin-only`) to refuse external plugins altogether.
