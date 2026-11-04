# Functional Design: pr-rla phases 3–4 (all units, stage-major)

**Stage:** Functional Design. This refines the draft's `pr-rla/docs/design/phase-3-4/05-functional-design.md` unit by unit. The units appear in build order: U1, U2a, U4, U2b, U3, U5, U7, U6, U8, U9, U10.

Each unit says what is **kept** from the draft (by section), what is **changed** and what is **added**. Kept text stays authoritative as written in `05`. Only the changes and additions are spelled out here, in enough detail to build without re-deciding anything. Contracts are in `contracts.md`; NFR numbers are in `nfr-design.md`.

Several open review points from the approved stages are resolved here: requirements R-09 to R-12 and domain design R-01 to R-07. Each is marked where it is fixed.

## U1 · Trusted time

**Kept from `05` §U1:**
- "What changed upstream" (the Rekor v2, Rekor v1 and Sigstore TSA facts).
- Decisions 1–4: the signed time is the seed input, tokens bound it, k-of-n operators, Rekor optional.
- The token acceptance rules 1–7 and the operator grouping with `U_k`.
- The check 1–3 table.
- Offline `publishTime(R)`.
- The trust bundle table (eight authorities; defaults `sigstore, digicert, globalsign, microsoft`; k = 2), and the exclusion of Apple.
- HTTP accepted for DigiCert and GlobalSign; `certReq: true`; a 64-bit nonce; parallel requests.
- `scripts/update-trust-bundle.mjs` and `verify --tsa-trust`.
- Roughtime and OpenTimestamps stay out.

**Changed:**

1. **Parser: evaluate a library first (FR1.3, RQ8).** This replaces "Parser footprint". The evaluation is the first task of U1 and its result goes in BUILD-NOTES.
   - **Candidate:** `pkijs` + `asn1js` (the draft measured `pkijs` 4.0.1 at 926 KB with three dependencies). Others may be added if they meet the bar.
   - **Accept a library only if all of these hold:**
     - it parses `TimeStampResp` and `TimeStampToken`, and CMS `SignedData` with signed attributes;
     - it verifies the signature over the DER `signedAttrs` for RSA PKCS#1 v1.5, RSA-PSS, and ECDSA P-256 and P-384;
     - it is ESM-importable on Node 22.13;
     - it had a release in the last 12 months and has no unaddressed security advisory;
     - its installed size and dependency count are recorded.
   - **pr-rla still enforces these rules itself**, on the library's parsed structures, because the draft found libraries do not check them: rule 2 (nonce), rule 4 (ESSCertID), rule 5 (EKU exactly `timeStamping` and critical), rule 6 (chain to a pinned root, valid at genTime) and rule 7 (tolerance). Rule 1 and the signature part of rule 3 may come from the library.
   - **If no library qualifies,** build the draft's hand-written DER walker, and record which criterion failed.
   - **Correctness oracle (kept):** `openssl ts -reply -text` and `openssl ts -verify` on recorded tokens from all eight authorities.
2. **Requests go through the broker** with `destination: "tsa"` (ADR-002).
   - **One retry owner.** The broker's `tsa` policy is the single owner of retries for timestamp requests: each attempt has a 15 s timeout, with backoff until a 5-minute per-request deadline (`toleranceSeconds / 2`). After the deadline the authority is dropped. U1 itself does not loop.
   - **Before bolt 2.** U1 uses the minimal adapter from `contracts.md` §2, which implements the same `tsa` policy. Bolt 2 replaces the adapter with the broker, and the same tests pass unchanged.
   - **Spacing.** Sectigo is spaced at ≥ 15 s between requests and FreeTSA at ≤ 1 per second (`nfr-design.md` §3).
