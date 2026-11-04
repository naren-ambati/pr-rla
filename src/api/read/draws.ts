import { isRegistrationV2 } from "../../core/records.js";
import { computeStatus, provenanceOf } from "../../core/status.js";
import { ledgerTraits } from "../../ledger-traits.js";
import type { ProvenanceLevel } from "../../sdk/ledger.js";
import { AuditError } from "../errors.js";
import { auditContextFor, configFor, ledgerFor, readManifest, readRegistration, type ApiContext } from "../session.js";
import { issuedDraws } from "./draw-context.js";
import { countedLedgerVerdicts } from "./status.js";

/** At most this many draws in one view (contracts.md §4). */
export const MAX_DRAWS_LIMIT = 200;

export interface DrawsOptions {
  window?: string;
  /** The first draw to list (default 1). */
  from?: number;
  /** How many (default 50, at most 200). */
  limit?: number;
}

export interface DrawView {
  draw: number;
  changeId: string;
  url: string;
  /** False for a change drawn before: it reuses that draw's verdict. */
  firstOccurrence: boolean;
  firstDraw: number;
  /** null when the ledger was not read (a tracker ledger: `draws` makes no network call). */
  state: "unlabelled" | "pass" | "fail" | null;
  reviewer?: string;
  recordedAt?: string;
  provenance?: ProvenanceLevel;
}

/** The issued draws with their verdict state (contracts.md §4 `draws`): a read-only view. Issuing draws stays a human's CLI command. */
export interface DrawsView {
  window: string;
  N: number;
  issued: number;
  cap: number;
  seedRound: number;
  from: number;
  limit: number;
  draws: DrawView[];
  /** The first unlabelled draw, which holds the prefix back: review it next. */
  blockingDraw: { draw: number; changeId: string; url: string } | null;
  verdictsRead: boolean;
  verdictsSkipped?: string;
}

/** `draws`: the issued draws with state, and the blocking draw. No network: a tracker ledger's verdicts are not read. */
export async function draws(ctx: ApiContext, opts: DrawsOptions = {}): Promise<DrawsView> {
  const { config, paths } = configFor(ctx, opts.window);
  const window = opts.window ?? config.window.name;
  const file = issuedDraws(paths, window);
  const from = opts.from ?? 1;
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DRAWS_LIMIT) throw new AuditError(`limit must be a whole number from 1 to ${MAX_DRAWS_LIMIT}`);
  if (!Number.isInteger(from) || from < 1 || from > Math.max(1, file.issued)) throw new AuditError(`from must be an issued draw: #1 to #${file.issued}`, 1, "DRAW_OUT_OF_RANGE");
  const reg = readRegistration(paths);
  const lt = await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx));
  const firstDrawOf = new Map<string, number>();
  for (const d of file.draws) if (!firstDrawOf.has(d.changeId)) firstDrawOf.set(d.changeId, d.draw);
  const issued = file.draws.filter((d) => d.draw <= file.issued);
  const page = issued.filter((d) => d.draw >= from).slice(0, limit);
  const base = { window, N: file.N, issued: file.issued, cap: file.cap, seedRound: file.round, from, limit };
  const view = (d: (typeof issued)[number]) => ({ draw: d.draw, changeId: d.changeId, url: d.url, firstOccurrence: d.firstOccurrence, firstDraw: firstDrawOf.get(d.changeId)! });
  if (lt.hosts.length > 0) {
    return { ...base, draws: page.map((d) => ({ ...view(d), state: null })), blockingDraw: null, verdictsRead: false, verdictsSkipped: `ledger ${lt.name} lives in ${lt.hosts.join(", ")}; status with offline: false reads its verdicts` };
  }
  const manifest = readManifest(paths);
  const ledger = await ledgerFor(ctx, config, paths, { command: "draws" });
  const counted = await countedLedgerVerdicts(ctx, config, reg, ledger, { manifestSha256: manifest.sha256, beacon: file.beacon });
  const report = computeStatus({
    N: manifest.N,
    minPopulation: reg.record.parameters.minPopulation,
    draws: file.draws,
    drawsIssued: file.issued,
    verdicts: counted.verdicts,
    protocolSha256: reg.record.protocolSha256,
    params: reg.record.parameters,
    reviewers: isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null,
    ineligible: counted.ineligible,
  });
  const first = new Map(report.firstVerdicts.map((v) => [v.changeId, v]));
  return {
    ...base,
    draws: page.map((d) => {
      const v = first.get(d.changeId);
      return v ? { ...view(d), state: v.verdict, reviewer: v.reviewer, recordedAt: v.recordedAt, provenance: provenanceOf(v) } : { ...view(d), state: "unlabelled" as const };
    }),
    blockingDraw: report.blockingDraw ? { draw: report.blockingDraw.draw, changeId: report.blockingDraw.changeId, url: report.blockingDraw.url } : null,
    verdictsRead: true,
  };
}
