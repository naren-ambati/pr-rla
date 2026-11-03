# 01 · Requirements (phases 3–4)

Source: `inputs/pr-rla-vision.md` and `inputs/pr-rla-tech-env.md` (2026-11-03), `docs/design/spec.md`, `BUILD-NOTES.md`. Every requirement has an id that later documents trace to.

## Fixed constraints (not open to redesign)

| Id | Constraint |
|---|---|
| C-1 | The statistics are fixed: claim D, SPRT/BRAVO scoring, the stopping table 36/56/75 (p0 10%, p1 2%, α 5%), the cap rule, the longest-labelled-prefix rule and duplicate reuse. |
| C-2 | The seed derivation is fixed: R = first drand quicknet round that publishes ≥ 24 h after the later of window close and registration time. Draw *i* = SHA-256(randomness ‖ manifest-hash ‖ uint64be(i)) mod N. Phase 3 changes only **where the registration time comes from** (FR-T), never the formula. |
| C-3 | `verify` keeps its seven checks with the same meaning. New evidence (TSA tokens, plugin identity, ledger history) feeds the existing checks: time feeds 1–3, provider identity feeds 5, ledger history feeds 7. |
| C-4 | TypeScript strict ESM, Node ≥ 22, `commander` / `vitest` / `yaml`; no extra runtime in the core package; no telemetry; statistics and seeding stay pure functions. |
| C-5 | Nothing is published to npm, GitHub, Rekor or any public log without the founder's explicit action. Every permanent public write needs an explicit flag. No licence file. |
| C-6 | Phase 1's provider SDK, registry and conformance kit are the baseline. Changes are additive within `providerApiVersion` 1 and `ledgerApiVersion` 1, or they bump the version. |

## Functional requirements

### FR-T · Tamper-evident time (open question 1)
| Id | Requirement |
|---|---|
| FR-T1 | `register` and `freeze` obtain RFC 3161 timestamp tokens over the signed record's digest from the configured timestamp authorities (TSAs), and store them in the signed-record file. |
| FR-T2 | `verify` checks each token offline: CMS signature, message imprint, signer certificate with the `timeStamping` EKU, chain to a pinned root, genTime ± accuracy. |
| FR-T3 | Time evidence bounds a signed time and does not replace it. A token that proves the record existed by `registeredAt` + tolerance makes `registeredAt` the seed-derivation input. A team cannot move R by choosing which token to present. |
| FR-T4 | k-of-n: the registration names how many independent TSAs must agree (default 1). |
| FR-T5 | With no TSA configured, or none reachable, the record is written anyway and every output says `TIMESTAMP NOT TAMPER-PROOF`, exactly as today. |
| FR-T6 | Rekor becomes optional. A v2 entry, added only with `--submit`, gives public discoverability and an inclusion proof; its time comes from the TSA tokens. Existing Rekor v1 records keep verifying through `integratedTime`. |

### FR-P · Plugin trust (open question 2)
| Id | Requirement |
|---|---|
| FR-P1 | The registration records each plugin's identity: name, source (built-in, package or path), version, content hash and the hash of its options. |
| FR-P2 | `pr-rla.lock.json` pins every external plugin: package version, its npm lockfile integrity, and a tree hash of the installed files. A mismatch at load refuses to run. |
| FR-P3 | External plugins run out of process by default, in a plugin host with a scrubbed environment. Credentials reach them only as placeholders that the parent's fetch broker swaps for the real token on allowlisted hosts. |
| FR-P4 | `trust: full` (in-process, real env) is an explicit per-plugin opt-in, recorded in the registration and printed by `verify`. |
| FR-P5 | `--plugins builtin-only` and `PR_RLA_PLUGINS=builtin-only` refuse all external code (for CI). |
| FR-P6 | `pr-rla plugin check <spec>` runs the conformance kit against the plugin *through the plugin host*, and reports integrity, host allowlist and npm signature status. The kit is a correctness gate, never presented as a safety gate. |

