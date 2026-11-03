# NFR Design: pr-rla phases 3–4

**Stage:** NFR Design. It refines the draft's `pr-rla/docs/design/phase-3-4/06-nfr-design.md`, to meet `nfr-requirements.md` (NFR1–NFR24).

Infrastructure design does not apply: there is no hosted backend (FC-08). Packaging is covered in §5 instead.

## 1. What leaves the machine

| Destination | What is sent | When | Public or permanent? |
|-------------|--------------|------|----------------------|
| SCM APIs, through the broker | Read requests for audited repos and the audit repo; writes only to the audit repo or project's declared `writePaths` | freeze, verify, online status, draw-context; sample and record with issue ledgers | Issue-ledger writes are visible in the audit repo |
| Audit git remote, through the git transport | Checkpoint commits | `checkpoint --push` only | Visible to whoever can read the audit repo |
| RFC 3161 authorities, through the broker | The SHA-256 of a signed record and a nonce | register, freeze, checkpoint | No (the authority may keep logs) |
| drand, through the broker | A GET for one round | sample, verify | No |
| Rekor, through the broker | Record digest, signature, public key | Only the user's `--submit --yes`; **never during the build** (D3) | **Yes, public and permanent** |
| npm registry | `npm audit signatures` | Only `pr-rla plugin check` | No |

There is no telemetry, no update check and no crash reporting.

## 2. Security model

**Assets** (kept from the draft):
1. The integrity of the audit claim.
2. SCM tokens.
3. The audit signing key.
4. The reviewer's verdict authority.
5. Private repo data seen during freeze and draw-context.

### Threats and controls

T1–T5 and T8–T15 are kept from the draft's `06` §2. Changed and added rows:

| # | Threat | Control | Unit | Residual |
|---|--------|---------|------|----------|
| T6 | A malicious plugin steals tokens or credentials | Out-of-process host; scrubbed environment; placeholders swapped only on declared hosts; fs-read scoped; provider traffic read-only; lock written only by `plugin add` | U2a, U2b | Node's permission model is a seatbelt. On Node 22 and 24 repo data can still be sent out. On Node 25 or later it is blocked only if the IPC test passes, so the row is unverified until it runs |
| T7 | An assistant records a verdict on a human's behalf | Tier 1: pr-rla surfaces never write (tested). Tier 2: a read-only token for the assistant, registered reviewers, app-applied labels ignored, `minProvenance: account` by default with issue ledgers. Tier 3: hooks | U4, U5, U6, U9 | Without the tier-2 setup, an assistant with the human's shell and token can record and look like the human. Presence attestation is designed for that case, but in this release it is verified with software keys only (D7) |
| T16 | A reviewer registers a software-emulated security key, so the user-presence flag proves nothing | Docs say `presence` relies on a hardware-backed registered key; certificates print `key hardware not attested` | U9, U10 | Not mitigated in this release. FIDO key attestation at registration would close it later |
| T17 | A tampered or vulnerable ASN.1/CMS library accepts a forged token | Exact pin plus lockfile integrity; pr-rla's own checks for rules 2, 4, 5, 6 and 7; six tamper fixtures on every upgrade | U1 | A bug in signature verification inside the library; mitigated by the `openssl ts -verify` oracle in tests |
| T18 | Checkpoint pushes are used to rewrite audit history | Append-only file rebuilt from the remote; never `--force`; the assistant hook blocks `checkpoint --push` | U4, U6 | A repo admin can still force-push, which git history and earlier checkpoints expose |

### The verdict-authority guarantee

This replaces the draft's verbatim text, for `docs/security-model.md`:

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

## 3. Rate limits, timeouts and performance

### Default budgets (NFR12; requirements finding R-09)

Each default is the smallest limit the provider publishes for the request's auth state. The page titles are those the draft's `06` §3 check of 2026-11-03 relied on; U2a's defaults test re-confirms each page when it is written.

