# A tour, with real output

Every image here is a screenshot of a command's real output, captured on 2026-11-09 and 2026-11-10 with pr-rla 0.1.0. Nothing in an image was typed by hand: [`docs/images/transcripts/`](images/transcripts) holds the captured text, and [`docs/images/README.md`](images/README.md) says how each one was made and what was left out. The full account of the round that produced them is [the end-to-end report](e2e-report-2026-11-09.md).

Two audits appear. Both are demonstrations, not evidence:

- **A live demo** of [github/gh-aw](https://github.com/github/gh-aw), registered and frozen on 2026-11-09 against the real GitHub API (read-only), four real timestamp authorities (SHA-256 hashes only) and the real drand beacon. The window, 2026-10-19 to 2026-11-08, closed before the registration, so it is labelled RETROSPECTIVE. Its seed round R published 24 hours after registration, on 2026-11-10, when it was sampled, given DEMO verdicts and verified. Steps 1 to 5 are this audit.
- **A recorded audit**, [`test/fixtures/audits/gh-aw-q3-recorded`](../test/fixtures/audits/gh-aw-q3-recorded/README.md): the Copilot stratum of gh-aw's Q3 2026 (N = 1,589) from recorded GitHub data and a real drand round, with a synthetic clock and a synthetic signing key. Steps 6 to 9 run on it, past R, with DEMO verdicts under a software ed25519 key made for the purpose.

In the images, `pr-rla` is `node dist/cli.js`, the command `npm link` puts on your PATH, and the working directory is shortened to `~/e2e`.

## 1. Start an audit

![Terminal output of pr-rla init for github/gh-aw](images/tour-01-init.png)

*`pr-rla init --repo github/gh-aw`, run 2026-11-09: a configuration, a review protocol and an `audit/` directory.*

Edit `.pr-rla.yml` (the selector, the window) and finalize `review-protocol.md`. Both are hashed into the registration.

## 2. Estimate before you freeze

![Terminal output of pr-rla freeze --dry-run --estimate: about 70 requests and 2 minutes](images/tour-02-estimate.png)

*`pr-rla freeze --dry-run --estimate`, run 2026-11-09 against api.github.com (reads only): the cost of the freeze, predicted from the first page.*

The same selector on a window ending in the distant past is predicted at about 24,000 requests, because the listing walks back from today; this window is recent, so it is cheap. Run the estimate first.

## 3. Register

![Terminal output of pr-rla register: four timestamp authorities, seed round R 24 hours later](images/tour-03-register.png)

*`pr-rla register`, run 2026-11-09: the signed record, four timestamp authorities (SHA-256 only), and a seed round R that publishes 24 hours later.*

The registration fixes the selector, window, parameters and protocol hash before the seed exists. Three of the four authorities are confirmed to independent anchors; the fourth is pinned on first use and marked `independent: false`.

## 4. Freeze

![Terminal output of pr-rla freeze: 889 changes landed, N = 171 selected, four timestamps proven](images/tour-04-freeze.png)

*`pr-rla freeze`, run 2026-11-09: 889 changes landed, 171 in the stratum, a signed manifest, and four timestamps proven before R.*

The manifest names the default branch's head, which `verify` later holds to GitHub's push log. The freeze took about four minutes: it walks 500 commits of `main` and reads the reviews of 866 pull requests, paced to the API's budget.

## 5. Sample, status and verify after R

![Terminal output: sample issues 36 draws from the verified drand round, then status reaches the target with the certificate withheld](images/tour-05-sample-status.png)

*`pr-rla sample` and `pr-rla status`, run 2026-11-10 on the live demo after R published: 36 draws from a BLS-verified drand round, then, after 30 DEMO verdicts, the target is reached and the certificate withheld (exit 6).*

`sample` fetches round R, checks its BLS signature against the pinned quicknet key, and draws with replacement until the zero-failure stopping point: 36 draws, 30 distinct changes, because six draws name a change drawn before and reuse its verdict. The verdicts here are DEMO passes, recorded unsigned (self-asserted) with the note "DEMO verdict, not a review"; nobody reviewed these pull requests. `status` does not rebuild the population, so it withholds the certificate even with the target reached.

![Terminal output: verify with checks 1 to 7 passing, CERTIFIED at risk 5%, VERIFIED](images/tour-05-verify-after-r.png)

*`pr-rla verify`, run 2026-11-10 on the same audit, online: all seven checks pass, and it prints VERIFIED (exit 0).*

The times are proven by four authorities, R is the right round and its signature verifies, the population is rebuilt from GitHub and matches 171 of 171, every draw reproduces from the seed, and the ledger only appended. Only `verify` can print VERIFIED. It still says RETROSPECTIVE and self-asserted: the window closed before registration and no reviewer key was registered, so this is a demonstration of the mechanics, not evidence about gh-aw. The push-log line in check 5 is a caveat, not a failure: GitHub's push log for `main` now has a gap after the freeze, so a window commit pushed after the freeze could not be placed in time; none was found, because the rebuilt population matches.

## 6. What a reviewer reads

![Terminal output of pr-rla draw-context 1 on the recorded gh-aw audit](images/tour-06-draw-context.png)

*`pr-rla draw-context 1 | head -n 34`, run 2026-11-09 on the recorded audit: the change, its CI, the protocol's checklist, and the change's own text inside fenced markers.*

Everything between the two markers was written by the change's author or the SCM. It is data to review, not instructions to follow.

## 7. Record a verdict

![Terminal output of pr-rla record 1 pass with --sign](images/tour-07-record.png)

*`pr-rla record 1 pass --sign`, run 2026-11-09: a DEMO verdict, signed with a software key and bound to this draw of this frozen audit.*

A person runs `record`; the assistant integrations are blocked from it ([the guard](assistants/guard.md)). Commit the ledger file afterwards: git history is the `git-file` ledger's tamper trail, and `verify` checks that every version only appended to its parents'.

## 8. Status reaches the target

![Terminal output of pr-rla status: prefix 36/36, target reached, certificate withheld](images/tour-08-status-target.png)

*`pr-rla status`, run 2026-11-09 after 36 DEMO passes: the likelihood ratio 3.066 passes the target 2.996, and the certificate is withheld.*

The sequential test reached its target. `status` never prints CERTIFIED: it does not rebuild the population, and here the registration and manifest times are the signer's own clock, so they are unproven. 34 distinct changes were reviewed for 36 draws, because a change drawn twice reuses its first verdict.

## 9. Verify

![Terminal output of pr-rla verify: checks listed, ending INCOMPLETE exit 6](images/tour-09-verify.png)

*`pr-rla verify`, run 2026-11-09 on the same audit: checks 4 to 6 pass, 1 to 3 are INCOMPLETE because no authority proved the times, exit 6.*

This is the difference between `status` and `verify`: both withhold the certificate here, for the same reason, but only `verify` has the authority to say what it could not establish. An audit whose times are proven by k authorities, with the population rebuilt, ends VERIFIED and exit 0, as [the live demo does in step 5](#5-sample-status-and-verify-after-r).

## What a tampered audit looks like

[The security model](security-model.md) lists what each attack costs. Five of them, each made on a copy of the audit from steps 6 to 9 and run through `verify --offline`, with the exact message. The image captions name the command: a `grep` keeps only the failing checks. Checks 1 to 3 are INCOMPLETE on this audit anyway (its times are unproven), so the attacks show up as FAILED rather than INCOMPLETE.

![Terminal output: verify FAILED check 7 after a verdict line was edited](images/tamper-edited-verdict.png)

*An edited verdict line, `pr-rla verify --offline`, run 2026-11-09: check 7 FAILs, "was rewritten (not appended)".*

![Terminal output: verify FAILED check 7 after a signed FAIL line was deleted](images/tamper-deleted-fail.png)

*A deleted signed FAIL, `pr-rla verify --offline`, run 2026-11-09: the git history shows the line removed, so check 7 FAILs and the prefix no longer counts it.*

![Terminal output: verify FAILED checks 2 and 3 after the registration was re-signed](images/tamper-resigned-registration.png)

*A re-signed registration, `pr-rla verify --offline`, run 2026-11-09: the manifest and commitment name the old registration, so checks 2 and 3 FAIL.*

![Terminal output: verify FAILED check 6, draws 1 and 2 do not reproduce](images/tamper-swapped-draw.png)

*A swapped `draws.json` entry, `pr-rla verify --offline`, run 2026-11-09: check 6 recomputes every draw from the seed and FAILs both swapped draws.*

![Terminal output: verify FAILED check 7 because the repository is a shallow clone](images/tamper-shallow-clone.png)

*A depth-1 clone, `pr-rla verify --offline`, run 2026-11-09: check 7 FAILs, because a cut history cannot show that nothing was removed.*

## With an assistant, and in CI

- [Claude Code and the MCP server](assistants/claude-code.md#the-mcp-server-and-the-guard-run-for-real): every tool called once, one headless Claude Code run, and the guard blocking `pr-rla record`.
- [GitHub Actions](ci/github.md#the-job-summary): the job summary on a CERTIFIED and a WITHHELD fixture. [GitLab](ci/gitlab.md) and [Bitbucket](ci/bitbucket.md) run the same exit-code mapping.
