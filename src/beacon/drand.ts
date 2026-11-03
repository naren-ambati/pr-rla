import { fetchBeacon, type Chain, type ChainClient, type ChainInfo, type ChainOptions, type RandomnessBeacon } from "drand-client";
import { QUICKNET, roundPublishTime } from "../core/seed.js";

/** Pinned quicknet chain info. The trust anchor is this constant, not anything fetched. */
export const QUICKNET_CHAIN_INFO: ChainInfo = {
  public_key: QUICKNET.publicKey,
  period: QUICKNET.period,
  genesis_time: QUICKNET.genesis,
  hash: QUICKNET.chainHash,
  groupHash: QUICKNET.groupHash,
  schemeID: QUICKNET.schemeID,
  metadata: { beaconID: "quicknet" },
};

/** Public HTTP relays for quicknet (read-only). */
export const DRAND_RELAYS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"];

export interface Beacon {
  round: number;
  randomness: string;
  signature: string;
}

/**
 * A ChainClient that serves exactly one already-fetched beacon. Passing it to
 * drand-client's `fetchBeacon` runs the library's own verification
 * (BLS on G1, RFC 9380 DST, randomness == SHA-256(signature), expected round)
 * against the pinned chain info, with no network access.
 */
class FixedBeaconClient implements ChainClient {
  options: ChainOptions = { disableBeaconVerification: false, noCache: true };
  constructor(private readonly beacon: Beacon) {}
  async latest(): Promise<RandomnessBeacon> {
    return { ...this.beacon } as RandomnessBeacon;
  }
  async get(): Promise<RandomnessBeacon> {
    return { ...this.beacon } as RandomnessBeacon;
  }
  chain(): Chain {
    return { baseUrl: "pinned:quicknet", info: async () => QUICKNET_CHAIN_INFO };
  }
}

/** Verifies a quicknet beacon for `expectedRound` with drand-client 1.4.2. */
export async function verifyQuicknetBeacon(beacon: Beacon, expectedRound: number): Promise<boolean> {
  if (beacon.round !== expectedRound) return false;
  const origError = console.error;
  console.error = () => {}; // drand-client logs its reason before returning false; we report our own.
  try {
    await fetchBeacon(new FixedBeaconClient(beacon), expectedRound);
    return true;
  } catch {
    return false;
  } finally {
    console.error = origError;
  }
}

export class RoundNotYetPublished extends Error {
  constructor(readonly round: number, readonly publishesAt: number) {
    super(`drand quicknet round ${round} publishes at ${new Date(publishesAt * 1000).toISOString()}; not yet available`);
    this.name = "RoundNotYetPublished";
  }
}

/** Fetches round R from public relays and verifies it before returning. */
export async function fetchQuicknetBeacon(round: number, opts: { fetch?: typeof fetch; relays?: string[]; nowUnix?: number } = {}): Promise<Beacon> {
  const f = opts.fetch ?? fetch;
  const now = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const publishesAt = roundPublishTime(round);
  if (now < publishesAt) throw new RoundNotYetPublished(round, publishesAt);
  const errors: string[] = [];
  for (const relay of opts.relays ?? DRAND_RELAYS) {
    const url = `${relay}/${QUICKNET.chainHash}/public/${round}`;
    try {
      const res = await f(url, { headers: { accept: "application/json", "user-agent": "pr-rla/0.1" } });
      if (!res.ok) {
        errors.push(`${relay}: HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as Partial<Beacon>;
      const beacon: Beacon = { round: Number(body.round), randomness: String(body.randomness), signature: String(body.signature) };
      if (!(await verifyQuicknetBeacon(beacon, round))) {
        errors.push(`${relay}: beacon failed BLS verification`);
        continue;
      }
      return beacon;
    } catch (e) {
      errors.push(`${relay}: ${(e as Error).message}`);
    }
  }
  throw new Error(`could not fetch a valid quicknet round ${round}: ${errors.join("; ")}`);
}
