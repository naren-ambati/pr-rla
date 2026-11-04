// The release secret grep (FR8.3, NFR2): packs pr-rla and pr-rla-mcp exactly as `npm pack` would ship
// them, reads every file inside each tarball, and fails on anything that looks like a credential or an
// e-mail address. Nothing is published: `npm pack` writes the tarball into a temporary directory.
//
// Usage (after `npm run build` and `npm --prefix packages/pr-rla-mcp run build`):
//   node scripts/secret-grep.mjs              both packages; exit 1 on a finding
//   node scripts/secret-grep.mjs <dir>...     the packages at these directories
//
// `npm pack` runs with --ignore-scripts (so it packs the dist/ you built, and runs no prepack) and
// --offline (so npm asks no registry). test/release.test.ts and the MCP package's own release test
// run the same functions.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What a credential looks like, by issuer. Each is the token's documented prefix and shape. */
export const SECRET_PATTERNS = [
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: "GitLab token", re: /\bgl(?:pat|dt|rt|ptt|ft|soat|cbt|imt|agent)-[A-Za-z0-9_-]{20,}\b/g },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "Atlassian token", re: /\b(?:ATATT3[A-Za-z0-9_=-]{20,}|ATBB[A-Za-z0-9]{24,}|ATCTT3[A-Za-z0-9_=-]{20,})/g },
  { name: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
  { name: "credential in an Authorization header", re: /\bauthorization["']?\s*[:=]\s*["']?(?:token|bearer|basic)\s+[A-Za-z0-9+/_.=-]{20,}/gi },
  { name: "e-mail address", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

/**
 * Addresses that are not anyone's: the scrubbed form pr-rla's recorders write (`user-<hash>@example.invalid`,
 * NFR2), the reserved example domains, and OpenSSH's key-type names (`sk-ssh-ed25519@openssh.com`), which
 * the signature verifier names and which have the shape of an address.
 */
export const ALLOWED_ADDRESSES = [/^[^@]+@example\.(?:invalid|com|org|net)$/i, /^(?:sk-ssh-ed25519|sk-ecdsa-sha2-nistp256|webauthn-sk-ecdsa-sha2-nistp256|ssh-ed25519-cert-v01|ecdsa-sha2-nistp256-cert-v01)@openssh\.com$/];

/** Every finding in one text: `{ pattern, line, match }`, the match shortened so a report never repeats a secret whole. */
export function findSecrets(text) {
  const out = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const { name, re } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        if (name === "e-mail address" && ALLOWED_ADDRESSES.some((a) => a.test(m[0]))) continue;
        out.push({ pattern: name, line: i + 1, match: m[0].length > 12 ? `${m[0].slice(0, 6)}…(${m[0].length} chars)` : m[0] });
      }
    }
  });
  return out;
}

/** The files of a .tgz as npm writes it (ustar, with pax headers for long names): `{ path, text }`. */
export function tarballFiles(tgzPath) {
  const tar = gunzipSync(readFileSync(tgzPath));
  const files = [];
  let paxPath = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from, len) => header.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const body = tar.subarray(at + 512, at + 512 + size);
    const name = field(0, 100);
    const prefix = field(345, 155);
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      paxPath = m ? m[1] : null;
    } else if (type === "0") {
      files.push({ path: paxPath ?? (prefix ? `${prefix}/${name}` : name), text: body.toString("utf8") });
      paxPath = null;
    } else paxPath = null;
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const npm = (args, cwd) =>
  execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
  });

/** `npm pack` of the package at `pkgDir` into `dest` (no scripts, no registry): the tarball's path and npm's file list. */
export function packTarball(pkgDir, dest) {
  const [info] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", dest], pkgDir));
  return { tgz: join(dest, info.filename), files: info.files.map((f) => f.path), name: info.name, version: info.version };
}

/** Packs `pkgDir` in a temporary directory and greps every file of the tarball: `{ name, version, files, findings }`. */
export function grepPackage(pkgDir) {
  const dest = mkdtempSync(join(tmpdir(), "pr-rla-secret-grep-"));
  try {
    const { tgz, name, version } = packTarball(pkgDir, dest);
    const files = tarballFiles(tgz);
    const findings = files.flatMap((f) => findSecrets(f.text).map((x) => ({ file: f.path, ...x })));
    return { name, version, files: files.map((f) => f.path), findings };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2).map((d) => resolve(d)) : [ROOT, join(ROOT, "packages", "pr-rla-mcp")];
  let bad = 0;
  for (const dir of dirs) {
    const r = grepPackage(dir);
    console.log(`${r.name}@${r.version}: ${r.files.length} files in the tarball, ${r.findings.length} finding(s)`);
    for (const f of r.findings) console.log(`  ${f.file}:${f.line}: ${f.pattern}: ${f.match}`);
    bad += r.findings.length;
  }
  process.exitCode = bad ? 1 : 0;
}