3. **Outcome when tokens fall short (FR1.11; requirements finding R-11).**

   | Situation | Record written? | Output | Exit |
   |-----------|-----------------|--------|------|
   | ≥ k operators accepted | yes | `timestamps: n of N TSAs (…) · k = 2 · PROVEN` | 0 |
   | 1 ≤ accepted < k | yes | `TIMESTAMP NOT TAMPER-PROOF (n of k)` and `to make it tamper-proof, register again before anything is shown to anyone: pr-rla register --force` | 5 |
   | authorities configured, none reachable | yes | `TIMESTAMP NOT TAMPER-PROOF (0 of k)` plus the same command | 5 |
   | `timestamping.authorities: []` | yes | `TIMESTAMP NOT TAMPER-PROOF` | 0 |

   `freeze` uses the same table, with `pr-rla freeze --force` as the command. Tokens are never added to a written record: there is no `--retry-timestamps` (FR1.10).
4. **Clock-skew refusal (FR1.8).**
   - **Rule.** Before writing, take the median genTime of the obtained tokens and compare it with the signed time. If they differ by more than 600 s (no accuracy term, exactly as FR1.8 states), refuse with `local clock differs from timestamp authority time by <s> s; fix the clock and run again`, and exit 1.
   - **Why stricter.** This is stricter than rule 7, which adds the token's accuracy. A clock that far off is refused even when a token would still pass.
   - **No tokens.** Skew cannot be measured, so the table in item 3 applies.
   - **Tests.** A fixture skewed by 10 min 1 s is refused; one skewed by 9 min 59 s is accepted.
5. **Rekor (FR1.7; D3; RQ19).** This replaces "First real Rekor submission".
   - There is no staging or production entry in the build. The v2 client is built from rekor-tiles `CLIENTS.md` and tested against a mock server that implements the documented request and response, including the inclusion proof and signed checkpoint.
   - `--submit` with `--rekor-api v2` prints, before any network call: `Rekor v2 client: tested against the published API and a mock log only, not the production log. This entry will be public and permanent.` It then requires `--yes`, or an interactive confirmation.
   - v1 behaviour is kept.

**Added:**
- **The gh-aw prospective hand-off (FR1.9; RQ24).** Once U1's tests pass, the build prepares the registration and stops; the founder runs `register`, and nothing in the build calls it.
  - **Files.** The build writes `audits/gh-aw-prospective/.pr-rla.yml` and the exact command `pr-rla -C audits/gh-aw-prospective register` into `docs/gh-aw-prospective.md`.
  - **What the registration fixes.** Because it is signed before later units exist, it fixes exactly:
    - `repos: {kind: "repo", repo: "github/gh-aw"}`;
    - the phase-1 selector with `bots: []` and `direct_push_via_merge: "include"`, which behave exactly as phase 1 did;
    - the default parameters;
    - the four default authorities, k = 2;
    - `plugins.provider` = the built-in `github` provider at the registering version;
    - `plugins.ledger` = `git-file`;
    - `verdicts.minProvenance: "self-asserted"` and `reviewers: null`;
    - a window that opens after the registration's expected `U_k`.
  - **Freezing.** `freeze` must run with a build that includes U3 (the pinned head), so the population is reproducible. U3 is bolt 5, well inside the 7-week window.
  - **Version check.** `verify` prints the registering and freezing pr-rla versions. Check 5 rebuilds the population with the freezing provider identity. Any later change to selector or population semantics is a new registration, never a silent change.
  - **Consequence to note.** A registration made right after U1 uses `git-file`, so the gh-aw certificate's provenance is `self-asserted`. Registering after U4 instead (about 6.5 build days later) would allow the `github-issues` ledger and `account` provenance. The founder chose "as soon as U1 is built"; this design keeps that choice and records the trade-off.
- **Composite token identity:** (`tsa`, `serial`), as in `contracts.md` §5 (domain design finding R-06).

## U2a · Fetch broker

**Kept from `05` §U2a:** the pipeline (allowlist, read-only guard with the GraphQL tokenizer, credential swap, rate governor, retry policy including the rule for non-idempotent requests, recorder). It is now seven steps with the timeout (`contracts.md` §2). Also kept: `pr-rla/http` for `trust: full` plugins.

