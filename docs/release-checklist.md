# Release checklist: pr-rla 0.1.0

The ordered steps from this checkout to the first public release of `pr-rla` and `pr-rla-mcp` (0.1.0, released together) and the start of the prospective gh-aw audit. **No step in the build publishes anything:** every step that makes something public or permanent is the founder's, by hand, and is marked so.

Two owners:

- **founder**: decides, and does every public or permanent act (a repository, a publish, a catalog entry, a registration).
- **maintainer**: anyone working in a checkout. Every maintainer step is local and reversible, or read-only on the network (a public GET, or a timestamp request that sends a SHA-256 digest and a nonce).

Licence: decided by the founder before release. Until then no package has a licence file or licence text, and every `package.json` stays `"private": true` and `"license": "UNLICENSED"` (`test/release.test.ts` enforces it).

## The steps

| # | Step | Owner |
|---|------|-------|
| 1 | Decide the licence | founder |
| 2 | Decide the security contact | founder |
| 3 | Decide the npm names | founder |
| 4 | Decide on `npm-shrinkwrap.json` | founder |
| 5 | Confirm the three trust-on-first-use anchors from a second source | founder |
| 6 | Record the confirmed anchors in the trust bundle | maintainer |
| 7 | Run the three manual assistant runs | founder |
| 8 | Check the GitHub visibility proof and the push log on an org you own | founder |
| 9 | Diff the trust bundle against every authority's current chain | maintainer |
| 10 | Resolve the pending hooks, regenerate the output blocks, run the doc check | maintainer |
| 11 | Verify from three fresh clones, on each platform you have | maintainer |
| 12 | Check both tarballs, and date the changelogs | maintainer |
| 13 | Make the two packages publishable | founder |
| 14 | Create the public repository `naren-ambati/pr-rla` | founder |
| 15 | Set up trusted publishing | founder |
| 16 | Tag v0.1.0 and publish `pr-rla@0.1.0` with provenance | founder |
| 17 | Re-pin `pr-rla-mcp` to the published `pr-rla` | maintainer |
| 18 | Publish `pr-rla-mcp@0.1.0` with provenance | founder |
| 19 | Re-pin the GitHub Action, the GitLab component and the Bitbucket step | maintainer |
| 20 | Publish the GitLab component to the CI/CD Catalog | founder |
| 21 | Check the Claude Code marketplace install | maintainer |
| 22 | Register the prospective gh-aw audit | founder |

The order matters in four places: the decisions (1–4) change files the checks (9–12) then cover; the confirmations (5–8) settle claims the docs make, so they come before the docs are frozen; `pr-rla` is published (16) before anything pins it (17, 19), and `pr-rla-mcp` is published (18) only once it pins the published `pr-rla`; and the gh-aw audit (22) is registered with a released build, so an auditor can install the exact version that registered it.

**Which commit is which.** The tag `v0.1.0` (step 16) is the commit `pr-rla` is published from. The re-pin of `pr-rla-mcp` (step 17) and of the Action (step 19) are later commits: tag the first `pr-rla-mcp-v0.1.0` and publish `pr-rla-mcp` from it (step 18), and pin the Action by the full SHA of the second.

## 1. Decide the licence

