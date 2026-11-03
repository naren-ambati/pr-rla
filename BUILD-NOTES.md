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
| GitHub provider (PRs + direct pushes) | done; tested on recorded gh-aw responses and a synthetic graph; real read-only dry run on gh-aw Q3 (below). Phase 2: GHES `base_url` |
| GitLab, Bitbucket Cloud, Bitbucket Data Center providers | done in phase 2 (below); Data Center unverified against a live server |
| External Gitea/Forgejo plugin (`examples/providers/gitea`) + `docs/writing-a-provider.md` | done in phase 2 |
| JSON-file provider | done, tested |
| git-file ledger with append-only history check | done, tested |
| Provider/ledger registry, SDK exports, conformance kit | done, tested |
| github-issues ledger, GitHub Action, `review-draw` skill + `draw-context` | not started (day-3 items) |
| Claim T, fixed plans, multi-repo freeze | not started (v0.2) |
| Phase 3, bolt 1 (U1): RFC 3161 trusted time, k-of-n by operator, record schema v2, Rekor v2 client (mock-tested only) | done in bolt 1 (below) |

## Architecture

Decisions made so that later adapters and integrations need no rewrite:

1. **Provider registry** — `src/registry.ts`. Built-ins `github`, `gitlab`, `bitbucket-cloud` (alias `bitbucket`), `bitbucket-data-center` (aliases `bitbucket-server`, `bitbucket-dc`) and `json-file` (alias `json`); anything else in `.pr-rla.yml` is loaded with dynamic `import()`:
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
   - Checks: api-version, normalization, window-and-kinds, classification (PR vs direct push), merge-strategies (phase 2), no-double-counting (ids and commit SHAs), stable-sorted-ids (two runs give identical records), review-state-mapping, actors, bot-detection (phase 2), pagination (exact ids plus a minimum request count), kind-filtering and transient-faults (phase 2).
   - It is framework-agnostic (no vitest import), so third parties can run it under any runner.
   - The built-in GitHub provider passes it on recorded gh-aw data and on the synthetic graph. The JSON provider and the example template pass it too.
5. **The core is provider-free** — `src/core/*` imports only `src/sdk/*`, other core modules, and the non-SCM infrastructure (`src/beacon`, `src/translog`). `test/registry.test.ts › architecture boundaries` fails if the core imports a provider, a ledger, the registry or a command, or mentions GraphQL or the GitHub API.
   - The population builder (`src/core/population.ts`) re-checks the provider contract on every run: well-formed records, unique ids, no commit claimed by two changes, inside the window, requested kinds only.
   - `verify` (`src/core/verify.ts`) takes the provider, the ledger, the beacon source and the log key as injected dependencies.

Layout: `src/sdk` (public SDKs) · `src/core` (pure audit logic) · `src/beacon/drand.ts` · `src/translog/{merkle,rekor}.ts` · `src/providers/{github,gitlab,bitbucket-cloud,bitbucket-data-center,json-file}` plus the shared `src/providers/{http,attribution}.ts` · `src/ledgers/git-file.ts` · `src/registry.ts` · `src/config.ts` · `src/commands/*` · `src/cli.ts`. External: `examples/providers/gitea` (its own package).

## Verified (command → output)

- `npm run typecheck` → clean (TypeScript 7.0.2, strict, `noUncheckedIndexedAccess`).
- `npm run build` → `dist/` with `.d.ts`; `node -e "import('pr-rla/provider')"` (package self-reference) → `PROVIDER_API_VERSION 1`; the `./testing`, `./ledger` and `.` exports also resolve. `examples/provider-template.mjs` loads through `pr-rla/provider`.
- `npm test` → **91 tests in 9 files, all passing**:
  - `sprt` 11: stopping table 36/56/75 (p0 10%, p1 2%) and 73/113/153 (p0 5%, p1 1%); scores +0.0852 / −1.609 / 2.996; LLR 3.066 at 36 passes; "20 more passing draws needed (56 total)"; cap 144; escalation.
  - `seed` 14: round time formula, derived R for prospective (32,698,612) and retrospective (33,245,812) cases, BLS on 4 recorded quicknet rounds, 3 forged-beacon failures, draw formula and golden values.
  - `simulate` 7: ≥ 20,000 audits per row.
  - `translog` 3: RFC 6962 proofs for trees of size 1–17; mock-log submit/fetch/verify; edited `integratedTime`, swapped record and foreign log key are detected.
  - `github-provider` 19: recorded gh-aw responses + conformance; synthetic squash/merge/rebase/direct-push graph + conformance; review pagination past 100; adaptive history page size under 502s; pure history classifier (squash, merge commit, rebase, direct push, merge-SHA fallback, foxtrot merge, window) and normalizers.
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
7. **Foxtrot merges.** The first implementation walked the default branch's first-parent chain. gh-aw has 8 direct-push commits titled `Merge branch 'main' of https://github.com/github/gh-aw` in Q3: a `git pull` merge pushed to main, with the local work as first parent and the real mainline as second.
   - After such a merge, a first-parent walk follows the local side and skips the mainline. That run linked only 3,821 commits to the 3,883 PRs, leaving 62 PRs with no commit found.
   - The classifier now takes every commit in default-branch history dated in the window (GitHub `history`, all ancestors), as the brief specifies. Each commit is linked to a merged PR by association or by merge-commit SHA, or else it is a direct push.
   - Re-run: 3,944 commits = 3,883 linked (exactly one per PR, since gh-aw squash-merges) + 61 direct pushes. These are the same 61 the first-parent run found, so no direct push had been lost in this window, but now every PR is accounted for. `test/github-provider.test.ts › foxtrot merge` pins the case.
8. YAML: `authors: [copilot-swe-agent[bot]]` is invalid flow YAML. Logins must be quoted, and the config error now says so.

## Real read-only dry run: github/gh-aw, Q3 2026

Command (read-only; a token from `gh auth token`; no writes anywhere):

