import { createInterface } from "node:readline/promises";
import { AuditError } from "../api/errors.js";
import { escapeControls } from "../core/text.js";
import { sleepFor } from "../net/abort.js";
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

/**
 * Every line the CLI prints, stdout and stderr, has its control characters escaped (src/core/text.ts;
 * U5 fix round, M4): an ESC or CR sequence in a patch, a title, a ledger's note or a server's error
 * cannot move the cursor, rewrite earlier lines or reorder text in the person's terminal. The same
 * `\uXXXX` form is a valid escape inside a JSON string, so `--json` output stays exact JSON.
 */
export const terminalLine = (l: string): string => escapeControls(l);

export function nodeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    nowMs: () => Date.now(),
    fetch: globalThis.fetch,
    out: (l) => process.stdout.write(`${terminalLine(l)}\n`),
    err: (l) => process.stderr.write(`${terminalLine(l)}\n`),
    sleep: (ms, signal) => sleepFor(ms, signal),
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
