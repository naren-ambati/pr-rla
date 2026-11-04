# gh-aw Q3 2026, recorded (a test fixture)

A retrospective pr-rla audit of the Copilot stratum of https://github.com/github/gh-aw for 2026-07-01..2026-09-30, built offline by `scripts/build-gh-aw-recorded-audit.mjs`. It is a demonstration, not evidence: it was registered after the window closed.

- **recorded**: the population in `changes.json` (the 1,589 changes the phase-1 read-only dry run of 2026-11-03T14:27Z to 14:49Z selected: Copilot PRs merged into main with no recorded human review and at most 200 changed lines), and the drand quicknet round 33,245,812 the draws come from.
- **recorded**: `changes.json` `descriptions`, the GitHub API's own responses for the issued draws (`scripts/record-draw-descriptions.mjs`, GETs only, 2026-11-04), with e-mail addresses replaced by `user-<hash>@example.invalid`.
- **synthetic**: the registration, freeze and sample times (a fake clock: registered 2026-10-20T00:00Z, frozen 12:00Z, sampled 2026-10-21T00:00:05Z), the signing key (thrown away), and the review protocol (`docs/design/review-protocol.example.md` as it was when the fixture was built, before the U5 fix round added its base-commit rule for generated files). There are no verdicts: no one reviewed these changes for this fixture.
- No timestamp authority and no transparency log: every time is self-asserted (TIMESTAMP NOT TAMPER-PROOF).
