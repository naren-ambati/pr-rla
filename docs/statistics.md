# The statistics

This page explains the test pr-rla runs, why its risk limit holds, when it stops, why a small population means reviewing everything, and how the draws are derived. It describes the code as it is ([`src/core/sprt.ts`](../src/core/sprt.ts), [`src/core/seed.ts`](../src/core/seed.ts), [`src/core/status.ts`](../src/core/status.ts)); the original design and its sources are in [`design/spec.md`](design/spec.md). The terms are in [`concepts.md`](concepts.md).

## The claim: what reviewers would detect, not the true defect rate

A ballot is ground truth; a review verdict is not. Reviewers miss defects. If a deep review under the registered protocol catches a fraction *r* of real defects, the rate a review would flag is *d = r · p*, where *p* is the true defect rate. So pr-rla states two claims apart, and builds only the first:

- **Claim D (the only claim in 0.1.0):** *"deep review under protocol P would flag at most p0 of this window's changes in the stratum, at risk α."* It needs no assumption about *r*. Every certificate prints it in words: `claim D (detected-defect rate ≤ 10%, protocol f484…, …)`.
- **Claim T** (the true rate *p* ≤ p0) would need a lower bound on *r* from planted defects. It is not built.

Each change in the population has one verdict: the first eligible verdict recorded for it. A change drawn twice reuses that verdict. So the population, as the reviewers would judge it, has a fixed fraction *d* of changes they would fail, and the audit is a test about *d*.

## The test: Wald's SPRT over draws with replacement

pr-rla runs a ballot-polling risk-limiting audit, the design of BRAVO (Lindeman, Stark and Yates, 2012): Wald's sequential probability ratio test over changes drawn uniformly at random, with replacement, from the frozen list.

- **Hypotheses.** H0: *d* ≥ p0 (the tolerance). The planning alternative p1 < p0 (default p0/5) tunes how fast the test certifies a clean stratum; it is not part of the claim.
- **Scoring.** Each draw adds to a running log-likelihood ratio (LLR): a pass adds ln((1 − p1)/(1 − p0)), a fail adds ln(p1/p0). The test certifies as soon as the LLR reaches ln(1/α).
- **With the defaults** (p0 = 10%, p1 = 2%, α = 5%): a pass adds +0.0852, a fail adds −1.609, and the target is ln 20 = 2.996.

**Why the risk limit holds.** Under H0, the likelihood ratio (the exponential of the LLR) is a non-negative supermartingale with expectation at most 1, because each draw is an independent draw of one change from a fixed list. By Ville's inequality, the chance that it ever reaches 1/α is at most α. That holds whatever the population's size, at every draw, and for any rule about when to stop. So the chance of certifying a stratum whose detected rate is at or above p0 is at most α. The simulations below check it at the tolerance.

## When it stops

- **CERTIFIED** at the first draw where the LLR reaches the target. With the defaults that is 36 draws with no fail, 56 with one, 75 with two (`stoppingTable` in `src/core/sprt.ts`). With p0 = 5% and p1 = 1% it is 73, 113 and 153 (`test/sprt.test.ts` pins both tables).
- **ESCALATE** at the cap, which defaults to 4 × the zero-failure stopping point (144 draws with the defaults), **or earlier**, as soon as the target can no longer be reached within the cap even if every remaining draw passes. ESCALATE means the claim cannot be certified from this sample: review every change, or narrow the claim and register a new audit.
- **Not yet:** otherwise `status` says how many more passing draws it needs (`36 more passing draws needed (36 total)`).

`register --dry-run` prints the stopping table and the cap for the registered parameters. On the phase-1 demo configuration, `examples/gh-aw-q3/.pr-rla.yml`, run 2026-11-04, offline, with its one author named by account id (`id:198982749`, Copilot's, because `register` looks a login up on the SCM and this run reaches none; `npm run docs:outputs` regenerates it; the registration's hash and the seed round depend on the clock): <!-- docs-output: register-dry-run -->

```output
$ pr-rla register --dry-run
[dry run] registration 723e9b66258f… · github/gh-aw · window 2026-q3 (2026-07-01..2026-09-30)
  claim D: detected-defect rate <= 10% (p1 2%, risk 5%) · certify after 36 / 56 / 75 draws with 0/1/2 fails · cap 144
  selector {"kinds":["pull_request","direct_push"],"authors":["id:198982749"],"labels":[],"unreviewed":"no-human-review","merged_by":"any","max_changed_lines":200,"exclude_generated":true,"bots":[],"direct_push_via_merge":"include"}
  protocol 9f9ec5b6c79d… (../../docs/design/review-protocol.example.md)
  provider github (builtin 0.1.0) · ledger git-file · verdict provenance self-asserted
  warning: the git-file ledger is not in a git repository, so its path cannot be registered and it has no tamper trail; register from a clone of the audit repository
  seed round R = 33697561 (drand quicknet), publishes 2026-11-05T16:27:27Z: 24 h after the registration
  RETROSPECTIVE (registered after the window opened: a demonstration, not evidence)
  timestamps: not requested (dry run) · authorities sigstore, digicert, globalsign, microsoft · k = 2
(exit 0)
```

