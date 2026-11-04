# The prospective gh-aw audit: registration hand-off

**To be run by the founder personally, now that bolt 3 (U4, issue ledgers) is built.** Bolt 1 prepared the configuration and this command; bolt 3 added the `github-issues` ledger and made the configuration pass `register`'s preflight once its placeholders are filled in (`test/gh-aw-prospective.test.ts` runs that preflight on a filled-in copy, with `--dry-run`). Nothing in the build registers anything, and no registration has been made.

The audit is the launch artifact of `docs/design/spec.md` (the validation gate): the same stratum as the retrospective Q3 demonstration, registered *before* its window opens, so its certificate is evidence rather than a demonstration.

## The decision: register after bolt 3, with `github-issues`

> **Founder, 2026-11-03:** register after bolt 3 (U4) with the github-issues ledger, for account provenance.

This replaces the earlier plan (Q24 in `docs/design/phase-3-4/stages/founder-decisions.md`) of registering as soon as bolt 1 was built.

| | Register now (bolt 1, `git-file`) | Register after bolt 3 (`github-issues`) |
|---|---|---|
| Who records a verdict | Anyone who can push to the audit repo appends a line to `verdicts.jsonl`. The line names a reviewer, but nothing outside the repo attests who wrote it or when. | A reviewer applies `pr-rla:pass` or `pr-rla:fail` on the draw's issue. GitHub records the label event server-side, with the acting account and its own time. |
| Verdict provenance on the certificate | `self-asserted` | `account` |
| Who can make a verdict count | Whoever has the repo and a shell, including an assistant running with the founder's credentials. | Only registered reviewers' accounts. Label events from apps (`performed_via_github_app`), bots and unlisted accounts are ignored and reported. |
| Cost | none | The window opens later: bolts 2 and 3 come first (estimated at 1.5 and 2.5 build days in `docs/design/phase-3-4/delivery-plan.md`). |

The registration fixes the ledger and the minimum provenance, and they cannot be changed afterwards without a new registration. A certificate whose verdicts are `self-asserted` asks the auditor to trust the audit repo's own writer; one at `account` lets the auditor check, in GitHub's own history, that a named human account applied each verdict. That is the claim the validation gate needs to put in front of auditors, so the founder chose to wait for bolt 3.

## What the registration fixes

Signed into `audits/gh-aw-prospective/audit/gh-aw-prospective/registration.json` (schema `pr-rla/registration/v2`):

- `repos: {kind: "repo", repo: "github/gh-aw"}`;
- the phase-1 selector (Copilot coding-agent changes, no recorded human review, ≤ 200 changed lines, PRs and direct pushes), with `bots: []` and `direct_push_via_merge: "include"`, which behave exactly as phase 1 did;
- the default parameters (claim D, p0 10%, p1 2%, α 5%, minimum population 150);
- the SHA-256 of `review-protocol.md`;
- the four default timestamp authorities (Sigstore, DigiCert, GlobalSign, Microsoft), k = 2;
- `plugins.provider` = the built-in `github` provider at the registering pr-rla version;
- `plugins.ledger` = `github-issues` (bolt 3);
- `verdicts.minProvenance: "account"` and `verdicts.reviewers` = the founder's account;
- a window that opens after the registration's U_k (the time by which two authorities prove it existed).

## Before registering

1. **Use a build that includes bolt 3**, so the `github-issues` ledger exists. (The bolt-1 build refused this configuration with `cannot load ledger "github-issues"`.)
2. **Finalize `audits/gh-aw-prospective/review-protocol.md`.** Its hash is registered; changing it later fails check 1. It is drafted for gh-aw (2026-11-03): five failure codes with gh-aw examples, the generated-file exception, an unresolved specific concern counted as FAIL, and label rules that match the ledger's (the first label counts; never remove one). Edit it until it says what you mean; nothing hashes it before `register`.
3. **Create the audit repo** on GitHub (public, so auditors can read it), with issues enabled. `sample` opens the draw issues there and creates the labels `pr-rla:pass`, `pr-rla:fail` and `pr-rla:draw`; nothing is written before `sample`.
4. **Fill in the three remaining placeholders (marked `EDIT`) in `audits/gh-aw-prospective/.pr-rla.yml`.** Until each is replaced, `register` refuses and names it.
   - `window.start`: the UTC day after the day you register; `window.end`: start + 41 days (42 inclusive days).
   - `ledger.options.repo`: the audit repo, as `owner/name` (draw issues and labels live there; gh-aw itself is only read). Bolt 3 confirmed this option name. The founder chose a **separate** audit repo (2026-11-03), not the pr-rla product repo, for example `naren-ambati/pr-rla-audits`.
   - `verdicts.reviewers`: **filled in** as `naren-ambati` (2026-11-03). Only label events by listed accounts count; events by bots, apps and anyone else are ignored and reported.
   - **Which account runs what.** `sample` opens issues as the token's account, which may be any account with Issues: write on the audit repo. A verdict counts only if `naren-ambati` applies the label: in the web UI signed in as `naren-ambati`, or with `pr-rla record` and a `naren-ambati` token. On 2026-11-03 the `gh` CLI on the build machine was signed in as a different account, so `GITHUB_TOKEN=$(gh auth token) pr-rla record …` from there would label as that account, and the verdict would be ignored and reported.
   - `verdicts.min_provenance: account` is already set; it is also the default with an issue ledger.
