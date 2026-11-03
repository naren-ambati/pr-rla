import { createHash } from "node:crypto";

/** RFC 6962 / RFC 9162 Merkle tree hashing, as used by Rekor. */

function h(...parts: Uint8Array[]): Uint8Array {
  const x = createHash("sha256");
  for (const p of parts) x.update(p);
  return new Uint8Array(x.digest());
}

export function leafHash(data: Uint8Array): Uint8Array {
  return h(Uint8Array.of(0), data);
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return h(Uint8Array.of(1), left, right);
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** RFC 9162 section 2.1.3.2: verify an inclusion proof for a leaf hash. */
export function verifyInclusion(leaf: Uint8Array, index: number, size: number, proof: readonly Uint8Array[], root: Uint8Array): boolean {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && eq(r, root);
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

/** Merkle tree head over leaf hashes (RFC 6962 MTH). */
export function treeHead(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return h();
  if (leaves.length === 1) return leaves[0]!;
  const k = largestPowerOfTwoBelow(leaves.length);
  return nodeHash(treeHead(leaves.slice(0, k)), treeHead(leaves.slice(k)));
}

/** Audit path for leaf m (RFC 6962 PATH). */
export function inclusionPath(m: number, leaves: readonly Uint8Array[]): Uint8Array[] {
  if (leaves.length <= 1) return [];
  const k = largestPowerOfTwoBelow(leaves.length);
  if (m < k) return [...inclusionPath(m, leaves.slice(0, k)), treeHead(leaves.slice(k))];
  return [...inclusionPath(m - k, leaves.slice(k)), treeHead(leaves.slice(0, k))];
}
