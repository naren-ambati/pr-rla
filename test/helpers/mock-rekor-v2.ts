import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalJson } from "../../src/core/canonical.js";
import { inclusionPath, leafHash, treeHead } from "../../src/translog/merkle.js";
import { noteKeyId } from "../../src/translog/rekor-v2.js";

/**
 * A local stand-in for a Rekor v2 (rekor-tiles) log: POST /api/v2/log/entries for
 * hashedrekord v0.0.2, real RFC 6962 proofs and a C2SP signed-note checkpoint.
 * Built from the documented shapes; it is the only Rekor v2 server pr-rla has
 * ever talked to.
 */
export class MockRekorV2 {
  private server: Server | null = null;
  private readonly bodies: Buffer[] = [];
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly origin = "mock-rekor-v2.example/log";
  url = "";
  requests: { method: string; path: string; body: string }[] = [];

  constructor(readonly keyType: "ec" | "ed25519" = "ec") {
    const { privateKey } = keyType === "ec" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
    this.privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  }

  checkpoint(size: number, root: Uint8Array): string {
    const text = `${this.origin}\n${size}\n${Buffer.from(root).toString("base64")}\n`;
    const key = createPrivateKey(this.privateKeyPem);
    const sig = this.keyType === "ed25519" ? sign(null, Buffer.from(text), key) : sign("sha256", Buffer.from(text), key);
    const name = this.origin;
    return `${text}\n— ${name} ${Buffer.concat([Buffer.from(noteKeyId(name, this.publicKeyPem)), sig]).toString("base64")}\n`;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "", path: req.url ?? "", body: data });
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST" || req.url !== "/api/v2/log/entries") return send(404, { message: "not found" });
        let r: { hashedRekordRequestV002?: { digest?: string; signature?: { content?: string; verifier?: { publicKey?: { rawBytes?: string }; keyDetails?: string } } } };
        try {
          r = JSON.parse(data);
        } catch {
          return send(400, { message: "bad json" });
        }
        const h = r.hashedRekordRequestV002;
        if (!h?.digest || !h.signature?.content || !h.signature.verifier?.publicKey?.rawBytes) return send(400, { message: "unsupported entry" });
        const body = Buffer.from(
          canonicalJson({ apiVersion: "0.0.2", kind: "hashedrekord", spec: { hashedRekordV002: { data: { algorithm: "SHA2_256", digest: h.digest }, signature: { content: h.signature.content, verifier: { keyDetails: h.signature.verifier.keyDetails, publicKey: { rawBytes: h.signature.verifier.publicKey.rawBytes } } } } } }),
        );
        this.bodies.push(body);
        const i = this.bodies.length - 1;
        const leaves = this.bodies.map((b) => leafHash(new Uint8Array(b)));
        const root = treeHead(leaves);
        send(201, {
          logIndex: String(i),
          logId: { keyId: createHash("sha256").update(this.publicKeyPem).digest("base64") },
          kindVersion: { kind: "hashedrekord", version: "0.0.2" },
          integratedTime: "0",
          inclusionProof: { logIndex: String(i), rootHash: Buffer.from(root).toString("base64"), treeSize: String(leaves.length), hashes: inclusionPath(i, leaves).map((x) => Buffer.from(x).toString("base64")), checkpoint: { envelope: this.checkpoint(leaves.length, root) } },
          canonicalizedBody: body.toString("base64"),
        });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
  }
}
