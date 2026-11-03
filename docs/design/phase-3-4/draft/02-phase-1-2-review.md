# 02 · Review of the open questions from phases 1–2

These are the questions BUILD-NOTES leaves open: the "Open design questions" list from phase 2 and the Rekor risk from phase 1. Each answer gives a decision, the reason and its cost to the SDK. The answers that change behaviour become FR-X requirements (`01`) and work in unit U3 (`04`).

Answers marked **owner decision** change the audited population or a public contract. They carry a recommended default; the build follows the default unless the founder says otherwise.

## Phase 1

### P1-a · Rekor v2 has no `integratedTime`
Resolved in `05-functional-design.md` §U1. In short: RFC 3161 tokens bound the signed `registeredAt` / `frozenAt`, and Rekor becomes optional. Two further phase-1 gaps close in the same unit:
- **The checkpoint signature was never checked.** Rekor v2 has no SET, so a v2 entry's only log evidence is the inclusion proof plus the signed checkpoint. U1 verifies the checkpoint, which is a signed note, against the pinned log key.
- **The real Rekor call is unverified.** It stays unverified until the founder approves one staging submission (`05` §U1, "First real submission").

### P1-b · Multiple registrations (procedural control)
This is unchanged and cannot be solved in code: no log offers a complete search by signer. One cheap addition: `register` writes `audit/<window>/registration.receipt.txt`, which holds the registration digest, the TSA genTimes and the derived R as one paste-able block for the auditor. A prospective certificate printed by `status` names the same digest, so an auditor can match the receipt they were sent against the certificate.

### P1-c · git-file verdict times are self-asserted
Two mitigations, neither of which redesigns check 7. Ledger checkpoints (FR-L4) put a TSA-stamped hash of the verdict list into the record whenever CI runs. Verdict provenance levels (FR-M8) tell the reader how much a `recordedAt` and a `reviewer` are worth.

## Phase 2

### Q1 · Bots on regular accounts change the stratum → **registered `selector.bots`** (owner decision; recommended: yes)
- **Decision.** Add `selector.bots: [login | id:<n>]`. After the provider returns records and before the selector runs, the core re-labels every listed actor as `kind: "bot"`: author, merger and each review. Matching uses `normalizeLogin` or `Actor.id`. The list is part of the selector, so it is signed into the registration and shown on the certificate.
- **Why core, not providers.** One rule, identical on every SCM, and re-applied by `verify` from the registration. The Gitea plugin's `bots` option then becomes a provider default that the registered list overrides, and provider options are registered too (Q3).
- **Cost.** A selector field and one pure function in `src/core/selector.ts`. No SDK change. The manifest funnel prints "re-labelled as bot by selector: n actors".
- On gitlab-org/cli this moves 0 → 4 MRs into "no human review". That is the correct direction: those approvals came from automation.

### Q2 · The direct-push population drifts after freeze → **pin the head SHA** (recommended: yes)
- **Decision.**
  - Add optional `head?: string` to `ListChangesRequest`. It is additive within API version 1, the same way `ProviderContext.sleep` was added.
  - Add `ListChangesResult.headSha` (also optional).
  - `freeze` records the head per repo in the manifest. `verify` passes it back, so the rebuilt population walks exactly the frozen history.
  - A provider that ignores `head` still works. `verify` then adds a check-5 detail: `provider does not pin history; direct pushes dated in the window but pushed after freeze will show as extra`.
- **Conformance.** A new check, `pinned-head`. Its fixture adds a commit dated in the window and pushed after freeze. With `head` passed, the commit must not come back.
- **Why not push time.** Only GitLab exposes it durably (the Events API). Mixing time bases across providers would make pooled audits incomparable. Push-time windows can come later as a GitLab-only selector option.

