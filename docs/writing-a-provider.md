# Writing a provider

A provider turns one source-control system into the normalized `ChangeRecord`s the audit core works on. GitHub, GitLab, Bitbucket Cloud and Bitbucket Data Center are built in. Anything else is a plug-in that pr-rla loads from `.pr-rla.yml`.

This guide walks through a complete external provider: [`examples/providers/gitea/`](../examples/providers/gitea/), a standalone package named `pr-rla-provider-gitea` for Gitea and Forgejo (Codeberg). It imports only the public SDK, `pr-rla/provider`; its tests use only `pr-rla/testing`. Nothing in pr-rla's core imports it, and a test enforces that.

## 1. The contract

Everything a provider needs is exported from `pr-rla/provider` (`src/sdk/provider.ts`):

```ts
export default defineProvider({
  providerApiVersion: 1,                      // the SDK version this provider was written for
  name: "gitea",                              // lowercase; also the scheme of every change id
  create(options, ctx): ScmProvider { … },    // options come from .pr-rla.yml
});

interface ScmProvider {
  apiVersion: number;                         // 1
  name: string;
  listChanges(req: ListChangesRequest): Promise<ListChangesResult>;
}
```

- `req`: `{ repo, window: { opensAt, closesAt }, kinds, signal? }`. The window is `[opensAt, closesAt)`, in UTC.
- `ctx`: `{ cwd, env, log, fetch, sleep? }`. Use **`ctx.fetch` for every request and `ctx.sleep` for every wait**. The conformance kit injects both: it counts requests, injects faults and records waits.
- The result is `{ changes, defaultBranch, limitations, diagnostics? }`. `limitations` are copied into every manifest; `diagnostics` are printed by `freeze`.

**The population rule.** `listChanges` returns every change that reached the default branch in the window:

1. each PR merged into the default branch, with `merged_at` in the window, as `kind: "pull_request"` with all its reviews;
2. each default-branch commit dated in the window that no merged PR into that branch brought in, as `kind: "direct_push"` with `reviews: []` and `mergedBy: null`.

Never return one commit for two changes. The commits a PR brought in depend on the merge strategy, and none of them is a direct push:

| Strategy | Commits that land | Typical API field |
|---|---|---|
| Merge commit | the merge commit + the PR's own commits | `merge_commit_sha` = the merge commit |
| Squash | one new commit | `merge_commit_sha` / `squash_commit_sha` |
| Squash + merge commit (GitLab) | the squash commit + a merge commit | both |
| Rebase | new copies of the PR's commits (new SHAs) | the last copy, or nothing |
| Fast-forward | the PR's commits, unchanged | the head, or nothing (GitLab: `merge_commit_sha: null`) |

Each `ChangeRecord` (validated by `assertChangeRecord`):

| Field | Rule |
|---|---|
| `id` | `<name>:<repo>#<number>` for a PR, `<name>:<repo>@<sha>` for a direct push |
| `repo` | exactly `req.repo` |
| `mergeSha` | the commit that landed: lowercase hex, 40 or 64 characters |
| `mergedAt` | ISO-8601 UTC (`…Z`): merge time, or the commit date for a direct push |
| `author`, `mergedBy` | `{ login, kind: "human" \| "bot" }`; bot logins end in `[bot]`; `mergedBy` is `null` for direct pushes |
| `reviews` | `{ author, state, submittedAt }` with `state` in `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` |
| `changedLines` | raw additions + deletions as the SCM reports them |
| `labels` | strings, sorted |

**Optional fields (phase 3, same API version 1).** A provider written for phase 2 keeps working without any of them; set the ones your SCM can provide:

| Field | Meaning |
|---|---|
| `Actor.id` | the SCM's stable account id (GitHub `databaseId`, GitLab user id, Bitbucket `uuid`, Gitea user id). Selectors match it as `id:<value>`, and `verify` uses the manifest's ids so a renamed account stays the same actor. A direct push's git identity (`git:<email>`) and `ghost` have none |
| `ListChangesRequest.head` / `ListChangesResult.headSha` | walk default-branch history from `req.head` when it is given, and report the head you walked. `freeze` records it; `verify` passes it back, so a commit dated in the window but pushed after freeze does not show up. Without it, `verify` says so in check 5 |
| `ChangeRecord.landedVia` | for a direct push that a pushed merge commit brought in through a non-first parent (a release branch merged by a push), that merge's SHA. `selector.direct_push_via_merge: exclude` drops such records |
| definition `reviewGranularity` | `"submission"` (one review object per submitted review: GitHub, Gitea) or `"first-comment-per-user"` (one `COMMENTED` per non-author user, at their first comment: GitLab, Bitbucket). Recorded in the manifest; absent means `"submission"` |
| definition `populationOptions` | the option keys that change the population, e.g. `["base_url", "bots"]`. The registration hashes them; a verifier with other values FAILs check 5 |
| definition `reportsLandedVia` | `true` if you set `landedVia`; otherwise `register` warns that `exclude` has no effect |

