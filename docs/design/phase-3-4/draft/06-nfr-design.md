# 06 · Non-functional design: security, rate limits, reliability, versioning, packaging

Infrastructure design is **not applicable**: there is no hosted backend in the open-source scope (tech-env). Distribution and packaging are covered in §5 instead.

## 1. What leaves the machine

| Destination | What is sent | When | Public / permanent? |
|---|---|---|---|
| SCM APIs | read requests for the audited repo(s) and the audit repo; writes only to the audit repo/project (issues, labels) | freeze, verify, status online, draw-context, sample (issue ledgers), record (issue ledgers) | issue-ledger writes are visible in the audit repo |
| RFC 3161 TSAs | the SHA-256 of a signed record, plus a nonce | register, freeze, checkpoint | no (the TSA may keep its own logs) |
| drand | a GET for one round | sample, verify | no |
| Rekor | the record digest, the signature and the public key | only `--submit` | **yes, public and permanent** |
| npm registry | `npm audit signatures` | only `pr-rla plugin check` | no |

No telemetry, no update checks, no crash reporting (C-4).

## 2. Security model

### Assets
1. The integrity of the audit claim: population, seed, draws and verdicts.
2. SCM tokens: read tokens, and the ledger-write token.
3. The audit signing key (`.pr-rla/signing-key.pem`).
4. The reviewer's verdict authority.
5. Private repo data seen during freeze and draw-context.

### Threats and controls
| # | Threat | Control | Unit | Residual |
|---|---|---|---|---|
| T1 | Re-roll the seed by presenting a later timestamp | Seed input is the *signed* `registeredAt`; tokens only bound it | U1 | None beyond T14 |
| T2 | Backdate a registration to look prospective, or to pull R earlier | Token rule 7: `\|genTime − t\| ≤ tolerance + accuracy`; prospective needs `U_k < opensAt` | U1 | None if k TSA operators are honest |
| T3 | Compromised or wrong TSA | k-of-n distinct operators (default 2 of 4); same-operator tokens count once (Entrust = Sectigo) | U1 | k operators colluding |
| T4 | Prune the manifest | Check 5 rebuild (existing); pinned head; pooled freeze is all-or-nothing | U3, U8 | A repo the verifier cannot read → WARN with a count |
| T5 | Swap provider code or options so the rebuild agrees with a pruned manifest | Registered `PluginIdentity`; lock re-hash at load; stratum-relevant options FAIL on mismatch | U2b | A verifier who deliberately uses the same malicious plugin |
| T6 | A malicious plugin steals tokens or credentials | Out-of-process host; scrubbed env; credential placeholders swapped only on declared hosts; fs-read scoped; provider traffic read-only | U2a, U2b | Permission model is a *seatbelt*; Node 22/24 cannot block network, so repo-data exfiltration remains possible |
| T7 | An assistant records a verdict on a human's behalf | Tier 1: pr-rla surfaces never write (tested). Tier 2: read-only token in the assistant env, registered reviewers, app-applied labels ignored, presence attestation. Tier 3: hooks | U5, U6, U4, U9 | Without the tier-2 setup an assistant with the human's shell can record. Only `presence` makes that detectable |
| T8 | Prompt injection in a draw's diff or description steers the assistant | Untrusted-content fences; skill never states a verdict; verdict is human | U5, U6 | The human may still be misled by an assistant summary; the protocol governs |
| T9 | An admin deletes issues, labels or changelog to hide a FAIL | Draw → issue index in git; label-existence check; TSA-stamped checkpoints with stored event lists | U4 | Deletion before the first checkpoint is visible only as a missing indexed issue |
| T10 | A bot or app applies verdict labels | Eligibility: registered reviewers, no bots, `performed_via_github_app` null | U4 | An agent using a human's own PAT is indistinguishable at the SCM (T7 tier 2) |
| T11 | Audit signing key stolen | Mode 0600, gitignored; hooks block reading it; verify accepts only the key in the registration | existing, U6 | Thief can mint *new* registrations: the T14 gap |
| T12 | A compromised pr-rla release | Exact version pins in every integration; the action installs by lockfile integrity; publish with provenance via trusted publishing (founder, U10) | U7, U10 | Provenance proves origin, not safety (ChainDrop) |
| T13 | Tokens leak into fixtures, logs or MCP results | Recorder scrubs auth headers and e-mails; the broker never echoes credentials; secret-grep test over artifacts, fixtures and the npm tarball | U2a, U10 | none known |
| T14 | Several registrations, keep the best | Procedural: the auditor pins one registration receipt before the window opens | existing, `02` P1-b | Unsolvable in code: no log offers complete search |
| T15 | drand nodes collude to bias or pre-reveal | Assumption stated: threshold honesty of the League of Entropy | existing | Stated, not mitigated |

