import { isRegistrationV2 } from "../../core/records.js";
import { ledgerTraits } from "../../ledger-traits.js";
import { verdictIneligibility, type Verdict } from "../../sdk/ledger.js";
import { requireReadWrite } from "../context.js";
import { AuditError } from "../errors.js";
import { auditContextFor, configFor, isoNow, ledgerFor, readDraws, readRegistration, type ApiContext } from "../session.js";

export interface RecordInput {
  /** The draw number (1-based), as typed. */
  draw: number | string;
  /** "pass" or "fail", as typed. */
  verdict: string;
  reviewer?: string;
  note?: string;
  /** Append even if the change already has a verdict (it shows as a relabel; the first one counts). */
  force?: boolean;
}

export interface RecordResult {
  draw: number;
  changeId: string;
  verdict: Verdict;
  protocolSha256: string;
  ledger: string;
  /** The ledger's tracker records the acting account (issue ledgers): that, not --reviewer, is the reviewer. */
  recordsActor: boolean;
}

/**
 * `record` (write side): appends a pass/fail verdict for an issued draw to the ledger. A human's
 * command: CLI only, refused in a read-only context, and never an MCP tool (FR3.3).
 */
export async function record(ctx: ApiContext, input: RecordInput): Promise<RecordResult> {
  requireReadWrite(auditContextFor(ctx), "record");
  const { config, paths } = configFor(ctx);
  const draw = Number(input.draw);
  if (!Number.isInteger(draw) || draw < 1) throw new AuditError(`draw must be a positive integer (got ${String(input.draw)})`);
  if (input.verdict !== "pass" && input.verdict !== "fail") throw new AuditError('verdict must be "pass" or "fail"');
  const verdict: Verdict = input.verdict;
  // A ledger whose tracker records the acting account (issue ledgers) needs no --reviewer: the label event names who applied it.
  const recordsActor = (await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx).plugins)).provenance === "account";
  if (!input.reviewer && !recordsActor) throw new AuditError("--reviewer <id> is required");
  const reg = readRegistration(paths);
  const draws = readDraws(paths);
  const d = draws.draws.find((x) => x.draw === draw);
  if (!d || draw > draws.issued) throw new AuditError(`draw #${draw} has not been issued (issued: ${draws.issued}; "pr-rla sample --through ${draw}" issues more)`);
  const ledger = await ledgerFor(ctx, config, paths);
  // Only a verdict that counts blocks a new one: a bot's or an unregistered account's label does not.
  const reviewers = isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null;
  const existing = (await ledger.readVerdicts()).find((v) => v.changeId === d.changeId && v.protocolSha256 === reg.record.protocolSha256 && !verdictIneligibility(v, reviewers));
  if (existing && !input.force)
    throw new AuditError(`${d.changeId} already has a ${existing.verdict} verdict (draw #${existing.draw}); a change drawn twice reuses its first verdict. --force appends anyway (it will show as a relabel; the first verdict still counts)`);
  await ledger.appendVerdict({
    draw,
    changeId: d.changeId,
    verdict,
    protocolSha256: reg.record.protocolSha256,
    reviewer: input.reviewer ?? "(the token's account)",
    recordedAt: isoNow(ctx),
    ...(input.note ? { note: input.note } : {}),
  });
  return { draw, changeId: d.changeId, verdict, protocolSha256: reg.record.protocolSha256, ledger: ledger.name, recordsActor };
}
