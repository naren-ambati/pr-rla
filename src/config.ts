import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import type { AuditParameters, RepoSet } from "./core/records.js";
import { normalizeRepoSet, repoSetLabel } from "./core/repo-set.js";
import { normalizeSelector, type Selector } from "./core/selector.js";
import { parseAllowedSigners } from "./core/presence/allowed-signers.js";
import { validateParams } from "./core/sprt.js";
import { resolveWindow, type ResolvedWindow } from "./core/window.js";
import { parseRate, type RateLimitOverrides } from "./net/rate-limits.js";
import { normalizePluginSpec, type PluginSpec } from "./registry.js";
import { PROVENANCE_LEVELS, type ProvenanceLevel } from "./sdk/ledger.js";
import { DEFAULT_AUTHORITIES, DEFAULT_MIN_TOKENS } from "./timestamp/bundle.js";

export const CONFIG_FILE = ".pr-rla.yml";

export interface PrRlaConfig {
  configPath: string;
  /** The audit repo: directory holding .pr-rla.yml. */
  dir: string;
  provider: PluginSpec;
  /** What the audit covers (U8): one repo (`repo:`), a list or a rule (`repos:`). A single repo is a pool of one. */
  repoSet: RepoSet;
  /** Display name of `repoSet`: the repo itself, or `owner/*` for a rule, `n repos` for a list. */
  repo: string;
  window: ResolvedWindow;
  selector: Selector;
  parameters: AuditParameters;
  /** Path to the review protocol, relative to dir. */
  protocol: string;
  ledger: PluginSpec;
  auditDir: string;
  signingKey: string;
  transparencyLog: { url: string | null; publicKeyFile: string | null };
  /** RFC 3161 authorities (trust-bundle ids) and k. Absent in .pr-rla.yml means the four defaults with k = 2. */
  timestamping: { authorities: string[]; minTokens: number };
  /** `rate_limits:` per host, replacing default budgets (NFR12): `{ "api.github.com": { rest: "5000/h", concurrency: 50 } }`. */
  rateLimits: RateLimitOverrides;
  /**
   * `verdicts:` (FR3.8): the minimum provenance a counted verdict needs (null: the ledger's own level,
   * `account` for issue ledgers, else `self-asserted`) and the reviewers whose verdicts count (null: any non-bot account).
   * `allowed_signers` (git-file, U9): the reviewers' SSH keys as allowed-signers lines, given inline
   * or as a file next to the configuration; null when none are registered.
   */
  verdicts: { minProvenance: ProvenanceLevel | null; reviewers: string[] | null; allowedSigners: string[] | null };
  /** `freeze:` (U8): operational settings of a pooled freeze. They are not registered: they change how fast it runs, never what it finds. */
  freeze: { concurrency: number };
}

/** Repos frozen at once in a pooled freeze (FR5.7). The fetch broker's per-host budget, not this, limits the request rate. */
export const DEFAULT_FREEZE_CONCURRENCY = 4;

/** Issue ledgers that take their provider's self-hosted base_url when they set none (FR4.8). */
const LEDGER_BASE_URL_FROM: Readonly<Record<string, string>> = { "github-issues": "github", "gitlab-issues": "gitlab" };

export interface WindowPaths {
  windowDir: string;
  manifest: string;
  registration: string;
  commitment: string;
  draws: string;
}

export function windowPaths(c: Pick<PrRlaConfig, "dir" | "auditDir" | "window">): WindowPaths {
  const base = resolve(c.dir, c.auditDir);
  const windowDir = join(base, c.window.name);
  return {
    windowDir,
    manifest: join(base, `${c.window.name}.manifest.json`),
    registration: join(windowDir, "registration.json"),
    commitment: join(windowDir, "manifest-commitment.json"),
    draws: join(windowDir, "draws.json"),
  };
}

