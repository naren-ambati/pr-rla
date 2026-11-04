import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson } from "../core/canonical.js";
import { writeFileAtomic } from "../io/atomic.js";
import { PluginError } from "./errors.js";
import type { LockEntry, LockedCredential, PluginRules, PluginTrust } from "./lock.js";

/**
 * Local consent (the plugin and broker fix round, finding 1): what a repo's pr-rla.lock.json or
 * .pr-rla.yml asks for takes effect only when the person running the command agreed to it.
 *
 * Two things need that consent:
 * - a credential grant: a placeholder swapped for one of your secrets, sent to an origin;
 * - `trust: full`: a plugin running in pr-rla's own process, with your environment and files.
 *
 * The lock still pins what the plugin is (source, integrity, tree hash) and what it may read; it no
 * longer decides what it may send. Approvals live in a per-user file outside every repo:
 * `$PR_RLA_APPROVALS_FILE`, else `$XDG_CONFIG_HOME/pr-rla/approvals.json`, else
 * `~/.config/pr-rla/approvals.json`. `plugin add` and `plugin lock` record one (the person locking a
 * plugin is consenting to it); `plugin approve` records one for a plugin someone else locked, and for
 * a built-in's non-default credential use. `--accept-lock-grants` (or `PR_RLA_ACCEPT_LOCK_GRANTS=1`)
 * takes the repo's grants as given for one run, for a repo you control (CI).
 */

export const APPROVALS_SCHEMA = "pr-rla/approvals/v1";

type Env = Readonly<Record<string, string | undefined>>;

/** One credential a plugin may send: the env var, the https origins, and the extra headers it may go in. */
export interface CredentialGrant {
  env: string;
  /** `https://host[:port]`, the default port left out. */
  origins: string[];
  /** Header names besides `authorization` where its placeholder may be swapped. */
  headers?: string[];
  /** `false`: an identity (a Basic username), not scrubbed from responses. */
  secret?: false;
}

/** An external plugin, approved as locked: its use, its files, its trust, exactly these credential grants and these write paths. */
export interface PluginApproval {
  kind: "plugin";
  use: string;
  treeSha256: string;
  trust: PluginTrust;
  credentials: CredentialGrant[];
  /** The ledger write paths the lock grants: where the approved credentials may be used to write. */
  writePaths: string[];
  approvedAt: string;
}

/** Built-in providers and ledgers may send `env` to `origin` (beyond the built-in defaults). */
export interface BuiltinApproval {
  kind: "builtin";
  env: string;
  origin: string;
  approvedAt: string;
}

export type Approval = PluginApproval | BuiltinApproval;

export interface ApprovalsFile {
  schema: typeof APPROVALS_SCHEMA;
  approvals: Approval[];
}

/**
 * What a built-in sends with no approval: each service's own token to that service's public API.
 * Any other pair (a self-hosted base_url, another token_env) needs a local approval.
 */
export const BUILTIN_DEFAULT_GRANTS: readonly { env: string; origin: string }[] = [
  { env: "GITHUB_TOKEN", origin: "https://api.github.com" },
  { env: "GH_TOKEN", origin: "https://api.github.com" },
  { env: "GITLAB_TOKEN", origin: "https://gitlab.com" },
  { env: "BITBUCKET_TOKEN", origin: "https://api.bitbucket.org" },
  { env: "BITBUCKET_USERNAME", origin: "https://api.bitbucket.org" },
];

/** Where this user's approvals live. The context's env first, then this process's, so a test env without it never reaches the real home. */
export function approvalsFile(env: Env = process.env): string {
  const pick = (k: string): string | undefined => {
    const v = env[k] ?? process.env[k];
    return v ? v : undefined;
  };
  const explicit = pick("PR_RLA_APPROVALS_FILE");
  if (explicit) return resolve(explicit);
  const xdg = pick("XDG_CONFIG_HOME");
  const base = xdg && isAbsolute(xdg) ? xdg : join(pick("HOME") ?? homedir(), ".config");
  return join(base, "pr-rla", "approvals.json");
}

