# Requirement-to-Unit Map: pr-rla phases 3–4

**Stage:** Units Generation. There is no stories stage, so each row is a sub-requirement `FR{n}.{m}` from the approved `requirements.md`, and the NFRs follow. Every unit named on a row implements part of that requirement.

## Functional requirements

| ID | Unit | Directory | Note |
|----|------|-----------|------|
| FR1.1 | U1 | u1-trusted-time | |
| FR1.2 | U1 | u1-trusted-time | |
| FR1.3 | U1 | u1-trusted-time | Library evaluation |
| FR1.4 | U1 | u1-trusted-time | |
| FR1.5 | U1 | u1-trusted-time | |
| FR1.6 | U1 | u1-trusted-time | |
| FR1.7 | U1 | u1-trusted-time | |
| FR1.8 | U1 | u1-trusted-time | |
| FR1.9 | U1; U10 | u1-trusted-time; u10-docs-release | U1 makes the command; U10 documents the hand-off |
| FR1.10 | U1 | u1-trusted-time | |
| FR1.11 | U1 | u1-trusted-time | |
| FR2.1 | U2b | u2b-plugin-host | |
| FR2.2 | U2b | u2b-plugin-host | |
| FR2.3 | U2b | u2b-plugin-host | |
| FR2.4 | U2b | u2b-plugin-host | |
| FR2.5 | U2b | u2b-plugin-host | |
| FR2.6 | U2b | u2b-plugin-host | |
| FR2.7 | U2b | u2b-plugin-host | |
| FR3.1 | U5 | u5-audit-api-mcp | |
| FR3.2 | U5 | u5-audit-api-mcp | |
| FR3.3 | U5 | u5-audit-api-mcp | |
| FR3.4 | U5 | u5-audit-api-mcp | |
| FR3.5 | U5 | u5-audit-api-mcp | |
| FR3.6 | U5 | u5-audit-api-mcp | |
| FR3.7 | U6 | u6-assistant-integrations | |
| FR3.8 | U4; U9 | u4-issue-ledgers; u9-presence-verdicts | U4: `account` default; U9: `presence` and `minProvenance` |
| FR3.9 | U5 | u5-audit-api-mcp | |
| FR4.1 | U4 | u4-issue-ledgers | |
| FR4.2 | U4 | u4-issue-ledgers | |
| FR4.3 | U4 | u4-issue-ledgers | |
| FR4.4 | U4 | u4-issue-ledgers | |
| FR4.5 | U4 | u4-issue-ledgers | |
| FR4.6 | U4 | u4-issue-ledgers | |
| FR4.7 | U4 | u4-issue-ledgers | |
| FR4.8 | U4 | u4-issue-ledgers | |
| FR5.1 | U8 | u8-org-pooled-freeze | |
| FR5.2 | U8 | u8-org-pooled-freeze | |
| FR5.3 | U8 | u8-org-pooled-freeze | |
| FR5.4 | U8 | u8-org-pooled-freeze | |
| FR5.5 | U8 | u8-org-pooled-freeze | Uses U2a's governor |
| FR5.6 | U8 | u8-org-pooled-freeze | |
| FR5.7 | U8 | u8-org-pooled-freeze | |
| FR5.8 | U8 | u8-org-pooled-freeze | |
| FR6.1 | U7 | u7-ci-integrations | |
| FR6.2 | U7 | u7-ci-integrations | |
| FR6.3 | U7 | u7-ci-integrations | |
| FR6.4 | U7 | u7-ci-integrations | |
| FR6.5 | U7 | u7-ci-integrations | |
| FR6.6 | U7 | u7-ci-integrations | |
| FR6.7 | U7 | u7-ci-integrations | The end-to-end matrix in `test-design.md` §3 |
| FR7.1 | U3 | u3-sdk-carry-overs | |
| FR7.2 | U3 | u3-sdk-carry-overs | |
| FR7.3 | U3 | u3-sdk-carry-overs | |
| FR7.4 | U3 | u3-sdk-carry-overs | |
| FR7.5 | U3 | u3-sdk-carry-overs | |
| FR7.6 | U3 | u3-sdk-carry-overs | |
| FR7.7 | U3 | u3-sdk-carry-overs | |
| FR8.1 | U10 | u10-docs-release | |
| FR8.2 | U10 | u10-docs-release | |
| FR8.3 | U10 | u10-docs-release | |
| FR9.1 | U9 | u9-presence-verdicts | |
| FR9.2 | U9 | u9-presence-verdicts | |
| FR9.3 | U9 | u9-presence-verdicts | |
| FR9.4 | U9 | u9-presence-verdicts | |
| FR9.5 | U9 | u9-presence-verdicts | |
| FR9.6 | U9 | u9-presence-verdicts | |
| FR10.1 | U2a | u2a-fetch-broker | |
| FR10.2 | U2a | u2a-fetch-broker | |
| FR10.3 | U2a | u2a-fetch-broker | |
| FR10.4 | U2a | u2a-fetch-broker | |
| FR10.5 | U2a | u2a-fetch-broker | |

## Cross-cutting NFRs

| ID | Units | How it is shared |
|----|-------|------------------|
| NFR1 Least privilege | U2a, U4, U7, U10 | `writePaths` enforcement in the broker; scopes per ledger and CI template; the scope table in the docs |
| NFR2 Secrets | U2a, U2b, U5, U10 | Recorder scrubbing; placeholders; MCP results; the tarball grep |
| NFR3 No public writes | U1, U4, U6, U7 | `--submit` warning; ledger writes only on explicit commands; hooks; CI defaults |
| NFR4 Honest output | U1, U2b, U9 | Timestamp, plugin-trust and provenance lines |
| NFR5–NFR6 Resumable, deterministic | U3, U8 | Pinned heads; checkpoints |
| NFR7 Compatibility | U1 | v1 records keep verifying |
| NFR8 Versioning | U10 | The compatibility table |
| NFR9 Dependencies | U1, U5 | The ASN.1/CMS library; the MCP SDK stays in `pr-rla-mcp` |
| NFR10 Performance | U5 | Fixture timings |
| NFR11 Testability | all | `test-design.md` |
| NFR12 Rate budgets | U2a | Default table |
| NFR13 Runtime | U2b, U10 | Node 22.13; Node 25 network denial |
| NFR14–NFR15 Timeouts, atomic writes | U2a, U4, U5 | Broker and git transport timeouts; AuditApi atomic writes |
| NFR16–NFR17 Exit codes, error form | U5, U10 | CLI formatters; the compatibility table |
| NFR18 Supply chain | U7, U10 | Pinned versions; release checklist |
| NFR19 Platforms | U7, U10 | macOS and Linux in CI; README note on Windows |
| NFR20 MCP memory bounds | U5 | 4 jobs, 8 MiB results, 600 s retention |
| NFR21 Trust bundle freshness | U1, U10 | Historical certificates kept; release diff |
| NFR22 Parsing library | U1 | Exact pin; tamper fixtures on upgrade |
| NFR23 Presence claims | U9, U10 | Certificate wording; docs check |
| NFR24 Checkpoint push | U4 | 3 attempts, never force, exit 4 |

## Implementation order within each unit

Each unit builds its contract first (types and schemas from `contracts.md`), then its pure logic with fixtures, then its I/O edges, then its docs page. Tamper and failure fixtures come with the feature, not after it.

## Coverage check

- All 71 `FR{n}.{m}` IDs in `requirements.md` are assigned, and every unit has at least one row.
- U10 also owns FR1.9's documentation half.
- U2a and U5 own most cross-cutting NFRs.
