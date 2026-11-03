# Requirements: pr-rla phases 3–4

## How to read this

- **Inputs.** The approved `ideation/intent-capture/intent-statement.md` and `ideation/scope-definition/scope-document.md`; the feasibility constraint register (FC-nn) and RAID log (RK-nn, AS-nn); the founder's answers in `remaining-design-questions.md` (cited as RQn); and the draft `pr-rla/docs/design/phase-3-4/01-requirements.md`.
- **IDs.** Requirements use stable `FR{n}.{m}` and `NFR{n}` IDs. The draft's own ID is kept in the last column (for example `FR-T4`), so the draft's later documents still map.
- **Pass criterion.** Each requirement says how a test or a reviewer decides pass or fail.
- **vs draft.** *Kept* means unchanged in meaning; *Changed* means the founder's decisions or this review altered it; *Added* means the draft had no such requirement.
- **Build-phase criteria.** A pass criterion that describes the build (FR1.9, FR5.8, FR8.3, and any criterion that says "the build" or "the test suite") applies to the later build. This design round proves only that the design states it.
- **Founder's refinements.** Where a row cites "founder, 2026-11-03", the founder gave that detail directly when reviewing this document.

## Intent analysis

pr-rla lets a team make a bounded, verifiable statement about changes that reached its default branch without a recorded human review, by sampling them reproducibly and having humans review only the sample (intent statement, problem statement). Phases 3–4 make that usable from the CLI, CI and AI assistants on GitHub, GitLab and Bitbucket, and harden it for the first public release (intent statement, success metrics; scope document). All eleven draft units are built in this round (scope document). The work here is design only and refines the existing draft (intent statement, boundary).

## Functional requirements

