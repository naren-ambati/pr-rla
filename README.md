# pr-rla

Risk-limiting audits for code changes that landed on a default branch with no recorded human review, such as agent PRs merged on a bare click or direct pushes. pr-rla freezes the list of changes for a window, draws a publicly seeded random sample that anyone can re-derive, and runs a sequential test on your deep-review verdicts. It then certifies a bounded defect-rate claim, says how many more reviews it needs, or tells you to review everything.

Status: v0.1 (claim D only), plus phase 2: GitLab, Bitbucket Cloud and Bitbucket Data Center providers, GitHub Enterprise Server, and an external Gitea/Forgejo plugin. Phase 3, bolt 1: trusted time (RFC 3161 tokens from k-of-n timestamp authorities, record schema v2). Bolt 9: org-pooled audits (`repos:`, resumable `freeze`, `freeze --estimate`). The design is in [`docs/design/spec.md`](docs/design/spec.md); what was built, verified and assumed is in [`BUILD-NOTES.md`](BUILD-NOTES.md).

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
pr-rla draw-context 1                         # what to review for draw 1: diff (generated files dropped), description, CI, checklist
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

On 2026-11-03 it printed `2,947 landed · 2,717 no recorded human review (merged by: 2,717 human accounts, 0 bot) · 1,589 ≤ 200 changed lines`, next to GitHub search's `review:none` figure of 2,311. That run predates the review rules below; the same recorded listing under them gives `2,947 landed · 2,718 no recorded human review · 1,589 ≤ 200 changed lines` (one PR, #51168, had a human approval submitted 14 minutes after it merged; it is over 200 lines, so N stays 1,589). It also found 61 direct pushes to `main` in the window. [`BUILD-NOTES.md`](BUILD-NOTES.md) accounts for the two PRs that GitHub search counts and pr-rla does not: both were merged into other branches.

## How an audit stays honest

| Step | What is fixed | How |
|---|---|---|
| `register` | the selector (stratum), window, p0/p1/α, cap, minimum N and the SHA-256 of `review-protocol.md` | an ECDSA-signed record (schema v2) carrying RFC 3161 tokens over its SHA-256 from k = 2 of 4 timestamp authorities; optionally a Rekor entry |
| `freeze` | the population: every change id + merge SHA, sorted, with review states as of freeze time | `audit/<window>.manifest.json` with its SHA-256, plus a signed, time-stamped commitment naming N and the seed round |
| seed round R | derived, not chosen: the first drand quicknet round ≥ 24 h after the later of window close and registration | rounds publish at 1692803367 + 3·(R−1) s |
| `sample` | draw *i* = SHA-256(randomness ‖ manifest-hash ‖ uint64be(*i*)) mod N | BLS signature checked with `drand-client` against the pinned quicknet key |
| `status` | only the longest fully labelled prefix of draws counts; a change drawn twice reuses its first verdict | reviewers cannot label easy draws first |

`verify` checks: (1) the registration, its timestamp tokens, and whether it is PROSPECTIVE or RETROSPECTIVE; (2) that the manifest was time-stamped before R published; (3) that R is the derived round; (4) R's BLS signature; (5) the population, rebuilt from the SCM with the registered selector and diffed against the manifest; (6) every draw; (7) the verdict events and the ledger's own history. A manifest with changes removed fails check 5, a re-rolled round fails check 3, and a manifest written after the seed was public fails check 2.

Trusted time (schema v2 records): `register` and `freeze` send each configured timestamp authority one RFC 3161 request holding only the record's SHA-256 digest and a nonce, and store the tokens in the record. `verify` checks every token offline against the trust bundle shipped in the package (`src/timestamp/trust-bundle.json`): the CMS signature, the imprint and nonce, the signer's ESSCertID and its critical `timeStamping` EKU, the chain to a pinned anchor valid at genTime, and agreement with the record's signed time within 10 minutes plus the token's accuracy. Tokens from one operator count once, and k = 2 operators must agree; otherwise every output says `TIMESTAMP NOT TAMPER-PROOF (n of 2)`, and `register`/`freeze` exit 5 with the command to run again. `init` writes Sigstore, DigiCert, GlobalSign and Microsoft; GitHub, SwissSign, Sectigo and FreeTSA are bundled too, off by default. The signed `registeredAt` stays the seed input: tokens bound it, they do not replace it, and a v2 record whose envelope has lost its `timestamps` field FAILs. Parsing uses pkijs + asn1js ([`BUILD-NOTES.md`](BUILD-NOTES.md), bolt 1). v1 records keep verifying through their Rekor `integratedTime`.

