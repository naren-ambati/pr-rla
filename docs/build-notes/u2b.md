# Bolt 4 (U2b): plugin lock and isolated plugin host (2026-11-03)

Goal (delivery-plan.md, bolt 4): `pr-rla.lock.json`, written only by an explicit `pr-rla plugin add`; the npm integrity and tree hash re-checked at every load; external plugins out of process in a host with a scrubbed environment and the Node permission model; credentials only as placeholders the broker swaps on declared hosts (including `prrla-basic:`); `trust: full` as a per-plugin opt-in; `--plugins builtin-only` and `PR_RLA_PLUGINS`; `pr-rla plugin check` as a correctness gate; RK-02 settled or recorded.

Built on branch `bolt/u2b-plugin-host` from the end of bolt 2 (`54e1628`), in parallel with U4 (bolt 3) and U3, so this bolt has neither U4's ledgers and ledger kit nor U3's SDK additions. These notes live here rather than in BUILD-NOTES.md so the branches merge cleanly.

## Definition of done

| Item | State | Where it is shown |
|---|---|---|
| FR2.1 the registration records each plugin's name, source, version, content hash and options hash | met | `plugin-lock.test.ts › register records name, source, version, content hash and options hash`: `integrity` is the lock's treeSha256, `trust` the locked trust |
| FR2.2 the lock pins version, npm integrity and a tree hash; a mismatch at load refuses | met | `› a changed file is refused at load` (freeze and register), `› the tree hash covers … each dependency separately`, `› records the integrity … a changed package-lock entry is refused at load` |
| FR2.3 only `plugin add` creates a lock entry, printing what it trusts; `register` never extends the lock and refuses an unlocked plugin naming `plugin add` | met | `› exits 1 with the command to run; writes no lock and no registration`, `› prints the source, version, resolved, npm integrity and tree hash it trusts, and asks first`, `› … leaves the lock untouched` |
| FR2.4 out of process, scrubbed environment, placeholders swapped on declared hosts only; the security model states the Node 22/24 limit; Node 25+ network test run or marked unverified | met, with the limit | `plugin-host.test.ts › the hostile fixture plugin, contained` on Node 22.23.2 and 26.8.2; `docs/security-model.md`; RK-02 below |
| FR2.5 `trust: full` opt-in, recorded, printed by `verify` | met | `› runs in process with the real environment and prints PLUGIN TRUST: full` (register, freeze, verify) |
| FR2.6 `--plugins builtin-only` and `PR_RLA_PLUGINS=builtin-only` refuse all external code | met | `› refuse an external plugin before it is resolved or imported` (a module that throws on import never runs); other values refused |
| FR2.7 `plugin check` runs the kit through the host and says correctness, not safety | met | `› passes the Gitea example through the host and says correctness, not safety`; `node dist/cli.js plugin check ./examples/providers/gitea/index.mjs --offline` (below) |
| NFR13 `engines.node >= 22.13`; Node 25 network denial verified or recorded | met | `package.json`; RK-02 ran on Node 26.8.2 |
| The Gitea example passes the conformance kit **through the host** | met | `› on recorded Codeberg responses` and `› on the synthetic Forgejo (every merge strategy, a 45 s rate-limit wait proxied to the parent's clock)`; `plugin check` from `dist/` |
| The hostile fixture reads a placeholder, not the token | met | the demo below; `› reads a placeholder, not the token; no other variable reaches it` |
| Node 25 IPC/network-denial test | **ran** on Node 26.8.2 (found on PATH): IPC works under `--permission` without `--allow-net`, and the child's socket is `ERR_ACCESS_DENIED`. Node 25.x itself is not installed here, so the 25.x row rests on 26 | `› RK-02 … IPC works and the child has no network` |
| test-design.md U2b: tree-hash mismatch, symlink escape, builtin-only before import, register exit 1, install-script warning, 60 s without heartbeat kills the child | met | `plugin-lock.test.ts`, `plugin-host.test.ts › heartbeats, silence and message size` |

