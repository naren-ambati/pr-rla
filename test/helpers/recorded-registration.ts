import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RegistrationRecordV2, SignedRecord, TimestampEvidence } from "../../src/core/records.js";
import { signRecord } from "../../src/core/signing.js";
import { parseTimeStampResp } from "../../src/timestamp/client.js";
import { isoMs, readToken } from "../../src/timestamp/verify.js";
import { readJsonFixture } from "./fixtures.js";
import { TEST_SIGNING_KEY_PEM } from "./signing-key.js";
import { createPublicKey } from "node:crypto";

/**
 * The live registration of 2026-11-03 (test/fixtures/tsa/recorded-2026-11-03.json, recorded: real RFC 3161 responses
 * from the bundled authorities over one registration digest, hash only), as a registration.json.
 *
 * Since time round B a registration names its signing key inside its signed bytes, so `register` can no longer
 * reproduce that digest (the recorded record names no key, and its key was thrown away): the recording is replayed as
 * stored instead. The record and its four default authorities' tokens are the recorded ones, byte for byte; the
 * envelope is signed with the tests' fixed key (synthetic), which is exactly the re-keying a record without the field
 * allows, and which verify reports as a WARN.
 */
export interface Recording {
  registeredAt: string;
  digest: string;
  record: RegistrationRecordV2;
  nonces: Record<string, string>;
  authorities: Record<string, { url: string; request: string; status: number; contentType: string; response: string }>;
  demo: { register: string[] };
}

export const RECORDING = readJsonFixture<Recording>("tsa", "recorded-2026-11-03.json");

/** One authority's recorded token, as the envelope's TimestampEvidence (what `register` stored). */
export function recordedEvidence(id: string): TimestampEvidence {
  const a = RECORDING.authorities[id]!;
  const token = parseTimeStampResp(new Uint8Array(Buffer.from(a.response, "base64"))).token!;
  const { facts } = readToken(token);
  return { kind: "rfc3161", tsa: id, url: a.url, tokenDer: Buffer.from(token).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce: RECORDING.nonces[id]! };
}

/** The recorded registration with the tokens of the authorities it registered (the four defaults). */
export function recordedRegistration(): SignedRecord<RegistrationRecordV2> {
  const key = { privateKeyPem: TEST_SIGNING_KEY_PEM, publicKeyPem: createPublicKey(TEST_SIGNING_KEY_PEM).export({ type: "spki", format: "pem" }).toString() };
  const signed = signRecord(RECORDING.record, key);
  return { ...signed, timestamps: RECORDING.record.timestamping.authorities.map(recordedEvidence) };
}

/** Writes it where the tsa-demo audit keeps its registration. */
export function installRecordedRegistration(dir: string): string {
  const p = join(dir, "audit", RECORDING.record.window.name, "registration.json");
  mkdirSync(join(dir, "audit", RECORDING.record.window.name), { recursive: true });
  writeFileSync(p, `${JSON.stringify(recordedRegistration(), null, 2)}\n`);
  return p;
}
