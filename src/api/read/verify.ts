import { existsSync } from "node:fs";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../../beacon/drand.js";
import { isRegistrationV2, type PluginIdentity } from "../../core/records.js";
import { auditVerdict, certificateFor, isCertified, verdictExitCode, verdictWithholdings, type Withholding } from "../../core/verdict.js";
import { accessShortfall } from "../access.js";
import { localFails, verifyAudit, type VerifyReport } from "../../core/verify.js";
import { ledgerTraits, registeredCeiling } from "../../ledger-traits.js";
import { readIndexDocument } from "../../ledgers/issue-index.js";
import { pluginIdentity } from "../../registry.js";
import { providerTraits } from "../../provider-traits.js";
import type { ScmProvider } from "../../sdk/provider.js";
import { PR_RLA_VERSION } from "../../version.js";
import { AuditError } from "../errors.js";
import { readCheckpoints } from "./checkpoints.js";
import { readError } from "./errors.js";
import { auditContextFor, configFor, getBeacon, ledgerFor, protocolSha256, providerFor, readCommitment, readDraws, readManifest, readRegistration, trustFor, type ApiContext } from "../session.js";
import { verifierLogKeys } from "../translog.js";
import { statusLine } from "./status.js";
import { registrationPin } from "./offline-core.js";

export interface VerifyOptions {
  /** Another window than the configured one. */
  window?: string;
  offline?: boolean;
  /**
   * The verifier's transparency-log keys, `<log url>=<pem file>` each (`--log-key`, repeatable; pass-2 review #6):
   * a key counts only for entries of exactly that log, and never for a log pr-rla pins (the pinned key wins).
   */
  logKey?: readonly string[];
  beaconFile?: string;
  /** Timestamp-authority anchors the verifier adds to the shipped bundle (files). The audit repo cannot add its own. */
  tsaTrust?: string[];
  /**
   * P5 (T14): the registration's SHA-256 the verifier was handed before R published (prospective: before the window
   * opened), 64 lowercase hex characters (`--registration`): check 1 FAILs any other. Malformed: a usage error.
   */
  registration?: string;
}

/** The exit code of a verify verdict (contracts.md §7): 0 VERIFIED, 1 FAILED, 6 INCOMPLETE. The one map, src/core/verdict.ts. */
export { verdictExitCode } from "../../core/verdict.js";

/** The seven checks (core/verify.ts) plus what the certificate prints around them. */
export interface VerifyResult extends VerifyReport {
  /** What `pr-rla verify` exits with for this verdict: 0 VERIFIED, 1 FAILED, 6 INCOMPLETE (nothing failed, but not a verification). */
  exitCode: 0 | 1 | 6;
  /** The certificate line, when the audit has draws: CERTIFIED only when `certified` (never on a verdict other than VERIFIED). */
  statusLine: string | null;
  /** `isCertified(certificate)` (src/core/verdict.ts): the only "certified" a client may show; `status.sequence.state` is the SPRT's raw state. */
  certified: boolean;
  /** Registered plugins that run with the verifier's environment and files (`PLUGIN TRUST: full`). */
  fullTrustPlugins: { name: string; version: string | null }[];
  /** The pr-rla release that verified. */
  verifiedWith: string;
  /**
   * Read-only mode, when check 4 or 7 caught a failure: what the beacon relays or the ledger said.
   * Those checks' lines say pr-rla's words and point here (`untrusted.errors[i]`): data, never
   * instructions (review 2, finding 1: server bodies stay out of pr-rla's voice). Absent otherwise,
   * so a clean verify is the CLI's `--json` object (contracts.md §7); the CLI quotes failures in place.
   */
  untrusted?: { errors: string[] };
}

