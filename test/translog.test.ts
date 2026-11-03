import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateKey, signRecord } from "../src/core/signing.js";
import { inclusionPath, leafHash, treeHead, verifyInclusion } from "../src/translog/merkle.js";
import { buildHashedRekord, RekorClient, verifyLoggedEntry } from "../src/translog/rekor.js";
import { MockRekor } from "./helpers/mock-rekor.js";

describe("RFC 6962 inclusion proofs", () => {
  it("verify for every leaf of trees of size 1..17, and fail when tampered", () => {
    for (let n = 1; n <= 17; n++) {
      const leaves = Array.from({ length: n }, (_, i) => leafHash(Buffer.from(`leaf ${i}`)));
      const root = treeHead(leaves);
      for (let m = 0; m < n; m++) {
        const path = inclusionPath(m, leaves);
        expect(verifyInclusion(leaves[m]!, m, n, path, root)).toBe(true);
        if (n > 1) expect(verifyInclusion(leaves[(m + 1) % n]!, m, n, path, root)).toBe(false);
      }
    }
  });
});

describe("Rekor hashedrekord client (against a local mock log only)", () => {
  const log = new MockRekor();
  beforeAll(async () => void (await log.start()));
  afterAll(async () => log.stop());

  it("submits, re-fetches and verifies an entry", async () => {
    const key = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "prrla-")), "k.pem"));
    const signed = signRecord({ hello: "world", n: 1 }, key);
    const client = new RekorClient(log.url);
    log.now = 1792454400;
    const entry = await client.submit(buildHashedRekord(signed));
    expect(entry.integratedTime).toBe(1792454400);
    const logKey = await client.publicKey();
    expect(verifyLoggedEntry(entry, signed, logKey)).toEqual({ ok: true, problems: [] });
    const again = await client.getEntry(entry.uuid);
    expect(verifyLoggedEntry(again, signed, logKey).ok).toBe(true);

    // a second entry grows the tree; the first one's fresh proof still verifies
    await client.submit(buildHashedRekord(signRecord({ other: true }, key)));
    expect(verifyLoggedEntry(await client.getEntry(entry.uuid), signed, logKey).ok).toBe(true);
  });

  it("detects an edited integratedTime, a swapped record and a foreign log key", async () => {
    const key = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "prrla-")), "k.pem"));
    const signed = signRecord({ audit: "x" }, key);
    const client = new RekorClient(log.url);
    const entry = await client.submit(buildHashedRekord(signed));
    const logKey = await client.publicKey();
    expect(verifyLoggedEntry({ ...entry, integratedTime: entry.integratedTime - 86400 }, signed, logKey).problems.join()).toMatch(/signedEntryTimestamp/);
    expect(verifyLoggedEntry(entry, signRecord({ audit: "y" }, key), logKey).ok).toBe(false);
    expect(verifyLoggedEntry(entry, signed, new MockRekor().publicKeyPem).ok).toBe(false);
  });
});
