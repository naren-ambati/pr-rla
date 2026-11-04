import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AuditMode } from "../../core/records.js";
import { configFor, type ApiContext } from "../session.js";
import { status, type StatusResult } from "./status.js";

export interface AuditWindowSummary {
  name: string;
  phase: StatusResult["phase"];
  /** The window .pr-rla.yml configures (others are earlier windows in the audit directory). */
  configured: boolean;
  /** null before registration. */
  mode: AuditMode | null;
  timestampTamperProof?: boolean;
  N?: number;
  drawsIssued?: number;
  /** Set once the window is sampled and its verdicts could be read offline. */
  certified?: boolean;
  /** The status line. */
  line: string;
}

/** `audit_list` (contracts.md §4): the audit directory's windows and the phase of each. Offline, reads only. */
export async function auditList(ctx: ApiContext): Promise<{ dir: string; windows: AuditWindowSummary[] }> {
  const { config } = configFor(ctx);
  const auditDir = resolve(config.dir, config.auditDir);
  const names = new Set<string>([config.window.name]);
  if (existsSync(auditDir))
    for (const e of readdirSync(auditDir, { withFileTypes: true })) if (e.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.name) && existsSync(join(auditDir, e.name, "registration.json"))) names.add(e.name);
  const windows: AuditWindowSummary[] = [];
  for (const name of [...names].sort()) {
    const r = await status(ctx, { ...(name !== config.window.name ? { window: name } : {}), offline: true, skipTrackerLedger: true });
    const s: AuditWindowSummary = { name, phase: r.phase, configured: name === config.window.name, mode: r.phase === "unregistered" ? null : r.mode, line: r.line };
    if (r.phase !== "unregistered") s.timestampTamperProof = r.timestampTamperProof;
    if (r.phase === "frozen" || r.phase === "sampled") s.N = r.N;
    if (r.phase === "sampled") {
      s.drawsIssued = r.drawsIssued;
      // The certificate rule status prints (src/core/verdict.ts): not certified while something withholds it.
      if (r.verdictsRead) s.certified = r.certified;
    }
    windows.push(s);
  }
  return { dir: config.dir, windows };
}
