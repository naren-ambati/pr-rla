import { createHash, createPublicKey, verify } from "node:crypto";
import type { RekorV2Entry, SignedRecord } from "../core/records.js";
import type { BrokerFetch } from "../net/contract.js";
import { leafHash, verifyInclusion } from "./merkle.js";

/**
 * Rekor v2 (rekor-tiles) client for hashedrekord v0.0.2 entries.
 *
 * UNVERIFIED AGAINST THE PRODUCTION LOG. The request and response shapes follow
 * the published rekor-tiles API (`POST /api/v2/log/entries`, a TransparencyLogEntry
 * with an inclusion proof and a C2SP signed-note checkpoint) and are exercised
 * only against the local mock in test/helpers/mock-rekor-v2.ts. No entry has been
 * written to any real log, staging or production (founder decision D3).
 *
 * v2 sets no usable time: `integratedTime` is always 0 and is ignored. The time
 * evidence for a record comes from its RFC 3161 tokens; a v2 entry only makes the
 * record publicly discoverable.
 */

export const REKOR_V2_WARNING =
  "Rekor v2 client: tested against the published API and a mock log only, not the production log. This entry will be public and permanent.";

export interface HashedRekordRequestV002 {
  hashedRekordRequestV002: {
    digest: string;
    signature: { content: string; verifier: { publicKey: { rawBytes: string }; keyDetails: "PKIX_ECDSA_P256_SHA_256" } };
  };
}

const spkiDer = (pem: string) => createPublicKey(pem).export({ type: "spki", format: "der" });

export function buildHashedRekordV002(signed: Pick<SignedRecord<unknown>, "sha256" | "signature" | "publicKeyPem">): HashedRekordRequestV002 {
  return {
    hashedRekordRequestV002: {
      digest: Buffer.from(signed.sha256, "hex").toString("base64"),
      signature: { content: signed.signature, verifier: { publicKey: { rawBytes: spkiDer(signed.publicKeyPem).toString("base64") }, keyDetails: "PKIX_ECDSA_P256_SHA_256" } },
    },
  };
}

type RawV2 = {
  logIndex: string | number;
  logId?: { keyId?: string };
  kindVersion?: { kind?: string; version?: string };
  integratedTime?: string | number;
  inclusionProof?: { logIndex: string | number; rootHash: string; treeSize: string | number; hashes?: string[]; checkpoint?: { envelope?: string } };
  canonicalizedBody?: string;
};

export function toRekorV2Entry(logUrl: string, raw: RawV2): RekorV2Entry {
  const p = raw.inclusionProof;
  if (!p?.checkpoint?.envelope) throw new Error("Rekor v2 response has no inclusion proof with a checkpoint");
  if (!raw.canonicalizedBody) throw new Error("Rekor v2 response has no canonicalizedBody");
  return {
    apiVersion: "v2",
    logUrl,
    logIndex: Number(raw.logIndex),
    logId: raw.logId?.keyId ?? "",
    kindVersion: { kind: raw.kindVersion?.kind ?? "", version: raw.kindVersion?.version ?? "" },
    canonicalizedBody: raw.canonicalizedBody,
    inclusionProof: { logIndex: Number(p.logIndex), treeSize: Number(p.treeSize), rootHash: p.rootHash, hashes: p.hashes ?? [], checkpoint: { envelope: p.checkpoint.envelope } },
  };
}