Every token rule judges one certificate: the single certificate in the token that the signer identifier names. The signature key, ESSCertID, EKU and chain must all be that one certificate's, and a token carrying a second certificate with the signer's issuer and serial is refused. Intermediates must be CAs allowed to sign certificates (critical `cA`, `keyCertSign`, path length, an EKU that allows timestamping). Under the general-purpose roots of DigiCert, GlobalSign, SwissSign and GitHub, only the operator's pinned TSA issuing CA may issue the signer. Only tokens from the authorities the registration names count toward k; any other token is listed as `ignored (not registered)`. `register`, `verify` and `status` print each counted authority's anchor and how it is trusted, e.g. `microsoft: anchor pinned on first use (intermediate Microsoft Public RSA Timestamping CA 2020, independent: false)`.

Transparency log: pr-rla builds and verifies Rekor v1 `hashedrekord` entries (SET and RFC 6962 inclusion proof) and Rekor v2 entries (inclusion proof and signed checkpoint; v2 carries no time). It never submits anywhere unless you pass `--submit --rekor-url <url>`, because entries in a public log are public and permanent; `--rekor-api v2` also prints that the v2 client is unverified against the production log and needs `--yes`. No entry has ever been written to a real log. `verify` and `status` trust a log's key only if it is pinned in the package (Sigstore's production Rekor v1 and v2 logs, from Sigstore's TUF `trusted_root.json`) or passed with `verify --log-key <file>`: never the audit repo's `transparency_log.public_key_file`, any file in the audit repo, or the `/publicKey` of the URL a record names. An entry under any other key is reported as unverified and gives no time evidence. So a v1 audit logged to any other log verifies 7/7 only with the log's key passed as `--log-key`; without it, checks 1 and 2 WARN `time unproven`.

## Org-pooled audits

One registration, freeze and certificate for every repo of an org, group or workspace. A rule is registered and resolved once, at freeze; the population is the union of the repos' populations under one selector.

```yaml
repos: { owner: my-org, exclude: ["*-sandbox"] }   # archived repos and forks are out by default; or a list: repos: [my-org/api, my-org/web]
```

```sh
pr-rla freeze --dry-run --estimate    # predicts the requests and wall time from the first page of each repo; reads only
pr-rla freeze                         # 4 repos at a time, all-or-nothing; if it stops (exit 4) it prints `pr-rla freeze --resume <runId>`
```

