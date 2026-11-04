import { isRegistrationV2 } from "../core/records.js";
import { loadLedgerDefinition } from "../registry.js";
import { verdictIneligibility } from "../sdk/ledger.js";
import { configFor, CommandError, isoNow, ledgerFor, readDraws, readRegistration, type CommandContext } from "./context.js";

export async function recordCommand(ctx: CommandContext, drawArg: string, verdictArg: string, opts: { reviewer?: string; note?: string; force?: boolean }): Promise<number> {
  const { config, paths } = configFor(ctx);
  const draw = Number(drawArg);
  if (!Number.isInteger(draw) || draw < 1) throw new CommandError(`draw must be a positive integer (got ${drawArg})`);
  if (verdictArg !== "pass" && verdictArg !== "fail") throw new CommandError('verdict must be "pass" or "fail"');
  // A ledger whose tracker records the acting account (issue ledgers) needs no --reviewer: the label event names who applied it.
  const recordsActor = (await loadLedgerDefinition(config.ledger.use, config.dir)).provenance === "account";
  if (!opts.reviewer && !recordsActor) throw new CommandError("--reviewer <id> is required");
  const reg = readRegistration(paths);
  const draws = readDraws(paths);
  const d = draws.draws.find((x) => x.draw === draw);
  if (!d || draw > draws.issued) throw new CommandError(`draw #${draw} has not been issued (issued: ${draws.issued}; "pr-rla sample --through ${draw}" issues more)`);
  const ledger = await ledgerFor(ctx, config, paths);
  // Only a verdict that counts blocks a new one: a bot's or an unregistered account's label does not.
  const reviewers = isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null;
  const existing = (await ledger.readVerdicts()).find((v) => v.changeId === d.changeId && v.protocolSha256 === reg.record.protocolSha256 && !verdictIneligibility(v, reviewers));
  if (existing && !opts.force)
    throw new CommandError(`${d.changeId} already has a ${existing.verdict} verdict (draw #${existing.draw}); a change drawn twice reuses its first verdict. --force appends anyway (it will show as a relabel; the first verdict still counts)`);
  await ledger.appendVerdict({
    draw,
    changeId: d.changeId,
    verdict: verdictArg,
    protocolSha256: reg.record.protocolSha256,
    reviewer: opts.reviewer ?? "(the token's account)",
    recordedAt: isoNow(ctx),
    ...(opts.note ? { note: opts.note } : {}),
  });
  ctx.out(`recorded draw #${draw} ${d.changeId}: ${verdictArg} (per protocol ${reg.record.protocolSha256.slice(0, 8)}…) in ledger ${ledger.name}`);
  if (ledger.name === "git-file") ctx.out("commit the ledger file now: git history is the tamper trail");
  else if (recordsActor) ctx.out(`the tracker records the account that applied the label, and when; that, not --reviewer, is the verdict's reviewer`);
  return 0;
}