/** The https origin of a locked host (`host` or `host:port`), or null when it is not one. */
export function httpsOrigin(host: string): string | null {
  if (!host || /[/?#@\\\s]/.test(host)) return null;
  try {
    return new URL(`https://${host}`).origin;
  } catch {
    return null;
  }
}

/** A URL's origin when it is an https URL with nothing but an origin (a trailing `/` allowed), else null. */
export function parseHttpsOrigin(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
  return u.origin;
}

/** The grants a lock entry's credentials make, canonical: sorted, origins normalized. */
export function grantsOf(credentials: readonly LockedCredential[]): CredentialGrant[] {
  return [...credentials]
    .map((c) => ({
      env: c.env,
      origins: [...new Set(c.hosts.map(httpsOrigin).filter((o): o is string => o !== null))].sort(),
      ...(c.headers?.length ? { headers: [...new Set(c.headers.map((h) => h.toLowerCase()))].sort() } : {}),
      ...(c.secret === false ? { secret: false as const } : {}),
    }))
    .sort((a, b) => (a.env < b.env ? -1 : a.env > b.env ? 1 : 0));
}

const pluginKey = (a: { use: string; treeSha256: string; trust: PluginTrust; credentials: CredentialGrant[]; writePaths?: string[] }) => canonicalJson({ use: a.use, treeSha256: a.treeSha256, trust: a.trust, credentials: a.credentials, writePaths: [...new Set(a.writePaths ?? [])].sort() });
const keyOfEntry = (use: string, entry: LockEntry) => pluginKey({ use, treeSha256: entry.treeSha256, trust: entry.trust, credentials: grantsOf(entry.credentials), writePaths: entry.writePaths });

function problem(a: unknown): string | null {
  if (!a || typeof a !== "object") return "an approval must be an object";
  const x = a as { kind?: unknown; approvedAt?: unknown; env?: unknown; origin?: unknown; use?: unknown; treeSha256?: unknown; trust?: unknown; credentials?: unknown };
  if (typeof x.approvedAt !== "string") return "approvedAt must be a string";
  if (x.kind === "builtin") return typeof x.env === "string" && typeof x.origin === "string" ? null : "a builtin approval needs env and origin";
  if (x.kind !== "plugin") return 'kind must be "plugin" or "builtin"';
  if (typeof x.use !== "string" || typeof x.treeSha256 !== "string" || (x.trust !== "isolated" && x.trust !== "full")) return "a plugin approval needs use, treeSha256 and trust";
  if (!Array.isArray(x.credentials) || !x.credentials.every((c: { env?: unknown; origins?: unknown } | null) => c && typeof c.env === "string" && Array.isArray(c.origins))) return "credentials must be a list of { env, origins }";
  return null;
}

/** The approvals file; empty when it does not exist. A malformed file is refused, never read as "nothing approved" silently. */
export function readApprovals(path: string): ApprovalsFile {
  if (!existsSync(path)) return { schema: APPROVALS_SCHEMA, approvals: [] };
  const fix = `fix or remove ${path} (it holds only your own approvals), then approve again`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new PluginError(`${path} is not valid JSON: ${(e as Error).message}`, "PLUGIN_INVALID", fix);
  }
  const f = raw as Partial<ApprovalsFile>;
  if (f?.schema !== APPROVALS_SCHEMA || !Array.isArray(f.approvals)) throw new PluginError(`${path}: not a ${APPROVALS_SCHEMA} file`, "PLUGIN_INVALID", fix);
  for (const a of f.approvals) {
    const p = problem(a);
    if (p) throw new PluginError(`${path}: ${p}`, "PLUGIN_INVALID", fix);
  }
  return f as ApprovalsFile;
}

function writeApprovals(path: string, f: ApprovalsFile): void {
  writeFileAtomic(path, `${JSON.stringify({ schema: APPROVALS_SCHEMA, approvals: f.approvals }, null, 2)}\n`, { mode: 0o600 });
}

/** Records that `use`, locked as `entry`, is approved here. An identical approval is replaced (its time updated). */
export function approvePlugin(path: string, use: string, entry: LockEntry, approvedAt: string): PluginApproval {
  const a: PluginApproval = { kind: "plugin", use, treeSha256: entry.treeSha256, trust: entry.trust, credentials: grantsOf(entry.credentials), writePaths: [...new Set(entry.writePaths)].sort(), approvedAt };
  const f = readApprovals(path);
  const key = pluginKey(a);
  writeApprovals(path, { ...f, approvals: [...f.approvals.filter((x) => x.kind !== "plugin" || pluginKey(x) !== key), a] });
  return a;
}

/** Records that built-in providers and ledgers may send `env` to `origin` (an https origin). */
/** Refuses a built-in approval that is not an environment variable name and an https origin. */
export function checkBuiltinPair(env: string, origin: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) throw new PluginError(`${JSON.stringify(env)} is not an environment variable name`, "PLUGIN_INVALID");
  if (!parseHttpsOrigin(origin)) throw new PluginError(`${origin}: a credential is approved only for an https origin (https://host[:port]); a token is never sent in clear text`, "PLUGIN_INVALID", "pass the server's https URL, e.g. --origin https://ghe.example.com");
}