### FR-M · MCP server and assistants (open question 3)
| Id | Requirement |
|---|---|
| FR-M1 | A stdio MCP server exposes read-only tools: `audit_list`, `status`, `draws`, `draw_context`, `verify`, `simulate`, `freeze_preview` and `job_status`. The vision's `sample` maps to the read-only `draws`; issuing draws stays CLI-only. |
| FR-M2 | The server writes nothing: no files, no ledger events, no non-read HTTP requests. A transport guard enforces this, and a test proves every tool leaves the audit directory byte-identical. |
| FR-M3 | No MCP tool, prompt or skill records, edits or removes a verdict, issues draws, or submits to a public log. |
| FR-M4 | `draw_context` returns the draw's diff (generated files dropped when `exclude_generated`), description, CI results, protocol checklist and verdict state. It is the core function behind `pr-rla draw-context <n>`. |
| FR-M5 | Long calls (`freeze_preview`, online `verify`) report progress and finish under the client's tool timeout, or return a resumable job handle. |
| FR-M6 | The same server works unchanged in Claude Code, OpenAI Codex and Cursor. |
| FR-M7 | Claude Code plugin: the `review-draw` skill, the MCP server config, and hooks that block verdict writes and `--submit` from the assistant. |
| FR-M8 | Verdict provenance is reported per verdict (self-asserted, account-attributed, presence-attested). A registration can require a minimum level. |

### FR-L · Issue-tracker ledgers (open question 4)
| Id | Requirement |
|---|---|
| FR-L1 | Built-in `github-issues` and `gitlab-issues` ledgers: `publishDraws` opens one issue per draw in draw order, and verdicts are labels. |
| FR-L2 | `readVerdicts` derives verdicts from the label **event history**, not current labels: the first verdict label event per change counts, and its actor and server time become `reviewer` and `recordedAt`. |
| FR-L3 | `verifyIntegrity` reports every removal, re-add, swap, label edit, issue deletion or transfer, and app-applied verdict. Removal after counting is a FAIL. Removal before any other event, followed by a re-add, is a WARN relabel. |
| FR-L4 | Ledger checkpoints: `status`/CI can append a hash of the verdict-event list to `audit/<window>/ledger-checkpoints.jsonl`, optionally TSA-stamped. History later deleted by an admin then shows up as a mismatch. |
| FR-L5 | Jira ships as an example external ledger plugin (`examples/ledgers/jira`), using the changelog API. |

### FR-O · Org-pooled audits (open question 5)
| Id | Requirement |
|---|---|
| FR-O1 | A registration may name a repo set: an explicit list, or an org/group/workspace rule (include/exclude globs, archived/fork flags) that is registered and resolved at freeze. |
| FR-O2 | The pooled population is the union of per-repo populations under one selector. Ids are already repo-qualified; the manifest records the resolved repo list with stable repo ids and each repo's default-branch head SHA. |
| FR-O3 | One certificate per org and window. Per-repo counts are descriptive only. |
| FR-O4 | Freeze is all-or-nothing: no manifest is written unless every repo in the set completed. Progress is checkpointed so a rate-limited run resumes. |
| FR-O5 | A shared per-host rate governor serves all repos and plugins. `freeze --dry-run --estimate` predicts requests and wall time before a run. |

### FR-C · CI integrations
| Id | Requirement |
|---|---|
| FR-C1 | GitHub Action: runs `status` (and `verify --offline`) on verdict events, writes the job summary, fails the job on ESCALATE (exit 2), and optionally comments on the audit issue. |
| FR-C2 | GitLab CI/CD component with typed inputs, triggered by pushes to `audit/**` and by a schedule. |
| FR-C3 | Bitbucket Pipelines: a documented step (no Docker pipe) triggered by pushes and schedules. |
| FR-C4 | Every CI integration pins the pr-rla version and runs it with `--plugins builtin-only` unless the user opts in. |