### FR1 · Tamper-evident time (U1; open question 1)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR1.1 | `register` and `freeze` obtain RFC 3161 tokens over the SHA-256 digest of the signed record from the configured timestamp authorities, and store them in the signed-record file. Only the digest and a nonce leave the machine | A recorded request body contains only the digest and nonce; the tokens are present in the record file | FR-T1; D1 | Kept |
| FR1.2 | `verify` checks each token offline: CMS signature, message imprint, signer certificate with the `timeStamping` EKU, chain to a pinned root, and \|genTime − signed time\| ≤ 10 minutes (the tolerance) + the token's accuracy, which defaults to 60 s when the token states none | Recorded tokens from all eight bundled authorities verify offline. Six tamper fixtures each fail: edited genTime, wrong imprint, foreign root, expired signer, a token 10 min 61 s from the signed time with no stated accuracy, too few tokens for k | FR-T2; RQ10; RQ20 | Kept, numbers stated |
| FR1.3 | Token parsing and CMS verification use a maintained ASN.1/CMS library (for example `pkijs` + `asn1js`), chosen after an evaluation that confirms it parses `TimeStampResp` and verifies CMS `SignedData`. If none qualifies, a hand-written parser is used and the reason is recorded | The evaluation and its outcome are recorded in the functional design; the FR1.2 fixtures pass with whichever is chosen | RQ8 | Changed (the draft hand-wrote the parser) |
| FR1.4 | Time evidence bounds the signed time and does not replace it: `registeredAt` stays the seed-derivation input, so a team cannot move the drand round by choosing which token to present | A fixture with tokens of different genTimes derives the same round | FR-T3; FC-02 | Kept |
| FR1.5 | k-of-n: the registration names how many independent authorities must agree. The default is k = 2, and `init` writes the four default authorities (Sigstore, DigiCert, GlobalSign, Microsoft). Tokens from the same operator count once | With one valid token and k = 2, `verify` reports `TIMESTAMP NOT TAMPER-PROOF (1 of 2)` | FR-T4; D1 | Changed (the draft's default was 1) |
| FR1.6 | With no authority configured, or none reachable, the record is written and every output says `TIMESTAMP NOT TAMPER-PROOF`. There is no fallback to git dates, SCM push times or any other time source | A zero-token fixture prints the line in `status`, `verify` and the certificate; no other time source is read | FR-T5; RQ7 | Kept |
| FR1.7 | Rekor is optional: a v2 entry is written only with the user's `--submit`, and its time comes from the tokens. Rekor v1 records keep verifying through `integratedTime`. The v2 client is tested against the published API and mock servers only; `--submit` says it is unverified against the production log before it writes. The build makes no Rekor write of any kind | Mock-server tests pass; `--submit` prints the warning first; the test suite opens no connection to a Rekor host | FR-T6; D3; RQ19 | Changed (the draft verified the client with a staging entry) |
| FR1.8 | `register` and `freeze` refuse to write a record when the local clock differs from the authorities' time by more than 10 minutes, and print the difference | A fixture skewed by 10 min 1 s is refused with the printed difference; one skewed by 9 min 59 s is accepted | Draft `06` §4; RQ20 | Added (the draft had it only as a failure policy) |
| FR1.9 | Once U1 is built, the build prepares the prospective gh-aw audit configuration and the exact `register` command, and stops. The founder runs `register` | The configuration and command are in the docs; the build makes no registration | RQ24; intent metric 4 | Added |
| FR1.10 | `register` and `freeze` retry an authority for at most 5 minutes (half the tolerance), then stop asking it. Tokens cannot be added to a record later: there is no `--retry-timestamps`, and a record that came out short is fixed by running `register` (or `freeze`) again | A fake clock shows the last request at or before 5 minutes; the CLI has no `--retry-timestamps` option | Draft `05` §U1; RQ20; founder, 2026-11-03 | Kept, restored from the draft |
| FR1.11 | When fewer than k tokens arrive, `register` still writes the record, prints `TIMESTAMP NOT TAMPER-PROOF (n of k)` followed by the exact command to register again, and exits with code 5. `freeze` behaves the same way. With no authority configured at all (FR1.6), the command exits 0 with the warning | A fixture with 1 of 2 tokens writes the record, prints both lines and exits 5; a zero-authority configuration exits 0 | Founder, 2026-11-03; NFR16 | Added |

### FR2 · Plugin trust (U2b; open question 2)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR2.1 | The registration records each plugin's identity: name, source (built-in, package or path), version, content hash and options hash | A registration with an external plugin carries all five fields | FR-P1 | Kept |
| FR2.2 | `pr-rla.lock.json` pins every external plugin: package version, npm lockfile integrity and a tree hash of the installed files. A mismatch at load refuses to run | A tampered installed file is refused at load | FR-P2 | Kept |
| FR2.3 | A plugin enters the lock only through an explicit `pr-rla plugin add`, which prints the source, version and integrity it is trusting. `register` never creates or extends the lock | `register` with an unlocked external plugin refuses and names `plugin add` | RQ13 | Changed (the draft also locked implicitly at the first `register`) |
| FR2.4 | External plugins run out of process by default, in a host with a scrubbed environment; credentials reach them only as placeholders the parent's broker swaps for real tokens on declared hosts. The security model states the limit plainly: on Node 22 and 24 the host cannot block network, so a malicious plugin can still send repo data out | A hostile fixture plugin cannot read `GITHUB_TOKEN`; the security model contains the limit. On Node 25 or later, a test shows the host's child process cannot open a network connection; it is marked unverified until it has run | FR-P3; RQ14; RK-02; founder, 2026-11-03 | Kept, limit made explicit |
| FR2.5 | `trust: full` (in process, real environment) is an explicit per-plugin opt-in, recorded in the registration and printed by `verify` | `verify` prints `PLUGIN TRUST: full` for such a plugin | FR-P4 | Kept |
| FR2.6 | `--plugins builtin-only` and `PR_RLA_PLUGINS=builtin-only` refuse all external code | An external plugin is refused under either switch | FR-P5 | Kept |
| FR2.7 | `pr-rla plugin check <spec>` runs the conformance kit against the plugin through the host and reports integrity, host allowlist and npm signature status. The kit is presented as a correctness gate, never a safety gate | The Gitea plugin passes through the host; the output wording says "correctness" | FR-P6 | Kept |

### FR3 · MCP server and assistants (U5, U6; open question 3)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR3.1 | A stdio MCP server, shipped as the separate `pr-rla-mcp` package pinned to an exact `pr-rla` version, exposes eight read-only tools: `audit_list`, `status`, `draws`, `draw_context`, `verify`, `simulate`, `freeze_preview`, `job_status`. Issuing draws stays CLI-only | The MCP conformance test lists exactly these tools | FR-M1; RQ11; RQ12 | Kept |
| FR3.2 | The server writes nothing: no files anywhere on disk, no ledger events, no non-read HTTP requests, enforced by a transport guard. All its state, including job state, lives in memory | Every tool leaves the audit directory byte-identical, the server process opens no file for writing, and the broker sees zero non-read requests | FR-M2; founder, 2026-11-03 | Kept, job state placed in memory |
| FR3.3 | No MCP tool, prompt or skill records, edits or removes a verdict, issues draws, or submits to a public log | Covered by FR3.2's test plus a review of the tool list | FR-M3 | Kept |
| FR3.4 | `draw_context` returns the draw's diff (generated files dropped when `exclude_generated`), description, CI results, protocol checklist and verdict state, and backs `pr-rla draw-context <n>` | On a recorded gh-aw draw, `linguist-generated` files are absent | FR-M4 | Kept |
| FR3.5 | Long calls (`freeze_preview` and online `verify`) report progress and return within 30 s, or return a job handle that `job_status` follows. Job state lives in memory only: after a server restart a handle is unknown, and `job_status` says to re-run the call. A finished `freeze_preview` result is cached in memory for 10 minutes | On slow fixtures, both calls return a handle; after a restart, `job_status` on the old handle says to re-run; a repeat `freeze_preview` within 10 minutes returns the cached result | FR-M5; draft `06` §3; founder, 2026-11-03 | Kept, online `verify` restored, job state defined |
| FR3.6 | The same server works unchanged in Claude Code, Codex and Cursor. The founder checks each client by hand and the run is recorded in BUILD-NOTES | Three dated entries in BUILD-NOTES | FR-M6; RQ2 | Kept |
| FR3.7 | A Claude Code plugin carries the `review-draw` skill, the MCP server configuration and hooks that block verdict writes and `--submit` from the assistant. Codex and Cursor get setup guides | Hook tests: ten blocked and ten allowed commands | FR-M7; scope (U6 is Must) | Kept |
| FR3.8 | Every verdict reports its provenance: `self-asserted`, `account` or `presence`. A registration can require a minimum. The default minimum is `account` when an issue ledger is configured, and `self-asserted` with the git-file ledger. The level is printed on every certificate. The `presence` level is defined in FR9 | A git-file audit prints `VERDICT PROVENANCE: self-asserted`; an issue-ledger audit rejects a self-asserted verdict | FR-M8; D7 | Changed (the draft's default was `self-asserted` everywhere) |
| FR3.9 | Text taken from the SCM (diffs, descriptions, commit messages) is marked as untrusted data wherever `draw_context` hands it to an assistant | `draw_context` output wraps that text in the documented untrusted-content fence | Draft `06` T8; RK-10 | Added (the draft had it only as a threat control) |

### FR4 · Issue-tracker ledgers (U4; open question 4)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR4.1 | Built-in `github-issues` and `gitlab-issues` ledgers: `publishDraws` opens one issue per draw in draw order; verdicts are labels | A mock-server run opens issues in draw order | FR-L1 | Kept |
| FR4.2 | Verdicts come from the label event history, not current labels: the first verdict-label event per change counts, and its actor and server time become `reviewer` and `recordedAt` | A timeline with a later opposite label still reports the first verdict | FR-L2 | Kept |
| FR4.3 | `verifyIntegrity` reports every removal, re-add, swap, label edit, issue deletion or transfer, and app-applied verdict. Removal after counting is a FAIL; removal before any other event followed by a re-add is a WARN | One fixture per case gives the stated result | FR-L3 | Kept |
| FR4.4 | Ledger checkpoints: `status` and CI can append a hash of the verdict-event list to `audit/<window>/ledger-checkpoints.jsonl`, optionally time-stamped. Appends from different clones resolve through git: fetch, rebase, re-append, and retry at most 3 times, never force-pushing. Lines with identical hashes are de-duplicated on read | A deleted event shows as a checkpoint mismatch. Two clones appending at once both land after a rebase, with no force-push. A file with a repeated line reads as one checkpoint | FR-L4; corner sweep; founder, 2026-11-03 | Changed (cross-clone concurrency added) |
| FR4.5 | Jira ships as an external example ledger using a single-select custom field read through the changelog API | The example passes the ledger conformance kit | FR-L5; RQ21 | Changed (the field was a recommendation) |
| FR4.6 | A ledger conformance kit, `runLedgerConformance`, ships in `pr-rla/testing` | The built-in ledgers and the Jira example pass it | Draft `04` §U4 | Added (it was scope, not a requirement) |
| FR4.7 | Label-event fixtures come from read-only recordings of existing public issue timelines where they exist, otherwise from synthetic data and mock servers; each fixture says which it is | Every ledger fixture carries a `recorded` or `synthetic` marker | D8; AS-04 | Added |
| FR4.8 | The issue ledgers honour the provider's self-hosted base URL: GitHub Enterprise Server for `github-issues`, GitLab self-managed for `gitlab-issues` | Against mock servers at a non-default base URL, both ledgers publish and read verdicts there | Founder, 2026-11-03 | Added |

### FR5 · Org-pooled audits (U8; open question 5)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR5.1 | A registration may name a repo set: an explicit list, or an org, group or workspace rule (include and exclude globs, archived and fork flags), registered and resolved at freeze | A rule resolves to the same list on two runs over the same state | FR-O1 | Kept |
| FR5.2 | The pooled population is the union of per-repo populations under one selector; the manifest records stable repo ids and each repo's head SHA | The manifest lists every repo with its head | FR-O2 | Kept |
| FR5.3 | One certificate per org and window; per-repo counts are descriptive only | One certificate is produced | FR-O3 | Kept |
| FR5.4 | Freeze is all-or-nothing and resumes from checkpoints | A killed and resumed freeze of a synthetic 40-repo org gives a manifest byte-identical to an uninterrupted run | FR-O4 | Kept |
| FR5.5 | One per-host rate governor serves all repos and plugins; `freeze --dry-run --estimate` predicts requests and wall time | On the synthetic 40-repo org, the predicted request count is within ±20% of the actual count, and the predicted wall time within ±50% of the actual (wall time also depends on retries) | FR-O5; founder, 2026-11-03 | Kept, bound stated |
| FR5.6 | One provider per pooled registration; a mixed-provider pool is refused at `register` | A two-provider pool is refused with the reason | RQ15 | Added (the draft had it only in `05`) |
| FR5.7 | Defaults: archived repos and forks excluded, every visibility the token can see included, 4 repos frozen in parallel. There is no `--skip-repo` | The defaults appear in the resolved set; the flag does not exist | RQ16 | Added |
| FR5.8 | The org-pooled freeze is built in this round, before the first public release | It appears in the build order | Scope document | Changed (the draft and the vision deferred it to v0.2) |

### FR6 · CI integrations (U7)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR6.1 | GitHub Action: runs `status` (and `verify --offline`) on verdict events, writes the job summary, fails on ESCALATE (exit 2), optionally comments on the audit issue | Fixture events give the right job outcome | FR-C1 | Kept |
| FR6.2 | GitLab CI/CD component with typed inputs, triggered by pushes to `audit/**` and by a schedule | Schema checks pass in the test suite | FR-C2 | Kept |
| FR6.3 | Bitbucket Pipelines: a documented step, no Docker pipe | The step passes schema checks | FR-C3; RQ22 | Kept |
| FR6.4 | Every integration pins the pr-rla version and runs with `--plugins builtin-only` unless the user opts in | Each template contains an exact version and the switch | FR-C4 | Kept |
| FR6.5 | Every CI integration is tested on fixtures and mock servers only: no scratch repos, no runs against real repos | The test plan names no real repo for CI | D8 | Changed (the draft used scratch repos and `act`) |
| FR6.6 | Publishing the GitLab component to the CI/CD Catalog waits for the founder | No publish step runs in the build | RQ22 | Kept |
| FR6.7 | The end-to-end matrix names the ledger that completes metric 3 on each SCM: `github-issues` on GitHub, `gitlab-issues` on GitLab, and on Bitbucket `git-file`, or the Jira example where the team uses Jira | The matrix in the test design has one ledger per SCM row, and each row passes on fixtures | Intent metric 3; founder, 2026-11-03 | Added |

### FR7 · Phase 1–2 carry-overs (U3)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR7.1 | A registered bot list (`selector.bots`) is applied by the core to every actor on every provider | On recorded gitlab-org/cli data, `bots: ["gitlab-bot"]` moves exactly 4 MRs into the stratum | FR-X1; D4 | Kept |
| FR7.2 | Pinned head: the manifest records the default-branch head SHA, and `ListChangesRequest.head` makes `verify` walk the same history | A synthetic commit pushed after freeze no longer fails check 5 | FR-X2; RK-09 | Kept |
| FR7.3 | `Actor.id`, a stable account id; selectors can match `id:<n>` | A renamed user stays the same actor in `verify` | FR-X3 | Kept |
| FR7.4 | The SDK defines one review object; each provider declares `reviewGranularity`, recorded in the manifest | The kit's `review-granularity` check passes on every built-in | FR-X4 | Kept |
| FR7.5 | `pr-rla/http`, the retrying, rate-limit-aware fetch, exported under its own version | The export exists with its own version constant | FR-X5 | Kept |
| FR7.6 | `ChangeRecord.landedVia` and the selector option `direct_push_via_merge: include \| exclude`, default `include`; the certificate names the choice | On recorded bamboo-specs data, `exclude` removes the release-branch commits from the stratum | D5; draft `02` Q4 | Added (the draft's FR list missed it) |
| FR7.7 | Every new SDK field is optional, within provider API version 1 | The phase-2 providers pass unchanged | RQ18; FC-06 | Kept |

### FR8 · Documentation and release engineering (U10)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR8.1 | README, concepts, statistics explainer, "write a provider", "write a ledger", a CI guide per SCM, Claude Code / Codex / Cursor setup, security model, compatibility table, CONTRIBUTING, CHANGELOG, and SECURITY.md with a placeholder contact | Every listed doc exists | FR-D1; D10 | Kept, compatibility table and SECURITY.md named |
| FR8.2 | Every doc that shows output shows real output from a command that was run, with its date | A doc check finds no undated output block | FR-D2 | Kept |
| FR8.3 | Release engineering without publishing: `npm pack --dry-run` lists only `dist/`, README and CHANGELOG; the secret grep over the tarball is clean; a release checklist exists | All three hold | Draft `04` §U10; FC-15 | Added (it was unit acceptance only) |

### FR9 · Presence-attested verdicts (U9)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR9.1 | The git-file ledger option `require_signed` makes every verdict commit carry an SSH signature (SSHSIG) | With `require_signed` set, an unsigned verdict commit fails check 7 | Draft `04` §U9; founder, 2026-11-03 | Added (it was unit scope only) |
| FR9.2 | pr-rla verifies SSHSIG commit signatures in TypeScript over `node:crypto` for `ed25519`, `ed25519-sk` and `ecdsa-sk` keys, and for `-sk` keys checks the FIDO user-presence (UP) flag itself | The FR9.5 fixtures give their stated results, and the outcomes are cross-checked against `ssh-keygen -Y verify` | Draft `04` §U9; RK-12 | Added |
| FR9.3 | The registration lists the reviewers whose signatures count, as an allowed-signers list | A verdict signed by a key not on the list fails | Draft `04` §U9 | Added |
| FR9.4 | Check 7 enforces the registered `minProvenance`: a verdict below the minimum fails | A `self-asserted` verdict fails under `minProvenance: account` | Draft `04` §U9; FR3.8 | Added |
| FR9.5 | Four fixtures cover the path: an `-sk` signature with UP set (passes at `presence`), one with UP clear (fails at `presence`), an unlisted signer (fails), and an unsigned verdict under `require_signed` (fails). All are made with software keys, including a software-emulated authenticator for the `-sk` fixtures | Each fixture gives its stated result | D7; founder, 2026-11-03 | Added (the draft used a real FIDO key) |
| FR9.6 | Software-key fixtures prove the verifier logic, not that a human touched a hardware key. Until a real FIDO key has been used, no doc or certificate claims hardware-verified presence | A text check over the docs and certificate templates finds no claim of hardware-verified presence | D7; RK-01; founder, 2026-11-03 | Added |

### FR10 · Fetch broker (U2a)

| ID | Requirement | Pass criterion | Source | vs draft |
|----|-------------|----------------|--------|----------|
| FR10.1 | Every built-in provider, ledger and the MCP server make their HTTP calls through one broker (`ctx.fetch`) | The phase-2 suite passes unchanged with the broker in place | Draft `04` §U2a | Added (it was unit scope only) |
| FR10.2 | The broker retries with exponential backoff and jitter on 429, 5xx, timeouts and truncated bodies, honouring `Retry-After` and rate-limit reset headers; the phase-2 retry policy carries over | Fault-injection fixtures retry and then succeed or fail as the policy says | Draft `04` §U2a; draft `02` Q8 | Added |
| FR10.3 | Under the read-only guard, any request that is neither a read (`GET`, `HEAD`) nor a GraphQL query throws `ReadOnlyViolation` | A guarded `POST` mutation throws | Draft `04` §U2a; FR3.2 | Added |
| FR10.4 | One rate governor per host is shared by every caller (repos, plugins, MCP). Server-reported rate-limit headers win over the defaults in NFR12 | Two parallel callers on one host share one budget under a fake clock; a header lower than the default slows the pace | Draft `04` §U2a; founder, 2026-11-03 | Added |
| FR10.5 | Credentials are swapped in only for declared hosts; a request to any other host carries none | A request to an undeclared host has no `Authorization` header | Draft `04` §U2a; FR2.4 | Added |

### Unit coverage

Every unit maps to at least one requirement:

| Unit | Requirements |
|------|--------------|
| U1 Trusted time | FR1.1–FR1.11 |
| U2a Fetch broker | FR10.1–FR10.5, NFR12, NFR14 |
| U2b Plugin lock and host | FR2.1–FR2.7 |
| U3 SDK carry-overs | FR7.1–FR7.7 |
| U4 Issue ledgers | FR4.1–FR4.8 |
| U5 Audit API, draw-context, MCP | FR3.1–FR3.6, FR3.9 |
| U6 Assistant integrations | FR3.7 |
| U7 CI integrations | FR6.1–FR6.7 |
| U8 Org-pooled freeze | FR5.1–FR5.8 |
| U9 Presence-attested verdicts | FR3.8, FR9.1–FR9.6 |
| U10 Docs and release | FR8.1–FR8.3, NFR18, NFR19 |

## Non-functional requirements

| ID | Area | Requirement | Pass criterion | Source | vs draft |
|----|------|-------------|----------------|--------|----------|
| NFR1 | Least privilege | `freeze`, `verify` and MCP need read-only scopes; ledger writes need write access to the audit repo or project only. The docs give the exact scopes per SCM, as the draft lists them, each marked unverified until exercised read-only or on a mock server | The scope table exists with a verified/unverified marker per row | NFR-S1; RQ9; RK-08 | Changed |
| NFR2 | Secrets | Tokens come only from the environment and never appear in manifests, ledgers, fixtures, logs, MCP results or error messages | A grep over every artifact, fixture and the npm tarball finds no token | NFR-S2; FC-11 | Kept |
| NFR3 | No public writes | Rekor, issues and npm writes need an explicit flag plus a human action, and assistant hooks block those flags. The build itself makes no Rekor write and no write to any real repo | Hook tests pass; the test suite has no Rekor host and no real-repo write | NFR-S3; D3; D8 | Changed |
| NFR4 | Honest output | Every weakened guarantee is printed where it applies: `TIMESTAMP NOT TAMPER-PROOF`, `PLUGIN TRUST: full`, `VERDICT PROVENANCE: <level>`, and the Rekor v2 warning | Each line appears in its fixture's output | NFR-S4; FR1.7; FR3.8 | Changed |
| NFR5 | Resumable | Freeze survives rate limits and transient faults, and an org freeze resumes from checkpoints | FR5.4's test | NFR-R1 | Kept |
| NFR6 | Deterministic | Two runs over the same SCM state give byte-identical manifests | The kit's stable-ids check and FR5.4 | NFR-R2 | Kept |
| NFR7 | Compatibility | v1 records still verify after this round; new records use schema v2 | The existing v1 E2E still prints 7/7 | NFR-C1 | Kept |
| NFR8 | Versioning | The first public release is v0.1.0 and carries all eleven units; it starts the gh-aw clock. Below 1.0 a CLI or output change is a minor version. A new provider API version keeps a two-release overlap. The HTTP helper and record schemas are versioned separately in the compatibility table | The compatibility table states each rule | NFR-C2; RQ17 | Changed (the draft numbered phases 0.2.x and 0.3.x) |
| NFR9 | Dependencies | Core runtime dependencies: `commander`, `yaml`, `drand-client`, plus the ASN.1/CMS library chosen under FR1.3. The MCP server's dependencies stay in `pr-rla-mcp` | `npm ls --prod` on the core lists only these and their dependencies | NFR-P1; RQ8; RQ23; FC-05 | Changed |
| NFR10 | Performance | On fixtures, offline: `status --offline` < 1 s; `verify --offline` < 2 s for N ≤ 10,000; `draw_context` < 2 s; MCP server start < 2 s when installed. Live `draw_context` timing on GitHub is recorded in BUILD-NOTES as an observation, not a pass criterion | Timed in the test suite on fixtures, offline | NFR-P2; draft `06` §3; founder, 2026-11-03 | Changed (`draw_context` is timed offline) |
| NFR11 | Testability | Every external API is exercised on recorded fixtures offline, plus one read-only live run per SCM where a public target exists. Live tokens come from all eight bundled authorities with hashes only. Write paths use fixtures and mock servers only | The test plan lists each external API with its fixture source | NFR-T1; RQ10; D8 | Changed |
| NFR12 | Rate budgets | Each default equals the smallest limit the provider publishes, as listed in the rate-budget table below. Every limit can be raised in `.pr-rla.yml`, and server-reported rate-limit headers always win (FR10.4) | A test asserts every default equals its table value, and a second test raises one through configuration and the broker follows it | RQ1; RK-07; founder, 2026-11-03 | Added |
| NFR13 | Runtime | Node.js `>= 22.13`. The plugin host's network denial needs Node 25 or later, and its degraded behaviour below that is stated (FR2.4) | `engines.node` reads `>=22.13` | D6; FC-04 | Changed (the draft's C-4 said ≥ 22) |
| NFR14 | Reliability | Every network call has a timeout, and a failure degrades only the feature that needs it. Timestamp authority: 15 s per request (draft `06` §3). SCM request: 30 s, the MCP tool budget (FR3.5), so one stalled request cannot overrun a tool call; GitHub itself ends requests that take more than 10 s to process (GitHub REST API docs, "Timeouts"), so 30 s leaves room for the response to transfer | A hanging mock server times out at 15 s (authority) and 30 s (SCM) | Draft `06` §3–4; corner sweep; founder, 2026-11-03 | Added |
| NFR15 | Reliability | Every audit file pr-rla writes is written to a temporary file and renamed into place, so an interrupted command leaves the previous file intact | A kill-during-write test finds the old file whole | Corner sweep | Added |
| NFR16 | Operability | Exit codes are a documented, stable contract in the compatibility table. The phase 1–2 codes keep their meaning: 0 success; 1 `verify` FAIL or a refused plugin; 2 ESCALATE, R not yet published, or an assistant hook block; 3 population below the minimum; 4 stopped and resumable. One code is added: 5, record written without enough timestamps (FR1.11) | The table exists and every command's tests assert their codes | BUILD-NOTES; draft `05`, `06` §4; founder, 2026-11-03 | Added |
| NFR17 | Operability | Every error names the failing host or command, the reason and the next step; verbose output never prints credentials | Error fixtures match the documented form; NFR2's grep covers verbose logs | Corner sweep | Added |
| NFR18 | Supply chain | Integrations pin exact pr-rla versions and install by lockfile integrity; releases use npm trusted publishing with provenance, run by the founder | Each integration template pins a version; the release checklist names provenance | Draft `06` T12; RQ22 | Added |
| NFR19 | Platforms | macOS and Linux are supported and tested. Windows is untested, and the README says so | CI and local runs cover macOS and Linux; the README states the Windows status | Founder, 2026-11-03 | Added |

### Rate-budget defaults (NFR12)

Each value is the smallest limit the provider publishes, from vendor documentation as recorded in the draft's `06` §3 (checked 2026-11-03). Two values the draft did not record are marked to confirm in NFR design rather than guessed.

| Service | Default | Published limit it comes from |
|---------|---------|-------------------------------|
| GitHub REST, reads | 1,000 requests/h per repo | `GITHUB_TOKEN`: 1,000/h per repo (personal tokens get 5,000/h) |
| GitHub REST, content-creating writes | 80 per minute and 500 per hour | Secondary limits: 80 content-creating requests/min and 500/h |
| GitHub REST, concurrency | 100 in flight | Secondary limit: 100 concurrent requests |
| GitHub GraphQL | 5,000 points/h and 2,000 points/min | 5,000 points/h; 2,000 points/min secondary. To confirm in NFR design: whether `GITHUB_TOKEN` gets a lower GraphQL budget |
| GitLab.com API | 2,000 requests/min per user | Authenticated API: 2,000/min per user. To confirm in NFR design: the unauthenticated limit |
| Bitbucket Cloud | 1,000 requests/h authenticated; 60/h anonymous | `/2.0/repositories/*`: 1,000/h; anonymous 60/h |
| Bitbucket Data Center | burst 60, refilling 5 per second | The admin-configurable default token bucket: 60 with 5/s refill, per user |
| Jira Cloud, writes per issue | 20 per 2 s and 100 per 30 s | Per-issue write limits: 20/2 s and 100/30 s |
| Sectigo timestamp authority | one request per 15 s | Sectigo asks for at least 15 s between scripted requests |
| FreeTSA | one request per second | 1/s per IP |
| Other timestamp authorities, drand | one request per record or round | No published limit; pr-rla never loops on them |

## Constraints

The full set is `ideation/feasibility/constraint-register.md` (FC-01 to FC-29). The ones requirements lean on most:

- The statistics, seed derivation and seven `verify` checks are fixed (FC-01 to FC-03).
- Changes stay additive within provider and ledger API version 1 (FC-06).
- No public or permanent write without the founder (FC-15); no Rekor write in this round (FC-16).
- Write paths are tested on fixtures and mocks only (FC-17); there is no FIDO key (FC-14).
- Design only; the work stops before Code Generation (FC-21).

## Assumptions

| ID | Assumption | Why |
|----|------------|-----|
| AS-01 | The phase 1–2 code and its 144 tests are the baseline | Intent statement; BUILD-NOTES |
| AS-02 | The drand League of Entropy stays threshold-honest | Draft threat T15 |
| AS-03 | At least 2 of the 4 default timestamp-authority operators are honest | Draft threat T3; FR1.5 |
| AS-04 | Reading existing public issue timelines is a read path, allowed under D8 | Confirmed by the founder (project rule) |
| AS-05 | CI integrations run on Node 24 | Draft `06` §5 |
| AS-06 | A maintained ASN.1/CMS library that handles RFC 3161 exists (`pkijs` + `asn1js` is the first candidate); FR1.3 falls back if not | RQ8 |

## Out of scope

From `ideation/scope-definition/scope-document.md`: code generation and the build; redesigning the statistics, seed derivation or `verify` checks; redesigning the phase 2 providers; any public or permanent write; live write tests and scratch repos; testing presence with a real FIDO key; the paid tier; a hosted backend; built-in providers for Azure DevOps and internal SCMs (reached through the SDK).

## Open questions for later stages

None needs the founder now. These are settled during design:

- Which ASN.1/CMS library passes the FR1.3 evaluation (functional design, U1).
- Whether `GITHUB_TOKEN` gets a lower GraphQL budget, and GitLab.com's unauthenticated limit (NFR design; rate-budget table).
- The software-emulated authenticator used for the `-sk` fixtures (functional design, U9; FR9.5).

## Success metrics, traced

| Metric (intent statement) | What this phase does | Requirements |
|---------------------------|----------------------|--------------|
| A third-party provider passes the kit using only the public SDK | Already met by phase 1–2; reviewed | FR2.7, FR7.7 |
| GitHub, GitLab and Bitbucket pass the same kit, no double counting | Already met by phase 1–2; reviewed | FR7.2, FR7.6, NFR6 |
| End to end from CLI, CI and MCP on each SCM | The fixture-based test matrix is specified here, with one ledger per SCM; proof in the build | FR3.1–FR3.7, FR6.1–FR6.7, NFR11 |
| Prospective gh-aw certificate about 7 weeks after v0.1 | Enabled: the timing proof stands on the authorities alone | FR1.1–FR1.9, NFR8 |

## Review record: what this stage kept, changed and added

- **Kept.** 45 of the draft's requirements, renumbered to `FR{n}.{m}` and `NFR{n}` with the draft's ID alongside.
- **Changed (from the founder's decisions).**
  - k defaults to 2 (FR1.5).
  - No Rekor writes, and a labelled v2 client (FR1.7).
  - An ASN.1/CMS library instead of a hand-written parser (FR1.3).
  - The lock is created only by an explicit `plugin add` (FR2.3).
  - The default provenance is `account` where an issue ledger exists (FR3.8).
  - The Jira field (FR4.5).
  - The org-pooled freeze is built this round (FR5.8).
  - CI is tested on fixtures and mocks (FR6.5).
  - Unverified scopes are marked (NFR1).
  - Versioning (NFR8).
  - Dependencies (NFR9).
  - Testability (NFR11).
  - Node 22.13 (NFR13).
- **Restored from the draft.** No late tokens; re-register to fix a short record (FR1.10). Online `verify` under the client timeout (FR3.5).
- **Added.**
  - Requirements the draft had only as unit scope or threat controls:
    - the presence path (FR9);
    - the fetch broker (FR10);
    - FR1.8, FR3.9, FR4.6, FR5.6, FR5.7, FR8.3, NFR16 and NFR18.
  - One it missed: `direct_push_via_merge` (FR7.6).
  - From the founder's decisions:
    - the gh-aw registration hand-off (FR1.9);
    - the fewer-than-k behaviour and exit code 5 (FR1.11);
    - public-timeline fixtures (FR4.7) and self-hosted base URLs for the issue ledgers (FR4.8);
    - a ledger per SCM for metric 3 (FR6.7);
    - the in-memory MCP job state (FR3.2, FR3.5);
    - the Node 25 network check (FR2.4);
    - cross-clone checkpoint appends (FR4.4);
    - rate defaults taken from published limits (NFR12);
    - stated timeouts (NFR14);
    - the estimate error bound (FR5.5);
    - offline `draw_context` timing (NFR10);
    - supported platforms (NFR19).
  - Gaps from the corner-case sweep: atomic writes (NFR15) and error form (NFR17).
  - A unit coverage table, so every unit has at least one requirement.