- **Auth state picks the row.** With a token configured for the host, the authenticated row applies. With none, the anonymous row applies: GitHub REST 60/h, Bitbucket Cloud 60/h, GitLab.com to confirm.
- **Headers win.** The first response's rate-limit headers (for example GitHub's `x-ratelimit-limit`) replace the default for the rest of the run. In practice the defaults bind only before the first response, or on servers that send no headers.
- **Worked example: gh-aw.** A personal token's response reports 5,000/h, and the broker paces to that, not to the 1,000/h `GITHUB_TOKEN` default. So the measured 22-minute gh-aw Q3 freeze is not slowed by the defaults.
- **What the test checks.** The defaults test compares the code's defaults against this table, which is the reviewed source. The source pages are re-checked by hand when the table changes.

| Service | Default | Published limit | Source page |
|---------|---------|-----------------|-------------|
| GitHub REST, reads | 1,000 requests/h per repo | `GITHUB_TOKEN`: 1,000/h per repo (personal tokens 5,000/h) | GitHub Docs, "Rate limits for the REST API" |
| GitHub REST, secondary points | 900 points/min | 900 points per minute for REST | GitHub Docs, "Rate limits for the REST API" (secondary limits) |
| GitHub REST, content-creating writes | 80/min and 500/h | 80 per minute and 500 per hour | Same page |
| GitHub REST, concurrency | 100 in flight | 100 concurrent requests | Same page |
| GitHub GraphQL | 5,000 points/h; 2,000 points/min | 5,000 points/h; 2,000/min secondary | GitHub Docs, "Rate limits and query limits for the GraphQL API". To confirm: a lower `GITHUB_TOKEN` budget |
| GitLab.com API | 2,000 requests/min per user | Authenticated API, 2,000/min | GitLab Docs, "GitLab.com settings: rate limits". To confirm: the unauthenticated limit |
| Bitbucket Cloud | 1,000/h authenticated; 60/h anonymous | `/2.0/repositories/*` | Atlassian Support, "API request limits" (Bitbucket Cloud) |
| Bitbucket Data Center | burst 60, refill 5/s per user | Admin-configurable default token bucket | Atlassian, "Improving instance stability with rate limiting" (Bitbucket Data Center) |
| Jira Cloud, writes per issue | 20 per 2 s and 100 per 30 s | Per-issue write limits | Atlassian Developer, "Rate limiting" (Jira Cloud platform) |
| Sectigo authority | ≥ 15 s between requests | Sectigo's scripted-request guidance | Sectigo timestamping guidance |
| FreeTSA | ≤ 1 request/s | 1/s per IP | freetsa.org |
| Other authorities, drand | one request per record or round | none published | n/a |

### Timeouts (NFR14)

| Destination | Per-request timeout | Basis |
|-------------|---------------------|-------|
| SCM | 30 s | Equals the MCP tool budget, which is half of Codex's default `tool_timeout_sec` of 60 s (Codex MCP docs, as cited in the draft's `05` §U5). GitHub ends requests that take more than 10 s to process (GitHub Docs, "Troubleshooting the REST API": timeouts), so 30 s leaves room for transfer. MCP tools hand off to a job at 25 s, so one slow request never overruns a tool call |
| Timestamp authority | 15 s | The draft's per-authority timeout; at most 5 minutes of retries in total |
| drand | 15 s | One small GET |
| Rekor | 30 s | Same as SCM |
| Each git call in the checkpoint transport | 30 s | Same as SCM |

### Operation budgets

| Operation | Target | Pass criterion |
|-----------|--------|----------------|
| `status --offline`, `verify --offline` (N ≤ 10,000) | < 1 s, < 2 s | Fixture timing (NFR10) |
| `draw_context` | < 2 s offline | Fixture timing; live GitHub timing recorded as an observation |
| MCP tool call | result, or `{ jobId }` at 25 s | Slow-fixture test |
| MCP server start | < 2 s installed | Timed test. The Codex guide sets `startup_timeout_sec = 60` for a cold `npx -y` start |
| `register`, `freeze` timestamping | ≤ 15 s per authority, in parallel; ≤ 5 min with retries | Fake-clock test |
| Online `freeze` and `verify` on gh-aw Q3 | about 22 min (measured 2026-11-03, phase 1) | Observation only |

## 4. Reliability and failure policy

