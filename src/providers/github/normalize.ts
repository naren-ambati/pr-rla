import type { Actor, ChangeRecord, Review, ReviewState } from "../../sdk/provider.js";

/** Raw GitHub shapes pr-rla reads (subsets of the REST/GraphQL responses). */
export interface GqlActor {
  __typename?: string;
  login: string;
}

export interface GqlReview {
  state: string;
  submittedAt: string | null;
  author: GqlActor | null;
}

export interface GqlPullRequest {
  number: number;
  url: string;
  merged: boolean;
  mergedAt: string | null;
  baseRefName: string;
  additions: number;
  deletions: number;
  author: GqlActor | null;
  mergedBy: GqlActor | null;
  mergeCommit: { oid: string } | null;
  labels: { nodes: { name: string }[] };
  reviews: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlReview[] };
}

export interface GqlHistoryCommit {
  oid: string;
  url: string;
  committedDate: string;
  additions: number;
  deletions: number;
  parents: { nodes: { oid: string }[] };
  author: { name: string | null; email: string | null; user: { login: string } | null } | null;
  associatedPullRequests: { nodes: { number: number; merged: boolean; baseRefName: string }[] };
}

const BOT_SUFFIX = "[bot]";

/**
 * GitHub GraphQL reports bot accounts as `__typename: "Bot"` with the bare app
 * slug as login (`copilot-swe-agent`); REST shows `copilot-swe-agent[bot]`-style
 * logins. pr-rla normalizes every bot to the `[bot]` form. A deleted account
 * (null actor) becomes `ghost`, counted as human: the conservative choice for
 * "no human review" (a ghost approval is not treated as missing review).
 */
export function normalizeActor(a: GqlActor | null): Actor {
  if (!a) return { login: "ghost", kind: "human" };
  const isBot = a.__typename === "Bot" || a.login.endsWith(BOT_SUFFIX);
  if (!isBot) return { login: a.login, kind: "human" };
  return { login: a.login.endsWith(BOT_SUFFIX) ? a.login : `${a.login}${BOT_SUFFIX}`, kind: "bot" };
}

const STATES: Record<string, ReviewState> = {
  APPROVED: "APPROVED",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  COMMENTED: "COMMENTED",
  DISMISSED: "DISMISSED",
};

/** Maps review states; PENDING (unsubmitted, invisible to others) reviews are dropped. */
export function normalizeReviews(nodes: readonly GqlReview[]): Review[] {
  const out: Review[] = [];
  for (const n of nodes) {
    const state = STATES[n.state];
    if (!state || !n.submittedAt) continue;
    out.push({ author: normalizeActor(n.author), state, submittedAt: toIsoSeconds(n.submittedAt) });
  }
  return out.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
}

export function toIsoSeconds(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`invalid timestamp ${iso}`);
  return new Date(Math.floor(t / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export function normalizePullRequest(repo: string, pr: GqlPullRequest, extraReviews: readonly GqlReview[] = []): ChangeRecord {
  if (!pr.merged || !pr.mergedAt || !pr.mergeCommit) throw new Error(`github:${repo}#${pr.number} is not merged`);
  return {
    id: `github:${repo}#${pr.number}`,
    kind: "pull_request",
    repo,
    url: pr.url,
    mergeSha: pr.mergeCommit.oid.toLowerCase(),
    mergedAt: toIsoSeconds(pr.mergedAt),
    author: normalizeActor(pr.author),
    mergedBy: pr.mergedBy ? normalizeActor(pr.mergedBy) : null,
    reviews: normalizeReviews([...pr.reviews.nodes, ...extraReviews]),
    changedLines: pr.additions + pr.deletions,
    labels: pr.labels.nodes.map((l) => l.name).sort(),
  };
}

/**
 * The commit author of a direct push. GitHub's commit APIs do not expose who
 * pushed, so `author` is the commit author and `mergedBy` is null.
 */
export function normalizeCommitAuthor(c: GqlHistoryCommit): Actor {
  const login = c.author?.user?.login;
  if (login) return { login, kind: login.endsWith(BOT_SUFFIX) ? "bot" : "human" };
  const name = c.author?.name ?? "";
  if (name.endsWith(BOT_SUFFIX)) return { login: name, kind: "bot" };
  return { login: `git:${c.author?.email || name || "unknown"}`, kind: "human" };
}

export function normalizeDirectPush(repo: string, c: GqlHistoryCommit): ChangeRecord {
  return {
    id: `github:${repo}@${c.oid.toLowerCase()}`,
    kind: "direct_push",
    repo,
    url: c.url,
    mergeSha: c.oid.toLowerCase(),
    mergedAt: toIsoSeconds(c.committedDate),
    author: normalizeCommitAuthor(c),
    mergedBy: null,
    reviews: [],
    changedLines: c.additions + c.deletions,
    labels: [],
  };
}
