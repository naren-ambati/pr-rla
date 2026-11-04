import { pct } from "../api/session.js";
import { register, REREGISTER_COMMAND, type RegisterOptions as ApiRegisterOptions, type RegisterResult, type RegistrationPlan } from "../api/write/register.js";
import { unixToIso } from "../core/seed.js";
import { isoMs } from "../timestamp/verify.js";
import type { CommandContext } from "./context.js";
import { reportTimestamps } from "./timestamps.js";
import { confirmRekorV2 } from "./translog.js";

// The register logic moved to the audit API in U5 (src/api/write/register.ts).
export { preflightLedger, REREGISTER_COMMAND } from "../api/write/register.js";

export interface RegisterOptions {
  dryRun?: boolean;
  submit?: boolean;
  rekorUrl?: string;
  /** v1 (default) or v2. v2 is unverified against the production log and needs --yes. */
  rekorApi?: string;
  yes?: boolean;
  key?: string;
  force?: boolean;
  /** Extra timestamp-authority anchors (files), for authorities outside the shipped bundle. */
  tsaTrust?: string[];
}

const RETRO = " (registered after the window opened: a demonstration, not evidence)";

/** The registration's summary lines, printed before any authority is asked. */
export function printRegistrationPlan(ctx: Pick<CommandContext, "out">, p: RegistrationPlan): void {
  const record = p.signed.record;
  const params = record.parameters;
  ctx.out(`${p.dryRun ? "[dry run] " : ""}registration ${p.signed.sha256.slice(0, 12)}… · ${record.repos.kind === "repo" ? record.repos.repo : JSON.stringify(record.repos)} · window ${record.window.name} (${record.window.start}..${record.window.end})`);
  ctx.out(`  claim D: detected-defect rate <= ${pct(params.p0)} (p1 ${pct(params.p1)}, risk ${pct(params.alpha)}) · certify after ${p.stoppingTable.join(" / ")} draws with 0/1/2 fails · cap ${p.cap}`);
  ctx.out(`  selector ${JSON.stringify(record.selector)}`);
  if (p.landedViaWarning) ctx.out(`  warning: ${p.landedViaWarning}`);
  ctx.out(`  protocol ${record.protocolSha256.slice(0, 12)}… (${p.protocolFile})`);
  ctx.out(`  provider ${record.plugins.provider.name} (${record.plugins.provider.source}${record.plugins.provider.version ? ` ${record.plugins.provider.version}` : ""}) · ledger ${record.plugins.ledger.name} · verdict provenance ${record.verdicts.minProvenance}${record.verdicts.reviewers ? ` · reviewers ${record.verdicts.reviewers.join(", ")}` : ""}`);
  for (const id of [record.plugins.provider, record.plugins.ledger]) {
    if (id.integrity) ctx.out(`  plugin ${id.name}: trust ${id.trust} · treeSha256 ${id.integrity.slice(0, 12)}… (pr-rla.lock.json)`);
    if (id.trust === "full") ctx.out(`  PLUGIN TRUST: full (${id.name}@${id.version ?? "unversioned"} runs with your environment and files)`);
  }
  ctx.out(`  seed round R = ${p.seedRound} (drand quicknet), publishes ${p.seedRoundPublishesAt}: 24 h after the ${p.seedRoundBase === "registration" ? "registration" : "window close"}`);
  if (p.dryRun) {
    ctx.out(`  ${p.claimed}${p.claimed === "RETROSPECTIVE" ? RETRO : ""}`);
    ctx.out(`  timestamps: not requested (dry run) · authorities ${record.timestamping.authorities.join(", ") || "none"} · k = ${record.timestamping.minTokens}`);
  }
}

export async function registerCommand(ctx: CommandContext, opts: RegisterOptions): Promise<number> {
  const { yes, ...rest } = opts;
  const r = await register(ctx, rest satisfies ApiRegisterOptions, { onPlanned: (p) => printRegistrationPlan(ctx, p), confirmRekorV2: () => confirmRekorV2(ctx, yes) });
  return r.dryRun ? 0 : printRegistered(ctx, r);
}

function printRegistered(ctx: CommandContext, r: RegisterResult): number {
  if (r.submitError) {
    ctx.out(`wrote ${r.path} with its timestamps; the transparency-log submission failed: ${r.submitError}`);
    return 1;
  }
  const summary = r.evidence!;
  ctx.out(`  ${r.mode}${r.mode === "RETROSPECTIVE" ? RETRO : ""}${summary.proven ? ` · registration existed by ${isoMs(summary.ukMs!)} (U_k)` : summary.configured.length ? " (unproven: too few timestamps)" : ""}`);
  const code = reportTimestamps(ctx, summary, r.outcomes, REREGISTER_COMMAND);
  if (r.log && !("apiVersion" in r.log)) ctx.out(`  logged at ${r.log.logUrl} · index ${r.log.logIndex} · integratedTime ${unixToIso(r.log.integratedTime)}`);
  else if (r.log) ctx.out(`  in Rekor v2 log ${r.log.logUrl} · index ${r.log.logIndex} (v2 entries carry no time; unverified against the production log)`);
  ctx.out(`wrote ${r.path}`);
  return code;
}
