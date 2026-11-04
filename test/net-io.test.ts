import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../src/cli/exit-codes.js";
import { writeFileAtomic } from "../src/io/atomic.js";
import { PR_RLA_VERSION } from "../src/version.js";

describe("the network-deny harness (NFR11)", () => {
  it("refuses a connection to any real host, a Rekor log included", async () => {
    for (const url of ["https://rekor.sigstore.dev/api/v1/log", "https://log2025-1.rekor.sigstore.dev/api/v2/log/entries", "https://timestamp.sigstore.dev/api/v1/timestamp", "https://api.drand.sh/info"]) {
      const err = (await fetch(url).catch((e: unknown) => e)) as Error & { cause?: Error };
      expect(err).toBeInstanceOf(Error);
      expect(String(err.cause?.message ?? err.message)).toMatch(/network-deny: test tried to connect to /);
    }
    const denied = (globalThis as { __prrlaDeniedConnections?: string[] }).__prrlaDeniedConnections!;
    expect(denied).toEqual(expect.arrayContaining(["rekor.sigstore.dev", "log2025-1.rekor.sigstore.dev"]));
    denied.length = 0; // these four were deliberate; the harness fails a file that leaves any behind
  });

  it("no source file names a default Rekor log", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const hits = walk(join(__dirname, "..", "src")).filter((f) => /rekor\.sigstore\.dev/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("atomic writes (NFR15) and the exit-code contract", () => {
  it("replaces a file whole, and leaves the old one intact when the write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "prrla-atomic-"));
    const p = join(dir, "record.json");
    writeFileAtomic(p, "old\n");
    writeFileAtomic(p, "new\n");
    expect(readFileSync(p, "utf8")).toBe("new\n");
    expect(() => writeFileAtomic(p, { length: 3 } as unknown as Uint8Array)).toThrow();
    expect(readFileSync(p, "utf8")).toBe("new\n");
    expect(readdirSync(dir)).toEqual(["record.json"]);
    writeFileSync(join(dir, "x"), "");
    expect(existsSync(join(dir, "x"))).toBe(true);
  });

  it("codes 0–5 keep their meaning; 5 is a record written without enough timestamps; 6 is verify INCOMPLETE (U8)", () => {
    expect(EXIT).toEqual({ OK: 0, FAIL: 1, ESCALATE: 2, BELOW_MINIMUM: 3, STOPPED: 4, TIMESTAMPS_SHORT: 5, INCOMPLETE: 6 });
  });

  it("the version constant matches package.json", () => {
    expect(PR_RLA_VERSION).toBe((JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string }).version);
  });
});
