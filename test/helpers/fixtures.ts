import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Beacon } from "../../src/beacon/drand.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

export function readJsonFixture<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(fixturePath(...parts), "utf8")) as T;
}

export function recordedBeacon(round: number): Beacon {
  return readJsonFixture<Beacon>("drand", `quicknet-${round}.json`);
}
