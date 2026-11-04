# Contracts Between Units: pr-rla phases 3–4

**Stage:** Contract Design. Refines the draft's `03-application-design.md` §3–4 and the interfaces scattered through `05`.

Each contract has one owner, its shape, its failure behaviour and its version. These are the boundaries units build against in parallel. The integration mechanism inside one package is a typed function call, except where stated.

| § | Contract | Owner unit | Consumers | Mechanism | Version |
|---|----------|------------|-----------|-----------|---------|
| 1 | Plugin SDK (`pr-rla/provider`, `pr-rla/ledger`, `pr-rla/testing`, `pr-rla/http`) | U2a (`hosts`, `credentials`, `writePaths`), U3 (provider deltas, `populationOptions`), U4 (ledger deltas) | Built-ins, external plugins, core | Typed ESM exports | `providerApiVersion` 1, `ledgerApiVersion` 1, `HTTP_HELPER_VERSION` 1 |
| 1a | Read-only audit API (`pr-rla/api/read`) | U5 | `pr-rla-mcp` | Typed ESM export | `pr-rla` semver |
| 2 | Fetch broker (`ctx.fetch`) | U2a | Providers, ledgers, TimeEvidence, Beacon, TransparencyLog, PluginHost | In-process call | Internal; versioned with the package |
| 3 | Plugin host IPC | U2b | PluginRegistry ↔ child process | Length-prefixed JSON frames on the child's fd 3 | `pr-rla/ipc/v2` |
| 4 | MCP tools | U5 | Claude Code, Codex, Cursor | MCP over stdio | `pr-rla-mcp` semver; output schemas |
| 5 | Record schemas and the lock file | U1 (v2 in full), U2b (lock) | Every command, every verifier | Canonical JSON files in the audit directory | `pr-rla/<kind>/vN` |
| 6 | Checkpoint git transport | U4 | `pr-rla checkpoint --push`, CI | git subprocess | Internal |
| 7 | CLI exit codes and `--json` | U5 | CI, scripts, the MCP server | Process exit status and stdout | Compatibility table |

## 1. Plugin SDK

Every addition is optional within API version 1 (RQ18, ADR-007). A plugin written for phase 2 keeps working unchanged.

### `pr-rla/provider`

```ts
interface Actor {
  login: string;
  kind: ActorKind;
  id?: string;                 // stable account id (GitHub databaseId, GitLab id, Bitbucket uuid, Data Center id, Gitea id)
}
interface ChangeRecord {
  /* phase-2 fields unchanged */
  landedVia?: string;          // SHA of the direct-push merge commit whose non-first parent brought this commit in
  changedLinesUnknown?: true;  // the SCM truncated the diff (GitLab too_large/collapsed, Bitbucket Data Center truncated) and gave no stat: changedLines is a lower bound
}
interface ListChangesRequest {
  /* phase-2 fields unchanged */
  head?: string;               // walk history from this SHA (verify passes the manifest's headSha)
}
interface ListChangesResult {
  /* phase-2 fields unchanged */
  headSha?: string;            // the head the provider actually walked from
}
interface ProviderDefinition {
  /* phase-2 fields unchanged */
  reviewGranularity?: "submission" | "first-comment-per-user";   // absent means "submission"
  hosts?: (options: unknown) => string[];                         // hosts the broker allows for this plugin
  credentials?: { env: string; hosts: string[]; hostFromOption?: string; headers?: string[]; secret?: boolean }[];  // env vars it may receive, where (https origins) and in which extra headers they may be sent; secret: false = an identity
  populationOptions?: string[];                                   // option keys that change the population (FAIL on mismatch in check 5)
}
interface ScmProvider {
  /* phase-2 methods unchanged */
  listRepos?(set: RepoSetRule): Promise<RepoRef[]>;               // U8
  describeChange?(change: ChangeRecord): Promise<ChangeDescription>; // U5
  // U8 fix round (2026-11-04), all optional:
  estimateRequests?(req: ListChangesRequest): Promise<RequestEstimate>;
  describeRepo?(ref: { repo: string; id?: string }): Promise<RepoRef>;     // throws RepoUnavailableError(404) when gone
  listingVisibility?(set: RepoSetRule): Promise<ListingVisibility>;        // per visibility: provably complete, and why; P3: expected counts
  firstParentPath?(req: { repo: string; base: string; head: string }): Promise<{ sha: string; committedAt: string }[] | null>;
  // P3 (2026-11-04), optional: the branch's push log, newest first, back to the newest update at or before `since`
  pushLog?(req: { repo: string; branch: string; since: string }): Promise<{ events: { id: string; before: string; after: string; at: string; kind: "fast-forward" | "forced" | "created" | "deleted" | "unknown" }[]; limitations?: string[] }>;
}
// P3: ListChangesResult.unreachable?: string[]  (pull requests merged in the window whose merge commit headSha does not reach)
// P3: ListingVisibility.expected?: { visibilities, count, source }[]  (the SCM's own count, e.g. total_private_repos)
// P3: RetryHints.rateLimitBody?: string; RetryHints.blindRateLimitWaitMs?: number  (pr-rla/http; the broker honours them)
interface RepoRef { repo: string; id: string; defaultBranch: string; archived: boolean; fork: boolean; visibility: "public" | "private" | "internal"; createdAt?: string }
interface ChangeDescription {
  changeId: string;
  title: string;
  body: string;
  files: { path: string; status: "added" | "modified" | "removed" | "renamed"; additions: number; deletions: number; patch: string | null }[];
  gitattributes: string | null;          // .gitattributes at mergeSha, for linguist-generated
  checks: { name: string; state: "success" | "failure" | "neutral" | "pending" | "skipped" | "unknown"; url: string | null }[];
  truncated: boolean;
}
```

`head` and `headSha` live on the request and result, not on `ChangeRecord`. A `head` is a commit id (`^[0-9a-f]{40,64}$`): `buildPopulation` refuses anything else, `readManifest` refuses a manifest whose `repos[].headSha` is neither null nor one, and the built-in providers escape it in their history URLs.

**Size unknown.** A provider that cannot count a change's lines because the SCM truncated its diff, and has no stat field to count instead, sets `changedLinesUnknown: true` and never reports an undercount. A `max_changed_lines` stratum keeps such a change (it cannot be shown to exceed the limit); the funnel adds the step "of which size unknown (kept in the stratum)" with the count, and the provider reports a diagnostic. GitLab reads GraphQL `diffStatsSummary` first and falls back to the REST diffs only when GraphQL has none; Bitbucket Cloud's diffstat is complete; GitHub's additions and deletions are the SCM's own stat.

