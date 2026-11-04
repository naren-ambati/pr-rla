import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../io/atomic.js";
import { PluginError } from "./errors.js";

/**
 * `pr-rla.lock.json` (contracts.md §5; functional-design.md §U2b item 4; FR2.2, FR2.3).
 *
 * The lock pins every external plugin of an audit repo: its source, version, the npm integrity
 * its package-lock.json recorded, and a tree hash of the installed files (the plugin's own and
 * those of every runtime dependency). It also records what the plugin may reach: hosts,
 * ledger write paths and credentials, and how it runs: `isolated` (the default, out of process)
 * or `full` (in process, an explicit opt-in).
 *
 * It is written only by `pr-rla plugin add` and `pr-rla plugin lock`. Every load re-resolves the
 * plugin and re-hashes it, and refuses on any difference; npm checks integrity only at install.
 */

export const LOCK_FILE = "pr-rla.lock.json";
export const LOCK_SCHEMA = "pr-rla/lock/v1";

export type PluginTrust = "isolated" | "full";

export interface LockedCredential {
  env: string;
  hosts: string[];
  /** The option whose URL gave `hosts` (the definition's `hostFromOption`), when it did. */
  hostFromOption?: string;
}

export interface LockEntry {
  source: "package" | "path";
  /** The plugin definition's name, as the plugin reported it when it was added. */
  name: string;
  version: string | null;
  /** package-lock.json's `resolved` for a package; `file:<path from the audit directory>` for a path plugin. */
  resolved: string | null;
  /** package-lock.json's `integrity` (SRI); null for a path plugin, and for a package npm installed from a local path. */
  npmIntegrity: string | null;
  treeSha256: string;
  trust: PluginTrust;
  hosts: string[];
  writePaths: string[];
  credentials: LockedCredential[];
}

export interface LockFile {
  schema: typeof LOCK_SCHEMA;
  plugins: Record<string, LockEntry>;
}

/** Directory names never hashed or readable at a plugin's or dependency's top level. Dependencies are hashed separately. */
const SKIP = new Set(["node_modules", ".git"]);
/** npm lifecycle scripts that run on install. */
export const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const toPosix = (p: string) => p.split(sep).join("/");

export function isPathSpec(use: string): boolean {
  return use.startsWith("./") || use.startsWith("../") || isAbsolute(use) || use.startsWith("file:");
}

/** True when `child` is `parent` or inside it (both absolute, already resolved). */
export function isInside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (r.split(sep)[0] !== ".." && !isAbsolute(r));
}

// ---------------------------------------------------------------------------
// The lock file
// ---------------------------------------------------------------------------

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function entryProblem(e: unknown): string | null {
  if (!e || typeof e !== "object") return "an entry must be an object";
  const x = e as Partial<LockEntry>;
  if (x.source !== "package" && x.source !== "path") return 'source must be "package" or "path"';
  if (typeof x.name !== "string" || !x.name) return "name must be a string";
  for (const k of ["version", "resolved", "npmIntegrity"] as const) if (x[k] !== null && typeof x[k] !== "string") return `${k} must be a string or null`;
  if (typeof x.treeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(x.treeSha256)) return "treeSha256 must be 64 hex characters";
  if (x.trust !== "isolated" && x.trust !== "full") return 'trust must be "isolated" or "full"';
  if (!isStrings(x.hosts) || !isStrings(x.writePaths)) return "hosts and writePaths must be lists of strings";
  if (!Array.isArray(x.credentials) || !x.credentials.every((c) => c && typeof c.env === "string" && isStrings(c.hosts) && (c.hostFromOption === undefined || typeof c.hostFromOption === "string"))) return "credentials must be a list of { env, hosts, hostFromOption? }";
  return null;
}

export function lockPath(auditDir: string): string {
  return join(auditDir, LOCK_FILE);
}

