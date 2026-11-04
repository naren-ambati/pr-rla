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
- **What is signed** is the rule as written, with the defaults filled in and the lists sorted, so two spellings of one rule register the same bytes, and, for a rule, the repos it matches at that moment, by the SCM's stable repository id (`registeredRepos`). Those repos stay in the pool whatever happens to them after registration: archived, renamed out of a glob, made private under a public-only rule, transferred to another owner. Freeze includes every one that still exists, and `verify` FAILs a manifest that leaves one out. Repos created later join the pool if the rule matches them at freeze. A rule registration without `registeredRepos` FAILs check 2: `register` always writes them.
- **What the registering token could see** is signed too (`registeredVisibility`): per visibility, how many repositories the listing held and whether the provider could prove it complete (on GitHub: an org owner's classic token with the `repo` scope, or a GitHub App installation on all repositories). When the rule admits private or internal repositories and the token cannot prove it sees them all (a fine-grained token, a member who is not an owner), `register` prints a `WARNING` for each such visibility, because a repo the token did not see is not registered; `verify` is then INCOMPLETE for that visibility, whatever token it runs with.
- **`register` checks the pool before signing it.** It resolves the rule once (reads only) and refuses a rule that matches nothing. It refuses a rule for a provider that cannot list repositories, and names the provider. It refuses a pool that mixes providers (`github:acme/a` next to `gitlab:acme/b`): review counts mean different things on different providers, so there is one provider per registration. The refusal is a population rule in the core (`validateRepoSet`), so every caller gets it, not only the CLI.
- **Providers that list repositories** (`listRepos`): `github` (an org, else the user's own repositories), `gitlab` (a group with its subgroups, else a user), `bitbucket-cloud` (a workspace) and `bitbucket-data-center` (a project, unverified against a live server). An external plugin may implement it too ([`writing-a-provider.md`](writing-a-provider.md)). The core applies the globs and flags itself, so providers behave alike.

## Freezing a pool

`pr-rla freeze` resolves the rule at that moment, lists each repo's changes through the provider and the fetch broker (one per-host rate budget shared by every repo and every plugin), and writes one manifest and one signed, time-stamped commitment.

- **Records.** `repos` in the manifest lists every repo of the pool, sorted, with the SCM's stable repository id (from `listRepos`; `null` for a list), its default branch and the head the population was walked from. Change ids already carry their repo, so the sorted manifest, the draw formula and N need nothing else. For a rule, `repoListing` records the owner's whole listing as the freeze saw it: every repository with its id, flags, creation time and the rule clauses that exclude it (`archived`, `fork`, `visibility:private`, `include`, `exclude:<glob>`), the identity the token acts as and, per visibility, how many it listed and whether the provider could prove the listing complete. `goneRepos` records registered repos that are gone.
- **What the token can see.** For a rule that admits private or internal repositories, the provider's `listingVisibility` says whether the listing is provably complete. On GitHub that holds for an org owner (`/user/memberships/orgs/{org}` says `role: admin`) with a classic token holding the `repo` scope (its responses carry `X-OAuth-Scopes`), for the token's own user account, and for a GitHub App installation token whose `GET /installation/repositories` says `repository_selection: "all"` on the owner: an owner sees every repository of the org, while a member sees only the private repositories they were granted, and a fine-grained token or an app installed on selected repositories can be limited with no API that says so. When GitHub sends the org's `total_private_repos` (to an owner whose token has `admin:org`), the listing is held to it: one that shows fewer private and internal repositories is not complete. An OAuth App token (`gho_`, as the `gh` CLI's) is subject to the org's OAuth App access restrictions, which can hide every private repository with no response saying so, so it proves nothing without that count. A freeze that cannot prove it prints a note; a verifier that can see more will FAIL a repo it missed.
- **The push log.** After the listings, freeze reads each repo's push log (the provider's `pushLog`: GitHub's repository activity, GitLab's push events) back to the window's close, and records in `headEvidence`, per pinned head, the update that made it the branch's tip, or why the log cannot show that. The record is informational: `verify` reads the log again. A note names the heads the log cannot show, and repos whose branch was force-pushed after the window closed. It costs one request per repo (more for a branch updated over 100 times since the close), which `--estimate` counts.
- **A pull request the head does not reach.** When the provider reports one (a pull request merged in the window whose merge commit is not reachable from the branch's head: the branch was rewritten after it merged), freeze prints a warning: verify will FAIL check 5.
- **All-or-nothing.** A manifest missing a repo would be a pruned population, the attack check 5 exists to catch. So a repo in the listing that cannot be read (403, 404) fails the run and names the repo, and there is no `--skip-repo`. A repo the team cannot read must be excluded in the registered rule, before the seed.
- **Gone repos.** A repo counts as gone only after one repo-level probe (`describeRepo`, by id) answers 404: a 404 on a commit or a page of a repo that exists is a failure, and a rate limit is never "gone". A registered repo found gone is recorded in `goneRepos` with the probe's status, message and time, and the freeze completes; `verify` then reports it as INCOMPLETE, and FAILs if it comes back holding window changes. A provider without `describeRepo` cannot tell, so a registered repo missing from the listing stops the freeze.
- **Empty repos.** A repository with no commits holds nothing in any window: inside a pool it is listed with an empty default branch and no head. A single-repo audit of an empty repo stops with `<repo> has no default branch`, as before.
- **Parallelism.** 4 repos at a time by default (`freeze.concurrency`). The broker's per-host budget is the real limiter; the concurrency only bounds memory and open connections. An external provider runs the same way inside the isolated plugin host.
- **Stopping and resuming.** If the rate budget, a timeout or the service gives out after the broker's retries, freeze stops scheduling, lets the repos in flight finish, keeps every finished repo's checkpoint and exits 4 with the command that finishes the job: the message says how many repos are checkpointed, that no manifest was written, and ends `Continue with: pr-rla freeze --resume <runId>` (`src/api/read/freeze-preview.ts`; `test/pooled-freeze.test.ts` stops and resumes a synthetic 40-repo org).

  The same holds when the process is killed: checkpoints are written atomically, one file per finished repo, so a repo that was mid-listing simply starts again. Checkpoints live in `.pr-rla/cache/<window>/<runId>/` of the audit directory (not committed; `verify` never reads them).
- **The run id** is the SHA-256 of the registration, the resolved repo list (with ids), the registered repos found gone, the pr-rla version and the provider's identity, together with the run's start time and the listing it recorded then. `--resume <runId>` (a prefix of 8 or more digits is enough) refuses if any input differs, and says which, or if the run's header was edited. Running `freeze` again with the same inputs continues the newest such run too. `--force` starts over; `--force --resume <runId>` continues a stopped re-freeze.
- **Byte-identical.** The run keeps the time it started. That is the manifest's `frozenAt`, the instant reviews are read as of, so a killed and resumed freeze writes the same manifest as an uninterrupted one. The commitment is signed when the run finishes, because its timestamp tokens must agree with its signed time within 10 minutes and a pooled freeze can take hours; `verify` accepts a commitment dated at or after the manifest's `frozenAt` and checks both against the window and the seed round.
- **Before R.** Freeze refuses to start once seed round R has published, or when R is less than the timestamp authorities' 5-minute retry deadline away (the commitment's tokens could then be issued after R). It checks again when the listing ends (a single repo too) and right before it writes, so nothing is written after R; the checkpoints are kept.
- **Checkpoints are checked again.** A resumed run re-checks each checkpoint against the provider contract (in the window, from that repo, well formed) and against the digest it was written with; one that fails is listed again. A checkpoint that records a repo of a list as gone is probed again: still gone, its evidence stands; there, it is listed. The run id covers the run's start time and what it recorded at the start, so an edited `run.json` is not resumed. A re-freeze with `--force` that stops prints `pr-rla freeze --force --resume <runId>`.
- **GitHub's secondary rate limits** may come as a 403 that says so only in its body. The broker, the one retrier, treats that as a rate limit and waits as GitHub documents: at least a minute, then twice as long each time (1, 2, 4, 8, 15 minutes), then it gives up and the freeze stops resumable (exit 4).
- **Not computed for a pool:** the provider-native counts `freeze` prints next to a single repo (a search figure per author), because they cost requests per repo and carry no claim.