**Changed (one retry owner, review finding 3):**
- Built-in providers stop retrying when they move onto the broker: their `createJsonClient` is constructed with `maxRetries: 0` and `fetch: ctx.fetch`. The broker is then the only retrier for every destination.
- The conformance kit's `transient-faults` check runs providers through a broker-shaped harness by default. A provider passes if it recovers with the harness's retries; a third-party provider that brings its own retry still passes.

**Added: the AuditApi foundation (review finding 1).**
- U2a creates `src/api/context.ts`, defining `AuditContext` with `mode`, the broker wiring, and the read-only and read-write split.
- U4, U8 and U9 add their functions to it. U5 then moves the remaining commands onto it and builds the MCP package.
- Atomic writes (`src/io/atomic.ts`) and the exit-code constants (`src/cli/exit-codes.ts`) are created by U1, because bolt 1 already needs them.

**Changed:**
- **The broker serves every destination**: TimeEvidence, Beacon and TransparencyLog as well as providers and ledgers, through the `destination` field and its timeouts (SCM 30 s, TSA 15 s, drand 15 s, Rekor 30 s). See `contracts.md` §2 and ADR-002.
- **Default budgets come from published limits** (`nfr-design.md` §3), not from the draft's fallbacks ("concurrency 4; writes 1/s", "0.25 req/s", "4 req/s, burst 50"). For GitHub, the defaults are:
  - REST reads: 1,000/h per repo;
  - REST points: 900/min, the secondary limit the draft lists (requirements finding R-09);
  - content-creating writes: 80/min and 500/h;
  - concurrency: 100;
  - GraphQL: 5,000 points/h and 2,000 points/min.

  Server-reported headers always win.
- **The recorder is never installed in read-only mode** (domain design finding R-02).
- **Ledger non-read requests must match a declared `writePaths` prefix.** This is where "the audit repo only" is enforced.

**Added:**
- **`BrokerTimeout`** as a typed error, mapped to the CLI error form and the MCP `TIMEOUT` code.
- **A defaults test** asserting every default equals its table row, alongside the override test (NFR12).

## U4 · Issue ledgers and checkpoints

**Kept from `05` §U4:**
- The model: one issue per draw, `ledger-index.json`, idempotent `publishDraws`, configurable verdict labels, the protocol hash in the issue body, `note`.
- Reading verdicts from REST label events on GitHub and `resource_label_events` on GitLab.
- The first-eligible-event rule.
- Eligible reviewers (registered list, no bots, `performed_via_github_app` null).
- The `verifyIntegrity` table.
- The checkpoint rationale and contents.
- The Jira API choices (paged changelog endpoint, e-mail plus API token).
- The ledger conformance kit.

**Changed:**
- **Checkpoint commands (requirements finding R-10).** `pr-rla checkpoint` appends a checkpoint line and its event list atomically. `status --checkpoint` does the same. Plain `status`, and the MCP `status` tool, never append.
- **Cross-clone appends (FR4.4; domain design finding R-01; review finding 7).** `pr-rla checkpoint --push` uses the git transport in `contracts.md` §6:
  - refuse on a dirty tree, detached HEAD or a branch with no upstream;
  - commit the checkpoint on the current branch;
  - fetch, rebase onto the remote branch (never reset), resolving only `ledger-checkpoints.jsonl` conflicts by union, then push;
  - at most 3 attempts, each git call with a 30 s timeout;
  - never force; exit 4 after three rejections.

  Unpushed local commits, such as `git-file` verdict commits, are replayed by the rebase, never discarded. The transport is owned by U4 and runs outside the broker. AuditApi refuses `checkpoint` in read-only mode.
- **Timestamp shortfall on checkpoints (review finding 11).** `checkpoint` uses U1's outcome table: the line is written, `TIMESTAMP NOT TAMPER-PROOF (n of k)` is printed, and the command exits 5 (0 with no authority configured).
- **Issue-ledger checkpoints live in the audit git repo too.** The `github-issues` and `gitlab-issues` ledgers read history from the tracker, and the checkpoint file and event list are committed to the audit repo through the same transport. One mechanism serves every ledger.
- **Jira (FR4.5; RQ21).** The example uses a single-select custom field, "pr-rla verdict" (values `pass`, `fail`), read through `GET /rest/api/3/issue/{key}/changelog`. Labels are not supported in the example.
  - Jira authenticates with Basic auth (e-mail plus API token). In the isolated host the plugin sets `Authorization: prrla-basic:JIRA_EMAIL:JIRA_TOKEN`, and the broker builds the Basic header on declared hosts only (`contracts.md` §2; review finding 8).