The registration's time is its own signed `registeredAt`, so for a registration made after the window closed, as here, R is 24 hours after the registration (below).

## Only the longest fully labelled prefix counts

The draw order is the audit. `status` walks the issued draws in order and stops at the first draw whose change has no eligible verdict: that draw blocks everything after it (`blocking draw: #4 …`), so reviewers cannot improve the result by reviewing the easy draws first. Verdicts recorded beyond the blocking draw are not lost; they count once the prefix reaches them. Labelled draws after the test already stopped are reported as not counted.

- **Duplicates.** Draws are with replacement, so one change can be drawn twice. Its first verdict is reused, and every draw counts as an observation: a failed change drawn twice counts as two fails. That is what sampling with replacement means for the test, and it is why `status` reports `distinct changes reviewed` separately from `draws counted`.
- **One verdict per change.** Only the first eligible verdict for a change counts; a later different verdict is reported as a relabel. Ineligible verdicts (a bot's, an app's, an unregistered reviewer's, one below the signing rules) are ignored with their reason.
- **Issued draws.** `draws.json` holds every draw up to the cap (they are deterministic), and `sample` issues the zero-failure stopping point (36) by default. When the test needs more (after a fail), `pr-rla sample --through 56` issues more of the same sequence; an issue ledger then opens their issues.

## Simulation: the risk limit at the tolerance

`pr-rla simulate` runs the same scores and stopping rule as `evaluateSequence`, the function `status` uses (`src/core/simulate.ts`; `test/simulate.test.ts` checks that every run decides as `evaluateSequence` does on the same draws), against an oracle population with a known number of defects: 20,000 simulated audits by default, each stopping at the test's own decision. At the tolerance, a certificate is a false one, and the risk limit requires at most 5% of runs to certify. Run 2026-11-04, offline (`npm run docs:outputs` regenerates it): <!-- docs-output: simulate-tolerance -->

```output
$ pr-rla simulate --population 400 --defects 40
population 400, 40 defective (true rate 10%) · claim D p0 10% p1 2% risk 5% · cap 144 draws · oracle recall 1.0
certified 4.38% of 20,000 simulated audits · escalated 95.62%
mean draws 57.9 · mean distinct reviews 53.5 (when certified 52.3)
at or above the tolerance: certifying is a false certificate; the risk limit requires ≤ 5% → holds
(exit 0)
```

A clean stratum the size of the gh-aw Q3 stratum in the spec's count (1,590 changes; pr-rla's own N is 1,589), 1% defective, certifies almost always, after about 44 distinct reviews. Run 2026-11-04, offline: <!-- docs-output: simulate-clean -->

```output
$ pr-rla simulate --population 1590 --defects 16
population 1,590, 16 defective (true rate 1.01%) · claim D p0 10% p1 2% risk 5% · cap 144 draws · oracle recall 1.0
certified 99.83% of 20,000 simulated audits · escalated 0.17%
mean draws 44.8 · mean distinct reviews 44.1 (when certified 44.0)
(exit 0)
```

The spec's own simulation table (`design/spec.md`) gives 4.53% certified at 400 changes and 40 defects, and 99.8% with about 44 distinct reviews at 1,590 and 16: the same picture. pr-rla's numbers moved a little in the U5 fix round, when each simulated run began stopping at its decision (BUILD-NOTES, "U5 fix round": the random stream advances less, so a seed gives other runs); the risk limit held before and after.

## Why a population below 150 means reviewing everything

`status` and `sample` refuse an audit whose population N is below the registered minimum (`audit.min_population`, default 150): `population 12 < 150: review all 12 instead`, exit 3. Draws that exist anyway fail check 6.

This is a choice about value, not about validity. The risk limit above holds for any N. But the sample size of the test barely depends on N: certifying takes 36, 56 or 75 draws, and the cap is 144, whatever the population. So the smaller the population, the less an audit saves:

- At N = 150 the cap (144 draws) is about the size of the population. A clean stratum still certifies after about 36 distinct reviews, but a stratum at the tolerance escalates, usually well before the cap (a mean of 58 draws below), and then every change needs a review anyway.
- Reviewing all N changes gives an exact count, with no risk at all, for at most 150 reviews.

Run 2026-11-04, offline: <!-- docs-output: simulate-small -->

```output
$ pr-rla simulate --population 150 --defects 15
population 150, 15 defective (true rate 10%) · claim D p0 10% p1 2% risk 5% · cap 144 draws · oracle recall 1.0
certified 4.41% of 20,000 simulated audits · escalated 95.59%
mean draws 57.9 · mean distinct reviews 47.2 (when certified 45.2)
at or above the tolerance: certifying is a false certificate; the risk limit requires ≤ 5% → holds
(exit 0)

$ pr-rla simulate --population 150 --defects 1
population 150, 1 defective (true rate 0.67%) · claim D p0 10% p1 2% risk 5% · cap 144 draws · oracle recall 1.0
certified 99.98% of 20,000 simulated audits · escalated 0.01%
mean draws 41.4 · mean distinct reviews 36.0 (when certified 36.0)
(exit 0)
```