## Predicting the cost: `--estimate`

```sh
pr-rla freeze --dry-run --estimate
```

(`--estimate` implies `--dry-run`; it works before anything is registered.) Each repo is probed with the first page of what `listChanges` reads, and the provider extrapolates: for GitHub, the head, the newest page of closed PRs plus one from the middle of the list when it is longer, and one page of history. At most 200 repos are probed (every k-th, in repo order) and the rest are scaled. The predicted requests are then replayed through a fresh rate governor with the broker's budgets: the published-limit defaults, any `rate_limits:` override, and any limit the server reported while probing. The output of a real, read-only run on the public GitHub org `navikt` (a 223-repo subset), recorded 2026-11-04 (trimmed; BUILD-NOTES, "Bolt 9 (U8)"):

```output
estimate: 223 repos (probed 200 of them, every 1.1th, and scaled)
  requests: ~1,102 = 33 listing + ~1,069 for the repos (~446 REST, ~623 GraphQL); the probes already spent 600
  wall time: ~3 min at 4 repos at a time (bound by request latency, 656 ms each: 3 min; the rate budget alone needs 0 s)
  budget api.github.com: the server reports 5,000 requests per window (4,502 left); the estimate paces to that
  ...
```

and the freeze it predicted printed `freeze: 223 repos · 223 listed now, 0 from checkpoints · 1102 requests (623 GraphQL) · 3 min 43 s`.

