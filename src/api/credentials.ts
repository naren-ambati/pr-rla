import type { PluginCredential } from "../sdk/provider.js";

/**
 * The credentials a built-in provider or ledger gets in read-only mode (pr-rla/api/read, the MCP
 * server; U5 fix round). The audit repo's `.pr-rla.yml` is not the operator's: in read-only mode
 * it cannot choose which of the operator's secrets a built-in reads, nor where they are sent.
 *
 * - A built-in reads only its documented default token variables, and gets them as placeholders
 *   (`prrla-cred:<ENV>`): the fetch broker swaps a placeholder for the secret only on the built-in's
 *   default https origin (its credential host check), so a request anywhere else carries none.
 * - A `token_env` / `username_env` naming another variable, or a non-default base URL, needs the
 *   operator's consent. This branch has no consent store: the credential is withheld, the call runs
 *   without it, and the call's log says so (`withheld`). See `operatorConsents` below.
 * - Nothing else of the environment reaches a built-in.
 *
 * The CLI (read-write) is unchanged: built-ins read the person's own environment, as they always have.
 */

interface BuiltinCredentialRule {
  /** The documented default token variables, in the order the built-in reads them. */
  names: readonly string[];
  /** The default origin's host (https), or null when the built-in has none (Data Center is self-hosted). */
  host: string | null;
  /** Options that move the built-in off its default origin, or name other variables. */
  nonDefault: (o: Record<string, unknown>, names: readonly string[]) => string[];
}

const str = (v: unknown) => (typeof v === "string" && v.length ? v : null);
const off = (o: Record<string, unknown>, key: string, allowed: readonly string[] = []): string | null => {
  const v = str(o[key]);
  return v !== null && !allowed.includes(v.replace(/\/+$/, "")) ? `${key} ${v}` : null;
};
const otherName = (o: Record<string, unknown>, key: string, names: readonly string[]): string | null => {
  const v = str(o[key]);
  return v !== null && !names.includes(v) ? `${key} ${v}` : null;
};
const reasons = (...r: (string | null)[]) => r.filter((x): x is string => x !== null);

const RULES: Readonly<Record<string, BuiltinCredentialRule>> = {
  github: {
    names: ["GITHUB_TOKEN", "GH_TOKEN"],
    host: "api.github.com",
    nonDefault: (o, n) => reasons(off(o, "base_url", ["https://github.com", "https://www.github.com"]), off(o, "api_url", ["https://api.github.com"]), off(o, "graphql_url", ["https://api.github.com/graphql"]), otherName(o, "token_env", n)),
  },
  "github-issues": {
    names: ["GITHUB_TOKEN", "GH_TOKEN"],
    host: "api.github.com",
    nonDefault: (o, n) => reasons(off(o, "base_url", ["https://github.com", "https://www.github.com"]), off(o, "api_url", ["https://api.github.com"]), otherName(o, "token_env", n)),
  },
  gitlab: { names: ["GITLAB_TOKEN"], host: "gitlab.com", nonDefault: (o, n) => reasons(off(o, "base_url", ["https://gitlab.com", "https://gitlab.com/api/v4"]), otherName(o, "token_env", n)) },
  "gitlab-issues": { names: ["GITLAB_TOKEN"], host: "gitlab.com", nonDefault: (o, n) => reasons(off(o, "base_url", ["https://gitlab.com", "https://gitlab.com/api/v4"]), otherName(o, "token_env", n)) },
  "bitbucket-cloud": {
    names: ["BITBUCKET_TOKEN", "BITBUCKET_USERNAME"],
    host: "api.bitbucket.org",
    nonDefault: (o, n) => reasons(off(o, "api_url", ["https://api.bitbucket.org/2.0"]), otherName(o, "token_env", n), otherName(o, "username_env", n)),
  },
  // Self-hosted: there is no default origin, so its token always needs the operator's consent.
  "bitbucket-data-center": { names: ["BITBUCKET_DC_TOKEN"], host: null, nonDefault: (o) => reasons(str(o.base_url) ? `base_url ${str(o.base_url)}` : "no default origin", otherName(o, "token_env", ["BITBUCKET_DC_TOKEN"])) },
  "json-file": { names: [], host: null, nonDefault: () => [] },
  "git-file": { names: [], host: null, nonDefault: () => [] },
};

/**
 * INTEGRATION HOOK: the operator's consent to a credential the audit repo's config asks for (a
 * `token_env`, a non-default base URL). The plugin fix round's approvals store
 * (`PR_RLA_APPROVALS_FILE`, `pr-rla plugin approve`) answers this once the branches are joined; until
 * then nothing is consented to, so the credential is withheld.
 */
export function operatorConsents(_request: { builtin: string; reasons: readonly string[]; names: readonly string[] }): boolean {
  return false;
}

export interface ReadOnlyCredentials {
  /** The environment the built-in sees: a placeholder for each granted variable that is set, nothing else. */
  env: Record<string, string>;
  /** The broker grants: each placeholder may be swapped only on the default origin. */
  credentials: PluginCredential[];
  /** Why a credential was withheld, for the call's log; null when nothing was. */
  withheld: string | null;
}

/** The read-only credentials of built-in `name` for these options, from the operator's environment. */
export function readOnlyBuiltinCredentials(name: string, options: Record<string, unknown>, env: Readonly<Record<string, string | undefined>>): ReadOnlyCredentials {
  const rule = RULES[name];
  if (!rule) return { env: {}, credentials: [], withheld: null };
  const present = rule.names.filter((n) => typeof env[n] === "string" && env[n] !== "");
  const why = rule.nonDefault(options, rule.names);
  const asked = [...new Set([...present, ...["token_env", "username_env"].map((k) => str(options[k])).filter((v): v is string => v !== null && typeof env[v] === "string" && env[v] !== "")])];
  if (why.length && !operatorConsents({ builtin: name, reasons: why, names: asked })) {
    // Off the default origin, no default credential is sent either; with only another variable named, the defaults still go to the default origin.
    const movesOrigin = rule.host === null || why.some((w) => !/^(token_env|username_env) /.test(w));
    const withheld = asked.length ? `read-only: ${name} gets ${movesOrigin ? "no credential" : `only ${present.join(", ") || "no credential"}`} (${why.join("; ")} needs the operator's consent, which this build cannot record yet); the call runs ${movesOrigin || !present.length ? "anonymously" : "with the default token only"}` : null;
    if (movesOrigin || rule.host === null) return { env: {}, credentials: [], withheld };
    return grant(present, rule.host, withheld);
  }
  return rule.host === null ? { env: {}, credentials: [], withheld: null } : grant(present, rule.host, null);
}

function grant(names: readonly string[], host: string, withheld: string | null): ReadOnlyCredentials {
  return { env: Object.fromEntries(names.map((n) => [n, `prrla-cred:${n}`])), credentials: names.map((n) => ({ env: n, hosts: [host] })), withheld };
}
