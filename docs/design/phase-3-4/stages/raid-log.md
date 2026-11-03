# RAID Log: pr-rla phases 3–4 design review

Built from the approved `ideation/intent-capture/intent-statement.md`, `feasibility-questions.md`, `constraint-register.md`, the draft's **unverified** list (`pr-rla/docs/design/phase-3-4/README.md`), its threat table (`06-nfr-design.md` §2) and `pr-rla/BUILD-NOTES.md`. Every draft item marked unverified is a risk here.

## Risks

| ID | Risk | Likelihood | Impact | Response | Settled by |
|----|------|------------|--------|----------|------------|
| RK-01 | With no FIDO key (FC-14), software keys cannot attest that a human touched a device, so the `presence` verdict level is tested as code but never as a guarantee | Certain | High: the draft's statement that "only presence makes that detectable" loses its tested mechanism | Default to `account`; say plainly in the security model what `account` does and does not prove; keep the presence path for later | Requirements and NFR stages; a named test once a key exists |
| RK-02 | Node's permission model is not a security boundary, and network denial for the plugin host needs Node 25 or later; IPC from a `--permission` child without `--allow-net` on Node 25 is unverified | High | High: a malicious plugin can exfiltrate repo data on Node 22/24 | `--plugins builtin-only` as the CI default; state the limit in the security model; a named test on Node 25 | NFR design |
| RK-03 | Issue-ledger label semantics are unverified: whether GitHub fills `performed_via_github_app` on label events, whether GitHub REST keeps the original name after a rename, GitLab scoped-label swap events and the system-note fallback, the Jira `labels` changelog format. D8 forbids live writes to check them | High | High: tamper evidence for issue ledgers rests on them | Record read-only fixtures from existing public issue timelines where they exist; mark every synthesized fixture; check 7 FAILs on anything unreadable | Functional and test design |
| RK-04 | Rekor v2 request and response shapes are unverified against production, and FC-16 keeps them unverified for this phase | Certain | Medium: `--submit` may fail the first time a user runs it | Keep Rekor off every critical path; the time evidence never depends on it; mock-test against the published spec | NFR design |
| RK-05 | Timestamp authority terms, rate limits and availability: Sigstore TSA terms and rate limits are unverified; Sectigo asks for ≥ 15 s between scripted requests; the trust bundle needs upkeep as TSA certificates rotate or expire | Medium | High: fewer than k tokens means `TIMESTAMP NOT TAMPER-PROOF` | k-of-n operators; one request per TSA per record; a date-stamped trust bundle that only adds anchors | NFR design |
| RK-06 | MCP client behaviour is unverified: whether Claude Code starts a plugin's stdio MCP server in the project directory; Codex's hook payload shape; Codex auto-approves read-only tools; a cold `npx -y` start can exceed Codex's 10 s startup timeout | High | Medium | Named tests per client; setup guides that pin the timeout or use a global install | Functional and test design |
| RK-07 | SCM rate budgets make long or pooled freezes slow: Bitbucket Cloud 1,000 requests/h (60/h anonymous); the gh-aw Q3 freeze took about 22 minutes | High | Medium | Resume from checkpoints; `--estimate` before a long run; pooled freeze stays v0.2 | NFR design |
| RK-08 | Least-privilege claims are unverified: private repos and token scopes were never exercised on any SCM; Bitbucket Data Center and GHES were never run against a live server; Bitbucket Cloud's `Retry-After` on authenticated 429s is unknown | High | Medium: documented scopes may be wrong | Document scopes from vendor documentation and mark them unverified; read-only dry runs on public repos | Requirements (NFR security) |
| RK-09 | The direct-push population drifts after `freeze`: a commit dated in the window but pushed later shows up in `verify` and fails check 5 | Certain without a fix | High: reproducibility | The draft's pinned head SHA (additive SDK field); a conformance check for it | Application and functional design |
| RK-10 | Prompt injection in a draw's diff or description steers the assistant during review | Medium | Medium: the human may be misled by a summary | Untrusted-content fences; the skill never states a verdict; the verdict stays human | Functional design |
| RK-11 | Scope breadth for one founder: many units with several unverified foundations | Medium | Medium | A build order that puts the riskiest unverified items first; org-pooled stays v0.2 | Units and delivery planning |
| RK-12 | Whether `ssh-keygen -Y verify` enforces the FIDO presence flag is unverified; pr-rla checks it itself | Medium | Low under FC-14 (presence is not the default) | Keep pr-rla's own check; a named test | Test design |

## Assumptions

| ID | Assumption | Basis | Check |
|----|------------|-------|-------|
| AS-01 | The phase 1–2 code is the baseline and its 144 tests pass | Intent statement; BUILD-NOTES | Re-run the suite before the build starts |
| AS-02 | The drand League of Entropy stays threshold-honest | Draft threat T15 | Stated, not mitigated |
| AS-03 | At least k = 2 of the 4 timestamp-authority operators are honest | Draft threat T3 | Stated; k-of-n limits the damage |
| AS-04 | Reading existing public issue timelines to record fixtures is a read path, so D8 does not forbid it | This assessment | Confirmed by the founder on 2026-11-03, kept as a project rule |
| AS-05 | CI integrations run on Node 24 | Draft `06` §5 | Confirm in NFR design |

## Issues

| ID | Issue | Effect | Resolution |
|----|-------|--------|------------|
| IS-01 | The vision document says phase 2 is "being built now"; BUILD-NOTES and the founder say it is done (144 tests) | Readers of the vision get a stale status | Treat BUILD-NOTES as authoritative; the founder may update the vision |
| IS-02 | The draft's constraint C-4 says Node ≥ 22, but D6 sets `>= 22.13` | A stale constraint in the draft | FC-04 supersedes it; fix in the requirements stage |
| IS-03 | The draft's README decision table and `02` P1-a ("first real submission") still recommend a Rekor staging entry, FIDO-signed verdicts and scratch repos | They contradict D3, D7 and D8 | FC-14, FC-16 and FC-17 supersede them; update in the requirements and design stages |
| IS-04 | The draft's threat T7 says "only `presence` makes that detectable" | Untrue as a tested property under D7 | Rewrite at NFR design (RK-01) |

## Dependencies

| ID | Dependency | Direction | Notes |
|----|------------|-----------|-------|
| DP-01 | SCM public APIs: GitHub REST and GraphQL (and GHES), GitLab, Bitbucket Cloud and Data Center, Gitea | Read; write only to the audit ledger | Rate budgets in `06` §3 |
| DP-02 | drand quicknet public relays | Read one round | Offline `--beacon-file` exists |
| DP-03 | RFC 3161 timestamp authorities (the draft names Sigstore, DigiCert, GlobalSign and Microsoft) | Send a hash and a nonce | k = 2 of 4 (FC-09) |
| DP-04 | Sigstore Rekor | Write only on the user's `--submit` | Never in this phase (FC-16) |
| DP-05 | The MCP TypeScript SDK (`@modelcontextprotocol/server` 2.x with `zod`, per the draft) | Library | FC-05 |
| DP-06 | MCP clients: Claude Code, Codex, Cursor | Call pr-rla | RK-06 |
| DP-07 | CI: GitHub Actions, GitLab CI, Bitbucket Pipelines | Run pr-rla | Fixtures and mocks only (FC-17) |
| DP-08 | Node.js `>= 22.13` permission model; Node 25 or later for network denial | Runtime | RK-02 |
| DP-09 | npm registry | Publishing later; `npm audit signatures` for `plugin check` | Publishing is the founder's act (FC-15) |
