import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll } from "vitest";

/**
 * Local approvals (src/plugins/approvals.ts) live in a per-user file. Every test file gets its own
 * temp file through PR_RLA_APPROVALS_FILE, which a context's env falls back to, so no test reads or
 * writes the real ~/.config/pr-rla/approvals.json; this file fails if one did.
 */
const xdg = process.env.XDG_CONFIG_HOME;
const real = join(xdg && isAbsolute(xdg) ? xdg : join(process.env.HOME ?? homedir(), ".config"), "pr-rla", "approvals.json");
const before = existsSync(real) ? statSync(real).mtimeMs : null;
const dir = mkdtempSync(join(tmpdir(), "prrla-approvals-"));
process.env.PR_RLA_APPROVALS_FILE = join(dir, "approvals.json");
delete process.env.PR_RLA_ACCEPT_LOCK_GRANTS;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  const after = existsSync(real) ? statSync(real).mtimeMs : null;
  if (after !== before) throw new Error(`a test wrote the real approvals file ${real}; tests must use PR_RLA_APPROVALS_FILE`);
});
