/**
 * Default rate budgets (NFR12; nfr-design.md §3). Each default is the smallest limit
 * the service publishes for the request's auth state, with the page it comes from.
 * A request with an `Authorization` or `Private-Token` header counts as authenticated.
 *
 * Every rule is a token bucket: up to `burst` requests at once, refilled at `count`
 * per `perMs`. "N per window" limits have `burst = N`; a spacing guideline (one
 * request per 15 s) has `burst = 1`. Rules marked `primary` are the limits a service
 * reports in its own headers: once a response carries them, the headers replace the
 * rule for that resource for the rest of the run (FR10.4). Secondary limits are never
 * reported, so they always apply. `.pr-rla.yml` can change any rule (`rate_limits:`).
 *
 * Checked 2026-11-03 (BUILD-NOTES, "Bolt 2 (U2a)"). `test/broker.test.ts` asserts that
 * every value equals its row in the reviewed table.
 */

export type RuleScope = "all" | "rest" | "graphql" | "writes";
export type AuthState = "authenticated" | "anonymous";

export interface RateRule {
  /** The key `.pr-rla.yml` uses to change this rule. */
  id: string;
  /** Which requests count: all, REST (not GraphQL), GraphQL, or writes (non-GET REST and GraphQL mutations). */
  scope: RuleScope;
  /** `requests`: one per request. `points`: GitHub's secondary-limit points (reads 1, writes and mutations 5). */
  cost: "requests" | "points";
  auth: AuthState | "any";
  count: number;
  perMs: number;
  burst: number;
  primary: boolean;
  /** Only requests whose path starts with this count. */
  pathPrefix?: string;
  /** One bucket per value of this pattern's first group (Jira: per issue). */
  keyPattern?: RegExp;
  /** The published limit, in the source's words. */
  published: string;
  source: string;
}

export interface HostBudgetDefault {
  service: string;
  rules: RateRule[];
  /** Requests in flight at once, or null for no published limit. */
  concurrency: { limit: number; published: string; source: string } | null;
}

const H = 3_600_000;
const MIN = 60_000;

const GITHUB_REST = "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api";
const GITHUB_GRAPHQL = "https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api";
const GITLAB = "https://docs.gitlab.com/user/gitlab_com/rate_limits/";
const BITBUCKET_CLOUD = "https://support.atlassian.com/bitbucket-cloud/docs/api-request-limits/";
const BITBUCKET_DC = "https://confluence.atlassian.com/bitbucketserver/improving-instance-stability-with-rate-limiting-976171954.html";
const JIRA = "https://developer.atlassian.com/cloud/jira/platform/rate-limiting/";
const SECTIGO = "https://www.sectigo.com/resource-library/time-stamping-server";
const FREETSA = "https://freetsa.org/freetsa.html";

type RuleInput = Omit<RateRule, "burst"> & { burst?: number };
const rule = (r: RuleInput): RateRule => ({ ...r, burst: r.burst ?? r.count });

