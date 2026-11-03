# 03 · Application design

Components, interfaces and data shapes for phases 3–4. Unit-level behaviour is in `05`; this document fixes the boundaries those designs must respect.

## 1. Component view

```mermaid
flowchart TB
  subgraph Clients["Entry points"]
    CLI["pr-rla CLI<br/>src/cli.ts + commands"]
    MCP["pr-rla-mcp<br/>(separate npm package, stdio)"]
    CI["CI wrappers<br/>GitHub Action · GitLab component · Bitbucket step"]
  end

  subgraph Assist["Assistant integrations (no code in core)"]
    CCP["Claude Code plugin<br/>review-draw skill · hooks · .mcp.json"]
    CDX["Codex / Cursor config<br/>+ AGENTS.md snippet"]
  end

  subgraph Lib["pr-rla package"]
    API["Audit service API<br/>src/api/* (new)<br/>openAudit · status · verify · draws · drawContext · freezePreview"]
    subgraph Core["Core (pure; no SCM, no I/O)"]
      SEL["selector (+bots, via-merge)"]
      POP["population (+pooled repo sets)"]
      REC["records v1/v2"]
      SEED["seed · draws"]
      SPRT["SPRT · status"]
      VER["verify (7 checks)"]
      DCX["drawContext assembly<br/>(generated-file filter, checklist)"]
      PROV["verdict provenance"]
    end
    TS["Time evidence (new)<br/>src/timestamp: RFC 3161 client + verifier<br/>trust bundle (pinned TSA roots)"]
    TL["Transparency log<br/>src/translog: Rekor v1 + v2, checkpoint verify"]
    BEA["Beacon<br/>src/beacon/drand.ts"]
    REG["Registry + lock (extended)<br/>src/registry.ts · src/plugins/lock.ts"]
    HOST["Plugin host (new)<br/>src/plugins/host.ts ⇄ child.ts (IPC)"]
    BRK["Fetch broker (new)<br/>src/net/broker.ts<br/>retry · rate governor · credential swap<br/>host allowlist · read-only guard · recorder"]
    CACHE["Freeze checkpoint store (new)<br/>.pr-rla/cache"]
    subgraph BuiltIns["Built-in plugins (in-process, trusted)"]
      PGH["github"]
      PGL["gitlab"]
      PBB["bitbucket-cloud / -data-center"]
      PJS["json-file"]
      LGF["git-file ledger (+signed commits)"]
      LGI["github-issues ledger (new)"]
      LGL["gitlab-issues ledger (new)"]
    end
    SDK["SDKs: pr-rla/provider · pr-rla/ledger<br/>pr-rla/testing · pr-rla/http (new)"]
  end

  subgraph Ext["External plugins (out of process by default)"]
    XP["e.g. pr-rla-provider-gitea"]
    XL["e.g. examples/ledgers/jira"]
  end

  subgraph Net["External services"]
    SCM["SCM APIs<br/>GitHub · GitLab · Bitbucket · …"]
    TSA["RFC 3161 TSAs"]
    DR["drand quicknet"]
    RK["Rekor (only with --submit)"]
  end

  CLI --> API
  MCP --> API
  CI --> CLI
  CCP --> MCP
  CDX --> MCP
  API --> Core
  API --> TS
  API --> TL
  API --> BEA
  API --> REG
  REG --> BuiltIns
  REG --> HOST
  HOST --> XP
  HOST --> XL
  BuiltIns --> BRK
  HOST -- "fetch over IPC" --> BRK
  API --> CACHE
  BRK --> SCM
  TS --> TSA
  BEA --> DR
  TL --> RK
  XP -. "types only" .-> SDK
  XL -. "types only" .-> SDK
```

Boundary rules. The existing `architecture boundaries` test is extended to enforce each one.
1. `src/core/*` imports only `src/sdk/*` and other core modules. It does no I/O; RFC 3161 *parsing* is pure and lives in `src/timestamp/der.ts`, while fetching does not. The core never imports `src/plugins`, `src/net` or `src/api`.
2. `src/api/*` is the only layer that composes I/O: config, files, registry, broker, beacon, TSA, log. CLI commands become thin formatters over it. The MCP package depends on `pr-rla` (`.` export) and on nothing internal.
3. Built-in plugins call `ctx.fetch`, which is the broker. No plugin, built-in or external, constructs its own HTTP client. That is already true; the kit's `transient-faults` check fails a provider that bypasses the harness.
4. External plugins are reached only through the plugin host, unless the lock marks them `trust: full`.

