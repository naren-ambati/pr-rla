import { existsSync } from "node:fs";
import { RoundNotYetPublished, verifyQuicknetBeacon } from "../../beacon/drand.js";
import { isRegistrationV2 } from "../../core/records.js";
import { verifyAudit, type VerifyReport } from "../../core/verify.js";
import { ledgerTraits, registeredCeiling } from "../../ledger-traits.js";
import { readIndexDocument } from "../../ledgers/issue-index.js";
import { identityDiffs } from "../../core/plugin-binding.js";
import { bindingIdentity } from "../../registry.js";
import type { ScmProvider } from "../../sdk/provider.js";
import { PR_RLA_VERSION } from "../../version.js";
import { AuditError } from "../errors.js";
import { readCheckpoints } from "./checkpoints.js";
import { readError } from "./errors.js";
import { callerOf, readOnlyContext, auditContextFor, configFor, getBeacon, ledgerFor, protocolSha256, providerFor, readCommitment, readDraws, readManifest, readRegistration, trustFor, type ApiContext } from "../session.js";
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

/** The seven checks (core/verify.ts) plus what the certificate prints around them. */
export interface VerifyResult extends VerifyReport {
  /** What `pr-rla verify` exits with for this verdict: 0 VERIFIED, 1 FAILED, 6 INCOMPLETE (nothing failed, but not a verification). */
  exitCode: 0 | 1 | 6;
  /** The certificate line, when the audit has draws. */
  statusLine: string | null;
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
  // P1 (master-plugins-review #7): verify only reads, so it never runs read-write: the CLI's context becomes a
  // read-only one for the same person, whose broker refuses every request that is not a read (a ledger cannot write).
  ctx = readOnlyContext(ctx);
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
  // Checks 4 and 7 catch a failure and quote it. When an assistant reads the result (pr-rla/api/read),
  // what the ledger or the relay said moves to `untrusted.errors`, and the check quotes pr-rla's words.
  const errors: string[] = [];
  const fenced = <T>(fn: () => Promise<T>, words?: string): Promise<T> =>
    callerOf(ctx) === "person"
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
  const ledgerSkipped = !ledgerBound ? `the ledger in .pr-rla.yml is not the registered one, so it was not read` : skipLedger ? `offline: ledger ${lt!.name} lives in ${lt!.hosts.join(", ")}; run verify without --offline to check the verdicts` : null;
  const report = await verifyAudit(
    { registration, manifest, commitment, draws, currentProtocolSha256: currentProtocol, checkpoints, checkpointProblems: problems, checkpointsUnchained: unchained, ledgerIndex: readIndexDocument(paths.windowDir) },
    {
      provider,
      ledger,
      ...(ledgerSkipped ? { ledgerSkipped } : {}),
      ...(lt ? { provenanceCeiling: registeredCeiling(regV2 ? regV2.record.plugins.ledger : null, lt) } : {}),
      ledgerIdentity,
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
      logKey: (url) => logPublicKey(ctx, config, url, opts.logKey, !!opts.offline),
      trustBundle: trustFor(ctx, opts.tsaTrust),
      ...(loaded ? { providerIdentity: loaded } : {}),
    },
  );
  const reg = registration.record;
  return {
    ...report,
    statusLine: report.status ? statusLine(report.status, { p0: reg.parameters.p0, alpha: reg.parameters.alpha, protocol: reg.protocolSha256, maxLines: reg.selector.max_changed_lines, mode: report.mode, selector: reg.selector }) : null,
    fullTrustPlugins: isRegistrationV2(registration) ? [registration.record.plugins.provider, registration.record.plugins.ledger].filter((id) => id.trust === "full").map((id) => ({ name: id.name, version: id.version })) : [],
    verifiedWith: PR_RLA_VERSION,
    exitCode: verdictExitCode(report.verdict),
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
