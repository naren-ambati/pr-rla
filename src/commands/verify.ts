import { verify, type VerifyOptions as ApiVerifyOptions, type VerifyResult } from "../api/read/verify.js";
import { EXIT } from "../cli/exit-codes.js";
import { notTamperProof, timestampsLine } from "../timestamp/verify.js";
import type { CommandContext } from "./context.js";

export interface VerifyOptions {
  offline?: boolean;
  logKey?: string;
  beaconFile?: string;
  json?: boolean;
  /** Timestamp-authority anchors the verifier adds to the shipped bundle (files). The audit repo cannot add its own. */
  tsaTrust?: string[];
}

/** The verify report (src/api/read/verify.ts), for callers that format it themselves. */
export async function runVerify(ctx: CommandContext, opts: VerifyOptions): Promise<VerifyResult> {
  const { json: _json, ...rest } = opts;
  return verify(ctx, rest satisfies ApiVerifyOptions);
}

/** The exit code of a verify verdict (contracts.md §7): 0 VERIFIED, 1 FAILED, 6 INCOMPLETE. */
export function verifyExitCode(report: Pick<VerifyResult, "verdict">): number {
  return report.verdict === "VERIFIED" ? EXIT.OK : report.verdict === "INCOMPLETE" ? EXIT.INCOMPLETE : EXIT.FAIL;
}

export async function verifyCommand(ctx: CommandContext, opts: VerifyOptions): Promise<number> {
  const report = await runVerify(ctx, opts);
  if (opts.json) {
    ctx.out(JSON.stringify(report, null, 2));
    return verifyExitCode(report);
  }
  printVerify(ctx, report);
  return verifyExitCode(report);
}

/** The text form of a verify result: the seven checks, then the certificate. */
export function printVerify(ctx: Pick<CommandContext, "out">, report: VerifyResult): void {
  const mark = (s: string) => (s === "PASS" ? "✓" : s === "WARN" ? "(warn)" : s === "SKIP" ? "(skipped)" : s === "INCOMPLETE" ? "(incomplete)" : "✗");
  for (const c of report.checks) {
    ctx.out(`${String(c.n)}. ${c.status.padEnd(4)} ${c.name}: ${c.summary}`);
    for (const d of c.details) ctx.out(`        ${d}`);
  }
  ctx.out(report.checks.map((c) => (c.n === 1 ? c.summary : `${c.summary} ${mark(c.status)}`)).join(" · "));
  for (const p of report.fullTrustPlugins) ctx.out(`PLUGIN TRUST: full (${p.name}@${p.version ?? "unversioned"} runs with your environment and files)`);
  if (report.versions.registered) ctx.out(`registered with pr-rla ${report.versions.registered}${report.versions.frozen ? ` · frozen with pr-rla ${report.versions.frozen}` : ""} · verified with pr-rla ${report.verifiedWith}`);
  const ts = report.timestamps;
  if (ts.registration) {
    for (const [what, s] of [["registration", ts.registration], ["manifest commitment", ts.commitment]] as const) if (s) ctx.out(`${what} ${timestampsLine(s)}`);
    if (!report.timestampTamperProof) {
      const short = !ts.registration.proven ? ts.registration : ts.commitment;
      ctx.out(`${short ? notTamperProof(short) : "TIMESTAMP NOT TAMPER-PROOF"}: registration and/or manifest times are self-asserted (fewer than k timestamp authorities agree)`);
    }
  } else if (!report.timestampTamperProof) ctx.out("TIMESTAMP NOT TAMPER-PROOF: registration and/or manifest times are self-asserted (no transparency-log entry was verified)");
  if (report.statusLine) ctx.out(report.statusLine);
  const list = (st: string) => report.checks.filter((c) => c.status === st).map((c) => `check ${c.n} (${c.name})`).join(", ");
  ctx.out(report.verdict === "VERIFIED" ? "VERIFIED" : report.verdict === "FAILED" ? `FAILED: ${list("FAIL")}` : `INCOMPLETE: ${list("INCOMPLETE")} could not be completed; nothing failed, but this is not a verification (exit 6)`);
}
