# pr-rla design spec

Risk-limiting audit for agent PRs that merged with no recorded human review.

This is the original design, as written on 2026-11-02 before v0.1 was built. Where the build departs from it, `BUILD-NOTES.md` says so. Two scope changes from the owner apply on top of this text: the core is SCM-agnostic (providers and ledgers are plug-ins), and the audited population is every change that landed on the default branch, which includes direct pushes.

**Note, 2026-11-04 (review rules).** The first build counted any human APPROVED or CHANGES_REQUESTED review, whenever it was submitted and whoever wrote it, so an approval dated after the merge, or the author's own, hid a change from the population. The selector now follows the "reviewer differs from author; approval precedes merge" line below: a review counts only if it was submitted at or before `mergedAt` and its reviewer is not the author (compared by account id where both have one, by login otherwise). On the recorded gh-aw Q3 listing this moves one PR (#51168, approved by a human 14 minutes after it merged): `2,947 / 2,718 / 1,589` instead of `2,947 / 2,717 / 1,589`, and N is unchanged because that PR has 221 lines. The figures below that were measured with the earlier rule are corrected to the new rule where the change is exactly one PR; `BUILD-NOTES.md` keeps the earlier numbers as "before the post-merge/self-review fix". One semantic limit stays, by decision: an approval is not tied to the commit it approved, so an approval of an earlier head commit still counts as a human decision (GitHub's dismissed stale approvals and GitLab's approval resets are `DISMISSED`; nothing else is inferred).

**Pitch.** Election officials cannot hand-count every ballot, so they run a *risk-limiting audit* (RLA). They draw ballots at random from a fixed list, read them by hand, and stop once the evidence supports the reported outcome at a stated risk limit. If it never does, they escalate to a full hand count.

Agent-written code now merges with no recorded human review, at scale. Precisely: no human approval or change request on the PR. A human usually still pressed merge:
- On public GitHub, GitHub's search classifies **130,401 of the 138,064** PRs that Copilot's coding agent merged in Q3 2026 as not reviewed (qualifier `review:none`). For the `claude` app the figure is 30,657 of 34,645.
- That qualifier is coarse, so pr-rla does not use it. In github/gh-aw I read every review of all 2,949 merged Copilot PRs through GraphQL. 2,309 of its 2,311 `review:none` PRs do carry reviews, mostly bot comments, and 209 even carry a human approval or change request. Counted by review state instead, **2,720 of the 2,949 (92%) merged with no approval or change request from a human that counts** (an approval counts only if a non-bot account other than the author submitted it at or before the merge; see the note under the stratum definition below). The reviews they did get came from bots: Copilot's reviewer commented on almost every PR, and `github-actions` approved 1,010 of them.
- **Who pressed merge.** A second reviewer reran the count and found that all 2,719 (2,720 under the corrected rule) were merged by a `User` account (pelikhan 2,671, 2,672 under it, lpcox 40, mnkiefer 5, dsyme 3), none by a bot or app. I did not recount all of them; I confirmed the pattern on 50 PRs from September 2026 (50 of 50 `User`: pelikhan 49, lpcox 1). The same reviewer reports 199 of 200 sampled `review:none` Copilot PRs across GitHub were merged by a `User` too (not re-run by me). So the population is **"merged by a human, with no recorded human review"**, and the truly unattended stratum (bot or auto-merge) was about 1 PR in 200 there, far below the 150-per-window floor. pr-rla does not claim otherwise: it audits whether the review behind a human's merge click would have found a defect. For a SOC 2 buyer this matters: a named non-author made the merge decision, and whether an auditor counts that click as approval is the auditor's call (unverified).
- Meta lands hundreds of thousands of diffs through automated review.
- GitHub lets Copilot's approval count toward required reviews, and tools such as opendrs auto-approve "low-risk" PRs.

`pr-rla` is a CLI, a GitHub Action and a Claude Code skill. It audits that population:
1. It freezes the list of merged agent PRs for a window.
2. It draws a publicly seeded random sample that anyone can re-derive (`pr-rla verify`).
3. It opens one deep-review issue per draw, with pass/fail labels.
4. It runs a sequential test.