/** The audit repo's lock; empty when the file does not exist. */
export function readLock(auditDir: string): LockFile {
  const path = lockPath(auditDir);
  if (!existsSync(path)) return { schema: LOCK_SCHEMA, plugins: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new PluginError(`${path} is not valid JSON: ${(e as Error).message}`, "PLUGIN_INVALID", `restore it from git, or re-add the plugins with "pr-rla plugin add"`);
  }
  const l = raw as Partial<LockFile>;
  if (l?.schema !== LOCK_SCHEMA) throw new PluginError(`${path}: schema ${JSON.stringify(l?.schema)}; this pr-rla reads ${LOCK_SCHEMA}`, "PLUGIN_INVALID", "upgrade pr-rla, or restore the file from git");
  if (!l.plugins || typeof l.plugins !== "object" || Array.isArray(l.plugins)) throw new PluginError(`${path}: plugins must map each plugin's use to its entry`, "PLUGIN_INVALID", "restore it from git");
  for (const [use, e] of Object.entries(l.plugins)) {
    const p = entryProblem(e);
    if (p) throw new PluginError(`${path}: plugin ${use}: ${p}`, "PLUGIN_INVALID", "restore it from git, or re-add the plugin");
  }
  return l as LockFile;
}

function normalizedEntry(e: LockEntry): LockEntry {
  const sorted = (a: readonly string[]) => [...new Set(a)].sort();
  return {
    source: e.source,
    name: e.name,
    version: e.version,
    resolved: e.resolved,
    npmIntegrity: e.npmIntegrity,
    treeSha256: e.treeSha256,
    trust: e.trust,
    hosts: sorted(e.hosts),
    writePaths: sorted(e.writePaths),
    credentials: [...e.credentials].map((c) => ({ env: c.env, hosts: sorted(c.hosts), ...(c.hostFromOption !== undefined ? { hostFromOption: c.hostFromOption } : {}) })).sort((a, b) => (a.env < b.env ? -1 : a.env > b.env ? 1 : 0)),
  };
}