## Done

| Piece | Where |
|---|---|
| The lock: resolution (package by `node_modules` walk and its `.` export; path inside the audit repo, root = nearest package.json), transitive runtime dependencies, tree hash, read grants, install-script scan, load-time checks, builtin-only policy | `src/plugins/lock.ts`, `src/plugins/errors.ts` |
| The protocol `pr-rla/ipc/v1` (types and limits) | `src/plugins/protocol.ts` |
| The child: SDK mapping, IPC fetch and sleep, calls, heartbeats; no runtime import from pr-rla | `src/plugins/child.ts` |
| The parent: spawn with the permission flags, IPC, watchdog, size limits, secret scrubbing, definition validation, provider and ledger proxies | `src/plugins/host.ts` |
| Opening external plugins for commands (lock, then isolated or full) | `src/plugins/open.ts`, wired in `src/api/context.ts` (`openProvider`, `openLedger`, `plugins` policy, no-hosts sentinel) |
| External plugin identity from the lock, never an in-process import of an isolated plugin | `src/plugins/identity.ts`, `src/registry.ts` (`pluginIdentity`, `builtinProviderName`, `builtinLedgerName`) |
| Lock entries (shared by the CLI and tests) | `src/plugins/entry.ts` |
| `plugin add`, `plugin lock`, `plugin check`; `--plugins builtin-only`; hosts stopped when a command ends | `src/commands/plugin.ts`, `src/plugins/check.ts`, `src/cli.ts` |
| `register` prints each plugin's trust and tree hash, and `PLUGIN TRUST: full`; `verify` repeats it and warns in check 5 when the provider it loads is not the registered one | `src/commands/register.ts`, `src/commands/verify.ts` |
| The Gitea example declares `hosts`, `GITEA_TOKEN` for codeberg.org and its conformance fixture | `examples/providers/gitea/` |
| The hostile fixture | `test/fixtures/plugins/hostile/` |
| Tests: 37 new | `test/plugin-host.test.ts` 20 (one is the "unverified" placeholder, skipped when a Node 25+ is found), `test/plugin-lock.test.ts` 17 |
| Demo | `scripts/demo-plugin-host.mjs` |
| Docs | `docs/security-model.md` (new: the plugin section), `docs/writing-a-provider.md` §§3, 4, 7, README (step 5, one limitation) |

## RK-02: the Node 25 test

Measured 2026-11-03 on macOS with the Node versions Homebrew already had (nothing was installed for this bolt): a child started as the host starts it (`--permission`, fs-read limited, no `--allow-net`):

