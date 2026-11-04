import { bytesEqual } from "./wire.js";
import { isSshKeyType, parsePublicKeyText, type SshPublicKey } from "./keys.js";
import { VERDICT_NAMESPACE } from "./verdict-payload.js";

/**
 * Allowed signers: the reviewers whose verdict signatures count, fixed in the registration's
 * `verdicts.allowed_signers` (FR9.3). Each entry is one line of OpenSSH's allowed-signers format
 * (ssh-keygen(1), ALLOWED SIGNERS): `principal [options] keytype base64-key [comment]`, so the same
 * lines work with `ssh-keygen -Y verify -f`.
 *
 * pr-rla reads a narrower form than ssh-keygen, because a principal here is one reviewer:
 * - one principal per entry, an exact name (no `*`, `?` or `!` patterns, no commas, no quotes),
 *   matched exactly against a verdict's `reviewer`, as `ssh-keygen -Y verify -I` matches it;
 * - across a registration, no two principals equal ignoring case, and no key under two principals;
 * - the only option is `namespaces="…"`, which must admit `pr-rla-verdict@v1`; `cert-authority`,
 *   `valid-after` and `valid-before` are refused (a key change needs a new registration, which is the point).
 */
export interface AllowedSigner {
  /** The entry as registered. */
  line: string;
  /** The one principal (an array for the allowed-signers format's sake). */
  principals: string[];
  /** The `namespaces=` pattern list, or null when the entry has none (any namespace). */
  namespaces: string[] | null;
  key: SshPublicKey;
}

/** A principal pr-rla accepts: no whitespace, comma, quote, pattern character or control character, and not an account id. */
const PRINCIPAL = /^[^\s,"*?!\u0000-\u001f\u007f]+$/;

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
  if (principals.length > 1) throw new Error(`allowed-signers entry for ${principals.join(",")} lists several principals; register one reviewer per key, one key per line`);
  for (const p of principals) {
    if (p === "") throw new Error(`allowed-signers entry ${JSON.stringify(abbreviate(entry))} has an empty principal`);
    if (/[*?!]/.test(p)) throw new Error(`allowed-signers principal ${JSON.stringify(p)} is a pattern; register each reviewer by exact name`);
    if (p.startsWith("id:")) throw new Error(`allowed-signers principal ${JSON.stringify(p)} looks like an account id; name the reviewer instead`);
    if (!PRINCIPAL.test(p)) throw new Error(`allowed-signers principal ${JSON.stringify(p)} holds a quote or a control character; name the reviewer plainly`);
  }
  let i = 1;
  let namespaces: string[] | null = null;
  if (!isSshKeyType(f[1]!)) {
    for (const opt of options(f[1]!)) {
      const m = /^namespaces="([^"]*)"$/i.exec(opt);
      if (m) {
        if (namespaces) throw new Error(`allowed-signers entry for ${principals.join(",")} has two namespaces options`);
        namespaces = m[1]!.split(",").filter((n) => n !== "");
        if (!matchPatternList(VERDICT_NAMESPACE, namespaces)) throw new Error(`allowed-signers entry for ${principals.join(",")} does not admit namespace "${VERDICT_NAMESPACE}" (namespaces="${m[1]}")`);
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

/**
 * A registration's allowed signers, each entry parsed, and the list checked as a whole: no two
 * principals equal ignoring case (`Alice` and `alice` would be one login elsewhere), and no key held
 * under two principals (its signature would speak for both). Throws an Error naming the problem.
 */
export function parseAllowedSigners(lines: readonly string[]): AllowedSigner[] {
  const signers = lines.map(parseAllowedSigner);
  const byName = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const s of signers) {
    const name = s.principals[0]!;
    const other = byName.get(name.toLowerCase());
    if (other !== undefined) throw new Error(`allowed signers ${JSON.stringify(other)} and ${JSON.stringify(name)} are the same principal ignoring case; register each reviewer once`);
    byName.set(name.toLowerCase(), name);
    const holder = byKey.get(s.key.fingerprint);
    if (holder !== undefined) throw new Error(`allowed signers ${holder} and ${name} hold the same key ${s.key.fingerprint}; one key belongs to one reviewer`);
    byKey.set(s.key.fingerprint, name);
  }
  return signers;
}

/** The allowed signers a registration fixes (`verdicts.allowed_signers`; none when absent). Throws on a malformed list. */
export function allowedSignersOf(lines: readonly string[] | null | undefined): AllowedSigner[] {
  return parseAllowedSigners(lines ?? []);
}

/** The entries holding exactly this key that admit `namespace` (ssh-keygen -Y verify compares the whole public key). */
export function signersFor(key: SshPublicKey, signers: readonly AllowedSigner[], namespace = VERDICT_NAMESPACE): AllowedSigner[] {
  return signers.filter((s) => bytesEqual(s.key.blob, key.blob) && (s.namespaces === null || matchPatternList(namespace, s.namespaces)));
}

/** `alice (sk-ssh-ed25519@openssh.com SHA256:…)`, for output; keys are long. */
export function describeSigner(s: AllowedSigner): string {
  return `${s.principals.join(",")} (${s.key.type} ${s.key.fingerprint})`;
}

/** A line that reads as an allowed-signers entry (`principal keytype key`): `register` warns when one sits in `verdicts.reviewers`. */
export function looksLikeAllowedSigner(entry: string): boolean {
  try {
    parseAllowedSigner(entry);
    return true;
  } catch {
    return false;
  }
}

const abbreviate = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
