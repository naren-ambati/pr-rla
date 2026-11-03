import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { buildProgram } from "../src/cli.js";
import { nodeContext } from "../src/commands/context.js";
import { BrokerRetriesExhausted, BrokerTimeout, DESTINATION_TIMEOUT_MS, TSA_RETRY_DEADLINE_MS, type BrokerFetch } from "../src/net/contract.js";
import { HOST_SPACING_MS, createMinimalBroker } from "../src/net/minimal-adapter.js";
import { buildTimeStampReq, newNonce } from "../src/timestamp/client.js";
import { readJsonFixture } from "./helpers/fixtures.js";

const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe("FR1.1: what leaves the machine", () => {
  type Rec = { digest: string; nonces: Record<string, string>; authorities: Record<string, { request: string }> };
  const rec = readJsonFixture<Rec>("tsa", "recorded-2026-11-03.json");

  it.each(Object.keys(rec.authorities))("the request recorded for %s holds only version, the SHA-256 digest, the nonce and certReq", (id) => {
    const der = new Uint8Array(Buffer.from(rec.authorities[id]!.request, "base64"));
    const seq = asn1js.fromBER(ab(der)).result as asn1js.Sequence;
    // TimeStampReq ::= SEQUENCE { version, messageImprint, reqPolicy OPTIONAL, nonce OPTIONAL, certReq DEFAULT FALSE, extensions [0] OPTIONAL }
    expect(seq.valueBlock.value.map((v) => v.constructor.name)).toEqual(["Integer", "Sequence", "Integer", "Boolean"]);
    const req = pkijs.TimeStampReq.fromBER(ab(der));
    expect(req.version).toBe(1);
    expect(req.messageImprint.hashAlgorithm.algorithmId).toBe("2.16.840.1.101.3.4.2.1");
    expect(Buffer.from(req.messageImprint.hashedMessage.valueBlock.valueHexView).toString("hex")).toBe(rec.digest);
    expect(Buffer.from(req.nonce!.valueBlock.valueHexView).toString("hex")).toBe(rec.nonces[id]);
    expect(req.certReq).toBe(true);
    expect(req.reqPolicy).toBeUndefined();
    expect(req.extensions).toBeUndefined();
    expect(der.length).toBeLessThan(70);
  });

  it("nonces are 64-bit positive integers, fresh each time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = newNonce();
      expect(n.length).toBe(8);
      expect(n[0]! & 0x80).toBe(0);
      expect(n[0]).not.toBe(0);
      seen.add(Buffer.from(n).toString("hex"));
    }
    expect(seen.size).toBe(200);
    expect(() => buildTimeStampReq("abc", newNonce())).toThrow(/SHA-256 digest/);
  });
});

describe("the minimal broker adapter's tsa policy (contracts.md §2)", () => {
  const init = { method: "POST", pluginId: "pr-rla/timestamp", destination: "tsa" as const };

  it("uses the contract's timeouts: 15 s per timestamp request, a 5-minute retry deadline", () => {
    expect(DESTINATION_TIMEOUT_MS).toEqual({ scm: 30_000, tsa: 15_000, beacon: 15_000, rekor: 30_000 });
    expect(TSA_RETRY_DEADLINE_MS).toBe(300_000);
    expect(HOST_SPACING_MS).toEqual({ "timestamp.sectigo.com": 15_000, "freetsa.org": 1_000 });
  });

  it("retries 5xx and network errors with backoff, and starts no attempt after 5 minutes (fake clock)", async () => {
    let now = 1_000_000;
    const starts: number[] = [];
    const broker = createMinimalBroker({
      now: () => now,
      sleep: async (ms) => void (now += ms),
      random: () => 0.999,
      fetch: (async () => {
        starts.push(now);
        now += 1500; // each attempt takes 1.5 s
        if (starts.length % 2) throw new TypeError("fetch failed");
        return new Response("busy", { status: 503 });
      }) as typeof fetch,
    });
    const err = await broker("https://tsa.example/", init).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerRetriesExhausted);
    const last = starts.at(-1)! - starts[0]!;
    expect(last).toBeLessThanOrEqual(300_000);
    expect(last).toBeGreaterThan(240_000); // it kept trying for most of the deadline
    expect(starts.length).toBeGreaterThan(10);
    expect((err as BrokerRetriesExhausted).message).toMatch(/tsa\.example: gave up after \d+ attempt\(s\) in \d+ s/);
  });

  it("does not retry a 4xx, and returns a success at once", async () => {
    let calls = 0;
    const broker = createMinimalBroker({ fetch: (async () => (calls++, new Response("no", { status: 400 }))) as typeof fetch, sleep: async () => {} });
    expect((await broker("https://tsa.example/", init)).status).toBe(400);
    expect(calls).toBe(1);
  });

  it("honours Retry-After on 429", async () => {
    let now = 0;
    const waits: number[] = [];
    let calls = 0;
    const broker = createMinimalBroker({ now: () => now, sleep: async (ms) => void (waits.push(ms), (now += ms)), fetch: (async () => (++calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : new Response("ok"))) as typeof fetch });
    expect((await broker("https://tsa.example/", init)).status).toBe(200);
    expect(waits).toEqual([7000]);
  });

  it("spaces requests to Sectigo by 15 s and to FreeTSA by 1 s", async () => {
    let now = 0;
    const at: Record<string, number[]> = {};
    const broker = createMinimalBroker({ now: () => now, sleep: async (ms) => void (now += ms), fetch: (async (u: URL) => ((at[u.hostname] ??= []).push(now), new Response("ok"))) as unknown as typeof fetch });
    for (let i = 0; i < 3; i++) {
      await broker("https://timestamp.sectigo.com", init);
      await broker("https://freetsa.org/tsr", init);
    }
    const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);
    expect(Math.min(...gaps(at["timestamp.sectigo.com"]!))).toBeGreaterThanOrEqual(15_000);
    expect(Math.min(...gaps(at["freetsa.org"]!))).toBeGreaterThanOrEqual(1_000);
  });

  describe("against a hanging local server", () => {
    let server: Server;
    let url = "";
    const hanging: import("node:http").ServerResponse[] = [];
    beforeAll(async () => {
      server = createServer((_req, res) => void hanging.push(res));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });
    afterAll(async () => {
      for (const r of hanging) r.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    });

    it("an attempt is aborted at its destination timeout (BrokerTimeout), then retried", async () => {
      const broker: BrokerFetch = createMinimalBroker({ timeouts: { tsa: 150, scm: 150 }, tsaDeadlineMs: 5000, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) });
      const scm = await broker(url, { pluginId: "x", destination: "scm" }).catch((e: unknown) => e);
      expect(scm).toBeInstanceOf(BrokerTimeout);
      expect((scm as BrokerTimeout).message).toMatch(/no response within 0\.15 s \(scm\)/);
      const before = hanging.length;
      const tsa = await broker(url, init).catch((e: unknown) => e);
      expect(tsa).toBeInstanceOf(BrokerRetriesExhausted);
      expect(hanging.length - before).toBeGreaterThan(1);
    });
  });
});

describe("FR1.10: tokens cannot be added later", () => {
  it("no command has a --retry-timestamps option", () => {
    const program = buildProgram(() => nodeContext(), () => {});
    const options = program.commands.flatMap((c) => c.options.map((o) => o.long));
    expect(options).toContain("--tsa-trust");
    expect(options).not.toContain("--retry-timestamps");
    expect(options.filter((o) => /retry|timestamp/i.test(o ?? ""))).toEqual([]);
  });
});
