# Constraint Register: pr-rla phases 3–4 design review

Sources: the approved `ideation/intent-capture/intent-statement.md`, `feasibility-questions.md` Q1–Q2, `inputs/pr-rla-vision.md`, `inputs/pr-rla-tech-env.md`, and the draft's own constraints C-1 to C-6 (`pr-rla/docs/design/phase-3-4/01-requirements.md`). The last column records what happened to the draft's version.

## Technical constraints

| ID | Constraint | Source | Draft |
|----|------------|--------|-------|
| FC-01 | The statistics are fixed: claim D, SPRT/BRAVO scoring, the stopping table 36/56/75, the cap rule, the longest-labelled-prefix rule and duplicate reuse | Vision; intent Q3 | Kept (C-1) |
| FC-02 | The seed derivation is fixed. This phase may change only where the registration time comes from, never the formula | Vision; intent Q3 | Kept (C-2) |
| FC-03 | `verify` keeps its seven checks with the same meaning; new evidence feeds the existing checks | Vision; intent Q3 | Kept (C-3) |
| FC-04 | TypeScript strict ESM on Node.js `>= 22.13`; `commander`, `vitest` and `yaml`; no extra runtime in the core package; statistics and seeding stay pure functions | Tech env; D6; Q1 | Changed (C-4 said Node ≥ 22) |
| FC-05 | Minimal dependencies and no telemetry. Preferred: `@octokit/*` for GitHub, official or plain-`fetch` clients for GitLab and Bitbucket, the official MCP TypeScript SDK, a maintained drand client | Tech env; Q1 | Added |
| FC-06 | Phase 1's provider SDK, registry and conformance kit are the baseline. Changes are additive within provider and ledger API version 1, or they bump the version | Vision; Q1 | Kept (C-6) |
| FC-07 | The phase 2 provider ecosystem is reviewed, not redesigned | Vision; intent Q3 | Added |
| FC-08 | No hosted backend and no cloud services in the open-source scope | Tech env; Q1 | Added |
| FC-09 | `init` configures 4 RFC 3161 timestamp authorities with k = 2; tests send them SHA-256 hashes only | D1/D2; Q1 | Added |
| FC-10 | The prospective registration's timing proof stands on the timestamp authorities alone | Intent Q2; D3 | Added |

## Security constraints

| ID | Constraint | Source | Draft |
|----|------------|--------|-------|
| FC-11 | Tokens come from environment variables only and are never written to manifests or ledgers | Tech env; Q1 | Added |
| FC-12 | Least privilege: `freeze` and `verify` need read-only scopes; ledgers write only to the audit repo or project | Tech env; Q1 | Added |
| FC-13 | Third-party plugin code runs with the CLI's privileges, so the design must say how users pin and verify plugins and what the conformance kit checks | Tech env; Q1 | Added |
| FC-14 | No FIDO hardware key. The presence path is built and tested with software keys only; the default verdict provenance is `account`, through an issue ledger where one is configured | D7; Q1 | Added (supersedes the draft's D7 recommendation) |

## Organizational constraints

| ID | Constraint | Source | Draft |
|----|------------|--------|-------|
| FC-15 | Nothing is published to npm, GitHub or any public log without the founder's explicit approval; every permanent public write needs an explicit flag | Vision; intent Q3; Q1 | Kept (C-5) |
| FC-16 | No Rekor writes at all in this phase, not even staging. The Rekor client stays mock-tested; `--submit` remains the user's explicit act | D3; Q1 | Added (supersedes the draft's D3 recommendation and its "first real submission" plan) |
| FC-17 | Write paths (issue ledgers, CI, end-to-end runs) are tested only on recorded fixtures and mock servers; no scratch repos | D8; Q1 | Added (supersedes the draft's D8 recommendation) |
| FC-18 | No licence file; the licence is undecided | Vision; Q1 | Kept (C-5) |
| FC-19 | The security contact is a placeholder until public release | D10; Q1 | Added |
| FC-20 | A solo founder builds with Claude Code | Vision; Q1 | Added |
| FC-21 | Design only: the work stops before Code Generation | Intent Q3 | Added |
| FC-22 | No fixed date; take the time needed and do it thoroughly | Q2 | Added |

## Decided product options (treated as constraints)

| ID | Constraint | Source | Draft |
|----|------------|--------|-------|
| FC-23 | A registered `selector.bots` list exists | D4 | Kept |
| FC-24 | `direct_push_via_merge: exclude` is available; the default keeps such commits as direct pushes | D5 | Kept |
| FC-25 | Replacing `drand-client` with `@noble/curves` is optional and decided during this review | D9 | Open |

## Testing constraints

| ID | Constraint | Source | Draft |
|----|------------|--------|-------|
| FC-26 | Unit tests for statistics (stopping table; false-certify ≤ α over ≥ 20,000 simulated audits), seeding and tamper fixtures | Tech env | Added |
| FC-27 | Every provider runs the conformance kit on recorded API fixtures | Tech env | Added |
| FC-28 | An end-to-end lifecycle test per provider on fixtures, and one read-only live dry run per provider where a public repo exists | Tech env | Added |

## Regulatory constraints

| ID | Constraint | Source | Draft |
|----|------------|--------|-------|
| FC-29 | No regulation applies to pr-rla itself. Its users rely on its certificates as SOC 2 change-control evidence, so certificates and the draw record must be readable and reproducible by an auditor | Q1; intent statement | Added |