These three definition fields are data. When the provider runs isolated (section 7), pr-rla reads them from the plugin host's `describe` message, never by importing the plugin in its own process.

A `DISMISSED` review is a decision that no longer stands: a dismissed review, a withdrawn approval, an approval reset by a push. A revoked approval must never come back as `APPROVED`.

**`describeChange` (optional, phase 3, same API version 1).** `pr-rla draw-context <n>` and the MCP `draw_context` tool show a reviewer one drawn change. Without this method they show the manifest's fields and the URL. With it:

```ts
describeChange(change: ChangeRecord, opts?: { signal?: AbortSignal }): Promise<ChangeDescription>;

interface ChangeDescription {
  changeId: string;                   // change.id
  title: string;
  body: string;                       // a direct push: the commit message after its first line
  files: { path: string; previousPath?: string; status: "added" | "modified" | "removed" | "renamed";
           additions: number; deletions: number; patch: string | null }[];   // patch: the unified hunks, null when the SCM has none
  gitattributes: string | null;       // the root .gitattributes at change.mergeSha, or null when there is none
  checks: { name: string; state: "success" | "failure" | "neutral" | "pending" | "skipped" | "unknown"; url: string | null }[];
  truncated: boolean;                 // the SCM listed fewer files than the change has
  attributes?: {                      // optional: what pr-rla needs to drop linguist-generated files
    baseSha: string;                  //   the commit the change was applied to
    base: Record<string, string | null>;   //   .gitattributes by directory ("" the root) at baseSha: text, or null when absent
    head: Record<string, string | null>;   //   the same at change.mergeSha
  };
  checksTruncated?: boolean;          // optional: the SCM listed fewer CI results than there are
}
```

