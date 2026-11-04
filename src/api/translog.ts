import { resolve } from "node:path";
import { readTextConfined } from "../io/confine.js";
import type { PrRlaConfig } from "../config.js";
import { parseLogKeyArgs, trustedLogKey, type TrustedLogKey, type VerifierLogKeys } from "../translog/keys.js";
import { AuditError } from "./errors.js";
import type { ApiContext } from "./session.js";

/**
 * The verifier's `--log-key <url>=<pem-file>` keys (repeatable), each scoped to its log URL (pass-2 review #6).
 * A key for a log pr-rla pins is not used (the pinned key always wins) and is named in `ignored`. Files are read
 * relative to the working directory. A malformed value is a usage error (exit 1).
 */
export function verifierLogKeys(ctx: ApiContext, flags: readonly string[] | undefined): { keys: VerifierLogKeys; ignored: string[]; lookup: (logUrl: string) => TrustedLogKey | null } {
  try {
    const { keys, ignored } = parseLogKeyArgs(flags ?? [], (file) => readTextConfined(resolve(ctx.cwd, file), "the verifier's --log-key file"));
    return { keys, ignored, lookup: (logUrl) => trustedLogKey(logUrl, keys) };
  } catch (e) {
    throw new AuditError((e as Error).message);
  }
}

/**
 * The log key verify trusts (trusted-time review finding 3, pass-2 review #6): the key pinned in the package for that
 * log URL (src/translog/keys.ts), else the verifier's --log-key for exactly that URL. Never the audit repo's
 * transparency_log.public_key_file, a file in the audit repo, or the /publicKey of the URL a record names.
 * `_config` and `_offline` are kept for the callers.
 */
export async function logPublicKey(ctx: ApiContext, _config: PrRlaConfig, logUrl: string, flags: readonly string[] | undefined, _offline: boolean): Promise<TrustedLogKey | null> {
  return trustedLogKey(logUrl, verifierLogKeys(ctx, flags).keys);
}