```
GITHUB_TOKEN=$(gh auth token) node dist/cli.js -C examples/gh-aw-q3 freeze --dry-run --out <scratch>/population.json
```

Selector: kinds `pull_request` + `direct_push`, author `copilot-swe-agent[bot]`, `no-human-review`, `max_changed_lines: 200`. Run 2026-11-03 14:27–14:49Z (about 22 min, mostly API time). Output:

```
landed on main in window: 3,944 (pull_request 3,883 · direct_push 61)
author copilot-swe-agent[bot]........... 2,947
no recorded human review................ 2,717 (merged by: 2,717 human accounts, 0 bot, …)
<= 200 changed lines.................... 1,589
N = 1,589
2,947 landed · 2,717 no recorded human review (merged by: 2,717 human accounts, 0 bot) · 1,589 ≤ 200 changed lines
provider-native, for comparison only (not used): GitHub search: merged PRs (author, window) 2,949 · GitHub search: review:none 2,311
diagnostic: PRs merged into other branches in window (excluded): 6
diagnostic: default-branch commits in window: 3,944 · commits linked to a merged PR: 3,883 · direct pushes that are merge commits: 8
```

| | pr-rla | Spec |
|---|---|---|
| Copilot PRs merged | 2,947 (into `main`) | 2,949 |
| no recorded human review | 2,717 | 2,719 |
| ≤ 200 changed lines | 1,589 | 1,590 |
| GitHub search `review:none` | 2,311 | 2,311 |
| mergers (no-human-review set) | pelikhan 2,669 · lpcox 40 · mnkiefer 5 · dsyme 3 | pelikhan 2,671 · lpcox 40 · mnkiefer 5 · dsyme 3 |
| bot-approved / of which no human decision | 1,010 / 985 | 1,010 / 985 |
| Copilot PRs with no review object | 2 | 2 |
| median size of the stratum | 53 lines | 53 lines |

**The difference is fully explained.** GitHub search counts 2,949 Copilot PRs merged into any branch. Two of them, #47508 (60 lines) and #43457 (1,540 lines), were merged by pelikhan into other Copilot branches (`copilot/resolve-issue-stringsjoinone`, `copilot/lint-monster-targeted-cleanup-again`), not into `main`. Both have no human decision. Removing them gives exactly 2,947 / 2,717 / 1,589 and pelikhan 2,669. This was confirmed with `-base:main` search queries (2 Copilot PRs; 6 PRs in all, matching the diagnostic) and a GraphQL read of both PRs. pr-rla's population is changes that landed on the default branch, so they are excluded by design.

**Direct pushes to gh-aw's `main` in Q3: 61** (all authors).
- Authors: pelikhan 39, dsyme 20, mnkiefer 1, Copilot 1.
- Timing: 16 in July, 45 in August, none in September.
- 35 are ≤ 200 changed lines. 8 are pushed `git pull` merge commits.
- Their sizes range from 1 to 483,547 lines; the largest is a "recompile" of generated lock files.
- None is authored by `copilot-swe-agent[bot]`, so the audited stratum is unchanged.
- Each is listed with "commit author != pusher" in the manifest limitations. The one `Copilot`-authored commit is classified `human`, because GitHub reports that commit-author account as a `User`. That is a known misclassification (see Limitations).

Transient API failures seen across the three full runs: HTTP 500/502/503/504 and one truncated 200 body. Runs 1 and 2 died on these (findings 5 and 6); run 3 completed with 4 retries.

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
- **Superseded in bolt 1 (below):** RFC 3161 tokens are now the time evidence for schema-v2 records, and a Rekor v2 client exists (mock-tested only).
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
- GitLab, Bitbucket and Gitea providers: done in phase 2 (below).
- **Rekor v2 / TSA** (see above), before any real `--submit`.

## Phase 2: multi-SCM providers (2026-11-03)

Goal: run on several source-control systems through the bring-your-own-provider system. The audited population stays every change that reached the default branch in the window, merged PRs/MRs plus direct pushes, with no commit counted twice under merge-commit, squash, rebase or fast-forward merges.

### Done

| Piece | Where | State |
|---|---|---|
| Conformance kit: harness, `merge-strategies`, `bot-detection`, `transient-faults` | `src/testing/conformance.ts` | done; the kit's own tests show each new check failing on a broken provider (`test/conformance.test.ts`) |
| `ProviderContext.sleep` (optional, same API version 1) | `src/sdk/provider.ts` | done |
| Shared retrying JSON client | `src/providers/http.ts` | done (Retry-After, RateLimit-Reset / X-RateLimit-Reset, the structured `RateLimit` header, truncated bodies, a hold when `remaining: 0`) |
| Lazy commit attribution | `src/providers/attribution.ts` | done: PR commit lists are read only while some commit is unclaimed |
| GitLab | `src/providers/gitlab/`, `docs/providers/gitlab.md` | done; live on gitlab.com; recorded gitlab.com + gitlab.freedesktop.org fixtures |
| Bitbucket Cloud | `src/providers/bitbucket-cloud/`, `docs/providers/bitbucket-cloud.md` | done; live on bitbucket.org; recorded fixture from that run |
| Bitbucket Data Center | `src/providers/bitbucket-data-center/`, `docs/providers/bitbucket-data-center.md` | done; **unverified against a live server** (fake server from the documented shapes) |
| GitHub Enterprise Server | `base_url` in `src/providers/github/index.ts`, `docs/providers/github.md` | done; fake GHES only |
| External Gitea/Forgejo plugin | `examples/providers/gitea/` (`pr-rla-provider-gitea`) | done; loaded from `.pr-rla.yml` in a test; live on Codeberg; recorded Codeberg fixture; its own node:test |
| Tutorial | `docs/writing-a-provider.md` | done |
| E2E with GitLab swapped in | `test/e2e-gitlab.test.ts` | done: register → freeze → sample → record → status CERTIFIED → verify 7/7, tamper fixture 1 fails check 5 only |
| Fixture recorder | `scripts/record-fixture.mjs` (`--cli` runs the CLI's `freeze --dry-run` with a recording fetch) | done |

### Kit extensions (the gaps found)

1. **No check could see a fast-forward or rebased commit leaking out as a direct push** when the fixture did not enumerate every direct push. `expect.prCommits` names the commits a PR brought in: none may come back as a `direct_push`. `expect.mergeShas` pins the commit each change landed as.
2. **Reviewer bot detection was unchecked.** It decides `no-human-review`, yet `actors` covered only author and merger. `expect.bots` / `expect.humans` must hold wherever a login appears (author, merger, every review), and `expect.reviewers` pins review authors.
3. **Retries were untested by the kit.** A factory now receives a harness (`wrapFetch`, `sleep`, `context()`). The `transient-faults` check re-runs the fixture with these faults injected:
   - a 503 on the first request;
   - a 429 with `Retry-After: 7`;
   - the SCM's own rate-limit response (`rateLimitFault`; e.g. GitHub's 403 with `x-ratelimit-remaining: 0`);
   - a 503 on the last request.

   The provider must retry the same request, wait at least as long as the headers say (recorded sleeps or wall time), and return byte-identical records. A fixture marked `http: true` whose provider bypasses the harness fails instead of being skipped.

