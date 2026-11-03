import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SignedRecord } from "../core/records.js";
import { RekorClient, buildHashedRekord, verifyLoggedEntry } from "../translog/rekor.js";
import type { PrRlaConfig } from "../config.js";
import { CommandError, type CommandContext } from "./context.js";

/** Resolves the log URL for --submit. There is deliberately no default. */
export function submitUrl(config: PrRlaConfig, flag: string | undefined): string {
  const url = flag ?? config.transparencyLog.url;
  if (!url) throw new CommandError("--submit needs --rekor-url <url> (or transparency_log.url in .pr-rla.yml); pr-rla has no default log because entries are public and permanent");
  return url;
}

export async function submitSigned<T>(ctx: CommandContext, signed: SignedRecord<T>, url: string): Promise<SignedRecord<T>> {
  const client = new RekorClient(url, ctx.fetch);
  const entry = await client.submit(buildHashedRekord(signed));
  const check = verifyLoggedEntry(entry, signed, await client.publicKey());
  if (!check.ok) throw new CommandError(`log ${url} returned an entry that does not verify: ${check.problems.join("; ")}`);
  return { ...signed, log: entry };
}

/** The log key verify trusts: --log-key, transparency_log.public_key_file, or (online) the log's own /publicKey. */
export async function logPublicKey(ctx: CommandContext, config: PrRlaConfig, logUrl: string, flag: string | undefined, offline: boolean): Promise<string | null> {
  const file = flag ? resolve(ctx.cwd, flag) : config.transparencyLog.publicKeyFile ? resolve(config.dir, config.transparencyLog.publicKeyFile) : null;
  if (file) return readFileSync(file, "utf8");
  if (offline) return null;
  return new RekorClient(logUrl, ctx.fetch).publicKey();
}
