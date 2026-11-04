# Trusted time

A prospective audit is evidence only if its registration demonstrably existed before the window opened, and its draws are unpredictable only if the manifest demonstrably existed before the seed round published. pr-rla proves those two times with RFC 3161 timestamp tokens from independent authorities, and states plainly when it cannot. This page covers how, what `verify` accepts, and how to check a token without pr-rla. The threat side is in [`security-model.md`](security-model.md) ("Trusted time").

## What is sent, and when

`register` and `freeze` (and `checkpoint`, for a ledger checkpoint) send each configured authority one `TimeStampReq` holding only the SHA-256 digest of the signed record and a nonce. Nothing else leaves the machine. Each token that comes back is checked at once against the rules below; those that pass are stored in the record's envelope (`timestamps`), and one that fails is reported and not stored, since a stored bad token would make an honest record fail `verify` for good.

- **k of n, by operator.** `timestamping: { authorities, min_tokens }` in `.pr-rla.yml`; `init` writes Sigstore, DigiCert, GlobalSign and Microsoft with k = 2. A time is proven when tokens from k distinct operators are accepted. Tokens from one operator count once, and only the authorities the registration names count: any other token is listed as `ignored (not registered)`.
- **Each request** has a 15 s timeout and is retried for at most 5 minutes (half the tolerance below), on the broker's policy; Sectigo is spaced 15 s apart and FreeTSA 1 s, as they ask. There is no way to add tokens to a record later (no `--retry-timestamps`): a record that came out short is written again with `register --force` or `freeze --force`.
- **The clock.** `register` and `freeze` refuse to write when the local clock differs from the median `genTime` of the tokens by more than 10 minutes, and print the difference (exit 1).

| Outcome | What is written | Exit |
|---|---|---|
| k or more operators | the record with its tokens; `timestamps: a of n TSAs (…) · k = <k> · PROVEN` (a tokens accepted, of n authorities configured) | 0 |
| fewer than k (including 0 of k: every authority unreachable) | the record; `TIMESTAMP NOT TAMPER-PROOF (n of k)` and the exact command to run again | 5 |
| no authority configured | the record; `TIMESTAMP NOT TAMPER-PROOF` | 0 |
| clock skewed more than 10 minutes | nothing | 1 |

## What a token must satisfy

`verify` checks every token offline against the trust bundle shipped in the package ([`src/timestamp/trust-bundle.json`](../src/timestamp/trust-bundle.json), version `2026-11`), with pkijs and asn1js parsing and pr-rla's own rules on top (`src/timestamp/verify.ts`). A token is accepted only if:

