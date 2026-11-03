import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pkijs from "pkijs";
import { canonicalJson } from "../src/core/canonical.js";
import { parseTimeStampResp } from "../src/timestamp/client.js";
import { readToken } from "../src/timestamp/verify.js";
import { readJsonFixture } from "./helpers/fixtures.js";
import { makeTestAuthority, mintResponse, tokenOf, type TestAlg } from "./helpers/test-tsa.js";

/**
 * The FR1.3 library evaluation, as executable criteria. pkijs 4.0.1 + asn1js 4.0.0
 * must parse TimeStampResp, TimeStampToken and CMS SignedData with signed attributes,
 * and verify the signature over the DER signedAttrs for RSA PKCS#1 v1.5, RSA-PSS and
 * ECDSA P-256 / P-384. The release-recency, advisory and size criteria are recorded
 * in BUILD-NOTES (they need the registry, so they are not re-checked offline).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Recorded = { record: unknown; digest: string; authorities: Record<string, { response: string }> };
const rec = readJsonFixture<Recorded>("tsa", "recorded-2026-11-03.json");
const data = new Uint8Array(Buffer.from(canonicalJson(rec.record)));
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function libraryVerifies(token: Uint8Array, signed: Uint8Array): Promise<boolean> {
  const ci = pkijs.ContentInfo.fromBER(ab(token));
  const sd = new pkijs.SignedData({ schema: ci.content });
  try {
    return (await sd.verify({ signer: 0, data: ab(signed), extendedMode: true })).signatureVerified === true;
  } catch {
    return false;
  }
}

/** Flips one bit in the signerInfo's signature value (the last bytes of the SignedData that are not certificates). */
function corruptSignature(token: Uint8Array): Uint8Array {
  const ci = pkijs.ContentInfo.fromBER(ab(token));
  const sd = new pkijs.SignedData({ schema: ci.content });
  const sig = new Uint8Array(sd.signerInfos[0]!.signature.valueBlock.valueHexView);
  const at = Buffer.from(token).lastIndexOf(Buffer.from(sig));
  const out = new Uint8Array(token);
  out[at + 7] = out[at + 7]! ^ 0x01;
  return out;
}

describe("FR1.3 library evaluation: pkijs + asn1js", () => {
  it("is pinned by exact version, with lockfile integrity (NFR22)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.pkijs).toBe("4.0.1");
    expect(pkg.dependencies.asn1js).toBe("4.0.0");
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, { version: string; integrity?: string }> };
    for (const [name, v] of [["pkijs", "4.0.1"], ["asn1js", "4.0.0"]] as const) {
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(v);
      expect(lock.packages[`node_modules/${name}`]?.integrity).toMatch(/^sha512-/);
    }
    const req = createRequire(import.meta.url);
    expect((JSON.parse(readFileSync(req.resolve("pkijs/package.json"), "utf8")) as { version: string }).version).toBe("4.0.1");
  });

  it("is ESM-importable on this Node (>= 22.13)", async () => {
    const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
    expect(major > 22 || (major === 22 && minor >= 13)).toBe(true);
    const mod = await import("pkijs");
    expect(typeof mod.TimeStampResp).toBe("function");
    expect(typeof (await import("asn1js")).fromBER).toBe("function");
  });

  it.each(Object.keys(rec.authorities))("parses the recorded %s TimeStampResp, its token and the CMS SignedData with signed attributes", (id) => {
    const resp = parseTimeStampResp(new Uint8Array(Buffer.from(rec.authorities[id]!.response, "base64")));
    expect(resp.status).toBe(0);
    const { facts, signedData } = readToken(resp.token!);
    expect(facts.imprintHex).toBe(rec.digest);
    expect(signedData.signerInfos[0]!.signedAttrs!.attributes.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ["digicert", "RSA PKCS#1 v1.5"],
    ["globalsign", "RSA PKCS#1 v1.5"],
    ["microsoft", "RSA PKCS#1 v1.5"],
    ["swisssign", "RSA PKCS#1 v1.5"],
    ["sectigo", "RSA PKCS#1 v1.5"],
    ["sigstore", "ECDSA P-384"],
    ["github", "ECDSA P-384"],
    ["freetsa", "ECDSA P-384"],
  ])("verifies %s's real token (%s) over the DER signedAttrs, and rejects it with one bit flipped", async (id) => {
    const token = parseTimeStampResp(new Uint8Array(Buffer.from(rec.authorities[id]!.response, "base64"))).token!;
    expect(await libraryVerifies(token, data)).toBe(true);
    expect(await libraryVerifies(corruptSignature(token), data)).toBe(false);
  });

  it.each(["ECDSA-P256", "RSA-PSS"] as TestAlg[])("verifies a synthetic %s token (no bundled authority uses it), and rejects a corrupted one", async (alg) => {
    const a = await makeTestAuthority({ id: `lib-${alg}`, alg });
    const signed = new TextEncoder().encode("a record");
    const digestHex = (await import("node:crypto")).createHash("sha256").update(signed).digest("hex");
    const token = tokenOf(await mintResponse(a, { digestHex, nonceHex: "0102030405060708", genTime: new Date("2026-11-03T00:00:00Z") }));
    expect(await libraryVerifies(token, signed)).toBe(true);
    expect(await libraryVerifies(corruptSignature(token), signed)).toBe(false);
  });
});
