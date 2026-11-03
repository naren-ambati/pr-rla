# pr-rla phases 3–4: design

**Design only. It stops before code generation.** The inputs are `~/Documents/aidlc-designs/inputs/pr-rla-vision.md` and `pr-rla-tech-env.md` (2026-11-03), read against the code at `a23fcd2` plus the uncommitted phase-2 work, `docs/design/spec.md` and `BUILD-NOTES.md`.

The documents follow AI-DLC's stages in **stage-major** order: every unit's design is complete in each stage before the next stage starts. All diagrams are Mermaid.

**How this was made.** The AI-DLC tool itself was *not* run. `/aidlc` exists only in sessions opened in `~/Documents/aidlc-designs`, so this design was written directly in that structure. External facts were checked on 2026-11-03 and cited inline. Anything not checked is marked **unverified**.

| Stage | File |
|---|---|
| Requirements (FR/NFR ids, constraints, success-metric trace) | [01-requirements.md](01-requirements.md) |
| Review of phase 1–2 open questions | [02-phase-1-2-review.md](02-phase-1-2-review.md) |
| Application design: components, SDK deltas, record schemas v2, lifecycle, plugin sequence, MCP flow | [03-application-design.md](03-application-design.md) |
| Units of work, dependencies and build order | [04-units-of-work.md](04-units-of-work.md) |
| Functional design, every unit | [05-functional-design.md](05-functional-design.md) |
| NFR design: security model, rate limits, reliability, versioning, packaging | [06-nfr-design.md](06-nfr-design.md) |
| Test design and the E2E matrix | [07-test-design.md](07-test-design.md) |
| Infrastructure design | not applicable (no hosted backend); see `06` §5 |

## The five open questions: answers in one paragraph each

1. **Tamper-proof registration time** (`05` §U1).
   - **The seed input stays the *signed* `registeredAt`.** RFC 3161 tokens from k-of-n independent TSA operators (default: Sigstore, DigiCert, GlobalSign and Microsoft, k = 2) only *bound* it, within a 10-minute tolerance.
   - **Why genTime cannot be the input.** Taking a token's genTime directly would let a team collect tokens over time and present whichever gives a better seed round: a re-roll that check 3 cannot see.
   - **How `verify` checks.** Tokens are verified offline by a zero-dependency DER walker over node:crypto, with all seven RFC 3161 checks, against a pinned trust bundle. Prospective iff the k-th earliest bound precedes the window opening.
   - **No TSA.** With none configured, output is exactly today's: `TIMESTAMP NOT TAMPER-PROOF`. There is no fallback to git dates or Bitcoin time.
   - **Rekor** becomes optional discoverability: v1 kept, v2 added with checkpoint verification, `--submit` only.
2. **Plugin trust** (`05` §U2b).
   - **Pinning.** Plugins are pinned in `pr-rla.lock.json` (npm integrity plus a content tree hash, re-checked at every load) and recorded in the registration, so check 5 sees code or option drift.
   - **Isolation.** External plugins run in a child process with a scrubbed environment and the permission model. They receive only credential **placeholders**, which the parent's broker swaps for real tokens on declared hosts. Provider traffic is forced read-only.
   - **Limits, stated plainly.** Node's permission model is not a security boundary, and Node 22/24 cannot block network: the token is protected, but repo data could still be exfiltrated. On Node ≥ 25 the child gets no network at all.
   - **Policy and gate.** `--plugins builtin-only` is the CI default. The conformance kit is offered as a *correctness* gate (`pr-rla plugin check`), never as a safety gate.