export function approveBuiltin(path: string, env: string, origin: string, approvedAt: string): BuiltinApproval {
  checkBuiltinPair(env, origin);
  const o = parseHttpsOrigin(origin)!;
  const a: BuiltinApproval = { kind: "builtin", env, origin: o, approvedAt };
  const f = readApprovals(path);
  writeApprovals(path, { ...f, approvals: [...f.approvals.filter((x) => x.kind !== "builtin" || x.env !== env || x.origin !== o), a] });
  return a;
}

/** How a grant took effect: approved here, a built-in default, or accepted from the repo for this run. */
export type ConsentSource = "approved" | "default" | "accepted";

export interface LocalConsent {
  /** The approvals file this consent reads and `plugin add`/`lock`/`approve` write. */
  readonly file: string;
  /** `--accept-lock-grants` or `PR_RLA_ACCEPT_LOCK_GRANTS=1`: this run takes the repo's grants and trust as given. */
  readonly acceptLockGrants: boolean;
  /** Whether `use`, as `entry` locks it, may have its credential grants and trust. */
  plugin(use: string, entry: LockEntry): ConsentSource | null;
  /** Whether a built-in may send `env` to `origin`. */
  builtin(env: string, origin: string): ConsentSource | null;
}

/** `--accept-lock-grants` / `PR_RLA_ACCEPT_LOCK_GRANTS`: only `1` accepts; any other non-empty value is refused, so a typo is never silent. */
export function acceptLockGrantsFrom(flag: boolean | undefined, env: Env): boolean {
  const v = env.PR_RLA_ACCEPT_LOCK_GRANTS;
  if (v !== undefined && v !== "" && v !== "0" && v !== "1") throw new PluginError(`PR_RLA_ACCEPT_LOCK_GRANTS ${JSON.stringify(v)}: use 1 (accept the repo's grants for this run) or leave it unset`, "PLUGIN_INVALID", "set PR_RLA_ACCEPT_LOCK_GRANTS=1, or unset it");
  return flag === true || v === "1";
}

export function localConsent(env: Env, o: { acceptLockGrants?: boolean; file?: string } = {}): LocalConsent {
  const file = o.file ?? approvalsFile(env);
  const accept = acceptLockGrantsFrom(o.acceptLockGrants, env);
  return {
    file,
    acceptLockGrants: accept,
    plugin(use, entry) {
      const key = keyOfEntry(use, entry);
      if (readApprovals(file).approvals.some((a) => a.kind === "plugin" && pluginKey(a) === key)) return "approved";
      return accept ? "accepted" : null;
    },
    builtin(env, origin) {
      if (BUILTIN_DEFAULT_GRANTS.some((d) => d.env === env && d.origin === origin)) return "default";
      if (readApprovals(file).approvals.some((a) => a.kind === "builtin" && a.env === env && a.origin === origin)) return "approved";
      return accept ? "accepted" : null;
    },
  };
}

/** The grant lines `plugin add`, `lock` and `approve` print: `GITEA_TOKEN -> https://forge.example.com`. */
export function grantText(g: CredentialGrant): string {
  const extra = [...(g.headers?.length ? [`also in header${g.headers.length > 1 ? "s" : ""} ${g.headers.join(", ")}`] : []), ...(g.secret === false ? ["an identity: not scrubbed from responses"] : [])];
  return `${g.env} -> ${g.origins.join(", ") || "no origin"}${extra.length ? ` (${extra.join("; ")})` : ""}`;
}

export const approveCommand = (use: string) => `pr-rla plugin approve ${use}`;

/** The consent `rules` carry for `use` (none for a bare policy, which carries no consent). */
export const consentOf = (rules: PluginRules | string, use: string, entry: LockEntry): ConsentSource | null => (typeof rules === "string" ? null : (rules.consent?.plugin(use, entry) ?? null));

/** A `trust: full` plugin runs in this process with your environment: never on the repo's word alone. */
export function refuseFullTrustUnapproved(use: string, entry: LockEntry, consent: ConsentSource | null): void {
  if (consent !== null) return;
  throw new PluginError(
    `plugin ${use} is locked with trust: full (it would run in this process, with your environment and files), and you have not approved it on this machine; nothing of it was loaded`,
    "NOT_APPROVED",
    `review it, then: ${approveCommand(use)} (or run it isolated: pr-rla plugin lock ${use} --trust isolated)`,
  );
}
