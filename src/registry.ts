import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertLedgerDefinition,
  SUPPORTED_LEDGER_API_VERSIONS,
  LedgerApiVersionError,
  type Ledger,
  type LedgerContext,
  type LedgerDefinition,
} from "./sdk/ledger.js";
import {
  assertProviderDefinition,
  ProviderApiVersionError,
  SUPPORTED_PROVIDER_API_VERSIONS,
  type ProviderContext,
  type ProviderDefinition,
  type ScmProvider,
} from "./sdk/provider.js";
import { sha256Hex, canonicalJson } from "./core/canonical.js";
import type { PluginIdentity } from "./core/records.js";
import { externalPluginInfo } from "./plugins/identity.js";
import type { PluginPolicy, PluginRules } from "./plugins/lock.js";
import { PR_RLA_VERSION } from "./version.js";
import github from "./providers/github/index.js";
import gitlab from "./providers/gitlab/index.js";
import bitbucketCloud from "./providers/bitbucket-cloud/index.js";
import bitbucketDataCenter from "./providers/bitbucket-data-center/index.js";
import jsonFile from "./providers/json-file.js";
import gitFile from "./ledgers/git-file.js";
import githubIssues from "./ledgers/github-issues/index.js";
import gitlabIssues from "./ledgers/gitlab-issues/index.js";

/**
 * The plugin registry: the only place that knows concrete providers/ledgers.
 * `.pr-rla.yml` names one by built-in name, by path (`./my-provider.mjs`) or by
 * package name (`pr-rla-provider-gitea`); external ones are loaded with import().
 */
export interface PluginSpec {
  use: string;
  options: Record<string, unknown>;
}

export const BUILTIN_PROVIDERS: Readonly<Record<string, ProviderDefinition<never>>> = {
  github: github as ProviderDefinition<never>,
  gitlab: gitlab as ProviderDefinition<never>,
  "bitbucket-cloud": bitbucketCloud as ProviderDefinition<never>,
  "bitbucket-data-center": bitbucketDataCenter as ProviderDefinition<never>,
  "json-file": jsonFile as ProviderDefinition<never>,
};
const PROVIDER_ALIASES: Record<string, string> = { json: "json-file", bitbucket: "bitbucket-cloud", "bitbucket-server": "bitbucket-data-center", "bitbucket-dc": "bitbucket-data-center" };

export const BUILTIN_LEDGERS: Readonly<Record<string, LedgerDefinition<never>>> = {
  "git-file": gitFile as LedgerDefinition<never>,
  "github-issues": githubIssues as LedgerDefinition<never>,
  "gitlab-issues": gitlabIssues as LedgerDefinition<never>,
};

/** The built-in provider `use` names (aliases resolved), or null for an external plugin. Imports nothing. */
export function builtinProviderName(use: string): string | null {
  const name = PROVIDER_ALIASES[use] ?? use;
  return Object.hasOwn(BUILTIN_PROVIDERS, name) ? name : null;
}

/** The built-in ledger `use` names, or null for an external plugin. */
export function builtinLedgerName(use: string): string | null {
  return Object.hasOwn(BUILTIN_LEDGERS, use) ? use : null;
}

export function normalizePluginSpec(raw: unknown, what: string, fallback: string): PluginSpec {
  if (raw === undefined || raw === null) return { use: fallback, options: {} };
  if (typeof raw === "string") return { use: raw, options: {} };
  if (typeof raw === "object" && typeof (raw as { use?: unknown }).use === "string") {
    const o = (raw as { options?: unknown }).options;
    if (o !== undefined && (typeof o !== "object" || o === null || Array.isArray(o))) throw new Error(`${what}.options must be a mapping`);
    return { use: (raw as { use: string }).use, options: (o ?? {}) as Record<string, unknown> };
  }
  throw new Error(`${what} must be a name or { use: <name|path|package>, options: {...} }`);
}

function isPathLike(use: string): boolean {
  return use.startsWith("./") || use.startsWith("../") || isAbsolute(use) || use.startsWith("file:");
}

