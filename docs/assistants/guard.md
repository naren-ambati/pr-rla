# The guard

[`integrations/claude-code/hooks/guard.mjs`](../../integrations/claude-code/hooks/guard.mjs) is a pre-tool-use hook. Before each tool call it reads the client's hook payload on stdin and blocks the call when the assistant would act as the reviewer: write or sign a verdict, apply a verdict label, give consent, or change an audit record. It is one file with no dependencies, so Codex and Cursor projects copy it as is.

It is the third tier of the verdict-authority guarantee: a speed bump, not a boundary ([README](README.md#what-holds-and-what-does-not)). An assistant that wants to get round it can (a program the guard does not read, a tool the client does not hook). What makes a verdict count is the ledger and `verify`: registered reviewers, account provenance, and a token the assistant does not have.

## What it blocks

| From the assistant | Blocked |
|---|---|
| **Verdicts** | `pr-rla record` in any form, including `--sign`; `ssh-keygen -Y sign` in the `pr-rla-verdict@v1` namespace, or with a namespace it cannot read |
| **pr-rla's other writes** | `register`, `freeze`, `sample` and `init` in every form (`--dry-run`, and `freeze --estimate` and `--resume`, too: the MCP tool `freeze_preview` is the read-only dry run, and its `estimate` the read-only estimate); `checkpoint --push` (and `--remote`/`--branch`); `--submit` |
| **Consent** | `pr-rla plugin approve`, `add` and `lock`; `--accept-lock-grants`; setting `PR_RLA_ACCEPT_LOCK_GRANTS` or `PR_RLA_APPROVALS_FILE`, or `HOME`/`XDG_CONFIG_HOME` for a pr-rla command (also through `node --env-file`); writing either into a shell startup file (`~/.zshenv`, `~/.zshrc`, `~/.bashrc`, `~/.profile`, `.envrc`, `.env`, …), from which every later shell would carry it; linking or moving the approvals file's directory; any pr-rla command when the session itself was started with `PR_RLA_ACCEPT_LOCK_GRANTS` set |
| **Verdict labels** | `gh issue`/`gh pr` `edit --add-label`/`--remove-label` and `create --label` (flags before the verb too: `gh issue -R o/r edit …`); `gh label edit`/`delete`, and renaming a label to a verdict label; a `gh alias` (`set`, `set --shell`, `import`) that does one of these; `glab issue`/`mr` `update --label`/`--unlabel`; a GitLab `/label`, `/unlabel` or `/relabel` quick action naming a verdict label in a note (`glab issue note`, `glab mr note`, a notes request, an MCP comment tool); `gh issue delete` in an audit repo; `gh api`, `glab api`, `curl`, `wget` and HTTPie requests other than GET, HEAD or OPTIONS that carry or name a verdict label (in the URL, its query, `--url-query`, a URL glob, or the body, JSON `\u` escapes decoded), or that send a GraphQL label mutation (GitHub's or GitLab's), or a body the guard cannot read to a label, issue, merge-request or comment endpoint; another MCP server's tool whose input carries a verdict label |
| **Audit records** | Write, Edit, MultiEdit, NotebookEdit, Codex's `apply_patch` (as a tool, or run as a shell command), Cursor's Write, Delete and `edit_file`, another MCP server's write, move, shell, code or HTTP tool, shell redirects, and `tee`, `cp` (with `-R dir/.`, and `-l` links), `mv`, `install`, `ln` and `link`, `rsync`, `rm`, `truncate`, `touch`, `dd`, `sed -i` and sed's `w` command, `perl -i`, `awk`'s `print >` and `system()`, `sort -o`, `uniq`'s output file, `yq -i`, `curl -o`, `wget -O`, `tar -c`'s archive, `git archive -o`, `python -m json.tool`, `script`'s transcript, `patch` and `git apply` (from a file or stdin), `find -delete`, `-exec` and `xargs`, `tar -x` and `unzip` (by listing the archive), Makefile recipes (`make clean`, `make --eval`), npm scripts set by `npm pkg set` and lifecycle scripts run by `npm install`, PowerShell's `Set-Content` and its kin, code in another language that would write one (`node -e`, `python3 -c`, a heredoc on stdin, `bun -e`, `deno eval`, `perl`'s three-argument `open`, pathlib, `os.system`, `execSync`, …), and, in an audit repo, any program the guard does not know to only read (`gzip`, `ditto`, `ed`, `prettier --write`, …) handed a record or a directory that holds one. The records: `registration.json`, `manifest-commitment.json`, `*.manifest.json`, `draws.json`, `verdicts.jsonl` (or the ledger file `.pr-rla.yml` names), `ledger-index.json`, `ledger-publication.json`, `ledger-checkpoints.jsonl`, anything under `ledger-history/`, the audit repo's `.git/` (its hooks and config run commands as you), `pr-rla.lock.json` and `.pr-rla.yml`, and the approvals file (`$PR_RLA_APPROVALS_FILE`, `$XDG_CONFIG_HOME/pr-rla/approvals.json` or `~/.config/pr-rla/approvals.json`); also a directory that holds any of them |
| **The audit's history** | `git commit` that would commit `verdicts.jsonl` (staged, or by `-a`, a pathspec, `--pathspec-from-file` or an earlier `git add` in the same command), or amend a commit that holds it; the same for `git --git-dir`/`--work-tree`, `-C` and `GIT_DIR`/`GIT_WORK_TREE` pointing at an audit repo (a computed one is blocked); in an audit repo: `git push` with `--force`, `--force-with-lease`, `--mirror`, `--delete` or a `+`/`:` refspec, or forced by configuration (`-c remote.origin.push=+…`, `git config remote.*.push '+…'`); `git reset` (`--hard`, `--merge`, `--keep`, and `--soft`/`--mixed` that drop commits) that would discard a record's change or drop commits that change records; `git checkout`/`switch`/`restore` (also from another revision: `checkout <rev> -- audit/`, `restore --source=`, `checkout -B`), `rm`, `mv`, `stash` (and `stash pop`), `clean -f`, `apply`, `am`, `revert` and `cherry-pick` that would change or discard a record; `git update-ref`; `git rebase` with an option that drops or rewrites commits (`-i`, `--onto`, `--root`, `--exec`, `--autosquash`, `--rebase-merges`, `--empty=drop`), `filter-branch`, `filter-repo` and `replace`; `git config core.hooksPath` and `include.path`; the other keys git runs as a command later (`core.pager`, `core.editor`, `sequence.editor`, `credential.helper`, `diff.external`, aliases, …), from `git config`, `-c`, `--config-env` or `GIT_CONFIG_COUNT`, are read for what they would run, and blocked when their value is computed |
| **The signing key** | reading the audit's signing key (`.pr-rla/*.pem`, or the `signing_key` `.pr-rla.yml` names) with Read, Grep (the directory too), Cursor's file reads, or any shell command: `cat`, `grep -r` of its directory, `find -exec`, `tar` of the directory, `curl -d @key`, `openssl -in=key`, `git show REV:key`, `$(ls .pr-rla/*.pem)`, in any case (`.PR-RLA/` is the same directory on macOS) |

Records are recognized by name inside an **audit repo**, a directory tree with a `.pr-rla.yml` above it, so a `registration.json` in another project is left alone. `pr-rla.lock.json`, `.pr-rla.yml` and the approvals file are protected anywhere. The audit repo's `.git/` is matched in any case, since macOS and Windows treat `.GIT/` as the same directory. Verdict labels are the defaults (`pr-rla:pass`, `pr-rla:fail`, `pr-rla-pass`, `pr-rla-fail`, `pr-rla::pass`, `pr-rla::fail`, in any case), anything shaped like them, and the labels the audit's `ledger-index.json` and `.pr-rla.yml` name (quoted labels with spaces included).

A label request that neither carries nor names a verdict label passes: adding `bug`, creating `enhancement`, or replacing an issue's labels with ones that are not verdicts. Replacing or clearing an issue's labels can drop a verdict label without naming it; that passes, because `pr-rla verify` reports a verdict label that disappeared, while an added one is what the ledger would count.

Unknown pr-rla subcommands are blocked too: only `status` (with `--checkpoint`), `verify`, `draw-context`, `simulate`, `plugin check`, plain `checkpoint` (which appends pr-rla's own local checkpoint line and pushes nothing) and `--help`/`--version` pass. A pr-rla command with a computed subcommand, or a computed argument where a flag could go, is blocked: the guard cannot tell what it would do. Every subcommand and every option `src/cli.ts` defines is classified on its command, and a test fails on one that is not (`test/assistants/guard.test.ts`): on the commands that pass, `verify --verbose`, `status --checkpoint` and the read and format options pass, while `--accept-lock-grants` (before any command) and `checkpoint --push`, `--remote` and `--branch` are blocked.

## What passes

Reading anything other than the signing key (`cat`, `jq`, `sort`, `git log`, the Read tool, pr-rla's own MCP tools, code that reads a record and writes a report elsewhere), pr-rla's read-only commands, `gh issue edit` and label requests with other labels, GET requests to label endpoints, a GitLab comment that mentions a verdict label without a quick action, `ssh-keygen -Y verify` in pr-rla's namespace and `-Y sign` in others, `echo`ing the record command for the person to run, staging `verdicts.jsonl` (committing it is blocked), `git commit -- notes.md` and `git add notes.md && git commit` with a verdict still uncommitted, `git stash push -- notes.md`, a plain `git rebase origin/main`, `git config core.editor`, plain `git push`, `make build` (only the target's own recipe is read), `sed -i '' -e …` (macOS's backup suffix), `mv` of another file into the window's directory, `tar` of the audit directory to `/tmp`, `export -n`, `declare -p` and `env -u` of the consent variables, arithmetic (`$(( n * 2 ))`, `(( 4 > 3 ))`), quoted heredocs, an alias that names itself (`alias ls='ls -G'`), and every command in another project. `test/assistants/guard.test.ts` names 91 such cases.

## How it reads a command

It parses the command line as a POSIX shell would, far enough to see what runs and what is written:

- quoting (`'…'`, `"…"`, `$'…'` with escapes, backslashes), `VAR=value` prefixes, variables it can resolve (earlier assignments, arrays, `printf -v`, `IFS` splitting, empty variables, and `HOME`, `XDG_CONFIG_HOME`, `PR_RLA_APPROVALS_FILE`, `TMPDIR`, `PWD` from the session), `~`, brace expansion (lists and `{a..z}` sequences) and globs (expanded against the disk, zsh's `=cmd` and glob qualifiers too);
- `;`, `&&`, `||`, pipelines, subshells, `{ … }` groups, `if`/`while`/`case`/`for`, functions, aliases (never expanded inside their own expansion, as in bash), `$(…)`, backticks, `<(…)` and zsh's `=(…)`, and the substitutions inside arithmetic (`(( ))`, `$(( ))`, `$[ ]`) and unquoted heredoc bodies, which bash and zsh run;
- heredocs, here-strings, redirects, and a `cd` (also `cd -`, `pushd` and `popd`) earlier in the same line;
- commands a variable or builtin runs later: `trap`, `PROMPT_COMMAND`, `BASH_ENV`, `ENV`, `GIT_EXTERNAL_DIFF` and git's other command variables, and a script an in-line `PATH` puts first;
- wrappers: `env` (with `-S`, `-C`, `-u`), `command`, `exec`, `nohup`, `time`, `nice`, `timeout` and `gtimeout`, `sudo`, `doas`, `su -c`, `stdbuf`, `flock`, `xargs` (its input read where the guard can see it), `find -exec`, `watch`, `ssh`, `tmux`, `script`, `arch`, `setsid`, `nocorrect`, `direnv exec`, `parallel`, `at`, `npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx`, and any other program handed `pr-rla` or a command line as an argument;
- shells (`sh -c`, `bash -lc`, a script file, a script on stdin or from earlier in the pipeline, `pwsh -Command`), `eval`, `source`, executable scripts (read from disk, or from what the same line wrote), npm/pnpm/yarn/bun scripts from `package.json`, Makefile/justfile/Taskfile recipes, git aliases and pagers (`git -c core.pager=…`, `GIT_PAGER=…`);
- code in other languages (`node -e`/`-pe`, `python3 -c`/`-uc`, `perl -e`, `ruby -e`, `bun -e`, `deno eval`, `osascript -e`, programs on stdin or in a heredoc, and script files), by pattern: a pr-rla write command or pr-rla's write functions (`import('pr-rla')` too), the consent flags, signing in pr-rla's namespace, a verdict label sent anywhere, a shell command it runs, or a write call naming a record (the last only for inline code, or for a script file inside an audit repo).

It stops where reading would not end, and blocks what it did not finish: a command over 512 KiB, code over 1 MiB, commands nested more than 8 deep, and any decision that takes more than 8 seconds. Crafted inputs (a brace expansion of 2^26 words, 2000 nested `$(`, 5000 pending heredocs, 20000 repeated tokens) are decided in well under a second. In an audit repo it also blocks a script it cannot read (missing when the line is checked, unreadable, or over 1 MiB) and a shell reading a command from a pipe it cannot read (`base64 -d | sh`).

### What it cannot see

- A program that writes a record or applies a label without naming it where the guard looks: a compiled binary, a script that builds the path or the label at run time, a download it runs outside an audit repo, a Docker container, a program in another language that reads its target from a file.
- Outside an audit repo, a script it cannot read (a large bundle is ordinary there) and a command decoded and piped into a shell (`base64 -d | sh`), when what they do is aimed at an audit repo by path.
- Let through by decision: `git pull --rebase` and a plain `git rebase` (they replay local commits rather than drop them), and `gh label create --force` and `gh label clone --force` (they change a label's colour and description, not its name).
- Not read: `git worktree remove --force`, which can discard an uncommitted verdict in another worktree of the audit repo.
- Grep over a whole audit repo passes: the guard cannot tell from the call whether the search reaches `.pr-rla/` (ripgrep skips hidden directories unless told otherwise; whether Claude Code's Grep does was not checked). Grep aimed at that directory or at a key file is blocked.
- `((…))` is read as bash and zsh read it, as arithmetic. dash, which has no `((`, would run its contents as nested subshells; the clients run commands through the user's shell, normally bash or zsh.
- Commands made of text it cannot resolve: `eval` or `sh -c` of a variable or a command's output whose source does not show the pr-rla command (it blocks what it can see of them: a computed program name with pr-rla-like arguments, a computed pr-rla subcommand).
- Tools the client does not hook (Claude Code's `Glob`, a client's hosted web tools), files mentioned with `@` in a prompt (inserted without a tool call), and anything a client runs before its hooks load.
- A label applied in the tracker's web UI by whoever has the browser, which is where verdicts belong.

On Windows (untested), PowerShell commands are read with the same parser: plain commands and the file cmdlets are covered, PowerShell's own syntax is not.

## Clients and answers

| Client | Hooks | A block | An allowed call |
|---|---|---|---|
| Claude Code | `PreToolUse` on `Bash`, `PowerShell`, `Monitor` (it runs a shell command in the background), `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Read`, `Grep`, `mcp__.*` | exit 2, the reason on stderr | exit 0, no output (the normal permission flow) |
| Codex | `PreToolUse` on `Bash`, `apply_patch`, `mcp__*` | exit 2, the reason on stderr | exit 0, no output |
| Cursor | `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse` (`Write|Delete`) | exit 2, `{"permission":"deny",…}` on stdout | exit 0, `{"permission":"allow"}` |

`--client` names the payload's format; without it, and whenever the payload carries Cursor's `cursor_version` or Codex's `turn_id`, the guard reads the payload as that client's. Input it cannot read (not JSON, not an object) is blocked, and so is a crash of the guard itself. Exit 2 is the exit code `contracts.md` §7 reserves for an assistant hook block.

## Checking it by hand

`--check-shell '<command>' --cwd <dir>` prints what the guard decides for a shell command run in `<dir>`, without a client: `blocked:` and the reasons (exit 2), or `allowed` (exit 0). In a copy of the recorded audit (`test/fixtures/audits/gh-aw-q3-recorded`, an audit repo, so its records are protected), run 2026-11-04 (`npm run docs:outputs` regenerates it): <!-- docs-output: guard-check -->

```output
$ node integrations/claude-code/hooks/guard.mjs --check-shell 'pr-rla record 5 pass' --cwd .
blocked:
  - pr-rla record writes a verdict, and a verdict is the reviewer's: they run "pr-rla record …" themselves (a person's own command, in their own terminal), or apply the label in the tracker
(exit 2)

$ node integrations/claude-code/hooks/guard.mjs --check-shell 'echo pass >> audit/2026-q3/verdicts.jsonl' --cwd .
blocked:
  - a redirect writes audit/2026-q3/verdicts.jsonl, an audit record
(exit 2)

$ node integrations/claude-code/hooks/guard.mjs --check-shell 'pr-rla status --offline' --cwd .
allowed
(exit 0)
```

To see the payloads a client really sends (the founder's manual runs, [manual-acceptance.md](manual-acceptance.md)), add `--record <dir>` to the hook's command or `args`: the guard then also saves each payload, unchanged, as `<dir>/<client>-<event>-<tool>-<time>-<pid>.json`. Recording never changes the decision. The payload holds the command or the file's new content, so keep the directory private and remove the flag afterwards.

## Tests

`test/assistants/guard.test.ts` holds the named cases: 340 blocked and 91 allowed, across the three clients, each decided twice, by `evaluate()` in the test process and by `guard.mjs` as the hook process with the payload on stdin. The payloads follow each client's documented shape (`test/fixtures/hooks/`, synthetic, read 2026-11-04). The git cases run against local repositories the test creates. About 150 of the cases come from an adversarial review of the guard (2026-11-04): each blocked case is a way round the guard that the review found and that now fails, each allowed case an ordinary command the review found blocked. Further tests time the crafted inputs above and check the size limits.
