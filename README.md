# pr-rla

Risk-limiting audits for code changes that landed on a default branch with no recorded human review, such as agent PRs merged on a bare click or direct pushes. pr-rla freezes the list of changes for a window, draws a publicly seeded random sample that anyone can re-derive, and runs a sequential test on your deep-review verdicts. It then certifies a bounded defect-rate claim, says how many more reviews it needs, or tells you to review everything.

Status: v0.1 (claim D only). The design is in [`docs/design/spec.md`](docs/design/spec.md); what was built, verified and assumed is in [`BUILD-NOTES.md`](BUILD-NOTES.md).

## The election-audit idea in five lines

1. Election officials cannot hand-count every ballot, so they draw ballots at random from a list fixed in advance.
2. They read each drawn ballot by hand and keep a running likelihood ratio (Wald's SPRT, as in the BRAVO ballot-polling audit).
3. They stop as soon as the evidence supports the reported outcome at a stated risk limit, e.g. 5%.
4. If it never does, they escalate to a full hand count.
5. pr-rla does the same with merged changes as ballots and a deep review under a fixed protocol as the hand count.

Claim D (the default): *"deep review under protocol P would flag ≤ p0 of this window's changes in the stratum, at risk α."* With p0 = 10%, p1 = 2% and α = 5%, it certifies after 36, 56 or 75 draws with 0, 1 or 2 failures. It escalates at 144 draws (4 × 36), or earlier once the target is out of reach. Claim D is about what reviewers detect, not the true defect rate; the latter needs measured recall (claim T, planned for v0.2).

## Quickstart

```sh
git clone <this repo> pr-rla && cd pr-rla
npm ci && npm run build && npm link            # puts `pr-rla` on PATH

mkdir my-audit && cd my-audit && git init
pr-rla init --repo github/gh-aw               # writes .pr-rla.yml, review-protocol.md, audit/
export GITHUB_TOKEN=$(gh auth token)          # read-only use

pr-rla freeze --dry-run                       # see the population before fixing anything
pr-rla register                               # fixes selector + window + parameters + protocol hash
pr-rla freeze                                 # after the window closes: writes audit/<window>.manifest.json
pr-rla sample                                 # after seed round R publishes: BLS-verifies R, writes the draws
pr-rla record 1 pass --reviewer you           # one verdict per draw, in draw order; commit after each
pr-rla status                                 # CERTIFIED / n more passing draws needed / ESCALATE
pr-rla verify                                 # anyone can re-check the seven properties
pr-rla simulate --population 1590 --defects 159   # the risk limit holds at the tolerance
```

Any SCM can feed pr-rla today by exporting normalized changes to JSON: `pr-rla --from-file changes.json freeze --dry-run` (format: `pr-rla/changes/v1`, see `test/fixtures/changes/`).

The real demo population is in [`examples/gh-aw-q3/.pr-rla.yml`](examples/gh-aw-q3/.pr-rla.yml):

```sh
GITHUB_TOKEN=$(gh auth token) pr-rla -C examples/gh-aw-q3 freeze --dry-run
```

## How an audit stays honest

| Step | What is fixed | How |
|---|---|---|
| `register` | the selector (stratum), window, p0/p1/α, cap, minimum N and the SHA-256 of `review-protocol.md` | an ECDSA-signed record; optionally a Rekor `hashedrekord` entry |
| `freeze` | the population: every change id + merge SHA, sorted, with review states as of freeze time | `audit/<window>.manifest.json` with its SHA-256, plus a signed commitment naming N and the seed round |
| seed round R | derived, not chosen: the first drand quicknet round ≥ 24 h after the later of window close and registration | rounds publish at 1692803367 + 3·(R−1) s |
| `sample` | draw *i* = SHA-256(randomness ‖ manifest-hash ‖ uint64be(*i*)) mod N | BLS signature checked with `drand-client` against the pinned quicknet key |
| `status` | only the longest fully labelled prefix of draws counts; a change drawn twice reuses its first verdict | reviewers cannot label easy draws first |

`verify` checks: (1) the registration and whether it is PROSPECTIVE or RETROSPECTIVE; (2) that the manifest was logged before R published; (3) that R is the derived round; (4) R's BLS signature; (5) the population, rebuilt from the SCM with the registered selector and diffed against the manifest; (6) every draw; (7) the verdict events and the ledger's own history. A manifest with changes removed fails check 5, a re-rolled round fails check 3, and a manifest written after the seed was public fails check 2.

Transparency log: pr-rla builds and verifies Rekor `hashedrekord` entries (SET and RFC 6962 inclusion proof). It never submits anywhere unless you pass `--submit --rekor-url <url>`, because entries in a public log are public and permanent. Without a log entry, every output says `TIMESTAMP NOT TAMPER-PROOF`.

## Architecture: bring-your-own providers and ledgers

```
            .pr-rla.yml  ── provider: github | json-file | ./my.mjs | some-package
                                  │
          registry (src/registry.ts) ── loads built-ins or import()s plugins, checks API versions
              │                                   │
   ScmProvider → ChangeRecord[]            Ledger → VerdictEvent[]
              │                                   │
   core (src/core): selector · manifest · seed/draws · SPRT · status · verify · simulate
```

The core sees only `ChangeRecord`s. A boundary test fails the build if it imports a provider, a ledger or the registry:

```ts
interface ChangeRecord {
  id: string;                 // "github:owner/repo#123" or "github:owner/repo@<sha>"
  kind: "pull_request" | "direct_push";
  repo: string; url: string; mergeSha: string; mergedAt: string;
  author: { login: string; kind: "human" | "bot" };
  mergedBy: { login: string; kind: "human" | "bot" } | null;   // null for direct pushes
  reviews: { author; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"; submittedAt }[];
  changedLines: number; labels: string[];
}
```

Package exports:

- `pr-rla/provider`: `ScmProvider`, `ChangeRecord` and related types, `PROVIDER_API_VERSION` (1), `defineProvider()`.
- `pr-rla/ledger`: `Ledger`, `VerdictEvent`, `LEDGER_API_VERSION` (1), `defineLedger()`.
- `pr-rla/testing`: `runProviderConformance()` / `assertProviderConformance()`. It checks normalization, PR vs direct-push classification, no double counting, stable sorted ids, review-state mapping, actors, pagination and kind filtering.

Built-in providers:

- `github`: REST pulls sorted by update time and filtered by `merged_at`, re-scanning the head of the list for PRs updated mid-walk. Reviews come from GraphQL in batches of 40. Direct pushes come from a first-parent walk of the default branch.
- `json-file`: normalized changes exported from any SCM.

Built-in ledger: `git-file` (`audit/<window>/verdicts.jsonl`; git history is the tamper trail, and `verify` checks that every commit only appended).

### Adding a provider (GitLab, Bitbucket, Gitea, …)

1. Copy [`examples/provider-template.mjs`](examples/provider-template.mjs). Export `defineProvider({ providerApiVersion: 1, name, create(options, ctx) })`.
2. `listChanges({ repo, window, kinds })` returns every change that landed on the default branch in `[opensAt, closesAt)`:
   - merged PRs/MRs into the default branch, with all reviews;
   - first-parent commits that no merged PR introduced, as `direct_push` with `reviews: []` and `mergedBy: null`. Match both the SCM's commit→PR link and each PR's merge/squash SHA; GitHub's link was missing for one real merge commit in the recorded fixture.
   - Never return one commit for two changes. A rebase merge's commits all belong to its PR.
3. Record real API responses and run `assertProviderConformance(provider, fixtures)` from `pr-rla/testing`.
4. Reference it from `.pr-rla.yml`: `provider: { use: ./my-provider.mjs, options: {...} }` or `provider: { use: pr-rla-provider-gitlab }`. A provider declaring another API version is refused with a clear error.

## Limitations (v0.1)

- **Claim D only.** It bounds what reviewers detect under the protocol; claim T, fixed attribute plans, stratified audits and sampling without replacement are not built.
- **Transparency log.** Exercised only against a local mock log. No Rekor production or staging entry has ever been created, so a real `--submit` is unverified, and Rekor v2 logs (no `integratedTime`) are not supported.
- **Direct pushes on GitHub.**
  - The commit author is not the pusher, and GitHub's commit APIs do not expose the pusher. Every manifest records this.
  - The window applies to the commit date.
  - The first-parent walk stops at the first commit dated before the window.
- **GitHub review states are read at freeze time.** Labels can change later, so a label-based stratum may not re-verify.
- **One repo per audit.** There is no org-pooled freeze yet.
- **Timestamps are self-asserted** without a log: the signer's clock and the git commit times.
- **One registration per audit is a procedural control.** `verify` cannot prove that no other registration exists: hand your auditor the registration before the window opens.
