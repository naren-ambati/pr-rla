# Org-pooled audits

One registration, one freeze and one certificate for every repository of an org, GitLab group or Bitbucket workspace. The population is the union of the repos' populations under one selector, so the sample, the sequential test and the risk limit are those of a single repo with a larger N. A single repo is a pool of one: it runs through the same code and its records are unchanged.

The claim is about the pool. Per-repo counts are descriptive: `status` prints a table of where the draws fell, and says `per-repo counts are descriptive; the risk limit applies to the pool`.

## Registering a pool

`.pr-rla.yml` takes `repos:` where a single-repo audit takes `repo:` (not both):

```yaml
provider: github
repos:                           # a rule, resolved once, at freeze
  owner: my-org                  # a GitHub org or user, GitLab group, Bitbucket workspace or Data Center project key
  include: ["svc-*", "web"]      # globs over the repo path; default ["*"]
  exclude: ["*-sandbox"]
  archived: false                # default: archived repos are out
  forks: false                   # default: forks are out
  visibility: [public, private, internal]   # default: every visibility the token can see
freeze:
  concurrency: 4                 # repos listed at once; default 4. Not registered: it changes speed, never the result
```

or an explicit list, `repos: [my-org/api, my-org/web]`.

- **Globs.** A pattern with no `/` matches the repo's last segment; a pattern with a `/` matches the whole path (`my-org/team/**` for a GitLab subgroup). `*` stays inside a segment, `**` crosses segments, `?` is one character, and matching ignores case.
- **What is signed** is the rule as written, with the defaults filled in and the lists sorted, so two spellings of one rule register the same bytes. The registration records the rule, not the repos it matched.
- **`register` checks the pool before signing it.** It resolves the rule once (reads only) and refuses a rule that matches nothing. It refuses a rule for a provider that cannot list repositories, and names the provider. It refuses a pool that mixes providers (`github:acme/a` next to `gitlab:acme/b`): review counts mean different things on different providers, so there is one provider per registration. The refusal is a population rule in the core (`validateRepoSet`), so every caller gets it, not only the CLI.
- **Providers that list repositories** (`listRepos`): `github` (an org, else the user's own repositories), `gitlab` (a group with its subgroups, else a user), `bitbucket-cloud` (a workspace) and `bitbucket-data-center` (a project, unverified against a live server). An external plugin may implement it too ([`writing-a-provider.md`](writing-a-provider.md)). The core applies the globs and flags itself, so providers behave alike.

## Freezing a pool

`pr-rla freeze` resolves the rule at that moment, lists each repo's changes through the provider and the fetch broker (one per-host rate budget shared by every repo and every plugin), and writes one manifest and one signed, time-stamped commitment.

- **Records.** `repos` in the manifest lists every repo, sorted, with the SCM's stable repository id (from `listRepos`; `null` for a list), its default branch and the head the population was walked from. Change ids already carry their repo, so the sorted manifest, the draw formula and N need nothing else.
- **All-or-nothing.** A manifest missing a repo would be a pruned population, the attack check 5 exists to catch. So a repo that cannot be read (403, 404) fails the run and names the repo, and there is no `--skip-repo`. A repo the team cannot read must be excluded in the registered rule, before the seed.
- **Parallelism.** 4 repos at a time by default (`freeze.concurrency`). The broker's per-host budget is the real limiter; the concurrency only bounds memory and open connections. An external provider runs the same way inside the isolated plugin host.
- **Stopping and resuming.** If the rate budget, a timeout or the service gives out after the broker's retries, freeze stops scheduling, lets the repos in flight finish, keeps every finished repo's checkpoint and exits 4 with the command that finishes the job:

  ```
  pr-rla: stopped after 17 of 40 repos: …. The 17 repos listed are checkpointed; no manifest was written. Continue with: pr-rla freeze --resume <runId>
  ```

  The same holds when the process is killed: checkpoints are written atomically, one file per finished repo, so a repo that was mid-listing simply starts again. Checkpoints live in `.pr-rla/cache/<window>/<runId>/` of the audit directory (not committed; `verify` never reads them).
- **The run id** is the SHA-256 of the registration, the resolved repo list (with ids), the pr-rla version and the provider's identity. `--resume <runId>` (a prefix of 8 or more digits is enough) refuses if any of them differs, and says which. Running `freeze` again with the same inputs continues the run too. `--force` starts over.
- **Byte-identical.** The run keeps the time it started. That is the manifest's `frozenAt`, the instant reviews are read as of, so a killed and resumed freeze writes the same manifest as an uninterrupted one. The commitment is signed when the run finishes, because its timestamp tokens must agree with its signed time within 10 minutes and a pooled freeze can take hours; `verify` accepts a commitment dated at or after the manifest's `frozenAt` and checks both against the window and the seed round.
- **Before R.** Freeze still refuses to start once seed round R has published, and now refuses to write if the run finishes after it (the checkpoints are kept).
- **Not computed for a pool:** the provider-native counts `freeze` prints next to a single repo (a search figure per author), because they cost requests per repo and carry no claim.

## Predicting the cost: `--estimate`

```sh
pr-rla freeze --dry-run --estimate
```

(`--estimate` implies `--dry-run`; it works before anything is registered.) Each repo is probed with the first page of what `listChanges` reads, and the provider extrapolates: for GitHub, the head, the newest page of closed PRs plus one from the middle of the list when it is longer, and one page of history. At most 200 repos are probed (every k-th, in repo order) and the rest are scaled. The predicted requests are then replayed through a fresh rate governor with the broker's budgets: the published-limit defaults, any `rate_limits:` override, and any limit the server reported while probing. Output from a real run on the public GitHub org `navikt` (a 223-repo subset, 2026-11-04):

```
estimate: 223 repos (probed 200 of them, every 1.1th, and scaled)
  requests: ~1,102 = 33 listing + ~1,069 for the repos (~446 REST, ~623 GraphQL); the probes already spent 600
  wall time: ~3 min at 4 repos at a time (bound by request latency, 656 ms each: 3 min; the rate budget alone needs 0 s)
  budget api.github.com: the server reports 5,000 requests per window (4,502 left); the estimate paces to that
  ...
```

and the freeze it predicted printed `freeze: 223 repos · 223 listed now, 0 from checkpoints · 1102 requests (623 GraphQL) · 3 min 43 s`.

On the synthetic 40-repo org of the test suite the estimate lands within ±5% of the actual request count and within ±30% of the actual wall time over 18 orgs (6 seeds at 3 sizes, 2026-11-04); the bounds the design asks for are ±20% and ±50%, and the tests assert them on 4 of those orgs. It also warns when the predicted wall time exceeds the time left before R publishes. A provider without `estimateRequests` prints no figures and says so. The estimate is a prediction from first pages: how evenly a window's activity is spread decides how close it is, and a retried request counts again.

## What `verify` does with a pool

Check 2 holds the manifest to the registered set without any network: the registered repo, exactly the registered list, or only repos inside the registered rule; sorted and unique; and every change from a listed repo. Check 5 rebuilds each repo from its recorded head, re-resolves the rule, and diffs.

| Situation | Check 5 |
|---|---|
| A repo that matches the registered rule now but is not in the manifest, with changes in the window | **FAIL** `repo X matches the registered rule but is not in the manifest (n changes landed in the window)` |
| The same repo but with no change in the window (its first commit came after the window closed) | PASS, with a line saying it cannot change the population |
| A manifest repo that is gone (deleted, or not visible to the verifier's token: 404 or 403) | **WARN** `cannot rebuild X (404): its n changes are unverified`, one line per repo; the summary says how many changes could not be rebuilt |
| A manifest with a repo removed, even if re-hashed | **FAIL** as in the first row, because the rule still matches it |
| The verifier's provider cannot re-resolve the rule | **WARN** `cannot re-resolve the registered rule` |
| A repo's changes differ from the manifest's | **FAIL**, as for a single repo |

## Limits

- `verify` of a pool lists every repo again (4 at a time) and is not resumable: it takes about as long as the freeze did, and a rate limit that stops it means running it again.

- The estimate and `--resume` are verified on a synthetic org and on one public org (`navikt`, a 223-repo subset, read-only); a full `freeze` of a real org, with timestamp tokens, has not been run.
- `listRepos` for `bitbucket-data-center` is unverified against a live server, as that provider is. GitLab and Bitbucket Cloud `listRepos` are tested on hand-made responses only.
- A repo list carries no repository ids: the SCM is not asked. Only a rule records them.
- An empty GitHub repository (no commits) has nothing in any window and does not stop a pool. Its manifest entry has an empty default branch and no head.
- Bitbucket Data Center's repository list does not carry the default branch, so `listRepos` leaves it empty; the manifest records the branch `listChanges` walked.
