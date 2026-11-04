import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256Hex } from "../../core/canonical.js";
import { DEFAULT_MAX_PATCH_BYTES, MAX_PATCH_BYTES_LIMIT, buildDrawContext, type DrawContext } from "../../core/draw-context.js";
import { isRegistrationV2, type DrawsFile } from "../../core/records.js";
import { computeStatus } from "../../core/status.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { ledgerTraits, type LedgerTraits } from "../../ledger-traits.js";
import type { VerdictEvent } from "../../sdk/ledger.js";
import { changeDescriptionProblems, type ChangeDescription } from "../../sdk/provider.js";
import { AuditError } from "../errors.js";
import { auditContextFor, configFor, ledgerFor, protocolPath, providerFor, readDraws, readManifest, readRegistration, type ApiContext } from "../session.js";

export type { DrawContext } from "../../core/draw-context.js";

export interface DrawContextOptions {
  /** Another window than the configured one. */
  window?: string;
  /** The draw number (1-based); it must be issued. */
  draw: number;
  /** Bytes of patches to include in all (default 200 KiB, at most 1 MiB). */
  maxPatchBytes?: number;
  /** For tests only: the fence id (otherwise 128 fresh random bits per call). */
  fenceId?: string;
}

/** The issued draws, or NO_AUDIT when the window has none yet. */
export function issuedDraws(paths: WindowPaths, window: string): DrawsFile {
  if (!existsSync(paths.registration)) throw new AuditError(`window ${window} is not registered`, 1, "NO_AUDIT");
  if (!existsSync(paths.manifest) || !existsSync(paths.draws)) throw new AuditError(`window ${window} has no draws yet (it is ${existsSync(paths.manifest) ? "frozen; run \"pr-rla sample\" after R" : "not frozen"})`, 1, "NO_AUDIT");
  return readDraws(paths);
}

/** The draw a person records a verdict on, and how, for this ledger (the assistant never records). */
export function howToRecord(config: PrRlaConfig, paths: WindowPaths, lt: LedgerTraits, draw: number, changeId: string): string {
  if (lt.name === "git-file") {
    const file = relative(config.dir, join(paths.windowDir, typeof config.ledger.options.file === "string" ? config.ledger.options.file : "verdicts.jsonl"));
    return `pr-rla record ${draw} pass|fail --reviewer <you> --note "<one line>", then commit ${file}`;
  }
  if (lt.provenance === "account") {
    let where = "";
    try {
      const index = JSON.parse(readFileSync(join(paths.windowDir, "ledger-index.json"), "utf8")) as { labels?: Record<string, { name?: string }>; issues?: { changeId: string; url: string }[] };
      const issue = index.issues?.find((i) => i.changeId === changeId);
      const pass = index.labels?.pass?.name;
      const fail = index.labels?.fail?.name;
      if (issue && pass && fail) where = `apply ${pass} or ${fail} to ${issue.url} yourself, in the tracker (it records who applied it and when); or `;
    } catch {
      where = "";
    }
    return `${where}run "pr-rla record ${draw} pass|fail" with your own token (ledger ${lt.name})`;
  }
  return `pr-rla record ${draw} pass|fail --reviewer <you> (ledger ${lt.name})`;
}

/**
 * `draw_context` / `pr-rla draw-context <n>` (FR3.4, FR3.9): one issued draw's change as a reviewer
 * needs it: the manifest's fields, the verdict state, the registered protocol's checklist, and the
 * provider's description with linguist-generated files dropped under exclude_generated. Reads only.
 */
export async function drawContext(ctx: ApiContext, opts: DrawContextOptions): Promise<DrawContext> {
  const maxPatchBytes = opts.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
  if (!Number.isInteger(maxPatchBytes) || maxPatchBytes < 0 || maxPatchBytes > MAX_PATCH_BYTES_LIMIT) throw new AuditError(`maxPatchBytes must be a whole number from 0 to ${MAX_PATCH_BYTES_LIMIT} (1 MiB)`);
  const { config, paths } = configFor(ctx, opts.window);
  const window = opts.window ?? config.window.name;
  const draws = issuedDraws(paths, window);
  const n = opts.draw;
  const d = Number.isInteger(n) ? draws.draws.find((x) => x.draw === n) : undefined;
  if (!d || n < 1 || n > draws.issued) throw new AuditError(`draw #${String(n)} is not issued: the issued draws are #1 to #${draws.issued}`, 1, "DRAW_OUT_OF_RANGE", draws.issued < draws.cap ? `"pr-rla sample --through <n>" issues more (a human's command)` : undefined);
  const reg = readRegistration(paths);
  const manifest = readManifest(paths);
  const change = manifest.changes[d.index];
  if (!change || change.id !== d.changeId) throw new AuditError(`draws.json names ${d.changeId} for draw #${n}, but the manifest has ${change?.id ?? "no change"} at index ${d.index}`, 1, "NO_AUDIT");
  const firstDraw = draws.draws.find((x) => x.changeId === change.id)!.draw;

  // The verdict state, from the ledger (a tracker ledger is read: draw_context is an online call).
  const lt = await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx).plugins);
  let verdict: VerdictEvent | null = null;
  let verdictUnread: string | undefined;
  let blocksPrefix = false;
  try {
    const ledger = await ledgerFor(ctx, config, paths);
    const report = computeStatus({
      N: manifest.N,
      minPopulation: reg.record.parameters.minPopulation,
      draws: draws.draws,
      drawsIssued: draws.issued,
      verdicts: await ledger.readVerdicts(),
      protocolSha256: reg.record.protocolSha256,
      params: reg.record.parameters,
      reviewers: isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null,
    });
    verdict = report.firstVerdicts.find((v) => v.changeId === change.id) ?? null;
    blocksPrefix = report.blockingDraw?.draw === n;
  } catch (e) {
    verdictUnread = `ledger ${lt.name}: ${(e as Error).message}`;
  }

  const ppath = protocolPath(config);
  const bytes = existsSync(ppath) ? readFileSync(ppath) : null;

  const provider = await providerFor(ctx, config);
  let description: ChangeDescription | null = null;
  let descriptionNote: string | undefined;
  if (!provider.describeChange) descriptionNote = `provider ${provider.name} has no describeChange; open the URL`;
  else {
    try {
      ctx.onProgress?.({ done: 0, message: `asking ${provider.name} for ${change.id}` });
      description = await provider.describeChange(change);
    } catch (e) {
      if ((e as { code?: unknown }).code === "NO_DESCRIPTION") descriptionNote = `${(e as Error).message}; open the URL`;
      else throw e;
    }
    if (description) {
      const problems = changeDescriptionProblems(description, change.id);
      if (problems.length) throw new AuditError(`provider ${provider.name} described ${change.id} wrongly: ${problems.slice(0, 5).join("; ")}`, 1, "PROVIDER_ERROR");
    }
  }
  return buildDrawContext({
    window,
    draw: n,
    issued: draws.issued,
    change,
    firstDraw,
    verdict,
    ...(verdictUnread ? { verdictUnread } : {}),
    blocksPrefix,
    protocol: { file: config.protocol, text: bytes ? bytes.toString("utf8") : null, sha256: bytes ? sha256Hex(bytes) : null, registeredSha256: reg.record.protocolSha256 },
    description,
    providerName: provider.name,
    ...(descriptionNote ? { descriptionNote } : {}),
    excludeGenerated: reg.record.selector.exclude_generated,
    maxPatchBytes,
    howToRecord: howToRecord(config, paths, lt, firstDraw, change.id),
    fenceId: opts.fenceId ?? randomBytes(16).toString("hex"),
  });
}
