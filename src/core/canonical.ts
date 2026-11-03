import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace,
 * ECMAScript number and string serialization. For the value types pr-rla
 * writes (strings, finite numbers, booleans, null, arrays, plain objects)
 * this matches RFC 8785 (JCS). `undefined` object members are omitted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Bytes(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new Error(`not a hex string: ${hex.slice(0, 16)}…`);
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** SHA-256 of an object's canonical JSON, ignoring the listed top-level keys. */
export function hashCanonical(value: Record<string, unknown>, omit: string[] = []): string {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!omit.includes(k)) copy[k] = v;
  return sha256Hex(canonicalJson(copy));
}
