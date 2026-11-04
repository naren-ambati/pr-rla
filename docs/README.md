# pr-rla documentation

Every document, by what you are doing. The project's front page is the [README](../README.md); what changed in each release is the [changelog](../CHANGELOG.md).

## Understand it

- [Concepts](concepts.md): the population, the stratum, the steps of an audit, the seven checks, the certificate, verdicts and provenance.
- [The statistics](statistics.md): the sequential test, claim D, the stopping points, why a population below 150 means reviewing everything, and how the draws are derived.
- [Trusted time](trusted-time.md): timestamp tokens from k independent authorities, what a token must satisfy, and how to check one with OpenSSL.
- [Security model](security-model.md): every threat (T1–T18), its mitigation and its stated limit.
- [Compatibility](compatibility.md): Node versions, platforms, what is verified live and what only on fixtures, the exit codes, the versioning rules.

## Run an audit

- [Org-pooled audits](org-pooled-audits.md): one registration and certificate for an org, group or workspace.
- Each provider's page: [GitHub](providers/github.md), [GitLab](providers/gitlab.md), [Bitbucket Cloud](providers/bitbucket-cloud.md), [Bitbucket Data Center](providers/bitbucket-data-center.md).
- [The prospective gh-aw audit](gh-aw-prospective.md): the registration hand-off, for the founder.

## In CI

- [CI integrations](ci/README.md): what all three do, the scopes, the rate limits, the end-to-end matrix.
- [GitHub Actions](ci/github.md), [GitLab CI/CD](ci/gitlab.md), [Bitbucket Pipelines](ci/bitbucket.md).

## With an assistant

- [Assistants](assistants/README.md): the read-only MCP server, the `review-draw` skill and the guard, and the read-only token.
- [Claude Code](assistants/claude-code.md), [Codex](assistants/codex.md), [Cursor](assistants/cursor.md).
- [The guard](assistants/guard.md): what it blocks and what it cannot see.
- [Manual acceptance](assistants/manual-acceptance.md): the founder's checks in the three clients.
- [`pr-rla-mcp`](../packages/pr-rla-mcp/README.md): the MCP server's tools, jobs and errors.

## Extend it

- [Writing a provider](writing-a-provider.md), with the Gitea plugin as the worked example.
- [Writing a ledger](writing-a-ledger.md), with the Jira example.

## The project

- [Contributing](../CONTRIBUTING.md): building, testing, and the rules for changes and docs.
- [Security policy](../SECURITY.md): how to report a vulnerability (the contact is still a placeholder).
- [Release checklist](release-checklist.md): the ordered steps to the first public release, each with its owner.
- [BUILD-NOTES](../BUILD-NOTES.md): what each round built, verified, settled and left open, with the commands and their output.
- [The design record](design/spec.md) and the [phase 3–4 design](design/phase-3-4/README.md): kept as written. Where the code differs from the design, the code and BUILD-NOTES win, and the docs say so.

## The commands

`pr-rla --help`, run 2026-11-04 (`npm run docs:outputs` regenerates it; each command's own `--help` lists its options): <!-- docs-output: help -->

```output
$ pr-rla --help
Usage: pr-rla [options] [command]

Risk-limiting audits for code changes that landed with no recorded human review

Options:
  -V, --version                      output the version number
  -C, --dir <path>                   audit repo directory (holds .pr-rla.yml)
  -c, --config <path>                config file (default <dir>/.pr-rla.yml)
  --from-file <changes.json>         use the json-file provider with this export
                                     instead of the configured provider
  --plugins <builtin-only>           builtin-only: refuse every external
                                     provider and ledger (as
                                     PR_RLA_PLUGINS=builtin-only does)
  --accept-lock-grants               take the credential grants and trust in
                                     this repo's pr-rla.lock.json and
                                     .pr-rla.yml without your approval, for this
                                     run only: only for a repo you control (as
                                     PR_RLA_ACCEPT_LOCK_GRANTS=1 does)
  -h, --help                         display help for command

Commands:
  init [options]                     write .pr-rla.yml, review-protocol.md and
                                     audit/
  register [options]                 sign the selector, window, parameters and
                                     protocol hash (before the population is
                                     frozen)
  freeze [options]                   list every change that landed in the
                                     window, apply the registered selector,
                                     write the manifest
  sample [options]                   fetch and BLS-verify seed round R, compute
                                     the draws, write audit/<window>/draws.json
  draw-context [options] <draw>      what a reviewer reads for an issued draw:
                                     its diff (generated files dropped),
                                     description, CI results, protocol checklist
                                     and verdict state
  record [options] <draw> <verdict>  append a pass/fail verdict for a draw to
                                     the ledger (git-file: commit it afterwards)
  status [options]                   longest fully labelled prefix, LLR vs
                                     target, and CERTIFIED / n more needed /
                                     ESCALATE
  checkpoint [options]               hash the ledger's verdict-event history,
                                     time-stamp it, and append it to
                                     audit/<window>/ledger-checkpoints.jsonl
  verify [options]                   third-party check of the seven audit
                                     properties
  plugin                             lock, re-lock and check external providers
                                     and ledgers (pr-rla.lock.json)
  simulate [options]                 run the scoring code against an oracle
                                     population
  help [command]                     display help for command
(exit 0)
```