The GitHub, json-file and template providers pass the extended kit unchanged; GitHub's tests were rewired to the harness. Skipped checks are reported as `skip`, never silently passed.

### Verified (command → output)

- `npm run typecheck` → clean. `npm run build` → clean. `npm test` → **144 tests in 17 files, all passing** (phase 1: 91 in 9). `cd examples/providers/gitea && npm install && npm test` → `# pass 1` (the kit under node:test, against `dist/`).
- **GitLab, live, read-only, no token** (2026-11-03 15:23–15:27Z, 3 min 25 s):

  ```
  node dist/cli.js -C examples/gitlab-cli-2026-10 freeze --dry-run
  [dry run] gitlab-org/cli · window 2026-10 (2026-10-01..2026-10-31 UTC) · provider gitlab
    landed on main in window: 205 (pull_request 205 · direct_push 0)
    no recorded human review................ 0
    diagnostic: MRs merged into other branches in window (excluded): 1
    diagnostic: default-branch commits in window: 414
    diagnostic: commits linked to a merged MR: 414
  ```
  - Bots approved 137 of the 205 MRs. Most of that is GitLab Duo (`GitLabDuo`, `bot: true`): 221 approval events and 95 change requests.
  - Mergers: jay_mccure 77, phikai 54, ranehebden 41.
  - 138 of the 205 MRs are ≤ 200 lines.
  - `gitlab-dependency-update-bot` authored 33 MRs. It reports `bot: false`, so it counts as human.
  - `gitlab-bot` (triage automation, also `bot: false`) approves MRs. Counted as a bot, it would leave 4 MRs with no human decision instead of 0.
- **Bitbucket Cloud, live, read-only, no token** (2026-11-03 19:06:03–19:06:17Z, 14 s, 27 requests, no 429). It ran through the CLI program with a recording fetch, which also wrote the fixture:

  ```
  node scripts/record-fixture.mjs --cli examples/bitbucket-bamboo-specs-2026-10-27 test/fixtures/bitbucket-cloud/bamboo-specs-2026-10-27.json
  $ pr-rla -C examples/bitbucket-bamboo-specs-2026-10-27 freeze --dry-run   (recording)
  [dry run] atlassian/bamboo-specs · window 2026-10-27_31 (2026-10-27..2026-10-31 UTC) · provider bitbucket-cloud
    landed on master in window: 8 (pull_request 4 · direct_push 4)
    no recorded human review................ 4 (merged by: 0 human accounts, 0 bot, 4 unknown/direct push)
    diagnostic: default-branch commits in window: 14
    diagnostic: commits linked to a merged PR: 10
  ```
  - **It equals a git clone of `master`:** 14 commits = 4 PR merge commits + 6 commits that #738 brought in from the 13.0 release branch + 4 Maven release-plugin direct pushes (24 lines each).
  - The direct pushes are linked to the account `bamboo_hg_user` (git author `bambooagent`), type `user`, so they count as human.
  - #739 and #740 are by `atlassian-renovate-bot` (`app_user`, a workspace access token), so they count as bots. Each carries a human approval.
  - An app account, "Code Reviewer", commented on #738 and #741 (bot COMMENTED).
  - It took four attempts:
    1. the first ran into the anonymous limit that exploration had used up;
    2. the second (2026-10-20..31) ran out after 50 requests;
    3. the third completed, but found 2 direct pushes instead of 4 (finding 13);
    4. the fourth ran after the fix and is the one above.
- **Codeberg (Forgejo) through the external plugin, live, read-only, no token** (2026-11-03 15:57:55–15:58:46Z, 51 s):

  ```
  node dist/cli.js -C examples/codeberg-forgejo-docs-2026-10 freeze --dry-run
  [dry run] forgejo/docs · window 2026-10 (2026-10-01..2026-10-31 UTC) · provider gitea
    landed on next in window: 30 (pull_request 30 · direct_push 0)
    no recorded human review................ 0
    diagnostic: PRs merged into other branches in window (excluded): 13
    diagnostic: default-branch commits in window: 30
    diagnostic: commits linked to a merged PR: 30
  ```
  - `viceice-bot` (Renovate, declared in `bots:`) authored and merged 10 PRs itself; every one carries a human approval.
  - 13 of the 30 PRs were merged by their authors.