| Node | IPC under `--permission` | read outside the scope | write | `net.connect` |
|---|---|---|---|---|
| 22.23.2 | works | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` | **connects** |
| 24.20.0 | works | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` | **connects** |
| 26.8.2 | works | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| 26.8.2 with `--allow-net` | works | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` | connects |

So the design's "if it passes" branch applies: the child never gets `--allow-net`, and on Node 25 or later it has no network. The test (`plugin-host.test.ts › RK-02`) looks for a Node at 25 or later as this one, in `PR_RLA_NODE25`, or on PATH, and runs it as the child; with none it reports a skipped `UNVERIFIED` test instead. On this machine PATH has `/opt/homebrew/bin/node` (26.8.2) after Node 22, so plain `npm test` runs it.

## Verified (command → output)

From a clean state in the worktree (`node_modules`, `dist` and `examples/providers/gitea/node_modules` removed; nothing else untracked), at `b6e68c7`, 2026-11-04T00:24Z, Node 22.23.2:

```
npm ci                                     → added 60 packages … found 0 vulnerabilities
npm run build                              → exit 0
npm run typecheck                          → exit 0
npm test                                   → Test Files 29 passed (29) · Tests 344 passed | 1 skipped (345)
npm --prefix examples/providers/gitea ci   → added 1 package … found 0 vulnerabilities
npm --prefix examples/providers/gitea test → ok 1 - conformance on recorded Codeberg responses (forgejo/docs, 2026-10-01..07) · # pass 1 · # fail 0
npm ls --prod --depth=0                    → asn1js 4.0.0, commander 15.0.0, drand-client 1.4.2, pkijs 4.0.1, yaml 2.9.1 (no new dependency)
```

- 345 = the 308 of bolt 2, unchanged in what they assert, plus 37 new; the one skipped is the `UNVERIFIED` placeholder, skipped because the RK-02 test ran.
- The same suite under Node 26.8.2 (`/opt/homebrew/bin/node node_modules/vitest/vitest.mjs run`): 339 passed, 1 skipped (the second hostile block is not added when the test's own Node is already 25+).
- Each commit of this bolt was checked in a scratch clone: typecheck clean at every one; 308, 308, 308, 308, 344 (+1 skipped), 344 (+1 skipped) tests passing.
- `npm test` makes no network call. The children run only fixtures and the Gitea plugin, whose every request comes back to the parent's fake transports; the hostile plugin's one socket goes to a loopback server the test starts.

`plugin check` from the build, offline:

```
$ node dist/cli.js plugin check ./examples/providers/gitea/index.mjs --offline
plugin check ./examples/providers/gitea/index.mjs: provider gitea@0.1.0 (path)
  lock            not locked: run "pr-rla plugin add ./examples/providers/gitea/index.mjs" to trust it
  npm signatures  not applicable: a path plugin is not from the npm registry
  hosts           codeberg.org (with no options: not named in .pr-rla.yml)
  credentials     GITEA_TOKEN -> codeberg.org
  conformance     the provider kit through the plugin host, on 1 recorded fixture(s)
    ok   codeberg-forgejo-docs-2026-10-01.json › api-version
    … (normalization, window-and-kinds, classification, merge-strategies, no-double-counting,
       stable-sorted-ids, review-state-mapping, actors, pagination, kind-filtering: ok;
       bot-detection: skip, the fixture declares no bots)
    ok   codeberg-forgejo-docs-2026-10-01.json › transient-faults
  conformance     PASS
conformance = correctness, not safety: a malicious plugin can pass it
exit 0
```

On a scratch copy of the repo, `pr-rla -C examples/codeberg-forgejo-docs-2026-10 plugin add ../providers/gitea/index.mjs --yes` wrote the lock entry the example's comment describes (`source path`, `resolved file:../providers/gitea`, `hosts codeberg.org`, `GITEA_TOKEN -> codeberg.org`, trust isolated). No `freeze` ran against Codeberg: no live call was needed in this bolt.

## The demo

`node scripts/demo-plugin-host.mjs` (offline, after `npm run build`), Node 22.23.2:

```
U2b demo: a hostile provider through pr-rla's plugin host (this Node v22.23.2)
  the parent's environment has GITHUB_TOKEN=ghp_DEMO…, GITHUB_USER and AWS_SECRET_ACCESS_KEY
  lock entry: ./plugins/hostile/index.mjs · trust isolated · treeSha256 c8ee5d28a6eff068… · hosts api.github.com, uploads.example.com · credentials GITHUB_TOKEN -> api.github.com; GITHUB_USER -> api.github.com
  [pr-rla] plugin hostile@6.6.6 runs isolated: placeholder credentials, read-only access to its own files; Node 22 cannot block its network access, so it could still send out what it reads (Node 25 or later blocks it)
  what the plugin got, inside the host:
    process.env.GITHUB_TOKEN                 prrla-cred:GITHUB_TOKEN
    process.env.AWS_SECRET_ACCESS_KEY        null
    its whole environment                    GITHUB_TOKEN, GITHUB_USER, PR_RLA_HOST, __CF_USER_TEXT_ENCODING
    read ~/.npmrc                            refused: ERR_ACCESS_DENIED
    read a file outside the plugin           refused: ERR_ACCESS_DENIED
    read /proc/<parent>/environ              refused: ERR_ACCESS_DENIED
    write a file (own dir / tmp)             refused: ERR_ACCESS_DENIED / refused: ERR_ACCESS_DENIED
    start a process                          refused: ERR_ACCESS_DENIED
    token to its declared host, echoed back  allowed: "200 {\"authorization\":\"token prrla-cred:GITHUB_TOKEN\"}"
    Basic auth to it, echoed back            allowed: "200 {\"authorization\":\"Basic prrla-basic:GITHUB_USER:GITHUB_TOKEN\"}"
    the placeholder to another declared host refused: CREDENTIAL_HOST_MISMATCH
    the placeholder to an undeclared host    refused: HOST_NOT_ALLOWED
    prrla-basic: to an undeclared host       refused: HOST_NOT_ALLOWED
    global fetch() to an undeclared host     refused: HOST_NOT_ALLOWED
    POST (provider requests are read-only)   refused: READ_ONLY_VIOLATION
    open a socket to 127.0.0.1               allowed: "connected" (the server received "exfiltrated")
  what the fake api.github.com received (the broker swapped the placeholder there, and only there):
    GET https://api.github.com/echo  Authorization: token ghp_DEMO0123456789secret
    GET https://api.github.com/echo  Authorization: Basic YWxpY2U6Z2hwX0RFTU8wMTIzNDU2Nzg5c2VjcmV0
