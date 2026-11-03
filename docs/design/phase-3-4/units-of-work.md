# Units of Work: pr-rla phases 3–4

**Stage:** Units Generation. Refines the draft's `pr-rla/docs/design/phase-3-4/04-units-of-work.md`.

**Built on:**
- The approved requirements: `aidlc/spaces/default/intents/261103-rla-design-review/inception/requirements-analysis/requirements.md`, FR1–FR10 and NFR1–NFR19.
- The approved component catalogue: `…/inception/domain-design/components.md` and `decisions.md`.

This document gives topology only. The build order is in `delivery-plan.md`.

## Units

| Unit ID | Directory | Kind | Size | Components it builds or changes | Delivers |
|---------|-----------|------|------|----------------------------------|----------|
| U1 | `u1-trusted-time` | library | L | TimeEvidence, TransparencyLog, AuditCore (record schemas v2, checks 1–3) | RFC 3161 tokens from k = 2 of 4 authorities, the trust bundle, the Rekor v2 client (mock-tested only), record schema v2 in full |
| U2a | `u2a-fetch-broker` | library | M | FetchBroker, AuditApi (foundation), PluginSdk (`hosts`, `credentials`, `writePaths`) | One network path: retries, per-host budgets with published-limit defaults, timeouts, credential swap including Basic auth, read-only guard, recorder; plus the `src/api` foundation that later units add to |
| U2b | `u2b-plugin-host` | library | M | PluginRegistry (lock), PluginHost | `pr-rla.lock.json`, `plugin add / check / lock`, the out-of-process host, `--plugins builtin-only` |
| U3 | `u3-sdk-carry-overs` | library | M | PluginSdk (provider deltas, `populationOptions`), BuiltInProviders, AuditCore (selector) | Registered bots, `direct_push_via_merge`, pinned head, `Actor.id`, `reviewGranularity`, `landedVia`, `populationOptions`, `pr-rla/http`, four new kit checks (`pinned-head`, `actor-ids`, `review-granularity`, `revoked-approval`) |
| U4 | `u4-issue-ledgers` | library | L | BuiltInLedgers (issue ledgers), PluginSdk (ledger deltas, ledger kit), ExamplePlugins (Jira), AuditApi (checkpoint writer, git transport) | `github-issues`, `gitlab-issues` (self-hosted base URLs), label-event history, integrity, TSA-stamped checkpoints, the Jira example, the ledger conformance kit |
| U5 | `u5-audit-api-mcp` | service | L | AuditApi (moves the remaining commands onto the foundation; `pr-rla/api/read`), Cli (refactor to formatters), AuditCore (draw context), BuiltInProviders (`describeChange`), McpServer | The audit API, the read-only subpath, `pr-rla draw-context`, the `pr-rla-mcp` package with eight read-only tools |
| U6 | `u6-assistant-integrations` | packaging | S | AssistantIntegrations | The Claude Code plugin (skill, hooks, MCP config), Codex and Cursor setup |
| U7 | `u7-ci-integrations` | packaging | M | CiIntegrations | GitHub Action, GitLab CI/CD component, Bitbucket Pipelines step, tested on fixtures and mock servers |
| U8 | `u8-org-pooled-freeze` | library | L | AuditCore (pooled population), FreezeCheckpointStore, BuiltInProviders (`listRepos`) | One freeze and one certificate per org, group or workspace; resume; `--estimate` |
| U9 | `u9-presence-verdicts` | library | M | PresenceVerifier, BuiltInLedgers (git-file `require_signed`), AuditCore (check 7 `minProvenance`) | SSHSIG verification with the presence flag, registered signers, software-key fixtures |
| U10 | `u10-docs-release` | packaging | M | none (documents and release checks) | The doc set, compatibility table, SECURITY.md placeholder, release checklist, the gh-aw registration hand-off; no publish |

**Sizes:**

| Size | Build days |
|------|------------|
| S | ≤ 1 |
| M | 1.5–2 |
| L | 2.5–3 |
| XL | > 3 |

The per-unit day estimates are in `delivery-plan.md`.

### Where each unit lives in the code

The directories are as in BUILD-NOTES, plus the new ones the draft introduced.

