import { createInterface } from "node:readline/promises";
import { AuditError } from "../api/errors.js";
import type { ApiContext } from "../api/session.js";
export type { DrawsFile } from "../core/records.js";

/**
 * The CLI's context: an audit API context (src/api/session.ts) plus `out`, where the command's
 * formatter prints the result. Since U5 the commands are thin: they call `src/api` and format.
 */
export interface CommandContext extends ApiContext {
  out: (line: string) => void;
}

/** A refusal of a CLI command, with its exit code (contracts.md §7). The API throws its base, AuditError. */
export class CommandError extends AuditError {
  constructor(message: string, exitCode = 1) {
    super(message, exitCode);
    this.name = "CommandError";
  }
}

export function nodeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    nowMs: () => Date.now(),
    fetch: globalThis.fetch,
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...(process.stdin.isTTY
      ? {
          confirm: async (q: string) => {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
            } finally {
              rl.close();
            }
          },
        }
      : {}),
    ...overrides,
  };
}

// The helpers below moved to the audit API in U5; they are re-exported for the commands and tests.
export {
  auditContextFor,
  brokerFor,
  configFor,
  fmt,
  getBeacon,
  isoNow,
  ledgerFor,
  pct,
  protocolSha256,
  providerFor,
  readCommitment,
  readDraws,
  readJson,
  readManifest,
  readRegistration,
  trustFor,
} from "../api/session.js";
export { writeJson } from "../api/write/files.js";
