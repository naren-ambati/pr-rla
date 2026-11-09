# Images

Every PNG here is a screenshot of a real run, made on 2026-11-09 with pr-rla 0.1.0. The text in each is in [`transcripts/`](transcripts) as the command, its merged stdout and stderr, its exit status and its wall time; nothing was typed or edited by hand.

How they were made:

1. A capture script ran each command in a shell with the audit directory it names, and stored the transcript as JSON. Four live commands (`register`, `freeze`, `status`, `verify` on the github/gh-aw demo audit) cannot be repeated, so their transcripts are the output saved when they ran, minus the shell's own `time` summary line (its seconds are kept). The CI images come from the real steps of the GitHub Action and the GitLab and Bitbucket scripts, run by the harness in [`test/e2e-capture-ci.test.ts`](../../test/e2e-capture-ci.test.ts) (`PR_RLA_E2E_CAPTURE=<dir> npx vitest run test/e2e-capture-ci.test.ts`). The Claude Code transcript is formatted from `claude -p --output-format stream-json`.
2. [`render.mjs`](render.mjs) turned each transcript into a terminal-style page (the GitHub Action's job summary Markdown into a GitHub-styled page), with a caption line holding the pr-rla version and the capture date, and screenshotted it with Playwright 1.65.0's headless Chromium (`npx playwright@1.65.0 install chromium`, a read-only download).
3. The PNGs were reduced to 48 colours with ImageMagick (`magick in.png -colors 48 -dither None -strip PNG8:out.png`), about 1.2 MB in all. `npm run docs:check` fails if the images pass 3 MB.

What differs from the raw output, and only this: the working directory `~/…/_e2e-live` is written `~/e2e`, the checkout `~/pr-rla`, the system temp directory `$TMPDIR/`, and the home directory `~`; a few commands pipe through `head`, `grep` or `sed` to keep the image short, and the image shows that command.

Whose data: the github/gh-aw demo is a real run against the live GitHub API (reads only), four timestamp authorities (SHA-256 hashes only) and the drand beacon. The recorded audit is [`test/fixtures/audits/gh-aw-q3-recorded`](../../test/fixtures/audits/gh-aw-q3-recorded/README.md). Its verdicts, the tampered copies, the CI fixtures and the keys are synthetic or DEMO, made for these runs with software keys in a temporary directory. None of it is an audit claim.