function num(v: unknown, name: string, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

export function parseConfig(text: string, configPath: string, overrides: { fromFile?: string } = {}): PrRlaConfig {
  let raw: Record<string, unknown>;
  try {
    raw = (parse(text) ?? {}) as Record<string, unknown>;
  } catch (e) {
    const hint = text.includes("[bot]") ? ' (quote logins that contain [bot], e.g. authors: ["copilot-swe-agent[bot]"])' : "";
    throw new Error(`${configPath}: ${(e as Error).message.split("\n")[0]}${hint}`);
  }
  const dir = dirname(resolve(configPath));
  let provider = normalizePluginSpec(raw.provider, "provider", "github");
  if (overrides.fromFile) provider = { use: "json-file", options: { path: resolve(process.cwd(), overrides.fromFile) } };
  let repoSet: RepoSet;
  try {
    repoSet = normalizeRepoSet(raw);
  } catch (e) {
    throw new Error(`${configPath}: ${(e as Error).message}`);
  }
  const w = (raw.window ?? {}) as Record<string, unknown>;
  const start = String(w.start ?? "");
  const end = String(w.end ?? "");
  const window = resolveWindow({ name: typeof w.name === "string" ? w.name : `${start}_${end}`, start, end });
  const a = (raw.audit ?? {}) as Record<string, unknown>;
  const claim = a.claim ?? "D";
  if (claim !== "D") throw new Error(`audit.claim "${String(claim)}" is not supported in v0.1 (claim T needs calibration; planned for v0.2)`);
  const p0 = num(a.p0, "audit.p0", 0.1);
  const parameters: AuditParameters = {
    claim: "D",
    p0,
    p1: num(a.p1, "audit.p1", p0 / 5),
    alpha: num(a.alpha, "audit.alpha", 0.05),
    cap: a.cap === undefined || a.cap === null ? null : num(a.cap, "audit.cap", 0),
    minPopulation: num(a.min_population, "audit.min_population", 150),
  };
  validateParams(parameters);
  const tl = (raw.transparency_log ?? {}) as Record<string, unknown>;
  const ts = (raw.timestamping ?? {}) as Record<string, unknown>;
  const authorities = ts.authorities === undefined ? [...DEFAULT_AUTHORITIES] : ts.authorities;
  if (!Array.isArray(authorities) || authorities.some((a) => typeof a !== "string" || a.length === 0)) throw new Error(`${configPath}: timestamping.authorities must be a list of trust-bundle ids, or [] for none`);
  if (new Set(authorities).size !== authorities.length) throw new Error(`${configPath}: timestamping.authorities lists an authority twice`);
  const rateLimits = parseRateLimits(raw.rate_limits, configPath);
  const minTokens = num(ts.min_tokens, "timestamping.min_tokens", DEFAULT_MIN_TOKENS);
  if (!Number.isInteger(minTokens) || minTokens < 1) throw new Error(`${configPath}: timestamping.min_tokens must be a whole number >= 1`);
  const ledger = normalizePluginSpec(raw.ledger, "ledger", "git-file");
  const inheritFrom = LEDGER_BASE_URL_FROM[ledger.use];
  if (inheritFrom && provider.use === inheritFrom && ledger.options.base_url === undefined && provider.options.base_url !== undefined) ledger.options = { ...ledger.options, base_url: provider.options.base_url };
  return {
    configPath: resolve(configPath),
    dir,
    provider,
    repoSet,
    repo: repoSetLabel(repoSet),
    window,
    selector: normalizeSelector(raw.selector as Record<string, unknown> | undefined),
    parameters,
    protocol: typeof raw.protocol === "string" ? raw.protocol : "review-protocol.md",
    ledger,
    auditDir: typeof raw.audit_dir === "string" ? raw.audit_dir : "audit",
    signingKey: typeof raw.signing_key === "string" ? raw.signing_key : ".pr-rla/signing-key.pem",
    transparencyLog: {
      url: typeof tl.url === "string" ? tl.url : null,
      publicKeyFile: typeof tl.public_key_file === "string" ? tl.public_key_file : null,
    },
    timestamping: { authorities: authorities as string[], minTokens },
    rateLimits,
    verdicts: parseVerdicts(raw.verdicts, configPath),
    freeze: parseFreeze(raw.freeze, configPath),
  };
}

/** `freeze: { concurrency: 4 }`. */
function parseFreeze(raw: unknown, configPath: string): PrRlaConfig["freeze"] {
  if (raw === undefined || raw === null) return { concurrency: DEFAULT_FREEZE_CONCURRENCY };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${configPath}: freeze must be a mapping, e.g. freeze: { concurrency: 4 }`);
  const f = raw as Record<string, unknown>;
  for (const k of Object.keys(f)) if (k !== "concurrency") throw new Error(`${configPath}: freeze.${k} is not a setting (freeze takes concurrency)`);
  const c = f.concurrency === undefined || f.concurrency === null ? DEFAULT_FREEZE_CONCURRENCY : f.concurrency;
  if (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 32) throw new Error(`${configPath}: freeze.concurrency must be a whole number from 1 to 32`);
  return { concurrency: c };
}

/**
 * `verdicts: { min_provenance: account, reviewers: [login, "id:<account id>"], allowed_signers: [...] | <file> }`.
 * `allowed_signers` (U9) is a list of OpenSSH allowed-signers lines, or the path (relative to the
 * configuration) of an allowed_signers file; blank lines and `#` comments in the file are skipped.
 */
function parseVerdicts(raw: unknown, configPath: string): PrRlaConfig["verdicts"] {
  if (raw === undefined || raw === null) return { minProvenance: null, reviewers: null, allowedSigners: null };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${configPath}: verdicts must be a mapping, e.g. verdicts: { min_provenance: account, reviewers: [alice] }`);
  const v = raw as Record<string, unknown>;
  for (const k of Object.keys(v))
    if (k !== "min_provenance" && k !== "reviewers" && k !== "allowed_signers") throw new Error(`${configPath}: verdicts.${k} is not a setting (verdicts takes min_provenance, reviewers and allowed_signers)`);
  const min = v.min_provenance;
  if (min !== undefined && min !== null && !PROVENANCE_LEVELS.includes(min as ProvenanceLevel)) throw new Error(`${configPath}: verdicts.min_provenance must be one of ${PROVENANCE_LEVELS.join(", ")}`);
  let reviewers: string[] | null = null;
  if (v.reviewers !== undefined && v.reviewers !== null) {
    if (!Array.isArray(v.reviewers) || v.reviewers.some((r) => typeof r !== "string" || r.trim() === "")) throw new Error(`${configPath}: verdicts.reviewers must be a list of logins (or "id:<account id>")`);
    const bad = (v.reviewers as string[]).find((r) => /[<>]/.test(r));
    if (bad) throw new Error(`${configPath}: verdicts.reviewers: replace the placeholder ${JSON.stringify(bad)} with a login`);
    if (v.reviewers.length === 0) throw new Error(`${configPath}: verdicts.reviewers is empty, so no verdict could count; list the reviewers, or leave it out to accept any account that is not a bot`);
    reviewers = [...new Set((v.reviewers as string[]).map((r) => r.trim()))].sort();
  }
  return { minProvenance: (min ?? null) as ProvenanceLevel | null, reviewers, allowedSigners: parseAllowedSignersSetting(v.allowed_signers, configPath) };
}

/** `verdicts.allowed_signers`: inline lines, or an allowed_signers file next to the configuration. Each line is checked here. */
function parseAllowedSignersSetting(raw: unknown, configPath: string): string[] | null {
  if (raw === undefined || raw === null) return null;
  let lines: string[];
  if (typeof raw === "string") {
    const file = resolve(dirname(configPath), raw);
    if (!existsSync(file)) throw new Error(`${configPath}: verdicts.allowed_signers names ${raw}, which does not exist (give the file's path relative to the configuration, or list the lines)`);
    lines = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
  } else if (Array.isArray(raw) && raw.every((r) => typeof r === "string" && r.trim() !== "")) lines = (raw as string[]).map((r) => r.trim());
  else throw new Error(`${configPath}: verdicts.allowed_signers must be a list of allowed-signers lines ("<principal> <keytype> <base64 key>") or the path of an allowed_signers file`);
  if (lines.length === 0) throw new Error(`${configPath}: verdicts.allowed_signers lists no key; leave it out to register none`);
  if (lines.some((l) => /[<>]/.test(l))) throw new Error(`${configPath}: verdicts.allowed_signers: replace the placeholder with the reviewer's principal and public key`);
  try {
    return parseAllowedSigners(lines).map((s) => s.line).sort();
  } catch (e) {
    throw new Error(`${configPath}: verdicts.allowed_signers: ${(e as Error).message}`);
  }
}

/** `rate_limits:` checked for shape and rate syntax here; rule names are checked against the host's budget when it is used. */
function parseRateLimits(raw: unknown, configPath: string): RateLimitOverrides {
  if (raw === undefined || raw === null) return {};
  const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isMap(raw)) throw new Error(`${configPath}: rate_limits must map hosts to rules, e.g. rate_limits: { api.github.com: { rest: 5000/h } }`);
  const out: RateLimitOverrides = {};
  for (const [host, rules] of Object.entries(raw)) {
    if (!isMap(rules)) throw new Error(`${configPath}: rate_limits.${host} must map rule names to rates`);
    for (const [id, v] of Object.entries(rules)) {
      const rate = typeof v === "string" ? v : isMap(v) ? v.rate : undefined;
      if (id === "concurrency") continue;
      try {
        if (typeof rate !== "string") throw new Error(`a rate like "5000/h", or { rate: "5/s", burst: 60 }`);
        parseRate(rate);
      } catch (e) {
        throw new Error(`${configPath}: rate_limits.${host}.${id}: ${(e as Error).message}`);
      }
    }
    out[host] = rules;
  }
  return out;
}

export function loadConfig(path: string, overrides: { fromFile?: string } = {}): PrRlaConfig {
  if (!existsSync(path)) throw new Error(`no ${CONFIG_FILE} at ${path} (run "pr-rla init")`);
  return parseConfig(readFileSync(path, "utf8"), path, overrides);
}

export const CONFIG_TEMPLATE = (repo: string, provider: string) => `# pr-rla configuration. Everything under selector/window/audit is frozen by "pr-rla register".
provider: ${provider}            # github | gitlab | bitbucket-cloud | bitbucket-data-center | json-file | ./my-provider.mjs | { use: <name|path|package>, options: {...} }
repo: ${repo}

window:
  name: 2026-q3                 # file-name safe; audit files live under audit/<name>/
  start: 2026-07-01             # inclusive, UTC
  end: 2026-09-30               # inclusive, UTC

selector:
  kinds: [pull_request, direct_push]
  authors: any                  # or a quoted list, e.g. ["copilot-swe-agent[bot]", "claude[bot]"]
  labels: []                    # a change must carry all of these
  unreviewed: no-human-review   # no-human-review | no-review | any
  merged_by: any                # human | bot | any (direct pushes only match any)
  max_changed_lines: null       # e.g. 200 (raw additions + deletions)
  exclude_generated: true       # review scope only; does not change the stratum
  bots: []                      # accounts to count as bots on every provider: logins or "id:<account id>", e.g. ["gitlab-bot"]
  direct_push_via_merge: include  # include | exclude: direct pushes a pushed merge brought in (e.g. a release branch)

audit:
  claim: D                      # detected-defect rate under the review protocol
  p0: 0.10
  p1: 0.02
  alpha: 0.05
  cap: null                     # default: 4 x the zero-failure stopping point
  min_population: 150

protocol: review-protocol.md
ledger: git-file                # verdicts in audit/<window>/verdicts.jsonl

timestamping:                   # RFC 3161 tokens bound the registration and freeze times. Only the
  authorities: [sigstore, digicert, globalsign, microsoft]   # record's SHA-256 digest and a nonce are sent.
  min_tokens: 2                 # k: distinct operators that must agree; [] above = none (TIMESTAMP NOT TAMPER-PROOF)
# transparency_log:             # used only with --submit; no default on purpose
#   url: https://<your-rekor>
#   public_key_file: rekor.pub  # checks a --rekor-api v2 submission only; verify trusts pinned keys or --log-key
`;

export const PROTOCOL_TEMPLATE = `# Review protocol

This file is hashed into the registration. Every verdict names its hash, so
changing the protocol mid-audit is detectable. Fix it before \`pr-rla register\`.

## Scope
Read the change's full diff (generated files excluded when \`exclude_generated\` is true),
its description and its CI results.

## A change FAILS if any of these holds
1. It introduces a bug a user or another developer would hit (wrong result, crash, data loss).
2. It introduces a security weakness (injection, auth bypass, secret exposure, unsafe defaults).
3. It breaks or silently weakens a test, check or CI gate.
4. It does not do what its title/description says, in a way that matters.

## Otherwise it PASSES
Style, naming and taste issues are not failures.

## Recording
\`pr-rla record <draw> pass|fail --reviewer <you> --note "<one line>"\`, then commit.
`;