### FR-X · Phase 1–2 carry-overs (see `02-phase-1-2-review.md`)
| Id | Requirement |
|---|---|
| FR-X1 | Registered bot list (`selector.bots`) applied by the core to every actor, on every provider. |
| FR-X2 | Pinned head: the manifest records the default-branch head SHA; `ListChangesRequest.head` (optional, additive) makes `verify` walk the same history. |
| FR-X3 | `Actor.id` (optional, additive): a stable account id; selectors can match `id:<n>`. |
| FR-X4 | SDK definition of "one review object", declared by each provider as `reviewGranularity` and recorded in the manifest. |
| FR-X5 | `pr-rla/http`: the retrying, rate-limit-aware fetch, exported under its own semver and not tied to `providerApiVersion`. |

### FR-D · Documentation and contributor experience
| Id | Requirement |
|---|---|
| FR-D1 | README, concepts, statistics explainer, "write a provider", "write a ledger", CI guide per SCM, Claude Code / Codex / Cursor setup, security model, CONTRIBUTING, CHANGELOG. |
| FR-D2 | Every doc that shows output shows real output from a command that was run, with its date (the BUILD-NOTES convention). |

## Non-functional requirements

| Id | Area | Requirement |
|---|---|---|
| NFR-S1 | Least privilege | `freeze`/`verify`/MCP need read-only scopes only. Ledger writes need write access to the audit repo/project only. The docs give the exact scopes per SCM. |
| NFR-S2 | Secrets | Tokens come only from env. They are never written to manifests, ledgers, fixtures, logs, MCP results or error messages; a test greps every artifact. |
| NFR-S3 | No silent public writes | Rekor, issues, npm: an explicit flag plus a human action. Assistant hooks block the flags. |
| NFR-S4 | Honest output | Every weakened guarantee is printed where it applies (`TIMESTAMP NOT TAMPER-PROOF`, `PLUGIN TRUST: full`, `VERDICT PROVENANCE: self-asserted`). |
| NFR-R1 | Resumable | Freeze survives rate limits and transient faults (phase 2 behaviour), and an org freeze resumes from checkpoints. |
| NFR-R2 | Deterministic | Two runs over the same SCM state give byte-identical manifests; the conformance kit already checks this per provider. |
| NFR-C1 | Compatibility | v1 records (Rekor v1 `integratedTime`, no plugin identity) still verify after phase 3. New records use schema v2. |
| NFR-C2 | Versioning | One npm package version for the CLI + SDKs. `providerApiVersion`, `ledgerApiVersion` and record schemas are versioned separately and documented in a compatibility table. |
| NFR-P1 | Dependencies | Core package dependencies: `commander`, `yaml`, `drand-client`, plus at most one small, maintained ASN.1/CMS library for RFC 3161 if hand-parsing is rejected (decision in `05`). The MCP server ships as a separate package. |
| NFR-P2 | Performance | `status --offline` < 1 s; `draw_context` < 10 s on GitHub; `verify --offline` < 2 s for N ≤ 10,000. |
| NFR-T1 | Testability | Every external API (SCMs, TSAs, drand, Rekor, MCP clients) is exercised against recorded fixtures offline, plus one read-only live run per SCM where a public target exists. |

## Success metrics (from the vision), traced

| Metric | Proven by |
|---|---|
| A third-party provider written against only the public SDK passes the kit without touching core | Gitea plugin (done) + `pr-rla plugin check` through the plugin host (FR-P6) |
| GitHub, GitLab, Bitbucket all pass the same kit; PRs/MRs + direct pushes, no double counting | phase 2 (done; Bitbucket live run pending) + pinned-head check (FR-X2) |
| An audit runs end to end from the CLI, from CI and from an assistant via MCP on each of the three SCMs | E2E matrix in `07-test-design.md` §3 |
| Prospective gh-aw certificate ~7 weeks after v0.1 | needs FR-T before the prospective registration (see `04` unit order) |
