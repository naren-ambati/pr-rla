import { Fence, foreign, ident, isoOrForeign, render, type Foreign } from "../../core/said.js";
import type { AuditMode } from "../context.js";
import type { StatusReport } from "../../core/status.js";
import { PROVENANCE_LEVELS, type VerdictEvent } from "../../sdk/ledger.js";
import { isChangeId } from "../../sdk/provider.js";

/**
 * A verdict as a read result shows it (S1, the seam review's finding 2): what its ledger wrote is carried as foreign
 * text (src/core/said.ts), so the result's rendering keeps it out of pr-rla's voice in read-only mode. The reviewer,
 * the note and an app's name always; a change id, a protocol hash, an account or event id, a provenance source or
 * signer only when it is not the identifier it should be. The time is pr-rla's when it parses (printed as pr-rla prints
 * times), else foreign. The verdict itself and the draw number are values pr-rla checked.
 */

const time = (t: unknown): string | Foreign => isoOrForeign("the time the ledger line gives", t);

/** One verdict with its ledger-written fields fenced (its type is the verdict's; the fields become strings again when rendered). */
export function fenceVerdict(v: VerdictEvent): VerdictEvent {
  const p = v.provenance;
  const fenced: Record<string, unknown> = {
    ...v,
    changeId: isChangeId(v.changeId) ? v.changeId : foreign("the change the ledger line names", v.changeId),
    protocolSha256: typeof v.protocolSha256 === "string" && /^[0-9a-f]{64}$/.test(v.protocolSha256) ? v.protocolSha256 : foreign("the protocol the ledger line names", v.protocolSha256),
    reviewer: foreign("the reviewer the ledger names", v.reviewer),
    recordedAt: time(v.recordedAt),
    ...(v.note !== undefined ? { note: foreign("the verdict's note", v.note) } : {}),
  };
  if (p) {
    const q: Record<string, unknown> = { ...p, level: (PROVENANCE_LEVELS as readonly string[]).includes(p.level) ? p.level : foreign("the provenance the ledger claims", p.level), source: ident("the provenance source the ledger gives", p.source) };
    for (const k of ["actorId", "eventId", "signer", "keyFingerprint"] as const) if (p[k] !== undefined) q[k] = ident(`the ${k} the ledger gives`, p[k]);
    if (p.viaApp !== undefined && p.viaApp !== null) q.viaApp = foreign("the app's name", p.viaApp);
    fenced.provenance = q;
  }
  return fenced as unknown as VerdictEvent;
}

/** A status report with every verdict in it fenced: the counted ones, the ignored ones (their reasons are lines already) and the relabels. */
export function fenceStatus(r: StatusReport): StatusReport {
  return {
    ...r,
    ignored: r.ignored.map((i) => ({ event: fenceVerdict(i.event), reason: i.reason })),
    relabels: r.relabels.map((x) => ({ changeId: x.changeId, first: fenceVerdict(x.first), later: fenceVerdict(x.later) })),
    firstVerdicts: r.firstVerdicts.map(fenceVerdict),
  };
}

/**
 * A read result rendered once, by the mode (S1): every line and foreign piece in it (src/core/said.ts) becomes text.
 * In read-only mode each foreign piece is pr-rla's words and a pointer, and the texts are in `untrusted.errors`, which
 * is present only when there is one; the CLI's result quotes them in place.
 */
export function renderResult<T extends object>(mode: AuditMode, value: unknown, errors: string[] = []): T & { untrusted?: { errors: string[] } } {
  const fence = mode === "read-only" ? new Fence(errors) : null;
  const out = render(value, fence) as T;
  return fence?.errors.length ? { ...out, untrusted: { errors: fence.errors } } : out;
}