```

With `/opt/homebrew/opt/node@24/bin/node` the output is the same (Node 24). With `/opt/homebrew/bin/node` (26.8.2) every line is the same except two: `… no network (Node 26)` and `open a socket to 127.0.0.1  refused: ERR_ACCESS_DENIED`.

## Deviations from the design, and why

1. **Additions within `pr-rla/ipc/v1`.** The protocol is new in this release, so these are part of v1, not a new version:
   - a `describe` call evaluates `hosts(options)` and `writePaths(options)` without creating an instance, so the parent can refuse before `create` runs;
   - `sleep`/`slept` and `log` messages, so a plugin's waits run on the command's clock (one clock per command, as bolts 1 and 2 require) and its `ctx.log` reaches the command's log;
   - `error` with `id: null` reports a load failure;
   - `appendVerdict` and `nativeCounts` are callable: the SDK interfaces have them and the contract's method list left them out;
   - `ready` also carries the definition's shape, `credentials`, `populationOptions` and the child's Node version.
2. **The parent validates the definition**, not the child: the child reports the fields and the parent runs the SDK's own `assertProviderDefinition` / `assertLedgerDefinition` on them, so a hostile child cannot skip validation.
3. **A plugin links against the host's SDK.** `module.registerHooks` in the child maps `pr-rla/provider` and `pr-rla/ledger` to pr-rla's own modules. A plugin's own copy of pr-rla (the Gitea example's `file:` link points at the whole repo) is never loaded, hashed or readable, and an isolated plugin needs no `npm install`. `trust: full` plugins still resolve their own, as before. This needs Node 22.15 or later; on an older Node the child refuses with that message (untested there: only 22.23.2, 24.20.0 and 26.8.2 ran).
4. **Lock fields.** `name` is the plugin definition's name (what the child reports), so `PluginIdentity.name` stays what it was; `version` comes from the plugin's package.json; `resolved` and `npmIntegrity` from the audit repo's package-lock.json for a package, `file:<path from the audit directory>` and null for a path plugin, and null integrity for an npm local-path (link) install. `plugin add` refuses a package with no package-lock entry (the draft's "required for package plugins").
5. **"Inside the audit repo"** is the git work tree holding the audit directory (or the directory itself without one), so the Codeberg example's `../providers/gitea` qualifies.
6. **A placeholder only for a credential that is set.** An unset locked credential stays unset in the child, as it would in process; otherwise every anonymous run would send a placeholder the broker cannot swap and be refused.
7. **What the lock grants is what the broker enforces.** At load, what the plugin now asks for (hosts and write paths for these options, credential names) must be within its lock entry, or it is refused with `plugin lock`. This catches an options change such as a new `base_url`.
8. **An isolated plugin that declares no hosts may contact none.** The broker reads an empty host set as "any" (built-ins), so the AuditContext gives such a plugin a set no host matches.
9. **Message limits.** Outgoing messages are measured before they are sent. Incoming ones are measured after Node's IPC channel has parsed them, so the limit bounds what is accepted, not memory. The heartbeat watchdog counts any message and runs only while the plugin loads or a call is in flight.
10. **Broker hints across IPC.** An isolated plugin's `acceptJson` predicate cannot cross a process boundary, so it becomes "the body must parse", and its retry counts are capped at the broker's own limit (6 retries).
11. **`plugin check` fixtures** are data: the recorded-fixture format of `scripts/record-fixture.mjs`, listed in the plugin's package.json as `"pr-rla": { "conformance": [...] }` and/or passed with `--fixture`. The parent replays them; requests to hosts the plugin did not declare are refused as the broker would. With no fixtures, `check` exits 1: a gate with nothing checked does not pass. There is no ledger kit on this branch (it is U4's), so a ledger's check reports that and exits 1. Only the expectations of the kit's shape are read (the recorder writes `expected.pullRequests` as a count).
12. **`plugin add` and `plugin lock` need the plugin named in `.pr-rla.yml`**, because its options decide its hosts; `plugin check` does not (it then asks with no options).
13. **Check 5's identity comparison is in the verify command**, not in `src/core/verify.ts`, to leave the core to U3 (which adds the `populationOptions` FAIL there). It compares an external provider's name, source, version, integrity, options hash and trust, and turns a PASS into a WARN with the difference.
14. **Every command opening an isolated plugin prints what isolation it has** (NFR4): placeholder credentials, read-only access to its own files, and whether this Node blocks its network.
15. **The child replaces its global `fetch`** with the IPC fetch, so a plugin calling `fetch()` directly still goes through the broker.
16. **The `now` field** the Gitea tests inject in process is not part of the SDK and is not forwarded; the child uses its own clock. The Gitea plugin uses it only to stop its second list walk, and the recorded and synthetic data give the same results.
17. **One existing test's setup changed.** `test/api-context.test.ts` opened an unlocked example plugin through `openProvider`; it now copies and locks it in a temp audit directory first (5 lines). Every assertion is unchanged.

## Findings

- On Node 22 and 24, `process.permission.has("net")` is `false` although the network is not controlled at all. The host goes by the Node version (25 or later), not by that call.
- A directory grant does not leak to a sibling with the same prefix (`plug` vs `plug-evil`), and a bare import resolves when only the dependency's own directory is granted. Node removes `NODE_CHANNEL_FD` from the child's environment; macOS adds `__CF_USER_TEXT_ENCODING` to every process.
- `module.registerHooks` works under `--permission` without `--allow-worker` (its hooks run in-thread).
- The tree must be hashed before a child is granted anything: the permission model checks the path it is given, so an escaping symlink inside a granted directory would otherwise be read through (the class of CVE-2025-55130). `readGrants` hashes first.
- A child starts in about 70 ms; the kit through the host on one fixture takes about 0.5 s (it makes six instances, so six children).

## Unverified

- Node 25.x itself (the row rests on 26.8.2), Linux (`/proc/<ppid>/environ` was refused, but macOS has no `/proc`), Windows.
- Node 22.13 and 22.14 (no `module.registerHooks`): the child should refuse with the 22.15 message; not run.
- `npm audit signatures` in `plugin check`: it asks the npm registry, so it never ran in this bolt (`--offline` everywhere).
- A package plugin installed from the real registry: the tests use synthetic package-lock entries.
- An external ledger against a real tracker, and the ledger kit through the host (U4).
- **Credentials whose hosts depend on options.** SDK v1's `credentials` is a static list, so the Gitea example declares `GITEA_TOKEN` for codeberg.org only. An isolated self-hosted Gitea with a token gets `CREDENTIAL_HOST_MISMATCH` (refused unsent) instead of sending it; in process it works as before. Open question: a credential grant `plugin add` takes from the reviewer (`--credential ENV=host`), or `credentials(options)` in a later SDK.

## Shared files this bolt touched (for merge planning)

- `src/api/context.ts`: imports; `AuditContext.plugins` and `AuditContextOptions.plugins`; the no-hosts sentinel in `hostsFor`; one early branch in `openProvider`; `openLedger`'s first five lines moved into `openBuiltinLedger`.
- `src/registry.ts`: two imports; `builtinProviderName`, `builtinLedgerName`; an external branch at the top of `pluginIdentity` and its new `policy` parameter (U3 edits the built-in branch's `populationOptions` below it).
- `src/commands/context.ts` (`CommandContext.plugins`, one line in `auditContextFor`), `register.ts`, `freeze.ts` (pass the policy to `pluginIdentity`; register prints plugin lines), `verify.ts` (identity WARN, `PLUGIN TRUST` line), `src/cli.ts` (`--plugins`, the `plugin` command group, `closeAllPluginHosts` in `run`).
- `examples/providers/gitea/index.mjs` (two definition fields, next to where U3 adds its own) and `package.json` (`files`, `"pr-rla"`); `examples/codeberg-forgejo-docs-2026-10/.pr-rla.yml` (comment).
- `package.json` and `package-lock.json`: `engines.node` `>=22.13` only. No export, dependency or script changed; `src/testing/index.ts` untouched.
- `README.md` (step 5 under "Adding a provider", one limitation bullet), `docs/writing-a-provider.md`, `test/api-context.test.ts` (above). New: `docs/security-model.md`, `docs/build-notes/u2b.md`.

## What later units need to know

- **U8 (org-pooled freeze runs external providers through the host).** Open the provider once per freeze with `openProvider`: one child serves every repo. The host takes concurrent calls (each has its own id), so P = 4 parallel `listChanges` on one hosted provider works and shares the broker's per-host budget. `listRepos` is proxied when the plugin has it. Keep each call's result under 64 MiB, which per-repo calls do; do not build the pooled population inside the plugin. Pass `req.signal` to cancel (the host sends `cancel` and aborts that child's in-flight fetches). A long `listChanges` is safe: heartbeats continue while the child waits on the broker. The lock's hosts are computed from the configured options at `plugin add`, so a rule's hosts must not vary per repo. The child dies with the command (`closeAllPluginHosts`); a resumed run starts a new one. `freeze` calls `pluginIdentity` after opening the provider, which starts a second, short-lived child to read `populationOptions`.
- **U3.** For an isolated plugin, `populationOptions` comes from the child's `ready` message, already wired in `src/plugins/identity.ts`. Never import an isolated plugin in process to read it. When `pr-rla/http` is exported, add it to `SDK_MODULES` in `src/plugins/host.ts`. `head`, `headSha` and `Actor.id` cross IPC as data. Expect a small conflict where both branches add fields to the Gitea definition.
- **U4.** An external ledger through `openLedger` or a command now needs a lock entry; tests can use `test/helpers/plugin-lock.ts`. Wire `runLedgerConformance` into `src/plugins/check.ts` (ledgers report "not run" and exit 1 today). An isolated ledger has no fs-write: a Jira ledger that only speaks HTTP is fine. `readHistory` is proxied. The Jira example's `prrla-basic:JIRA_EMAIL:JIRA_TOKEN` works through the host when both are locked credentials for its site; see the credential open question above for options-dependent hosts.
- **U5.** In read-only mode an isolated ledger's writes are refused before they reach the child (tested). `pr-rla-mcp` should honour `PR_RLA_PLUGINS`.
- **U10.** `docs/security-model.md` holds the plugin section; extend it with the rest of the model. `engines` is already `>=22.13`.
