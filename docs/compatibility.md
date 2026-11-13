# Compatibility

What pr-rla 0.1.0 runs on, what has been verified against live services and what only on fixtures and mock servers, the exit codes, and the versioning rules. "Live" always means read-only: public GET requests, or a timestamp request that sends a SHA-256 digest and a nonce. Every write path (issues, labels, checkpoints pushed, CI jobs) is tested on mock servers and local bare git repositories, by design (D8); the `github-issues` writes and the GitHub Action have also run live, on repositories the owner created for the [sandbox showcase](../examples/sandbox-showcase/README.md) (2026-11-10 to 2026-11-13; public then, private since). Each row says when it was checked; [`BUILD-NOTES.md`](../BUILD-NOTES.md) has the commands and their output.

## Runtime

| Node.js | Status |
|---|---|
| 22.15 or later | **Required** (`engines`: `>=22.15`, both packages). The plugin host needs `module.registerHooks`; on 22.13 and 22.14 an isolated plugin refuses to load with "needs Node 22.15 or later" (checked on 22.14.0 and 22.15.0, 2026-11-04) |
| 22.23.2 | **Tested**: every verification of every bolt, and the three fresh-clone runs of this branch (BUILD-NOTES, "Bolt 11 (U10)") |
| 24.20.0 | **Tested**: the root suite of this branch, 95 files, 2,515 tests passed (2026-11-04; BUILD-NOTES, "Bolt 11 (U10)"), as in earlier rounds |
| 26.8.2 | **Tested**: the root suite of this branch, 95 files, 2,506 tests passed (2026-11-04; on 25 or later one block of the hostile-plugin tests is not added). It stands in for "25 or later": on 25 and later an isolated plugin has no network at all (no `--allow-net`); Node 25.x itself was not installed |

The CI integrations run Node 24 (the Action's `actions/setup-node` at `node-version: 24`; the GitLab and Bitbucket images `node:24-alpine` and `node:24`, pinned by digest).

## Platforms

| Platform | Status |
|---|---|
| macOS (Darwin 25.6.0, arm64) | **Tested**: everything in this repository ran here |
| Linux | **Root suite tested** (2026-11-10): Debian 12 in Docker (`node:22`, Linux 6.8 aarch64, git 2.39.5, OpenSSH 9.2p1, OpenSSL 3.0.20), `npm ci && npm run build && npm run typecheck && npx vitest run`: 2,722 passed, 8 skipped, 0 failed, including the OpenSSH and OpenSSL oracle tests. The first run found two tests that assumed a recent git (the `builtin_` attribute rule from 2.42, `GIT_NO_LAZY_FETCH` from 2.44); they now check the local git. The GitHub Action's steps ran in `node:24` on the same machine against a real audit repository. Not yet run on a GitHub-hosted runner, and not on x86_64 natively. The plugin host's permission model and the OpenSSH and OpenSSL oracle tests are measured on macOS only, and whether `/proc/<ppid>/environ` stays outside an isolated plugin's read scope is unverified (macOS has no `/proc`) |
| Windows | **Untested**, and not supported until it is. Known: pr-rla runs `git` and `ssh-keygen` by the absolute path it finds on PATH's absolute entries; a checkout with `core.autocrlf=true` FAILs check 7 (the working tree's CRLF ledger differs from its committed history: verify with `core.autocrlf=false`); the assistant guard reads PowerShell with its POSIX parser |

This is short of NFR19, which asks for macOS **and** Linux tested: a Linux run is a release step ([`release-checklist.md`](release-checklist.md), step 11).

## Tools pr-rla runs

| Tool | Needed for | Tested with |
|---|---|---|
| git | the `git-file` ledger's history walk, `checkpoint --push` | 2.55.0. `GIT_NO_LAZY_FETCH` needs 2.44 or later; an older git still refuses a partial clone, by its promisor check, before reading anything |
| ssh-keygen (OpenSSH) | `record --sign`; the oracle tests | OpenSSH 10.3p1 (macOS, LibreSSL 3.3.6) |
| openssl | the oracle tests only (skipped when `openssl ts` is missing) | OpenSSL 3.6.4 |

## Source-control systems

