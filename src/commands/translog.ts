import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SignedRecord } from "../core/records.js";
import { RekorClient, buildHashedRekord, verifyLoggedEntry } from "../translog/rekor.js";
import { REKOR_V2_WARNING, RekorV2Client, buildHashedRekordV002, verifyRekorV2Entry } from "../translog/rekor-v2.js";
import type { PrRlaConfig } from "../config.js";
import { CommandError, brokerFor, type CommandContext } from "./context.js";

export type RekorApi = "v1" | "v2";

export function rekorApi(flag: string | undefined): RekorApi {
  const api = flag ?? "v1";
  if (api !== "v1" && api !== "v2") throw new CommandError(`--rekor-api must be v1 or v2 (got ${api})`);
  return api;
}

/**
 * Before any network call of a `--submit --rekor-api v2` run: prints the v2 warning and
 * requires --yes or an interactive yes. Entries are public and permanent.
 */
export async function confirmRekorV2(ctx: CommandContext, yes: boolean | undefined): Promise<void> {
  ctx.out(REKOR_V2_WARNING);
  if (yes) return;
  if (ctx.confirm && (await ctx.confirm("Submit to this Rekor v2 log?"))) return;
  throw new CommandError("not submitted: pass --yes to confirm a public, permanent Rekor v2 entry (nothing was written)");
}

/** Submits to a Rekor v2 log and verifies the returned inclusion proof and checkpoint against the pinned log key. */
export async function submitSignedV2<T>(ctx: CommandContext, config: PrRlaConfig, signed: SignedRecord<T>, url: string): Promise<SignedRecord<T>> {
  const key = config.transparencyLog.publicKeyFile ? readFileSync(resolve(config.dir, config.transparencyLog.publicKeyFile), "utf8") : null;
  if (!key) throw new CommandError("a Rekor v2 submission needs the log's public key in transparency_log.public_key_file, to verify the signed checkpoint");
  const entry = await new RekorV2Client(url, brokerFor(ctx)).submit(buildHashedRekordV002(signed));
  const check = verifyRekorV2Entry(entry, signed, key);
  if (!check.ok) throw new CommandError(`Rekor v2 log ${url} returned an entry that does not verify: ${check.problems.join("; ")}`);
  return { ...signed, log: entry };
}

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
