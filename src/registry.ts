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
import github from "./providers/github/index.js";
import gitlab from "./providers/gitlab/index.js";
import bitbucketCloud from "./providers/bitbucket-cloud/index.js";
import bitbucketDataCenter from "./providers/bitbucket-data-center/index.js";
import jsonFile from "./providers/json-file.js";
import gitFile from "./ledgers/git-file.js";

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
};

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
