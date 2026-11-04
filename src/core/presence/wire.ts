/**
 * The SSH wire encoding (RFC 4251 §5) that SSHSIG blobs, public keys and signatures use:
 * `byte`, `uint32` (big-endian), `string` (uint32 length, then the bytes) and `mpint`.
 * Pure: no I/O.
 */

export class SshFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshFormatError";
  }
}

/** Reads SSH wire fields in order; every read past the end throws, and `end()` refuses trailing bytes. */
export class SshReader {
  private off = 0;
  constructor(
    private readonly buf: Uint8Array,
    private readonly what: string,
  ) {}

  get remaining(): number {
    return this.buf.length - this.off;
  }

  bytes(n: number): Uint8Array {
    if (n < 0 || this.off + n > this.buf.length) throw new SshFormatError(`${this.what} is truncated`);
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  u8(): number {
    return this.bytes(1)[0]!;
  }

  u32(): number {
    const b = this.bytes(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }

  string(): Uint8Array {
    return this.bytes(this.u32());
  }

  /** A string holding text (names, namespaces): must be valid UTF-8. */
  text(): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.string());
    } catch (e) {
      if (e instanceof SshFormatError) throw e;
      throw new SshFormatError(`${this.what} holds a name that is not UTF-8`);
    }
  }

  /** An unsigned mpint, as big-endian magnitude bytes without leading zeros. Negative values are refused. */
  unsignedMpint(): Uint8Array {
    const b = this.string();
    if (b.length > 0 && (b[0]! & 0x80) !== 0) throw new SshFormatError(`${this.what} holds a negative integer`);
    let i = 0;
    while (i < b.length && b[i] === 0) i++;
    return b.subarray(i);
  }

  end(): void {
    if (this.remaining !== 0) throw new SshFormatError(`${this.what} has ${this.remaining} unexpected trailing byte(s)`);
  }
}

export function u32be(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** An SSH `string`: uint32 length, then the bytes (text is encoded as UTF-8). */
export function sshString(value: Uint8Array | string): Uint8Array {
  const b = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return concatBytes(u32be(b.length), b);
}

/** Left-pads (or refuses) a big-endian magnitude to exactly `size` bytes. */
export function fixedWidth(magnitude: Uint8Array, size: number, what: string): Uint8Array {
  if (magnitude.length > size) throw new SshFormatError(`${what} is longer than ${size} bytes`);
  const out = new Uint8Array(size);
  out.set(magnitude, size - magnitude.length);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
