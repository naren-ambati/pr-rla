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
}
interface RepoRef { repo: string; id: string; defaultBranch: string; archived: boolean; fork: boolean; visibility: "public" | "private" | "internal" }
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

`head` and `headSha` live on the request and result, not on `ChangeRecord`.

**Failure behaviour:**
- A provider that ignores `head`, or returns a different `headSha` than requested, is not an error. `verify` adds the check-5 detail `provider does not pin history; direct pushes dated in the window but pushed after freeze will show as extra`.
- A provider without `describeChange` gets a context built from manifest fields only, with `files: []` and a note.
- A provider without `listRepos` cannot be used with a `rule` repo set: `register` refuses and names the provider.

**Conformance-kit additions** (`pr-rla/testing`):
- `pinned-head`;
- `actor-ids` (if any actor has an `id`, all must, and ids are stable across two runs);
- `review-granularity`;
- `revoked-approval` (a revoked approval never comes back as `APPROVED`).

### `pr-rla/ledger`

```ts
type ProvenanceLevel = "self-asserted" | "account" | "presence";
interface VerdictEvent {
  /* phase-1 fields unchanged */
  provenance?: {
    level: ProvenanceLevel;
    source: "git-commit" | "git-signed-commit" | "scm-label-event" | "jira-field-change" | string;
    actorId?: string;
    viaApp?: string | null;     // GitHub performed_via_github_app; non-null is ineligible by default
    eventId?: string;
    signer?: string;            // allowed-signers principal, for git-signed-commit
  };
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
interface LedgerDefinition {
  /* phase-1 fields unchanged */
  hosts?: (options: unknown) => string[];
  writePaths?: (options: unknown) => string[];     // host + path prefix a ledger may write to, e.g. api.github.com + /repos/<owner>/<audit repo>/
  credentials?: { env: string; hosts: string[]; hostFromOption?: string; headers?: string[]; secret?: boolean }[];  // as for providers
}
```

**Failure behaviour:**
- `readVerdicts` or `readHistory` throwing makes check 7 FAIL with the error. It never passes silently.
- A ledger without `readHistory` cannot be checkpointed: `checkpoint` says so and exits 1.

**Ledger conformance kit** (`runLedgerConformance`):
- first-label rule;
- relabel, same and opposite;
- removal; deletion; label rename;
- unlisted reviewer; app-applied event;
- verdict before seed;
- pagination past 100 events;
- idempotent `publishDraws`;
- checkpoint round-trip;
- `transient-faults`.

### `pr-rla/http`

`createJsonClient({ base, headers, fetch, sleep, log, maxRetries })`, the phase-2 retrying client, exported unchanged under `HTTP_HELPER_VERSION = 1` and its own semver. Built-ins re-export from it.

## 2. Fetch broker

Every outbound HTTP request in the process goes through this one function (ADR-002).

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
| `verdicts` | `{ minProvenance: ProvenanceLevel, reviewers: string[] \| null, require_signed?: boolean }` | `reviewers` is an OpenSSH allowed-signers list or account ids |

### `PluginIdentity`

`{ name, source: "builtin" | "package" | "path", version, integrity, optionsSha256, populationOptionsSha256, trust: "builtin" | "isolated" | "full" }`

- `integrity` is the lock's `treeSha256`.
- `populationOptionsSha256` hashes only the options the definition lists in `populationOptions`.

### `pr-rla/manifest/v2`

`{ schema, registrationSha256, repos: [{ repo, repoId, defaultBranch, headSha }], provider: PluginIdentity & { reviewGranularity }, frozenAt, changes: ChangeRecord[] }`

`repos` and `changes` are both sorted.

### `pr-rla/commitment/v2` (signed)

`{ schema, manifestSha256, frozenAt }`, carrying timestamp tokens in its `SignedRecord` envelope.

### `SignedRecord` envelope

`{ record, sha256, signature, publicKeyPem, log: LogEntry | null, timestamps: TimestampEvidence[] }`

### `TimestampEvidence`

`{ kind: "rfc3161", tsa, url, tokenDer, genTime, accuracySeconds, serial, nonce }`

Its identity is the pair (`tsa`, `serial`), because serials are unique only per authority.

### `pr-rla/ledger-checkpoint/v1`

One JSON line per checkpoint in `audit/<window>/ledger-checkpoints.jsonl`:

`{ schema, window, ledger: PluginIdentity, eventsSha256, count, perDrawFirstVerdict, takenAt, timestamps }`

- **Identity:** the pair (`takenAt`, `eventsSha256`). Two checkpoints of an unchanged history share `eventsSha256` but differ in `takenAt`.
- **Reading:** lines with an identical pair are de-duplicated.
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
   3. If the rebase conflicts only in `ledger-checkpoints.jsonl` or `ledger-history/`, resolve by union: the remote lines plus ours, de-duplicated by (`takenAt`, `eventsSha256`). Then continue.
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
| 5 | Record written without enough timestamps (`n of k`, including `0 of k` when every authority was unreachable) | `register`, `freeze`, `checkpoint` |

With no authority configured at all, `register` and `freeze` exit 0 with the `TIMESTAMP NOT TAMPER-PROOF` warning (FR1.6, FR1.11).

**`--json`:**
- The `--json` output of each command is the AuditApi result object.
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
