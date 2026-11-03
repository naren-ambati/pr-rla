import type { AuditWindow } from "../sdk/provider.js";

export interface WindowSpec {
  /** File-name-safe window name, e.g. `2026-q3`. */
  name: string;
  /** Inclusive first day, YYYY-MM-DD (UTC). */
  start: string;
  /** Inclusive last day, YYYY-MM-DD (UTC). */
  end: string;
}

export interface ResolvedWindow extends WindowSpec, AuditWindow {}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Days are UTC; the window opens at start 00:00:00Z and closes at (end + 1 day) 00:00:00Z. */
export function resolveWindow(spec: WindowSpec): ResolvedWindow {
  if (!DAY.test(spec.start) || !DAY.test(spec.end)) throw new Error("window.start and window.end must be YYYY-MM-DD (UTC days)");
  const open = Date.parse(`${spec.start}T00:00:00Z`);
  const lastDay = Date.parse(`${spec.end}T00:00:00Z`);
  if (Number.isNaN(open) || Number.isNaN(lastDay)) throw new Error("invalid window dates");
  if (lastDay < open) throw new Error("window.end is before window.start");
  if (!/^[A-Za-z0-9._-]+$/.test(spec.name)) throw new Error(`window.name "${spec.name}" must be file-name safe ([A-Za-z0-9._-])`);
  const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
  return { ...spec, opensAt: iso(open), closesAt: iso(lastDay + 86_400_000) };
}

export function inWindow(iso: string, w: AuditWindow): boolean {
  const t = Date.parse(iso);
  return t >= Date.parse(w.opensAt) && t < Date.parse(w.closesAt);
}

export function windowDays(w: AuditWindow): number {
  return Math.round((Date.parse(w.closesAt) - Date.parse(w.opensAt)) / 86_400_000);
}
