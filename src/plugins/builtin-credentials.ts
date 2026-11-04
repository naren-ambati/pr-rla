import { githubEndpoints } from "../providers/github/index.js";
import { PluginError } from "./errors.js";

/**
 * Where each built-in provider and ledger sends which environment variable, for the options a
 * repo's .pr-rla.yml gives it (the plugin and broker fix round, finding 1, for built-ins).
 *
 * A built-in reads its token from the environment itself and sends it in `authorization`. A
 * third party's .pr-rla.yml chooses `token_env` and `base_url`, so without a check a verifier's
 * GITHUB_TOKEN (or any secret named in `token_env`) would go to whatever host the repo names. Each
 * entry here is one grant, (env var, origins): the built-in defaults in ./approvals.ts are
 * pre-approved; any other needs your approval, or the variable is withheld from the built-in, which
 * then runs anonymously. pr-rla computes this from the options, never from what a server says.
 *
 * Keep this in step with the built-ins: `test/builtin-consent.test.ts` runs every built-in on an
 * environment that records each variable it reads, and fails on one that is not listed here.
 */

export interface BuiltinCredentialUse {
  env: string;
  /** Every origin the built-in sends it to with these options (`scheme://host[:port]`). */
  origins: string[];
  /** false: an identity (Bitbucket's account e-mail), not a secret. */
  secret: boolean;
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * A URL option (`base_url`, `api_url`, `graphql_url`). The table computes where a built-in sends its
 * token from the same option the built-in uses, so both must read it the same way: anything but a
 * non-empty string (a list would be read as the default here and stringified to another URL there)
 * is refused.
 */
function urlOpt(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0) throw new PluginError(`${key} must be a URL (a string), got ${JSON.stringify(v) ?? String(v)}`, "PLUGIN_INVALID", `set ${key} to the server's https URL in .pr-rla.yml`);
  return v;
}

/**
 * An option naming an environment variable (`token_env`, `username_env`). The built-ins read
 * `env[options.token_env]`, and JavaScript reads `env[["X"]]` as `env.X`: anything but a variable
 * name is refused, so the table always knows which variable a built-in will read.
 */
function envName(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new PluginError(`${key} must be the name of an environment variable, got ${JSON.stringify(v) ?? String(v)}`, "PLUGIN_INVALID", `set ${key} to a variable name in .pr-rla.yml, such as ${key === "username_env" ? "BITBUCKET_USERNAME" : "GITHUB_TOKEN"}`);
  return v;
}

function uses(envs: (string | undefined)[], urls: string[], secret = true): BuiltinCredentialUse[] {
  const origins = [...new Set(urls.map(originOf).filter((o): o is string => o !== null))].sort();
  return [...new Set(envs.filter((e): e is string => !!e))].map((env) => ({ env, origins, secret }));
}

/** GitHub (provider and issues ledger): token_env, then GITHUB_TOKEN, GH_TOKEN, and GH_ENTERPRISE_TOKEN off github.com. */
function github(o: Record<string, unknown>, withGraphql: boolean): BuiltinCredentialUse[] {
  const base = urlOpt(o, "base_url");
  const api = urlOpt(o, "api_url");
  const gql = withGraphql ? urlOpt(o, "graphql_url") : undefined;
  const urls = githubEndpoints({ ...(base ? { base_url: base } : {}), ...(api ? { api_url: api } : {}), ...(gql ? { graphql_url: gql } : {}) });
  return uses([envName(o, "token_env"), "GITHUB_TOKEN", "GH_TOKEN", urls.enterprise ? "GH_ENTERPRISE_TOKEN" : undefined], withGraphql ? [urls.apiUrl, urls.graphqlUrl] : [urls.apiUrl]);
}

const gitlabBase = (o: Record<string, unknown>) => (urlOpt(o, "base_url") ?? "https://gitlab.com").replace(/\/+$/, "").replace(/\/api\/v4$/, "");

const PROVIDERS: Readonly<Record<string, (o: Record<string, unknown>) => BuiltinCredentialUse[]>> = {
  github: (o) => github(o, true),
  gitlab: (o) => uses([envName(o, "token_env") ?? "GITLAB_TOKEN"], [gitlabBase(o)]),
  "bitbucket-cloud": (o) => {
    const api = urlOpt(o, "api_url") ?? "https://api.bitbucket.org/2.0";
    return [...uses([envName(o, "token_env") ?? "BITBUCKET_TOKEN"], [api]), ...uses([envName(o, "username_env") ?? "BITBUCKET_USERNAME"], [api], false)];
  },
  "bitbucket-data-center": (o) => {
    const base = urlOpt(o, "base_url");
    return base ? uses([envName(o, "token_env") ?? "BITBUCKET_DC_TOKEN"], [base]) : [];
  },
  "json-file": () => [],
};

const LEDGERS: Readonly<Record<string, (o: Record<string, unknown>) => BuiltinCredentialUse[]>> = {
  "github-issues": (o) => github(o, false),
  "gitlab-issues": (o) => uses([envName(o, "token_env") ?? "GITLAB_TOKEN"], [gitlabBase(o)]),
  "git-file": () => [],
};

/** The grants a built-in makes with these options; `name` is its built-in name (aliases resolved). */
export function builtinCredentialUses(kind: "provider" | "ledger", name: string, options: unknown): BuiltinCredentialUse[] {
  const f = (kind === "provider" ? PROVIDERS : LEDGERS)[name];
  if (!f) throw new Error(`no credential table for built-in ${kind} ${name}`);
  return f(options && typeof options === "object" ? (options as Record<string, unknown>) : {});
}