5. **Check without writing anything:**

   ```sh
   pr-rla -C audits/gh-aw-prospective register --dry-run
   ```

   It must say `PROSPECTIVE`, show `ledger github-issues · verdict provenance account · reviewers <your login>`, and `timestamps: not requested (dry run) · authorities sigstore, digicert, globalsign, microsoft · k = 2`. A dry run contacts no authority and no tracker.

## The command

```sh
pr-rla -C audits/gh-aw-prospective register
```

It signs the record, sends each of the four authorities one request holding only the record's SHA-256 digest and a nonce, and writes the record with the tokens it got. A successful run ends like bolt 1's live `register` of the demo audit (`test/fixtures/audits/tsa-demo`, through `node scripts/record-tsa-fixtures.mjs`), recorded 2026-11-03 (its last two lines; BUILD-NOTES, "Bolt 1 (U1)"):

```output
  PROSPECTIVE · registration existed by 2026-11-03T22:32:28Z (U_k)
  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN
```

Since the trusted-time round, `register` also prints how each counted authority's anchor is trusted, as the replay of that recording shows, recorded 2026-11-04 (BUILD-NOTES, "Trusted-time fix round A"):

```output
  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN
    sigstore: anchor confirmed independently (root sigstore-tsa-selfsigned, independent: true)
    digicert: anchor confirmed independently (root DigiCert Trusted Root G4, independent: true) · TSA issuing CA pinned (DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1)
    globalsign: anchor confirmed independently (root GlobalSign, independent: true) · TSA issuing CA pinned (GlobalSign Offline R45 Timestamping CA 2025)
    microsoft: anchor pinned on first use (intermediate Microsoft Public RSA Timestamping CA 2020, independent: false)
```

The Microsoft line is the one trust-on-first-use anchor among the defaults; confirming it from a second source is step 5 of the [release checklist](release-checklist.md).

- **Exit 5** (`TIMESTAMP NOT TAMPER-PROOF (n of 2)`): fewer than two operators answered. Run `pr-rla -C audits/gh-aw-prospective register --force` before showing the registration to anyone. Tokens cannot be added to a written record.
- **Exit 1 with `local clock differs from timestamp authority time`**: fix the clock; nothing was written.
- Do not pass `--submit`: no Rekor entry is part of this plan (D3).

## After registering

1. Commit `audits/gh-aw-prospective/audit/gh-aw-prospective/registration.json` and push the audit repo.
2. Give the auditors the registration's SHA-256 (printed first) before the window opens. `verify` cannot prove that no other registration exists, so this hand-over is the control.
3. **Freeze with a build that includes bolt 5** (U3, the pinned history head), after the window closes and before seed round R publishes (24 h after the close), so the population is reproducible.
4. **Sample, then review.** `GITHUB_TOKEN=$(gh auth token) pr-rla -C audits/gh-aw-prospective sample` opens one issue per drawn change in the audit repo, in draw order, and writes `audit/gh-aw-prospective/ledger-index.json`; commit it with `draws.json`. The token needs Issues: write on the audit repo. Record each verdict by applying `pr-rla:pass` or `pr-rla:fail` on the draw's issue in GitHub's web UI (or `pr-rla record <draw> pass|fail`, which applies the label as the token's account). The first label a registered reviewer applies counts.

   `sample` also signs the index and has the registered authorities time-stamp it, in `audit/gh-aw-prospective/ledger-publication.json`: commit it with `draws.json` and `ledger-index.json`, and do not label an issue until `sample` has exited 0 (exit 5 means a publication short of tokens, which counts for nothing: run `sample` again).
5. **Checkpoint the verdict history** once the audit certifies: `GITHUB_TOKEN=$(gh auth token) pr-rla -C audits/gh-aw-prospective checkpoint --push`. A repo admin can delete issues; a time-stamped checkpoint committed to the audit repo makes that visible to `verify`.
6. `verify` prints the registering and freezing pr-rla versions. Any later change to the selector or population semantics needs a new registration, never a silent change. Verifying the issue ledger reads every draw issue's events, which needs a token (any token: the 60-an-hour anonymous budget is too small for 36 issues).
