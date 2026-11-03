# The prospective gh-aw audit: registration hand-off

**To be run after bolt 3 (U4, issue ledgers), by the founder personally.** Bolt 1 prepared the configuration and this command, and stopped. Nothing in the build registers anything, and no registration has been made.

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

1. **Use a build that includes bolt 3**, so the `github-issues` ledger exists. With the bolt-1 build, `register` refuses this configuration: `cannot load ledger "github-issues"`.
2. **Finalize `audits/gh-aw-prospective/review-protocol.md`.** Its hash is registered; changing it later fails check 1. It is a copy of `docs/design/review-protocol.example.md`, with the recording section rewritten for labels.
3. **Fill in `audits/gh-aw-prospective/.pr-rla.yml`:**
   - `window.start`: the UTC day after the day you register; `window.end`: start + 41 days (42 inclusive days). Until both are set, the file does not load.
   - `ledger.options.repo`: the audit repo you own (draw issues and labels live there; gh-aw itself is only read).
   - `verdicts.reviewers`: your GitHub login.
   - Bolt 3 confirms the ledger's option names and the `verdicts` keys; adjust them to what it ships.
4. **Check without writing anything:**

   ```sh
   pr-rla -C audits/gh-aw-prospective register --dry-run
   ```

   It must say `PROSPECTIVE`, show `ledger github-issues · verdict provenance account`, and `timestamps: not requested (dry run) · authorities sigstore, digicert, globalsign, microsoft · k = 2`. A dry run contacts no authority.

## The command

```sh
pr-rla -C audits/gh-aw-prospective register
```

It signs the record, sends each of the four authorities one request holding only the record's SHA-256 digest and a nonce, and writes the record with the tokens it got. Expect:

```
  PROSPECTIVE · registration existed by <time> (U_k)
  timestamps: 4 of 4 TSAs (sigstore, digicert, globalsign, microsoft) · k = 2 · PROVEN
```

- **Exit 5** (`TIMESTAMP NOT TAMPER-PROOF (n of 2)`): fewer than two operators answered. Run `pr-rla -C audits/gh-aw-prospective register --force` before showing the registration to anyone. Tokens cannot be added to a written record.
- **Exit 1 with `local clock differs from timestamp authority time`**: fix the clock; nothing was written.
- Do not pass `--submit`: no Rekor entry is part of this plan (D3).

## After registering

1. Commit `audits/gh-aw-prospective/audit/gh-aw-prospective/registration.json` and push the audit repo.
2. Give the auditors the registration's SHA-256 (printed first) before the window opens. `verify` cannot prove that no other registration exists, so this hand-over is the control.
3. **Freeze with a build that includes bolt 5** (U3, the pinned history head), after the window closes and before seed round R publishes (24 h after the close), so the population is reproducible.
4. `verify` prints the registering and freezing pr-rla versions. Any later change to the selector or population semantics needs a new registration, never a silent change.
