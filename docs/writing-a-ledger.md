# Writing a ledger

A ledger is where reviewers' verdicts on the draws live, and what `status` and `verify` read them from. `git-file`, `github-issues` and `gitlab-issues` are built in; anything else is a plugin, loaded from `.pr-rla.yml` like a provider ([`writing-a-provider.md`](writing-a-provider.md)). This guide covers the contract, the rules the core applies to what a ledger returns, and the ledger conformance kit, with the Jira example ([`examples/ledgers/jira`](../examples/ledgers/jira), `pr-rla-ledger-jira`) as the worked case. The full contract is [`contracts.md` §1](design/phase-3-4/contracts.md), "`pr-rla/ledger`"; the types are `src/sdk/ledger.ts`.

## 1. The contract

Everything is exported from `pr-rla/ledger`, at `ledgerApiVersion` 1:

```ts
export default defineLedger({
  ledgerApiVersion: 1,                         // the SDK version this ledger was written for, as a literal
  name: "jira",                                // lowercase
  provenance: "account",                       // what its verdicts can attest (below); absent means "self-asserted"
  hosts: (options) => [/* the hosts it contacts with these options */],
  writePaths: (options) => [/* host/path prefixes where it may write */],
  credentials: [{ env: "JIRA_TOKEN", hosts: [], hostFromOption: "base_url" }],
  create(options, ctx): Ledger { … },          // options come from .pr-rla.yml
});

interface Ledger {
  apiVersion: number;                          // 1
  name: string;
  readVerdicts(): Promise<VerdictEvent[]>;     // every verdict event, in recorded order
  appendVerdict(event: VerdictEvent): Promise<void>;                          // pr-rla record
  publishDraws?(draws: DrawForLedger[], context?: PublishContext): Promise<void>;   // pr-rla sample; idempotent
  verifyIntegrity?(): Promise<LedgerIntegrityReport>;                         // its own history (check 7)
  readHistory?(): Promise<LedgerHistoryEvent[]>;                              // for checkpoints
}

interface VerdictEvent {
  draw: number;              // 1-based
  changeId: string;          // the drawn change
  verdict: "pass" | "fail";
  protocolSha256: string;    // the protocol the reviewer applied (the registration's)
  reviewer: string;          // a login, or an account id the registration can name as id:<n>
  recordedAt: string;        // ISO 8601 UTC: the tracker's own time
  note?: string;
  provenance?: { level, source, actorId?, viaApp?, eventId?, signer?, keyFingerprint?, counter? };
}
```

`ctx` is `{ cwd, windowDir, env, log, fetch, sleep?, reviewers?, index? }`. Use `ctx.fetch` for every request and `ctx.sleep` for every wait: in a real run they are pr-rla's fetch broker and the command's clock, and the kit injects its own.

## 2. What the core does with your verdicts

`readVerdicts` returns **every** verdict event, eligible or not, **in recorded order**: by the tracker's time, then by its event id. Use `compareByTimeThenId` / `compareEventIds` from `pr-rla/ledger`: ids compare as integers (a lexical order would count the wrong one of two same-second verdicts), and colon-separated ids (Jira's `<history id>:<item>:<action>`) compare part by part. Then the core (`classifyVerdicts`, which `status`, check 7 and the kit share):

- ignores, with a reason, a verdict under another protocol, on a change that was not drawn, on a draw that is not that change, or by an ineligible account: a bot (`[bot]` login), an app (`provenance.viaApp`), or, when the registration lists `verdicts.reviewers`, anyone not on it (entries match a login case-insensitively, or `id:<n>` against `provenance.actorId` exactly);
- counts the **first** eligible verdict per change; a later different one is reported as a relabel;
- fails check 7 when a counted verdict's `recordedAt` precedes the seed round's publication (`recordedBeforeSeed`): `recordedAt` must be the tracker's time, never the reviewer's claim.

