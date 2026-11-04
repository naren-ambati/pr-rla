# The guard

[`integrations/claude-code/hooks/guard.mjs`](../../integrations/claude-code/hooks/guard.mjs) is a pre-tool-use hook. Before each tool call it reads the client's hook payload on stdin and blocks the call when the assistant would act as the reviewer: write or sign a verdict, apply a verdict label, give consent, or change an audit record. It is one file with no dependencies, so Codex and Cursor projects copy it as is.

It is the third tier of the verdict-authority guarantee: a speed bump, not a boundary ([README](README.md#what-holds-and-what-does-not)). An assistant that wants to get round it can (a program the guard does not read, a tool the client does not hook). What makes a verdict count is the ledger and `verify`: registered reviewers, account provenance, and a token the assistant does not have.

## What it blocks

| From the assistant | Blocked |
|---|---|
| **Verdicts** | `pr-rla record` in any form, including `--sign`; `ssh-keygen -Y sign` in the `pr-rla-verdict@v1` namespace, or with a namespace it cannot read |
| **pr-rla's other writes** | `register`, `freeze`, `sample` and `init` in every form (`--dry-run` too: the MCP tool `freeze_preview` is the read-only dry run); `checkpoint --push` (and `--remote`/`--branch`); `--submit` |
| **Consent** | `pr-rla plugin approve`, `add` and `lock`; `--accept-lock-grants`; setting `PR_RLA_ACCEPT_LOCK_GRANTS` or `PR_RLA_APPROVALS_FILE`, or `HOME`/`XDG_CONFIG_HOME` for a pr-rla command; any pr-rla command when the session itself was started with `PR_RLA_ACCEPT_LOCK_GRANTS` set |
| **Verdict labels** | `gh issue`/`gh pr` `edit --add-label`/`--remove-label` and `create --label`; `gh label edit`/`delete`, and renaming a label to a verdict label; a `gh alias` that does one of these; `glab issue`/`mr` `update --label`/`--unlabel`; `gh api`, `glab api`, `curl`, `wget` and HTTPie requests other than GET or HEAD to a label endpoint, to an issue update carrying labels, or with a GraphQL label mutation (or a body the guard cannot read); another MCP server's tool whose input carries a verdict label |
| **Audit records** | Write, Edit, MultiEdit, NotebookEdit, Codex's `apply_patch`, Cursor's Write and Delete, another MCP server's write tool, shell redirects, and `tee`, `cp`, `mv`, `install`, `ln`, `rsync`, `rm`, `truncate`, `touch`, `dd`, `sed -i`, `perl -i`, `patch`, `find -delete`, `tar -x` and `unzip` (by listing the archive), PowerShell's `Set-Content` and its kin, or inline code (`node -e`, `python -c`, …) that would write: `registration.json`, `manifest-commitment.json`, `*.manifest.json`, `draws.json`, `verdicts.jsonl` (or the ledger file `.pr-rla.yml` names), `ledger-index.json`, `ledger-publication.json`, `ledger-checkpoints.jsonl`, anything under `ledger-history/`, the audit repo's `.git/` (its hooks and config run commands as you), `pr-rla.lock.json` and `.pr-rla.yml`, and the approvals file (`$PR_RLA_APPROVALS_FILE`, `$XDG_CONFIG_HOME/pr-rla/approvals.json` or `~/.config/pr-rla/approvals.json`); also a directory that holds any of them |
| **The audit's history** | `git commit` that would commit `verdicts.jsonl` (staged, or by `-a`, a pathspec or an earlier `git add` in the same command), or amend a commit that holds it; in an audit repo: `git push` with `--force`, `--force-with-lease`, `--mirror`, `--delete` or a `+`/`:` refspec, `git reset --hard` (or `--merge`, `--keep`) that would discard a record's change or drop commits that change records, `git checkout`/`restore`/`rm`/`mv`/`stash`/`clean -f`/`apply`/`am` that would change or discard a record, `git rebase`, `filter-branch`, `filter-repo` and `replace`, and `git config` of a key git runs as a command later (`core.hooksPath`, `core.pager`, `core.editor`, `credential.helper`, …) |
| **The signing key** | reading the audit's signing key (`.pr-rla/*.pem`, or the `signing_key` `.pr-rla.yml` names) with Read, Grep, Cursor's file reads, or any shell command |

Records are recognized by name inside an **audit repo**, a directory tree with a `.pr-rla.yml` above it, so a `registration.json` in another project is left alone. `pr-rla.lock.json`, `.pr-rla.yml` and the approvals file are protected anywhere. Verdict labels are the defaults (`pr-rla:pass`, `pr-rla:fail`, `pr-rla-pass`, `pr-rla-fail`, `pr-rla::pass`, `pr-rla::fail`, in any case), anything shaped like them, and the labels the audit's `ledger-index.json` and `.pr-rla.yml` name.

Unknown pr-rla subcommands are blocked too: only `status` (with `--checkpoint`), `verify`, `draw-context`, `simulate`, `plugin check`, plain `checkpoint` (which appends pr-rla's own local checkpoint line and pushes nothing) and `--help`/`--version` pass. A pr-rla command with a computed subcommand, or a computed argument where a flag could go, is blocked: the guard cannot tell what it would do.

## What passes

Reading anything other than the signing key (`cat`, `jq`, `git log`, the Read tool, pr-rla's own MCP tools), pr-rla's read-only commands, `gh issue edit` with other labels, GET requests to label endpoints, `ssh-keygen -Y verify` in pr-rla's namespace and `-Y sign` in others, `echo`ing the record command for the person to run, staging `verdicts.jsonl` (committing it is blocked), plain `git push`, and every command in another project. `test/assistants/guard.test.ts` names 60 such cases.

## How it reads a command

It parses the command line as a POSIX shell would, far enough to see what runs and what is written:

- quoting (`'…'`, `"…"`, `$'…'` with escapes, backslashes), `VAR=value` prefixes, variables it can resolve (earlier assignments, and `HOME`, `XDG_CONFIG_HOME`, `PR_RLA_APPROVALS_FILE`, `TMPDIR`, `PWD` from the session), `~`, brace expansion and globs (expanded against the disk);
- `;`, `&&`, `||`, pipelines, subshells, `{ … }` groups, `if`/`while`/`case`, functions, aliases, `$(…)`, backticks and `<(…)`;
- heredocs, here-strings, redirects, and a `cd` earlier in the same line;
- wrappers: `env` (with `-S`, `-C`), `command`, `exec`, `nohup`, `time`, `nice`, `timeout`, `sudo`, `doas`, `stdbuf`, `xargs`, `find -exec`, `watch`, `ssh`, `script`, `arch`, `setsid`, `direnv exec`, `parallel`, `at`, `npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx`, and any other program handed `pr-rla` as an argument;
- shells (`sh -c`, `bash -lc`, a script file, a script on stdin or from earlier in the pipeline, `pwsh -Command`), `eval`, `source`, executable scripts (read from disk, or from what the same line wrote), npm/pnpm/yarn/bun scripts from `package.json`, Makefile/justfile/Taskfile recipes, git aliases and pagers (`git -c core.pager=…`, `GIT_PAGER=…`);
- code in other languages (`node -e`, `python -c`, `perl -e`, `ruby -e`, `osascript -e`, and script files), by pattern: a pr-rla write command, the consent flags, signing in pr-rla's namespace, a verdict label sent anywhere, or a write call naming a record (the last only for inline code, or for a script file inside an audit repo).

### What it cannot see

- A program that writes a record or applies a label without naming it where the guard looks: a compiled binary, a script that builds the path or the label at run time, a download it runs, a Docker container, a program in another language that reads its target from a file.
- Commands made of text it cannot resolve: `eval` or `sh -c` of a variable or a command's output whose source does not show the pr-rla command (it blocks what it can see of them: a computed program name with pr-rla-like arguments, a computed pr-rla subcommand).
- Tools the client does not hook (Claude Code's `Glob`, a client's hosted web tools), files mentioned with `@` in a prompt (inserted without a tool call), and anything a client runs before its hooks load.
- A label applied in the tracker's web UI by whoever has the browser, which is where verdicts belong.

On Windows (untested), PowerShell commands are read with the same parser: plain commands and the file cmdlets are covered, PowerShell's own syntax is not.

## Clients and answers

| Client | Hooks | A block | An allowed call |
|---|---|---|---|
| Claude Code | `PreToolUse` on `Bash`, `PowerShell`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Read`, `Grep`, `mcp__.*` | exit 2, the reason on stderr | exit 0, no output (the normal permission flow) |
| Codex | `PreToolUse` on `Bash`, `apply_patch`, `mcp__*` | exit 2, the reason on stderr | exit 0, no output |
| Cursor | `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse` (`Write|Delete`) | exit 2, `{"permission":"deny",…}` on stdout | exit 0, `{"permission":"allow"}` |

`--client` names the payload's format; without it, and whenever the payload carries Cursor's `cursor_version` or Codex's `turn_id`, the guard reads the payload as that client's. Input it cannot read (not JSON, not an object) is blocked, and so is a crash of the guard itself. Exit 2 is the exit code `contracts.md` §7 reserves for an assistant hook block.

## Checking it by hand

```sh
node integrations/claude-code/hooks/guard.mjs --check-shell 'pr-rla record 5 pass' --cwd /path/to/audit-repo
# blocked:
#   - pr-rla record writes a verdict, and a verdict is the reviewer's: …
node integrations/claude-code/hooks/guard.mjs --check-shell 'pr-rla status' --cwd /path/to/audit-repo
# allowed
```

To see the payloads a client really sends (the founder's manual runs, [manual-acceptance.md](manual-acceptance.md)), add `--record <dir>` to the hook's command or `args`: the guard then also saves each payload, unchanged, as `<dir>/<client>-<event>-<tool>-<time>-<pid>.json`. Recording never changes the decision. The payload holds the command or the file's new content, so keep the directory private and remove the flag afterwards.

## Tests

`test/assistants/guard.test.ts` holds the named cases: 186 blocked and 60 allowed, across the three clients, each decided twice, by `evaluate()` in the test process and by `guard.mjs` as the hook process with the payload on stdin. The payloads follow each client's documented shape (`test/fixtures/hooks/`, synthetic, read 2026-11-04). The git cases run against local repositories the test creates.
