# BUILD-NOTES

Working log for pr-rla v0.1: what is done, what is verified (with the command and its output), what is stubbed, and every assumption. The design is in `docs/design/spec.md`. Where this file and the spec differ, this file records why.

## Status (v0.1, claim D)

| Area | State |
|---|---|
| `init`, `register [--dry-run] [--submit]`, `freeze [--dry-run] [--submit]`, `sample`, `record`, `status`, `verify`, `simulate` | done, tested |
| SPRT scoring, stopping table, cap, early escalation, longest-labelled-prefix rule, duplicate reuse | done, tested |
| drand quicknet round derivation; BLS check via `drand-client` 1.4.2; recorded rounds as fixtures | done, tested offline |
| Draw index SHA-256(randomness ‖ manifest-hash ‖ uint64be(i)) mod N | done; cross-checked with an independent Python implementation |
| Manifest + signed commitment; signed registration; Rekor `hashedrekord` builder, client, SET and inclusion-proof checks | done; tested against a local mock log only |
| GitHub provider (PRs + direct pushes) | done; tested on recorded gh-aw responses and a synthetic graph; real read-only dry run on gh-aw Q3 (below) |
| JSON-file provider | done, tested |
| git-file ledger with append-only history check | done, tested |
| Provider/ledger registry, SDK exports, conformance kit | done, tested |
| GitLab / Bitbucket adapters | not started (owner: a later phase); `examples/provider-template.mjs` + README section document how |
| github-issues ledger, GitHub Action, `review-draw` skill + `draw-context` | not started (day-3 items) |
| Claim T, fixed plans, multi-repo freeze | not started (v0.2) |

## Architecture

Decisions made so that later adapters and integrations need no rewrite:

1. **Provider registry** — `src/registry.ts`. Built-ins `github` and `json-file` (alias `json`); anything else in `.pr-rla.yml` is loaded with dynamic `import()`:
   - `provider: ./my-provider.mjs` or `provider: { use: ./my-provider.mjs, options: {...} }`: a path, resolved relative to the audit repo;
   - `provider: { use: pr-rla-provider-gitea, options: {...} }`: a package name, resolved from the audit repo's `node_modules` (via `createRequire`), falling back to a plain `import()`.
   The module's default export (or a named `provider` export) must be a provider definition.
2. **Versioned provider SDK** — `src/sdk/provider.ts`, exported as `pr-rla/provider`:
   - `ScmProvider`, `ChangeRecord`, `Actor`, `Review`, `ReviewState`, `ListChangesRequest/Result`, `ProviderContext`;
   - `PROVIDER_API_VERSION = 1`, `defineProvider()`, plus validators (`changeRecordProblems`, `assertChangeRecord`).
   The registry refuses a definition whose `providerApiVersion` is unsupported (`ProviderApiVersionError`: "provider "x" declares providerApiVersion 2; this pr-rla supports 1 …"). It also refuses an instance whose `apiVersion` is unsupported.
3. **Ledgers use the same pattern** — `src/sdk/ledger.ts`, exported as `pr-rla/ledger`:
   - `Ledger`, `VerdictEvent`, `LEDGER_API_VERSION = 1`, `defineLedger()`;
   - optional hooks `publishDraws()` (for issue-tracker ledgers: one issue per draw) and `verifyIntegrity()` (append-only / label-history checks).
   Built-in: `git-file` (`src/ledgers/git-file.ts`). External ledgers load exactly like providers.
4. **Conformance kit** — `src/testing/conformance.ts`, exported as `pr-rla/testing`:
   - `runProviderConformance(provider | factory, fixtures)` returns a report; `assertProviderConformance` throws.
   - Checks: api-version, normalization, window-and-kinds, classification (PR vs direct push), no-double-counting (ids and commit SHAs), stable-sorted-ids (two runs give identical records), review-state-mapping, actors, pagination (exact ids plus a minimum request count) and kind-filtering.
   - It is framework-agnostic (no vitest import), so third parties can run it under any runner.
   - The built-in GitHub provider passes it on recorded gh-aw data and on the synthetic graph. The JSON provider and the example template pass it too.
