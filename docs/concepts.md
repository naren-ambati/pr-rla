# Concepts

What pr-rla audits, the steps of an audit, and what each word in its output means. The statistics behind the test are in [`statistics.md`](statistics.md), the threats it is built against in [`security-model.md`](security-model.md).

## The idea

pr-rla makes a bounded, checkable statement about the changes that reached a default branch without a recorded human review: agent pull requests merged on a click, direct pushes. It does what an election audit does with ballots. It fixes the list of changes, draws a sample from it with randomness nobody could know in advance, has people review only the sample under a fixed protocol, and runs a sequential test on their verdicts. The test certifies a claim at a stated risk, says how many more reviews it needs, or says to review everything. Anyone can re-derive the sample and re-check every step with `pr-rla verify`.

## The population and the stratum

- **The window.** A period of whole UTC days (`window: { name, start, end }`, both inclusive). It opens at `start` 00:00:00Z and closes at the day after `end`, 00:00:00Z.
- **The population.** Every change that landed on the repository's default branch in the window: each pull or merge request merged into it, and each default-branch commit dated in the window that no merged pull request brought in (a **direct push**). No commit is counted twice, under merge-commit, squash, rebase or fast-forward merges. A pull request merged into another branch is not in it. A pooled audit's population is the union of its repositories' populations ([`org-pooled-audits.md`](org-pooled-audits.md)).
- **The stratum** is the part of the population the claim is about, chosen by the **selector**: the kinds (`pull_request`, `direct_push`), the authors, required labels, `unreviewed` (`no-human-review`, `no-review` or `any`), who merged (`merged_by`), a size limit (`max_changed_lines`), the accounts to count as bots on every provider (`bots`), and whether direct pushes that a pushed merge brought in count (`direct_push_via_merge`). `exclude_generated` changes what a reviewer is shown, never the stratum. N is the stratum's size.
- **No recorded human review** means no APPROVED or CHANGES_REQUESTED review by a non-bot account that is not the author, submitted at or before the merge. A later approval, or the author's own, does not count. An approval is not tied to the commit it approved, so an approval of an earlier head commit still counts.

## The review protocol and the claim

The **review protocol** (`review-protocol.md`) says what a deep review checks and when a change FAILS. Its SHA-256 is fixed by the registration, every verdict names it, and a verdict under another protocol does not count. The **claim** is claim D: *deep review under protocol P would flag at most p0 of this window's changes in the stratum, at risk α*. With the defaults (p0 = 10%, p1 = 2%, α = 5%) it certifies after 36, 56 or 75 draws with 0, 1 or 2 fails, and escalates at 144 draws or earlier ([`statistics.md`](statistics.md)).

## The steps of an audit

A window moves through four phases, `unregistered`, `registered`, `frozen` and `sampled`; `status` and the MCP `audit_list` tool name the phase.

