# Test Design: pr-rla phases 3–4

This refines the draft's `pr-rla/docs/design/phase-3-4/07-test-design.md`. It is the plan the build follows, since this design stops before code generation.

The conventions are BUILD-NOTES':
- recorded fixtures offline;
- read-only live runs where a public target exists;
- every claimed result pasted with its command and date.

## 1. Principles

- **Kept from the draft:** offline by default; every fixture checked against a second implementation before it is trusted; first-class tamper fixtures that assert the exact check number and message; the statistics regression tests run unchanged.
- **Changed:**
  - Write paths (issue ledgers, CI, end-to-end runs) use only recorded fixtures and mock servers. There are no scratch repos and no real-repo writes (D8).
  - Every fixture is marked `recorded` or `synthetic` (FR4.7).
  - Live work is read-only or hash-only (§4).
- **Added: a network-deny harness.** `npm test` fails if any test opens a socket, with a narrow allowance for the local mock servers on 127.0.0.1.
- **Added: timing budgets.** Timing tests (NFR10) assert the target when run locally and 2× the target in CI, so shared runners do not make them flaky.
- **Added: what "offline" means for `draw_context`.** It runs against the `json-file` provider with a recorded `describeChange` response, so no network is involved.

## 2. Per-unit tests

| Unit | Tests | Data |
|------|-------|------|
| U1 | **Library evaluation** recorded (FR1.3). Acceptance rules 1–7, each violated once. k-of-n with same-operator de-duplication (Entrust/Sectigo). `U_k` against `opensAt` and `publishTime(R)` at ±1 s boundaries. A token 10 min 61 s off with no stated accuracy fails rule 7. **Outcome table:** 1 of 2 writes and exits 5, 0 of 2 exits 5, no authority configured exits 0. Skew of 10 min 1 s against the median genTime is refused and 9 min 59 s accepted, with no accuracy term. The last retry falls at or before 5 min (fake clock). No `--retry-timestamps` option exists. v1 Rekor records still 7/7. Rekor v2 inclusion proof and checkpoint against a **mock log**. `--submit` prints the v2 warning and needs `--yes`. No Rekor host is contacted in the suite. Old-token fixture verifies after a DigiCert certificate rotation (NFR21) | Tokens recorded 2026-11, one per authority (all eight, hash only), plus a forged genTime, a foreign root, an expired signer and a SHA-1 signature. Rekor v2 mock built from rekor-tiles `CLIENTS.md` |
| U2a | Phase-2 suite unchanged. Read-only guard: GET passes; a GraphQL query passes; a GraphQL mutation, a REST POST and a cross-host redirect are refused. Shared host budget under a fake clock. Header-derived pacing. **Defaults test**: every default equals its row in `nfr-design.md` §3, including 900 points/min. Override test. Timeouts by destination (30 s SCM, 15 s TSA) against hanging servers. No recorder in read-only mode. `writePaths` enforcement for ledger writes | Fake servers |
| U4 | Ledger kit on GitHub and GitLab timelines: clean, relabel same, relabel opposite, both labels, removal, deleted issue, transferred issue, deleted label, renamed label, app-applied, unlisted reviewer, verdict before seed, more than 100 events. Checkpoint round-trip and a checkpoint mismatch. Idempotent `publishDraws`. **Self-hosted base URLs** for GHES and GitLab self-managed on mock servers. **Cross-clone checkpoint push**: two clones of a local bare repo push at once, and both lines land with no force-push. A clone with an unpushed local `git-file` verdict commit keeps that commit after the rebase. A dirty tree, a detached HEAD and a missing upstream are each refused with exit 1. Three forced rejections exit 4. A repeated line reads as one checkpoint. A checkpoint with 1 of 2 tokens exits 5. Jira example passes the ledger kit with a single-select field | Read-only recordings of public timelines where they exist (per `functional-design.md` §U4 table), otherwise synthetic, each marked. Destructive cases always synthetic. Local bare git repos |
| U2b | Gitea passes the kit through the host. A hostile fixture plugin tries `process.env.GITHUB_TOKEN` (gets the placeholder), reads `~/.npmrc` (denied), writes a file (denied), sends the placeholder to another host (refused), sends `prrla-basic:` to an undeclared host (refused), and on Node 25 or later opens a socket (denied, or recorded as unverified if the IPC test fails). Tree-hash mismatch refuses load. A symlink escape aborts hashing. `--plugins builtin-only` refuses before import. `register` with an unlocked plugin exits 1 and names `plugin add`. Install-script warning. No heartbeat for 60 s kills the child | `test/fixtures/plugins/hostile/` |
| U3 | `bots` re-labelling (exactly +4 MRs on gitlab-org/cli). `pinned-head` on every built-in and Gitea. `actor-ids` stability. `review-granularity`. `revoked-approval`. `direct_push_via_merge: exclude` on bamboo-specs' release merge. A `populationOptions` mismatch FAILs check 5 | Existing recorded fixtures plus a late-push synthetic history |
| U5 | API functions return the same objects as `--json`. `mcp-readonly.test.ts`: every tool with valid and hostile inputs; the audit-directory tree hash is unchanged; the server opens no file for writing; zero non-read requests. `draw_context` drops `linguist-generated` files and carries the core-built fence. A job hand-off at 25 s for `freeze_preview` and online `verify`. `unknown` after a restart. Preview cache hit within 600 s. At most 4 concurrent jobs (NFR20). Root escape refused. Write operations refused in read-only mode | Recorded gh-aw draw; synthetic audit directory |
| U7 | Schema checks for `action.yml`, the GitLab component and `bitbucket-pipelines.yml`, against the published schemas. The **harness** runs the composite action's steps and each GitLab and Bitbucket job script against a fixture audit directory and a mock API. Exit mapping: 2 and 3 fail, 0 passes. Summary rendering. `command: checkpoint` refuses without `allow-writes: true` | Fixture audit directories; mock GitHub API |
| U6 | `guard.test.ts`: 10 blocked and 10 allowed hook payloads, now including `checkpoint --push`. `claude plugin validate` on the plugin directory. **The founder's manual runs** in Claude Code, Codex and Cursor, each dated in BUILD-NOTES | Recorded hook JSON |
| U8 | Synthetic 40-repo org with injected 429s and a killed run: the resumed manifest is byte-identical. A repo added after freeze makes check 5 FAIL; a deleted repo gives a WARN with a count. `--estimate` within ±20% of requests and ±50% of wall time. A two-provider pool is refused by AuditCore | Fake GitHub org |
| U9 | Software `ed25519` key gives `account`. A software-emulated `-sk` signature with UP set passes `presence`; one with UP clear fails it. An unlisted signer is not counted. Unsigned under `require_signed` fails. A reviewer/principal mismatch is reported. A decreasing counter gives a WARN. Certificate text says `key hardware not attested`. No doc claims hardware-verified presence | Signatures made with software keys and a software-emulated authenticator, cross-checked with `ssh-keygen -Y verify` |
| U10 | `npm pack --dry-run` lists only `dist/`, README, CHANGELOG and package.json. Secret grep over the tarball. `check-docs` re-runs offline outputs. Every doc page listed in FR8.1 exists | Build output |