- **Recorded fixtures** (scrubbed, conformance kit on each). Hand-checked against the live APIs with separate `curl`/Python reads that do not use pr-rla code:
  - `test/fixtures/gitlab/gitlab-org-cli-2026-11-02.json` (28 exchanges, 70 KB): 9 MRs (squash + merge commit), 18 commits. Hand-checked: !4290's history (GitLabDuo approved 13:09:33, `gitlab-bot` approved 13:09:38 and unapproved 14:22:09, viktomas approved 14:29:52) against GraphQL and REST `approvals`.
  - `test/fixtures/gitlab/freedesktop-xserver-2026-10-05.json` (19 exchanges, 41 KB): self-managed, **fast-forward**. Hand-checked: !2304 and !2341 have `merge_commit_sha` null and 3 and 12 commits, which are exactly the 15 commits in the window; 13 backport MRs into release branches are excluded; both were merged by `marge-bot` (`bot: false`).
  - `examples/providers/gitea/fixtures/codeberg-forgejo-docs-2026-10-01.json` (27 exchanges, 134 KB): 9 PRs into `next`, 6 into release branches. Hand-checked: #2070's reviews (REQUEST_CHANGES then APPROVED); #2219 / #2221 file stats.
  - `test/fixtures/bitbucket-cloud/bamboo-specs-2026-10-27.json` (27 exchanges, 166 KB; two 100-commit history pages make up most of it): recorded during the live Bitbucket run (above). Hand-checked against a git clone of master: 14 commits, 4 PR merges, 6 commits from #738's release branch, and 4 direct pushes of 24 lines.
- **Synthetic** (`test/helpers/scm-scenario.ts` rendered by `fake-{gitlab,bitbucket-cloud,bitbucket-dc,gitea}.ts`). Each provider passes the kit on one history containing:
  - every merge strategy;
  - direct pushes by a human and by a bot account;
  - a PR fast-forwarded *after* the window whose commits are dated inside it (not counted, not direct pushes);
  - a PR merged 2 s after the window opened with `updated_at` 2 s before it;
  - a PR into another branch;
  - review pagination past 100.

### Real-data findings (fixed in code)

1. **GitLab REST notes need a token even on public projects** (`/merge_requests/:iid/notes`, `/discussions` and `/resource_state_events` return 401). GraphQL serves the same notes anonymously, so review history comes from GraphQL.
2. **GitLab's `merged_at` can be later than `updated_at`.** gitlab-org/cli !4285: updated 14:24:14.764, merged 14:24:19.170. A listing that stops at `updated_at < window open` could miss an MR merged just after the window opened, so the listing starts 24 h early (`listing_slack_hours`).
3. **GitLab REST user objects carry `bot` only on an MR's `author`; `GET /users/:id` is 403 without a token.** GraphQL has `bot` on every user, and GitLab Duo is `bot: true` there. Without it, GitLab Duo's 221 approvals would count as human decisions.
4. **Bitbucket ignores `state=MERGED` when `q` is given.** The atlassian/aui listing returned OPEN PR #5455. `state` now goes inside `q`.
5. **Bitbucket leaves `closed_on` null on merged PRs.** The merge time and merger come from the activity's MERGED update.
6. **Bitbucket abbreviates `merge_commit.hash` to 12 characters.** It is resolved against the history, or with one `/commit/{hash}` read.
7. **Bitbucket's anonymous API budget is roughly 50–60 requests per hour**, answered with HTTP 429, a plain-text body and no `Retry-After`. It behaves like a bucket that refills at about one request per minute. Exploration exhausted it, and the first live run died after 7 attempts on one request. A second run of 2026-10-20..31 made 50 successful requests and died on the third of four direct-push diffstats. Four changes followed:
   - participants are pulled into the PR listing with `fields`;
   - PR commit lists are read lazily;
   - the listing re-scan is skipped after a single-page walk;
   - the error names `BITBUCKET_TOKEN`.

   The live window was then cut to 5 days.
8. **Bitbucket's commit `date` is the committer date**, and `/commits/{rev}` lists in git's default date order. Both were checked against a clone of bamboo-specs: 614ea18d has author 13:30:45+02:00, committer 13:30:55+02:00, and the API shows 11:30:55Z.
9. **Forgejo's PR list returns `merged_by: null`; the single-PR endpoint has it.** Each in-window PR is re-read.
10. **Forgejo reports `additions = deletions = changed_files = 0` on some merged PRs.** forgejo/docs #2219 and #2221 list 7+3 and 4+6 lines in `/files`. The plugin sums `/files` when `changed_files` is 0.
11. **Forgejo's `/commits` ignores `since`/`until`.** x-total 1,466 = the whole history. The walk stops by date itself.
12. **GHES GraphQL URL.** The GitHub provider defaulted GraphQL to `<api_url>/graphql`, which on GHES is `/api/v3/graphql` instead of `/api/graphql`, so GHES could not work through `api_url` alone. Found by reading the code, not by data.
13. **Look-alike commits on Bitbucket.** On atlassian/bamboo-specs the first complete live run found 2 direct pushes where a git clone shows 4. The Maven release plugin writes identical commits (author `bambooagent`, "prepare for next development iteration") on master and on the 13.0 release branch that PR #738 merged, and Bitbucket's API has no author date. So matching rebased copies on author + message claimed two real direct pushes for #738. Rebased copies are now matched only on the merge commit's first-parent chain (or its second parent's), at most as many as the PR lists. A unit test reproduces the case.
14. **Recorder leak, caught before commit.** Codeberg's `/branches/{b}` response carries the head commit's author e-mail. The recorder now trims it; every fixture is grepped for addresses other than `user-<hash>@example.invalid`.

### Assumptions (phase 2)

- **One review object per user for comments.** GitLab, Bitbucket and Data Center produce one `COMMENTED` per non-author user, at their first comment. GitHub and Gitea produce one per submitted review. Only the `no-review` stratum can see the difference.
- **Revoked approvals.** GitLab and Data Center map a revoked approval ("unapproved", "reset approvals … by pushing", `UNAPPROVED`) to `DISMISSED`. Bitbucket Cloud drops withdrawn approvals from its activity, so nothing is reported.
- **Review times when the SCM has none.** A GitLab reviewer state with no note is dated at the review request. A Data Center final status with no activity is dated at the merge. Both are ≤ the merge time, so they survive the freeze cutoff.
- **Rebased copies** are matched to their PR by author + first message line, but only along the merge commit's first-parent chain (Bitbucket Cloud, finding 13). Data Center and Gitea match anywhere in the window by author + author time + first message line. There, a cherry-picked PR commit pushed directly would be attributed to that PR; bounding them the same way is open question 9.
- **Bot logins** keep the SDK's `[bot]` suffix on every SCM: `GitLabDuo[bot]`, `atlassian-renovate-bot[bot]`, `forgejo-actions[bot]`.
- **Ids are not instance-qualified.** `gitlab:<path>#<iid>` is the id on every GitLab instance, which is safe within a one-repo audit.
- **The PRs that can claim commits** are those merged since the window opened, including after it closed.
- **The `merge_user` of a "merge when pipeline succeeds" / merge-train MR is `mergedBy`**: the human who set it, not GitLab's merge job.