/** Writes the lock atomically, entries sorted. Only `plugin add` and `plugin lock` call this. */
export function writeLock(auditDir: string, lock: LockFile): void {
  const plugins = Object.fromEntries(Object.keys(lock.plugins).sort().map((use) => [use, normalizedEntry(lock.plugins[use]!)]));
  writeFileAtomic(lockPath(auditDir), `${JSON.stringify({ schema: LOCK_SCHEMA, plugins }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface PackageJson {
  name?: unknown;
  version?: unknown;
  main?: unknown;
  exports?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  "pr-rla"?: unknown;
}

export interface ResolvedDependency {
  name: string;
  version: string | null;
  dir: string;
  pkg: PackageJson;
}

export interface ResolvedPlugin {
  use: string;
  source: "package" | "path";
  /** The module file the host imports (a real path). */
  entry: string;
  /** The plugin's directory (a real path), or the entry file itself for a single-file plugin. */
  root: string;
  rootIsFile: boolean;
  pkg: PackageJson | null;
  /** Runtime dependencies, transitively, without pr-rla (a plugin links against the host's own SDK). */
  deps: ResolvedDependency[];
  version: string | null;
  /** What the lock records as `resolved`. */
  resolved: string | null;
  /** package-lock.json's entry, for a package plugin (null if the package-lock has none). */
  npm: { lockfile: string; version: string | null; resolved: string | null; integrity: string | null } | null;
}

function readPackageJson(dir: string): PackageJson | null {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PackageJson;
  } catch (e) {
    throw new PluginError(`${p} is not valid JSON: ${(e as Error).message}`, "PLUGIN_INVALID");
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The git work tree holding the audit directory, or the audit directory itself. A path plugin must live inside it. */
export function auditRepoRoot(auditDir: string): string {
  const start = realpathSync(auditDir);
  for (let d = start; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return start;
  }
}

/** Node's bare-specifier lookup: <dir>/node_modules/<name>, walking up. */
function findPackage(name: string, fromDir: string): { dir: string; installedAt: string } | null {
  for (let d = fromDir; ; d = dirname(d)) {
    const candidate = join(d, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return { dir: realpathSync(candidate), installedAt: d };
    if (dirname(d) === d) return null;
  }
}

/** The file a package's "." export (or main) names, under the node/import/default conditions. */
function packageEntry(dir: string, pkg: PackageJson): string {
  const pick = (t: unknown): string | null => {
    if (typeof t === "string") return t;
    if (Array.isArray(t)) {
      for (const x of t) {
        const r = pick(x);
        if (r) return r;
      }
      return null;
    }
    if (t && typeof t === "object") {
      for (const c of ["node", "import", "default"]) if (c in t) {
        const r = pick((t as Record<string, unknown>)[c]);
        if (r) return r;
      }
    }
    return null;
  };
  const exp = pkg.exports;
  let target: string | null = null;
  if (exp !== undefined && exp !== null) {
    if (typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."))) target = pick((exp as Record<string, unknown>)["."]);
    else target = pick(exp);
  }
  target ??= str(pkg.main) ?? "index.js";
  let file = resolve(dir, target);
  if (!existsSync(file) && existsSync(`${file}.js`)) file = `${file}.js`;
  if (!existsSync(file)) throw new PluginError(`package ${str(pkg.name) ?? dir}: its entry ${target} does not exist`, "PLUGIN_UNRESOLVED", "reinstall it (npm ci --ignore-scripts)");
  const real = realpathSync(file);
  if (!isInside(real, dir)) throw new PluginError(`package ${str(pkg.name) ?? dir}: its entry ${target} resolves outside the package (${real})`, "TREE_ESCAPE");
  return real;
}

function npmLockEntry(name: string, installedAt: string): ResolvedPlugin["npm"] {
  const lockfile = join(installedAt, "package-lock.json");
  if (!existsSync(lockfile)) return null;
  let lock: { packages?: Record<string, { version?: unknown; resolved?: unknown; integrity?: unknown; link?: unknown }> };
  try {
    lock = JSON.parse(readFileSync(lockfile, "utf8"));
  } catch {
    return null;
  }
  const e = lock.packages?.[`node_modules/${name}`];
  if (!e) return null;
  if (e.link === true && typeof e.resolved === "string") {
    // npm installed it from a local path: the target carries the version, and nothing carries an integrity.
    const target = lock.packages?.[e.resolved];
    return { lockfile, version: str(target?.version), resolved: `file:${e.resolved}`, integrity: null };
  }
  return { lockfile, version: str(e.version), resolved: str(e.resolved), integrity: str(e.integrity) };
}

function dependencyNames(pkg: PackageJson): { name: string; required: boolean }[] {
  const keys = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : []);
  const optional = new Set([...keys(pkg.optionalDependencies), ...keys(pkg.peerDependencies)]);
  const names = new Set([...keys(pkg.dependencies), ...optional]);
  return [...names].filter((n) => n !== "pr-rla").sort().map((name) => ({ name, required: keys(pkg.dependencies).includes(name) && !keys(pkg.optionalDependencies).includes(name) }));
}

function resolveDependencies(use: string, root: string, pkg: PackageJson | null): ResolvedDependency[] {
  if (!pkg) return [];
  const out = new Map<string, ResolvedDependency>();
  const queue: { from: string; pkg: PackageJson; who: string }[] = [{ from: root, pkg, who: use }];
  while (queue.length) {
    const { from, pkg: p, who } = queue.shift()!;
    for (const { name, required } of dependencyNames(p)) {
      const found = findPackage(name, from);
      if (!found) {
        if (required) throw new PluginError(`plugin ${use}: dependency ${name} of ${who} is not installed`, "PLUGIN_UNRESOLVED", "install the plugin's dependencies (npm ci --ignore-scripts)");
        continue;
      }
      if (out.has(found.dir) || found.dir === root) continue;
      const dp = readPackageJson(found.dir) ?? {};
      out.set(found.dir, { name, version: str(dp.version), dir: found.dir, pkg: dp });
      queue.push({ from: found.dir, pkg: dp, who: name });
    }
  }
  return [...out.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/**
 * Resolves an external plugin's `use` from the audit directory, as the host will load it:
 * - a package name: `<dir>/node_modules/<name>` walking up, its "." export or main;
 * - a path (relative to the audit directory, or a file: URL): it must stay inside the audit
 *   repo, so third-party verifiers have the same file. Its root is the nearest directory with a
 *   package.json between the file and the audit directory; without one it is the file alone.
 */
export function resolvePlugin(use: string, auditDir: string): ResolvedPlugin {
  const dir = realpathSync(auditDir);
  if (!isPathSpec(use)) {
    const found = findPackage(use, dir);
    if (!found) throw new PluginError(`cannot find package ${use} from ${dir}`, "PLUGIN_UNRESOLVED", `install it in the audit repo (npm install --save-exact ${use} --ignore-scripts), or use it by path`);
    const pkg = readPackageJson(found.dir) ?? {};
    const npm = npmLockEntry(use, found.installedAt);
    return {
      use,
      source: "package",
      entry: packageEntry(found.dir, pkg),
      root: found.dir,
      rootIsFile: false,
      pkg,
      deps: resolveDependencies(use, found.dir, pkg),
      version: str(pkg.version),
      resolved: npm?.resolved ?? null,
      npm,
    };
  }
  const abs = use.startsWith("file:") ? fileURLToPath(use) : resolve(dir, use);
  if (!existsSync(abs)) throw new PluginError(`plugin ${use}: no file at ${abs}`, "PLUGIN_UNRESOLVED", "check the path in .pr-rla.yml (relative to the audit directory)");
  const entry = realpathSync(abs);
  if (!statSync(entry).isFile()) throw new PluginError(`plugin ${use}: ${entry} is not a file; point use at the plugin's module file`, "PLUGIN_UNRESOLVED");
  const repo = auditRepoRoot(dir);
  if (!isInside(entry, repo)) throw new PluginError(`plugin ${use} resolves to ${entry}, outside the audit repo ${repo}`, "TREE_ESCAPE", "vendor the plugin into the audit repo, so third-party verifiers load the same files");
  let root = entry;
  for (let d = dirname(entry); isInside(d, repo) && d !== dir && d !== repo; d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) {
      root = d;
      break;
    }
  }
  const rootIsFile = root === entry;
  const pkg = rootIsFile ? null : readPackageJson(root);
  return { use, source: "path", entry, root, rootIsFile, pkg, deps: resolveDependencies(use, root, pkg), version: str(pkg?.version), resolved: `file:${toPosix(relative(dir, root)) || "."}`, npm: null };
}