### The verdict-authority guarantee, verbatim (for `docs/security-model.md`)
> pr-rla's MCP tools and its review skill never record, edit or remove a verdict, never issue draws and never submit to a public log. This is enforced by a read-only mode and tested on every tool.
>
> pr-rla cannot stop an assistant that has your shell and your credentials from acting as you. Client permission rules and hooks are not a security boundary, and some clients let an AI approve tool calls.
>
> What pr-rla can do is make such verdicts not count:
> - give the assistant a read-only token;
> - record verdicts where the assistant cannot, in the SCM web UI or in commits signed with a touch-required FIDO key;
> - register the reviewers whose verdicts count.
>
> `verify` then reports any verdict that does not meet the registered provenance level.

## 3. Rate limits and performance

The broker paces by **what the server reports**: `x-ratelimit-remaining` / `-reset`, `RateLimit-Remaining` / `-Reset`, `Retry-After`. Its pace is remaining ÷ seconds-to-reset, shared across every caller of that host. The static fallbacks below apply only when a server sends no headers.

| SCM / service | Documented budget (checked 2026-11-03) | Headers | Broker fallback |
|---|---|---|---|
| GitHub REST | PAT 5,000/h; App 5,000–12,500/h (15,000 on Enterprise Cloud); `GITHUB_TOKEN` 1,000/h per repo. Secondary limits: 100 concurrent, 900 points/min, 80 content-creating requests/min and 500/h | `x-ratelimit-*`, `retry-after`; 403 or 429 | concurrency 4; writes 1/s |
| GitHub GraphQL | 5,000 points/h (10,000 on Enterprise Cloud); 2,000 points/min secondary; `first` ≤ 100 | same | phase-2 page sizes (40 PRs, 50 commits, halving on 5xx) |
| GitLab.com | authenticated API 2,000/min per user (tier-aware limits proposed, not in effect) | `RateLimit-*`, `Retry-After` | concurrency 4 |
| Bitbucket Cloud | `/2.0/repositories/*` 1,000/h (scales only on paid workspaces with 100+ users and access tokens); anonymous 60/h | `X-RateLimit-Limit`, `-NearLimit`; `Retry-After` not seen on anonymous 429s (phase 2) | 0.25 req/s; 60 s back-off on a bare 429 |
| Bitbucket Data Center | admin-configured token bucket, default 60 with 5/s refill, per user; 429 with no documented headers | — | 4 req/s, burst 50 |
| Jira Cloud | API-token traffic exempt from the points quota; burst limits; per-issue writes 20/2 s and 100/30 s | `Retry-After`, `X-RateLimit-*` | writes 1/s per issue |
| TSAs | Sectigo asks for ≥ 15 s between scripted requests; FreeTSA 1/s per IP | — | one request per TSA per record; never loops |
| drand | public relays | — | one round per command |

### Operation budgets (targets; measured values go in BUILD-NOTES)
| Operation | Target | Basis |
|---|---|---|
| `status --offline`, `verify --offline` (N ≤ 10,000) | < 1 s, < 2 s | pure computation + file reads |
| `register` / `freeze` timestamping | ≤ 15 s per TSA in parallel | per-TSA timeout |
| `draw_context` (GitHub) | < 10 s | ~5–8 requests |
| `freeze` / online `verify`, gh-aw Q3 | ~22 min (measured 2026-11-03, phase 1) | history walk; dominated by 5xx retries |
| MCP tool call | returns in < 30 s, else a job handle | Codex `tool_timeout_sec` default 60 |
| MCP server start | < 2 s when installed | Codex `startup_timeout_sec` default 10. A cold `npx -y` download can exceed it, so the Codex guide sets `startup_timeout_sec = 60` or uses a global install. |