| Unit | Source paths |
|------|--------------|
| U1 | `src/timestamp/` (client, verifier, `trust-bundle.json`), `src/translog/rekor.ts` (v2 added), `src/core/records/` (schema v2), `src/io/atomic.ts`, `src/cli/exit-codes.ts` |
| U2a | `src/net/broker.ts`, `src/api/context.ts` (the foundation), definition fields in `src/sdk/provider.ts` and `src/sdk/ledger.ts` |
| U2b | `src/plugins/lock.ts`, `src/plugins/host.ts`, `src/plugins/child.ts`, `src/registry.ts` |
| U3 | `src/sdk/provider.ts`, `src/sdk/http.ts`, `src/core/selector.ts`, `src/providers/*`, `src/testing/conformance.ts` |
| U4 | `src/ledgers/github-issues/`, `src/ledgers/gitlab-issues/`, `src/sdk/ledger.ts`, `src/testing/ledger-conformance.ts`, `src/api/checkpoint.ts`, `src/io/git-transport.ts`, `examples/ledgers/jira/` |
| U5 | `src/api/read/`, `src/api/write/`, `src/commands/*` (formatters), `src/core/draw-context.ts`, `src/core/generated.ts`, `packages/pr-rla-mcp/` |
| U6 | `integrations/claude-code/`, `.claude-plugin/marketplace.json`, `docs/assistants/` |
| U7 | `integrations/github-action/`, `integrations/gitlab/`, `docs/ci/` |
| U8 | `src/core/population.ts` (pooled), `src/core/repo-set.ts`, `src/api/freeze-store.ts`, provider `listRepos` |
| U9 | `src/core/presence/`, `src/ledgers/git-file.ts` (`require_signed`), `src/core/verify.ts` (check 7) |
| U10 | `docs/`, `CHANGELOG.md`, `SECURITY.md`, `docs/release.md`, `scripts/check-docs.mjs` |

### Responsibilities, boundaries and constraints per unit

**U1 · Trusted time**
- **Owns:** the token request and offline verification; k-of-n counting by operator; the trust bundle; clock-skew refusal; retries for at most 5 minutes, with no tokens added later; exit 5 when fewer than k tokens arrive.
- **Also owns:** record schema v2, defined in full once, so later units fill fields without changing the schema.
- **Rekor:** the v1 client is kept. The v2 client is tested against the published API and mock servers only. `--submit` warns that it is unverified against production.
- **Boundary:** U1 calls the network through the broker *interface* defined in `contracts.md` §2. Until U2a lands it binds to a minimal adapter over global `fetch` with the same 15 s timeout, so U1 does not wait for U2a. This is how the founder's order (U1 before U2a) satisfies ADR-002.
- **Constraint:** no Rekor write of any kind in the build (D3). Live token fetches from all eight bundled authorities send hashes only (D2, RQ10).

**U1 · Trusted time** also creates `src/io/atomic.ts` (temporary file, then rename) and `src/cli/exit-codes.ts`. Bolt 1 needs atomic writes and exit code 5, and every later unit uses them.

**U2a · Fetch broker**
- **Owns:**
  - the seven-step request pipeline: host allowlist, read-only guard, credential swap (including the `prrla-basic` form), rate governor, timeout, retry, recorder;
  - per-destination timeouts: 30 s for SCMs, 15 s for timestamp authorities. The job hand-off at 25 s is in `functional-design.md` §U5;
  - the broker is the only retrier;
  - the definition fields `hosts`, `credentials` and `writePaths`;
  - the `src/api` foundation (`AuditContext` with `mode`), which U4, U8 and U9 add to and U5 completes.
- **Consumers it takes over:** built-in providers, built-in ledgers, Beacon, TransparencyLog and U1's adapter.
- **Constraint:** defaults equal the smallest published limits (NFR12, table in `nfr-design.md` §3).

**U2b · Plugin lock and isolated host**
- **Owns:** the lock file, identity hashing, and the child-process host with IPC.
- **Constraint:** a lock entry is written only by `pr-rla plugin add` (FR2.3). The Node 25 network-denial test is marked unverified until it runs.

**U3 · SDK carry-overs**
- **Owns:** optional additions within provider API version 1, plus the selector rules in the core.
- **Boundary:** `head` and `headSha` belong to `ListChangesRequest` and `ListChangesResult`, not to `ChangeRecord`.

