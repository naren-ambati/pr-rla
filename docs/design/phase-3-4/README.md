# pr-rla phases 3–4: refined design

This is the finished design review of the draft in `pr-rla/docs/design/phase-3-4/` (README and 01–07). It refines that draft against the founder's vision, technical environment and decisions. It does not start from a blank page. Every document records what it **kept**, **changed** and **added** against the draft, and why.

**Design only.** This stops before code generation. Implementation is done separately.

## How it was made

- **Stages 1–5** ran as AI-DLC stages with the founder's approval at each one. They live in the workflow record, `aidlc/spaces/default/intents/261103-rla-design-review/`:

  | Stage | Files |
  |-------|-------|
  | Intent capture | `ideation/intent-capture/intent-statement.md`, `stakeholder-map.md` |
  | Feasibility | `ideation/feasibility/feasibility-assessment.md`, `constraint-register.md`, `raid-log.md` |
  | Scope | `ideation/scope-definition/scope-document.md`, `intent-backlog.md` |
  | Requirements | `inception/requirements-analysis/requirements.md` (FR1–FR10, NFR1–NFR19) |
  | Domain design | `inception/domain-design/components.md`, `decisions.md` (ADR-001 to ADR-007), `traceability.json` |

- **Stages 6–11** were completed directly, at the founder's instruction, from the founder's single answers file (`…/remaining-design-questions.md`) and the approved stages. They are in this folder. The AI-DLC workflow is paused at Units Generation. `/aidlc --resume` picks it up if the founder wants these stages formally approved there.
- **Open review points.** The ones the founder accepted at the last two approvals are resolved in this folder: requirements R-09 to R-12, and domain design R-01 to R-07.

## Files in this folder

| Stage | File | Refines draft |
|-------|------|---------------|
| Units Generation | `units-of-work.md`, `unit-of-work-dependency.md`, `unit-of-work-story-map.md` | `04-units-of-work.md` |
| Contract Design | `contracts.md` | `03` §3–4 and the interfaces in `05` |
| Delivery Planning | `delivery-plan.md` | `04` (order, estimates) |
| Functional Design | `functional-design.md` | `05-functional-design.md` |
| NFR Requirements | `nfr-requirements.md` | `01` NFRs |
| NFR Design | `nfr-design.md` | `06-nfr-design.md` |
| Test design | `test-design.md` | `07-test-design.md` |
| Independent review | `review.md` | the whole set. All 14 findings (8 major, 6 minor) have been fixed in the files above |

Infrastructure design does not apply (no hosted backend), as the draft already said.

## The founder's decisions applied

| Decision | Applied as |
|----------|------------|
| D1/D2 timestamp authorities | `init` writes four (Sigstore, DigiCert, GlobalSign, Microsoft) with k = 2; the build may fetch live tokens from all eight bundled authorities, hashes only |
| D3 no Rekor writes | No staging or production entry; the v2 client is mock-tested and `--submit` says so |
| D4 registered bots | `selector.bots` |
| D5 `direct_push_via_merge` | Available, default `include`; added as a requirement (FR7.6) |
| D6 Node | `>= 22.13` |
| D7 no FIDO key | Software-key fixtures only; default provenance `account` with issue ledgers; no claim of hardware-verified presence |
| D8 fixtures and mocks for writes | No scratch repos; CI harness and local bare repos; public timelines recorded read-only |
| D9 `drand-client` swap | Kept `drand-client` |
| D10 security contact | Placeholder in SECURITY.md |
| Answers file | Free-tier rate defaults, configurable; separate `pr-rla-mcp`; eight read-only tools; explicit `plugin add`; an ASN.1/CMS library rather than a hand-written parser; v0.1.0 as the first public release with all eleven units; build order U1 → U2a → U4 → U2b → U3 → U5 → U7 → U6 → U8 → U9 → U10; the founder runs the gh-aw `register` personally |

## The biggest changes from the draft