The floor is checked for each window when it is registered, never assumed from an earlier window (the spec's gh-aw stratum moved from about 122 a week in Q3 to about 40 a week in October 2026). A registration can set another `min_population`; it is signed with the rest of the parameters.

## How the draws are derived

Nothing about the sample is chosen by anyone: it follows from records fixed before the randomness exists.

1. **The seed round R.** R is the first drand quicknet round that publishes at least 24 hours after the later of the window's close and the registration's signed time `registeredAt`: `R = ⌈(t − 1692803367) / 3⌉ + 1` for t = that time plus 24 h, since quicknet round R publishes at 1692803367 + 3 · (R − 1) seconds (`deriveSeedRound`). The registration and the manifest commitment must be time-stamped before R publishes (checks 1–3). Timestamp tokens bound `registeredAt` but never move it, so presenting a different token cannot move R.
2. **The randomness.** `sample` fetches round R (or reads `--beacon-file`), checks its BLS signature against the pinned quicknet public key with `drand-client`, and takes its randomness: the SHA-256 of the signature, 32 bytes.
3. **Each draw.** Draw *i* (1-based) is the 0-based index

   index_i = int_be( SHA-256( randomness ‖ binding ‖ uint64be(*i*) ) ) mod N

   where `binding` is the registration's `sha256` for a schema-v2 audit (the manifest's for a v1 audit, as v1 audits were drawn), `uint64be(i)` is *i* as 8 bytes big-endian, the hashed message is exactly 72 bytes, and the digest is read as an unsigned 256-bit big-endian integer (`drawIndex` in `src/core/seed.ts`; [`contracts.md` §5](design/phase-3-4/contracts.md), "Draws").
4. **What the index points into.** The population in canonical order: ascending by **draw key**, `scheme ":" R " " L` (`R` is the SCM's stable repo id for a rule pool, `id:<repoId>`, or the path exactly as the signed registration names it for a repo or a list; `L` is `#n` or `@sha`), compared by UTF-16 code units (JavaScript's `<` on strings). A single repo's order is its change-id order. No name the auditee picks can move a draw: renaming or respelling a repository between freezes changes nothing for a rule pool, and check 2 fails a manifest that spells a repo or a list entry other than the registration does ([`contracts.md` §5](design/phase-3-4/contracts.md), "Draws"). The manifest stores its changes in that order, and check 2 fails one that is not; a schema-v1 audit, whose order is its change ids, is INCOMPLETE in check 6 (its draws are bound to the manifest).

**Why the registration and not the manifest.** Before time round B, the binding was the manifest's hash, which covers what the freezer chooses: the freeze time, the funnel, the limitations, the pr-rla version. One registration frozen a dozen times before R could give a dozen samples to choose from. Bound to the signed registration, the draws depend only on the registration, the beacon and the set of change ids, so freezing again cannot move a draw (BUILD-NOTES, "P2 time round B"). What can still move N is SCM state that changes after a change landed and that pr-rla reads as of the freeze: labels (a `labels:` stratum), an approval dismissed after the merge, an account renamed. Those are stated limits ([`security-model.md`](security-model.md)).

**Checking it by hand.** `pr-rla verify` check 6 recomputes every draw in `draws.json`. A second implementation, [`scripts/rederive-draws.mjs`](../scripts/rederive-draws.mjs), does the same with `node:crypto` alone and no pr-rla code (it does not check the BLS signature; check 4 does). On the recorded gh-aw audit, run 2026-11-04, offline (`npm run docs:outputs` regenerates it): <!-- docs-output: draw-by-hand -->

```output
$ node scripts/rederive-draws.mjs test/fixtures/audits/gh-aw-q3-recorded 1 2 3 36
round 33245812: randomness = SHA-256(signature): true
binding: the registration sha256 1a619c365fb07dea… · N = 1589
draw 1: index 1030 = github:github/gh-aw#53413 · draws.json: github:github/gh-aw#53413 · same
draw 2: index 167 = github:github/gh-aw#44286 · draws.json: github:github/gh-aw#44286 · same
draw 3: index 966 = github:github/gh-aw#52960 · draws.json: github:github/gh-aw#52960 · same
draw 36: index 1026 = github:github/gh-aw#53374 · draws.json: github:github/gh-aw#53374 · same
(exit 0)
```

Phase 1 cross-checked the v1 formula (the manifest binding) with an independent Python implementation (BUILD-NOTES, "Status"); for the v2 binding, `test/seed.test.ts` recomputes the index from the concatenated 72 bytes for draws 1, 2, 3 and 144, and the script above is the second implementation.