1. the token is CMS SignedData with TSTInfo content (the client also checked, when it asked, that the response's status was `granted` or `grantedWithMods`);
2. its message imprint is the record's SHA-256 (its `sha256`), and its nonce is the request's;
3. the signature over the signed attributes verifies under the signer certificate (a SHA-1 signature is refused);
4. ESSCertID identifies the signer certificate;
5. the signer certificate's extended key usage is exactly `timeStamping`, marked critical;
6. the chain reaches an anchor pinned for that authority, every certificate valid at `genTime`; every intermediate is a CA allowed to issue certificates; and under the general-purpose roots of DigiCert, GlobalSign, SwissSign and GitHub, only the operator's pinned TSA issuing CA may issue the signer;
7. `|genTime − t| ≤ 10 minutes + the token's accuracy` (60 s when the token states none), where t is the record's own signed time.

Every rule judges one certificate: the single certificate in the token that the CMS signer identifier names. A token carrying a second certificate with the signer's issuer and serial is refused. This closed the twin-certificate forgery the trusted-time review found (BUILD-NOTES, "Trusted-time fix round A", finding 1).

Each accepted token gives an upper bound `genTime + accuracy`: the record existed no later than that. `U_k` is the k-th smallest bound across distinct operators. The registration is **PROSPECTIVE** when `U_k` is before the window opens; the commitment must have its `U_k` before seed round R publishes. A time k operators do not prove leaves checks 1–3 INCOMPLETE: the record's time is the signer's own clock, and the seed round rests on it.

A stored token from a registered authority that breaks any rule FAILs the check (an honest client never stores one); a token from an authority the registration does not name is ignored, whatever it holds.

The record's signed time stays the seed's input. Tokens bound it and never replace it, so presenting a different token cannot move R, and a v2 record whose envelope has lost its `timestamps` FAILs.

## The authorities

| Authority | Default | Anchor pinned | How the anchor is trusted |
|---|---|---|---|
| `sigstore` (Sigstore) | on | sigstore-tsa-selfsigned | independently: Sigstore's TUF `trusted_root.json` |
| `digicert` (DigiCert) | on | the root DigiCert Trusted Root G4; its TSA issuing CA is pinned too, as a constraint that adds no trust | independently: macOS and Node's root stores |
| `globalsign` (GlobalSign) | on | the root GlobalSign Root R6; its TSA issuing CA is pinned as a constraint | independently: macOS and Node's root stores |
| `microsoft` (Microsoft) | on | **the intermediate** Microsoft Public RSA Timestamping CA 2020 (its tokens omit the root) | **on first use**, from its own response (`independent: false`) |
| `github` (GitHub) | off | the root Internal Services Root; its TSA intermediate is pinned as a constraint | independently: gh's TUF cache of tuf-repo.github.com |
| `swisssign` (SwissSign) | off | the root SwissSign Signature Services Root 2020 - 2; its TSA issuing CA is pinned as a constraint | **on first use** (`independent: false`) |
| `sectigo` (Sectigo) | off | Sectigo Public Time Stamping Root R46 | independently: macOS system roots (not in Node's) |
| `freetsa` (FreeTSA) | off | its own root | **on first use** (`independent: false`) |

All eight answered hash-only requests on 2026-11-03 (BUILD-NOTES, bolt 1), and their tokens are recorded in `test/fixtures/tsa/recorded-2026-11-03.json`. Only `register` has run against the real authorities; `freeze` and `checkpoint` with tokens have run on mock authorities. `register`, `verify` and `status` print each counted authority's anchor and how it is trusted, for example `microsoft: anchor pinned on first use (intermediate Microsoft Public RSA Timestamping CA 2020, independent: false)`. Confirming the three trust-on-first-use anchors from a second source is a release step ([`release-checklist.md`](release-checklist.md), step 5).

**Another authority, or another anchor.** `--tsa-trust <file>` (on `register`, `freeze`, `checkpoint`, `status` and `verify`, repeatable) adds anchors the person running the command trusts: a JSON file shaped like the bundle (`{ "authorities": { "<id>": { "operator", "url", "anchors": [...], "intermediates": [...] } } }`, any subset). It can add an authority, anchors, intermediates and `issuingCAs`; it cannot change a shipped authority's operator or URL. An authority only such a file vouches for proves a time to whoever passes the same file, and to nobody else. `verify` never trusts anchors from the audit repository itself.

## Transparency logs (Rekor)

pr-rla builds and verifies Rekor v1 `hashedrekord` entries and Rekor v2 entries, but submits nothing unless you pass `--submit` with a log URL (`--rekor-url <url>`, or `transparency_log.url` in `.pr-rla.yml`): an entry in a public log is public and permanent, and no entry has ever been written to a real log. `--rekor-api v2` also prints that the v2 client is unverified against the production log and needs `--yes`, and checks the log's response with `transparency_log.public_key_file`. Rekor v2 carries no time, so for a schema-v2 record the tokens are the time evidence and a log entry adds at most one operator. A v1 record's time comes from its Rekor v1 `integratedTime`, and counts only under a key `verify` trusts: Sigstore's production logs (pinned in the package) or one you pass for that log with `verify --log-key <log url>=<pem file>`, which then counts as the neutral operator `log at <host>`, never as Sigstore.

## Checking a token without pr-rla

Any token can be checked with OpenSSL's own verifier, which shares no code with pr-rla. A registration stores each token as `timestamps[].tokenDer` (base64), over the record's `sha256`. With the bundle's anchors for that authority (the bundle is `node_modules/pr-rla/dist/timestamp/trust-bundle.json` where pr-rla is installed, `dist/timestamp/trust-bundle.json` in a checkout):

```sh
REG=audit/2026-q3/registration.json; TSA=digicert
node -e '
const fs = require("node:fs"), [reg, tsa] = process.argv.slice(1);
const r = JSON.parse(fs.readFileSync(reg, "utf8"));
const b = JSON.parse(fs.readFileSync("node_modules/pr-rla/dist/timestamp/trust-bundle.json", "utf8")).authorities[tsa];
fs.writeFileSync(`${tsa}.tst`, Buffer.from(r.timestamps.find((t) => t.tsa === tsa).tokenDer, "base64"));
fs.writeFileSync(`${tsa}-ca.pem`, b.anchors.map((c) => c.pem).join(""));
fs.writeFileSync(`${tsa}-untrusted.pem`, [...b.intermediates, ...b.anchors].map((c) => c.pem).join(""));
fs.writeFileSync("digest.txt", r.sha256);' "$REG" "$TSA"
openssl ts -verify -token_in -in "$TSA.tst" -digest "$(cat digest.txt)" -CAfile "$TSA-ca.pem" -untrusted "$TSA-untrusted.pem"
```

Two authorities need more: Microsoft's anchor is an intermediate, so add `-partial_chain`; Sectigo's tokens name its cross-signed chain up to USERTrust RSA, and OpenSSL requires every certificate they name, so anchor it at USERTrust RSA from your system's roots (pr-rla checks the first ESSCertID, the signer's, as RFC 5035 requires). `test/timestamp-verify.test.ts` runs this oracle on all eight recorded tokens.

The same recipe on the bolt-1 recording (its tokens are over the demo registration's digest, stored there as whole responses: `-in <tsa>.tsr` without `-token_in`, and after `openssl ts -reply -in <tsa>.tsr -token_out -out <tsa>.tst`, with `-token_in`), recorded 2026-11-04 with OpenSSL 3.6.4 on macOS, standard output only:

```output
$ openssl ts -verify -digest "$(cat digest.txt)" -in digicert.tsr -CAfile digicert-ca.pem -untrusted digicert-untrusted.pem
Verification: OK
$ openssl ts -verify -token_in -digest "$(cat digest.txt)" -in digicert.tst -CAfile digicert-ca.pem -untrusted digicert-untrusted.pem
Verification: OK
$ openssl ts -verify -token_in -digest "$(cat digest.txt)" -in globalsign.tst -CAfile globalsign-ca.pem -untrusted globalsign-untrusted.pem
Verification: OK
$ openssl ts -verify -token_in -digest "$(cat digest.txt)" -in sigstore.tst -CAfile sigstore-ca.pem -untrusted sigstore-untrusted.pem
Verification: OK
```

OpenSSL accepts some tokens pr-rla refuses (a duplicated signer certificate, an appended twin), and cannot read a subject-key-identifier signer, which pr-rla accepts when it is consistent; no bundled authority uses that form (`test/timestamp-openssl-differential.test.ts`).
