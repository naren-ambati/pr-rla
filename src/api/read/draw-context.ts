import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256Hex } from "../../core/canonical.js";
import { DEFAULT_MAX_PATCH_BYTES, MAX_PATCH_BYTES_LIMIT, buildDrawContext, type DrawContext, type RecordTarget } from "../../core/draw-context.js";
import { isRegistrationV2, type DrawsFile } from "../../core/records.js";
import { computeStatus } from "../../core/status.js";
import type { PrRlaConfig, WindowPaths } from "../../config.js";
import { readTextConfined } from "../../io/confine.js";
import { gitFileLedgerFile } from "../../ledgers/git-file.js";
import { ledgerTraits, type LedgerTraits } from "../../ledger-traits.js";
import { NoRecordedDescription } from "../../providers/json-file.js";
import type { VerdictEvent } from "../../sdk/ledger.js";
import { changeDescriptionProblems, type ChangeDescription } from "../../sdk/provider.js";
import { AuditError } from "../errors.js";
import { auditContextFor, configFor, ledgerFor, providerFor, readDraws, readManifest, readProtocol, readRegistration, type ApiContext } from "../session.js";
import { countedLedgerVerdicts } from "./status.js";

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

/**
 * How a person records a verdict on the draw, for this ledger, in pr-rla's words (the assistant
 * never records). For a tracker ledger, the issue and the verdict labels come from the ledger's
 * index, which holds the tracker's text: they are returned apart, as `target`, for the fence.
 */
export function howToRecord(config: PrRlaConfig, paths: WindowPaths, lt: LedgerTraits, draw: number, changeId: string): { text: string; target: RecordTarget | null } {
  if (lt.name === "git-file") {
    const file = relative(config.dir, gitFileLedgerFile(paths.windowDir, config.ledger.options as { file?: string }));
    return { text: `pr-rla record ${draw} pass|fail --reviewer <you> --note "<one line>", then commit ${file}`, target: null };
  }
  if (lt.provenance === "account") {
    let target: RecordTarget | null = null;
    const indexFile = join(paths.windowDir, "ledger-index.json");
    try {
      if (existsSync(indexFile)) {
        const index = JSON.parse(readTextConfined(indexFile, "the ledger index")) as { labels?: Record<string, { name?: unknown }>; issues?: { changeId: string; url: unknown }[] };
        const issue = index.issues?.find((i) => i.changeId === changeId);
        const pass = index.labels?.pass?.name;
        const fail = index.labels?.fail?.name;
        if (issue && typeof issue.url === "string" && typeof pass === "string" && typeof fail === "string") target = { issueUrl: issue.url, passLabel: pass, failLabel: fail };
      }
    } catch (e) {
      if ((e as { code?: unknown }).code === "ROOT_ESCAPE") throw e;
      target = null;
    }
    const where = target ? "apply the pass or the fail label named in the fence to the tracker issue named there, yourself, in the tracker (it records who applied it and when); or " : "";
    return { text: `${where}run "pr-rla record ${draw} pass|fail" with your own token (ledger ${lt.name})`, target };
  }
  return { text: `pr-rla record ${draw} pass|fail --reviewer <you> (ledger ${lt.name})`, target: null };
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
  const lt = await ledgerTraits(config.ledger, config.dir, auditContextFor(ctx));
  let verdict: VerdictEvent | null = null;
  let verdictUnread: { ledger: string; error: string } | undefined;
  let blocksPrefix = false;
  ctx.onProgress?.({ done: 0, message: `reading the verdicts from ledger ${lt.name}` });
  try {
    const ledger = await ledgerFor(ctx, config, paths);
    const counted = await countedLedgerVerdicts(ctx, config, reg, ledger, { manifestSha256: manifest.sha256, beacon: draws.beacon });
    const report = computeStatus({
      N: manifest.N,
      minPopulation: reg.record.parameters.minPopulation,
      draws: draws.draws,
      drawsIssued: draws.issued,
      verdicts: counted.verdicts,
      protocolSha256: reg.record.protocolSha256,
      params: reg.record.parameters,
      reviewers: isRegistrationV2(reg) ? reg.record.verdicts.reviewers : null,
      ineligible: counted.ineligible,
    });
    verdict = report.firstVerdicts.find((v) => v.changeId === change.id) ?? null;
    blocksPrefix = report.blockingDraw?.draw === n;
  } catch (e) {
    // A stopped call stops; a file outside the roots is refused; anything else the ledger says goes in the fence.
    if (ctx.signal?.aborted || (e as { code?: unknown }).code === "ROOT_ESCAPE") throw e;
    verdictUnread = { ledger: lt.name, error: (e as Error)?.message ?? String(e) };
  }

  const bytes = readProtocol(config);
  const provider = await providerFor(ctx, config);
  let description: ChangeDescription | null = null;
  let descriptionNote: string | undefined;
  if (!provider.describeChange) descriptionNote = `provider ${provider.name} has no describeChange; open the URL`;
  else {
    ctx.onProgress?.({ done: 1, message: `asking ${provider.name} for ${change.id}` });
    let got: unknown;
    try {
      got = await provider.describeChange(change, ctx.signal ? { signal: ctx.signal } : {});
    } catch (e) {
      // Only pr-rla's own "no description" is a note, and in pr-rla's words; a plugin's error is an error.
      if (!(e instanceof NoRecordedDescription)) throw e;
      descriptionNote = "the json-file export records no description for this change; open the URL";
    }
    if (descriptionNote === undefined) {
      // Every return is checked, a falsy one included.
      const problems = changeDescriptionProblems(got, change.id);
      if (problems.length) throw new AuditError(`provider ${provider.name} described ${change.id} wrongly: ${problems.slice(0, 5).join("; ")}`, 1, "PROVIDER_ERROR");
      description = got as ChangeDescription;
    }
  }
  const record = howToRecord(config, paths, lt, firstDraw, change.id);
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
    howToRecord: record.text,
    recordTarget: record.target,
    fenceId: opts.fenceId ?? randomBytes(16).toString("hex"),
  });
}