## 3. End-to-end matrix (intent metric 3, FR6.7)

Every cell runs on recorded fixtures and mock servers in this phase. **H** marks the steps a human does by design: deep review and recording the verdict. Live runs on real repos come later as a configuration change, not new code.

| | GitHub | GitLab | Bitbucket Cloud |
|---|---|---|---|
| **Ledger** | `github-issues` | `gitlab-issues` | `git-file`, or the Jira example where the team uses Jira |
| **CLI** | register (tokens) → freeze → sample → issue-ledger publish (mock) → record via label event (H, simulated in the fixture) → `status --offline false` against the mock ledger → verify 7/7 | Same, on the GitLab fixture and the `gitlab-issues` mock | `e2e-bitbucket`: recorded provider fixture, `git-file` ledger, signed and unsigned verdict commits; `status` offline |
| **CI** | Action harness: a label event fixture → status summary; an ESCALATE fixture fails the job; `checkpoint --push` to a local bare repo | Component job harness: a push to `audit/**` → status artifact; schedule run | Pipeline step harness: push → status step |
| **Assistant (MCP)** | Claude Code: `review-draw` on a recorded draw → the human records (H) → the `status` tool with `offline: false` shows the new prefix (issue-ledger verdicts come from the tracker) | Codex: the same flow against the GitLab audit directory, `status` with `offline: false` | Cursor: the same flow against the Bitbucket audit directory, `status` offline (git-file) |

The assistant cells rotate clients so each client and each SCM appears once. Each run also calls every MCP tool once in every client. The founder runs the assistant cells by hand (RQ2).

**Bitbucket Data Center** stays unverified against a live server, as in phase 2.

## 4. Live runs and what they need

| Run | Writes? | Needs the founder? |
|-----|---------|--------------------|
| One token from each of the eight bundled authorities (U1) | No; a hash goes to each authority | No: allowed by D2 and RQ10 |
| Read-only recordings of public issue timelines (U4) | No | No: allowed under D8 (AS-04) |
| Read-only dry runs: navikt org (U8), gh-aw `draw_context` (U5) | No | No |
| Manual assistant runs in Claude Code, Codex and Cursor (U6) | No (read-only tools) | Yes, the founder runs them (RQ2) |
| The prospective gh-aw `register` (U1 hand-off) | Hashes go to the authorities; the record is local | Yes, the founder runs `register` personally (RQ24) |
| Any Rekor entry, staging or production | Yes, permanent | **Not in this round** (D3) |
| Scratch repos or projects | Yes | **Not in this round** (D8) |

## 5. Standing guards (in `npm test`)

- **`architecture boundaries`, extended.**
  - Core imports only `src/sdk/*`, `src/core/**` (including `src/core/presence`), and the pure parts of `src/beacon` and `src/translog`.
  - Core does not import `src/api`, `src/net`, `src/plugins` or `src/timestamp` clients.
  - `pr-rla-mcp` imports only `pr-rla/api/read`.
  - The import graph from `pr-rla/api/read` reaches no module under `src/api/write/`, `src/io/git-transport.ts` or `src/commands/`.
- **Network deny.** No socket outside the local mock servers.
- **Secret grep** over fixtures, test outputs, verbose logs and `npm pack --dry-run` contents.
- **`check-docs`:** offline doc outputs re-run and diffed.
- **Schema readers:** every record schema ever written (v1 and v2) round-trips through `verify`.

## Kept, changed and added against the draft's `07`

- **Kept.** The principles, the per-unit test lists (extended), the matrix shape, Bitbucket Data Center unverified, and the standing guards.
- **Changed.**
  - No Rekor staging data; a mock log instead (D3).
  - No scratch repos for U4, U7 or the matrix; mocks, local bare repos and public-timeline recordings instead (D8).
  - U9's signatures come from software keys, not a real FIDO key (D7).
  - The U8 estimate bound is ±20% of requests plus ±50% of wall time.
  - The matrix names one ledger per SCM.
- **Added.**
  - The network-deny harness.
  - The library evaluation test.
  - The outcome-table and clock-skew tests.
  - The defaults test.
  - The self-hosted base-URL tests.
  - The cross-clone checkpoint test.
  - The CI harness.
  - The MCP memory bound test.
  - The presence-wording check.