**Provenance.** Every verdict needs `provenance: { level, source }` (the kit fails one without). `level` is `self-asserted`, `account` (an account the tracker authenticated did it, at the tracker's time) or `presence` (which only the built-in `git-file` can attest, with the key hardware not attested). A ledger cannot raise a verdict above what pr-rla can check:

- an external ledger's verdicts count at most at the level its definition **declares** (`provenance`), and never above `account`: declare `provenance: "account"` if your tracker records which account acted, or every verdict counts as `self-asserted`;
- the issue ledgers top out at `account`, because a label event carries no evidence beyond the account that applied it;
- `presence` comes only from the built-in `git-file` ledger's per-verdict signatures, checked by the core, and is printed as `presence (user-presence flag verified; key hardware not attested)` (T16).

A verdict above its ledger's ceiling is counted at the ceiling, and check 7 warns. The declared level is also the default `verdicts.min_provenance` that `register` writes for your ledger. Optional provenance fields: `actorId` (the tracker's stable account id), `viaApp` (an app that acted for a person; non-null makes the verdict ineligible), `eventId` (the tracker's event id). `signer`, `keyFingerprint` and `counter` are the git-file signature fields; a plugin never sets them.

## 3. Integrity: what `verifyIntegrity` reports

`verifyIntegrity` checks the ledger's own history and returns `{ ok, findings, tamperTrail, warnings? }`. Check 7 FAILs on `ok: false` and WARNs on warnings, and on `tamperTrail: false` (no external trail at all). For a tracker whose verdicts are labels or field values, apply the shared rules with `analyzeDrawHistory(draw, events, { reviewers, labelOf })` from `pr-rla/ledger` (functional design §U4, FR4.3):

- the first eligible add counts;
- after it, the same verdict removed and added again: **WARN** (relabel, same verdict);
- the opposite verdict added (a swap, or both present): **WARN**, and the first verdict counts;
- the counted verdict removed with nothing left in its place: **FAIL** (removal after counting);
- an event whose label the tracker has since erased: **FAIL**;
- at one instant a removal sorts before an add, so a select-field change or a scoped-label swap reads as a relabel.

Report a deleted or moved issue, or a deleted or renamed verdict label, as a FAIL. When an indexed issue answers 404, probe the audit project first: if the token cannot read that either, say the token has no access, not that the issue was deleted. `LedgerIntegrityReport.location` belongs to the built-in `git-file` only (check 7 compares it with the registered `ledgerPath`).

## 4. Publishing draws, and the index

`pr-rla sample` calls `publishDraws(draws, { window, protocolSha256, registrationSha256, repo })` once the draws exist. An issue ledger opens one issue per drawn change, in draw order (a repeated draw points at its first issue; `firstOccurrence` says which). It must be **idempotent**: mark every write `idempotent: false` in its init, and the fetch broker then never repeats it after a 5xx, so after a lost response the next run must find what was created, by a marker in the issue (the built-ins put an HTML comment in the body; Jira puts it in the summary), and must not create it again.

The draw → issue map is the **ledger index**, `audit/<window>/ledger-index.json`. A ledger in the plugin host cannot write files, so it keeps the index through `ctx.index` (`read()`, `write(value)`), which pr-rla writes atomically for it. The index is a hint, not a witness: on read, check that the tracker returns the issue the index names (its id and number) and that the issue says it is that draw's, for the same window and change. `sample` binds the index's hash into `draws.json`, and each checkpoint carries it: check 7 FAILs an index whose hash is not the one `draws.json` binds, or that does not match the draws, even offline, and WARNs when it changed since the latest checkpoint (publishing more draws changes it legitimately). The built-in issue ledgers' index (`pr-rla/ledger-index/v1`, `src/ledgers/issue-index.ts`) lists `issues` (each draw's change and its issue's number, id, URL and creation time), `repeats` (a later draw of a change, `sameAs` its first draw) and the verdict and draw `labels` with their ids; an external ledger's own shape gets the hash check only.

**The publication record (P1).** Right after `publishDraws` returns, `sample` signs the index and has the registered timestamp authorities time-stamp it, in `audit/<window>/ledger-publication.json`; `verify` then FAILs a verdict read from an issue no proven publication lists, an index that is not an append-only extension of the latest publication, and issue numbers that do not rise with the draws. What a ledger that publishes draws must do: keep its index in `ctx.index` with an `issues` list whose entries name the issue by `number` (or a `KEY-123` `key`), `id` and `url`; open the issues in draw order; name an issue by the tracker's stable numeric id (GitHub's issue `id`, not its node id); and read each verdict from the issue the index names. A ledger that publishes draws and keeps no index is refused by `sample`. The option name `foreign_issues` is reserved for tests over recorded public timelines (issues pr-rla did not open); `verify` FAILs check 7 for any audit whose ledger options set it, so never use it in a ledger.

## 5. Recording a verdict