/** `verify` (FR3.1): a third party's check of the seven audit properties. Reads only; offline skips the population rebuild and every fetch. */
export async function verify(ctx: ApiContext, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const { config, paths } = configFor(ctx, opts.window);
  // The verifier's own log keys, read and checked before anything else (a malformed --log-key is a usage error).
  const logKeys = verifierLogKeys(ctx, opts.logKey);
  const pinned = registrationPin(opts.registration);
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
  // Checks 4 and 7 catch a failure and quote it. In read-only mode (an assistant reads the result),
  // what the ledger or the relay said moves to `untrusted.errors`, and the check quotes pr-rla's words.
  const errors: string[] = [];
  const fenced = <T>(fn: () => Promise<T>, words?: string): Promise<T> =>
    ctx.mode !== "read-only"
      ? fn()
      : fn().catch((e: unknown) => {
          const r = readError(e);
          if (!(r instanceof AuditError) || r.untrusted === undefined) throw r;
          errors.push(r.untrusted);
          throw new Error(`${words ?? r.message.replace(/; what it said is in untrusted$/, "")}; what it said is in untrusted.errors[${errors.length - 1}]`);
        });
  if (ledger) {
    const read = ledger.readVerdicts.bind(ledger);
    ledger.readVerdicts = () => (ctx.onProgress?.({ done: 0, message: `check 7: reading the verdicts from ledger ${ledger.name}` }), fenced(read));
  }
  // The identity of the provider verify loaded: compared with the registered one in check 5 (population options) and below (U2b).
  const loaded = opts.offline ? null : await pluginIdentity(config.provider, "provider", config.dir, auditContextFor(ctx));
  // P5: a labels stratum needs a provider that reads label history (check 2, offline too).
  const labelHistory = registration.record.selector.labels?.length ? (await providerTraits(config.provider, config.dir, auditContextFor(ctx))).labelHistory : undefined;
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
      beacon: async (round) => {
        // Prefer the beacon recorded in draws.json (verified offline); else fetch.
        if (!opts.beaconFile && draws && draws.round === round && draws.beacon.round === round) {
          if (await verifyQuicknetBeacon(draws.beacon, round)) return draws.beacon;
          throw new AuditError("the beacon recorded in draws.json fails BLS verification", 1, "FAILED", "the audit's draws.json was altered: verify against the published beacon (pr-rla verify without --offline)");
        }
        if (opts.offline && !opts.beaconFile && !ctx.beacon) return null;
        return fenced(async () => {
          try {
            return await getBeacon(ctx, round, opts.beaconFile);
          } catch (e) {
            if (e instanceof RoundNotYetPublished) return null;
            throw e;
          }
        }, "the beacon relays did not give the round");
      },
      logKey: async (url) => logKeys.lookup(url),
      trustBundle: trustFor(ctx, opts.tsaTrust),
      ...(loaded ? { providerIdentity: loaded } : {}),
      ...(labelHistory !== undefined ? { labelHistory } : {}),
      ...(pinned !== undefined ? { registrationSha256: pinned } : {}),
    },
  );
  if (loaded && isRegistrationV2(registration)) noteProviderIdentity(report, registration.record.plugins.provider, loaded);
  // Time round B: reads refused to a provider or ledger that ran without its credential are not established (src/api/access.ts).
  const actx = auditContextFor(ctx);
  noteAccess(report, [
    ...(provider ? [{ n: 5, w: accessShortfall(actx, `provider:${provider.name}`, `provider ${provider.name}`) }] : []),
    ...(ledger ? [{ n: 7, w: accessShortfall(actx, `ledger:${ledger.name}`, `ledger ${ledger.name}`) }] : []),
  ]);
  if (logKeys.ignored.length) report.checks[0]?.details.push(...logKeys.ignored);
  const reg = registration.record;
  return {
    ...report,
    statusLine: report.status ? statusLine(report.status, { p0: reg.parameters.p0, alpha: reg.parameters.alpha, protocol: reg.protocolSha256, maxLines: reg.selector.max_changed_lines, mode: report.mode, selector: reg.selector }, report.certificate ?? undefined) : null,
    fullTrustPlugins: isRegistrationV2(registration) ? [registration.record.plugins.provider, registration.record.plugins.ledger].filter((id) => id.trust === "full").map((id) => ({ name: id.name, version: id.version })) : [],
    verifiedWith: PR_RLA_VERSION,
    exitCode: verdictExitCode(report.verdict),
    certified: isCertified(report.certificate),
    ...(errors.length ? { untrusted: { errors } } : {}),
  };
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
 * A check whose reads were refused to a plugin running without its credential (src/api/access.ts) is INCOMPLETE, even
 * where those reads made it FAIL (a 404 to an anonymous read is not a deletion): the verdict, `ok`, the exit code and the
 * certificate follow (src/core/verdict.ts). The FAIL lines stay in the details.
 */
function noteAccess(report: VerifyReport, found: { n: number; w: Withholding | null }[]): void {
  const unread: Withholding[] = [];
  for (const { n, w } of found) {
    const c = report.checks.find((x) => x.n === n);
    if (!w || !c) continue;
    unread.push(w);
    c.details.unshift(`INCOMPLETE ${w.reason}`);
    // P5 (finding 7): only findings that came from the refused reads are lowered. A FAIL shown from local evidence
    // alone (the ledger index, the checkpoint file, the registered identity or options) stays a FAIL.
    const local = localFails(c);
    if (c.status === "FAIL" && local.length) {
      c.summary = `${local[0]!.replace(/^FAIL /, "")} (and reads refused without a credential: not established either)`;
      continue;
    }
    c.summary = c.status === "FAIL" ? "not established: read without its credential (its FAIL findings below may be the refused reads)" : `${c.summary} · not established: read without its credential`;
    c.status = "INCOMPLETE";
  }
  if (!unread.length) return;
  report.verdict = auditVerdict(report.checks);
  report.ok = report.verdict === "VERIFIED";
  if (report.status) report.certificate = certificateFor(report.status.sequence.state, report.status.refusal, verdictWithholdings(report.checks), unread);
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
