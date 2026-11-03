import { createServer, type Server } from "node:http";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { canonicalJson, sha256Hex } from "../../src/core/canonical.js";
import { inclusionPath, leafHash, treeHead } from "../../src/translog/merkle.js";
import { setPayload } from "../../src/translog/rekor.js";

/** A local, in-memory stand-in for a Rekor v1 log: hashedrekord only, real Merkle proofs and SETs. */
export class MockRekor {
  private server: Server | null = null;
  private readonly bodies: Buffer[] = [];
  private readonly meta: { integratedTime: number; uuid: string }[] = [];
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly logID: string;
  /** Unix seconds the log stamps on the next entry. */
  now = Math.floor(Date.now() / 1000);
  url = "";
  requests: { method: string; path: string }[] = [];

  constructor() {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    this.logID = sha256Hex(this.publicKeyPem);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.requests.push({ method: req.method ?? "", path: req.url ?? "" });
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const send = (status: number, body: unknown, type = "application/json") => {
          res.writeHead(status, { "content-type": type });
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        };
        if (req.method === "GET" && req.url === "/api/v1/log/publicKey") return send(200, this.publicKeyPem, "application/x-pem-file");
        if (req.method === "POST" && req.url === "/api/v1/log/entries") {
          let entry: { kind?: string; spec?: { data?: { hash?: { value?: string } } } };
          try {
            entry = JSON.parse(data);
          } catch {
            return send(400, { message: "bad json" });
          }
          if (entry.kind !== "hashedrekord" || !entry.spec?.data?.hash?.value) return send(400, { message: "unsupported entry" });
          const body = Buffer.from(canonicalJson(entry));
          const uuid = Buffer.from(leafHash(new Uint8Array(body))).toString("hex");
          if (this.meta.some((m) => m.uuid === uuid)) return send(409, { message: "entry already exists" });
          this.bodies.push(body);
          this.meta.push({ integratedTime: this.now, uuid });
          return send(201, this.entryResponse(this.bodies.length - 1));
        }
        const m = req.url?.match(/^\/api\/v1\/log\/entries\/([0-9a-f]+)$/);
        if (req.method === "GET" && m) {
          const i = this.meta.findIndex((x) => x.uuid === m[1]);
          return i < 0 ? send(404, { message: "not found" }) : send(200, this.entryResponse(i));
        }
        send(404, { message: "not found" });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.url;
  }

  private entryResponse(i: number) {
    const leaves = this.bodies.map((b) => leafHash(new Uint8Array(b)));
    const body = this.bodies[i]!.toString("base64");
    const { integratedTime, uuid } = this.meta[i]!;
    const core = { body, integratedTime, logID: this.logID, logIndex: i };
    const signedEntryTimestamp = sign("sha256", Buffer.from(setPayload(core)), createPrivateKey(this.privateKeyPem)).toString("base64");
    const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
    return {
      [uuid]: {
        ...core,
        verification: {
          signedEntryTimestamp,
          inclusionProof: { logIndex: i, treeSize: leaves.length, rootHash: hex(treeHead(leaves)), hashes: inclusionPath(i, leaves).map(hex) },
        },
      },
    };
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }
}
