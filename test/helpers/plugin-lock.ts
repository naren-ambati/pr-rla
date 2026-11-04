import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalsFile, approvePlugin } from "../../src/plugins/approvals.js";
import { buildLockEntry } from "../../src/plugins/entry.js";
import { readLock, writeLock, type PluginTrust } from "../../src/plugins/lock.js";

/** A temp audit directory holding copies of `files` (destination -> source path). */
export function auditDirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "prrla-plugins-"));
  for (const [to, from] of Object.entries(files)) cpSync(from, join(dir, to), { recursive: true });
  return dir;
}

/**
 * Locks `use` in `dir`'s pr-rla.lock.json. With `approve`, also records the local approval, as
 * `pr-rla plugin add --yes` does (in the test file's own approvals file, test/setup/approvals.ts);
 * without it, the lock is as a third party receives it with someone else's audit repo.
 */
export async function lockPlugin(dir: string, use: string, o: { kind?: "provider" | "ledger"; options?: Record<string, unknown>; trust?: PluginTrust; approve?: boolean } = {}): Promise<void> {
  const entry = await buildLockEntry(o.kind ?? "provider", use, dir, o.options ?? {}, o.trust ?? "isolated");
  const lock = readLock(dir);
  writeLock(dir, { ...lock, plugins: { ...lock.plugins, [use]: entry } });
  if (o.approve) approvePlugin(approvalsFile(), use, entry, "2026-11-04T00:00:00Z");
}
