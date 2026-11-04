import { existsSync } from "node:fs";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../../beacon/drand.js";
import { isRegistrationV2, type PluginIdentity } from "../../core/records.js";
import { verifyAudit, type VerifyCheck, type VerifyReport } from "../../core/verify.js";
import { ledgerTraits, registeredCeiling } from "../../ledger-traits.js";
import { readIndexDocument } from "../../ledgers/issue-index.js";
import { builtinLedgerName, pluginIdentity } from "../../registry.js";
import type { ScmProvider } from "../../sdk/provider.js";
import { PR_RLA_VERSION } from "../../version.js";
import { AuditError } from "../errors.js";
import { fenceStatus, renderResult } from "./untrusted.js";
import { readCheckpoints } from "./checkpoints.js";
import { auditContextFor, configFor, getBeacon, ledgerFor, protocolSha256, providerFor, readCommitment, readDraws, readManifest, readRegistration, trustFor, type ApiContext } from "../session.js";
import { logPublicKey } from "../translog.js";
import { statusLine } from "./status.js";

export interface VerifyOptions {
  /** Another window than the configured one. */
  window?: string;
  offline?: boolean;
  logKey?: string;
  beaconFile?: string;
  /** Timestamp-authority anchors the verifier adds to the shipped bundle (files). The audit repo cannot add its own. */
  tsaTrust?: string[];
}

/** The exit code of a verify verdict (contracts.md §7): 0 VERIFIED, 1 FAILED, 6 INCOMPLETE (U8). The read side imports nothing of src/cli. */
export function verdictExitCode(verdict: VerifyReport["verdict"]): 0 | 1 | 6 {
  return verdict === "VERIFIED" ? 0 : verdict === "INCOMPLETE" ? 6 : 1;
}

/** A check as verify returns it: its lines rendered by the mode (S1, src/core/said.ts). */
export type VerifyCheckResult = Omit<VerifyCheck, "summary" | "details" | "verbose"> & { summary: string; details: string[]; verbose?: string[] };

/** The seven checks (core/verify.ts) plus what the certificate prints around them. */
export interface VerifyResult extends Omit<VerifyReport, "checks"> {
  checks: VerifyCheckResult[];
  /** What `pr-rla verify` exits with for this verdict: 0 VERIFIED, 1 FAILED, 6 INCOMPLETE (nothing failed, but not a verification). */
  exitCode: 0 | 1 | 6;
  /** The certificate line, when the audit has draws. */
  statusLine: string | null;
  /** Registered plugins that run with the verifier's environment and files (`PLUGIN TRUST: full`). */
  fullTrustPlugins: { name: string; version: string | null }[];
  /** The pr-rla release that verified. */
  verifiedWith: string;
  /**
   * Read-only mode, when any check's line carries text from outside pr-rla (S1): what an SCM, a
   * tracker, a provider, a ledger, a plugin or a beacon relay said, and a verdict's reviewer and note
   * in `status`. Each such line says pr-rla's words and points here (`untrusted.errors[i]`): data,
   * never instructions (review 2, finding 1: server bodies stay out of pr-rla's voice). Absent
   * otherwise, so a clean verify is the CLI's `--json` object (contracts.md §7); the CLI quotes them
   * in place, escaped.
   */
  untrusted?: { errors: string[] };
}