**Owner: founder.** Choose the licence, or decide to release without one. Then, in one change: add the licence file at the root and in `packages/pr-rla-mcp`, set `"license"` in the two package.json files that will be published, and update the tests that hold the no-licence rule: `test/release.test.ts` ("no licence", and its pack-list `ALLOWED`, because npm always packs a root `LICENSE`), `packages/pr-rla-mcp/test/release.test.mjs` (the same `ALLOWED`), `packages/pr-rla-mcp/test/mcp-package.test.mjs` ("private and unlicensed"), `test/ci-integrations.test.ts` (the integrations' package.json) and `test/assistants/integrations.test.ts` (the plugin manifest has no `license` field). The examples (`examples/providers/gitea`, `examples/ledgers/jira`) and the Action package stay private: they are not published.

## 2. Decide the security contact

**Owner: founder** (design decision D10). Replace the placeholder in [`SECURITY.md`](../SECURITY.md) ("Contact: to be decided before public release") with the contact, and say which releases receive security fixes and, if you want one, the disclosure policy. `test/docs.test.ts` ("SECURITY.md carries the placeholder contact") changes with it.

## 3. Decide the npm names

**Owner: founder.** The design uses `pr-rla` and `pr-rla-mcp`; the examples are `pr-rla-provider-gitea` and `pr-rla-ledger-jira` (not published). All four were unclaimed when checked with `npm view <name>` (E404 from `GET https://registry.npmjs.org/<name>`, 2026-11-04T11:39:54Z; BUILD-NOTES, "Bolt 11 (U10)"). A name is claimed by publishing it (steps 16 and 18), so check again just before. A different name changes `package.json`, the `bin`, the plugin and assistant pins (`pr-rla-mcp@…` in `integrations/`), the Action's dependency and every doc that names the package.

## 4. Decide on `npm-shrinkwrap.json`

**Owner: founder.** The question (U7, "Deviations" 6): publish each package with an `npm-shrinkwrap.json`, which pins its whole dependency tree for everyone who installs it, or without one, which lets npm resolve the transitive dependencies on the day.

**Recommended: publish both packages with one, created at publish time from the committed `package-lock.json`** (`cp package-lock.json npm-shrinkwrap.json` in the release job, just before `npm publish`; the repository keeps `package-lock.json`, which `test/timestamp-library.test.ts` reads). The reasons:

- **The GitLab component and the Bitbucket step install `pr-rla@<version>` with no lockfile of their own.** Without a shrinkwrap their transitive dependencies are whatever npm resolves that day; with one they are the tree the release was tested with. The GitHub Action has its own lockfile and is pinned either way.
- **The ASN.1/CMS library is a security surface** (T17, NFR22). `pkijs` and `asn1js` are pinned exactly, but their dependencies (`@noble/hashes`, `@peculiar/utils`, `bytestreamjs`) are not, and `commander` and `yaml` are ranges. A shrinkwrap pins all of them by integrity in every install, not only in this repository.
- **pr-rla is run as a tool** (the CLI, CI, the MCP server through `npx`) far more than it is imported, so the usual objection (a library's shrinkwrap stops consumers deduplicating and taking transitive patches) costs little; plugins list `pr-rla` as a peer and are unaffected.
- **The cost:** a security fix in a transitive dependency reaches users only through a pr-rla release, and each package's tarball gains one file.

If the answer is yes, the tarball holds `npm-shrinkwrap.json` beside `dist/`, `README.md`, `CHANGELOG.md` and `package.json`: the release job adds it after the repository's pack checks (step 12), which stay as they are, and step 16 checks the published file list. If no, note it here and nothing changes.

## 5. Confirm the three trust-on-first-use anchors from a second source

**Owner: founder.** Three bundled anchors were taken from the authorities' own responses (bolt 1, 2026-11-03): Microsoft's (pinned at its intermediate, Microsoft Public RSA Timestamping CA 2020, because its tokens omit the root, Microsoft Identity Verification Root Certificate Authority 2020), SwissSign's (SwissSign Signature Services Root 2020 - 2) and FreeTSA's (its own root). Every output that counts one says `anchor pinned on first use … independent: false`, and Microsoft is one of the four defaults. Fetch each from a source other than the authority's token response (the operator's published certificate page or repository, an OS root store that carries it), compare its SHA-256 fingerprint with the bundle's (`src/timestamp/trust-bundle.json`), and write down where each came from and when. For Microsoft, decide whether to pin the root (once confirmed) or keep the intermediate.

## 6. Record the confirmed anchors in the trust bundle

**Owner: maintainer**, with the founder's confirmations from step 5. The bundle script cannot mark an anchor independent while that authority is planned as trust on first use, and `--write` keeps every certificate already in the bundle, so:

1. In `scripts/update-trust-bundle.mjs`, change each confirmed authority's `anchor` in `ANCHOR_PLAN` from `{ tofu: … }` to `{ system: "<the anchor's subject>" }`.
2. `npm run build && node scripts/update-trust-bundle.mjs --recorded test/fixtures/tsa/recorded-2026-11-03.json --trusted-root <Sigstore's trusted_root.json>#<label> --trusted-root <GitHub's trusted_root.json>#<label> --anchors <confirmed.pem>#<where it came from>` (one `--anchors` per confirmed certificate; the two TUF files are those a TUF client already verified: npm's `@sigstore/tuf` seeds and gh's TUF cache of tuf-repo.github.com, as BUILD-NOTES, "Trusted-time fix round A", used). Review the printed diff.
3. Edit the existing entries for those certificates in `src/timestamp/trust-bundle.json` (`independent: true`, and their `source`), since `--write` would keep the old ones; add the root for Microsoft if step 5 chose it.
4. Update what says "on first use": `test/timestamp-trust-bundle.test.ts` (it asserts `independent: false` for the three), the table in [`trusted-time.md`](trusted-time.md), T3 and "The limits" in [`security-model.md`](security-model.md), the README's Limitations, and the note in [`gh-aw-prospective.md`](gh-aw-prospective.md). Its recorded output stays as it was recorded.

## 7. Run the three manual assistant runs

**Owner: founder** (FR3.6, RQ2). Follow [`assistants/manual-acceptance.md`](assistants/manual-acceptance.md) in Claude Code, Codex and Cursor, on the recorded gh-aw audit, and fill in the three dated rows in BUILD-NOTES, "Bolt 8 (U6)", "The founder's manual runs". Keep the hook payloads each client sends (`guard.mjs --record`): they settle the payload shapes the build could only read about. A failure here changes a guide or the guard before release.

## 8. Check the GitHub visibility proof and the push log on an org you own

**Owner: founder.** Read-only, against live responses on an organization you own (no write, no scratch repository): a rule over that org (`repos: { owner: <your org> }`) with `pr-rla freeze --dry-run`, then a pooled audit's `verify`, with (a) an org owner's classic token holding `repo` (and `admin:org`, so GitHub sends `total_private_repos`), (b) a fine-grained token, (c) the `gh` CLI's OAuth token (`gho_`), and (d) a GitHub App installation token on all repositories and on selected ones. Expected: (a) and (d, all) prove private and internal completeness; (b), (c) without the count and (d, selected) leave check 5 INCOMPLETE. These proofs were built from GitHub's documentation and tested on fakes only (BUILD-NOTES, "U8 fix round" and "P3"). The push log was read live on two public repositories (github/gh-aw and gitlab-org/cli, 2026-11-04), but not on one with a force push or a renamed default branch: check `GET /repos/{owner}/{repo}/activity` on such a repository too. Record what you saw, dated, in BUILD-NOTES; a difference is a code change before release.

## 9. Diff the trust bundle against every authority's current chain

**Owner: maintainer** (NFR21). `npm run build && node scripts/update-trust-bundle.mjs --trusted-root <Sigstore's trusted_root.json>#<label> --trusted-root <GitHub's trusted_root.json>#<label>`: without `--recorded` it requests one token from each of the eight bundled authorities over the SHA-256 of a fixed probe string (a digest and a nonce leave the machine, nothing else), and prints how each chain differs from the bundle. Anchors and intermediates are only ever added, so old tokens keep verifying after a rotation. A new TSA issuing CA (DigiCert, GlobalSign, SwissSign and GitHub pin theirs) makes the script stop and name it: after review, add its name to that authority's `issuing` list in `ANCHOR_PLAN`, keeping the old one, or tokens under it fail. When the bundle changes, bump the script's `VERSION` (the bundle's date stamp, now `2026-11`) and `--write`.

## 10. Resolve the pending hooks, regenerate the output blocks, run the doc check

**Owner: maintainer** (FR8.2). The docs carry `<!-- pending P1: … -->` and `<!-- pending S1: … -->` hooks where the P1 (audit binding) and S1 (integration seams) rounds add behaviour; `npm run docs:check` lists them. Complete each section and remove its hook: there must be none at release. Then, after the last code change: `npm run build && npm run docs:outputs`, review the diff (every generated block and its date), commit it, and `npm run docs:check`. The check fails on an output block without its date, a block that no longer matches a fresh run, a broken relative link, a `pr-rla` command or option the CLI does not have, and an exit-code table that disagrees with `contracts.md` §7.

## 11. Verify from three fresh clones, on each platform you have

**Owner: maintainer.** Three times in a row, each from a fresh `git clone` of the release commit:

```sh
npm ci && npm run build && npm run typecheck && npm test
npm --prefix packages/pr-rla-mcp ci && npm --prefix packages/pr-rla-mcp test
npm --prefix examples/providers/gitea ci && npm --prefix examples/providers/gitea test
npm --prefix examples/ledgers/jira ci && npm --prefix examples/ledgers/jira test
npm --prefix integrations/github-action ci
for d in scripts/demo-*.mjs packages/pr-rla-mcp/scripts/demo-*.mjs; do node "$d" > /dev/null || echo "FAIL $d"; done
```

Run the root suite on Node 24 and 26 as well as 22 (`/path/to/node node_modules/vitest/vitest.mjs run`). macOS is the only platform tested so far ([`compatibility.md`](compatibility.md)): if a Linux machine is available, run the same there, including the two oracle tests that compare pr-rla with OpenSSH's `ssh-keygen` and OpenSSL's `openssl ts` (they have run only on macOS), and update the compatibility table either way. Windows stays untested unless someone runs it.

## 12. Check both tarballs, and date the changelogs

**Owner: maintainer** (FR8.3, NFR2). Build both packages first (`npm run build`, `npm --prefix packages/pr-rla-mcp run build`). `test/release.test.ts` and `packages/pr-rla-mcp/test/release.test.mjs` (in step 11's suites) assert that `npm pack --dry-run` lists only `dist/`, `README.md`, `CHANGELOG.md` and `package.json` in each package, and that a stale file in `dist/` never ships. Then, by hand: `npm run secret-grep` (both tarballs, every file: no token, private key or e-mail address), and read `npm pack --dry-run` once yourself in each package. Date both changelog entries: `## 0.1.0: unreleased` becomes `## 0.1.0 (YYYY-MM-DD)`, the release's day (the tests accept either form).

## 13. Make the two packages publishable

**Owner: founder.** npm refuses to publish a `"private": true` package. In `package.json` and `packages/pr-rla-mcp/package.json` only: remove `"private": true` and set `"license"` (step 1). Update the tests that hold the private rule for those two (step 1 lists them); the examples, the Action package and the plugin stay private.

## 14. Create the public repository `naren-ambati/pr-rla`

**Owner: founder.** Create it and push the release commit. Then replace the address placeholders: `<owner>/pr-rla` in `docs/ci/github.md` and `docs/assistants/claude-code.md`, the Action's `<full commit SHA>` in `docs/ci/github.md` (after step 19), and `<group>/<project>` and `<exact ref>` in `docs/ci/gitlab.md` (after step 20). `test/ci-integrations.test.ts` ("the Action's workflow example pins … a full commit SHA placeholder") asserts the literal placeholder and changes with it. The prospective gh-aw audit lives in a separate audit repository (step 22), not here.

## 15. Set up trusted publishing

**Owner: founder** (NFR18). Configure npm trusted publishing (OIDC, no long-lived token) for `pr-rla` and `pr-rla-mcp` from a release workflow in the public repository. Check npm's current requirements first; whether a package must already exist before a trusted publisher can be configured was not checked here. The repository has no CI of its own today, and `test/ci-integrations.test.ts` ("the repository has no CI of its own to publish from") says so: the workflow and that test's update land in the same change.

## 16. Tag v0.1.0 and publish `pr-rla@0.1.0` with provenance

**Owner: founder.** Tag `v0.1.0` on the release commit. From the trusted-publishing workflow, at that tag: `npm publish --provenance` in the repository root (with `npm-shrinkwrap.json` copied from `package-lock.json` first, if step 4 said yes). Then check, read-only: `npm view pr-rla@0.1.0 dist.integrity`, the provenance attestation on the package page, and that the published file list is `dist/`, `README.md`, `CHANGELOG.md`, `package.json` (and `npm-shrinkwrap.json`).

## 17. Re-pin `pr-rla-mcp` to the published `pr-rla`

**Owner: maintainer** (FR3.1: the server pins an exact pr-rla). In `packages/pr-rla-mcp/package.json` set `"pr-rla": "0.1.0"` (exact, no range) in place of `"file:../.."`; delete its `package-lock.json` and `node_modules/`; run `npm install --package-lock-only --ignore-scripts` there. Check that `node_modules/pr-rla` in the lockfile has `resolved: https://registry.npmjs.org/pr-rla/-/pr-rla-0.1.0.tgz` and an `integrity` equal to `npm view pr-rla@0.1.0 dist.integrity`. Update `packages/pr-rla-mcp/test/mcp-package.test.mjs` ("pr-rla is the repository's own package, linked" becomes the exact pin), `test/release.test.ts` (it accepts the link or the exact version) and the package README's "Run it" section, then `npm --prefix packages/pr-rla-mcp ci && npm --prefix packages/pr-rla-mcp test`. Commit, and tag the commit `pr-rla-mcp-v0.1.0`.

## 18. Publish `pr-rla-mcp@0.1.0` with provenance

**Owner: founder.** From the trusted-publishing workflow, at the `pr-rla-mcp-v0.1.0` tag: `npm publish --provenance` in `packages/pr-rla-mcp` (with its `npm-shrinkwrap.json`, if step 4 said yes). Check `npx -y pr-rla-mcp@0.1.0 --version` prints `0.1.0`. The plugin's `.mcp.json` and the Codex and Cursor configurations already pin `pr-rla-mcp@0.1.0`.

## 19. Re-pin the GitHub Action, the GitLab component and the Bitbucket step

**Owner: maintainer.** U7's "Re-pinning at release" ([`ci/github.md`](ci/github.md#re-pinning-at-release)), exactly, with X = 0.1.0:

1. After the founder publishes `pr-rla@X`, in `integrations/github-action/package.json` set `"pr-rla": "X"` (the exact version, no `^`).
2. Delete `integrations/github-action/package-lock.json`, `node_modules/` and `vendor/`, then run `npm install --package-lock-only --ignore-scripts` there. The lockfile now records `resolved: https://registry.npmjs.org/pr-rla/-/pr-rla-X.tgz` and the registry's `integrity`.
3. Check that entry: `resolved` starts with `https://registry.npmjs.org/`, and its `integrity` equals `npm view pr-rla@X dist.integrity`.
4. Delete `scripts/pack-action-tarball.mjs` and the `!integrations/github-action/vendor/…` exception in `.gitignore`.
5. In `integrations/gitlab/templates/pr-rla.yml`, the `version` default is `X`, and the `integrity` default may be that same `integrity`; in the snippet in `docs/ci/gitlab.md` and the step in `docs/ci/bitbucket.md`, `PRRLA_VERSION` is `X` (and `PRRLA_INTEGRITY` may be set). `test/ci-integrations.test.ts` reads the root `package.json` version, so those tests need no edit.
6. Replace `<owner>/pr-rla` and `<exact ref>` in these pages with the repository's address once it has one.
7. Run `npm --prefix integrations/github-action ci` and `npm test`.

Tests these steps change, though step 5's do not: `test/ci-integrations.test.ts` ("the pr-rla in the Action is a local tarball: no registry URL names pr-rla itself", the pre-release rule, with step 2) and the two of its file lists that name `scripts/pack-action-tarball.mjs` (with step 4), and `test/release.test.ts` ("the vendored Action tarball is that version's", with step 4). Commit, and pin the Action by this commit's full SHA in `docs/ci/github.md`.

## 20. Publish the GitLab component to the CI/CD Catalog

**Owner: founder** (FR6.6). Publishing to gitlab.com's CI/CD Catalog is a public write. A catalog component lives in a `templates/` directory at the root of its GitLab project, so the component's project is `integrations/gitlab/` on its own (its `templates/pr-rla.yml`, with a README), not a mirror of this repository. Mark that project a catalog project and release the component at a tag; `docs/ci/gitlab.md` then names its path in place of `<group>/<project>` and the tag in place of `<exact ref>`.

## 21. Check the Claude Code marketplace install

**Owner: maintainer.** Once the repository is public and `pr-rla-mcp` is on npm: `claude plugin marketplace add naren-ambati/pr-rla`, `claude plugin install pr-rla@pr-rla`, `/mcp` shows `plugin:pr-rla:pr-rla` with eight tools, and `claude plugin validate integrations/claude-code` passes. The local copy (`scripts/local-claude-plugin.mjs`) is no longer needed for users; keep it for development.

## 22. Register the prospective gh-aw audit

**Owner: founder, personally** (FR1.9, RQ24). Follow [`gh-aw-prospective.md`](gh-aw-prospective.md) with the released build (`npm install -g pr-rla@0.1.0`, or `npx pr-rla@0.1.0`): create the separate audit repository, fill in the placeholders in `audits/gh-aw-prospective/.pr-rla.yml`, `register --dry-run`, then `register`. No build or agent runs this step. The release starts the gh-aw clock: the certificate comes about seven weeks later (NFR8).