### Q3 · Provider identity is not in the manifest → **record it, registered** (recommended: yes)
Covered by plugin trust (`05` §U2). The registration (schema v2) carries `plugins.provider = { name, source, version, integrity, optionsSha256, trust }`, and so does the ledger entry. `verify` prints the identity it rebuilt with. A different version or options is a **WARN** in check 5: the check still compares populations, but the reader is told that different code produced the rebuild. A different `optionsSha256` for options that change the population (`base_url`, `bots`) is a **FAIL**, because those options are part of the stratum.

### Q4 · Release branches merged by a direct push → **intended; make it visible and selectable** (owner decision)
- Under "every change that reached the default branch", each release-branch commit is a separate direct push. That matches the definition and hides nothing, but it can inflate "no human review" with commits that were reviewed as PRs into the release branch.
- **Recommendation.**
  - Keep the current behaviour as the default.
  - Add an optional, additive `ChangeRecord.landedVia?: string`: the SHA of the direct-push merge commit whose non-first parent brought the commit in.
  - Freeze prints it as a diagnostic: `direct pushes that arrived through merge 8f3a… (second parent): 214`.
  - A registered selector option `direct_push_via_merge: include | exclude` lets a team leave them out of the stratum before the seed. The certificate names the choice.
- **Why not re-attribute them to the release-branch PRs.** That changes what "a PR" means (merged into the default branch). It also fails on foxtrot merges, where the first parent is the local side, and pr-rla cannot tell which parent was the mainline without push history.

### Q5 · `no-review` and `DISMISSED` are provider-dependent → **define them in the SDK; declare granularity** (recommended: yes)
- **Decision.**
  - The SDK documents one review object as **one submitted review event**: GitHub reviews, Gitea reviews, GitLab approval/request-changes events.
  - An SCM with no review objects synthesises one `COMMENTED` per non-author user at their first comment. Each provider declares which it does with `reviewGranularity: "submission" | "first-comment-per-user"`, an optional definition field.
  - The manifest records the value.
  - In an org-pooled audit, `unreviewed: no-review` across providers of different granularity is refused at `register`: the stratum would mean different things in different repos.
- `DISMISSED` already means "a decision that no longer stands" on every provider. Document it, and add a kit check that a revoked approval never comes back as `APPROVED`.

### Q6 · Logins are not stable identities → **add `Actor.id`** (recommended: yes)
- Add optional `Actor.id?: string`: GitHub `databaseId`, GitLab user id, Bitbucket account UUID, Gitea user id.
- Selectors accept `id:<value>` alongside logins. The manifest stores both.
- `verify` matches by id when both sides have one, so a renamed GitLab user stays the same actor. Logins remain the display value.
- The kit gets a soft check, `actor-ids`: a provider that sets `id` must set it on every actor and keep it stable across two runs.

### Q7 · A genuine direct push is expensive to attribute → **cache + resume + estimate; no definition change**
- One freeze checkpoint store, shared with org pooling (FR-O4): `.pr-rla/cache/<window>/<run>/`, with responses keyed by request digest. A rate-limited freeze resumes where it stopped. `verify` never reads the cache: it must re-read the SCM.
- Providers may use a commit→PR index where one exists: GitLab `/repository/commits/:sha/merge_requests`, or GitHub `associatedPullRequests` (already used).
- `freeze --dry-run --estimate` samples the first pages and prints a request count and wall-time estimate against the SCM's budget before a long run.

### Q8 · An HTTP helper in the SDK? → **yes, as `pr-rla/http`, versioned on its own**
- Export the retrying JSON client from `src/providers/http.ts` as `pr-rla/http`, under `HTTP_HELPER_VERSION` and semver. It is not covered by `providerApiVersion`, so it can evolve without breaking providers.
- For out-of-process plugins (U2), the parent's fetch broker already does retries, `Retry-After`/`RateLimit-*` handling and per-host rate governance. A plugin there gets well-behaved fetch for free, and the helper matters mostly to in-process (`trust: full`) plugins and to tests.
