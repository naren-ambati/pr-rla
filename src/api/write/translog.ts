import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SignedRecord } from "../../core/records.js";
import type { PrRlaConfig } from "../../config.js";
import { RekorClient, buildHashedRekord, verifyLoggedEntry } from "../../translog/rekor.js";
import { RekorV2Client, buildHashedRekordV002, verifyRekorV2Entry } from "../../translog/rekor-v2.js";
import { AuditError } from "../errors.js";
import { auditContextFor, brokerFor, type ApiContext } from "../session.js";

export type RekorApi = "v1" | "v2";

export function rekorApi(flag: string | undefined): RekorApi {
  const api = flag ?? "v1";
  if (api !== "v1" && api !== "v2") throw new AuditError(`--rekor-api must be v1 or v2 (got ${api})`);
  return api;
}

/** Submits to a Rekor v2 log and verifies the returned inclusion proof and checkpoint against the pinned log key. */
export async function submitSignedV2<T>(ctx: ApiContext, config: PrRlaConfig, signed: SignedRecord<T>, url: string): Promise<SignedRecord<T>> {
  const key = config.transparencyLog.publicKeyFile ? readFileSync(resolve(config.dir, config.transparencyLog.publicKeyFile), "utf8") : null;
  if (!key) throw new AuditError("a Rekor v2 submission needs the log's public key in transparency_log.public_key_file, to verify the signed checkpoint");
  const entry = await new RekorV2Client(url, brokerFor(ctx)).submit(buildHashedRekordV002(signed));
  const check = verifyRekorV2Entry(entry, signed, key);
  if (!check.ok) throw new AuditError(`Rekor v2 log ${url} returned an entry that does not verify: ${check.problems.join("; ")}`);
  return { ...signed, log: entry };
}

/** Resolves the log URL for --submit. There is deliberately no default. */
export function submitUrl(config: PrRlaConfig, flag: string | undefined): string {
  const url = flag ?? config.transparencyLog.url;
  if (!url) throw new AuditError("--submit needs --rekor-url <url> (or transparency_log.url in .pr-rla.yml); pr-rla has no default log because entries are public and permanent");
  return url;
}

export async function submitSigned<T>(ctx: ApiContext, signed: SignedRecord<T>, url: string): Promise<SignedRecord<T>> {
  const client = new RekorClient(url, auditContextFor(ctx).componentFetch("pr-rla/rekor", "rekor"));
  const entry = await client.submit(buildHashedRekord(signed));
  const check = verifyLoggedEntry(entry, signed, await client.publicKey());
  if (!check.ok) throw new AuditError(`log ${url} returned an entry that does not verify: ${check.problems.join("; ")}`);
  return { ...signed, log: entry };
}