### Unverified

- Bitbucket Data Center against any real server: every field and action name comes from Atlassian's documentation.
- GitHub Enterprise Server against a real instance.
- Private repositories and token scopes on every SCM. Every live run here was anonymous on public projects.
- Bitbucket Cloud's rebase strategies (how `/pullrequests/{id}/commits` lists rebased PRs) and its `diffstat` of merge commits. The rebase-key fallback covers the worst case.
- GitLab on instances older than 17.x (no "requested changes" notes), and the exact wording of the "reset approvals from @… by pushing to the branch" note: it is written from GitLab's documented behaviour and has not been seen in recorded data, so it is covered only by the synthetic instance.

### Open design questions (candidates for an AI-DLC review)

1. **Bots on regular accounts change the stratum.** GitHub's `Copilot`, GitLab's `gitlab-bot` / `gitlab-dependency-update-bot` / `marge-bot`, Bitbucket's `bamboo_hg_user` and Gitea's Renovate accounts are all "users". On gitlab-org/cli this moves 0 → 4 MRs into "no human review". Gitea has no flag at all, so its plugin takes a `bots` option, but provider options are **not registered**. Should the registration carry an explicit, hashed bot list that every provider applies?
2. **The direct-push population is not stable over time.** A commit *dated* in the window but pushed after `freeze` becomes reachable later. `verify` then sees an extra change and fails check 5. This affects GitHub as well. Fixes:
   - record the default-branch head SHA in the manifest and walk history from it in `verify` (needs a `head` field in `ListChangesRequest`: an SDK question);
   - window direct pushes by *push* time where the SCM exposes it. GitLab's Events API (`/projects/:id/events?action=pushed`) is readable without a token and gives the pusher, the push time and the commit range; GitHub has no durable equivalent.
3. **Provider identity in the manifest.** Only `provider.name` + `apiVersion` are recorded, not the package version, an integrity hash or the options. A verifier could rebuild the population with a different provider release or options.
4. **Release branches merged by a direct push** bring every release-branch commit in as a separate direct push. On bamboo-specs, `Tardigrade`'s automated branch merge of 2026-10-06 is one. PRs merged into the release branch do not count. Is that the intended population?
5. **`no-review` is provider-dependent** (assumption 1), and so is `DISMISSED` (assumption 2). Should the SDK define what one review object is?
6. **Login identity.** Selectors match logins. Bitbucket nicknames are not unique or permanent, and GitLab usernames can be renamed. Should `Actor` carry a stable account id?
7. **Cost of a genuine direct push.** It forces reading every PR's commit list merged since the window opened (lazy attribution cannot stop early). For an old window on Bitbucket's anonymous budget, that is unaffordable. Should `freeze` cache or resume, or should providers use commit → PR indexes (GitLab has one; Bitbucket's needs an app; Gitea's only knows merge commits)?
8. **An HTTP helper in the SDK?** The Gitea plugin re-implements about 60 lines of retry and rate-limit handling that built-ins share in `src/providers/http.ts`. Exporting it from `pr-rla/provider` would widen the versioned API.
9. **Rebase matching outside Bitbucket Cloud.** Data Center and the Gitea plugin still match rebased copies anywhere in the window (author + author time + message). That is safe against the bamboo-specs look-alikes, which differ in author time, but not against cherry-picks. Bound them to the merge commit's chain as on Bitbucket Cloud?

## Bolt 1 (U1): trusted time (2026-11-03)

Goal (delivery-plan.md, bolt 1): RFC 3161 tokens over each signed record's SHA-256 from k = 2 of n independent authority operators, checked offline; record schema v2 in full; the Rekor v2 client, mock-tested only; the gh-aw prospective registration prepared, not made.

### Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR1.1 tokens over the digest; only the digest and a nonce leave | met | `timestamp-client.test.ts › FR1.1` parses all eight recorded requests: version, SHA-256 imprint = the record digest, nonce, certReq, nothing else (< 70 bytes) |
| FR1.2 offline check of each token; recorded tokens from all eight verify; six tamper fixtures fail | met | `timestamp-verify.test.ts` (rules 1–7 each violated once; all eight recorded tokens); `timestamps-e2e.test.ts › six tamper fixtures` |
| FR1.3 library evaluation recorded | met: pkijs 4.0.1 + asn1js 4.0.0 chosen (below) | `timestamp-library.test.ts` |
| FR1.4 tokens bound the signed time, never replace it | met | `timestamp-verify.test.ts › FR1.4`: different genTimes, same round |
| FR1.5 k-of-n, k = 2, `init` writes the four defaults, one operator counts once | met | `› k-of-n by operator`, `timestamps-e2e.test.ts › init` |
| FR1.6 no authority, or none reachable: the line everywhere, no fallback | met | `timestamps-e2e.test.ts › FR1.6` (status, verify, and the CERTIFIED line) |
| FR1.7 Rekor optional; v1 records verify via integratedTime; v2 client mock-tested; warning first; no Rekor connection in the suite | met | `rekor-v2.test.ts`, `v1-compat.test.ts`, the network-deny harness |
| FR1.8 clock skew over 10 min refused | met | `› FR1.8`: 601 s refused (exit 1, nothing written), 599 s accepted |
| FR1.9 gh-aw configuration and command prepared; no registration made | met, with the founder's change (after bolt 3) | `docs/gh-aw-prospective.md`, `audits/gh-aw-prospective/` |
| FR1.10 retries ≤ 5 min; no `--retry-timestamps` | met | `timestamp-client.test.ts` (fake clock; option list) |
| FR1.11 fewer than k: record written, both lines, exit 5; no authority: exit 0 | met | `timestamps-e2e.test.ts › the outcome table` |
| Six tamper fixtures fail as specified | met | edited genTime (rule 3), wrong imprint (rule 2), foreign root (rule 6), expired signer (rule 6), 10 min 61 s with no accuracy (rule 7): check 1 FAIL; too few tokens for k: `TIMESTAMP NOT TAMPER-PROOF (1 of 2)` |
| v1 E2E prints 7/7 | met | `e2e.test.ts` (now on schema v2 with two mock authorities) and `v1-compat.test.ts` (a v1 audit written by the phase-2 code before any writer changed) |
| The founder runs `register` (FR1.9) | not in this bolt, by the founder's change: after bolt 3 | `docs/gh-aw-prospective.md` |