- **Write budget.** GitHub issue creation uses the published secondary limits (80/min, 500/h), not the draft's flat 1/s.

**Added:**
- **Self-hosted base URLs (FR4.8).**
  - `github-issues` takes the provider's `base_url`: `https://<host>/api/v3` for REST on GitHub Enterprise Server, with the GraphQL base fixed as in phase-2 finding 12.
  - `gitlab-issues` takes `base_url` for GitLab self-managed.
  - Both declare their hosts and `writePaths` from it.
- **Fixture sources (FR4.7; D8; AS-04).** Every fixture carries `"source": "recorded" | "synthetic"`. Recorded fixtures come from read-only reads of public data, chosen to settle the unverified items where possible:

  | Unverified item | Read-only evidence to record | If none is found |
  |-----------------|------------------------------|------------------|
  | `performed_via_github_app` on GitHub label events | Issue events on a public repo where a GitHub App applies labels (for example a labeler workflow acting as `github-actions[bot]`) | Synthetic; the item stays unverified |
  | GitHub REST keeps the original label name after a rename | A public repo whose label was renamed after use, if one can be identified | Synthetic; stays unverified |
  | GitLab scoped-label swap events | `resource_label_events` on a public gitlab.com issue whose scoped label changed (gitlab-org/gitlab uses scoped `workflow::` labels) | Synthetic |
  | Jira changelog format for a single-select field | A public Jira instance's changelog for a select field change. This shows Data Center's shape only; the Cloud v3 format stays unverified | Synthetic |

  Destructive cases (a deleted issue, a deleted label, a transfer) are always synthetic, because they cannot be produced read-only.
- **Reviewer identity.** Reviewers match by login until U3 lands, then also by `Actor.id`.

## U2b · Plugin lock and isolated host

**Kept from `05` §U2b:**
- The threat statement and the Node permission model facts.
- Design items 1–3: out of process, placeholders only, providers read-only on the wire.
- Items 5–8: registered identity, `trust: full`, `--plugins builtin-only`, `plugin check`.
- The isolation table and the Linux `/proc` note.
- No sandbox is shipped.

**Changed:**
- **Item 4, pinning (FR2.3; RQ13).**
  - Only `pr-rla plugin add <use>` creates a lock entry. It prints the source, version, `resolved`, `npmIntegrity` and `treeSha256` it is trusting, and asks for confirmation (or `--yes`).
  - `register` with an external plugin that has no lock entry exits 1 with `plugin <use> is not locked; review it and run "pr-rla plugin add <use>"`.
  - `plugin lock` re-hashes an already-added plugin after a reviewed change.
- **Node 25 (FR2.4; RK-02).** The first U2b test checks that IPC works under `--permission` without `--allow-net`.
  - If it passes, the child on Node 25 or later runs without network.
  - If it fails, the child gets `--allow-net`, and the security model's Node 25 row says network exfiltration is possible there too.
  - Either way the result is recorded in BUILD-NOTES, and the row stays marked unverified until the test has run.
- **The IPC protocol** is `pr-rla/ipc/v1` (`contracts.md` §3), with heartbeats and a 60 s silence limit.

**Added:**
- **Install-hygiene warning.** `plugin add` prints a warning when the plugin's `package.json` declares install scripts. It does not refuse (RQ14 keeps hygiene documented, not enforced).

## U3 · SDK carry-overs

**Kept from `05` §U3:** `selector.bots`; `direct_push_via_merge` with its `register` warning; the pinned head mechanics; `Actor.id` sources; `reviewGranularity` with its default; `pr-rla/http`; the kit checks `pinned-head`, `actor-ids` and `review-granularity`.

