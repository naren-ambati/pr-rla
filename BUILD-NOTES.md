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
| GitHub Action, `review-draw` skill + `draw-context` | not started (day-3 items) |
| Claim T, fixed plans, multi-repo freeze | not started (v0.2) |
| Phase 3, bolt 1 (U1): RFC 3161 trusted time, k-of-n by operator, record schema v2, Rekor v2 client (mock-tested only) | done in bolt 1 (below) |
| Phase 3, bolt 2 (U2a): the fetch broker (every outbound request), published-limit rate defaults, the `src/api` foundation | done in bolt 2 (below) |
| Phase 3, bolt 3 (U4): `github-issues` and `gitlab-issues` ledgers, the ledger kit, the Jira example, ledger checkpoints and their git transport, `account` provenance | done in bolt 3 (below) |
| Phase 3, bolt 4 (U2b): `pr-rla.lock.json`, the isolated plugin host (`pr-rla/ipc/v1`), `trust: full`, `--plugins builtin-only`, `plugin add` / `lock` / `check` | done in bolt 4 (below) |
| Phase 3, bolt 5 (U3): `selector.bots`, the pinned head, `Actor.id`, `reviewGranularity`, `pr-rla/http`, `landedVia` and `direct_push_via_merge` | done in bolt 5 (below) |
| Wave 1 integration: bolts 3, 4 and 5 on one branch | done (below): traits and provenance over IPC, `hostFromOption` credentials, external ledgers in the plugin host, the 204 fix |

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

> **Update, 2026-11-04 (ledger, selector and provider fix round).** Everything on this page, the output block and the table, is what the run printed *before the post-merge/self-review fix* and is kept as it was. The selector now counts a review only if it was submitted at or before `mergedAt` and its reviewer is not the author. Re-running the selector over this run's recorded listing (the same 3,944 changes, reviews as of the same freeze time) gives 2,947 / **2,718** / 1,589: PR #51168 had a human APPROVED review 14 minutes after it merged, and it is 221 lines, so N is unchanged. The other numbers in the table are unaffected, except: pelikhan merged 2,670 (not 2,669) of the no-human-review set, and bot-approved-with-no-human-decision is 986 (not 985). The spec's own figures move the same way (2,719 → 2,720 over its 2,949; the two other-branch PRs, #47508 and #43457, carry no human approval before or after merging, checked by three read-only GETs each on 2026-11-04). See "Ledger, selector and provider fix round" at the end.

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

## Bolt 2 (U2a): the fetch broker and the `src/api` foundation (2026-11-03)

Goal (delivery-plan.md, bolt 2): one network path for every outbound HTTP request (host allowlist, read-only guard, credential swap, a per-host rate governor with published-limit defaults, per-destination timeouts, the single retrier, a recorder), the built-in providers behind it at `maxRetries: 0`, U1 rewired onto it, and `src/api/context.ts` with read-only and read-write modes.

### Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR10.1 every built-in provider and ledger (and later the MCP server) calls through one broker; the phase-2 suite passes unchanged | met | the 259 earlier tests pass unchanged; `api-context.test.ts › every outbound request came through the broker` runs `register --submit` and `freeze --submit` against a GitLab instance, two authorities and a Rekor log (all mocks) and finds every request carrying `redirect: "manual"`, which only the broker sets; drand too (`› drand goes through the broker`) |
| Built-ins at `maxRetries: 0` behind the broker; the conformance kit passes unchanged | met | `broker.test.ts › the built-in providers make one attempt per request` (each of the four: alone it gives up on the first 503; behind the broker it recovers; seven 502s give `gave up after 7 attempts`). Every built-in still passes `transient-faults`, now through the kit's broker-shaped harness, since the clients no longer retry |
| U1 rewired onto the broker; `timestamp-client.test.ts` passes unchanged | met | `brokerFor(ctx)` returns the command's broker; `createMinimalBroker` is now a wrapper that builds the broker, so the file's 15 s, 5-minute-deadline, spacing, Retry-After and 4xx tests run against the broker's own `tsa` policy, unchanged |
| FR10.2 retries with backoff and jitter on 429, 5xx, timeouts and truncated bodies, honouring `Retry-After` and reset headers | met | `broker.test.ts › FR10.2` (7 tests): 503, 429 + `Retry-After: 9` and a truncated body, then success, with waits `[750, 9000, 1500]`; gives up after 7 attempts naming the status; header waits are not attempts; blind-429 early stop; no retry on 4xx; non-idempotent rules |
| FR10.3 a guarded `POST` mutation throws `ReadOnlyViolation` | met | `broker.test.ts › FR10.3` (5 tests): GET, HEAD and GraphQL queries pass (keywords inside strings and comments do not fool the tokenizer); mutations, subscriptions, REST POST/PUT/PATCH/DELETE/OPTIONS and unreadable GraphQL bodies are refused and nothing is sent; a cross-host redirect is refused for a plugin held to its hosts; every built-in GraphQL document is a query |
| FR10.4 two parallel callers share one budget under a fake clock; a header lower than the default slows the pace | met | `broker.test.ts › FR10.4` (6 tests): shared starts `[0, 0, 500, …, 4000]` against 4 at once with a broker each; GitLab.com's anonymous default 500/min against a server saying 3 (the fourth request waits 61 s); headers above the default win too (the gh-aw case); GitHub's `search` budget does not pace `core`; `Retry-After` pauses the host for every caller; concurrency limit |
| FR10.5 a request to an undeclared host has no `Authorization` header | met | `broker.test.ts › FR10.5` (5 tests): placeholder swapped for the declared host; refused unsent for any other (`CredentialHostMismatch`); `prrla-basic:` becomes Basic auth for declared hosts only; placeholders in URLs and bodies are never swapped; no credential follows a redirect to another origin |
| NFR12 every default equals its table value; one raised through configuration is followed | met | `broker.test.ts › NFR12` (3 tests): the reviewed table row by row with its source URL; `rate_limits: { api.bitbucket.org: { anonymous: 600/h } }` from `.pr-rla.yml` lets the 61st anonymous request through at 0 s, where the default makes it wait 60 s; unknown rules and malformed rates are refused by name |
| NFR14 hanging servers time out at 15 s (authority) and 30 s (SCM) | met | `broker.test.ts › NFR14` (4 tests, one per destination, against a server on 127.0.0.1 that never answers): the broker arms 30 000 ms (scm, rekor) and 15 000 ms (tsa, beacon) and turns the timer's firing into `BrokerTimeout`; the real-timer version is bolt 1's `an attempt is aborted at its destination timeout`, now against the broker |
| No recorder in read-only mode; `writePaths` enforced for ledger writes | met | `broker.test.ts › step 7` (2), `› ledger writes only under declared writePaths` (2) |
| `src/api/context.ts` exists with read-only and read-write modes | met | `api-context.test.ts › AuditContext modes` (4 tests) |
| Demo: a guarded `POST` throws `ReadOnlyViolation`; two parallel callers share one budget | met | `node scripts/demo-broker.mjs`, below |

### Done

| Piece | Where |
|---|---|
| The broker: the seven-step pipeline, `bind(pluginId)` for plugins and components, roles by id (`provider:<name>`, `ledger:<name>`, `pr-rla/<component>`) | `src/net/broker.ts` |
| Rate governor: token buckets per host and auth state, server windows per reported resource, host pauses, concurrency slots | `src/net/governor.ts` |
| Default budgets with sources; `rate_limits` parsing and overrides | `src/net/rate-limits.ts`, `src/config.ts` |
| GraphQL operation tokenizer | `src/net/graphql.ts` |
| Typed errors: `HostNotAllowed`, `ReadOnlyViolation`, `WritePathNotAllowed`, `CredentialHostMismatch`; `BrokerTimeout` and `BrokerRetriesExhausted` gain `attempts`, `status`, `rateLimited`; `BrokerInit.retry` | `src/net/contract.ts` |
| The phase-2 retry policy in one pure module, shared by the broker, the clients and the kit | `src/sdk/http.ts` |
| Built-in clients at `maxRetries: 0`, passing their rules in `retry`; `hosts()` on every built-in definition | `src/providers/http.ts`, `src/providers/github/http.ts`, `src/providers/*/index.ts` |
| SDK definition fields `hosts`, `credentials` (providers and ledgers), `writePaths` (ledgers), validated at load | `src/sdk/provider.ts`, `src/sdk/ledger.ts` |
| The kit's broker-shaped harness | `src/testing/conformance.ts` |
| `AuditContext` (mode, clock, log, one broker), `openProvider`, `openLedger` (read-only view in read-only mode), `requireReadWrite`, `AuditApiError` | `src/api/context.ts` |
| Every command on one broker per `CommandContext`; drand and Rekor v1 through it; broker errors print `next:` | `src/commands/context.ts`, `src/commands/translog.ts`, `src/translog/rekor.ts`, `src/cli.ts` |
| Bolt 1's adapter as a wrapper over the broker | `src/net/minimal-adapter.ts` |
| Fixture recorders through the broker; the demo | `scripts/record-fixture.mjs`, `scripts/record-github-fixture.mjs`, `scripts/demo-broker.mjs` |
| Tests: 49 new | `test/broker.test.ts` 39, `test/api-context.test.ts` 8, `test/conformance-broker.test.ts` 2; `test/helpers/fake-clock.ts` |

### Default rate limits (NFR12)

Each is the smallest limit the service publishes for the request's auth state, read from the source page on 2026-11-03. A request with an `Authorization` or `Private-Token` header is authenticated. Every rule is a token bucket (`burst` at once, refilled at the rate). "Primary" rules are replaced by the server's own rate-limit headers once a response carries them; secondary ones always apply.

| Service (hosts) | Rule (`rate_limits` key) | Default | Published limit | Source |
|---|---|---|---|---|
| GitHub (`api.github.com`; GHES hosts from `base_url`) | `rest` (authenticated, primary) | 1,000/h | `GITHUB_TOKEN`: 1,000 requests per hour per repository (personal tokens 5,000) | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api |
| | `rest_anonymous` (primary) | 60/h | unauthenticated: 60 requests per hour | same |
| | `rest_points` | 900 points/min (reads 1, writes 5) | no more than 900 points per minute for REST endpoints | same |
| | `graphql` (authenticated, primary) | **1,000 points/h** (1 per request until headers report cost) | `GITHUB_TOKEN`: 1,000 points per hour per repository (users 5,000) | https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api |
| | `graphql_points` | 2,000 points/min (queries 1, mutations 5) | no more than 2,000 points per minute for the GraphQL endpoint | same |
| | `writes_per_minute`, `writes_per_hour` | 80/min, 500/h | no more than 80 content-generating requests per minute and 500 per hour | REST page |
| | `concurrency` | 100 in flight | no more than 100 concurrent requests | REST page |
| GitLab.com (`gitlab.com`; self-managed hosts from `base_url`) | `api` (authenticated, primary) | 2,000/min | authenticated API traffic for a user: 2,000 requests each minute | https://docs.gitlab.com/user/gitlab_com/rate_limits/ |
| | `api_anonymous` (primary) | **500/min** | unauthenticated traffic from an IP address: 500 requests each minute | same |
| Bitbucket Cloud (`api.bitbucket.org`) | `repositories` (authenticated, `/2.0/repositories/*`, primary) | 1,000/h | 1,000 per hour (scaled to 10,000 only for large paid workspaces with access tokens) | https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/ |
| | `anonymous` (primary) | 60/h | 60 requests per hour across all API resources | same |
| Bitbucket Data Center (hosts from `base_url`) | `api` (authenticated) | burst 60, refill 5/s | default token bucket: size 60, refill 5 per second, per user | https://confluence.atlassian.com/bitbucketserver/improving-instance-stability-with-rate-limiting-976171954.html |
| Jira Cloud (`*.atlassian.net`) | `issue_writes_2s`, `issue_writes_30s` (one bucket per issue) | 20 per 2 s, 100 per 30 s | per-issue write limits | https://developer.atlassian.com/cloud/jira/platform/rate-limiting/ |
| Sectigo (`timestamp.sectigo.com`) | `spacing` | 1 per 15 s | "add a delay of 15 seconds or more between each one" | https://www.sectigo.com/resource-library/time-stamping-server |
| FreeTSA (`freetsa.org`) | `spacing` | 1 per s | "a maximum of one timestamping request per second per IP address" | https://freetsa.org/freetsa.html |
| Other authorities, drand | none | one request per record or round | none published | n/a |

`.pr-rla.yml` changes any rule: `rate_limits: { api.github.com: { rest: 5000/h, concurrency: 50 }, bitbucket.example.com: { api: { rate: 10/s, burst: 120 } } }`.

### Live checks (read-only, unauthenticated, 2026-11-03T23:04:14Z)

Three requests, rate-limit headers only, no token:

```
$ curl -sD - -o /dev/null https://gitlab.com/api/v4/projects/gitlab-org%2Fcli
HTTP/2 200 · ratelimit-limit: 500 · ratelimit-name: throttle_unauthenticated_api · ratelimit-observed: 1 · ratelimit-remaining: 499 · ratelimit-reset: 1793747100
$ curl -sD - -o /dev/null https://api.github.com/repos/github/gh-aw
HTTP/2 200 · x-ratelimit-limit: 60 · x-ratelimit-remaining: 59 · x-ratelimit-used: 1 · x-ratelimit-resource: core · x-ratelimit-reset: 1793750654
$ curl -sD - -o /dev/null https://api.bitbucket.org/2.0/repositories/atlassian/bamboo-specs
HTTP/2 200 · (no rate-limit header)
```

- **GitLab.com's unauthenticated limit is settled: 500 requests per minute.** The docs say so and the live header agrees (`throttle_unauthenticated_api`, a reset 46 s ahead, so per minute).
- **`GITHUB_TOKEN`'s GraphQL budget is lower: 1,000 points per hour per repository**, by GitHub's GraphQL rate-limit page. It cannot be read with an unauthenticated call (only Actions issues that token), so it rests on the docs.
- GitHub's anonymous REST limit (60, resource `core`) is confirmed. Bitbucket Cloud sends no rate-limit header on an anonymous 200, as phase 2 saw on its 429s, so its defaults bind for the whole run.
- The other pages were read (WebFetch), not called.

### Verified (command → output)

From a fresh `git clone` of the repo at `be3ad2f`, 2026-11-03T23:33Z, Node 22.23.2:

```
npm ci                                     → added 60 packages … found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 27 passed (27) · Tests 308 passed (308)
npm --prefix examples/providers/gitea ci   → added 1 package … found 0 vulnerabilities
npm --prefix examples/providers/gitea test → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm ls --prod --depth=0                    → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1
```

- 308 tests = the 259 of bolt 1, unchanged, plus 49 new (above). None skipped.
- Each intermediate commit was checked in a scratch worktree: typecheck clean, and 259, 261 and 269 tests passing.
- `npm test` makes no network call: the broker tests use fake transports and one hanging server on 127.0.0.1, under the network-deny harness.

**The demo** (`node scripts/demo-broker.mjs`, offline, in the clean clone):

```
1. read-only guard (an AuditContext in read-only mode, as the MCP server will use)
   GET  /repos/github/gh-aw: 200 (sent)
   POST /graphql query: 200 (sent)
   POST /graphql mutation: ReadOnlyViolation READ_ONLY_VIOLATION: read-only: POST api.github.com/graphql refused (a GraphQL mutation or subscription, or not a GraphQL query)
   POST /repos/github/gh-aw/issues: ReadOnlyViolation READ_ONLY_VIOLATION: read-only: POST api.github.com/repos/github/gh-aw/issues refused (POST is not a read)

2. two parallel callers, 40 anonymous GETs each to api.github.com (default budget: 60/h, burst 60)
   one broker:  60 started at 0 s (a: 30, b: 30); the other 20 one a minute, at 60 s, 120 s, 180 s … 1200 s
   a broker each (what sharing prevents): 80 started at 0 s, over the published limit
```

### Deviations from the design, and why

1. **GitHub GraphQL defaults to 1,000 points per hour, not the table's 5,000.** The design marked this "to confirm: a lower `GITHUB_TOKEN` budget", and GitHub documents 1,000 for `GITHUB_TOKEN`. NFR12 takes the smallest published limit, as the REST row already does. With a personal token the first response reports 5,000 and replaces the default, so gh-aw is not slowed.
2. **The broker retries only callers wired to it.** A request whose init passes the broker contract (`destination`) gets the full retry policy. A plugin calling `ctx.fetch(url, init)` as plain fetch gets every other step and one attempt, because phase-2 plugins bring their own retries. The kit's harness does the same: it retries wired requests ("broker-shaped by default"), and a plain-fetch provider is tested on its own retries. The design's harness would have rescued a provider with no retries at all; the unchanged kit test `transient-faults: a provider that does not retry fails` requires that such a provider still fails.
3. **The shared retry policy lives in `src/sdk/http.ts`**, the file units-of-work gives to U3. The kit must stay self-contained (the `architecture boundaries` test), and the broker, the clients and the kit all need the policy. The `pr-rla/http` export and `createJsonClient` remain U3's.
4. **Exhaustion throws.** After the last attempt the broker throws `BrokerRetriesExhausted` (with `attempts`, `status`, `rateLimited`); a request that timed out every time stays a `BrokerTimeout` with `attempts`. The clients reword it into their phase-2 message (`gitlab GET /x: gave up after 7 attempts (HTTP 502).`), so `GAVE_UP` handling such as GitHub's history halving is unchanged.
5. **Waits imposed by rate-limit headers do not count as attempts, but they are bounded:** at most `maxRetries` (6) of them per request. Each one is capped at 15 minutes (the phase-2 cap), so a bogus header cannot stall a run. Waits the budget itself imposes are not capped, or a 60/h budget would not hold.
6. **Budgets are token buckets.** "N per window" is burst N, refilled at N per window; Data Center is burst 60, refill 5/s; spacing is burst 1. A request reserves its slot when it asks, so parallel callers interleave and each wait is slept once.
7. **Auth state comes from the request:** an `Authorization` or `Private-Token` header makes it authenticated. The design says "a token configured for the host"; a configured token is sent in one of those headers.
8. **Self-hosted servers get their provider's family** for the hosts the built-in declares: GHES gets GitHub.com's rules and GitLab self-managed gets GitLab.com's. These are conservative, and headers win. Data Center's row only ever applies this way.
9. **Header budgets are kept per reported resource.** GitHub reports `core`, `graphql` and `search` separately. They are learned per first path segment, so a `search` budget of 30/min never paces `core`.
10. **drand stays one attempt per relay;** the relay list is its failover. Rekor v1 GETs are retried; its submit is not idempotent (`idempotent: false`), as for v2.
11. **`hostsFor` is empty for every plugin in this bolt,** since built-ins and in-process plugins are trust `builtin` or `full`. `hosts()` is recorded for U2b's isolated host and used now for budget families. Credentials are swapped for any plugin that declares them and sends placeholders; the built-ins still read their tokens from the environment (as the draft said, the step is inert for them until U2b).
12. **Caller roles come from the pluginId's namespace.** `provider:` and unknown ids are always read-only; `ledger:` writes only under `writePaths`; `pr-rla/` components (timestamp, Rekor) write only in read-write mode.
13. **Every CLI command runs in read-write mode in this bolt.** The per-command split is U5's.
14. **The broker reads every response body in full** before returning it. The timeout then covers the body, a truncated body can be retried, and the recorder sees it.
15. **Redirects:** a raw `Authorization`, `Private-Token` or `Cookie` is dropped when a redirect leaves the origin, as fetch does. A placeholder credential is refused there.
16. **The recorder scrubs every e-mail address,** as the contract says. The fixture scripts keep their own field-level trimming, which keeps bot addresses on purpose, and now run on top of the broker so the built-ins retry while recording.
17. **`rate_limits` can lower a limit as well as raise it.** It is not in the `init` template yet (docs are U10's). An override for a host with no default budget is reported when the provider is opened.
18. **The Jira Cloud row is implemented now** (per-issue buckets on `*.atlassian.net`), though the Jira example arrives in bolt 3, so the defaults test covers the whole table.
19. **GitHub "content-generating" requests are counted as every write** (non-GET REST, GraphQL mutations), which is conservative.
20. `src/net/minimal-adapter.ts` is kept as a thin wrapper, so bolt 1's callers and tests did not change.

### Findings

- **GitLab.com has published proposed per-plan limits** that are "not in effect yet": Free 5,000/h with a burst of 100/min, Premium 15,000/h, Ultimate 25,000/h, and unauthenticated traffic 60/h per IP. When GitLab enforces them, the authenticated default (2,000/min) and the anonymous one (500/min) must drop, and GitLab says it will announce dates in advance.
- A 15-minute cap on every governor wait (the phase-2 cap) would have broken any budget slower than 4 per hour. The `headers replace the default` test caught it, and the cap now applies to header-imposed waits only.
- On a clock that never moves, a host pause would be applied to every later request. Every test clock that sleeps must advance; the command contexts' clocks do.

### Unverified

- The `GITHUB_TOKEN` GraphQL budget against a real Actions token (docs only).
- Bitbucket Cloud's headers on an authenticated or rate-limited request (phase 2 saw none on anonymous 429s).
- The broker against real servers at all: no live freeze ran in this bolt. Its behaviour on GitHub's real secondary-limit 403s and on GitLab's `RateLimit-*` headers is tested on synthetic responses shaped like the documented ones.
- Bitbucket Data Center's token bucket against a live server (it stays unverified, as in phase 2).
- The hand-followed redirects against GitHub's renamed-repository 301s (none in the recorded fixtures).

### What bolt 3 (U4, issue ledgers) needs to know

- **Open ledgers through the broker:** `ledgerFor(ctx, config, paths)` (CLI) or `openLedger(actx, spec, cwd, windowDir)`. A ledger's requests carry `pluginId` `ledger:<definition name>`.
- **Declare `writePaths(options)`** on `github-issues` and `gitlab-issues`, for example `api.github.com/repos/<owner>/<audit-repo>/` (the GHES host from `base_url`) and `gitlab.com/api/v4/projects/<id or encoded path>/`. Any other write is `WritePathNotAllowed`, and in read-only mode every write is `ReadOnlyViolation`. A GraphQL mutation cannot be path-scoped, so use REST for writes or declare the GraphQL path exactly.
- **Mark writes `idempotent: false`** with `destination: "scm"` in the init. They are then retried only on 429 and on connection errors before send, never after a 5xx. `publishDraws` must therefore find an issue that may have been created before a lost response, by its body marker as designed.
- **GitHub writes are paced automatically:** 80/min and 500/h (`writes_*`), plus 5 points each against 900/min. 144 issues take under a minute (80 at once, then one every 0.75 s).
- **GitLab.com publishes issue creation at 200/min and note creation at 60/min.** They are not in the NFR12 table yet. Add them to the `gitlab` family, with rows in the defaults test, when `gitlab-issues` lands.
- **Jira:** per-issue write buckets already exist for `*.atlassian.net`. The example should declare `hosts`, `writePaths` and `credentials` and authenticate with `prrla-basic:JIRA_EMAIL:JIRA_TOKEN`; swapping that placeholder is tested.
- **Read-only mode:** `openLedger` returns a view with `readVerdicts`, `verifyIntegrity` and `readHistory` only. `requireReadWrite(actx, "checkpoint")` refuses before anything starts. The git transport is outside the broker, as designed.
- **The kit's harness retries requests that pass `destination`.** A ledger kit built on the same harness gets this for free.
- **Recording public issue timelines:** route the recording fetch through `createBroker({}, { fetch: recordingFetch }).bind("ledger:github-issues")`, as the provider recorders now do, or use the broker's scrubbing `recorder`.
- `test/helpers/fake-clock.ts` drives parallel waits; a test clock must advance on `sleep`.

## Bolt 3 (U4): issue-tracker ledgers and ledger checkpoints (2026-11-03)

Goal (delivery-plan.md, bolt 3): the built-in `github-issues` and `gitlab-issues` ledgers, verdicts read from label-event history, the ledger conformance kit, the external Jira example, TSA-stamped ledger checkpoints and their cross-clone git transport, `account` provenance with issue ledgers, and the gh-aw prospective audit ready for the founder's `register`. Settles RK-03 through read-only recordings of public issue timelines where they exist.

### Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR4.1 `github-issues` and `gitlab-issues`; `publishDraws` opens one issue per draw, in draw order; verdicts are labels | met (one issue per drawn *change*: deviation 1) | `e2e-github-issues.test.ts › sample opens one issue per drawn change, in draw order`; `github-issues-ledger.test.ts › publishDraws (FR4.1)`; `gitlab-issues-ledger.test.ts › publishes at the self-managed base URL` |
| FR4.2 verdicts from label-event history, the first eligible event counts, its actor and server time become `reviewer` and `recordedAt` | met | the kit's `first-label` check on every built-in fixture; `relabel-opposite` (a later opposite label still reports the first) |
| FR4.3 every removal, re-add, swap, label edit, deletion, transfer and app-applied verdict reported; removal after counting FAILs; removal followed by a re-add WARNs | met (interpretation: deviation 4) | kit cases `relabel-same`, `relabel-opposite`, `removal`, `deletion` (deleted and transferred), `label-rename` (renamed, renamed and re-used, deleted), `app-applied`, `unlisted-reviewer`, on synthetic GitHub, GitLab and Jira and on six recorded GitHub timelines |
| FR4.4 checkpoints from `status --checkpoint` and `checkpoint`; cross-clone appends through fetch, rebase, re-append, at most 3 attempts, never forced; identical lines read once | met | `git-transport.test.ts` (7, local bare repo); `e2e-github-issues.test.ts` (an erased event and a deleted issue show as `history rewritten after checkpoint`); `checkpoint.test.ts` (de-duplication) |
| FR4.5 Jira as an external example, a single-select custom field read through the changelog API, passing the kit | met; in-process until bolt 4's host | `examples/ledgers/jira` (`npm test`: `# pass 1`); `jira-example.test.ts` |
| FR4.6 `runLedgerConformance` in `pr-rla/testing`; both built-ins and the Jira example pass it | met | `github-issues-ledger.test.ts`, `github-issues-recorded.test.ts`, `gitlab-issues-ledger.test.ts`, the Jira package's test; `ledger-conformance.test.ts` shows each check failing on a broken ledger |
| FR4.7 fixtures recorded read-only from public timelines where they exist, else synthetic; each marked | met | every JSON fixture has `"source": "recorded"`; every kit fixture declares `source`, and the kit refuses one that does not (Fixtures, below) |
| FR4.8 GHES and GitLab self-managed base URLs: publish and read there | met (mock servers) | `› github-issues on GitHub Enterprise Server (FR4.8)`; `› publishes at the self-managed base URL` |
| Ledger `writePaths()`; writes `idempotent: false` | met | `writePaths` on both built-ins and the Jira example; a write outside them is `WritePathNotAllowed` before it is sent (GHES test) |
| GitLab issue-create (200/min) and note-create (60/min) in the defaults table, with the source | met | `src/net/rate-limits.ts`; two new rows in `broker.test.ts › NFR12` (source: https://docs.gitlab.com/user/gitlab_com/rate_limits/, re-read 2026-11-03) |
| `account` provenance for issue ledgers, enforced | met | `register` defaults `verdicts.min_provenance` to the ledger's level (`account`); check 7 FAILs a counted verdict below the registered minimum (`e2e-github-issues.test.ts › FR3.8`) |
| `audits/gh-aw-prospective/` passes `register`'s preflight | met; `register` not run | `gh-aw-prospective.test.ts` (a filled-in copy, `--dry-run` only) |
| Demo: a recorded public timeline with a remove and re-add WARNs; a deleted-issue fixture FAILs | met, both on recorded data | `node scripts/demo-ledgers.mjs` (below) |

### Done

| Piece | Where |
|---|---|
| Ledger SDK deltas, all optional within `ledgerApiVersion` 1: `VerdictEvent.provenance`, `Ledger.readHistory`, `LedgerHistoryEvent`, a publish context, `LedgerIntegrityReport.warnings`, `LedgerContext.sleep` / `reviewers`, `LedgerDefinition.provenance`; pure helpers `verdictIneligibility`, `analyzeDrawHistory`, `canonicalHistory`, `historyDiff` | `src/sdk/ledger.ts` |
| The issue-tracker base (snapshot per command, verdicts, integrity, history, idempotent publish, record) and the draw → issue index | `src/ledgers/issue-ledger.ts`, `src/ledgers/issue-index.ts`, `src/ledgers/http.ts` |
| `github-issues` (REST issue events; GHES through `base_url` or `api_url`) and `gitlab-issues` (`resource_label_events`; self-managed through `base_url`) | `src/ledgers/github-issues/`, `src/ledgers/gitlab-issues/` |
| Eligibility and provenance in the core: bots, apps and unregistered reviewers ignored and reported; `VERDICT PROVENANCE` on status and verify; check 7 enforces `minProvenance`, FAILs on an unreadable ledger, WARNs on ledger warnings, compares checkpoints | `src/core/status.ts`, `src/core/verify.ts` |
| The checkpoint record (pure), its files, the command, `status --checkpoint`, the git transport | `src/core/checkpoint.ts`, `src/api/checkpoint.ts`, `src/commands/checkpoint.ts`, `src/io/git-transport.ts` |
| `verdicts:` in `.pr-rla.yml`, `register`'s ledger preflight, `base_url` inheritance, `sample` publishing with the protocol hash, `record` through an issue ledger | `src/config.ts`, `src/commands/{register,sample,record,status,verify}.ts` |
| The ledger kit | `src/testing/ledger-conformance.ts` |
| The Jira example, its recorder and its tests | `examples/ledgers/jira/` |
| Recorder for public timelines (read-only broker) and the demo | `scripts/record-ledger-fixtures.mjs`, `scripts/demo-ledgers.mjs` |
| Tests: 59 new | `e2e-github-issues` 14, `ledger-conformance` 10, `git-transport` 7, `checkpoint` 7, `github-issues-ledger` 6, `github-issues-recorded` 5, `gitlab-issues-ledger` 4, `jira-example` 3, `gh-aw-prospective` 3; helpers `fake-issue-trackers.ts`, `ledger-draws.ts` |

### Fixtures (FR4.7)

Recorded fixtures are read-only recordings of public trackers, trimmed to the fields pr-rla reads (no request headers, no names beyond public logins, no e-mail addresses). Synthetic ones are fake trackers built from the documented APIs and the recorded shapes.

| Fixture | Source | What it shows |
|---|---|---|
| `test/fixtures/ledgers/github/relabel-same-nodejs-node-67038.json` | recorded | A maintainer applied `commit-queue-squash` (14:06:04Z), removed it (14:42:47Z) and applied it again (20:12:24Z). Mapped to pass: WARN `relabel (same verdict)`, the first event counts |
| `…/first-label-microsoft-vscode-345779.json` | recorded | One human `bug` label: a clean first verdict, PASS |
| `…/app-applied-microsoft-vscode-345652.json` | recorded | `unreleased` applied by the vs-code-engineering GitHub App: `actor.type: Bot`, `performed_via_github_app: null`; ignored by the bot rule |
| `…/deleted-microsoft-vscode-345635.json` | recorded | A deleted issue: GitHub answers **404** (not 410). FAIL `deleted … its history is gone` |
| `…/label-renamed-rust-lang-rust-30010.json` | recorded | `I-enhancement` (2015) since renamed `C-enhancement`: the old name 404s. FAIL |
| `…/label-renamed-and-reused-rust-lang-rust-30003.json` | recorded | `T-libs` (id 211668062) renamed `T-libs-api`, and a new label (id 2011781731) took the name. The index's id catches it: FAIL |
| `…/evidence-label-rename-rust-lang-rust.json` | recorded | REST events next to GraphQL timeline items for the same events (unverified item 2) |
| `…/evidence-performed-via-app-github-gh-aw.json` | recorded | 300 repository issue events of github/gh-aw (unverified item 1) |
| `test/fixtures/ledgers/gitlab/scoped-swap-gitlab-org-gitlab-633165.json` | recorded | GitLab's synthesized label notes for gitlab-org/gitlab#633165, including a human's scoped swap (unverified item 3) |
| `examples/ledgers/jira/fixtures/hibernate-first-verdicts.json` | recorded | hibernate.atlassian.net HHH-17005 (single-select set to Approved: pass) and HHH-16971 (Rejected: fail) |
| `examples/ledgers/jira/fixtures/hibernate-removal-HHH-14722.json` | recorded | Approved, then changed to Undecided 8 s later: FAIL, removal after counting |
| Kit fixtures on `FakeGitHubIssues`, `FakeGitLabIssues`, `FakeJira` | synthetic | Every kit case, including all destructive ones (deleted and moved issues, deleted and renamed labels, an erased event), pagination past 100 events, idempotent publishing after a lost response and after a lost index, GHES and self-managed URLs |

### Live reads (all read-only; 2026-11-03T23:40Z to 2026-11-04T00:51Z)

- **GitHub REST, with the founder's `gh` token, GET only:** repository issue events (up to 30 pages each, and the final tally above) of microsoft/vscode, github/gh-aw, kubernetes/kubernetes, rust-lang/rust, dependabot/dependabot-core, home-assistant/core, nodejs/node, python/cpython, flutter/flutter, facebook/react, golang/go, microsoft/TypeScript and dotnet/runtime; per-issue events and label lookups on the recorded issues; microsoft/vscode issues 345600–345660 (to find a deleted one).
- **GitHub GraphQL, queries only:** label timelines of rust-lang/rust #30000–#30040; microsoft/vscode #345635 and `hasDiscussionsEnabled`.
- **GitLab.com, anonymous:** `resource_label_events` (HTTP 401), issue listings, GraphQL notes, and the web `discussions.json` of seven gitlab-org/gitlab issues and one gitlab-org/cli issue.
- **Jira, anonymous:** hibernate.atlassian.net (Jira Cloud) REST v3 field list, `search/jql`, issue and changelog reads for about 50 HHH issues; one probe each to issues.apache.org (Data Center, 200), jira.mongodb.org (Data Center, 200) and bugs.openjdk.org (401).
- **Pages read (WebFetch):** GitLab's "GitLab.com settings: rate limits" and "Rate limits on content creation".
- The recorders (`scripts/record-ledger-fixtures.mjs`, `examples/ledgers/jira/scripts/record.mjs`, at 2026-11-04T00:23:32Z) send every request through the broker in **read-only** mode, so no write could leave. Nothing was written to any repo, project or tracker; no scratch repo was created; nothing was pushed.

### Unverified items settled, and how

1. **Whether GitHub fills `performed_via_github_app` on label events: settled, no.** A tally of the newest repository issue-event pages of eight repos (microsoft/vscode, github/gh-aw, kubernetes/kubernetes, rust-lang/rust, dependabot/dependabot-core, home-assistant/core, nodejs/node, python/cpython; about 2026-11-04T00:50Z) found 1,140 label events, 612 of them by `Bot` actors, and **none** with `performed_via_github_app` set. The apps seen include github-actions, dependabot, vs-code-engineering, kubernetes-prow, home-assistant, rust-bors and issue-triage-workflows. Apps show up as `actor.type: "Bot"`, so the bot rule is what ignores them. The field is filled on other events: `copilot_work_started` / `copilot_work_finished`, with a `User` actor and the app `copilot-swe-agent` or `copilot-pull-request-reviewer` (recorded in `evidence-performed-via-app-github-gh-aw.json`, asserted in `github-issues-recorded.test.ts`). The `viaApp` rule is kept, since it costs nothing. *Still unverified:* a label applied by an app through a user-to-server token (actor `User`); none was seen.
2. **Whether GitHub REST keeps a label's original name after a rename: settled, yes.** rust-lang/rust #30003: the REST event of 2017-05-04T16:51:21Z says `T-libs`; GraphQL's `LabeledEvent` for the same time and actor says `T-libs-api`. #30010: REST `I-enhancement`, GraphQL `C-enhancement`. #30002: REST `A-traits`, GraphQL `A-trait-system`. **New finding:** after the rename a new label took the old name `T-libs` (id 2011781731; the original is 211668062). By name, the old events now look like the new label's. So the index records each verdict label's id at publish time, and a different id under the same name FAILs.
3. **GitLab scoped-label swap events: partly settled.** GitLab's own label notes, synthesized from `resource_label_events` that share one user and one instant, show a swap as a single "added … label and removed … label" note. Example: gitlab-org/gitlab#633165, ifrenkel, 2026-10-09T17:42:45.113Z, added `workflow::in dev` and removed `workflow::refinement`; #632975 shows a `group::` swap. So the swap is one add and one remove at one instant. *Still unverified:* the REST `resource_label_events` JSON itself, which answers 401 without a token, even on public projects. The ledger reads a swap as a remove and an add, and the shared rules apply the removal first at one instant, which reports it as a relabel.
4. **Jira Cloud's changelog format for a single-select field: settled.** The design expected only Data Center to be publicly readable, but hibernate.atlassian.net is Jira Cloud and serves `GET /rest/api/3/issue/{key}/changelog` anonymously. A select change is one item `{ field: "backportDecision", fieldtype: "custom", fieldId: "customfield_11702", from: "<option id>" | null, fromString: "<value>" | null, to: "<option id>", toString: "<value>" }`. `created` carries a local offset and milliseconds (`2023-07-28T03:43:22.045-0700`). Paging uses `startAt`, `maxResults`, `total` and `isLast`. The author is `{ accountId, accountType: "atlassian" | "app" }`.

### Verified (command → output)

From a fresh `git clone` of the repo at `c555eeb`, 2026-11-04T00:46Z, Node 22.23.2:

```
npm ci                                     → added 60 packages … found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 36 passed (36) · Tests 367 passed (367)
npm --prefix examples/providers/gitea ci   → added 1 package … found 0 vulnerabilities
npm --prefix examples/providers/gitea test → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm --prefix examples/ledgers/jira ci      → added 1 package … found 0 vulnerabilities
npm --prefix examples/ledgers/jira test    → ok 1 - the ledger kit: recorded hibernate.atlassian.net changelogs and a synthetic Jira Cloud · # pass 1 · # fail 0
npm ls --prod --depth=0                    → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1
```

- 367 tests = the 308 of bolt 2, unchanged except that `broker.test.ts › NFR12`'s table gained the two GitLab rows, plus 59 new (above). None skipped.
- Every commit of the bolt was checked in a scratch worktree: typecheck clean and the suite passing at each (308, 308, 308, 324, 333, 333, 353, 353, 353, 356, 359, 359, 359, 359, 367).
- `npm test` makes no network call: trackers are fakes or replayed recordings, the git transport uses a local bare repository, and mock authorities listen on 127.0.0.1, all under the network-deny harness.
- No LICENSE file; `"private": true, "license": "UNLICENSED"` (also in the Jira example).

**The demo** (`node scripts/demo-ledgers.mjs`, offline, in the clean clone):

```
nodejs/node#67038, commit-queue-squash mapped to pr-rla:pass  (source: recorded, recorded 2026-11-04T00:23:32.000Z)
  event 35026589137  2026-11-03T14:06:04Z  labeled    commit-queue-squash  by RafaelGSS (User)
  event 35030378986  2026-11-03T14:42:47Z  unlabeled  commit-queue-squash  by RafaelGSS (User)
  event 35060730080  2026-11-03T20:12:24Z  labeled    commit-queue-squash  by RafaelGSS (User)
  verdict: draw #1 pass by RafaelGSS at 2026-11-03T14:06:04Z (provenance account, event 35026589137)
  verdict: draw #1 pass by RafaelGSS at 2026-11-03T20:12:24Z (provenance account, event 35060730080)
  integrity: WARN
    draw #1: commit-queue-squash removed and added again (relabel, same verdict); the first event (2026-11-03T14:06:04Z) counts

microsoft/vscode#345635, deleted  (source: recorded, recorded 2026-11-04T00:23:32.000Z)
  GET https://api.github.com/repos/microsoft/vscode/issues/345635 → HTTP 404
  integrity: FAIL
    draw #1 issue https://github.com/microsoft/vscode/issues/345635 deleted (HTTP 404); its history is gone

Part 2: pr-rla verify, with an audit's ledger pointed at the recorded tracker (check 7)
$ pr-rla verify     (ledger: relabel-same-nodejs-node-67038, recorded)
  7. WARN labels: labels (prefix 1, 2 events)
          VERDICT PROVENANCE: account (1) (registered minimum: self-asserted)
          draw #1: commit-queue-squash removed and added again (relabel, same verdict); the first event (2026-11-03T14:06:04Z) counts
  VERIFIED
  (exit 0)
$ pr-rla verify     (ledger: deleted-microsoft-vscode-345635, recorded)
  7. FAIL labels: labels FAIL
          VERDICT PROVENANCE: none counted (registered minimum: self-asserted)
          draw #1 issue https://github.com/microsoft/vscode/issues/345635 deleted (HTTP 404); its history is gone
  FAILED: check 7 (labels)
  (exit 1)
```

Part 2 registers, freezes and samples a 200-change json-file audit offline (git-file ledger, so its minimum is `self-asserted`), then points its ledger at the recorded tracker, with the recorded issue standing for draw #1. The end-to-end test does the same on a synthetic GitHub with `github-issues` from registration on, and gets 7/7 PASS, `VERDICT PROVENANCE: account (35)` and a checkpoint with 2 of 2 tokens.

### The gh-aw registration

`audits/gh-aw-prospective/.pr-rla.yml` now uses the live `github-issues` ledger. Bolt 3 confirms the option names: `ledger.options.repo` and `verdicts: { min_provenance, reviewers }`. Four placeholders, marked `EDIT`, remain for the founder: `window.start`, `window.end`, `ledger.options.repo` (the audit repo, `owner/name`) and `verdicts.reviewers` (the founder's login). `register` refuses each placeholder by name. With all four filled in, `register --dry-run` prints `PROSPECTIVE`, `ledger github-issues · verdict provenance account · reviewers <login>` and the four default authorities with k = 2. `docs/gh-aw-prospective.md` has the steps. **`register` was not run.**

### Deviations from the design, and why

1. **One issue per drawn change, not per draw.** A change drawn twice reuses its first verdict, so a second issue would only invite a second verdict. Later draws of the change are listed in the index's `repeats` and point at its first issue; `record` on a repeat labels that issue.
2. **The index keeps label ids,** and a verdict label whose name now belongs to another id FAILs. This follows from settled item 2: a rename can free the name for a new label.
3. **Event lists are stored as `ledger-history/<takenAt, basic format>-<eventsSha256[0..12]>.json`,** not `<takenAt>.json`. Colons are refused on some file systems. Two clones checkpointing in the same second would otherwise collide, and with the hash in the name, the same name always means the same content.
4. **FR4.3, as applied.** The counted verdict is the first eligible add. After it:
   - the same label removed and added again is a WARN;
   - the opposite label added (a swap, or both present) is a WARN;
   - the counted verdict removed with **no verdict label left at the end** is a FAIL ("removal after counting").
   At one instant a removal is applied before an add, so a select-field change or a scoped swap reads as a relabel. An event whose label the tracker erased (GitLab nulls deleted labels) is a FAIL. Integrity looks at every actor's events; counting looks only at eligible ones.
5. **Eligibility lives in the core** (`computeStatus`), through the SDK's `verdictIneligibility`. `readVerdicts` returns every verdict-label add, including ineligible ones, so status and verify can report them as ignored, as the draft required. Bots are recognized by the SDK's `[bot]` suffix. Registered reviewers match a login or `id:<account id>` (the event's `provenance.actorId`), so U3's `Actor.id` is not needed.
6. **FR9.4's enforcement is built now for the levels that exist.** Check 7 FAILs a counted verdict below `minProvenance`. `register` refuses a `min_provenance` the configured ledger cannot meet (`account` with `git-file`). U9 must relax that check when `git-file` gains signed commits.
7. **`LedgerDefinition.provenance`** (new, optional) is where `register` gets the default minimum: `account` for the issue ledgers and the Jira example, otherwise `self-asserted`.
8. **A credential declared with `hosts: []`** may be sent only to the hosts the ledger's `hosts(options)` declares. A definition's credential list is static, and a Jira site's host belongs to the user. The design named no mechanism for this.
9. **`verify --offline` does not read a ledger that declares hosts.** Check 7 then SKIPs, saying which host it would need. The draft's offline status for issue ledgers was left to U5.
10. **Draw issues carry a draw label** (`pr-rla:draw`, `pr-rla-draw`), which is how `publishDraws` lists them to find markers after a lost response or a lost index. On GitHub and GitLab the marker is an HTML comment in the body; in the Jira example it is the summary (Jira's search index can lag, so a lookup made immediately after a lost response may miss the issue).
11. **`record` with an issue ledger applies the label as the token's account,** and `--reviewer` is optional for ledgers whose verdicts are `account`: the tracker records who applied it. `record` refuses only when a verdict that counts already exists.
12. **The git transport:**
    - untracked files do not count as a dirty tree;
    - it rebases onto `FETCH_HEAD`, so `--remote/--branch` works without a tracking ref;
    - a push that fails with "cannot lock ref" (a concurrent push) is retried like a non-fast-forward;
    - a replayed commit that the union makes empty (the remote already holds the same checkpoint) is skipped;
    - the re-run command after exit 4 is `pr-rla checkpoint --push`, which appends another checkpoint, since lines are only ever added.
13. **A GitHub issue counts as moved when its `repository_url` is not the audit repo's.** This covers a transfer, whether or not the API redirects, and also a renamed audit repo; both FAIL, conservatively.
14. **Ledger writes do not ask the broker for a JSON check.** They are never retried after a response, and Jira answers a PUT with 204, which `checkJsonBody` (`src/sdk/http.ts`) cannot rebuild (finding 4).
15. **The Jira example notices a deleted verdict field,** but not a renamed option (that needs admin rights to read options). It matches values by name.
16. **Checkpoint tokens in check 7:** a token failing rules 1–7 FAILs; too few tokens WARN with `TIMESTAMP NOT TAMPER-PROOF (n of k)`. `status --checkpoint` returns status's code, unless that is 0, in which case it returns the checkpoint's.

### Findings

1. **Verifying an issue ledger needs a token.** 36 draw issues take about 74 reads. Anonymous GitHub reads are paced at 60 per hour, so the e2e test's fake clock moved an hour before its token was set. Every verifier, not only the reviewer, needs some token.
2. **GitHub answers 404 for a deleted issue** (vscode #345635), not the 410 the docs list. The ledger treats both as deleted.
3. **Bots on user accounts apply labels** (`rustbot`, `nodejs-github-bot`, `rust-rfcbot`: `actor.type: "User"`). Only `verdicts.reviewers` stops them from counting, which is why the gh-aw configuration registers the founder's login.
4. **`checkJsonBody` in `src/sdk/http.ts` throws on a 204** ("Invalid response status code 204"): it rebuilds the response with an empty-string body. Any broker request that passes `acceptJson` and gets a 204 hits it. It is avoided in the ledgers (deviation 14), not fixed: the file is U3's, and U3 is being built in parallel.
5. **The Copilot coding agent's events carry a human actor with `performed_via_github_app` set** (`copilot_work_started` by a maintainer, via `copilot-swe-agent`). An assistant working through an app as a human is threat T7. Label events do not show it today, but the field is the signal to watch.
6. **GitLab serves `resource_label_events` only to a token, even on public projects**, as phase 2 found for MR notes. Verifying `gitlab-issues` needs `read_api`.

### Unverified

- GitLab's REST `resource_label_events` JSON, including how a scoped swap and a deleted label (nulled on past events, per the draft) appear there. A token is needed; the fake follows the documented shape.
- A GitHub label applied by an app through a user-to-server token.
- Whether GitHub's REST API answers a transferred issue with 301 or 200 (both are handled).
- Every write path on a real tracker: issue and label creation, label application, comments. They ran on mock servers only (D8). The same holds for GitHub's real secondary limits on 144 issue creations.
- GHES and GitLab self-managed against real servers; Jira Data Center at all (the example targets Cloud); Jira's search-index lag for marker lookups; option renames in a Jira changelog.
- The git transport against a real remote (authentication, network timeouts); only a local bare repository was used.
- A checkpoint time-stamped by the real authorities (mock authorities only).

### Notes for bolt 4 (U2b) and the merge

- **A trial merge with `integrate/wave1` (in memory, nothing written) gives four textual conflicts:**
  - `README.md`;
  - `src/api/context.ts`: U2b split `openLedger` into `openBuiltinLedger` and `openExternalLedger`. Carry this bolt's additions into both paths: the `reviewers` option, `sleep` in the ledger context, `LEDGER_BUDGET_FAMILY` for built-ins, and host-less credentials resolved to the ledger's declared hosts;
  - `src/commands/register.ts`: keep U2b's `pluginIdentity(…, auditContextFor(ctx).plugins)` and its trust lines, together with this bolt's `preflightLedger` and `verdicts`;
  - `src/commands/verify.ts`: keep `const report = await verifyAudit(…)` and add this bolt's `checkpoints`, `checkpointProblems` and `ledgerSkipped`.
  `config.ts`, `core/verify.ts`, `registry.ts`, `cli.ts`, `commands/status.ts`, `commands/context.ts` and `src/testing/*` merge cleanly.
- **Four places load an external ledger's definition in-process.** Under the isolated host they must not:
  - `register`'s `preflightLedger` calls `hosts`, `writePaths` and `create()`, with a fetch that refuses;
  - `record` reads `provenance`;
  - `verify` reads `hosts` for the offline skip.
  For an isolated plugin, take `provenance`, `hosts` and `writePaths` from the lock entry, or from the child's `ready` message (adding `provenance` there is optional within `pr-rla/ipc/v1`). Run the preflight's `create()` in the child.
- **The IPC `create` call must pass `LedgerContext.reviewers`.** The method list already has `readHistory`; `publishDraws` now takes a second argument (the publish context).
- **The Jira example declares `credentials: [{ env, hosts: [] }]`.** The lock and the host must resolve an empty `hosts` the way `openLedger` does: to the hosts the ledger declares for its options. Its requests pass `destination`, `idempotent` and `retry` in the init; the IPC `fetch` message should carry them, or the broker should treat a child's requests as wired.
- **`src/testing/conformance.ts` now exports `makeHarness` and `Fault`,** which the ledger kit uses. U3's kit changes merge cleanly with that.
- **U3 owns `src/sdk/http.ts`:** please fix finding 4 (pass a `null` body for 204, 205 and 304 in `checkJsonBody`).
- **For U9:** `register`'s refusal of `min_provenance: account` with `git-file` must give way once `require_signed` produces `account` and `presence` verdicts. Check 7 already compares levels by `provenanceRank`.
- **For U7:** `command: checkpoint` maps to `pr-rla checkpoint --push`, with exit 1 (preconditions), 4 (stopped) and 5 (too few tokens). The transport needs a checkout with an upstream branch, or `--remote` and `--branch`.

## Bolt 4 (U2b): plugin lock and isolated plugin host (2026-11-03)

*Appended from `docs/build-notes/u2b.md` (kept there too) at the wave-1 integration. Written on its own branch; "Integration: wave 1" below records what changed when it met U3 and U4.*

Goal (delivery-plan.md, bolt 4): `pr-rla.lock.json`, written only by an explicit `pr-rla plugin add`; the npm integrity and tree hash re-checked at every load; external plugins out of process in a host with a scrubbed environment and the Node permission model; credentials only as placeholders the broker swaps on declared hosts (including `prrla-basic:`); `trust: full` as a per-plugin opt-in; `--plugins builtin-only` and `PR_RLA_PLUGINS`; `pr-rla plugin check` as a correctness gate; RK-02 settled or recorded.

Built on branch `bolt/u2b-plugin-host` from the end of bolt 2 (`54e1628`), in parallel with U4 (bolt 3) and U3, so this bolt has neither U4's ledgers and ledger kit nor U3's SDK additions. These notes live here rather than in BUILD-NOTES.md so the branches merge cleanly.

### Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR2.1 the registration records each plugin's name, source, version, content hash and options hash | met | `plugin-lock.test.ts › register records name, source, version, content hash and options hash`: `integrity` is the lock's treeSha256, `trust` the locked trust |
| FR2.2 the lock pins version, npm integrity and a tree hash; a mismatch at load refuses | met | `› a changed file is refused at load` (freeze and register), `› the tree hash covers … each dependency separately`, `› records the integrity … a changed package-lock entry is refused at load` |
| FR2.3 only `plugin add` creates a lock entry, printing what it trusts; `register` never extends the lock and refuses an unlocked plugin naming `plugin add` | met | `› exits 1 with the command to run; writes no lock and no registration`, `› prints the source, version, resolved, npm integrity and tree hash it trusts, and asks first`, `› … leaves the lock untouched` |
| FR2.4 out of process, scrubbed environment, placeholders swapped on declared hosts only; the security model states the Node 22/24 limit; Node 25+ network test run or marked unverified | met, with the limit | `plugin-host.test.ts › the hostile fixture plugin, contained` on Node 22.23.2 and 26.8.2; `docs/security-model.md`; RK-02 below |
| FR2.5 `trust: full` opt-in, recorded, printed by `verify` | met | `› runs in process with the real environment and prints PLUGIN TRUST: full` (register, freeze, verify) |
| FR2.6 `--plugins builtin-only` and `PR_RLA_PLUGINS=builtin-only` refuse all external code | met | `› refuse an external plugin before it is resolved or imported` (a module that throws on import never runs); other values refused |
| FR2.7 `plugin check` runs the kit through the host and says correctness, not safety | met | `› passes the Gitea example through the host and says correctness, not safety`; `node dist/cli.js plugin check ./examples/providers/gitea/index.mjs --offline` (below) |
| NFR13 `engines.node >= 22.13`; Node 25 network denial verified or recorded | met | `package.json`; RK-02 ran on Node 26.8.2 |
| The Gitea example passes the conformance kit **through the host** | met | `› on recorded Codeberg responses` and `› on the synthetic Forgejo (every merge strategy, a 45 s rate-limit wait proxied to the parent's clock)`; `plugin check` from `dist/` |
| The hostile fixture reads a placeholder, not the token | met | the demo below; `› reads a placeholder, not the token; no other variable reaches it` |
| Node 25 IPC/network-denial test | **ran** on Node 26.8.2 (found on PATH): IPC works under `--permission` without `--allow-net`, and the child's socket is `ERR_ACCESS_DENIED`. Node 25.x itself is not installed here, so the 25.x row rests on 26 | `› RK-02 … IPC works and the child has no network` |
| test-design.md U2b: tree-hash mismatch, symlink escape, builtin-only before import, register exit 1, install-script warning, 60 s without heartbeat kills the child | met | `plugin-lock.test.ts`, `plugin-host.test.ts › heartbeats, silence and message size` |

### Done

| Piece | Where |
|---|---|
| The lock: resolution (package by `node_modules` walk and its `.` export; path inside the audit repo, root = nearest package.json), transitive runtime dependencies, tree hash, read grants, install-script scan, load-time checks, builtin-only policy | `src/plugins/lock.ts`, `src/plugins/errors.ts` |
| The protocol `pr-rla/ipc/v1` (types and limits) | `src/plugins/protocol.ts` |
| The child: SDK mapping, IPC fetch and sleep, calls, heartbeats; no runtime import from pr-rla | `src/plugins/child.ts` |
| The parent: spawn with the permission flags, IPC, watchdog, size limits, secret scrubbing, definition validation, provider and ledger proxies | `src/plugins/host.ts` |
| Opening external plugins for commands (lock, then isolated or full) | `src/plugins/open.ts`, wired in `src/api/context.ts` (`openProvider`, `openLedger`, `plugins` policy, no-hosts sentinel) |
| External plugin identity from the lock, never an in-process import of an isolated plugin | `src/plugins/identity.ts`, `src/registry.ts` (`pluginIdentity`, `builtinProviderName`, `builtinLedgerName`) |
| Lock entries (shared by the CLI and tests) | `src/plugins/entry.ts` |
| `plugin add`, `plugin lock`, `plugin check`; `--plugins builtin-only`; hosts stopped when a command ends | `src/commands/plugin.ts`, `src/plugins/check.ts`, `src/cli.ts` |
| `register` prints each plugin's trust and tree hash, and `PLUGIN TRUST: full`; `verify` repeats it and warns in check 5 when the provider it loads is not the registered one | `src/commands/register.ts`, `src/commands/verify.ts` |
| The Gitea example declares `hosts`, `GITEA_TOKEN` for codeberg.org and its conformance fixture | `examples/providers/gitea/` |
| The hostile fixture | `test/fixtures/plugins/hostile/` |
| Tests: 37 new | `test/plugin-host.test.ts` 20 (one is the "unverified" placeholder, skipped when a Node 25+ is found), `test/plugin-lock.test.ts` 17 |
| Demo | `scripts/demo-plugin-host.mjs` |
| Docs | `docs/security-model.md` (new: the plugin section), `docs/writing-a-provider.md` §§3, 4, 7, README (step 5, one limitation) |

### RK-02: the Node 25 test

Measured 2026-11-03 on macOS with the Node versions Homebrew already had (nothing was installed for this bolt): a child started as the host starts it (`--permission`, fs-read limited, no `--allow-net`):

| Node | IPC under `--permission` | read outside the scope | write | `net.connect` |
|---|---|---|---|---|
| 22.23.2 | works | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` | **connects** |
| 24.20.0 | works | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` | **connects** |
| 26.8.2 | works | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| 26.8.2 with `--allow-net` | works | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` | connects |

So the design's "if it passes" branch applies: the child never gets `--allow-net`, and on Node 25 or later it has no network. The test (`plugin-host.test.ts › RK-02`) looks for a Node at 25 or later as this one, in `PR_RLA_NODE25`, or on PATH, and runs it as the child; with none it reports a skipped `UNVERIFIED` test instead. On this machine PATH has `/opt/homebrew/bin/node` (26.8.2) after Node 22, so plain `npm test` runs it.

### Verified (command → output)

From a clean state in the worktree (`node_modules`, `dist` and `examples/providers/gitea/node_modules` removed; nothing else untracked), at `b6e68c7`, 2026-11-04T00:24Z, Node 22.23.2:

```
npm ci                                     → added 60 packages … found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 29 passed (29) · Tests 344 passed | 1 skipped (345)
npm --prefix examples/providers/gitea ci   → added 1 package … found 0 vulnerabilities
npm --prefix examples/providers/gitea test → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm ls --prod --depth=0                    → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1 (no new dependency)
```

- 345 = the 308 of bolt 2, unchanged in what they assert, plus 37 new; the one skipped is the `UNVERIFIED` placeholder, skipped because the RK-02 test ran.
- The same suite under Node 26.8.2 (`/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run`): 339 passed, 1 skipped (the second hostile block is not added when the test's own Node is already 25+).
- Each commit of this bolt was checked in a scratch clone: typecheck clean at every one; 308, 308, 308, 308, 344 (+1 skipped), 344 (+1 skipped) tests passing.
- `npm test` makes no network call. The children run only fixtures and the Gitea plugin, whose every request comes back to the parent's fake transports; the hostile plugin's one socket goes to a loopback server the test starts.

`plugin check` from the build, offline:

```
$ node dist/cli.js plugin check ./examples/providers/gitea/index.mjs --offline
plugin check ./examples/providers/gitea/index.mjs: provider gitea@0.1.0 (path)
  lock            not locked: run "pr-rla plugin add ./examples/providers/gitea/index.mjs" to trust it
  npm signatures  not applicable: a path plugin is not from the npm registry
  hosts           codeberg.org (with no options: not named in .pr-rla.yml)
  credentials     GITEA_TOKEN -> codeberg.org
  conformance     the provider kit through the plugin host, on 1 recorded fixture(s)
    ok   codeberg-forgejo-docs-2026-10-01.json › api-version
    … (normalization, window-and-kinds, classification, merge-strategies, no-double-counting,
       stable-sorted-ids, review-state-mapping, actors, pagination, kind-filtering: ok;
       bot-detection: skip, the fixture declares no bots)
    ok   codeberg-forgejo-docs-2026-10-01.json › transient-faults
  conformance     PASS
conformance = correctness, not safety: a malicious plugin can pass it
exit 0
```

On a scratch copy of the repo, `pr-rla -C examples/codeberg-forgejo-docs-2026-10 plugin add ../providers/gitea/index.mjs --yes` wrote the lock entry the example's comment describes (`source path`, `resolved file:../providers/gitea`, `hosts codeberg.org`, `GITEA_TOKEN -> codeberg.org`, trust isolated). No `freeze` ran against Codeberg: no live call was needed in this bolt.

### The demo

`node scripts/demo-plugin-host.mjs` (offline, after `npm run build`), Node 22.23.2:

```
U2b demo: a hostile provider through pr-rla's plugin host (this Node v22.23.2)
  the parent's environment has GITHUB_TOKEN=ghp_DEMO…, GITHUB_USER and AWS_SECRET_ACCESS_KEY
  lock entry: ./plugins/hostile/index.mjs · trust isolated · treeSha256 c8ee5d28a6eff068… · hosts api.github.com, uploads.example.com · credentials GITHUB_TOKEN -> api.github.com; GITHUB_USER -> api.github.com
  [pr-rla] plugin hostile@6.6.6 runs isolated: placeholder credentials, read-only access to its own files; Node 22 cannot block its network access, so it could still send out what it reads (Node 25 or later blocks it)
  what the plugin got, inside the host:
    process.env.GITHUB_TOKEN                 prrla-cred:GITHUB_TOKEN
    process.env.AWS_SECRET_ACCESS_KEY        null
    its whole environment                    GITHUB_TOKEN, GITHUB_USER, PR_RLA_HOST, __CF_USER_TEXT_ENCODING
    read ~/.npmrc                            refused: ERR_ACCESS_DENIED
    read a file outside the plugin           refused: ERR_ACCESS_DENIED
    read /proc/<parent>/environ              refused: ERR_ACCESS_DENIED
    write a file (own dir / tmp)             refused: ERR_ACCESS_DENIED / refused: ERR_ACCESS_DENIED
    start a process                          refused: ERR_ACCESS_DENIED
    token to its declared host, echoed back  allowed: "200 {\"authorization\":\"token prrla-cred:GITHUB_TOKEN\"}"
    Basic auth to it, echoed back            allowed: "200 {\"authorization\":\"Basic prrla-basic:GITHUB_USER:GITHUB_TOKEN\"}"
    the placeholder to another declared host refused: CREDENTIAL_HOST_MISMATCH
    the placeholder to an undeclared host    refused: HOST_NOT_ALLOWED
    prrla-basic: to an undeclared host       refused: HOST_NOT_ALLOWED
    global fetch() to an undeclared host     refused: HOST_NOT_ALLOWED
    POST (provider requests are read-only)   refused: READ_ONLY_VIOLATION
    open a socket to 127.0.0.1               allowed: "connected" (the server received "exfiltrated")
  what the fake api.github.com received (the broker swapped the placeholder there, and only there):
    GET https://api.github.com/echo  Authorization: token ghp_DEMO0123456789secret
    GET https://api.github.com/echo  Authorization: Basic YWxpY2U6Z2hwX0RFTU8wMTIzNDU2Nzg5c2VjcmV0
```

With `/opt/homebrew/opt/node@24/bin/node` the output is the same (Node 24). With `/opt/homebrew/bin/node` (26.8.2) every line is the same except two: `… no network (Node 26)` and `open a socket to 127.0.0.1  refused: ERR_ACCESS_DENIED`.

### Deviations from the design, and why

1. **Additions within `pr-rla/ipc/v1`.** The protocol is new in this release, so these are part of v1, not a new version:
   - a `describe` call evaluates `hosts(options)` and `writePaths(options)` without creating an instance, so the parent can refuse before `create` runs;
   - `sleep`/`slept` and `log` messages, so a plugin's waits run on the command's clock (one clock per command, as bolts 1 and 2 require) and its `ctx.log` reaches the command's log;
   - `error` with `id: null` reports a load failure;
   - `appendVerdict` and `nativeCounts` are callable: the SDK interfaces have them and the contract's method list left them out;
   - `ready` also carries the definition's shape, `credentials`, `populationOptions` and the child's Node version.
2. **The parent validates the definition**, not the child: the child reports the fields and the parent runs the SDK's own `assertProviderDefinition` / `assertLedgerDefinition` on them, so a hostile child cannot skip validation.
3. **A plugin links against the host's SDK.** `module.registerHooks` in the child maps `pr-rla/provider` and `pr-rla/ledger` to pr-rla's own modules. A plugin's own copy of pr-rla (the Gitea example's `file:` link points at the whole repo) is never loaded, hashed or readable, and an isolated plugin needs no `npm install`. `trust: full` plugins still resolve their own, as before. This needs Node 22.15 or later; on an older Node the child refuses with that message (untested there: only 22.23.2, 24.20.0 and 26.8.2 ran).
4. **Lock fields.** `name` is the plugin definition's name (what the child reports), so `PluginIdentity.name` stays what it was; `version` comes from the plugin's package.json; `resolved` and `npmIntegrity` from the audit repo's package-lock.json for a package, `file:<path from the audit directory>` and null for a path plugin, and null integrity for an npm local-path (link) install. `plugin add` refuses a package with no package-lock entry (the draft's "required for package plugins").
5. **"Inside the audit repo"** is the git work tree holding the audit directory (or the directory itself without one), so the Codeberg example's `../providers/gitea` qualifies.
6. **A placeholder only for a credential that is set.** An unset locked credential stays unset in the child, as it would in process; otherwise every anonymous run would send a placeholder the broker cannot swap and be refused.
7. **What the lock grants is what the broker enforces.** At load, what the plugin now asks for (hosts and write paths for these options, credential names) must be within its lock entry, or it is refused with `plugin lock`. This catches an options change such as a new `base_url`.
8. **An isolated plugin that declares no hosts may contact none.** The broker reads an empty host set as "any" (built-ins), so the AuditContext gives such a plugin a set no host matches.
9. **Message limits.** Outgoing messages are measured before they are sent. Incoming ones are measured after Node's IPC channel has parsed them, so the limit bounds what is accepted, not memory. The heartbeat watchdog counts any message and runs only while the plugin loads or a call is in flight.
10. **Broker hints across IPC.** An isolated plugin's `acceptJson` predicate cannot cross a process boundary, so it becomes "the body must parse", and its retry counts are capped at the broker's own limit (6 retries).
11. **`plugin check` fixtures** are data: the recorded-fixture format of `scripts/record-fixture.mjs`, listed in the plugin's package.json as `"pr-rla": { "conformance": [...] }` and/or passed with `--fixture`. The parent replays them; requests to hosts the plugin did not declare are refused as the broker would. With no fixtures, `check` exits 1: a gate with nothing checked does not pass. There is no ledger kit on this branch (it is U4's), so a ledger's check reports that and exits 1. Only the expectations of the kit's shape are read (the recorder writes `expected.pullRequests` as a count).
12. **`plugin add` and `plugin lock` need the plugin named in `.pr-rla.yml`**, because its options decide its hosts; `plugin check` does not (it then asks with no options).
13. **Check 5's identity comparison is in the verify command**, not in `src/core/verify.ts`, to leave the core to U3 (which adds the `populationOptions` FAIL there). It compares an external provider's name, source, version, integrity, options hash and trust, and turns a PASS into a WARN with the difference.
14. **Every command opening an isolated plugin prints what isolation it has** (NFR4): placeholder credentials, read-only access to its own files, and whether this Node blocks its network.
15. **The child replaces its global `fetch`** with the IPC fetch, so a plugin calling `fetch()` directly still goes through the broker.
16. **The `now` field** the Gitea tests inject in process is not part of the SDK and is not forwarded; the child uses its own clock. The Gitea plugin uses it only to stop its second list walk, and the recorded and synthetic data give the same results.
17. **One existing test's setup changed.** `test/api-context.test.ts` opened an unlocked example plugin through `openProvider`; it now copies and locks it in a temp audit directory first (5 lines). Every assertion is unchanged.

### Findings

- On Node 22 and 24, `process.permission.has("net")` is `false` although the network is not controlled at all. The host goes by the Node version (25 or later), not by that call.
- A directory grant does not leak to a sibling with the same prefix (`plug` vs `plug-evil`), and a bare import resolves when only the dependency's own directory is granted. Node removes `NODE_CHANNEL_FD` from the child's environment; macOS adds `__CF_USER_TEXT_ENCODING` to every process.
- `module.registerHooks` works under `--permission` without `--allow-worker` (its hooks run in-thread).
- The tree must be hashed before a child is granted anything: the permission model checks the path it is given, so an escaping symlink inside a granted directory would otherwise be read through (the class of CVE-2025-55130). `readGrants` hashes first.
- A child starts in about 70 ms; the kit through the host on one fixture takes about 0.5 s (it makes six instances, so six children).

### Unverified

- Node 25.x itself (the row rests on 26.8.2), Linux (`/proc/<ppid>/environ` was refused, but macOS has no `/proc`), Windows.
- Node 22.13 and 22.14 (no `module.registerHooks`): the child should refuse with the 22.15 message; not run.
- `npm audit signatures` in `plugin check`: it asks the npm registry, so it never ran in this bolt (`--offline` everywhere).
- A package plugin installed from the real registry: the tests use synthetic package-lock entries.
- An external ledger against a real tracker, and the ledger kit through the host (U4).
- **Credentials whose hosts depend on options.** SDK v1's `credentials` is a static list, so the Gitea example declares `GITEA_TOKEN` for codeberg.org only. An isolated self-hosted Gitea with a token gets `CREDENTIAL_HOST_MISMATCH` (refused unsent) instead of sending it; in process it works as before. Open question: a credential grant `plugin add` takes from the reviewer (`--credential ENV=host`), or `credentials(options)` in a later SDK.

### Shared files this bolt touched (for merge planning)

- `src/api/context.ts`: imports; `AuditContext.plugins` and `AuditContextOptions.plugins`; the no-hosts sentinel in `hostsFor`; one early branch in `openProvider`; `openLedger`'s first five lines moved into `openBuiltinLedger`.
- `src/registry.ts`: two imports; `builtinProviderName`, `builtinLedgerName`; an external branch at the top of `pluginIdentity` and its new `policy` parameter (U3 edits the built-in branch's `populationOptions` below it).
- `src/commands/context.ts` (`CommandContext.plugins`, one line in `auditContextFor`), `register.ts`, `freeze.ts` (pass the policy to `pluginIdentity`; register prints plugin lines), `verify.ts` (identity WARN, `PLUGIN TRUST` line), `src/cli.ts` (`--plugins`, the `plugin` command group, `closeAllPluginHosts` in `run`).
- `examples/providers/gitea/index.mjs` (two definition fields, next to where U3 adds its own) and `package.json` (`files`, `"pr-rla"`); `examples/codeberg-forgejo-docs-2026-10/.pr-rla.yml` (comment).
- `package.json` and `package-lock.json`: `engines.node` `>=22.13` only. No export, dependency or script changed; `src/testing/index.ts` untouched.
- `README.md` (step 5 under "Adding a provider", one limitation bullet), `docs/writing-a-provider.md`, `test/api-context.test.ts` (above). New: `docs/security-model.md`, `docs/build-notes/u2b.md`.

### What later units need to know

- **U8 (org-pooled freeze runs external providers through the host).** Open the provider once per freeze with `openProvider`: one child serves every repo. The host takes concurrent calls (each has its own id), so P = 4 parallel `listChanges` on one hosted provider works and shares the broker's per-host budget. `listRepos` is proxied when the plugin has it. Keep each call's result under 64 MiB, which per-repo calls do; do not build the pooled population inside the plugin. Pass `req.signal` to cancel (the host sends `cancel` and aborts that child's in-flight fetches). A long `listChanges` is safe: heartbeats continue while the child waits on the broker. The lock's hosts are computed from the configured options at `plugin add`, so a rule's hosts must not vary per repo. The child dies with the command (`closeAllPluginHosts`); a resumed run starts a new one. `freeze` calls `pluginIdentity` after opening the provider, which starts a second, short-lived child to read `populationOptions`.
- **U3.** For an isolated plugin, `populationOptions` comes from the child's `ready` message, already wired in `src/plugins/identity.ts`. Never import an isolated plugin in process to read it. When `pr-rla/http` is exported, add it to `SDK_MODULES` in `src/plugins/host.ts`. `head`, `headSha` and `Actor.id` cross IPC as data. Expect a small conflict where both branches add fields to the Gitea definition.
- **U4.** An external ledger through `openLedger` or a command now needs a lock entry; tests can use `test/helpers/plugin-lock.ts`. Wire `runLedgerConformance` into `src/plugins/check.ts` (ledgers report "not run" and exit 1 today). An isolated ledger has no fs-write: a Jira ledger that only speaks HTTP is fine. `readHistory` is proxied. The Jira example's `prrla-basic:JIRA_EMAIL:JIRA_TOKEN` works through the host when both are locked credentials for its site; see the credential open question above for options-dependent hosts.
- **U5.** In read-only mode an isolated ledger's writes are refused before they reach the child (tested). `pr-rla-mcp` should honour `PR_RLA_PLUGINS`.
- **U10.** `docs/security-model.md` holds the plugin section; extend it with the rest of the model. `engines` is already `>=22.13`.

## Bolt 5 (U3): SDK carry-overs (2026-11-04)

*Appended from `docs/build-notes/u3.md` (kept there too) at the wave-1 integration. Written on its own branch; "Integration: wave 1" below records what changed when it met U2b and U4.*

Goal (delivery-plan.md, bolt 5): FR7.1–FR7.7. The registered bot list, the pinned head, `Actor.id`, `reviewGranularity`, `pr-rla/http` and `landedVia` with `direct_push_via_merge`, all optional within provider API version 1, implemented by every built-in where the SCM provides them, with four new kit checks that every built-in and the Gitea plugin pass.

Built on branch `bolt/u3-sdk-carry-overs` from the end of bolt 2 (`54e1628`), in parallel with U4 (master) and U2b. These notes are kept out of `BUILD-NOTES.md` so the branches merge cleanly.

### Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR7.1 `selector.bots`, applied by the core to every actor on every provider; on recorded gitlab-org/cli data `bots: ["gitlab-bot"]` moves exactly 4 MRs into the stratum | met | `gitlab-provider.test.ts › … October 2026`: no-human-review 0 → 4 (!4191, !4247, !4251, !4253), also as `id:1786152`; `e2e-u3.test.ts`: the list is signed into the registration and re-applied by `verify`; the demo below |
| FR7.2 pinned head: `headSha` in the manifest, `ListChangesRequest.head` in `verify`; a synthetic commit pushed after freeze no longer fails check 5 | met | `e2e-gitlab.test.ts › FR7.2`: a merge pushed on 10-25 brings in a commit dated 09-30; from the branch's head it is a direct push the manifest lacks, `verify` walks the frozen head and check 5 passes (`population 400/400 match`); per provider, `walks from request.head` tests; kit check `pinned-head` |
| FR7.3 `Actor.id`; `id:<n>` selectors; a renamed user stays the same actor in `verify` | met | `e2e-u3.test.ts › FR7.3`: `claude[bot]` renamed after freeze to `claude-code[bot]` with the same id: check 5 PASS with `1 account(s) renamed since freeze, matched by account id: claude[bot] → claude-code[bot]`; the same rename without ids FAILs check 5 |
| FR7.4 one review object defined in the SDK; `reviewGranularity` declared per provider and recorded in the manifest; the kit's check passes on every built-in | met | `Review` JSDoc in `src/sdk/provider.ts`; GitHub `submission`, GitLab and both Bitbuckets `first-comment-per-user`, json-file default; the manifest's `provider.reviewGranularity` (`e2e-gitlab.test.ts`); `review-granularity` passes on all five built-ins and the Gitea plugin |
| FR7.5 `pr-rla/http` with its own version constant | met | `package.json` export `./http`; `HTTP_HELPER_VERSION = 1`; `createJsonClient` (`sdk-u3.test.ts`); in the clean clone `import('pr-rla/http')` → `HTTP_HELPER_VERSION 1 function` |
| FR7.6 `ChangeRecord.landedVia` and `direct_push_via_merge: include \| exclude` (default `include`), named on the certificate; on recorded bamboo-specs data `exclude` removes the release-branch commits | met | `bitbucket-cloud-provider.test.ts › … 2026-10-06`: 5 direct pushes, 4 with `landedVia` = Tardigrade's merge `a9f178ae03`; `exclude` leaves only the merge; the status/verify certificate line says `direct pushes via a pushed merge included\|excluded` (`selector-u3.test.ts`) |
| FR7.7 every new SDK field optional, within API version 1; the phase-2 providers pass unchanged | met | `conformance.test.ts › a phase-2 provider (no headSha, no ids) still passes`; the template example and the Gitea plugin's own node:test pass unchanged; `sdk-u3.test.ts` |
| Every built-in and the Gitea plugin pass the extended kit | met | GitHub, GitLab, Bitbucket Cloud, Data Center: synthetic fixtures plus a late-push fixture, none of the 17 checks skipped; recorded gh-aw, gitlab-org/cli (11-02 and October), freedesktop, bamboo-specs (10-27 and 10-06), Codeberg; json-file with its definition (the checks it cannot exercise skip and say why) |
| `populationOptions` (functional-design §U3 "Added"): a mismatch FAILs check 5 | met | `e2e-u3.test.ts › populationOptions`: a different `scope` FAILs check 5 and `freeze` refuses it; a different `page_size` does not |
| Kit check `revoked-approval` | met | every synthetic fixture (erin unapproved, carol reset by a push), and !4290's withdrawn `gitlab-bot` approval on recorded gitlab-org/cli |

### Done

| Piece | Where |
|---|---|
| SDK: `Actor.id`, `ChangeRecord.landedVia`, `ListChangesRequest.head`, `ListChangesResult.headSha`, definition `reviewGranularity`, `populationOptions`, `reportsLandedVia`, validators, the "one review object" definition | `src/sdk/provider.ts` |
| `pr-rla/http`: the phase-2 `HttpClient` moved here; `createJsonClient`, `HTTP_HELPER_VERSION`; `src/providers/http.ts` re-exports it | `src/sdk/http.ts`, `package.json` |
| Core: `normalizeBotList`, `actorMatches` (`id:<n>`, aliases), `applyBotList`, the `exclude` step, renamed-account aliases from the manifest | `src/core/selector.ts`, `src/core/population.ts` |
| `freeze`: records `headSha` and the definition's `reviewGranularity`, prints the `landedVia` diagnostic, refuses changed population options; `register`: the landedVia warning; the certificate line names the bot list and the via-merge choice | `src/commands/{freeze,register,status,verify}.ts`, `src/provider-traits.ts` |
| `verify` check 5: walks the frozen head, aliases renamed accounts by id, FAILs on changed population options, says when the provider does not pin history | `src/core/verify.ts` |
| `landedVia` for the built-ins (pure) | `src/providers/landed-via.ts` |
| Built-ins: GitHub (`databaseId`), GitLab (user id from GraphQL and REST), Bitbucket Cloud (`uuid`), Data Center (user id), each with the pinned head, `landedVia` and the three definition fields | `src/providers/*` |
| Gitea plugin: user ids, the pinned head, `reviewGranularity`, `populationOptions` | `examples/providers/gitea/index.mjs` |
| Kit: `pinned-head`, `actor-ids`, `review-granularity`, `revoked-approval`; `ConformanceOptions.definition`; fixture `pinnedHead`; expected actors compared on the fields they name | `src/testing/conformance.ts` |
| Fixtures: gh-aw 11-02, gitlab-org/cli 11-02 and freedesktop re-recorded; gitlab-org/cli October and bamboo-specs 10-06 new | `test/fixtures/` |
| Demo | `scripts/demo-sdk-carry-overs.mjs` |
| Tests: 45 new (308 → 353) | `sdk-u3` 7, `selector-u3` 10, `e2e-u3` 8, `conformance` 6, and provider/e2e tests |

### Live calls (all read-only, all 2026-11-04)

| What | Requests | Time (UTC) | Why |
|---|---|---|---|
| GitHub gh-aw 2026-11-02, re-recorded twice, token from `gh auth token` | 16 + 16 | 00:05:09, 00:06:30 | the GraphQL queries now ask for `databaseId`. The first recording carried a personal commit e-mail (commits made after the original recording); the recorder now scrubs non-noreply addresses and the second recording replaced it |
| GitLab gitlab-org/cli 2026-11-02, no token | 24 | 00:11:52 | GraphQL users now carry `id` |
| GitLab gitlab.freedesktop.org xorg/xserver 2026-10-05..07, no token | 12 | 00:12:01 | same |
| Bitbucket Cloud atlassian/bamboo-specs 2026-10-06, no token | 38 | 00:14:53–00:15:09 | new: the pushed release merge (FR7.6). No 429 |
| GitLab gitlab-org/cli October 2026 through `freeze --dry-run` (`record-fixture.mjs --cli`), no token | 462 | 00:15:33–00:18:21 | new: the bots demo (FR7.1) |
| `curl` of `/approvals` and the MR for !4191, !4247, !4251, !4253 | 8 | 00:19:14 | independent check: each was approved only by GitLabDuo and gitlab-bot, merged into main by jay_mccure |

Each re-recording was replayed through the bolt-2 code (a `git archive` of `54e1628` built in the scratchpad) and the new code: normalized without ids, the records are byte-identical (38, 9 and 2 changes); only `headSha` is new. gh-aw PR #73884's merge commit still has no `associatedPullRequests`, so that regression case survives. Every fixture was grepped for e-mail addresses: only `user-<hash>@example.invalid`, GitHub noreply addresses and Bitbucket's bot address (kept for bot detection, as before).

### Verified (command → output)

From a fresh `git clone` of the branch at `53fe2f2`, 2026-11-04T00:29Z, Node 22.23.2:

```
npm ci                                     → added 60 packages … found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 30 passed (30) · Tests 353 passed (353)
npm --prefix examples/providers/gitea ci   → added 1 package … found 0 vulnerabilities
npm --prefix examples/providers/gitea test → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm ls --prod --depth=0                    → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1
```

- 353 tests = the 308 of bolt 2 plus 45 new. None skipped. `npm test` makes no network call (the network-deny harness is unchanged; every new test replays recordings or uses fakes).
- Each of the 15 code commits (everything before this note) was checked in the scratch clone: typecheck clean, and 315, 325, 325, 327, 330, 333, 334, 335, 336, 344, 351, 351, 351, 352 and 353 tests passing.

**The demo** (`node scripts/demo-sdk-carry-overs.mjs`, offline, in the clean clone; trimmed):

```
1. gitlab-org/cli, October 2026 (recorded 2026-11-04): GitLab reports gitlab-bot as bot: false
   selector.bots: []
     no recorded human review................ 0
     N = 0
   selector.bots: ["gitlab-bot"]
     actors re-labelled as bot by selector... 164
     no recorded human review................ 4 (merged by: 4 human accounts, 0 bot, 0 unknown/direct push)
     N = 4: #4191, #4247, #4251, #4253
   selector.bots: ["gitlab-bot"], max_changed_lines: 200 (the example's stratum)
     no recorded human review................ 4
     <= 200 changed lines.................... 3
     N = 3: #4191, #4251, #4253

2. atlassian/bamboo-specs, 2026-10-06 (recorded 2026-11-04): Tardigrade's merge of the 13.0 branch, pushed to master
   direct_push_via_merge: include (the default)
     N = 5: @4f1f0c51…, @735553ca…, @78611696…, @9470b730…, @a9f178ae…
     diagnostic: direct pushes that arrived through merge a9f178ae03b6… (a non-first parent): 4
   direct_push_via_merge: exclude
     excluding pushes via a pushed merge..... 1
     N = 1: @a9f178ae03b65a3190e4eb98f9454c7fcad71c91
```

### Deviations from the design, and why

1. **`reportsLandedVia`, a definition field the contract does not list.** `register` must warn "provider X does not report landedVia" before any change is listed, so only the definition can say it. It is optional, within API version 1, and owned by U3.
2. **`landedVia` names the outermost pushed merge, and only a merge that is itself a direct push in the population.** For each direct-push merge M, the commits it brought in are those reachable from its non-first parents and not from its first parent, over the history the provider walked. A commit brought in through nested merges (a release branch merged into another, then pushed) names the one no other of them brought in; on bamboo-specs that is Tardigrade's merge for all four. A PR's merge commit never names anything (its commits belong to the PR). Limitation, added to the provider's limitations whenever it reports `landedVia`: without push history a `git pull` merge pushed to the default branch ("foxtrot") is indistinguishable, so the mainline commits behind its second parent are reported as arriving through it, and `exclude` would drop them. gh-aw has 8 such merges in Q3; its registration uses `include`.
3. **Re-labelling keeps the login.** The design says `applyBotList` rewrites `kind`; it does not add the `[bot]` suffix, so `authors` entries and the manifest keep matching the provider's login. It runs inside `applySelector` (not before it in `buildPopulation`), so every caller gets it and the funnel step comes with it. The step counts actor entries (author, merger, review), and appears only when the list is non-empty; the `exclude` step only when `exclude` is set. So phase-2 funnels are unchanged.
4. **Matching.** `id:<v>` entries match `Actor.id` exactly and never a login; logins stay case-insensitive and exact (a bare login does not match its `[bot]` form, as before). `authors` gains `id:<v>` too. Bot-list entries are trimmed, de-duplicated (logins case-insensitively) and sorted.
5. **Renamed accounts are aliased from the manifest.** `verify` maps each account id in the frozen changes to the login it had then, and a selector login matches an actor whose id maps to it. So the rename case of FR7.3 holds for every change in the manifest. Not covered: an account renamed after freeze whose changes were *excluded* by a login-based rule (say `merged_by: human` with that account in `bots`); `id:<n>` entries cover that.
6. **Check 5 and the pinned head.** When the manifest has a `headSha` and the provider walks elsewhere (or reports none), check 5 adds the contract's detail and becomes WARN. When the manifest has no head (a provider that never pinned, such as json-file), the detail is added but the status is unchanged, so json-file audits still read 7/7 PASS. A pinned walk adds `history walked from the frozen head …`.
7. **Population options are compared only when the options differ.** A registration made before U3 hashed no population options, so its `populationOptionsSha256` differs from today's even for identical options. Check 5 FAILs (and `freeze` refuses) only when both the full options hash and the population-options hash differ. The remaining edge: a pre-U3 registration whose verifier also changed a non-population option would FAIL. No such registration exists (the gh-aw one is still to be made).
8. **Kit.**
   - The definition reaches the kit as a third argument, `runProviderConformance(provider, fixtures, { definition })`, because a factory returns instances.
   - `actor-ids` exempts a direct push's author (a git identity the SCM links to an account only sometimes) and `ghost`.
   - `pinnedHead` is a fixture field. Without it, a provider that reports `headSha` is re-run from that head and must give the same head and records, so recorded fixtures exercise the check too.
   - The `actors` and `reviewers` expectations now compare login and kind, and the id only when the expectation names one (its own commit, first, so providers adding ids keep passing old fixtures).
   - The kit's own "none skipped" test now runs a fake that reports ids and a head, and a new test shows a phase-2 provider passing with two skips.
9. **`createJsonClient`** takes the contract's `{ base, headers, fetch, sleep, log, maxRetries }` plus the built-ins' `name`, `rateLimitHint` and `maxBlindRateLimitRetries`, and returns the same `HttpClient` the built-ins use. Moving it into the self-contained SDK meant detecting broker errors by shape (`code`, `host`, `next`) instead of `instanceof BrokerError`. The Gitea plugin still carries its own client: switching it was not needed, and U2b edits the same file.
10. **The Gitea plugin reports no `landedVia`** (the helper is internal to the built-ins, and the plugin imports only `pr-rla/provider`). `register` warns if it is paired with `exclude`. Its `bots` option stays: the registered list is applied on top, and `bots` is now one of its population options.
11. **Per-provider id choices.** GitHub: `databaseId` on `User`, `Bot`, `Mannequin` and `Organization` actors (an `EnterpriseUserAccount` would have none). GitLab: the numeric id, from REST or the end of the GraphQL gid. Bitbucket Cloud: `uuid`, through a new `account()`, so the exported `normalizeUser` and its tests are unchanged; the Gitea plugin does the same. Data Center: the numeric id (from the documented shape).
12. **Population options per built-in:** GitHub `base_url`, `api_url`, `graphql_url`; GitLab `base_url`, `listing_slack_hours`; Bitbucket Cloud `api_url`, `listing_slack_hours`; Data Center `base_url`; Gitea `base_url`, `bots`; json-file none (its `path` can differ between a freezer and a verifier with the same file).
13. **Two existing assertions were updated, both to values U3 now fills.** `e2e-gitlab.test.ts` pinned the manifest's provider identity with bolt 1's placeholders (`reviewGranularity: "submission"`, `populationOptionsSha256` over `{}`); it now expects `first-comment-per-user` and the hash over `base_url`, and also checks `headSha`. The GitLab note-pagination test's expected review author now carries its id. No assertion was loosened.
14. **CLI-mode recordings and the provider's clock.** `record-fixture.mjs --cli` stamps `recordedAt` when the script starts, but GitLab re-scans its listing from its own walk start minus 60 s. Replays derive that clock from the recording (`recordedWalkClock` in `test/helpers/replay-fetch.ts`).
15. **The October GitLab fixture is 2.0 MB** (462 exchanges, a whole month). It is the data the definition of done names.

### Findings

- **The October population of commits moved, the changes did not.** Phase 2 counted 414 default-branch commits dated in October; on 2026-11-04 there are 415, all linked to merged MRs, with the same 205 MRs. A commit dated in October reached `main` later through an MR. It is attributed to that MR, so it is not a direct push. This is the drift the pinned head guards against when such a commit is *not* claimed.
- **gitlab-bot is account 1786152 and appears 164 times** as an actor in October (approvals, withdrawn approvals, comments), always `bot: false`.
- **The 2026-10-06 bamboo-specs merges are empty:** all five direct pushes have 0 changed lines in Bitbucket's diffstat (`release/empty/merge_…` branches). Under `include` the stratum gains 5 changes with nothing to review.
- The re-recorded GitLab fixtures needed fewer requests (24 and 12) than the originals (28 and 19), with identical records: the current walk claimed every commit from the listing and read no MR commit lists.

### Unverified

- `landedVia` on real GitHub, GitLab and Data Center data: only Bitbucket Cloud has a recorded pushed merge; the others are synthetic.
- A real account rename on any SCM (the FR7.3 test renames a login in a json-file export).
- `databaseId` on GitHub Enterprise Server; Data Center's user `id` against a live server (as before).
- The Gitea plugin through U2b's isolated host (not in this branch).

### Shared files touched (for merging with U4 and U2b)

- `package.json`: one export added (`./http`).
- `src/testing/index.ts`: one type added to the export list (`ConformanceOptions`).
- `README.md`: one bullet (`pr-rla/http`), one clause (the kit's U3 checks), one sentence (registering bots).
- `src/config.ts`: two lines in the `init` template's selector.
- `examples/providers/gitea/index.mjs`: `account()`, the pinned head, and three lines in the definition (near `description`, where U2b may add `hosts` and `credentials`).
- `src/sdk/provider.ts`, `src/sdk/http.ts`, `src/providers/http.ts` (now a re-export), `src/testing/conformance.ts`.
- `src/commands/{freeze,register,status,verify}.ts` and `src/core/{selector,population,verify}.ts`.
- Test helpers: `fake-github.ts`, `fake-gitlab.ts`, `fake-bitbucket-dc.ts`, `scm-scenario.ts` (the `latePush` variant), `replay-fetch.ts`.
- Not touched: `src/registry.ts` (the traits live in the new `src/provider-traits.ts`, which reads the definition in process: U2b's isolated host must supply `reviewGranularity`, `populationOptions` and `reportsLandedVia` from the child, as its `ready` message is designed to), `src/api/`, `src/net/`, `src/ledgers/`, `BUILD-NOTES.md`.

### What U5 and U8 need to know

**U5 (audit API, `draw-context`, MCP):**
- `describeChange` is U5's: nothing in this branch implements it. `ScmProvider` has no `describeChange` member yet; add it as optional, as contracts §1 shows.
- Every built-in actor now carries `Actor.id` (direct-push git identities and `ghost` excepted). Use it to match reviewers and to show stable identities; logins remain the display value. `manifestAliases(changes)` gives id → frozen login.
- The manifest's `repos[0].headSha` is the pinned head; report it in `status`/`verify` results. `Population` now has `headSha` and `viaMerge`, and `freeze --dry-run --json` prints both: `freeze_preview` can pass them through.
- The certificate line comes from `statusLine(…, { selector })` and names the bot list and the via-merge choice; the API's status result should carry the same.
- `providerTraits(spec, dir)` reads the definition fields; it loads the definition in process.

**U8 (org-pooled freeze):**
- `ListChangesRequest.head` is per repository: record each repo's `headSha` in `manifest.repos[]` and pass each back in `verify`.
- `reviewGranularity` is per provider; the design's rule that a pooled `unreviewed: no-review` across providers of different granularity is refused at `register` is not built (single-repo audits have one provider). With one provider per pool (RQ15) it holds trivially.
- `selector.bots` is applied by the core across the whole pooled population; prefer `id:<n>` entries there, since logins are not unique across hosts.
- `landedViaMerges` (`src/providers/landed-via.ts`) is pure and costs one reachability walk per direct-push merge; a large org with many pushed merges will feel it.

## Integration: wave 1 (U2b + U3 + U4, 2026-11-04)

Branch `integrate/wave1`, from the end of bolt 2 (`54e1628`). U2b (`bolt/u2b-plugin-host`) and U3 (`bolt/u3-sdk-carry-overs`) were built in parallel from that commit and U4 on `master`; this section is what it took to make them one program. Neither bolt branch was changed.

### Merges and conflicts

| Commit | What | Conflicts, and how they were resolved (both units' behaviour kept) |
|---|---|---|
| `c8e33ce` | `merge --no-ff bolt/u2b-plugin-host` | none |
| `8a7e0ff` | `merge --no-ff bolt/u3-sdk-carry-overs` | `examples/providers/gitea/index.mjs`: U2b's `hosts` and `credentials`, then U3's `reviewGranularity` and `populationOptions`. `src/commands/freeze.ts`: U2b's `pluginIdentity(…, policy)` and U3's `providerTraits`. `docs/writing-a-provider.md`: U3's `pr-rla/http` paragraph, then U2b's broker paragraph. `src/commands/verify.ts` merged textually but imported `pluginIdentity` twice; one kept. `README.md`, `package.json`, `package-lock.json`, `src/config.ts`, `src/cli.ts`, `src/commands/{register,context}.ts` and the test helpers merged cleanly |
| `facfb8f` | `merge --no-ff master` (U4, at `7d044f8`) | `README.md`: U3's provider-kit sentence and `pr-rla/http`, with U4's ledger-kit bullet. `src/api/context.ts`: U2b's split into `openBuiltinLedger` / `openExternalLedger`, carrying U4's `reviewers`, the ledger's `sleep`, `LEDGER_BUDGET_FAMILY` and (until `c021c4d`) its empty-hosts credential rule; external ledgers get `reviewers` and `sleep` through the host's `create`. `src/commands/register.ts`: U2b's policy and trust lines, U3's landedVia warning, U4's `preflightLedger`, `verdicts` and reviewers line. `src/commands/verify.ts`: the loaded identity computed once, with U4's `checkpoints`, `checkpointProblems` and `ledgerSkipped` |

The merge commits typecheck; `8a7e0ff` and `facfb8f` each left tests failing on the integration gaps below, fixed in the commits that follow them.

### Gaps fixed

1. **Provider traits across the host** (`1f1af6c`). U3's `providerTraits` imported the provider in process to read `reviewGranularity`, `reportsLandedVia` and `populationOptions`; with U2b that ran an isolated plugin in pr-rla's own process, with the real environment.
   - `describe` (`pr-rla/ipc/v1`) also returns those three fields, additively. The parent validates them with the SDK's own `providerTraitProblems`, and now validates `ready`'s `reviewGranularity` and `populationOptions` at load too.
   - `externalPluginInfo` reads them through `describe` (`trust: full` reads the imported definition). `pluginIdentity` and `providerTraits` both use it, so the registration, the manifest's `reviewGranularity` and register's landedVia warning come from one place.
   - `plugin check` hands the kit the traits the child described (so `review-granularity` runs through the host), and reads U3's `actorIds`, `revokedApprovals` and `reviewGranularity` from a recorded fixture.
   - `pr-rla/http` is mapped to the host's own SDK module in the child, as U2b's notes asked.
   - Shown by `wave1-integration.test.ts`: the Gitea plugin's traits read isolated (`submission`, `["base_url","bots"]`, no landedVia); a plugin that throws when imported outside the host goes through `register`, `freeze` (manifest `reviewGranularity: first-comment-per-user`) and `verify` (check 5 PASS); a child reporting `reviewGranularity: "per-comment"` is refused `PLUGIN_INVALID`.
2. **The plugin policy everywhere** (`1f1af6c`, `8f187ec`). U3's calls to `pluginIdentity` in `freeze` and `verify`, and U4's in `checkpoint`, passed no policy. With `--plugins builtin-only` they would have started an isolated plugin's child, or imported a `trust: full` one, before anything refused. Every command now passes `auditContextFor(ctx).plugins`.
3. **Credentials for self-hosted isolated plugins** (`a4293a3`). SDK v1's static list refused an isolated self-hosted Gitea run with a token. Within provider API version 1, a credential may name the option holding the service's URL: `{ env: "GITEA_TOKEN", hosts: ["codeberg.org"], hostFromOption: "base_url" }`.
   - pr-rla computes the host from the option, not from the plugin's code (`credentialGrants`, `src/plugins/host.ts`): the URL's host when the option is set and is `https:`; no host for any other value, so a token is refused unsent rather than sent in clear text; the declared `hosts` without the option.
   - `plugin add` / `plugin lock` record the computed hosts and `hostFromOption` in the lock entry and print `GITEA_TOKEN -> gitea.example.com (the host of option base_url)`. Every load recomputes them and refuses a host the lock does not grant, so a changed `base_url` needs `plugin lock`. The broker still swaps the placeholder only on the locked hosts.
   - The registration commits to the option through `optionsSha256`, and for Gitea through `populationOptionsSha256` too (`base_url` is a population option), so a verifier with another `base_url` FAILs check 5 before it could send the token anywhere.
   - Shown: an isolated Gitea at forge.example.com receives `token <secret>` on every request there; without `base_url` the grant stays codeberg.org; a changed `base_url` is refused at load naming the credential; an `http://` `base_url` grants no host and nothing is sent.
4. **External ledgers through the host** (`c021c4d`). U4 read an external ledger's definition in process in three places: `register`'s preflight (`hosts`, `writePaths`, `create()`, `provenance`), `record` (`provenance`) and `verify` (`hosts`, for the offline skip).
   - `describe` also returns a ledger's `provenance`; the new `ledgerTraits` (`src/ledger-traits.ts`) gives `record` and `verify` the name, provenance and hosts (an external ledger's locked hosts) without importing it.
   - `register`'s preflight runs in the ledger's host: lock and files checked, `hosts` and `writePaths` evaluated and compared with the lock, `create()` run in the child with a fetch that refuses. Lock refusals keep their code (`NOT_LOCKED` names `plugin add`); what the ledger throws is reported as U4 reported it.
   - **The Jira ledger writes `ledger-index.json`, and an isolated child cannot write files.** `LedgerContext.index` (optional, `ledgerApiVersion` 1) is that one JSON document: pr-rla reads and writes `<windowDir>/ledger-index.json` for the ledger, atomically, over two messages added within `pr-rla/ipc/v1` (`index`, `indexResult`); writes are refused in a read-only context. The Jira example uses it when offered and keeps its own file code otherwise, so its package test is unchanged.
   - Shown: the Jira example passes `runLedgerConformance` with every ledger instance in its own host child (both recorded hibernate fixtures and the synthetic ones; all 13 checks its package test requires ran); isolated, `JIRA_EMAIL`/`JIRA_TOKEN` reach it as placeholders, the broker builds Basic auth (`prrla-basic:`) for the `base_url` host only, pr-rla writes its index, and an undeclared host is refused; a ledger that throws when imported outside the host goes through the preflight, `record` and `verify --offline` (check 7 SKIP naming its host); an options error comes back from the child; an unlocked ledger is refused naming `plugin add`.
5. **One credential mechanism** (`c021c4d`). U4 let a ledger credential with `hosts: []` follow `hosts(options)`, in process only. The Jira example now declares `hostFromOption: "base_url"` for both credentials, and built-in and `trust: full` ledgers resolve credentials with the same `credentialGrants` as providers. An empty `hosts` without `hostFromOption` means no host again, as the broker always enforced it.
6. **HTTP 204 through a JSON check** (`73fa7fb`, U4 finding 4). `checkJsonBody` rebuilt every checked response with a string body, and `new Response("", { status: 204 })` throws. A 101, 103, 204, 205 or 304 now passes through with no body and no check, in the broker and the kit's harness. Test: `broker.test.ts › a 204, 205 or 304 to a request with a JSON check passes through`.
7. **Reviewers by `id:`, as U3 matches actors** (`259d2bb`). U4's `verdictIneligibility` already matched `id:<account id>` against the event's `provenance.actorId`, which is the tracker event's `Actor.id` (GitHub's numeric id, GitLab's user id, Jira's accountId), the same ids U3's providers report. It also let a bare entry match an id; U3's rule (`actorMatches`) is that a bare entry is a login, never an id. They now agree, case by case (`wave1-integration.test.ts`, 6 cases, each checked against `actorMatches` too). No U4 test relied on the bare-id match: Jira's reviewers are its accountIds, which are also its logins.

### Registration identity and check 5: U3 and U2b agree

- An external plugin's `PluginIdentity` takes `name`, `source`, `version`, `integrity` (treeSha256) and `trust` from its re-verified lock entry (U2b), and `optionsSha256` and `populationOptionsSha256` from the same `optionsDigest` U3 uses for built-ins, over the keys the definition lists, now read through `describe`. A U2b-era registration hashed the keys from `ready`, which are the same, so U3's pre-U3 compatibility rule (deviation 7) is unaffected.
- The manifest's provider is that identity plus `apiVersion` and the `reviewGranularity` from the same traits read.
- Check 5 evaluates one loaded identity: U3's FAIL (both option hashes differ) and U2b's WARN (an external provider whose name, source, version, integrity, options hash or trust differs). A FAIL stays FAIL; the WARN only lifts a PASS. This is draft 02 Q3: other options are a WARN, population options a FAIL.
- **One U3 assertion changed for it.** `e2e-u3.test.ts` expected PASS when a non-population option (`page_size`) of a path plugin changes. With U2b that plugin is external and must be locked, and the design makes the change a WARN, so the test now expects WARN, no FAIL detail, and the WARN line naming `optionsSha256`. Its FAIL and freeze-refusal cases are unchanged.

### Decisions

- **`describe`, not `ready`, carries the traits**, as the brief asked: one call per open that already answers "what does this definition ask for with these options". `ready` keeps U2b's fields, and they are now validated.
- **`hostFromOption` over the alternatives** U2b listed (a `--credential ENV=host` grant at `plugin add`, or `credentials(options)` evaluated by the plugin) and U4's `hosts: []` rule: the host comes from configuration the user wrote, is computed by pr-rla, is a single `https:` host, and is recorded in the lock and bound by the registration's options hash. Plugin code never decides where a credential goes.
- **A parent-kept index rather than fs-write for ledgers.** Granting an isolated ledger write access to `audit/<window>/` would break the security model's "cannot write files". One parent-written JSON document keeps it true.
- **`plugin check` still does not run the ledger kit.** Its fixtures are built by code (fake trackers, published issues), and `plugin check` replays recorded data only; the message now says so, and the command still exits 1 for a ledger.

### Tests

468 = 308 (bolt 2) + 37 (U2b) + 45 (U3) + 59 (U4) + 19 (this integration: 18 in `test/wave1-integration.test.ts`, 1 in `broker.test.ts`). 467 pass; 1 is skipped: U2b's `UNVERIFIED` RK-02 placeholder, skipped because the RK-02 test ran on Node 26.8.2 found on PATH.

Existing tests changed, none weakened:
- `e2e-u3.test.ts › populationOptions` (3): the path plugin is locked (`trust: full`, since it reads the audit directory), and the WARN above.
- `plugin-host.test.ts › the Gitea example … through the host` (2): the recorded run's skip list adds `revoked-approval` (U3's check, with nothing to check: the recording's one stale Codeberg approval still counts) and asserts `review-granularity` ran; the synthetic run adds U3's expectations, the traits from `describe` and a pinned-head fixture, and still asserts no skips.
- `jira-example.test.ts` (2): they opened the example unlocked from the repo root; they now lock a copy in a temp audit directory with `trust: full`, as their titles say. Every assertion is unchanged.

### Verified (command → output)

From a fresh `git clone` of `integrate/wave1` at `8f187ec` (the last code commit; only this file changes after it), 2026-11-04T01:11Z, Node 22.23.2:

```
npm ci                                     → added 60 packages … found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 42 passed (42) · Tests 467 passed | 1 skipped (468)
npm --prefix examples/providers/gitea ci   → found 0 vulnerabilities
npm --prefix examples/providers/gitea test → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm --prefix examples/ledgers/jira ci      → found 0 vulnerabilities
npm --prefix examples/ledgers/jira test    → ok 1 - the ledger kit: recorded hibernate.atlassian.net changelogs and a synthetic Jira Cloud · # pass 1 · # fail 0
node scripts/demo-plugin-host.mjs          → exit 0, output as in bolt 4's demo (the token reaches only the fake api.github.com)
node scripts/demo-sdk-carry-overs.mjs      → exit 0; N = 0 → 4 (#4191, #4247, #4251, #4253) with bots: [gitlab-bot]; 5 → 1 with direct_push_via_merge: exclude
node scripts/demo-ledgers.mjs              → exit 0; the relabel VERIFIED with check 7 WARN, the deleted issue FAILED check 7
npm ls --prod --depth=0                    → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1
```

- `node dist/cli.js plugin check ./examples/providers/gitea/index.mjs --offline` → `conformance PASS`, now with `pinned-head`, `actor-ids` and `review-granularity` ok through the host (`bot-detection` and `revoked-approval` skip, saying why), exit 0. In the scratch clone, `plugin add ../providers/gitea/index.mjs --yes` on the Codeberg example printed `credentials   GITEA_TOKEN -> codeberg.org (the host of option base_url)` and locked `{ env: GITEA_TOKEN, hosts: [codeberg.org], hostFromOption: base_url }`.
- `npm test` makes no network call: the new tests use fake trackers, fake Gitea and recordings under the network-deny harness.
- **One unexplained failure.** The very first `npm test` in the fresh clone reported 1 failed test; its output was not kept. It did not recur in 18 further full runs (sequential, with vitest's cache cleared, and in a second fresh clone). Two suites run concurrently once failed `timestamps-e2e.test.ts` with `ENOENT … .git/objects` in `cloneScenario` (bolt 1's helper copying a temp git repo), which looks like interference between the two runs. After the fast-forward, `npm test` in the main tree failed one test in 2 of 6 runs, `plugin-host.test.ts › the hostile fixture plugin › this Node (22.23.2) › CAN open a socket: Node 22 and 24 have no network control` (U2b's); it passed alone, in the other 4 runs (467 passed, 1 skipped), and in 6 more runs in the integration worktree. It checks that a loopback server received what the child wrote, which is timing-dependent under load; the Jira-through-the-host test now adds load (67 short-lived children in about 7 s). It is the first suspect for the clean clone's failure too.
- **The hostile-socket flake: cause and fix (after wave 1).** The child's `socket.end(data, cb)` callback fires once its bytes reach the operating system, not once the test's loopback server has run its `data` handler, so the test could read the server's buffer before the bytes arrived. Reproduced deterministically by delaying the server's handler 200 ms: the old assertion fails with `expected '' to be 'exfiltrated'`, the failure seen in the main tree. The assertion now waits for receipt (`vi.waitFor`, 5 s, 10 ms interval); with the same delay it passes on Node 22 and Node 26. The Node 25+ branch still checks that nothing arrived, which needs no wait because the connection is denied. Nothing else changed; 4 further full runs passed (467 passed, 1 skipped).

### For the next units

- **U5 (audit API, MCP).** A read-only context refuses `LedgerContext.index` writes, as it refuses the ledger's own. `pr-rla-mcp` should pass `PR_RLA_PLUGINS`. `ledgerTraits` and `providerTraits` read external plugins without importing isolated ones; use them, not `loadLedgerDefinition` / `loadProviderDefinition`, for anything configured.
- **Still in process:** `scripts/record-fixture.mjs` and `examples/ledgers/jira/scripts/record.mjs` import the plugin they record, as before; they are developer tools, run on code you trust.
- **`selector.bots` does not touch verdict eligibility.** A bot on a user account (U4 finding 3) is stopped only by `verdicts.reviewers`; with `Actor.id`, `id:<n>` entries are the robust form, since they survive a rename.
- **IPC additions within `pr-rla/ipc/v1`** in this integration: `describe` returns `reviewGranularity`, `populationOptions`, `reportsLandedVia` and `provenance`; `create` passes a ledger's `reviewers`; `index` / `indexResult` carry `LedgerContext.index`.

## Ledger, selector and provider fix round

Branch `fix/ledgers-selector`, off master 4b72ecb, 2026-11-04. It fixes findings 3, 4, 5, 6, 7, 9 and 10 of the review of master and every "test that cannot fail" it listed. Findings 1, 2 and 8 (ledger and provider identity in `verify`, the pinned head) are other rounds' and are untouched; so is the identity comparison and the pinned-head logic in `src/core/verify.ts`. Tests: 467 passed + 1 skipped (468) before, 552 passed + 1 skipped (553) after; the one skip is U2b's `UNVERIFIED` RK-02 placeholder, as before.

### Findings, commits and tests

| Finding | Fix | Commit | Regression test |
|---|---|---|---|
| 4 post-merge and self-approvals hide a change | A review is a human decision only if it is APPROVED or CHANGES_REQUESTED by a non-bot account, submitted at or before `mergedAt`, and the reviewer is not the author (`Actor.id` where both have one, else login). The review stays on the record | d5bd0a5 | `selector-review-rules.test.ts` |
| 6 lexical event-id ties | `compareEventIds` / `compareByTimeThenId` (BigInt; colon-separated ids part by part, so Jira's `99:0:add` precedes `100:0:add`), used by the SDK, both issue ledgers, the checkpoint canonical order and the Jira example | c74523d, e4e293f | `ledger-event-ids.test.ts`, `jira-example.test.ts` |
| 3 index unauthenticated | On read the tracker's issue must be the one the index names (id and number), its body must carry the marker for the same window, draw and change, and issue numbers, ids, draws and changes are unique (`indexProblems`). `sample` writes `ledgerIndexSha256` into `draws.json`, each checkpoint line carries it, and `verify` check 7 FAILs a changed or missing index or one that does not match `draws.json`, even offline | a88ddfd, 591a4a4 | `issue-ledger-binding.test.ts`, `e2e-ledger-anchors.test.ts`, `checkpoint-chain.test.ts` |
| 7 case-only label rename | GitHub matches label names case-insensitively; any label event that is not pass, fail or draw warns (once per label per draw); a live label whose name differs from the index warns | a88ddfd | `issue-ledger-binding.test.ts` |
| 5 Jira example | Option ids are learnt from the issue's edit metadata at publish and kept in the index; events match by id; a change to any other option FAILs; the index's field, tracker, option ids and uniqueness and each issue's id are checked on read; numeric ids compare numerically | e4e293f | `jira-example.test.ts` (hardening) |
| 9 checkpoints vanish | `prevLineSha256` chain (old lines stay readable and are counted as unchained); a broken chain FAILs; check 7 WARNs when an issue ledger has no time-stamped checkpoint at or after the last counted verdict, and for a line with no tokens; the union dedupes on the whole line and reading keeps the copy with the most tokens | 591a4a4 | `checkpoint-chain.test.ts`, `e2e-ledger-anchors.test.ts` |
| 10 GraphQL caps | GitHub: labels, a commit's associated PRs (paged) and parents (read to 100, refused beyond); GitLab: `approvedBy` and `reviewers` paged | 9199899 | `provider-caps.test.ts` |
| 10 truncated diffs | `ChangeRecord.changedLinesUnknown`: set for a GitLab diff with a `too_large` or `collapsed` file (only when GraphQL has no `diffStatsSummary`) and for a Bitbucket Data Center truncated diff; `max_changed_lines` keeps it and the funnel adds "of which size unknown (kept in the stratum)" | 9199899 | `provider-caps.test.ts` |
| 10 404 from a token that cannot read | The ledgers probe the audit repo or project; if it is unreadable too, the finding says the token has no access, not "deleted" (GitHub, GitLab, Jira) | a88ddfd, e4e293f | `issue-ledger-binding.test.ts`, `jira-example.test.ts` |
| 10 GitLab "reset approvals" | Notes are read by `systemNoteMetadata.action` (`approved`, `unapproved`, `requested_changes`, `approvals_reset`), the English text only for an untagged note; a tagged reset that names nobody is counted in a diagnostic | 9199899 | `provider-caps.test.ts` |
| 10 `headSha` | `^[0-9a-f]{40,64}$` in `readManifest` and `buildPopulation`; escaped in the GitLab, Bitbucket Cloud and Data Center history URLs | 9199899 | `provider-caps.test.ts` |
| 10 stale-commit approval | Documented as a known semantic limit (README, spec, contracts, `Selector.unreviewed`); behaviour unchanged | 8d7e33a | (none: a documented limit) |
| Tests that cannot fail | See below | 3598dd0 | `conformance.test.ts`, `ledger-conformance.test.ts`, the built-in ledger suites |

The reproductions in the review's `rv.test.ts` that are in scope (the string-id tiebreak and the post-merge self-approval) are the first test of `ledger-event-ids.test.ts` and `selector-review-rules.test.ts`. Run against master's `src/`, 48 of 56 tests in the six new files for findings 3, 4, 6, 7, 9 and 10 fail, and the kit tests fail too (12 of 37 in the two kit files); the 8 that pass on master assert behaviour that was already right (an untouched index verifies, a real deletion still says deleted, and so on).

### The gh-aw Q3 funnel, re-derived

The dry run of 2026-11-03T14:27:18Z recorded the whole listing with every review's `submittedAt` and author, and each change's `mergedAt`, so no live re-run was needed. Running the new selector over that recorded listing at the same freeze time:

| | before (this page, "Real read-only dry run") | after the post-merge/self-review fix |
|---|---|---|
| landed | 3,944 | 3,944 |
| author `copilot-swe-agent[bot]` | 2,947 | 2,947 |
| no recorded human review | 2,717 | **2,718** |
| ≤ 200 changed lines (N) | 1,589 | **1,589** |
| merged by pelikhan, in the no-human-review set | 2,669 | 2,670 |
| bot-approved with no human decision | 985 | 986 |

One PR moved: #51168 (221 lines) had a human APPROVED review 14 minutes after it merged, so N is unchanged. No author-approval case occurs here (the authors are bots). The spec's own counts over the 2,949 search results go 2,719 → 2,720 and 1,590 stays; the two other-branch PRs it counts that pr-rla does not, #47508 and #43457, were read (3 GETs each, 2026-11-04) and carry no human approval before or after merging. The ID-based comparison was not exercised on this data: the recorded dry run kept no `Actor.id`, so the author comparison there was by login. Old numbers are kept above in this file, README and spec were updated, and `spec.md` and the dry-run section have dated notes.

### Settled and decided

- **Where the index hash goes.** `sample` signs and time-stamps nothing, so the hash goes where `sample`'s output is: `draws.json` (optional field, committed with the index, its history the trail) and, so that the authorities' time covers it, each checkpoint line (optional field inside the time-stamped record). It is the SHA-256 of the canonical JSON of the parsed file, so indentation and line endings do not matter. A checkpoint whose index hash differs from the current one only WARNs: publishing more draws later changes the index legitimately. `contracts.md` §5 has the field.
- **`foreignIssues`.** The recorded public timelines are real issues pr-rla did not open: no marker in their bodies, and many other labels. Their hand-built indexes carry `foreignIssues: true`, which skips the marker check and the stray-label warning; `verify` WARNs when an audit's index has it. The six GitHub timelines were re-recorded (2026-11-04, same issues) so the deleted-issue one carries the new repo probe and the others carry the flag; their expectations did not change.
- **Checkpoint chain semantics.** A line must name a line that is earlier in the file, not the line immediately before it, because the git transport's union interleaves two clones' lines. This catches a deleted or edited middle line. It cannot see the newest line (and its history file) being deleted; that is what the coverage WARN is for, and the README says so.
- **GitLab approval resets.** GitLab's own tag was checked three ways on 2026-11-04: its source (`ee/app/services/ee/system_notes/merge_requests_service.rb` gives the reset note `action: 'approvals_reset'`), its GraphQL reference (`Note.systemNoteMetadata.action`), and one anonymous GET of the GraphQL endpoint for gitlab-org/cli !3978, whose notes came back tagged `approved`, `approvals_reset`, and so on. The tag says it is a reset; WHOSE approvals it reset is still read from the `@references` in the body, because GitLab has no structured field for it. That is the remaining limit, stated in `docs/providers/gitlab.md`.
- **Transient write faults.** The fetch broker retries a write only before it is sent and on a rate limit, never after a 5xx. The kit's harness now does the same for `idempotent: false`, and a fault can name "the nth write" and can be "lost" (the write reaches the tracker, the answer is replaced). The ledger kit's `transient-write-faults` check: a 429 on the first write (wait, repeat it), a lost 503 on call 3 (the second write the publish means to make), a recovery on the same tracker that must bring the total to exactly the writes a clean publish makes, and a 429 on a `record`. A factory that serves no fresh tracker for phase `publish-faults` gets a reported skip. github-issues, gitlab-issues and the Jira example (also with every instance in its own plugin host) pass it.
- **`classifyVerdicts` and `recordedBeforeSeed` live in `pr-rla/ledger`.** The architecture test keeps `pr-rla/testing` free of `core/`, so the logic `computeStatus` and check 7 run is now in the SDK, and the kit and the core call the same code.
- **Kit compatibility.** `providerApiVersion` and `ledgerApiVersion` stay 1; the kits' third parameter (`skipCases`) is new and optional. Plugin authors' existing fixtures can now fail where they used to pass vacuously: `window-and-kinds` needs `ids` (or pullRequests and directPushes), and the ledger kit needs a fixture per case. `docs/writing-a-provider.md` §3 and §8 say so. The Gitea and Jira examples pass.

### Deviations and declined items

- **The recorded GraphQL fixtures were not re-recorded.** The new GitHub and GitLab queries select more fields, so their request hashes changed. GraphQL queries are POSTs and this round's live reads were GET-only. The four fixtures (`github/gh-aw-2026-11-02`, three GitLab) keep their recorded responses and have only their `bodySha256` updated to the new query, with a `graphqlQueryNote` in each file; the responses lack the new fields, which the providers read as "no tag, nothing more to page". Checked instead: all seven GitHub queries validate against GitHub's published schema (`docs.github.com/public/fpt/schema.docs.graphql`, fetched 2026-11-04, validated with graphql-js in the scratch directory), and the GitLab MR batch query ran once as an anonymous GET against gitlab.com and returned the new fields. Not run live: the GitHub queries themselves (POSTs), and the Jira `editmeta` route (it needs a token that may edit issues; the fake follows Atlassian's documented shape).
- **`no-double-counting` stays a real check.** It inspects the returned data (duplicate ids, a commit counted twice), so it needs no expectation and always runs; the kit's other expectation-driven checks skip.
- **A manifest with a bad `headSha` aborts `verify`.** `readManifest` throws a `CommandError` instead of letting check 2 FAIL, so `verify` stops with the reason rather than printing a report. The pinned-head logic in check 5 is untouched.
- **Event-id order and `eventsSha256`.** The checkpoint's canonical list now sorts same-instant events by the new id order. A checkpoint of a history with same-second events whose numeric ids differ in digit count would hash differently under the old order; no checkpoint exists outside test fixtures, and none of them has such events.
- **Selector semantics changed under a registered selector.** A manifest frozen before this round and verified after it can rebuild a different population if a post-merge or author approval existed. gh-aw's was one PR outside N. The registration's selector text is unchanged, and this is recorded here and in the spec rather than versioned.

### Live reads (all GET, all read-only, 2026-11-04; about 150 requests, no POST sent)

- `gh api` GETs of PRs #47508, #43457 and #51168 and their reviews (6).
- The six GitHub ledger timelines re-recorded twice and the deleted-issue one once more (about 110, anonymous GitHub REST with `gh auth token`), the Jira recorder for the two hibernate timelines (about 12).
- GitLab: raw files from gitlab.com (`system_note_metadata.rb`, the EE system-note service files, the GraphQL reference, the MR API doc, the diff entity: about 10), and two GETs of `/api/graphql?query=` (the MR batch query on gitlab-org/cli !3000, the notes of !3978).
- GitHub's public GraphQL schema file (1); `npm install graphql` into the scratch directory.

### Files touched that other rounds are also in

`src/commands/{checkpoint,context,sample,verify}.ts` (U5: a handful of lines each: the index hash and chain tip passed to the checkpoint, `readManifest` validation, the hash written after `sample` publishes, the index and unchained count read into `verify`); `src/api/checkpoint.ts` (U5: `checkpointChainTip`, the extra record fields, `readCheckpoints` returns `unchained`); `src/core/verify.ts` (U8/U9: an `addAnchor` helper, one call before check 7's summary for the index and the checkpoint coverage, the same index call in the skip branch, `lastCountedAt` captured where the counted verdicts are known, and `recordedBeforeSeed` replacing one inline comparison; nothing in the ledger-identity or pinned-head code); `src/providers/github/{index,queries,normalize}.ts` (U8: `http.ts` untouched; `index.ts` gains `completeCommit` and the label paging); `src/testing/conformance.ts` (U8: the empty-fixtures and skip rules, the completeness rule, `Fault.write`/`lost`, `idempotent: false` in the harness); `README.md` (limitations and kit lines). Not touched: `src/ledgers/git-file.ts`, `src/config.ts`, `package.json`.

### Verified (command → output)

From a fresh `git clone -b fix/ledgers-selector` at `8bb807e` (the last commit before this section; only this file changes after it), three runs in a row, 2026-11-04T04:18–04:19Z, Node 22 (`node --version` v22.x on PATH):

```
npm ci                                     → found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 48 passed (48) · Tests 552 passed | 1 skipped (553)
npm --prefix examples/providers/gitea ci   → found 0 vulnerabilities
npm --prefix examples/providers/gitea test → # pass 1 · # fail 0
npm --prefix examples/ledgers/jira ci      → found 0 vulnerabilities
npm --prefix examples/ledgers/jira test    → # pass 1 · # fail 0
```

Each of the three runs printed the same lines. `node scripts/demo-ledgers.mjs`, `demo-sdk-carry-overs.mjs`, `demo-plugin-host.mjs` and `demo-broker.mjs` exit 0; the ledger demo's second part now shows the recorded relabel VERIFIED with check 7 WARN (the foreignIssues flag and the missing checkpoint) and the deleted issue FAILED, as before. `npm test` makes no network call. Not verified: see "Deviations and declined items" (the GitHub GraphQL queries and the Jira `editmeta` route were not run live).

## Trusted-time fix round A (2026-11-04)

Branch `fix/trusted-time`, off master `4b72ecb`. It fixes findings 1, 3, 4, 5 and 8 of the independent review of master `4b72ecb` (trusted time, seed, sampling, SPRT, verify checks 1–4 and 6), plus the related test gaps. Findings 2 (draw derivation), 6 (verify's verdict and exit), 7 (the population minimum) and 9 (small verify items) are the next round; `src/core/seed.ts`, the draw derivation and verify's verdict and exit logic are untouched.

### Findings fixed

| # | Commit | What was wrong | What changed | Regression tests |
|---|---|---|---|---|
| 1 (critical) | `0f7049c` | pkijs chose the signature certificate by the `sid` (a SubjectKeyIdentifier could name an attacker's twin certificate) while ESSCertID and the chain were judged on the first certificate with the signer's issuer and serial (the real one, copied from any public token). Anyone could forge a token from any of the eight authorities | pr-rla resolves the signer itself (RFC 5652 §5.3, either `sid` form) and refuses a token when no certificate or more than one matches the `sid`, when two certificates carry the signer's issuer and serial, or when pkijs checked the signature with another certificate or a key that is not byte-equal. ESSCertID, the EKU check and the chain use that one certificate | `timestamp-signer-identity.test.ts` (45), `timestamp-openssl-differential.test.ts` (5) |
| 4 | `21b5f40` | `effectiveTime` asked whether the unsigned envelope had `timestamps`: dropping it from a v2 record handed the time, and R, to the log's integratedTime | keyed on `record.schema`: a v2 registration or commitment always uses its signed time. A v2 envelope without `timestamps` FAILs check 1 (registration) or check 2 (commitment) | `timestamp-verify.test.ts › FR1.4` (rewritten so it can fail), `timestamps-e2e.test.ts › review finding 4` (2) |
| 5 | `abe689a` | any accepted token counted toward k, also from an authority the registration does not name | only `timestamping.authorities` count; others print `ignored (not registered)` and are never a FAIL | `timestamp-verify.test.ts › review finding 5`, `timestamps-e2e.test.ts › review finding 5` |
| 3 | `cdeba43` | verify took the log key from the audit repo's `transparency_log.public_key_file`, or fetched it from the URL in the unsigned envelope, and counted the entry as operator Sigstore: a self-run log was a second operator, and a v1 record's whole time evidence | log keys come only from `src/translog/keys.ts` (Sigstore's production Rekor v1 and v2 logs) or `verify --log-key`; an entry under any other key is unverified, gives no time evidence and is no operator. `status` uses the same keys. The e2e scenario keeps the mock log's key outside the audit repo; the v1 fixture's verifier copy is `test/fixtures/log-keys/` | `translog-keys.test.ts` (7), `v1-compat.test.ts` (the 7/7 test now passes `--log-key`; a new test shows `time unproven` without it; status), `e2e.test.ts`, `rekor-v2.test.ts`, `net-io.test.ts` |
| 8 | `07ce083` | DigiCert and GlobalSign pinned at general-purpose roots; intermediates' basicConstraints, path length, keyUsage and EKU unchecked; nothing printed Microsoft's TOFU anchor (NFR4) | intermediates must be CAs (critical `cA`, `keyCertSign`, path length honoured, an EKU that allows timestamping); the anchor's own path length is honoured. The bundle pins the TSA issuing CA under each general-purpose root (DigiCert, GlobalSign, SwissSign, GitHub) and only a signer issued directly by it counts. `register`/`freeze`, `verify` and `status` print each counted authority's anchor kind and independence | `timestamp-trust-bundle.test.ts` (21) |

The anchor lines, as `register` prints them for the four defaults (replayed from the 2026-11-03 recording):

```
  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN
    sigstore: anchor confirmed independently (root sigstore-tsa-selfsigned, independent: true)
    digicert: anchor confirmed independently (root DigiCert Trusted Root G4, independent: true) · TSA issuing CA pinned (DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1)
    globalsign: anchor confirmed independently (root GlobalSign, independent: true) · TSA issuing CA pinned (GlobalSign Offline R45 Timestamping CA 2025)
    microsoft: anchor pinned on first use (intermediate Microsoft Public RSA Timestamping CA 2020, independent: false)
```

`verify` prints the same lines in the details of checks 1 and 2 (`registration microsoft: anchor pinned on first use …`), and `status` prints one `  timestamp anchors: …` line under its status line.

### Before and after

- **This round's tests on the old code.** Copied into a scratch clone at `4b72ecb`, nine test files: 65 of the 170 tests in the eight that load fail, every in-scope regression among them (the passing ones are guards, such as "a consistent SubjectKeyIdentifier `sid` is accepted"). The ninth, `translog-keys.test.ts`, cannot load there (`src/translog/keys.ts` is new); its five behavioural tests, run without the key-module import, all fail on `4b72ecb` (`logPublicKey` returned the audit repo's key; the self-run log made k = 2 PROVEN; status said tamper-proof; an entry claiming Sigstore's URL PASSed under the audit repo's key).
- **The review's own reproductions** (`rvtime-forge`, `-e2e`, `-log`, `-dropts`, `-unlisted`: 22 assertions, each asserting the vulnerable behaviour): 22 of 22 pass on `4b72ecb`, 0 of 22 on this branch. The forged audit now ends `FAILED: check 1 (registration), check 2 (manifest before seed)`, exit 1, instead of `CERTIFIED (risk 5%) · PROSPECTIVE … VERIFIED`, exit 0.
- **All eight recorded tokens still verify**, with the same chains, and `openssl ts -verify` still accepts all eight.

### The negative differential against `openssl ts -verify`

OpenSSL 3.6.4, local, offline. The corpus is ten signer-identity mutations of each authority's recorded token (80 tokens):

- four attacker-signed forgeries with a twin of the real signer certificate: the review's attack (SubjectKeyIdentifier `sid`); a twin named by issuer and serial placed first, with ESSCertID naming the real certificate or the twin; and the twin placed last;
- six edits of the real token's unsigned certificate set: a twin inserted before the signer, a twin appended after it, the signer carried twice, removed, replaced by another authority's signer, and replaced by its twin.

OpenSSL rejects 64: the SKI forgery as undecodable (`PKCS7_ISSUER_AND_SERIAL`), the others on the signature, the certificate verify or `signer certificate not found`. It accepts 16: the appended twin and the duplicate signer. **pr-rla rejects all 80**, so every token OpenSSL rejects, pr-rla rejects too. The one recorded divergence: OpenSSL cannot decode a SubjectKeyIdentifier `sid` at all, and pr-rla accepts a consistent one (RFC 5652 allows it). None of the eight authorities uses that form; all identify the signer by issuer and serial.

### NFR7: what this does to v1 audits

A v1 record's only time evidence is its Rekor v1 entry. It is evidence only if the entry verifies under a key the verifier trusts: one pinned in the package (Sigstore's production Rekor) or passed with `--log-key`.

- **No v1 audit has ever been logged to a real log** (BUILD-NOTES, phase 1), so every existing v1 audit was logged to a mock or self-run log. Each one now:
  - verifies 7/7 PASS only when the verifier passes that log's key with `--log-key`;
  - without it, verifies with checks 1 and 2 WARN, `registration after window close → RETROSPECTIVE (a demonstration) (time unproven: no transparency-log entry verified under a trusted key)`, `manifest logged (unverified) …` and `TIMESTAMP NOT TAMPER-PROOF`;
  - shows `· TIMESTAMP NOT TAMPER-PROOF` in `status`, which takes no `--log-key`.
- R is still derived from the logged integratedTime, as the v1 contract says, so every verifier computes the same R; the output says it rests on an unproven time.
- Verify still prints VERIFIED and exits 0 in that case. Whether an unproven record may certify is finding 6, the next round.
- The v1 fixture keeps its `rekor.pub` and `public_key_file` (a phase-2 audit repo looked like that, and verify must ignore them). `v1-compat.test.ts` verifies it 7/7 with the verifier's copy in `test/fixtures/log-keys/`, and shows the unproven output without it. NFR7 ("v1 records verify 7/7 after this round") therefore holds with the log's key passed as `--log-key`.

### Still trust on first use (for the founder's release checklist)

| Authority | Default | Anchor | Why it is TOFU |
|---|---|---|---|
| Microsoft | **on** | the intermediate Microsoft Public RSA Timestamping CA 2020 | its tokens omit the root (Microsoft Identity Verification Root Certificate Authority 2020), and no local store has it |
| SwissSign | off | SwissSign Signature Services Root 2020 - 2 | not in a local root store |
| FreeTSA | off | its root (www.freetsa.org) | not in a local root store |

Each must be confirmed from a second source before release (`scripts/update-trust-bundle.mjs --anchors <file>#<label>`). Until then every output that counts one prints `anchor pinned on first use … independent: false`.

### Settled or recorded, with dates

- **The four pinned TSA issuing CAs** (2026-11-04, offline). They came from the recorded responses of 2026-11-03 (DigiCert, GlobalSign, SwissSign) and from gh's TUF cache of tuf-repo.github.com, fetched 2026-10-20 (GitHub), via `update-trust-bundle.mjs --recorded … --trusted-root … --write`. The bundle diff is exactly those four `issuingCAs` entries, each already a bundled intermediate. They constrain which certificates count; they add no trust, because the chain must still reach the pinned anchor.
- **Why only four.** Sigstore's, Microsoft's, Sectigo's and FreeTSA's anchors are already specific to timestamping. GitHub's Internal Services Root also issues Fulcio's code-signing CAs (its TUF `certificateAuthorities`), so its TSA intermediate is pinned.
- **The pinned Rekor keys** (2026-11-04). Read from local TUF copies: npm 11.19.1's `@sigstore/tuf` 4.0.2 `seeds.json` (both logs), npm 10.9.8's `@sigstore/tuf` 3.1.1 (the v1 log), and gh's TUF cache of tuf-repo-cdn.sigstore.dev, fetched 2026-10-20 (both). The three copies agree. This round ran no TUF client; those files were verified by npm's and gh's TUF clients when they were fetched.
  - `https://rekor.sigstore.dev` (v1, ECDSA P-256): logID `c0d23d6a…` = SHA-256 of the DER key.
  - `https://log2025-1.rekor.sigstore.dev` (v2, Ed25519): TUF's logId `cf119915…` = SHA-256(`log2025-1.rekor.sigstore.dev` ‖ `\n` ‖ 0x01 ‖ key). That matches pr-rla's C2SP checkpoint key-id derivation (bolt 1's deviation 6 called it unverified), confirmed offline; the 4-byte checkpoint key id is `cf119915`.
- **No live request in this round:** no timestamp authority, no Rekor host, no drand. `npm ci` read the npm registry.
- **Node's `X509Certificate.checkIssued`** (OpenSSL's `X509_check_issued`) already refuses an issuer whose keyUsage lacks `keyCertSign`, so that chain never forms. It accepts an issuer with no keyUsage at all; pr-rla's own check refuses that one.

### Deviations from the brief, and decisions

1. **SubjectKeyIdentifier `sid`s stay accepted when consistent** (the brief: "either form"); OpenSSL refuses them all. The strictest reading kept: exactly one certificate may match (by its SKI extension or by the SHA-1 of its key, the way pkijs resolves it), and its issuer and serial must be unique in the token.
2. **An identical duplicate of the signer certificate is refused**, as "more than one certificate carries the signer's issuer and serial". OpenSSL accepts it.
3. **A certificate-set entry that is not an X.509 certificate** fails the token (rule 4). Before, it could make `checkToken` throw.
4. **An unregistered authority's token is ignored even when it breaks rules 1–7**: it is not evidence, so it is not a FAIL. Tamper fixture 4 (an expired signer) used such a token; it now mints the expired signer under test-b's own root (`makeTestAuthority({ under })`), so it still FAILs on rule 6.
5. **A verified log entry still counts as operator Sigstore**, also under `--log-key`: a log adds at most one operator.
6. **`transparency_log.public_key_file` is still read by `--submit --rekor-api v2`**, to check the log's response at submission (the submitter's own check, unchanged; the config template comment says so). Verify and status never read it. `--submit` on v1 still checks its response with that log's `/publicKey`; neither path feeds evidence.
7. **`logPublicKey` keeps its signature** (`config` and `offline` are now unused), so U5's moved copy takes the same one-line body.
8. **`status` gained no `--log-key`**, to keep the CLI edits to one help string. Its v1 tamper-proof check now also requires the commitment's log entry to verify, as v2 already did.
9. **Issuing CAs are pinned by certificate SHA-256**, and the constraint applies to the signer's direct issuer. A rotation of an operator's issuing CA needs a bundle update (the NFR21 release diff); issuing CAs are only added, so old tokens keep verifying.
10. **Anchors are trust inputs** (RFC 5280 §6.1): only their path length is enforced, not keyUsage or criticality. FreeTSA's root, for one, has non-critical basicConstraints.
11. **A v2 envelope without `timestamps` is a FAIL in verify**, not a thrown error, so verify can report it.
12. **The differential test's `beforeAll`** forges or rebuilds 80 tokens and runs OpenSSL on each, so it has a 180 s hook timeout; vitest's 10 s default was too tight under a loaded parallel run.

### Tests

467 passed, 1 skipped (468) → **550 passed, 1 skipped (551)**: 83 new. The new files are `timestamp-signer-identity` (45), `timestamp-trust-bundle` (21), `translog-keys` (7) and `timestamp-openssl-differential` (5). Existing files gained tests: `timestamps-e2e` +3, `timestamp-verify` +1 (FR1.4 was rewritten in place), `v1-compat` +1. The skipped test is U2b's RK-02 Node 25 test, as before. The new helper `test/helpers/forge-tsa.ts` makes synthetic forgeries from the recorded certificates. `test-tsa.ts` gained `sidSki`, `extraCerts`, `under` and `rootKey`.

### Verified (command → output)

From fresh `git clone`s of `fix/trusted-time` at `07ce083` (the last code commit; only docs change after it), 2026-11-04T04:32Z to 04:39Z, Node 22.23.2, OpenSSL 3.6.4:

```
npm ci                                     → found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 46 passed (46) · Tests 550 passed | 1 skipped (551)
npm --prefix examples/providers/gitea ci   → found 0 vulnerabilities
npm --prefix examples/providers/gitea test → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm --prefix examples/ledgers/jira ci      → found 0 vulnerabilities
npm --prefix examples/ledgers/jira test    → ok 1 - the ledger kit: recorded hibernate.atlassian.net changelogs and a synthetic Jira Cloud · # pass 1 · # fail 0
npm ls --prod --depth=0                    → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1
```

- **Every run was a fresh clone running the whole command**, 16 at this branch (4 at `07ce083`, 12 at the docs commit) and 8 at `4b72ecb` for comparison. The last three runs at the docs commit, and runs 2–4 at `07ce083`, were green in a row.
- **Two load-dependent tests from other units fail at times, at `4b72ecb` as well.** Other agents' suites ran on this machine throughout (load averages 18–98 on 10 cores; a quiet `npm test` takes 24 s, these took 45–72 s).
  - U2b's `plugin-host.test.ts › a slow call that keeps sending heartbeats is not stopped` (`plugin hostile sent no heartbeat for 1 s and was stopped`).
  - Wave 1's `wave1-integration.test.ts › the Jira example passes the ledger conformance kit with every instance in its own plugin host` (the 60 s test timeout).
  - Failing runs: 5 of 16 on this branch (heartbeat 4, Jira host 2) and 3 of 8 at `4b72ecb` (heartbeat 3, Jira host 1). The failures are the same, at a similar rate, without this round's code.
- **The heartbeat test's cause.** The host's watchdog is armed from spawn, so the test's 500 ms limit also covers the child's start-up (Node with `--permission`, loading the TypeScript child). A cold or loaded start exceeds it.
  - In this worktree under `~/Documents`, that test run alone fails 3 of 3. In `/private/tmp` clones, at `4b72ecb` and this branch alike, it passes 3 of 3 alone.
  - It is probably the unexplained first-run failure the wave-1 integration recorded.
- **Both are left alone here**, since `fix/ledgers-selector` touches the plugin host files. A start-up allowance in the host's watchdog, and a longer timeout for the 67-child Jira test, would settle them. This round's four new test files add about 16 s of CPU to the suite (U2b's `plugin-host.test.ts` alone takes 8 s).
- `npm test` makes no network call: OpenSSL runs locally, and every log, authority and beacon is a mock or a recording under the network-deny harness.

### Unverified

- The pinned Rekor keys against a live log (D3: no Rekor contact at all). The v2 key-id derivation is confirmed only against TUF's logId.
- An issuing-CA rotation by DigiCert, GlobalSign, SwissSign or GitHub: a token under a new issuing CA fails until the bundle carries it.
- The OpenSSL differential on Linux or another OpenSSL version. It is skipped where `openssl ts` is missing, and the divergence test expects OpenSSL 3.6's `PKCS7_ISSUER_AND_SERIAL` decode error.
- The three TOFU anchors, against an independent source.
- Whether any real authority issues SubjectKeyIdentifier-`sid` tokens: none of the eight does.

### For the integration step

- **U5 moved `logPublicKey` to `src/api/translog.ts`.** Its body must become `return trustedLogKey(logUrl, flag ? readFileSync(resolve(ctx.cwd, flag), "utf8") : null);`, or finding 3 reopens.
  - U5's `src/api/timestamps.ts` needs `logBound` exported (status's v1 branch uses it) and the anchor lines in `reportTimestamps`.
  - U5's status (`timeStanding`) needs the v1 log check and the `anchors` line.
  - U5's `session.ts` still confines `transparency_log.public_key_file`, which is harmless: `--submit --rekor-api v2` reads it.
- **`src/core/verify.ts`** (U8 and U9 edit it too). This round's hunks are in `checkLog` (three messages), `checkTimestamps` (the ignored and anchor lines), check 1 (the absent-`timestamps` FAIL and v1's `time unproven` summary) and check 2 (the absent-`timestamps` line and `logged (unverified)`).
- **`src/core/records.ts`** (U8): `isSignedV2` and `effectiveTime` only.
- **`src/cli.ts`**: the `--log-key` help string. **`src/config.ts`**: the template comment. Also README and `docs/security-model.md` (a new trusted-time section).
- **Test helpers.**
  - `audit-scenario.ts` no longer writes `rekor.pub` or `public_key_file` into the audit repo. A test that needs a mock-logged entry verified passes `logKey: s.logKeyFile`.
  - `TestAuthority` has a new `rootKey` field, so a hand-built `TestAuthority` literal elsewhere needs it.
  - A test elsewhere that relies on a token from an unregistered authority counting toward k, or on verify trusting an audit-repo log key, will now fail by design.

## Bolt 10 (U9): presence-attested verdicts (2026-11-04)

Goal (delivery-plan.md, bolt 10): git-file verdict commits signed with `git commit -S` in the SSH format; SSHSIG verified in TypeScript, including the `-sk` signed-data layout and the user-presence (UP) flag; allowed signers fixed in the registration; provenance per line with reviewers matched to principals; `require_signed`; `minProvenance` enforced in check 7 with FR3.8's defaults; issue ledgers topping out at `account`; software keys only (D7); and no doc or certificate claiming hardware-verified presence.

Built on branch `bolt/u9-presence-verdicts` from master at `a360348`, in parallel with U5 (audit API, MCP) and U8 (org-pooled freeze).

### Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR3.8 every verdict reports its provenance; default minimum `account` with an issue ledger, `self-asserted` with git-file; printed on every certificate | met | `presence-verifier.test.ts › FR3.8: the default minimum…`; `e2e-presence.test.ts › a git-file audit with no keys prints VERDICT PROVENANCE: self-asserted, the registered default`; the issue-ledger side is U4's `e2e-github-issues.test.ts › FR3.8`, unchanged |
| FR9.1 `require_signed` makes every verdict commit carry an SSH signature; an unsigned verdict commit fails check 7 | met | `e2e-presence.test.ts › FR9.1: an unsigned verdict commit fails under require_signed` and `› a verdict recorded but never committed fails under require_signed`; `presence-fixtures.test.ts › FR9.5 (4)`; the real path, `› git commit -S with an ssh-keygen software key (FR9.1)` |
| FR9.2 SSHSIG verified in TypeScript over node:crypto for ed25519, ed25519-sk and ecdsa-sk, with the UP flag checked by pr-rla; outcomes cross-checked against `ssh-keygen -Y verify` | met | `presence-verifier.test.ts › SSHSIG verification in TypeScript (FR9.2)` (every key type, tampering, flags and counter); `presence-oracle.test.ts` (25 cases against `-Y verify` and `-Y check-novalidate -vv`, `git verify-commit`, the recorded sk-dummy commits) |
| FR9.3 the registration lists the reviewers whose signatures count, as an allowed-signers list; a verdict signed by a key not on the list fails | met (interpretation: deviation 4) | `presence-verifier.test.ts › allowed signers (FR9.3)`; `presence-fixtures.test.ts › FR9.5 (3)`; `e2e-presence.test.ts › FR9.3: a verdict signed by an unlisted key fails` |
| FR9.4 check 7 enforces `minProvenance` | met | `presence-verifier.test.ts › FR9.4: a verdict below the registered minimum fails…`; `e2e-presence.test.ts › FR9.5: a verdict whose security-key signature has UP clear fails at presence` |
| FR9.5 four fixtures: `-sk` UP set passes at presence, UP clear fails at presence, unlisted signer fails, unsigned under `require_signed` fails; software keys only | met | `presence-fixtures.test.ts › FR9.5 (1)`–`(4)` on commits made by ssh-keygen and OpenSSH's sk-dummy; the same four end to end in `e2e-presence.test.ts` with the test-time emulated authenticator |
| FR9.6 no doc or certificate claims hardware-verified presence; `presence (user-presence flag verified; key hardware not attested)` | met | `presence-wording.test.ts` (every Markdown and source file, sentence by sentence; the certificate strings); the e2e status and verify output |
| NFR4 the weakened guarantee prints its line | met | the T16 line (`PRESENCE_LIMIT`) on register, status and verify whenever presence is registered or counted: `e2e-presence.test.ts › register fixes…`, `› status…`, `› the demo…` |
| NFR11 `npm test` makes no network call | met | local git, ssh-keygen and node:crypto only, under the network-deny harness |
| NFR23 the presence wording, text-checked | met | `presence-wording.test.ts` |
| Reviewer/principal mismatch reported; decreasing counter a WARN | met | `presence-fixtures.test.ts › a reviewer/principal mismatch…`; `e2e-presence.test.ts › a decreasing counter is a WARN, never a FAIL`; `presence-verifier.test.ts › analyzeSignedVerdicts…` |
| Issue ledgers top out at `account` | met | `e2e-presence.test.ts › issue ledgers top out at account: presence, or SSH keys, with github-issues`, `› issue ledgers top out at account; git-file reaches presence…`, `› check 7 counts a ledger's claim above its ceiling at the ceiling, and WARNs` |
| PresenceVerifier in `src/core/presence/`, pure; the boundary test extended | met | `registry.test.ts › PresenceVerifier (src/core/presence) is pure…` (imports and their transitive closure); the core boundary tests now walk subdirectories |
| `ssh-keygen -Y verify` presence-flag finding recorded | met | it does not enforce UP and has no option to (Findings, below); `presence-oracle.test.ts › FINDING: …` |
| Demo: a software `-sk` fixture with UP set passes at presence, and one with UP clear fails | met | `node scripts/demo-presence.mjs` (below) |

### Done

| Piece | Where |
|---|---|
| SSH wire format, public keys (fingerprints as ssh-keygen prints them), SSHSIG parse and verify, the FIDO signed data and flags | `src/core/presence/{wire,keys,sshsig}.ts` |
| Allowed-signers entries (pr-rla's narrower form), OpenSSH pattern lists for `namespaces` | `src/core/presence/allowed-signers.ts` |
| A commit split into payload and signature as git does it (`gpgsig`, `gpgsig-sha256`) | `src/core/presence/commit.ts` |
| PresenceVerifier: a commit's signature state, a line's provenance, the analysis of a whole ledger file (mismatches, counters, notes) | `src/core/presence/verifier.ts` |
| The rules (`verdictRuleFailures`), the ceiling cap, the wording and the T16 line; the verdict rules a registration fixes | `src/core/presence/{provenance,registration}.ts` |
| git-file: line → commit through `git blame`, commits through one `cat-file --batch`, each checked to hash to its name; `require_signed` option; WARNs and notes in `verifyIntegrity` | `src/ledgers/git-file.ts` |
| SDK: `VerdictProvenance.keyFingerprint` and `.counter` (optional, `ledgerApiVersion` 1); `verdictIneligibility` reads an allowed-signers entry's principals | `src/sdk/ledger.ts` |
| `LedgerTraits.maxProvenance`, `SIGNATURE_LEDGERS`, `maxProvenanceOf` | `src/ledger-traits.ts` |
| Check 7: the rules, the cap (`VerifyDeps.provenanceCeiling`), the wording; check 1 prints the registered rules | `src/core/verify.ts`, `src/core/status.ts` |
| Config validation of key lines; register's rules and output; status, verify and record (thin) | `src/config.ts`, `src/commands/{register,status,verify,record}.ts` |
| Library exports of the verifier | `src/index.ts` |
| Fixture maker (real OpenSSH tooling) and the fixture; the demo | `scripts/make-presence-fixtures.mjs`, `test/fixtures/presence/sk-dummy-verdicts.json`, `scripts/demo-presence.mjs` |
| Test helpers: a software SSHSIG signer and emulated authenticator; signed commits without ssh-keygen | `test/helpers/sshsig-signer.ts`, `test/helpers/signed-commits.ts` |
| Tests: 111 new | `presence-verifier` 33, `presence-oracle` 30 (one skipped: the UNVERIFIED placeholder for a machine without ssh-keygen), `e2e-presence` 20, `presence-fixtures` 12, `git-file-presence` 11, `presence-wording` 4, `registry` 1 |
| Docs | README (git-file provenance, "Signed verdicts (git-file)", a limitation), `docs/security-model.md` ("Verdict provenance and presence (T7, T16)") |

### Making `-sk` signatures without hardware: both paths, and why

1. **OpenSSH's sk-dummy, confirmed at build.** The design's candidate works on this machine. OpenSSH 10.3p1 portable was downloaded read-only (below), configured against Homebrew's openssl@3 and built in the session's scratch directory only (`make openbsd-compat/libopenbsd-compat.a regress/misc/sk-dummy/sk-dummy.so`; nothing installed, nothing in the repo). macOS's own `ssh-keygen` (OpenSSH_10.3p1, LibreSSL 3.3.6) has FIDO support compiled in and loads a middleware given through `SSH_SK_PROVIDER`; its `/usr/libexec/ssh-sk-helper` runs with the hardened runtime but carries `com.apple.private.security.clear-library-validation`, so the linker-signed sk-dummy dylib loaded. It enrolled `ed25519-sk` and `ecdsa-sk` keys, signed with UP set, and with UP clear for keys made with `-O no-touch-required` (sk-dummy echoes the requested flags; its counter is the constant 0x12345678). `scripts/make-presence-fixtures.mjs` drives it: ten keys in a temp directory (never `~/.ssh`), git with no global or system configuration, twelve `git commit -S` verdict commits, and at recording time git's own `verify-commit` and `ssh-keygen -vv -Y check-novalidate` for each. The fixture keeps public keys, file contents, trees and raw commit objects; the tests rebuild it to the same SHAs with plain git plumbing, so no test needs sk-dummy.
2. **A software-emulated authenticator in TypeScript, for test time.** `test/helpers/sshsig-signer.ts` signs exactly what an authenticator signs (PROTOCOL.u2f) with a node:crypto key, so a test chooses the flags and the counter. It makes the end-to-end audits (the commits depend on each run's draws) and what sk-dummy cannot: a decreasing counter, UV, arbitrary flags. It is written apart from the verifier so a layout mistake would not hide in both, and `presence-oracle.test.ts` cross-checks its output against `ssh-keygen`.

Both paths are software (D7). Neither proves anything about hardware, which is the point of T16.

### Live and local work (read-only; dated)

- 2026-11-04T01:43:49Z: `GET https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-10.3p1.tar.gz` and its `.asc` (public, read-only). SHA-256 `56682a36bb92dcf4b4f016fd8ec8e74059b79a8de25c15d670d731e7d18e45f4`, recorded in the fixture. The PGP signature was not checked (no OpenSSH release key on the machine); the build is a test tool, and every signature it made is checked by the system's own ssh-keygen.
- 2026-11-04T02:08:02Z: the fixture was made (`test/fixtures/presence/sk-dummy-verdicts.json`, `"source": "synthetic"`), on macOS (Darwin 25.6.0, arm64), git 2.55.0.
- Nothing else left the machine: no key was written to `~/.ssh`, no hardware key was touched, nothing was pushed or written anywhere.

### Verified (command → output)

From a fresh `git clone` of the branch at `3dbc93f` (the last code commit; only this file changes after it), 2026-11-04T02:49:07Z, Node 22.23.2:

```
npm ci                                     → added 60 packages … found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 48 passed (48) · Tests 577 passed | 2 skipped (579)
npm --prefix examples/providers/gitea ci   → found 0 vulnerabilities
npm --prefix examples/providers/gitea test → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm --prefix examples/ledgers/jira ci      → found 0 vulnerabilities
npm --prefix examples/ledgers/jira test    → ok 1 - the ledger kit: recorded hibernate.atlassian.net changelogs and a synthetic Jira Cloud · # pass 1 · # fail 0
npm test, again with both examples installed → Test Files 48 passed (48) · Tests 577 passed | 2 skipped (579)
node scripts/demo-presence.mjs             → exit 0 (below)
node scripts/demo-{broker,ledgers,plugin-host,sdk-carry-overs}.mjs → exit 0
npm ls --prod --depth=0                    → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1
```

- 579 = 468 before (467 passed, 1 skipped) + 111 new. The second skipped test is the oracle's `UNVERIFIED` placeholder, skipped because ssh-keygen is installed.
- The U9 test files also pass on Node 26.8.2 and 24.20.0 (116 passed, 1 skipped each).
- Every code commit of the bolt was checked in a scratch clone: typecheck clean and the suite passing at each (501, 552, 572, 576, then 577 passed).
- No LICENSE file; `"private": true, "license": "UNLICENSED"`. No dependency added.

**The demo** (`node scripts/demo-presence.mjs`, offline, on the sk-dummy fixture; abridged):

```
draw #2  reviewer bob     an ed25519-sk key, UP set
         → presence (user-presence flag verified; key hardware not attested) · ssh-keygen -Y verify -I bob: Good
         → check 7 under min_provenance presence + require_signed: PASS
draw #4  reviewer dave    an ed25519-sk key made with no-touch-required: UP clear
         → account · ssh-keygen -Y verify -I dave: Good
         → check 7 under min_provenance presence + require_signed: FAIL: verdict on draw #4 (json:acme/widgets#104) is account; the registration requires presence
draw #6  reviewer mallory signed by a key nobody registered
         → self-asserted · ssh-keygen -Y verify -I mallory: refused
         → check 7 …: FAIL: … is self-asserted; the registration requires presence; … was added in commit 59a19dca98, which its registered reviewer did not sign; the registration requires signed verdict commits (require_signed)
draw #7  reviewer alice   an unsigned commit
         → self-asserted
         → check 7 …: FAIL: … is self-asserted …; … was added in commit 3e5bcef72e, which its registered reviewer did not sign …
draw #8  reviewer alice   names alice but bob signed it
         → self-asserted · ssh-keygen -Y verify -I alice: refused
integrity: WARN
  WARN verdict on draw #8 names reviewer alice but commit 5089dd43a3 was signed by bob: self-asserted
  WARN commit 59a19dca98 (draw #6): signed by key SHA256:hlcWUEWN1hZ9u3OaFQNEQO0u6DSjfUJVicjp7K2klA8 (ssh-ed25519), which no registered reviewer holds: self-asserted
  commit 4e62d9033a (draw #4): signed by dave's sk-ssh-ed25519@openssh.com key SHA256:9qr9+XMx1YB6LDWrBGHn4Hdk5zdVhn/nIZNu6jbpP90 without the user-presence flag (no touch): account, not presence
  commit 3e5bcef72e (draw #7): not signed: self-asserted

VERDICT PROVENANCE: self-asserted (3) · account (7) · presence (user-presence flag verified; key hardware not attested) (2)
presence relies on each reviewer having registered a hardware-backed security key, which pr-rla does not check: a software-emulated authenticator can set the user-presence flag too (threat T16)
```

The ecdsa-sk pair (draws #3 and #5) gives the same two results; the ECDSA P-256/384/521 and RSA software keys give `account`. The end-to-end audit (`e2e-presence.test.ts`) registers `min_provenance: presence` with `require_signed`, signs 36 verdict commits through the emulated authenticator and gets status `CERTIFIED` with `VERDICT PROVENANCE: presence (user-presence flag verified; key hardware not attested) (n)` and verify 7/7 PASS.

### Deviations from the design, and why

1. **Two `-sk` paths, not one.** sk-dummy works here and makes the recorded fixture through real `ssh-keygen` and `git commit -S`; the TypeScript emulated authenticator makes test-time signatures and the cases sk-dummy cannot (its counter is constant). Both are cross-checked against `ssh-keygen` (above).
2. **More key types than FR9.2 names.** ECDSA P-256, P-384 and P-521 and RSA (rsa-sha2-256 or rsa-sha2-512) software keys give `account` too, since reviewers commonly sign with them; each is covered by a recorded ssh-keygen signature and the oracle. RSA below 2048 bits is refused, which is stricter than OpenSSH's 1024; SHA-1 `ssh-rsa` signatures are refused, as PROTOCOL.sshsig requires and ssh-keygen also does. `webauthn-sk-*` signatures are refused (git never makes them).
3. **A narrower allowed-signers form.** Principals are exact names, compared case-insensitively like logins (OpenSSH matches case-sensitive patterns); the only option is `namespaces="…"`, which must admit `git`; `cert-authority`, `valid-after` and `valid-before` are refused at configuration. A reviewer is one identity, and a key change is a new registration.
4. **`require_signed` and FR9.3, as applied.** A counted verdict meets `require_signed` only when its commit was signed by a registered key whose principal is the reviewer the line names: an unsigned, uncommitted, unlisted, invalid or mismatched verdict fails it. A verdict signed by an unlisted key is never counted above `self-asserted`; it FAILs check 7 whenever the registration requires `account`, `presence` or signed commits, and is a WARN otherwise.
5. **`require_signed` does not raise the default minimum.** FR3.8's default with git-file stays `self-asserted`; `require_signed` is its own rule, recorded as `verdicts.require_signed: true` (only when true, so other registrations keep their shape) and printed next to the minimum.
6. **A registered security key without the UP flag gives `account`,** not `self-asserted`: the signature is valid and the key registered, only presence is missing.
7. **A ceiling for every ledger.** The design says issue ledgers top out at `account`. pr-rla also counts an external ledger at most `account`, and `presence` only from git-file, because the certificate's wording says pr-rla verified the flag. A claim above the ceiling is counted at the ceiling and WARNs. `register` applies the same ceiling. No IPC change: an external ledger's ceiling comes from its declared level.
8. **Lines are attributed with `git blame`.** The design walks the commits that touched `verdicts.jsonl`; blame does that walk, attributes lines through merges, and gives working-tree line numbers to match. The append-only check is unchanged.
9. **Two optional SDK fields.** `VerdictProvenance.keyFingerprint` and `.counter` record which key signed and its counter; `eventId` is the commit SHA and `signer` the principal.
10. **A line's own `provenance` never counts,** with or without registered keys. Before U9 a hand-written git-file line could claim `account`; `register` refused `account` with git-file, so it was not exploitable, but the ledger now discards it in every case.
11. **"Decreasing" means below the highest counter seen before for that key,** in file order; an equal counter is not a warning, since some authenticators report a constant.
12. **The wording check reads everything,** every Markdown file (README, docs, the design record, BUILD-NOTES, examples, audits) and every source file, and flags a sentence that claims hardware-verified presence unless it negates or conditions it. The superseded draft's U9 goal sentence ("cryptographic evidence that a person touched an authenticator") is not a hardware claim and was not edited (the draft is the design record; the refined design adds T16).
13. **The security model gained only the provenance section.** The verdict-authority guarantee text in `nfr-design.md` §2 is about the MCP tools (U5) and is left to U5 and U10.
14. **`init`'s template is unchanged**; signed verdicts are documented in the README, which keeps `src/config.ts` edits small for the merge.
15. **`docs/writing-a-provider.md` is unchanged:** the provider SDK did not change. The ledger SDK's additions are optional fields; the ledger guide is U10's (FR8.1).
16. **Two existing tests changed.** `registry.test.ts`'s boundary helpers now walk core subdirectories (a `readdirSync` of `src/core` would have hit `presence/` as a file); `wave1-integration.test.ts`'s `ledgerTraits` assertion gains `maxProvenance: "account"`. No assertion was loosened.

### Findings

1. **`ssh-keygen -Y verify` does not enforce the presence flag (settles the design's open item).** OpenSSH_10.3p1 (macOS, LibreSSL 3.3.6), 2026-11-04: a `sk-ssh-ed25519` signature with flags `0x00` verifies (`Good "git" signature for bob with ED25519-SK key SHA256:…`, exit 0); `-vv` logs `signature details: counter = 43, flags = 0x00`. No option requires the flag: `-Y verify` takes `-O hashalg`, `print-pubkey` and `verify-time` only, and the allowed-signers options are `cert-authority`, `namespaces`, `valid-after` and `valid-before`; in the source, `sig_verify` only logs the flags at debug2. `no-touch-required` and `verify-required` exist only as certificate and key-generation options in ssh-keygen, and as `authorized_keys` options for sshd. `git verify-commit` inherits this: the fixture's UP-clear commits (draws #4 and #5) verify with exit 0. So a team verifying with git or ssh-keygen alone would accept a touch-less signature; pr-rla checks the flag itself. Every other outcome agrees with ssh-keygen, including its refusal reasons (`unsupported RSA signature algorithm ssh-rsa`, `Signature version 2 is larger than supported version 1`, `namespace does not match`, `incorrect signature`). *(Corrected in the U9 fix round, below: not every outcome agreed. A non-empty SSHSIG reserved field was signed over by pr-rla and ignored by ssh-keygen (review finding 6); pr-rla now refuses it, and the oracle lists each case where pr-rla is deliberately stricter.)*
2. **An empty `blame.ignoreRevsFile` does not clear a configured ignore list.** git inserts the configured files into a sorted list, so `""` sorts first and clears nothing; a verifier whose git configuration names an ignore-revs file would have had lines moved to other commits. `--no-ignore-revs-file` clears it, and the ledger passes it (`git-file-presence.test.ts › an ignore-revs list…`).
3. **Replace refs.** With a `refs/replace` entry, plain `git cat-file commit <unsigned>` shows a genuinely signed object under the unsigned commit's name. The ledger runs git with `--no-replace-objects` and checks that each commit object hashes to its name (`› a replace ref cannot swap…`).
4. **sk-dummy's counter is a constant** (305419896) and it echoes the flags ssh-keygen asks for, so a decreasing counter cannot be made with it.
5. **A doc-tree walk that follows symlinks loops** once the examples are installed: `examples/*/node_modules/pr-rla` links to the repository root. The wording check walks its own tree and skips symlinks (`2785627`).
6. `npm audit` named a scratch clone's `file:` link by its directory: a clone in a directory called `fresh` reported the `fresh` package's ReDoS advisory against the linked pr-rla. A clone in another directory reports 0 vulnerabilities.

### Unverified

- Any hardware FIDO key (D7): `presence` has been exercised with software keys only. T16 is not mitigated: FIDO attestation at registration (`ssh-keygen -O write-attestation`, verified against vendor roots) is not built.
- The ssh-keygen oracle and sk-dummy on Linux, on other OpenSSH versions, and on Windows; only macOS's OpenSSH_10.3p1 ran. The OpenSSH tarball's PGP signature.
- Git versions other than 2.55.0 (the ledger needs `blame --no-ignore-revs-file`, git 2.23 or later).
- Real authenticators' counter behaviour; the decreasing-counter case is synthetic.
- OpenPGP- and X.509-signed verdict commits: reported as unsupported and counted `self-asserted`, never verified.
- Shallow clones: lines before the boundary lose their level (stated in the security model, not tested). *(Wrong, corrected in the U9 fix round, below: in a shallow clone, blame attributed every line before the boundary to the boundary commit, which then gave them all its signer's level (review finding 1, reproduced end to end). A shallow, grafted or partial clone is now refused.)*
- The logic through U5's API layer, which does not exist on this branch.

### Shared files touched (for the integration with U5 and U8)

- `src/commands/register.ts`: `preflightLedger`'s ending now calls `registeredVerdicts` (core), and one output line uses `verdictsSummary` plus the T16 line. U5 should carry `preflightLedger` into its register API as is.
- `src/commands/status.ts`: imports; the verdicts pass through `capProvenance` with `ledgerTraits(...).maxProvenance` before `computeStatus`; the provenance line prints `provenanceLabel` and `require_signed`; the T16 line; one `require_signed` count line. All of it belongs in U5's status API result and formatter.
- `src/commands/verify.ts`: one line, `provenanceCeiling: lt.maxProvenance` in the deps. `src/commands/record.ts`: an import and two lines (the signed-commit hint).
- `src/core/verify.ts`: check 1's registration detail line and check 7's provenance block (rules, cap, wording). U8 may edit check 5 in the same file; the hunks are apart.
- `src/core/status.ts` (`provenanceLine`), `src/config.ts` (`parseVerdicts` and one import), `src/ledger-traits.ts` (`maxProvenance`), `src/sdk/ledger.ts`, `src/index.ts` (one export block after `core/verify.js`, which U5 may also extend), `src/ledgers/git-file.ts`.
- `README.md`: the git-file bullet, a "Signed verdicts (git-file)" section before "Adding a provider", one limitation bullet. `docs/security-model.md`: one section appended at the end.
- `test/registry.test.ts` (boundary helpers and one test), `test/wave1-integration.test.ts` (one assertion).
- Not touched: `package.json`, `package-lock.json`, `src/cli.ts`, `src/api/`, `src/plugins/`, `src/core/population.ts`, `src/core/records.ts`.

### What later units need to know

- **U5:** status and verify results should carry each verdict's `provenance` (with `signer`, `keyFingerprint`, `counter`) and print levels through `provenanceLabel`; the MCP tools must not print `presence` without it. A read-only context reads signed git-file verdicts the same way (blame and cat-file only read). `verify --offline` checks signatures, since git-file is local.
- **U10:** the "write a ledger" guide should say that a ledger cannot raise a verdict above `account` (only git-file's own signature check gives `presence`), and list the new optional `VerdictProvenance` fields. The release checklist could add a run of `presence-oracle.test.ts` on Linux.
- **The founder:** registering reviewers' security keys gives `presence` only as far as T16 allows; until key attestation exists, the security model asks each reviewer to register a hardware-backed key.

## U9 fix round (2026-11-04)

An independent review of bolt 10 at `0cf8af1` (verdict: FIX FIRST) found a critical forgery path and a design flaw, with two end-to-end reproductions in which `verify` passed 7/7 and `status` said CERTIFIED at `presence` on forged or tampered verdicts. This round fixes every finding on the same branch, `bolt/u9-presence-verdicts`, in the same worktree, and replaces the verdict mechanism on the coordinator's decision.

### The mechanism change: a deviation from the approved design

**What the approved design said.** The refined design's §U9 kept the draft's mechanism (`05` §U9): the registration lists allowed signers, the reviewer commits each verdict with `git commit -S`, and each verdict line takes the level of the signed commit that added it, with SSHSIG verified in TypeScript.

**Why it was changed (the review's reasoning).** That mechanism defeats U9's own goal, which is to let a registration demand evidence that a person was present for each verdict, against an assistant holding the reviewer's shell:
- A line's provenance was its commit's signature, so one signing touch covered every line in the commit: an assistant appends 35 verdicts naming the reviewer, the reviewer's next `git commit -S -a` makes all 35 `presence` (finding 4). With `commit.gpgsign=true`, rebase, cherry-pick, amend and `merge --squash` re-sign other people's lines with the registered key.
- Finding a line's commit needs `git blame`, which a verifier's checkout can steer: in a `--depth 1` clone (a CI checkout's default) every line is attributed to the boundary commit and takes its signer's level (finding 1, reproduced: 7/7 PASS, CERTIFIED, `presence (35)`); grafts, a hand-written `.git/shallow`, a rename hidden behind a merge (finding 2, reproduced on a full clone), textconv and commit-graph files steer it too (finding 5).
- The namespace `git` cannot tell a verdict from any other commit the reviewer signs, and a signed line was bound to no audit (finding 8).

**What replaces it.** One signature per verdict:
- Each git-file line carries `sshsig`, an SSHSIG in its own namespace `pr-rla-verdict@v1`, made by OpenSSH's `ssh-keygen -Y sign`, over a canonical, versioned text naming `registrationSha256`, `protocolSha256`, `draw`, `changeId`, `verdict`, `reviewer` (the principal) and `recordedAt`, and `registrationSha256` beside it (contracts.md §1, "Per-verdict signatures"). A `-sk` key with UP set gives `presence (user-presence flag verified; key hardware not attested)`; any other valid registered key gives `account`; anything else `self-asserted`.
- So one touch signs exactly one verdict, for one draw of one registration (findings 4 and 8 closed by construction). Commit signatures give no provenance; no line is credited to any commit; blame is gone.
- `pr-rla record <draw> pass|fail --sign <key>` writes the bytes to a temporary file, runs `ssh-keygen -Y sign -n pr-rla-verdict@v1 -f <key> <file>` (a security key asks for its touch), checks the signature as verify will, and appends the line. The README gives the manual alternative: the bytes with `printf`, the ssh-keygen command, the line with `printf`, and the `-Y verify` check. The sk-dummy fixture is made with exactly that recipe.
- `verdicts.allowed_signers` holds the keys (lines, or the path of an `allowed_signers` file). `require_signed` means every counted verdict carries a valid per-verdict signature by the registered key of the reviewer it names, and needs the built-in git-file ledger.
- Signed lines can still be deleted, so the git-file history walk was rebuilt over hash-checked raw objects (findings 1, 2, 5), and check 7 now compares the loaded ledger with the registered one (finding 3).

**What it means for FR9.** FR9.1 ("`require_signed` makes every verdict commit carry an SSH signature") is met as "every counted verdict carries its own SSHSIG"; FR9.2 ("verifies SSHSIG commit signatures") as "verifies each verdict's SSHSIG". The requirements table (`stages/requirements.md`) is not edited; this section and the refined §U9's dated note record the change. FR9.3–FR9.6, NFR4, NFR23, T16 and the levels are unchanged.

**What it costs.** A reviewer signs each verdict (one touch each with a security key) instead of each commit; `git commit -S` is no longer needed. Keys move from `verdicts.reviewers` to `verdicts.allowed_signers`, so a registration made on this branch before the round must be remade (none was released). A key's principal is matched exactly.

### Each finding, its commit and its test

| # | Finding (severity) | Outcome | Commit | Tests |
|---|---|---|---|---|
| 1 | Shallow clone credits every line to the boundary commit (CRITICAL) | fixed: no line is credited to a commit; a shallow clone, a grafts file and a hand-written `.git/shallow` are refused before anything is read, saying to verify in a full clone | `4fef1aa`, `9ba0e90` | `u9-review-regressions.test.ts › attack A`, `› exp1`, `› exp7`; `git-file-history.test.ts › finding 1: a cut history is refused` |
| 2 | Rename hidden behind a merge drops a signed FAIL (HIGH) | fixed: the walk takes parents from raw commit objects, with full history and no rename following; every version must extend every parent's | `9ba0e90` | `› attack B`; `git-file-history.test.ts › finding 2: a removal on a branch merged in FAILs` |
| 3 | Verify never compares the loaded ledger with the registered one (HIGH) | fixed for every ledger: check 7 FAILs when name, source, integrity or optionsSha256 differ; the ceiling comes from the registered identity; `require_signed` needs the built-in git-file | `47b8e6f` | `› exp2(b): a renamed copy … through a changed file option`; `› a locally locked external ledger, swapped in at verify` |
| 4 | A verdict signature is just a commit signature (MEDIUM) | fixed by construction: one signature per verdict; security model: don't register your everyday signing key | `4fef1aa` | `› finding 4: … one touch signs the commit; none of its lines counts`; fixture draw #14 (bob's touch as a commit signature) |
| 5 | Trusts the verifier's git config and environment (LOW-MEDIUM) | fixed: blobs read raw (no blame, diff or textconv), no commit-graph, no replace refs, inherited `GIT_*` dropped, all through `src/io/git-safe.ts` | `9ba0e90` | `› exp4: textconv …`, `› a lying commit-graph …`, `› an inherited GIT_DIR …`; `git-file-history.test.ts › finding 5` (also replace ref, a corrupt object) |
| 6 | SSHSIG reserved field differs from OpenSSH (LOW) | fixed: a non-empty reserved field is refused; oracle cases | `356adf2` | `presence-verifier.test.ts › finding 6`; `presence-oracle.test.ts › finding 6: …` (both variants); `› exp5` |
| 7 | Principal matching case-insensitive and not unique (LOW) | fixed: principals equal ignoring case and one key under two principals are refused; one principal per entry; matching exact | `4fef1aa` | `presence-verifier.test.ts › finding 7`; `› exp6 and finding 7`; `e2e-presence.test.ts › malformed keys, principals equal ignoring case, and one key twice` |
| 8 | Verdict not bound to its audit (LOW) | fixed by construction: the signed bytes name `registrationSha256` | `4fef1aa` | `› finding 8`; `presence-verifier.test.ts › finding 8`; fixture draw #13 |
| 9 | Wording test weak; bare `presence` printed (LOW) | fixed: negation scoped to the claim, new claim patterns, `scripts/` scanned, every printed level labelled in text and `--json`; the draft's forgery sentence gains a "Superseded" note | `4fef1aa` (labels), `bfae3e6` | `presence-wording.test.ts`; `e2e-presence.test.ts › finding 9: every printed level is labelled …` |
| 10 | Oracle gaps (LOW) | fixed: principal matching as production, reserved, curve/algorithm, RSA 1024, webauthn, small-order Ed25519, real `ssh-keygen -Y sign` (software ed25519), the recorded sk-dummy `-sk` signatures (UP set and clear); a missing ssh-keygen FAILs unless `PR_RLA_SKIP_ORACLE=1` | `4fef1aa` | `presence-oracle.test.ts` (33) |
| 11 | Existing audits verify differently (LOW) | (a) keyless git-file audits verify as before; the lines' own `provenance` stays discarded (release note); (b) fixed: reviewers with spaces load as plain names; (c) kept, release-noted | `4fef1aa`, `4638e99` | `git-file-unchanged.test.ts` (passes on `a360348`, before U9, and now); `› finding 11(b)` |
| 12 | Hardening (INFO) | fixed: RSA e = 1 or even, small-order Ed25519, a non-`ssh:` application refused; `register` warns when keys enforce nothing; SHA-1 collision exposure documented | `356adf2`, `4fef1aa`, `06fee84` | `presence-verifier.test.ts › finding 12` (3); `› exp6 (finding 12)`, `› finding 12: …` (2) |
| — | Partial clone fetches lazily (from the U5 review, via the coordinator) | fixed: refused (promisor remote or packs, `extensions.partialClone`); `GIT_NO_LAZY_FETCH=1`; a missing object is "missing", never "deleted" | `9ba0e90` | `git-file-history.test.ts › a partial clone is refused, and nothing is fetched` (2); `› a partial clone (--filter=blob:none) …` |

Other commits: `8c1166f` and `063f34a` (two tests' timing under load), `aa0ed5c` (the ledger demo), `06fee84` (docs), and this section.

### Before and after

The reviewer's own reproductions, re-run against `0cf8af1` at the start of the round (2026-11-04T03:27Z):
- `attack.test.ts`, attack A: full clone `7:FAIL` (`self-asserted (30) · presence (1)`); the depth-1 clone `1:PASS … 7:PASS`, `VERDICT PROVENANCE: presence (user-presence flag verified; key hardware not attested) (31)`, status `CERTIFIED (risk 5%)`.
- attack B: before the attack `7:WARN`, `NOT CERTIFIED · 20 more passing draws needed`; after it, `log -- rel` shows one commit, `7:PASS`, `CERTIFIED (risk 5%)` at presence (31).
- `exp1`: the shallow, grafted and hand-shallow clones credit the attacker's unsigned line `account` with integrity clean; `exp2(b)`/`exp3`: the rename keeps every line at `account`, integrity clean; `exp4`: with textconv, the flipped line is `account`; `exp5`: reserved `X` signed over `X` is `ok=true` in pr-rla, refused by ssh-keygen; `exp6`: RSA e = 1 and 2 accepted, `alice,ALICE` accepted; `exp7`: the shallow clone with a signed README tip credits three forged lines `account`.

`test/u9-review-regressions.test.ts` turns each into a test. Run against `0cf8af1` at 2026-11-04T04:22Z (the same file; only `test/helpers/u9-config.ts` swapped for that branch's key setting, keys in `verdicts.reviewers`; the newer test signer and line helper copied in): **18 failed, 2 passed** ("held before"), each failing on the attack's own outcome: `expected 'PASS' to be 'FAIL'` for attacks A and B, exp1, exp7, exp2(b), the external ledger, findings 4 and 8; `expected 'account' to be 'self-asserted'` (exp4); the lying commit-graph and `GIT_DIR` tests found nothing; the partial clone's pack count went from 2 to 4 (a lazy fetch); exp5, exp6 and finding 12's keys accepted; register accepted `Alice` and `alice`; the config refused `"Alice Smith"`; no register warning. After the round: **20 passed**.

### Release notes (behaviour that changes for existing audits)

1. **A git-file line's own `provenance` never counts**, keys or not: its `level`, and also `actorId` and `viaApp`. A hand-written line with `provenance.actorId` no longer matches an `id:<N>` reviewer (a phase-1/2 audit relying on that loses those verdicts); a hand-written `viaApp` line is no longer ignored. `pr-rla record` never wrote `provenance`, so only hand-written lines are affected. Restoring `actorId`/`viaApp` was declined: in git-file they are as self-asserted as the line, and honouring a line's claim about itself is what U9 removes.
2. **A shallow, grafted or partial clone FAILs check 7** for every git-file audit (before: a silently weaker check). Verify in a full clone: `git fetch --unshallow`, or `git clone` without `--depth` or `--filter`.
3. **A merge where both sides appended different verdicts FAILs** the append-only check: no version of the merge extends both parents. Record verdicts on one branch.
4. **Check 7 FAILs when the ledger verify loads is not the registered one** (name, source, files, options), for every ledger, including a changed git-file `file` option.
5. **`verdicts.reviewers` takes names again** (logins, `id:<N>`); SSH keys go in `verdicts.allowed_signers`. A key line left in `reviewers` is read as a name, and `register` warns.
6. **`require_signed` with any ledger but the built-in git-file is refused** at register (before: silently ignored), and FAILs check 7.
7. **An external ledger reporting a level above the one it declares** is counted at its declared level and check 7 WARNs (finding 11(c), kept: trusting a ledger beyond its declaration is what the ceiling prevents).
8. **A missing object is reported as missing**, never as a deletion, and git never fetches it.
9. git-file no longer looks for a repository from the process's cwd when the window directory does not exist; it starts from the nearest existing parent.

### Deviations, and what was declined

1. **The mechanism** (above).
2. **Signatures are checked in the core, not in the ledger.** git-file returns each line with its `sshsig` and `registrationSha256`; `countedVerdicts` (src/core/presence/provenance.ts) attests them against the registration's digest and allowed signers, for check 7 and status. The ledger can only supply lines, never a level, and `LedgerContext` is unchanged.
3. **One principal per allowed-signers entry**, stricter than "refuse one key under several principals": an entry `bob,robert <key>` is refused too.
4. **Exact principal matching.** Production now matches as `ssh-keygen -Y verify -I` does, so the oracle and production agree (finding 10); principals equal ignoring case are refused, so the exact match is never ambiguous.
5. **The canonical form is text, not JSON**: eight `name value` lines, values without control characters, `recordedAt` in strict ISO-8601 UTC, so a reviewer can type it with printf. `note` is not signed and never counts. The line carries the SSHSIG blob in base64 without the armor.
6. **`--no-textconv`** is not a global git option and `cat-file --batch` has none; textconv applies only to diff, log, show, blame and grep, and to `cat-file --textconv`. `git-safe.ts` adds `--no-textconv` to those commands; the walk runs none of them (only `rev-parse`, `rev-list` as a hint, `config` and `cat-file --batch`), and a test shows a configured textconv changes nothing.
7. **`GIT_CEILING_DIRECTORIES`** is the audit root's parent: git stops before climbing *into* a ceiling, so this keeps git at or below the root. Discovery (`rev-parse --show-toplevel` from the window directory) runs with no effective ceiling, so an audit whose `.pr-rla.yml` sits in a subdirectory of its repository keeps working; every later call runs at the toplevel with the ceiling there.
8. **Commit signatures are not reported, even informationally** (the brief allowed it): the commit-signature code is removed, so nothing can be mistaken for provenance.
9. **`CommandContext.signVerdict`**, an optional hook like `ctx.beacon`, lets the end-to-end tests sign through the software-emulated authenticator; the default is ssh-keygen.
10. **`rev-list` is used as a hint only.** The walk reads what it names, then follows raw parent links from HEAD and reads whatever the hint missed; a commit the hint names but HEAD does not reach is ignored.
11. **`test/plugin-host.test.ts`** (U2b's): "a slow call that keeps sending heartbeats is not stopped" failed in 2 of 4 full runs under the parallel load on this machine (load average near 48, other agents' suites running) and in 0 of 5 alone: its 500 ms watchdog window also covers the child's start. Widened to 2 s with a 4 s call (`8c1166f`); the property tested is unchanged.
12. **`scripts/demo-ledgers.mjs`** (U4's bolt 3 demo) registered a git-file audit and then pointed its configuration at github-issues before verifying recorded tracker data: the very swap check 7 now FAILs (finding 3), so both its verifies FAILed on identity. Each fixture now gets its own audit registered with the github-issues ledger it is verified with (`aa0ed5c`); its output is as bolt 3 recorded it, with the registered minimum now `account`.
13. **`test/wave1-integration.test.ts`** (the integration's): "the Jira example passes the ledger conformance kit with every instance in its own plugin host" starts one plugin-host child per kit instance; at load average 55 it took 54 s alone and passed the 60 s default in one full run of four. Its timeout is now 180 s (`063f34a`).
14. **Declined:** FIDO attestation (T16; unchanged, not built); detecting a history rewritten wholesale (a limit: nothing in one clone can show it; stated in the security model); SHA-1 collision detection (a limit, stated).

### Live and local work (dated)

- 2026-11-04T03:47:22Z: the fixture remade with the round-1 sk-dummy build (`scratchpad/u9/openssh-10.3p1/regress/misc/sk-dummy/sk-dummy.so`, as recorded above) and macOS's `ssh-keygen` (OpenSSH_10.3p1, LibreSSL 3.3.6): 14 verdicts, one `-Y sign` each, ten keys in a temporary directory deleted afterwards. ssh-keygen's own `-Y verify` and `-vv -Y check-novalidate` outcomes are recorded per verdict (UP `0x01` for bob and carol, `0x00` for dave and erin, counter 305419896).
- 2026-11-04T04:24Z: `record --sign` run live through real `ssh-keygen -Y sign` with sk-dummy (a scratch test, not committed, as sk-dummy is not in the repository): ssh-keygen printed `Confirm user presence for key ED25519-SK SHA256:…` for each of bob's verdicts; verify gave `VERDICT PROVENANCE: account (1) · presence (user-presence flag verified; key hardware not attested) (32)` and FAILed check 7 on dave's no-touch `ecdsa-sk` verdict (`is account; the registration requires presence (…)`).
- Found while running the suite, 2026-11-04T04:10Z: a symlink `node_modules/node_modules → …/u8-org-pooled-freeze/node_modules` had appeared inside this worktree's `node_modules` (not made by this round). Node then resolved `pkijs`'s `asn1js` from U8's tree, two copies of `asn1js` disagreed on `instanceof`, and every timestamp test failed with `rule 4: signer certificate not found among the token's certificates`, at `0cf8af1` too. The link (only the link) was removed; U8's tree was not touched.
- ssh-keygen findings, 2026-11-04 (`presence-oracle.test.ts`): it still does not enforce the UP flag; it accepts a non-empty reserved field signed over an empty one, RSA keys of 1024 bits, and WebAuthn signatures; and it accepts a small-order Ed25519 key (the identity point) whose one "signature" (R = identity, S = 0) verifies any message. pr-rla refuses all of these.
- Nothing left the machine: no network call, no key in `~/.ssh`, no hardware key, nothing pushed.

### Tests

- Before the round (`0cf8af1`): 577 passed, 2 skipped (579).
- After: 630 passed, 1 skipped (631); the remaining skip is the pre-existing one (the oracle's `UNVERIFIED` placeholder is gone). U9's files: `presence-verifier` 41, `presence-oracle` 33, `presence-fixtures` 13, `e2e-presence` 23, `git-file-history` 22 (replaces `git-file-presence`, 11), `presence-wording` 7, `u9-review-regressions` 20, `git-file-unchanged` 3.

### Verified (command → output)

Each run: `git clone` of the branch into the scratch directory, then `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, both examples' `ci` and `test`, `npm test` again with the examples installed, the five demos and `npm ls --prod --depth=0`, on Node 22.23.2, with other agents' suites running on the machine (load average 21 to 55).

First, at `4907ae6`:
- run 1 (2026-11-04T04:54Z): every step exit 0; `npm test` twice `Test Files 50 passed (50) · Tests 630 passed | 1 skipped (631)`; gitea and jira examples `# pass 1 · # fail 0`; `found 0 vulnerabilities`; dependencies asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1.
- run 2 (04:57Z): the same, except the second `npm test`: `1 failed | 629 passed`, the Jira plugin-host test timing out at 60 s (fixed in `063f34a`); and `demo-ledgers.mjs` printed check 7's identity FAIL for its ledger swap (fixed in `aa0ed5c`).

Then three runs in a row at `ed24591` (the last commit before this one, which changes only this section):

```
run 3 (2026-11-04T05:04Z)       run 4 (05:07Z)                  run 5 (05:10Z), under parallel load
npm ci              → exit 0    npm ci              → exit 0    npm ci              → exit 0
npm run build       → exit 0    npm run build       → exit 0    npm run build       → exit 0
npm run typecheck   → exit 0    npm run typecheck   → exit 0    npm run typecheck   → exit 0
npm test            → 630 passed | 1 skipped (631), all three
gitea ci, test      → # pass 1 · # fail 0, all three
jira ci, test       → # pass 1 · # fail 0, all three
npm test (again)    → 630 passed | 1 skipped (631), all three
node scripts/demo-{presence,broker,ledgers,plugin-host,sdk-carry-overs}.mjs → exit 0, all three
npm ls --prod --depth=0 → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1
```

Run 5 ran beside an extra full `npm test` in run 3's clone, on top of the other agents' suites. That extra run (not one of the three) failed one test: `e2e.test.ts › status: 36 passes certify claim D`, where `cloneScenario`'s `cpSync` reported its own freshly made temp directory's `.git/objects` missing (`ENOENT … prrla-tamper-…/.git/objects`). The helper and that test are unchanged; every process on this machine shares the same temp directory and the `prrla-` prefixes, and it did not recur. Unexplained, recorded here.

The demo `demo-presence.mjs` prints, for the sk-dummy fixture: `draw #2 … an ed25519-sk key, UP set → presence (user-presence flag verified; key hardware not attested) · ssh-keygen -Y verify -I bob: Good → check 7 …: PASS`; `draw #4 … no-touch-required: UP clear → account · … Good → FAIL: … is account; the registration requires presence (…)`; `draw #13 … for another audit's registration → self-asserted · ssh-keygen … Good`; `draw #14 … in namespace git … → self-asserted · … refused`; `VERDICT PROVENANCE: self-asserted (5) · account (7) · presence (user-presence flag verified; key hardware not attested) (2)`; then `integrity, full clone: PASS` and `integrity, depth-1 clone: FAIL … the repository is a shallow clone …`.

### Unverified

- Any hardware FIDO key (D7); T16 is not mitigated.
- The oracle and sk-dummy on Linux, Windows and other OpenSSH versions; only macOS's OpenSSH_10.3p1 (LibreSSL 3.3.6) ran.
- git other than 2.55.0. `GIT_NO_LAZY_FETCH` needs git 2.44 or later; an older git still refuses a partial clone through the promisor check, which runs before any object is read.
- The walk's cost on a very large history: it reads every reachable commit and its root tree once (measured only on test repositories).
- `record --sign` with a passphrase-protected key or a key held by ssh-agent (`--sign key.pub`).
- A history rewritten wholesale, and SHA-1 collisions (limits, stated in the security model).
- The logic through U5's API layer, which is not on this branch.

### Shared files touched (for the integration with U5 and U8)

- **Command files:** `src/commands/context.ts` (`CommandContext.signVerdict`), `record.ts` (`--sign`, through `verdictSigner` in `src/io/ssh-sign.ts`), `register.ts` (`allowedSigners` input, `verdictRuleWarnings`, the T16 line from `allowed_signers`), `status.ts` (`countedVerdicts`, `registeredCeiling`, labelled lines), `verify.ts` (`ledgerIdentity`, `registeredCeiling`); `src/cli.ts` (one option).
- **`src/core/verify.ts`:** `VerifyDeps.ledgerIdentity`, next to `provenanceCeiling`; check 7's verdict block (identity, `require_signed` ledger, `countedVerdicts`); check 1's `signed verdicts required` wording. Nothing in checks 2 and 5.
- **New shared git helper: `src/io/git-safe.ts`** (`gitSafe`, `gitSafeText`, `gitSafeSpawn`, `gitSafeEnv`, `gitSafeArgs`, `historyRefusal`, `FULL_CLONE`). U5's equivalent guard should merge into it; every read-path git call should go through it.
- **New:** `src/core/presence/verdict-payload.ts`, `src/io/ssh-sign.ts`, `src/ledgers/git-history.ts`; `src/core/presence/commit.ts` removed; `src/core/presence/verifier.ts` rewritten.
- `src/sdk/ledger.ts` (`VerdictEvent.registrationSha256`, `.sshsig`; source `verdict-signature`; `verdictIneligibility` back to master's), `src/config.ts` (`verdicts.allowed_signers`), `src/core/records.ts`, `src/ledger-traits.ts` (`registeredCeiling`), `src/index.ts`.
- Tests and scripts: `test/plugin-host.test.ts` and `test/wave1-integration.test.ts` (one test's timing each), `scripts/demo-ledgers.mjs` (its audits register the ledger they verify with).
- **U5 must:** have its status and verify APIs call `countedVerdicts(read, { registration, verifiesSignatures, ceiling, ledger })` with `registeredCeiling`, and pass `ledgerIdentity` to `verifyAudit`; carry `record --sign`; strip `sshsig` and `registrationSha256` before showing a verdict (`withoutSignatureFields`); run any git through `git-safe.ts`.

## Bolt 9 (U8): org-pooled freeze (2026-11-04)

Goal (delivery-plan.md, bolt 9): FR5.1–FR5.8. One registration, one freeze and one certificate for every repo of an org, group or workspace: a registered `RepoSet`, resolved once at freeze; the union of per-repo populations under one selector; a P = 4, all-or-nothing, resumable freeze run; `freeze --dry-run --estimate`; the repo-added and repo-gone rules in `verify`. A single repo is a pool of one.

Built on branch `bolt/u8-org-pooled-freeze` off master `a360348` (the end of wave 1), in parallel with U5 (audit API, MCP) and U9 (presence verdicts). Design read: `functional-design.md` §U8, the draft's `05` §U8, `contracts.md`, `test-design.md`, `delivery-plan.md`, FR5.1–FR5.8. User-facing description: [`docs/org-pooled-audits.md`](docs/org-pooled-audits.md).

### Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR5.1 a registration names a repo set (an explicit list, or a rule with include/exclude globs and the archived and fork flags), registered and resolved at freeze; a rule resolves to the same list on two runs over the same state | met | `repo-set.test.ts` › "FR5.1 / FR5.7: the repo set a config registers", "FR5.1: globs and rule application", "FR5.1: a rule resolves to the same list on two runs over the same state" (sorted, independent of the provider's order, re-validated); `pooled-freeze.test.ts` › "FR5.1 / FR5.7: registering a repo rule" (the rule, not its resolution, is signed; a zero-match rule and a provider without `listRepos` are refused) |
| FR5.2 the pooled population is the union of per-repo populations under one selector; the manifest records stable repo ids and each repo's head SHA | met | `repo-set.test.ts` › "FR5.2: the pooled population is the union of per-repo populations" and "…the repos a manifest lists must be the registered ones"; `pooled-freeze.test.ts` › "lists every repo with its id, default branch and pinned head; N is the union of per-repo populations" (40 repos, each head 40 hex, N equal to the selector over each repo built on its own); `pooled-verify.test.ts` › "the manifest is held to the registered repo set" |
| FR5.3 one certificate per owner and window; per-repo counts descriptive | met | one `manifest-commitment.json` and one manifest (`pooled-freeze.test.ts`); `pooled-verify.test.ts` › "FR5.3: one certificate for the pool; per-repo counts are descriptive" (`status` prints the table and `per-repo counts are descriptive; the risk limit applies to the pool`; `--json` has `perRepo`; the draws file is labelled `acme-org (30 repos)`) |
| FR5.4 all-or-nothing, resumes from checkpoints; a killed and resumed freeze of the synthetic 40-repo org gives a byte-identical manifest | met | `pooled-freeze.test.ts` › "FR5.4 / NFR5: a rate-limited, stopped or killed freeze resumes to a byte-identical manifest": injected 429s, a killed run (every fetch after request 150 never returns, nothing cleaned up), a stuck repo (exit 4, resume command, `--resume`), a prefix of the run id, a refused resume with the differing input named, a plain re-run, `--force`; "FR5.4: all-or-nothing" (403 and 404 name the repo, no manifest); `pooled-api.test.ts` (in-flight repos finish and keep their checkpoints; nothing new starts after a failure) |
| FR5.5 one per-host rate governor serves all repos and plugins; `freeze --dry-run --estimate` within ±20% of requests and ±50% of wall time on the synthetic 40-repo org | met | `pooled-freeze.test.ts` › "FR5.5: freeze --dry-run --estimate": the 40-repo org plus three more orgs (other seeds and sizes); the rate budget (200/h on REST and GraphQL) really bound the run (more than 10 fake minutes), which can only happen if the 40 repos share the host's budget. Measured over 18 orgs: requests within 5.2%, wall time within 28.6% (see Findings) |
| FR5.6 one provider per pooled registration; a mixed pool is refused with the reason, by AuditCore | met | `repo-set.test.ts` › "FR5.6: one provider per pooled registration, enforced by AuditCore" (`validateRepoSet`, `resolveRepoSet` and `assemblePopulation` each refuse; the last by id scheme, whatever the caller); `pooled-freeze.test.ts` › "FR5.6: refuses a list that mixes providers" at `register` |
| FR5.7 defaults: archived repos and forks excluded, every visibility included, 4 repos in parallel; no `--skip-repo` | met | `repo-set.test.ts` (defaults in the parsed set, `freeze.concurrency` default 4, range 1–32); `pooled-freeze.test.ts` (`freeze` has no `--skip-repo`; 45 repos in the org, 40 in the pool; `pooled-plugin.test.ts`: 2 to 4 listings overlap in the isolated host, never more) |
| FR5.8 built this round | met | this bolt |
| NFR5 resumable, NFR6 deterministic | met | "NFR6: two runs over the same SCM state write byte-identical manifests" (two fresh runs; one repo at a time versus eight); the kill/resume tests above |
| Repo added after freeze makes check 5 FAIL; a deleted repo WARNs with a count | met | `pooled-verify.test.ts` › "a repo created after freeze", "a repo that is gone" (404 and 403; the WARN names the repo and counts its changes; a real difference in another repo still FAILs) |
| Two-provider pool refused by AuditCore; kit/conformance updated for `listRepos` | met | above; `list-repos.test.ts` (kit checks `list-repos` and `estimate-requests`, opt-in per fixture; built-ins' `listRepos`) |
| Pooled freezes through external providers run in the isolated plugin host (U2b) | met | `pooled-plugin.test.ts`: a synthetic plugin (12 repos) that refuses to be imported outside the host lists repos over IPC, lists four repos at once in the child, answers `estimateRequests` through the host, and `verify` rebuilds it |
| Single-repo audits behave byte-identically | met | `single-repo-anchor.test.ts`: two scenarios (json-file, 400 changes; GitHub, a synthetic repo) produce the same manifest sections, record keys in order, commitment and registration `repos` as the master build `a360348`, and the same `register` and `freeze` output and `verify` results; see "Verified" |
| The navikt read-only dry run is recorded | met | "Live reads" below |

### Done

| Piece | Where |
|---|---|
| `RepoSetRule`, `RepoRef`, `RequestEstimate`, optional `ScmProvider.listRepos` and `estimateRequests`, `RepoUnavailableError` / `REPO_UNAVAILABLE` / `isRepoUnavailable` | `src/sdk/provider.ts` |
| Repo sets: parsing and defaults, globs, `validateRepoSet` (one provider per pool; a rule needs `listRepos`), `resolveRepoSet`, `manifestRepoProblems` | `src/core/repo-set.ts` |
| The pooled population: `assemblePopulation` (union, one selector, one id scheme), `buildPooledPopulation`, `buildSetPopulation`, `mapPool`; `buildPopulation` is the pool of one; `Population.repos` | `src/core/population.ts` |
| Verify: check 2 holds the manifest to the registered set and the commitment to the manifest's as-of time; check 5 rebuilds each repo from its head, re-resolves the rule, FAILs a repo added after freeze, WARNs a gone repo | `src/core/verify.ts` |
| Per-repo table | `src/core/pooled-report.ts`, `src/commands/status.ts` |
| `FreezeCheckpointStore`, the run id, `differingInputs` | `src/api/freeze-store.ts` |
| The run: `freezeRepos`, `FreezeStopped` / `FreezeRepoFailed` / `ResumeRefused`, `isTransientFailure` | `src/api/pooled-freeze.ts` |
| The estimate: sampling, the replay through a fresh `RateGovernor`, output lines | `src/api/freeze-estimate.ts` |
| `freeze` call-through (`runFreezeRepos`, `estimateCommand`) and exit codes; `--estimate`, `--resume` | `src/commands/freeze-pool.ts` (new), `src/commands/freeze.ts` (54 lines), `src/cli.ts` (2 options) |
| `register`: `repos:` signed as written; the pool is checked and dry-resolved first | `src/commands/register.ts` |
| Config: `repos:` (a list or a rule), `freeze: { concurrency }` | `src/config.ts` |
| `listRepos` on GitHub (`/orgs/{o}/repos`, user fallback), GitLab (group with subgroups, user fallback), Bitbucket Cloud, Bitbucket Data Center; `estimateRequests` on GitHub | `src/providers/*` |
| Broker `stats` (requests, time in the transport, per host: authenticated and GraphQL) | `src/net/broker.ts` |
| IPC: `estimateRequests` joins the provider methods (`listRepos` was already there) | `src/plugins/{protocol,child,host}.ts` |
| Kit: opt-in `list-repos` and `estimate-requests` | `src/testing/conformance.ts` |
| Docs | `docs/org-pooled-audits.md` (new), `docs/writing-a-provider.md`, `README.md` |
| Tests: 111 new (467 → 578 passed, 1 skipped; 42 → 49 files) | `repo-set` 28, `pooled-api` 18, `pooled-freeze` 29, `pooled-verify` 16, `list-repos` 17, `pooled-plugin` 1, `single-repo-anchor` 2; helpers `fake-org.ts` (a synthetic GitHub org: fixture kind `synthetic`) and `pool-scenario.ts`. No existing test or helper changed |

### How the freeze run works (and what was settled)

- **One path for a pool of one.** `freezeRepos` resolves the set, lists each repo through the provider (so through the broker's shared per-host budget, or the isolated host), checks each listing with the same contract checks as before, and assembles with the selector applied once. For `repo:` it is `buildPopulation` itself: no checkpoints, and a provider error reaches the caller unwrapped, as before.
- **Stopping versus failing.** A transient failure that survived the broker's retries (`BrokerRetriesExhausted`, `BrokerTimeout`, a provider's own give-up with status 0, 429, 5xx, a dropped connection; across the plugin host only `code` and `status` survive, and the classifier reads those) stops scheduling, lets the repos in flight finish, keeps their checkpoints and exits **4** with `pr-rla freeze --resume <runId>`. Anything else (a 403 or 404, a contract violation) fails the run, names the repo and exits 1. Neither writes a manifest.
- **Checkpoints.** `.pr-rla/cache/<window>/<runId>/` of the audit directory (git-ignored by `init`): `run.json` (inputs and start time) and one atomically written file per finished repo holding the checked listing. A damaged or foreign file is ignored and its repo lists again. `verify` never reads the directory (a test follows the import graph).
- **The run id** is the SHA-256 of the registration digest, the resolved repo list with ids, the pr-rla version and the provider identity. `--resume` takes it or a prefix of 8 or more digits; if any input differs it refuses and says which (`the resolved repo list (1 added, 0 removed since that run started)`). Running `freeze` again with the same inputs continues the run as well (the exit-4 contract is that re-running the printed command finishes the job); `--force` starts over; `--resume` with `--force` is refused.
- **Time.** The manifest's `frozenAt` is the run's start (kept in `run.json` across a resume), which is the instant reviews are read as of and what makes a resumed manifest byte-identical. The commitment's `frozenAt` is the time the run finished and signed, because rule 7 of the token acceptance rules (genTime within 10 minutes of the signed time) would refuse the tokens of any freeze longer than that. A live gh-aw freeze already took 22 minutes; an org takes hours. Check 2 FAILs a commitment dated before its manifest's as-of time. For a single repo the two times are still one value. A freeze that finishes after seed round R is refused before anything is written (checkpoints kept); the estimate warns when the predicted wall time exceeds the time left.
- **The estimate.** The provider's `estimateRequests` probes the first page of what `listChanges` reads (GitHub: the head query, the newest page of closed PRs plus one from the middle when the list is longer, one history page) and extrapolates by density. The core samples at most 200 repos (every k-th) and scales. The wall time replays the predicted requests, as REST and GraphQL interleaved, through a fresh `RateGovernor` holding the broker's budgets, seeded with whatever limit the server reported while probing (synthetic `x-ratelimit-*` headers built from the live governor's window), so a 5,000/hour token is paced as the real run will pace it. The run is also bounded by work, requests × measured latency ÷ repos in flight; the larger of the two is printed with which one binds.

### Live reads (all read-only, 2026-11-04, UTC)

`gh auth token` used for reads only, as `GITHUB_TOKEN` in the environment of `node dist/cli.js`. The broker's read-only guard refuses anything but GET, HEAD and GraphQL queries from a provider, and `--dry-run` writes nothing, not even a key. Nothing was written to GitHub, and no scratch repository or project was used.

| When | What | Requests | Wall |
|---|---|---|---|
| 02:11:24Z | `gh api /orgs/navikt`: `public_repos` 3,206 | 1 | |
| 02:11:34Z | `freeze --dry-run --estimate`, the whole org (`repos: { owner: navikt }`, window 2026-10-26..2026-11-01, both kinds) | 33 listing + 594 probes | 137 s |
| 02:13Z | `gh api --paginate /orgs/navikt/repos` filtered to non-archived non-forks: 1,782 names, the number pr-rla's `listRepos` and defaults resolved | 33 | |
| 02:15:27Z | `--estimate`, the subset `include: [dp-*, familie-*, helse-*, tms-*]` = 223 repos | 33 + 600 | 154 s |
| 02:18:11Z | **`freeze --dry-run --out`, the same 223 repos** | **1,102 (623 GraphQL)** | **3 min 54 s** |
| 02:22:38Z | the same again | 1,102 (623 GraphQL) | 3 min 43 s |

- **The whole org is too large for the budget.** The estimate for 1,782 repos is about 7,892 requests (3,511 REST, 4,348 GraphQL) and about 17 minutes at 530 ms a request (the rate budget alone would need 3 minutes on this 5,000/hour token). That is far above the "about 2,000" limit for the real run, so the real dry run is the 223-repo subset above; the full org was estimated, not frozen.
- **Estimate versus actual on the subset.** Requests: predicted 1,102 (33 listing + 1,069 for the repos from 200 probed repos, scaled by 223/200), actual 1,102, in both runs; GraphQL 623 predicted and 623 actual. Wall time: predicted about 3 min (1,102 × 656 ms ÷ 4), actual 3 min 43 s and 3 min 54 s, about 20% under. This is one window of one org whose repos are mostly small, so a repo costs nearly a fixed 4 requests (head, one page of PRs plus its re-scan, one history page) and the request figure is close to exact for a reason that says little about large repos; the synthetic sweep below covers those.
- **Result.** 223 repos (179 with changes in the window), 1,810 landed (1,364 PRs, 446 direct pushes), 1,419 with no recorded human review, so N = 1,419; 7 direct pushes are merge commits and 9 arrived through two pushed merges. The two runs produced the same `selected` ids and the same funnel (the files differ only in `frozenAt`), a live check of NFR6 on a closed window.
- **GitHub's own counters are not a clean cross-check.** Over the first dry run the token's REST counter fell by 595 and the GraphQL counter by 154 points, while pr-rla counted 479 REST requests and 623 GraphQL queries. The same account's token is used by the other bolts' live reads, and GraphQL points are not requests, so the difference is not attributed to anything.

### Verified (command → output)

- `npm ci && npm run build && npm run typecheck && npm test` from the worktree → build and typecheck clean; `Test Files 49 passed (49) · Tests 578 passed | 1 skipped (579)`, against `42 files · 467 passed | 1 skipped (468)` before this bolt. The suite makes no network call (the network-deny harness fails any test file that opens a socket off loopback). The machine was heavily loaded (load average above 30), so the wall time of the suite (about 75 s here, about 12 s before this bolt) is not a measurement; `pooled-freeze.test.ts` took 21 s and `pooled-verify.test.ts` 8 s in an earlier, less loaded run.
- `npm --prefix examples/providers/gitea ci && npm --prefix examples/providers/gitea test` → `# pass 1`; `npm --prefix examples/ledgers/jira ci && npm --prefix examples/ledgers/jira test` → `# pass 1`. `packages/pr-rla-mcp` and `integrations/github-action` do not exist yet (bolts 6 and 7).
- **Single-repo byte-identity against master.** `git archive a360348` extracted to a scratch directory, with this worktree's `node_modules` linked, and the same two scenarios (json-file with `makeChanges(400)`; GitHub over a synthetic one-repo org) run at a fixed clock on both builds: the `register` and `freeze` output, the registration sha, the manifest file hash and sha, the commitment record and sha, and all seven `verify` checks with their details were identical (`diff` empty). The permanent test pins the sections that do not depend on a registration hash or a version.
- Estimate sweep over 18 synthetic 40-repo orgs (seeds 11–16 at size ×1, ×2, ×4), actual versus predicted, at 200 requests an hour on both budgets: requests −5.2% to +1.3% (the estimate under-counts a little as repos get large), wall time −10.5% to +28.6% (the largest is the smallest run, 4 minutes). Tests assert the requested bounds on four of them.
- The demo: `npx vitest run test/pooled-freeze.test.ts -t "killed run"` → the first run dies after 150 requests with 6 to 39 of 40 repos checkpointed and no manifest, the second run reports `run … resuming (N of 40 repos already listed, as of 2026-10-20T12:00:00Z)`, lists only the rest, and its manifest is byte-identical to an uninterrupted run's.

### Deviations from the design, and why

1. **`RepoSet` rule flags are booleans.** `contracts.md` types `archived: false; forks: false`; FR5.1 says "archived and fork flags", so `true` includes them. Existing readers are unaffected.
2. **`listRepos` returns what the token sees under the owner, and the core filters.** The contract says `listRepos(set)` but not who applies the globs and flags. The core applies them (after re-validating every entry), so providers behave alike and a provider cannot widen the pool; a provider may pre-filter. `RepoRef` is as in the contract.
3. **A new optional provider method, `estimateRequests`.** The draft says "sample first page per repo" but the SDK had no way to do that; the request count depends on how the provider paginates. It is optional within API version 1, rides the IPC method list (`pr-rla/ipc/v1` gains one method name), is documented in `writing-a-provider.md`, and has an opt-in kit check. A provider without it gets "cannot estimate" and no figures. Only GitHub implements it; GitLab and the Bitbuckets do not, and the wall-time replay is GitHub-shaped (REST versus GraphQL budgets), though it uses the family budgets of whatever host the probes used.
4. **The done-marker is used unconditionally.** The draft skips a repo "with a done-marker whose head SHA matches". A repo is not asked its current head on resume (that would be a request per repo for nothing): the marker holds the head it was listed from, and the resumed run uses that listing, which is also what keeps the manifest byte-identical.
5. **`frozenAt` is split for a pooled freeze** (see "How the freeze run works"). The design had one `frozenAt`; it cannot be both the instant reviews are read as of (which a resume must keep) and the instant tokens agree with (which is when the run ends). Check 2 gained one rule for it.
6. **`RepoUnavailableError` and a 404/403 convention.** `verify` needs to tell "this repo is gone" from "this repo is broken" to give a WARN with a count. The SDK now exports an error class and `isRepoUnavailable` (a `code`, or a provider's own `status` 404 or 403). GitHub's GraphQL reports a missing repository as HTTP 200 with a `NOT_FOUND` error; the provider now gives that error status 404 (and `FORBIDDEN` 403), with the same message.
7. **An empty GitHub repository returns no changes** instead of throwing "has no default branch". One empty repo would stop an org-wide pool (nothing can be skipped). A typo still fails with NOT_FOUND. This changes the one error a single-repo audit of an empty repo used to give. *Reversed in the U8 fix round: the provider throws master's error again (as a `RepoEmptyError`), and only a pool counts the repo as empty.*
8. **Check 5, "unless its first commit is after the window closed".** `RepoRef` carries no creation date, so the exemption is decided from what the repo holds: a repo that matches the rule but is not in the manifest FAILs if the provider lists any change for it in the window, and passes (with a line saying so) if it lists none. The selector is not applied: a repo with only reviewed changes in the window still FAILs.
9. **Not computed for a pool:** `nativeCounts` (a search figure per author and repo).
10. **A list records no repository ids** (the SCM is not asked for a list, which has no `listRepos` call); only a rule does. Bitbucket Data Center's list carries no default branch, so its `RepoRef.defaultBranch` is empty.
11. **Kit checks are opt-in.** `list-repos` and `estimate-requests` add no result unless the fixture names them, because older fixtures cannot answer the probes and the existing test requires that a well-behaved provider's results equal `CONFORMANCE_CHECKS` with none skipped.
12. **Small additions:** `--estimate` implies `--dry-run` and works before registration; `--resume` takes a prefix; `freeze.concurrency` in `.pr-rla.yml` (not registered: it changes speed, never the result); progress lines go to stderr; the pooled summary line `freeze: 223 repos · … · 1102 requests (623 GraphQL) · 3 min 43 s`; the config note now also names a differing repo set (`freezing with the REGISTERED selector, window and repos`); `src/index.ts` exports the new core and API pieces; `Broker.stats`.

### Findings

- **`src/sdk/provider.ts` must be written in erasable TypeScript only.** The plugin host's child runs it under Node's type stripping, which refuses parameter properties; a first `RepoUnavailableError` with them broke 26 tests in the plugin suites. The class declares its fields and assigns them. Anything added to `src/sdk/` has to pass the same test.
- **`fakeClock.run` and real asynchronous work did not mix.** The helper drove fake timers and gave other work 50 turns of the event loop; a command that awaits real asynchronous I/O intermittently threw "waiting on something other than the clock" (1 run in 3 here). *Corrected in the U8 fix round:* this note first blamed the BLS check in `sample` and `verify`, wrongly. BLS verification is synchronous JavaScript (the review timed 60 verifications with no wait at all); the waits were the git-file ledger's `node:fs/promises` calls (up to 16 loop turns for `record`, 12 for `verify`, 5 for `status` at load ~6) and loopback sockets to the mock timestamp authorities. The helper is fixed (it yields real time while no fake timer is pending), and the workarounds this note described are gone (see "U8 fix round").
- **The pool's cost is mostly a fixed 4 requests per repo** (head, one PR page, its re-scan, one history page) plus one PR batch per 40 merged PRs and one history page per 50 commits. A 1,782-repo org is thus about 7,900 requests for a one-week window, almost all of it floor.
- **A pooled freeze finds a conflict between two designs in the draft:** its "frozenAt" was one value, and its timestamp rule assumes freezes are short. See deviation 5.
- **navikt has 3,206 public repositories**, 1,782 of them neither archived nor forks.

### Unverified

- A full `freeze` of a real org (not a dry run) with timestamp tokens, and `--resume` on a real org. The resume path is tested only on the synthetic org and the plugin host; the live runs were dry runs, which write no checkpoints.
- The estimate on large repos of a real org, or on a window far in the past. The one live subset is mostly small repos; the synthetic sweep uses uniform activity, which is the case the extrapolation is built for. An org whose recent activity differs from the window's will be mis-estimated by the first-page method (it samples the newest and middle pages of the PR list).
- `listRepos` on GitLab and Bitbucket Cloud against live servers (hand-made responses only), and on Bitbucket Data Center (unverified, like the provider). `estimateRequests` exists only for GitHub.
- A pooled freeze through the isolated host on Node 24 or 26 (the synthetic plugin ran on this machine's Node 22; the host's own tests cover the others).
- Concurrency above 4 against a real SCM: the secondary limits (GitHub: 100 concurrent requests, 900 REST points a minute) were not approached.

### Shared files touched (for merging with U5 and U9)

- **Most likely to conflict with U5** (it moves every command into `src/api`): `src/commands/freeze.ts` (54 lines changed; the new logic is in `src/commands/freeze-pool.ts`, which calls `src/api/pooled-freeze.ts` and `src/api/freeze-estimate.ts`, so the move is `runFreezeRepos` / `estimateCommand` into the API layer), `src/commands/register.ts` (`preflightRepoSet` and one field), `src/commands/status.ts` (the population call and the per-repo table), `src/commands/sample.ts` (`repoLabel`), `src/cli.ts` (two options on `freeze`), `src/index.ts` (exports), `README.md`, `docs/writing-a-provider.md`.
- **Possible with U9:** `src/core/verify.ts` (check 2 repo rules and check 5 are rewritten; check 7 is untouched), `src/core/records.ts` (`RepoSet` type, `registrationRepoSet`, `manifestRepos`, `repoLabel`; `registrationRepo` and `manifestRepo` now throw for a pool rather than for "org-pooled audits are not supported"), `src/config.ts` (`repoSet`, `freeze`).
- **Shared plumbing:** `src/sdk/provider.ts` (additions only), `src/plugins/{protocol,child,host}.ts` (one method name each), `src/net/broker.ts` (`stats`), `src/testing/conformance.ts` and `index.ts` (additions only), `src/providers/*` (new methods; GitHub's `listChanges` returns no changes for an empty repo and `http.ts` maps GraphQL NOT_FOUND and FORBIDDEN to 404 and 403).
- **Tests:** only new files; no existing test or helper was edited. `test/helpers/fake-org.ts` and `pool-scenario.ts` are new.
- **U5 should know:** a read-only context must not reach `FreezeCheckpointStore` (it writes under `.pr-rla/cache`); `freeze_preview` with `estimate` can call `estimateFreeze` (reads only, no store) and the `FreezeEstimate` it returns is JSON. The MCP job hand-off applies: an estimate of a large org makes hundreds of requests. `draw_context` for a pooled draw works unchanged, since the draw names its repo through the change.
- **U9 should know:** nothing in `src/core/presence/` was needed. `PluginIdentity`, the registration's `verdicts` field and check 7 are as on master.

## U8 fix round (2026-11-04)

An independent review of `bolt/u8-org-pooled-freeze` at `b76a9e4` found five reproduced ways a pooled audit could be pruned or left unverified while `verify` printed VERIFIED and exited 0, plus seven smaller gaps and six tests that could not fail. The coordinator's governing principle for the fixes: **anything the auditee controls after registration must not silently remove changes from the population, and anything the verifier cannot check must never print plain VERIFIED.** The fixes are general mechanisms (a registered repo set, a recorded listing, one repo-level probe, a current-head comparison, an INCOMPLETE verdict), not one case per finding.

Every reproduction the review wrote (its scratch `rt/soundness`, `rt/more`, `rt/bbhead`, `rt/est`, `rt/flake` and `anchor/dump`) is now a committed test. The first 27 tests of `test/u8-review.test.ts` all **fail on `b76a9e4`** (run with this round's test helpers over that commit's `src`) and pass now; `test/fake-clock.test.ts` fails 2 of 3 with `b76a9e4`'s helper.

### Findings, fixes and evidence

| # | Finding | Fix | Regression test(s) | Before (b76a9e4) | After |
|---|---|---|---|---|---|
| 1 | Archiving (renaming, making private, transferring) a repo before freeze takes it out of the pool unseen | `register` signs a rule's resolved repos by id (`registeredRepos`); freeze includes each one that still exists, whatever its attributes; the manifest records the owner's unfiltered listing with each exclusion (`repoListing`); check 2 FAILs a manifest that drops a registered repo, offline; check 5 FAILs a registered repo outside the pool and WARNs, with the count, a non-registered repo excluded only by a mutable attribute | `u8-review` › finding 1 (3 tests); `pooled-freeze` › "signs the rule and, by repo id…"; `pool-integrity` › resolvePool, poolRecordProblems | archived `svc-07` (267 window changes) absent from the manifest, check 5 PASS, VERIFIED | `svc-07` frozen; a manifest without it: check 2 `manifest drops 1 registered repo(s)`, check 5 FAIL, FAILED; retrospective archive before registration: WARN with the count |
| 2 | A verifier who sees less than the freezer WARNs on the honest manifest and PASSes a pruned one | The manifest records the freezing identity and per-visibility counts and proofs; `ScmProvider.listingVisibility`; check 5 is INCOMPLETE for each private or internal visibility the rule admits that the verifier cannot prove it sees | `u8-review` › finding 2 (3); `pooled-verify` › "not visible to the verifier's token at all…"; `list-repos` › listingVisibility; `pool-integrity` › checkPool | honest: WARN, VERIFIED; pruned of 7 private/internal repos and re-signed: PASS, VERIFIED | honest: INCOMPLETE, exit 6, reason "fine-grained … token"; pruned: check 2 FAIL, FAILED |
| 3 | `verify` trusts each repo's head; a rewound head (or an edited checkpoint) hides direct pushes | check 5 lists the window from the current head as well as rebuilding from the frozen head (single repos too); a window landing the frozen head lacks FAILs (a PR always; a direct push unless every first-parent commit after the head is dated after the window, FR7.2); INCOMPLETE where the provider cannot tell (`ScmProvider.firstParentPath`, built for all four built-ins); freeze re-checks cached listings and a digest per checkpoint | `u8-review` › finding 3 (5); `pool-integrity` › rebuildRepo (7); e2e-gitlab FR7.2 test unchanged and passing | rewound `svc-08` head, 104 pushes dropped: PASS; single repo: PASS; an edited marker's head signed into the manifest | FAIL "…first-parent commit(s) after the frozen head are dated before the window closed: the frozen head is older than the window's landings"; edited marker listed again; a re-hashed one caught by verify |
| 4 | Any 403/404 while listing marks the whole repo unavailable (a forged head hides everything) | A repo is gone only after one repo-level probe (`ScmProvider.describeRepo`, by id) answers 404; a 404 on the frozen head or a sub-resource of a repo that exists FAILs ("frozen head … not found"); a 403 on the metadata is "no access" | `u8-review` › finding 4 (2); `pool-integrity` › rebuildRepo 404 cases | Bitbucket Cloud forged head: WARN "cannot rebuild", VERIFIED | FAIL "frozen head 000000000000… not found (HTTP 404 …); the repository itself exists" |
| 5 | `verify` says VERIFIED and exits 0 having rebuilt nothing | `CheckStatus` and the report gain INCOMPLETE; `verify` prints INCOMPLETE, never VERIFIED, and exits **6**; `--json` has `verdict` and `ok` is true only for VERIFIED; the check-5 details name each repo and why | `u8-review` › finding 5; `pooled-verify` › gone/unreadable tests; `net-io` › exit codes | SSO 403 everywhere: `population 0/0 match · 3,138 changes in 30 repo(s) could not be rebuilt`, WARN, `ok: true`, exit 0 | INCOMPLETE, exit 6, `verdict: "INCOMPLETE"`, `ok: false`; "no access: … HTTP 403" per repo, "cannot re-list …" |
| 6 | Rate limits classified as "repo unavailable" | `isRepoUnavailable` is false for a broker give-up, `rateLimited` or status 0; GitHub's 403 with a rate-limit body is transient; freeze stops with a resumable exit 4; verify is INCOMPLETE "could not be listed … a rate limit or an outage"; opt-in kit check `repo-unavailable` | `u8-review` › finding 6 (2); `list-repos` › secondary-limit 403, kit repo-unavailable (3) | `isRepoUnavailable(rate-limited 403)` true; freeze exit 1; verify WARN "cannot rebuild (403)", VERIFIED | false; freeze exit 4 with `--resume`; verify INCOMPLETE |
| 7 | An empty repo changes single-repo audits (N = 0 manifest, wrong note) | Providers throw `RepoEmptyError` with their existing messages; only a pool counts the repo as empty; verify's note says "empty", not "does not pin history" | `u8-review` › finding 7 (2); `pooled-api` › empty repo; `single-repo-anchor` | freeze exit 0 with an N = 0 manifest; note "provider github does not pin history" | `acme/widgets has no default branch`, nothing written (master's behaviour); pool note "1 repo(s) are empty" |
| 8 | A rename after freeze FAILs check 5 | repos are matched by id first, then by path; a renamed repo is rebuilt under its new name and compared under the manifest's; a list's repo (no id) is found through the probe's redirect | `u8-review` › finding 8 (2); `pool-integrity` › renamed (2) | FAIL | PASS, with "…is named … now (matched by repo id)" |
| 9 | A user-owned pool misses the user's private repos | GitHub lists `/user/repos?affiliation=owner` when the owner is the token's own account | `u8-review` › finding 9 | `/users/alice/repos` only: public repos | public and private |
| 10 | "A freeze finishing after R is refused" is not airtight | freeze refuses to start within the authorities' 5-minute retry deadline of R, checks again when the listing ends (single repos too) and right before it writes | `u8-review` › finding 10 (2); `timestamps-e2e` › U_k boundary (adapted) | started at R − 4 min and wrote; a single repo whose listing ran past R wrote its manifest | refused, nothing written |
| 11 | `startedAt` not covered by the run id; `markComplete` never read; dry-run text | the run id covers the start time and what the run recorded; `markComplete` removed; "Nothing was checkpointed (a dry run writes nothing)" | `u8-review` › finding 11 (2); `pooled-api` › store tests | an edited `startedAt` was resumed; a `complete` file; "The N repos listed are checkpointed" on a dry run | refused ("header is damaged or was edited"); no marker; the right text |
| 12 | status before freeze lists the whole pool; the created-after exemption is "no change now"; `ConformanceCheck` widened; erasable TS only indirect | status does not list a pool (it says what N costs); `RepoRef.createdAt` from the SCM decides the exemption; `ConformanceCheck` restored, `OptInConformanceCheck` separate; `tsconfig.sdk.json` (`erasableSyntaxOnly`) in `npm run typecheck`, and `src/sdk/http.ts` lost its parameter properties | `u8-review` › finding 12 (3); `list-repos` › exhaustive switch (compile-time) | one status call made 334 requests (the whole 30-repo pool); an imported-history repo FAILed; `pr-rla/http` refused by Node's type stripping (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) | 0 requests; PASS with the creation time; loads |
| clock | `fakeClock.run` threw when real I/O outlasted 50 loop turns | yields real time while no fake timer is pending; a hang only after 5 s; the `drive()` retry and the direct command calls are gone; the BLS blame corrected above | `fake-clock` (3) | "waiting on something other than the clock" | passes |

Tests that could not fail, made able to: **order** (`repo-set` › "the same pool in any order, finishing in any order…": three orders, three concurrencies, per-repo limitations and diagnostics; it fails when `assemblePopulation` does not sort, which it now does); **pool of one** (`repo-set` › "a single repo is a pool of one…": two repos take the pooled path, one empty); **P = 4** (`pooled-freeze` › six listed repos with 2 s of latency per request: exactly 4 in flight, and 1 with `freeze.concurrency: 1`); **FR5.5** (`pooled-freeze` › latency-bound at 1.5 s a request, the work and not the budget binding, measured latency 1500 ms; and a 240-repo org with every 1.2th repo probed); **realistic invisibility** (`pooled-verify` › a private repo left out of the listing and 404 everywhere, as GitHub hides it); **anchor** (`single-repo-anchor` builds `git archive $(git merge-base HEAD master)` into a temp dir and compares every command's result and stdout and the record bodies with this build; on `b76a9e4` it differs in the empty-repo scenario, which master stops on).

### Decisions and deviations

1. **The GitHub completeness proof.** Complete for private and internal repositories only when the token sends `X-OAuth-Scopes` including `repo` (a classic PAT or OAuth token, which no API can limit to selected repositories) and `GET /user/memberships/orgs/{org}` says `state: active`, `role: admin` (an owner, whom GitHub shows every repository of the org), or the owner is the token's own account listed through `/user/repos`. Sufficient: those two facts together leave no repository of the org unlisted. Why nothing weaker: an org member sees only the private repositories they were granted, and a fine-grained or GitHub App token can be restricted to selected repositories without any response saying so. Members are not accepted even for internal repositories (all enterprise members can read those), to stay on what a single response proves. Public is complete for any token.
2. **FR7.2 against "a window change reachable now but missing from the pinned rebuild is a FAIL" (partly declined).** FR7.2's pass criterion is that a commit pushed after freeze does not fail check 5, and without push times a merge after freeze looks like a hidden landing. The rule implemented: a pull request missing from the pinned rebuild always FAILs; a direct push FAILs unless every first-parent commit between the frozen head and the current head is dated at or after window close, in which case the work arrived after the window (a note says so, PASS); where the provider cannot report first-parent history it is INCOMPLETE. This keeps FR7.2's e2e test passing unchanged and FAILs the review's rewound head. It rests on committer dates, which the pusher sets; that is stated in `docs/security-model.md` and `docs/org-pooled-audits.md`. A commit dated in the window pushed straight onto the frozen head after freeze is a FAIL (its date puts it in the window); a `git pull` merge pushed after freeze whose first parent is fabricated history is read like any merge (stated).
3. **The registered set is recorded for every rule registration, retrospective too.** The brief asks for it on prospective audits; recording it on retrospective ones as well means an attribute changed after a retrospective registration also cannot remove a repo (the principle). What a retrospective audit still cannot detect, attribute changes before registration, gives the WARN with a count the brief specifies.
4. **A public-only rule warns for every never-public repo with window changes.** That follows the brief's rule literally (excluded only by a mutable attribute, changes in the window, not registered: WARN). It is noise for a team that never meant to audit private repos, but VERIFIED still prints.
5. **`ok` now means VERIFIED.** An INCOMPLETE report has `ok: false`, so a consumer of `--json` that reads `ok` does not mistake it for a verification (the review's `ok: true` case). `verdict` is new.
6. **Transient failures in verify are INCOMPLETE**, where master's single-repo verify threw the provider's error (exit 1). A non-transient listing error is a FAIL with the message (also exit 1).
7. **Lists record gone repos too.** A listed repo whose probe answers 404 is recorded in `goneRepos` and the freeze completes, where it used to fail the run. A repo in a rule's listing that answers 404 still fails the run (the listing and the probe disagree).
8. **Archived repos in the synthetic org hold no window change** (an archived repository is read-only). Before, they had window activity, which now WARNs correctly in every verify.

### Found while fixing (and fixed)

- **Only `code` crossed the plugin host.** `status` and `rateLimited` were lost, so a plugin's rate-limited 403 or a probe's plain 403 could not be classified. The IPC error message now carries both (additive to `pr-rla/ipc/v1`).
- **A stopped `freeze --force` printed a command that could not finish it** (`--resume` was refused because the old commitment exists, and `--force --resume` was refused as contradictory). It now prints `pr-rla freeze --force --resume <runId>`, which continues the run.
- **`assemblePopulation` depended on the order repos were given** (limitations and diagnostics by first appearance). It sorts by repo now.
- **A GitHub App installation token (`GITHUB_TOKEN`) cannot read `/user`.** `listingVisibility` and the user-pool check now treat that answer as "not proven" rather than an error, so such a token can still freeze and verify (INCOMPLETE for private and internal).
- **A repo of a registered list renamed after freeze** has no id to match by; its probe follows GitHub's redirect to the new path, and the rebuild follows it there (one rename, never a chain).
- **Five timing and filesystem flakes in older tests, met only with two or three suites running at once** (the machine's load average was 40 to 185 from other work; each failed the same way on `b76a9e4`, or in code this round did not touch):
  - `plugin-host` › "a slow call that keeps sending heartbeats is not stopped": a 500 ms silence timeout stopped the child. The call now outlasts a 5 s timeout (6.5 s), which still shows the heartbeats keep it alive.
  - `wave1-integration` › the Jira kit through the host: past the 60 s test timeout; 240 s now.
  - `e2e-gitlab` and `timestamps-e2e` (`cloneScenario`): `ENOENT … .git/objects` while copying an audit repo. git 2.55's `commit` starts `git maintenance run --auto --detach`, whose `objects/maintenance.lock` vanished mid-copy. The test repos now set `maintenance.auto=false` and `gc.auto=0` (`test/helpers/audit-scenario.ts`).
  - `timestamp-verify`: its `beforeAll` (test keys) passed vitest's default 10 s hook timeout; `hookTimeout` is now 60 s, as tests already had (`vitest.config.ts`).
  - `plugin-host` › the Gitea kit through the host: 30.3 s against a 30 s real-time bound that only has to show a 45 s rate-limit wait did not run in real time; the bound is 45 s.
- **The estimate's k-th sampling is coarse on heavy-tailed orgs.** Measured on six synthetic 40-repo orgs (2026-11-04): every 4th repo probed, requests off by up to −34.2%; every 2nd, up to −10.2% and wall time up to +57% when the budget binds. All probed: requests within ±5.2%, wall within ±28.6% (budget-bound) or ±11% (latency-bound). 200 of 240 probed: −3.1% and −13.2%. Recorded in the docs as a limit; not changed.

### Single-repo behaviour changes (all deliberate)

- A single repo deleted after freeze (or unreadable, or rate limited) makes `verify` INCOMPLETE (exit 6) with the reason; master threw the provider's error (exit 1). The anchor test asserts this is the only difference from master in its scenarios.
- A frozen head that hides window landings now FAILs check 5 for a single repo too (master trusted the head).
- A non-transient listing error in verify is a FAIL with the message in check 5 (master threw it; the exit code stays 1).
- `freeze` refuses within 5 minutes of R when timestamp authorities are configured, and refuses to write when its listing ran into R (master had neither check for single repos). The U1 boundary test in `timestamps-e2e` freezes just outside the deadline and re-signs a late commitment to keep testing check 2's boundary.
- `verify --json` has `verdict`; `ok` is false for INCOMPLETE (unchanged otherwise).

### For U7 (CI)

U7's CI exit-code mapping needs a row for **6**: fail when `fail-on` includes `incomplete`, which should be in the default, so an INCOMPLETE verify fails a CI job unless the workflow opts out.

### Tests

578 passed, 1 skipped (49 files) at `b76a9e4`; 647 passed, 1 skipped (52 files) now. New files: `test/u8-review.test.ts` (28), `test/pool-integrity.test.ts` (18), `test/fake-clock.test.ts` (3). Changed: `pooled-freeze` (+7), `pooled-verify` (+2), `pooled-api` (+2), `list-repos` (+10), `repo-set` (0 net, two rewritten), `pooled-plugin` (more assertions), `single-repo-anchor` (rewritten, one test), `net-io` (exit 6), `timestamps-e2e` (boundary adapted).

### Verified (command → output)

Each run is a fresh `git clone --branch bolt/u8-org-pooled-freeze` of this worktree into the scratch directory, then `npm ci && npm run build && npm run typecheck && npm test`, then `npm --prefix examples/providers/gitea ci && npm --prefix examples/providers/gitea test` and the same for `examples/ledgers/jira` (2026-11-04, UTC, at `ca94524`; the docs commit after it changes no code):

| Run | Clones at once | Load average | Result |
|---|---|---|---|
| 1 (05:29) | 1 | 160–185 | build and typecheck (both tsconfigs) clean; `Test Files 52 passed (52) · Tests 647 passed \| 1 skipped (648)`; gitea `# pass 1`, jira `# pass 1` |
| 2 and 3 (05:33) | 2 | 130–170 | the same, in both clones |
| extra (05:37) | 3, tests only | 100–150 | `647 passed \| 1 skipped` in all three |

The runs before these found the five flakes above, each fixed and committed before the streak was started again from new clones. `node dist/cli.js verify --help` ends with the exit codes line. The suite makes no network call (the network-deny harness).

### Files touched in this round

- Commands (thin): `src/commands/freeze.ts` (the R checks, two manifest fields, `markComplete` call removed, `reg` to the estimate), `src/commands/freeze-pool.ts` (registered repos and the clock to the run, notes printed, the resume and dry-run texts), `src/commands/register.ts` (`registeredRepos`), `src/commands/status.ts` (no pool listing before freeze), `src/commands/verify.ts` (verdict, exit 6, the INCOMPLETE line), `src/cli.ts` (help text for verify's exit codes).
- Core: `src/core/failures.ts` and `src/core/rebuild.ts` (new), `src/core/repo-set.ts`, `src/core/verify.ts` (check 2's repo rules, check 5, the verdict), `src/core/population.ts`, `src/core/records.ts`. API: `src/api/pooled-freeze.ts`, `src/api/freeze-store.ts`.
- SDK and plumbing: `src/sdk/provider.ts`, `src/sdk/http.ts`, `tsconfig.sdk.json`, `package.json` (typecheck script), `src/cli/exit-codes.ts`, `src/plugins/{protocol,child,host}.ts`, `src/testing/{conformance,index}.ts`, `src/index.ts`.
- Providers: `src/providers/github/{index,http}.ts`, `src/providers/gitlab/index.ts`, `src/providers/bitbucket-cloud/index.ts`, `src/providers/bitbucket-data-center/index.ts`, `src/providers/first-parent.ts` (new).
- Docs: `README.md`, `docs/org-pooled-audits.md`, `docs/security-model.md` (new section), `docs/writing-a-provider.md`, `docs/design/phase-3-4/contracts.md` (§1 SDK lines, §5 record fields, §7 exit 6 and `--json`).
- Shared test files outside U8 (timing and robustness only): `vitest.config.ts` (`hookTimeout`), `test/helpers/audit-scenario.ts` (git options), `test/plugin-host.test.ts` (two margins), `test/wave1-integration.test.ts` (one timeout), `test/timestamps-e2e.test.ts` (the U_k boundary test, adapted to the freeze deadline), `test/net-io.test.ts` (exit 6).
- For the integration step: U5 is moving commands into `src/api`; the six command files above change by a few lines each. U9 may touch `src/core/verify.ts` (check 7 is untouched; check 2 and check 5 changed) and `src/core/records.ts` (additions only).

### Unverified

- The GitHub visibility proof against live responses for an org owner and a fine-grained token (the shapes follow GitHub's documentation; the fakes reproduce them). No live call was made in this round.
- GitLab's `ref_name=<base>..<head>&first_parent=true`, Bitbucket Cloud's `commits?include=&exclude=` and Bitbucket Data Center's `commits?until=&since=` (Data Center unverified, like the provider) are built from the documented APIs and tested on hand-made responses only. GitLab, Bitbucket Cloud and Data Center have no `listingVisibility`, so a rule that admits private or internal repos is INCOMPLETE on them.
- Whether GitHub's compare API pages commits beyond 250 exactly as documented (the fake pages them; no live repo was compared).

## Plugin and broker fix round (2026-11-04)

Branch `fix/plugins-broker`, from master `4b72ecb`. It fixes findings 1, 3, 4, 5, 6 and 8 to 15 of the master review of the plugin system and fetch broker, closes the review's test gaps, and takes on two additions from the coordinator: finding 1 for the built-in providers and ledgers, and the two timing flakes. Findings 2 (registered plugin identity) and 7 (read-only contexts for verify and status) are left for the round after the other branches merge; freeze's and verify's identity comparison is unchanged.

Every finding has a regression test that fails on `4b72ecb` and passes here. "Before" was run by copying the new tests into a clone of `4b72ecb`. The reproductions import only what existed there, so they fail on their assertions, not on imports.

### Findings, commits and evidence

| Finding | Commit | Tests | Before (on `4b72ecb`) → after |
|---|---|---|---|
| 1. The repo's lock granted credentials and `trust: full` on every machine | `d18ce8f` | `test/local-consent.test.ts` (11) | The verifier's `Bearer ghp_VERIFIER_SECRET` and `Bearer AWS_VERIFIER_SECRET` reached `telemetry.auditee.example`. A hard-coded placeholder was `sent 200`. `verify` loaded a `trust: full` plugin in process (the review's PWNED.txt). → Nothing is sent. The child's environment is `PR_RLA_HOST` alone, a hard-coded placeholder gets `CREDENTIAL_NOT_APPROVED`, one line names `pr-rla plugin approve <use>`, and `trust: full` exits 1 (`NOT_APPROVED`) before import |
| 1, built-ins (the coordinator's addition) | `a528dbe`, `3ca3c66` | `test/builtin-consent.test.ts` (13) | `base_url: https://attacker.example` got `Bearer ghp_MINE`. `token_env: AWS_SECRET_ACCESS_KEY` sent `Bearer AWS_SECRET` to api.github.com. A self-managed GitLab got `Bearer glpat`. → All are anonymous, with one line each. The default github path keeps its token, and an approved GHES gets its token |
| 3. Dependency names widened the read grant | `f7a6b1b` | `plugin-host.test.ts` › finding 3 (6) | `optionalDependencies: {"../../..": "*"}` granted the child `.env`, `.pr-rla/` and `package.json` of the audit repo. → `PLUGIN_INVALID` / `TREE_ESCAPE` before anything is hashed, granted or run, in `plugin check` too |
| 4. Credentials bound to the hostname only | `e9281a9` | `broker.test.ts` › finding 4 (4), hostile `httpDowngrade`, `otherPort`, `redirectDowngrade` | `http://` got Basic auth, port 8443 got the token, and a 302 to http re-sent the Bearer. → `CREDENTIAL_HOST_MISMATCH`, nothing sent on the hop |
| 5. Swapped into any header; recorder and scrubber missed echoes | `0d2012a`, `302aa47` | `broker.test.ts` › finding 5 (3) and recorder; hostile `otherHeader`, `echoForms` | `X-Echo` carried the secret. The recording kept `landing?t=SECRET%2BTOKEN%2F123%3D`, and the child saw encoded echoes. → `CREDENTIAL_HEADER_NOT_ALLOWED`. Every form becomes the placeholder in the body, headers, status text and redirect URL |
| 6. GraphQL documents in the URL; method overrides | `dc35aaf` | `broker.test.ts` › finding 6 (4); hostile `graphqlPostUrl`, `graphqlGetMutation`, `methodOverride` | The requests were sent. → `READ_ONLY_VIOLATION` (or `WRITE_PATH_NOT_ALLOWED` for a ledger's override), unsent |
| 8. Identities scrubbed out of data | `302aa47` | hostile `identityEcho`, `identityAsToken` | Logins came back as `prrla-cred:GITHUB_USER`, `prrla-cred:GITHUB_USERa` and `bprrla-cred:GITHUB_USER`. → `alice`, `alicea`, `balice`. An identity used as a token gets `CREDENTIAL_IDENTITY_ONLY` |
| 9. Write paths were raw prefixes | `dc35aaf` | `broker.test.ts` › finding 9 | `/issueLink`, `/issuetype` and `/issue-archive` were written. → `WRITE_PATH_NOT_ALLOWED` |
| 10. Isolated plugins lost `acceptJson` | `e28de24` | `plugin-host.test.ts` › finding 10; › finding 15 (pr-rla/http) | `{"errors":["busy 1"]}` came back accepted. → Retried twice, then `{"data":{"ok":true}}` |
| 11. Oversize IPC refused only after full buffering | `e28de24` | › a message over the limit; › a frame header claiming 1 GiB | The 8 MiB result was refused only after parsing. A 1 GiB header hung until the test timed out (15 s). → Refused from the header at once, with under 64 KiB held |
| 12. Signals and path probing undocumented | `a01d4fc` | measured, docs only | `process.kill(pid, "SIGUSR2")` was delivered to a same-user process, and `fs.realpathSync(outside)` succeeded, on 22.23.2, 24.20.0 and 26.8.2 (macOS, 2026-11-04). Now stated in docs/security-model.md |
| 13. A plugin's sleep could keep pr-rla alive | `e28de24` | › finding 13 (3) | A 10 h sleep was served for `36000000` ms, a sleep after the call returned was served, and close() cancelled nothing. → Capped at 15 min, not served outside a call, aborted on close |
| 14. Unlocked in-process loads | `1995202` | `registry.test.ts` › finding 14 (2), `plugin-lock.test.ts` › finding 14 | An external `createProvider` imported the module, `freeze --dry-run` ran an unhashed `node_modules/pr-rla` in process, and `record-fixture --cli` imported the plugin. → `NOT_LOCKED` (with `unsafe*` names for tests and authors), `TREE_ESCAPE` before import, and the name comes from the lock |
| 15. pr-rla/http, `--plugins ""`, engines, plugin check | `970d7da`, `537c27c` | › finding 15 (pr-rla/http), `plugin-lock.test.ts` › typo, › finding 15 (2) | The child failed with `TypeScript parameter property is not supported in strip-only mode`, `tsc -p tsconfig.sdk.json` failed with 3 × TS1294, `--plugins ""` meant unset, and plugin check ran no kit for a ledger. → Passes on 22, 24 and 26, typecheck runs the SDK check, `--plugins ""` is refused, and the Jira example's recordings pass the ledger kit through the host |

Test gaps (`e28de24`, `59b4d15`):
- The UNVERIFIED test is now a skipped test with its reason in the title.
- The heartbeat test counts heartbeats the parent received.
- The size tests show the cap applies while reading.
- The hostile fixture tries http, another port, a downgrading redirect, an `X-Echo` swap, GraphQL in the URL, a method override, echo forms, identities and dependency names, on this Node and with Node 26 as the child.
- The plugin-lock test that pins finding 2 is unchanged and marked as the identity round's known gap.

Flakes (`dda13e1`, the coordinator's addition):
- The watchdog's heartbeat timeout now counts from `ready`. Start-up has its own `loadTimeoutMs`, 60 s by default, so the defaults are unchanged.
- The heartbeat tests take their pace from the contract's ratio, timeout = 6 × interval: 250 ms and 1.5 s.
- The Jira-through-the-host test starts fresh hosts ahead of need, at most three at once. Every kit instance still gets its own child, and the test went from 13–59 s to 6.9 s.
- Proof: `test/plugin-host.test.ts` and `test/wave1-integration.test.ts` ran 20 times in a row in a clone of `dda13e1`. Load averages were 35 to 214 on 10 cores while a second clone ran full `npm test` 22 times: **20 of 20 passed** (54 tests each). In the load clone, 21 of 22 full runs passed. The one failure was `timestamps-e2e.test.ts › cloneScenario` (`ENOENT … .git/objects`), the copy-a-temp-git-repo race in bolt 1's helper. It is outside this round, and U5's branch turns off git's auto maintenance in test repos.

### Decisions

1. **What an approval covers.** An approval is keyed by the plugin's use, its `treeSha256`, its trust, its exact grants (each env var, its https origins, any declared `headers`, and `secret: false`) and the lock's write paths. The brief named env vars and origins only. The rest is in the key because the lock is repo-controlled: an edited lock that marked a token `secret: false` would stop it being scrubbed, and wider write paths would let an approved token write where nobody approved. A load also refuses a definition that declares more headers, or an identity the lock lacks.
2. **`plugin lock` records an approval, as `plugin add` does.** Re-locking after a review is the same consent.
3. **Withheld means absent.** An unapproved credential gets no placeholder in the child, so a plugin runs exactly as if it were unset, anonymously. A placeholder written into the code gets `CREDENTIAL_NOT_APPROVED`. The broker never sees a value for it.
4. **The built-ins' grant is (env var, origin), shared by every built-in.** The defaults are each service's own public API: GITHUB_TOKEN and GH_TOKEN to `https://api.github.com` (GH_TOKEN is the provider's documented fallback), GITLAB_TOKEN to `https://gitlab.com`, and BITBUCKET_TOKEN and BITBUCKET_USERNAME to `https://api.bitbucket.org`.
   - A built-in's environment holds only the set variables approved for every origin they would go to; nothing else is copied in. If `token_env` is withheld, GitHub falls back to GITHUB_TOKEN for api.github.com, which is a default. `token_env` and `username_env` must be variable names, and `base_url`, `api_url` and `graphql_url` non-empty strings, so the table and the built-in always read them the same way.
   - `src/plugins/builtin-credentials.ts` mirrors each built-in's reads. A test runs every built-in on an environment that records each variable read, so the table cannot drift.
   - An `http:` origin is never approvable, not even with `--accept-lock-grants`.
5. **`plugin approve` has two shapes.** `plugin approve <use>` covers an external plugin, as its lock pins it, or a built-in, as the config's options make it send. `plugin approve --env <ENV> --origin <https-url>` covers one built-in grant without an audit repo. Without a terminal, both need `--yes`.
6. **The approvals file is located per key.** Each key is read from the context's env first, then from this process's environment. A test's env object therefore never reaches the real home: the test setup gives each test file its own `PR_RLA_APPROVALS_FILE`, and it fails if the real file's mtime changes. `~/.config/pr-rla` did not exist before this round and does not exist after it.
7. **Identities must be declared (finding 8).** The brief: "a Basic username is not secret unless the plugin marks it so." Inferring a username from its place in `prrla-basic:USER:TOKEN` would let a hostile plugin swap the two and read the password back unscrubbed. So `secret: false` is declared, shown at approval, and an identity may be only the user part. An undeclared credential is a secret. The Jira example marks JIRA_EMAIL and the hostile fixture marks GITHUB_USER. The built-in Bitbucket username is an identity, though that only matters to the recorder.
8. **A placeholder in an undeclared header is refused, not stripped (finding 5).** Refusal is visible to the plugin author. Fragments of a secret, and secrets the server hashes or transforms, are not scrubbed; this is documented.
9. **A method override must be allowed as every method named (finding 6).** A server may honour any of `X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override` and `_method`. GraphQL paths match in any case; a GraphQL GET with a query document stays a read, and a body item naming a stored document (`extensions`, `documentId`) is not one.
10. **IPC: bumped to `pr-rla/ipc/v2`, not kept additive (finding 11).** Node's channel cannot be capped while reading, so the framing changed: 4-byte length-prefixed JSON on fd 3, a plain pipe. Under `--permission`, `new net.Socket({ fd: 3 })` and `fs.writeSync(3)` work on 22, 24 and 26. The messages are v1's plus `accept` / `acceptResult`. The child flushes its load-failure frame before it exits.
11. **acceptJson is asked over IPC (finding 10).** `RetryHints.acceptJson` may now return a promise (additive within `HTTP_HELPER_VERSION` 1). Retry semantics and the 7-attempt cap stay the broker's.
12. **Sleeps (finding 13).** The cap is the SDK's own MAX_WAIT_MS of 15 min. A wait is cancelled when the calls end or the host closes. `AuditContext.sleep` and `CommandContext.sleep` take an optional AbortSignal, so the CLI's real timer is cleared too.
13. **Unlocked loads (finding 14).** The existing public names now load built-ins only, and the old behaviour moved to `unsafe*` names. `pr-rla` must resolve to the running pr-rla, or not at all, from a `trust: full` plugin's directory and every dependency's, through `node_modules` or package self-reference; I chose this over hashing a second copy. And every import a `trust: full` plugin's modules make must resolve to a hashed file: `src/plugins/inprocess-guard.ts` registers a `module.registerHooks` resolve hook (Node 22.15+, already the floor) that refuses anything else, such as an undeclared package found in an enclosing `node_modules` or a single-file plugin's sibling file.
    - A hashed tree is the plugin's root (or its one file) and each declared dependency's directory, minus the top-level `node_modules` and `.git` the tree hash skips. The running pr-rla counts only for its own `dist`, `src`, `node_modules` and `package.json`, so a checkout's tests, scripts and examples are outside. Guarding a plugin again (a re-lock in a long-lived process) replaces its guard.
    - The hook holds imports on pr-rla's thread. A worker the plugin starts, a process it forks and `createRequire` from a path outside its trees are not held to it, and neither is what the approved code reads and runs itself; the security model and the approval text say so. I did not try to close these: they are the plugin running code it chose, which is what `trust: full` approves.
    - Vitest resolves test imports itself, so the hook is tested in plain Node processes: the guard type-stripped from src/, on 22, 24 and 26, and the built CLI (skipped, with that reason, when dist/ is absent).
14. **Finding 15.**
    - `tsconfig.sdk.json` also covers `src/plugins/child.ts` and `protocol.ts`, which also run type-stripped. U8's round may add the same file; merge by union.
    - `plugin check` for a ledger runs the kit on recorded ledger fixtures, which are data. Cases that need a tracker to change between reads (erasure, publish) stay in the ledger's own test. An unconfigured ledger is asked with its first fixture's options.
    - The Jira recordings gained `expected` blocks, appended so the recorded bytes are untouched, and its package.json lists them.

15. **Finding 3's directory rule, for the plugin itself.** A dependency must be in a `node_modules` directory; the plugin's own package may be a link to a local directory (`npm install ../plugin`, which U2b supports with null integrity), but no resolved package may contain the audit directory.
16. **Fetches, like sleeps, are served only while a call is in flight,** and at most `MAX_PLUGIN_FETCHES` (64) at once, so a child cannot make the parent hold an unbounded number of 64 MiB requests.

### The independent review of this round

A read-only review of `4b72ecb..3ca3c66` found one HIGH, two MEDIUM and seven LOW problems in this round's own changes. All are fixed, each with a test that fails on the reviewed head (`abba094`) and passes after:

| Severity | Problem | Fix |
|---|---|---|
| HIGH | `token_env: ["AWS_SECRET_ACCESS_KEY"]` (a list; JavaScript reads `env[["X"]]` as `env.X`) with `base_url` at an attacker host sent the verifier's AWS secret there: the table skipped non-strings, and the built-in got the whole environment minus the withheld names. A list `graphql_url` or `base_url` split the table from the provider the same way | `f9c158a`: a built-in gets only its granted variables; non-string env and URL options are refused |
| MEDIUM | A single-file `trust: full` plugin's `import "pr-rla/x"` self-resolved to the audit repo's package.json named `pr-rla`; more generally, an import the plugin never declared (`import "yaml"`) resolved to unhashed code that could change after approval | `1b5592a`: package scope checked; then the in-process import guard (re-review) |
| MEDIUM | Only the first differing method override was checked (`HEAD` hid `DELETE`) | `f95715b` |
| LOW | `/GraphQL` passed as a read; stored documents in a POST body | `f95715b` |
| LOW | JSON-escaped echoes (`\/`, `\u003d`) and an error's `host`/`next` reached the child | `f95715b` |
| LOW | Approvals did not cover write paths | `1b5592a` |
| LOW | The child's frame reader was quadratic | `a9150d4` |
| LOW | Unbounded fetches in flight, and fetches outside a call | `a9150d4` |
| LOW | Linked local plugin packages refused (U2b supports them) | `a9150d4` |
| LOW | A load failure's last frame could lose the race with "exit" | `a9150d4`: "close" |

A re-review of `abba094..fdbc2bb` confirmed those fixes and found the general case of the self-reference problem: any undeclared import of a `trust: full` plugin ran unhashed code in process. `0e4c157` added the import guard (decision 13) and limited a read-only GraphQL body to the spec's keys.

A third review of `fdbc2bb..0e4c157` found four problems in the guard, all fixed in `6c5dfb3` and `235549e`, each with a test that fails on `0e4c157`:

| Severity | Problem | Fix and evidence |
|---|---|---|
| MEDIUM | A guarded tree counted as a whole directory, so an undeclared package in the plugin's own `<root>/node_modules` (which the tree hash skips) loaded | Trees exclude their top-level `node_modules` and `.git`. Before: `import "nested-undeclared"` → `LOADED`; after: `TREE_ESCAPE`, while a declared dependency still loads |
| LOW-MEDIUM | The docs said a full plugin's imports were held to its hashed files without saying the hook is per thread | Docs and the approval text: "on this thread"; workers, forks and `createRequire` from another path are outside |
| LOW | Guarding a plugin again appended the new guard, so an older, wider guard for it still matched first | The newest guard is consulted first and replaces one for the same tree. Before: re-guarded as its single file, the plugin still imported an unhashed sibling (`["LOADED","LOADED"]`); after: `["TREE_ESCAPE","LOADED"]` |
| LOW | Run from a checkout, the running pr-rla allowed the whole checkout | Only its `dist`, `src`, `node_modules` and `package.json`. Before: a plugin importing `test/fixtures/plugins/hostile/package.json` loaded under `freeze --dry-run`; after: `TREE_ESCAPE`, exit 1 |

### Verification

All on macOS (Darwin 25.6.0, 10 cores), 2026-11-04.

- **Fresh clones, three in a row, at `235549e`** (the last code commit; only this text follows it). Each clone ran `npm ci`, `npm run build`, `npm run typecheck` and `npm test`, then `ci` and `test` in `examples/providers/gitea` and `examples/ledgers/jira`. Every step exited 0 in all three, with 538 tests passing each time (06:48–06:50 UTC). Earlier heads had their own three green runs: `abba094` (529 tests) and `0e4c157` (536 tests).
- **Node 24.20.0 and 26.8.2**, full suite at `235549e`: 538 and 529 passed, 44 files. On 26 the second hostile block is not added, because the test's own Node is already 25+.
- **Test counts.** `4b72ecb` had 468 (467 passed and 1 skipped, 42 files). This branch has 538, in 44 files, with none skipped on this machine.
- **Flake proof (the coordinator's addition).** `test/plugin-host.test.ts` and `test/wave1-integration.test.ts` ran 20 times in a row in one clone, while a second clone ran full `npm test` back to back:

  | Head | Both files | Load average | Full `npm test` in the second clone |
  |---|---|---|---|
  | `dda13e1` | 20 of 20 (54 tests each) | 35–214 | 21 of 22 |
  | `fdbc2bb` | 20 of 20 (60) | 20.5–71.5 | 21 of 21 (534) |
  | `235549e` | **20 of 20** (60) | 10.7–27.7 | 18 of 21 (538) |

  Every failure in the second clone, one at `dda13e1` and three at `235549e`, was the same: `ENOENT … prrla-tamper-*/.git/objects` from `cloneScenario` in `test/helpers/audit-scenario.ts`, which this round does not touch. The three at `235549e` were in e2e, timestamps-e2e and e2e-gitlab.
- **Engines.** I downloaded 22.14.0 and 22.15.0. On 22.14.0, `plugin check` exits 1 with "needs Node 22.15 or later". On 22.15.0 it passes, and so does `scripts/demo-plugin-host.mjs`.
- **The real approvals file.** `~/.config/pr-rla` did not exist before this round and still does not; every test used its own temp approvals file.

### Unverified

- Linux and Windows (the permission-model and pipe behaviour were measured on macOS only); Node 25.x itself (26.8.2 stands in, as in bolt 4).
- Node 22.15–22.17 running from source (type stripping is unflagged only from 22.18); the package runs from `dist/`, which 22.15.0 ran.
- A real GHES, GitLab self-managed or Bitbucket Data Center with an approved token: fakes only, no live call was made in this round.
- `npm audit signatures` in `plugin check` (always `--offline` here).
- The in-process import guard is tested against Node's resolver on this thread. Workers, forked processes and `createRequire` from another path are outside it by design (decision 13) and are not tested.
- `cloneScenario`'s copy of a temp git repo races git's own object writes under load (see Verification). That helper is bolt 1's, and U5's branch turns off auto maintenance in test repos. Not fixed here.

### Files touched (for the merge)

- New: `src/plugins/approvals.ts`, `src/plugins/approve.ts`, `src/plugins/builtin-credentials.ts`, `src/plugins/inprocess-guard.ts`, `src/net/scrub.ts`, `tsconfig.sdk.json`, `test/local-consent.test.ts`, `test/builtin-consent.test.ts`, `test/setup/approvals.ts`.
- Plugin system: `src/plugins/{host,child,protocol,open,lock,identity,check,errors}.ts`.
  - **U5** added `withPluginHostScope` / `livePluginHosts` to `host.ts`. They are independent of this round's changes but in the same file.
  - **U8** added `estimateRequests` to `child.ts`, `protocol.ts` and `host.ts`. Its method-list lines are near but not in this round's hunks; the frame codec is new code.
- Broker: `src/net/broker.ts`, `src/net/contract.ts` and `src/net/graphql.ts` (path case; a body is a read only with the spec's `query`, `operationName` and `variables` keys). **U8** adds `stats` in `attempt()` around `send()`; this round changed the same function's guard, swap and redirect lines, so expect a small manual merge there.
- SDK: `src/sdk/http.ts` (`HttpError`, the `HttpClient` constructor, `RetryHints.acceptJson`, `checkJsonBody`). **U5** changed `RequestOptions`, `request()` and `getText` next to the constructor. `src/sdk/provider.ts` and `src/sdk/ledger.ts` gained the credential `headers` and `secret` fields (U5, U8, U9 and fix/ledgers-selector also touch these files).
- API and CLI:
  - `src/api/context.ts`: `consent`, `builtinEnvironment`, the abortable sleep, grant host normalisation.
  - `src/registry.ts`: the `unsafe*` loaders, `providerNameOf`.
  - `src/index.ts`: two export lines (U8 adds lines nearby).
  - `src/provider-traits.ts` and `src/ledger-traits.ts`: parameter types.
  - `src/cli.ts`: `--accept-lock-grants` and `plugin approve`.
  - `src/commands/context.ts` (`acceptLockGrants`, the abortable sleep) and `src/commands/plugin.ts` (approvals in add and lock, approve, the ledger kit in check). **U5** moved both into `src/api/session.ts` and `src/api/write/plugin.ts` / `src/api/plugin-check.ts`, so port these hunks there.
  - `src/commands/{verify,record,freeze,checkpoint,register}.ts`: `auditContextFor(ctx).plugins` → `auditContextFor(ctx)` in ten calls, so a `trust: full` identity read carries consent. U5 moved those calls into `src/api/write/*` and `src/api/read/*`, so port them there. A missed one fails closed: a `trust: full` plugin refused.
- Tests: `test/{plugin-host,plugin-lock,broker,registry,wave1-integration,e2e-u3,jira-example,gitea-example,github-issues-ledger,gitlab-issues-ledger}.test.ts`, `test/helpers/plugin-lock.ts` (`approve` option), `test/fixtures/plugins/hostile/index.mjs`, `vitest.config.ts` (one setup file).
- Examples: `examples/ledgers/jira/index.mjs` (`secret: false` on JIRA_EMAIL, in the definition's credentials, below fix/ledgers-selector's hunks), `examples/ledgers/jira/package.json`, and both Jira recordings (an appended `expected` block; fix/ledgers-selector edits their `options` and `index` near the top).
- Scripts: `scripts/record-fixture.mjs`, `scripts/demo-plugin-host.mjs`.
- `package.json` (`typecheck`, `engines >=22.15`), `package-lock.json` (engines only).
- Docs: `docs/security-model.md` (inside the plugin section, above the last lines U5 and U9 append after), `docs/design/phase-3-4/contracts.md` §§1, 2, 3, 5, `docs/writing-a-provider.md`, `README.md` (two lines).

### For the identity round and the integration

- Finding 2's test in `plugin-lock.test.ts` is marked. Finding 7 still holds after this round, as noted at the end of this list.
- Approvals are keyed by `treeSha256`, so the identity round's "freeze refuses a swapped provider" composes with them. A swapped plugin is a new tree, and it is unapproved on every machine but the one that locked it.
- Every commands-layer call that reads a `trust: full` plugin's identity must pass the AuditContext, not `.plugins`.
- Finding 7: a verify still opens a read-write broker. With this round, a verifier's credentials are withheld unless approved, but an approved ledger can still write under its writePaths during verify.

## Bolt 6 (U5): the audit API, draw-context and the MCP server (2026-11-04)

Goal (delivery-plan.md, bolt 6): every command through `src/api`, with the CLI as a formatter; the read-only subpath `pr-rla/api/read` and its import-graph guard; `drawContext` and `pr-rla draw-context <n>` with the untrusted-content fence; `describeChange` on the built-in providers; the separate `pr-rla-mcp` package with eight read-only tools, jobs and memory bounds. FR3.1–FR3.6, FR3.9 and NFR10.

Built on branch `bolt/u5-audit-api-mcp` from master at `a360348`, in parallel with U8 (org-pooled freeze) and U9 (presence-attested verdicts). The integration notes at the end list what moved where.

### Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR3.1 a stdio MCP server, a separate `pr-rla-mcp` package, exposes exactly the eight read-only tools; issuing draws stays CLI-only | met | `packages/pr-rla-mcp/test/mcp-readonly.test.mjs › the tool list › is exactly the eight read-only tools…` (names, `readOnlyHint`, `destructiveHint: false`, `openWorldHint` per tool, strict input schemas, output schemas; `record`, `sample`, `register`, `freeze`, `checkpoint` and `publish_draws` are not tools); `mcp-package.test.mjs › pins every dependency…` (pr-rla linked, released with the same version) |
| FR3.2 the server writes nothing: no file, no ledger event, no non-read request; state in memory | met | `mcp-readonly.test.mjs › after every call: nothing written, nothing but reads sent` (tree hash of every audit directory, `.git` included, unchanged; no write attempt under the permission model with a preloaded write guard; the mock SCM saw only GETs and GraphQL queries; no socket beyond loopback); `test/api-read.test.ts › pr-rla/api/read reads only › every read function leaves the audit directory byte-identical`; `test/api-read-boundary.test.ts` (the import graph) |
| FR3.3 no tool, prompt or skill records, edits or removes a verdict, issues draws or submits | met for the MCP surface (the skill is U6's) | the tool list above; `› the server never asked the client for input (no elicitation)`; `test/api-read.test.ts › write functions refuse a read-only context (READ_ONLY_VIOLATION)…` |
| FR3.4 `draw_context` returns the diff with `linguist-generated` files dropped under `exclude_generated`, the description, CI results, the protocol checklist and the verdict state, and backs `pr-rla draw-context <n>` | met, on a recorded gh-aw draw | `test/draw-context.test.ts › drawContext on the recorded gh-aw audit › draw #7 (github/gh-aw#42597): the two lock files are dropped…` and `› draw #13 … 21 of 28 files are linguist-generated and dropped`; `› pr-rla draw-context 7 prints the core's text, and --json the same object as the API`; `mcp-readonly.test.mjs › draw_context: draw #7's lock files are gone…` |
| FR3.5 long calls report progress and return within 30 s, or a job handle; `job_status` says unknown after a restart; a finished preview is cached in memory for 10 minutes | met (hand-off shortened in the tests) | `mcp-jobs.test.mjs › the hand-off…` (draw_context: a progress notification before the hand-off, then `{ jobId }`, `job_status` running then done; freeze_preview and online verify hand off too); `› after a restart, job_status answers unknown and says to run the tool again`; `› freeze_preview's cache…` and `test/api-read.test.ts › freezePreview: … a repeat within 600 s comes from the cache…` |
| FR3.6 the same server in Claude Code, Codex and Cursor, checked by hand | **not in this bolt**: the founder's manual runs (U6) | the server speaks both the 2025 handshake and the 2026-07-28 revision: `mcp-readonly.test.mjs › both protocol eras` |
| FR3.9 text from the SCM is marked untrusted wherever `draw_context` hands it to an assistant | met | `test/draw-context.test.ts › the draw context, as the core builds it › puts the author's title, body, patches and checks inside one fence…`, `› a hostile body that forges an end marker or instructions does not leave the fence`, `› each call draws a new 128-bit fence`; `mcp-readonly.test.mjs › a change whose text tries to steer the assistant stays inside the fence`, `› … the core's fence is passed through as is` |
| Every command runs through `src/api`; write functions refuse read-only mode with `READ_ONLY_VIOLATION`; API functions return the `--json` objects | met | the command table below; `test/api-read.test.ts › API functions return the same objects as --json` (status in every phase, verify, freeze --dry-run, simulate) and `test/draw-context.test.ts` (draw-context); `› write functions refuse a read-only context…` (register, freeze, sample, record, checkpoint, init, plugin add, plugin lock; the tree is unchanged) |
| `pr-rla/api/read` holds only the seven read functions, fixed to read-only; the import-graph guard passes | met | `test/api-read-boundary.test.ts` (6 tests: the exports at runtime; no `src/api/write/`, git transport, command or CLI module reachable; no writer imported by name; every module in the graph that can write a file is on a reasoned list; the write side is reachable from the CLI, so the guard is not vacuous). A planted `import { writeJson } from "../write/files.js"` in `src/api/read/draws.ts` failed three of the six |
| `freeze_preview` read-only: never FreezeCheckpointStore or `.pr-rla/cache`, in-memory cache for 600 s by (window, registration digest, `estimate`) | met for what exists in this build (U8 brings the store and the estimate) | `test/api-read.test.ts › freezePreview › writes nothing: no manifest, no key, no cache file…`; the cache tests above |
| `mcp-readonly.test.ts`: every tool with valid and hostile inputs; tree hash; no file opened for writing; zero non-read requests | met (`mcp-readonly.test.mjs`, node:test in the package) | 25 tests; hostile inputs: `..` paths, `/etc`, a directory outside the roots, a symlink out of a root, a config whose `protocol:` points outside, missing audits, path-like windows, draws 0, −1, 1.5, 37, 144, 145, 1e9, `maxPatchBytes` over 1 MiB and negative, limits over 200, a string draw with shell text, NUL bytes, extra keys, a 500-element argument, `runs` over 20,000, `defects` over `population`, `p1` above `p0`, an empty and an oversized `jobId` |
| NFR10 on fixtures, offline: `status` < 1 s, `verify` < 2 s at N ≤ 10,000, `draw_context` < 2 s, MCP start < 2 s | met | `test/api-read.test.ts › NFR10 on fixtures…` (N = 10,000: status 21 ms, verify 140 ms in the clean clone); `test/draw-context.test.ts › is under 2 s offline on the recorded draws (NFR10), every one of the 36` (500 ms for all 36); `mcp-package.test.mjs › starts in under 2 s when installed (NFR10), under the permission model` (330 ms). Live GitHub, as an observation: 3.4 s (below) |
| NFR20 at most 4 concurrent jobs; a result over 8 MiB refused; finished jobs dropped after 600 s | met | `mcp-jobs.test.mjs › at most four long calls at once`, `› a result over 8 MiB is refused` (returned directly, and as a job, which keeps no result), `› a finished job is dropped after 600 s; a running one is kept`, `› the default limit is 8 MiB` |
| NFR15 atomic writes, NFR16 exit codes, NFR17 the error form (U5's rows in nfr-requirements.md) | met | `test/api-cli-contract.test.ts` (a writer SIGKILLed part-way through a large atomic write leaves the old or the new file, never a part, at least one kill landing mid-write; `init` writes atomically now; `draw-context` exit codes; errors as a sentence and `next:` on stderr, or `{ "error": { code, message, host?, next? } }` on stdout with `--json`) |
| NFR2 no token in MCP results | met | `mcp-readonly.test.mjs › no result carried a token from the server's environment` |
| The existing CLI suite passes unchanged in behaviour | met | the 467 tests of master pass; no existing test file changed. Two helpers changed: `test/helpers/audit-scenario.ts` runs git with `maintenance.auto=false` (finding 4), and `test/helpers/replay-fetch.ts` serves non-JSON bodies |
| Demo: `draw_context` on a recorded gh-aw draw through a real MCP client session; the audit directory's hash unchanged | met | `node packages/pr-rla-mcp/scripts/demo-draw-context.mjs` (below) |

### Done

| Piece | Where |
|---|---|
| The audit API's context and readers (`ApiContext`, one AuditContext per call, `configFor` with a window and the `confine` hook, the record readers, `getBeacon`, `trustFor`), its error (`AuditError`, with an exit code, a code and `next`) | `src/api/session.ts`, `src/api/errors.ts` |
| Read functions: `status`, `verify`, `planFreeze` / `freezePreview` / `freezePreviewKey`, `draws`, `drawContext`, `auditList`, `simulate`, the checkpoint readers | `src/api/read/` |
| Write functions: `register`, `freeze`, `sample`, `record`, `checkpoint` (with `buildCheckpoint`, `appendCheckpoint`), `initAudit`, `preparePluginAdd` / `preparePluginLock` / `commitPluginLock`, `obtainTimestamps`, the Rekor submissions, `writeJson`; each refuses a read-only context first | `src/api/write/` |
| `checkPlugin` (writes nothing, not a read-subpath function) | `src/api/plugin-check.ts` |
| The read-only subpath: seven functions on read-only contexts, a caller session shares one broker per audit directory, a caller-held preview cache, each call's notes routed by AsyncLocalStorage, each call's plugin hosts stopped when it ends | `src/api/read/index.ts`, `package.json` (`./api/read`), `withPluginHostScope` in `src/plugins/host.ts` |
| The CLI as formatters; `--json` prints the result object; errors print in the contract's JSON form with `--json` | `src/commands/*.ts`, `src/cli.ts` |
| `describeChange` in the SDK (`ChangeDescription`, `changeDescriptionProblems`) and on GitHub, GitLab, Bitbucket Cloud, Data Center and json-file (`descriptions` in the export) | `src/sdk/provider.ts`, `src/providers/*/describe.ts`, `src/providers/diff.ts`, `src/providers/json-file.ts`; `HttpClient.getText` in `src/sdk/http.ts` |
| `linguist-generated` from `.gitattributes` (gitattributes(5) patterns, macros, last line wins) | `src/core/generated.ts` |
| The draw context and its fence, built by the core | `src/core/draw-context.ts`, `src/api/read/draw-context.ts`, `src/commands/draw-context.ts` |
| `pr-rla-mcp`: the server, jobs, roots, errors, the bin; its README; tests; the demo | `packages/pr-rla-mcp/` |
| The recorded gh-aw audit and its builder; recorders for describeChange | `test/fixtures/audits/gh-aw-q3-recorded/`, `scripts/build-gh-aw-recorded-audit.mjs`, `scripts/record-draw-descriptions.mjs`, `scripts/record-describe-change.mjs` |
| Docs | `README.md` (quickstart line, the `pr-rla/api/read` export, a section for assistants), `docs/security-model.md` (the assistant section), `docs/writing-a-provider.md` (describeChange), `docs/providers/*.md` (each provider's draw context) |
| Tests: 79 new at the root, 42 in the package | `api-read` 22, `describe-change` 19, `draw-context` 25, `api-read-boundary` 6, `api-cli-contract` 6, `draw-context-plugin` 1; `mcp-readonly` 25, `mcp-jobs` 11, `mcp-package` 6 |

### Command files: where the logic went (for the integration)

| Command file on master | Its logic is now in | What the command file keeps |
|---|---|---|
| `src/commands/context.ts` | `src/api/session.ts` (context, readers, `configFor`, `providerFor`, `ledgerFor`, `getBeacon`, `trustFor`, `fmt`, `isoNow`, `pct`), `src/api/write/files.ts` (`writeJson`), `src/api/errors.ts` | `CommandContext` (= `ApiContext` + `out`), `CommandError` (extends `AuditError`), `nodeContext`, and re-exports of the moved helpers |
| `status.ts` | `src/api/read/status.ts` (`status`, `timeStanding`, `statusLine`, `stratumChoices`, `ledgerStatus`) | `statusCommand` (with `--checkpoint`), `printStatus`, `statusExitCode`; re-exports |
| `verify.ts` | `src/api/read/verify.ts` (`verify`, the check-5 identity WARN) | `runVerify` (the API), `verifyCommand`, `printVerify` |
| `freeze.ts` | `src/api/read/freeze-preview.ts` (`planFreeze`, the shared steps; `freezePreview`; `summarizeFunnel`, `summarizePopulation`), `src/api/write/freeze.ts` (`freeze`) | `freezeCommand` (dry run, `--out`, `--json`), `printPopulation`, `freezeExitCode`; re-exports |
| `register.ts` | `src/api/write/register.ts` (`register`, `preflightLedger`, `REREGISTER_COMMAND`) | `registerCommand`, `printRegistrationPlan` |
| `sample.ts` | `src/api/write/sample.ts` | `sampleCommand` (the lines and exit codes 2 and 3) |
| `record.ts` | `src/api/write/record.ts` | `recordCommand` (the lines) |
| `checkpoint.ts` | `src/api/write/checkpoint.ts` (`checkpoint`, `buildCheckpoint`, `appendCheckpoint`); readers in `src/api/read/checkpoints.ts`; `src/api/checkpoint.ts` is now a barrel of both, kept for U4's imports | `checkpointCommand` (the lines, exit 4 on a stopped push) |
| `simulate.ts` | `src/api/read/simulate.ts` | argument parsing and the lines |
| `init.ts` | `src/api/write/init.ts` | the lines |
| `plugin.ts` | `src/api/write/plugin.ts` (add and lock, prepared then committed), `src/api/plugin-check.ts` | the trust text, the confirmation and the lines |
| `timestamps.ts` | `src/api/timestamps.ts` (`assessRecord`, `timestampingFor`), `src/api/write/timestamps.ts` (`obtainTimestamps`) | `reportTimestamps` (the outcome table's lines and exit code); re-exports |
| `translog.ts` | `src/api/translog.ts` (`logPublicKey`), `src/api/write/translog.ts` (`rekorApi`, `submitUrl`, `submitSigned`, `submitSignedV2`) | `confirmRekorV2` (the warning and the question); re-exports |
| (new) `draw-context.ts` | `src/api/read/draw-context.ts`, `src/core/draw-context.ts` | the text or JSON output |

The write functions that print part of their output before a side effect take a hook at that point, so the CLI prints the same lines in the same order as on master: `register(…, { onPlanned, confirmRekorV2 })`, `freeze(…, { onPopulation, confirmRekorV2 })`, `checkpoint(…, { onAppended })`.

### Live reads (all read-only; 2026-11-04)

| When (UTC) | What | Requests |
|---|---|---|
| about 01:40 | npm registry: `npm view` and `npm pack` of `@modelcontextprotocol/server`, `client`, `core` 2.4.0 (published 2026-10-23), `@modelcontextprotocol/sdk` 1.32.2 and `zod` (4.6.7), to read the SDK's types | registry GETs |
| 02:20 | `gh api rate_limit`; `gh api repos/github/gh-aw/contents/.gitattributes` | 2 |
| 02:21:27 to 02:22:27 | describeChange for the 36 issued draws of the recorded gh-aw audit (36 distinct PRs), GitHub REST with the founder's `gh` token, through pr-rla's broker in read-only mode (`scripts/record-draw-descriptions.mjs`) | 180 GETs; the recording keeps 20 of them (4 PRs), and all 36 descriptions are in the audit's `changes.json` |
| 03:04:25 to 03:04:29 | the live demo: `draw_context` on draw #13 (github/gh-aw#49685) through pr-rla-mcp, built-in `github` provider | 5 GETs, 3,432 ms for the tool call |
| 03:10 to 03:17:30 | anonymous probes of gitlab.com (gitlab-org/cli !4191, its diffs, pipelines) and api.bitbucket.org (atlassian/bamboo-specs pull requests, #745, a commit); then the recordings of describeChange on !4191 and #745 (`scripts/record-describe-change.mjs`) | 7 probe GETs; 4 + 7 recorded GETs |

No write to any repo, tracker, registry or log; no scratch repo; nothing pushed. The token was used for GitHub reads only. E-mail addresses in recorded text are replaced by `user-<hash>@example.invalid` (none occurred).

### Fixtures

| Fixture | Source | What it is |
|---|---|---|
| `test/fixtures/audits/gh-aw-q3-recorded/` | recorded population and beacon; synthetic times, key and protocol | A retrospective audit of the gh-aw Q3 2026 Copilot stratum: the 1,589 changes the phase-1 read-only dry run selected (2026-11-03T14:27Z to 14:49Z), registered, frozen and sampled offline on a fake clock with the recorded drand round 33,245,812 (`scripts/build-gh-aw-recorded-audit.mjs`). No authority, no log, no verdicts. `changes.json` also holds the recorded descriptions of the 36 issued draws. Its README says which part is which |
| `test/fixtures/github/gh-aw-q3-draws-2026-11-04.json` | recorded | GitHub's responses for describeChange on draws 5, 7, 13 and 31 (github/gh-aw #43382, #42597, #49685, #47149) |
| `test/fixtures/gitlab/describe-gitlab-org-cli-4191-2026-11-04.json` | recorded (anonymous) | GitLab's responses for gitlab-org/cli !4191 |
| `test/fixtures/bitbucket-cloud/describe-bamboo-specs-745-2026-11-04.json` | recorded (anonymous) | Bitbucket Cloud's responses for atlassian/bamboo-specs #745, two of them 302s |
| Fakes in `test/describe-change.test.ts`, the mock GitHub Enterprise Server and the in-process recorded fetch in the package's tests | synthetic, from the documented shapes and the recordings | pagination, direct pushes, 404s, every status mapping, Data Center entirely |

### Verified (command → output)

From a fresh `git clone` of the branch at `761a1b2`, 2026-11-04T03:31:37Z, Node 22.23.2:

```
npm ci                                       → added 60 packages … found 0 vulnerabilities
npm run build                                → exit 0
npm run typecheck                            → exit 0
npm test                                     → Test Files 48 passed (48) · Tests 546 passed | 1 skipped (547)
npm --prefix packages/pr-rla-mcp ci          → added 19 packages … found 0 vulnerabilities
npm --prefix packages/pr-rla-mcp test        → # tests 42 · # suites 12 · # pass 42 · # fail 0
npm --prefix packages/pr-rla-mcp ci --offline (node_modules removed first) → added 19 packages … found 0 vulnerabilities
npm --prefix examples/providers/gitea ci     → found 0 vulnerabilities
npm --prefix examples/providers/gitea test   → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm --prefix examples/ledgers/jira ci        → found 0 vulnerabilities
npm --prefix examples/ledgers/jira test      → ok 1 - the ledger kit: recorded hibernate.atlassian.net changelogs and a synthetic Jira Cloud · # pass 1 · # fail 0
npm ls --prod --depth=0                      → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1 (no new dependency)
npm --prefix packages/pr-rla-mcp ls --prod   → @modelcontextprotocol/server 2.4.0, pr-rla 0.1.0 -> ./../.., zod 4.6.7
```

- 547 = the 468 of master (467 passed, 1 skipped: U2b's `UNVERIFIED` RK-02 placeholder, skipped because the RK-02 test ran on Node 26.8.2 found on PATH), unchanged, plus 79 new. The package's 42 are new.
- The root suite also passes on Node 24.20.0 (546 passed, 1 skipped) and Node 26.8.2 (541 passed, 1 skipped: the second hostile block is not added on Node 25 or later, as in bolt 4). The package's 42 pass on Node 22.23.2, 24.20.0 and 26.8.2.
- `npm test` makes no network call: the root suite runs under the network-deny harness; the package's server processes run with a guard that refuses every socket beyond loopback, and none was refused.
- No LICENSE file; both `package.json` files are `"private": true, "license": "UNLICENSED"`.

### The demo

`node packages/pr-rla-mcp/scripts/demo-draw-context.mjs 13`, in the clean clone (offline; the fence and the patches trimmed here):

```
pr-rla-mcp 0.1.0 over stdio, started in 330 ms (node --permission, no fs-write grant)
tools: audit_list (readOnly), status (readOnly), draws (readOnly), draw_context (readOnly), verify (readOnly), simulate (readOnly), freeze_preview (readOnly), job_status (readOnly)

draw_context { draw: 13 }  recorded (json-file export) · 64 ms
  github:github/gh-aw#49685 · https://github.com/github/gh-aw/pull/49685
  files shown 7 (+49 −35) · linguist-generated dropped 21: .github/workflows/api-consumption-report.lock.yml, .github/workflows/audit-workflows.lock.yml, .github/workflows/copilot-pr-nlp-analysis.lock.yml, …
  checks {"success":1} · protocol is the registered one · state unlabelled
    | pr-rla draw-context · window 2026-q3 · draw #13 of 36 issued
    | the change FAILS if any of these holds:
    |   [ ] 1. It introduces a bug a user or another developer would hit (wrong result, crash, data loss).
    | <<<UNTRUSTED-CHANGE-CONTENT 9669324c5bd0ff95dd706934511f13c5>>>
    | title: fix: move Python venv out of agent artifact upload path to restore MC
    | …
    | <<<END 9669324c5bd0ff95dd706934511f13c5>>>
    | record the verdict yourself: pr-rla record 13 pass|fail --reviewer <you> --note "<one line>", then commit audit/2026-q3/verdicts.jsonl

audit directory …/test/fixtures/audits/gh-aw-q3-recorded
  tree hash before b6af9c787e3b88a2e3d79cc071233aefafcdbcabafc6f582c75684646508d102
  tree hash after  b6af9c787e3b88a2e3d79cc071233aefafcdbcabafc6f582c75684646508d102  (unchanged)
  write attempts by the server: 0 · sockets beyond loopback refused: 0
```

With `--live` (2026-11-04T03:04:25Z, the founder's token, a copy of the audit on the built-in `github` provider) the same draw came from api.github.com in 3,432 ms with the same files, checks and dropped lock files, and the copy's tree hash was unchanged.

### Deviations from the design, and why

1. **`--json` prints the API's result object, and only that.** `status --json` printed JSON only once a window was sampled and a text line before that; it now prints the phase's result object in every phase, with the same exit code as the text form (the sampled-phase refusal now exits 3 there too; master exited 0 or 2 with `--json`, a path a real audit cannot reach because `sample` refuses first). `freeze --json` (not a dry run) printed the population as JSON and then the text lines; it now prints the freeze result alone. The `--json` dry run and `status --json` once sampled are supersets of master's objects (fields added: compatible under contracts.md §7). No test used `--json`.
2. **Errors with `--json`** now print `{ "error": { code, message, host?, next? } }` on stdout (contracts.md §7, which U5 owns); without `--json` they are as before. `code` is pr-rla's (`NO_AUDIT`, `DRAW_OUT_OF_RANGE`, a broker or plugin code), `FAILED` when there is none.
3. **`freeze_preview`'s `estimate` is refused with `UNSUPPORTED`**, a code contracts.md §4 does not list. The estimate is U8's (`--estimate`, built in parallel), and a full listing in its place could run for 22 minutes against the caller's budget. Remove the code when `freezePreview` calls U8's estimator.
4. **Progress after the hand-off goes to `job_status`, not to notifications.** MCP allows a progress notification only while its request is open, and the hand-off ends the tool call. Before the hand-off, the API's progress and the providers' log lines go out as `notifications/progress` when the client sent a progress token.
5. **`TOO_MANY_JOBS` counts long calls still in their tool call**, not only handed-off jobs: at most four network-capable calls run at once, so four calls cannot all hand off and make a fifth job. Offline calls (status, verify offline, draws, audit_list, simulate, job_status) are not counted.
6. **Malformed arguments are the MCP SDK's own input errors** (`isError` with "Input validation error: …"), not one of the contract's codes, which have none for them: the strict schemas bound every number and string, refuse extra keys, and the server caps an argument payload at 64 elements.
7. **`status` offline with a tracker ledger reports `verdictsRead: false`** and no verdict state, for the MCP tool (offline by default; the design's `openWorldHint` is false offline). The CLI's `status --offline` is unchanged: it skips only the provider and still reads the tracker. `draws` never reads a tracker (its `openWorldHint` is false) and gives `state: null` there; `draw_context` reads it.
8. **`untrusted` holds everything from `describeChange`**: title, body, every file with its patch, the generated files' names and the CI checks, because file and check names come from the change too (FR3.9 says text from the SCM). The trusted part has pr-rla's counts (`summary`) and the manifest's fields. The text shows the protocol's checklist, not its full text (that is in `protocol.text`).
9. **Patches within `maxPatchBytes` are whole**, in file order: a patch that does not fit the remaining budget is left out (`patchOmitted`, counted in `omittedBytes`), and later smaller ones may still fit. None is cut mid-hunk. The description is cut at 8 KiB of UTF-8 on a character boundary.
10. **Only the root `.gitattributes`** at the landed commit is read (describeChange returns one), with gitattributes(5) patterns, macros and last-line-wins. Attribute files in subdirectories and Linguist's own heuristics (vendored, minified) are not applied.
11. **The MCP SDK is v2, `@modelcontextprotocol/server` 2.4.0** (published 2026-10-23, as the draft's `05` §U5 chose), with `zod` 4.6.7, both pinned exactly. `serveStdio` serves the 2025 `initialize` handshake and the 2026-07-28 revision; both are tested. The package is TypeScript built with its own `typescript` 7.0.2 (exact) and tested with `node:test`, so it ships `dist/` and needs no test runner from the root.
12. **pr-rla is linked with `file:../..`**: npm symlinks the repository's own package (it does not touch the root's `node_modules`), and `npm ci --offline` works once npm's cache holds the SDK and zod (checked in the clean clone). FR3.1's "pinned to an exact pr-rla version" holds at release, when U10 replaces the link with `"pr-rla": "0.1.0"`; until then a test requires the two versions to be equal.
13. **Output schemas are loose objects**: each tool's result and its `{ jobId }` handle share one schema per tool, so a handle is never an output-validation error; the key fields are typed.
14. **`--handoff-ms`** (1 to 25,000) exists for the tests; it cannot lengthen the hand-off past the design's 25 s.
15. **Roots apply to the files an audit names, too.** `ApiContext.confine` is called for the config, `audit_dir`, the window directory, the protocol, a json-file export, a ledger `file` option and the transparency-log key. An external path plugin's own files are not confined: it must be locked, and it is in the audit repo by U2b's rule.
16. **A caller session shares one broker per audit directory**, built from the session's first call's transport, clock and environment (the MCP server passes the same every time); per-call notes are routed with AsyncLocalStorage. Each read call stops the plugin hosts it started (`withPluginHostScope`, added to U2b's `src/plugins/host.ts`), because the server, unlike the CLI, never ends.
17. **The checkpoint module is split** into readers (`src/api/read/checkpoints.ts`) and writers (`src/api/write/checkpoint.ts`); `src/api/checkpoint.ts` stays as a barrel of both, so U4's imports and tests are unchanged, and `pr-rla/api/read` never imports it.
18. **`pr-rla/http`'s `HttpClient` gains `getText()`** and a `raw` request option (U3's file; optional additions within `HTTP_HELPER_VERSION` 1). A raw request asks the broker for no JSON check.
19. **`init` now writes through the atomic writer** (NFR15). The `git-file` ledger still appends its line with `appendFile` (U9 edits that file in parallel); an interrupted append leaves the earlier lines whole and a partial last line that `verify` reports.
20. **The fixture audit is 3.2 MB** (the 1,589 changes appear in both `changes.json` and the manifest), so it is stored as committed files rather than built at test time: built at test time, its draws would depend on the trust bundle's version and pr-rla's version (both are hashed into the registration), and the recorded descriptions would stop matching the draws.
21. **`simulate`'s tool inputs are bounded** beyond the contract's `runs` ≤ 20,000: `population` and `defects` at most 10,000,000, `p0`, `p1`, `alpha` in (0, 1), `p1` below `p0`, `defects` at most `population`.

### Findings

1. **14 of the 36 issued gh-aw draws touch `linguist-generated` files** under gh-aw's own `.gitattributes`: draw #31 (#47149) changes 91 files of which 90 are lock files, draw #35 (#48733) 60 of which 57, draw #13 (#49685) 28 of which 21. The stratum's "≤ 200 changed lines" counts generated lines, so a reviewer without `exclude_generated` would read mostly compiled workflow files.
2. **Bitbucket Cloud answers `pullrequests/{id}/diffstat` and `/diff` with a 302** to `diffstat/{spec}` and `diff/{spec}`. The broker follows them by hand, re-checking the host (recorded on #745).
3. **gitlab-org/cli's pipeline at !4191's head commit has source `duo_workflow`**: the only CI result GitLab lists for that commit is an agent workflow's pipeline.
4. **git can write under `.git` after a commit returns.** A commit may start git's detached auto maintenance, which takes a lock file under `.git/objects`. Under load it overlapped a tree-hash assertion once in the full suite; test repos now run git with `maintenance.auto=false`.
5. **Node 25 or later also denies the network under `--permission`.** The MCP tests run the server under the permission model, so they add `--allow-net` there; the preloaded guard still refuses every host but loopback. Node 22 and 24 have no such flag.
6. **The live `draw_context` on GitHub took 3.4 s** (5 GETs, a personal token): the 25 s hand-off is not near for one draw.
7. **The v2 MCP SDK validates `structuredContent` against the output schema**: a draw context's `state` object failed a first schema that typed a job handle's `state` as a string; the handle's `state` is now untyped in the shared schema.

### Unverified

- **FR3.6**: the server in Claude Code, Codex and Cursor. The founder's manual runs (U6). How each client shows progress notifications, honours `readOnlyHint`, and polls `job_status` is unverified; only the SDK's own client was used.
- **The 25 s hand-off against a slow real SCM**: tested with the hand-off shortened to 100–250 ms on a mock that delays its answers.
- **`describeChange` against GitHub Enterprise Server, GitLab self-managed and Bitbucket Data Center**; Data Center is entirely synthetic, as the provider is. GitHub's 3,000-file cap (`truncated`) on a real PR. A GitLab diff marked `too_large` on a real MR.
- **Linguist's own rules**: only `.gitattributes` is applied, so a generated file Linguist detects by heuristic (a minified file, `package-lock.json`) is shown.
- **Windows and Linux** for the MCP server and its tests (macOS only); Node 22.13 to 22.14 (the plugin host needs 22.15, see bolt 4).
- **The MCP server's memory under a 22-minute job**: the bound is four jobs and 8 MiB per result, not measured on a real long freeze preview.
- **An independent review of the branch** was started at the end of the bolt and had not reported when this was written; nothing from it is in these commits.

### For the integration with U8 and U9

- **U8 (org-pooled freeze).** Move its call-through out of `src/commands/freeze.ts` into the API: the steps a dry run and a freeze share are `planFreeze` in `src/api/read/freeze-preview.ts` (read side; `pr-rla/api/read` reaches it), and the writing is `freeze` in `src/api/write/freeze.ts`. Keep FreezeCheckpointStore and `.pr-rla/cache` on the write side: the boundary test fails if a module that writes enters the read graph unlisted, and `freeze_preview` must keep its working data in memory. `freezePreview({ estimate: true })` refuses with `UNSUPPORTED` today; wire it to the estimator, drop the code from `src/api/errors.ts` and `packages/pr-rla-mcp/src/errors.ts`, and update the `freeze_preview` tool description and the package README. `printRegistrationPlan` (`src/commands/register.ts`) prints a `repos` other than `{ kind: "repo" }` as JSON: give it the pooled form. Both units add an optional method to `ScmProvider` in `src/sdk/provider.ts`, next to `nativeCounts` (`describeChange` here, `listRepos` there): adjacent lines.
- **U9 (presence-attested verdicts).** Its edits to `src/commands/record.ts` and `src/commands/verify.ts` move into `src/api/write/record.ts` and `src/api/read/verify.ts`; the command files are formatters now (`recordCommand` prints from `RecordResult`, `printVerify` from `VerifyResult`). U5 did not touch `src/core/verify.ts`, `src/ledgers/git-file.ts` or `src/core/presence/`. The draw context reports a verdict's provenance level as the ledger gives it, so `presence` shows there with no change. Both bolts append a section to `docs/security-model.md`: this bolt's carries the tier-2 wording under D7 verbatim.
- **Files the other bolts are likely to touch too**: `README.md` (this bolt adds a quickstart line, a bullet under the exports and a section before Limitations), `BUILD-NOTES.md` (this section, at the end), `package.json` (the `./api/read` export), `src/cli.ts` (the `draw-context` command; `run` takes the command's `--json` and catches `AuditError`), `src/sdk/provider.ts`, `src/sdk/http.ts`, `src/plugins/host.ts`, `vitest.config.ts` (an alias), `test/helpers/audit-scenario.ts` and `test/helpers/replay-fetch.ts`.
- **The MCP package's lockfile records the root's dependencies** (the `../..` entry). A root dependency added or changed at the integration needs `npm install` in `packages/pr-rla-mcp` once, or its `npm ci` refuses the stale lock. A version bump must change both `package.json` files and `packages/pr-rla-mcp/src/version.ts` (a test checks them against each other).
- **A new command** goes in two places: its logic in `src/api/read/` or `src/api/write/` (a write function calls `requireReadWrite` first), and a formatter in `src/commands/`. A new read function joins `pr-rla/api/read` only by an edit to `src/api/read/index.ts` and the guard test's list of seven.

## U5 fix round (2026-11-04)

Two independent reviews of `bolt/u5-audit-api-mcp` at `cf3a779` (review 1: 2 high, 6 medium, the lows and a list of tests that cannot fail; review 2: four new findings, confirming review 1's H1, H2, M1, M3, M4, M5 and M6, and five test gaps). Every finding below is fixed, with a regression test that fails on `cf3a779` and passes now, unless it says otherwise. Work on the same branch, from `cf3a779` to the commit this section is in.

### The findings, their commits and their tests

| Finding | Fixed in | Test (what fails on `cf3a779`) |
|---|---|---|
| **H1** one `simulate` call could hang or exhaust the server (each run filled two arrays of the cap's length; p0 = 1e-6: 13 million entries, 12.7 s a run; p0 = 1e-9: out of memory; synchronous in the request handler) | `e24c938` (core and API), `af2cae5` (the tool runs as a long call) | `test/simulate.test.ts` › *each run stops at the SPRT's decision* (a run's decision equals `evaluateSequence` on the same draws, 200 runs, both representations; p0 = 1e-6 with one run stays under 64 MB), › *simulate for read-only callers* (TOO_MUCH_WORK at once for the review's two inputs; the derivation pinned; the worst case at the budget in under 12.5 s of CPU; a timer fires while it runs; abort stops it; progress); `packages/pr-rla-mcp/test/mcp-jobs.test.mjs` › *simulate runs as a long call* |
| **H2** a change decided which of its own files were dropped (`.gitattributes` read at its own landed commit) | `efc489d` (SDK, providers, core, recordings), `8616ec5` (the matcher), `e78bcc6` | `test/draw-context.test.ts` › *a change cannot decide which of its own files are dropped (H2)* (`* linguist-generated` plus `src/backdoor.ts` drops nothing, with the note outside the fence; nested, renamed and copied `.gitattributes`; base-only and head-only marks; a rename into a generated path; no base attributes; a truncated listing; a nested unset; an unread directory); `test/generated-git.test.ts` (against `git check-attr`); `test/describe-change.test.ts` › *base attributes…*; the recorded draws #7 and #13 still drop their lock files from the base commits' attributes |
| **M1** root confinement covered directories, not the files read in them; JSON.parse put file bytes in errors; git walked above the root; the ledger-file check used another path than the one opened | `efc489d`, `a59f7d8` | `test/api-read-fix.test.ts` › *M1* (registration, draws, manifest, verdicts.jsonl, ledger-checkpoints and the ledger index linked out of the roots are ROOT_ESCAPE with no file content in any message; JSON and YAML errors without the file; an absolute ledger `file:` inside the root accepted; git not above the roots; a `.git` file pointing out refused); `mcp-readonly.test.mjs` › *record files linked out of the roots…* |
| **M2** no cancellation or deadline; `Jobs.close()` stopped nothing; online status and verify sent no progress | `efc489d` (signals through the API, broker waits, plugin hosts), `af2cae5` (jobs), `a59f7d8`, `ba882bb` | `mcp-jobs.test.mjs` › *slots, deadlines, cancellation and close* (slots freed after a failed job and after a TIMEOUT; the request's cancellation stops the work; `close()` resolves with every request aborted; the process exits with a job running; `startedAt`); `test/api-read-fix.test.ts` › *cancellation reaches the work*, › *online verify reports its progress*, › *the per-job deadline is derived* |
| **M3** SCM, ledger and plugin text outside the fence | `efc489d` | `test/draw-context.test.ts` › *reports the verdict state…*, › *the header fields from the SCM…*; `test/draw-context-plugin.test.ts` (a plugin's NO_DESCRIPTION is an error with its text in `untrusted`); `test/api-read-fix.test.ts` › *read calls throw pr-rla's errors*; `mcp-readonly.test.mjs` › *a config cannot send another environment secret…* (the echoing server's body is in `untrusted`) |
| **M4** control characters printed raw | `efc489d` (the draw context's text), `d9ee0df` (every CLI line) | `test/draw-context.test.ts` › *escapes C0 controls…* (every field of the text); `test/api-cli-contract.test.ts` › *every line the CLI prints has its control characters escaped* (status text, stderr, `--json` read back exactly) |
| **M5** `--json` stdout not one document | `d9ee0df` | `test/api-cli-contract.test.ts` › *--json: stdout carries exactly one JSON document, always* (status --checkpoint folded, the dry-run note and the Rekor v2 warning on stderr, `log: null`) |
| **M6** finished jobs unbounded | `af2cae5` | `mcp-jobs.test.mjs` › *finished jobs are bounded by count and bytes* |
| Read-only claim: `trust: full` plugins ran in the server; the whole environment reached plugins | `efc489d`, `ba882bb` | `test/api-read-fix.test.ts` › *a trust: full plugin is refused…*, › *an isolated plugin's locked credential grants…*; `mcp-readonly.test.mjs` › *a trust: full plugin is refused in read-only mode* |
| **Review 2, 1 (HIGH)** a config under a root sent any environment secret to any host | `efc489d`, `ba882bb` | `test/api-read-fix.test.ts` › *the operator's credentials in read-only mode*; `mcp-readonly.test.mjs` › *a config cannot send another environment secret to its own host* (the review's `token_env: SOME_OTHER_SECRET` plus `base_url` config: the mock received no Authorization at all), › *no result carried a token… on the mock GitHub Enterprise Server* |
| **Review 2, 2** ReDoS in `.gitattributes` patterns; `[z-a]` threw | `8616ec5` | `test/generated-git.test.ts` › *the matcher is linear*; `test/draw-context.test.ts` › *a ReDoS-shaped pattern…*; `mcp-readonly.test.mjs` › *a ReDoS-shaped .gitattributes is decided in moments, and the server keeps answering* |
| **Review 2, 3** offline verify on a partial clone fetched lazily and wrote under `.git` | `efc489d` (`src/io/git-read.ts`), `a59f7d8` | `mcp-readonly.test.mjs` › *an audit in a partial clone…* (tree hash unchanged, the missing object reported as missing, not deleted); `test/api-read-runtime.test.ts` (every git call carries the read-only environment) |
| **Review 2, 4** the preview cache ignored the provider | `efc489d` | `test/api-read-fix.test.ts` › *freeze_preview's cache key*; `mcp-readonly.test.mjs` › *freeze_preview's cache key includes the provider* |
| `init`, `plugin add` and `plugin lock` failed under an invalid PR_RLA_PLUGINS | `d9ee0df` | `test/api-cli-contract.test.ts` › *init works under an invalid PR_RLA_PLUGINS…*; the differential's flow 3 with `PR_RLA_PLUGINS=bogus` is now identical to master's |
| `plugin check` printed nothing before a kit error | `d9ee0df` | `test/api-cli-contract.test.ts` › *plugin check prints as it goes*; differential flows 7 and 8 identical |
| Error-path output order (register, checkpoint) | `d9ee0df` | `test/cli-order.test.ts` (the failing steps mocked) |
| `log` missing instead of `null` | `d9ee0df` | `test/api-cli-contract.test.ts` › *log is null, not missing…* |
| pr-rla's refusals reported as PROVIDER_ERROR | `efc489d`, `af2cae5` | `test/api-read-fix.test.ts` › *pr-rla's own refusals keep their code and words*; `mcp-readonly.test.mjs` › *a trust: full plugin…* (FAILED) |
| Roots: `..foo` refused; outside paths and the roots echoed | `af2cae5` | `mcp-readonly.test.mjs` › *a root's directory named ..foo…* |
| `job_status` re-checked a wrapped result; `startedAt` was the hand-off | `af2cae5` | `mcp-jobs.test.mjs` › *a result that fits but whose job_status answer does not…*, › *startedAt is when the call started* |
| A falsy `describeChange` skipped validation | `efc489d` | `test/draw-context-plugin.test.ts` (a plugin returning null is refused) |
| Title, paths and check names unbounded | `efc489d` | `test/draw-context.test.ts` › *bounds the title, paths, names…* |
| Paging loops without a repeat check or a page cap | `efc489d` | `test/describe-change.test.ts` › *a server that repeats its next page…*, › *the page cap…*, the Data Center and Bitbucket Cloud cases |
| GitHub `copied` → renamed; Data Center COPY without its source | `efc489d` | `test/describe-change.test.ts` (synthetic GitHub listing; › *Data Center: a COPY is an added file…*) |
| Provider-side truncation never reported | `efc489d` | `test/describe-change.test.ts` › *GitHub direct push…*, › *the combined status is paged…*, › *GitLab: a collapsed diff…*, › *Data Center…* |
| Bitbucket Cloud git-quoted paths | `efc489d` | `test/describe-change.test.ts` › *Bitbucket Cloud: a git-quoted path…*, › *splitUnifiedDiff reads git-quoted paths…* |
| Per-file patch budget all or nothing | `efc489d` | `test/draw-context.test.ts` › *fits whole patches first… an oversize one gets a prefix cut at a line end* |
| A changed protocol's checklist printed in pr-rla's voice | `efc489d` | `test/draw-context.test.ts` › *FAILs the protocol… and withholds a changed protocol's checklist* |
| Review 2, 1, found in this round: `verify` catches a ledger's failure (check 7) and the beacon relays' (check 4) and quoted their text, so up to 300 bytes of a tracker's HTTP error body reached a read-only caller in a check's line | `d03971f` | `test/api-read-fix.test.ts` › *verify's checks quote pr-rla…* (an isolated ledger whose error carries an instruction: check 7 says pr-rla's words and points to `untrusted.errors[0]`; a relay answering non-JSON: check 4 likewise; the CLI quotes in place as before) |
| Found in this round's fresh-clone runs (2 of 5 red at load averages above 100, in master's own test *a slow call that keeps sending heartbeats is not stopped*): the plugin host's watchdog stopped a child whose heartbeats were waiting in the pipe, because timers run before the poll phase reads I/O | `69f0af7` | `test/plugin-host.test.ts` › *a heartbeat that arrived while this process was busy counts* (this process blocked from a check-phase callback past the timeout: fails 3 of 3 on the old watchdog); master's test keeps its 3× ratio with 1 s / 3 s instead of 0.5 s / 1.5 s |

**Tests that could not fail, fixed:** the init atomic-write test (a hard link to the old file must keep its content, which an in-place write would change); the 8 KiB cut (`"a" + "é"…`, so the cut lands inside a character and the U+FFFD branch runs: the byte count is asserted); every "inside the fence" check (strictly after the open marker and before the close, never true for a missing string); the plugin-host count (the setup's hosts are stopped first, then each read call, failing or not, must leave none); the describeChange replays (now hand-written expectations from the raw recorded JSON for GitHub #42597, GitLab !4191 and Bitbucket #745; Data Center has no real recording, its synthetic raw JSON maps by hand as before); the huge-payload test (a known key with 500 elements: only the 64-element cap can refuse it); the token test (on the mock GitHub Enterprise Server, with tokens set); the boundary test (writers found by their `fs` and `child_process` imports, including `spawn`, `execFile` and async writes; namespace imports and `export … from` re-exports, with a planted negative control), plus `test/api-read-runtime.test.ts`, a fresh Node process that runs every read function under a load hook and an fs and child_process spy: no write-side module loads, nothing is written, the only processes are git with the read-only environment.

### Measured and recorded (2026-11-04)

- **simulate's budget.** Worst-case throughput at N = 10,000,000, both representations, Node 22.23.2, 24.20.0 and 26.8.2, on this machine (Apple M5) at 04:06 to 04:16 UTC while other work ran: the slowest rate was 2.81 million draws a second (Node 22 sparse, and Node 24 sparse with the largest Map), the fastest 3.7 × 10⁷. `SIMULATE_MAX_DRAWS` = 2.8 × 10⁶ × 25 s ÷ 8 = **8,750,000**: 8 = 4 (the at most four long calls the server runs share its one thread) × 2 (headroom for a slower machine, garbage collection and the measurement's own 2–3× spread). The default MCP simulate (20,000 runs × cap 144 = 2.88 million) fits; p0 = 1% (cap 1,492) fits up to 5,864 runs. The scripts are in the session's scratchpad, not the repo.
- **Re-recorded describeChange**, read-only, through pr-rla's broker in read-only mode: GitHub, the 36 issued draws of the gh-aw audit, 04:50:30 to 04:51:53 UTC, 270 GETs with the founder's `gh` token (the recording keeps the 36 of draws 5, 7, 13 and 31); GitLab !4191 at 04:52:22 and Bitbucket Cloud #745 at 04:52:25, anonymously, 5 and 8 GETs. New in each: the base commit's `.gitattributes` and, for the 14 gh-aw draws with generated files, the directories above them (all 404). No write anywhere; e-mail addresses scrubbed as before.

### Differential against master

The review's master and branch CLIs, with the branch rebuilt at `ba882bb` and again at `d03971f` (`scratchpad/u5fix/diff`), on copies of the recorded fixture: the seventeen single commands and the eight flows plus flow 3 under `PR_RLA_PLUGINS=bogus`. Identical: status (plain, `--offline`), verify (offline, online), freeze `--force` and plain, `simulate` with bad input, flows 2, 7 and 8. Every other difference is explained: the additive `--json` fields and the JSON error form (U5's §7, as review 1 found), times and hashes of commands run seconds apart, `status --json --checkpoint` now one document with the checkpoint's error inside (M5), `draw-context` (master has none), and **simulate's numbers**: each run now stops at its decision, so the random stream advances less and a seed gives other runs (500 runs at the tolerance: 2.60% on master, 4.40% now, both under the 5% risk; the spec-table tests at 20,000 runs still hold). The refactor's two differential regressions (flow 3 under a bad PR_RLA_PLUGINS, flow 8's plugin check) are now identical to master. Between the two rebuilds the branch's own output changed only in seed rounds and hashes (the clock moved), the fence id (random per call), and flow 4's draw-context losing its "could not be decided" note for files no root marks (`e78bcc6`); the set of cases identical to master is the same.

### Verified (command → output)

From a fresh clone of the branch at `6fcfe33` into the session's scratchpad, three runs in a row (runs 9 to 11, 2026-11-04 06:43 to 06:50 UTC, Node v22.23.2, load averages 1.9 to 13), each: `npm ci && npm run build && npm run typecheck && npm test` at the root, `npm ci && npm test` in `packages/pr-rla-mcp`, `examples/providers/gitea` and `examples/ledgers/jira`.

| Step | Each of the three runs |
|---|---|
| root `npm ci` | 60 packages, 0 vulnerabilities |
| root `npm run build`, `npm run typecheck` | clean |
| root `npm test` | 624 passed, 1 skipped, of 625 (52 files), 24 to 42 s |
| `packages/pr-rla-mcp` | 19 packages, 0 vulnerabilities; 57 of 57 pass |
| `examples/providers/gitea`, `examples/ledgers/jira` | 0 vulnerabilities; 1 of 1 pass each |

Tests: at `cf3a779` 547 at the root (546 passed, 1 skipped) and 42 in the package; now 625 (624 passed, the same 1 skipped) and 57. The earlier runs of this round, for the record: run 0 on `e78bcc6`, at load averages above 100, failed master's heartbeat test, the Jira conformance test's 60 s, and NFR10's MCP start (best of five starts 2,268 ms against 2 s; every later run met it); of runs 1 to 5 on `21c6dec`, runs 2 and 5 failed the heartbeat test, again above 100 (`69f0af7`); of runs 6 to 8 on `9666d25`, run 6 timed out the Jira conformance test at a load average of 24 (`6fcfe33`). No other test failed in any run. NFR10's 2 s start is a requirement, so its test keeps the bound and stays sensitive to a starved machine.

### Deviations from the design, and why

1. **`ChangeDescription` gains `attributes` (base and head `.gitattributes` by directory) and `checksTruncated`; `describeChange` takes `{ signal }`.** Optional, within provider API version 1 (contracts.md §1 has `gitattributes` only). Without `attributes`, nothing is dropped.
2. **The draw context's shape.** `author`, `mergedBy` and `labels` moved into `untrusted`, as did a verdict's `reviewer` and `note` (`untrusted.verdict`), a ledger's error (`untrusted.ledgerError`) and the tracker's issue and labels (`untrusted.record`); `state` keeps pr-rla's reading. New: `titleTruncated`, `patchCut`, `pathCut`. A changed protocol's `text` is null and its checklist empty. The `draws` and `status` results are unchanged (their ledger fields are JSON with no text rendering; FR3.9 is about `draw_context`).
3. **MCP error codes beyond contracts.md §4:** `FAILED` (pr-rla refused, no other code names it), `TOO_MUCH_WORK` (simulate's budget), beside `UNSUPPORTED`; error bodies gain `untrusted`.
4. **`pr-rla/api/read` exports two numbers** (`LONG_CALL_DEADLINE_MS`, `SIMULATE_MAX_DRAWS`) and its `simulate` returns a promise and takes `ReadOptions`; `ReadOptions` gains `roots`. The CLI's `simulate` stays synchronous and unbounded: a person's own command has no tool budget.
5. **`simulate` is a long call** in the MCP server (counted toward the four, handed off at 25 s), so `TOO_MANY_JOBS` now counts it too.
6. **Job limits beyond NFR20:** a per-job deadline (1 h 30 s, derived), at most 32 finished jobs and 32 MiB of them.
7. **Read-only credentials** (review 2's decision): a built-in reads only its default token variables, as placeholders swapped on its default https origin; `token_env`, a non-default base URL and an isolated plugin's lock grants need consent, which this build cannot record (`operatorConsents` answers no), so they are withheld in read-only mode. GitHub Enterprise Server, GitLab self-managed and Bitbucket Data Center therefore run anonymously in the MCP server until integration. A new `PluginPolicy`, `isolated-only`, is what read-only contexts run under.
8. **`status --json --checkpoint`** prints `{ …status, checkpoint }` (or `checkpoint: { error }`) as one document; the exit code is as without `--json`.
9. **`verify`'s result gains `untrusted: { errors }`** in read-only mode, only when check 4 or 7 caught a failure; a clean verify is still the CLI's `--json` object (contracts.md §7). The CLI's checks quote the failure in place, as on master.

### Declined or partly done, and why

- **Nested `.gitattributes` are read only above files the root marks generated** (at both commits). A file only a nested file marks generated is shown: the safe side, and it saves a request per directory for every other file. Git's semantics are applied in full to whatever is read.
- **Anonymous GETs to a config-chosen host** (a `base_url`, the transparency-log URL) still happen in read-only mode, with no credential: blocking non-default origins would make GitHub Enterprise Server and the other self-hosted SCMs unusable until the consent store lands. Responses reach the caller only as parsed fields or, in errors, as `untrusted`. Recorded in `docs/security-model.md`.
- **A concurrent rename inside a root during a call** could race the realpath check (only the last component is pinned, by `O_NOFOLLOW`); whoever can do that already controls the audit.

### Unverified

- describeChange's base commits on GitHub Enterprise Server, GitLab self-managed and Bitbucket Data Center (DC entirely synthetic; `toRef.latestCommit` of a merged DC pull request in particular), GitHub's 3,000-file cap and GitLab's `collapsed` and `changes_count: "1000+"` on a real change.
- The deadline, cancellation and `close()` against a real SCM's rate-limit waits (tested on mocks and fake waits).
- Windows and Linux. The timing tests ran green on this machine under load averages up to about 40 (below); at 100 to 170 (other work on the machine) master's own heartbeat test failed, which `69f0af7` addresses for this process's side; a child starved for longer than a test's timeout still fails that test, by design. Master's Jira conformance test (`test/wave1-integration.test.ts`, about 13 s alone on master and on this branch) took over 60 s in one parallel run at a load average of 24 and now has a 180 s hang guard of its own.

### For the integration

- **Plugin and broker fix round:** join its approvals store at `operatorConsents` in `src/api/credentials.ts` (both the built-ins' `token_env`/base URL and the isolated plugins' lock grants route through it, the latter in `grantedCredentials`, `src/plugins/open.ts`). This round touched `src/plugins/open.ts`, `lock.ts` (`isolated-only`, `refuseFullTrust`), `identity.ts`, `host.ts` (hosted calls take the call's signal; the watchdog decides in a `setImmediate` after the poll phase, with a generation counter, `69f0af7`), `errors.ts` (`FULL_TRUST_REFUSED`), and the broker (`src/net/broker.ts`: abortable waits, no secret over `http:` in read-only mode; `governor.ts`: an abortable slot). Its origin-exact credential matching supersedes the read-only https check.
- **U9 fix round:** `src/io/git-read.ts` is the one place for read-only git's environment and config (`gitReadEnv`, `GIT_READ_CONFIG`); add its stripped `GIT_*`, `--no-replace-objects`, `--no-textconv` and `core.commitGraph=false` there. `src/ledgers/git-file.ts` here: confined reads, `gitFilePath`, the `.git` file check, and "missing object" findings.
- **U8:** `src/providers/github/http.ts` (`rest(url, signal)`; aborts pass through), `src/sdk/provider.ts` (`DescribeChangeOptions`, `ChangeAttributes`), `src/api/read/freeze-preview.ts` (the cache key).
- New shared helpers: `src/net/abort.ts`, `src/io/confine.ts`, `src/core/text.ts`, `src/providers/paging.ts`, `src/providers/attributes.ts`, `src/api/read/errors.ts`.

## P4 git-file ledger path and verdict binding (2026-11-04)

A second adversarial review of U9's fix round (at `5fe1072`) found the walked ledger path unbound to the registration, unsigned lines that could poison a reviewer's signed verdict, a walk whose memory grew with the repository, verdict bytes that did not bind the seed, bare-name spawns, and a wording check that missed 9 of 12 direct claims. This round fixes each, on branch `fix/p4-ledger-path`, off `integrate/wave2` at `66e3f54` (U8, U9, the ledger and trusted-time rounds; U5 and plugins-broker were not yet merged).

### Each finding, its outcome, commit and test

| # | Finding (severity) | Outcome | Commit | Tests |
|---|---|---|---|---|
| 1 | The walked ledger path is not bound to the registered location (HIGH): E1, a window moved behind a symlink, and E1b, the audit copied to another `audit_dir`, each dropped bob's signed FAIL with 7/7 PASS, CERTIFIED | fixed: `register` signs `ledgerPath` (lexical, normalised, from the toplevel); the integrity check walks that lexical path and FAILs on a symbolic link, a non-directory or another spelling on the way; check 7 FAILs when the walked path is not the registered one; a registration without the field WARNs | `c86577c` | `p4-review-regressions.test.ts › E1`, `› E1b`, `› E1c, held before`; `git-file-history.test.ts › P4 … the ledger is walked at its lexical path` (8) |
| 2 | Unsigned lines appended first poison the reviewer's signed verdict (MEDIUM): E3 | fixed: under keys plus `require_signed` or a minimum above `self-asserted`, a line without a valid registered signature is ineligible and ignored with its reason; the first eligible signed verdict counts; one predicate for status, check 7 and `record` | `9ad336b` | `› E3`; `presence-verifier.test.ts › P4 finding 2 …`; `presence-fixtures.test.ts › FR9.5 (4)`; `e2e-presence.test.ts › FR9.1`, `› FR9.3` |
| 3 | On a case-insensitive filesystem the walk can see no history (MEDIUM-LOW): E2 | fixed: each component of the lexical path must be in its parent's directory listing under exactly its name; a never-committed ledger beside a committed registration FAILs; `record` refuses to write into another spelling | `c86577c` | `› E2` (runs where the temp directory folds case: macOS here); `› a ledger with lines that was never committed …`; `git-file-history.test.ts › E2 …`, `› a ledger with verdicts never committed …` |
| 4 | The walk's memory grows with history (LOW) | fixed: the walk streams (measurements below) | `c86577c` | `git-file-history.test.ts › P4 … the walk streams` (4,000 commits of 61 KB trees under 120 MB; the old walk peaked at 277 MB on it); the reviewer's walk cases (`zz-walk`) give identical results before and after |
| 5 | The signed bytes bind the registration but not the seed or the manifest (LOW) | fixed: bytes `pr-rla-verdict/v2` add `manifestSha256`, `beaconRound` and `beaconRandomness`; verify rebuilds them from what checks 2, 4 and 6 verified; v1 signatures are refused everywhere | `9ad336b` | `› signatures over the v1 bytes …`; `presence-verifier.test.ts › P4 finding 5 …`; `presence-oracle.test.ts › P4: …` (3); `presence-fixtures.test.ts › P4: bob's touch for another manifest …` (fixture draws #15, #16) |
| 6 | Bare-name spawns of git and ssh-keygen (LOW, Windows) | fixed: both resolved once from PATH's absolute entries and spawned by that path, the checkpoint transport's git too; Windows documented as untested | `ad5c465` | `› a git committed in the audit repository …`, `› ssh-keygen is not looked up through a relative PATH entry`; `git-file-history.test.ts › P4 (finding 6) …` |
| 7 | Wording (LOW): the security model's "unambiguous" touch request, a bare `presence` in git-file's description; the deny-list missed 9 of 12 claims | fixed: both sentences rewritten; the check is now an allow-list over the docs, the sources' prose, the scripts and the printed and `--json` output, with a vetted list | `acb29eb` (docs), `8352d66` | `presence-wording.test.ts` (12, five new: the 12 probes, limit wording, source prose, the whole tree, the vetted list); `e2e-presence.test.ts › finding 9` |
| — | Tests: the commit-graph tests passed with the guard removed | fixed: they now also run the guarded git call that a commit-graph would steer, and assert on it | `c86577c`, `9ad336b` | `git-file-history.test.ts › a lying commit-graph …`, `u9-review-regressions.test.ts › a lying commit-graph …`: with `-c core.commitGraph=false` removed from `git-safe.ts` both FAIL (checked), with it both PASS |
| — | Tests: no symlinked-directory or `audit_dir` test; exp2(a) asserted presence ≤ 1 | fixed: E1/E1b and the unit tests above; exp2(a) asserts exactly 0 | `c86577c`, `9ad336b`, `ff67bac` | as above; `u9-review-regressions.test.ts › exp2(a)` |
| INFO | Status printed CERTIFIED where verify FAILed check 7 (attack B, E3) | fixed: status runs the same git-file walk and path rule, and prints `NOT CERTIFIED: verify check 7 would FAIL (…)` where the sequence certifies but check 7 would FAIL (integrity, path, a counted verdict below the minimum or unsigned under `require_signed`); `--json` adds `ledgerIntegrity` and `certificateWithheld` | `c86577c` | `› attack B …: status prints NOT CERTIFIED and the integrity FAIL` (text and `--json`), `› E1`, `› E1b`, `› E2` |

The six commits: `ad5c465` (programs by absolute path), `c86577c` (the ledger path, the streaming walk, status's walk), `9ad336b` (eligibility, v2 bytes, the fixture), `acb29eb` (docs), `8352d66` (the wording allow-list), `ff67bac` (the reproductions). Each was checked in a scratch clone of the branch (typecheck, then the whole suite, 1 skipped each time): `c86577c` 995 passed, `9ad336b` 1001, `acb29eb` 1001, `8352d66` 1006, `ff67bac` 1016 (the totals below).

### Before and after

The reviewer's reproductions, as `test/p4-review-regressions.test.ts` (made through the public commands and a fresh `git clone`), run against `66e3f54` with only a shim helper (`bindingOf` returning the registration's digest, since v1 bytes are all that tree knows): **9 failed, 1 passed** (E1c, held before), each on the attack's own outcome:
- E1 and E1b: `expected 'PASS' to be 'FAIL'` (check 7 of the fresh clone);
- E2: `record` wrote into `Verdicts.jsonl` (`promise resolved "+0" instead of rejecting`);
- the never-committed ledger: `expected 'WARN' to be 'FAIL'`;
- E3: `record --sign` refused, "already has a pass verdict (draw #1) … --force appends anyway";
- attack B: status printed `prefix 36/36 · fails 0 … CERTIFIED (risk 5%)` while check 7 FAILed;
- the v1 signatures: counted, at the registered minimum, and certified;
- the trapped `git` in the audit repository and the trapped `ssh-keygen` on a relative PATH entry both ran.

After the round: **10 passed**. The reviewer's `zz-wording` probes: all 12 are caught by the allow-list (the deny-list alone still lets 8 through). The reviewer's `zz-compare` (a360348's keyless audits verified by the old and the new code) differs only by the anchor lines of trusted time, U9's refusals (shallow clone, two-sided merge), and the new WARN that such registrations do not record the ledger's path.

### The walk's cost, measured on the reviewer's repositories

macOS (Darwin 25.6.0, arm64, 10 cores), Node 22.23.2, git 2.55.0, load average 6–26; peak RSS from `process.resourceUsage().maxRSS`, the process's own baseline 54 MB included:

| Repository | Before (`66e3f54`) | After |
|---|---|---|
| `big/r`: 200,000 commits, a 1.8 KB root tree | 15.8 s, 921 MB | 2.7–3.2 s, 249–274 MB (four runs) |
| `big/r2`: 30,000 commits, a 65 KB root tree | 9.8 s, 2,043 MB | 1.9–2.1 s, 141–144 MB |

**The target, and why:** under 300 MB peak for 200,000 commits, the coordinator's example, met with a margin of 26 MB at worst. A 200,000-commit history is a large monorepo's, and 300 MB fits a default CI runner several times over. The walk now costs about 1.1 KB per commit (an id, a tree id, the parents and their index entries), independent of commit messages, signatures and tree sizes; only the ledger file's distinct versions are kept whole. A history of 1.3 million commits (the Linux kernel's size) would need about 1.5 GB, unmeasured: stated as a limit.

How: one `git cat-file --batch` per pass fed straight from `git rev-list` (a hint only), each object parsed as it streams and hash-checked; a body that fits in the chunk is read in place, one that spans chunks is gathered into one reused buffer; ids are read from the bytes, so no kept id holds a commit's text alive; per commit an index, a tree id and the parents' indices; per tree only the entry the path needs, entries interned.

### Decisions and deviations

1. **`ledgerPath` is a top-level field of the registration,** not inside `plugins.ledger` (the identity P1 enforces) or `verdicts`: it is where the built-in git-file's file is, signed in once at register. Absent for other ledgers and for a git-file ledger registered outside a git repository (register warns).
2. **The path is computed lexically from the first ancestor that is git's toplevel on disk.** Symbolic links above the toplevel (macOS's `/var`) are the machine's and allowed; below it every component must be a real directory (or the file) listed under exactly its name. A window directory linked into another repository is "not inside the repository git found", a FAIL, and nothing is walked.
3. **The integrity check reports a path problem and still walks** the configured path's history, so E1 also shows `… was deleted in commit … (audit/2026-q3 is a symbolic link there, not a directory)`.
4. **`LedgerIntegrityReport.location`** (optional SDK field) carries the walked path to check 7; only the built-in git-file's counts. `classifyVerdicts` gains an optional `ineligible` hook (the ledger kit passes none).
5. **The version line is `pr-rla-verdict/v2`** (the brief wrote `pr-rla-verdict@v2`): v1's first line is `pr-rla-verdict/v1` and `@` is the namespace's form. The namespace stays `pr-rla-verdict@v1`: it names the purpose, the first line names the format, and every registered `namespaces=` option keeps admitting it.
6. **v1 signatures are refused for every registration** (the brief's choice between "refused under v2" and "kept for v1"): no registration is v1-only in the sense that matters, nothing signed under v1 was released, and keeping v1 would keep pre-signing open. Check 7 names the reason.
7. **Status and record take the binding from `manifest.json` and `draws.json`;** verify takes it from the manifest and beacon it verified. A tampered `draws.json` only makes status's signatures fail to verify; verify is the authority.
8. **FR9.1 and FR9.3 are met as "never counts"**, not "counted and FAILed". Under the signing rules an unsigned, foreign or invalid line is ignored with its reason and its draw blocks the prefix; check 7 WARNs it as ignored. FAILing it would make one appended line block the audit forever, which is finding 2. `verdictRuleFailures`' `require_signed` branch stays as defence in depth; with the predicate it no longer fires for a counted verdict.
9. **With keys required, a ledger other than the registered git-file makes every verdict ineligible** (its signature fields are never checked).
10. **Status withholds CERTIFIED** where the sequence certifies but check 7 would FAIL; it does not change the exit code (P2 owns the exit model) or `sequence.state` in `--json`, and adds `certificateWithheld` and `ledgerIntegrity`.
11. **The allow-list.** A sentence "mentions" when it names presence, the UP flag, hardware, a security key or a YubiKey, or a touch in a sentence about keys or people ("touches no file" is not a mention). Source prose is comments and string or template literals, read by a small tokenizer; code, identifiers and regular expressions are skipped, so U5's refactor moves code without touching the list. The vetted list matches after normalising whitespace, change ids, fingerprints, long hex and numbers; a stale entry fails nothing. The deny-list still runs over whole texts, with the printed label read as bare `presence`.
12. **The checkpoint transport** (`src/io/git-transport.ts`) also runs git by absolute path, though the review named only `git-safe.ts` and `ssh-sign.ts`.
13. **U8's anchor test** (`single-repo-anchor.test.ts`) compares a branch audit with master's build byte for byte. A branch registration now carries `ledgerPath`, so the dump re-signs it without the field (same key) and the comparison sets aside register's path line, its first line's hash and status's resulting WARN, each asserted first.
14. **Two tests read counts instead of writing them in** (`git-file-unchanged.test.ts`, E3): the registration's bytes, and so the draws, changed with the new field.

### Found on the way, not fixed

- **A Git for Windows checkout (`core.autocrlf=true`) FAILs check 7** with "`verdicts.jsonl` in the working tree rewrites its committed history": the working tree holds CRLF, the blobs LF (shown on macOS with `git -c core.autocrlf=true clone`; it was so before U9 too). Verify in a checkout with `core.autocrlf=false`. Left alone with the rest of Windows, which is untested.

### Release notes

1. **Registrations of the built-in git-file ledger carry `ledgerPath`.** A ledger read anywhere else (another `audit_dir`, through a symbolic link, under another spelling) FAILs check 7; a registration without the field WARNs (test fixtures only).
2. **Verdict signatures are over `pr-rla-verdict/v2`** (manifest and seed included). Lines signed over v1 count for nothing: sign them again (`pr-rla record --sign`, or the README's recipe).
3. **Under keys and `require_signed` or a minimum above `self-asserted`, unsigned or foreign lines are ignored,** not FAILed; `record --sign` records over them without `--force`.
4. **Status may print `NOT CERTIFIED: verify check 7 would FAIL (…)`** where it used to print CERTIFIED.
5. **A git-file ledger with verdicts never committed at its path, beside a committed registration, FAILs check 7.**
6. **git and ssh-keygen must be on an absolute PATH entry**; a relative entry is skipped.

### Live and local work (dated)

- 2026-11-04T06:49:18Z: the sk-dummy fixture remade with `scripts/make-presence-fixtures.mjs` (the README's v2 recipe, printf and `ssh-keygen -Y sign`), with the round-1 sk-dummy build (`scratchpad/u9/openssh-10.3p1/regress/misc/sk-dummy/sk-dummy.so`) and macOS's OpenSSH_10.3p1 (LibreSSL 3.3.6): 16 verdicts, ten software keys in a temporary directory deleted afterwards, `"source": "synthetic"`. ssh-keygen's own `-Y verify` gives Good for #15 and #16 over the bytes each was made over; pr-rla refuses both for this audit.
- The reviewer's `big/` repositories were only read (`rev-list` and `cat-file`, with `GIT_OPTIONAL_LOCKS=0`).
- Nothing left the machine: no network call, no key in `~/.ssh`, no hardware key, nothing pushed.

### Tests

- Before (`66e3f54`): 985 passed, 1 skipped (986).
- After: 1016 passed, 1 skipped (1017): `p4-review-regressions` 10 (new), `git-file-history` 32 (was 22), `presence-wording` 12 (7), `presence-verifier` 43 (41), `presence-oracle` 36 (33), `presence-fixtures` 14 (13); `e2e-presence`, `u9-review-regressions`, `git-file-unchanged` and `single-repo-anchor` keep their counts, with assertions changed as above.

### Verified (command → output)

Three runs in a row, each a fresh `git clone` of the branch at `532e2bc` (the last commit before this one, which changes only this section) into the scratch directory, Node 22.23.2, other agents' suites running beside them:

```
run 1 (2026-11-04T07:41Z, load 71)  run 2 (07:44Z, load 16)  run 3 (07:47Z, load 22)
npm ci              → exit 0, found 0 vulnerabilities, all three
npm run build       → exit 0, all three
npm run typecheck   → exit 0 (both tsconfigs), all three
npm test            → Tests 1016 passed | 1 skipped (1017), all three
gitea ci, test      → found 0 vulnerabilities · # pass 1 · # fail 0, all three
jira ci, test       → found 0 vulnerabilities · # pass 1 · # fail 0, all three
npm test (again)    → Tests 1016 passed | 1 skipped (1017), all three
node scripts/demo-{presence,broker,ledgers,plugin-host,sdk-carry-overs}.mjs → exit 0, all three
npm ls --prod --depth=0 → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1
```

No LICENSE file; `"private": true, "license": "UNLICENSED"`; no dependency added.

### Unverified

- Windows, entirely: the absolute-path resolution (`.exe`, `.com`), the cwd lookup it closes, and the CRLF checkout above.
- Case-insensitive filesystems other than macOS's APFS (NTFS, case-insensitive ext4), and Unicode normalisation (an NFD name for an NFC one) on any filesystem: the listing comparison covers them by construction, untested.
- Histories beyond 200,000 commits; the walk's memory on Linux.
- Hardware FIDO keys (D7), as before; T16 is unchanged.
- The logic through U5's API layer, which is not on this branch.

### Shared files touched (for the integration)

- **Command files (thin): `src/commands/register.ts`** (the `ledgerPath` field and its output line, through `gitFileRegisteredPath`), **`src/commands/status.ts`** (`auditBinding`, `ineligible`, `gitFileLedgerGate`, `certificateWithheld`, the `withheld` parameter of `statusLine`, two `--json` fields), **`src/commands/record.ts`** (`countingVerdictFor` and the binding passed to `--sign`). Not touched: `src/cli.ts`, `package.json`, `package-lock.json`, `src/api/`.
- **`src/core/verify.ts`:** check 7 only: the binding, `ineligible`, and the path rule after the integrity check.
- **`src/core/records.ts`:** one optional field, `ledgerPath`, after `plugins` (P2 owns the file). **`src/core/status.ts`:** `computeStatus`'s `ineligible` input. **`src/sdk/ledger.ts`:** `LedgerIntegrityReport.location` and `classifyVerdicts`' `ineligible`.
- New: `src/core/ledger-path.ts`, `src/io/executables.ts`, `test/fixtures/wording/vetted.json`, `test/p4-review-regressions.test.ts`.
- **U5 must:** have its status API call `gitFileLedgerGate` and `certificateWithheld` (and print the withheld line), pass `binding` and `ineligible` as `src/commands/status.ts` does, use `countingVerdictFor` in its record API, record `ledgerPath` in its register API, and spawn git only through `git-safe.ts` (or `gitExecutable()`). Any new printed or documented sentence about presence, a touch, hardware or a security key needs the limit wording or an entry in the vetted list.
- **P1 (identity everywhere)** meets this round in check 7 (the identity compare stays as it was here, the path rule runs after the integrity check) and in status and record.
- **A trial merge with `integrate/wave2` at `d59b719`** (plugins-broker merged) conflicts in `README.md` (two limitation bullets) and `src/commands/register.ts` (the `plugins` line, whose `auditContextFor(ctx)` argument changed there, beside the new `ledgerPath` line); both keep both sides. Resolved so in a scratch clone, the merged tree typechecks and its suite passes: 74 files, 1086 passed, 2 skipped (1088), 2026-11-04T07:31Z.

## P3 frozen-head and repo-set integrity (2026-11-04)

Round P3, on branch `fix/p3-pool-head` off `integrate/wave2` at `66e3f54` (U8, U9, the ledger and trusted-time rounds merged), after a second adversarial review of U8 at `ec073d7`. Its governing decision: **prove the frozen head from push-time evidence the SCM records itself, never from committer dates or graph shape, which the pusher sets.** U8's fix round had excused a window commit the frozen head does not reach when every first-parent commit after the head was dated after the window; the review showed that a fast-forward merge `[base, real tip]` pushed after the window turned a rewound head into PASS and VERIFIED, on single repos and on all four built-ins, and that the same rule made honest late pushes FAIL.

Every reproduction is a committed test. `test/p3-pool-head.test.ts` (44 tests) uses only APIs that existed at `66e3f54`, so it was also run against that commit's `src` with this round's test helpers: **40 of the 44 fail there**; the 4 that pass are controls (honest shapes that leave no window commit unreached, with and without a push log), which both builds pass. The new modules' own tests are in `test/p3-head-proof.test.ts` (13).

### Findings, fixes and evidence

| # | Finding (second pass) | Fix | Regression test(s) | Before (`66e3f54`) | After |
|---|---|---|---|---|---|
| 1 | A fast-forward merge masks a rewound head; padding does too | The committer-date first-parent exemption is gone. Freeze reads each repo's push log (`ScmProvider.pushLog`, new, optional) and records `headEvidence`; verify reads it again (`src/core/head-proof.ts`). A head the log shows was not the branch's tip at any instant of the freeze span FAILs; one it proves makes an unreached window commit FR7.2 (a note); no usable log makes it INCOMPLETE. After an update the SCM does not call a fast-forward, the tip at the window's close must be an ancestor of the frozen head. The stopgap: a pull request merged in the window whose merge commit the frozen head does not reach FAILs (`ListChangesResult.unreachable`, reported by all four built-ins) | `p3-pool-head` › finding 1 (6: E1 on a push-only repo, on a repo with PRs, without a log, on a single repo; padding; a force push back to before the window, left and restored), › every built-in (3: GitLab, Bitbucket Cloud, Data Center), › the force-pushed PR; `p3-head-proof` › analysis and provider level | E1: PASS, VERIFIED (the review: 104 pushes dropped on svc-08); padding: PASS; single repo: PASS | FAIL "the frozen head … was not the default branch's tip at freeze: the push log shows that at … the tip was …", plus the stopgap where PRs merged; GitLab, Bitbucket Cloud and Data Center FAIL by the stopgap (GitLab by its push log too); with no log and no PR: INCOMPLETE |
| 2 | `registeredRepos` optional and auditee-asserted; a fine-grained token registers a subset silently | Check 2 FAILs a rule registration without `registeredRepos`. `register` signs what its token could prove it saw (`registeredVisibility`, the same proof as a manifest's `repoListing`) and prints a `WARNING` per private or internal visibility it cannot prove; check 5 is INCOMPLETE for each such visibility | `p3-pool-head` › finding 2 (E4a, E4b, E4c), › a registration without `registeredVisibility` | E4a: WARN, VERIFIED; E4b: WARN, VERIFIED; E4c: WARN, VERIFIED, and `register` said nothing | E4a: check 2 FAIL; E4b: FAIL (archived after its window changes); E4c: the WARNING at register, INCOMPLETE with an honest freeze, FAIL for the archived private repo |
| 3 | Honest late pushes FAIL (a backdated commit pushed after freeze, a `git pull` merge, a fast-forward of local window-dated work) | The push log places them: PASS with the FR7.2 note; without a log, INCOMPLETE, never FAIL | `p3-pool-head` › finding 3 (6 shapes × with and without a log, and retention); `single-repo-anchor` (the same six shapes on master's build and this one) | backdated, `git pull` and fast-forward: FAILED; the anchor covered static heads only | all six VERIFIED, check by check equal to master's; without a log the four that leave a window commit unreached are INCOMPLETE |
| 4 | A repo created during the window, after registration, dropped by an archive (real or recorded) | A repo excluded at freeze by its archive state alone with window changes FAILs when it was created after the registration, and in any prospective audit; one excluded by its name or visibility and created after the registration (or with no creation time) is INCOMPLETE | `p3-pool-head` › finding 4 (E3a, E3b, visibility), › no creation time | E3a and E3b: WARN, VERIFIED | E3a and E3b: FAIL; visibility: INCOMPLETE |
| 5 | A repo transferred in after freeze FAILs | A repo the freeze's listing did not show, matching the rule, with window changes: INCOMPLETE with the note that it may be a transfer in. Transfer events: declined (below) | `p3-pool-head` › finding 5 (E8a); `pooled-verify` › repo created after freeze (rewritten) | FAIL | INCOMPLETE |
| 6 | The verifier's own token failing reads as fraud | A 401 is INCOMPLETE ("its access, not the audit, is at fault"); while the owner listing or the token's proof fails, an otherwise unexplained listing error is INCOMPLETE; a failure on one repo alone still FAILs | `p3-pool-head` › finding 6 (E7, and a 400 everywhere) | FAILED, exit 1 | INCOMPLETE, exit 6 |
| 7 | `verify --offline` prints VERIFIED | not this round's (P2 owns the verdict model) | | | |
| 8 | An edited "gone" done-marker is signed on resume without a probe | A gone marker is probed again on resume: still gone, its recorded evidence stands (the manifest stays byte-identical); there, it is listed | `p3-pool-head` › finding 8 (E8b, and a repo really gone) | the edited marker's repo signed into `goneRepos` | listed and in the manifest; verify PASS |
| 9 | GitHub's body-only secondary rate limit is never waited out | `RetryHints.rateLimitBody` and `blindRateLimitWaitMs` (`pr-rla/http`); the broker, the one retrier, treats a 403/429 whose body says "rate limit" as a rate limit and waits 1, 2, 4, 8, 15 minutes (GitHub's "at least one minute", then exponential, then an error), then gives up; freeze stops resumable (exit 4). The kit's harness applies the same policy | `p3-pool-head` › finding 9 (waits 60, 120, 240 s then success; five waits then exit 4) | no wait: freeze stopped at once | waited as documented; stopped resumably after the cap |
| 10 | WARN noise: one WARN per attribute-excluded repo | One summary WARN with the counts and a few names; each repo's line in `VerifyCheck.verbose`, printed by `verify --verbose`, always in `--json` | `p3-pool-head` › finding 10; `u8-review` › finding 1 (two tests read `verbose` now) | 7 WARN lines on a public-only rule over the 30-repo org | 1 line; 7 with `--verbose` and in `--json` |
| vis | The visibility proof's gaps: an OAuth App token may see only public repos; a GitHub App installation could not prove itself | `ListingVisibility.expected` (new, optional): the core holds a listing to the SCM's own count (GitHub's `total_private_repos`). An OAuth App token (`gho_`) proves an owner's listing only with that count. A GitHub App installation proves itself by `GET /installation/repositories` saying `repository_selection: "all"` on the owner | `p3-pool-head` › visibility proof (3) | `gho_`: complete; an installation: never; no count check | `gho_` without the count: INCOMPLETE, with it: PASS; installation on all: PASS, on selected: INCOMPLETE; a count larger than the listing: INCOMPLETE |
| tests | Tests that could not fail | pool-integrity's FR7.2 test rewritten for the push log (its synthetic provider labelled as one that lists PRs through history; the built-ins are tested in `p3-*`); the "no creation time" test now omits `created_at` (`createdAt: null` in the fake); the anchor moves heads; U8's test that pinned the backdated push as FAIL now expects PASS | as named | | |

### The push log, settled from the documentation and live reads

- **GitHub** (`GET /repos/{owner}/{repo}/activity`, REST API version 2022-11-28, the version pr-rla sends): `id`, `node_id`, `before`, `after`, `ref`, `timestamp`, `activity_type` (`push`, `force_push`, `branch_creation`, `branch_deletion`, `pr_merge`, `merge_queue_merge`), `actor`; filters `ref`, `direction`, `per_page`, `before`/`after` cursors, `actor`, `time_period`, `activity_type`; 200 or 422 ("Validation failed, or the endpoint has been spammed"). Fine-grained tokens need Contents read; public repositories need no token. The docs page's example response shows the 2026-03-10 shape (`pushed_at`, `push_type`, `pusher`) while its schema is 2022-11-28's; the live response (`x-github-api-version-selected: 2022-11-28`) has the schema's fields. **Retention is not documented.** Seen 2026-11-04: `github/gh-aw` (created 2025-08-12) returns its whole log from `branch_creation`; `torvalds/linux` begins at a `push` on 2023-03-07, so updates before about March 2023 are not served; `octocat/Hello-World` returns none. Each update's `before` is the previous update's `after` on the live log (all 29 consecutive pairs of the 30 read). pr-rla maps `push`, `pr_merge` and `merge_queue_merge` to fast-forward, `force_push` to forced, and reads at most 100 pages (10,000 updates) per repo.
- **GitLab** (`GET /projects/:id/events?action=pushed`): `push_data.action` (`pushed`, `created`, `removed`), `ref_type`, `ref`, `commit_from`, `commit_to`, `commit_count`; `before`/`after` take dates only; offset pages. **GitLab removes project activity events older than three years** (its docs, "Project activity time period limit"). A push of more refs than the instance's push event activities limit is a bulk event with null refs and commits. GitLab does not say whether a push was forced, so every update is kind `unknown` and verify checks the window-close tip's ancestry whenever the branch moved after the close (the first-parent shortcut usually settles it in one request). The live log of `gitlab-org/cli` interleaves every branch's pushes; `main`'s updates chain (the 4 consecutive pairs among the 20 events read first).
- **Bitbucket Cloud and Data Center** have no push log pr-rla can read with a token: a moved head there is INCOMPLETE wherever a window commit is not reachable from it, and the stopgap still FAILs a rewound head through merged pull requests.

### Live reads (all read-only GETs, 2026-11-04, UTC; 22 requests)

| When | What | Requests |
|---|---|---|
| 06:17–06:30, 07:34, 07:52 | GitHub docs: REST repositories (the activity endpoint), the activity view (2 pages), REST organizations (`total_private_repos`, owner-only, `admin:org` for classic and OAuth tokens), the org audit log (API only on Enterprise Cloud), REST app installations (`GET /installation/repositories` for installation tokens; its response schema has `total_count`, `repositories`, `repository_selection`) | 6 |
| 06:23 | `api.github.com`, no token: `github/gh-aw` activity (30 newest, and the 3 oldest), `torvalds/linux` and `octocat/Hello-World` (oldest), `github/gh-aw` (`created_at`) | 5 |
| 06:24 | GitLab docs: events API, project activity retention, user activity retention | 3 |
| 06:24 | `gitlab.com`, no token: `gitlab-org/cli` push events (20) | 1 |
| 06:41 | `gh auth token`: `/user` (which private fields it returns: none, so `/user`'s private counts were not used), the token's org memberships (role only), `/user` headers (`X-OAuth-Scopes` present) | 3 |
| 07:36 | pr-rla's own `GitHubProvider.pushLog` on `github/gh-aw` (one page reached the close; `analysePushLog`: proven against the live head) and `GitLabProvider.pushLog` on `gitlab-org/cli` (2 pages, 42 `main` updates; proven), through a fetch that refuses anything but GET and GraphQL queries | 4 |

Nothing was written anywhere; no scratch repository was used.

### Decisions and deviations

1. **The freeze span, not "the last push before frozenAt".** A pooled freeze lists its repos over hours after the manifest's `frozenAt` (the run's start), and a single-repo freeze lists after the command's start, so a push during the listing makes the honest head the tip only after `frozenAt`. The head must have been the tip at some instant from the manifest's `frozenAt` until seed round R published (freeze refuses to write after R; check 2 proves it with tokens). Soundness does not need a tighter bound: any post-close tip from which the close's tip is reachable is a legitimate freeze state.
2. **Beyond the brief: the tip when the window closed must be reachable from the frozen head.** "Tip at freeze" alone passes a server-side rewind: force-push the branch back after the window closes, freeze honestly, restore with a fast-forward merge. When the log shows an update after the close that the SCM does not call a fast-forward, verify checks the close's tip is on the frozen head's first-parent history (`firstParentPath`, repurposed: it no longer reads dates), else lists the window from the close's tip and FAILs what the frozen head lacks. Tested left and restored.
3. **Beyond the brief: the archive FAIL covers every prospective audit**, not only repos created after registration. In a prospective audit every window change is after registration, so "an archived repository is read-only" proves the archive came after them whatever the repo's age; the case is the review's E4b (a subset registration). Retrospective audits keep the WARN for repos that existed at registration.
4. **Transfer events: declined.** No built-in provider exposes transfers to a read token: neither GitHub's repository listing nor its activity log records one, GitHub's organization audit log has an API only on Enterprise Cloud, and no SDK capability is added without a provider that has the data. A repo the freeze's listing did not show is INCOMPLETE everywhere, with the note.
5. **The recorded evidence is informational.** `headEvidence` is the auditee's signed claim; verify decides from its own read of the log. Check 2 only holds the record to the manifest's own repos and heads. Recording it lets freeze print what the log cannot show before the audit is committed.
6. **The stopgap lives in the providers.** Each built-in already walks history from the head for direct pushes; a pull request merged in the window whose merge commit the walk did not visit is confirmed with one ancestry request (GitHub compare status, GitLab `merge_base`, Bitbucket commit ranges), at most 10 asked and stopping at the third unreachable. It runs only when both kinds are listed (a pull-request-only audit's population does not depend on the head on these providers). An unconfirmable answer (404, 422) is not reported.
7. **#6 is read as "the verifier's own access is failing":** a 401 anywhere, or an owner listing or token proof that throws, turns an otherwise unexplained listing error INCOMPLETE. A probe that succeeds still makes a missing commit a FAIL.
8. **An OAuth App token needs the org's count.** GitHub sends `total_private_repos` only to owners, and to classic and OAuth tokens only with `admin:org` (its docs); the `gh` CLI's token is an OAuth App token (`gho_`, checked on this machine by its prefix alone), so without `admin:org` it cannot prove private completeness. That is the price of the review's OAuth App restriction case; a classic token, or adding `admin:org` to the token, restores it. A token's kind is read from its prefix in-process and never logged.
9. **The rate-limit hints stay in-process.** The plugin host carries `maxRetries`, `maxBlindRateLimitRetries` and `acceptJson`; the two new hints are for built-ins (an isolated plugin keeps its own retries).
10. **The fake org can follow the test's clock** (`control.now`), so a prospective test does not see commits dated after its freeze; it is off by default, which keeps every earlier test's fake unchanged.
11. **Found while fixing:** a repo the freeze's listing records as a fork (or not the owner's) that is not one now, with window changes, is INCOMPLETE rather than skipped (the listing is the auditee's record); an update listed twice (GitLab's offset pages) is one update; a bulk push as the last update before the window's close leaves the tip then unknown (no evidence); a proven head whose reach of the close's tip could not be shown gets no FR7.2 note (the check's own FAIL or INCOMPLETE stands); the attribute WARN's quiet list is a count.

### Single-repo behaviour changes (all deliberate)

- A GitHub or GitLab manifest records `headEvidence`, so its sha and the commitment's differ from master's; `freeze` and `verify` print one push-log line. The anchor test removes exactly these and is otherwise byte-equal to master.
- Every frozen head is held to the push log: a rewound one FAILs; a moved one is VERIFIED where the log places the unreached window commits (all six honest shapes, equal to master check by check), and INCOMPLETE where no log exists.
- `freeze` makes one more request per repo (the push log), and `--estimate` counts it.

### Tests

985 passed, 1 skipped (71 files) at `66e3f54`; 1043 passed, 1 skipped (73 files) now. New: `test/p3-pool-head.test.ts` (44), `test/p3-head-proof.test.ts` (13). Changed: `u8-review` (7 tests: five finding 3 tests for the new messages, one of them the backdated push now PASS; two WARN tests read `verbose`), `pooled-verify` (the repo after freeze is INCOMPLETE; a new FAIL test; the no-creation-time test omits it), `pool-integrity` (the FR7.2 test), `single-repo-anchor` (moved heads), `pooled-plugin` (`pushLog` over IPC, the estimate's extra requests), `list-repos` (the opt-in list). Helpers: `fake-org.ts` (push log, `forcePush`, `pushCommits(…, { at })`, `control.pushLog`, `control.now`, `control.orgTotalPrivate`, `viewer.installation`, `createdAt: null`), `fake-gitlab.ts` (push events, `merge_base`).

### Files touched in this round

- Commands (thin): `src/commands/freeze.ts` (one field into the manifest), `src/commands/register.ts` (`preflightRepoSet` calls `registerRuleRepos`; two record fields; the warnings printed), `src/commands/verify.ts` (`--verbose`: one option field, one print line), `src/cli.ts` (the `--verbose` option).
- API: `src/api/pooled-freeze.ts` (the gone-marker probe, the push-log pass, the unreachable warning), `src/api/freeze-estimate.ts` (one request per repo).
- Core: `src/core/head-proof.ts` (new), `src/core/rebuild.ts` (rebuilt), `src/core/repo-set.ts` (`listingProof`, `registerRuleRepos`, check 2's two pool rules), `src/core/records.ts` (`registeredVisibility`, `headEvidence`, accessors), `src/core/verify.ts` (check 2's arguments, check 5's inputs and `verbose`), `src/core/population.ts` (the `unreachable` contract).
- SDK and plumbing: `src/sdk/provider.ts` (`pushLog` and its types, `NO_COMMIT`, `ListChangesResult.unreachable`, `ListingVisibility.expected`), `src/sdk/http.ts` (two hints and two helpers), `src/net/broker.ts` (the retry loop only), `src/testing/conformance.ts` (the harness's retry policy; the `push-log` check), `src/plugins/{protocol,child,host}.ts` (one method name each).
- Providers: `src/providers/github/{index,http}.ts`, `src/providers/gitlab/index.ts`, `src/providers/bitbucket-cloud/index.ts`, `src/providers/bitbucket-data-center/index.ts`.
- Docs: `README.md`, `docs/org-pooled-audits.md`, `docs/security-model.md`, `docs/writing-a-provider.md`, `docs/design/phase-3-4/contracts.md` (§1, §5, §7).

### For the merges that follow

- **U5** (`src/api` refactor): the four command files above change by a few lines each; `src/api/pooled-freeze.ts` gained the push-log pass and `src/api/freeze-estimate.ts` one line. The MCP `verify` tool should carry `VerifyCheck.verbose` through, and a `freeze_preview` estimate counts the push log.
- **fix/plugins-broker**: overlaps in `src/net/broker.ts` (this round touches only `withRetries` and an import), `src/sdk/http.ts` (two hints after `acceptJson`, two helpers after `backoffMs`), `src/sdk/provider.ts` (additions), `src/plugins/{protocol,child,host}.ts` (`pushLog` in each method list and wrapper; the IPC v2 rewrite must keep it), `src/testing/conformance.ts`, `docs/writing-a-provider.md`, `contracts.md` §1. None is a semantic conflict.
- **P1** (check 5's provider identity, check 7): `src/core/verify.ts` check 5's call site and `src/core/rebuild.ts`; the identity lines are untouched.
- **P2** (verdict model, checks 1–4 and 6): `VerifyCheck` gained the optional `verbose`; check 2's pool rules gained the `registeredRepos` requirement and the `headEvidence` record check (inside `poolRecordProblems`).

### Unverified

- The push log of a repository whose default branch was renamed, of GitHub Enterprise Server (whether it serves `/activity`), and of a GitLab instance with bulk pushes on the default branch, against live servers. The fakes follow the documented shapes and the two live logs read.
- Bitbucket Data Center's ancestry request (`commits?until=&since=&limit=1`), like the provider, against a live server; Bitbucket Cloud's `commits?include=&exclude=` was built from the documented API and tested on the fake only.
- `GET /installation/repositories` and `total_private_repos` against live responses: no installation token or org-owner `admin:org` token was used (the only org the available token administers is not one pr-rla may use).
- GitHub's activity log beyond what was read: its retention is undocumented, and the 100-page cap (10,000 updates since the window closed) means a verify of a very busy repository long after the window has no evidence for a moved head.

### Verified (command → output)

Each run is a fresh `git clone --branch fix/p3-pool-head` of this worktree into the scratch directory, then `npm ci && npm run build && npm run typecheck && npm test`, then `npm --prefix examples/providers/gitea ci && npm --prefix examples/providers/gitea test` and the same for `examples/ledgers/jira` (`packages/pr-rla-mcp` and `integrations/github-action` do not exist yet). The suite makes no network call (the network-deny harness).

| Run (2026-11-04, UTC) | At | Load average | Result |
|---|---|---|---|
| 1, 2, 3 (07:46–07:58) | `8b74947` | 14–28 | build and typecheck (both tsconfigs) clean; `Test Files 73 passed (73) · Tests 1042 passed \| 1 skipped (1043)`; gitea `# pass 1`, jira `# pass 1`, in all three |
| 4, 5, 6 (08:02–08:12), one after another | `af180ac` (the last code: the FR7.2 note's condition and the bulk push at the close) | 6–29 | the same, with `Tests 1043 passed \| 1 skipped (1044)`, in all three |

The five demo scripts (`demo-broker`, `demo-ledgers`, `demo-plugin-host`, `demo-presence`, `demo-sdk-carry-overs`) exit 0. This commit adds only these lines to `af180ac`.

## Bolt 7 (U7): CI integrations (2026-11-04)

Branch `bolt/u7-ci-integrations`, from `0fa9ad8` (the wave-2 integration plus the U5 seam tests). A GitHub composite action, a GitLab CI/CD component with a plain-snippet twin, and a Bitbucket Pipelines step, with a CI guide per SCM. All tested on fixtures and mock servers; nothing published, nothing written to a real service.

### Definition of done (delivery-plan.md, bolt 7)

FR6.1 to FR6.7 pass on fixtures and mock servers, and the templates pass schema checks. The demo: the Action's steps on a fixture ESCALATE fail the job.

| ID | Covered by |
|---|---|
| FR6.1 Action: status and verify, summary, fails on ESCALATE, optional comment | `test/ci-github-action.test.ts`: "FR6.1: status on fixtures gives the right job outcome" (CERTIFIED passes with outputs and summary; a label-event fixture and `comment: true`; **DEMO, ESCALATE fixture fails the job**; fail-on tolerance; refusal; exit 1; verify; `dir`), "the comment is best effort and the token stays on GitHub", "what pr-rla prints is data" |
| FR6.2 GitLab component, typed inputs, push to `audit/**` and a schedule | `test/ci-integrations.test.ts` "FR6.2, FR6.5: the GitLab component and the plain snippet pass GitLab's CI schema"; `test/ci-job-scripts.test.ts` "the GitLab component (FR6.2)" (typed inputs, the rules for push, schedule, trigger and web, `audit-path`, mock gitlab.com runs) |
| FR6.3 Bitbucket step, no pipe | `test/ci-integrations.test.ts` "FR6.3, FR6.5: the Bitbucket step passes Bitbucket's pipelines schema"; `test/ci-job-scripts.test.ts` "the Bitbucket step (FR6.3)" |
| FR6.4 exact version, `--plugins builtin-only` unless opted in | `test/ci-integrations.test.ts` "FR6.4, NFR18: every integration pins ..."; `test/ci-github-action.test.ts` "FR6.4"; `test/ci-job-scripts.test.ts` "pinning (FR6.4)" and "runs pr-rla --plugins builtin-only by default" |
| FR6.5 fixtures and mocks only | the harness (`test/helpers/ci-harness.ts`), the vendored schemas test, and `denied` assertions (no socket left the machine) in every run |
| FR6.6 no publish | `test/ci-integrations.test.ts` "FR6.6: nothing in the build publishes" |
| FR6.7 matrix, one ledger per SCM | `docs/ci/README.md` "End-to-end matrix"; `test/ci-integrations.test.ts` "FR6.7: the end-to-end matrix names one ledger per SCM, and each cell points at a test that runs" |
| NFR1 scopes | `docs/ci/README.md` "Scopes" (each row marked unverified); every tracker request in the Action and GitLab runs is a GET; `checkpoint` writes to the bare remote only |
| NFR3 no public writes | every run asserts `denied` is empty; the only POSTs are the opt-in comment, to the mock |
| NFR11 offline fixtures | `test/helpers/ci-preload.cjs` refuses non-loopback sockets in every child; `npm test` opens none |
| NFR16 exit codes | `test/ci-integrations.test.ts` "the exit-code mapping" (15 codes by 6 lists, in dash and bash); the mapping tables in all three runners |
| NFR18 supply chain | the pin tests above; `npm --prefix integrations/github-action ci` |
| NFR19 platforms | `docs/ci/README.md` "Platforms" (macOS tested here; Linux unverified; Windows untested) |

### Done

- **`integrations/github-action/`**: `action.yml` (composite), `package.json` and `package-lock.json` (private, UNLICENSED, one dependency), `vendor/pr-rla-0.1.0.tgz`, `scripts/{prepare.sh,run.sh,exit-map.sh,report.mjs,comment.mjs}`.
- **`integrations/gitlab/templates/pr-rla.yml`**: two YAML documents, `spec:inputs` (12 typed inputs) and the job.
- **`docs/ci/{README,github,gitlab,bitbucket}.md`**: guides, the matrix, the scope table, the platforms note, the credentials models, and the release re-pin steps for U10. The README gets a "CI integrations" section (before "Architecture").
- **`test/helpers/ci-harness.ts`, `ci-fixtures.ts`, `ci-preload.cjs`**: the harness (below). **`scripts/pack-action-tarball.mjs`**: rebuilds the vendored tarball and the lockfile. **`scripts/demo-ci.mjs`**: the demo.
- **`ajv@8.20.0`** (exact) in devDependencies: the pinned JSON-schema validator.

### The harness (FR6.5)

- **`runComposite`** reads `action.yml`, evaluates the `${{ }}` subset it uses (contexts `inputs`, `github`, `runner`, `steps`; `==`, `!=`, `&&`, `||`, `!`; `always()`, `success()`, `failure()`; anything else throws), and runs each `run` step with `bash --noprofile --norc -e -o pipefail`, with `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY` and `GITHUB_ENV` on temporary files. A `uses` step is recorded, never fetched. The `install` step (`npm ci`, which needs the network) is skipped by id, and a test pins its exact text. The action path is a copy of the action with a `pr-rla` shim running `dist/cli.js` where `npm ci` would have put one.
- **`runScript`** runs a GitLab job's or a Bitbucket step's `script` lines in one shell (dash for GitLab where `/bin/dash` exists, bash for Bitbucket). `renderGitLabTemplate` interpolates `$[[ inputs.x ]]` the way GitLab does and `ruleApplies` evaluates the component's `rules`.
- **Mock servers**: `MockApi` is one HTTP server on 127.0.0.1 with a path prefix per mocked origin. The real CLI runs unchanged in a child; `ci-preload.cjs` (`NODE_OPTIONS=--require`) swaps only the last hop of `fetch` for the origins in `PRRLA_TEST_ROUTES`, so the broker's grants, read-only guard and pacing run as in production, and refuses every other socket (recorded in a file the test reads). The trackers behind it are `FakeGitHubIssues` and `FakeGitLabIssues` (synthetic).
- **Fixtures** (`test/fixtures/ci/README.md`): synthetic github-issues, gitlab-issues and small-population audits built at test time with the in-process commands; the recorded gh-aw Q3 audit plus synthetic verdict lines for git-file; one synthetic `issues`/`labeled` event payload.
- The child's git is hermetic (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`): a machine-wide gitconfig identity had been reaching a checkpoint commit.

### Settled or recorded, with dates (all read-only; 2026-11-04)

- **`actions/setup-node`**: `gh api repos/actions/setup-node/tags` at 08:21Z. Latest release v7.1.0 is commit `949feb2413d6458794dcd2491c4babbbce0c15c1` (committed 2026-10-08T02:43:26Z; a commit, not a tag object). Its `action.yml` has `package-manager-cache`, set to `false`. Pinned in `action.yml` with `# v7.1.0` at `node-version: "24"`.
- **`actions/checkout`**: v7.0.1 is `3d3c42e5aac5ba805825da76410c181273ba90b1` (committed 2026-07-17T18:45:11Z); used in the docs example only.
- **Schemas**, each fetched once with a GET and vendored byte for byte under `test/fixtures/schemas/` (URL, date, bytes and sha256 in `SOURCES.json`, checked by a test):

  | File | Source | sha256 |
  |---|---|---|
  | `github-action.json` (31,255 bytes) | `https://www.schemastore.org/github-action.json` (identical to `json.schemastore.org/github-action.json`) | `224326cc…` |
  | `gitlab-ci.json` (128,124 bytes) | `https://gitlab.com/gitlab-org/gitlab/-/raw/master/app/assets/javascripts/editor/schema/ci.json` | `2ed7f27a…` |
  | `bitbucket-pipelines.json` (33,271 bytes) | `https://api.bitbucket.org/schemas/pipelines-configuration` (SchemaStore's catalog points there and carries no copy; `json.schemastore.org/bitbucket-pipelines.json` is a 404) | `b3731926…` |

  All three are JSON Schema draft-07 and compile under ajv 8.20.0 with `strict: false` and `validateFormats: false`.
- **Image digests** (Docker Hub's public tag API): `node:24-alpine` index `sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85` and `node:24` index `sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413`, both tags last updated 2026-10-28.
- **The pin**: `npm pack` of this checkout is `integrations/github-action/vendor/pr-rla-0.1.0.tgz`, sha512 `P9hXc6xR…dng==`, recorded in the Action's lockfile. `npm ci` there installs 21 packages and `pr-rla --version` prints 0.1.0.

### Verified (command → output), Node 22.23.2

```
npm ci && npm run build && npm run typecheck && npm test
  Test Files  86 passed (86)      (before this bolt, on 0fa9ad8: 83 files)
  Tests       1420 passed (1420)  (before: 1218; +202, all in the three new files)
  ~118 s (before: ~79 s), the three CI files running beside the others
npm --prefix packages/pr-rla-mcp ci && npm --prefix packages/pr-rla-mcp test     # 59 of 59
npm --prefix examples/providers/gitea ci && npm --prefix examples/providers/gitea test   # 1 of 1
npm --prefix examples/ledgers/jira ci && npm --prefix examples/ledgers/jira test         # 1 of 1
npm --prefix integrations/github-action ci      # 21 packages; node_modules/.bin/pr-rla --version = 0.1.0
```

The new tests by file: `test/ci-github-action.test.ts` 46, `test/ci-job-scripts.test.ts` 113, `test/ci-integrations.test.ts` 43. Every `npm test` run listed `denied` connections as empty for the Action and the two job-script runners; the vitest process's own network-deny setup also passed for all three files.

Shellcheck (not part of the suite; run by hand, 2026-11-04) is clean for `prepare.sh`, `run.sh`, `exit-map.sh` and the shared job script, apart from two info notes (`SC1091` not following a sourced file, `SC2016` about the single-quoted `node -e`).

### The demo

`npm run build && node scripts/demo-ci.mjs` (offline, Node 22.23.2) runs the Action's `prepare.sh` and `run.sh` as the runner would on a fixture ESCALATE audit and on a fixture CERTIFIED one:

```
== fixture ESCALATE (6 fails of 6 labelled draws) ==
  [run.sh] pr-rla --plugins builtin-only -C . status --json --offline -> exit 2
  [run.sh] pr-rla: prefix 6/36 · fails 6 · claim D (detected-defect rate ≤ 10%, protocol f484…, stratum ≤ 200 lines, direct pushes via a pushed merge included) · LLR -9.657 / target 2.996 · ESCALATE: review all 1,589 or narrow the claim · RETROSPECTIVE · TIMESTAMP NOT TAMPER-PROOF
  outputs: state=ESCALATE prefix=6/36 llr=-9.657 exit-code=2
  job summary: ## pr-rla status / ### ESCALATE / the certificate line / a table / **Job result: FAIL** (exit 2: ESCALATE …; fail-on includes escalate)
  [decide] ::error title=pr-rla::exit 2: ESCALATE (the sequential test cannot certify), or the seed round is not yet published; fail-on includes escalate
  JOB RESULT: FAILED

== fixture CERTIFIED (36 passes) ==
  outputs: state=CERTIFIED prefix=36/36 llr=3.066 exit-code=0
  JOB RESULT: passed
```

The same thing, with `action.yml` read and its expressions evaluated, is the test "DEMO, ESCALATE fixture fails the job" in `test/ci-github-action.test.ts`.

### Deviations from the design, and why

1. **`window` input dropped.** The design lists it; the CLI has no `--window` option (the window is in `.pr-rla.yml`).
2. **Added inputs and outputs.** `comment-issue` (the audit issue, defaulting to the event's), `approve-origins`, `accept-lock-grants`, `allow-writes`, `token`; output `exit-code`. The design's `sample` stays out of the default and is accepted only with `allow-writes: true`, as in the draft.
3. **pr-rla is a vendored tarball, not an npm version.** Nothing is published, so the lockfile pins a tarball made by `npm pack` from this checkout and its integrity. The re-pin to the published version is written out in `docs/ci/github.md`. The tarball is a snapshot: it does not move when `src/` does, and `node scripts/pack-action-tarball.mjs` re-takes it. The root `.gitignore` ignores `pr-rla-0.1.0.tgz`, so one exception was added for that directory.
4. **GitLab and Bitbucket offer `status` and `verify` only.** The design lists `checkpoint` for the component. Pushing needs a write credential and git auth plumbing a job does not have, and none of it could be exercised against a real remote with a token, so the guides say to run `checkpoint` and `sample` from a clone with push rights. (The Action's checkpoint uses the checkout's own credentials and was tested against a local bare repo.)
5. **No `act`-style full workflow run.** The harness runs the composite action's steps only (`workflow` events, `permissions:` and `uses:` resolution are not simulated); the example workflow is a documented example and is checked only for its pins.
6. **GitLab and Bitbucket install by version, not by lockfile.** They have no lockfile of their own. The script requires one exact version, checks `--version` after the install, installs with `--ignore-scripts`, and takes an optional `integrity` (checked against `npm view`). Transitive dependencies still resolve on the day. Recorded for U10: publish with an `npm-shrinkwrap.json`.
7. **Credential approvals use `approve-origins`**, the typed input the brief suggests, in the Action and the component; `PRRLA_APPROVE_ORIGINS` in the snippet and Bitbucket. Entries are `ENV_VAR=https://host`.
8. **Booleans of the component are strings with `options`.** GitLab keeps the type of an input that is the whole value, which would put a boolean in a `variables:` map.

### Findings

- **A withheld credential does not fail anything.** On GitHub Enterprise Server with no `approve-origins`, `pr-rla status` runs anonymously, a private tracker answers 404, and the job passes `NOT_CERTIFIED 0/36` with exit 0. The only sign is one stderr line (`… is not approved on this machine, so withheld`). The Action now puts stderr in the summary, and the guides name the line. Whether `status` should exit non-zero when a credential was withheld and the ledger then read nothing is a CLI decision I did not make. Test: "a self-hosted SCM gets no token without an approve-origins entry".
- **`npm install --package-lock-only` keeps a stale integrity for a `file:` tarball whose bytes changed**, both from the lockfile and from `node_modules/.package-lock.json`. The first version of the pack script reported success with the old integrity. It now deletes both and checks the result against the tarball's own sha512.
- **The Bitbucket schema accepts a step with no `script` and a step with an unknown key.** The GitLab and GitHub schemas refuse the equivalents. The Bitbucket test records this and adds its own structural assertions.
- **The `git-file` ledger cannot be checkpointed** ("ledger git-file has no readHistory"), so `checkpoint --push` in CI needs an issue ledger. The harness test uses github-issues and a local bare remote.
- **Exit 3 comes from `sample` in practice.** `status` reports a refusal only when a sampled audit's population is below the minimum, which `sample` refuses to produce; the harness covers exit 3 through `sample` on a 12-change audit and the REFUSED state through a canned status result.
- **A runner has no git identity.** The checkpoint is a commit, so `run.sh` sets the `github-actions[bot]` identity unless the repository sets one. The harness caught the other direction: the machine's own system gitconfig identity leaked into the commit until the harness made git hermetic.
- **A child bash inherits no `-e`, but `run.sh` is also run directly in the demo.** `run.sh` now says `set +e` itself, since the exit code is its data.
- **An offline `verify` of a tracker ledger skips check 7 and still says VERIFIED** (exit 0). The Action therefore reports no `state` for it (the certificate was not read); the summary shows the verdict and the seven checks.
- **A shell glob in `approve-origins`** would have expanded against the checkout; both shell versions run the loop under `set -f`. Origins are checked to `https://` plus host characters, and the approvals file's directory is compared by physical path (a symlink cannot move it into the workspace; the GitLab and Bitbucket first version compared strings and the test caught the macOS `/var` to `/private/var` case).

### Unverified

- Any run on a real GitHub runner, GitLab instance or Bitbucket pipeline. In particular: GitLab's own interpolation of `spec:inputs` and its rule evaluation; Bitbucket's handling of the YAML anchor for the shared script; `condition: changesets` on Bitbucket; the Actions runner's expression semantics beyond the subset the harness implements.
- Linux. Everything ran on macOS 26 (Node 22.23.2, bash 5.3, dash from `/bin/dash`). Alpine's `ash` is not dash; the script uses only POSIX constructs, but it was not run under ash.
- The webhook route for GitLab label events (described from GitLab's documentation).
- Bitbucket Data Center (as in phase 2).
- That `npm install pr-rla@X` from the registry behaves like the tarball: nothing is published.
- That `GITHUB_TOKEN`'s default permissions cover reading the audit repository's issues (documented as the scope, exercised on a mock).

### Shared files touched (for the integration step)

- `README.md`: a "CI integrations" section inserted before "Architecture: bring-your-own providers and ledgers". U6 will add its own README section; keep both.
- `package.json` and `package-lock.json`: one devDependency, `ajv` `8.20.0`. U8 and U9 changed neither when branched; resolve by keeping both sides' edits and re-running `npm install`.
- `.gitignore`: one appended exception for `integrations/github-action/vendor/pr-rla-*.tgz`.
- `BUILD-NOTES.md`: this section is at the end.
- Nothing in `src/` changed, so no code from U5, U8 or U9 can conflict. The vendored tarball is a snapshot of `dist/` at this branch's tip; after the merge, re-take it with `node scripts/pack-action-tarball.mjs` (it is the only place the integrated build would otherwise differ from what the Action installs).
- `test/ci-*.test.ts` read `dist/cli.js`, so run `npm run build` before `npm test` (as `api-cli-contract.test.ts` already needs).

### What U10 needs to know

- The re-pin is `docs/ci/github.md`, "Re-pinning at release": 7 numbered steps, including what to delete (`vendor/`, `scripts/pack-action-tarball.mjs`, the `.gitignore` exception) and which defaults to change in the GitLab template, the snippet and the Bitbucket step. The tests read the root `package.json` version, so they need no edit; they accept both the tarball form and an exact registry version.
- Decide on `npm-shrinkwrap.json` for the published package (finding 6 above).
- The README's Windows statement (NFR19) is U10's; `docs/ci/README.md` says only what applies to CI.
- `<owner>/pr-rla` and `<exact ref>` in `docs/ci/*.md` are placeholders until the repository has an address.

## Bolt 8 (U6): assistant integrations (2026-11-04)

Goal (delivery-plan.md, bolt 8): FR3.7. The Claude Code plugin (manifest, the MCP server configuration with an exact-version `npx` pin, the `review-draw` skill, the guard hooks), the Codex and Cursor setup with each client's equivalent guard, and the founder's manual runs in all three clients (FR3.6), which this bolt prepares and does not run.

Built on branch `bolt/u6-assistants` from the end of U5's fix round (`3e21347`, branch `bolt/u5-audit-api-mcp`), not master. The guard is written against the CLI that `integrate/wave2` (plugin approvals, per-verdict signatures, INCOMPLETE) has as of `a6622f2`, read-only: `pr-rla plugin approve`, `--accept-lock-grants`, `PR_RLA_ACCEPT_LOCK_GRANTS`, `PR_RLA_APPROVALS_FILE` and its `XDG_CONFIG_HOME`/`~/.config` fallbacks, `pr-rla record --sign` and `ssh-keygen -Y sign -n pr-rla-verdict@v1`.

### Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR3.7 a Claude Code plugin carries the `review-draw` skill, the MCP server configuration and hooks that block verdict writes and `--submit` from the assistant | met | `integrations/claude-code/`; `test/assistants/integrations.test.ts › the Claude Code plugin` (layout, manifest, marketplace, `.mcp.json`, hooks) and `› the review-draw skill`; `claude plugin validate` passes (below) |
| FR3.7 pass criterion: hook tests, ten blocked and ten allowed commands | met, 340 blocked and 91 allowed | `test/assistants/guard.test.ts`: 431 named cases across Claude Code, Codex and Cursor, each decided by `evaluate()` and again by `guard.mjs` as the hook process |
| FR3.7 Codex and Cursor get setup guides | met | `docs/assistants/codex.md`, `docs/assistants/cursor.md`, with the committed files verbatim (`› the guides show the files as committed`) |
| test-design §2 U6: the hook tests include `checkpoint --push` | met | `guard.test.ts › blocks: pr-rla checkpoint --push` and `› … --remote/--branch` |
| test-design §2 U6: `claude plugin validate` on the plugin directory | met (Claude Code 2.1.267) | below |
| FR3.6 / delivery plan: three dated manual runs in BUILD-NOTES | **pending, the founder's** | `docs/assistants/manual-acceptance.md`; the three rows below |
| FR3.3 for the skill (U5 met it for the MCP surface): no skill records, edits or removes a verdict | met | `integrations.test.ts › never tells the assistant to record, label or sign`; `packages/pr-rla-mcp/test/review-draw-flow.test.mjs` (the flow ends with the person's command, which the guard blocks from the assistant) |
| FR3.9 for the skill: the fenced text is data | met | skill step 3; `review-draw-flow.test.mjs › step 3`; `guard.test.ts` blocks what an injected instruction would ask for |
| NFR3 assistant hooks block `--submit`, issue-label writes and verdict writes | met | `guard.test.ts` (verdicts, `--submit`, labels through `gh`, `glab`, `curl`, `wget`, HTTPie, other MCP servers) |
| NFR16 an assistant hook block exits 2 | met | every blocked case through the hook process asserts exit 2 |
| NFR18 integrations pin exact versions | met | `integrations.test.ts › .mcp.json launches pr-rla-mcp through npx at the exact package version` and `› every pin of pr-rla-mcp in the integrations is the one version` |
| NFR11 `npm test` makes no network call | met | the new root tests run under the network-deny harness; the guard spawns only local `git`, `tar` and `unzip` |
| T18 (nfr-design §2): the assistant hook blocks `checkpoint --push` | met | as above |
| Demo: `review-draw` in Claude Code, ending with the human's own `record` command | rehearsed offline; the real run is the founder's (Claude Code row below) | `node packages/pr-rla-mcp/scripts/demo-review-draw.mjs` (below) |

### Done

| Piece | Where |
|---|---|
| The plugin: manifest (`name: pr-rla`, `version: 0.1.0`, `author: pr-rla`, no licence), `.mcp.json` (`npx -y pr-rla-mcp@0.1.0 --root ${CLAUDE_PROJECT_DIR}`, read-only token mapping), the skill, `hooks/hooks.json`, `hooks/guard.mjs`, a README | `integrations/claude-code/` |
| The marketplace listing the plugin by relative path | `.claude-plugin/marketplace.json` |
| `review-draw`: frontmatter (`allowed-tools` the five read MCP tools under the plugin's scoped names plus `Read`; `disallowed-tools` the shell and the editors) and the five-step body | `integrations/claude-code/skills/review-draw/SKILL.md` |
| The same skill for Codex and Cursor (`name`, `description` only; the body byte-identical), and the AGENTS.md block of standing rules | `integrations/agents/` |
| Codex: `config.toml` (pinned server, `env_vars`, 60 s timeouts), `hooks.json` (`PreToolUse` on `Bash`, `apply_patch`, `mcp__*`) | `integrations/codex/` |
| Cursor: `mcp.json` (pinned server, `${workspaceFolder}`, read-only token mapping), `hooks.json` (four hooks, `failClosed`), an always-applied rule | `integrations/cursor/` |
| The guard: a shell parser, the rules, one adapter per client, `--check-shell`, `--record` | `integrations/claude-code/hooks/guard.mjs` (no dependencies) |
| A local copy of the plugin running this checkout's server, for the founder's runs before release | `scripts/local-claude-plugin.mjs` |
| The skill's flow through the server (test and rehearsal) | `packages/pr-rla-mcp/test/review-draw-flow.test.mjs`, `packages/pr-rla-mcp/scripts/demo-review-draw.mjs` |
| Docs: setup index (the read-only token, before release, what a release changes, the formats' sources), one guide per client, the guard's rules and limits, the founder's checklist; a README section; the security model's tier 3 | `docs/assistants/`, `README.md`, `docs/security-model.md` |
| Fixtures: one payload per client event, synthetic, from the documented shapes | `test/fixtures/hooks/` |
| Tests: 901 new at the root, 7 in the package (root 624 passed and 1 skipped before, 1525 and 1 after; package 57 before, 64 after) | `guard.test.ts` 874 (431 cases × 2, the case-list check, and 11 on the hook protocol, crafted-input timing and the size limits among them), `integrations.test.ts` 27; `review-draw-flow.test.mjs` 7 |

### Live reads (all read-only GETs; 2026-11-04)

| When (UTC) | What |
|---|---|
| 07:07:18 to 07:07:39 | Claude Code docs, as Markdown (`https://code.claude.com/docs/en/<page>.md`): plugins-reference, hooks, skills, mcp, plugin-marketplaces, plugins, plugins/components, plugins/marketplace-reference, plugins/loading, plugins/cli-reference, plugins/troubleshooting, plugins/install, plugins/create |
| about 07:09 | Codex docs: eight pages under `https://developers.openai.com/codex/` (each redirected to `learn.chatgpt.com`), then their Markdown twins 07:09:50 to 07:10:00: hooks, extend/mcp, config-file/config-reference, config-file/config-basic, build-skills, agent-configuration/agents-md, agent-configuration/rules, agent-approvals-security, and `llms.txt` |
| 07:10:46 to 07:11:23 | Cursor docs: `https://cursor.com/llms.txt`, then rules, skills, hooks, mcp and reference/third-party-hooks as Markdown |

No write anywhere; no model was called (no `claude -p`, no Codex or Cursor session); nothing was installed from a marketplace or npm. `claude plugin validate` reads local files only.

### What the official docs settled

- **Claude Code plugin MCP tool names** are `mcp__plugin_<plugin>_<server>__<tool>`: here `mcp__plugin_pr-rla_pr-rla__draws`. A skill's `allowed-tools` and a hook matcher must use that form; one written against the bare server name never matches (plugins/components, mcp).
- **`${CLAUDE_PROJECT_DIR}` is substituted in a plugin's MCP `args`** (mcp, "Plugin-provided MCP servers"). So `.mcp.json` passes `--root ${CLAUDE_PROJECT_DIR}` and the plugin no longer depends on the server's working directory, the item the design left open for this bolt. The manual run still checks it.
- **Skill frontmatter**: `allowed-tools` pre-approves for the turn that invokes the skill and restricts nothing; `disallowed-tools` exists and removes tools while the skill is active; both clear on the user's next message (skills). So across a multi-turn review only the hooks keep holding.
- **Hooks**: exec form (`command` plus `args`) passes `${CLAUDE_PLUGIN_ROOT}` with no shell; exit 2 blocks a `PreToolUse` call with stderr as the reason; `onFailure: "block"` needs Claude Code 2.1.295 (hooks).
- **`${VAR:-default}`** expands in `.mcp.json` `env`, and an unset variable with no default stays unexpanded with a warning (mcp), hence `${PR_RLA_READONLY_GITHUB_TOKEN:-}`.
- **Codex hooks are now documented** (hooks): `PreToolUse` with `tool_name` `Bash`, `apply_patch` or `mcp__<server>__<tool>`, the command or patch in `tool_input.command`, plus `turn_id`; deny by exit 2 with stderr, or by `hookSpecificOutput.permissionDecision: "deny"`; hooks need a trust review per hash; plugins export `CLAUDE_PLUGIN_ROOT` for compatibility. So the design's "Codex's hook payload is unverified" becomes **documented, not observed**: nothing here ran Codex.
- **Codex MCP**: `env_vars` whitelists variables for a stdio server; `startup_timeout_sec` defaults to 10 and `tool_timeout_sec` to 60 (extend/mcp, config-reference). Skills live in `.agents/skills` with `name` and `description` (build-skills).
- **Claude Code's `Monitor` tool runs a shell command** (`command`, with `description`, `timeout_ms`, `persistent`; or a `ws` WebSocket, which runs nothing), read from the tool's schema in a Claude Code session on 2026-11-04, not from the docs pages above. So the hooks match it and the guard reads its `command` like `Bash`'s.
- **Cursor** reads Agent Skills from `.agents/skills/` (and `.cursor/skills/`), reads `AGENTS.md`, and loads Claude Code hooks from `.claude/settings*.json` with its own answer format (skills, rules, third-party-hooks). Its permission hooks (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse`) block on invalid JSON even without `failClosed`, so the guard always prints `{"permission":"allow"}` or a deny object for Cursor (hooks).

### Verified (command → output)

`claude plugin validate`, Claude Code 2.1.267, 2026-11-04:

```
claude plugin validate integrations/claude-code            → ✔ Validation passed
claude plugin validate --strict integrations/claude-code   → ✔ Validation passed (exit 0)
claude plugin validate .                                   → ✔ Validation passed (the marketplace)
claude plugin validate integrations/agents                 → ✔ Validation passed (the portable skill)
node scripts/local-claude-plugin.mjs <scratch>/local-plugin && claude plugin validate <scratch>/local-plugin → ✔ Validation passed
```

Its checks of MCP server entries need 2.1.281 or later, so `.mcp.json` rests on the docs and `integrations.test.ts`. It accepted the `onFailure` field that 2.1.295 acts on. An experiment in the scratchpad confirmed it does read `hooks/hooks.json` and skills: an unknown hook type and invalid JSON each fail validation; a skill with no `description` warns.

From a fresh `git clone` of the branch at `9a38be8`, 2026-11-04T09:09:27Z, Node 22.23.2, Claude Code 2.1.267 (load average about 20: other work ran on the machine):

```
npm ci                                       → added 60 packages … found 0 vulnerabilities
npm run build                                → exit 0
npm run typecheck                            → exit 0
npm test                                     → Test Files 54 passed (54) · Tests 1525 passed | 1 skipped (1526)
npm --prefix packages/pr-rla-mcp ci          → added 19 packages … found 0 vulnerabilities
npm --prefix packages/pr-rla-mcp test        → exit 0 · # tests 64 · # suites 17 · # pass 64 · # fail 0
npm --prefix examples/providers/gitea ci     → found 0 vulnerabilities
npm --prefix examples/providers/gitea test   → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm --prefix examples/ledgers/jira ci        → found 0 vulnerabilities
npm --prefix examples/ledgers/jira test      → ok 1 - the ledger kit: recorded hibernate.atlassian.net changelogs and a synthetic Jira Cloud · # pass 1 · # fail 0
claude plugin validate integrations/claude-code → ✔ Validation passed
claude plugin validate .                     → ✔ Validation passed
npm ls --prod --depth=0                      → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1 (no new dependency)
```

- 1526 = the base's 625 (`3e21347`: 1526 less the 901 new, as no existing test file changed; its 1 skip is U2b's `UNVERIFIED` RK-02 placeholder) plus 901 new (`guard.test.ts` 874, `integrations.test.ts` 27). The package's 64 = U5's 57 plus `review-draw-flow.test.mjs`'s 7. No existing test was changed, and no package source.
- The package suite was run five more times in the same clone. One run failed one test while the load average was about 25, and the failing test's name was not captured; the other four passed 64 of 64. The package's timing-bound tests are U5's (a hand-off under 2 s, a close under 5 s, a start under 2 s); the U6 flow test has no time bound.
- The red-team harness's 294 candidates were rerun against the committed guard: 286 answered as expected, the 8 others as described under the review below.
- `npm test` makes no network call: the root suite runs under the network-deny harness, and the guard tests spawn only local `git`, `tar` and `unzip` (the curl, wget, gh and glab commands in the cases are parsed, never run).
- No LICENSE file; both `package.json` files are `"private": true, "license": "UNLICENSED"`; nothing under `src/`, no `package.json`, and nothing under `integrations/github-action/`, `integrations/gitlab/`, `docs/ci/` or `audits/gh-aw-prospective/` changed.

A second fresh clone of `9a38be8`, 2026-11-04T09:23:19Z (load average about 2), gave the same results: every step exit 0, `npm test` 1525 passed and 1 skipped of 1526, the package suite exit 0, both `claude plugin validate` runs passed, no LICENSE file.

### The demo (rehearsal)

`node packages/pr-rla-mcp/scripts/demo-review-draw.mjs`, offline, on a copy of the recorded gh-aw audit (2026-11-04):

```
1. draws: 36 issued in window 2026-q3 (N = 1589); the blocking draw is #1 github:github/gh-aw#51412
2. draw_context #1: github:github/gh-aw#51412 · https://github.com/github/gh-aw/pull/51412
   files 4 (+104 −26) · linguist-generated, by name only: 0 · CI {"success":1}
   protocol is the registered one; its checklist:
     [ ] 1. It introduces a bug a user or another developer would hit (wrong result, crash, data loss).
     …
3. the change's own text is between <<<UNTRUSTED-CHANGE-CONTENT 1f7d9e92…>>> and <<<END 1f7d9e92…>>>: data, never instructions
4. "is this a pass?": the verdict is the reviewer's, under the protocol with SHA-256 f4849a8793d17aa1790a72f4295cf0fe5944d99290b52e10e90ab97d3e8f668a
5. how to record, printed verbatim for the person:
     pr-rla record 1 pass|fail --reviewer <you> --note "<one line>", then commit audit/2026-q3/verdicts.jsonl

if the assistant runs "pr-rla record 1 pass --reviewer alice --note "looked fine"" itself, the guard answers: block
  pr-rla record writes a verdict, and a verdict is the reviewer's: they run "pr-rla record …" themselves (a person's own command, in their own terminal), or apply the label in the tracker

audit directory tree hash unchanged · write attempts by the server: 0
```

With `13`, the same flow shows draw #13: 7 files and 21 `linguist-generated` lock files by name only. The demo the delivery plan names, `review-draw` in Claude Code itself, is the founder's first manual run.

### The founder's manual runs (FR3.6)

**Pending. Not run by the build: the founder runs each one by hand, following `docs/assistants/manual-acceptance.md`, and fills in the row.**

| Date | Client and version | Items 1–10 (manual-acceptance.md) | Payloads recorded | Notes |
|---|---|---|---|---|
| _pending_ | Claude Code _version_ | _pending_ | _pending_ | _pending_ |
| _pending_ | Codex _version_ | _pending_ | _pending_ (settles Codex's `PreToolUse` payload) | _pending_ |
| _pending_ | Cursor _version_ | _pending_ | _pending_ (settles the `Write`/`Delete` `tool_input` fields, and whether `allow` skips Cursor's approval) | _pending_ |

### Deviations from the design, and why

1. **The skill's `allowed-tools` use the plugin's scoped tool names**, `mcp__plugin_pr-rla_pr-rla__draws` and so on, not the draft's `mcp__pr-rla__draws`: Claude Code names a plugin's MCP tools that way, and the draft's names would never match. It also lists `audit_list` and `job_status` (a hand-off returns a `jobId` the skill must poll), and `disallowed-tools` adds `PowerShell`, `MultiEdit` and `NotebookEdit` to the draft's `Bash Write Edit`.
2. **`.mcp.json` passes `--root ${CLAUDE_PROJECT_DIR}`**, which the docs say a plugin's MCP configuration substitutes. The draft had no root and a `userConfig` fallback in case the working directory was not the project; neither is needed.
3. **Every MCP configuration hands the server a dedicated read-only token**, `PR_RLA_READONLY_GITHUB_TOKEN` and its GitLab and Bitbucket siblings, mapped onto the variables pr-rla's read-only mode reads (`GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`), empty by default. The draft gave Codex a literal `env = { GITHUB_TOKEN = "<read-only token>" }` and Claude Code nothing, so the server would have inherited the user's own token. Codex cannot rename a variable in `config.toml`, so its file whitelists the standard names with `env_vars` and the guide says to start Codex with read-only tokens in them (which also makes `gh` in Codex's shell read-only).
4. **The guard's rules go beyond the draft's list and the refined design's one addition** (`checkpoint --push`), as the brief asked: consent (`plugin approve`, `add`, `lock`, `--accept-lock-grants`, `PR_RLA_ACCEPT_LOCK_GRANTS`, `PR_RLA_APPROVALS_FILE`, `HOME`/`XDG_CONFIG_HOME` for a pr-rla command, and a session started with `PR_RLA_ACCEPT_LOCK_GRANTS` set), per-verdict signing (`record --sign`, `ssh-keygen -Y sign -n pr-rla-verdict@v1`), `gh api` PUT and PATCH as well as POST and DELETE, `gh label` and `gh alias`, `wget` and HTTPie, GraphQL label mutations, every audit record the brief names (the draft had six) plus the audit repo's `.git/` (hooks and config run commands as the person), and git commands that discard or rewrite records (`reset --hard`, `checkout`/`restore`/`rm`/`mv`/`stash`/`clean`/`apply`/`am`, `rebase`, `filter-branch`, `commit --amend`, `git config` of command keys). The draft's `git commit` rule (staged `verdicts.jsonl`) also covers `-a`, pathspecs and an earlier `git add` in the same command line.
5. **`register`, `freeze`, `sample` and `init` are blocked in every form, `--dry-run` included**: the brief lists the commands without exceptions, and the MCP tool `freeze_preview` is the read-only dry run. **Plain `checkpoint` and `status --checkpoint` pass**: the refined design names only `--push`, and a local checkpoint is pr-rla's own append of what the ledger already says.
6. **Unknown pr-rla subcommands are blocked** (default deny), so a write command added later is blocked until the guard knows it. `guard.test.ts › classifies every subcommand src/cli.ts defines` fails when `src/cli.ts` gains one the guard has not classified; it already classifies wave 2's `plugin approve`.
7. **Hook matchers**: `Bash|PowerShell|Monitor|Write|Edit|MultiEdit|NotebookEdit|Read|Grep` and `mcp__.*`. The brief names Bash, Write, Edit and MultiEdit; `Read` and `mcp__.*` serve the draft's rules on the signing key and on other MCP servers' label tools; `PowerShell` because Claude Code routes shell commands through it on Windows; `Monitor` because it runs a shell command in the background (the review found it unhooked); `Grep` and `NotebookEdit` for completeness. The current Claude Code docs no longer list a `MultiEdit` tool; matching a name that never comes is harmless. Each handler sets `onFailure: "block"`.
8. **The guard answers in each client's documented form** (exit 2 and stderr for Claude Code and Codex; exit 2 and a deny object for Cursor, which also gets `{"permission":"allow"}` for an allowed call), **fails closed** on input it cannot read, and **reads a payload as Cursor's or Codex's whenever it carries their markers**, whatever `--client` says, because Cursor can load Claude Code hooks.
9. **`--check-shell` and `--record` are additions**: the first lets a person see what the guard decides for a command; the second saves the payloads a running client sends, which is how the founder's runs settle the payload shapes this build could only read about.
10. **Codex and Cursor files live in `integrations/codex/`, `integrations/cursor/` and `integrations/agents/`**, beyond units-of-work's `integrations/claude-code/`, `.claude-plugin/marketplace.json` and `docs/assistants/`: the guides embed them verbatim and the tests check them, so they are files, not just guide text.
11. **Cursor gets the skill as an Agent Skill** in `.agents/skills/`, which Cursor now reads, instead of the draft's `.cursor/rules/pr-rla.mdc` "carrying the skill text". The rule file now carries the standing rules, the same text as the AGENTS.md block (Cursor also reads `AGENTS.md`; the guide says to use one or the other).
12. **The manual acceptance runs the recorded gh-aw audit in all three clients**, not test-design §3's split (Claude Code on GitHub with `github-issues`, Codex on GitLab, Cursor on Bitbucket). Those cells need live audit repositories with trackers, which do not exist yet and cannot be made as scratch repos (D8); they become runnable once a real audit exists, the prospective gh-aw audit first. Each run still calls every MCP tool once, as §3 asks.
13. **`scripts/local-claude-plugin.mjs` is new**: before `pr-rla-mcp` is published, `npx -y pr-rla-mcp@0.1.0` has nothing to install, so the founder's Claude Code run needs a copy of the plugin whose `.mcp.json` runs the checkout's server. It changes nothing else, so the skill, hooks and tool names are the released plugin's.
14. **The plugin's `author` is `{ "name": "pr-rla" }`**, the project's name (the founder's rule: never a personal name), and the marketplace's `owner` likewise. The manifest has no `license` field.
15. **Label requests are judged by the labels they carry, not by the endpoint.** The draft blocked a `gh api` POST or DELETE to a label endpoint outright, and this bolt's first version did the same for every write method. After the review, a request other than GET, HEAD or OPTIONS is blocked when it carries or names a verdict label, sends a GraphQL label mutation, posts a GitLab quick action on a verdict label, or has a body the guard cannot read. Adding `bug` or creating `enhancement` passes, which the review counted among the first version's false positives. Replacing or clearing an issue's labels passes even when that drops a verdict label: `verify` reports a verdict label that disappeared, while an added one is what the ledger would count.
16. **The guard blocks what it does not finish reading**, beyond the brief's "fail closed on input it cannot read": a command over 512 KiB, code over 1 MiB, commands nested more than 8 deep (the first version skipped them, which the review turned into a bypass), a decision that takes more than 8 s, and, in an audit repo, a script it cannot read (missing when the line is checked, unreadable, or over 1 MiB) or a shell fed from a pipe it cannot read (`curl … | sh`, `base64 -d | sh`). Outside an audit repo those two pass, because large bundles and install scripts are ordinary there; `guard.md` lists it as a limit.

### Findings

1. **The draft's `allowed-tools` would never have matched** a plugin's MCP tools (deviation 1).
2. **A skill's tool grants and removals last one turn.** The person's next message clears `allowed-tools` and `disallowed-tools`, so in a real review, which runs over many messages, the shell and the editors come back: only the hooks still block. The guide says so.
3. **`claude plugin validate` 2.1.267 does not check MCP server entries** (that needs 2.1.281), so a broken `.mcp.json` would pass it here.
4. **Cursor blocks a permission hook's action on empty or invalid output**, even without `failClosed`: a Claude Code-style "print nothing to allow" hook would block everything in Cursor. Hence the Cursor form, and the payload-marker rule (deviation 8).
5. **pr-rla's read-only mode already treats an empty token as none** (`readOnlyBuiltinCredentials` keeps only non-empty variables), so mapping an unset `PR_RLA_READONLY_*` to an empty `GITHUB_TOKEN` makes the server read anonymously rather than fail.
6. **The hook costs about what starting Node costs**: 140 ms per call on an idle machine (Node 22.23.2, five runs) for the first version; 310 to 470 ms for the hardened one while a fresh-clone verification ran alongside, against 330 to 450 ms for `node -e 0` at the same moment. Claude Code runs it before every shell command, file edit, file read and MCP call.
7. **In pr-rla's own repository the guard blocks some development commands**: the test fixtures under `test/fixtures/audits/` and `examples/` are audit repos (they have a `.pr-rla.yml`), and scripts such as `scripts/build-gh-aw-recorded-audit.mjs` run `pr-rla register`, `freeze` and `sample`. That is the rule working; developing pr-rla with the plugin enabled means approving those commands in your own terminal.

### The adversarial review (2026-11-04)

A separate agent was given the guard, its rules and its doc, and asked to find ways an assistant could get round it (blocked things that pass) and ordinary commands it blocks wrongly. It worked in a scratch audit repo it made under the scratchpad (registered, frozen, sampled, with a verdict committed, a dirty sibling, a tracker with a custom label and a forged window) and ran its candidates through `guard.mjs --check-shell` and the hook entry point. Nothing left the machine: no tracker, no push, no model.

| | Candidates | Wrong answers |
|---|---|---|
| First version | about 315 written, 294 in the harness's batches | 166 (bypasses and false positives together) |
| After the fixes | the same 294 | 8 |

The 8 that remain:

- **Right for the scratch repo's state** (the candidate expected a block, but the command could not hurt there): g21 `git stash pop` with no record in the stash, g30 `git clean -fdX` with no ignored record, g33 `commit --amend` of a commit that holds no verdict.
- **Decisions or limits, in `guard.md`**: g32 `git pull --rebase` (replays local commits), l30 and l31 `gh label create --force` and `gh label clone --force` (they change colour and description, not names), g27 `git worktree remove --force` (not read; it can discard an uncommitted verdict in another worktree), t5 Grep over the audit repo's root (the guard cannot tell whether the search reaches `.pr-rla/`).

What was found and fixed, by kind (each now a named case in `guard.test.ts`):

- **Code the guard did not read**: programs on stdin and in heredocs (`python3 - <<'PY'`), combined flags (`node -pe`, `python3 -uc`), write APIs its patterns missed (pathlib's `open('a')`, `mode='w'`, Perl's three-argument `open`, `os.system`, `execSync`, `fs.rm`, `IO.write`, `Deno.writeTextFile`, `bun -e`), awk's `system()` and `print >`, sed's `w` and `e` commands, and pr-rla's write API through `import()`.
- **Writers it did not know**: `sort -o`, `uniq`'s output file, `yq -i`, `curl -o`, `wget -O`, `tar -c`, `git archive -o`, `python -m json.tool`, `script`, `link`, `cp -l`, `cp -R dir/.`, `rsync` of a directory, `gzip`, `ditto`, `ed`, `prettier --write`. In an audit repo a program the guard does not know to only read is no longer handed a record.
- **Commands run indirectly**: Makefile recipes (`make clean`, `make --eval`), `npm pkg set` then `npm run`, lifecycle scripts run by `npm install`, `npm --silent run`, patches from stdin (`patch`, `git apply`, `apply_patch` in the shell), `find -exec`, `xargs` (also `xargs -I{} sh -c '{}'`), for loops over the window, `su -c`, `tmux`, `flock`, `gtimeout`, `trap`, `PROMPT_COMMAND`, `BASH_ENV`, an in-line `PATH`, and Claude Code's `Monitor` tool, which the hooks did not match.
- **The parser**: `$[…]` hiding the next line, `((cmd) )` and `$((cmd) )`, brace sequences and `{gh,}` as the program, an empty variable before the program, `cd -`, `pushd`/`popd`, a computed `cd`, `bash <(…)`, `source <(…)`, `/dev/stdin`, `IFS` splitting, arrays, `printf -v`, zsh's `=cmd`, glob qualifiers, `nocorrect` and `source =(…)`. Fixed after the review's batches, while writing the regression cases: substitutions inside arithmetic (`(( $(…) ))`, `$(( $(…) ))`, `` $[ `…` ] ``) and in unquoted heredoc bodies, which bash and zsh run and the guard skipped; and commands nested more than 8 deep (nine `sh -c` levels), which it skipped instead of blocking.
- **Consent and links**: consent written into `~/.zshenv` or `~/.zshrc` (by shell or by the Write tool), `node --env-file`, the approvals directory linked elsewhere in a fresh home, a link to the window made earlier in the line, a link standing for pr-rla, `.GIT/hooks` and `.PR-RLA/` in another case.
- **git**: a one-shot `core.hooksPath`, `--git-dir`/`--work-tree` and `GIT_DIR`/`GIT_WORK_TREE`, `-C` with a computed directory, `--pathspec-from-file`, `update-ref`, `revert`, `cherry-pick`, `switch -f`, `checkout <rev> --`, `restore --source`, `checkout -B`, `reset --soft HEAD~1`, pushes forced by configuration, `include.path`, `--config-env` and `GIT_CONFIG_COUNT` aliases, an alias without `!` that force-pushes, `rebase --autosquash`, `GIT_EXTERNAL_DIFF`.
- **Labels**: `gh issue -R … edit`, `gh alias set --shell` and `gh alias import`, `gh api` creating an issue with a verdict label, GitLab quick actions in notes (by `glab` and by request), GitLab's `issueSetLabels`, a GraphQL mutation behind a `\u` escape, curl URL globs, `--url-query`, `--expand-data`, `wget --post-data`, HTTPie with `-a`, `curl -d @-` and `gh api --input -` from heredocs, `xargs gh issue edit`, a configured label with a space, `gh issue delete`.
- **The signing key**: Grep on its directory, `grep -r`, `find -exec cat`, `cat $(ls …)`, `curl -d @key`, `tar` of the directory, `openssl -in=`, `git show REV:key`.
- **Other MCP servers**: a shell tool taking argv, a code tool, an HTTP tool with a JSON body, a GitLab note with a quick action, a tool named `mv`; Cursor's `edit_file`.
- **Resource use**: brace bombs, deep nesting and backtracking patterns. Each is now decided well inside the 8 s budget (`guard.test.ts › decides crafted inputs …`), the label-mutation and record-name patterns are bounded, and a decision over the budget blocks.
- **False positives fixed** (now allowed cases): `sed -i '' -e`, `find -delete` outside audit repos, code that reads a record and writes elsewhere, label requests with other labels, `mv` into the window's directory, `git commit -- notes.md`, `git add notes.md && git commit`, `make build`, `export -n`, `declare -p`, `env -u`, `[[ a > b ]]`, a plain rebase, `git config core.editor`, `git stash push -- notes.md`.

### Unverified

- **FR3.6, all three clients**: the founder's runs above. Until then nothing here has run inside Claude Code, Codex or Cursor.
- **Claude Code**: the real `PreToolUse` payload (the tests use the documented shape); whether the plugin's server starts in the project directory (sidestepped by `--root ${CLAUDE_PROJECT_DIR}`); `${VAR:-}` expansion in a plugin's `.mcp.json` `env` (documented for `.mcp.json` files); how it shows progress notifications and whether it polls `job_status`; `onFailure: "block"` (needs 2.1.295; 2.1.267 is installed).
- **Codex**: everything, as Codex is not installed here. The `PreToolUse` payload is documented, not observed (a string or an argv `command`; the guard takes both); whether exit 2's reason is shown; the default environment of a stdio server; whether it asks before `readOnlyHint` tools.
- **Cursor**: everything, likewise. The `Write`/`Delete` `tool_input` fields (the guard checks every path-like field); whether `{"permission":"allow"}` skips Cursor's own approval; what `${env:NAME}` gives when `NAME` is unset (an empty string is assumed).
- **Windows**: PowerShell commands are read with the POSIX parser plus the file cmdlets; untested.
- **Claude Code's Grep and hidden directories**: whether its Grep searches `.pr-rla/` when aimed at the repo's root was not checked (the guard lets that call through).
- **The review's harness is not a proof**: 286 of its 294 candidates are now answered as expected, and the regression cases pin them, but a reviewer with more time will find more. The guard stays a speed bump (tier 3); `verify` is what decides.
- **The guard is best effort**: what it cannot see is listed in `docs/assistants/guard.md`.

### For the integration

- **Files this bolt touched that U7, U8, U9 or the plugin fix round may touch too**: `README.md` (a section appended at the end), `BUILD-NOTES.md` (this section, at the end), `docs/security-model.md` (one bullet in U5's tier list, tier 3), `packages/pr-rla-mcp/test/review-draw-flow.test.mjs` and `packages/pr-rla-mcp/scripts/demo-review-draw.mjs` (new files in U5's package). Nothing under `src/`, no `package.json`, no `src/cli.ts` or `src/commands/*`. U7's directories (`integrations/github-action/`, `integrations/gitlab/`, `docs/ci/`) are untouched.
- **The guard already knows wave 2's commands**: `plugin approve` (and `--env`/`--origin`), `--accept-lock-grants`, `PR_RLA_ACCEPT_LOCK_GRANTS`, `PR_RLA_APPROVALS_FILE`, `record --sign`, `ssh-keygen -Y sign -n pr-rla-verdict@v1`. A new **read-only** subcommand must be added to `PRRLA_READ` in `guard.mjs` and to the `reads` set in `guard.test.ts`; a new write one only to the `writes` set (the guard blocks it already).
- **U8's `freeze --estimate` is blocked** (freeze in every form). If the assistant should run it, allow `freeze --estimate` without `--resume` in `prRla()` and add a case; the read path is the MCP tool `freeze_preview` with `estimate`.
- **A release** bumps the `pr-rla-mcp@` pin in `integrations/claude-code/.mcp.json`, `integrations/codex/config.toml`, `integrations/cursor/mcp.json` and `docs/assistants/*.md`, and the plugin's `version`; `integrations.test.ts` fails until they all equal `packages/pr-rla-mcp/package.json`'s version, which must equal `package.json`'s.
- **When the approvals store lands** (`operatorConsents` in `src/api/credentials.ts`), nothing here needs to change: the guard keeps the assistant from writing an approval, whatever the store then grants. Which approved credentials the MCP server may use is the fix round's decision, not this bolt's.

## P2 time round B (2026-11-04)

Branch `fix/p2-time-b`, off `integrate/wave2` at `0fa9ad8` (U1–U5, U8, U9, the ledger, trusted-time and plugins-broker rounds merged). It fixes time review findings 2, 6, 7 and 9 (`master-time-review.md`), pass-2 findings 2 and 6 and the trusted-time test gaps (`pass2-ledgers-time.md`), and two cases the coordinator added during the round: the CI round's withheld-credential case and the seam review's "CERTIFIED shown where it cannot stand". P1, P3 and P4 ran in parallel; this round stayed out of checks 5 and 7's logic, the ledgers, the providers and the freeze store, except the narrow seams listed under "For the integration step".

### The shared names

- **`src/core/verdict.ts`**, the one verdict model:
  - `CheckStatus` (`PASS | WARN | FAIL | SKIP | INCOMPLETE`), re-exported by `src/core/verify.ts` as before;
  - `AuditVerdict` (`VERIFIED | INCOMPLETE | FAILED`; `VerifyVerdict` is an alias);
  - `auditVerdict(checks)`: any FAIL → FAILED; any INCOMPLETE **or SKIP** → INCOMPLETE; else VERIFIED;
  - `VERDICT_EXIT_CODES` / `verdictExitCode(verdict)`: 0, 6, 1 (`src/api/read/verify.ts` re-exports `verdictExitCode`; the CLI's `verifyExitCode` calls it);
  - `raiseStatus(status, to)`: FAIL > INCOMPLETE > WARN > PASS;
  - `Withholding` (`{ verdict: "INCOMPLETE" | "FAILED", reason }`), `Certificate` (`{ state, withheld }`), `CertificateState` (`CERTIFIED | WITHHELD | NOT CERTIFIED | ESCALATE | REFUSED | INCOMPLETE`);
  - `certificateFor(sprtState, refusal, withheld, unread)`: the certificate; `isCertified(certificate)`: **the only "certified" any surface shows**; `verdictWithholdings(checks)`: verify's withholdings; `failedWithholdings(reasons)`: a status-side gate's FAIL reasons as withholdings; `withheldVerdict(withheld)`.
- **`src/api/access.ts`**: `accessShortfall(auditContext, pluginId, label)`, the CI-round rule.
- **`src/core/records.ts`**: `drawBinding(registration, manifest)`, `compareChangeIds`, `reviewHorizonFor(registration)`, `RegistrationRecordV2.publicKeyPem`.

### Findings fixed

| # | What was wrong | What changed | Regression tests (fail at `0fa9ad8`, pass now) |
|---|---|---|---|
| time #2 (HIGH) | each draw index hashed the manifest's sha256, which covers `frozenAt`, the funnel, limitations and the version: one registration frozen twelve times before R gave twelve samples to choose from | schema v2: `index_i = SHA-256(randomness ‖ registrationSha256 ‖ uint64be(i)) mod N` over the change ids in canonical order (contracts.md §5, "Draws"); v1 keeps the manifest binding; the population audit below; `unreviewed: no-review` counts review objects at landing (v2) | `time-round-b › time review #2` (twelve freezes: twelve manifests, twelve old-binding samples, one new-binding sample; a review added after landing between two freezes changes neither N nor the ids); `seed › time round B` (binding per schema, the 72-byte message checked independently, strict encoding); `selector-review-rules › time round B` (both horizons) |
| time #6 | verify said VERIFIED / CERTIFIED / exit 0 with a commitment time no operator proved, and with checks 4–7 skipped | unproven times are INCOMPLETE in checks 1 and 2 (v2: fewer than k registered operators; v1: no log entry verified under a trusted key), and so is check 3 when its R rests on an unproven registration time; any SKIP makes the verdict INCOMPLETE (exit 6); the certificate is withheld whenever the verdict is not VERIFIED; status withholds it for unproven times (exit 6) | `time-round-b › time review #6` (the late commitment: INCOMPLETE, exit 6, `ok` false, `certificate.state` WITHHELD, in text, `--json` and status `--json`; `--offline` before sample: exit 6; offline after sample: check 5's skip alone is INCOMPLETE, online the same audit is VERIFIED and CERTIFIED) |
| time #7 | N below `minPopulation`: hand-made draws certified, verify VERIFIED, status `--json` reported `sequence.state` CERTIFIED next to the refusal | draws that exist below the minimum FAIL check 6 (exit 1); without draws check 6 SKIPs naming the minimum (INCOMPLETE); status refuses with exit 3 (U5 had already fixed the exit code) and `certificate.state` REFUSED | `time-round-b › time review #7` (both cases, text and `--json`) |
| pass-2 #2 | a v1 envelope's unsigned `integratedTime` chose R and check 3 PASSed: CERTIFIED, VERIFIED, exit 0 | check 3 INCOMPLETE ("it could have been written after round R was public, to choose R"), certificate withheld, exit 6; with the log's key the edit FAILs checks 1 and 2 | `time-round-b › pass-2 review #2` (the reviewer's steer, both ways); `v1-compat` (rewritten: the old test enshrined `3:PASS`); `timestamp-verify › FR1.4` (the v1 clause now also runs verify: check 3 INCOMPLETE) |
| pass-2 #6 | one `--log-key` replaced the pinned key for every URL, and anything verified under it counted as operator Sigstore | `--log-key <log url>=<pem file>`, repeatable, each key scoped to its log; the pinned key always wins for a pinned log (a key given for one is ignored, and check 1 says so); a log only the verifier vouches for counts as `log at <host>`; malformed values, non-keys and two keys for one log are usage errors (exit 1) | `translog-keys` (scoping, pinned-wins, neutral operator, the parser's refusals; a key for another log vouches for nothing); `e2e`, `rekor-v2` (the operator line) |
| time #9 | swapped "logged by k of n"; check 6 counted issued draws, not compared ones, and passed an empty `draws[]`; `frozenAt` of manifest and commitment never compared; `opensAt`/`closesAt` never re-derived; `publicKeyPem` outside the signed bytes | `manifest logged by <operators> operators (k = <k>)`; check 6 compares every entry (index, change, url, merge SHA, first occurrence), needs every issued draw, FAILs duplicates, an empty list and `issued < 1`, and names the derivation; a single repo's commitment must carry the manifest's `frozenAt`; check 1 re-derives the window from its days; v2 registrations name `publicKeyPem` inside their signed bytes (check 1 FAILs a re-signed one, WARNs one without the field) | `time-round-b › time review #9` (six tests) |

The CI round's two cases (the coordinator, during this round):

| Case | What changed | Tests |
|---|---|---|
| a withheld or missing credential, then 401/403/404 | the broker records each 401/403/404 by caller (`stats.denied`) and each 2xx (`stats.answered`); the context records each provider's and ledger's credential standing (`credentialStanding`: granted, withheld with the approve command, not set). A plugin that ran without a credential and had every read refused (`accessShortfall`) makes check 5 (provider) or 7 (ledger) INCOMPLETE, even where those reads made it FAIL, and status `INCOMPLETE: not established (…)` with exit 6; the reason names the variable and `pr-rla plugin approve --env <ENV> --origin <origin>` (built-ins) or `pr-rla plugin approve <use>` (isolated plugins) | `access-incomplete` (GHES tracker: status text and `--json`, verify text and `--json`, withheld and not set; the provider in check 5; the control; a public tracker's deleted issue still FAILs anonymously) |
| offline verify with a tracker ledger | covered by "a SKIP is INCOMPLETE": check 7 SKIPs offline, so exit 6 | `access-incomplete › offline verify with a tracker ledger` |

The seam review's case (the coordinator, after P4's merge, `zz-seam-auditlist`): `audit_list`'s `certified`, verify's `statusLine` and `--json`, and status now all ask `isCertified(certificate)`. `StatusReport.sequence.state` stays the SPRT's **raw** state (documented in contracts.md §7, the MCP tool descriptions and README); `certified` and `certificate` are the claim. verify's line on a FAILED verdict reads `target reached · CERTIFICATE WITHHELD (verify check 7 (labels) FAILED)` (`time-round-b › seam review`).

### The population: every input to N and to the sorted list

| Input | Fixed by | Status after this round |
|---|---|---|
| window, kinds, authors, bots, `direct_push_via_merge`, `max_changed_lines`, `merged_by` | the signed registration (check 2 compares the manifest's copy; check 1 re-derives the window) | fixed |
| review state for `no-human-review` | reviews submitted at or before `mergedAt` (since the ledger round) | fixed at landing |
| review objects for `no-review` | v2: submitted at or before `mergedAt` (this round; was as of `frozenAt`); v1: as of `frozenAt`, as v1 manifests were made | fixed at landing (v2) |
| `frozenAt`, the funnel, limitations, `prRlaVersion`, the provider's identity fields, `repoListing`, `goneRepos` | in the manifest hash only | no longer reach a draw |
| the canonical id order | `compareChangeIds` (UTF-16 code units), validated by check 2, used by `sample` and check 6 | fixed |
| labels (a `labels:` stratum) | read as of the freeze | **stated limit**: `register` notes it and check 2 WARNs; not refused, because the spec lists label strata and pr-rla reads no label history |
| an approval dismissed after the merge, an account renamed | the SCM's current record | stated limit (providers' review normalisation is P1's area) |
| a pool's repositories and heads | U8's registered repos and listing, P3's push-log proof | P3's area |

### Fixtures: what changed and why

- **`test/fixtures/audits/gh-aw-q3-recorded`** (recorded population, synthetic times) is a schema-v2 audit, so its draws change. It was rebuilt with its own scripts: `scripts/build-gh-aw-recorded-audit.mjs` (it now takes the protocol file as a third argument, so the fixture keeps its own `review-protocol.md`) on the fixture's own `changes.json` as `{ listed, selected, limitations }`, which reproduced the manifest's changes byte for byte; only the registration (a new key, named inside it), the manifest's `registrationSha256` and `sha256`, the commitment and the draws differ. The 36 new draws name 36 changes, none of the old 36.
- **The new draws' descriptions were recorded live**, read-only, by `scripts/record-draw-descriptions.mjs` (new `--only` and `--merge` options): GitHub API with the operator's `gh auth token`, pr-rla's broker in read-only mode, GETs only. 2026-11-04T09:05:19Z–09:06:40Z, 249 GETs (all 36); 09:19:35Z and 09:20:00Z, 30 GETs each (four of them again, for the replay file; the first of these two runs wrote a wrong count into its description, fixed in the script and run again). 309 GETs in all, to `api.github.com` only. No write anywhere; no timestamp authority, drand relay or Rekor host was contacted in this round.
- `changes.json` keeps the 36 old descriptions (recorded 04:50Z) beside the 36 new ones, because `test/fixtures/github/gh-aw-q3-draws-2026-11-04.json` still replays four of them for the provider's `describeChange` tests; `recordedDescriptions` says which is which (its text was rewritten by hand to say so; no recorded data was edited). That file's `description` now says its four changes were the draws before this round.
- **New `test/fixtures/github/gh-aw-q3-draws-v2-binding-2026-11-04.json`** (recorded): the four kept changes of the new draws 5, 7, 13 and 31, which the MCP package's mock GitHub serves.
- Tests moved to the new draws: draw #7 is gh-aw#58625 (a lock file and a changeset dropped), #27 gh-aw#55696 (12 of 18 files generated; it replaces the old #13, gh-aw#49685, 21 of 28). The MCP demo's default draw is 27.
- **The bolt-1 TSA recording** (`test/fixtures/tsa/recorded-2026-11-03.json`, recorded) is unchanged, but `register` can no longer reproduce its digest: the recorded record names no key, and a registration now does. The replay tests (`timestamps-e2e`, `timestamp-trust-bundle`) install the recorded record and its four registered tokens as a registration (`test/helpers/recorded-registration.ts`), signed with the tests' fixed key: all four tokens still verify (`4 of 4 … PROVEN`, U_k 2026-11-03T22:32:28Z), register's printer gives its recorded lines, and verify WARNs that the record names no key. No new timestamp request was made.
- The v1 fixture keeps its draws (v1 binding). No other committed fixture carries draws; the e2e, pooled and ledger tests draw at run time.

### Decisions and deviations

1. **v1 with an unverified log: INCOMPLETE, not FAIL.** An honest v1 audit verified without its log's key shows nothing false; INCOMPLETE says the time, and R with it, is not established. R is still derived from the logged time, so every verifier computes the same R.
2. **Check 3 is INCOMPLETE on an unproven registration time for either base.** With a window-close base, the claim that the registration preceded R is the unproven time too.
3. **SKIP counts as not verified** for every check, not only 4–7 (checks 1–3 never skip).
4. **A wholly refused, uncredentialed plugin turns its check from FAIL to INCOMPLETE**, as the coordinator decided. Only "wholly": a plugin with any 2xx read is reading a public tracker or repository, its 404s are the server's answers, and the plugin's own probes decide (so a deleted issue on a public tracker still FAILs). Without that limit, U8's anonymous-verifier tests showed genuine FAILs masked.
5. **Status can now exit 6** (a withheld certificate or unread verdicts), and 1 when a status-side gate shows a check would FAIL. contracts.md §7 says so; U7's CI map already treats 6 as "incomplete".
6. **`CertificateState` gained `INCOMPLETE`**: the verdicts were not readable, so even the SPRT's state is not established.
7. **The withheld line reads `target reached · CERTIFICATE WITHHELD (reasons)`**, so it never says CERTIFIED; P4's merged line says `NOT CERTIFIED: verify check 7 would FAIL (…)` (see the integration notes).
8. **Label strata are noted and WARNed, not refused** (above).
9. **A registration without `publicKeyPem` WARNs** rather than FAILs or INCOMPLETE: it can be re-keyed, but the draws no longer depend on the commitment, the tokens still bind its digest, and the only such records are test fixtures and the 2026-11-03 recording (P4 chose the same for its new field).
10. **The trust-bundle "not cA" and "absent" cases are refused before pr-rla's own clause:** node's `checkIssued` (OpenSSL's `X509_check_issued`) refuses such an issuer, so no chain forms (`rule 6: chain … does not reach an anchor`). The tests assert that; pr-rla's clause stays for another OpenSSL. The "not critical" case reaches it.
11. **SPRT cap-reached is reachable**, so the branch stays: with a registered cap of 36, 35 passes then a fail escalate at the cap. Under the default cap (144) it cannot fire for claim D's parameters; a test enumerates every split of the 143 draws before the cap and finds none landing within one pass of the target.
12. **Rule 3's index and key-equality findings are reached by replacing pkijs's `SignedData.verify`** in the test: pr-rla resolves the signer itself, so an agreeing library never trips them. The finding for a certificate outside the token said "certificate 0 of the token"; it now says "a certificate that is not in the token".
13. **Draw encoding is strict:** `drawIndex` refuses anything but 64 lowercase hex characters for the randomness and the binding; check 6 reports a refusal as a FAIL instead of throwing.

### Tests

At `0fa9ad8`: 83 files, **1218** passed. Now: 85 files, **1269** passed (+51): `time-round-b` (16) and `access-incomplete` (8) are new; `timestamp-signer-identity` +20 (the sixteen distinct-serial forgeries against DigiCert, GlobalSign, Microsoft and Sigstore, and four tests of rule 3's cross-check); `seed` +2; `sprt` +2 (one rewritten: the old "at the cap" test reached target-unreachable); `selector-review-rules` +1; `translog-keys` +1; `timestamps-e2e` +1; `timestamp-trust-bundle` (the not-cA and absent cases in the existing test). The MCP package keeps 59. Tests rewritten for the new behaviour, each to what the round decided, none weakened: `e2e`, `v1-compat`, `timestamps-e2e`, `translog-keys`, `rekor-v2`, `timestamp-trust-bundle`, `git-file-unchanged`, `pooled-verify`, `pooled-plugin`, `u8-review` (an honest frozen, unsampled pool is INCOMPLETE now, and check 5 is still its own PASS), `wave2-integration`, `api-cli-contract`, `draw-context`, `single-repo-anchor` (time round B's differences from master are applied to master's output rule by rule, so nothing else may differ), and the MCP tests. Helpers: `signing-key.ts` (a fixed synthetic key, which `setupAuditRepo` installs in every scenario: a registration names its key now, so with a fresh key per run its digest, and the draws, changed from run to run; the first verification runs caught one test, `e2e › one failure …`, that assumed draw #37 was new and failed when the random draws repeated a change; it now reads the blocking draw from `draws.json`), `recorded-registration.ts`, `audit-scenario.ts` (`logKeyArgs`), `forge-tsa.ts` (distinct-serial twins).

The reproductions, run against `0fa9ad8` (a `git archive` with the new test files copied in): `time-round-b` and `access-incomplete`, 23 of 24 fail; the one that passes is the guard that a public tracker's deleted issue FAILs anonymously. The reviewers' own files, run on this branch: `rvtime-grind`, `rvtime-small`'s offline test and `rv2-v1-steer` (which assert the vulnerable behaviour) fail; `rvtime-late` and `rvtime-small`'s minimum-population test only print what verify said, and print `INCOMPLETE` exit 6 (`ok` false) and `FAILED: check 6 (draws)` exit 1 with status exit 3 (its `state CERTIFIED` is `sequence.state`, the raw SPRT state, beside `certificate.state` REFUSED).

### Unverified

- The new descriptions against GitHub after 2026-11-04T09:20Z (the recording is what GitHub said then).
- `accessShortfall` against a real GitHub Enterprise Server, GitLab self-managed or Bitbucket Data Center: tested on fakes that answer 404 to anonymous reads, as GitHub does for a private repository.
- The neutral `log at <host>` operator against any real non-Sigstore log (none was contacted).

### For the integration step

A trial merge of this branch (`1a32174`) into `integrate/wave2` at `6b0ec01` (P3, P4 and U7 merged), in a scratch clone, 2026-11-04:

- **Conflicts:** 11 files. In source, four, each small: `src/core/verify.ts` (the import line: keep P4's `auditBinding` and this round's `./verdict.js` and `./window.js` imports), `src/api/pool-list.ts` (keep P3's `now` line beside this round's `horizon`), `src/cli.ts` (keep P3's `--verbose` and this round's exit-code help), and `src/api/read/status.ts`. Docs: `contracts.md`, `packages/pr-rla-mcp/README.md`. Tests: `api-cli-contract`, `git-file-unchanged`, `pooled-plugin`, `single-repo-anchor`, `u8-review`.
- **`src/api/read/status.ts`, the seam.** Keep P4's `ledgerIntegrity` and `certificateWithheld` fields beside `certificate` and `certified`; keep this round's `statusLine` (it still takes P4's `info.withheld`) and its verdict text; keep P4's extra arguments to `countedLedgerVerdicts` inside this round's `try`, and add `ineligible: () => null` to the fallback `CountedVerdicts` (P4 added the field); then fold P4's gate into the one certificate: `const withholdings = [...timeWithheld, ...failedWithholdings(withheld.map((w) => \`verify check 7 would FAIL: ${w}\`))]`. P1's check-7 local gate goes into the same list the same way. The resolved four source files are in `scratchpad/p2b-merge-resolution/src/`; with them the merged tree builds and typechecks (both tsconfigs).
- **What then fails, 40 tests in 9 files, each an expectation of the old model, none a crash:**
  - U7's CI tests (`ci-github-action` 7, `ci-job-scripts` 17): their fixtures certify on self-asserted times (no timestamp authority), and status now withholds that certificate and exits 6, which U7's map turns into a failed job (`fail-on` includes incomplete by default); one also counts a labelled prefix that the new draws move (20/36 → 21/36). They pass on `integrate/wave2` alone. Give those fixtures mock authorities (as `test/time-round-b.test.ts` does), or expect INCOMPLETE where the times are unproven.
  - P3's `p3-pool-head` (8), `u8-review` (2) and `pooled-verify` (1): VERIFIED on audits with no timestamp authority, or before sample; now INCOMPLETE for checks 1–3 (and 6–7 when unsampled). Assert check 5's own status and `honestButUnsampled` (in `u8-review`), or add authorities.
  - P4's `p4-review-regressions` (2) and `wave2-integration` (1): they match P4's line `NOT CERTIFIED: verify check 7 would FAIL (…)`; the one line is now `target reached · CERTIFICATE WITHHELD (verify check 7 would FAIL: …)`, and `certified` is false.
  - `single-repo-anchor`: the three rule sets (P3's moved heads and `headEvidence`, P4's ledger path, this round's `timeRoundB`) must be combined; P3's moved-head scenarios are VERIFIED on master and INCOMPLETE here (no authority), so `timeRoundB` applies to them too.
  - `api-cli-contract` flow 2: P4 expects `verify --offline` to exit 1 (an uncommitted git-file ledger FAILs check 7); FAIL still wins over INCOMPLETE, so keep P4's 1 and re-check the other steps' codes.
- **Files this round touched that P1, P3 or P4 also own:** `src/core/verify.ts` (check 5: one line passing `reviewHorizonFor`; check 7: only `checkTimestamps(..., "WARN")` for checkpoints, so their coverage keeps WARNing), `src/api/read/verify.ts` (`noteAccess` runs after P1's and P3's checks and only lowers a check to INCOMPLETE), `src/api/pool-list.ts` and `src/api/read/freeze-preview.ts` (the review horizon), `src/api/write/register.ts` (`publicKeyPem` in the record; the label note), `src/net/broker.ts` (`stats.denied`, `stats.answered`), `src/plugins/open.ts` and `src/api/context.ts` (credential standing).
- **Every registration's digest changes** (it names its key), so anything a test or fixture pinned to a registration's sha256, or to draws, moves; P4's verdict payload v2 names the manifest and the beacon, which this round does not change.

### Verified (command → output)

From fresh `git clone`s of `fix/p2-time-b` at `e450463` (the last code and test commit; only this section comes after it), 2026-11-04T10:04Z to 10:14Z, Node 22.23.2, OpenSSL 3.6.4, three runs in a row, each the whole command, every step exit 0:

```
npm ci                                       → found 0 vulnerabilities
npm run build                                → exit 0
npm run typecheck                            → exit 0 (both tsconfigs)
npm test                                     → Test Files 85 passed (85) · Tests 1269 passed (1269)
npm --prefix packages/pr-rla-mcp ci && test  → # pass 59 · # fail 0
npm --prefix examples/providers/gitea ci && test → # pass 1 · # fail 0
npm --prefix examples/ledgers/jira ci && test    → # pass 1 · # fail 0
node scripts/demo-{broker,ledgers,plugin-host,presence,sdk-carry-overs}.mjs, packages/pr-rla-mcp/scripts/demo-draw-context.mjs → exit 0
```

- An earlier set of three runs, at `3110a10`, had run 2 fail on `e2e › one failure …` (the random-key draws above); `e450463` fixed it, and the three runs above followed it.
- The ledgers demo now ends `INCOMPLETE … (exit 6)` for the relabel fixture (its audit has no timestamp authority) and still `FAILED: check 7 (labels)` for the deleted issue, read anonymously from a recorded public tracker.
- `npm test` makes no network call. The only network use of the round is the 309 read-only GitHub GETs listed under "Fixtures".

## Integration: wave 2

Branch `integrate/wave2`, off master `3059cfb` (which carries `4b72ecb`, the reviewer, and `3059cfb`, the protocol edit), 2026-11-04. Real merges (`--no-ff`), one branch at a time, in the coordinator's order; each merge verified before the next. Master is not moved until the coordinator says so.

### Merge 1: `fix/ledgers-selector` (51d2a37)

- **Conflicts:** none. Master's only change since the branch point is `audits/gh-aw-prospective/review-protocol.md`, which the branch does not touch.
- **Tests:** 552 passed + 1 skipped (553), the same as the branch.

### Merge 2: `fix/trusted-time` (aa9be90)

- **Conflicts:** `BUILD-NOTES.md` only: both rounds appended a section at the end. Both kept, the ledger round's first.
- **Auto-merged, read through:** `src/core/verify.ts` keeps every hunk of both rounds (ledgers: `addAnchor`, the index binding in both branches of check 7, `lastCountedAt`, `recordedBeforeSeed`, the checkpoint coverage; trusted time: `checkLog`'s messages, the ignored and anchor lines in `checkTimestamps`, the absent-`timestamps` FAILs in checks 1 and 2, v1's `time unproven`). `src/core/records.ts` keeps `ledgerIndexSha256` on `DrawsFile` and `isSignedV2` / `effectiveTime`. `README.md` keeps both rounds' paragraphs.
- **Tests:** 635 passed + 1 skipped (636) before the seam fix below: the 553 plus trusted time's 83.

### Where the two meet: checkpoint tokens and the coverage rule

The ledger round's checkpoint coverage (check 7 WARNs unless a time-stamped checkpoint post-dates the last counted verdict) decided "time-stamped" by the presence of tokens. Trusted time made only the registration's own authorities count (review finding 5). Merged as they were, a checkpoint whose only token came from an authority the registration does not name was reported `ignored (not registered)` and `TIMESTAMP NOT TAMPER-PROOF (0 of 2)`, yet it still counted as covering the last verdict, so the coverage WARN and its instruction to checkpoint again were lost. The same held for a checkpoint whose tokens all failed (check 7 FAILed, but coverage was satisfied).

- **Fix (integration, not either round):** `checkpointCoverage` takes an optional `timeStamped` predicate. On a v2 audit, check 7 passes trusted time's result for each checkpoint it assessed: covered only if at least one token is counted (verified, from a registered authority). Unassessed lines (a v1 audit, or the tracker history unreadable) keep the presence rule, unchanged. The WARN names the post-dating lines whose tokens did not count.
- **Left to the post-merge "audit binding" round:** pass-2 review #5 asks for coverage by *proven* (k-of-n) tokens. This merge does the smaller, seam-only step (counted tokens); the predicate is where `ts.proven` goes.
- **Tests:** `test/wave2-integration.test.ts`, end to end over a fake GitHub tracker and mock authorities (synthetic):
  - control: a checkpoint after the last verdict with both registered tokens PASSes check 7;
  - a checkpoint whose only token is from a trusted but unregistered authority does not cover the last verdict (the coverage WARN, with the ignored and 0-of-2 lines);
  - the index anchor is inside the time-stamped bytes: editing the newest line's `ledgerIndexSha256` FAILs both its tokens on rule 2 as well as giving the ledger round's "index changed since the latest checkpoint" WARN, and the edited line no longer covers the last verdict.

  Against the merged tree without the fix, the second and third fail (on the coverage assertion only) and the control passes.

### Verified after merges 1 and 2 (command → output)

From a fresh copy (`git archive`) of `0ed624f`, 2026-11-04T05:43Z, Node 22.23.2, load average 38 on 10 cores:

```
npm ci                                     → found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 53 passed (53) · Tests 638 passed | 1 skipped (639)
npm --prefix examples/providers/gitea ci   → found 0 vulnerabilities
npm --prefix examples/providers/gitea test → # pass 1 · # fail 0
npm --prefix examples/ledgers/jira ci      → found 0 vulnerabilities
npm --prefix examples/ledgers/jira test    → # pass 1 · # fail 0
```

- **The load flakes.** Earlier full runs, at load averages of 40–197, failed only plugin-host wall-clock tests: the heartbeat test, the Jira-through-host test and once the Gitea-through-host 30 s bound. Master `3059cfb`, from a scratch copy at the same load, failed the same two (heartbeat, Jira host), and the heartbeat test failed master's two-file run once too. They are the flakes the tracker assigns to the plugin and broker round; nothing in this integration touches the plugin host, and no test was changed for them.

### Merge 3: `bolt/u9-presence-verdicts` (5fe1072)

Merged before U5 and U8, on the coordinator's instruction. U9 branched from master `a360348`, before `4b72ecb`.

- **Conflicts, each resolved by keeping both sides:**
  - `src/core/verify.ts`: the SDK import keeps the ledger round's `recordedBeforeSeed` and drops `provenanceRank`, whose only use U9 replaced with `verdictRuleFailures`. Check 7 keeps the ledger round's `lastCountedAt` beside U9's `read` / `countedVerdicts`. The rest auto-merged and was read through: U9's ledger identity, `require_signed` and provenance ceiling, the ledger round's index binding (both branches of check 7), checkpoint chain and coverage, the coverage fix above, and trusted time's checks 1 and 2.
  - `src/commands/status.ts`: the imports carry trusted time's `anchorLines` and `logBound` with U9's `auditContextFor`. Both rounds' status bodies auto-merged.
  - `scripts/demo-ledgers.mjs`: U9's one audit per fixture, registered on the ledger it verifies with, sampled with `--through 1` as the ledger round needs (the recorded tracker holds one issue, and the index binding FAILs an issued draw with no issue). Its output is what both rounds recorded: the relabel VERIFIED with check 7 WARN (foreignIssues, no checkpoint), the deleted issue FAILED.
  - `docs/design/phase-3-4/contracts.md` (§1) and `docs/security-model.md`: both rounds' new sections kept, the ledger round's and trusted time's first.
  - `BUILD-NOTES.md`: U9's two sections go before this one, which stays last.
- **A test that contradicted another branch:** trusted time's `net-io.test.ts › no source file names a default Rekor log` lists the files that import the log keys with a pattern matching any relative `keys.js`. U9's `src/core/presence/` imports its own SSH-key module, `./keys.js`, so the list grew by three files that never touch `src/translog/keys.ts`. The check now resolves each relative import and compares it with `src/translog/keys.ts`. It is still exact (the same two importers) and no weaker: a new importer at any depth fails it.
- **Timing changes outside U9's unit** (`8c1166f`, the plugin-host heartbeat test widened to 2 s; `063f34a`, the Jira-through-host test given 180 s) came in with the merge. When `fix/plugins-broker` lands, its versions replace them.
- **Integration test** (`test/wave2-integration.test.ts`): an audit registered on github-issues and verified with git-file swapped in FAILs check 7 on U9's identity rule, and an edited index still FAILs the ledger round's binding (a local file, judged whatever ledger is loaded); git-file gets no checkpoint-coverage WARN. Without U9 it fails on the identity assertion.
- **Not yet joined:** U9's `src/io/git-safe.ts` is the one safe-git helper so far; git-file and its history walk use it. The only other git caller in `src/` is `src/io/git-transport.ts` (`checkpoint --push`, a write path, unchanged since it was added). U5's equivalent helper lands with U5, and the two become one there.
- **Verified** (in this worktree, 2026-11-04T05:52Z, load average 70): `npm ci` 0 vulnerabilities · build 0 · typecheck 0 · `npm test` 61 files, **802 passed | 1 skipped (803)** · gitea 1 pass · jira 1 pass · `demo-presence`, `demo-sdk-carry-overs`, `demo-plugin-host`, `demo-broker`, `demo-ledgers` exit 0.

### Merge 4: `bolt/u8-org-pooled-freeze` (ec073d7)

Merged after U9 and before U5, on the coordinator's instruction. U8 branched from master `a360348`.

- **Conflicts, each resolved by keeping both sides:**
  - `src/core/population.ts`: U8 split `buildPopulation` into `listRepoChanges`, `checkListed` and `assemblePopulation`. The ledger round's pinned-head check (`isCommitId`) moves into `listRepoChanges`, the one place every listing passes through. A single repo, a pooled build and check 5's rebuild therefore all refuse a head that is not a commit id, before asking the provider. On the ledger branch it covered only the single-repo path. `readManifest` validates every `repos[].headSha` on read, as the ledger round left it.
  - `src/commands/sample.ts`: U8's `repoLabel(manifest)` passed to `publishDraws`, then the ledger round's index binding.
  - `src/config.ts`: U9's `allowedSigners` beside U8's `freeze` settings, with both parsers.
  - `src/providers/github/index.ts`: the ledger round's `completeCommit` and U8's `listRepos`, `describeRepo`, `listingVisibility`, `firstParentPath` and `estimateRequests`, all kept.
  - `src/commands/status.ts` (U9's `requireSigned`, U8's `perRepo`) and `src/commands/verify.ts` (the ledger round's `readIndexDocument`, U8's `EXIT`): both lines kept.
  - `test/timestamps-e2e.test.ts`: both sides' imports.
  - `README.md` (the kit lines, the limitations), `contracts.md` §5 (U9's `verdicts` row and U8's `registeredRepos` row) and `docs/security-model.md` (U8's section after U9's): both sides kept, line by line.
  - `BUILD-NOTES.md`: U8's two sections go before this one.
- **Timing margins outside both units.** U9 and U8 each widened the same two tests; U8's margins were kept, being the wider:
  - the heartbeat test: a 5 s silence timeout with a 6.5 s call (U9 had 2 s with 4 s);
  - the Jira-through-host test: 240 s (U9 had 180 s).

  U8's other robustness changes came in unopposed: `maintenance.auto=false` and `gc.auto=0` in `audit-scenario.ts`, the 60 s `hookTimeout` and the Gitea-through-host bound. `fix/plugins-broker`'s rewrites replace the two plugin-host tests when it lands, and U5's `maintenance.auto=false` meets U8's then.
- **A test that contradicted the stricter rule.** U8's `repo-set.test.ts › each repo is listed from its own head` pinned a head of `"aa"`, which the pinned-head rule now refuses in a pooled build too. The stricter behaviour is kept: the test pins a 40-hex head and asserts the same property (each repo listed from its own head).
- **Integration tests** (`test/wave2-integration.test.ts`, synthetic: U8's fake org and the fake tracker on one router):
  - a pooled build refuses a non-commit-id head before any provider call, and lists from a real one;
  - a pooled audit with github-issues: `sample` binds the index to draws spanning the pool's repos, and check 5 PASSes, check 7 does not FAIL, and the verdict is VERIFIED;
  - an index edited across repos FAILs check 7 while a deleted repo makes check 5 INCOMPLETE: the verdict is FAILED, `ok` false, exit 1, never INCOMPLETE.
- **Still to write when U5 lands:** pooled freeze and INCOMPLETE through the MCP `verify` tool; INCOMPLETE in `status` through U5's API.
- **Verified** (in this worktree, 2026-11-04T06:02Z, load average 23–45): `npm ci` 0 vulnerabilities · build 0 · typecheck 0 (both tsconfigs) · `npm test` 71 files, **985 passed | 1 skipped (986)** · gitea 1 pass · jira 1 pass · all five demo scripts exit 0.

### Merge 5: `fix/plugins-broker` (bb5bd24)

Merged after U8 and before U5, on the coordinator's instruction. The branch was cut from master `4b72ecb`.

- **Conflicts, each resolved by keeping both sides:**
  - `src/commands/{checkpoint,record,verify}.ts`: the ledger round's and U9's arguments, with this round's `auditContextFor(ctx)` in place of `auditContextFor(ctx).plugins`. Two more calls of that kind came from branches this round never saw: U9's `ledgerTraits` in `status.ts` and U8's `pluginIdentity` in `freeze-pool.ts`. Both now pass the AuditContext, so a `trust: full` plugin's identity read carries consent. A missed call would fail closed.
  - `src/commands/context.ts`: U9's `signVerdict` and this round's `acceptLockGrants`.
  - `src/ledger-traits.ts`: U9's imports plus `PluginRules`.
  - `src/sdk/http.ts`: both sides made the same erasable `HttpError` constructor. It is kept once; a duplicate `private readonly o` field produced by the auto-merge is removed. The file is now byte-equal to this round's.
  - `tsconfig.sdk.json`: one file, the union (`src/sdk/**` plus `child.ts`, `protocol.ts`, `inprocess-guard.ts`).
  - `test/plugin-host.test.ts`: this round's heartbeat tests (the watchdog counted from `ready`, 6 × the interval) replace U8's and U9's margins. U8's Gitea-through-host bound of 45 s stays: it is the wait itself, so it is the logical limit, not a margin.
  - `test/wave1-integration.test.ts`: this round's host pool replaces U8's 240 s and U9's 180 s. The ledger round's `transient-write-faults` stays in the list of cases that must run.
  - `README.md` and `BUILD-NOTES.md`: both sides kept; this round's section goes before this one.
- **Auto-merged and read through:** U8's IPC additions sit on the v2 frames: `estimateRequests`, `describeRepo`, `listingVisibility`, `firstParentPath`, and the error's `status` and `rateLimited`, in `protocol.ts`, `child.ts` and `host.ts`. U8's `stats` sits in the broker's `attempt()`, around `send()` and after this round's guard and swap lines. The other files merged cleanly: `package.json` (`engines >=22.15`, typecheck over both tsconfigs), `vitest.config.ts` (both setup files and U8's `hookTimeout`), and `audit-scenario.ts`, which keeps U8's `maintenance.auto=false` and `gc.auto=0`. That is the `cloneScenario` ENOENT fix the coordinator asked for, already in from U8.
- **Two tests that contradicted another branch:**
  - `plugin-lock.test.ts › plugin check runs the ledger kit …`: the ledger round's kit FAILs any case with no fixture unless the caller names it in `skipCases` with a reason. `plugin check` runs recordings only, so it FAILed on the ten cases the Jira recordings do not show. Kept the stricter rule: `hostedLedgerConformance` now names each unrecorded case with its reason, either "a recording cannot show it (the tracker must change between reads)" or "plugin check was given no recorded fixture for this case". The report lists those cases as `skip` lines, and the test now asserts them (ten, two of them by text). `docs/writing-a-provider.md` says so.
  - `u9-review-regressions.test.ts › a locally locked external ledger, swapped in …`: this round refuses to load a `trust: full` plugin nobody approved, so verify threw before check 7. Both behaviours are kept and tested: unapproved, verify rejects with `NOT_APPROVED` and loads nothing; locked with approval (as `plugin add` and `plugin lock` record it), check 7 FAILs on U9's identity rule as before.
- **Integration test:** an isolated provider throws a rate-limited 403. On v2 it reaches the parent with `status` 403 and `rateLimited`, and U8's `rebuildRepo` classifies it as INCOMPLETE ("a rate limit or an outage … run verify again"), not as a FAIL or a gone repo. U8's own `pooled-plugin.test.ts`, unchanged, now runs its pooled freeze, estimate, `listingVisibility` and `describeRepo` over v2.
- **Verified** (in this worktree, 2026-11-04T07:02Z, load average 2–16): `npm ci` 0 vulnerabilities · build 0 · typecheck 0 (both tsconfigs) · `npm test` 73 files, **1057 passed (1057)** (this round runs the RK-02 test that was skipped) · gitea 1 pass · jira 1 pass · all five demos exit 0. `~/.config/pr-rla` does not exist after the run.

### Merge 6: `bolt/u5-audit-api-mcp` (3e21347)

The last wave-2 branch, merged after plugins-broker on the coordinator's instruction. U5 branched from master `a360348`, so every other branch's edits to `src/commands/*` had to be ported into U5's `src/api` modules (U5's map, "Bolt 6 (U5)"). The command files are formatters again: each one is U5's version plus the output lines the other rounds added.

**What was ported where:**

| From | What | Now in |
|---|---|---|
| trusted time | `logPublicKey` is `trustedLogKey(logUrl, --log-key file)` (no audit-repo key, no `/publicKey`); `logBound` exported | `src/api/translog.ts`, `src/api/timestamps.ts` |
| trusted time | status's v1 log check and `timestamp anchors` (as `timestampAnchors`); `reportTimestamps` prints the anchor lines | `src/api/read/status.ts`, `src/commands/{status,timestamps}.ts` |
| U9 | counted verdicts (`countedVerdicts`, `registeredCeiling`) in status, the draws and the draw context, through one helper, `countedLedgerVerdicts`; the shown verdicts carry no `sshsig` or `registrationSha256` | `src/api/read/{status,draws,draw-context}.ts` |
| U9 | verify passes `ledgerIdentity` and the ceiling; `record --sign` with the `signVerdict` hook (now on `ApiContext`); register's `allowed_signers` rules and warnings | `src/api/read/verify.ts`, `src/api/write/{record,register}.ts`, `src/api/session.ts` |
| U8 | the pooled run, `--resume`, the R deadlines (start, end, before write), the manifest's `repos`, `repoListing` and `goneRepos`, the commitment signed at the end of a pooled run | `planFreeze` (`src/api/read/freeze-preview.ts`) and `src/api/write/freeze.ts` |
| U8 | the estimate: `freezeEstimate`; `freeze_preview`'s `estimate` runs it, and `UNSUPPORTED` is gone from both error lists | `src/api/read/freeze-preview.ts`, `src/api/read/index.ts`, `packages/pr-rla-mcp` |
| U8 | the pool label, the pooled status line, `registeredRepos` at register, INCOMPLETE and exit 6 in verify | the matching `src/api` modules; `VerifyResult.exitCode` |
| ledgers | `sample` binds `ledgerIndexSha256`; checkpoints carry `prevLineSha256` and the index hash; `readManifest` checks pinned heads | `src/api/write/{sample,checkpoint}.ts`, `src/api/read/checkpoints.ts`, `src/api/session.ts` |
| plugins | every identity and traits read passes the AuditContext; `plugin approve`; `add` and `lock` record the approval; `plugin check` runs the ledger kit | `src/api/**`, `src/api/write/plugin.ts`, `src/api/plugin-check.ts` |

`src/commands/freeze-pool.ts` (U8's command-side pooled run) is gone: its two functions are `runPool` and `freezeEstimate` in the API. Its `resumeCommand` and the summary line came along.

**Joined into one mechanism each:**

- **Consent.**
  - Read-only mode and the CLI ask the same approvals store: `builtinEnvironment` for built-ins, `pluginConsent` for isolated plugins. U5's own table (`src/api/credentials.ts`, with `operatorConsents`) and `grantedCredentials` are gone: two tables of the built-ins' credential uses would drift.
  - What U5 added and stays, read-only only:
    - `approvedOnly`: consent from stored approvals and the built-in defaults, never `--accept-lock-grants` or `PR_RLA_ACCEPT_LOCK_GRANTS`, which accept a repo's grants and are only for a repo you control;
    - built-ins get placeholders, never the secrets, and the broker swaps each on its approved origin;
    - `isolated-only`: `trust: full` never runs, approved or not (`refuseFullTrust` beside the plugins round's `refuseFullTrustUnapproved`).
  - The plugins round's origin-exact, https-only broker rule supersedes U5's read-only https check (U5's notes said it would).
- **git.**
  - `src/io/git-safe.ts` carries the union of both guards: inherited `GIT_*` dropped, `GIT_NO_LAZY_FETCH`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` (U5's), `GIT_CEILING_DIRECTORIES` (the audit root's parent plus, in a confined call, the roots' parents: U5's), `--no-replace-objects`, `core.commitGraph=false`, `core.fsmonitor=false`, `gc.auto=0`, `maintenance.auto=false`, and `--no-textconv`.
  - The `.git`-file check stays in git-file's `confineGitDir`, now on U9's discovery. `src/io/git-read.ts` is gone. git-file keeps U9's history walk; U5's confined reads (`readTextConfinedAsync`, `readConfined`) and `gitFilePath` are folded in.
  - The checkpoint push (`src/io/git-transport.ts`) runs in `gitWriteEnv`: the user's transport settings kept, the variables that point git at another repository dropped.
- **Watchdog.** The plugins round's limit counts from `ready`, with start-up under its own limit. U5's decision runs in a `setImmediate` after the poll phase, with a generation counter. Both are on the v2 code. U5's test of it is kept beside the plugins round's heartbeat tests.
- **The checkpoint store stays write-side.** The pooled run moved to `src/api/pool-list.ts`, which reaches the store only through a `RunStores` interface. The write side fills it (`withCheckpointStore` in `src/api/pooled-freeze.ts`, still the only importer of `freeze-store.ts`). The run's record types and `differingInputs` moved with it; `freeze-store.ts` re-exports them. The read graph has neither module, and the boundary tests pass unchanged on that point.

**Fixes the merge needed, beyond the ports:**

- **A plugin host's wait.**
  - U5's wrapper dropped the host's signal, so a wait the host cancelled kept its timer. The wait now ends on the host's signal or the call's (`hostSleep`).
  - pr-rla's own waits reject on abort (U5, so a cancelled call stops) while the host's resolve. The host's handler now takes both, where a rejection was unhandled.
- **The read graph stays off `src/cli`.** Exit 4 is a local constant there, and the CLI's `verifyExitCode` uses the read side's `verdictExitCode`.
- **`readIndexDocument`** (ledgers) reads confined, and its JSON error no longer quotes the file.
- **The MCP package's tests** and the servers they start use a temp approvals file and fail if the real one changes (`test/helpers.mjs`). The package's engines are `>=22.15`, as the root's.

**Tests changed where two branches met, none weakened:**

- **Expectations that moved with U5's code:**
  - the log-key importer is `api/translog.ts`;
  - `readManifest` throws the API's `AuditError` (CommandError's base);
  - an identity read of a `trust: full` plugin uses the CLI's read-write context.
- **Expectations that follow the joined rules, each stricter or equal:**
  - the boundary list gains `git-safe.ts` and `approvals.ts`, with reasons;
  - the runtime trace expects the full git guard and U9's commands;
  - U5's credential unit tests now run on the store: placeholders; withheld until approved; an http: origin never; `PR_RLA_ACCEPT_LOCK_GRANTS` ignored in read-only;
  - an isolated plugin's grant: withheld in both modes until approved, a placeholder in both after;
  - U9's git env test adds `GIT_TERMINAL_PROMPT`;
  - the plugins round's `--accept-lock-grants` test runs read-write (the CLI's flag) and now also shows read-only ignoring it;
  - its sleep test accepts an AbortError rejection;
  - the MCP tests expect the approvals line and U9's partial-clone refusal, which happens before anything is read.
- **The `estimate` tests:** in place of `UNSUPPORTED`, they run U8's estimator. A provider without `estimateRequests` gives its reason, and the estimate and the population are cached apart.
- **Two plugin-host timeouts:** U5's 180 s Jira hang guard is dropped for the plugins round's host pool, as the coordinator asked.

**Integration tests:**

- **`test/wave2-integration.test.ts`**, through `pr-rla/api/read`:
  - per-verdict signatures in status: presence 1, account 1, self-asserted 1; the unsigned one below the registered minimum; the T16 note; no signature field;
  - the draw context: presence (user-presence flag verified; key hardware not attested) and account; the reviewer in the fence; no SSHSIG blob;
  - read-only mode on a GitHub Enterprise Server audit: anonymous until `GH_ENTERPRISE_TOKEN` is approved for its origin, then the token reaches `ghe.example.com` only and never the result.
- **`packages/pr-rla-mcp/test/mcp-wave2.test.mjs`**, through the MCP tools of an in-process server:
  - on a pooled audit (an isolated plugin's org; the token cannot be shown to see every private repo), the `verify` tool returns `verdict: "INCOMPLETE"`, `exitCode: 6`, `ok: false`, and check 5 says why, while the CLI's verify exits 6;
  - `draw_context` serves a pooled draw (a repo-qualified change, the provider's description in the fence), and the draws span the pool's repos.
- **The isolated-plugin approval test above** (`test/api-read-fix.test.ts`) is the third "approvals in read-only mode" case.
- **Status has no INCOMPLETE:** it never rebuilds the population, so U8's verdict cannot arise there. The time round B item (#6, "unify verdict") is where status's own exit model is settled.
- **Verified from three fresh clones of `integrate/wave2` at `0fa9ad8`** (2026-11-04, 07:55Z–08:08Z, Node v22.23.2, load average 17–33; `scratchpad/wave2/verify-run.sh`), each run the same: `npm ci` 0 vulnerabilities · build 0 · typecheck 0 (both tsconfigs) · `npm test` 83 files, **1218 passed (1218)** · `packages/pr-rla-mcp` `npm ci` 0 vulnerabilities, `npm test` **59 pass, 0 fail** · gitea 1 pass · jira 1 pass · every demo exits 0 (the five under `scripts/` and the MCP package's `demo-draw-context`).

### Merge 7: `fix/p4-ledger-path` (577fe00)

Merged after U5 on the coordinator's instruction. P4 was cut from `integrate/wave2` at `66e3f54` (U8 merged, before plugins-broker and U5), so its command-file edits (its "Shared files touched") were written against the command files U5 has since thinned. They are ported into `src/api`; the command files keep U5's form plus P4's output lines.

- **Conflicts, each resolved by keeping both sides:**
  - `src/io/git-safe.ts`: the joined guard (merge 6) plus P4's `gitExecutable()`: `gitSafe` and `gitSafeSpawn` run git by the absolute path found on PATH's absolute entries.
  - `src/io/git-transport.ts`: the checkpoint push runs `gitExecutable()` in `gitWriteEnv()` (merge 6's environment, P4's executable).
  - `src/ledgers/git-file.ts`: P4's `gitFileLocation` (the registered path, walked through real directories spelled as registered), with U5's `confineGitDir` before discovery and U5's confined reads. U5's `gitFilePath` is gone for P4's `gitFileLedgerFile`; `src/api/session.ts` and `src/api/read/draw-context.ts` use it.
  - `src/commands/{record,register,status}.ts`: U5's formatters. P4's logic is in the API (below); the command files print P4's lines.
  - `README.md`: P4's two limitation bullets (registered path; Windows untested) and the "Verifying someone else's audit" bullet from merges 5 and 6.
  - `BUILD-NOTES.md`: P4's section before this one.
- **Ported into `src/api`:**
  - **status** (`src/api/read/status.ts`): `gitFileLedgerGate` (check 7's history walk and path rule, local) and `certificateWithheld`; `binding` (`auditBinding` of the registration, manifest and beacon) and `ineligible` passed to the counting and to `computeStatus`, through `countedLedgerVerdicts`, so the draws and the draw context count the same lines. The line says `NOT CERTIFIED: verify check 7 would FAIL (…); run "pr-rla verify"` where the sequence certifies but check 7 would FAIL; `--json` gains `ledgerIntegrity` and `certificateWithheld`; the CLI prints `ledger integrity FAILs:` and `WARN` lines.
  - **record** (`src/api/write/record.ts`): `countingVerdictFor` (only a counting verdict blocks a new one, so `record --sign` records over an assistant's unsigned lines without `--force`), and `--sign` signs the v2 bytes (`pr-rla-verdict/v2`: the registration, manifest and seed). A symbolic link or another spelling on the ledger's path is refused through `gitFileLedgerFile`.
  - **register** (`src/api/write/register.ts`): the top-level `ledgerPath` field (`registeredLedgerPath`), in the plan and the record; the CLI prints it.
  - **git** runs only through `src/io/git-safe.ts`, with P4's `src/io/executables.ts`.
- **The wording allow-list** (P4's `test/fixtures/wording/vetted.json`) over the merged tree flagged seven sentences from merges 3–6. Three were reworded to carry the limit or to stop naming a touch (README: the change "edits" a `.gitattributes`; `docs/security-model.md`'s read-only paragraph: `presence (U9: the user-presence flag verified; key hardware not attested)`; merge 6's note above). Four are U5's history sentences (its section names U9 by its title); they are added to the vetted list under `history`, as P4's own history sentences are.
- **Tests that met P4's stricter rules (kept stricter, none weakened):**
  - `api-cli-contract.test.ts` flow 2: U5's flow recorded a verdict in a git-file ledger and verified without committing the ledger file. Under P4 a ledger never committed beside a committed registration FAILs check 7 (`p4-review-regressions`, finding 1). The flow now asserts that exit 1, then commits the ledger as `record` says to, and asserts verify's exit 0.
  - `api-read-runtime.test.ts`: the read API spawns git by an absolute path whose basename is `git`, not the bare name.
  - `wave2-integration.test.ts` (per-verdict signatures): with keys registered and `min_provenance: account`, carol's unsigned line is ineligible under P4: status ignores it with its reason (`carries no signature, and the registration counts only verdicts signed with their reviewer's registered key`) instead of counting it below the minimum. Provenance: `presence (user-presence flag verified; key hardware not attested)` 1, account 1; `belowMinimum` is empty.
- **Fixed on the coordinator's instruction:** P4's `record` said an unsigned verdict "counts as self-asserted" even where the registration requires signatures, where the line is ignored. `signVerdictHint` now takes the rule (`signingRequirement`, beside `signaturesRequired`, with the setting that imposes it: `require_signed is set` or `min_provenance is …`) and says `this verdict is not signed, so it is ignored and does not count: … ; record it again with --sign …`. Without the rule it still says "counts as self-asserted". Tested in the verifier's unit tests (each rule, no rule, no keys), in the end-to-end FR9.1 test under `require_signed` (where the old message was asserted) and in the wave-2 signature test (`min_provenance is account`).
- **Integration test** (U5 × P4, `test/wave2-integration.test.ts`): through `pr-rla/api/read`, an honest git-file review certifies with `certificateWithheld: []` and `ledgerIntegrity.ok`; a committed line taken out again (the history rewritten) leaves the sequence certifying, but `read.status` returns `certificateWithheld: ["the ledger's integrity check FAILs"]`, the integrity FAIL naming the commit, and the `NOT CERTIFIED: verify check 7 would FAIL` line, while `read.verify` returns FAILED, `exitCode: 1`, check 7 FAIL. The MCP `status` tool serves the same object (its schema is open).
- **Verified** (in this worktree, 2026-11-04, load average 2–20): build 0 · typecheck 0 (both tsconfigs) · `npm test` 84 files, **1251 passed (1251)** · `packages/pr-rla-mcp` `npm test` **59 pass, 0 fail** · gitea 1 pass · jira 1 pass · every demo exits 0. The three fresh-clone runs follow P3's merge.

### Merge 8: `fix/p3-pool-head` (3e1cac9)

Merged after U5 and P4 on the coordinator's instruction. P3 was cut from `integrate/wave2` at `66e3f54`, before plugins-broker, U5 and P4, so its edits to the command files and to `src/api/pooled-freeze.ts` are ported into the modules U5 moved them to.

- **Conflicts, each resolved by keeping both sides:**
  - `src/net/broker.ts`: the plugins round's imports (`abortable`, `sleepFor`) and P3's (`blindRateLimitWaitMs`, `rateLimitedByBody`). P3 changes only `withRetries`; it auto-merged onto the plugins round's broker, whose origin-exact credential swap and scrubbing it does not touch.
  - `src/sdk/http.ts`: the plugins round's asynchronous `acceptJson` and P3's two hints, `rateLimitBody` and `blindRateLimitWaitMs`. P3's helpers auto-merged.
  - `src/plugins/host.ts`: the plugins round's wrappers, each ending on the call's signal or the host's (`either`), with P3's `pushLog` written the same way. `protocol.ts` and `child.ts` auto-merged `pushLog` into v2's method lists.
  - `src/api/pooled-freeze.ts`: U5's thin wrapper. P3's changes are in `listPool` (`src/api/pool-list.ts`): a gone marker is probed again on resume; the push-log pass runs after the listings (a stop there resumes with every listing kept); `headEvidence`; the stopgap's `unreachable` warning, for a single repo and a pool.
  - `src/commands/freeze.ts`: U5's formatter. The manifest's `headEvidence` is written by `src/api/write/freeze.ts`.
  - `src/commands/register.ts`: U5's formatter, plus P3's `WARNING:` line for each visibility the token could not prove it saw. `preflightRepoSet` in `src/api/write/register.ts` runs `registerRuleRepos`, signs `registeredVisibility` and returns the warnings, which the plan carries as `pool.warnings`.
  - `src/commands/verify.ts` (auto-merged, but P3's print line landed in U5's `printVerify`, where `opts` is not in scope): `--verbose` is now `printVerify`'s `verbose` option, and `runVerify` does not pass it to the API. `VerifyResult` extends `VerifyReport`, so `verbose` reaches `pr-rla/api/read` and the MCP `verify` tool unchanged (its schema is open; the package README says so).
  - `docs/security-model.md`: P3's two bullets and U5's MCP section.
  - `test/single-repo-anchor.test.ts`: P4's step and P3's steps, renumbered. P4's ledger-path loop skips P3's `moved` shapes, which step 4 compares on their verdicts.
  - `BUILD-NOTES.md`: P3's section before this one.
- **The retry hints across the plugin host.** P3's decision 9 ("an isolated plugin keeps its own retries") was written before plugins-broker, which made the broker every plugin's one retrier. So `blindRateLimitWaitMs` is now carried over IPC v2, like `maxRetries` and `maxBlindRateLimitRetries`, at no less than 1 s (the broker's own first backoff, so a plugin's hint can lengthen waits but never make them shorter than without it) and no more than `MAX_WAIT_MS`. `rateLimitBody` is not carried. The pattern would be compiled and run in pr-rla's process, where one that backtracks without end stalls the broker for every caller, which is what isolation exists to prevent. Carrying it needs a question to the child, as `acceptJson`'s is; that is left open. `docs/writing-a-provider.md` says which hints cross.
- **The estimate.** `freeze --estimate` and the MCP `freeze_preview` estimate both run the read API's `freezeEstimate`, so P3's one push-log request per repo counts in both. P3's `pooled-plugin` test asserts it through the CLI and over the host (`pushLog` and `estimateRequests` cross v2).
- **The wording allow-list** flagged one P3 sentence, the one listing the five demo scripts by file name. It is vetted under `names`.
- **Integration tests:**
  - `test/wave2-integration.test.ts` (U5 × P3), on a public-only rule over a 30-repo GitHub org:
    - the write API records every frozen head's push-log evidence;
    - `read.verify`, in read-only mode, proves each head from the log (`push log: 23 of 23 frozen head(s) were their default branch's tip at freeze`) and carries check 5's per-repo lines in `verbose`, behind one summary WARN;
    - every request was a read, the push logs among them, and the default token was swapped in on its origin and is never in the result.
  - `test/plugin-host.test.ts` (P3 × plugins-broker): an isolated plugin's 5 ms `blindRateLimitWaitMs` reaches the broker as 1 s, then 2 s, and a body-only 403 comes back at once. Without the host change the test fails (checked).
  - `pushLog` over v2 is P3's own `pooled-plugin` test, unchanged, now on the v2 frames.
- **Verified** (in this worktree, 2026-11-04, load average 1–7): build 0 · typecheck 0 (both tsconfigs) · `npm test` 86 files, **1311 passed (1311)** · `packages/pr-rla-mcp` `npm test` **59 pass, 0 fail** · gitea 1 pass · jira 1 pass · every demo exits 0.
- **Verified from three fresh clones of `integrate/wave2` at `45f1c9d`** (2026-11-04, 08:43Z–08:57Z, Node v22.23.2, load average 3–17), each run the same: `npm ci` 0 vulnerabilities · build 0 · typecheck 0 (both tsconfigs) · `npm test` 86 files, **1311 passed (1311)** · `packages/pr-rla-mcp` **59 pass, 0 fail** · gitea 1 pass · jira 1 pass · every demo exits 0.

### Merge 9: `bolt/u7-ci-integrations` (d83d991)

Merged on top of `45f1c9d` on the coordinator's instruction. U7 was cut from `0fa9ad8` and changes nothing under `src/`.

- **Conflicts:** only `BUILD-NOTES.md`; U7's section goes before this one. `README.md` auto-merged: U7's "CI integrations" section sits before "Architecture", with P4's and P3's edits around it unchanged. `package.json`, `package-lock.json` (`ajv` 8.20.0) and `.gitignore` (the `vendor/` exception) merged cleanly.
- **Tests:** U7's 202 tests (46 + 113 + 43) pass against the integrated build unchanged. They run `dist/cli.js`, so they run P4's and P3's code: the merged suite is 89 files, 1513 passed.
- **The Action's pin, re-taken from the integrated build** (`node scripts/pack-action-tarball.mjs`): `vendor/pr-rla-0.1.0.tgz` is now `npm pack` of this tree, sha512 `umZUL1XC…nB0Xg==` in the Action's lockfile (it was U7's snapshot of `0fa9ad8`, `P9hXc6xR…dng==`). The tarball gains P4's and P3's modules (`core/head-proof`, `core/ledger-path`, `io/executables`). Packing twice gives the same bytes (sha256 `71fff18d…`). `npm --prefix integrations/github-action ci` installs it, `pr-rla --version` prints 0.1.0, and its `verify --help` lists P3's `--verbose`.
- **Fixed on the way:** the first re-pin shipped `dist/commands/freeze-pool.*`, compiled from a file U5 removed. tsc never deletes the output of a deleted source, and this worktree's `dist/` predates merge 6. A fresh clone does not have the problem, but a maintainer's checkout does. The pack script now removes `dist/` before it builds; with a stale file planted in `dist/`, the tarball is byte-identical to a clean one.
- **Verified from a fresh clone of `integrate/wave2` at `6b0ec01`** (2026-11-04, 09:13Z–09:19Z, Node v22.23.2): `npm ci` 0 vulnerabilities · build 0 · typecheck 0 · `npm test` 89 files, **1513 passed (1513)** · `npm pack` of the clone equals the vendored tarball · `npm --prefix integrations/github-action ci` 0 vulnerabilities, `pr-rla --version` 0.1.0 · `packages/pr-rla-mcp` **59 pass, 0 fail** · gitea 1 pass · jira 1 pass · every demo exits 0 (`demo-ci` among them).

### Merge 10: `bolt/u6-assistants` (16a7a64)

Merged on top of `6b0ec01` on the coordinator's instruction. U6 was cut from U5's tip `3e21347` and changes nothing under `src/` and no package file.

- **Conflicts:** `BUILD-NOTES.md`, where U6's section goes before this one, and `docs/security-model.md`'s tiers. There P4's wording of the tier-2 attestation bullet is kept, and U6's tier-3 bullet (the guard hook, the skill's rules, `docs/assistants/guard.md`) replaces the old one-line tier 3. `README.md` auto-merged (U6's section appended).
- **The guard knows every command and option of the integrated CLI.** U6's guard already classified `plugin approve` and the consent routes (`--accept-lock-grants`, `PR_RLA_ACCEPT_LOCK_GRANTS`, `PR_RLA_APPROVALS_FILE`, `HOME`/`XDG_CONFIG_HOME`, writes to the approvals file), and its subcommand test passes unchanged. A new test beside it classifies every option `src/cli.ts` defines, on its command, and runs the guard on each:
  - **blocked:** every option of a write command (`record --sign`, `freeze --estimate`, `--resume` and `--dry-run`, `register --dry-run`, `plugin approve --env/--origin`), `--accept-lock-grants` before any command, and `checkpoint --push`, `--remote` and `--branch`;
  - **allowed:** the read and format options of the commands that only read (`verify --verbose`, `--offline`, `--log-key`, `--tsa-trust`, `--beacon-file`, `--json`; `status --offline`, `--json`; `draw-context --max-patch-bytes`; `plugin check`'s; `simulate`'s; the global `--dir`, `--config`, `--from-file`, `--plugins`).

  An option added later fails the test until it is classified. `freeze` stays blocked in every form, since the assistant has the MCP `freeze_preview` (its dry run and its `estimate`); `docs/assistants/guard.md` says so and names the option test. Plain `checkpoint` and `status --checkpoint` stay allowed, as U6 classified them: they append pr-rla's own local checkpoint line and push nothing, and the instruction named `checkpoint --push` as the write to block.
- **Tests adapted, none weakened:**
  - `integrations.test.ts` read the default token variables from `src/api/credentials.ts`, which merge 6 removed when consent became one store. It now reads them from the approvals store's `BUILTIN_DEFAULT_GRANTS` (`src/plugins/approvals.ts`). The variables are the same five, and the `.mcp.json` and Cursor assertions are unchanged.
  - Its licence check met U7's Action package. That package's own `"license": "UNLICENSED"` (in `package.json` and the lockfile's root entry) is the project's no-licence marker, as in the root `package.json`, and the lockfile's dependency entries carry third-party packages' licences (npm's metadata, not a licence of ours). The check now requires a package's own licence field to be exactly `UNLICENSED` and leaves those fields out of the text check, which every other byte of `integrations/` and `docs/assistants/` still goes through. An installed `node_modules` (not committed) is skipped.
- **Tool names:** the skill's `allowed-tools` (`mcp__plugin_pr-rla_pr-rla__` plus `audit_list`, `status`, `draws`, `draw_context`, `job_status`) name tools the integrated server registers (plugin `pr-rla`, server `pr-rla`; eight tools, `TOOL_NAMES`). U6's test reads them from the server's source.
- **Wording:** U6's docs pass the allow-list as they are.
- **The Action's pin** is re-taken (`node scripts/pack-action-tarball.mjs`), because `npm pack` includes `README.md`, which U6 extended. Nothing else in the tarball changed.
- **Verified** (in this worktree, 2026-11-04, load average 17–34): build 0 · typecheck 0 · `npm test` 91 files, **2415 passed (2415)** (U6's 901 and the option test among them) · `packages/pr-rla-mcp` **66 pass, 0 fail** (U6's review-draw flow among them) · `claude plugin validate integrations/claude-code` and `claude plugin validate .` (the marketplace), Claude Code 2.1.267: both pass · gitea 1 pass · jira 1 pass · every demo exits 0 (`demo-review-draw` among them) · `npm --prefix integrations/github-action ci` 0 vulnerabilities, `pr-rla --version` 0.1.0.
- **Verified from a fresh clone of `integrate/wave2` at `1943f7f`** (2026-11-04, 09:41Z–09:49Z, Node v22.23.2, load average 31–48): `npm ci` 0 vulnerabilities · build 0 · typecheck 0 · `npm test` 91 files, **2415 passed (2415)** · `npm pack` of the clone equals the vendored tarball · the Action's `npm ci` 0 vulnerabilities, `pr-rla --version` 0.1.0 · `packages/pr-rla-mcp` **66 pass, 0 fail** · gitea 1 pass · jira 1 pass · every demo exits 0 · both `claude plugin validate` runs pass.

### Merge 11: `fix/p2-time-b` (2a8fa2d)

Merged on top of `1943f7f` on the coordinator's instruction. P2 was cut from `0fa9ad8`; its section's "For the integration step" (a trial merge against `6b0ec01`, with resolved source files in the scratchpad) was the plan.

- **Conflicts (12 files):**
  - **Source.** `src/core/verify.ts`, `src/api/pool-list.ts` and `src/cli.ts` are each a both-sides line: P4's `auditBinding` import beside P2's `./verdict.js` and `./window.js`; P3's `now` beside P2's `horizon`; P3's `--verbose` beside P2's exit-code help. Resolved by hand, they are byte-equal to P2's reference resolutions. `src/api/read/status.ts` is the seam. P4's `ledgerIntegrity` and `certificateWithheld` sit beside P2's `certificate` and `certified`, and P4's extra arguments to `countedLedgerVerdicts` sit inside P2's access `try`, with `ineligible: () => null` in its fallback. P4's gate goes through P2's one certificate: `failedWithholdings(withheld.map((w) => "verify check 7 would FAIL: " + w))`, beside the unproven times. P2's reference file was taken after a line-by-line review against both sides.
  - **Docs.** `contracts.md` keeps P3's two registration rows and P2's `publicKeyPem` row and "Draws" section, and P3's `verbose` sentence and P2's verdict-model bullet. The MCP README's `verify` row has P3's `verbose` and P2's wording and `certified`.
  - **Tests.** `api-cli-contract`, `git-file-unchanged`, `pooled-plugin`, `u8-review` and `single-repo-anchor` (below). In BUILD-NOTES, P2's section goes before this one.
- **Tests that expected the old model, each updated to the same intent under the stricter one (none weakened):**
  - **P4 (3).** `p4-review-regressions` E1 and attack B, and the wave-2 seam test, now assert the one line, `target reached · CERTIFICATE WITHHELD (verify check 7 would FAIL: the ledger's integrity check FAILs)`, and the reason names check 7. Attack B also asserts `certified: false`, the certificate `{ state: WITHHELD, withheld: [{ verdict: FAILED, … }] }`, status exit 1, and `sequence.state` CERTIFIED as the raw state. The seam test now registers with two mock authorities. Through the CLI's context, which trusts their roots, the honest audit is CERTIFIED (exit 0) and the rewritten one withheld by check 7 alone (exit 1). Through `pr-rla/api/read`, which trusts only the shipped bundle, both are withheld for the unproven times, and the rewritten one by check 7 too.
  - **P3.**
    - `p3-pool-head`'s finding-3 shapes (12 cases) are frozen, unsampled pools without authorities. They now assert that check 5 keeps its own status, that nothing FAILs, and that the INCOMPLETE comes only from checks 1–4 and 6–7 (plus 5 where a window commit is not placed), each test saying why.
    - A new test keeps VERIFIED where that is the intent: with two mock authorities, a commit dated in the window and pushed onto the frozen head after freeze, then sample and verify, is VERIFIED with check 5's FR7.2 note.
    - `u8-review`'s backdated push uses P2's `honestButUnsampled`.
    - `pooled-verify` records one verdict per drawn change: the draws moved, and draw 1 now repeats a change among the first 12.
  - **U7 (24).** The CI fixtures now register and freeze with two mock authorities, and each audit carries a trust file for them. The CERTIFIED tests pass it as the owner's `tsa-trust` and are truly PROVEN, and still exit 0. New tests run the same audit without the anchors: the state is `WITHHELD`, the exit 6, and the job fails unless `fail-on` leaves `incomplete` out. The tests changed beyond that:
    - the label-event prefix is computed from the draws (20 labelled changes now cover 21 draws);
    - a self-hosted tracker without approval is `INCOMPLETE`, exit 6 (P2's access rule, where U7 expected NOT_CERTIFIED and exit 0);
    - an offline verify is INCOMPLETE (exit 6) and passes only when `fail-on` leaves `incomplete` out;
    - the Action's checkpoint test keeps the authorities' server up, since a checkpoint asks them again.
  - **`single-repo-anchor`.** The three rule sets apply in turn: U8's, P4's ledger path, P3's head evidence, P3's moved heads, then P2's key and draws and `timeRoundB`. P3's moved shapes are VERIFIED on master. Here only checks 1–3 become INCOMPLETE (exit 6), with check 5 and the FR7.2 note as master has them.
  - **`api-cli-contract`.** P4's exit 1 stays for the uncommitted ledger. After the commit, offline verify is INCOMPLETE (exit 6) with no FAIL.
  - **U6's review-draw flow** and its docs move to draw #27 (gh-aw#55696: 12 of 18 files generated; CI 29 success, 3 skipped), as P2 moved the MCP demo.
  - **Wording.** P2's line listing the demo files is vetted under `names`.
- **Added by the merge, where two rounds met:**
  - **`pr-rla status --tsa-trust <file>`** (repeatable; `StatusOptions.tsaTrust`; passed on to `status --checkpoint`'s checkpoint).
    - Under P2 a certificate needs proven times. `register`, `freeze`, `checkpoint` and `verify` all take the verifier's extra anchors, but `status` could prove only the shipped bundle's. So an audit stamped by any other authority could never show a certificate in status, and no CI job could pass one.
    - `pr-rla/api/read` and the MCP `status` tool are unchanged: they trust the shipped bundle only.
    - The anchors come only from the operator: the flag, or the CLI's context. The wave-2 seam test commits the same trust file in the audited repo and names it in its `.pr-rla.yml` (`tsa_trust`, `tsaTrust`, `trust_bundle`) and its `pr-rla.lock.json`: status still withholds (exit 6), and the operator's `--tsa-trust` naming that very file certifies (exit 0). An operator-set `pr-rla-mcp --tsa-trust`, like `--root` and never a tool input, is left for the final round (the coordinator).
    - U6's option test now classifies `status --tsa-trust` as a read. It also runs the guard on the value forms: `verify --log-key https://…=key.pem --tsa-trust …` and `status --tsa-trust …` are allowed, while `--accept-lock-grants status …` and `checkpoint --push --tsa-trust …` are blocked.
  - **CI integrations.**
    - A `tsa-trust` input on the Action and the GitLab component, and `PRRLA_TSA_TRUST` in the plain snippet and the Bitbucket step. These are anchor files that whoever owns the CI configuration trusts, passed as `--tsa-trust` to `status` and `verify` (and to the Action's `checkpoint`). Relative paths are made absolute, since `-C` moves the CLI.
    - The Action's prepare step, and the shared job scripts, refuse a name that is not a file, and a shell metacharacter in it never runs (tested).
    - The exit map's reason for 6 now names unproven times and skipped checks, in all four copies, which stay identical (tested).
    - The Action's `state` output is now the certificate's state, never `sequence.state` (P2's one display decision): CERTIFIED, WITHHELD, NOT_CERTIFIED, ESCALATE, REFUSED or INCOMPLETE.
    - `docs/ci/*`, the README and `docs/security-model.md` say so, and that these anchors are the CI owner's trust, which proves nothing to a third party.
- **Verified** (in this worktree, 2026-11-04, load average 4–10): build 0 · typecheck 0 · `npm test` 93 files, **2472 passed (2472)** · `packages/pr-rla-mcp` **66 pass, 0 fail** · gitea 1 pass · jira 1 pass · every demo exits 0.