### Done

| Piece | Where |
|---|---|
| Record schema v2 in full: registration (`repos`, `timestamping`, `plugins`, `verdicts`, `prRlaVersion`), manifest (`repos`, provider identity), commitment, `TimestampEvidence` in the envelope | `src/core/records.ts` |
| Token verifier (rules 1–7, k-of-n by operator, U_k), pure | `src/timestamp/verify.ts` |
| Token client: one TimeStampReq per authority, in parallel, through the broker contract | `src/timestamp/client.ts` |
| Trust bundle (eight authorities) and its update script | `src/timestamp/trust-bundle.json`, `src/timestamp/bundle.ts`, `scripts/update-trust-bundle.mjs` |
| Broker contract and the minimal adapter (15 s per request, 5-minute deadline, Sectigo/FreeTSA spacing) | `src/net/contract.ts`, `src/net/minimal-adapter.ts` |
| Atomic writes; exit codes 0–5 | `src/io/atomic.ts`, `src/cli/exit-codes.ts` |
| `register`/`freeze`: tokens, skew refusal, the outcome table, `freeze --force`; `status`/`verify`: offline evidence, `(n of k)` lines, versions; `--tsa-trust` | `src/commands/*` |
| Rekor v2 client and verifier (inclusion proof, C2SP checkpoint), `--rekor-api v2`, `--yes` | `src/translog/rekor-v2.ts`, `src/commands/translog.ts` |
| Network-deny test harness | `test/setup/network-deny.ts` |
| Recorded tokens from all eight authorities; the demo audit; the recorder | `test/fixtures/tsa/recorded-2026-11-03.json`, `test/fixtures/audits/tsa-demo/`, `scripts/record-tsa-fixtures.mjs` |
| Synthetic authorities and a mock TSA server; a mock Rekor v2 log | `test/helpers/test-tsa.ts`, `test/helpers/mock-rekor-v2.ts` |

### Library evaluation (FR1.3)

Candidate: `pkijs` + `asn1js`. Checked 2026-11-03 (npm registry for versions, dates and advisories; everything else offline).

| Criterion | Result |
|---|---|
| Parses `TimeStampResp`, `TimeStampToken`, CMS `SignedData` with signed attributes | yes: all eight recorded responses (`timestamp-library.test.ts`) |
| Verifies the signature over the DER `signedAttrs`: RSA PKCS#1 v1.5, RSA-PSS, ECDSA P-256, P-384 | yes. Real tokens: RSA PKCS#1 v1.5 (DigiCert, GlobalSign, Microsoft, SwissSign, Sectigo), ECDSA P-384 (Sigstore, GitHub, FreeTSA). No bundled authority uses RSA-PSS or P-256, so those two are synthetic tokens minted with pkijs. A flipped signature bit fails in every case |
| ESM-importable on Node ≥ 22.13 | yes, on Node 22.23.2 (`"type": "module"`; engines `^20.19.0 \|\| >=22.12.0`) |
| A release in the last 12 months; no unaddressed advisory | pkijs 4.0.1 on 2026-10-27 (3.4.2 2026-10-20, 4.0.0 2026-10-22); asn1js 4.0.0 on 2026-10-19. `npm audit`: 0 vulnerabilities |
| Installed size and dependencies | pkijs 912 KB and asn1js 184 KB, plus @noble/hashes 804 KB, @peculiar/utils 268 KB and bytestreamjs 132 KB: about 2.3 MB in 5 packages (pkijs declares 3 dependencies and asn1js as a peer) |

**Outcome: the library qualifies and is used; no DER walker was written.** Pinned exactly (`"pkijs": "4.0.1"`, `"asn1js": "4.0.0"`) with lockfile integrity (NFR22, asserted by a test).

What the library does not check, and pr-rla does on its parsed structures: the nonce and that the imprint algorithm is SHA-256 (rule 2), ESSCertID (rule 4), an EKU of exactly `timeStamping` and critical (rule 5; pkijs exposes criticality, so no DER walk was needed), the chain to an anchor pinned for that authority with every certificate valid at genTime (rule 6), the tolerance (rule 7), SHA-1 rejection, and that the content-type attribute names TSTInfo. One API fact: pkijs's `SignedData.verify` for TSTInfo content wants the timestamped data itself, not the digest; `verify` always has the record, so it passes `canonicalJson(record)`.

Oracle: `openssl ts -verify` (OpenSSL 3.6.4) accepts all eight recorded tokens with the bundle's anchors (a test; skipped only if `openssl ts` is missing). Sectigo is the exception that needed a different anchor: its ESSCertID list names its cross-signed chain up to USERTrust RSA, and OpenSSL requires every listed certificate in the chain it builds, so anchored at the self-signed R46 that pr-rla pins it reports `ess cert id not found`; anchored at USERTrust RSA it prints `Verification: OK`. pr-rla checks the first ESSCertID (the signer), which is what RFC 5035 requires. Microsoft needs `-partial_chain` because its anchor is an intermediate (below).

### Live authority results