## 4. Reliability and failure policy

| Failure | Behaviour |
|---|---|
| SCM 5xx / 429 / truncated body | Broker retry with back-off (the phase-2 policy); a host-wide pause on rate-limit headers |
| Rate budget exhausted mid-freeze | Pooled: stop, keep checkpoints, exit 4 with the resume command, no manifest. Single repo: same mechanism, one repo |
| A TSA is down or slow | Others continue. Fewer than k tokens → record written, `TIMESTAMP NOT TAMPER-PROOF (k′ of k)`. Re-registering is the only remedy (U1) |
| drand unreachable | `sample` exits 2 (as today, "R not yet published / unavailable"); `verify` check 4 SKIP; `--beacon-file` works offline |
| Rekor down (cf. the v1 outage of 2026-10-11 to 10-20) | `--submit` fails and leaves the TSA-stamped record intact; time evidence never depends on Rekor |
| Plugin host crash | The command fails with the plugin's stderr tail; no partial outputs written |
| Ledger API failure in `verify` | Check 7 FAIL with the error, never a silent PASS |
| Clock skew on the signer > tolerance | Register/freeze print `local clock differs from TSA time by X s` and refuse to write a record whose tokens would fail rule 7 |

**Determinism (NFR-R2):** the same SCM state gives a byte-identical manifest. That needs the pinned head (U3), sorted ids and repos, canonical JSON, and no wall-clock fields inside hashed content except the signed times.

## 5. Versioning, compatibility and packaging

### Packages
| Package | Contents | Runtime deps |
|---|---|---|
| `pr-rla` | CLI, core, SDK subpaths (`/provider`, `/ledger`, `/testing`, `/http`), built-in providers and ledgers, trust bundle | `commander`, `yaml`, `drand-client` (unchanged) |
| `pr-rla-mcp` | stdio MCP server | `pr-rla` (exact), `@modelcontextprotocol/server` 2.x, `zod` 4 |
| `integrations/claude-code` | plugin directory (not an npm package) | — |
| `integrations/github-action` | composite action + its own lockfile | `pr-rla` (exact, by integrity) |
| `integrations/gitlab` | CI/CD component | — |
| `pr-rla-provider-gitea`, `examples/ledgers/jira` | examples; own packages | peer `pr-rla` |

- **The npm name `pr-rla` was unclaimed** on 2026-11-03 (`npm view pr-rla` → E404). Claiming it is a public write (founder).
- **Dependency note.** `drand-client` 1.4.2 pulls in isomorphic-fetch, buffer and a bn254 library (2.16 MB). Quicknet verification needs only BLS12-381, which `@noble/curves` 2.4.0 provides alone. Swapping is an owner decision for phase 4, not required for any unit.

### Version table (published in `docs/compatibility.md`)
| Thing | Versioned as | Phase 3–4 value | Breaking change means |
|---|---|---|---|
| npm packages | semver, released together | 0.2.x (phase 3), 0.3.x (phase 4) | any CLI flag or output contract change while < 1.0 is minor |
| `providerApiVersion` | integer | 1 (additive fields only) | a required method or a changed meaning → 2, with a 2-release overlap where the core loads both |
| `ledgerApiVersion` | integer | 1 (additive) | same |
| `HTTP_HELPER_VERSION` | integer | 1 | — |
| record schemas | `pr-rla/<kind>/vN` | registration v2, manifest v2, commitment v2, checkpoint v1, lock v1 | verify must keep reading every schema it ever wrote |
| trust bundle | date-stamped | `2026-11` | anchors are only added; removed ones are kept as historical |
| MCP tool contract | `pr-rla-mcp` semver + output schemas | 0.2.x | renamed tool or removed field → minor (< 1.0), and the plugin pins it |

**Node support:** ≥ 22.13 (permission model stable). The plugin host's network denial needs ≥ 25 and degrades as `06` §2 T6 says. CI integrations use Node 24.
