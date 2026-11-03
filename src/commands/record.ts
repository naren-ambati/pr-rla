import { configFor, CommandError, isoNow, ledgerFor, readDraws, readRegistration, type CommandContext } from "./context.js";

export async function recordCommand(ctx: CommandContext, drawArg: string, verdictArg: string, opts: { reviewer?: string; note?: string; force?: boolean }): Promise<number> {
  const { config, paths } = configFor(ctx);
  const draw = Number(drawArg);
  if (!Number.isInteger(draw) || draw < 1) throw new CommandError(`draw must be a positive integer (got ${drawArg})`);
  if (verdictArg !== "pass" && verdictArg !== "fail") throw new CommandError('verdict must be "pass" or "fail"');
  if (!opts.reviewer) throw new CommandError("--reviewer <id> is required");
  const reg = readRegistration(paths);
  const draws = readDraws(paths);
  const d = draws.draws.find((x) => x.draw === draw);
  if (!d || draw > draws.issued) throw new CommandError(`draw #${draw} has not been issued (issued: ${draws.issued}; "pr-rla sample --through ${draw}" issues more)`);
  const ledger = await ledgerFor(ctx, config, paths);
  const existing = (await ledger.readVerdicts()).find((v) => v.changeId === d.changeId && v.protocolSha256 === reg.record.protocolSha256);
  if (existing && !opts.force)
    throw new CommandError(`${d.changeId} already has a ${existing.verdict} verdict (draw #${existing.draw}); a change drawn twice reuses its first verdict. --force appends anyway (it will show as a relabel; the first verdict still counts)`);
  await ledger.appendVerdict({
    draw,
    changeId: d.changeId,
    verdict: verdictArg,
    protocolSha256: reg.record.protocolSha256,
    reviewer: opts.reviewer,
    recordedAt: isoNow(ctx),
    ...(opts.note ? { note: opts.note } : {}),
  });
  ctx.out(`recorded draw #${draw} ${d.changeId}: ${verdictArg} (per protocol ${reg.record.protocolSha256.slice(0, 8)}…) in ledger ${ledger.name}`);
  if (ledger.name === "git-file") ctx.out("commit the ledger file now: git history is the tamper trail");
  return 0;
}