Two rounds of hash-only requests, one per authority each (16 in all): a probe for the evaluation (SHA-256 of a fixed string, 22:04:50Z), and the recording (the demo registration's digest `d293ce73…`, 22:32:27Z). **All eight worked both times**: HTTP 200, `application/timestamp-reply`, status granted, nonce echoed, every token accepted.

| Authority | Recorded ms | Signature | Accuracy | ESSCertID | Chain in the token | Anchor pinned, and from where |
|---|---|---|---|---|---|---|
| sigstore | 345 | ECDSA P-384 / SHA-256 | 1 s | v2 | leaf only | `sigstore-tsa-selfsigned`: TUF `trusted_root.json` from npm's `@sigstore/tuf` 4.0.2 seeds, identical to gh's TUF cache |
| digicert | 144 | RSA-4096 / SHA-256 | none | v1 + v2 | leaf, CA1 2025, Root G4 (cross-signed) | DigiCert Trusted Root G4: macOS system roots and Node's Mozilla roots |
| globalsign | 573 | RSA-3072 / SHA-384 | 1 s | v2 | leaf, R45 TS CA 2025, TS Root R45 (cross-signed), R6 | GlobalSign Root CA - R6: macOS and Node roots |
| microsoft | 550 | RSA-4096 / SHA-256 | 500 ms | v2 | leaf, Public RSA Timestamping CA 2020 | **the intermediate**, from its own response (TOFU): the root is not in the token or in any local store |
| github | 277 | ECDSA P-384 / SHA-384 | 1 s | v2 | leaf only | Internal Services Root: gh CLI's TUF cache of tuf-repo.github.com (fetched by gh 2026-10-20) |
| swisssign | 554 | RSA-3072 / SHA-256 | 500 ms | v2 | leaf, ICA 2021, root | the root, from its own response (TOFU) |
| sectigo | 655 | RSA-4096 / SHA-384 | none | v1 only | leaf, CA R41, Root R46 (cross-signed) | Sectigo Public Time Stamping Root R46: macOS system roots (not in Node's Mozilla store) |
| freetsa | 304 | ECDSA P-384 / SHA-512 | none | v1 | leaf, root | the root, from its own response (TOFU) |

No anchor was fetched from the network: the only live calls in this bolt were these 16 token requests (plus the npm registry for installing, `npm view` and `npm audit`). drand was not needed. No Rekor host was contacted, by the build or by the suite.

### Verified (command → output)

From a fresh `git clone` of the repo at `e1822b8`, 2026-11-03:

```
npm ci                                   → added 60 packages … found 0 vulnerabilities
npm run build                            → exit 0
npm run typecheck                        → exit 0
npm test                                 → Test Files 24 passed (24) · Tests 259 passed (259)
npm --prefix examples/providers/gitea ci → added 1 package … found 0 vulnerabilities
npm --prefix examples/providers/gitea test → ok 1 - conformance on recorded Codeberg responses … # pass 1 # fail 0
```

- 259 tests = the phase-2 144 (unchanged; registry gained one boundary test, 145) + 114 new: `timestamp-verify` 40, `timestamps-e2e` 23, `timestamp-library` 20, `timestamp-client` 16, `rekor-v2` 7, `net-io` 5, `v1-compat` 3. None skipped (the OpenSSL oracle ran).
- `npm test` makes no network call: every socket outside 127.0.0.1 is refused, and a test file fails afterwards if anything tried (checked with a throwaway test that swallowed a fetch error: `network-deny: this test file tried to reach example.com`).
- `npm ls --prod --depth=0` → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1 (NFR9).

**The demo, live** (`node scripts/record-tsa-fixtures.mjs`, 2026-11-03T22:32:27Z, on a copy of `test/fixtures/audits/tsa-demo`):

```
$ pr-rla register
registration d293ce73c828… · acme/widgets · window demo-2026-q4 (2026-11-09..2026-12-20)
  …
  provider json-file (builtin 0.1.0) · ledger git-file · verdict provenance self-asserted
  seed round R = 35031412 (drand quicknet), publishes 2026-12-22T00:00:00Z: 24 h after the window close
  PROSPECTIVE · registration existed by 2026-11-03T22:32:28Z (U_k)
  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN
(exit 0)

other bundled authorities, same digest: github, swisssign, sectigo, freetsa
  github: accepted · genTime 2026-11-03T22:32:28Z · ECDSA P-384 / SHA-384
  swisssign: accepted · genTime 2026-11-03T22:32:28Z · RSA PKCS#1 v1.5 3072 / SHA-256
  sectigo: accepted · genTime 2026-11-03T22:32:28Z · RSA PKCS#1 v1.5 4096 / SHA-384
  freetsa: accepted · genTime 2026-11-03T22:32:28Z · ECDSA P-384 / SHA-512

$ pr-rla verify --offline              (after moving sigstore's genTime one minute earlier, in the token and the record)
1. FAIL registration: registered 2026-11-03T22:32:27Z, proven by 2026-11-03T22:32:28.187Z before the window opened → PROSPECTIVE
        FAIL registration token from sigstore: rule 3: Error during verification: Message digest doesn't match
        registration timestamps: 3 of 4 TSAs (digicert, globalsign, microsoft) · k = 2 · PROVEN · existed by 2026-11-03T22:32:28.187Z (U_k)
…
FAILED: check 1 (registration), check 2 (manifest before seed)
```

Check 2 fails there only because the demo audit has no manifest. Before the forgery, `verify --offline` gave check 1 PASS with `4 of 4 … PROVEN`. The same demo replays offline in `timestamps-e2e.test.ts` from the recorded responses (same clock and nonces, so the same digest), with a forged DigiCert token failing check 1.

### Deviations from the design, and why

1. **Three anchors are trust-on-first-use.** The design pins every authority's root. Without an external fetch beyond the authorities themselves, no independent copy of Microsoft's root (Microsoft Identity Verification Root CA 2020), SwissSign's root or FreeTSA's root exists on this machine. They are pinned from the authorities' own responses with `independent: false`; Microsoft's at its intermediate, because its token omits the root. Each should be confirmed from a second source before release (`scripts/update-trust-bundle.mjs --anchors <file>#<label>`).
2. **The commitment and manifest v2 keep the v1 fields** that contracts.md §5 does not list (commitment: `window`, `N`, `registrationSha256`, `seedRound`, `seedRoundPublishesAt`; manifest: `window`, `selector`, `parameters`, `protocolSha256`, `funnel`, `limitations`, `N`). Checks 2 and 3 read them ("a commitment naming a different round fails check 3"), and the draft's `03` §4 says a v2 record differs from v1 only where listed. `repo` and `defaultBranch` moved into `repos`.
3. **`prRlaVersion`** was added to the registration, manifest and commitment v2. FR1.9 needs `verify` to print the registering and freezing versions, and `PluginIdentity.version` holds the plugin's version for external providers. `PluginIdentity` on the manifest also keeps `apiVersion`.
4. **Tokens are checked as they arrive.** A token failing rules 1–7 is reported and not stored, because a stored bad token would make an honest record FAIL `verify` forever. The skew check uses the median genTime of tokens that pass rules 1–6, so a skewed local clock gets the skew message rather than `0 of k`.
5. **A Rekor v1 entry on a v2 record** counts as one bound from operator Sigstore (as the draft says), with U = integratedTime + 1 s, and only if it is within the tolerance of the signed time.
6. **The Rekor v2 client was built without re-reading rekor-tiles `CLIENTS.md`:** this bolt allowed no external call beyond the authorities and drand. The request (`hashedRekordRequestV002`), the TransparencyLogEntry fields and the checkpoint come from the documented API as known; the checkpoint key id follows C2SP for Ed25519 and Sigstore's SHA-256-of-DER convention for ECDSA. All of it is unverified until a real log is used, and `--submit --rekor-api v2` says so.
7. **`selector.bots` and `direct_push_via_merge`** are registered (`[]`, `include`) and any other value is refused until bolt 5 applies them, so a registration never signs a stratum this build does not compute. `verdicts.minProvenance` is always `self-asserted` in this bolt (there is no issue ledger yet).
8. **`--tsa-trust`** is also on `register` and `freeze` (the design names it for `verify`), so an authority outside the bundle can be used. `verify` never trusts anchors from the audit repo itself; only the verifier's own `--tsa-trust` files.
9. **A config with no `timestamping` block** gets the four defaults with k = 2. The test scenarios write `authorities: []` unless they bring mock authorities; the phase-2 e2e scenarios now run with two mock authorities, so their schema-v2 records stay tamper-evident and every original assertion still holds (the GitLab e2e's manifest-provider assertion now checks the full v2 identity, and one line of `e2e.test.ts` gained a type-only cast).
10. **`freeze --force`**: the printed re-run command needs it, so `freeze` now refuses to replace an existing manifest without it (checked after the "R is public" refusal, which is unchanged).
11. A v1 registration (made before bolt 1) is frozen as v1, so one audit is one schema.
12. `src/core/records/` in units-of-work.md is `src/core/records.ts`, one module.
13. The Gitea example gained a `package-lock.json`, so the delivery plan's `npm --prefix examples/providers/gitea ci` works (phase 2 used `npm install`).
14. The gh-aw hand-off follows the founder's change of 2026-11-03 (register after bolt 3, `github-issues`, `account`); the hand-off fields in `functional-design.md` §U1 (`git-file`, `self-asserted`) are superseded. The design's founder decisions, README and delivery plan carry the change note.

### Findings

- Sectigo's ESSCertID list and OpenSSL's strict check (above). pr-rla's anchor for Sectigo (the self-signed R46) is in the macOS system roots but not in Node's bundled Mozilla roots, so a Linux maintainer rebuilding the bundle needs `--anchors`.
- The draft's "Sigstore: ECDSA P-384" is the key; its signatures use SHA-256. GlobalSign and SwissSign add the CMSAlgorithmProtection attribute; nothing rejects it.
- When an authority is down, `register` waits out its 5-minute deadline even after k others have answered (the designed policy). With a mock authority failing every request, that was 19 attempts in 297 s on the fake clock.

### Unverified

- Rekor v2 against any real log (D3); the interactive `--rekor-api v2` confirmation through a terminal (tests inject the confirm function).
- The three TOFU anchors (Microsoft, SwissSign, FreeTSA) against an independent source.
- An old DigiCert token after a real certificate rotation (NFR21): only a synthetic token whose signer certificate has since expired is tested.
- Sigstore TSA terms and rate limits (none published that I could check offline).
- The OpenSSL oracle and the bundle script on Linux; Windows at all.
- A full audit (`freeze` included) against the real authorities: only `register` ran live; `freeze` with tokens is tested on mock authorities.

### What bolt 2 needs to know

- Swap the adapter for the broker in one place: `brokerFor(ctx)` in `src/commands/context.ts`. The `tsa` policy and its tests (`timestamp-client.test.ts`: 15 s, 5-minute deadline on a fake clock, Sectigo/FreeTSA spacing, 429 `Retry-After`, no retry on 4xx) should pass unchanged against the broker. Timestamp requests carry `pluginId: "pr-rla/timestamp"`, `destination: "tsa"`, `idempotent: true`; the Rekor v2 client uses `destination: "rekor"`, `idempotent: false`.
- drand (`src/beacon/drand.ts`), Rekor v1 (`src/translog/rekor.ts`) and the providers still call `ctx.fetch` directly; they are bolt 2's to move.
- The broker must take the command's clock: the tests pass `ctx.nowMs` and a `ctx.sleep` that advances the fake clock, and the retry deadline relies on both.
- `CommandContext` gained `sleep`, `nonceFor` (recorded-response replays), `tsaTrust` and `confirm`.
- The network-deny harness allows loopback only; mock servers must listen on 127.0.0.1.
- Exit code 5 and `src/io/atomic.ts` exist for every later unit; `writeJson` already writes atomically.