5. **The core is provider-free** — `src/core/*` imports only `src/sdk/*`, other core modules, and the non-SCM infrastructure (`src/beacon`, `src/translog`). `test/registry.test.ts › architecture boundaries` fails if the core imports a provider, a ledger, the registry or a command, or mentions GraphQL or the GitHub API.
   - The population builder (`src/core/population.ts`) re-checks the provider contract on every run: well-formed records, unique ids, no commit claimed by two changes, inside the window, requested kinds only.
   - `verify` (`src/core/verify.ts`) takes the provider, the ledger, the beacon source and the log key as injected dependencies.

Layout: `src/sdk` (public SDKs) · `src/core` (pure audit logic) · `src/beacon/drand.ts` · `src/translog/{merkle,rekor}.ts` · `src/providers/{github,json-file}` · `src/ledgers/git-file.ts` · `src/registry.ts` · `src/config.ts` · `src/commands/*` · `src/cli.ts`.

## Verified (command → output)

- `npm run typecheck` → clean (TypeScript 7.0.2, strict, `noUncheckedIndexedAccess`).
- `npm run build` → `dist/` with `.d.ts`; `node -e "import('pr-rla/provider')"` (package self-reference) → `PROVIDER_API_VERSION 1`; the `./testing`, `./ledger` and `.` exports also resolve. `examples/provider-template.mjs` loads through `pr-rla/provider`.
- `npm test` → **90 tests in 9 files, all passing**:
  - `sprt` 11: stopping table 36/56/75 (p0 10%, p1 2%) and 73/113/153 (p0 5%, p1 1%); scores +0.0852 / −1.609 / 2.996; LLR 3.066 at 36 passes; "20 more passing draws needed (56 total)"; cap 144; escalation.
  - `seed` 14: round time formula, derived R for prospective (32,698,612) and retrospective (33,245,812) cases, BLS on 4 recorded quicknet rounds, 3 forged-beacon failures, draw formula and golden values.
  - `simulate` 7: ≥ 20,000 audits per row.
  - `translog` 3: RFC 6962 proofs for trees of size 1–17; mock-log submit/fetch/verify; edited `integratedTime`, swapped record and foreign log key are detected.
  - `github-provider` 18: recorded gh-aw responses + conformance; synthetic squash/merge/rebase/direct-push graph + conformance; review pagination past 100; adaptive history page size under 502s; pure classifier and normalizers.
  - `github-http` 3: 503 then a truncated 200 body then success; GraphQL timeout retried; real query errors and 404s not retried; give-up after max retries.
  - `json-provider` 4; `registry` 9 (BYOP by path and by package, version rejection, ledger plugins, architecture boundaries, config).
  - `e2e` 21: full audit with the three tamper fixtures and more (below).
- `pr-rla simulate` (20,000 audits each, seed 1), against the spec's simulation table:

  | Population, defects | pr-rla | Spec |
  |---|---|---|
  | 400, 40 (10%, at the tolerance) | certified 4.58% (≤ 5%) | 4.53% |
  | 400, 4 (1%) | 99.85%, mean 42.2 distinct reviews | 99.86%, 42 |
  | 1,590, 159 (10%) | 4.52% | 4.8% |
  | 1,590, 16 (1%) | 99.81%, 44.2 distinct | 99.8%, 44 |
- End-to-end (`test/e2e.test.ts`): json-file provider, local mock Rekor, recorded round 33,245,812 and a git-file ledger in a temp git repo.
  - Register (logged 2026-10-20T00:00Z) → freeze (logged 12:00Z) → sample after R → 36 passes.
  - `status` prints `prefix 36/36 · fails 0 · claim D (detected-defect rate ≤ 10%, protocol …) · LLR 3.066 / target 2.996 · CERTIFIED (risk 5%) · RETROSPECTIVE`.
  - `verify` → 7/7 PASS: `registration after window close → RETROSPECTIVE (a demonstration) · manifest logged … before R ✓ · R = 33,245,812: first round ≥ 24 h after registration ✓ · BLS ✓ · population 400/400 match ✓ · 36/36 draws reproduce ✓ · labels … ✓ … VERIFIED`.
