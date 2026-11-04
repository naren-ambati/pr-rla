# Security model

This page states what pr-rla protects and what it does not. It covers external plugins (threat T6 in `docs/design/phase-3-4/nfr-design.md`) and trusted time (T17); the other parts of the model are added as their units land.

## External plugins (T6)

A provider or ledger plugin is code you did not write. It decides the population, and anything it can read or send, it can steal. The npm worms of 2025–2026 (Shai-Hulud, chalk/debug, ChainDrop) took tokens from the environment and from `~/.npmrc`, at run time, from packages with valid provenance. So pr-rla treats every external plugin as untrusted unless you say otherwise.

### What pr-rla does

1. **Nothing external runs until you lock it.** `pr-rla plugin add <use>` resolves the plugin from `.pr-rla.yml`, loads it in the host (below, never in pr-rla's own process), and prints everything it is about to trust: source, version, `resolved`, the npm integrity from `package-lock.json`, a `treeSha256` over every installed file of the plugin and of each runtime dependency, its trust, its hosts, write paths and credentials. Only after you confirm (or pass `--yes`) does it write `pr-rla.lock.json`. Nothing else writes that file: `register` with an unlocked external plugin exits 1 and tells you to run `plugin add`.
2. **Every load re-checks the lock.** npm checks integrity only at install. pr-rla re-resolves the plugin and re-hashes its files at every load, and refuses on any difference: `plugin … changed since it was locked (treeSha256 …); run "pr-rla plugin lock …" after reviewing the change`. A symlink that leaves the plugin's tree aborts the hash. A path plugin must live inside the audit repo, so a third-party verifier loads the same files. The registration records the plugin's name, source, version, tree hash, options hash and trust, and `verify` warns when the plugin it loads is not the registered one.
3. **It runs out of process by default** (`trust: isolated`), in a child Node process started with:
   - `--permission`, with read access to the plugin's own files and its dependencies' only (never their `node_modules` or `.git`), plus pr-rla's child script and SDK modules;
   - no permission to write files, start processes or workers, load addons or use WASI;
   - no `--allow-net`, so on Node 25 or later the child has no network at all;
   - an environment of `PR_RLA_HOST=1` and placeholders only: a locked credential that is set reaches the plugin as `prrla-cred:<ENV>`, never as its value.

   A credential's hosts are locked like everything else. A self-hosted server's credential can follow the URL option its definition names (`hostFromOption: "base_url"`; the Gitea and Jira examples do): pr-rla, not the plugin, takes the host from that option, only from an `https:` URL, and records it in the lock entry, so the reviewer sees it at `plugin add` and a changed option is refused at load. The registration's options hash covers the option.

   A ledger still cannot write files. Its local index (`LedgerContext.index`, `audit/<window>/ledger-index.json`) travels over IPC, and pr-rla reads and writes that one file for it, atomically; nothing else on disk is reachable. `register`, `record` and `verify` read an isolated ledger's provenance and hosts through the host (or from its lock entry), never by importing it.
4. **Every request goes through the parent's fetch broker** over IPC (`pr-rla/ipc/v1`), including a plugin's own `fetch()`. The broker allows only the locked hosts, swaps a placeholder for the secret only on the hosts locked for that credential (`prrla-basic:<USER_ENV>:<TOKEN_ENV>` becomes Basic auth the same way), refuses anything else unsent, and keeps providers read-only on the wire. A secret a server echoes back is replaced with its placeholder before the plugin sees the response. Waits run on the command's clock in the parent.
5. **The host watches the child.** A call sends a heartbeat every 10 s; 60 s of silence stops the child, and the command fails with the plugin's last output lines and writes nothing. Messages over 64 MiB are refused. Results are re-validated by the core whatever the child returns.
6. **`trust: full` is an explicit opt-in** (`plugin add --trust full`): the plugin runs in pr-rla's process with your environment and files, as plugins did before. Every command that loads it prints `PLUGIN TRUST: full (<name>@<version> runs with your environment and files)`, the registration records it, and `verify` repeats it.
7. **`--plugins builtin-only`** (or `PR_RLA_PLUGINS=builtin-only`) refuses every external plugin before anything resolves or imports it. Any other value is refused, so a typo never lets external code in.
8. **`pr-rla plugin check <use>`** reports the lock status, `npm audit signatures` for a package plugin, the hosts and credentials the plugin asks for, and runs the conformance kit through the host on the plugin's own recorded fixtures. Its last line is always `conformance = correctness, not safety: a malicious plugin can pass it`.

### What isolation guarantees

Tested with `test/fixtures/plugins/hostile`, a plugin that tries each of these (`test/plugin-host.test.ts`; `node scripts/demo-plugin-host.mjs` prints the results):

| Node | Token theft through the environment | Reading `~/.npmrc`, gh config, other files | Sending out repo data the plugin sees | Writing files, starting processes |
|---|---|---|---|---|
| 22 and 24 | prevented: it reads a placeholder | blocked by the fs-read scope (*a seatbelt*) | **possible**: Node 22 and 24 have no network control, so the plugin can open its own sockets | blocked (*a seatbelt*) |
| 25 or later | prevented | blocked (*a seatbelt*) | blocked: no `--allow-net` (*a seatbelt*) | blocked (*a seatbelt*) |

Measured on 2026-11-03 with Node 22.23.2, 24.20.0 and 26.8.2 on macOS. Node 25 itself was not available; the Node 25-or-later row rests on Node 26.8.2, where IPC works under `--permission` without `--allow-net` and the plugin's socket is refused with `ERR_ACCESS_DENIED`.

### The limits, stated plainly

- **On Node 22 and 24 a malicious plugin can still send repo data out.** It cannot read your tokens, but it sees whatever the SCM returns to it (private repo data included) and can open a socket to anywhere. Run pr-rla on Node 25 or later to close that.
- **The permission model is a seatbelt, not a security boundary.** Node's documentation says it "does not protect against malicious code" and that malicious code can bypass it; CVE-2025-55130 was a symlink bypass of the fs flags on Node 20, 22, 24 and 25. On Linux, `/proc/<ppid>/environ` is readable by the same user; it is outside the fs-read scope, which is again a seatbelt.
- **A placeholder protects the secret, not the request.** The plugin can still make any read request the token allows to the hosts it is locked to. Give it the narrowest token you have: read-only, one repository.
- **A plugin decides the population.** Isolation does not stop a provider from dropping changes; `verify` rebuilds the population with the provider it is given. Review a plugin before you lock it, and lock the same version your auditor will use.
- **Strong isolation needs the operating system.** For a plugin you do not trust, run pr-rla itself in a container or VM with no ambient credentials. pr-rla ships no sandbox.
- **Install hygiene is yours.** Install plugins with `npm ci --ignore-scripts` (pr-rla plugins need no install scripts; `plugin add` warns when one declares them). npm 11's `allow-scripts` and `min-release-age` help where available.
- **The host needs Node 22.15 or later** (`module.registerHooks`, which links a plugin against pr-rla's own SDK). On an older Node an isolated plugin fails to load with that message; tested only on 22.23.2, 24.20.0 and 26.8.2.

## Trusted time (T17, and the trusted-time review of 2026-11-04)

A registration's or a commitment's time is proven by RFC 3161 tokens from k = 2 independent timestamp-authority operators. A forged token is the cheapest way to fake a prospective audit or to pick the draws after the seed is public, so `verify` decides what counts using only what the verifier brings: the package and the verifier's own flags. Nothing in the audit repo can add trust.

### What verify trusts, and from where

| Evidence | Trusted when | Never from |
|---|---|---|
| An RFC 3161 token | its chain reaches an anchor pinned in the package for that authority (`src/timestamp/trust-bundle.json`), or in a file the verifier passes with `--tsa-trust` | the audit repo |
| A token toward k | it is accepted, and its authority is one the registration names in `timestamping.authorities` | any other authority, even a bundled one (`ignored (not registered)`) |
| A transparency-log entry | its key is pinned in the package (Sigstore's production Rekor v1 and v2 logs, from Sigstore's TUF `trusted_root.json`) or passed with `verify --log-key` | `.pr-rla.yml`'s `transparency_log.public_key_file`, any file in the audit repo, the log URL in the record's unsigned envelope |
| The time a v2 record counts as | its own signed `registeredAt` or `frozenAt`, always | the envelope: dropping `timestamps` FAILs, it never hands the time to a log |

### One signer certificate for every rule

pr-rla finds the one certificate in the token that the CMS signer identifier names (issuer and serial, or subject key identifier; RFC 5652 §5.3), and checks the signature key, ESSCertID, the critical `timeStamping` EKU and the chain on that certificate alone. It refuses a token when no certificate or more than one matches the identifier, when two certificates carry the signer's issuer and serial, or when the library checked the signature under any other key. A test runs 80 signer-identity mutations of the eight authorities' recorded tokens past `openssl ts -verify`: every one OpenSSL rejects, pr-rla rejects too (and pr-rla also rejects the duplicate and appended-twin cases that OpenSSL accepts). The one known difference is that OpenSSL cannot read a subject-key-identifier signer at all; pr-rla accepts a consistent one, and no bundled authority uses that form.

### Chains

Every intermediate must be a CA allowed to issue certificates (critical `cA`, `keyCertSign`, its path length honoured, and an EKU, if it has one, that allows timestamping). DigiCert's and GlobalSign's anchors are general-purpose roots (DigiCert Trusted Root G4, GlobalSign Root R6), and so are SwissSign's and GitHub's; for those four the bundle also pins the operator's TSA issuing CA, and only a signer issued directly by it counts as that operator.

### The limits, stated plainly

- **Three anchors are trust on first use.** Microsoft's (pinned at its intermediate, because its tokens omit the root), SwissSign's and FreeTSA's were taken from the authorities' own responses. Every output that counts one prints `anchor pinned on first use … independent: false`. Confirming them from a second source is a release-checklist item.
- **A pinned issuing CA must be updated when an operator rotates it.** A token signed under a new issuing CA fails until the bundle carries it (NFR21's release diff). Old tokens keep verifying, because issuing CAs are only added.
- **A v1 audit logged to a log whose key is not pinned** verifies at most as `time unproven` unless the verifier passes that log's key with `--log-key`.
- **The parsing library still verifies the signature** (pkijs); pr-rla checks that it did so under the signer certificate's key, byte for byte.

## Verdict provenance and presence (T7, T16)

A verdict is only as good as the evidence of who recorded it. pr-rla gives every counted verdict a provenance level, prints it on every certificate, and lets a registration require a minimum (FR3.8, FR9).

| Level | What it means | Produced by |
|---|---|---|
| `self-asserted` | `reviewer` and `recordedAt` are whatever the writer typed | the `git-file` ledger: a line with no signature, or one whose signature does not count (another key, another reviewer, another registration, a broken signature) |
| `account` | an SCM account (server-assigned time) or the reviewer's registered signing key did it | the issue ledgers (the label event's actor and `created_at`); a `git-file` line signed by the registered software SSH key of the reviewer it names, or by their registered security key with the user-presence flag clear |
| `presence` | as `account`, and the signature carries the FIDO user-presence (UP) flag from the reviewer's registered security key | a `git-file` line signed by the registered `sk-ssh-ed25519@openssh.com` or `sk-ecdsa-sha2-nistp256@openssh.com` key of the reviewer it names, UP set |

Every certificate prints the level, and prints `presence` as `presence (user-presence flag verified; key hardware not attested)`: `VERDICT PROVENANCE: account (12) · presence (user-presence flag verified; key hardware not attested) (24)`.

### One signature per verdict

A verdict's provenance comes only from its own signature. Each `git-file` line carries `sshsig`: an SSHSIG (OpenSSH `PROTOCOL.sshsig`) in namespace `pr-rla-verdict@v1`, made by `ssh-keygen -Y sign`, over a versioned text that names the registration's digest, the protocol, the draw, the change, the verdict, the reviewer and the time (contracts.md §1, "Per-verdict signatures"). `pr-rla record --sign <key>` makes it; a reviewer who does not want to run pr-rla's process can write the bytes with printf and sign them with ssh-keygen themselves (README, "Signed verdicts").

So one signature is one verdict, on one draw, of one registration. With a security key, one touch signs exactly one verdict: an assistant that appends lines in the reviewer's shell cannot have them all vouched for by the next touch, a line cannot move to another draw or another audit, and rebasing, cherry-picking or amending other people's commits signs nothing that counts. Commit signatures give no provenance at all, and no line is credited to the commit that added it.

### What the registration fixes

- `verdicts.min_provenance`: the level below which a counted verdict FAILs check 7. The default is `account` with an issue ledger and `self-asserted` with `git-file`.
- `verdicts.allowed_signers`: the reviewers' keys, as lines of OpenSSH's allowed-signers format (`<principal> [namespaces="pr-rla-verdict@v1"] <keytype> <base64 key>`), inline or from an `allowed_signers` file next to the configuration. They are hashed into the signed registration, so rotating a key needs a new registration, which is the point. pr-rla reads a narrower form than `ssh-keygen`: one principal per line, an exact name; no two principals equal ignoring case; no key under two principals; the only option is `namespaces`, which must admit `pr-rla-verdict@v1`.
- `verdicts.reviewers`: whose verdicts count at all (logins and `id:<account id>`), as before; it is no longer where keys go.
- `verdicts.require_signed`, from the `git-file` option `require_signed: true`: every counted verdict must carry a valid signature by the registered key of the reviewer it names. Only the built-in `git-file` ledger can be registered with it.

`register` refuses rules no verdict could meet (`account` with `git-file` and no keys, `presence` with no registered security key, `require_signed` with no keys or another ledger, keys with any ledger but `git-file`), and warns when keys are registered but neither `require_signed` nor a minimum above `self-asserted` is set, since unsigned verdicts would then still count.

### How pr-rla checks a signed verdict

For each line, the core's PresenceVerifier (`src/core/presence/`, pure: node:crypto only, no file, process or network access):
1. rebuilds the signed bytes from the line's fields and **this** registration's digest (a line naming another registration is refused);
2. parses the SSHSIG and checks the `SSHSIG` preamble, version 1, an empty reserved field, namespace `pr-rla-verdict@v1` and a `sha256` or `sha512` message hash;
3. requires the signing key to be a registered key, byte for byte, admitting the namespace, and the line's `reviewer` to be that key's principal, exactly (as `ssh-keygen -Y verify -I` matches);
4. verifies the signature in TypeScript: Ed25519, ECDSA P-256, P-384 and P-521, RSA (rsa-sha2-256 or rsa-sha2-512, 2048 bits or more, an odd exponent above 1; SHA-1 `ssh-rsa` is refused), and for the FIDO types the authenticator's signed data, `SHA256(application) ‖ flags ‖ counter ‖ SHA256(signed data)` (OpenSSH `PROTOCOL.u2f`), with an application that starts with `ssh:`; small-order Ed25519 keys and WebAuthn signatures are refused;
5. for a security key, reads the UP flag (bit `0x01`) itself.

A level a line writes about itself never counts. A ledger cannot raise a verdict above what it can attest: `presence` comes only from this check of a `git-file` line, the issue ledgers top out at `account` (a label event carries no presence evidence), and an external ledger is never counted above `account`. Signatures count only when the ledger `verify` loaded is the registered one: check 7 FAILs when its name, source, files (`integrity`) or options differ from the registration's `plugins.ledger`, and takes the ceiling from the registered identity. Check 7 WARNs on an unreadable, invalid or foreign signature, an unlisted key, a signer who is not the reviewer the line names, and a security key whose signature counter goes down.

### The ledger's history

Signed lines can still be deleted, so `verify` walks the history of `verdicts.jsonl` itself: every commit reachable from HEAD through the parents its raw commit object names (no `git log` history simplification, no rename following), each object read with `git cat-file --batch` and checked to hash to its name. Every version of the file must extend the version in each of its parents, so a removal, a relabel or a rewrite anywhere, on any merged branch, FAILs. git runs through one guard (`src/io/git-safe.ts`): every inherited `GIT_*` variable dropped, no lazy fetch, no optional locks, no automatic gc or maintenance, no climbing above the repository, no replace refs, no commit-graph, no fsmonitor, and no textconv (the walk reads blobs, never diffs).

A shallow clone, a repository with a grafts file or a hand-written `shallow` file, and a partial clone are refused before anything is read: check 7 FAILs and says to verify in a full clone. In a shallow clone the history before the cut is not there, so a verdict removed before it could not be seen; earlier versions of this page said such lines "lose their level", which was wrong (they took the boundary commit's level). A missing object is reported as missing, never as a deletion, and is never fetched.

### The limits, stated plainly

- **`presence` does not prove a person touched hardware (T16).** A software-emulated authenticator sets the user-presence flag as easily as a hardware key does. So `presence` relies on each reviewer having registered a hardware-backed security key; pr-rla does not check that a registered key is hardware-backed (key hardware not attested). Closing this would need FIDO attestation at registration (`ssh-keygen -O write-attestation`, verified against the authenticator vendors' roots); it is not built.
- **Tested with software keys only (D7).** The `-sk` signatures in the test suite come from OpenSSH's own sk-dummy test middleware and from a software-emulated authenticator in the tests; no hardware key has been used, and no doc or certificate claims hardware-verified presence.
- **Don't register your everyday signing key.** Register a key you keep for verdicts, with `namespaces="pr-rla-verdict@v1"`. A touch request from a key that only signs verdicts is unambiguous; one from the key that also signs your commits and SSH logins is easy to grant without looking. And anyone who can use a registered software key (an assistant in your shell, a process reading your key file) can sign verdicts as you at `account`.
- **A touch is presence for one signature, not a review.** The authenticator does not show what it signs, so a reviewer could be talked into touching for a verdict they did not make. `presence` rules out "no human at all" for that one verdict, not "no review".
- **`ssh-keygen -Y verify` and `git verify-commit` do not enforce the presence flag.** OpenSSH 10.3p1 accepts a security-key signature whose UP flag is clear, and neither `-Y verify` nor the allowed-signers format has an option that requires it (checked 2026-11-04; `test/presence-oracle.test.ts`). pr-rla checks the flag itself; verifying with ssh-keygen alone would accept a touch-less signature. ssh-keygen also accepts things pr-rla refuses on purpose: a small-order Ed25519 key whose one "signature" verifies every message, RSA keys of 1024 to 2047 bits, a non-empty reserved field, and WebAuthn signatures.
- **The counter is a WARN, never a FAIL.** Authenticators differ: some report 0, OpenSSH's test middleware a constant. A counter that goes down for one key can mean a cloned key, so it is reported.
- **A signature binds the verdict to the reviewer's key, not to a time.** `recordedAt` is signed, but it is still the signer's own clock.
- **The walk sees the history it is given.** It catches a removal or rewrite anywhere in the history reachable from HEAD. A history rewritten wholesale (a new root, force-pushed, with the signed lines copied over without the ones the rewriter dislikes) is not visible from the repository alone: protect the default branch and keep the audit repository where force-pushes are refused, and compare with a clone taken earlier.
- **SHA-1 repositories hash-check objects without collision detection.** pr-rla recomputes each object's SHA-1 itself; it does not run git's collision detection over it, so a repository whose objects were built with a SHA-1 collision (chosen-prefix collisions are practical) could pass the check with two contents under one name. A SHA-256 repository (`git init --object-format=sha256`) does not have this exposure; the per-verdict signatures (SHA-256 or SHA-512 message hashes) do not depend on git's hash either way.

## Org-pooled audits (U8)

A pooled audit adds one more thing the auditee controls: which repositories the pool holds. The rule (an owner, globs, the archived, fork and visibility flags) is registered before the seed, but the attributes it filters on belong to the repositories' owners, who can change them at any time. The principle the U8 fix round applies: nothing the auditee controls after registration may silently remove changes from the population, and nothing the verifier cannot check prints `VERIFIED`.

### What pr-rla does

1. **The resolution is registered.** `register` signs the repos a rule matches, by the SCM's stable repository id. Freeze includes every one that still exists, whatever its archive state, visibility, name or owner by then; one found gone is recorded with the repo-level probe's evidence. Check 2 FAILs a manifest that drops a registered repo, offline.
2. **The freeze's whole listing is recorded.** The manifest holds every repository the token listed under the owner, with its flags and the rule clauses that excluded it, the identity that listed them and, per visibility, the count and whether the listing was provably complete. Check 2 recomputes each exclusion from the recorded attributes.
3. **verify lists again and compares, by id.** A repo the rule matches now that the freeze did not hold FAILs (unless the SCM says it was created after the window), a registered repo outside the pool FAILs, a rename is matched by id, and a repo excluded only by an attribute its owners can change, with changes in the window, is a WARN with the count.
4. **verify must show it sees what it checks.** For private and internal repositories it needs the provider's proof that the token sees every one. Without it check 5 is INCOMPLETE, so a pruned private repo can never pass unseen. On GitHub the proof is an org owner (`/user/memberships/orgs/{org}`: `role: admin`, `state: active`) with a classic token holding the `repo` scope (`X-OAuth-Scopes`), or the token's own user account. That is sufficient because GitHub shows an org owner every repository of the org and a classic token is not limited to selected repositories, and it is necessary because a member sees only the private repositories they were granted and a fine-grained or GitHub App token can be limited to selected repositories without any API saying so.
5. **The frozen head cannot hide landings.** verify rebuilds each repo from the head the manifest records and also lists the window from the branch's current head. A window landing reachable now but not from the frozen head FAILs: a pull request always (its merge time is the SCM's), a direct push unless every first-parent commit after the frozen head is dated after the window, which is work merged after freeze (FR7.2). Where the provider cannot report first-parent history, check 5 is INCOMPLETE.
6. **Gone is decided by one probe.** A repository counts as gone only when its own metadata answers 404 (or a 403 the provider documents as hiding a repository). A 404 on a commit of a repository that exists FAILs ("frozen head not found"); a rate limit is never "gone". A gone or unreadable repository makes verify INCOMPLETE (exit 6), never VERIFIED.

### The limits, stated plainly

- **What a retrospective pooled audit cannot detect: attribute changes made before registration.** A repository archived, made private or renamed out of the rule during the window but before a retrospective registration is not among the registered repos. verify WARNs with its change count, and cannot say when the change was made. A prospective registration (before the window opens) closes this: every repository the rule matched before the window stays in the pool.
- **Direct pushes are dated by their committer date, which the pusher sets.** A direct push dated outside the window is outside the population, and a merge pushed during the window but dated after it could hide the work it brings in from the frozen head. pr-rla sees no push times. A `git pull` merge pushed after freeze, whose first parent is not the branch's previous head, is read like any other merge.
- **A hidden repository is no repository.** Without the provider's proof of complete visibility, verify cannot know that a repository it cannot see exists. That is why the answer is INCOMPLETE rather than a pass.
- **The registering token defines the registered repos.** A repository the registering token could not see is not registered; if the rule matches it at freeze it joins the pool, and a verifier who can see it FAILs a manifest without it, but nothing holds it in the pool against a later attribute change. Register with a token that can see the whole owner.
