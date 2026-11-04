import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAuditContext } from "../../src/api/context.js";
import type { RegistrationRecordV2, SignedRecord } from "../../src/core/records.js";
import { pluginIdentity, type PluginSpec } from "../../src/registry.js";

/**
 * P1: every command runs only the registered provider and ledger. A test that needs another plugin in a
 * copied fixture (an unreachable provider, a failing ledger) names it in the copy's registration, as a
 * registration made with it would; the record is not re-signed, so this is only for tests whose subject
 * is not check 1's signature (status, draw-context, check 7's own lines).
 */
export async function registerPluginInCopy(dir: string, kind: "provider" | "ledger", spec: PluginSpec, window = "2026-q3"): Promise<void> {
  const p = join(dir, "audit", window, "registration.json");
  const reg = JSON.parse(readFileSync(p, "utf8")) as SignedRecord<RegistrationRecordV2>;
  reg.record.plugins[kind] = await pluginIdentity(spec, kind, dir, createAuditContext({ mode: "read-write" }));
  writeFileSync(p, `${JSON.stringify(reg, null, 2)}\n`);
}