// ---------------------------------------------------------------------------
// Tree hash
// ---------------------------------------------------------------------------

function hashTree(use: string, base: string, prefix: string, out: [string, string][]): void {
  const seen = new Set<string>([base]);
  const visit = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (rel === "" && SKIP.has(name)) continue;
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let real = abs;
      if (lstatSync(abs).isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(abs);
        } catch {
          throw new PluginError(`plugin ${use}: ${prefix}${r} is a dangling symlink; refusing to hash it`, "TREE_ESCAPE", "remove the symlink, or replace it with the file it should point to");
        }
        if (!isInside(target, base)) throw new PluginError(`plugin ${use}: ${prefix}${r} is a symlink to ${target}, outside ${base}; refusing to hash it`, "TREE_ESCAPE", "replace the symlink with the file it points to, or remove it");
        real = target;
      }
      const st = statSync(real);
      if (st.isDirectory()) {
        if (seen.has(real)) continue;
        seen.add(real);
        visit(real, r);
      } else if (st.isFile()) out.push([`${prefix}${r}`, sha256(readFileSync(real))]);
    }
  };
  visit(base, "");
}

/**
 * SHA-256 over the sorted lines `<file sha256>  <path>` for every file of the plugin (its
 * node_modules and .git excepted) and of each runtime dependency (as `node_modules/<name>@<version>/…`),
 * in the way Terraform's h1 hashes package contents. A symlink that leaves its tree aborts it.
 */
export function treeSha256(p: ResolvedPlugin): string {
  const files: [string, string][] = [];
  if (p.rootIsFile) files.push([basename(p.root), sha256(readFileSync(p.root))]);
  else hashTree(p.use, p.root, "", files);
  for (const d of p.deps) hashTree(p.use, d.dir, `node_modules/${d.name}@${d.version ?? ""}/`, files);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(files.map(([path, h]) => `${h}  ${path}\n`).join(""));
}

/**
 * The paths the host child may read: the plugin's files and its dependencies', never their
 * node_modules or .git. The trees are hashed first, so a symlink that leaves them aborts here,
 * before any child could read through it.
 */
export function readGrants(p: ResolvedPlugin): string[] {
  treeSha256(p);
  const children = (dir: string) => readdirSync(dir).filter((n) => !SKIP.has(n)).map((n) => join(dir, n));
  return [...(p.rootIsFile ? [p.root] : children(p.root)), ...p.deps.flatMap((d) => children(d.dir))];
}