## 2. Component responsibilities (new or changed)

| Component | Responsibility | Unit |
|---|---|---|
| Audit service API (`src/api`) | One function per user-visible operation, returning structured results (the same objects `--json` prints). Takes an `AuditContext` with an injected `mode: "read-write" \| "read-only"`. In read-only mode it never writes files, ledgers or logs. | U5 |
| Time evidence (`src/timestamp`) | Build TimeStampReq (SHA-256 imprint, nonce, certReq), POST to each TSA, parse and verify TimeStampToken offline against the trust bundle, return `TimestampEvidence`. | U1 |
| Transparency log (`src/translog`) | Keep the v1 client. Add the v2 client (`/api/v2/log/entries`), its inclusion proof and signed-checkpoint verification. Submit only on `--submit`. | U1 |
| Registry + lock | Resolve `use`, compute plugin identity, check `pr-rla.lock.json`, choose in-process vs host. | U2 |
| Plugin host | Spawn a child Node process with a scrubbed env and the permission model, import the plugin there, proxy `create` / `listChanges` / ledger calls over IPC, and enforce timeouts and cancellation. | U2 |
| Fetch broker | The only network path for plugins. Per-host token bucket shared across repos (org pooling), retry and `Retry-After` / `RateLimit-*` (moved from `src/providers/http.ts`), placeholder → credential swap on allowlisted hosts, read-only guard (MCP), recording (fixtures). | U2, U5, U8 |
| Issue ledgers | `publishDraws` (one issue per draw), `readVerdicts` from label-event history, `verifyIntegrity`, `readHistory` for checkpoints. | U4 |
| Freeze checkpoint store | Per-run, content-addressed response cache and per-repo completion markers. Freeze resumes; verify never reads it. | U8 (Q7) |
| `pr-rla-mcp` | stdio MCP server, read-only tools over the audit service API. | U5 |
| Claude Code plugin | `review-draw` skill, `.mcp.json`, PreToolUse hooks. | U6 |
| CI wrappers | Thin, version-pinned invocations of the CLI. | U7 |

## 3. SDK deltas (all additive within API version 1)

The rule set by `ProviderContext.sleep`, which was added under the same API version: an **optional** field or method that old plugins can ignore is additive. Anything a plugin *must* now do, or a changed meaning, bumps the version.

### `pr-rla/provider`
```ts
interface Actor { login: string; kind: ActorKind; id?: string }            // Q6
interface ChangeRecord { /* … */ landedVia?: string }                       // Q4: merge sha that brought it in
interface ListChangesRequest { /* … */ head?: string }                      // Q2: walk history from this sha
interface ListChangesResult { /* … */ headSha?: string }                    // Q2
interface ProviderDefinition {
  /* … */
  reviewGranularity?: "submission" | "first-comment-per-user";            // Q5
  hosts?: (options) => string[];                                            // U2: hosts the broker allows
  credentials?: { env: string; hosts: string[] }[];                         // U2: env vars it may read
}
interface ScmProvider {
  /* … */
  listRepos?(set: RepoSetRule): Promise<RepoRef[]>;                         // U8: org/group/workspace listing
  describeChange?(change: ChangeRecord): Promise<ChangeDescription>;        // U5: for draw_context
}
interface RepoRef { repo: string; id: string; defaultBranch: string; archived: boolean; fork: boolean; visibility: "public" | "private" | "internal" }
interface ChangeDescription {
  title: string; body: string;
  files: { path: string; status: "added" | "modified" | "removed" | "renamed"; additions: number; deletions: number; patch: string | null }[];
  gitattributes: string | null;                                             // .gitattributes at mergeSha, for linguist-generated
  checks: { name: string; state: "success" | "failure" | "neutral" | "pending" | "skipped" | "unknown"; url: string | null }[];
  truncated: boolean;
}
```