`pr-rla record <draw> pass|fail` calls `appendVerdict`. An issue ledger applies the verdict label (or field value) to the draw's issue as the token's account; the tracker then records who did it and when, which is what its `account` provenance rests on. Without `--reviewer`, the verdict's reviewer reads `(the token's account)` until the tracker's own event names it. `record` refuses when a counting verdict for the change already exists (`--force` appends anyway; a later verdict that differs shows as a relabel, and the first still counts). Many teams record in the tracker's web UI instead, where an assistant cannot.

## 6. Checkpoints: `readHistory`

A tracker's admin can delete issues and their history. `readHistory()` returns the canonical verdict-event list: every add and remove of a verdict label (or field value) on an indexed issue, as `{ id, at, actor: { login, kind, id? }, action, label, draw }` (`raw` is kept for display and not hashed). `pr-rla checkpoint` hashes it (`canonicalHistory`: sorted by time then id, `raw` dropped), time-stamps the hash, appends it to `ledger-checkpoints.jsonl` and stores the list in `ledger-history/`; `verify` compares the current history with every checkpoint (`historyDiff`) and FAILs an event that is gone or changed. Without `readHistory` a ledger cannot be checkpointed (`checkpoint` says so and exits 1), so `checkpoint --push` in CI needs a ledger that has one: the issue ledgers or the Jira example, never `git-file`. With Jira, whose changelog goes with the issue, checkpoints are not optional.

## 7. The network and credentials

Every request goes through `ctx.fetch`, which in a real run is pr-rla's fetch broker. Declare what you reach:

- `hosts(options)`: the hosts you contact with these options. Isolated, you may contact no other.
- `writePaths(options)`: `host/path` prefixes where you may send anything but a read (`acme.atlassian.net/rest/api/3/issue`). A write anywhere else is refused unsent (`WRITE_PATH_NOT_ALLOWED`), and in a read-only context (the MCP server, `pr-rla/api/read`) every write is refused (`READ_ONLY_VIOLATION`).
- `credentials`: each `{ env, hosts, hostFromOption?, headers?, secret? }`. Run isolated, your code sees `prrla-cred:<ENV>` placeholders, and the broker swaps in the secret only on an approved https origin, and only in `authorization` or a header you list in `headers` (a `trust: full` plugin runs in pr-rla's process with the real environment instead). For a tracker whose host is the user's own, name the option that holds its URL in `hostFromOption`; pr-rla computes the host from it (an `https:` URL only). `Authorization: prrla-basic:<USER_ENV>:<TOKEN_ENV>` becomes Basic auth; declare the user part `secret: false` (an identity, left alone in responses).

Pass `destination: "scm"` in every request's init: the broker then retries your reads on its policy (5xx, 429, truncated bodies, rate-limit headers), which the kit's `transient-faults` check expects; a plain `fetch(url, init)` gets one attempt and must retry itself. Mark writes `{ destination: "scm", idempotent: false }`, so the broker retries them only before they are sent and on a rate limit, never after a 5xx. A credential reaches your code only once the person running pr-rla has approved it on their machine (`pr-rla plugin approve <use>`; `plugin add` and `plugin lock` approve it for whoever locks it; `--accept-lock-grants` takes the lock's grants for one run, in a repository you control).

**Isolated, the default.** An external ledger runs in pr-rla's plugin host: a child Node process that can read only its own files, cannot write files or start processes, and gets fetches and waits only while one of its methods runs (at most 64 fetches at once, waits of at most 15 minutes). Keep your state in `ctx.index`. On Node 22 and 24 the child can still open its own network connections; Node 25 or later blocks them. [`security-model.md`](security-model.md) states what isolation does and does not guarantee.

**What pr-rla holds your text to (S1).** Everything a ledger returns in free text (an error's message, the findings and warnings of `verifyIntegrity`, a verdict's reviewer and note) is shown to an assistant (read-only mode, the MCP server) as text the ledger wrote, in `untrusted.errors`, with pr-rla's own words in its place; the CLI shows it as written. Only the built-in git-file ledger's findings count as pr-rla's words. Identifiers are checked instead: a verdict's change id, protocol hash, account id, event id, provenance source and signer are shown in pr-rla's words only when each is the identifier it should be (an event id is letters, digits and `._:@+/=-`, at most 128), and otherwise as the ledger's text; a time that parses is printed as pr-rla prints times; and the instance `create()` returns must carry a plugin name. A hostile ledger cannot take the host down: an answer that does not fit one IPC frame (the index, say) reaches the ledger as a `MESSAGE_TOO_LARGE` error for that request, and echoes are cut to 2 KiB.

## 8. Test it with the ledger kit

`runLedgerConformance(factory, fixtures, { skipCases? })` from `pr-rla/testing` returns a report; `assertLedgerConformance` throws. The factory is `(fixture, harness) => Ledger`: wire the ledger to the fixture's recorded or fake tracker through `harness.context({ fetch, windowDir })`, and serve the tracker state `harness.phase` asks for. Each fixture declares its `case` (one of `LEDGER_CASES`), its `source`, its draws and what must come out: the verdict that counts per draw and the integrity result.

- **The cases:** `first-label`, `relabel-same`, `relabel-opposite`, `removal`, `deletion`, `label-rename`, `unlisted-reviewer`, `app-applied`, `verdict-before-seed`, `pagination` (past 100 events), `idempotent-publish` and `checkpoint-round-trip`; the kit also runs `transient-faults` (reads) and `transient-write-faults`. The kit holds each declaration to the design's rule for its case (a removal after counting must FAIL, a same-verdict relabel must WARN, …) and the ledger to the declaration.
- **Fixtures.** An empty list fails. Every case needs a fixture, or a reason in `skipCases` (`{ pagination: "the recording fits one page" }`): a skipped case is reported with its reason, a missing one fails. Mark each fixture `source: "recorded"` (read-only from a public tracker; keep where and when in the recording) or `"synthetic"`.
- **Every method.** The core treats `publishDraws`, `verifyIntegrity` and `readHistory` as optional, but the kit's `normalization` check fails a ledger without `verifyIntegrity` or `readHistory`: a ledger that passes the kit can be checked and checkpointed.
- **Order.** The kit counts the first eligible event by `compareByTimeThenId`, and fails a ledger that returns another order.
- **Ineligible events are returned and reported.** An event by an app, a bot or an unlisted account must come back from `readVerdicts`, so the core can ignore it with a reason, and your own integrity report must name it.
- **Verdict before the seed.** The kit asks whether the core would count your verdict and `recordedBeforeSeed` would refuse it: the time must be the tracker's.
- **Writes under faults (`transient-write-faults`).** Your write path meets a 429 with `Retry-After` on a publish's first write (wait, then repeat that write), then a 503 on its second write that arrives after the write happened (the broker does not repeat it: your publish must find what exists, by its marker, and not write it again); then a recovery publish on the same tracker must bring the writes of both runs to exactly the writes one clean publish makes, and a `record` that meets a 429 must wait. Serve phase `publish-faults` on a fresh tracker and phase `publish-recover` on the tracker the faulted run left; a factory that serves neither gets the check reported as skipped.

`pr-rla plugin check <use>` (with `--kind ledger` for a ledger the config does not name) runs the kit through the plugin host on the recorded fixtures your package.json lists (`"pr-rla": { "conformance": [...] }`); cases no recording can show (the tracker must change between reads) are listed as skipped with why, and belong in your own kit run on a fake tracker. The kit is a correctness gate, never a safety gate: a malicious ledger can pass it.

## 9. The Jira example

[`examples/ledgers/jira/index.mjs`](../examples/ledgers/jira/index.mjs) is a complete external ledger for Jira Cloud. From pr-rla it imports only `pr-rla/ledger` (and `node:fs` and `node:path`, for its own index file when it runs in process):

- **Verdicts are a single-select custom field** ("pr-rla verdict", values pass and fail), read from each issue's paged changelog (`GET /rest/api/3/issue/{key}/changelog`), never from the field's current value. A change from one option to another is a remove and an add at the same instant. Labels are not used: Jira reports a label change as whole old and new sets.
- **Options are matched by id**, learnt from the first issue's edit metadata at publish and kept in the index, so a renamed option still reads; a change to any other option FAILs rather than being dropped.
- **Credentials:** `JIRA_EMAIL` (an identity, `secret: false`) and `JIRA_TOKEN`, sent as `prrla-basic:JIRA_EMAIL:JIRA_TOKEN`, for the host of `options.base_url` only (`hostFromOption`). Without them it reads anonymously (public projects).
- **Its index** goes through `ctx.index` when pr-rla offers it, so it works in the plugin host, which cannot write files.
- **Its fixtures** are recorded read-only from hibernate.atlassian.net (a public Jira Cloud site, 2026-11-04) plus synthetic trackers for the destructive cases; `npm test` in its directory runs the kit on them. Its writes (issues, the field) have run only on a fake Jira; the `editmeta` route it learns option ids from was not called live.

```yaml
ledger:
  use: ./examples/ledgers/jira/index.mjs      # or pr-rla-ledger-jira, once installed
  options: { base_url: https://acme.atlassian.net, project: AUD, field: customfield_10050 }
```

Lock it before the first run (`pr-rla plugin add <use>`), as every external plugin.

## 10. Versioning

`ledgerApiVersion` (now 1) changes only on a breaking change to `pr-rla/ledger`. Everything added in phase 3 (provenance, `readHistory`, the publish context, `ctx.index`, `ctx.reviewers`, `hosts`, `writePaths`, `credentials`) is optional within version 1, and a phase-2 ledger keeps working. A definition declaring another version is refused with `LedgerApiVersionError`. Name a published ledger `pr-rla-ledger-<name>` and keep `pr-rla` a peer dependency (`~0.1.0`).