It then certifies one of two claims, says exactly how many more reviews are needed, or tells you to review everything:
- *"Deep review under protocol P would flag ≤ 10% of Q3's agent PRs that merged with no recorded human review, risk 5%."* This is the default and needs no assumptions.
- *"The true defect rate is ≤ 10%, risk 5%."* This needs measured reviewer recall.

**What a certificate is for.** Claim D is about the whole frozen population, not the sampled PRs. In the demo below, 36 passing deep reviews bound the share of *all 1,590* PRs in the stratum that a deep review would flag. A team uses it as a gate on its own policy:
- While each window certifies, the agent's no-recorded-review lane stays open for that stratum. What is audited is the depth of review behind a human's merge click, not a missing merge decision.
- On ESCALATE the lane closes: the Action posts the verdict on the audit issue and its run fails. pr-rla never changes branch protection itself; the team's policy turns human review back on for that agent.
- The same record (manifest hash, beacon round, draws, labels, protocol hash) is the sampled evidence a SOC 2 auditor already works with (see Demand).

**Who runs it, measured.** The audit saves work only above roughly 150 merged agent PRs per window. To find who is above that line, I sampled 14,000 of the 130,388 `review:none` Copilot-agent PRs merged in Q3. I took the first 1,000 search results for each of the 13 weeks. That is not a random sample, so a busy repo could be missed, and the counts below are a floor. The 14,000 came from 6,580 distinct repos, and 4,505 of those appear only once: a long tail. For the 60 repos with 15 or more sampled PRs, I then fetched exact counts.
- **25 public repos are at or above 150** `review:none` PRs in Q3.
- **7 of the 25 are organisation-owned, and 6 of those 7 belong to GitHub itself:** github/gh-aw 2,311 (by review state, 2,720 of 2,949 had no recorded human review); githubnext/gh-cao 1,541; githubnext/gh-aw-workshop 941; github/gh-aw-firewall 380; github/gh-aw-mcpg 302; githubnext/gh-aw-wizard 182. The seventh is AceDataCloud/Clis, with 212.
- **18 are personal repos**, for example xadupre/onnx-light (788), makr-code/ThemisDB (744) and nalfeo/Crawler (622). They are users of a free tool, not buyers.
- **Pooled by organisation, more owners cross the line.** navikt (Nav IT, Norway's labour and welfare administration) has 163 of 186 merged Copilot PRs `review:none` across its public repos. microsoft has 323 of 1,302, and AceDataCloud 354. No single navikt repo reaches the floor: the 163 are spread over 41 repos, and the largest (navikt/pdfgenrs) has 95. So pooling needs a multi-repo freeze. That moves from "leaves out" into v0.2.
- Repos that review almost everything do not need pr-rla: microsoft/vscode has 6 of 177 `review:none`, dotnet/runtime 2 of 239.
- **The rate moves.** gh-aw merged 2,949 Copilot PRs in Q3, about 227 a week, but 523 from 1 October to 2 November, about 111 a week; all 523 were merged by a `User`. Its ≤ 200-line stratum with no recorded human review held 161 PRs in the 28 days to 2 November, about 40 a week, against about 122 a week in Q3 (GraphQL, every review read, 11-02). githubnext/gh-cao fell from 1,435 merged Copilot PRs in September to 189 in October. So the 150-PR floor is checked for each window when it is registered, never assumed from last quarter.

The honest reading: the *public* buyers I can name are few, and most are GitHub's own experiments. Private org repos, where paying teams would be, are invisible to search. That is why the paid path is uncertain.

The founder does not need such a repo to use it. `freeze` only *reads* the audited repo, and the draws and labels live in an audit repo the founder owns. So a real audit of a public population is possible with no permissions. Two audits of gh-aw are planned. A **retrospective** audit of its Q3 PRs is the demo; it is labelled a demonstration, because its window had closed before it was registered. A **pre-registered** audit of its next six weeks is the launch artifact and the evidence for auditors (see the validation gate).

**Where the analogy breaks, and the fix.**
- **(a) No reported tally.** A comparison audit checks a machine count, and code has none. The right port is the **ballot-polling** audit, which assesses the outcome directly: BRAVO (Lindeman, Stark & Yates, EVT/WOTE 2012, https://www.usenix.org/conference/evtwote12/workshop-program/presentation/lindeman), Wald's sequential probability ratio test (SPRT) over draws with replacement.
- **(b) A ballot is ground truth; a review verdict is not.** Reviewers miss bugs. If they catch a fraction *r* of real defects, the observed fail rate is *d = r·p*. So pr-rla keeps two claims apart:
  - **Claim D (default):** the detected-defect rate *d* ≤ p0. Valid with no assumption about *r*.
  - **Claim T:** the true rate *p* ≤ p0. Needs a lower bound on *r* from planted bugs. Without one, pr-rla prints at most `CONDITIONAL (assumed recall r)`, never `CERTIFIED`.
- **(c) No ballot manifest unless you build one.** RLAs draw from a list fixed *before* the seed is known. `freeze` therefore commits the population before the seed exists. The *selector* (which PRs count) must be fixed before the seed too, or an auditor could try several strata against known randomness and keep the kindest. So the seed round is derived from the registration time as well as the window close (Day 1 below).
- **(d) PRs are not alike.** That does not break validity, because the guarantee comes from the random draw. It only costs efficiency. Per-agent claims need separate audits; the MVP reports strata descriptively.
- **(e) Small populations.** Sample size barely depends on N, so below about 150 PRs per window `status` says "review everything".
- **(f) The draw order is the audit.** Only the fully labelled *prefix* of draws counts. Otherwise reviewers could label the easy draws first.
- **(g) Ballot-interpretation rules are fixed before the count; review standards are not.** Claim D is only meaningful if "deep review" means the same thing for every draw. The review protocol (`review-protocol.md`: the checklist, and what counts as a fail) is hashed into the commitment comment. Every verdict then reads "per protocol 3f2a…", and changing the protocol mid-audit is detectable.

**The stopping rule, exactly.**
- **Hypotheses.** H0: rate ≥ p0. Planning alternative p1 (default p0/5).
- **Scoring.** A pass adds ln((1−p1)/(1−p0)) and a fail adds ln(p1/p0). Certify when the sum reaches ln(1/α).
- **Cap and duplicates.** Escalate at the cap (4 × the zero-failure stopping point). A PR drawn twice reuses its verdict.
- **Claim D:** α = 5% on the detected rate.
- **Claim T:** calibration of *k* planted bugs, *x* caught by the same reviewers.
  1. Compute r_lo, the one-sided 97.5% Clopper–Pearson lower bound on recall.
  2. Test r_lo·p0 against r_lo·p1 at α_test = 2.5%.
  3. Why it is valid: if r ≥ r_lo (which fails with probability ≤ 2.5%), then p ≥ p0 implies d ≥ r_lo·p0. The union bound keeps total risk ≤ 5%.
  4. Assumption printed with every verdict: planted bugs are as hard to find as real ones. That cannot be verified, and planted bugs are usually easier, so r_lo errs optimistic.

| Setting | Certify after this many draws with 0 / 1 / 2 failures |
|---|---|
| Claim D, p0 = 10%, p1 = 2%, α = 5% (default) | 36 / 56 / 75 (each pass adds 0.0852, each fail −1.609, target 2.996) |
| Claim D, p0 = 5%, p1 = 1% | 73 / 113 / 153 |
| Claim T, 20/20 planted bugs caught (r_lo = 0.832) | 53 / 77 / 101 |
| Claim T, 30/30 caught (r_lo = 0.884) | 50 / 72 / 95 |
| Claim T, 19/20 caught (r_lo = 0.751) | 59 / 86 / 112 |

Trade-off, stated plainly. A fixed zero-failure attribute plan certifies after 29 draws (0.9²⁹ = 4.7% ≤ 5%), but it must escalate at the first failure. Pre-committed plans allowing one or two failures need 46 or 61 draws. The sequential default pays 7 extra draws to absorb failures without pre-committing. Fixed plans, which auditors already know, are a v1.1 option (`plan: fixed`).

**Simulation check** (my script; N = 400 PRs; 20,000 audits per row for claim D and 10,000 for claim T):

| True defect rate | Claim D certified (recall 1.0) | Claim T certified (20 planted, true recall 0.8) |
|---|---|---|
| 1% | 99.86% (mean 42 distinct PRs reviewed) | 98.4% (mean 96 + 20 planted) |
| 2% | 96.5% (51) | 83.8% (113 + 20) |
| 5% | 48.4% (62) | 16.9% |
| **10% (exactly at tolerance)** | **4.53%** (risk limit holds) | **0.36%** |

A naive design that assumes recall 1.0 fails badly when that is wrong. At a true 10% defect rate it certified 4.3% / 7.8% / 21.3% / 49.3% of audits when true recall was 1.0 / 0.9 / 0.7 / 0.5. The claim-T procedure stays at ≤ 0.71% across that range, at about 2.5–3× the reviews of claim D.

**Verified non-existence.** The missing piece is *a sampling-plus-sequential-statistics audit of merged agent PRs that turns human deep reviews into a bounded defect-rate claim.* Short GitHub queries, with the top results inspected:
- `risk-limiting audit` (45 on 10-29; 46 on 11-02, the newest being nealmcb/corla-observer, nealmcb/audit_cvrs and JohnLCaron/rlauxe): election tools only.
- `code review sampling` (709), `pull request sampling` (251), `sample pull requests` (321), `audit sampling` (1,031), `acceptance sampling` (224): top hits unrelated.
- `sequential probability ratio test` (43) and `SPRT` (729): chess engines and statistics libraries.
- These return agent tooling, none of which samples or infers: `agent PR review sampling` (17), `spot check pull requests` (6), `audit AI pull requests` (84), `AI generated PR audit` (134), `sample merged pull requests` (28), `sequential test pull requests` (5), and `audit agent pull requests` (66 on 11-02; the newest is gomerai-oss/governance-control-system).

npm `risk-limiting audit` returns only npm-audit tooling. I found no sampling-audit skill or plugin on skills.sh, skillsmp.com, claude-plugins.dev or agentskills.io (the nearest was a "calculate-pr-risk-score" skill), or in the official plugin repos.

Closest three:

| Item | Stars | Last push | What it is / what it lacks |
|---|---|---|---|
| https://github.com/atelierfactory/agent-pr-ledger | 0 | 2026-09-07 | GitHub Action that counts agent-authored merges with and without a human review record (from a study of 33,596 agent PRs). No sampling, no defect-rate inference, no risk statement. Found by `agent authored pull request audit` (1 result). |
| https://github.com/error-path/opendrs | 2 | 2026-11-01 | Meta-style Diff Risk Score that auto-approves low-risk PRs. It decides what skips review and never measures what slipped through; pr-rla is the audit for that stratum. Found by `auto approve low risk pull requests` (4). |
| https://github.com/pbstark/SHANGRLA | 13 | 2026-08-28 | Python statistics for assertion-based election RLAs: the maths to port, with no PR integration. Found by `risk-limiting audit`. |

Also seen:
- votingworks/arlo (154★): production election RLA software.
- npm `@adlc/review-calibration` v1.12.0, "Measures reviewer recall via planted bugs". It samples nothing, but its output can feed claim T.
- arXiv 2305.06884, risk-limiting *financial* audits (2023): a precedent for porting RLAs outside elections, with no tool for code.

**Demand evidence.**
- **The population (GitHub search API, 2026-11-02).**
  - `is:pr is:merged author:app/copilot-swe-agent merged:2026-07-01..2026-09-30` → 138,064; adding `review:none` → 130,401 (94%).
  - The same for `author:app/claude` → 34,645 and 30,657.
  - **What that number is and is not.** GitHub's docs define `review:none` as "matches pull requests that have not been reviewed". In gh-aw, where I checked review by review, it does *not* mean "no review object" (2 of 2,949 had none). Nor does it equal pr-rla's selector, which is "no APPROVED or CHANGES_REQUESTED review, by a non-bot account other than the author, submitted at or before the merge": 2,311 by search against 2,720 by review state, with 2,102 in both. So 130,401 is GitHub's own classification, not the audited population. pr-rla computes its population from review states at `freeze` time and prints both counts. Counts cover what an authenticated search can see, mostly public repos.
- **Reddit, r/ExperiencedDevs** (via the archive). These show that review *capacity* is the bottleneck. They are not demand for sampling: the posters want fewer or smaller AI PRs, or more review, not a statistical bound.
  - "Started making people walk me through their AI PRs in person. The 500-line diffs disappeared overnight": **1,902 points, 143 comments** (2026-01-15, https://reddit.com/comments/1qdgghz).
  - "Today I announced that I won't be reviewing AI generated PRs at company meeting": **1,560 points, 406 comments** (2026-05-27, https://reddit.com/comments/1towli9).
  - "Reviewing someone else's AI slop": 316 points, 227 comments (https://reddit.com/comments/1nfpb14).
- **Meta, "Automating Low-Risk Code Review at Meta: RADAR…"** (https://arxiv.org/abs/2605.30208):
  - "RADAR has reviewed 535K+ diffs and landed 331K+".
  - Agentic AI is "responsible for over 80%" of diff-volume growth.
  - Meta checks safety with fleet telemetry (revert rate 1/3 of non-RADAR diffs). A small team has no such denominator; a sample of about 40 reviews gives it a bound.
- **GitHub changelog, 2026-09-01** (https://github.blog/changelog/2026-09-01-copilot-code-review-can-now-approve-pull-requests): Copilot "can submit an approval that counts toward the repository's required-approvals rule".
- **Sonar *State of Code* survey** (1,100+ developers; https://www.sonarsource.com/blog/state-of-code-developer-survey-report-the-current-reality-of-ai-coding/): 96% do not fully trust AI-generated code, yet only 48% always verify it before committing.
- **HN, "Verification debt: the hidden cost of AI-generated code":** 115 points, 96 comments (https://news.ycombinator.com/item?id=47289406).
- **Auditors already work this way.** Linford & Co (https://linfordco.com/blog/audit-sampling/) says SOC auditors use sampling tables that "align with the guidance set forth in the audit sampling guide from the AICPA". Its example tests a population of 389 with an initial sample of 25, expandable to 40 or 60 on deviations. That is the same shape as pr-rla's escalation.
- **The buyer: SOC 2-audited teams whose change control now has agent merges in it.**
  - What the auditor checks, per sampled change: "Reviewer differs from author; approval precedes merge". The sample "starts at 25, and a deviation extends it to 40, then 60" (soc2auditors.org, "SOC 2 Change Management Controls: What Auditors Trace", updated 2026-10-30, https://soc2auditors.org/insights/soc-2-change-management-controls/). So an agent PR merged with no recorded human approval is a deviation if the auditor treats a bare merge click as no approval (auditor-dependent; unverified).
  - Teams are asking how to pass that control. The Vanta community thread "AI-Only Code Reviews and SOC 2 Change Management: Experiences and Compliance Insights Requested" (2026-06-03, 13 comments, https://community.vanta.com/x/grc/nwnr9uwkwu1y/ai-only-code-reviews-and-soc-2-change-management-e) asks "Have you successfully cleared a SOC 2 Type I/II audit with this setup?". In it, a commenter relays feedback from their A-LIGN auditor: "Most clients keep a human at the approval/push-to-prod step, especially for higher-risk changes". Citing ISO 42001, the same comment adds "Human-in-the-loop is tiered by risk — high: human approves before the action; medium: human monitors and intervenes as needed; low: minimal/periodic human involvement". pr-rla is a *periodic, measured* human control for that low tier, not a replacement for pre-merge review of high-risk changes.
  - Auditors accept controls that fit the process. Amp, an agent company with 11–50 staff, passed SOC 2 Type II without required pull requests: "Ours didn't ask us for pull requests; they asked what our change process was, and worked with us on a set of controls that fit it" (https://ampcode.com/notes/thats-not-soc-2-compliant, 2026-08-13). Its controls are signed commits, CI and agent-thread links. None of them is an after-the-fact human review.
- **What this does not show.** Nobody asks for sequential sampling of agent PRs by name. No auditor has yet accepted a pr-rla certificate, because none exists. The public organisations above the floor are few, and six of the seven are GitHub's own ("Who runs it"). Private SOC 2-audited repos, where the buyer is, are invisible to search. So the paid path stays uncertain. The gate before any paid tier is in the MVP plan below.

**MVP scope and estimate (3 days; a shippable v0.1 at the end of day 2).** The critical path is days 1–2: freeze, commit, draw, verify and the sequential test, for claim D only. That alone is a usable tool, because any third party can recompute the draws and the verdict. Day 3 adds the adoption pieces, and nothing in v0.1 depends on them, so a slip on days 1–2 costs the Action and the skill, not the ship. The scoring code is a port of a ~100-line simulation script written while designing it, which is why day 2 fits.
- **Day 1: `init`, `freeze`, the commitment and `sample`.**
  - `.pr-rla.yml` holds:
    - the selector: author bots such as `copilot-swe-agent[bot]` or `claude[bot]`; labels; `unreviewed: no-human-review` (the default: no APPROVED or CHANGES_REQUESTED review by a non-bot account other than the author, submitted at or before the merge) or `no-review` (no review object at all); a `merged_by` stratum read from GraphQL `mergedBy` (`human` or `bot`, default `any`), so a team can audit the unattended lane separately; an optional size stratum `max_changed_lines`; and `exclude_generated: true`, which drops files marked `linguist-generated` in `.gitattributes` from the review scope (the stratum itself is measured on GitHub's raw additions + deletions, so anyone can recompute it);
    - window, α, p0, p1 and cap;
    - `protocol: review-protocol.md`;
    - `audit_repo` (issues and labels only; see below);
    - an optional `calibration:` block (used from v0.2).
  - `freeze` lists merged PRs through the REST pulls endpoint (paginated, filtered by `merged_at`). That avoids the search API's 1,000-result cap and index lag. It reads review states through GraphQL, 40 PRs per query: at 100 per query the API returned HTTP 502 when I ran the gh-aw count.
  - It writes `audit/<window>.manifest.json`: sorted `[PR, merge SHA]` pairs plus parameters.
  - **Registration (`pr-rla register`).** It signs `{repo, window, selector, size stratum, protocol hash, p0, p1, α}` and records it in the public Sigstore Rekor transparency log. A log entry cannot be edited or removed by the audited repo's owner, and Rekor supplies `integratedTime` and an inclusion proof. Registered before the window opens, the audit is **prospective**; registered after the window has closed, it is **retrospective**. I have not built or run this. The Rekor client call is unverified, and day 1 starts with a 2-hour spike. If the spike fails, v0.1 ships with a GitHub comment and `verify` prints `TIMESTAMP NOT TAMPER-PROOF`.
  - **`freeze` records the manifest hash the same way, after the window closes and before the seed exists.** The manifest holds each PR's merge SHA, review states, merger and size as of freeze time. Its SHA-256 and N go into a second log entry.
  - **The seed round is derived, not chosen.** R is the first drand quicknet round that publishes at least 24 h after the *later* of two times: the window close and the registration's `integratedTime` (rounds publish at 1692803367 + 3·(R−1) s). In a prospective audit that is 24 h after the window closes; in a retrospective one, 24 h after the registration. Either way the selector is in the log before the randomness exists. The manifest entry must be logged before R publishes. The team cannot re-roll by naming a different round, and cannot test strata against known draws.
  - **`audit_repo`** (default: the same repo) holds the draw issues and labels. It is not a trust anchor; the commitments live in the log.
  - `sample` waits for round R and verifies its BLS signature with npm `drand-client` v1.4.2 (a library call, not home-made cryptography). It draws index *i* = SHA-256(randomness ‖ manifest-hash ‖ i) mod N and opens issues **in draw order**, in batches.
- **Day 2: `status`, `verify` and the tests. End of day 2 = v0.1, tagged and published to npm.**
  - `status` reads first-label events of the frozen draws only. It counts the **longest fully labelled prefix** and names any blocking draw. It prints the claim, the log-likelihood ratio (LLR) against its target, and CERTIFIED / "n more passing draws needed" / ESCALATE, with every assumption.
  - `verify` lets any third party check seven things:
    1. A registration entry exists. If its `integratedTime` precedes the window opening, the audit is `PROSPECTIVE`. Otherwise it is `RETROSPECTIVE`: the stratum was chosen after the population was visible, though before the randomness existed, so the certificate is a demonstration, not evidence.
    2. The manifest entry was logged before round R published.
    3. R is the derived round, recomputed from the window close and the registration time.
    4. R's BLS signature.
    5. **The population, rebuilt from GitHub with the registered selector and diffed against the manifest.** Any PR missing from or extra in the manifest is a FAIL, except a review that GitHub's timeline dates after freeze time, which `verify` lists.
    6. Every draw, recomputed.
    7. The label events of the counted prefix.

    So pruning the manifest fails check 5, re-rolling fails check 3, and a manifest written after the seed was public fails check 2.
  - **What it still does not stop.** A team can register several differently-parameterised audits, under one identity or several, and publish the best. `verify` cannot prove that no other registration exists: Rekor's search-by-signer endpoint (`/api/v1/index/retrieve`) is marked deprecated and "EXPERIMENTAL", and "The results returned from this endpoint may be incomplete" (Rekor `openapi.yaml`). The control is procedural. The team hands its auditor the registration's log ID before the window opens, and the auditor accepts only that audit. A retrospective audit has no such defence, which is why it is labelled a demonstration. Review labels sit in the audit repo, so `verify` also reads their event history; a label removed and reapplied shows up there.
  - Tests: the 36/56/75 stopping table; false-certify ≤ α at the tolerance boundary over 20,000 simulated audits; a recorded drand round as a fixture, so the BLS check runs offline; and three tamper fixtures, which `verify` must fail: a manifest with 80 known-bad PRs removed, a commitment naming a different round, and a manifest logged after R.
- **Day 3: adoption.**
  - A composite **GitHub Action** reruns `status` on `issues: labeled`.
  - A **`review-draw` Claude Code skill** (one SKILL.md plus `pr-rla draw-context <n>`) shows the reviewer the draw's diff (generated files excluded), CI results and protocol checklist. The human applies the label; the skill never labels.
  - `simulate --population --defects` runs the same scoring code against an oracle.
- **v0.2 (about 3 more days, after the first ship):** claim T (a calibration file of planted bugs, from hand-planting or `@adlc/review-calibration`; Clopper–Pearson); `simulate --true-recall --assume-recall --calibration --adversary skip-fails`; `status --what-if`; multi-repo (org-pooled) `freeze`.
- **Leaves out:**
  - canary planting;
  - `--check-label-history`;
  - fixed attribute plans;
  - sampling without replacement (ALPHA, https://arxiv.org/abs/2201.02707) and stratified audits;
  - dashboards, GitLab and Bitbucket;
  - multi-repo (org-pooled) freeze, which is the first v0.2 item after claim T, because org pooling is where the buyers above appear.
- **Validation gate before any paid tier.** The evidence is a *prospective* audit, and that takes a window to close, so the gate runs over about 7 weeks.
  1. **At v0.1 (end of day 2), register the prospective audit:** gh-aw, the same stratum (no recorded human review, ≤ 200 changed lines), for the 42 days after registration. At the last 28 days' rate (161 PRs, about 40 a week) it should hold about 240 PRs. The lowest four-week count since September was 155, which scales to about 230. If it closes below 150, `status` says "review all N", and that result is what gets published.
  2. **In the week after v0.1, publish the launch post:** the retrospective Q3 audit (the demo below, labelled a demonstration) and the prospective audit's log ID, so anyone can watch it close. Show both to 5 SOC 2-audited teams that let agents merge without a human approval (found through the Vanta thread above and the teams that answer the post), and to 2 auditors. That is about 2 days of outreach.
  3. **About 7 weeks after day 1, the prospective certificate exists:** 42 days of window, 24 h for round R, then about 9 hours of review. That certificate, not the demonstration, is what the auditors are asked about.
  4. **Go** for the evidence pack if at least 2 teams say they would put a prospective certificate in front of their auditor, and at least 1 auditor says it could support a risk-tiered change control.
  5. **Kill** the paid tiers otherwise. pr-rla then stays a free tool and portfolio piece, and paid effort moves elsewhere. That costs nothing already built, because v0.1 is complete on its own.

**Monetisation.**
- **Hosted canary planting ("recall as a service").** Realistic planted bugs that cannot be told apart from real review issues make claim T cheap.
- **Org dashboard:** certification history and defect rate per agent, model and stratum.
- **"Audit the auto-approver":** per-stratum audits of PRs approved by risk scores, by Copilot or by a workflow bot. The stratum exists: in gh-aw, a bot approved 1,010 of the 2,949 merged Copilot PRs, and 986 of those had no human approval or change request.
- **Team tier: org-pooled audits** across many small repos (the navikt case above), with one certificate per org and window.
- **Evidence pack (the most direct paid path):** fixed attribute plans in the 25/40/60 form auditors already use, plus the reproducible draw record for each window. It sells to the SOC 2 buyer above. It is still a hypothesis that an auditor would accept it, which is what the validation gate tests.

**Demo (< 5 min), on a real population.** The audited population is real, not a fixture: github/gh-aw's Copilot PRs merged in Q3 2026 with no human approval or change request and **≤ 200 changed lines**. That is 1,590 PRs (measured 11-02 from the review states above). `freeze` only reads gh-aw; the commitment, draws and labels live in the founder's audit repo. This audit is **retrospective**: Q3 closed on 2026-09-30, and the size stratum was chosen after measuring the population. It shows the mechanism on real PRs and says so in every output; the prospective audit in the validation gate is the evidence.
- **Before the demo (about 3 days after v0.1, most of it waiting).** `register` the stratum, `freeze`, wait the 24 h until round R publishes, `sample` the 36 draws (claim D's zero-failure stopping point), and deep-review them under the protocol. The stratum's median PR is 53 changed lines. At an assumed 400 changed lines an hour plus 5 minutes a PR (my assumption, not a measured rate), the 36 reviews take about 9 hours (p90 10, by resampling the real sizes). The size stratum is what makes this affordable: across all 2,719 PRs the mean is 941 lines and 8.8% exceed 2,000, so the same 36 reviews would take about 40 hours. The certificate names the stratum, so it claims nothing about larger PRs.
- **The verdict is not known in advance.** The script below works for every outcome.

0. **The population (20 s).** `pr-rla freeze --dry-run` prints `2,949 merged · 2,720 no recorded human review (merged by: 2,720 human accounts, 0 bot) · 1,590 ≤ 200 changed lines` next to GitHub's own `review:none` figure (2,311), so the audience sees why the tool computes its own population.
1. **Tamper evidence (1.5 min).** `pr-rla verify` fetches round R, checks the BLS signature, rebuilds the population from GitHub and prints every check:
   `registration after window close → RETROSPECTIVE (a demonstration) · manifest logged before R ✓ · R = first round ≥ 24 h after registration ✓ · BLS ✓ · population 1,590/1,590 match ✓ · 36/36 draws reproduce ✓ · labels ✓`.
   Then three attacks on the record, all fixtures, not claims about the gh-aw team: a manifest with 80 PRs removed prints `FAIL population: 80 PRs on GitHub are missing from the manifest`; a commitment naming another round prints `FAIL seed round 33,720,000 ≠ derived round 33,721,012`; and a manifest logged after R prints `FAIL manifest logged after the seed was public`. The Rekor steps are unverified; see Day 1.
2. **The last draw, live (1.5 min).** The `review-draw` skill shows draw #36's diff, its CI results and the protocol checklist. The presenter applies the label, and the Action posts the status. There are three possible results, and all three are correct behaviour:
   - all 36 pass: `prefix 36/36 · fails 0 · claim D (detected-defect rate ≤ 10%, protocol 3f2a…, stratum ≤ 200 lines) · LLR 3.066 / target 2.996 · CERTIFIED (risk 5%) · RETROSPECTIVE`;
   - one fails: `fails 1 · NOT CERTIFIED · 20 more passing draws needed (56 total)`, and the failing draw is a real defect that merged with no recorded human review, which is the stronger demo;
   - failures exceed what the cap can absorb: `ESCALATE: review all 1,590 or narrow the claim`.
3. **Refusal (15 s).** On a 12-PR repo, `population 12 < 150: review all 12 instead`.
4. **The risk limit holds (1 min).** `pr-rla simulate --population 1590 --defects 159` (a true rate of exactly 10%) certifies 4.8% of 20,000 simulated audits, inside the 5% limit. With `--defects 16` (1%) it certifies 99.8%, after 44 distinct reviews on average.
5. **The audit that counts (15 s).** `pr-rla status` on the prospective registration: `PROSPECTIVE · window open, day 12 of 42 · N so far 61 · seed round not yet published`.

A synthetic 200-PR audit repo serves only as the CI test bed. What the real demo certifies is detection *by an outside reviewer under protocol P*. An outsider catches less than a gh-aw maintainer would, and claim D says exactly that, no more. The demo's value is the mechanism, shown on real PRs that merged with no recorded human review: a buyer sees sampled, reproducible evidence of the kind their auditor already works with, produced in 36 reviews instead of 1,590.
