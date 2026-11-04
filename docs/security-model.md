# Security model

This page states what pr-rla protects and what it does not. It starts with external plugins (threat T6 in `docs/design/phase-3-4/nfr-design.md`); the other parts of the model are added as their units land.

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

## Verdict provenance and presence (T7, T16)

A verdict is only as good as the evidence of who recorded it. pr-rla gives every counted verdict a provenance level, prints it on every certificate, and lets a registration require a minimum (FR3.8, FR9).

| Level | What it means | Produced by |
|---|---|---|
| `self-asserted` | `reviewer` and `recordedAt` are whatever the writer typed | the `git-file` ledger: a line in an unsigned commit, in a commit no registered reviewer signed, or not committed yet |
| `account` | an SCM account (server-assigned time) or the reviewer's registered signing key did it | the issue ledgers (the label event's actor and `created_at`); a `git-file` line whose commit the reviewer it names signed with a registered software SSH key, or with a registered security key whose signature has the user-presence flag clear |
| `presence` | as `account`, and the signature carries the FIDO user-presence (UP) flag from the reviewer's registered security key | a `git-file` line whose commit the reviewer it names signed with a registered `sk-ssh-ed25519@openssh.com` or `sk-ecdsa-sha2-nistp256@openssh.com` key, UP set |

Every certificate prints the level, and prints `presence` as `presence (user-presence flag verified; key hardware not attested)`: `VERDICT PROVENANCE: account (12) · presence (user-presence flag verified; key hardware not attested) (24)`.

### What the registration fixes

- `verdicts.min_provenance`: the level below which a counted verdict FAILs check 7. The default is `account` with an issue ledger and `self-asserted` with `git-file`.
- `verdicts.reviewers`: whose verdicts count. For `git-file` with signed verdicts, each entry is a line of OpenSSH's allowed-signers format, `<principal> [namespaces="git"] <keytype> <base64 key>`. pr-rla reads a narrower form than `ssh-keygen`: principals are exact names (no patterns), and the only option is `namespaces`, which must admit `git`. Rotating a key needs a new registration, which is the point.
- `verdicts.require_signed`, from the `git-file` option `require_signed: true`: every counted verdict must come from a commit signed by the registered reviewer it names. An unsigned, uncommitted, unlisted or mismatched verdict then FAILs check 7.

`register` refuses rules no verdict could meet: `account` with `git-file` and no registered keys, `presence` with no registered security key, `require_signed` with no keys, `presence` with an issue ledger, and SSH keys with any ledger but `git-file`.

### How pr-rla checks a signed verdict

For each line of `verdicts.jsonl`, the `git-file` ledger asks git which commit added it (`git blame`) and reads that commit object. The core's PresenceVerifier (`src/core/presence/`, pure: node:crypto only, no file, process or network access) then:
1. splits the `gpgsig` header from the payload, as `git verify-commit` does;
2. parses the armored SSHSIG (OpenSSH `PROTOCOL.sshsig`) and checks the `SSHSIG` preamble, version 1, namespace `git` and a `sha256` or `sha512` message hash;
3. requires the signing key to be a registered key, byte for byte, and the line's `reviewer` to be one of that key's principals;
4. verifies the signature in TypeScript: Ed25519, ECDSA P-256, P-384 and P-521, RSA (rsa-sha2-256 or rsa-sha2-512, 2048 bits or more; SHA-1 `ssh-rsa` is refused), and for the FIDO types the authenticator's signed data, `SHA256(application) ‖ flags ‖ counter ‖ SHA256(signed data)` (OpenSSH `PROTOCOL.u2f`);
5. for a security key, reads the UP flag (bit `0x01`) itself.

A level the line writes about itself never counts. A ledger cannot raise a verdict above what it can attest: `presence` comes only from this check, the issue ledgers top out at `account` (a label event carries no presence evidence), and an external ledger is never counted above `account`. Check 7 WARNs on an invalid or unknown signature, a signer who is not the reviewer the line names, and a security key whose signature counter goes down.

### The limits, stated plainly

- **`presence` does not prove a person touched hardware (T16).** A software-emulated authenticator sets the user-presence flag as easily as a hardware key does. So `presence` relies on each reviewer having registered a hardware-backed security key; pr-rla does not check that a registered key is hardware-backed (key hardware not attested). Closing this would need FIDO attestation at registration (`ssh-keygen -O write-attestation`, verified against the authenticator vendors' roots); it is not built.
- **Tested with software keys only (D7).** The `-sk` signatures in the test suite come from OpenSSH's own sk-dummy test middleware and from a software-emulated authenticator in the tests; no hardware key has been used, and no doc or certificate claims hardware-verified presence.
- **A touch is presence for one signature, not a review.** The authenticator does not show what it signs, so a reviewer could be talked into touching for a commit they did not read. `presence` rules out "no human at all", not "no review".
- **`ssh-keygen -Y verify` and `git verify-commit` do not enforce the presence flag.** OpenSSH 10.3p1 accepts a security-key signature whose UP flag is clear, and neither `-Y verify` nor the allowed-signers format has an option that requires it (checked 2026-11-04; `test/presence-oracle.test.ts`). pr-rla checks the flag itself; verifying commits with git or ssh-keygen alone would accept a touch-less signature.
- **The counter is a WARN, never a FAIL.** Authenticators differ: some report 0, OpenSSH's test middleware a constant. A counter that goes down for one key can mean a cloned key, so it is reported.
- **A signature binds the line to the reviewer's key, not to a time.** `recordedAt` and the commit date are still the signer's own clock.
- **Verify needs the full history of `verdicts.jsonl`.** In a shallow clone, lines from before the boundary are attributed to the boundary commit and lose their level.
