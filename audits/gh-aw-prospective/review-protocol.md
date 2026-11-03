# Review protocol

This file is hashed into the registration. Every verdict names its hash, so
changing the protocol mid-audit is detectable. Fix it before `pr-rla register`.

## Scope
Read the change's full diff (generated files excluded when `exclude_generated` is true),
its description and its CI results.

## A change FAILS if any of these holds
1. It introduces a bug a user or another developer would hit (wrong result, crash, data loss).
2. It introduces a security weakness (injection, auth bypass, secret exposure, unsafe defaults).
3. It breaks or silently weakens a test, check or CI gate.
4. It does not do what its title/description says, in a way that matters.

## Otherwise it PASSES
Style, naming and taste issues are not failures.

## Recording
Apply exactly one of the labels `pr-rla:pass` or `pr-rla:fail` to the draw's issue in the audit
repo, yourself, in the GitHub web UI; add a one-line justification as the next comment. Labels
applied by an app, a bot or an unlisted account do not count.
