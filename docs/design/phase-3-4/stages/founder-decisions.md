# All Remaining Questions: pr-rla phases 3–4 design review

This file holds every open decision for the rest of the design, so you answer once. Later stages read these answers and do not ask again. Where you leave nothing to decide, I decide, write the choice into the stage's document, and you can correct it at that stage's approval.

**The quickest way through:**

1. Answer Part 1 (Q1–Q3). Only you know these.
2. Answer Q4 with `A` to accept every recommended answer in Part 3 and Part 4.
3. Then answer only the questions where you want something other than the recommendation. A question you answer yourself overrides Q4.

The draft is `pr-rla/docs/design/phase-3-4/`; section references below point into it.

---

## Part 1: only you know these

## Q1. [Product owner] Which SCM accounts and plans will pr-rla be run with?

Context: The SCM API budgets depend on plan and token type, and the draft's rate-limit fallbacks (`06` §3) assume the smallest ones. For example, Bitbucket Cloud allows 1,000 requests an hour, more only on paid workspaces with 100 or more users, and GitHub's `GITHUB_TOKEN` allows 1,000 an hour per repo against a personal token's 5,000.

A. Free and public tiers only: design to the smallest budgets
B. Some paid tiers (say which in your answer)
C. Not known yet: design to the smallest budgets and make the limits configurable
X. Other (please specify)

[Answer]: C. Not known yet: design to the smallest free-tier budgets and make every limit configurable, so a paid plan only raises a setting.

## Q2. [Product owner] Which AI assistants can you run the manual checks in?

Context: The draft (`04` §U5, `07` §3) assumes you check the MCP server and plugin by hand in Claude Code, Codex and Cursor. A client you cannot run gets configuration that is tested by unit tests only and marked unverified.

A. Claude Code, Codex and Cursor
B. Claude Code only
C. Claude Code and one other (say which)
X. Other (please specify)

[Answer]: A. Claude Code, Codex and Cursor. The founder will hand-check all three.

## Q3. [Product owner] What GitHub owner should the design use for the plugin marketplace and the Action?

Context: The draft writes `<owner>/pr-rla` and `uses: <owner>/pr-rla/…@<sha>` (`05` §U6, §U7). Nothing is created or claimed during this design. A placeholder is fine.

A. Keep the placeholder `<owner>` until release
B. Use this owner (say which)
X. Other (please specify)

[Answer]: A. Keep the placeholder `<owner>` until release.

---

## Part 2: the shortcut

## Q4. [Product owner] Accept every recommended answer in Parts 3 and 4?

Context: Every question below has a recommendation as option A, with the reason. Accepting means you answer only the ones you want different.

A. Yes: accept every recommendation, except where I answer a question myself
B. No: I'll answer every question
X. Other (please specify)

[Answer]: A. Accept every recommendation, except Q8 and Q24, which are answered below.

---

## Part 3: how the rest of the workflow runs

## Q5. [Product owner] Skip the five stages that don't fit pr-rla?

Context: Rough Mockups and Refined Mockups design screens, and pr-rla has none. Infrastructure Design covers hosted infrastructure, which the draft says does not apply (`06`). Practices Discovery records coding conventions for Code Generation, which this work never reaches. User Stories turns requirements into stories, and the draft works from requirements and units instead. Skipping leaves eight stages that match the draft's files: Requirements, Domain Design, Units, Contract Design, Delivery Planning, Functional Design, NFR Requirements and NFR Design.

A. Skip all five (recommended: they add stops without adding to this design)
B. Keep them all
C. Skip some (say which)
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q6. [Product owner] Turn off the "keep these notes for next time?" question at each stage?

Context: It asks after every stage whether my working notes should become standing rules for this project. Turning it off removes one stop per stage, and the notes stay in each stage's record either way.

A. Turn it off for this piece of work (recommended: one fewer stop per stage)
B. Keep asking
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

---

## Part 4: design decisions

### Requirements

## Q7. [Architect] What happens when no timestamp authority is configured?

Context: The vision asked for a fallback. The draft decided there is none (`05` §U1): the output says `TIMESTAMP NOT TAMPER-PROOF`, and it never falls back to git dates, SCM push times or Bitcoin time.

A. No fallback, warning only (recommended: every fallback named is a time the audited team can influence, so it would look tamper-proof without being so)
B. Fall back to SCM push times where the SCM records them, labelled as weaker evidence
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q8. [Architect] Write the RFC 3161 token parser by hand, or use a library?

