import { resolve } from "node:path";
import { readTextConfined } from "../io/confine.js";
import type { PrRlaConfig } from "../config.js";
import { trustedLogKey } from "../translog/keys.js";
import type { ApiContext } from "./session.js";

/**
 * The log key verify trusts (trusted-time review finding 3): the verifier's --log-key, else a key pinned in
 * the package (src/translog/keys.ts). Never the audit repo's transparency_log.public_key_file, a file in the
 * audit repo, or the /publicKey of the URL a record names. `_config` and `_offline` are kept for the callers.
 */
export async function logPublicKey(ctx: ApiContext, _config: PrRlaConfig, logUrl: string, flag: string | undefined, _offline: boolean): Promise<string | null> {
  return trustedLogKey(logUrl, flag ? readTextConfined(resolve(ctx.cwd, flag), "the verifier's --log-key file") : null);
}
