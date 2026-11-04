# Changelog: pr-rla-mcp

Every release of `pr-rla-mcp`, newest first. It is released together with `pr-rla`, at the same version, and at release pins that exact `pr-rla` (until then it links the repository's own) ([`docs/compatibility.md`](../../docs/compatibility.md) in the pr-rla repository). Below 1.0, a renamed tool or a removed result field is a minor version and is listed here.

## 0.1.0: unreleased

Not published yet. The first release:

- A stdio MCP server with eight read-only tools: `audit_list`, `status`, `draws`, `draw_context`, `verify`, `simulate`, `freeze_preview` and `job_status`. Issuing draws, recording verdicts and submitting to a log stay with the CLI and a person.
- It imports only `pr-rla/api/read`: read-only contexts, no `trust: full` plugin, every file confined to the `--root`s, no file written, no request that is not a read.
- Long calls hand off to an in-memory job at 25 s; at most four run at once; a result over 8 MiB is refused; jobs and the freeze-preview cache live in memory only.
- The draw context's text from the change, its SCM, the ledger or a plugin is fenced as untrusted, with a fresh 128-bit id per call.
- Error codes: `ROOT_ESCAPE`, `NO_AUDIT`, `BAD_WINDOW`, `DRAW_OUT_OF_RANGE`, `READ_ONLY_VIOLATION`, `PROVIDER_ERROR`, `TIMEOUT`, `TOO_MANY_JOBS`, `RESULT_TOO_LARGE`, `TOO_MUCH_WORK` and `FAILED`.

<!-- pending S1: the integration-seams round (MCP robustness against hostile plugins; {words, foreign} results) adds its lines here when it merges. -->

Licence: decided by the founder before release.