**Review rule (the selector).** A review counts as a human decision (so the change is not in the `no-human-review` stratum) only if it is an APPROVED or CHANGES_REQUESTED review by a non-bot account, submitted at or before the change's `mergedAt`, whose reviewer is not the author (compared by `Actor.id` where both have one, by login otherwise). A review whose time the SCM does not give (`Review.timeUnknown: true`, optional, P1: a GitLab approval without `approved_at`, a reviewer state whose only time is its review request, a Bitbucket final status with no activity of its own) never counts: it cannot be shown to precede the merge. Reviews that do not count stay on the change record. Known semantic limit: an approval is not tied to the commit it approved, so an approval of an earlier head commit still counts (stale-commit approval); GitHub's `dismiss stale approvals` and GitLab's approval resets show up as `DISMISSED`, nothing else is inferred.

**Caps.** A provider never truncates a connection silently: it pages it, or refuses and fails loudly. The built-ins page a PR's labels, a commit's associated PRs and a GitLab MR's approvers and reviewers, read the rest of a commit with more than two parents, and refuse one with more than 100.

**Failure behaviour:**
- A provider that ignores `head`, or returns a different `headSha` than requested, is not an error. `verify` adds the check-5 detail `provider does not pin history; direct pushes dated in the window but pushed after freeze will show as extra`.
- A provider without `describeChange` gets a context built from manifest fields only, with `files: []` and a note.
- A provider without `listRepos` cannot be used with a `rule` repo set: `register` refuses and names the provider.

**Conformance-kit additions** (`pr-rla/testing`):
- `pinned-head`;
- `actor-ids` (if any actor has an `id`, all must, and ids are stable across two runs);
- `review-granularity`;
- `revoked-approval` (a revoked approval never comes back as `APPROVED`).

**Conformance-kit honesty (ledger/selector fix round).** The provider kit fails an empty fixture list; marks a check skipped (not ok) when the fixture declares nothing for it (`classification`: pullRequests/directPushes; `merge-strategies`: prCommits/mergeShas; `review-state-mapping`: reviewStates/reviewers; `actors`: actors/changedLines; `pagination`: ids/minPages); and asserts completeness in `window-and-kinds` against `expect.ids` (or pullRequests plus directPushes), failing when the fixture states neither. `no-double-counting` inspects the returned data, so it always runs.

### `pr-rla/ledger`

```ts
type ProvenanceLevel = "self-asserted" | "account" | "presence";
interface VerdictEvent {
  /* phase-1 fields unchanged */
  provenance?: {
    level: ProvenanceLevel;
    source: "verdict-signature" | "scm-label-event" | "jira-field-change" | string;  // "git-commit", "git-signed-commit": reserved, no longer produced (U9 fix round)
    actorId?: string;
    viaApp?: string | null;     // GitHub performed_via_github_app; non-null is ineligible by default
    eventId?: string;
    signer?: string;            // allowed-signers principal, for verdict-signature
    keyFingerprint?: string;    // verdict-signature: SHA256:… of the signing key
    counter?: number;           // verdict-signature with a FIDO key: the authenticator's counter
  };
  registrationSha256?: string;  // git-file line: the registration a signed verdict names
  sshsig?: string;              // git-file line: the per-verdict SSHSIG, base64 without armor (below)
}
interface LedgerHistoryEvent {
  id: string;                   // the tracker's event id
  at: string;                   // server time, ISO 8601 UTC
  actor: Actor;
  action: "add" | "remove" | "edit" | "delete-issue" | "transfer";
  label: string | null;
  draw: number | null;
  raw?: unknown;
}
interface Ledger {
  /* phase-1 methods unchanged: publishDraws?, readVerdicts, verifyIntegrity? */
  readHistory?(): Promise<LedgerHistoryEvent[]>;   // canonical event list for checkpoints
}
interface LedgerIntegrityReport {
  /* phase-1/3 fields unchanged: ok, findings, tamperTrail, warnings? */
  location?: string;            // P4: the file's path from its git toplevel, as walked; only the built-in git-file's counts (check 7 compares it with the registration's ledgerPath)
}
// classifyVerdicts(verdicts, { protocolSha256, draws, reviewers?, ineligible? }): P4 adds `ineligible`, a further reason a
// verdict cannot count (the core's signing rules); null when it can. The ledger kit passes none.
interface LedgerDefinition {
  /* phase-1 fields unchanged */
  hosts?: (options: unknown) => string[];
  writePaths?: (options: unknown) => string[];     // host + path prefix a ledger may write to, e.g. api.github.com + /repos/<owner>/<audit repo>/
  credentials?: { env: string; hosts: string[]; hostFromOption?: string; headers?: string[]; secret?: boolean }[];  // as for providers
}
```

**Event order (added in the ledger/selector fix round).** `readVerdicts` returns verdicts in recorded order: by the tracker's time, then by event id. Ids compare part by part (split on `:`), each part as an integer when it is all digits (BigInt, so ids past 2^53 stay exact), a number before anything else, and anything else by UTF-16 code unit; equal numbers written differently fall back to code units. The order is total. `compareEventIds` and `compareByTimeThenId` in `pr-rla/ledger` are the reference; a lexical order would put id "100" before "99" and count the wrong one of two same-second verdicts. The checkpoint's canonical event list (`eventsSha256`) is sorted the same way.

**The ledger index.** An issue-tracker ledger keeps `audit/<window>/ledger-index.json` (draw → issue; for an external ledger, through `LedgerContext.index`). It is a hint, not a witness: on read the issue the tracker returns must be the one the index names (its numeric id, GitHub's issue `id` since P1 and not its node id, or GitLab's `id`, and its number), its body must carry the draw's marker for the same window, draw and change, and no two draws may share an issue number or id. `sample` binds the file to the draws, and (P1) publishes it in a signed, time-stamped record (§5, `pr-rla/ledger-publication/v1`); `verify` compares both.

**Publishing draws (P1).** A ledger with `publishDraws` keeps its index in `LedgerContext.index` (`sample` refuses one that keeps none), with an `issues` list naming each issue by `number` (or a `KEY-123` `key`), `id` and `url`, and opens the issues in draw order: their numbers rise strictly with the draw number, and check 7 FAILs an index (or a publication) where they do not. The option name `foreign_issues` is reserved for tests over recorded public timelines (issues pr-rla did not open): check 7 FAILs an audit whose ledger options set it, and an index that carries the old `foreignIssues` field.

#### Per-verdict signatures (`pr-rla-verdict@v1`, U9)

Added in the U9 fix round (2026-11-04); the bytes are version 2 since the P4 round (same day). A git-file verdict's provenance comes only from its own signature; no line is credited to a git commit.

**The signed bytes** are UTF-8 text, eleven lines in this order, each ending in LF (0x0A), the last included, with one space between a name and its value:

```
pr-rla-verdict/v2
registrationSha256 <64 lowercase hex: the registration's sha256, as in registration.json>
manifestSha256 <64 lowercase hex: the frozen manifest's sha256 (manifestSha256 in draws.json)>
beaconRound <decimal, 1 or more, no leading zero: the drand round the draws come from (beacon.round in draws.json)>
beaconRandomness <64 lowercase hex: that round's randomness (beacon.randomness in draws.json)>
protocolSha256 <64 lowercase hex>
draw <decimal, 1 or more, no leading zero>
changeId <text>
verdict <pass | fail>
reviewer <text: the allowed-signers principal>
recordedAt <YYYY-MM-DDTHH:MM:SS[.1-9 digits]Z>
```

