import { bytesToHex, hexToBytes, sha256Bytes } from "./canonical.js";

/** drand quicknet (League of Entropy), pinned. Never fetched from the network as a trust anchor. */
export const QUICKNET = {
  chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  publicKey:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  schemeID: "bls-unchained-g1-rfc9380",
  genesis: 1692803367,
  period: 3,
} as const;

/** Seconds between the later of (window close, registration) and the earliest usable round. */
export const SEED_DELAY_SECONDS = 24 * 60 * 60;

/** Unix seconds at which round R publishes: genesis + period * (R - 1). */
export function roundPublishTime(round: number): number {
  if (!Number.isInteger(round) || round < 1) throw new Error(`invalid round ${round}`);
  return QUICKNET.genesis + QUICKNET.period * (round - 1);
}

/** The first round whose publish time is >= t (unix seconds). */
export function firstRoundAtOrAfter(t: number): number {
  if (t <= QUICKNET.genesis) return 1;
  return Math.ceil((t - QUICKNET.genesis) / QUICKNET.period) + 1;
}

export interface SeedRoundInputs {
  /** Window close, unix seconds. */
  windowClosesAt: number;
  /** Registration time, unix seconds (the log's integratedTime when logged). */
  registeredAt: number;
}

/** R = first quicknet round publishing >= 24 h after the later of window close and registration. */
export function deriveSeedRound(inputs: SeedRoundInputs): number {
  const base = Math.max(inputs.windowClosesAt, inputs.registeredAt);
  return firstRoundAtOrAfter(base + SEED_DELAY_SECONDS);
}

const HEX32 = /^[0-9a-f]{64}$/;

function uint64be(i: number): Uint8Array {
  if (!Number.isSafeInteger(i) || i < 0) throw new Error(`draw number must be a non-negative safe integer: ${i}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(i), false);
  return b;
}

/**
 * Draw i (1-based): SHA-256(randomness || binding || uint64be(i)) read as a big-endian unsigned
 * 256-bit integer, mod N. `randomness` and `binding` are raw 32-byte values (64 lowercase hex
 * characters each, hex-decoded). Returns a 0-based index into the population's change ids in
 * canonical order (contracts.md §5, "Draws").
 *
 * The binding is the registration's sha256 for schema-v2 audits (`drawBinding` in records.ts), so
 * nothing chosen at freeze (frozenAt, the funnel, limitations, the pr-rla version, the provider's
 * self-description) can move a draw; v1 audits keep the manifest's sha256, as they were drawn.
 */
export function drawIndex(randomnessHex: string, bindingHex: string, i: number, N: number): number {
  if (!Number.isInteger(N) || N < 1) throw new Error(`population N must be >= 1 (got ${N})`);
  for (const [what, hex] of [["randomness", randomnessHex], ["draw binding", bindingHex]] as const)
    if (!HEX32.test(hex)) throw new Error(`the ${what} must be 32 bytes as 64 lowercase hex characters (got ${JSON.stringify(hex.slice(0, 70))})`);
  const digest = sha256Bytes(hexToBytes(randomnessHex), hexToBytes(bindingHex), uint64be(i));
  return Number(BigInt(`0x${bytesToHex(digest)}`) % BigInt(N));
}

export interface Draw {
  draw: number;
  index: number;
}

/** Draws 1..count: `drawIndex` for each. */
export function computeDraws(randomnessHex: string, bindingHex: string, N: number, count: number): Draw[] {
  const out: Draw[] = [];
  for (let i = 1; i <= count; i++) out.push({ draw: i, index: drawIndex(randomnessHex, bindingHex, i, N) });
  return out;
}

export function isoToUnix(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid timestamp ${iso}`);
  return Math.floor(ms / 1000);
}

export function unixToIso(t: number): string {
  return new Date(t * 1000).toISOString().replace(".000Z", "Z");
}