### `pr-rla/ledger`
```ts
type ProvenanceLevel = "self-asserted" | "account" | "presence";            // FR-M8
interface VerdictEvent { /* … */ provenance?: { level: ProvenanceLevel; source: string; actorId?: string; viaApp?: string | null; eventId?: string } }
interface LedgerHistoryEvent { id: string; at: string; actor: Actor; action: "add" | "remove" | "edit" | "delete-issue" | "transfer"; label: string | null; draw: number | null; raw?: unknown }
interface Ledger {
  /* … */
  readHistory?(): Promise<LedgerHistoryEvent[]>;                            // FR-L4 checkpoints
}
interface LedgerDefinition { /* … */ hosts?: (options) => string[]; credentials?: { env: string; hosts: string[] }[] }
```

### `pr-rla/http` (new subpath, own semver: Q8)
`createJsonClient({ base, headers, fetch, sleep, log, maxRetries })`, the phase-2 client from `src/providers/http.ts`, unchanged.

## 4. Data model: record schemas v2

v1 files keep verifying (NFR-C1). Writers emit v2 from phase 3 on. A v2 record differs from v1 only where listed.

```mermaid
classDiagram
  class SignedRecord~T~ {
    record: T
    sha256
    signature
    publicKeyPem
    log: LoggedEntry or RekorV2Entry or null
    timestamps: TimestampEvidence list (v2)
  }
  class TimestampEvidence {
    kind rfc3161
    tsa: string  (trust-bundle id)
    url
    tokenDer: base64
    genTime
    accuracySeconds
    serial
    nonce
  }
  class RegistrationV2 {
    schema pr-rla/registration/v2
    repos: RepoSet
    window
    selector (bots, direct_push_via_merge)
    protocolSha256
    parameters
    beacon
    registeredAt  (signed; seed input)
    timestamping: authorities, minTokens, toleranceSeconds
    plugins: provider + ledger PluginIdentity
    verdicts: minProvenance, reviewers
  }
  class PluginIdentity {
    name
    source: builtin, package or path
    version
    integrity  (lock tree hash)
    optionsSha256
    populationOptionsSha256
    trust: isolated or full
  }
  class ManifestV2 {
    schema pr-rla/manifest/v2
    repos: repo, repoId, defaultBranch, headSha (each)
    provider: PluginIdentity + reviewGranularity
    frozenAt
    changes (Actor.id, landedVia)
    sha256
  }
  class LedgerCheckpoint {
    schema pr-rla/ledger-checkpoint/v1
    window
    ledger: PluginIdentity
    eventsSha256
    count
    takenAt
  }
  SignedRecord --> TimestampEvidence
  SignedRecord --> RegistrationV2
  SignedRecord --> LedgerCheckpoint
  RegistrationV2 --> PluginIdentity
  ManifestV2 --> PluginIdentity
```

- **`RepoSet`.** Either `{ kind: "repo", repo }`, which is v1-equivalent, or `{ kind: "list", repos: string[] }`, or `{ kind: "rule", owner, include: glob[], exclude: glob[], archived: false, forks: false, visibility: [...] }` (U8).
- **`populationOptionsSha256`.** A hash over only the options a provider declares as stratum-relevant (`base_url`, `bots`, `default_branch`). These FAIL check 5 on mismatch; other options WARN (Q3).
- **`pr-rla.lock.json`.** Committed in the audit repo; not a signed record. `{ schema: "pr-rla/lock/v1", plugins: { "<use>": { source, name, version, resolved, npmIntegrity, treeSha256, trust, hosts, credentials } } }`.

## 5. Audit lifecycle (with phase-3 evidence)

