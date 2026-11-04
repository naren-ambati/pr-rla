import { isRegistrationV2 } from "../../core/records.js";
import { ledgerTraits } from "../../ledger-traits.js";
import { verdictIneligibility, type Verdict } from "../../sdk/ledger.js";
import { registeredSigners, signVerdictHint } from "../../core/presence/index.js";
import { builtinLedgerName } from "../../registry.js";
import { verdictSigner, type VerdictSigner } from "../../io/ssh-sign.js";
import { AuditError } from "../errors.js";
import { auditContextFor, configFor, isoNow, ledgerFor, readDraws, readRegistration, requireWritable, type ApiContext } from "../session.js";

export interface RecordInput {
  /** The draw number (1-based), as typed. */
  draw: number | string;
  /** "pass" or "fail", as typed. */
  verdict: string;
  reviewer?: string;
  note?: string;
  /** Append even if the change already has a verdict (it shows as a relabel; the first one counts). */
  force?: boolean;
  /** `--sign <key>` (U9): sign this one verdict with ssh-keygen; the reviewer is the key's registered principal. */
  sign?: string;
}

export interface RecordResult {
  draw: number;
  changeId: string;
  verdict: Verdict;
  protocolSha256: string;
  ledger: string;
  /** The ledger's tracker records the acting account (issue ledgers): that, not --reviewer, is the reviewer. */
  recordsActor: boolean;
  /** What signing this verdict gave (U9), as the CLI prints it; null when it was not signed. */
  signedLine: string | null;
  /** For an unsigned git-file verdict under registered signers: how to sign the next one; else null. */
  signHint: string | null;
}

/**
 * `record` (write side): appends a pass/fail verdict for an issued draw to the ledger. A human's
 * command: CLI only, refused in a read-only context, and never an MCP tool (FR3.3).
 */
export async function record(ctx: ApiContext, input: RecordInput): Promise<RecordResult> {
  requireWritable(ctx, "record");
  const { config, paths } = configFor(ctx);
  const draw = Number(input.draw);
  if (!Number.isInteger(draw) || draw < 1) throw new AuditError(`draw must be a positive integer (got ${String(input.draw)})`);
  if (input.verdict !== "pass" && input.verdict !== "fail") throw new AuditError('verdict must be "pass" or "fail"');
  const verdict: Verdict = input.verdict;
  // A ledger whose tracker records the acting account (issue ledgers) needs no --reviewer: the label event names who applied it.
  const recordsActor = (await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx))).provenance === "account";
  if (!input.reviewer && !recordsActor && !input.sign) throw new AuditError("--reviewer <id> is required");
  const reg = readRegistration(paths);
  // U9: --sign <key> signs this one verdict (ssh-keygen -Y sign); the reviewer is the key's registered principal.
  const signers = registeredSigners(reg);
  let signer: VerdictSigner | null = null;
  try {
    if (input.sign && !(builtinLedgerName(config.ledger.use) === "git-file" && signers.length)) throw new Error("--sign needs the built-in git-file ledger and a registration with verdicts.allowed_signers");
    signer = input.sign ? verdictSigner({ keyPath: input.sign, signers, reviewer: input.reviewer, env: ctx.env, log: ctx.err, sign: ctx.signVerdict }) : null;
  } catch (e) {
    throw new AuditError((e as Error).message);
  }
  const draws = readDraws(paths);
  const d = draws.draws.find((x) => x.draw === draw);
  if (!d || draw > draws.issued) throw new AuditError(`draw #${draw} has not been issued (issued: ${draws.issued}; "pr-rla sample --through ${draw}" issues more)`);
  const ledger = await ledgerFor(ctx, config, paths);
  // Only a verdict that counts blocks a new one: a bot's or an unregistered account's label does not.
  const reviewers = isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null;
  const existing = (await ledger.readVerdicts()).find((v) => v.changeId === d.changeId && v.protocolSha256 === reg.record.protocolSha256 && !verdictIneligibility(v, reviewers));
  if (existing && !input.force)
    throw new AuditError(`${d.changeId} already has a ${existing.verdict} verdict (draw #${existing.draw}); a change drawn twice reuses its first verdict. --force appends anyway (it will show as a relabel; the first verdict still counts)`);
  const event = { draw, changeId: d.changeId, verdict, protocolSha256: reg.record.protocolSha256, reviewer: signer?.principal ?? input.reviewer ?? "(the token's account)", recordedAt: isoNow(ctx) } as const;
  const signed = signer
    ? await signer.sign({ ...event, registrationSha256: reg.sha256 }).catch((e: Error) => {
        throw new AuditError(`draw #${draw} was not recorded: ${e.message}`);
      })
    : null;
  await ledger.appendVerdict({ ...event, ...(input.note ? { note: input.note } : {}), ...(signed?.fields ?? {}) });
  const signHint = ledger.name === "git-file" && !signed ? signVerdictHint(signers) : null;
  return { draw, changeId: d.changeId, verdict, protocolSha256: reg.record.protocolSha256, ledger: ledger.name, recordsActor, signedLine: signed?.line ?? null, signHint };
}
