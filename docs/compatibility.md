# Compatibility

What pr-rla 0.1.0 runs on, what has been verified against live services and what only on fixtures and mock servers, the exit codes, and the versioning rules. "Live" always means read-only: public GET requests, or a timestamp request that sends a SHA-256 digest and a nonce. Every write path (issues, labels, checkpoints pushed, CI jobs) is tested on mock servers and local bare git repositories only, by design (D8). Each row says when it was checked; [`BUILD-NOTES.md`](../BUILD-NOTES.md) has the commands and their output.

## Runtime

| Node.js | Status |
|---|---|
| 22.15 or later | **Required** (`engines`: `>=22.15`, both packages). The plugin host needs `module.registerHooks`; on 22.13 and 22.14 an isolated plugin refuses to load with "needs Node 22.15 or later" (checked on 22.14.0 and 22.15.0, 2026-11-04) |
| 22.23.2 | **Tested**: every verification of every bolt, including this release's three fresh-clone runs |
| 24.20.0 | **Tested**: the root suite (BUILD-NOTES, "Bolt 11 (U10)", for the run on this release) |
| 26.8.2 | **Tested**: the root suite. It stands in for "25 or later": on 25 and later an isolated plugin has no network at all (no `--allow-net`); Node 25.x itself was not installed |

The CI integrations run Node 24 (the Action's `actions/setup-node` at `node-version: 24`; the GitLab and Bitbucket images `node:24-alpine` and `node:24`, pinned by digest).

## Platforms

| Platform | Status |
|---|---|
| macOS (Darwin 25.6.0, arm64) | **Tested**: everything in this repository ran here |
| Linux | **Untested.** It is the CI templates' target (Linux runners and containers), and nothing in the code is macOS-specific that a test knows of, but no suite has run on Linux. The plugin host's permission model, the OpenSSH and OpenSSL oracle tests, and `/proc/<ppid>/environ` being outside the child's read scope are measured on macOS only |
| Windows | **Untested**, and not supported until it is. Known: pr-rla runs `git` and `ssh-keygen` by the absolute path it finds on PATH's absolute entries; a checkout with `core.autocrlf=true` FAILs check 7 (the working tree's CRLF ledger differs from its committed history: verify with `core.autocrlf=false`); the assistant guard reads PowerShell with its POSIX parser |

This is short of NFR19, which asks for macOS **and** Linux tested: a Linux run is a release step ([`release-checklist.md`](release-checklist.md), step 10).

## Tools pr-rla runs

| Tool | Needed for | Tested with |
|---|---|---|
| git | the `git-file` ledger's history walk, `checkpoint --push` | 2.55.0. `GIT_NO_LAZY_FETCH` needs 2.44 or later; an older git still refuses a partial clone, by its promisor check, before reading anything |
| ssh-keygen (OpenSSH) | `record --sign`; the oracle tests | OpenSSH 10.3p1 (macOS, LibreSSL 3.3.6) |
| openssl | the oracle tests only (skipped when `openssl ts` is missing) | OpenSSL 3.6.4 |

## Source-control systems