- Tamper fixtures, all of which `verify` fails:
  1. A manifest with the 80 `known-bad` changes removed, re-hashed, re-signed and re-logged before R → check 5 `population: 80 changes on json-file are missing from the manifest`. It is the only failing check.
  2. A commitment naming round 33,244,800, with draws redone from that round → check 3 `FAIL seed round 33,244,800 ≠ derived round 33,245,812` (both commitment and draws); check 6 fails too.
  3. A manifest commitment logged 2026-10-22, after R published → check 2 `manifest logged after the seed was public`. It is the only failing check. `freeze` itself also refuses once R is public.
  - Also failing: an edited `integratedTime` (SET no longer verifies), a changed review protocol (check 1), a rewritten `verdicts.jsonl` in git history (check 7), and a verdict dated before the seed (check 7).
- Local-only registration → `verify` passes with `1. WARN registration` and `TIMESTAMP NOT TAMPER-PROOF`, as the spec's fallback describes.
- Refusal: a 12-change population → `population 12 < 150: review all 12 instead` (freeze prints it; sample exits 3).
- Prospective status → `PROSPECTIVE · window open, day 12 of 92 · N so far … · seed round 32698612 not yet published · TIMESTAMP NOT TAMPER-PROOF`.
- drand: `curl https://api.drand.sh/52db…e971/info` matched the pinned chain info. Round 33,635,758 was current at t = 1793710639, consistent with 1692803367 + 3·(R−1).

## Real-data findings (fixed in code)

1. **GitHub's `associatedPullRequests` can be empty for a PR's own merge commit.**
   - Seen: gh-aw PR #73884, merged 2026-11-02T00:27:55Z; the merge commit `a1f805b0…` has no associated PRs.
   - With only the brief's rule ("no associated merged PR ⇒ direct push") that commit was counted as both a PR and a direct push. `buildPopulation` would have refused it ("counted commit … twice").
   - Fix: a default-branch commit equal to a merged PR's REST `merge_commit_sha` is also attributed to that PR. The recorded fixture `test/fixtures/github/gh-aw-2026-11-02.json` keeps this case as a regression test.
2. `associatedPullRequests(first: 5)` is used, not `first: 1`. A commit can belong to several PRs, and `first: 1` could return an unmerged one.
3. History is read from a **pinned head oid** (`object(oid:)`), so pushes during the walk cannot shift the cursor. REST pull pagination is by page number over a list sorted by `updated_at`, so the head of the list is re-read after the walk to catch PRs updated mid-walk.
4. The git-file history check broke on symlinked paths (macOS `/var` → `/private/var`): the path relative to git's toplevel was wrong, so no history was found. Fixed with `realpath`.
5. The first full gh-aw run died with `Unexpected end of JSON input`: a 200 response with a truncated body, right after an HTTP 503. Truncated bodies and GitHub's transient GraphQL errors ("Something went wrong … timeout") are now retried with backoff (`src/providers/github/http.ts`).
6. The second full run got through all 3,883 PRs but died in the history walk. Pages of 100 commits, each with `associatedPullRequests`, drew 41 HTTP 502/504 retries, and one call gave up after 7 attempts. This is the same server-side limit the spec hit with 100 PRs per query. The history walk now defaults to 50 commits per page and halves after two failed tries, resuming from the same cursor (tested with a fake GitHub that 502s above 13 commits).
7. YAML: `authors: [copilot-swe-agent[bot]]` is invalid flow YAML. Logins must be quoted, and the config error now says so.

## Assumptions (each is a decision the spec left open)