**Changed:**
- `head` and `headSha` are fields of `ListChangesRequest` and `ListChangesResult`, not `ChangeRecord` (domain design finding R-05).

**Ownership of the other definition fields (review finding 5).** `hosts`, `credentials` (provider and ledger) and `writePaths` (ledger) are delivered by U2a, which enforces them. U2b reads them for the host. U3 owns only `populationOptions` and the provider deltas below.

**Added:**
- **`populationOptions` on the provider definition.** It lists the option keys that change the population (for example `base_url`, `bots`, `default_branch`). `populationOptionsSha256` hashes exactly those, and a mismatch FAILs check 5, as the draft's `02` Q3 intended.
- **Kit check `revoked-approval`,** from the draft's `02` Q5: a revoked approval never comes back as `APPROVED`.

## U5 · Audit API, draw-context and MCP server

**Kept from `05` §U5:**
- The API functions and `AuditContext`.
- Read-only mode: write functions sit in a module the MCP package never imports, there is a ledger proxy, and the broker guard is on.
- The `drawContext` field table.
- `describeChange` per provider, and the fallback without it.
- The MCP package, stdio transport and roots.
- The tool table and annotations.
- No elicitation.
- The three-tier guarantee, with the wording change below.

**Changed:**
- **Long calls (FR3.5; requirements finding R-12; review finding 9).**
  - Any tool that makes network calls and is still running at 25 s returns `{ jobId }` and continues in the server process with progress notifications. That covers `draw_context`, online `status`, online `verify` and `freeze_preview`.
  - Jobs and the preview cache live in memory. The cache keeps a finished preview for 600 s, keyed by (window, registration digest, `estimate`).
  - After a restart, `job_status` answers `unknown`, with the re-run hint.
  - A fifth concurrent job is refused with `TOO_MANY_JOBS`. A result over 8 MiB is refused with `RESULT_TOO_LARGE`.
- **Read-only API subpath (review finding 6).**
  - `pr-rla` exports `pr-rla/api/read`, containing only `auditList`, `status`, `draws`, `drawContext`, `verify`, `freezePreview` and `simulate`, all fixed to read-only mode.
  - `pr-rla-mcp` imports only that subpath. The write functions live in `src/api/write/`, which the subpath never reaches.
  - The import-graph guard checks this.
- **`freeze_preview` in read-only mode (domain design finding R-02).** It never touches FreezeCheckpointStore or `.pr-rla/cache`. It reads first pages through the read-only broker and keeps its working data in the in-memory cache.
- **Untrusted-content fence (FR3.9; domain design finding R-07).** AuditCore builds the fenced text and the `untrusted` object. The MCP server passes them through and adds nothing.
- **Tier 2 wording under D7.** "Presence attestation (U9) is the only tier that still holds if the assistant has the human's full shell" becomes: "Presence attestation (U9) is designed to be the tier that holds even then. In this release it is verified with software keys only, so pr-rla does not claim it proves a human touched a hardware key."

**Added:**
- **The MCP error codes and `unknown` job state** (`contracts.md` §4).
- **Write operations stay CLI-only:** `register`, `freeze`, `sample`, `record`, `checkpoint`. AuditApi refuses them in read-only mode with `READ_ONLY_VIOLATION`, so a future MCP tool cannot reach them by mistake.

## U7 · CI integrations

**Kept from `05` §U7:**
- The composite GitHub Action design: its own lockfile pinning `pr-rla` by version and integrity, `setup-node` pinned by SHA at Node 24, the inputs, outputs and steps, the example workflow, the note on events caused by `GITHUB_TOKEN`, the budget note, and no default `sample`.
- The GitLab component, the plain-snippet alternative, tokens, and label triggers.
- The Bitbucket step and its credentials.