3. **MCP surface** (`05` §U5).
   - **Eight tools in a separate `pr-rla-mcp` package:** `audit_list`, `status`, `draws`, `draw_context`, `verify`, `simulate`, `freeze_preview` and `job_status`. It is built on `@modelcontextprotocol/server` 2.x, which needs only zod.
   - **Every tool is read-only.** This is enforced by a read-only API mode, a ledger proxy and the broker's wire guard, and tested by tree-hashing the audit directory around every call.
   - **What can be guaranteed.** Annotations and client hooks cannot guarantee the assistant never records a verdict: Codex auto-approves read-only tools, and Codex/Cursor can have an AI approve calls. The guarantee is therefore built at the ledger: a read-only token in the assistant, registered reviewers, app-applied labels ignored, and optional FIDO presence-attested signed verdicts (U9). Client hooks are a third, best-effort tier.
4. **Issue-tracker ledgers** (`05` §U4).
   - **Verdicts come from label *event history*,** through REST, not GraphQL (GraphQL rewrites renamed labels). The first eligible verdict event counts.
   - **Removal and re-add.** A removal followed by the same label is a WARN relabel; an opposite label is a WARN, and the first verdict still counts.
   - **Deleted history.** Deleted issues and labels are FAILs, caught by a draw → issue index committed in git. Admin deletion is caught by TSA-stamped **checkpoints** that store the event list.
   - **Scope.** GitHub and GitLab are built in; Jira is an example plugin that prefers a single-select field to labels.
5. **Org-pooled freeze** (`05` §U8).
   - **Population.** A registered repo-set rule is resolved at freeze, with each repo's head SHA pinned. The population is the union of per-repo populations, with one certificate per owner and window.
   - **All-or-nothing.** A partial pooled manifest would be a pruned population, so there is none. A rate-limited run resumes from checkpoints instead.
   - **Rate.** The broker paces each host from the server's own rate-limit headers, shared across repos.

## Decisions for the founder

Each has a recommended default; the build follows it unless you say otherwise.

| # | Decision | Recommended |
|---|---|---|
| D1 | `init` writes the four default TSAs (k = 2), so `register`/`freeze` send a record **hash** to four third parties | **yes**; nothing public or permanent |
| D2 | Allow live TSA fetches while building U1 (hash only) | **yes** |
| D3 | One Rekor **staging** entry for a throwaway registration (permanent, public) to verify the client; production only for the prospective gh-aw registration | **yes, staging only for now** |
| D4 | Registered `selector.bots` (moves gitlab-org/cli 0 → 4 MRs into "no human review") | **yes** |
| D5 | Release-branch commits merged by a direct push: keep as direct pushes by default; add `direct_push_via_merge: exclude` | **yes** |
| D6 | Raise `engines.node` from `>=22` to `>=22.13` (stable permission model) | **yes** |
| D7 | Default `verdicts.minProvenance` is `self-asserted` (printed on every certificate). For the prospective gh-aw audit, use git-file + FIDO-signed commits (`presence`) **if you have a FIDO key**; otherwise `account` via an issue ledger | **yes; do you have a FIDO key?** |
| D8 | Private scratch repos on GitHub, GitLab and Bitbucket for the write tests (U4, U7, E2E) | **yes** |
| D9 | Phase 4: replace `drand-client` (2.16 MB of deps) with `@noble/curves` | optional |
| D10 | Security contact for `SECURITY.md` | your call |

## Unverified (each one is settled by a named test in `07` before its unit ships)
- IPC from a `--permission` child without `--allow-net` on Node 25 (U2b).
- Whether Claude Code starts a plugin's stdio MCP server in the project directory (U6). Codex's hook payload shape (U6).
- Whether GitHub populates `performed_via_github_app` on label events. GitHub REST keeping the original name after a label rename (a third-party report only). GitLab scoped-label swap events and the system-note fallback. The format of Jira `labels` changelog entries (U4).
- Rekor v2 request and response shapes against production. Sigstore TSA terms and rate limits (U1).
- Whether `ssh-keygen -Y verify` enforces the FIDO presence flag; pr-rla checks it itself (U9).
- Bitbucket Cloud `Retry-After` on authenticated 429s. Bitbucket Data Center against any live server (carried over from phase 2).
