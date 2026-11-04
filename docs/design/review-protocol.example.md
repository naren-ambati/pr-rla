# Review protocol

This file is hashed into the registration. Every verdict names its hash, so
changing the protocol mid-audit is detectable. Fix it before `pr-rla register`.

## Scope
Read the change's full diff (generated files excluded when `exclude_generated` is true),
its description and its CI results.
- Generated means marked `linguist-generated` by the `.gitattributes` of the commit the
  change was based on, and still at the commit it landed as: not by one the change supplies.
- If the change edits any `.gitattributes` file, nothing is left out: read every file.

## A change FAILS if any of these holds
1. It introduces a bug a user or another developer would hit (wrong result, crash, data loss).
2. It introduces a security weakness (injection, auth bypass, secret exposure, unsafe defaults).
3. It breaks or silently weakens a test, check or CI gate.
4. It does not do what its title/description says, in a way that matters.

## Otherwise it PASSES
Style, naming and taste issues are not failures.

## Recording
`pr-rla record <draw> pass|fail --reviewer <you> --note "<one line>"`, then commit.