**Changed:**
- **Testing without scratch repos (FR6.5; D8).**

  | Check | How |
  |-------|-----|
  | Template validity | `action.yml` against GitHub's action-metadata schema; the GitLab component against GitLab's published CI JSON schema; `bitbucket-pipelines.yml` against Bitbucket's published schema. All run offline in vitest |
  | Action behaviour | A test harness runs the composite action's `run` steps in a temporary directory against a fixture audit directory, with `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` pointed at temporary files and the GitHub API replaced by a mock server. It asserts the summary text, the outputs, and the exit-code mapping (2 ESCALATE and 3 refusal fail the step; 0 passes) |
  | GitLab and Bitbucket jobs | The same harness runs each job's `script` lines against the fixture audit directory |
  | Not used | `act` against real repos, scratch repos or projects, and `gitlab-ci-lint` through the API |

- **Checkpoints in CI.** `command: checkpoint` runs `pr-rla checkpoint --push` and needs `allow-writes: true` with `contents: write`.
- **Exit-code mapping (review finding 11).**

  | Code | Effect on the job |
  |------|-------------------|
  | 0 | Pass |
  | 1 | Always fail |
  | 2 | Fail when `fail-on` includes `escalate` (the default) |
  | 3 | Fail when `fail-on` includes `refusal` (the default) |
  | 4 | Always fail, with the re-run command in the summary |
  | 5 | Fail when `fail-on` includes `timestamps` (the default) |

  The default `fail-on` is `escalate,refusal,timestamps`.

**Added:**
- **The end-to-end matrix names one ledger per SCM (FR6.7):** `github-issues` for GitHub, `gitlab-issues` for GitLab, and `git-file` for Bitbucket, or the Jira example where the team uses Jira. See `test-design.md` §3.

## U6 · Assistant integrations

**Kept from `05` §U6:** the Claude Code plugin layout, install steps, the exact-version `npx` pin, the `review-draw` skill frontmatter and its five-step body, the `guard.mjs` rule list, the Codex and Cursor guides, and the one-adapter-per-client approach. Whether Claude Code starts the server in the project directory stays unverified until U6's acceptance run.

**Changed:**
- **Manual acceptance (FR3.6; RQ2).** The founder runs the `review-draw` flow by hand in all three clients (Claude Code, Codex and Cursor), and each run is recorded with its date in BUILD-NOTES.

**Added:**
- **One more guard rule:** `pr-rla … checkpoint --push` from the assistant is blocked, because it writes to the audit repo.

## U8 · Org-pooled freeze

**Kept from `05` §U8:** the population definition (RepoSet, resolution at freeze, the union of per-repo populations, one certificate per owner and window, repo creation and deletion rules, single-repo as a pool of one); the freeze algorithm diagram; all-or-nothing with no `--skip-repo`; resume and `runId`; P = 4; must finish before R.

**Changed:**
- **Built in this round, before release (scope; FR5.8).** The "out of scope for v0.2" wording goes.
- **One provider per pooled registration (FR5.6; RQ15).** The refusal is a population rule in AuditCore (`validateRepoSet`), not an AuditApi check, so every caller gets it (domain design finding R-03).
- **Estimate bounds (FR5.5).** `--estimate` must land within ±20% of the actual request count and ±50% of the actual wall time on the synthetic 40-repo org. It uses the broker's published-limit budgets.

## U9 · Presence-attested verdicts

**Kept from `05` §U9:** the provenance levels table; the mechanism (allowed signers in the registration, `git commit -S`, SSHSIG verification in TypeScript including the `sk-*` signed-data layout and the UP flag, line-level levels, reviewer and principal matching); the known limits; issue ledgers topping out at `account`.

**Changed:**
- **Default `minProvenance` (FR3.8; D7).** `account` when an issue ledger is configured; `self-asserted` with the git-file ledger. The draft had `self-asserted` everywhere.
- **Fixtures (FR9.5; D7).** All are made with software keys:
  - a plain software `ed25519` key, which gives `account`;
  - `-sk` signatures with UP set and with UP clear, made through a software-emulated authenticator. The candidate is OpenSSH's own test middleware, loaded through `SSH_SK_PROVIDER`, as OpenSSH's regression tests do; confirm it at build;
  - an unlisted signer;
  - an unsigned verdict under `require_signed`.

  Outcomes are cross-checked against `ssh-keygen -Y verify`.
