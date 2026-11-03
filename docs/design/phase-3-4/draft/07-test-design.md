# 07 · Test design

This stops before code generation, so it is the plan the build follows: what proves each requirement, and on what data. The conventions are BUILD-NOTES': recorded fixtures offline, one read-only live run per SCM where a public target exists, and every claimed result pasted with its command and date.

## 1. Principles
- **Offline by default.** `npm test` makes no network call. Every external API comes from recorded exchanges in the phase-2 recorder format, scrubbed of auth headers and e-mails: SCMs, TSAs, drand, Rekor, and MCP over stdio.
- **A fixture is checked against a second implementation** before it is trusted:
  - TSA tokens against `openssl ts -verify`;
  - SSHSIG against `ssh-keygen -Y verify`;
  - label histories against a separate `curl` read;
  - draws against the existing Python cross-check.
- **Tamper fixtures are first-class.** Every new kind of evidence comes with at least one fixture that `verify` must FAIL, and the test asserts the *exact* check number and message, as phase 1 does.
- **Statistics are untouched** (C-1), so the 20,000-audit simulation and stopping-table tests run unchanged as regression guards.

## 2. Per-unit tests
| Unit | Tests | Data |
|---|---|---|
| U1 | DER walker on tokens from all 8 TSAs; acceptance rule 1–7, each violated once; k-of-n with same-operator dedupe (Entrust/Sectigo); `U_k` vs `opensAt` and vs `publishTime(R)` at ±1 s boundaries; v1 Rekor records still 7/7; Rekor v2 inclusion proof + signed checkpoint; `TIMESTAMP NOT TAMPER-PROOF (1 of 2)`; no-TSA config makes zero network calls | tokens recorded 2026-11 (one per TSA, plus a forged genTime, a foreign root, an expired signer and a SHA-1 signature); Rekor v2 staging responses (after approval) |
| U3 | `bots` re-labelling (gitlab-org/cli: exactly +4 MRs); `pinned-head` kit check on every built-in + Gitea; `actor-ids` stability; `review-granularity`; `direct_push_via_merge: exclude` on bamboo-specs' release merge | existing recorded fixtures + a late-push synthetic history |
| U2a | Phase-2 suite unchanged; read-only guard (GET ok, GraphQL query ok, GraphQL mutation refused, POST to REST refused, redirect to another host refused); shared host bucket under a fake clock; header-derived pacing | fake servers |
| U5 | API functions return the same objects as `--json`; `mcp-readonly.test.ts` (every tool, valid and hostile inputs; directory tree hash unchanged; zero non-read requests); `draw_context` drops `linguist-generated` files; untrusted fence present; job handle for a long `freeze_preview`; root escape refused | recorded gh-aw draw; synthetic audit dir |
| U4 | Ledger kit on GitHub and GitLab recorded timelines: clean, relabel same, relabel opposite, both labels, removal, deleted issue, transferred issue, deleted label, renamed label (REST keeps old name), app-applied, unlisted reviewer, verdict before seed, > 100 events; checkpoint round-trip and a checkpoint mismatch; idempotent `publishDraws` | recorded from a scratch audit repo the founder owns (writes need approval); synthetic for the destructive cases |
| U6 | `guard.test.ts`: 10 blocked and 10 allowed hook payloads; `claude plugin validate` on the plugin dir | recorded hook JSON |
| U7 | `action.yml` and component YAML schema checks; exit-code mapping (2 → ESCALATE fails, 3 → refusal fails, 0 passes); summary rendering | — |
| U2b | Gitea passes the kit *through the host*; a hostile fixture plugin tries `process.env.GITHUB_TOKEN` (gets the placeholder), reads `~/.npmrc` (denied), writes a file (denied), sends the placeholder to another host (refused), and on Node ≥ 25 opens a socket (denied); tree-hash mismatch refuses load; symlink escape aborts hashing; `--plugins builtin-only` refuses before import | `test/fixtures/plugins/hostile/` |
| U8 | Synthetic 40-repo org with injected 429s and a killed run: resumed manifest byte-identical; a repo added after freeze → check 5 FAIL; a repo deleted → WARN with count; `--estimate` within ±25% of the actual request count | fake GitHub org |
| U9 | `ed25519-sk` with UP, which passes `presence`; `no-touch-required` key, which fails `presence`; software key → `account`; unlisted signer → `self-asserted`; reviewer/principal mismatch; decreasing counter → WARN | signatures made with a real FIDO key by the founder, recorded once |

## 3. End-to-end matrix (the success metric)
Each cell is a scripted run recorded in BUILD-NOTES. **H** marks the steps a human must do by design (register approval, deep review, recording the verdict).

| | GitHub | GitLab | Bitbucket Cloud |
|---|---|---|---|
| **CLI** | phase-1 E2E, plus TSA tokens and a git-file signed ledger | `e2e-gitlab` (phase 2), plus TSA tokens and the gitlab-issues ledger | new `e2e-bitbucket`: json → real provider fixture, git-file ledger |
| **CI** | Action in a scratch repo: label (H) → status comment; ESCALATE fixture fails the run | component in a scratch project: push to `audit/**` → status artifact; schedule run | pipeline in a scratch repo: push → status step |
| **Assistant (MCP)** | Claude Code: `review-draw` on a recorded draw → human records (H) → `status` tool shows the new prefix | Codex: same flow against the GitLab audit dir | Cursor: same flow against the Bitbucket audit dir |

The three assistant cells rotate clients so each client and each SCM appears once. Each run also calls every MCP tool once in every client.

**Bitbucket Data Center** stays unverified live (no public instance), as in phase 2.

## 4. Live runs and the approvals they need
| Run | Writes? | Needs the founder's go-ahead |
|---|---|---|
| One token from each bundled TSA (U1) | no; a hash goes to the TSA | recommended as allowed; confirm (README, decision D2) |
| Rekor v2 **staging** entry for a throwaway registration (U1) | yes: public, permanent (staging) | **yes** |
| Scratch audit repo / project on GitHub, GitLab, Bitbucket for U4, U7 and the E2E matrix | yes: the founder's own private repos | **yes** (creating repos) |
| Read-only dry runs: navikt org (U8), gh-aw `draw_context` (U5) | no | no |
| Prospective gh-aw registration with TSA tokens (+ optional production Rekor) | TSA: no. Rekor: yes, permanent | **yes** (the validation gate) |

## 5. Standing guards (run in `npm test`)
- **`architecture boundaries`, extended:**
  - core imports no `src/api`, `src/net`, `src/plugins` or `src/timestamp/client`;
  - `pr-rla-mcp` imports only the `pr-rla` public entry;
  - no write function is reachable from the MCP package.
- **Secret grep** over fixtures, test outputs and `npm pack --dry-run` contents: no token patterns, no e-mails other than `user-<hash>@example.invalid`.
- **`check-docs`:** offline doc outputs re-run and diffed.
- **Schema readers:** every record schema ever written (v1 and v2) round-trips through `verify`.