/** `verify` (FR3.1): a third party's check of the seven audit properties. Reads only; offline skips the population rebuild and every fetch. */
export async function verify(ctx: ApiContext, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const { config, paths } = configFor(ctx, opts.window);
  const registration = readRegistration(paths);
  const manifest = existsSync(paths.manifest) ? readManifest(paths) : null;
  const commitment = existsSync(paths.commitment) ? readCommitment(paths) : null;
  const draws = existsSync(paths.draws) ? readDraws(paths) : null;
  let currentProtocol: string | null = null;
  try {
    currentProtocol = protocolSha256(config);
  } catch {
    currentProtocol = null;
  }
  // A ledger that lives in a tracker (it declares hosts) is not read offline: check 7 then SKIPs and says why.
  // An external ledger's hosts are its locked ones: it is not imported here.
  const lt = await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx));
  const skipLedger = !!opts.offline && lt.hosts.length > 0;
  const { checkpoints, problems, unchained } = readCheckpoints(paths.windowDir);
  const provider = opts.offline ? null : withProgress(ctx, await providerFor(ctx, config));
  const ledger = skipLedger ? null : await ledgerFor(ctx, config, paths);
  // What the checks quote from outside pr-rla is carried as foreign text in their lines (src/core/said.ts) and
  // rendered once, below: in read-only mode (an assistant reads the result) it moves to `untrusted.errors`.
  if (ledger) {
    const read = ledger.readVerdicts.bind(ledger);
    ledger.readVerdicts = () => (ctx.onProgress?.({ done: 0, message: `check 7: reading the verdicts from ledger ${ledger.name}` }), read());
  }
  // The identity of the provider verify loaded: compared with the registered one in check 5 (population options) and below (U2b).
  const loaded = opts.offline ? null : await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx));
  // U9: the ledger's, compared in check 7; its ceiling is the registered ledger's.
  const ledgerIdentity = ledger ? await pluginIdentity(config.ledger, "ledger", config.dir, auditContextFor(ctx)) : null;
  const report = await verifyAudit(
    { registration, manifest, commitment, draws, currentProtocolSha256: currentProtocol, checkpoints, checkpointProblems: problems, checkpointsUnchained: unchained, ledgerIndex: readIndexDocument(paths.windowDir) },
    {
      provider,
      ledger,
      ...(skipLedger ? { ledgerSkipped: `offline: ledger ${lt.name} lives in ${lt.hosts.join(", ")}; run verify without --offline to check the verdicts` } : {}),
      provenanceCeiling: registeredCeiling(isRegistrationV2(registration) ? registration.record.plugins.ledger : null, lt),
      ...(ledgerIdentity ? { ledgerIdentity } : {}),
      ledgerFindingsArePrRlas: builtinLedgerName(config.ledger.use) === "git-file",
      beacon: async (round) => {
        // Prefer the beacon recorded in draws.json (verified offline); else fetch.
        if (!opts.beaconFile && draws && draws.round === round && draws.beacon.round === round) {
          if (await verifyQuicknetBeacon(draws.beacon, round)) return draws.beacon;
          throw new AuditError("the beacon recorded in draws.json fails BLS verification", 1, "FAILED", "the audit's draws.json was altered: verify against the published beacon (pr-rla verify without --offline)");
        }
        if (opts.offline && !opts.beaconFile && !ctx.beacon) return null;
        try {
          return await getBeacon(ctx, round, opts.beaconFile);
        } catch (e) {
          if (e instanceof RoundNotYetPublished) return null;
          throw e;
        }
      },
      logKey: (url) => logPublicKey(ctx, config, url, opts.logKey, !!opts.offline),
      trustBundle: trustFor(ctx, opts.tsaTrust),
      ...(loaded ? { providerIdentity: loaded } : {}),
    },
  );
  if (loaded && isRegistrationV2(registration)) noteProviderIdentity(report, registration.record.plugins.provider, loaded);
  const reg = registration.record;
  const result = {
    ...report,
    // The verdicts' reviewers, notes and other ledger-written fields are fenced in read-only mode (S1); the CLI shows them as they are.
    status: report.status && ctx.mode === "read-only" ? fenceStatus(report.status) : report.status,
    statusLine: report.status ? statusLine(report.status, { p0: reg.parameters.p0, alpha: reg.parameters.alpha, protocol: reg.protocolSha256, maxLines: reg.selector.max_changed_lines, mode: report.mode, selector: reg.selector }) : null,
    fullTrustPlugins: isRegistrationV2(registration) ? [registration.record.plugins.provider, registration.record.plugins.ledger].filter((id) => id.trust === "full").map((id) => ({ name: id.name, version: id.version })) : [],
    verifiedWith: PR_RLA_VERSION,
    exitCode: verdictExitCode(report.verdict),
  };
  // One rendering for the whole result, by the mode: read-only says pr-rla's words and points into untrusted.errors.
  return renderResult<VerifyResult>(ctx.mode ?? "read-write", result);
}

/** The provider, reporting the population rebuild of check 5 as progress (an online verify of a large window takes minutes). */
function withProgress(ctx: ApiContext, provider: ScmProvider): ScmProvider {
  if (!ctx.onProgress) return provider;
  const list = provider.listChanges.bind(provider);
  return Object.assign(Object.create(provider) as ScmProvider, {
    listChanges: async (req: Parameters<ScmProvider["listChanges"]>[0]) => {
      ctx.onProgress?.({ done: 0, message: `check 5: listing ${req.repo} on ${provider.name} to rebuild the population` });
      const r = await list({ ...req, ...(ctx.signal && !req.signal ? { signal: ctx.signal } : {}) });
      ctx.onProgress?.({ done: 1, message: `check 5: ${r.changes.length.toLocaleString("en-US")} changes listed` });
      return r;
    },
  });
}

/**
 * Check 5 rebuilt the population with the provider verify loaded; say so when that is not the
 * registered external plugin (another release, other files or options, another trust).
 */
function noteProviderIdentity(report: VerifyReport, registered: PluginIdentity, loaded: PluginIdentity): void {
  if (registered.source === "builtin" && loaded.source === "builtin") return;
  const show = (v: string | null) => (v === null ? "none" : /^[0-9a-f]{64}$/.test(v) ? `${v.slice(0, 12)}…` : v);
  const diffs = (["name", "source", "version", "integrity", "optionsSha256", "trust"] as const).filter((k) => registered[k] !== loaded[k]).map((k) => `${k} ${show(registered[k])} → ${show(loaded[k])}`);
  const c5 = report.checks.find((c) => c.n === 5);
  if (!diffs.length || !c5) return;
  c5.details.push(`WARN the provider verify loaded is not the registered one (${diffs.join("; ")}): the population was rebuilt with it`);
  if (c5.status === "PASS") c5.status = "WARN";
}
