// Maintainer tool: rebuilds the timestamp-authority trust bundle (src/timestamp/trust-bundle.json)
// and prints a diff for human review. The CLI never runs it.
//
// Usage (after `npm run build`):
//   node scripts/update-trust-bundle.mjs [--recorded <tokens.json>] [--trusted-root <trusted_root.json>[#label]]... [--anchors <file.pem>[#label]]... [--write]
// A `#label` names the source in the bundle instead of the file path.
//
// Sources, per authority (ANCHOR_PLAN below says which one each uses):
//   token   the certificates in a fresh token response. Without --recorded, one token is requested from
//           every bundled authority over the SHA-256 of a fixed probe string: only that hash and a nonce
//           are sent. With --recorded, the responses come from a recorded fixture instead (no network).
//   system  an anchor found in a local root store: the macOS system roots keychain, Node's bundled
//           Mozilla roots, and any --anchors PEM file. Confirms the anchor independently of the token.
//   tuf     a Sigstore-format trusted_root.json (TUF target) given with --trusted-root, for authorities
//           whose tokens carry only the leaf (Sigstore, GitHub). This script does not run a TUF client:
//           pass files a TUF client already verified (npm's @sigstore/tuf seeds, gh's TUF cache).
//   tofu    no local source exists: the anchor is taken from the authority's own response
//           (trust on first use) and marked `independent: false` for review before a release.
//
// `issuing` names the operator's TSA issuing CA(s), pinned as `issuingCAs` where the anchor is a
// general-purpose root (DigiCert G4, GlobalSign R6, SwissSign's and GitHub's roots): only a signer
// issued directly by one of them counts as that operator. They come from the same token chain or TUF file.
//
// Anchors and intermediates are only ever added: with --write, certificates already in the bundle are kept.
import { X509Certificate, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as asn1js from "asn1js";
import { buildTimeStampReq, newNonce, parseTimeStampResp } from "../dist/timestamp/client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "src/timestamp/trust-bundle.json");
const VERSION = "2026-11";

/** The eight bundled authorities (functional-design.md §U1; draft 05 §U1 trust-bundle table). */
const ANCHOR_PLAN = {
  sigstore: {
    operator: "Sigstore",
    url: "https://timestamp.sigstore.dev/api/v1/timestamp",
    defaultEnabled: true,
    anchor: { tuf: "timestamp.sigstore.dev" },
    notes: "ECDSA P-384 key, SHA-256 signatures. Tokens carry only the leaf; the chain is pinned from Sigstore's TUF trusted_root.json. No GA announcement, rate limit or terms found (unverified).",
  },
  digicert: {
    operator: "DigiCert",
    url: "http://timestamp.digicert.com",
    defaultEnabled: true,
    anchor: { system: "DigiCert Trusted Root G4" },
    issuing: ["DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1"],
    notes: "RSA-4096, SHA-256. HTTP is acceptable: only a hash is sent and the response is verified by signature. States no accuracy (60 s default). ESSCertID v1 and v2. Rotates signer certificates at least every 15 months; intermediates are kept as historical.",
  },
  globalsign: {
    operator: "GlobalSign",
    url: "http://timestamp.globalsign.com/tsa/r45standard",
    defaultEnabled: true,
    anchor: { system: "GlobalSign Root CA - R6" },
    issuing: ["GlobalSign Offline R45 Timestamping CA 2025"],
    notes: "RSA-3072 key, SHA-384 signatures; accuracy 1 s. Chain: R45 timestamping CA, Timestamping Root R45 cross-signed by Root R6.",
  },
  microsoft: {
    operator: "Microsoft",
    url: "https://timestamp.acs.microsoft.com",
    defaultEnabled: true,
    anchor: { tofu: "Microsoft Public RSA Timestamping CA 2020" },
    notes: "RSA-4096, SHA-256; accuracy 500 ms. The root (Microsoft Identity Verification Root Certificate Authority 2020) is not in the token or in a local root store; the anchor is the token's intermediate, pinned on first use (independent: false) until the root is confirmed.",
  },
  github: {
    operator: "GitHub",
    url: "https://timestamp.githubapp.com/api/v1/timestamp",
    defaultEnabled: false,
    anchor: { tuf: "timestamp.githubapp.com" },
    issuing: ["TSA intermediate"],
    notes: "ECDSA P-384, SHA-384; accuracy 1 s. Tokens carry only the leaf; the chain is pinned from GitHub's TUF trusted_root.json. Off by default.",
  },
  swisssign: {
    operator: "SwissSign",
    url: "https://tsa.swisssign.net",
    defaultEnabled: false,
    anchor: { tofu: "SwissSign Signature Services Root 2020 - 2" },
    issuing: ["SwissSign Qualified TSA ICA 2021 - 1"],
    notes: "RSA-3072, SHA-256; accuracy 500 ms. Rejects SHA-384 requests (SHA-256 is used). Root not in a local store: pinned on first use. Off by default.",
  },
  sectigo: {
    operator: "Sectigo",
    url: "https://timestamp.sectigo.com",
    defaultEnabled: false,
    anchor: { system: "Sectigo Public Time Stamping Root R46" },
    notes: "RSA-4096, SHA-384. Asks for at least 15 s between scripted requests. ESSCertID v1 only; no accuracy stated. Entrust's TSA returns Sectigo-signed tokens: same operator. Off by default.",
  },
  freetsa: {
    operator: "FreeTSA",
    url: "https://freetsa.org/tsr",
    defaultEnabled: false,
    anchor: { tofu: "www.freetsa.org" },
    notes: "ECDSA P-384, SHA-512; no accuracy stated. 1 request/s per IP, best effort. Root not in a local store: pinned on first use. Off by default.",
  },
};
const DEFAULTS = { authorities: ["sigstore", "digicert", "globalsign", "microsoft"], minTokens: 2 };

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const recorded = opt("--recorded")[0];
const trustedRoots = opt("--trusted-root");
const anchorFiles = opt("--anchors");
const write = args.includes("--write");

const sha256 = (der) => createHash("sha256").update(der).digest("hex");
const cn = (x) => /CN=([^\n]+)/.exec(x.subject)?.[1] ?? x.subject.replace(/\n/g, ", ");
const iso = (s) => new Date(s).toISOString().replace(".000Z", "Z");
// Subjects are stored without e-mail attributes (the certificate itself is in the PEM).
const entry = (x, source, independent) => ({
  subject: x.subject.split("\n").filter((l) => !/^emailAddress=/.test(l)).join(", "),
  sha256: sha256(x.raw),
  notBefore: iso(x.validFrom),
  notAfter: iso(x.validTo),
  ...(independent === undefined ? {} : { independent }),
  source,
  pem: x.toString(),
});

function pems(text) {
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map((m) => new X509Certificate(m[0]));
}

// Local root stores.
const stores = [];
const keychain = "/System/Library/Keychains/SystemRootCertificates.keychain";
if (existsSync(keychain)) {
  const text = execFileSync("security", ["find-certificate", "-a", "-p", keychain], { encoding: "utf8", maxBuffer: 64 << 20 });
  stores.push({ name: "macOS SystemRootCertificates.keychain", certs: pems(text) });
}
stores.push({ name: `Node ${process.version} bundled Mozilla roots`, certs: rootCertificates.map((p) => new X509Certificate(p)) });
const labelled = (arg) => { const i = arg.lastIndexOf("#"); return i > 0 ? { path: arg.slice(0, i), label: arg.slice(i + 1) } : { path: arg, label: arg }; };
for (const a of anchorFiles.map(labelled)) stores.push({ name: a.label, certs: pems(readFileSync(a.path, "utf8")) });

// TUF trusted roots.
const tufTsas = [];
for (const { path, label } of trustedRoots.map(labelled)) {
  const tr = JSON.parse(readFileSync(path, "utf8"));
  for (const t of tr.timestampAuthorities ?? []) tufTsas.push({ file: label, uri: t.uri, validFor: t.validFor, certs: t.certChain.certificates.map((c) => new X509Certificate(Buffer.from(c.rawBytes, "base64"))) });
}

// Token chains.
const probe = createHash("sha256").update(`pr-rla trust-bundle probe ${new Date().toISOString().slice(0, 10)}`).digest("hex");
const rec = recorded ? JSON.parse(readFileSync(recorded, "utf8")) : null;
async function tokenCerts(id, url) {
  let body;
  if (rec) {
    const r = rec.authorities?.[id];
    if (!r) throw new Error(`${recorded} has no response for ${id}`);
    body = new Uint8Array(Buffer.from(r.response, "base64"));
  } else {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" }, body: buildTimeStampReq(probe, newNonce()), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
    body = new Uint8Array(await res.arrayBuffer());
  }
  const { token } = parseTimeStampResp(body);
  if (!token) throw new Error(`${id}: no token`);
  const sd = asn1js.fromBER(token.buffer.slice(token.byteOffset, token.byteOffset + token.byteLength)).result.valueBlock.value[1].valueBlock.value[0];
  const field = sd.valueBlock.value.find((v) => v.idBlock.tagClass === 3 && v.idBlock.tagNumber === 0);
  return (field?.valueBlock.value ?? []).map((c) => new X509Certificate(Buffer.from(c.valueBeforeDecodeView)));
}

const current = existsSync(BUNDLE) ? JSON.parse(readFileSync(BUNDLE, "utf8")) : { authorities: {} };
const bundle = { schema: "pr-rla/tsa-trust-bundle/v1", version: VERSION, defaults: DEFAULTS, authorities: {} };
const when = rec ? `recorded response of ${rec.recordedAt?.slice(0, 10) ?? "?"}` : `live response of ${new Date().toISOString().slice(0, 10)}`;
for (const [id, plan] of Object.entries(ANCHOR_PLAN)) {
  const tokenChain = await tokenCerts(id, plan.url);
  const anchors = [];
  const intermediates = [];
  let pool = tokenChain.map((x) => ({ x, source: `${plan.url} token (${when})` }));
  if (plan.anchor.tuf) {
    const tsas = tufTsas.filter((t) => t.uri.includes(plan.anchor.tuf));
    if (!tsas.length) throw new Error(`${id}: no --trusted-root file lists ${plan.anchor.tuf}`);
    for (const t of tsas)
      for (const x of t.certs) {
        const src = `TUF trusted_root.json: ${t.file}`;
        if (x.ca && x.checkIssued(x) && x.verify(x.publicKey)) anchors.push({ x, source: src, independent: true });
        else if (x.ca) pool.push({ x, source: src });
      }
  } else if (plan.anchor.system) {
    for (const s of stores) for (const x of s.certs) if (cn(x) === plan.anchor.system || x.subject.includes(plan.anchor.system)) anchors.push({ x, source: s.name, independent: true });
    if (!anchors.length) throw new Error(`${id}: ${plan.anchor.system} not found in any local root store`);
  } else {
    const x = tokenChain.find((c) => c.ca && (cn(c) === plan.anchor.tofu || c.subject.includes(plan.anchor.tofu)));
    if (!x) throw new Error(`${id}: the token carries no CA certificate named ${plan.anchor.tofu}`);
    anchors.push({ x, source: `${plan.url} token (${when}): trust on first use, not confirmed by an independent source`, independent: false });
  }
  for (const { x, source } of pool) if (x.ca && !anchors.some((a) => a.x.fingerprint256 === x.fingerprint256)) intermediates.push({ x, source });
  const dedupe = (list) => list.filter((e, i) => list.findIndex((f) => f.x.fingerprint256 === e.x.fingerprint256) === i);
  const merge = (fresh, old = []) => [...old, ...fresh.filter((f) => !old.some((o) => o.sha256 === f.sha256))];
  const prev = current.authorities?.[id];
  const freshAnchors = dedupe(anchors).map((a) => {
    const sources = anchors.filter((b) => b.x.fingerprint256 === a.x.fingerprint256).map((b) => b.source);
    return entry(a.x, [...new Set(sources)].join("; "), a.independent);
  });
  const freshInter = dedupe(intermediates).map((i) => entry(i.x, i.source));
  const freshIssuing = (plan.issuing ?? []).map((name) => {
    const found = pool.find(({ x }) => x.ca && cn(x) === name);
    if (!found) throw new Error(`${id}: the token chain and TUF files carry no CA certificate named ${name}`);
    const { subject, sha256: sha } = entry(found.x, found.source);
    return { subject, sha256: sha, source: found.source };
  });
  bundle.authorities[id] = {
    operator: plan.operator,
    url: plan.url,
    defaultEnabled: plan.defaultEnabled,
    notes: plan.notes,
    anchors: write ? merge(freshAnchors, prev?.anchors) : freshAnchors,
    intermediates: write ? merge(freshInter, prev?.intermediates) : freshInter,
    ...(freshIssuing.length || prev?.issuingCAs ? { issuingCAs: write ? merge(freshIssuing, prev?.issuingCAs) : freshIssuing } : {}),
  };
  const before = new Set([...(prev?.anchors ?? []), ...(prev?.intermediates ?? [])].map((c) => c.sha256));
  const after = [...bundle.authorities[id].anchors, ...bundle.authorities[id].intermediates];
  const added = after.filter((c) => !before.has(c.sha256));
  console.log(`${id}: ${bundle.authorities[id].anchors.length} anchor(s), ${bundle.authorities[id].intermediates.length} intermediate(s)${added.length ? `; new: ${added.map((c) => `${c.subject.replace(/.*CN=/, "")} ${c.sha256.slice(0, 16)}…`).join(", ")}` : "; no change"}`);
  for (const a of bundle.authorities[id].anchors) console.log(`   anchor ${a.subject.replace(/.*CN=/, "")} ${a.sha256.slice(0, 16)}… ${a.independent ? "independent" : "TOFU"} · ${a.source}`);
  for (const i of bundle.authorities[id].issuingCAs ?? []) console.log(`   TSA issuing CA ${i.subject.replace(/.*CN=/, "")} ${i.sha256.slice(0, 16)}… · ${i.source}`);
}
if (write) {
  writeFileSync(BUNDLE, `${JSON.stringify(bundle, null, 1)}\n`);
  console.log(`wrote ${BUNDLE}`);
} else console.log("(dry run: pass --write to update the bundle after reviewing the diff above)");
