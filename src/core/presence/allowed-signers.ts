import { bytesEqual } from "./wire.js";
import { isSshKeyType, parsePublicKeyText, type SshPublicKey } from "./keys.js";

/**
 * Allowed signers: the reviewers whose signatures count, fixed in the registration's
 * `verdicts.reviewers` (FR9.3). Each entry is one line of OpenSSH's allowed-signers format
 * (ssh-keygen(1), ALLOWED SIGNERS): `principals [options] keytype base64-key [comment]`.
 *
 * pr-rla reads a narrower form than ssh-keygen, because a principal here is a reviewer's identity:
 * - principals are exact names (no `*`, `?` or `!` patterns), compared case-insensitively, like logins;
 * - the only option is `namespaces="…"`, which must admit `git`; `cert-authority`, `valid-after`
 *   and `valid-before` are refused (a key change needs a new registration, which is the point).
 */
export interface AllowedSigner {
  /** The entry as registered. */
  line: string;
  principals: string[];
  /** The `namespaces=` pattern list, or null when the entry has none (any namespace). */
  namespaces: string[] | null;
  key: SshPublicKey;
}

/** An entry with whitespace is an allowed-signers line; anything else is a login or `id:<account id>`. */
export const isAllowedSignerEntry = (entry: string): boolean => /\s/.test(entry.trim());

/** Splits on whitespace outside double quotes. */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (quoted) throw new Error("an option has an unterminated quote");
  if (cur) out.push(cur);
  return out;
}

/** Splits an options field on commas outside double quotes. */
function options(field: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of field) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** OpenSSH pattern matching (ssh_config(5), PATTERNS): `*` and `?` wildcards. */
function globMatch(text: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(text);
}

/** OpenSSH pattern-list semantics: a matching negated (`!`) pattern refuses; otherwise any positive match admits. */
export function matchPatternList(text: string, patterns: readonly string[]): boolean {
  let matched = false;
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (globMatch(text, p.slice(1))) return false;
    } else if (globMatch(text, p)) matched = true;
  }
  return matched;
}

/** Parses one allowed-signers entry. Throws an Error naming what is wrong. */
export function parseAllowedSigner(line: string): AllowedSigner {
  const entry = line.trim();
  const f = fields(entry);
  if (f.length < 3) throw new Error(`allowed-signers entry ${JSON.stringify(abbreviate(entry))} needs "principal keytype base64-key"`);
  const principals = f[0]!.split(",");
  for (const p of principals) {
    if (p === "") throw new Error(`allowed-signers entry ${JSON.stringify(abbreviate(entry))} has an empty principal`);
    if (/[*?!]/.test(p)) throw new Error(`allowed-signers principal ${JSON.stringify(p)} is a pattern; register each reviewer by exact name`);
    if (p.startsWith("id:")) throw new Error(`allowed-signers principal ${JSON.stringify(p)} looks like an account id; name the reviewer instead`);
  }
  let i = 1;
  let namespaces: string[] | null = null;
  if (!isSshKeyType(f[1]!)) {
    for (const opt of options(f[1]!)) {
      const m = /^namespaces="([^"]*)"$/i.exec(opt);
      if (m) {
        if (namespaces) throw new Error(`allowed-signers entry for ${principals.join(",")} has two namespaces options`);
        namespaces = m[1]!.split(",").filter((n) => n !== "");
        if (!matchPatternList("git", namespaces)) throw new Error(`allowed-signers entry for ${principals.join(",")} does not admit namespace "git" (namespaces="${m[1]}")`);
      } else
        throw new Error(
          `allowed-signers option ${opt} for ${principals.join(",")} is not supported: pr-rla reads only namespaces="…" (a reviewer's key is fixed by the registration, so validity periods and certificate authorities do not apply)`,
        );
    }
    i = 2;
  }
  if (f.length < i + 2) throw new Error(`allowed-signers entry for ${principals.join(",")} has no key`);
  let key: SshPublicKey;
  try {
    key = parsePublicKeyText(f[i]!, f[i + 1]!);
  } catch (e) {
    throw new Error(`allowed-signers entry for ${principals.join(",")}: ${(e as Error).message}`);
  }
  return { line: entry, principals, namespaces, key };
}

/** The allowed signers among a registration's `verdicts.reviewers` (logins and `id:` entries are skipped). Throws on a malformed entry. */
export function allowedSignersOf(reviewers: readonly string[] | null | undefined): AllowedSigner[] {
  return (reviewers ?? []).filter(isAllowedSignerEntry).map(parseAllowedSigner);
}

/** The entries holding exactly this key that admit `namespace` (ssh-keygen -Y verify compares the whole public key). */
export function signersFor(key: SshPublicKey, signers: readonly AllowedSigner[], namespace = "git"): AllowedSigner[] {
  return signers.filter((s) => bytesEqual(s.key.blob, key.blob) && (s.namespaces === null || matchPatternList(namespace, s.namespaces)));
}

/** `alice (sk-ssh-ed25519@openssh.com SHA256:…)`, for output; keys are long. */
export function describeSigner(s: AllowedSigner): string {
  return `${s.principals.join(",")} (${s.key.type} ${s.key.fingerprint})`;
}

const abbreviate = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
