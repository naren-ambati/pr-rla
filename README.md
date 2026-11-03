# pr-rla

Risk-limiting audits for code changes that landed on a default branch with no recorded human review, such as agent PRs merged on a bare click or direct pushes. pr-rla freezes the list of changes for a window, draws a publicly seeded random sample that anyone can re-derive, and runs a sequential test on your deep-review verdicts. It then certifies a bounded defect-rate claim, says how many more reviews it needs, or tells you to review everything.

Status: v0.1 (claim D only), plus phase 2: GitLab, Bitbucket Cloud and Bitbucket Data Center providers, GitHub Enterprise Server, and an external Gitea/Forgejo plugin. Phase 3, bolt 1: trusted time (RFC 3161 tokens from k-of-n timestamp authorities, record schema v2). The design is in [`docs/design/spec.md`](docs/design/spec.md); what was built, verified and assumed is in [`BUILD-NOTES.md`](BUILD-NOTES.md).

## Supported source-control systems

| Provider | Cloud / self-hosted | Merge strategies classified | Direct pushes | Live-verified |
|---|---|---|---|---|
| [`github`](docs/providers/github.md) | github.com; GitHub Enterprise Server (`base_url`) | merge commit, squash, rebase, fast-forward | yes | **yes** (github.com: github/gh-aw Q3 2026). GHES: no, fake server only |
| [`gitlab`](docs/providers/gitlab.md) | gitlab.com; self-managed (`base_url`) | merge commit, squash, squash + merge commit, fast-forward / semi-linear rebase | yes | **yes** (gitlab.com: gitlab-org/cli, Oct 2026). Self-managed: recorded gitlab.freedesktop.org responses |
| [`bitbucket-cloud`](docs/providers/bitbucket-cloud.md) | bitbucket.org | merge commit, squash, fast-forward, rebase (copies on the merge commit's chain) | yes | **yes** (atlassian/bamboo-specs, 2026-10-27..31) |
| [`bitbucket-data-center`](docs/providers/bitbucket-data-center.md) | self-hosted Data Center / Server | merge commit, squash, fast-forward, rebase (by author + time + message) | yes | **no**: no public instance; fake server from the documented shapes |
| [`gitea`](docs/writing-a-provider.md) (external plugin, [`examples/providers/gitea`](examples/providers/gitea)) | Gitea, Forgejo, Codeberg; self-hosted (`base_url`) | merge commit, squash, rebase (by author + date + message), fast-forward | yes | **yes** (Codeberg: forgejo/docs, Oct 2026) |
| `json-file` | any (normalized export) | as exported | as exported | n/a |

Every provider passes the same conformance kit (`pr-rla/testing`); the HTTP ones also pass it under injected 5xx and 429 faults. Writing your own: [`docs/writing-a-provider.md`](docs/writing-a-provider.md).

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
pr-rla register                               # fixes selector + window + parameters + protocol hash; time-stamped by 4 TSAs (hash only)
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

On 2026-11-03 it printed `2,947 landed · 2,717 no recorded human review (merged by: 2,717 human accounts, 0 bot) · 1,589 ≤ 200 changed lines`, next to GitHub search's `review:none` figure of 2,311. It also found 61 direct pushes to `main` in the window. [`BUILD-NOTES.md`](BUILD-NOTES.md) accounts for the two PRs that GitHub search counts and pr-rla does not: both were merged into other branches.

## How an audit stays honest

| Step | What is fixed | How |
|---|---|---|
| `register` | the selector (stratum), window, p0/p1/α, cap, minimum N and the SHA-256 of `review-protocol.md` | an ECDSA-signed record (schema v2) carrying RFC 3161 tokens over its SHA-256 from k = 2 of 4 timestamp authorities; optionally a Rekor entry |
| `freeze` | the population: every change id + merge SHA, sorted, with review states as of freeze time | `audit/<window>.manifest.json` with its SHA-256, plus a signed, time-stamped commitment naming N and the seed round |
| seed round R | derived, not chosen: the first drand quicknet round ≥ 24 h after the later of window close and registration | rounds publish at 1692803367 + 3·(R−1) s |
| `sample` | draw *i* = SHA-256(randomness ‖ manifest-hash ‖ uint64be(*i*)) mod N | BLS signature checked with `drand-client` against the pinned quicknet key |
| `status` | only the longest fully labelled prefix of draws counts; a change drawn twice reuses its first verdict | reviewers cannot label easy draws first |

`verify` checks: (1) the registration, its timestamp tokens, and whether it is PROSPECTIVE or RETROSPECTIVE; (2) that the manifest was time-stamped before R published; (3) that R is the derived round; (4) R's BLS signature; (5) the population, rebuilt from the SCM with the registered selector and diffed against the manifest; (6) every draw; (7) the verdict events and the ledger's own history. A manifest with changes removed fails check 5, a re-rolled round fails check 3, and a manifest written after the seed was public fails check 2.

Trusted time (schema v2 records): `register` and `freeze` send each configured timestamp authority one RFC 3161 request holding only the record's SHA-256 digest and a nonce, and store the tokens in the record. `verify` checks every token offline against the trust bundle shipped in the package (`src/timestamp/trust-bundle.json`): the CMS signature, the imprint and nonce, the signer's ESSCertID and its critical `timeStamping` EKU, the chain to a pinned anchor valid at genTime, and agreement with the record's signed time within 10 minutes plus the token's accuracy. Tokens from one operator count once, and k = 2 operators must agree; otherwise every output says `TIMESTAMP NOT TAMPER-PROOF (n of 2)`, and `register`/`freeze` exit 5 with the command to run again. `init` writes Sigstore, DigiCert, GlobalSign and Microsoft; GitHub, SwissSign, Sectigo and FreeTSA are bundled too, off by default. The signed `registeredAt` stays the seed input: tokens bound it, they do not replace it. Parsing uses pkijs + asn1js ([`BUILD-NOTES.md`](BUILD-NOTES.md), bolt 1). v1 records keep verifying through their Rekor `integratedTime`.

Transparency log: pr-rla builds and verifies Rekor v1 `hashedrekord` entries (SET and RFC 6962 inclusion proof) and Rekor v2 entries (inclusion proof and signed checkpoint; v2 carries no time). It never submits anywhere unless you pass `--submit --rekor-url <url>`, because entries in a public log are public and permanent; `--rekor-api v2` also prints that the v2 client is unverified against the production log and needs `--yes`. No entry has ever been written to a real log.

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
- `pr-rla/testing`: `runProviderConformance()` / `assertProviderConformance()`. It checks normalization, PR vs direct-push classification, merge strategies (no commit a PR brought in comes back as a direct push), no double counting, stable sorted ids, review-state mapping, actors, bot detection, pagination, kind filtering, and retries under injected 5xx/429 faults with the rate-limit headers respected.

Built-in providers (one page each in [`docs/providers/`](docs/providers/)):

- `github`: REST pulls sorted by update time and filtered by `merged_at`, re-scanning the head of the list for PRs updated mid-walk. Reviews come from GraphQL in batches of 40. Direct pushes are default-branch commits in the window that no merged PR introduced. `base_url` selects GitHub Enterprise Server.
- `gitlab`: REST merge requests, approvals and reviewer states; review notes, bot flags and diff stats through GraphQL (which serves notes on public projects without a token); `base_url` for self-managed.
- `bitbucket-cloud` (alias `bitbucket`): merged PRs with participants, activity for merge time and reviews, diffstat for size.
- `bitbucket-data-center` (aliases `bitbucket-server`, `bitbucket-dc`): REST 1.0, unverified against a live server.
- `json-file`: normalized changes exported from any SCM.

External: [`examples/providers/gitea`](examples/providers/gitea) (`pr-rla-provider-gitea`) for Gitea and Forgejo, loaded by path or package name.

Built-in ledger: `git-file` (`audit/<window>/verdicts.jsonl`; git history is the tamper trail, and `verify` checks that every commit only appended).

### Adding a provider (Gerrit, Azure Repos, …)

The full walkthrough, with the Gitea plugin as the worked example, is [`docs/writing-a-provider.md`](docs/writing-a-provider.md). In short:

1. Start from [`examples/providers/gitea/`](examples/providers/gitea/) (a complete plugin) or [`examples/provider-template.mjs`](examples/provider-template.mjs) (a skeleton). Export `defineProvider({ providerApiVersion: 1, name, create(options, ctx) })`, and send every request through `ctx.fetch` and every wait through `ctx.sleep`.
2. `listChanges({ repo, window, kinds })` returns every change that landed on the default branch in `[opensAt, closesAt)`:
   - merged PRs/MRs into the default branch, with all reviews;
   - default-branch commits (all ancestors, not only first parents) that no merged PR introduced, as `direct_push` with `reviews: []` and `mergedBy: null`. Match both the SCM's commit→PR link and each PR's merge/squash SHA; GitHub's link was missing for one real merge commit in the recorded fixture.
   - Never return one commit for two changes. A rebase merge's commits all belong to its PR.
3. Record real API responses (`scripts/record-fixture.mjs`) and run `assertProviderConformance((fixture, harness) => …, fixtures)` from `pr-rla/testing`.
4. Reference it from `.pr-rla.yml`: `provider: { use: ./my-provider.mjs, options: {...} }` or `provider: { use: pr-rla-provider-gitlab }`. A provider declaring another API version is refused with a clear error.

## Limitations (v0.1)

- **Claim D only.** It bounds what reviewers detect under the protocol; claim T, fixed attribute plans, stratified audits and sampling without replacement are not built.
- **Transparency log.** Exercised only against local mock logs (v1 and v2). No Rekor production or staging entry has ever been created, so a real `--submit` is unverified on both APIs.
- **Bots on regular accounts.** Every SCM's bot detection rests on its own account type or flag. Service accounts that run as ordinary users count as human: GitHub's `Copilot` commit author, GitLab's `gitlab-bot` and `marge-bot`, Bitbucket's `bamboo_hg_user`. On Gitea, which has no flag at all, they count as human unless they are listed in the provider's `bots` option.
- **Direct pushes on GitHub.**
  - The commit author is not the pusher, and GitHub's commit APIs do not expose the pusher. Every manifest records this.
  - The window applies to the commit date.
  - GitHub reports the `Copilot` commit-author account as a `User`, so a commit it authors directly is classified `human`.
  - A direct-push merge commit (e.g. a `git pull` merge pushed to main) is its own change, and its size is GitHub's diff against its first parent.
- **GitHub review states are read at freeze time.** Labels can change later, so a label-based stratum may not re-verify.
- **One repo per audit.** There is no org-pooled freeze yet.
- **Timestamps** are tamper-evident only when k = 2 timestamp-authority operators agree; with fewer (or none configured) they are the signer's clock, and every output says so. Three of the eight bundled anchors (Microsoft's, pinned at its intermediate, SwissSign's and FreeTSA's) were taken from the authorities' own responses (trust on first use): see BUILD-NOTES, bolt 1.
- **One registration per audit is a procedural control.** `verify` cannot prove that no other registration exists: hand your auditor the registration before the window opens.