/** Imports an external plugin module by path (relative to the audit repo) or by package name (resolved from the audit repo). */
export async function importPlugin(use: string, baseDir: string): Promise<Record<string, unknown>> {
  if (use.startsWith("file:")) return (await import(use)) as Record<string, unknown>;
  if (isPathLike(use)) return (await import(pathToFileURL(resolve(baseDir, use)).href)) as Record<string, unknown>;
  try {
    const resolved = createRequire(join(baseDir, "noop.js")).resolve(use);
    return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch {
    return (await import(use)) as Record<string, unknown>;
  }
}

function pickExport(mod: Record<string, unknown>, named: string): unknown {
  return mod.default ?? mod[named];
}

export async function loadProviderDefinition(use: string, baseDir: string): Promise<ProviderDefinition> {
  const name = PROVIDER_ALIASES[use] ?? use;
  const builtin = BUILTIN_PROVIDERS[name];
  if (builtin) return builtin as ProviderDefinition;
  let mod: Record<string, unknown>;
  try {
    mod = await importPlugin(use, baseDir);
  } catch (e) {
    throw new Error(`cannot load provider "${use}": ${(e as Error).message}. Built-in providers: ${Object.keys(BUILTIN_PROVIDERS).join(", ")}`);
  }
  const def = pickExport(mod, "provider");
  assertProviderDefinition(def, `provider "${use}"`);
  return def;
}

export async function createProvider(spec: PluginSpec, ctx: ProviderContext): Promise<ScmProvider> {
  const def = await loadProviderDefinition(spec.use, ctx.cwd);
  const p = await def.create(spec.options as never, ctx);
  if (!SUPPORTED_PROVIDER_API_VERSIONS.includes(p.apiVersion)) throw new ProviderApiVersionError(def.name, p.apiVersion);
  if (typeof p.listChanges !== "function") throw new Error(`provider "${def.name}" returned an object without listChanges()`);
  return p;
}

export async function loadLedgerDefinition(use: string, baseDir: string): Promise<LedgerDefinition> {
  const builtin = BUILTIN_LEDGERS[use];
  if (builtin) return builtin as LedgerDefinition;
  let mod: Record<string, unknown>;
  try {
    mod = await importPlugin(use, baseDir);
  } catch (e) {
    throw new Error(`cannot load ledger "${use}": ${(e as Error).message}. Built-in ledgers: ${Object.keys(BUILTIN_LEDGERS).join(", ")}`);
  }
  const def = pickExport(mod, "ledger");
  assertLedgerDefinition(def, `ledger "${use}"`);
  return def;
}

export async function createLedger(spec: PluginSpec, ctx: LedgerContext): Promise<Ledger> {
  const def = await loadLedgerDefinition(spec.use, ctx.cwd);
  const l = await def.create(spec.options as never, ctx);
  if (!SUPPORTED_LEDGER_API_VERSIONS.includes(l.apiVersion)) throw new LedgerApiVersionError(def.name, l.apiVersion);
  for (const m of ["readVerdicts", "appendVerdict"] as const) if (typeof l[m] !== "function") throw new Error(`ledger "${def.name}" has no ${m}()`);
  return l;
}

/** SHA-256 over the canonical JSON of `options` restricted to `keys`. */
export function optionsDigest(options: Record<string, unknown>, keys?: readonly string[]): string {
  const picked = keys ? Object.fromEntries(keys.filter((k) => k in options).map((k) => [k, options[k]])) : options;
  return sha256Hex(canonicalJson(picked));
}

function packageVersion(use: string, baseDir: string): string | null {
  try {
    const pkg = createRequire(join(baseDir, "noop.js")).resolve(`${use}/package.json`);
    const v = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * What a registration or manifest records about a provider or ledger (contracts.md §5).
 * Built-ins carry the pr-rla version. An external plugin's identity comes from its
 * pr-rla.lock.json entry after its files are re-hashed (FR2.1): `integrity` is the locked
 * treeSha256 and `trust` the locked trust. An unlocked or changed plugin is refused, and
 * `builtin-only` refuses every external one (src/plugins/identity.ts). Pass the AuditContext as
 * `policy` so a `trust: full` plugin you approved can be read (a bare policy carries no consent).
 */
export async function pluginIdentity(spec: PluginSpec, kind: "provider" | "ledger", baseDir: string, policy: PluginPolicy | PluginRules = "locked"): Promise<PluginIdentity> {
  if (!(kind === "provider" ? builtinProviderName(spec.use) : builtinLedgerName(spec.use))) {
    const { entry, traits } = await externalPluginInfo(spec.use, kind, baseDir, policy, spec.options);
    return {
      name: entry.name,
      source: entry.source,
      version: entry.version,
      integrity: entry.treeSha256,
      optionsSha256: optionsDigest(spec.options),
      populationOptionsSha256: optionsDigest(spec.options, traits.populationOptions),
      trust: entry.trust,
    };
  }
  const builtinName = kind === "provider" ? (BUILTIN_PROVIDERS[PROVIDER_ALIASES[spec.use] ?? spec.use] ? PROVIDER_ALIASES[spec.use] ?? spec.use : null) : BUILTIN_LEDGERS[spec.use] ? spec.use : null;
  const def = kind === "provider" ? await loadProviderDefinition(spec.use, baseDir) : await loadLedgerDefinition(spec.use, baseDir);
  const populationOptions = (def as { populationOptions?: unknown }).populationOptions;
  const keys = Array.isArray(populationOptions) ? populationOptions.filter((k): k is string => typeof k === "string") : [];
  return {
    name: builtinName ?? def.name,
    source: builtinName ? "builtin" : isPathLike(spec.use) ? "path" : "package",
    version: builtinName ? PR_RLA_VERSION : isPathLike(spec.use) ? null : packageVersion(spec.use, baseDir),
    integrity: null,
    optionsSha256: optionsDigest(spec.options),
    populationOptionsSha256: optionsDigest(spec.options, keys),
    trust: builtinName ? "builtin" : "full",
  };
}