- **Location (domain design finding R-04).** PresenceVerifier lives under `src/core/presence/` and stays pure. The updated boundary rule:
  - core may import `src/sdk/*`, `src/core/**`, and the pure verification parts of `src/beacon` (round math, BLS verify) and `src/translog` (Merkle and SET checks);
  - core may not import `src/api`, `src/net`, `src/plugins`, `src/timestamp` clients, or any network client.

**Added:**
- **Wording (FR9.6).** The certificate prints the level as `presence (user-presence flag verified; key hardware not attested)`. No doc or certificate claims hardware-verified presence.
- **A limit the draft did not state.** A software-emulated authenticator can set the UP flag as easily as hardware can. So `presence` proves "a human touched a hardware key" only if the registered key is hardware-backed, and pr-rla does not check that.
  - Proving it would need FIDO key attestation at registration (`ssh-keygen -O write-attestation`), verified against authenticator vendor roots.
  - That is not built in this round. The security model says `presence` relies on the reviewer registering a hardware-backed key.

**Changed after review (2026-11-04).** An independent review of the first build found that the mechanism kept from the draft defeats the goal it serves. A verdict's provenance was the signature of the git commit that added its line, so one signing touch covered every line an assistant had appended; rebase, cherry-pick and amend re-signed other people's lines; and attribution through `git blame` could be steered by shallow clones, grafts, hidden renames, textconv and commit-graph files (two end-to-end forgeries verified 7/7 at `presence`). The mechanism is replaced:
- **One signature per verdict.** Each line carries an SSHSIG in its own namespace, `pr-rla-verdict@v1`, made by `ssh-keygen -Y sign` over a canonical, versioned text of the verdict that names the registration's digest, the protocol, the draw, the change, the verdict, the reviewer and the time (contracts.md §1, "Per-verdict signatures"). One touch signs exactly one verdict, for one draw of one registration. Commit signatures give no provenance; no line is credited to a commit; blame is gone.
- **`pr-rla record <draw> pass|fail --sign <key>`** builds the bytes, runs ssh-keygen, checks the signature as verify will, and writes the line. A reviewer can do the same by hand (README).
- **`verdicts.allowed_signers`** holds the keys, apart from `verdicts.reviewers` (which takes plain names again). Principals equal ignoring case, and one key under several principals, are refused; `namespaces=` must admit `pr-rla-verdict@v1`. `require_signed` means every counted verdict carries a valid signature by its reviewer's registered key, and needs the built-in git-file ledger.
- **The append-only walk** reads hash-checked raw objects, takes parents from each raw commit, and requires every version of the file to extend each parent's; a shallow, grafted or partial clone is refused. git runs through one guard (`src/io/git-safe.ts`).
- **Check 7 FAILs when the loaded ledger is not the registered one** (name, source, integrity, `optionsSha256`), for every ledger, and takes the provenance ceiling from the registered identity.

The levels, the wording (FR9.6), T16 and the known limits are unchanged. BUILD-NOTES ("U9 fix round") records this as a deviation from the approved design, with the review's reasoning.

## U10 · Docs and release engineering

**Kept from `05` §U10:** the doc set; the FR-D2 convention and `scripts/check-docs.mjs`; the release checklist steps; no licence file (`"license": "UNLICENSED"`, `"private": true`).

**Changed:**
- **Version.** The release is v0.1.0 across `pr-rla`, `pr-rla-mcp`, the plugin manifest, the action lockfile and the GitLab component docs (RQ17).
- **SECURITY.md** ships with a placeholder contact, `to be decided before public release` (D10).

**Added:**
- `docs/gh-aw-prospective.md`, the registration hand-off (FR1.9).
- The exit-code table in `docs/compatibility.md` (`contracts.md` §7).
- A README platform note: macOS and Linux tested, Windows untested (NFR19).
- A rate-limit and token-scope table per SCM in the CI guides, with each scope marked verified or unverified (NFR1).
