# NFR Requirements: pr-rla phases 3–4

**Stage:** NFR Requirements.

- **Starting point.** It takes the approved NFR1–NFR19 from `…/inception/requirements-analysis/requirements.md`, assigns each to the units that carry it, and adds what the design work since then has shown is missing (NFR20–NFR24).
- **Numbers.** Every target is measurable. Where a number comes from a provider, the source is in `nfr-design.md` §3.

## Targets by category

| ID | Category | Target | Measured by | Units |
|----|----------|--------|-------------|-------|
| NFR1 | Security: least privilege | Read-only scopes for `freeze`, `verify` and MCP; write only to the audit repo or project; a scope table per SCM, each row marked verified or unverified | The scope table; the broker's `writePaths` test | U2a, U4, U7, U10 |
| NFR2 | Security: secrets | Zero token or e-mail matches (other than `user-<hash>@example.invalid`) in fixtures, test outputs, logs, MCP results and the npm tarball | Secret-grep guard in `npm test` | U2a, U2b, U5, U10 |
| NFR3 | Security: no public writes | Zero Rekor connections and zero real-repo writes in the test suite; `--submit` always needs explicit confirmation | Network-deny test harness; hook tests | U1, U4, U6, U7 |
| NFR4 | Honest output | Every weakened guarantee prints its line: timestamps, plugin trust, provenance, the Rekor v2 warning | Fixture output assertions | U1, U2b, U9 |
| NFR5 | Reliability: resumable | A rate-limited or killed freeze resumes to a byte-identical manifest | Synthetic 40-repo test | U8 |
| NFR6 | Reliability: deterministic | Two runs over the same SCM state give byte-identical manifests | The kit's stable-ids check; the U8 test | U3, U8 |
| NFR7 | Compatibility | v1 records verify 7/7 after this round | The existing v1 E2E | U1 |
| NFR8 | Versioning | v0.1.0 first public release; the compatibility rules in `contracts.md` | The compatibility table | U10 |
| NFR9 | Dependencies | Core runtime dependencies: `commander`, `yaml`, `drand-client`, plus the ASN.1/CMS library chosen in U1 | `npm ls --prod` | U1, U5 |
| NFR10 | Performance | On fixtures, offline: `status --offline` < 1 s; `verify --offline` < 2 s at N ≤ 10,000; `draw_context` < 2 s; MCP server start < 2 s when installed | Timed tests | U5 |
| NFR11 | Testability | `npm test` makes no network call; every external API has recorded or synthetic fixtures, marked as such | Network-deny harness; fixture markers | all |
| NFR12 | Rate budgets | Defaults equal the smallest published limits (`nfr-design.md` §3); all configurable; headers win | Defaults test plus override test | U2a |
| NFR13 | Runtime | `engines.node >= 22.13`; Node 25 network denial verified or recorded as unverified | `package.json`; the U2b Node 25 test | U2b, U10 |
| NFR14 | Reliability: timeouts | SCM 30 s; timestamp authority 15 s; drand 15 s; Rekor 30 s; each git call 30 s | Hanging-server tests | U2a, U4 |
| NFR15 | Reliability: atomic writes | An interrupted command leaves the previous file whole | Kill-during-write test | U5 |
| NFR16 | Operability: exit codes | Codes 0–5 as in `contracts.md` §7; existing codes never change meaning | Per-command exit assertions | U5, U10 |
| NFR17 | Operability: errors | Every error names the host or command, the reason and the next step; verbose output never prints credentials | Error fixtures; NFR2 grep over verbose logs | U5 |
| NFR18 | Supply chain | Integrations pin exact versions and install by lockfile integrity; releases use trusted publishing with provenance, run by the founder | Template checks; release checklist | U7, U10 |
| NFR19 | Platforms | macOS and Linux tested in CI; Windows untested and documented | CI matrix; README | U7, U10 |
| NFR20 | MCP: bounded memory | At most 4 concurrent jobs; a job result over 8 MiB is refused with a message; finished jobs are dropped after 600 s | MCP tests | U5 |
| NFR21 | Trust bundle freshness | Every release diffs the bundle against each authority's current chain; historical signer certificates are kept, so old tokens still verify after rotation (DigiCert rotates at least every 15 months) | Release checklist step; old-token fixture | U1, U10 |
| NFR22 | Security: parsing library | The ASN.1/CMS library is pinned by exact version and lockfile integrity; the six tamper fixtures run on every upgrade | Lockfile; tamper tests | U1 |
| NFR23 | Security: presence claims | No doc or certificate claims hardware-verified presence; `presence` prints `key hardware not attested` | Text check over docs and certificate templates | U9, U10 |
| NFR24 | Reliability: checkpoint push | At most 3 attempts, never `--force`, exit 4 with the re-run command after the third rejection | Local bare-repo race test | U4 |

## Added in this stage, and why

| ID | Why it was missing |
|----|--------------------|
| NFR20 | The MCP server keeps job state in memory (founder decision at the requirements approval). Memory without a bound is a reliability gap |
| NFR21 | U1's trust bundle ages as authorities rotate certificates; the draft named the update script but no requirement |
| NFR22 | The founder chose a library over a hand-written parser (RQ8); the library's own updates become a security surface |
| NFR23 | The presence limit found in functional design (§U9): a software authenticator can set the UP flag |
| NFR24 | The git transport for checkpoints (`contracts.md` §6) needs its own reliability target |

## Kept, changed and added against the draft

- **Kept.** The draft's NFR-S1–S4, NFR-R1–R2, NFR-C1–C2, NFR-P1–P2 and NFR-T1, now NFR1–NFR11.
- **Changed.** The numbers stated at the requirements approval: timeouts, rate defaults, offline `draw_context` timing.
- **Added.** NFR12–NFR19 at requirements, and NFR20–NFR24 here.
