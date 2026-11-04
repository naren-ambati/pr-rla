import { createHash, createPublicKey } from "node:crypto";

/**
 * Transparency-log public keys (review finding 3, FR1.7).
 *
 * A log entry is time evidence only if it verifies under a key the verifier trusts without the
 * auditee's help: a key pinned here (Sigstore's production logs, from Sigstore's TUF
 * trusted_root.json), or a key the verifier passes with `--log-key`. A key never comes from the
 * audit repo (its `.pr-rla.yml` or a file in it) or from the log URL in a record's unsigned
 * envelope: the auditee controls both, so a self-run log could otherwise stamp any time.
 * An entry under any other key is reported as unverified, gives no time evidence and is no operator.
 */

export interface PinnedLogKey {
  /** The log's base URL, as entries name it (`logUrl`). */
  url: string;
  /** Rekor API: v1 entries carry an integratedTime and a SET; v2 entries carry no time. */
  api: "v1" | "v2";
  /** The operator whose evidence a verified entry is (it merges with that operator's own TSA token). */
  operator: string;
  /** Hex of the TUF `logId.keyId`: SHA-256 of the DER key (v1); SHA-256 of the C2SP note key material (v2). */
  logId: string;
  publicKeyPem: string;
  /** TUF `validFor.start`. */
  validFrom: string;
  source: string;
}

const SOURCES =
  "TUF trusted_root.json: npm @sigstore/tuf 4.0.2 seeds.json (bundled in npm 11.19.1); gh CLI TUF cache of tuf-repo-cdn.sigstore.dev, fetched 2026-10-20";

export const PINNED_LOG_KEYS: readonly PinnedLogKey[] = [
  {
    url: "https://rekor.sigstore.dev",
    api: "v1",
    operator: "Sigstore",
    logId: "c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr\nkBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==\n-----END PUBLIC KEY-----\n",
    validFrom: "2021-01-12T11:53:27Z",
    source: `${SOURCES}; also npm @sigstore/tuf 3.1.1 seeds.json (bundled in npm 10.9.8)`,
  },
  {
    url: "https://log2025-1.rekor.sigstore.dev",
    api: "v2",
    operator: "Sigstore",
    logId: "cf1199155bddd051268d1f16ac5c0c75c009f6fb5a63f4177f8e18d7051e3fa0",
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAt8rlp1knGwjfbcXAYPYAkn0XiLz1x8O4t0YkEhie244=\n-----END PUBLIC KEY-----\n",
    validFrom: "2025-09-23T00:00:00Z",
    source: SOURCES,
  },
];

/** A log URL in a comparable form: lower-case scheme and host, no trailing slash. */
export function normalizeLogUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/, "").toLowerCase();
  }
}

/** The key pinned in the package for this log URL, if any. */
export function pinnedLogKey(logUrl: string): PinnedLogKey | null {
  const want = normalizeLogUrl(logUrl);
  return PINNED_LOG_KEYS.find((k) => normalizeLogUrl(k.url) === want) ?? null;
}

/** A key verify trusts for a log, where it came from, and the operator a verified entry counts as. */
export interface TrustedLogKey {
  publicKeyPem: string;
  source: "pinned" | "verifier";
  /** "Sigstore" for a pinned log; a neutral `log at <host>` for a log only the verifier's --log-key vouches for. */
  operator: string;
  /** The log URL the key is for, as pinned or as the verifier named it. */
  url: string;
}

/**
 * The verifier's `--log-key <url>=<pem-file>` keys, by normalised log URL. Each is scoped to its URL: a
 * key for one log never verifies another log's entries.
 */
export type VerifierLogKeys = ReadonlyMap<string, { url: string; publicKeyPem: string }>;

/** The operator a log only the verifier vouches for counts as: never "Sigstore", whatever its URL claims. */
export function neutralLogOperator(logUrl: string): string {
  try {
    return `log at ${new URL(logUrl).host}`;
  } catch {
    return `log at ${normalizeLogUrl(logUrl)}`;
  }
}

/**
 * The key verify trusts for an entry (pass-2 review #6): the key pinned for that log URL, which always wins for a
 * pinned log; else the verifier's own `--log-key` for exactly that URL; else none (the entry is then unverified).
 * Nothing else is consulted: not the audit repo, not the URL's /publicKey.
 */
export function trustedLogKey(logUrl: string, verifierKeys: VerifierLogKeys = new Map()): TrustedLogKey | null {
  const pinned = pinnedLogKey(logUrl);
  if (pinned) return { publicKeyPem: pinned.publicKeyPem, source: "pinned", operator: pinned.operator, url: pinned.url };
  const own = verifierKeys.get(normalizeLogUrl(logUrl));
  return own ? { publicKeyPem: own.publicKeyPem, source: "verifier", operator: neutralLogOperator(own.url), url: own.url } : null;
}

/** Where a trusted key came from, for the verify output (NFR4). */
export function logKeySource(key: TrustedLogKey): string {
  return key.source === "pinned" ? `the key pinned for ${key.url} (Sigstore TUF)` : `the verifier's --log-key for ${key.url}`;
}

/**
 * Parses `--log-key <url>=<pem-file>` values (repeatable). The URL is everything before the first `=`; an http(s)
 * URL. A key for a log pr-rla pins is reported in `ignored`: the pinned key wins. Two keys for one URL are refused.
 */
export function parseLogKeyArgs(args: readonly string[], readPem: (file: string) => string): { keys: Map<string, { url: string; publicKeyPem: string }>; ignored: string[] } {
  const keys = new Map<string, { url: string; publicKeyPem: string }>();
  const ignored: string[] = [];
  for (const arg of args) {
    const at = arg.indexOf("=");
    const url = at > 0 ? arg.slice(0, at).trim() : "";
    const file = at > 0 ? arg.slice(at + 1).trim() : "";
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!url || !file || !parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:"))
      throw new Error(`--log-key takes <log url>=<pem file> (e.g. --log-key https://rekor.example.org=rekor.pub), got ${JSON.stringify(arg)}`);
    const pem = readPem(file);
    try {
      createPublicKey(pem);
    } catch (e) {
      throw new Error(`--log-key ${url}: ${file} is not a public key (PEM): ${(e as Error).message}`);
    }
    const norm = normalizeLogUrl(url);
    if (pinnedLogKey(url)) {
      ignored.push(`--log-key for ${url} is not used: pr-rla pins that log's key, and the pinned key always wins`);
      continue;
    }
    const prev = keys.get(norm);
    if (prev && keySha256(prev.publicKeyPem) !== keySha256(pem)) throw new Error(`--log-key names two different keys for ${url}`);
    keys.set(norm, { url, publicKeyPem: pem });
  }
  return { keys, ignored };
}

/** SHA-256 of a PEM key's DER, hex (a Rekor v1 logID). */
export function keySha256(pem: string): string {
  return createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex");
}
