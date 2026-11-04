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