1. **`init`** writes `.pr-rla.yml`, a starter `review-protocol.md` and `audit/`.
2. **`register`** signs the selector, the window, the statistics parameters, the protocol's hash, the provider's and ledger's identity, the verdict rules and the signing key itself (ECDSA P-256), and sends the record's SHA-256 to the configured timestamp authorities. The registration is **prospective** when k authorities prove it existed before the window opened (`U_k < opensAt`): its certificate is evidence. Otherwise it is **retrospective**: a demonstration.
3. **`freeze`**, after the window closes and before the seed round publishes, lists every change, applies the registered selector, and writes the **manifest** (`audit/<window>.manifest.json`: every change of the stratum, sorted, with its merge commit, the default branch's head the history was walked from, and the provider's identity) and a signed, time-stamped **commitment** to it (`manifest-commitment.json`).
4. **The seed round R** is derived, never chosen: the first drand quicknet round published at least 24 hours after the later of the window's close and the registration.
5. **`sample`**, once R has published, checks R's BLS signature and computes the **draws** (`draws.json`): each draw is one change of the manifest, from R's randomness and the registration's hash. With an issue ledger it opens one issue per drawn change, in draw order.
6. **Review and record.** A reviewer reads a draw (`pr-rla draw-context <n>`: its diff without generated files, its description, CI results and the protocol's checklist) and records `pass` or `fail` in the **ledger**: `pr-rla record <n> pass|fail --reviewer <you>` (or `--sign <key>` for a signed verdict) for `git-file`, or the verdict label on the draw's issue for an issue ledger.
7. **`status`** counts the **longest fully labelled prefix** of draws and runs the test: CERTIFIED, `n more passing draws needed`, or ESCALATE.
8. **`verify`**, run by anyone with the audit repository, checks seven properties from the records and the SCM.

## What `verify` checks

| Check | What it establishes |
|---|---|
| 1. registration | the registration's signature and key, that `review-protocol.md` still hashes to the registered value, the window re-derived from its days, its timestamp tokens (k operators), and whether it is PROSPECTIVE or RETROSPECTIVE |
| 2. manifest before seed | the commitment is time-stamped before R published, and the manifest is the registered set, sorted |
| 3. seed round | R is the derived round, from a proven registration time |
| 4. BLS | R's signature verifies against the pinned quicknet key |
| 5. population | the population, rebuilt from the SCM with the registered selector from the frozen head, equals the manifest |
| 6. draws | every draw in `draws.json` reproduces |
| 7. labels | the verdict events, their eligibility and provenance, and the ledger's own history |

Each check is PASS, WARN, FAIL, INCOMPLETE (not established: a time no k operators prove, a population not rebuilt or not shown complete, a read refused for want of a credential) or SKIP (not run: `--offline`, before `sample`). The audit's verdict is **FAILED** (exit 1) if any check failed, **INCOMPLETE** (exit 6) if any is incomplete or skipped, and **VERIFIED** (exit 0) only otherwise. `verify --offline` is never VERIFIED: it does not rebuild the population.

## The certificate

`status`, `verify`'s summary line and the MCP tools print **CERTIFIED** only when the test reached its target and nothing withholds it. The certificate's states:

| State | Meaning |
|---|---|
| CERTIFIED | the test reached its target, and the times it rests on are proven |
| WITHHELD | the test reached its target, but something withholds the certificate: `target reached · CERTIFICATE WITHHELD (why)`, for example a registration time not proven by k operators, or a ledger whose history check would FAIL |
| NOT CERTIFIED | the test needs more passing draws |
| ESCALATE | the test cannot certify from this sample: review every change, or narrow the claim |
| REFUSED | N is below the registered minimum: review all N instead |
| INCOMPLETE | the verdicts could not be read (a tracker that refused every read made without its credential) |

`--json` carries the certificate as `certificate: { state, withheld }` and `certified`; `sequence.state` is the test's raw state and never the claim.

## Verdicts, ledgers and provenance

A **ledger** is where verdicts live. The built-in **`git-file`** ledger appends lines to `audit/<window>/verdicts.jsonl`, and git history is its tamper trail: `verify` checks that every version of the file, in every commit, only appended to its parents' versions, from a full clone, at the path the registration records. The built-in **`github-issues`** and **`gitlab-issues`** ledgers open one issue per drawn change, and a verdict is the first eligible verdict label applied to the issue (by an account that is not a bot or an app, and is a registered reviewer when the registration lists them), read from the label-event history, never from current labels. The **Jira** example is an external ledger with the verdict in a single-select field ([`writing-a-ledger.md`](writing-a-ledger.md)).

Every counted verdict has a **provenance** level, printed on every certificate (`VERDICT PROVENANCE: account (36)`):

- **`self-asserted`**: the reviewer and time are what the writer typed (an unsigned `git-file` line);
- **`account`**: an SCM account did it, at the server's time (an issue ledger), or the line is signed with the reviewer's registered SSH key;
- **`presence`**: as `account`, signed with the reviewer's registered FIDO security key with the user-presence flag set, and printed as `presence (user-presence flag verified; key hardware not attested)`: pr-rla does not check that the key is hardware-backed, and has been tested with software keys only (threat T16).

A registration fixes the minimum (`verdicts.min_provenance`: `account` by default with an issue ledger, `self-asserted` with `git-file`), the reviewers whose verdicts count (`verdicts.reviewers`), and for signed verdicts the reviewers' keys (`verdicts.allowed_signers`) and, with the `git-file` option `require_signed: true` (recorded as `verdicts.require_signed`), that every counted verdict is signed. A verdict below the minimum fails check 7. Bots, apps and unregistered reviewers are ignored with a reason.

**Checkpoints.** A tracker's admin can delete issues and their history. `pr-rla checkpoint [--push]` hashes the ledger's verdict-event history, time-stamps the hash, and appends it to `audit/<window>/ledger-checkpoints.jsonl`; `verify` compares the history with every checkpoint. A ledger without a history it can return (`git-file`, whose history is git's) cannot be checkpointed.

**The ledger index.** An issue ledger keeps `audit/<window>/ledger-index.json` (draw → issue). `sample` binds its hash into `draws.json`, each checkpoint carries it, and check 7 fails an index that changed or does not match the draws, even offline.

### The ledger publication record

A ledger index is the auditee's own file, and so are the issue bodies whose markers name the draw: swapping the issues of two draws, with both bodies swapped and `draws.json` rehashed, would turn a failing audit into a certified one. So when a ledger publishes draws, `sample` signs the index it leaves with the registration's key, and has the registered timestamp authorities time-stamp its digest (SHA-256 only), in `audit/<window>/ledger-publication.json` (`pr-rla/ledger-publication/v1`). The record holds the index's hash, each draw's issue (number, id and URL) and the draws it covers; each later `sample --through` appends a record that must extend the previous one.

`verify`'s check 7 reads each verdict from the issue a proven publication lists, and FAILs when no proven publication exists, when the current index is not an append-only extension of the latest proven one, when a verdict was read from an issue no proven publication lists, or when a counted verdict is earlier than the time the first proven publication listing its issue existed. Issue numbers must rise with the draws. A publication short of tokens proves nothing: `sample` exits 5, and a verdict only such a publication binds leaves check 7 INCOMPLETE, never PASS. With no authority registered the record rests on the auditee's own signature and clock, and check 7 says `TIMESTAMP NOT TAMPER-PROOF`. A ledger that keeps no draw → issue index, such as `git-file`, has no publication record. `status` runs the same gate (`check7Gate`), so it never shows CERTIFIED where `verify` would FAIL this.

## Time evidence

`register` and `freeze` send each configured timestamp authority one RFC 3161 request holding only the record's SHA-256 digest and a nonce, and store the tokens in the record. A time counts as proven when tokens from k independent operators (`timestamping.min_tokens`, default 2) agree with the record's own signed time (within 10 minutes plus each token's accuracy, 60 s for a token that states none). With fewer, every output says `TIMESTAMP NOT TAMPER-PROOF (n of k)`: the time is the signer's own clock, so `verify` is INCOMPLETE and the certificate is withheld. The signed time stays the seed's input; tokens bound it and never replace it ([`trusted-time.md`](trusted-time.md)).

## Providers and plugins

A **provider** turns one SCM into the normalized change records the core works on: `github` (and GitHub Enterprise Server), `gitlab` (and self-managed), `bitbucket-cloud`, `bitbucket-data-center` and `json-file` are built in; anything else is a plugin ([`writing-a-provider.md`](writing-a-provider.md)). An external provider or ledger loads only once it is **locked** (`pr-rla plugin add`), runs **isolated** in a child process by default, and receives a credential only where the person running the command **approved** it ([`security-model.md`](security-model.md)).

## Who does what

- **A person** registers, freezes, samples, reviews, records verdicts and checkpoints, from their own terminal or the tracker's web UI.
- **CI** runs `status` and `verify` on every verdict event or on a schedule, and fails the job on ESCALATE, a refusal, too few timestamps or INCOMPLETE ([`ci/README.md`](ci/README.md)). It writes nothing unless its owner allows it.
- **An assistant** reads the audit through the read-only MCP server and helps a person review a draw; it never records a verdict ([`assistants/README.md`](assistants/README.md)).

## What it looks like

`pr-rla status --offline` on the recorded gh-aw audit (a retrospective audit of 1,589 changes, sampled, with no verdicts yet and no timestamp authority), in a copy of `test/fixtures/audits/gh-aw-q3-recorded`, run 2026-11-04 (`npm run docs:outputs` regenerates it): <!-- docs-output: status-recorded -->

```output
$ pr-rla status --offline
prefix 0/36 · fails 0 · claim D (detected-defect rate ≤ 10%, protocol f484…, stratum ≤ 200 lines, direct pushes via a pushed merge included) · LLR 0.000 / target 2.996 · NOT CERTIFIED · 36 more passing draws needed (36 total) · RETROSPECTIVE · TIMESTAMP NOT TAMPER-PROOF
  WARN the registration does not record the git-file ledger's path (registrations made before this field, only test fixtures, lack it): where the ledger lives is not bound, so a copy kept elsewhere would be read; register again to bind it
  blocking draw: #1 github:github/gh-aw#53413 https://github.com/github/gh-aw/pull/53413
  distinct changes reviewed: 0 · draws counted: 0
  VERDICT PROVENANCE: none counted · registered minimum self-asserted
  assumptions: claim D is about detection under the registered protocol by these reviewers, not the true defect rate; draws are with replacement.
(exit 0)
```

`pr-rla verify --offline` on the same copy, run 2026-11-04: <!-- docs-output: verify-recorded -->

```output
$ pr-rla verify --offline
1. INCOMPLETE registration: registration after window close → RETROSPECTIVE (a demonstration) (unproven: too few timestamps)
        registration sha256 1a619c365fb07deaf9c9e39f5a0396628ff252a83259ffe431a9a86689a3a3a5
        registration timestamps: no authority configured · TIMESTAMP NOT TAMPER-PROOF
        TIMESTAMP NOT TAMPER-PROOF: the registration's time is the signer's own clock
        registered with pr-rla 0.1.0 · provider json-file (builtin 0.1.0) · ledger git-file · verdict provenance self-asserted
2. INCOMPLETE manifest before seed: manifest written (signed time, unproven) 2026-10-20T12:00:00Z: not shown to precede R
        WARN the registration does not bind its selector's logins (copilot-swe-agent[bot]) to account ids (no accounts field: its provider could not resolve them, or it was written before P5), so they match as logins: an account renamed before the freeze, or a login written onto another account's change, could move a change in or out of the stratum (a retrospective audit: register warned)
        manifest commitment timestamps: no authority configured · TIMESTAMP NOT TAMPER-PROOF
        TIMESTAMP NOT TAMPER-PROOF: the manifest commitment's time is the signer's own clock
        frozen with pr-rla 0.1.0 · provider json-file (builtin 0.1.0)
3. INCOMPLETE seed round: R = 33,245,812: first round ≥ 24 h after registration, but the registration time it rests on is unproven
        INCOMPLETE R is derived from the registration time 2026-10-20T00:00:00Z, which no trusted evidence bounds (fewer than k timestamp authorities agree): it could have been written after round 33,245,812 was public, to choose R
4. PASS BLS: BLS
        round 33245812 randomness f9b8c2fb7b8afe1e… verified with drand-client against pinned quicknet key
5. SKIP population: offline: population not rebuilt
6. PASS draws: 36/36 draws reproduce
        144 draw(s) in the file compared, every one reproduces: SHA-256(randomness ‖ registrationSha256 ‖ uint64be(i)) mod N over the 1,589 changes in canonical order (by draw key: the registered path, or a rule pool's repo id)
7. WARN labels: labels (prefix 0, 0 events)
        VERDICT PROVENANCE: none counted (registered minimum: self-asserted)
        verdicts are not in a git repository: there is no tamper trail
        WARN the registration does not record the git-file ledger's path (registrations made before this field, only test fixtures, lack it): where the ledger lives is not bound, so a copy kept elsewhere would be read; register again to bind it
registration after window close → RETROSPECTIVE (a demonstration) (unproven: too few timestamps) · manifest written (signed time, unproven) 2026-10-20T12:00:00Z: not shown to precede R (incomplete) · R = 33,245,812: first round ≥ 24 h after registration, but the registration time it rests on is unproven (incomplete) · BLS ✓ · offline: population not rebuilt (skipped) · 36/36 draws reproduce ✓ · labels (prefix 0, 0 events) (warn)
registered with pr-rla 0.1.0 · frozen with pr-rla 0.1.0 · verified with pr-rla 0.1.0
registration timestamps: no authority configured · TIMESTAMP NOT TAMPER-PROOF
manifest commitment timestamps: no authority configured · TIMESTAMP NOT TAMPER-PROOF
TIMESTAMP NOT TAMPER-PROOF: registration and/or manifest times are self-asserted (fewer than k timestamp authorities agree)
prefix 0/36 · fails 0 · claim D (detected-defect rate ≤ 10%, protocol f484…, stratum ≤ 200 lines, direct pushes via a pushed merge included) · LLR 0.000 / target 2.996 · NOT CERTIFIED · 36 more passing draws needed (36 total) · RETROSPECTIVE
INCOMPLETE: check 1 (registration), check 2 (manifest before seed), check 3 (seed round) could not be established; check 5 (population) skipped; nothing failed, but this is not a verification (exit 6)
(exit 6)
```

Checks 1–3 are INCOMPLETE because no timestamp authority proves the fixture's times, check 5 is skipped offline, and check 7 warns that the copy is not in a git repository: nothing failed, and it is not a verification (exit 6).