/** Install scripts declared by the plugin or a dependency (npm runs them at install; pr-rla plugins need none). */
export function installScripts(p: ResolvedPlugin): { pkg: string; scripts: string[] }[] {
  const out: { pkg: string; scripts: string[] }[] = [];
  const check = (label: string, dir: string, pkg: PackageJson | null) => {
    const s = pkg?.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {};
    const found: string[] = INSTALL_SCRIPTS.filter((k) => typeof s[k] === "string");
    if (!found.includes("install") && existsSync(join(dir, "binding.gyp"))) found.push("install (binding.gyp)");
    if (found.length) out.push({ pkg: label, scripts: found });
  };
  if (!p.rootIsFile) check(str(p.pkg?.name) ?? p.use, p.root, p.pkg);
  for (const d of p.deps) check(`${d.name}@${d.version ?? "?"}`, d.dir, d.pkg);
  return out;
}

// ---------------------------------------------------------------------------
// Load-time checks
// ---------------------------------------------------------------------------

export type PluginPolicy = "locked" | "builtin-only";

/** `--plugins builtin-only` or `PR_RLA_PLUGINS=builtin-only` (FR2.6). Any other value is refused, so a typo never allows external code. */
export function pluginPolicy(flag: string | undefined, env: Readonly<Record<string, string | undefined>>): PluginPolicy {
  for (const [what, v] of [["--plugins", flag], ["PR_RLA_PLUGINS", env.PR_RLA_PLUGINS]] as const) {
    if (v === undefined || v === "") continue;
    if (v !== "builtin-only") throw new PluginError(`${what} ${JSON.stringify(v)}: the only value is builtin-only`, "PLUGIN_INVALID", `use ${what === "--plugins" ? "--plugins builtin-only" : "PR_RLA_PLUGINS=builtin-only"}, or leave it unset`);
    return "builtin-only";
  }
  return "locked";
}

/** Refuses an external plugin under builtin-only, before anything resolves or imports it. */
export function refuseIfBuiltinOnly(policy: PluginPolicy, kind: "provider" | "ledger", use: string): void {
  if (policy === "builtin-only")
    throw new PluginError(`${kind} ${use} is an external plugin, and --plugins builtin-only (or PR_RLA_PLUGINS=builtin-only) refuses all external code`, "BUILTIN_ONLY", `use a built-in ${kind}, or run without builtin-only`);
}

const short = (v: string | null) => (v === null ? "none" : v.length > 24 ? `${v.slice(0, 20)}…` : v);

/**
 * The lock entry for `use`, after re-resolving and re-hashing the installed plugin (FR2.2).
 * Refuses when the plugin is not locked, or when its version, npm integrity or files changed.
 */
export function verifyLocked(use: string, auditDir: string, lock: LockFile = readLock(auditDir)): { entry: LockEntry; plugin: ResolvedPlugin } {
  const entry = Object.hasOwn(lock.plugins, use) ? lock.plugins[use] : undefined;
  if (!entry) throw new PluginError(`plugin ${use} is not locked; review it and run "pr-rla plugin add ${use}"`, "NOT_LOCKED", `pr-rla plugin add ${use}`);
  const plugin = resolvePlugin(use, auditDir);
  const tree = treeSha256(plugin);
  const changed: string[] = [];
  if (plugin.source !== entry.source) changed.push(`source ${entry.source} → ${plugin.source}`);
  if (plugin.version !== entry.version) changed.push(`version ${entry.version ?? "none"} → ${plugin.version ?? "none"}`);
  const integrity = plugin.source === "package" ? (plugin.npm?.integrity ?? null) : null;
  if (integrity !== entry.npmIntegrity) changed.push(`npm integrity ${short(entry.npmIntegrity)} → ${short(integrity)}`);
  if (tree !== entry.treeSha256) changed.push(`treeSha256 ${entry.treeSha256.slice(0, 12)}… → ${tree.slice(0, 12)}…`);
  if (changed.length)
    throw new PluginError(`plugin ${use} changed since it was locked (${changed.join("; ")}); run "pr-rla plugin lock ${use}" after reviewing the change`, "LOCK_MISMATCH", `review the change, then: pr-rla plugin lock ${use}`);
  return { entry, plugin };
}

/**
 * The child's environment: PR_RLA_HOST=1 and a placeholder for each locked credential that is set
 * in the real environment (an unset one stays unset, as it would in process). Nothing else.
 */
export function placeholderEnv(credentials: readonly LockedCredential[], env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return { PR_RLA_HOST: "1", ...Object.fromEntries(credentials.filter((c) => env[c.env]).map((c) => [c.env, `prrla-cred:${c.env}`])) };
}