A killed or rate-limited freeze resumes to a byte-identical manifest. There is no `--skip-repo`: a repo the token cannot read is excluded in the registered rule, before the seed. `register` signs the repos the rule matches, by id, so archiving, renaming or hiding one later cannot take it out of the pool. `verify` fails a registered repo missing from the manifest, a repo archived after it took window changes, and a frozen head the SCM's push log shows was not the branch's tip at freeze (or one older than the window's merges); a commit pushed after freeze is not a failure where the push log places it (FR7.2). It is **INCOMPLETE** (exit 6) for a repo that is gone or unreadable, when it cannot establish that its token (or the registering token) sees every private or internal repo, for a moved head with no push log to place it (Bitbucket keeps none), for a repo that may have been transferred in, and when its own token is refused. Attribute warnings are one line; `verify --verbose` lists each repo. One provider per pool. Details, the output of a read-only run on the public `navikt` org (2026-11-04) and the limits, including what a retrospective pooled audit cannot detect: [`docs/org-pooled-audits.md`](docs/org-pooled-audits.md).

`verify` exits 0 when VERIFIED, 1 when a check FAILed, and 6 when INCOMPLETE: nothing failed, but part of the population could not be rebuilt or its completeness established, so it is not a verification (`--json` has `verdict`; `ok` is true only for VERIFIED). The other exit codes are in [`contracts.md` §7](docs/design/phase-3-4/contracts.md).

## CI integrations

pr-rla runs in CI to keep a certificate honest between humans: on a verdict event or a schedule it reads the ledger, prints where the audit stands, and fails the job when it ESCALATEs, refuses, has too few trusted timestamps, or cannot show completeness. It makes no verdict and, by default, writes nothing.

| SCM | Integration | Guide |
|---|---|---|
| GitHub | A composite action, [`integrations/github-action`](integrations/github-action), with its own lockfile pinning pr-rla by version and integrity | [`docs/ci/github.md`](docs/ci/github.md) |
| GitLab | A CI/CD component, [`integrations/gitlab/templates/pr-rla.yml`](integrations/gitlab/templates/pr-rla.yml), with typed inputs; and a plain snippet. Not in the CI/CD Catalog | [`docs/ci/gitlab.md`](docs/ci/gitlab.md) |
| Bitbucket | A Pipelines script step, no Docker pipe | [`docs/ci/bitbucket.md`](docs/ci/bitbucket.md) |

All three pin the pr-rla version, run `--plugins builtin-only` unless you opt in, map the exit codes the same way (2 ESCALATE, 3 refusal, 5 timestamps and 6 INCOMPLETE fail the job by default; 1 and 4 always do), and keep to the local-consent model for credentials: the defaults go to their own SCM, and a self-hosted host needs an `approve-origins` line written by whoever owns the CI configuration. [`docs/ci/README.md`](docs/ci/README.md) has the end-to-end matrix and what is and is not verified. They are tested on fixtures and mock servers only.

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
- `pr-rla/testing`: `runProviderConformance()` / `assertProviderConformance()`. It checks normalization, PR vs direct-push classification, merge strategies (no commit a PR brought in comes back as a direct push), no double counting, stable sorted ids, review-state mapping, actors, bot detection, pagination, kind filtering, and retries under injected 5xx/429 faults with the rate-limit headers respected; and, for the optional phase-3 fields, the pinned head, account ids, review granularity and revoked approvals; fixtures can opt in to `list-repos`, `estimate-requests`, `repo-unavailable` and `push-log` for org-pooled audits.
- Both kits fail an empty fixture list and report a check as skipped when the fixture declares nothing for it (the provider kit's `window-and-kinds` asserts completeness against `expect.ids`; the ledger kit needs a fixture per case or a reason in `skipCases`): see [`docs/writing-a-provider.md`](docs/writing-a-provider.md).
- `pr-rla/testing` also has `runLedgerConformance()` / `assertLedgerConformance()` for ledgers: the first eligible verdict counts, relabels warn, a removal after counting, a deleted or moved issue and a deleted or renamed verdict label fail, bots, apps and unregistered reviewers are ignored, verdicts carry the tracker's time, history pages and round-trips through a checkpoint, publishing is idempotent, and reads survive injected faults. Each fixture says whether it is `recorded` or `synthetic`.
- `pr-rla/http`: `createJsonClient()`, the built-ins' retrying JSON client, under its own `HTTP_HELPER_VERSION` (1).
- `pr-rla/api/read`: the read-only audit API, `auditList`, `status`, `draws`, `drawContext`, `verify`, `freezePreview` and `simulate`, with `LONG_CALL_DEADLINE_MS` and `SIMULATE_MAX_DRAWS`. Each call runs read-only: the fetch broker refuses any request that is not a read, no `trust: full` plugin loads, every file it opens is confined to the caller's `roots`/`confine`, its `signal` stops it, and its errors carry foreign text only in `untrusted`. No write function is reachable from this subpath (a test walks its import graph, and another traces what a run loads, writes and starts). Every CLI command is a formatter over the audit API in `src/api`, and its `--json` output is the API's result object.

Built-in providers (one page each in [`docs/providers/`](docs/providers/)):

- `github`: REST pulls sorted by update time and filtered by `merged_at`, re-scanning the head of the list for PRs updated mid-walk. Reviews come from GraphQL in batches of 40. Direct pushes are default-branch commits in the window that no merged PR introduced. `base_url` selects GitHub Enterprise Server.
- `gitlab`: REST merge requests, approvals and reviewer states; review notes, bot flags and diff stats through GraphQL (which serves notes on public projects without a token); `base_url` for self-managed.
- `bitbucket-cloud` (alias `bitbucket`): merged PRs with participants, activity for merge time and reviews, diffstat for size.
- `bitbucket-data-center` (aliases `bitbucket-server`, `bitbucket-dc`): REST 1.0, unverified against a live server.
- `json-file`: normalized changes exported from any SCM.

External: [`examples/providers/gitea`](examples/providers/gitea) (`pr-rla-provider-gitea`) for Gitea and Forgejo, loaded by path or package name.

Built-in ledgers:

- `git-file` (`audit/<window>/verdicts.jsonl`; git history is the tamper trail, and `verify` checks that every version of the file, in every commit, only appended to its parents' versions; it needs a full clone). Verdict provenance: `self-asserted`; with the reviewers' SSH keys registered and each verdict signed on its own (`pr-rla record --sign`), `account`, or `presence` with a FIDO security key and the user-presence flag set ([signed verdicts](#signed-verdicts-git-file), below).
- `github-issues` and `gitlab-issues`: one issue per drawn change in an audit repo or project (GitHub Enterprise Server and GitLab self-managed through `base_url`); a reviewer applies `pr-rla:pass` / `pr-rla:fail` (`pr-rla-pass` / `pr-rla-fail` on GitLab), and the verdict is read from the label-event history, never from current labels. Verdict provenance: `account`, the default `verdicts.min_provenance` with an issue ledger. `pr-rla checkpoint [--push]` time-stamps a hash of that history into the audit repo, so an admin deleting issues shows up in `verify`.

External: [`examples/ledgers/jira`](examples/ledgers/jira) (`pr-rla-ledger-jira`) for Jira Cloud, with the verdict in a single-select custom field read from the changelog. Like any external plugin it loads only once locked (`pr-rla plugin add`), and runs in the plugin host: `JIRA_EMAIL` and `JIRA_TOKEN` reach it as placeholders, the broker builds Basic auth for the `base_url` site only, and pr-rla writes its `ledger-index.json` for it.

### Signed verdicts (git-file)

A registration can make `git-file` verdicts attributable: list each reviewer's SSH public key in `verdicts.allowed_signers`, require signed verdicts, and set the minimum provenance.

```yaml
ledger: { use: git-file, options: { require_signed: true } }
verdicts:
  min_provenance: presence        # or account; the git-file default is self-asserted
  allowed_signers:                # OpenSSH allowed-signers lines, or the path of an allowed_signers file
    - 'alice namespaces="pr-rla-verdict@v1" sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t…'
```

Each verdict carries its own signature: an SSHSIG in namespace `pr-rla-verdict@v1` over a few lines of text that name the registration, the frozen manifest, the seed (the beacon round and its randomness), the protocol, the draw, the change, the verdict, the reviewer and the time (the exact bytes, version `pr-rla-verdict/v2`, are in [`contracts.md`](docs/design/phase-3-4/contracts.md), "Per-verdict signatures"). So one signature, which with a security key is one touch, is one verdict on one draw of one frozen audit, and it cannot be made before the seed is public. A commit's signature counts for nothing. With keys registered and `require_signed` or a minimum above `self-asserted`, a line without a valid signature by its reviewer's registered key never counts: it is listed as an ignored verdict, and the reviewer's signed verdict for that change counts instead.

The reviewer signs as they record: `pr-rla record 7 pass --sign ~/keys/verdicts_sk`. pr-rla writes the bytes to a temporary file, runs `ssh-keygen -Y sign -n pr-rla-verdict@v1 -f <key> <file>` (a security key asks for its touch), checks the signature as `verify` will, and appends the line; the reviewer is the key's registered principal. Then commit the ledger file as usual: git history is the tamper trail.

To sign without running pr-rla's process, a reviewer writes the bytes and the line themselves:

```sh
W=audit/2026-q3; DRAW=7; VERDICT=pass; ME=alice; KEY=~/keys/verdicts_sk
REG=$(jq -r .sha256 $W/registration.json)
PROTO=$(jq -r .record.protocolSha256 $W/registration.json)
MAN=$(jq -r .manifestSha256 $W/draws.json)
ROUND=$(jq -r .beacon.round $W/draws.json)
RAND=$(jq -r .beacon.randomness $W/draws.json)
CHANGE=$(jq -r --argjson d $DRAW '.draws[] | select(.draw == $d) | .changeId' $W/draws.json)
AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'pr-rla-verdict/v2\nregistrationSha256 %s\nmanifestSha256 %s\nbeaconRound %s\nbeaconRandomness %s\nprotocolSha256 %s\ndraw %s\nchangeId %s\nverdict %s\nreviewer %s\nrecordedAt %s\n' \
  "$REG" "$MAN" "$ROUND" "$RAND" "$PROTO" "$DRAW" "$CHANGE" "$VERDICT" "$ME" "$AT" > "verdict-$DRAW.txt"
ssh-keygen -Y sign -n pr-rla-verdict@v1 -f "$KEY" "verdict-$DRAW.txt"      # writes verdict-$DRAW.txt.sig
SIG=$(sed '1d;$d' "verdict-$DRAW.txt.sig" | tr -d '\n')
printf '{"changeId":"%s","draw":%s,"protocolSha256":"%s","recordedAt":"%s","registrationSha256":"%s","reviewer":"%s","schema":"pr-rla/verdict/v1","sshsig":"%s","verdict":"%s"}\n' \
  "$CHANGE" "$DRAW" "$PROTO" "$AT" "$REG" "$ME" "$SIG" "$VERDICT" >> $W/verdicts.jsonl
# check it as pr-rla will: ssh-keygen -Y verify -f allowed_signers -I "$ME" -n pr-rla-verdict@v1 -s "verdict-$DRAW.txt.sig" < "verdict-$DRAW.txt"
```

(A value holding `"` or `\` would need JSON escaping in the line; change ids and principals hold neither.) `verify` checks each line's SSHSIG in TypeScript, without ssh-keygen: the key must be registered, the line's `reviewer` must be that key's principal exactly, the signature must be for this registration, manifest and seed (verify rebuilds the bytes from what it has verified, and refuses `pr-rla-verdict/v1` signatures, which named neither), and for a security key (`sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com`) the user-presence flag must be set for `presence`. Ed25519, ECDSA and RSA software keys give `account`. Check 7 FAILs a counted verdict below the registered minimum; it also FAILs when the ledger it reads is not the registered one or not at the registered path (`ledgerPath`: a symbolic link or another spelling on the way FAILs too), and refuses a shallow, grafted or partial clone. `status` runs the same history walk, so it never prints CERTIFIED where verify would FAIL check 7. Certificates print the level as `presence (user-presence flag verified; key hardware not attested)`: a software-emulated authenticator can set that flag too, and pr-rla does not check that a registered key is hardware-backed ([`docs/security-model.md`](docs/security-model.md), T16). Register a key you keep for verdicts, not your everyday signing key. Issue ledgers top out at `account`.

### Adding a provider (Gerrit, Azure Repos, …)

The full walkthrough, with the Gitea plugin as the worked example, is [`docs/writing-a-provider.md`](docs/writing-a-provider.md). In short:

1. Start from [`examples/providers/gitea/`](examples/providers/gitea/) (a complete plugin) or [`examples/provider-template.mjs`](examples/provider-template.mjs) (a skeleton). Export `defineProvider({ providerApiVersion: 1, name, create(options, ctx) })`, and send every request through `ctx.fetch` and every wait through `ctx.sleep`.
2. `listChanges({ repo, window, kinds })` returns every change that landed on the default branch in `[opensAt, closesAt)`:
   - merged PRs/MRs into the default branch, with all reviews;
   - default-branch commits (all ancestors, not only first parents) that no merged PR introduced, as `direct_push` with `reviews: []` and `mergedBy: null`. Match both the SCM's commit→PR link and each PR's merge/squash SHA; GitHub's link was missing for one real merge commit in the recorded fixture.
   - Never return one commit for two changes. A rebase merge's commits all belong to its PR.
3. Record real API responses (`scripts/record-fixture.mjs`) and run `assertProviderConformance((fixture, harness) => …, fixtures)` from `pr-rla/testing`.
4. Reference it from `.pr-rla.yml`: `provider: { use: ./my-provider.mjs, options: {...} }` or `provider: { use: pr-rla-provider-gitlab }`. A provider declaring another API version is refused with a clear error.
5. Lock it: `pr-rla plugin add <use>` prints what it trusts and writes `pr-rla.lock.json`, the only way an external plugin gets in. It then runs out of process with placeholder credentials ([`docs/security-model.md`](docs/security-model.md)); `pr-rla plugin check <use>` runs the kit through that host. The lock does not hand anyone's secrets to the plugin: its credentials and `trust: full` take effect only on a machine where they are approved (`plugin add` approves them for you; anyone else runs `pr-rla plugin approve <use>`, and `--accept-lock-grants` takes them for one run in a repo you control).

## For assistants: `draw-context` and the read-only MCP server

`pr-rla draw-context <n>` shows what a reviewer reads for an issued draw: the change's files and patches with `linguist-generated` files dropped (when the registration's `exclude_generated` is on: only files the `.gitattributes` of both the change's base commit and its landed commit mark, by git's own rules, and none when the change edits a `.gitattributes`), its description, its CI results, the protocol's "FAILS if" checklist (with a FAIL, and no checklist, if the protocol's hash is not the registered one), the draw's verdict state, and how to record a verdict. Every built-in provider implements `describeChange` for it; a provider without it gets the manifest's fields and the URL. Text from the change, its SCM, the ledger or a plugin is fenced as untrusted data, with its control characters escaped:

```
<<<UNTRUSTED-CHANGE-CONTENT 7f3a9c…>>>
… author, title, description, patches, CI check names, the verdict's reviewer and note …
<<<END 7f3a9c…>>>
```

with a fresh 128-bit id on every call. The fence lowers the risk of prompt injection; it cannot rule it out, which is one more reason the verdict stays with a person.

[`packages/pr-rla-mcp`](packages/pr-rla-mcp) is a separate package: an MCP server over stdio with eight read-only tools, `audit_list`, `status`, `draws`, `draw_context`, `verify`, `simulate`, `freeze_preview` and `job_status`. It imports only `pr-rla/api/read`, whose read-only mode runs pr-rla's built-ins and isolated plugins only (a `trust: full` plugin is refused). So it records no verdict, issues no draw, submits to no log and writes no file, and its jobs and caches live in memory. Tools open only files under its `--root`s. A built-in gets only its default token variables, sent only to its default origin; a credential the audit repo's config or lock chooses is withheld until the operator consents. A call still running after 25 s returns `{ jobId }` for `job_status`. See its [README](packages/pr-rla-mcp/README.md) and [`docs/security-model.md`](docs/security-model.md) for what this does and does not guarantee.

## Limitations (v0.1)

- **Claim D only.** It bounds what reviewers detect under the protocol; claim T, fixed attribute plans, stratified audits and sampling without replacement are not built.
- **Transparency log.** Exercised only against local mock logs (v1 and v2). No Rekor production or staging entry has ever been created, so a real `--submit` is unverified on both APIs.
- **Bots on regular accounts.** Every SCM's bot detection rests on its own account type or flag. Service accounts that run as ordinary users count as human: GitHub's `Copilot` commit author, GitLab's `gitlab-bot` and `marge-bot`, Bitbucket's `bamboo_hg_user`. On Gitea, which has no flag at all, they count as human unless they are listed in the provider's `bots` option. Register them in `selector.bots` (logins or `id:<account id>`): the core then counts them as bots on every provider, and `verify` re-applies the list.
- **What counts as a human review.** A change leaves the `no-human-review` stratum only through an APPROVED or CHANGES_REQUESTED review by a non-bot account that is not the author and was submitted at or before the merge. A later approval and the author's own approval do not count. An approval is not tied to the commit it approved, so an approval of an earlier head commit still counts (the stale-commit limit; a dismissed or reset approval shows as `DISMISSED`, nothing else is inferred).
- **Size unknown.** When an SCM truncates a diff (GitLab `too_large`, Bitbucket Data Center), the change carries `changedLinesUnknown` instead of an undercount; a `max_changed_lines` stratum keeps it and the funnel reports how many.
- **Checkpoints are the only thing that sees deleted tracker history.** `verify` WARNs for an issue ledger with no time-stamped checkpoint at or after the last counted verdict; on a v2 audit a checkpoint counts as time-stamped only if at least one of its tokens verifies and comes from an authority the registration names. The checkpoint lines are hash-chained, so a deleted middle line is a FAIL, but deleting the newest line and its history file cannot be seen: take the last checkpoint after the last verdict and push it.
- **Direct pushes on GitHub.**
  - The commit author is not the pusher, and GitHub's commit APIs do not expose the pusher. Every manifest records this.
  - The window applies to the commit date.
  - GitHub reports the `Copilot` commit-author account as a `User`, so a commit it authors directly is classified `human`.
  - A direct-push merge commit (e.g. a `git pull` merge pushed to main) is its own change, and its size is GitHub's diff against its first parent.
- **GitHub review states are read at freeze time.** Labels can change later, so a label-based stratum may not re-verify.
- **Org-pooled audits are young.** They are verified on a synthetic 40-repo org and on a read-only 223-repo run of `navikt`; a full freeze of a real org with timestamp tokens has not been run. One provider per pool.
- **Timestamps** are tamper-evident only when k = 2 timestamp-authority operators agree; with fewer (or none configured) they are the signer's clock, and every output says so. Three of the eight bundled anchors (Microsoft's, pinned at its intermediate, SwissSign's and FreeTSA's) were taken from the authorities' own responses (trust on first use), and every output that counts one of them says `anchor pinned on first use … independent: false`: see BUILD-NOTES, bolt 1 and trusted-time fix round A.
- **One registration per audit is a procedural control.** `verify` cannot prove that no other registration exists: hand your auditor the registration before the window opens.
- **`presence` is not hardware-attested.** It means the verdict's own signature carries the user-presence flag from a registered security key. A software-emulated authenticator sets the same flag, pr-rla does not check that a key is hardware-backed, and the presence path has been tested with software keys only.
- **A git-file audit verifies from a full clone, at its registered path.** A shallow, grafted or partial clone is refused (check 7 FAILs and says to clone in full), because a verdict removed before the cut could not be seen. The ledger must be read at the path the registration records, through real directories spelled exactly as registered.
- **Windows is untested.** pr-rla runs `git` and `ssh-keygen` by the absolute path it finds on PATH, never one in the audit repository, but no part of pr-rla has been run on Windows.
- **Verifying someone else's audit does not hand it your tokens.** Its plugins get no credential and do not run in your process until you approve them, and a built-in pointed at another host by its `.pr-rla.yml` (`base_url`, `token_env`) does not send your token there; public audits verify anonymously ([`docs/security-model.md`](docs/security-model.md), "If you verify someone else's audit").
- **External plugins run isolated, not sandboxed.** On Node 22 and 24 an isolated plugin cannot read your tokens or files but can still open network connections and send out what it reads; Node 25 or later blocks that. The Node permission model is a seatbelt ([`docs/security-model.md`](docs/security-model.md)).
