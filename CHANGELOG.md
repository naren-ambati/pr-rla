# Changelog

Every release of `pr-rla` and `pr-rla-mcp`, newest first. The two packages are released together with one version ([`docs/compatibility.md`](docs/compatibility.md), versioning). Below 1.0, a change to the CLI, an output or a record is a minor version and is listed here. Adding a field is compatible; renaming or removing one is listed here.

## 0.1.0: unreleased

Nothing is published yet: no npm package, no public repository, no tag. This entry describes what the first public release carries: all eleven units of the phase 3–4 design on top of the phase 1–2 audit. The release steps are [`docs/release-checklist.md`](docs/release-checklist.md). Licence: decided by the founder before release.

### The audit (phases 1 and 2)

- **Claim D**, a ballot-polling risk-limiting audit (Wald's SPRT, as in BRAVO) over the changes that landed on a default branch in a window with no recorded human review: `init`, `register`, `freeze`, `sample`, `record`, `status`, `verify`, `simulate` ([`docs/concepts.md`](docs/concepts.md), [`docs/statistics.md`](docs/statistics.md)).
- The population is every change that landed on the default branch: merged pull requests and direct pushes, with no commit counted twice under merge-commit, squash, rebase or fast-forward merges.
- Built-in providers `github` (and GitHub Enterprise Server), `gitlab` (and self-managed), `bitbucket-cloud`, `bitbucket-data-center` and `json-file`; an external Gitea/Forgejo plugin as the worked example ([`docs/writing-a-provider.md`](docs/writing-a-provider.md)).
- The provider SDK (`pr-rla/provider`), the ledger SDK (`pr-rla/ledger`) and the conformance kits (`pr-rla/testing`), at `providerApiVersion` 1 and `ledgerApiVersion` 1.

### Added in phases 3 and 4

- **Trusted time (U1).** RFC 3161 tokens over each signed record's SHA-256 from k = 2 of the registered timestamp authorities, by operator; eight authorities bundled, four on by default (Sigstore, DigiCert, GlobalSign, Microsoft); offline verification with pkijs and asn1js; record schema v2; `register` and `freeze` exit 5 with too few tokens. A Rekor v2 client, tested against mock logs only ([`docs/trusted-time.md`](docs/trusted-time.md)).
- **The fetch broker (U2a).** Every outbound request through one path: a host allowlist, a read-only guard, credential placeholders swapped only on approved https origins, a per-host rate governor whose defaults are the smallest published limits, timeouts by destination, the one retrier, and a scrubbing recorder.
- **Issue-tracker ledgers (U4).** `github-issues` and `gitlab-issues` (GitHub Enterprise Server and GitLab self-managed through `base_url`), verdicts read from label-event history; the ledger conformance kit; the Jira example ledger; time-stamped ledger checkpoints, hash-chained, pushed across clones with `checkpoint --push` (never forced).
- **The plugin lock and the isolated plugin host (U2b).** `pr-rla.lock.json`, written only by `plugin add` and `plugin lock`; external plugins out of process under Node's permission model; `trust: full` as an opt-in; `--plugins builtin-only`; `plugin check`; local consent for every credential grant and for `trust: full` (`plugin approve`).
- **SDK carry-overs (U3).** `selector.bots`, the pinned history head, `Actor.id`, `reviewGranularity`, `landedVia` with `direct_push_via_merge`, `populationOptions`, and `pr-rla/http` under its own `HTTP_HELPER_VERSION` 1.
- **The audit API and the MCP server (U5).** Every command is a formatter over `src/api`; the read-only subpath `pr-rla/api/read`; `pr-rla draw-context <n>`; the separate `pr-rla-mcp` package, eight read-only tools over stdio ([`packages/pr-rla-mcp`](packages/pr-rla-mcp)).
- **CI integrations (U7).** A GitHub composite action with its own lockfile, a GitLab CI/CD component and plain snippet, and a Bitbucket Pipelines step, all tested on fixtures and mock servers ([`docs/ci/`](docs/ci/README.md)).
- **Assistant integrations (U6).** A Claude Code plugin (the MCP server, the `review-draw` skill, a guard hook), and Codex and Cursor setup ([`docs/assistants/`](docs/assistants/README.md)).
- **Org-pooled audits (U8).** One registration, freeze and certificate for a list or a rule of repositories; a resumable, all-or-nothing freeze; `freeze --dry-run --estimate` ([`docs/org-pooled-audits.md`](docs/org-pooled-audits.md)).
- **Per-verdict signatures (U9).** A git-file verdict signed on its own with `record --sign` (an SSHSIG over `pr-rla-verdict/v2` bytes that name the registration, the manifest and the seed); provenance `self-asserted`, `account` or `presence`; a registered minimum enforced by check 7. `presence` is printed as `presence (user-presence flag verified; key hardware not attested)` and has been tested with software keys only.
- **Docs and release engineering (U10).** The doc set and its index ([`docs/README.md`](docs/README.md)), the compatibility table, `SECURITY.md` with a placeholder contact, `CONTRIBUTING.md`, this changelog, the release checklist, a doc check (`npm run docs:check`: dated output blocks, offline links, CLI commands and flags, exit codes), a secret grep over both tarballs (`npm run secret-grep`), and a build that starts from an empty `dist/`.

### Exit codes

0 success · 1 a check failed, a refusal or a usage error · 2 ESCALATE, R not yet published, or an assistant hook block · 3 population below the registered minimum · 4 stopped before finishing (run the printed command again) · 5 a record written without enough timestamps · 6 INCOMPLETE. Code 5 and code 6 are new in this round; the others keep their phase 1–2 meaning ([`docs/compatibility.md`](docs/compatibility.md)).

### Behaviour settled during the build

Nothing was released before 0.1.0, so no released audit is affected. Audits made with a pre-release checkout (test fixtures, and any trial audit) meet these rules:

- **Draws are bound to the registration** for schema-v2 audits: draw *i* = SHA-256(randomness ‖ registrationSha256 ‖ uint64be(*i*)) mod N, so freezing again cannot move a draw. v1 audits keep the manifest's hash.
- **Unproven is not certified.** A time that k operators do not prove, a check that was skipped and a population that could not be rebuilt make `verify` INCOMPLETE (exit 6), and status withholds the certificate (`target reached · CERTIFICATE WITHHELD (why)`). `verify --offline` is never VERIFIED.
- **A review counts as a human decision** only if it is an APPROVED or CHANGES_REQUESTED review by a non-bot account that is not the author, submitted at or before the merge.
- **Verdict signatures are over `pr-rla-verdict/v2`**; a line signed over v1 bytes, a git-file line's own `provenance`, and a commit's signature count for nothing.
- **A git-file audit verifies from a full clone**, at the path its registration records (`ledgerPath`); a shallow, grafted or partial clone FAILs check 7.
- **Check 7 FAILs when the ledger it loads is not the registered one**; a registration names its signing key inside its signed bytes (`publicKeyPem`).
- **A lock's credential grants and `trust: full` need the local approval** of whoever runs the command (`pr-rla plugin approve`, or `plugin add`/`plugin lock`); without it the credential is withheld and a `trust: full` plugin is refused.

<!-- pending P1: the audit-binding round (ledger-publication.json written by sample; registered provider and ledger identity enforced in every command; read-only contexts for verify, status and freeze --dry-run; a shared check-7 local gate) adds its lines here when it merges. -->
<!-- pending S1: the integration-seams round ({words, foreign} results, MCP robustness against hostile plugins, bounded estimates and retry hints) adds its lines here when it merges. -->

### Known limits

The limits that ship with 0.1.0 are stated where they apply: [`docs/security-model.md`](docs/security-model.md) (each threat and its residual), [`docs/compatibility.md`](docs/compatibility.md) (what is verified live and what only on fixtures) and the README's Limitations.
