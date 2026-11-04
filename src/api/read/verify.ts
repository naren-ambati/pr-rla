import { existsSync } from "node:fs";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../../beacon/drand.js";
import { isRegistrationV2 } from "../../core/records.js";
import { auditVerdict, certificateFor, isCertified, verdictExitCode, verdictWithholdings, type Withholding } from "../../core/verdict.js";
import { accessShortfall } from "../access.js";
import { verifyAudit, type VerifyCheck, type VerifyReport } from "../../core/verify.js";
import { ledgerTraits, registeredCeiling, testOnlyLedgerOptions } from "../../ledger-traits.js";
import { readIndexDocument } from "../../ledgers/issue-index.js";
import { identityDiffs } from "../../core/plugin-binding.js";
import { bindingIdentity, builtinLedgerName } from "../../registry.js";
import type { ScmProvider } from "../../sdk/provider.js";
import { PR_RLA_VERSION } from "../../version.js";
import { AuditError } from "../errors.js";
import { said } from "../../core/said.js";
import { fenceStatus, renderResult } from "./untrusted.js";
import { readCheckpoints } from "./checkpoints.js";
import { readPublications } from "./publications.js";
import { callerOf, readOnlyContext, auditContextFor, configFor, getBeacon, ledgerFor, protocolSha256, providerFor, readCommitment, readDraws, readManifest, readRegistration, trustFor, type ApiContext } from "../session.js";
import { verifierLogKeys } from "../translog.js";
import { statusLine } from "./status.js";

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
}

/** The exit code of a verify verdict (contracts.md §7): 0 VERIFIED, 1 FAILED, 6 INCOMPLETE. The one map, src/core/verdict.ts. */
export { verdictExitCode } from "../../core/verdict.js";

/** A check as verify returns it: its lines rendered by the mode (S1, src/core/said.ts). */
export type VerifyCheckResult = Omit<VerifyCheck, "summary" | "details" | "verbose"> & { summary: string; details: string[]; verbose?: string[] };