| Failure | Behaviour |
|---------|-----------|
| SCM 5xx, 429, truncated body | Broker retry with backoff and jitter; host-wide pause on rate-limit headers |
| Rate budget exhausted mid-freeze | Stop scheduling, finish in-flight, keep checkpoints, exit 4 with the resume command, write no manifest |
| An authority is down or slow | Others continue. Fewer than k: record written, `TIMESTAMP NOT TAMPER-PROOF (n of k)` plus the re-register command, exit 5. All configured but none reachable: `(0 of k)`, exit 5 |
| No authority configured | Record written, warning, exit 0 |
| Local clock skewed more than 10 min | Refuse to write; print the difference; exit 1 |
| drand unreachable | `sample` exits 2; `verify` check 4 SKIP; `--beacon-file` works offline |
| Rekor down | `--submit` fails and leaves the time-stamped record intact; time evidence never depends on Rekor |
| Plugin host crash or 60 s without heartbeat | The command fails with the plugin's stderr tail; no partial outputs |
| Ledger API failure in `verify` | Check 7 FAIL with the error, never a silent PASS |
| Checkpoint push rejected | Up to 3 attempts, never `--force`, then exit 4 with the re-run command |
| Interrupted write | Temporary file plus rename; the previous file stays whole |
| MCP server restart | Jobs are lost; `job_status` answers `unknown` with the re-run hint |

**Determinism (NFR6)** still needs the pinned head (U3), sorted ids and repos, canonical JSON, and no wall-clock fields inside hashed content except the signed times.

## 5. Versioning, compatibility and packaging

| Package | Contents | Runtime dependencies |
|---------|----------|----------------------|
| `pr-rla` | CLI, core, SDK subpaths (`/provider`, `/ledger`, `/testing`, `/http`), the read-only API subpath `/api/read`, built-in providers and ledgers, trust bundle | `commander`, `yaml`, `drand-client` (kept, RQ23), plus the ASN.1/CMS library chosen in U1 (`pkijs` + `asn1js` if it qualifies) |
| `pr-rla-mcp` | stdio MCP server; imports only `pr-rla/api/read` | `pr-rla` (exact), `@modelcontextprotocol/server` 2.x, `zod` 4 |
| `integrations/claude-code` | Plugin directory (not an npm package) | none |
| `integrations/github-action` | Composite action and its own lockfile | `pr-rla` (exact, by integrity) |
| `integrations/gitlab` | CI/CD component | none |
| `examples/providers/gitea`, `examples/ledgers/jira` | Examples, their own packages | peer `pr-rla` |

- **First public release:** v0.1.0, with all eleven units (RQ17). The full compatibility table is in `contracts.md`.
- **npm names:** `pr-rla` was unclaimed on 2026-11-03. Claiming it, and `pr-rla-mcp`, is a public act left to the founder.
- **Node:** `>= 22.13`. CI integrations run on Node 24. Network denial in the plugin host needs Node 25 or later, pending the IPC test.

## 6. Operability

- **Exit codes:** 0–5, as in `contracts.md` §7. Existing codes keep their meaning.
- **Errors:** a plain first sentence, then the host or command and the next step. With `--json`, the error object goes to stdout.
- **Verbose output:** `--verbose` adds per-request host, status and timing lines, never headers or bodies, and never credentials.
- **Diagnostics in CI:** the Action writes the status line and the check table to the job summary and uploads the JSON as an artifact.

## 7. Platforms

macOS and Linux are tested in CI. Windows is untested, and the README says so. Path handling uses `node:path`, and the plugin host's fs-read scope uses resolved absolute paths. On Linux, `/proc/<ppid>/environ` is outside the child's fs-read scope (kept from the draft).

## Kept, changed and added against the draft's `06`

- **Kept.** The asset list, threats T1–T5 and T8–T15, the failure policy rows that did not change, determinism, and the package table with its dependency note.
- **Changed.**
  - Rekor is never written in the build.
  - TSA, drand and Rekor traffic goes through the broker.
  - T6 marks the Node 25 row unverified.
  - T7 and the guarantee text are rewritten under D7.
  - The rate defaults are published limits, not round fallbacks, and now include GitHub's 900 points/min.
  - The timeouts are numbers.
  - The MCP hand-off is at 25 s.
  - `draw_context` is timed offline.
  - The first release is v0.1.0.
- **Added.**
  - T16 (software-emulated keys), T17 (parsing library) and T18 (checkpoint pushes).
  - The git transport row in §1.
  - The fewer-than-k, clock-skew and checkpoint-push failure rows.
  - The operability section and the platforms section.