Context: The draft writes a DER walker of about 250 lines over `node:crypto`, with no dependency (`05` §U1, `01` NFR-P1).

A. Hand-written, no dependency (recommended: minimal dependencies; the six tamper fixtures and recorded tokens from every authority test it)
B. A maintained ASN.1/CMS library, adding dependencies but less code of our own
X. Other (please specify)

[Answer]: B. Use a maintained ASN.1/CMS library (for example PeculiarVentures `pkijs` + `asn1js`, if it handles RFC 3161 TimeStampResp and CMS SignedData verification), not a hand-written DER walker. This is the tamper-proofing core, and the rule "don't write your own crypto parsing" outweighs keeping dependencies minimal here. Keep the six tamper fixtures and the recorded tokens from every authority as the tests. If the evaluation finds no suitable maintained library, fall back to A and record why.

## Q9. [Architect] Do the draft's auth scopes stand?

Context: The draft (`01` NFR-S1, `05` §U4, §U7) uses: GitHub, a fine-grained personal token with Issues write on the audit repo only, and Issues read for `verify`, with the Action's `permissions: { contents: read, issues: write }`; GitLab, `api` to write and `read_api` to verify, with a project access token (Premium) or a personal token (Free) in CI; Bitbucket, `read:repository:bitbucket` and `read:pullrequest:bitbucket`. None was exercised on a private repo (risk RK-08).

A. Accept them, marked unverified until each is exercised read-only or on a mock server (recommended)
B. I'll give the scopes I use (say which)
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q10. [Architect] May the build fetch live tokens from all eight bundled timestamp authorities, or only the four defaults?

Context: D2 allows live fetches with hashes only. The draft fetches from all eight (`04` §U1, `07` §2), including the four that are off by default: GitHub, SwissSign, Sectigo and FreeTSA.

A. All eight, hashes only (recommended: every bundled authority then has a recorded, verified token, and nothing permanent is sent)
B. Only the four defaults
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

### Design and packaging

## Q11. [Architect] Ship the MCP server as its own package?

Context: The draft ships `pr-rla-mcp`, built on `@modelcontextprotocol/server` 2.x and `zod` 4, pinned to an exact `pr-rla` version (`03` §1, `06` §5).

A. Yes, a separate package (recommended: the core keeps its minimal dependencies)
B. Inside `pr-rla`, as a `pr-rla mcp` command
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q12. [Architect] Does the draft's MCP tool set stand?

Context: Eight tools, all read-only: `audit_list`, `status`, `draws`, `draw_context`, `verify`, `simulate`, `freeze_preview` and `job_status` (`05` §U5). The vision's `sample` maps to `draws`. Issuing draws stays CLI-only, and `offline` defaults to true.

A. Yes (recommended: nothing an assistant can call changes the audit)
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q13. [Architect] How is the plugin lock first created?

Context: The draft creates `pr-rla.lock.json` at `plugin add`, or implicitly at the first `register`, trusting whatever is installed at that moment; the lock is committed and not signed (`03` §4, `05` §U2b).

A. Only by an explicit `plugin add`, which prints the source and integrity it is trusting (recommended: the trust decision becomes a visible act, not a side effect of `register`)
B. As the draft has it
C. Also sign the lock with the audit key
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q14. [Architect] Does the draft's plugin isolation policy stand?

Context: External plugins run in an isolated child process by default; `trust: full` is a per-plugin opt-in; install hygiene (for example install scripts) is documented but not enforced; pr-rla ships no sandbox (`05` §U2b). On Node 22/24 a malicious plugin can still send repo data out (risk RK-02).

A. Keep it, and say the limits plainly in the security model (recommended)
B. Also refuse plugins that run install scripts
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q15. [Architect] May one org-pooled audit mix SCM providers?

Context: The draft allows one provider per pooled registration (`05` §U8). Its "out of scope for v0.2" label is stale now that U8 is built in this round.