/** The seven checks (core/verify.ts) plus what the certificate prints around them. */
export interface VerifyResult extends Omit<VerifyReport, "checks"> {
  checks: VerifyCheckResult[];
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
  // P1 (master-plugins-review #7): verify only reads, so it never runs read-write: the CLI's context becomes a
  // read-only one for the same person, whose broker refuses every request that is not a read (a ledger cannot write).
  ctx = readOnlyContext(ctx);
  const { config, paths } = configFor(ctx, opts.window);
  // The verifier's own log keys, read and checked before anything else (a malformed --log-key is a usage error).
  const logKeys = verifierLogKeys(ctx, opts.logKey);
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
  // P1: what the configured plugins are, read from their definitions or locks (nothing runs yet). One that is not
  // the registered plugin is never opened: checks 5 and 7 FAIL naming the difference, and nothing reaches its hosts.
  const regV2 = isRegistrationV2(registration) ? registration : null;
  const loaded = opts.offline ? null : await bindingIdentity(config.provider, "provider", config.dir, auditContextFor(ctx));
  const providerBound = !loaded || !regV2 || identityDiffs(regV2.record.plugins.provider, loaded).length === 0;
  const ledgerIdentity = await bindingIdentity(config.ledger, "ledger", config.dir, auditContextFor(ctx));
  const ledgerBound = !regV2 || identityDiffs(regV2.record.plugins.ledger, ledgerIdentity).length === 0;
  // A ledger that lives in a tracker (it declares hosts) is not read offline: check 7 then SKIPs and says why.
  // An external ledger's hosts are its locked ones: it is not imported here.
  const lt = ledgerBound ? await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx)) : null;
  const skipLedger = !ledgerBound || (!!opts.offline && lt!.hosts.length > 0);
  const { checkpoints, problems, unchained } = readCheckpoints(paths.windowDir);
  const provider = opts.offline || !providerBound ? null : withProgress(ctx, await providerFor(ctx, config, { onMismatch: "report" }));
  const ledger = skipLedger ? null : await ledgerFor(ctx, config, paths, { onMismatch: "report" });
  // What the checks quote from outside pr-rla is carried as foreign text in their lines (src/core/said.ts) and
  // rendered once, below: when an assistant reads the result it moves to `untrusted.errors`; a person's is quoted in place.
  if (ledger) {
    const read = ledger.readVerdicts.bind(ledger);
    ledger.readVerdicts = () => (ctx.onProgress?.({ done: 0, message: `check 7: reading the verdicts from ledger ${ledger.name}` }), read());
  }
  const ledgerSkipped = !ledgerBound ? `the ledger in .pr-rla.yml is not the registered one, so it was not read` : skipLedger ? `offline: ledger ${lt!.name} lives in ${lt!.hosts.join(", ")}; run verify without --offline to check the verdicts` : null;
  const report = await verifyAudit(
    { registration, manifest, commitment, draws, currentProtocolSha256: currentProtocol, checkpoints, checkpointProblems: problems, checkpointsUnchained: unchained, ledgerIndex: readIndexDocument(paths.windowDir), ledgerPublications: readPublications(paths.windowDir) },
    {
      provider,
      ledger,
      ...(ledgerSkipped ? { ledgerSkipped } : {}),
      ...(lt ? { provenanceCeiling: registeredCeiling(regV2 ? regV2.record.plugins.ledger : null, lt) } : {}),
      ledgerIdentity,
      ledgerTestOnlyOptions: testOnlyLedgerOptions(config.ledger),
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
      logKey: async (url) => logKeys.lookup(url),
      trustBundle: trustFor(ctx, opts.tsaTrust),
      ...(loaded ? { providerIdentity: loaded } : {}),
    },
  );
  // Time round B: reads refused to a provider or ledger that ran without its credential are not established (src/api/access.ts).
  const actx = auditContextFor(ctx);
  noteAccess(report, [
    ...(provider ? [{ n: 5, w: accessShortfall(actx, `provider:${provider.name}`, `provider ${provider.name}`) }] : []),
    ...(ledger ? [{ n: 7, w: accessShortfall(actx, `ledger:${ledger.name}`, `ledger ${ledger.name}`) }] : []),
  ]);
  if (logKeys.ignored.length) report.checks[0]?.details.push(...logKeys.ignored);
  const reg = registration.record;
  // P1 made every read run read-only; what S1 fences is what an assistant reads, so the reader decides, not the mode.
  const assistant = callerOf(ctx) !== "person";
  const result = {
    ...report,
    // The verdicts' reviewers, notes and other ledger-written fields are fenced when an assistant reads (S1); the CLI shows them as they are.
    status: report.status && assistant ? fenceStatus(report.status) : report.status,
    statusLine: report.status ? statusLine(report.status, { p0: reg.parameters.p0, alpha: reg.parameters.alpha, protocol: reg.protocolSha256, maxLines: reg.selector.max_changed_lines, mode: report.mode, selector: reg.selector }, report.certificate ?? undefined) : null,
    fullTrustPlugins: isRegistrationV2(registration) ? [registration.record.plugins.provider, registration.record.plugins.ledger].filter((id) => id.trust === "full").map((id) => ({ name: id.name, version: id.version })) : [],
    verifiedWith: PR_RLA_VERSION,
    exitCode: verdictExitCode(report.verdict),
    certified: isCertified(report.certificate),
  };
  // One rendering for the whole result, by the mode: read-only says pr-rla's words and points into untrusted.errors.
  return renderResult<VerifyResult>(assistant ? "read-only" : "read-write", result);
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
    // The summary can carry what a provider or ledger said (S1): extended with the said tag, so it keeps its pieces.
    c.summary = c.status === "FAIL" ? "not established: read without its credential (its FAIL findings below may be the refused reads)" : said`${c.summary} · not established: read without its credential`;
    c.status = "INCOMPLETE";
  }
  if (!unread.length) return;
  report.verdict = auditVerdict(report.checks);
  report.ok = report.verdict === "VERIFIED";
  if (report.status) report.certificate = certificateFor(report.status.sequence.state, report.status.refusal, verdictWithholdings(report.checks), unread);
}