1. **No Rekor writes at all.** The v2 client ships labelled "unverified against production". Time evidence stands on the timestamp authorities alone (D3).
2. **Token parsing uses a maintained ASN.1/CMS library** if one passes a recorded evaluation (the draft hand-wrote a DER walker). pr-rla still enforces nonce, ESSCertID, EKU, chain and tolerance itself.
3. **Fewer than k tokens:** the record is written and the command exits 5 with the exact re-register command. `0 of k` counts too (new exit code).
4. **Every outbound HTTP call goes through the fetch broker**, including timestamp authorities, drand and Rekor, with per-destination timeouts (SCM 30 s, authority 15 s).
5. **Rate defaults are the smallest published limits**, cited per provider, including GitHub's 900 points/min. They replace the draft's round fallbacks.
6. **The plugin lock is written only by an explicit `plugin add`.** The draft also locked implicitly at the first `register`.
7. **MCP job state lives in memory only.** A job handle comes back at 25 s, inside the 30 s tool budget. `freeze_preview` never touches the on-disk cache.
8. **Checkpoints across clones** go through a git transport: fetch, rebuild, commit, push; at most 3 attempts; never force. They are appended only with `--checkpoint` or `checkpoint`, never by the MCP `status` tool.
9. **The issue ledgers honour self-hosted base URLs** (GHES, GitLab self-managed).
10. **Default verdict provenance is `account`** where an issue ledger is configured.
11. **A newly found limit:** a software-emulated security key can set the presence flag. So `presence` proves hardware presence only if the registered key is hardware-backed, which pr-rla does not check. It is now stated, printed (`key hardware not attested`), and listed as threat T16.
12. **CI is tested without scratch repos,** through schema checks and a harness that runs each template's steps against fixtures and a mock API.
13. **The org-pooled freeze is built in this round,** before release. One provider per pool, enforced in the core.
14. **Requirements the draft lacked:** the presence path and the broker as their own requirement groups, `direct_push_via_merge`, atomic writes, the exit-code contract, the error form, platforms, MCP memory bounds, trust-bundle freshness, and the parsing library's supply chain.
15. **The first public release is v0.1.0** with all eleven units. The draft had 0.2.x for phase 3 and 0.3.x for phase 4.
16. **The fixes from the independent review:**
    - U2a now lays an `src/api` foundation, so units before U5 have a place to add to.
    - The broker is the single retrier, and the 5-minute timestamp deadline lives in its policy.
    - Clock skew follows FR1.8 exactly (median genTime, no accuracy term).
    - Every SDK field has an owner.
    - A read-only API subpath, `pr-rla/api/read`, is the only thing the MCP server imports.
    - The checkpoint transport refuses dirty trees and replays unpushed verdict commits with a rebase, never a reset.
    - A `prrla-basic:` credential form covers Basic auth in the isolated host.
    - The gh-aw registration's fixed fields are spelled out, including that registering right after U1 means `git-file` and `self-asserted` provenance.

## One trade-off for the founder to know

The founder chose to register gh-aw as soon as U1 is built. That registration must use the `git-file` ledger, so the gh-aw certificate's verdict provenance will be `self-asserted`. Registering after U4 instead (about 6.5 build days later) would allow `github-issues` and `account` provenance. The design keeps the founder's choice; it can be changed by registering later.

## Still unverified (each has a named test that settles it)

| Item | Settled by |
|------|------------|
| IPC from a `--permission` child without `--allow-net` on Node 25 | U2b's first test |
| Whether GitHub fills `performed_via_github_app` on label events | U4, recorded from a public repo, else stays unverified |
| GitHub REST keeping a label's original name after a rename | U4, if a public example is found, else stays unverified |
| GitLab scoped-label swap events | U4, recorded from a public gitlab.com issue |
| Jira Cloud changelog format for a select field | Stays unverified (only Data Center can be read publicly) |
| Rekor v2 against production | Not in this round (D3) |
| Sigstore authority terms and rate limits | U1 live fetch; the terms remain unverified |
| Whether Claude Code starts a plugin's server in the project directory; Codex's hook payload | The founder's manual runs (U6) |
| Whether `ssh-keygen -Y verify` enforces the presence flag | U9's oracle cross-check |
| Bitbucket Cloud `Retry-After` on authenticated 429s; Bitbucket Data Center and GHES against live servers; token scopes on private repos | Marked unverified in the scope table |
| Whether `GITHUB_TOKEN` gets a lower GraphQL budget; GitLab.com's unauthenticated limit | U2a's defaults test |
| A software-emulated authenticator for the `-sk` fixtures | U9 build |

## What only the founder does

- Runs the prospective gh-aw `register` once U1 is built. The command is prepared in `docs/gh-aw-prospective.md`.
- Runs the manual assistant checks in Claude Code, Codex and Cursor.
- Decides the security contact (D10), the licence, and when to claim the npm names and create the public repo.
- Publishes. No step in the build publishes anything.