On the synthetic 40-repo org of the test suite the estimate lands within ±5% of the actual request count and within ±30% of the actual wall time over 18 orgs (6 seeds at 3 sizes, 2026-11-04); the bounds the design asks for are ±20% and ±50%, and the tests assert them on 4 of those orgs. It also warns when the predicted wall time exceeds the time left before R publishes. A provider without `estimateRequests` prints no figures and says so. The estimate is a prediction from first pages: how evenly a window's activity is spread decides how close it is, and a retried request counts again.

## What `verify` does with a pool

Check 2 holds the manifest to the registered set without any network: the registered repo, exactly the registered list (a listed repo may be recorded gone instead), or only repos inside the registered rule or registered by id; a rule registration that records its `registeredRepos`, every one either in the manifest or recorded gone; a listing that agrees with itself (its exclusions follow from the attributes it records, every repo it shows the rule matching is in the pool); a `headEvidence` record about the manifest's own repos and heads; sorted and unique; and every change from a listed repo. Check 5 re-lists the owner, matches each repo by id first and by path second, rebuilds each from its recorded head, compares that with the window as the branch's current head shows it, reads each branch's push log, and diffs.

**The frozen head is held to the push log**, which the SCM records as the branch moves; never to commit dates or the shape of the history, which the pusher sets. For each repo the log either proves the head (it was the branch's tip at some instant from the manifest's `frozenAt` until seed round R published, and everything on the branch when the window closed is reachable from it), disproves it, or gives no evidence (no `pushLog`, the log cannot be read, it no longer reaches back to the window's close, or it has a gap). After an update the SCM does not call a fast-forward (a force push), verify checks that the branch's tip at the window's close is an ancestor of the frozen head (on its first-parent history, else by listing the window from that tip). A pull request merged in the window whose merge commit the frozen head does not reach FAILs whatever the log says (the stopgap).

`verify` prints **VERIFIED** only when every check passed or warned. It prints **INCOMPLETE** and exits **6** when nothing failed but part of the population could not be rebuilt, or its completeness could not be established; `--json` has `verdict: "INCOMPLETE"` and `ok: false`.

| Situation | Check 5 |
|---|---|
| A repo that matches the registered rule now, was not in the freeze's listing, and has changes in the window | **INCOMPLETE** `… it may have been transferred in after freeze, and provider X gives no transfer events …` (no built-in provider exposes transfers to a read token) |
| A repo the freeze's own listing says the rule matched, not in the manifest, with changes in the window | **FAIL** |
| The same repo, but the SCM says it was created after the window closed | PASS, with a line saying it cannot hold a window landing |
| The same repo, no creation time given, and no change in the window now | PASS, with a line saying so |
| A registered repo missing from the manifest, or recorded gone but there, with changes in the window | **FAIL** |
| A repo renamed (or transferred) after freeze | PASS: it is matched by its id and rebuilt under its new name |
| A repo excluded at freeze by its archive state alone, with changes in the window, in a prospective audit or created after the registration | **FAIL**: an archived repository is read-only, so it was archived after those changes, and archiving it took them out of the pool |
| A repo excluded at freeze by its name or visibility, with changes in the window, created after the registration (or with no creation time from the SCM) | **INCOMPLETE**: it could not be registered, and whether it was excluded when its changes landed is unverified |
| Any other repo excluded at freeze or now only by an attribute its owners can change (archived, visibility, name), not registered, with changes in the window | **WARN**, one line for all of them with the counts and a few names; each repo's line is printed with `verify --verbose` and is in `--json` (`checks[].verbose`). A retrospective audit cannot tell whether the change came before registration |
| A repo the freeze's listing records as a fork (or not the owner's) that is not one now, with changes in the window | **INCOMPLETE** |
| The registration's token could not prove it saw every private (or internal) repository, or the registration does not record it | **INCOMPLETE** `the registered repo set cannot be shown to hold every private repository under X: …` |
| A manifest repo that is gone (its metadata answers 404) | **INCOMPLETE** `X: gone: … HTTP 404 (deleted, or hidden from this token): its n changes in the manifest were not rebuilt` |
| A manifest repo the token cannot read (403 on its metadata) | **INCOMPLETE** `X: no access: …`, worded differently from gone |
| A rate limit or an outage while listing a repo | **INCOMPLETE** `X: could not be listed (…): a rate limit or an outage, not a missing repository; run verify again` |
| The rule admits private or internal repos and the provider cannot prove this token sees them all (a fine-grained token, a member who is not an owner, a provider without `listingVisibility`) | **INCOMPLETE** `cannot establish that this token sees every private repository under X: <reason> (the freeze listed n)` |
| The owner cannot be re-listed | **INCOMPLETE** `cannot re-list the repositories under X` |
| The verifier's token is refused (401), or a listing fails while the verifier's own access is failing too (the owner listing, what its token is) | **INCOMPLETE**: the verifier's access, not the audit, is at fault |
| A frozen head the push log shows was not the branch's tip at freeze | **FAIL** `the frozen head X was not the default branch's tip at freeze: the push log shows …` |
| A pull request merged in the window whose merge commit the frozen head does not reach | **FAIL** |
| Changes that were on the branch when the window closed, not reachable from the frozen head (the branch was force-pushed after the window closed) | **FAIL** |
| A pull request merged in the window, on the branch now, missing from the frozen head's history | **FAIL** (the frozen head hides window landings) |
| A commit dated in the window that is on the branch now but not reachable from the frozen head, which the push log proves | PASS, with a line: it reached the branch after the window closed, so it is not in the population (FR7.2). This covers a merge pushed after freeze, a commit pushed straight onto the frozen head, a `git pull` merge and a fast-forward of older local work |
| The same, with no push-time evidence | **INCOMPLETE**, never PASS and never FAIL |
| A frozen head the repository does not have (404 on the commit) | **FAIL** `frozen head X not found …; the repository itself exists` |
| A repo's changes differ from the manifest's | **FAIL**, as for a single repo |

Single repositories get the same per-repo rules: a frozen head the push log disproves FAILs, a moved head is held to the push log as above, and a repo that is gone or unreadable is INCOMPLETE (exit 6) where `verify` used to stop with the provider's error.

## Limits

- **What a retrospective pooled audit cannot detect: attribute changes made before registration.** The registered repos are the ones the rule matched when it was registered. In a retrospective audit (registered after the window opened) a repo archived, made private or renamed out of the rule during the window, before registration, is not among them; `verify` WARNs with its change count but cannot tell when the change was made. A prospective audit (registered before the window opens) has no such gap: every repo the rule matched before the window is in the pool, whatever happens to it later.
- **What the verifier sees.** Without the provider's proof that the token sees every private and internal repository, `verify` is INCOMPLETE for them: a hidden repo is indistinguishable from no repo. Only the GitHub built-in can give that proof: for an org owner with a classic `repo`-scoped token (an OAuth App token also needs the org's `total_private_repos`, which takes `admin:org`), for a GitHub App installation on all repositories, or for the token's own account.
- **Direct pushes are still dated by their committer date.** The window is applied to it, as the providers' limitations say: a direct push given a date outside the window is outside the population. What changed in P3 is how `verify` places a commit the frozen head does not reach: by the push log, never by the date. Without a push log (Bitbucket Cloud and Data Center, a token that cannot read it, a log past its retention) such a commit makes the repo INCOMPLETE.
- **The push log's retention.** GitHub documents none for its repository activity; on 2026-11-04 `github/gh-aw`'s log began at its branch's creation (2025-08-12) and `torvalds/linux`'s on 2023-03-07, so updates before about March 2023 are not in it. GitLab removes project events older than three years, does not say whether a push was forced, and records a push of many refs at once without them (a gap, so no evidence). A verify run after the log has lost the window's close has no evidence for a moved head.
- **Force pushes inside the window** take commits off the branch; they are not in the population, and `verify` says how many such updates the log shows. Commits removed that way are not recovered.
- `verify` of a pool lists every repo again (4 at a time), reads each repo's push log (one request, more for a branch updated over 100 times since the window closed), lists a repo twice when its branch moved since freeze (from the frozen head and from the current one), three times after a force push the first-parent check cannot settle, lists every repo excluded only by an attribute its owners can change (archived, private, renamed) to count its window changes, and is not resumable: it takes about as long as the freeze did, or longer for an org with many archived repos, and a rate limit that stops it makes it INCOMPLETE until it is run again.
- **Transfers in.** A repo transferred to the owner after freeze is not in the pool, rightly; with window changes it makes check 5 INCOMPLETE, because no built-in provider can tell a transfer from a freeze listing that left the repo out: neither the repository listing nor the push log records a transfer, and the built-ins read no audit log (GitHub's organization audit log has an API only for organizations on GitHub Enterprise Cloud).
- **Status before freeze** does not compute N for a pool: it would list every repo, about as many requests as the freeze. `pr-rla freeze --dry-run --estimate` predicts the cost and `pr-rla freeze --dry-run` counts N.
- **The estimate's sampling.** Probing every k-th repo of an org with heavy-tailed activity can miss its largest repos: on six synthetic 40-repo orgs, probing every 4th repo was off by up to 34% in requests and every 2nd by up to 10% (and up to 57% in wall time when the rate budget binds), 2026-11-04. With every repo probed (any org up to 200 repos) the same orgs stayed within ±5.2% of requests and ±29% of wall time (±11% when request latency binds); 200 of 240 repos probed stayed within ±3.1% and ±13.2%. The tests assert ±20% and ±50% on those cases.

- The estimate and `--resume` are verified on a synthetic org and on one public org (`navikt`, a 223-repo subset, read-only); a full `freeze` of a real org, with timestamp tokens, has not been run.
- `listRepos` for `bitbucket-data-center` is unverified against a live server, as that provider is. GitLab and Bitbucket Cloud `listRepos` are tested on hand-made responses only.
- A repo list carries no repository ids: the SCM is not asked. Only a rule records them.
- Bitbucket Data Center's repository list does not carry the default branch, so `listRepos` leaves it empty; the manifest records the branch `listChanges` walked.
