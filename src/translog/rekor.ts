import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "../core/canonical.js";
import type { LoggedEntry, SignedRecord } from "../core/records.js";
import { leafHash, verifyInclusion } from "./merkle.js";

/**
 * Sigstore Rekor (v1 API) client for `hashedrekord` entries.
 *
 * pr-rla never picks a log URL by default: submitting requires an explicit
 * `--rekor-url`, because entries in a public log are public and permanent.
 * In v0.1 this client has been exercised only against the local mock log
 * in test/helpers/mock-rekor.ts.
 */

export interface HashedRekordEntry {
  apiVersion: "0.0.1";
  kind: "hashedrekord";
  spec: {
    signature: { content: string; publicKey: { content: string } };
    data: { hash: { algorithm: "sha256"; value: string } };
  };
}

export function buildHashedRekord(signed: Pick<SignedRecord<unknown>, "sha256" | "signature" | "publicKeyPem">): HashedRekordEntry {
  return {
    apiVersion: "0.0.1",
    kind: "hashedrekord",
    spec: {
      signature: { content: signed.signature, publicKey: { content: Buffer.from(signed.publicKeyPem).toString("base64") } },
      data: { hash: { algorithm: "sha256", value: signed.sha256 } },
    },
  };
}

type RawEntry = {
  body: string;
  integratedTime: number;
  logID: string;
  logIndex: number;
  verification?: {
    signedEntryTimestamp?: string;
    inclusionProof?: { logIndex: number; rootHash: string; treeSize: number; hashes: string[]; checkpoint?: string };
  };
};

function toLogged(logUrl: string, raw: Record<string, RawEntry>): LoggedEntry {
  const [uuid, e] = Object.entries(raw)[0] ?? [];
  if (!uuid || !e) throw new Error("Rekor response had no entry");
  if (!e.verification?.signedEntryTimestamp) throw new Error("Rekor response had no signedEntryTimestamp");
  const verification: LoggedEntry["verification"] = { signedEntryTimestamp: e.verification.signedEntryTimestamp };
  if (e.verification.inclusionProof) verification.inclusionProof = e.verification.inclusionProof;
  return { logUrl, uuid, logIndex: e.logIndex, integratedTime: e.integratedTime, logID: e.logID, body: e.body, verification };
}

export class RekorClient {
  private readonly base: string;
  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async submit(entry: HashedRekordEntry): Promise<LoggedEntry> {
    const res = await this.fetchImpl(`${this.base}/api/v1/log/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(entry),
    });
    if (res.status !== 201) throw new Error(`Rekor submit failed: HTTP ${res.status} ${await res.text()}`);
    return toLogged(this.base, (await res.json()) as Record<string, RawEntry>);
  }

  async getEntry(uuid: string): Promise<LoggedEntry> {
    const res = await this.fetchImpl(`${this.base}/api/v1/log/entries/${uuid}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Rekor get ${uuid.slice(0, 12)}… failed: HTTP ${res.status}`);
    return toLogged(this.base, (await res.json()) as Record<string, RawEntry>);
  }

  async publicKey(): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/api/v1/log/publicKey`, { headers: { accept: "application/x-pem-file" } });
    if (!res.ok) throw new Error(`Rekor publicKey failed: HTTP ${res.status}`);
    return res.text();
  }
}

/** The payload a Rekor signedEntryTimestamp signs. */
export function setPayload(e: Pick<LoggedEntry, "body" | "integratedTime" | "logID" | "logIndex">): string {
  return canonicalJson({ body: e.body, integratedTime: e.integratedTime, logID: e.logID, logIndex: e.logIndex });
}

export interface LogCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Offline checks of a logged entry against the signed record it claims to log:
 * the body names this record's digest, signature and key; the SET verifies
 * under the log's key; the inclusion proof reaches its root.
 * (The inclusion proof's checkpoint signature is not checked in v0.1.)
 */
export function verifyLoggedEntry(logged: LoggedEntry, signed: Pick<SignedRecord<unknown>, "sha256" | "signature" | "publicKeyPem">, logPublicKeyPem: string): LogCheck {
  const problems: string[] = [];
  let body: HashedRekordEntry | null = null;
  try {
    body = JSON.parse(Buffer.from(logged.body, "base64").toString("utf8")) as HashedRekordEntry;
  } catch {
    problems.push("log entry body is not JSON");
  }
  if (body) {
    if (body.kind !== "hashedrekord") problems.push(`log entry kind ${String(body.kind)} is not hashedrekord`);
    if (body.spec?.data?.hash?.value !== signed.sha256) problems.push("log entry names a different record digest");
    if (body.spec?.signature?.content !== signed.signature) problems.push("log entry carries a different signature");
    const pem = body.spec?.signature?.publicKey?.content ? Buffer.from(body.spec.signature.publicKey.content, "base64").toString("utf8") : "";
    if (pem.trim() !== signed.publicKeyPem.trim()) problems.push("log entry carries a different public key");
  }
  try {
    const ok = verify("sha256", Buffer.from(setPayload(logged)), createPublicKey(logPublicKeyPem), Buffer.from(logged.verification.signedEntryTimestamp, "base64"));
    if (!ok) problems.push("signedEntryTimestamp does not verify under the log key (integratedTime not trustworthy)");
  } catch (e) {
    problems.push(`signedEntryTimestamp check failed: ${(e as Error).message}`);
  }
  const proof = logged.verification.inclusionProof;
  if (!proof) problems.push("no inclusion proof");
  else {
    const leaf = leafHash(new Uint8Array(Buffer.from(logged.body, "base64")));
    const leafHex = Buffer.from(leaf).toString("hex");
    if (!logged.uuid.endsWith(leafHex)) problems.push("entry UUID does not match its body's leaf hash");
    const ok = verifyInclusion(leaf, proof.logIndex, proof.treeSize, proof.hashes.map((x) => new Uint8Array(Buffer.from(x, "hex"))), new Uint8Array(Buffer.from(proof.rootHash, "hex")));
    if (!ok) problems.push("inclusion proof does not reach the stated root");
  }
  return { ok: problems.length === 0, problems };
}