| Provider | Population (`listChanges`) | Draw context (`describeChange`) | Org pools (`listRepos`, push log, visibility proof) |
|---|---|---|---|
| `github` (github.com) | **live**: github/gh-aw Q3 2026, 3,944 changes (2026-11-03); recorded and synthetic fixtures | **live** once (draw #13, 2026-11-04); recorded for the 36 issued gh-aw draws (2026-11-04) | `listRepos` **live** on the `navikt` org (223-repo subset, dry run and estimate, 2026-11-04); push log **live** on github/gh-aw (2026-11-04); the visibility proof (org owner, installation, `total_private_repos`) on fakes only |
| `github` (Enterprise Server) | fake server only | fake server only | fake server only |
| `gitlab` (gitlab.com) | **live**: gitlab-org/cli October 2026, anonymous (2026-11-03); recorded | recorded anonymously: gitlab-org/cli !4191 (2026-11-04) | `listRepos` on hand-made responses only; push log **live** on gitlab-org/cli (2026-11-04); no visibility proof (a rule with private repos is INCOMPLETE) |
| `gitlab` (self-managed) | recorded anonymously: gitlab.freedesktop.org xorg/xserver (2026-11-04); with a token, unverified | unverified | unverified |
| `bitbucket-cloud` | **live**: atlassian/bamboo-specs, anonymous (2026-11-03); recorded | recorded anonymously: bamboo-specs #745 (2026-11-04) | `listRepos` on hand-made responses only; no push log (a moved head is INCOMPLETE); no visibility proof |
| `bitbucket-data-center` | **unverified**: a fake server built from Atlassian's documented shapes | synthetic only | synthetic only |
| `json-file` | n/a (an export) | the export's `descriptions` | n/a |
| `gitea` (the example plugin) | **live**: Codeberg forgejo/docs, anonymous (2026-11-03); recorded | not implemented (the manifest's fields are shown) | not implemented |

Private repositories and token scopes have not been exercised on any SCM: every live run here read public data. The CI guides list the scopes per SCM, each marked unverified ([`ci/README.md`](ci/README.md#scopes)).

## Ledgers

| Ledger | Reads | Writes |
|---|---|---|
| `git-file` | local git, real git 2.55.0 | local appends and commits; per-verdict signatures with real `ssh-keygen -Y sign` and software keys only (no hardware key, D7) |
| `github-issues` | recorded public timelines (six GitHub issues, 2026-11-04); GitHub Enterprise Server on a mock | mock servers only (issues, labels, comments) |
| `gitlab-issues` | synthetic, from the documented `resource_label_events` shape (it needs a token even on public projects: unverified); recorded label notes as evidence | mock servers only |
| Jira (the example plugin) | recorded from hibernate.atlassian.net, Jira Cloud, anonymously (2026-11-04) | mock servers only; Jira Data Center not supported |

## Time, beacon and log

| Service | Status |
|---|---|
| The eight bundled timestamp authorities | **live**, hash only: one request each, twice, all eight answering (2026-11-03); `register` ran live on a demo audit. A `freeze` and a checkpoint with real tokens have run on mock authorities only |
| drand quicknet | **live**: chain info and a round read (phase 1); recorded rounds verify their BLS signatures in the suite |
| Rekor (transparency log) | **mock logs only**, v1 and v2. No entry has ever been written to a real log, production or staging (D3); the pinned production keys come from Sigstore's TUF root |

## Integrations

| Integration | Status |
|---|---|
| GitHub Action, GitLab component and snippet, Bitbucket step | schema-checked against the published schemas (vendored, dated) and run on fixtures and mock servers; never on a real runner. The GitLab component is not in the CI/CD Catalog |
| Claude Code plugin | `claude plugin validate` passes (Claude Code 2.1.267, 2026-11-04); not yet run in a session |
| Codex, Cursor | configuration from their documentation (read 2026-11-04); not run |
| The three manual assistant runs (FR3.6) | **pending**: the founder's ([`assistants/manual-acceptance.md`](assistants/manual-acceptance.md)) |

## Exit codes

Every command's exit status is a stable contract ([`contracts.md` §7](design/phase-3-4/contracts.md); `src/cli/exit-codes.ts`). Existing codes never change meaning; codes 0–4 are phase 1–2's, 5 and 6 were added in this round.

| Code | Meaning | Commands |
|---|---|---|
| 0 | Success | all |
| 1 | A `verify` check FAILed; a plugin refused (not locked, a lock mismatch, builtin-only, not approved); the clock skewed over 10 minutes; checkpoint preconditions not met; not registered; a usage error | `verify`, `register`, `freeze`, `checkpoint`, `status` (not registered, or a check `verify` would FAIL withholds the certificate), any command loading a plugin |
| 2 | ESCALATE; seed round R not yet published; an assistant hook block | `status`, `sample`, the assistant guard |
| 3 | Population below the registered minimum (review all instead) | `status`, `sample` |
| 4 | Stopped before finishing; running the printed command again finishes it (a rate budget exhausted; a checkpoint push rejected 3 times or blocked by another conflict) | `freeze`, `checkpoint --push` |
| 5 | A record written without enough timestamps (`n of k`, including `0 of k`) | `register`, `freeze`, `checkpoint` |
| 6 | INCOMPLETE: nothing failed, but something was not established (a time k operators do not prove, the population not rebuilt or not shown complete, a read refused for want of a credential) or a check was skipped; for `status`, the test reached its target but the certificate is withheld for such a reason, or the verdicts could not be read | `verify`, `status` |

With no timestamp authority configured at all, `register` and `freeze` exit 0 with `TIMESTAMP NOT TAMPER-PROOF`. With `--json`, an error prints `{ "error": { "code", "message", "host"?, "next"? } }` on stdout. The CI integrations map 2, 3, 5 and 6 to a failed job by default and 1 and 4 always ([`ci/README.md`](ci/README.md)).

## Versioning

| Thing | Version | Rule |
|---|---|---|
| `pr-rla`, `pr-rla-mcp` | semver, released together at one version | The first public release is 0.1.0. Below 1.0, a change to the CLI, an output or a record is a minor version and is listed in the [changelog](../CHANGELOG.md); adding a field is compatible. `pr-rla-mcp` pins its `pr-rla` exactly |
| `providerApiVersion`, `ledgerApiVersion` | 1 | Optional additions only. A required method or a changed meaning moves to 2, with two releases in which pr-rla loads both |
| `pr-rla/http` (`HTTP_HELPER_VERSION`) | 1 | Versioned on its own, independent of the API versions |
| The plugin host protocol | `pr-rla/ipc/v2` | The parent refuses a child that reports another protocol; the two always ship together |
| The MCP tools | `pr-rla-mcp`'s version, and the tools' output schemas | A renamed tool or a removed field is a minor version below 1.0 |
| The trust bundle | date-stamped, `2026-11` | Anchors and intermediates are only added; old tokens keep verifying after a rotation |
| Record schemas | `pr-rla/<kind>/vN` | `verify` reads every schema ever written; writers emit the newest |

The record schemas in this release: `pr-rla/registration/v1` and `/v2`, `pr-rla/manifest/v1` and `/v2`, `pr-rla/manifest-commitment/v1` and `pr-rla/commitment/v2`, `pr-rla/draws/v1`, `pr-rla/verdict/v1` (a `git-file` line; its signed bytes are `pr-rla-verdict/v2`, and `v1` signatures are refused), `pr-rla/ledger-index/v1`, `pr-rla/ledger-checkpoint/v1`, `pr-rla/ledger-history/v1`, `pr-rla/changes/v1` (the json-file export), `pr-rla/lock/v1`, `pr-rla/approvals/v1`, `pr-rla/tsa-trust-bundle/v1`, `pr-rla/freeze-run/v2` and `pr-rla/freeze-repo/v2` (a pooled freeze's checkpoints, never committed), and `pr-rla/draw-context/v1` (`draw-context --json`).

<!-- pending P1: the P1 round adds the ledger publication record (ledger-publication.json); add its schema to this list once that round merges. -->
