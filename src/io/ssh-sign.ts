import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERDICT_NAMESPACE,
  describeSigner,
  parsePublicKeyText,
  provenanceLabel,
  signatureProvenance,
  signersFor,
  signVerdict,
  type AllowedSigner,
  type SshPublicKey,
  type VerdictPayloadFields,
} from "../core/presence/index.js";

/**
 * `pr-rla record --sign <key>` (U9, after review): the reviewer's own `ssh-keygen -Y sign` over the
 * verdict's bytes, in namespace `pr-rla-verdict@v1`. A security key asks for its touch then, once for
 * this one verdict. Nothing here is needed to sign by hand: the README gives the bytes and the command.
 */

/** Signs `payload` as a reviewer would by hand: the bytes in a file, `ssh-keygen -Y sign -n pr-rla-verdict@v1 -f <key> <file>`. Returns the armored SSHSIG. */
export function sshKeygenSign(payload: Uint8Array, keyPath: string, env: Readonly<Record<string, string | undefined>>, log: (line: string) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pr-rla-sign-"));
  const file = join(dir, "verdict");
  writeFileSync(file, payload);
  return new Promise<string>((done, fail) => {
    // ssh-keygen's own messages (the touch request among them) reach the reviewer as they come.
    const child = spawn("ssh-keygen", ["-Y", "sign", "-n", VERDICT_NAMESPACE, "-f", keyPath, file], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
      const lines = err.split("\n");
      err = lines.pop()!;
      for (const l of lines) if (l.trim()) log(`ssh-keygen: ${l}`);
    });
    child.on("error", (e) => fail(new Error(`ssh-keygen could not run (${e.message}); sign the verdict's bytes by hand instead (README, "Signed verdicts")`)));
    child.on("close", (code) => {
      if (err.trim()) log(`ssh-keygen: ${err}`);
      if (code !== 0) return fail(new Error(`ssh-keygen -Y sign exited ${code}: the verdict was not recorded`));
      try {
        done(readFileSync(`${file}.sig`, "utf8"));
      } catch (e) {
        fail(new Error(`ssh-keygen wrote no signature (${(e as Error).message})`));
      }
    });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** The public key of the key `--sign` names: `<key>.pub` beside a private key, or the file itself when it is a public key. */
export function signingPublicKey(keyPath: string): SshPublicKey {
  const candidates = [`${keyPath}.pub`, keyPath];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    const [type, b64] = readFileSync(f, "utf8").trim().split(/\s+/);
    if (type && b64 && !type.startsWith("-----"))
      try {
        return parsePublicKeyText(type, b64);
      } catch (e) {
        throw new Error(`${f}: ${(e as Error).message}`);
      }
  }
  throw new Error(`--sign ${keyPath}: no public key found (expected ${keyPath}.pub next to the private key, or a .pub file)`);
}

/**
 * The registered reviewer `--sign <key>` signs as: the one allowed signer holding that key. A
 * `--reviewer` that names someone else is refused, since the signature would not count for them.
 */
export function signingReviewer(keyPath: string, signers: readonly AllowedSigner[], reviewer: string | undefined): { principal: string; signer: AllowedSigner } {
  const key = signingPublicKey(keyPath);
  const holder = signersFor(key, signers)[0];
  if (!holder) throw new Error(`--sign ${keyPath}: key ${key.fingerprint} (${key.type}) is not among this registration's allowed signers (${signers.map(describeSigner).join(", ")})`);
  const principal = holder.principals[0]!;
  if (reviewer !== undefined && reviewer !== principal) throw new Error(`--reviewer ${reviewer}, but key ${key.fingerprint} is registered to ${principal}; record as ${principal}, or sign with ${reviewer}'s key`);
  return { principal, signer: holder };
}

export interface VerdictSigner {
  /** The registered principal the key belongs to: the verdict's reviewer. */
  principal: string;
  /** Signs one verdict and checks it as verify will: the line fields to add, and a line for the reviewer. */
  sign(fields: VerdictPayloadFields): Promise<{ fields: { registrationSha256: string; sshsig: string }; line: string }>;
}

/**
 * What `record --sign <key>` signs with: the registered reviewer holding the key, and ssh-keygen (or
 * an injected signer, for tests). Throws when the key is not registered or names another reviewer.
 */
export function verdictSigner(o: {
  keyPath: string;
  signers: readonly AllowedSigner[];
  reviewer?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
  sign?: ((payload: Uint8Array, keyPath: string) => Promise<string>) | undefined;
}): VerdictSigner {
  const { principal, signer } = signingReviewer(o.keyPath, o.signers, o.reviewer);
  const sign = o.sign ?? ((p: Uint8Array, k: string) => sshKeygenSign(p, k, o.env, o.log));
  return {
    principal,
    async sign(fields) {
      if (signer.key.securityKey) o.log(`touch your security key to sign this one verdict (${signer.key.fingerprint})`);
      const s = await signVerdict(fields, o.signers, (payload) => sign(payload, o.keyPath));
      return { fields: { registrationSha256: s.registrationSha256, sshsig: s.sshsig }, line: `signed: the verdict ${s.check.detail}: ${provenanceLabel(signatureProvenance(s.check)!.level)}` };
    },
  };
}