**U4 · Issue ledgers and checkpoints**
- **Owns:** the two built-in issue ledgers, the ledger SDK deltas, the ledger kit, the Jira example, and the checkpoint writer with its git transport (`contracts.md` §6).
- **Boundary:** the git transport runs outside the broker (git is not HTTP the broker can proxy), with its own 30 s timeout per git call and at most 3 retries. It is never reachable in read-only mode.
- **Constraint:** label-event fixtures come from read-only recordings of public issue timelines where they exist, otherwise synthetic (D8, AS-04).

**U5 · Audit API, draw-context and MCP server**
- **Owns:**
  - the read-only/read-write split of every command;
  - the draw-context assembly and its untrusted-content fence, built by the core (the MCP server passes it through);
  - `describeChange` on the built-in providers;
  - the `pr-rla-mcp` package.
- **Constraint:** the MCP server writes nothing. Job state and the preview cache live in memory. FreezeCheckpointStore and the broker's recorder are not used in read-only mode.

**U6 · Assistant integrations**
- **Owns:** the plugin files, the guard hooks with one adapter per client, and the setup guides.
- **Constraint:** the founder checks Claude Code, Codex and Cursor by hand (RQ2).

**U7 · CI integrations**
- **Owns:** the three templates and their exit-code mapping.
- **Constraint:** tested on fixtures and mock servers only: no scratch repos or projects, and no runs against real repos (D8).

**U8 · Org-pooled freeze**
- **Owns:** RepoSet resolution, the pooled population, checkpoints and resume, and `--estimate`.
- **Constraint:** built in this round (scope). One provider per pooled registration (RQ15). The draft's defaults stand, with no `--skip-repo` (RQ16).

**U9 · Presence-attested verdicts**
- **Owns:** pure SSHSIG verification, allowed signers, and `minProvenance` in check 7.
- **Constraint:** software keys only (D7). Software-emulated authenticator fixtures prove the verifier logic, never hardware presence (FR9.6).

**U10 · Docs and release engineering**
- **Owns:** the documents, the compatibility table (including exit codes), SECURITY.md with a placeholder contact, the release checklist, and the gh-aw registration hand-off.
- **Constraint:** no publish step runs (FC-15).

## Deployment model

pr-rla is a library and CLI, not a hosted service.

| Deliverable | Units | Deployment |
|-------------|-------|------------|
| `pr-rla` npm package (CLI, core, SDK subpaths, built-ins, trust bundle) | U1, U2a, U2b, U3, U4, U5 (API and CLI), U8, U9 | One package, released together |
| `pr-rla-mcp` npm package | U5 (server) | Separate package, pinned to an exact `pr-rla` version |
| `integrations/claude-code`, Codex and Cursor guides | U6 | Plugin directory and docs in the repo, not an npm package |
| `integrations/github-action`, `integrations/gitlab`, `docs/ci/bitbucket.md` | U7 | In the repo; the Action carries its own lockfile |
| `examples/ledgers/jira`, `examples/providers/gitea` | U4, existing | Separate example packages |
| Docs, checklists | U10 | In the repo |

## Kept, changed and added against the draft's `04`

- **Kept.** The eleven units, their scope, and the draft's dependency edges.
- **Changed.**
  - U1 no longer waits on a Rekor staging entry. Its live work is token fetches with hashes only (D3, D2). It binds to the broker interface, not the broker build (ADR-002).
  - U1 uses an ASN.1/CMS library chosen by evaluation, not a hand-written DER walker (RQ8).
  - U4 gains an edge to U2a, because ledgers fetch through the broker. Its fixtures come from public timelines and synthetic data, not a scratch repo (D8).
  - U5's MCP server keeps all state in memory, and FreezeCheckpointStore and the recorder are off in read-only mode.
  - U7's acceptance no longer uses scratch repos, `act` against real repos, or a `gitlab-ci-lint` call on a scratch project (D8). See `functional-design.md` §U7.
  - U8 is built in this round. The vision's "v0.2" label is gone.
  - U9's fixtures come from software keys, including a software-emulated authenticator, not from the founder's FIDO key (D7).
  - Every unit has a directory name `u{n}-…` and a kind.
- **Added.**
  - The git transport for checkpoints, owned by U4 (fixes domain-design finding R-01).
  - The explicit rule that U1 depends on the broker contract, not on U2a's implementation.