| Provider | Population (`listChanges`) | Draw context (`describeChange`) | Org pools (`listRepos`, push log, visibility proof) |
|---|---|---|---|
| `github` (github.com) | **live**: github/gh-aw Q3 2026, 3,944 changes (2026-11-03); recorded and synthetic fixtures | **live**, read-only, for the 36 issued gh-aw draws (three times, 2026-11-04), and once through `pr-rla-mcp` (draw #13); the raw responses of four draws are recorded, and all 36 descriptions are in the recorded audit's `changes.json` | `listRepos` **live** on the `navikt` org (223-repo subset, dry run and estimate, 2026-11-04); push log **live** on github/gh-aw (2026-11-04, and on 2026-11-10 with a gap after the freeze, reported as a caveat in check 5); a whole audit **live** on github/gh-aw, the retrospective demo of the [tour](tour.md): `register`, `freeze` (N = 171) on 2026-11-09, `sample`, DEMO verdicts and an online `verify` ending VERIFIED, exit 0, on 2026-11-10; the visibility proof (org owner, installation, `total_private_repos`) on fakes only |
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
| `github-issues` | recorded public timelines (six GitHub issues, 2026-11-04); **live** on github.com in the [sandbox showcase](../examples/sandbox-showcase/README.md) (2026-11-12): 22 label events read back by `verify` and compared with a checkpoint; GitHub Enterprise Server on a mock | **live** on github.com (2026-11-12): `sample` opened 22 issues and created the labels, `record` applied 22 verdict labels, `checkpoint` time-stamped the history, and the Action posted comments, in a repository the owner created for it (public during the showcase, private since); GitHub Enterprise Server on mock servers only |
| `gitlab-issues` | synthetic, from the documented `resource_label_events` shape: the endpoint answers 401 without a token even on public projects (seen live, 2026-11-04), so its JSON itself is unverified; recorded label notes as evidence | mock servers only |
| Jira (the example plugin) | recorded from hibernate.atlassian.net, Jira Cloud, anonymously (2026-11-04) | mock servers only; Jira Data Center not supported |

## Time, beacon and log

| Service | Status |
|---|---|
| The eight bundled timestamp authorities | **live**, hash only: one request each, twice, all eight answering (2026-11-03); `register` and `freeze` ran live on a demo audit (2026-11-09, four authorities), and `verify` checked those tokens online (2026-11-10). A checkpoint with real tokens has run on mock authorities only |
| drand quicknet | **live**: chain info and a round read (phase 1); round 33843684 fetched and BLS-verified by `sample` and `verify` on the demo audit (2026-11-10); recorded rounds verify their BLS signatures in the suite |
| Rekor (transparency log) | **mock logs only**, v1 and v2. No entry has ever been written to a real log, production or staging (D3); the pinned production keys come from Sigstore's TUF root |

## Integrations

| Integration | Status |
|---|---|
| GitHub Action, GitLab component and snippet, Bitbucket step | schema-checked against the published schemas (vendored, dated) and run on fixtures and mock servers. The **GitHub Action ran on GitHub-hosted runners** (`ubuntu-latest`, 2026-11-11 to 2026-11-13) from this repository pinned by commit, on push, label, schedule and dispatch events, `status` and online `verify` ([sandbox showcase](../examples/sandbox-showcase/README.md)); the GitLab component and the Bitbucket step never on a real runner. The GitLab component is not in the CI/CD Catalog |
| Claude Code plugin | `claude plugin validate` passes (Claude Code 2.1.267, 2026-11-04); not yet run in a session |
| Codex, Cursor | configuration from their documentation (read 2026-11-04); not run |
| The three manual assistant runs (FR3.6) | **pending**: the founder's ([`assistants/manual-acceptance.md`](assistants/manual-acceptance.md)) |

## Exit codes

Every command's exit status is a stable contract ([`contracts.md` §7](design/phase-3-4/contracts.md); `src/cli/exit-codes.ts`). Existing codes never change meaning. Codes 0–3 are phase 1–2's; 4 and 5 were added in bolt 1, with the exit-code table, and 6 in the U8 fix round (the design's NFR16 counts 4 among phase 2's codes; the phase-2 code had none).

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
| `pr-rla`, `pr-rla-mcp` | semver, released together at one version | The first public release is 0.1.0. Below 1.0, a change to the CLI, an output or a record is a minor version and is listed in the [changelog](../CHANGELOG.md); adding a field is compatible. `pr-rla-mcp` pins its `pr-rla` exactly at release (until then it links this checkout: [`release-checklist.md`](release-checklist.md)) |
| `providerApiVersion`, `ledgerApiVersion` | 1 | Optional additions only. A required method or a changed meaning moves to 2, with two releases in which pr-rla loads both |
| `pr-rla/http` (`HTTP_HELPER_VERSION`) | 1 | Versioned on its own, independent of the API versions |
| The plugin host protocol | `pr-rla/ipc/v2` | The parent refuses a child that reports another protocol; the two always ship together |
| The MCP tools | `pr-rla-mcp`'s version, and the tools' output schemas | A renamed tool or a removed field is a minor version below 1.0 |
| The trust bundle | date-stamped, `2026-11` | Anchors and intermediates are only added; old tokens keep verifying after a rotation |
| Record schemas | `pr-rla/<kind>/vN` | `verify` reads every schema ever written; writers emit the newest |

The record schemas in this release: `pr-rla/registration/v1` and `/v2`, `pr-rla/manifest/v1` and `/v2`, `pr-rla/manifest-commitment/v1` and `pr-rla/commitment/v2`, `pr-rla/draws/v1`, `pr-rla/verdict/v1` (a `git-file` line; its signed bytes are `pr-rla-verdict/v2`, and `v1` signatures are refused), `pr-rla/ledger-index/v1`, `pr-rla/ledger-checkpoint/v1`, `pr-rla/ledger-history/v1`, `pr-rla/changes/v1` (the json-file export), `pr-rla/lock/v1`, `pr-rla/approvals/v1`, `pr-rla/tsa-trust-bundle/v1`, `pr-rla/freeze-run/v2` and `pr-rla/freeze-repo/v2` (a pooled freeze's checkpoints, never committed), and `pr-rla/draw-context/v1` (`draw-context --json`).

The ledger publication record, `audit/<window>/ledger-publication.json`, is `pr-rla/ledger-publication/v1`: a signed record (the registration's key) of the ledger index as `sample` published it, with the registered authorities' tokens on its digest. Each `sample` appends one that must extend the previous.