Version 1 (`pr-rla-verdict/v1`) had eight lines: the same without `manifestSha256`, `beaconRound` and `beaconRandomness`. It bound only the registration, so a software key could sign every (draw, change) pair before the seed was drawn, with a `recordedAt` of its choosing, and a signature stayed valid for any manifest under the same registration (second-pass review finding 5). A signature over v1 bytes counts for nothing in any registration; check 7 names it as such. Nothing signed under v1 was released. The namespace stays `pr-rla-verdict@v1`: it names the purpose, and the first line names the format.

`<text>` is non-empty, well-formed UTF-8 with no control character (U+0000–U+001F, U+007F), so no value can carry a line break and the form is unambiguous. Nothing is escaped, quoted or normalised; the bytes are the values as the line holds them. A verdict whose fields do not fit cannot be signed (`record --sign` refuses it) and its signature cannot count. `note` is not signed and never counts.

**The signature** is an SSHSIG (OpenSSH `PROTOCOL.sshsig`) over those bytes in namespace `pr-rla-verdict@v1`, as `ssh-keygen -Y sign -n pr-rla-verdict@v1 -f <key> <file>` makes it: version 1, an empty reserved field, hash `sha512` (ssh-keygen's default) or `sha256`.

**The line** carries it in two fields beside the verdict's own:
- `registrationSha256`: the registration the signature names (a line naming another one is refused before its signature is checked);
- `sshsig`: the SSHSIG blob in base64, without the armor lines (`sed '1d;$d' file.sig | tr -d '\n'`).

```json
{"changeId":"github:acme/widgets#104","draw":7,"protocolSha256":"…","recordedAt":"2026-10-21T03:00:00Z","registrationSha256":"…","reviewer":"alice","schema":"pr-rla/verdict/v1","sshsig":"U1NIU0lH…","verdict":"pass"}
```

**Verification** (src/core/presence, pure) rebuilds the bytes from the line's fields and the audit being verified: the registration's digest, and the manifest digest and beacon round and randomness verify has already checked (status and `record` read them from `manifest.json` and `draws.json`). It counts the signature only when its key is one of the registration's `verdicts.allowed_signers` (exactly, with a `namespaces=` option that admits `pr-rla-verdict@v1`) and the line's `reviewer` is that key's principal, exactly. Level: `presence (user-presence flag verified; key hardware not attested)` for a FIDO security key with the user-presence flag set, else `account`; any other line `self-asserted`. Signatures count only with the registered built-in `git-file` ledger, and only when the ledger verify loaded is the registered one (check 7 compares `name`, `source`, `integrity` and `optionsSha256`).

**Eligibility under signing rules** (P4). When the registration lists `allowed_signers` and sets `require_signed` or a `minProvenance` above `self-asserted`, a verdict whose signature state is anything but a valid signature by its reviewer's registered key (unsigned, unreadable, another registration, invalid, v1 bytes, an unlisted key, another principal) is ineligible: it is ignored with its reason (`ignored verdict on draw #N: …`), and the first eligible verdict per change counts. With any other ledger than the registered git-file, every verdict is ineligible under such a registration. `countedVerdicts(…).ineligible` is the one predicate; status, check 7 (through `computeStatus` and `classifyVerdicts`) and `record`'s existing-verdict check (`countingVerdictFor`) all use it.

**The git-file history** check walks every commit reachable from HEAD through the parents in its raw object, reading objects with `git cat-file --batch` and checking each hashes to its name; every version of the file must extend each parent's version. A shallow, grafted or partial repository is refused. git runs through `src/io/git-safe.ts` only, by the absolute path PATH gives (`src/io/executables.ts`). The walk streams: per commit it keeps the tree id and the parents, per tree the one entry on the path, and only the file's distinct versions whole.

**The git-file path** (P4). The path walked is the file's path from the repository's toplevel, lexical and normalised, as the configuration names it (`<audit_dir>/<window>/<file>`); it is reported as `LedgerIntegrityReport.location`. The integrity check FAILs (`ledger path: …`) when a directory on it is a symbolic link, is not a directory, or exists on disk only under another spelling than its name in its parent's listing (a case-folding or normalising filesystem), and when the ledger is not inside the repository git found for it. Check 7 FAILs when `location` is not the registration's `ledgerPath` (§5), or when the registration has one and the ledger is in no repository; a registration without `ledgerPath` gives a WARN. With HEAD present and the window's `registration.json` committed, a ledger file holding verdicts that was never committed at its path FAILs. `appendVerdict` refuses to write through a symbolic link or into a file of another spelling.

**Failure behaviour:**
- `readVerdicts` or `readHistory` throwing makes check 7 FAIL with the error. It never passes silently.
- A 404 on an indexed issue is told apart from a deletion by probing the audit repo or project: if the credentials cannot read that either, the finding says the token has no access, not that the issue was deleted.
- A ledger without `readHistory` cannot be checkpointed: `checkpoint` says so and exits 1.

**Ledger conformance kit** (`runLedgerConformance(ledger, fixtures, { skipCases? })`):
- first-label rule;
- relabel, same and opposite;
- removal; deletion; label rename;
- unlisted reviewer; app-applied event (the core must ignore the event, and the ledger's own report must name it);
- verdict before seed (the core counts the verdict and check 7 would refuse it: `classifyVerdicts` and `recordedBeforeSeed`, shared with the core);
- pagination past 100 events;
- idempotent `publishDraws`;
- checkpoint round-trip;
- `transient-faults` (reads) and `transient-write-faults` (a publish's first write meets a 429, its second a lost 503, a recovery on the same tracker makes exactly the writes a clean publish makes, and a record meets a 429).

The kit fails an empty fixture list, and fails every case in `LEDGER_CASES` that no fixture exercises unless `skipCases` names it with a reason (then it is reported as skipped with the reason). `readVerdicts` must return its events in recorded order (normalization). For `transient-write-faults` the factory serves phase `publish-faults` on a fresh tracker and phase `publish-recover` on the tracker the faulted run left; a factory that does neither gets a reported skip.

### `pr-rla/http`

`createJsonClient({ base, headers, fetch, sleep, log, maxRetries })`, the phase-2 retrying client, exported unchanged under `HTTP_HELPER_VERSION = 1` and its own semver. Built-ins re-export from it.

## 2. Fetch broker

Every outbound HTTP request in the process goes through this one function (ADR-002).

**Read-only is the reader's mode (P1).** The read functions (`verify`, `status`, `draws`, `draw-context`, a freeze preview and estimate) run on a read-only AuditContext whatever context they are called with, so the CLI's `verify`, `status` and `freeze --dry-run` never open a read-write broker: a ledger cannot write while it is read. A read-only AuditContext says who reads it (`AuditCaller`): an `assistant`'s (`pr-rla/api/read`, the MCP server) holds built-ins to placeholders, counts only this machine's approvals, runs no `trust: full` plugin and fences what a plugin or server said into `untrusted`; a `person`'s (the CLI's) keeps their approvals, `--accept-lock-grants` and approved `trust: full` plugins, as read-write mode does (a `trust: full` plugin runs in-process and could bypass the broker; that is what its approval accepts).

```ts
type Destination = "scm" | "tsa" | "beacon" | "rekor";
type BrokerFetch = (input: string | URL, init: RequestInit & { pluginId: string; destination: Destination; idempotent?: boolean }) => Promise<Response>;

interface BrokerPolicy {
  mode: "read-write" | "read-only";
  hostsFor(pluginId: string): Set<string>;                 // empty = any (built-ins, trust: full)
  writePathsFor(pluginId: string): Set<string>;            // host + path prefix where non-read requests are allowed
  credentialsFor(pluginId: string): Map<string, { value: string; hosts: Set<string> }>;  // placeholder -> secret
  budgets: Map<string /* host */, HostBudgetDefault>;      // defaults from nfr-design.md §3
  timeouts: Record<Destination, number>;                   // scm 30_000, tsa 15_000, beacon 15_000, rekor 30_000
  recorder?: (exchange: RecordedExchange) => void;         // never set in read-only mode
}
```

### Pipeline, in order, per request

1. **Host allowlist.** A non-empty `hostsFor` set must contain the URL host, or the request throws `HostNotAllowed`. Redirects are followed manually and each hop is re-checked.
2. **Read-only guard.** In `read-only` mode, only `GET`, `HEAD` and a GraphQL `POST` whose document has no `mutation` or `subscription` operation are allowed. Anything else throws `ReadOnlyViolation { method, path }`. Provider requests are always under this guard. Ledger non-read requests must match `writePathsFor`, a prefix that ends on a `/` segment boundary.
   - **What a server may read as a write is one** (plugin and broker fix round, finding 6). On a GraphQL path, a `POST` with `query`, `operationName` or `extensions` in its URL is not a read, and a `GET` is a read only when its URL's `query` is a query document and it carries no `extensions`. `X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override` and a `_method` parameter name a second method; the request must be allowed as both.
3. **Credential swap.** A placeholder `prrla-cred:<ENV>` is replaced with the secret only (findings 4 and 5 of the fix round):
   - on `https:`, for an origin in the credential's grant: host and port exact, the default port normalised (a `host` entry is `https://host:443`, a `host:port` entry that port);
   - on no hop after a redirect from https to http, even one that comes back to https (raw secret headers are dropped from then on too);
   - in `authorization`, or a header name the credential declares in `headers`.
   - **Basic auth.** An `Authorization` value of exactly `prrla-basic:<USER_ENV>:<TOKEN_ENV>` becomes `Basic base64(<user>:<token>)` under the same rules. This is how isolated plugins such as the Jira example authenticate, since a placeholder cannot sit inside base64. A credential declared `secret: false` (an identity) may be only the user part.
   - **Local consent.** The grants come from the lock, but take effect only with the approval of the person running the command (`src/plugins/approvals.ts`), or `--accept-lock-grants`; otherwise the credential is withheld.
   - **Refusals, nothing sent.** Another origin, a scheme other than https or a downgraded hop throws `CredentialHostMismatch`; another header `CredentialHeaderNotAllowed` (`CREDENTIAL_HEADER_NOT_ALLOWED`); a withheld credential `CredentialNotApproved` (`CREDENTIAL_NOT_APPROVED`); an identity used as a token `CredentialIdentityOnly` (`CREDENTIAL_IDENTITY_ONLY`). Placeholders in URLs or bodies are never swapped.
4. **Rate governor.** One budget per host, shared by every caller. Server headers (`Retry-After`, `RateLimit-*`, `X-RateLimit-*`) override the default and pause the whole host.
5. **Timeout.** By destination: SCM 30 s, timestamp authority 15 s, drand 15 s, Rekor 30 s. A timeout throws `BrokerTimeout { host, destination, ms }`.
6. **Retry.** The broker is the only retrier once a caller is wired to it; built-ins construct their clients with `maxRetries: 0`.
   - **What is retried.** The phase-2 policy: 5xx, 429, truncated JSON bodies and GitHub transient GraphQL errors, with backoff and jitter.
   - **Limits by destination.** SCM, drand and Rekor allow at most 7 attempts. `tsa` retries until a 5-minute per-request deadline (FR1.10).
   - **Rate-limit waits.** Waits imposed by rate-limit headers are the governor's, not retries. They do not count as attempts.
   - **Non-idempotent requests.** A request marked `idempotent: false` (ledger writes) is retried only on connection errors before send and on 429, never on 5xx after send.
7. **Recorder.** When set, records the exchange with `authorization`, `private-token` and `cookie` headers and e-mail addresses scrubbed, and every secret value the caller holds replaced by its placeholder wherever it appears (URL, header values, body), raw, percent-encoded, base64 or base64url, and inside a Basic pair; an identity (`secret: false`) is left alone. It is never set in read-only mode.

**Errors** are typed classes with `code`, `host` and a `next` hint. They surface through the CLI error form (§7).

## 3. Plugin host IPC (`pr-rla/ipc/v2`)

The parent and the child exchange JSON objects in frames on the child's file descriptor 3, a plain pipe. A frame is a 4-byte big-endian unsigned length, then that many bytes of UTF-8 JSON, one object per frame. The reader checks the length before it buffers anything more.

| Direction | `type` | Fields | Meaning |
|-----------|--------|--------|---------|
| child → parent | `ready` | `protocol: "pr-rla/ipc/v2"`, `kind`, `name`, `apiVersion`, `shape`, `credentials?`, `reviewGranularity?`, `populationOptions?`, `node` | The plugin loaded; the parent validates the definition from these fields |
| parent → child | `call` | `id`, `method` (`describe`, `create`, `listChanges`, `nativeCounts`, `listRepos`, `describeChange`, `publishDraws`, `readVerdicts`, `appendVerdict`, `verifyIntegrity`, `readHistory`), `args` | Invoke one plugin method |
| child → parent | `result` | `id`, `value` | Method returned |
| child → parent | `error` | `id` (null: the plugin failed to load), `code`, `message` | Method threw |
| child → parent | `fetch` | `fid`, `url`, `method`, `headers`, `body?`, `bodyEncoding?`, `broker?` | The plugin called `ctx.fetch` (or `fetch`); the parent sends it through the broker |
| parent → child | `fetchResult` | `fid`, `status`, `statusText`, `headers`, `body`, `url`, or `error` | Broker response, with secrets scrubbed from every part of it |
| parent → child | `accept` | `aid`, `fid`, `body` | The broker asks the plugin's own `acceptJson` rule about a 2xx JSON body (scrubbed) |
| child → parent | `acceptResult` | `aid`, `problem` or `error` | The rule's answer: a reason to retry, or null |
| child → parent | `sleep` / parent → child `slept` | `sid`, `ms` | The plugin called `ctx.sleep`, which waits on the command's clock |
| child → parent | `log` | `line` | The plugin called `ctx.log` |
| child → parent | `index` / parent → child `indexResult` | `xid`, `op`, `value?` / `value` or `error` | A ledger's `LedgerContext.index`, kept by the parent |
| parent → child | `cancel` | `id` | Abort a call |
| child → parent | `heartbeat` | none | Sent every 10 s while a call runs |

**Failure behaviour:**
- No heartbeat for 60 s while a call is in flight, counted from `ready`, kills the child; so does a start-up that has not reported `ready` within its own limit (60 s by default). The command then fails with the plugin's stderr tail and writes no partial output.
- A frame over 64 MiB is refused from its length, before any of its payload is buffered, in both directions (`MESSAGE_TOO_LARGE`; the parent stops the child).
- A `sleep` is served only while a call is in flight, for at most 15 minutes (the SDK's `MAX_WAIT_MS`), and is cancelled when the calls end or the host closes. A `fetch` too is served only while a call is in flight, and at most 64 at once; any other is answered with `PLUGIN_FETCH_REFUSED`, unsent.
- Results are re-validated by the core (`population.ts`) whatever the child returns.

**Compatibility.** v2 has v1's messages and adds `accept` / `acceptResult`; what changed is the framing, from Node's IPC channel (which buffers and parses a whole message before anyone can measure it) to these frames. The parent and the child ship together in one pr-rla, and the parent refuses a child that reports another protocol. No plugin, lock or audit file carries the protocol, so nothing else changes.

## 4. MCP tools (`pr-rla-mcp`)

- **Transport:** stdio only. No listening port.
- **Import surface:** `pr-rla-mcp` imports only `pr-rla/api/read`, a subpath with the read functions fixed to read-only mode. No write function is reachable from it.
- **Roots:** `--root <dir>` (repeatable), defaulting to the working directory. Every `dir` argument must resolve, after `realpath`, inside a root, or the tool returns `ROOT_ESCAPE`.
- **Results:** every result is `structuredContent` plus the same JSON as text.
- **Mode:** every tool calls AuditApi in read-only mode.

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `audit_list` | `dir?` | `{ windows: { name, phase, mode, N?, certified? }[] }` | |
| `status` | `dir?`, `window?`, `offline` (default `true`) | `StatusResult` + status line | Never passes `--checkpoint` |
| `draws` | `dir?`, `window?`, `from?`, `limit?` (≤ 200) | issued draws with state; the next blocking draw | Read-only view; issuing draws stays CLI-only |
| `draw_context` | `dir?`, `window?`, `draw`, `maxPatchBytes?` (≤ 1 MiB, default 200 KiB) | `DrawContext` with an `untrusted` object and the fenced text the core built | The server passes the fence through and adds none of its own |
| `verify` | `dir?`, `window?`, `offline` (default `true`) | `VerifyReport` (seven checks), or `{ jobId }` | Online runs become jobs |
| `simulate` | `population`, `defects`, `runs` (≤ 20,000), `p0?`, `p1?`, `alpha?`, `seed?` | `SimulateReport` | Pure |
| `freeze_preview` | `dir?`, `window?`, `estimate?` | `FreezePreview`, or `{ jobId }` | Uses an in-memory response cache only; never FreezeCheckpointStore |
| `job_status` | `jobId` | `{ state: "running" \| "done" \| "failed" \| "unknown", progress?, result?, error? }` | `unknown` says `Unknown job (the server restarted or it expired): run <tool> again` |

**Job contract:**
- **Hand-off at 25 s.** Any tool that makes network calls (`draw_context`, online `status`, online `verify`, `freeze_preview`) and is still running at **25 s** returns `{ jobId }` and keeps running in the server process, emitting progress notifications.
  - The tool budget is 30 s: half of Codex's default `tool_timeout_sec` of 60 s, per the draft's `05` §U5.
  - Handing off at 25 s leaves 5 s inside that budget even when one SCM request is mid-way through its own 30 s timeout. Requests continue in the job, not in the tool call.
- **Memory only.** Jobs live in memory and die with the process. At most 4 run at once.
- **Preview cache.** A finished `freeze_preview` is cached in memory for 600 s, keyed by (window, registration digest, `estimate`).

**Error results:** `isError: true` with `{ code, message, next? }`. The codes are `ROOT_ESCAPE`, `NO_AUDIT`, `BAD_WINDOW`, `DRAW_OUT_OF_RANGE`, `READ_ONLY_VIOLATION`, `PROVIDER_ERROR`, `TIMEOUT`, `TOO_MANY_JOBS`, `RESULT_TOO_LARGE`.

**Untrusted-content fence** (built by AuditCore):

```
<<<UNTRUSTED-CHANGE-CONTENT {random 128-bit hex}>>>
… title, body and patches …
<<<END {same hex}>>>
```

## 5. Record schemas v2 and the lock file

All records are canonical JSON: sorted keys, no insignificant whitespace, UTF-8, and times as ISO 8601 UTC with a `Z`. v1 records keep verifying (NFR7); writers emit v2.

### `pr-rla/registration/v2` (signed)

| Field | Type | Notes |
|-------|------|-------|
| `schema` | `"pr-rla/registration/v2"` | |
| `repos` | `RepoSet` | `{kind:"repo",repo}` \| `{kind:"list",repos}` \| `{kind:"rule",owner,include,exclude,archived:false,forks:false,visibility}` |
| `window` | `{ opensAt, closesAt }` | |
| `selector` | object | adds `bots: string[]` (sorted, `login` or `id:<v>`) and `direct_push_via_merge: "include" \| "exclude"` |
| `protocolSha256` | hex | |
| `parameters` | object | unchanged statistics parameters |
| `beacon` | object | unchanged |
| `registeredAt` | time | signed; the seed input |
| `timestamping` | `{ authorities: string[], minTokens: number, toleranceSeconds: 600, defaultAccuracySeconds: 60, bundle: string }` | `minTokens` defaults to 2 |
| `plugins` | `{ provider: PluginIdentity, ledger: PluginIdentity }` | |
| `ledgerPath?` | string | The built-in git-file ledger only (P4): the ledger file's path from the audit repository's toplevel, lexical and normalised, `/`-separated (`audit/2026-q3/verdicts.jsonl`). Check 7 FAILs a ledger read anywhere else. Absent for other ledgers, for a git-file ledger registered outside a git repository (register warns), and in registrations made before the field (check 7 WARNs) |
| `verdicts` | `{ minProvenance: ProvenanceLevel, reviewers: string[] \| null, require_signed?: boolean, allowed_signers?: string[] }` | `reviewers` are logins or account ids (who may count); `allowed_signers` (U9 fix round) are OpenSSH allowed-signers lines, sorted, present only when keys are registered; `require_signed` only when true, and only with the built-in git-file ledger |
| `registeredRepos?` | `{ repo, repoId }[]` | A `rule` only (U8 fix round): the repos the rule matched at `register`, by id, sorted. Freeze includes each that still exists, whatever its attributes. Required for a rule (P3): check 2 FAILs a rule registration without it |
| `registeredVisibility?` | `{ identity, visibility: { <v>: { listed, complete, reason } } }` | A `rule` only (P3): what the registering token could prove it saw. A visibility the rule admits whose proof is not complete leaves check 5 INCOMPLETE |
| `publicKeyPem` | PEM (SPKI) | Time round B (2026-11-04): the P-256 key that signs this registration and the audit's commitment, inside the signed and time-stamped bytes, so the registration cannot be re-signed under another key. `verify` check 1 FAILs when the envelope's `publicKeyPem` is not this key (compared as SPKI DER), and check 2 FAILs a commitment signed by another key. A v2 registration without the field (written before it existed: test fixtures and the 2026-11-03 recording; nothing was released) WARNs that it can be re-keyed |

### Draws (time round B, 2026-11-04)

Draw *i* (1-based, *i* = 1 … cap) of an audit with *N* changes is the 0-based index

```
index_i = int_be( SHA-256( randomness ‖ binding ‖ uint64be(i) ) ) mod N
```

- `randomness`: drand quicknet round R's `randomness` (SHA-256 of its BLS signature), 32 bytes, from its 64 lowercase hex characters.
- `binding`, keyed on the **signed registration's** `schema`, never on a field of an unsigned file:
  - `pr-rla/registration/v2`: the registration's `sha256` (SHA-256 of its canonical JSON), 32 bytes from 64 lowercase hex characters;
  - `pr-rla/registration/v1`: the manifest's `sha256`, as v1 audits were drawn (read-only compatibility).
- `uint64be(i)`: *i* as an unsigned 64-bit big-endian integer (8 bytes). The hashed message is exactly 72 bytes.
- `int_be`: the 32-byte digest read as an unsigned 256-bit big-endian integer; the remainder mod *N* is exact (BigInt).
- `index_i` points into the population's change ids **in canonical order**: ascending by UTF-16 code units, which is JavaScript's `<` on strings (equivalently, the ids' UTF-16BE encodings compared byte by byte). Ids are unique; the manifest's `changes` are stored in this order (check 2 FAILs a manifest that is not), and `draws.json`'s `index` is into it.

Anything else (non-hex, upper-case hex, another length) is refused, never coerced. So for a v2 audit the draws are a function of the registration, the beacon and the set of change ids alone: nothing chosen at freeze (`frozenAt`, the funnel, the limitations, `prRlaVersion`, the provider's description of itself, the pool's listing) can move a draw, and freezing again cannot grind for a better sample (time review finding 2).

**The population, too, is fixed before the freeze.** N and the id list are the registered selector applied to the SCM's record of each change at landing: the window, kinds, authors, bots and `direct_push_via_merge` are registered; a review counts for `no-human-review` only if submitted at or before the change's `mergedAt`; and from schema v2 `unreviewed: no-review` likewise sees only review objects submitted at or before `mergedAt` (v1 manifests counted them as of `frozenAt`). What stays outside pr-rla's reach, and is stated as a limit (BUILD-NOTES, "P2 time round B"): SCM state that can change after landing (labels, which a `labels:` stratum reads as of freeze; an approval dismissed after the merge; an account renamed), and, for a pool, which repositories exist and their heads, which the U8 and P3 rules hold to the registration and the push log.

### `PluginIdentity`

`{ name, source: "builtin" | "package" | "path", version, integrity, optionsSha256, populationOptionsSha256, trust: "builtin" | "isolated" | "full" }`

- `integrity` is the lock's `treeSha256`.
- `populationOptionsSha256` hashes only the options the definition lists in `populationOptions`.
- **Bound to the registration (P1).** The provider and the ledger every command loads must be the registration's `plugins.provider` and `plugins.ledger`: `name`, `source`, `integrity`, `trust`, `optionsSha256` (every option, not only the population ones) and, for an external plugin, `version` (a built-in's version is the pr-rla release that ran it, shown and not compared; `populationOptionsSha256` follows from the options). `freeze`, `status`, `record`, `sample`, `checkpoint`, `draws` and `draw-context` refuse any other before it is opened (a dry run notes it); `verify` reads the configured plugin's identity from its definition or its lock entry, never runs one the registration does not name, and FAILs check 5 (the provider, and the manifest's `provider`, offline too) or check 7 (the ledger). One comparison: `src/core/plugin-binding.ts`.

### `pr-rla/manifest/v2`

`{ schema, registrationSha256, repos: [{ repo, repoId, defaultBranch, headSha }], provider: PluginIdentity & { reviewGranularity }, frozenAt, changes: ChangeRecord[] }`

`repos` and `changes` are both sorted. A pool adds (U8 fix round): `repoListing` (a rule: the owner's unfiltered listing at freeze, `{ owner, identity, visibility: { <v>: { listed, complete, reason } }, repos: [{ repo, repoId, defaultBranch, archived, fork, visibility, createdAt, excludedBy }] }`) and `goneRepos` (`[{ repo, repoId, status, detail, probedAt }]`, registered repos a repo-level probe found gone). P3 adds `headEvidence` (`[{ repo, headSha, status: "tip" | "unproven", since?, event?, detail }]`, sorted by repo, present when the provider has a push log): what the push log showed at freeze about each pinned head. Informational; verify reads the log again.

### `pr-rla/commitment/v2` (signed)

`{ schema, manifestSha256, frozenAt }`, carrying timestamp tokens in its `SignedRecord` envelope.

### `SignedRecord` envelope

`{ record, sha256, signature, publicKeyPem, log: LogEntry | null, timestamps: TimestampEvidence[] }`

### `TimestampEvidence`

`{ kind: "rfc3161", tsa, url, tokenDer, genTime, accuracySeconds, serial, nonce }`

Its identity is the pair (`tsa`, `serial`), because serials are unique only per authority.

### `pr-rla/draws/v1` (`audit/<window>/draws.json`, committed, not signed)

Adds one optional field: `ledgerIndexSha256`, the SHA-256 of the canonical JSON (sorted keys, no whitespace) of the window's `ledger-index.json`, written by `sample` after the ledger has published. `draws.json` is committed with the index; its git history is the trail, and each checkpoint line (below) carries the same hash, so the authorities' time-stamp covers the draw → issue mapping.

`verify` check 7 compares it, even offline: the file missing or changed since `sample` is a FAIL; a `draws.json` without the field (sampled by an earlier pr-rla) is a WARN; every issued first-occurrence draw must have an issue for the change `draws.json` draws, and every repeat must say which draw it repeats. An index without an `issues` list (an external ledger's own shape) gets the hash check only. An index with `foreignIssues` FAILs (P1; it was a WARN). `draws.json` is not signed, so this binding is a convenience: what binds the mapping is the publication record below.

### `pr-rla/ledger-publication/v1` (`audit/<window>/ledger-publication.json`, committed; each record signed and time-stamped)

Added in P1 (2026-11-04; pass-2 review #1, the coordinator's decision). When the registered ledger publishes draws, `sample` appends one record, right after the ledger has opened the issues and before anyone can label them:

`{ schema: "pr-rla/ledger-publications/v1", publications: [SignedRecord<{ schema: "pr-rla/ledger-publication/v1", window, registrationSha256, manifestSha256, ledger: PluginIdentity, sequence, previousSha256, draws: { through }, ledgerIndexSha256, index, publishedAt, prRlaVersion }>, …] }`

- **Signed** with the registration's key (`sample --key`, else `signing_key`; refused when it is not the registration's key), and **time-stamped** by the registered k-of-n authorities over the record's SHA-256 only, like the other records. `index` is the index exactly as the ledger left it (draw → issue number or key, id and url; the repeats; the labels or option ids), and `ledgerIndexSha256` its hash. `draws.through`: the issued draws it covers. `ledger`: the registered ledger.
- **Append-only:** `sequence` counts from 1 and `previousSha256` is the previous record's `sha256`; each record's index must be an append-only extension of the previous one's (every earlier entry identical, every other field unchanged). A later `sample --through` appends a record; a re-run with nothing new appends none, unless the latest has too few tokens (then it publishes again; `sample` exits 5 meanwhile).
- **Required** for a schema-v2 registration whose registered ledger publishes draws (the built-in issue ledgers by name; an external ledger with `publishDraws`): keyed on the signed registration, never on a field of an unsigned file. Not required for v1 registrations (a WARN when the mapping is bound by none).
- **Check 7** (and status, through the shared gate) FAILs: a record not signed by the registration's key, not for this audit, out of sequence or not an extension of the one before; a token that fails a rule (as check 1 judges the registration's); the current index not an append-only extension of the latest record; an issue a verdict was read from that no proven record lists; and a counted verdict recorded before the U_k of the first proven record listing its issue. A record **short of tokens** (fewer than k, none failing, nothing else wrong with it) proves nothing and shows nothing false: a verdict whose issue only such records list, or whose only listing before the verdict is such a record, makes check 7 **INCOMPLETE** (time round B), not FAIL. With no authority registered, records count at their signed time and check 7 WARNs `TIMESTAMP NOT TAMPER-PROOF`.
- **The local gate** is `check7Gate(paths, registration, ledger, trust)` (`src/api/read/ledger-gate.ts`): a function of the audit directory, the registration and the loaded ledger (its identity from its definition or lock, its test-only options, and what was read from it, or null), with no side effects. It returns `{ fails, incompletes }` (with `warns`, `lines`, and the short reasons `withheld` and `unestablished`); verify's check 7 runs the same rules (`assessedLedgerGate`, `src/core/ledger-gate.ts`), and status folds `withheld` into FAILED and `unestablished` into INCOMPLETE withholdings.
- **`sample` refuses** to publish over an index that is not the bound one: not an extension of the latest record, carrying `foreignIssues`, or (an audit with no record yet) not the index `draws.json` bound; and to bind an index the ledger left out of draw order.

### `pr-rla/ledger-checkpoint/v1`

One JSON line per checkpoint in `audit/<window>/ledger-checkpoints.jsonl`:

`{ schema, window, ledger: PluginIdentity, eventsSha256, count, perDrawFirstVerdict, takenAt, prevLineSha256?, ledgerIndexSha256?, timestamps }`

- **Identity:** the pair (`takenAt`, `eventsSha256`). Two checkpoints of an unchanged history share `eventsSha256` but differ in `takenAt`.
- **Chain:** `prevLineSha256` is the SHA-256 of the text of the line before this one in the file (without its line break), `null` for the first. It is part of the record the authorities time-stamp. Reading checks that a line naming a previous line names one that is earlier in the file: a deleted or edited line breaks the next line's link, and `verify` FAILs it. Lines written before the field existed carry none, stay readable, and are reported as unchained. Lines of two clones joined by the transport each link to the line their clone had before. Deleting only the newest line (and its history file) breaks no link: that is what the coverage rule below is for.
- **Coverage (check 7, issue ledgers):** a WARN unless some checkpoint has `takenAt` at or after the last counted verdict's time and tokens that are proven (k registered authorities) with U_k at or after it (P1, pass-2 review #5: a line whose tokens are short, ignored or failing covers nothing, and on a v1 registration, whose checkpoint tokens are never assessed, none does); a line with no tokens WARNs on its own.
- **Ledger:** the registered ledger's identity (P1: `checkpoint` refuses any other ledger); check 7 FAILs a line naming another.
- **Reading:** lines with an identical pair are one checkpoint, and the copy with the most tokens is kept, so a weaker copy never shadows a stronger one; two such lines that disagree about anything but their tokens and link are a FAIL.
- **Stored alongside:** the canonical event list, in `audit/<window>/ledger-history/<takenAt>.json`.

### `pr-rla/lock/v1` (`pr-rla.lock.json`, committed, not signed)

`{ schema, plugins: { "<use>": { source, name, version, resolved, npmIntegrity, treeSha256, trust, hosts, writePaths, credentials } } }`, where each credential is `{ env, hosts, hostFromOption?, headers?, secret? }` (optional fields added within v1).

Written only by `pr-rla plugin add` and `pr-rla plugin lock` (FR2.3). Its credential grants and `trust: full` take effect only with the local approval of whoever runs the command: `pr-rla/approvals/v1`, a per-user file outside every repo (`$PR_RLA_APPROVALS_FILE`, `$XDG_CONFIG_HOME/pr-rla/approvals.json` or `~/.config/pr-rla/approvals.json`), keyed by the plugin's use, `treeSha256`, trust, exact credential grants and write paths.

## 6. Checkpoint git transport

**Owner:** U4. **Callers:** `pr-rla checkpoint --push` and the CI integrations.

It runs outside the broker, because git speaks its own protocols and authenticates with the user's git credentials. Its limits are its own.

**Preconditions (refused with exit 1 and the reason):**
- a tree with any staged or unstaged change;
- a detached HEAD;
- a branch with no upstream, unless `--remote` and `--branch` are given.

**Steps:**
1. Compute the checkpoint line from `readHistory()`. Append it and its event list atomically, and commit on the current branch.
2. Up to 3 attempts:
   1. `git fetch <remote> <branch>`.
   2. `git rebase <remote>/<branch>`. This replays every unpushed local commit, including `git-file` verdict commits, onto the remote tip. Nothing is reset or discarded.
   3. If the rebase conflicts only in `ledger-checkpoints.jsonl` or `ledger-history/`, resolve by union: the remote lines plus ours, de-duplicated by the whole line (two copies of one checkpoint with different tokens both stay; reading keeps the stronger). Then continue.
   4. Any other conflict: `git rebase --abort`, leave the branch exactly as it was before the attempt, and exit 4 with the reason.
   5. `git push <remote> HEAD:<branch>`. On a non-fast-forward rejection, go round again.
3. Never `--force`. After 3 rejected pushes, exit 4 with the exact command to re-run.

- **Timeout:** each git subprocess has 30 s.
- **Read-only mode:** the transport is unreachable. AuditApi refuses `checkpoint` there with `READ_ONLY_VIOLATION`, and the MCP server never calls it.
- **Without `--push`:** `checkpoint` only appends locally (atomically) and prints the commit command.

## 7. CLI exit codes and `--json`

| Code | Meaning | Commands |
|------|---------|----------|
| 0 | Success | all |
| 1 | `verify` FAIL; plugin refused (lock mismatch, not locked, builtin-only); clock skew over 10 minutes; checkpoint preconditions not met; usage error | `verify`, `register`, `freeze`, `checkpoint`, any command loading a plugin |
| 2 | ESCALATE; R not yet published; an assistant hook block | `status`, `sample`, hooks |
| 3 | Population below the registered minimum (review all instead) | `status`, `sample` |
| 4 | Stopped before finishing; re-running the printed command finishes it (rate budget exhausted; checkpoint push rejected 3 times or blocked by a non-checkpoint conflict) | `freeze`, `checkpoint --push` |
| 5 | Record written without enough timestamps (`n of k`, including `0 of k` when every authority was unreachable) | `register`, `freeze`, `checkpoint`, `sample` (its ledger publication record, P1) |
| 6 | INCOMPLETE. `verify`: no check failed, but something was not established or a check did not run: part of the population could not be rebuilt (a repo gone, unreadable or rate limited) or its completeness could not be established (a token that cannot be shown to see every private or internal repo, a provider that cannot tell a late merge from a hidden landing); a registration or commitment time that k operators do not prove (v1: no log entry verified under a trusted key), and the seed round resting on it; a read a provider or ledger made without its credential (withheld or not set) that was refused with 401, 403 or 404 while nothing it read was answered; and any SKIPped check (`--offline`, before `sample`, a tracker ledger not read). It prints `INCOMPLETE`, never `VERIFIED`. `status`: the SPRT reached its target but the certificate is withheld for such a reason (an unproven time), or the verdicts were read without the ledger's credential and refused. *(Added in the U8 fix round; widened in time round B, 2026-11-04.)* | `verify`, `status` |

With no authority configured at all, `register` and `freeze` exit 0 with the `TIMESTAMP NOT TAMPER-PROOF` warning (FR1.6, FR1.11).

**`--json`:**
- The `--json` output of each command is the AuditApi result object. `verify --json` carries `verdict` (`VERIFIED`, `INCOMPLETE` or `FAILED`), and `ok` is true only for `VERIFIED`; a check's `status` can be `INCOMPLETE`. A check may carry `verbose` (P3): the per-item lines a summary line in `details` stands for, printed by `verify --verbose`.
- **One verdict model** (`src/core/verdict.ts`, time round B): `auditVerdict(checks)` (any FAIL → FAILED; any INCOMPLETE or SKIP → INCOMPLETE; else VERIFIED), `verdictExitCode` (0, 6, 1), and `certificateFor(sprtState, refusal, withheld, unread)` → `certificate: { state, withheld }` with `state` one of `CERTIFIED`, `WITHHELD`, `NOT CERTIFIED`, `ESCALATE`, `REFUSED`, `INCOMPLETE`, and `withheld: { verdict: "INCOMPLETE" | "FAILED", reason }[]`. `isCertified(certificate)` is the only claim any surface makes: status and verify `--json` carry it as `certified`, `audit_list` as `certified`, and the certificate line says `CERTIFIED (risk …)` only then (`target reached · CERTIFICATE WITHHELD (why)` when withheld). `StatusReport.sequence.state` is the SPRT's raw state and is never the claim. verify's withholdings are its non-passing checks; status's are the unproven times, plus whatever a status-side gate of check 7 shows would FAIL.
- Adding a field is compatible. Renaming or removing a field is a minor version below 1.0 and is listed in the CHANGELOG.
- Errors print `{ "error": { "code", "message", "host"?, "next"? } }` to stdout with `--json`, and a plain sentence plus the next step to stderr without it (NFR17).

## Versioning and compatibility

| Thing | Version | Rule |
|-------|---------|------|
| npm packages `pr-rla`, `pr-rla-mcp` | semver, released together | The first public release is **v0.1.0**, carrying all eleven units (RQ17). Below 1.0, a CLI or output contract change is a minor version |
| `providerApiVersion` / `ledgerApiVersion` | integer, 1 | Optional additions only. A required method or changed meaning moves to 2, with two releases where the core loads both |
| `HTTP_HELPER_VERSION` | integer, 1 | Independent of the API versions |
| Record schemas | `pr-rla/<kind>/vN` | `verify` reads every schema ever written |
| `pr-rla/ipc/v2` | string | The parent refuses a child that reports another protocol; v2 replaced v1's framing in the plugin and broker fix round (§3) |
| Trust bundle | date-stamped (`2026-11`) | Anchors are only added; removed ones are kept as historical |
| MCP tool contract | `pr-rla-mcp` semver plus output schemas | A renamed tool or removed field is a minor version below 1.0; the plugin pins the version |
| Exit codes | the table in §7 | Existing codes never change meaning |

## Kept, changed and added against the draft

- **Kept.**
  - The SDK deltas of `03` §3 and the record schemas of `03` §4.
  - The broker pipeline of `05` §U2a.
  - The MCP tool set and annotations of `05` §U5.
  - The lock fields of `05` §U2b.
- **Changed.**
  - `head` and `headSha` sit on the request and result, not on `ChangeRecord`.
  - The broker takes a `destination` with per-destination timeouts, and serves TimeEvidence, Beacon and Rekor too (ADR-002).
  - The recorder is never set in read-only mode.
  - The job hand-off is at 25 s, not "predicted to exceed 30 s".
  - `freeze_preview` uses only an in-memory cache.
  - `TimestampEvidence` and checkpoint identities are composite.
  - The default `minTokens` is 2.
  - The lock is written only by `plugin add` and `plugin lock`.
  - The first public version is v0.1.0, not 0.2.x and 0.3.x.
- **Added.**
  - The IPC message protocol (`pr-rla/ipc/v1`), which the draft left implicit.
  - `writePaths` for ledgers.
  - `populationOptions` on provider definitions.
  - The MCP error codes and the `unknown` job state.
  - The checkpoint git transport (§6).
  - The full exit-code table, including the new code 5.
  - The JSON error form.