- Read only, through `ctx.fetch`, like every other request; behind the broker in read-only mode anything else is refused. For a PR, report the CI results at its head commit (what the merger saw); for a direct push, at the commit. Stop when `opts.signal` aborts (a stopped job); every request through `ctx.fetch` is aborted with it too.
- **Generated files are pr-rla's decision, from your `attributes`.** Return every file, generated or not. A file is dropped (under the registration's `exclude_generated`) only when the `.gitattributes` of the change's **base** commit and of its **landed** commit both mark it `linguist-generated`, with git's own rules (`src/core/generated.ts`, checked against `git check-attr`); never a `.gitattributes` itself; and nothing at all when the change touches any `.gitattributes` or its file list is truncated. So a change cannot mark its own files generated. The base is a PR's target-branch commit (its base SHA) or a direct push's first parent. Read the root file at both commits, and for every file the root marks generated at both, the `.gitattributes` of each directory above it, at both (a directory missing from a map counts as unread: files below it are shown). The built-ins use `readChangeAttributes` (`src/providers/attributes.ts`) for this; without `attributes`, nothing is dropped.
- **Say when a listing is cut, with evidence.** Set `truncated` when the SCM says it listed fewer files than the change has (GitHub's 3,000-file cap, a commit's `stats` above the listed lines, GitLab's `too_large`, `collapsed` and `changes_count`), and `checksTruncated` for CI results (a `total_count` above the list, a page cap). Never report `false` when you could not tell. Follow every page, but stop at a page the server repeats and at a page cap (the built-ins use `followPages`, 100 pages).
- The core caps patches and text (a line-boundary prefix of a patch that does not fit, 8 KiB of body, 1 KiB of title, 512 bytes of a name, 5,000 files, 1,000 checks). A body, a patch, a file name, a check name, the author's name and labels are never trusted: the core fences all of it as untrusted text, and escapes its control characters, before an assistant sees it.
- The core validates the result with `changeDescriptionProblems` (exported from `pr-rla/provider`), so a malformed description, or none, fails `draw-context` with the problem named, whatever process it came from. Throwing an error to mean "no description" is not honoured from a plugin: the call fails, and the error's text reaches the caller only as untrusted text.
- The built-ins show the calls per SCM (`src/providers/*/describe.ts`): GitHub `pulls/{n}` and `/files`, `contents/<dir>/.gitattributes?ref=`, `check-runs` and `status`; GitLab `merge_requests/:iid/diffs`, `repository/files/<path>/raw`, `pipelines?sha=`; Bitbucket Cloud `diffstat` and `diff`, `src/{sha}/<dir>/.gitattributes`, `commit/{sha}/statuses`; Data Center `changes` and `diff`, `raw/<dir>/.gitattributes?at=`, build status. `pr-rla/http`'s client has `getText()` for a body that is not JSON (a raw file, a diff), returning null on 404.

## 2. Step by step: the Gitea provider

The numbers below match the comments in [`index.mjs`](../examples/providers/gitea/index.mjs).

**Package.** `package.json` names the package `pr-rla-provider-gitea`, declares `"type": "module"`, and lists `pr-rla` as a **peer dependency** (`"~0.1.0"`). The user's pr-rla is then the one that loads it, and `pr-rla/provider` resolves to that copy. For development inside this repository, `devDependencies` links the checkout (`"pr-rla": "file:../../.."`); run `npm install` once in `examples/providers/gitea/`.

**Declare the API version you wrote against.** `providerApiVersion: 1`, as a literal. Do not import `PROVIDER_API_VERSION` into it: a future pr-rla 2.x would then make this plugin claim version 2 without anyone having checked it.

**1. HTTP.** Every request retries network errors, 5xx, 429 and truncated bodies with exponential backoff. `retryWait()` honours `Retry-After`, the `RateLimit: "baseline";r=0;t=600` header Codeberg sends, and `X-RateLimit-Reset`. Waits go through `ctx.sleep`, so the kit's fault check runs in milliseconds.

**2. Normalization.** These are pure functions, exported so they can be unit-tested:
- `actor()`: Gitea has no bot flag. The built-in Actions user (id -2: `gitea-actions`, `forgejo-actions`), logins ending in `[bot]`, and logins listed in `options.bots` are bots. A deleted user (null, or id -1) is `ghost`, human.
- `reviews()`: `APPROVED` → `APPROVED`; `REQUEST_CHANGES` → `CHANGES_REQUESTED`; `COMMENT` → `COMMENTED`. A review with `dismissed: true` → `DISMISSED`. `PENDING` and `REQUEST_REVIEW` are not reviews yet, so they are dropped.
- `rebaseKey()`: author e-mail, author date and first message line. A rebase keeps all three and changes the SHA.

**3. `listChanges`:**
- **(a) PRs.** `GET /repos/{o}/{r}/pulls?state=closed&sort=recentupdate`, newest update first, back to a day before the window. Then the head of the list is read again, because a PR updated during the walk jumps to page 1 and page-number pagination could skip it. A PR merged into another branch is excluded and counted. In-window PRs are re-read one by one, for two reasons found on Codeberg:
  - the list endpoint returns `merged_by: null`;
  - some merged PRs report `additions = deletions = changed_files = 0`. forgejo/docs #2219 is one: its files list 7 + 3 lines. When `changed_files` is 0 the provider sums `/pulls/{n}/files` instead.
- **(b) History.** Pin the head (`/branches/{b}`), then walk `/commits?sha=<head>` newest first (all parents, in git's date order) until a whole page is older than the window. Forgejo ignores `since`/`until` on this endpoint, so the provider filters by date itself.
- **(c) Attribution.** Every PR merged into the default branch *since the window opened* can claim commits, including PRs merged after it closed: a PR fast-forwarded the next morning brings commits dated inside the window, and those are not direct pushes. Claims happen in three steps:
  1. `merge_commit_sha` claims a commit without any request;
  2. while some in-window commit is still unclaimed, the provider reads the next PR's commit list and claims by SHA, or by `rebaseKey` for rebased copies;
  3. whatever is left is a direct push.

**Limitations and diagnostics.** List what a manifest reader must know, such as "the window applies to the committer date". Report counts that explain the population, such as PRs into other branches and commits linked by rebase key.

## 3. Test it with the conformance kit

`pr-rla/testing` is framework-agnostic: `runProviderConformance` returns a report, and `assertProviderConformance` throws on failure. Pass a **factory**, so that each run gets a fresh provider wired to the kit's harness:

```js
import { assertProviderConformance } from "pr-rla/testing";
import gitea from "pr-rla-provider-gitea";

await assertProviderConformance(
  (fixture, harness) => gitea.create(options, harness.context({ fetch: replayFetch() })),
  [{
    name: "forgejo/docs 2026-10-01..07",
    request: { repo: "forgejo/docs", window, kinds: ["pull_request", "direct_push"] },
    http: true,                                   // requests must go through the harness
    expect: {
      ids: [...],                                 // exact set (make the data span pages)
      pullRequests: [...], directPushes: [...],
      prCommits: { "gitea:o/r#4": [ffSha1, ffSha2] }, // never returned as direct pushes
      mergeShas: { "gitea:o/r#2": lastRebasedSha },
      reviewStates: { "gitea:o/r#7": ["CHANGES_REQUESTED", "APPROVED"] },
      bots: ["renovate-bot[bot]"], humans: ["alice"],
      changedLines: { ... }, minPages: 10,
    },
    rateLimitFault: { status: 429, headers: () => ({ ratelimit: '"baseline";r=0;t=45' }), minWaitMs: 45_000 },
  }],
);
```

It checks: `api-version`, `normalization`, `window-and-kinds`, `classification`, `merge-strategies`, `no-double-counting`, `stable-sorted-ids` (two runs, identical records), `review-state-mapping`, `actors`, `bot-detection`, `pagination`, `kind-filtering`, `transient-faults`, and four checks for the optional fields: `pinned-head`, `actor-ids`, `review-granularity` and `revoked-approval` (below). `transient-faults` re-runs the fixture with:
- a 503 on the first request;
- a 429 with `Retry-After: 7`;
- your SCM's own rate-limit response (`rateLimitFault`, or a 502 if none is given);
- a 503 on the last request.

The provider must retry each one, wait at least as long as the headers say, and return exactly the same records.

The four checks for the optional fields skip, and say why, when there is nothing to check:
- `pinned-head`: a provider that reports `headSha` must honour `request.head`. A fixture's `pinnedHead: { head, late }` serves a branch with commits pushed after `head`: unpinned, the `late` commits must come back; pinned, they must not, and nothing else may change.
- `actor-ids`: once any actor has an `id`, every account actor must (a direct push's author may lack one), with one id per login, stable across two runs; `expect.actorIds` pins specific ones.
- `review-granularity`: pass your definition as the third argument, `assertProviderConformance(factory, fixtures, { definition })`. Its declaration must match `expect.reviewGranularity`, and under `first-comment-per-user` no user may have two `COMMENTED` on one change.
- `revoked-approval`: `expect.revokedApprovals: { "<change id>": ["<login>"] }` lists approvals your data shows withdrawn; none may come back as `APPROVED`.

**Behind the fetch broker.** In a real run `ctx.fetch` is pr-rla's fetch broker: every request passes its read-only guard (a provider may send only `GET`, `HEAD` and GraphQL queries), a per-host rate budget shared with every other caller, and a 30 s timeout. A request made as plain `fetch(url, init)`, as this example makes them, gets one attempt and the provider retries it, as above. A provider may instead hand retries to the broker by passing `destination: "scm"` (and optionally `retry: { maxRetries, acceptJson }`) in the init, as the built-in providers do; the kit's harness then retries that request with the broker's policy, and the provider passes by recovering through it.

For your own retries outside the broker, `pr-rla/http` exports the built-ins' retrying JSON client, `createJsonClient({ base, headers, fetch, sleep, log, maxRetries })`, versioned on its own (`HTTP_HELPER_VERSION`, now 1). Behind the broker, construct it with `maxRetries: 0`: it then hands every request's retries to the broker.

Two optional definition fields tell the broker what the provider reaches: `hosts(options)` (the hosts it contacts) and `credentials` (`[{ env: "GITEA_TOKEN", hosts: ["codeberg.org"] }]`). A header value `prrla-cred:GITEA_TOKEN` is then replaced with the token for those hosts only; a request to any other host carrying it is refused unsent. **Declare both:** an external provider runs isolated by default (section 7), where it may contact only the hosts it declared and receives each declared credential only as its placeholder.

**A self-hosted server.** A credential's `hosts` are a fixed list, but a self-hosted Gitea's host is whatever the user configures. Name the option that holds the server's URL in `hostFromOption` (also optional, still API version 1): `{ env: "GITEA_TOKEN", hosts: ["codeberg.org"], hostFromOption: "base_url" }`. When the options set `base_url`, the token may go to that URL's host instead of `hosts`, and only to an `https:` URL (an `http:` or malformed value grants it no host, so the token is refused unsent rather than sent in clear text); without `base_url` it keeps `hosts`. pr-rla computes the host from the option itself, never by asking the plugin. `pr-rla plugin add` prints and records the result (`GITEA_TOKEN -> gitea.example.com (the host of option base_url)`) in `pr-rla.lock.json`, every load recomputes it and refuses a host the lock does not grant (so a changed `base_url` needs `pr-rla plugin lock`), and the registration commits to the option through its options hash (and, when the option is in `populationOptions`, as `base_url` is for Gitea, a verifier with another value FAILs check 5).

Two kinds of fixture are worth having:
- **Recorded real responses.** `node scripts/record-fixture.mjs ./examples/providers/gitea/index.mjs forgejo/docs 2026-10-01 2026-10-07 out.json '{"base_url":"https://codeberg.org"}'` records read-only responses. It trims them to the fields pr-rla reads, scrubs personal e-mail addresses and never records tokens. The example ships one: [`fixtures/codeberg-forgejo-docs-2026-10-01.json`](../examples/providers/gitea/fixtures/codeberg-forgejo-docs-2026-10-01.json).
- **A synthetic graph** with every merge strategy, because real windows rarely contain them all. pr-rla's own tests render one shared history (`test/helpers/scm-scenario.ts`) through a fake server per SCM (`test/helpers/fake-gitea.ts` for this provider).

Run the example's own test: `cd examples/providers/gitea && npm install && npm test` (node:test; build pr-rla first). pr-rla's suite also loads it from `.pr-rla.yml` through the registry (`test/gitea-example.test.ts`).

## 4. Use it

```yaml
provider:
  use: ./providers/gitea/index.mjs      # a path, relative to .pr-rla.yml
  options: { base_url: https://codeberg.org, bots: [renovate-bot] }
repo: forgejo/docs
```

or, once installed in the audit repo, `use: pr-rla-provider-gitea`. A package name is resolved from the audit repo's `node_modules`. The module's default export (or a named `provider` export) must be the definition.

Before the first run, lock it: `pr-rla plugin add ./providers/gitea/index.mjs` prints what it is about to trust (version, npm integrity, a tree hash of the files, hosts and credentials) and writes `pr-rla.lock.json`, which you commit with the audit. Until then every command refuses the plugin. After a reviewed change, `pr-rla plugin lock <use>` re-hashes it. `pr-rla plugin check <use>` runs the conformance kit through the plugin host on the fixtures your package.json lists (`"pr-rla": { "conformance": ["fixtures/…json"] }`), as this example does.

## 5. API versioning

- `PROVIDER_API_VERSION` (now 1) changes only on a breaking change to anything exported by `pr-rla/provider`. pr-rla lists the versions it can load in `SUPPORTED_PROVIDER_API_VERSIONS`. A definition or instance that declares another version is refused with `ProviderApiVersionError`: `provider "x" declares providerApiVersion 2; this pr-rla supports 1. Upgrade pr-rla or use a provider release built for API 1.`
- Additive, optional changes keep the version. `ProviderContext.sleep` was added in pr-rla 0.2 this way: old providers ignore it, and new ones fall back to a timer when it is absent.
- Declare a peer range that matches the API you tested against (`~0.1.0`), and release a new major when you move to a new provider API.

## 6. Publishing as `pr-rla-provider-<name>`

Name the package `pr-rla-provider-<name>`, add the `pr-rla-provider` keyword, ship only the runtime files (`"files"`), and keep `pr-rla` a peer dependency. (This example is `"private": true` and is not published.) Include in the package:
- your recorded fixtures and the conformance test, so users can re-run them;
- a list of limitations: what your SCM's API cannot tell you, such as the pusher.

## 7. Trust model

**An external provider runs out of process by default**, in pr-rla's plugin host: a child Node process under the permission model, which can read only its own files, cannot write files or start processes, and receives credentials only as `prrla-cred:<ENV>` placeholders that the fetch broker swaps for the secret on the declared hosts. On Node 22 and 24 it can still open its own network connections. [`docs/security-model.md`](security-model.md) has the details and the limits. `plugin add --trust full` runs it in pr-rla's process instead, with your environment and files, and every command then says so (`PLUGIN TRUST: full`).

Whichever way it runs, a provider *decides the population*. A provider that drops changes produces a manifest that its own re-run will "verify". `verify` rebuilds the population with the configured provider, so it can only catch tampering with the manifest, not a lying provider.

So treat a provider like any code you run with your credentials, and like part of the audit's evidence:
- **Pin it exactly.** Use an exact version in the audit repo's `package.json` (`"pr-rla-provider-gitea": "0.1.0"`, no range), commit the lockfile and install with `npm ci`, so the lockfile's `integrity` hash pins the bytes. Or vendor the file into the audit repo and reference it by path; then the git history of the audit repo pins it.
- **Review it** before registering an audit, and hand the auditor the provider version with the registration.
- **Give it the narrowest token:** a read-only token for one repository. pr-rla never needs write access to the SCM.
- **Know what is recorded.** Registrations and manifests record the provider's name, source, version, the lock's `treeSha256` over its files, an options hash and its trust. `verify` warns when the provider it loads differs from the registered one.