- **Window.** `start`/`end` are inclusive UTC days. The window opens at `start` 00:00:00Z and closes at `end`+1 day 00:00:00Z (exclusive). Q3 2026 closes 2026-10-01T00:00:00Z.
- **Population.** Changes landing on the **default branch** only. PRs merged into other branches are excluded and counted as a diagnostic.
- **Direct-push window and walk.** The commit's `committedDate` is used, because push time is not exposed. History is every ancestor of the current default-branch HEAD with a commit date in the window (GitHub `history(since:)` from a pinned head oid). A direct-push merge commit counts as one change, sized by GitHub's diff against its first parent.
- **Bots and ghosts.** GraphQL `__typename: "Bot"` or a `[bot]` suffix ⇒ bot, normalized to the `login[bot]` form. A deleted account (null actor) ⇒ `ghost`, human: a ghost approval is not treated as missing review. Commit authors with no linked account ⇒ `git:<email>`, human, unless the name ends in `[bot]`.
- **Reviews.** `PENDING` reviews are dropped. Reviews are taken as of `frozenAt`; later reviews are ignored and `verify` lists them. `no-human-review` = no APPROVED or CHANGES_REQUESTED by a human. A DISMISSED review does not count.
- **Selector semantics.**
  - `labels`: a change must carry all listed labels.
  - `merged_by: human|bot`: direct pushes never match, because the pusher is unknown.
  - `authors`: case-insensitive.
  - `exclude_generated`: recorded only. It affects the reviewer's scope (day-3 `draw-context`), never the stratum.
- **Canonical form.**
  - Manifest changes are sorted by id (UTF-16 code-unit order).
  - Hashes are SHA-256 over canonical JSON (sorted keys, no whitespace; RFC 8785-compatible for the value types used). The manifest hash covers every field except `sha256`.
  - Draw *i* is 1-based; *i* is encoded as uint64 big-endian; the digest is read as a big-endian integer mod N; the index is 0-based into the sorted manifest.
- **Duplicates.** Draws are with replacement, and every draw counts as an observation. A change drawn twice reuses its first verdict, so a failed duplicate counts twice. That is correct for BRAVO-style sampling with replacement, but surprising. Only the **first** eligible verdict per change counts; later disagreeing ones are reported as relabels.
- **Stopping and the cap.** The test stops at the first crossing; labelled draws after the stop are reported as not counted. The cap is in draws (144 by default). Escalation also fires as soon as the target is unreachable within the cap.
- **Signing.**
  - Records are signed with a local ECDSA P-256 key (`.pr-rla/signing-key.pem`, mode 0600, gitignored; created on the first real `register`).
  - The manifest commitment must be signed by the same key as the registration.
  - `register --dry-run` and `freeze --dry-run` write nothing.
- **Times.** Without a log entry, the registration time is the signer's clock (`registeredAt`) and the manifest time is `frozenAt`. Both are flagged `TIMESTAMP NOT TAMPER-PROOF`.
- **Verdict times.**
  - A counted verdict whose `recordedAt` precedes R's publish time fails check 7.
  - In the git-file ledger that time is self-asserted.
  - Its tamper trail is git history: `verify` checks that every committed version extends the previous one, and warns about uncommitted lines.
- **Minimum population.** It is a registered parameter, `min_population`, default 150.
- **Draws issued.** `sample` issues the zero-failure stopping point (36) by default, and `sample --through n` issues more. `draws.json` always holds all cap draws, because they are deterministic.
- **Exit codes.**
  - `status`: 2 on ESCALATE and 3 on the < 150 refusal, so the planned GitHub Action can fail its run.
  - `sample`: 2 if R is not yet published, 3 on the refusal.
  - `verify`: 1 on any FAIL.
- **`record` command.** Added (not in the spec) so the git-file ledger has a writer. It refuses a second verdict on the same change unless `--force`.

## Transparency log (Rekor): built, mock-tested, never submitted

