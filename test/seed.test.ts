import { describe, expect, it } from "vitest";
import { verifyQuicknetBeacon } from "../src/beacon/drand.js";
import { sha256Hex } from "../src/core/canonical.js";
import { computeDraws, deriveSeedRound, drawIndex, firstRoundAtOrAfter, roundPublishTime } from "../src/core/seed.js";
import { recordedBeacon } from "./helpers/fixtures.js";

const unix = (iso: string) => Date.parse(iso) / 1000;

describe("drand quicknet round derivation", () => {
  it("rounds publish at 1692803367 + 3*(R-1)", () => {
    expect(roundPublishTime(1)).toBe(1692803367);
    expect(roundPublishTime(1000000)).toBe(1692803367 + 3 * 999999);
  });

  it("first round at or after t", () => {
    const t = roundPublishTime(500);
    expect(firstRoundAtOrAfter(t)).toBe(500);
    expect(firstRoundAtOrAfter(t + 1)).toBe(501);
    expect(firstRoundAtOrAfter(t - 1)).toBe(500);
  });

  it("prospective: R is 24 h after the window close", () => {
    const R = deriveSeedRound({ windowClosesAt: unix("2026-10-01T00:00:00Z"), registeredAt: unix("2026-06-20T00:00:00Z") });
    expect(R).toBe(32698612);
    expect(roundPublishTime(R)).toBe(unix("2026-10-02T00:00:00Z"));
  });

  it("retrospective: R is 24 h after the registration", () => {
    const R = deriveSeedRound({ windowClosesAt: unix("2026-10-01T00:00:00Z"), registeredAt: unix("2026-10-20T00:00:00Z") });
    expect(R).toBe(33245812);
    expect(roundPublishTime(R) - unix("2026-10-20T00:00:00Z")).toBe(86400);
  });
});

describe("BLS verification of recorded rounds (offline, drand-client 1.4.2)", () => {
  for (const round of [1000000, 32698612, 33245812, 33244800]) {
    it(`round ${round} verifies`, async () => {
      expect(await verifyQuicknetBeacon(recordedBeacon(round), round)).toBe(true);
    });
  }

  it("a beacon with a flipped signature byte fails", async () => {
    const b = recordedBeacon(33245812);
    const sig = b.signature.slice(0, 10) + (b.signature[10] === "0" ? "1" : "0") + b.signature.slice(11);
    expect(await verifyQuicknetBeacon({ ...b, signature: sig, randomness: sha256Hex(Buffer.from(sig, "hex")) }, 33245812)).toBe(false);
  });

  it("randomness that does not match the signature fails", async () => {
    const b = recordedBeacon(33245812);
    expect(await verifyQuicknetBeacon({ ...b, randomness: "00".repeat(32) }, 33245812)).toBe(false);
  });

  it("a real beacon presented as a different round fails", async () => {
    const b = recordedBeacon(33244800);
    expect(await verifyQuicknetBeacon({ ...b, round: 33245812 }, 33245812)).toBe(false);
  });
});

describe("draws", () => {
  const randomness = recordedBeacon(33245812).randomness;
  const manifest = sha256Hex("example manifest");

  it("index = SHA-256(randomness || manifest-hash || uint64be(i)) mod N", () => {
    const buf = Buffer.concat([Buffer.from(randomness, "hex"), Buffer.from(manifest, "hex"), Buffer.from([0, 0, 0, 0, 0, 0, 0, 7])]);
    const expected = Number(BigInt("0x" + sha256Hex(buf)) % 1590n);
    expect(drawIndex(randomness, manifest, 7, 1590)).toBe(expected);
  });

  it("is reproducible and depends on every input", () => {
    const a = computeDraws(randomness, manifest, 1590, 144);
    expect(computeDraws(randomness, manifest, 1590, 144)).toEqual(a);
    expect(computeDraws(randomness, sha256Hex("other"), 1590, 144)).not.toEqual(a);
    expect(computeDraws(recordedBeacon(33244800).randomness, manifest, 1590, 144)).not.toEqual(a);
    expect(a.every((d) => d.index >= 0 && d.index < 1590)).toBe(true);
    expect(a.map((d) => d.draw)).toEqual(Array.from({ length: 144 }, (_, i) => i + 1));
  });

  it("golden values (any reimplementation must match)", () => {
    const g = computeDraws(recordedBeacon(33245812).randomness, sha256Hex("pr-rla golden manifest"), 400, 5).map((d) => d.index);
    expect(g).toMatchSnapshot();
  });
});
