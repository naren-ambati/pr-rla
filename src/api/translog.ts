import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrRlaConfig } from "../config.js";
import { RekorClient } from "../translog/rekor.js";
import { auditContextFor, type ApiContext } from "./session.js";

/** The log key verify trusts: --log-key, transparency_log.public_key_file, or (online) the log's own /publicKey (a GET). */
export async function logPublicKey(ctx: ApiContext, config: PrRlaConfig, logUrl: string, flag: string | undefined, offline: boolean): Promise<string | null> {
  const file = flag ? resolve(ctx.cwd, flag) : config.transparencyLog.publicKeyFile ? resolve(config.dir, config.transparencyLog.publicKeyFile) : null;
  if (file) return readFileSync(file, "utf8");
  if (offline) return null;
  return new RekorClient(logUrl, auditContextFor(ctx).componentFetch("pr-rla/rekor", "rekor")).publicKey();
}