- `src/translog/rekor.ts`:
  - builds Rekor v1 `hashedrekord` entries (sha256 digest of the canonical record, base64 DER ECDSA signature, base64 PEM key);
  - `POST /api/v1/log/entries`, `GET /api/v1/log/entries/{uuid}`, `GET /api/v1/log/publicKey`;
  - verifies the body, the SET over `{body, integratedTime, logID, logIndex}` and the RFC 6962 inclusion proof.
  - Not checked: the checkpoint signature.
- **No default log URL.** `--submit` requires `--rekor-url` (or `transparency_log.url`). Nothing was submitted to any real log, production or staging: the owner has not approved public, permanent entries.
- `verify` trusts a log key from `--log-key`, from `transparency_log.public_key_file`, or (online) from the log's own `/publicKey`. Pinning a key is recommended.
- **Design risk found:** Rekor v2 went GA on 2025-10-10 and "no longer returns signed timestamps with proofs". Clients fetch an RFC 3161 timestamp from a timestamp authority instead (https://blog.sigstore.dev/rekor-v2-ga/). Rekor v1 keeps running in parallel and is to be frozen with a year's notice.
  - The spec's `integratedTime` design works only against v1.
  - The next step is an RFC 3161 TSA timestamp over the record digest, stored beside the v2 entry, with `verify` checking the TSA signature chain. Unbuilt and unverified.
- The real Rekor client call is **unverified** against a real log.

## Deviations from the spec

- The population is every change on the default branch (PRs + direct pushes), per the owner. The spec's population was PRs only.
- The core is SCM-agnostic, with plug-in providers and ledgers. The spec was GitHub-only, with draw issues as the ledger.
- The default ledger is `git-file`, not GitHub issues. `sample` therefore opens no issues; the `publishDraws` hook is where an issue ledger will do it.
- `simulate` ships in v0.1 (the spec put it in day 3).
- Not done: tagging, npm publishing and pushing (owner constraints). `package.json` is `"private": true`, `"license": "UNLICENSED"`.

## Not built / stubbed

- `examples/provider-template.mjs` is a runnable template (in-memory data), not a GitLab adapter.
- No `draw-context`, `review-draw` skill, GitHub Action, `github-issues` ledger, claim T, `status --what-if`, or multi-repo freeze.

## Next steps

- **GitHub Action** (day 3): a composite action that runs `pr-rla status` (and `verify --offline`) on `issues: labeled` and `push` to `audit/**`. It posts the status line and fails on exit code 2 (ESCALATE).
- **`review-draw` skill + `pr-rla draw-context <n>`** (day 3). `draw-context` prints the draw's diff with `linguist-generated` files dropped (when `exclude_generated`), its CI results and the protocol checklist. A one-file SKILL.md shows them; the human runs `pr-rla record`, and the skill never records.
- **`github-issues` ledger** (day 3): implement `Ledger` in a plug-in.
  - `publishDraws` opens one issue per draw in draw order.
  - `readVerdicts` maps the first `pr-rla:pass` / `pr-rla:fail` label event per issue.
  - `verifyIntegrity` reads the label-event history and flags removals and re-adds.
  - Test it with recorded timeline responses.
- **GitLab adapter** (later phase): a plug-in using `defineProvider`.
  - List merge requests (`state=merged`, `target_branch=<default>`, filter by `merged_at`, `updated_after` paging) and read their approvals (`/merge_requests/:iid/approvals`) and notes.
  - Map approvals to `APPROVED`, `requested_changes` to `CHANGES_REQUESTED` (where supported) and `bot` users to `kind: "bot"`.
  - Read the default branch's commits via `/repository/commits?ref_name=<default>&since&until` (all ancestors; not `first_parent`, see the foxtrot finding), and use `/repository/commits/:sha/merge_requests` plus each MR's `merge_commit_sha`/`squash_commit_sha` to find direct pushes.
  - Run `assertProviderConformance` on recorded responses.
- **Rekor v2 / TSA** (see above), before any real `--submit`.