A. One provider per pooled registration (recommended: review counts mean different things across providers, as the draft's `02` Q5 found)
B. Allow mixed providers
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q16. [Architect] Do the draft's org-freeze defaults stand?

Context: Archived repos and forks are excluded, every visibility the token can see is included, 4 repos are frozen in parallel, and there is no `--skip-repo` (`05` §U8).

A. Yes (recommended: a skip option would let a team leave a repo out of the population)
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

### Contracts and versioning

## Q17. [Architect] How are the releases numbered?

Context: The draft numbers phase 3 as 0.2.x and phase 4 as 0.3.x (`06` §5), but the vision times the gh-aw certificate from "v0.1", and everything is now built before the first public release.

A. The first public release is v0.1.0 and contains all eleven units; the gh-aw clock starts there. Below 1.0, a CLI or output change is a minor version, and a new provider API version keeps a two-release overlap (recommended)
B. Keep the draft's 0.2.x and 0.3.x
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q18. [Architect] Add the new public SDK fields within provider API version 1?

Context: `head` and `headSha`, `PluginIdentity`, `reviewGranularity` and `Actor.id` are all optional additions (`02` Q2, Q3, Q5, Q6). They change a public contract, though nothing existing breaks.

A. Yes, as optional additions within version 1 (recommended)
B. Bump to provider API version 2
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

### Functional design

## Q19. [Architect] What happens to the Rekor v2 client, which can never be checked against the real log in this round (D3)?

Context: The draft verified its request and response shapes against one staging entry, which D3 rules out (`05` §U1).

A. Ship it, labelled unverified against production; `--submit` says so before it writes (recommended)
B. Defer the v2 client; keep only v1 behind `--submit`
C. Leave Rekor submission out until it can be verified
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q20. [Architect] Do the draft's timing defaults stand?

Context: A 10-minute tolerance between the signed time and the authorities' times, a default accuracy of 60 seconds, and retries for up to half the tolerance (`05` §U1). They are signed into each registration.

A. Yes (recommended)
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q21. [Architect] Should the Jira example ledger use a single-select field or labels?

Context: The draft recommends a single-select custom field (`05` §U4).

A. A single-select field (recommended: it holds one verdict at a time, so its history is simpler to check)
B. Labels, to match the GitHub and GitLab ledgers
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

## Q22. [Architect] Do the draft's distribution choices stand?

Context: `npx -y pr-rla-mcp@<exact>` for the MCP server; publishing the GitLab CI/CD component to the Catalog waits for you; Bitbucket gets a documented step, not a Docker pipe; npm publishing uses trusted publishing with provenance, run by you at release (`05` §U6, §U7, §U10). Claiming the npm names is a public act left to you.

A. Yes (recommended)
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

### NFRs

## Q23. [Architect] Swap `drand-client` for `@noble/curves` (D9)?

Context: `drand-client` brings about 2.16 MB of dependencies; checking a quicknet round needs only BLS12-381, which `@noble/curves` provides (`06` §5). Your tech environment prefers "a maintained drand client".

A. Keep `drand-client` (recommended: your tech environment names a maintained drand client as preferred, and the swap is optional)
B. Swap to `@noble/curves`, checked against the recorded rounds
X. Other (please specify)

[Answer]: A (the recommendation, accepted through Q4)

### Testing

## Q24. [Product owner] When should the prospective gh-aw registration be made?

Context: It must be registered before its window opens, and the certificate comes about 7 weeks later. Registering sends only hashes to the timestamp authorities; nothing is public.

A. As soon as U1 is built, so the window is not held back by later units (recommended)
B. At the first public release
X. Other (please specify)

[Answer]: X. As soon as U1 is built (A), but the founder runs `register` personally: the build prepares the config and the exact command and stops there. Registering is the founder's decision.

---

## Already settled: I'll apply these, no answer needed

These parts of the draft conflict with your decisions of 2026-11-03, so the refined design changes them:

- `01` FR-T4: the default number of timestamp authorities that must agree becomes 2, not 1 (D1).
- `01` FR-M8: the default verdict provenance becomes `account` when an issue ledger is configured, and stays `self-asserted` with the git-file ledger. The README's "do you have a FIDO key?" goes (D7).
- `04` and `05`: the build order becomes yours (U1 → U2a → U4 → U2b → U3 → U5 → U7 → U6 → U8 → U9 → U10), and every unit is built in this round.
- `04` §U7 and `07` §3–4: no `act` runs against real repos and no scratch repos or projects; CI is tested on fixtures and mock servers (D8).
- `04` §U9 and `07` §2: presence signatures come from software keys, not a real FIDO key (D7).
- `05` §U1 and `07` §2, §4: no Rekor staging entry (D3).
- `07` §2 U4: issue-ledger data comes from read-only recordings of public timelines, synthetic data and mock servers, not a scratch audit repo (D8).
- `05` §U8: the "v0.2" labels go.
