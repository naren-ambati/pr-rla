import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/core/canonical.js";
import { SHIPPED_TRUST_BUNDLE, mergeTrust } from "../src/timestamp/bundle.js";
import { isoMs, readToken } from "../src/timestamp/verify.js";
import { verifyAudit } from "../src/core/verify.js";
import { beaconParams, derivedRoundFor, type RegistrationRecordV2, type SignedRecord, type TimestampEvidence } from "../src/core/records.js";
import { makeTestAuthority, mintResponse, tokenOf, trustExtra } from "./helpers/test-tsa.js";

// Final fix round, item 1: the registration's PROVEN time is compared with R's publish time, and the verifier holds
// its own tolerance, never the record's. Synthetic: test authorities and a hand-built registration, no network.
async function build(o: { toleranceSeconds: number; claimed: string; genTime: string; accuracySeconds?: number }) {
  const A = await makeTestAuthority({ id: "test-a" });
  const B = await makeTestAuthority({ id: "test-b", operator: "Operator B" });
  const bundle = mergeTrust(SHIPPED_TRUST_BUNDLE, [trustExtra([A, B])]);
  const record = {
    schema: "pr-rla/registration/v2",
    registeredAt: o.claimed,
    window: { name: "w", start: "2026-07-01", end: "2026-09-30", opensAt: "2026-07-01T00:00:00Z", closesAt: "2026-10-01T00:00:00Z" },
    beacon: beaconParams(),
    plugins: { provider: { name: "p", source: "builtin" }, ledger: { name: "l", source: "builtin" } },
    verdicts: { minProvenance: "self-asserted" },
    prRlaVersion: "x",
    protocolSha256: "0".repeat(64),
    timestamping: { authorities: ["test-a", "test-b"], minTokens: 2, toleranceSeconds: o.toleranceSeconds, defaultAccuracySeconds: 60 },
  } as unknown as RegistrationRecordV2;
  const data = new Uint8Array(Buffer.from(canonicalJson(record)));
  const digestHex = createHash("sha256").update(data).digest("hex");
  const real = new Date(o.genTime);
  const ev = async (a: typeof A): Promise<TimestampEvidence> => {
    const der = tokenOf(await mintResponse(a, { digestHex, nonceHex: "1122334455667788", genTime: real, ...(o.accuracySeconds !== undefined ? { accuracySeconds: o.accuracySeconds } : {}) }));
    const { facts } = readToken(der);
    return { kind: "rfc3161", tsa: a.id, url: "x", tokenDer: Buffer.from(der).toString("base64"), genTime: isoMs(facts.genTimeMs), accuracySeconds: facts.accuracySeconds, serial: facts.serial, nonce: "1122334455667788" };
  };
  const reg = { record, sha256: digestHex, signature: "", publicKeyPem: "", log: null, timestamps: [await ev(A), await ev(B)] } as SignedRecord<RegistrationRecordV2>;
  const rep = await verifyAudit({ registration: reg, manifest: null, commitment: null, draws: null, currentProtocolSha256: null }, { provider: null, ledger: null, beacon: async () => null, logKey: async () => null, trustBundle: bundle });
  return { reg, rep };
}

describe("a registration proven to exist only after R was public", () => {
  it("does not PASS check 3 when the record widens its own tolerance (400 days after R)", async () => {
    const { reg, rep } = await build({ toleranceSeconds: 1e9, claimed: "2026-06-01T00:00:00Z", genTime: "2027-12-01T00:00:00Z" });
    expect(derivedRoundFor(reg).publishesAt * 1000).toBeLessThan(Date.parse("2027-12-01T00:00:00Z") - 300 * 86400_000);
    expect(rep.checks[0]!.details.join("\n")).toMatch(/a record does not set its own/);
    expect(rep.checks[2]!.status).not.toBe("PASS");
    expect(rep.timestamps.registration?.proven).toBe(false);
  });

  it("FAILs check 1 for any record-stated tolerance other than the verifier's, even a narrower one", async () => {
    const { rep } = await build({ toleranceSeconds: 5, claimed: "2026-06-01T00:00:00Z", genTime: "2026-06-01T00:00:01Z" });
    expect(rep.checks[0]!.status).toBe("FAIL");
    // (The hand-built envelope carries no signature, so check 1 FAILs anyway: the reason is what is asserted.)
    expect(rep.checks[0]!.details.join("\n")).toMatch(/FAIL registration: the record states a clock tolerance of 5 s and a default accuracy of 60 s; this verifier holds 600 s and 60 s/);
    expect(rep.timestamps.registration?.proven).toBe(false);
  });

  it("FAILs check 3 when the tolerance is the verifier's but the tokens' upper bound is after R published", async () => {
    // genTime agrees with the claimed time, but the tokens state an accuracy of 46 days: U_k lands after round R.
    const { rep } = await build({ toleranceSeconds: 600, claimed: "2026-09-25T00:00:00Z", genTime: "2026-09-25T00:00:00Z", accuracySeconds: 4_000_000 });
    expect(rep.timestamps.registration?.proven).toBe(true);
    expect(rep.checks[2]!.status).toBe("FAIL");
    expect(rep.checks[2]!.summary).toMatch(/the registration was proven to exist only after round R was public/);
  });

  it("still lets an honest registration through check 3 (control)", async () => {
    const { rep } = await build({ toleranceSeconds: 600, claimed: "2026-06-01T00:00:00Z", genTime: "2026-06-01T00:00:02Z" });
    expect(rep.timestamps.registration?.proven).toBe(true);
    expect(rep.checks[2]!.status).toBe("PASS");
  });
});
