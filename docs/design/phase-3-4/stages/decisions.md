# Architecture Decisions: pr-rla phases 3–4

Each decision traces to `inception/requirements-analysis/requirements.md`, the component catalogue in `components.md`, and the founder's answers carried in `domain-design-questions.md`. Each ADR carries Context, Decision, Consequences (with security implications) and Alternatives Rejected.

## ADR-001: Keep a pure core behind one audit API

**Status:** Accepted (kept from the draft's `03` §1)

**Context.** The CLI, the MCP server and CI all run the same operations. The MCP server must provably write nothing (FR3.2). The statistics and verify checks are fixed and must stay exhaustively testable (FC-01 to FC-03).

**Decision.** All I/O is composed in one AuditApi layer, which takes a read-only or read-write mode. The CLI and the MCP server are thin callers. AuditCore stays pure and imports only the SDK and other core modules. The existing architecture-boundaries test is extended to enforce this.

**Consequences.**
- Read-only mode is enforced in one layer.
- The MCP server needs no audit logic of its own.
- The core stays fixture-testable without a network.
- Cost: the CLI commands must be refactored into formatters over the API.
- Security: a single enforcement point for the verdict-authority guarantee (FR3.3).

**Alternatives rejected.**
- *Commands keep doing their own I/O* (the phase-2 shape). Rejected: read-only would have to be proven per command and per tool.
- *A separate MCP implementation of each operation.* Rejected: two code paths would drift, and the byte-identical guarantee would need its own proof.

## ADR-002: Route every outbound HTTP call through the fetch broker

**Status:** Accepted (changed from the draft)

**Context.** The draft routes provider and ledger traffic through the broker, but lets the timestamp client, drand and Rekor call the network directly. NFR14 requires a timeout on every network call. NFR11 records fixtures for every external API. FR3.2 requires that the MCP server send no non-read request.

**Decision.** TimeEvidence, Beacon and TransparencyLog also make their HTTP calls through FetchBroker, with per-destination timeouts: 15 s for timestamp authorities and 30 s for SCMs.

**Consequences.**
- Timeouts, retries, recording and the read-only guard are enforced once.
- A timestamp or Rekor POST can never leave from a read-only run.
- Cost: the broker becomes a hub that most components depend on, so its interface must stay small and stable.
- Security: one place to check that credentials are swapped in only on declared hosts.

**Alternatives rejected.**
- *Direct calls from each component* (the draft). Rejected: four places to enforce timeouts and recording, and the read-only guard would not cover them.
- *A shared low-level HTTP helper without a broker.* Rejected: it gives retries but no shared per-host budget and no read-only mode.

## ADR-003: Ship the MCP server as its own package with in-memory state only

**Status:** Accepted (RQ11; FR3.1, FR3.2, FR3.5)

**Context.** The MCP SDK brings `zod` and protocol code that the core should not carry (NFR9). Long calls need job handles, but the server must write nothing.

**Decision.** `pr-rla-mcp` is a separate package pinned to an exact `pr-rla` version. Jobs and the `freeze_preview` cache live in memory. A handle is unknown after a restart, and a cached preview expires after 10 minutes.

**Consequences.**
- The core's dependencies stay minimal, and the server proves "writes nothing" with a simple file-open check.
- Cost: a restart loses in-flight jobs, and the user re-runs the call.
- Security: the server cannot leave state behind for a later process to trust.

**Alternatives rejected.**
- *An `mcp` command inside `pr-rla`.* Rejected: it puts the MCP SDK into the core package's dependencies.
- *Persist jobs under a cache directory.* Rejected: it breaks the writes-nothing guarantee and its test.

## ADR-004: Make presence verification its own pure component

**Status:** Accepted (added; FR9)

**Context.** Check 7 enforces `minProvenance`, and the `presence` level depends on verifying SSHSIG signatures and the FIDO user-presence flag. The draft placed this inside the git-file ledger. With no FIDO key (D7), the verifier is proven only with software keys.

**Decision.** PresenceVerifier is a pure component beside the core, over `node:crypto`. It verifies `ed25519`, `ed25519-sk` and `ecdsa-sk` signatures, checks the UP flag, and matches allowed signers. The ledger supplies raw signatures; the core decides the level.

**Consequences.**
- Check 7 stays in the core with no dependency on a plugin.
- The verifier has its own fixtures and is cross-checked against `ssh-keygen -Y verify`.
- Cost: one more component to version.
- Security: the verifier's output says it proved verifier logic only, so no certificate claims hardware-verified presence (FR9.6).

**Alternatives rejected.**
- *Inside the git-file ledger* (the draft). Rejected: the core would depend on a plugin for a check it owns.
- *Shell out to `ssh-keygen -Y verify`.* Rejected: an extra runtime the core may not carry (FC-04), and `ssh-keygen`'s handling of the UP flag is itself unverified (RK-12).

## ADR-005: A plugin enters the lock only through an explicit `plugin add`

**Status:** Accepted (changed; RQ13; FR2.3)

**Context.** The draft also created a lock entry at the first `register`, trusting whatever was installed then. Plugin code runs with the CLI's privileges (FC-13).

**Decision.** Only `pr-rla plugin add` writes a lock entry. It prints the source, version and integrity it trusts. `register` with an unlocked external plugin refuses and names `plugin add`.

**Consequences.**
- The trust decision is a visible, deliberate act.
- Cost: one extra command in the setup guide.
- Security: a compromised install cannot become trusted as a side effect of registering.

**Alternatives rejected.**
- *Implicit lock at the first `register`* (the draft). Rejected: trust becomes a side effect.
- *Sign the lock with the audit key.* Rejected for now: the lock is already re-hashed at every load and recorded in the signed registration, so a signature adds key handling for little gain.

## ADR-006: Verify timestamp tokens with a maintained ASN.1/CMS library inside TimeEvidence

**Status:** Accepted (changed; RQ8; FR1.3)

**Context.** The draft hand-wrote a DER walker in `src/timestamp/der.ts` and called it pure core parsing. The founder ruled that tamper-proofing parsing should not be hand-written when a maintained library exists.

**Decision.** TimeEvidence uses a maintained ASN.1/CMS library (`pkijs` + `asn1js` first), chosen by an evaluation recorded in Functional Design. TimeEvidence hands the core already-verified evidence; the core does not parse DER. If no library qualifies, TimeEvidence hand-writes the parser and the reason is recorded.

**Consequences.**
- Less own cryptographic parsing code.
- Cost: new runtime dependencies in the core package (NFR9), which the evaluation must keep small and maintained.
- Security: the library's own vulnerabilities become pr-rla's, so its version is pinned and covered by the six tamper fixtures.

**Alternatives rejected.**
- *Hand-written DER walker* (the draft). Rejected by the founder unless the evaluation finds no suitable library.
- *Shell out to `openssl ts -verify`.* Rejected: an extra runtime, and behaviour that varies across platforms (NFR19).

## ADR-007: Keep the plugin contracts in the SDK, additive within API version 1

**Status:** Accepted (kept; RQ18; FR7.7)

**Context.** Third-party providers already depend on `pr-rla/provider` version 1. The new fields (`head`, `headSha`, `Actor.id`, `reviewGranularity`, `landedVia`, `describeChange`, `listRepos`, ledger `readHistory`) are all needed by this round.

**Decision.** PluginSdk owns ChangeRecord, Actor, ChangeDescription, RepoRef, VerdictEvent and LedgerHistoryEvent. Every addition is optional, so old plugins keep working.

**Consequences.**
- No version bump; the phase-2 providers pass unchanged.
- Cost: the core must handle every optional field being absent, for example a provider that ignores `head` produces a check-5 detail instead of failing.
- Security: no change to what a plugin may access; access stays governed by the broker and the host.

**Alternatives rejected.**
- *Bump to provider API version 2.* Rejected: it breaks the Gitea plugin and every third-party provider for fields they can safely ignore.
- *Put the new fields in a side channel* (provider options). Rejected: options are not typed contracts, and the draft's `02` Q3 already found them unregistered.
