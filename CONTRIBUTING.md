# Contributing

pr-rla is pre-release: it has no public repository yet, and nothing is published. Licence: decided by the founder before release.

## Build and verify

Node 22.15 or later (the project is tested on 22.23.2, 24.20.0 and 26.8.2 on macOS; see [`docs/compatibility.md`](docs/compatibility.md)). From a clean checkout:

```sh
npm ci && npm run build && npm run typecheck && npm test
npm --prefix packages/pr-rla-mcp ci && npm --prefix packages/pr-rla-mcp test
npm --prefix examples/providers/gitea ci && npm --prefix examples/providers/gitea test
npm --prefix examples/ledgers/jira ci && npm --prefix examples/ledgers/jira test
npm --prefix integrations/github-action ci
```

- `npm run build` starts from an empty `dist/` (`scripts/clean-dist.mjs`): tsc never removes the output of a source you deleted or moved, and `npm pack` would ship it. `npm pack` runs the build first (`prepack`).
- `npm run typecheck` checks `src/` and `test/`, and holds `src/sdk` and the plugin host's child to erasable TypeScript (`tsconfig.sdk.json`): the plugin host runs them under Node's type stripping, which refuses parameter properties, enums and namespaces.
- `npm test` makes no network call. A test that opens a socket to anything but 127.0.0.1 fails (`test/setup/network-deny.ts`), and every test file gets its own approvals file, so no test touches your `~/.config/pr-rla`.
- The CI tests and the doc check run `dist/cli.js`, so build before you test.

## Rules for changes

- **No write to anything outside this machine**, in code, tests or scripts: no push, no publish, no issue, label or comment on a real tracker, no Rekor entry, no scratch repository. Write paths are tested on local bare git repositories and mock servers on 127.0.0.1. Live work is read-only (public GETs) or hash-only (a timestamp authority receives a SHA-256 digest and a nonce).
- **Every fixture says where it came from**: `recorded` (read-only from a public source, with its date and URL) or `synthetic`. Recorders scrub e-mail addresses to `user-<hash>@example.invalid` and never record a token.
- **The core stays provider-free**: `src/core` imports only `src/sdk`, other core modules and the pure parts of `src/beacon` and `src/translog`; `test/registry.test.ts` fails otherwise. `pr-rla/api/read` reaches no write module (`test/api-read-boundary.test.ts`).
- **Every command is a formatter over `src/api`.** A new command puts its logic in `src/api/read/` or `src/api/write/` (a write function refuses a read-only context first) and its output in `src/commands/`. A new subcommand or option must also be classified by the assistant guard (`test/assistants/guard.test.ts` fails until it is).
- **Optional additions only** within `providerApiVersion` 1 and `ledgerApiVersion` 1; a breaking change moves the version, with two releases that load both.
- **Exit codes keep their meaning** ([`docs/compatibility.md`](docs/compatibility.md)).
- **No claim of hardware-verified presence** in any doc, source string or output: `test/presence-wording.test.ts` reads them all.

## Docs

- Every fenced block in the docs has a language. A block that shows what a command printed is an `output` block: the line before it says when it was run (`run YYYY-MM-DD` or `recorded YYYY-MM-DD`), and it is real output, never written by hand.
- Output that pr-rla prints offline on a fixture is generated: `npm run docs:outputs` runs each command in `scripts/docs-outputs.mjs` on a copy of its fixture and rewrites the block and its date. `npm run docs:check` (and `test/docs.test.ts` in `npm test`) runs them again and fails when a block no longer matches. Output from a live run (a public repository, a timestamp authority) is recorded once, with its date, and not re-run.
- `npm run docs:check` also checks every relative link and anchor (offline), that every `pr-rla` command and option a doc names exists, and that the exit-code table agrees with `contracts.md` §7 and `src/cli/exit-codes.ts`.
- Write what the code does now. Where it differs from the design in `docs/design/`, the code and [`BUILD-NOTES.md`](BUILD-NOTES.md) win, and the doc says so.

## Before a release

[`docs/release-checklist.md`](docs/release-checklist.md): ordered, with an owner per step. The secret grep over both tarballs is `npm run secret-grep` (build both packages first).