/** Budgets by service. Keys are the families built-in providers and hosts map to. */
export const BUDGET_FAMILIES = {
  github: {
    service: "GitHub",
    rules: [
      rule({ id: "rest", scope: "rest", cost: "requests", auth: "authenticated", count: 1_000, perMs: H, primary: true, published: "GITHUB_TOKEN in GitHub Actions: 1,000 requests per hour per repository (personal tokens 5,000)", source: GITHUB_REST }),
      rule({ id: "rest_anonymous", scope: "rest", cost: "requests", auth: "anonymous", count: 60, perMs: H, primary: true, published: "unauthenticated: 60 requests per hour", source: GITHUB_REST }),
      rule({ id: "rest_points", scope: "rest", cost: "points", auth: "any", count: 900, perMs: MIN, primary: false, published: "no more than 900 points per minute for REST API endpoints (GET, HEAD, OPTIONS 1 point; POST, PATCH, PUT, DELETE 5)", source: GITHUB_REST }),
      rule({ id: "graphql", scope: "graphql", cost: "requests", auth: "authenticated", count: 1_000, perMs: H, primary: true, published: "GITHUB_TOKEN: 1,000 points per hour per repository (users 5,000 points per hour)", source: GITHUB_GRAPHQL }),
      rule({ id: "graphql_points", scope: "graphql", cost: "points", auth: "any", count: 2_000, perMs: MIN, primary: false, published: "no more than 2,000 points per minute for the GraphQL API endpoint (without mutations 1 point; with mutations 5)", source: GITHUB_GRAPHQL }),
      rule({ id: "writes_per_minute", scope: "writes", cost: "requests", auth: "any", count: 80, perMs: MIN, primary: false, published: "no more than 80 content-generating requests per minute", source: GITHUB_REST }),
      rule({ id: "writes_per_hour", scope: "writes", cost: "requests", auth: "any", count: 500, perMs: H, primary: false, published: "no more than 500 content-generating requests per hour", source: GITHUB_REST }),
    ],
    concurrency: { limit: 100, published: "no more than 100 concurrent requests", source: GITHUB_REST },
  },
  gitlab: {
    service: "GitLab.com",
    rules: [
      rule({ id: "api", scope: "all", cost: "requests", auth: "authenticated", count: 2_000, perMs: MIN, primary: true, published: "authenticated API traffic for a user: 2,000 requests each minute", source: GITLAB }),
      rule({ id: "api_anonymous", scope: "all", cost: "requests", auth: "anonymous", count: 500, perMs: MIN, primary: true, published: "unauthenticated traffic from an IP address: 500 requests each minute", source: GITLAB }),
    ],
    concurrency: null,
  },
  "bitbucket-cloud": {
    service: "Bitbucket Cloud",
    rules: [
      rule({ id: "repositories", scope: "all", cost: "requests", auth: "authenticated", count: 1_000, perMs: H, primary: true, pathPrefix: "/2.0/repositories/", published: "repository data (/2.0/repositories/*): 1,000 requests per hour (scaled up to 10,000 only for large paid workspaces using access tokens)", source: BITBUCKET_CLOUD }),
      rule({ id: "anonymous", scope: "all", cost: "requests", auth: "anonymous", count: 60, perMs: H, primary: true, published: "anonymous: 60 requests per hour across all API resources", source: BITBUCKET_CLOUD }),
    ],
    concurrency: null,
  },
  "bitbucket-data-center": {
    service: "Bitbucket Data Center",
    rules: [rule({ id: "api", scope: "all", cost: "requests", auth: "authenticated", count: 5, perMs: 1_000, burst: 60, primary: false, published: "default token bucket per user: size 60, refill 5 tokens per second (admin-configurable)", source: BITBUCKET_DC })],
    concurrency: null,
  },
  "jira-cloud": {
    service: "Jira Cloud",
    rules: [
      rule({ id: "issue_writes_2s", scope: "writes", cost: "requests", auth: "any", count: 20, perMs: 2_000, primary: false, keyPattern: /\/rest\/api\/[23]\/issue\/([^/?#]+)/, published: "per issue: 20 write operations per 2 seconds", source: JIRA }),
      rule({ id: "issue_writes_30s", scope: "writes", cost: "requests", auth: "any", count: 100, perMs: 30_000, primary: false, keyPattern: /\/rest\/api\/[23]\/issue\/([^/?#]+)/, published: "per issue: 100 write operations per 30 seconds", source: JIRA }),
    ],
    concurrency: null,
  },
  sectigo: {
    service: "Sectigo timestamp authority",
    rules: [rule({ id: "spacing", scope: "all", cost: "requests", auth: "any", count: 1, perMs: 15_000, primary: false, published: "if you are timestamping several items with a script, please add a delay of 15 seconds or more between each one", source: SECTIGO })],
    concurrency: null,
  },
  freetsa: {
    service: "FreeTSA",
    rules: [rule({ id: "spacing", scope: "all", cost: "requests", auth: "any", count: 1, perMs: 1_000, primary: false, published: "a maximum of one timestamping request per second per IP address", source: FREETSA })],
    concurrency: null,
  },
} satisfies Record<string, HostBudgetDefault>;

export type BudgetFamily = keyof typeof BUDGET_FAMILIES;

/**
 * Public hosts with a default budget. Self-hosted servers (GitHub Enterprise Server,
 * GitLab self-managed, Bitbucket Data Center) get their provider's family for the hosts
 * the provider declares. Other timestamp authorities and drand publish no limit, and
 * pr-rla sends them one request per record or round.
 */
export const DEFAULT_HOSTS: Readonly<Record<string, BudgetFamily>> = {
  "api.github.com": "github",
  "gitlab.com": "gitlab",
  "api.bitbucket.org": "bitbucket-cloud",
  "*.atlassian.net": "jira-cloud",
  "timestamp.sectigo.com": "sectigo",
  "freetsa.org": "freetsa",
};

/** The family of each built-in provider, applied to the hosts it declares. */
export const PROVIDER_BUDGET_FAMILY: Readonly<Record<string, BudgetFamily>> = {
  github: "github",
  gitlab: "gitlab",
  "bitbucket-cloud": "bitbucket-cloud",
  "bitbucket-data-center": "bitbucket-data-center",
};

const clone = (b: HostBudgetDefault): HostBudgetDefault => ({ ...b, rules: b.rules.map((r) => ({ ...r })), concurrency: b.concurrency ? { ...b.concurrency } : null });

export function familyBudget(family: BudgetFamily): HostBudgetDefault {
  return clone(BUDGET_FAMILIES[family]);
}

/** A fresh map of the default budgets by host (callers may change their copy). */
export function defaultBudgets(): Map<string, HostBudgetDefault> {
  return new Map(Object.entries(DEFAULT_HOSTS).map(([host, family]) => [host, familyBudget(family)]));
}

/** The budget for a host: an exact entry, else a `*.domain` entry. */
export function budgetFor(budgets: ReadonlyMap<string, HostBudgetDefault>, host: string): HostBudgetDefault | undefined {
  const exact = budgets.get(host);
  if (exact) return exact;
  for (const [pattern, b] of budgets) if (pattern.startsWith("*.") && host.endsWith(pattern.slice(1))) return b;
  return undefined;
}

/** Minimum spacing between timestamp requests, from the spacing rules above (bolt 1's adapter constant). */
export const HOST_SPACING_MS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(DEFAULT_HOSTS)
    .map(([host, family]) => [host, BUDGET_FAMILIES[family].rules.find((r) => r.id === "spacing")] as const)
    .filter(([, r]) => r !== undefined)
    .map(([host, r]) => [host, r!.perMs / r!.count]),
);

/** A one-rule budget that spaces requests to a host by `ms`. */
export function spacingBudget(service: string, ms: number, source = "configured"): HostBudgetDefault {
  return { service, rules: [rule({ id: "spacing", scope: "all", cost: "requests", auth: "any", count: 1, perMs: ms, primary: false, published: `one request per ${ms / 1000} s`, source })], concurrency: null };
}

const UNITS: Record<string, number> = { ms: 1, s: 1_000, sec: 1_000, min: MIN, m: MIN, h: H, hr: H, hour: H, d: 24 * H, day: 24 * H };

/** Parses `5000/h`, `20/2s`, `5/s`, `900/min` into a count per milliseconds. */
export function parseRate(spec: string): { count: number; perMs: number } {
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)?\s*([a-z]+)\s*$/i.exec(spec);
  const unit = m ? UNITS[m[3]!.toLowerCase()] : undefined;
  const count = m ? Number(m[1]) : NaN;
  const per = m?.[2] ? Number(m[2]) : 1;
  if (!m || unit === undefined || !(count > 0) || !(per > 0)) throw new Error(`"${spec}" is not a rate; write <count>/<unit>, e.g. 5000/h, 900/min, 20/2s or 5/s`);
  return { count, perMs: per * unit };
}

/** `rate_limits:` in .pr-rla.yml: per host, a rate (`5000/h`) or `{ rate, burst }` per rule id, and `concurrency: <n>`. */
export type RateLimitOverrides = Record<string, Record<string, unknown>>;

/** Applies one host's overrides to its default budget. Unknown rule ids are refused, so a typo is not silently ignored. */
export function applyRateOverrides(budget: HostBudgetDefault, overrides: Record<string, unknown>, where: string): HostBudgetDefault {
  const out = clone(budget);
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "concurrency") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${where}.concurrency must be a whole number >= 1`);
      out.concurrency = { limit: value, published: out.concurrency?.published ?? "none published", source: "configured in .pr-rla.yml" };
      continue;
    }
    const r = out.rules.find((x) => x.id === key);
    if (!r) throw new Error(`${where}.${key}: ${out.service} has no rule "${key}" (rules: ${[...out.rules.map((x) => x.id), ...(out.concurrency ? ["concurrency"] : [])].join(", ")})`);
    const spec = typeof value === "string" ? { rate: value } : value && typeof value === "object" ? (value as { rate?: unknown; burst?: unknown }) : null;
    if (!spec || typeof spec.rate !== "string") throw new Error(`${where}.${key} must be a rate like "5000/h", or { rate: "5/s", burst: 60 }`);
    const { count, perMs } = parseRate(spec.rate);
    if (spec.burst !== undefined && (typeof spec.burst !== "number" || !(spec.burst >= 1))) throw new Error(`${where}.${key}.burst must be a number >= 1`);
    Object.assign(r, { count, perMs, burst: (spec.burst as number | undefined) ?? count, source: "configured in .pr-rla.yml" });
  }
  return out;
}
