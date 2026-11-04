import { verify, type VerifyOptions as ApiVerifyOptions, type VerifyResult } from "../api/read/verify.js";
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

export async function verifyCommand(ctx: CommandContext, opts: VerifyOptions): Promise<number> {
  const report = await runVerify(ctx, opts);
  if (opts.json) {
    ctx.out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  printVerify(ctx, report);
  return report.ok ? 0 : 1;
}

/** The text form of a verify result: the seven checks, then the certificate. */
export function printVerify(ctx: Pick<CommandContext, "out">, report: VerifyResult): void {
  const mark = (s: string) => (s === "PASS" ? "✓" : s === "WARN" ? "(warn)" : s === "SKIP" ? "(skipped)" : "✗");
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
  ctx.out(report.ok ? "VERIFIED" : `FAILED: ${report.checks.filter((c) => c.status === "FAIL").map((c) => `check ${c.n} (${c.name})`).join(", ")}`);
}