```mermaid
stateDiagram-v2
  [*] --> Configured: init (.pr-rla.yml, protocol, lock)
  Configured --> Registered: register · sign record · RFC 3161 tokens ≥ k · [--submit: Rekor v2 entry]
  note right of Registered
    prospective iff every counted token's
    genTime + accuracy < window.opensAt
  end note
  Registered --> WindowOpen: opensAt
  Registered --> WindowClosed: (retrospective: already closed)
  WindowOpen --> WindowClosed: closesAt
  WindowClosed --> Frozen: freeze · pinned heads · manifest · commitment · RFC 3161 tokens before R publishes
  Frozen --> Seeded: round R publishes · (≥ 24 h after max(close, registeredAt))
  Seeded --> Sampling: sample · BLS-verify R · draws.json · [issue ledger: publishDraws]
  Sampling --> Reviewing: human deep review · (review-draw skill / draw-context)
  Reviewing --> Reviewing: human records verdict · (record / label) · CI: status + checkpoint
  Reviewing --> Certified: LLR ≥ ln(1/α) on the labelled prefix
  Reviewing --> Escalated: cap reached or target unreachable
  Reviewing --> Sampling: sample --through n (more draws)
  Certified --> Verified: verify (any third party)
  Escalated --> Verified: verify
  Verified --> [*]
```

## 6. Plugin call sequence (external provider, isolated)

```mermaid
sequenceDiagram
  autonumber
  participant U as CLI / MCP (api layer)
  participant R as Registry
  participant L as pr-rla.lock.json
  participant H as Plugin host (parent)
  participant C as Child process<br/>(--permission, scrubbed env)
  participant P as Plugin module
  participant B as Fetch broker
  participant S as SCM API

  U->>R: createProvider({use: "pr-rla-provider-gitea", options})
  R->>L: lookup(use)
  L-->>R: version, treeSha256, hosts, credentials, trust=isolated
  R->>R: hash installed tree == treeSha256?
  alt mismatch or not locked
    R-->>U: refuse: "plugin changed since lock" (exit 1)
  end
  R->>H: spawn(plugin path, allowed fs read paths)
  H->>C: fork (env = {PR_RLA_*} + placeholders only)
  C->>P: import() · assertProviderDefinition
  C-->>H: ready {name, providerApiVersion, reviewGranularity}
  U->>H: listChanges(request)
  H->>C: IPC call listChanges
  P->>C: ctx.fetch(url, {authorization: "token prrla-cred:GITEA_TOKEN"})
  C->>H: IPC fetch request
  H->>B: fetch(request, plugin=gitea)
  B->>B: host in allowlist? swap placeholder → real token<br/>rate governor (per host) · read-only guard (MCP)
  B->>S: HTTPS request
  S-->>B: response (retry on 5xx/429 with Retry-After)
  B-->>H: response (credential stripped from any echo)
  H-->>C: IPC fetch response
  C-->>P: Response
  P-->>C: ListChangesResult
  C-->>H: IPC result (JSON)
  H-->>U: ListChangesResult
  U->>U: core re-validates every ChangeRecord (population.ts)
```

## 7. MCP request flow

```mermaid
sequenceDiagram
  autonumber
  actor Human
  participant A as Assistant<br/>(Claude Code · Codex · Cursor)
  participant K as Hooks (Claude Code plugin)
  participant M as pr-rla-mcp (stdio)
  participant G as Read-only guard
  participant API as Audit service API (read-only mode)
  participant X as Provider · ledger · drand · TSA trust bundle

  Human->>A: "review draw 12"
  A->>M: tools/call draw_context {draw: 12}
  M->>API: drawContext(12) with mode=read-only
  API->>G: every fetch / file open / ledger call
  G-->>API: GET/HEAD and GraphQL "query" only · fs read-only · ledger proxy without append/publish
  API->>X: describeChange · readVerdicts · protocol file
  X-->>API: diff, checks, verdict state
  API-->>M: DrawContext
  M-->>A: structuredContent + text (diff, CI, checklist)<br/>+ "record it yourself: pr-rla record 12 pass|fail …"
  A-->>Human: shows the draw and the protocol checklist
  Human->>Human: deep review
  opt assistant tries to write
    A->>K: Bash "pr-rla record 12 pass" / gh issue edit --add-label / Write verdicts.jsonl
    K-->>A: blocked (exit 2): "verdicts are recorded by the reviewer, not the assistant"
  end
  Human->>X: records the verdict in their own terminal or SCM UI
  Note over X: CI re-runs status on the ledger event
```
