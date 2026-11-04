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
