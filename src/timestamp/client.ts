import { randomBytes } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import type { TimestampEvidence } from "../core/records.js";
import type { BrokerFetch } from "../net/contract.js";
import type { TrustBundle } from "./bundle.js";
import { OID, checkToken, isoMs, normHex, readToken, type TokenCheck } from "./verify.js";

/**
 * The RFC 3161 client. It sends each configured authority one TimeStampReq
 * holding only the SHA-256 record digest and a 64-bit nonce (certReq true), in
 * parallel, through the broker contract with `destination: "tsa"`. Retries are
 * the broker's (5-minute deadline); this client does not loop.
 */

export const TSA_PLUGIN_ID = "pr-rla/timestamp";

/** A random 64-bit nonce as a positive DER INTEGER value (top bit clear, first byte non-zero). */
export function newNonce(): Uint8Array {
  const b = new Uint8Array(randomBytes(8));
  b[0] = (b[0]! & 0x7f) | 0x01;
  return b;
}

function asBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** DER TimeStampReq: version 1, messageImprint (SHA-256, the digest), nonce, certReq TRUE. Nothing else. */
export function buildTimeStampReq(digestHex: string, nonce: Uint8Array): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(digestHex)) throw new Error("a timestamp request needs a SHA-256 digest (64 hex digits)");
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256, algorithmParams: new asn1js.Null() }),
      hashedMessage: new asn1js.OctetString({ valueHex: asBuffer(new Uint8Array(Buffer.from(digestHex, "hex"))) }),
    }),
    nonce: new asn1js.Integer({ valueHex: asBuffer(nonce) }),
    certReq: true,
  });
  return new Uint8Array(req.toSchema().toBER(false));
}

const PKI_STATUS = ["granted", "grantedWithMods", "rejection", "waiting", "revocationWarning", "revocationNotification"];

/** Splits a TimeStampResp into its status and the raw TimeStampToken bytes. */
export function parseTimeStampResp(der: Uint8Array): { status: number; statusText: string; token: Uint8Array | null } {
  const r = asn1js.fromBER(asBuffer(der));
  if (r.offset === -1) throw new Error("response is not a DER TimeStampResp");
  const resp = new pkijs.TimeStampResp({ schema: r.result });
  const status = resp.status.status as number;
  const strings = (resp.status.statusStrings ?? []).map((s) => s.valueBlock.value).join("; ");
  const seq = r.result as asn1js.Sequence;
  const tokenBlock = seq.valueBlock.value[1];
  return { status, statusText: `${PKI_STATUS[status] ?? `status ${status}`}${strings ? ` (${strings})` : ""}`, token: tokenBlock ? new Uint8Array(tokenBlock.valueBeforeDecodeView) : null };
}

export interface AuthorityOutcome {
  tsa: string;
  url: string;
  /** Set when the authority returned a granted token (genuine or not). */
  evidence: TimestampEvidence | null;
  check: TokenCheck | null;
  /** Why there is no token: HTTP status, rejection, timeout, parse error. */
  error: string | null;
}

export interface RequestTimestampsInput {
  authorities: readonly string[];
  bundle: TrustBundle;
  digestHex: string;
  /** canonicalJson(record) bytes, to check each token as it arrives. */
  data: Uint8Array;
  signedTimeIso: string;
  toleranceSeconds: number;
  defaultAccuracySeconds: number;
  broker: BrokerFetch;
  /** Injected for recorded-fixture replays; defaults to a fresh random nonce per authority. */
  nonceFor?: (tsa: string) => Uint8Array;
}

/** Requests one token from every configured authority in parallel and checks each one offline. */
export async function requestTimestamps(input: RequestTimestampsInput): Promise<AuthorityOutcome[]> {
  const jobs = input.authorities.map((tsa) => {
    const authority = input.bundle.authorities[tsa];
    const url = authority?.url ?? "";
    const nonce = (input.nonceFor ?? newNonce)(tsa);
    return { tsa, url, nonce, authority };
  });
  return Promise.all(
    jobs.map(async ({ tsa, url, nonce, authority }): Promise<AuthorityOutcome> => {
      if (!authority) return { tsa, url, evidence: null, check: null, error: `"${tsa}" is not in the trust bundle` };
      try {
        const res = await input.broker(url, {
          method: "POST",
          headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply", "user-agent": "pr-rla" },
          body: asBuffer(buildTimeStampReq(input.digestHex, nonce)),
          pluginId: TSA_PLUGIN_ID,
          destination: "tsa",
          idempotent: true,
        });
        const body = new Uint8Array(await res.arrayBuffer());
        if (!res.ok) return { tsa, url, evidence: null, check: null, error: `HTTP ${res.status}` };
        const resp = parseTimeStampResp(body);
        if (resp.status !== 0 && resp.status !== 1) return { tsa, url, evidence: null, check: null, error: `the authority answered ${resp.statusText}` };
        if (!resp.token) return { tsa, url, evidence: null, check: null, error: `${resp.statusText} but no token` };
        const { facts } = readToken(resp.token);
        const evidence: TimestampEvidence = {
          kind: "rfc3161",
          tsa,
          url,
          tokenDer: Buffer.from(resp.token).toString("base64"),
          genTime: isoMs(facts.genTimeMs),
          accuracySeconds: facts.accuracySeconds,
          serial: facts.serial,
          nonce: normHex(Buffer.from(nonce).toString("hex")),
        };
        const check = await checkToken({ evidence, data: input.data, digestHex: input.digestHex, signedTimeIso: input.signedTimeIso, toleranceSeconds: input.toleranceSeconds, defaultAccuracySeconds: input.defaultAccuracySeconds, bundle: input.bundle });
        return { tsa, url, evidence, check, error: null };
      } catch (e) {
        return { tsa, url, evidence: null, check: null, error: (e as Error).message };
      }
    }),
  );
}