export class RekorV2Client {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly broker: BrokerFetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async submit(req: HashedRekordRequestV002): Promise<RekorV2Entry> {
    const res = await this.broker(`${this.base}/api/v2/log/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(req),
      pluginId: "pr-rla/rekor",
      destination: "rekor",
      idempotent: false,
    });
    if (res.status !== 201 && res.status !== 200) throw new Error(`Rekor v2 submit failed: HTTP ${res.status} ${await res.text()}`);
    return toRekorV2Entry(this.base, (await res.json()) as RawV2);
  }
}

export interface SignedNote {
  /** The signed text: every line up to and including the newline before the blank line. */
  text: string;
  origin: string;
  treeSize: number;
  rootHash: Uint8Array;
  signatures: { name: string; keyId: Uint8Array; signature: Uint8Array }[];
}

/** Parses a C2SP signed note carrying a tlog checkpoint (origin, tree size, base64 root hash). */
export function parseCheckpoint(envelope: string): SignedNote {
  const split = envelope.indexOf("\n\n");
  if (split < 0) throw new Error("checkpoint has no signature block");
  const text = envelope.slice(0, split + 1);
  const [origin, size, root] = text.split("\n");
  if (!origin || !size || !root || !/^\d+$/.test(size)) throw new Error("checkpoint body is not origin / size / root hash");
  const signatures = envelope
    .slice(split + 2)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = /^— (\S+) ([A-Za-z0-9+/=]+)$/.exec(line);
      if (!m) throw new Error(`malformed checkpoint signature line: ${line.slice(0, 40)}`);
      const raw = Buffer.from(m[2]!, "base64");
      return { name: m[1]!, keyId: new Uint8Array(raw.subarray(0, 4)), signature: new Uint8Array(raw.subarray(4)) };
    });
  return { text, origin, treeSize: Number(size), rootHash: new Uint8Array(Buffer.from(root, "base64")), signatures };
}

/**
 * The 4-byte key id a checkpoint signature line starts with. Ed25519 follows C2SP
 * signed-note (SHA-256 of name, newline, 0x01, raw key); ECDSA follows Sigstore's
 * convention (SHA-256 of the DER public key). Unverified against production.
 */
export function noteKeyId(name: string, publicKeyPem: string): Uint8Array {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType === "ed25519") {
    const raw = key.export({ type: "spki", format: "der" }).subarray(-32);
    return new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(`${name}\n`), Buffer.of(0x01), raw])).digest().subarray(0, 4));
  }
  return new Uint8Array(createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest().subarray(0, 4));
}

export function verifyCheckpointSignature(note: SignedNote, publicKeyPem: string): boolean {
  const key = createPublicKey(publicKeyPem);
  return note.signatures.some((s) => {
    if (Buffer.compare(Buffer.from(s.keyId), Buffer.from(noteKeyId(s.name, publicKeyPem))) !== 0) return false;
    try {
      return key.asymmetricKeyType === "ed25519" ? verify(null, Buffer.from(note.text), key, s.signature) : verify("sha256", Buffer.from(note.text), key, s.signature);
    } catch {
      return false;
    }
  });
}

/**
 * Offline checks of a v2 entry against the signed record: the body names this
 * record's digest, signature and key; the inclusion proof reaches the
 * checkpoint's root; the checkpoint is signed by the pinned log key.
 */
export function verifyRekorV2Entry(entry: RekorV2Entry, signed: Pick<SignedRecord<unknown>, "sha256" | "signature" | "publicKeyPem">, logPublicKeyPem: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const bodyBytes = new Uint8Array(Buffer.from(entry.canonicalizedBody, "base64"));
  try {
    const body = JSON.parse(Buffer.from(bodyBytes).toString("utf8")) as { kind?: string; spec?: { hashedRekordV002?: { data?: { digest?: string }; signature?: { content?: string; verifier?: { publicKey?: { rawBytes?: string } } } } } };
    const spec = body.spec?.hashedRekordV002;
    if (body.kind !== "hashedrekord" || !spec) problems.push(`log entry kind ${String(body.kind)} is not hashedrekord v0.0.2`);
    if (spec?.data?.digest !== Buffer.from(signed.sha256, "hex").toString("base64")) problems.push("log entry names a different record digest");
    if (spec?.signature?.content !== signed.signature) problems.push("log entry carries a different signature");
    if (spec?.signature?.verifier?.publicKey?.rawBytes !== spkiDer(signed.publicKeyPem).toString("base64")) problems.push("log entry carries a different public key");
  } catch {
    problems.push("log entry body is not JSON");
  }
  const proof = entry.inclusionProof;
  let note: SignedNote | null = null;
  try {
    note = parseCheckpoint(proof.checkpoint.envelope);
  } catch (e) {
    problems.push(`checkpoint: ${(e as Error).message}`);
  }
  const root = new Uint8Array(Buffer.from(proof.rootHash, "base64"));
  if (!verifyInclusion(leafHash(bodyBytes), proof.logIndex, proof.treeSize, proof.hashes.map((h) => new Uint8Array(Buffer.from(h, "base64"))), root)) problems.push("inclusion proof does not reach the stated root");
  if (note) {
    if (note.treeSize !== proof.treeSize || Buffer.compare(Buffer.from(note.rootHash), Buffer.from(root)) !== 0) problems.push("checkpoint names a different tree than the inclusion proof");
    if (!verifyCheckpointSignature(note, logPublicKeyPem)) problems.push("checkpoint signature does not verify under the log key");
  }
  return { ok: problems.length === 0, problems };
}
