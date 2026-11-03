import type { Actor, ChangeRecord, Review } from "../../sdk/provider.js";
import { isoUtcSeconds } from "../http.js";

/** The subsets of Bitbucket Cloud 2.0 responses pr-rla reads. */
export interface BbUser {
  /** `user`, `team`, or `app_user` (access tokens, Connect/Forge apps). */
  type?: string;
  uuid?: string;
  nickname?: string;
  display_name?: string;
  account_id?: string;
}

export interface BbParticipant {
  role?: string;
  approved?: boolean;
  /** `approved`, `changes_requested`, or null. */
  state?: string | null;
  participated_on?: string | null;
  user: BbUser;
}

export interface BbPullRequest {
  id: number;
  updated_on: string;
  destination: { branch: { name: string } };
  source?: { commit?: { hash: string } | null };
  /** Usually a 12-character abbreviated hash. */
  merge_commit: { hash: string } | null;
  author: BbUser | null;
  closed_by?: BbUser | null;
  links?: { html?: { href: string } };
  participants?: BbParticipant[];
}

export type BbActivity =
  | { update: { state: string; date: string; author?: BbUser | null } }
  | { approval: { date: string; user: BbUser } }
  | { changes_requested: { date: string; user: BbUser } }
  | { comment: { created_on: string; user: BbUser | null } }
  | Record<string, unknown>;

export interface BbCommit {
  hash: string;
  /** The committer date (checked against git for atlassian/bamboo-specs 614ea18d). */
  date: string;
  parents: { hash: string }[];
  message?: string;
  author?: { raw?: string; user?: BbUser | null };
  links?: { html?: { href: string } };
}

export const BOT_SUFFIX = "[bot]";
const BOT_EMAIL = /@bots\.bitbucket\.org>?$/i;

/** A stable key per account, for matching activity to participants. */
export const userKey = (u: BbUser | null | undefined) => u?.uuid ?? u?.account_id ?? u?.nickname ?? u?.display_name ?? "unknown";

/**
 * Bitbucket Cloud accounts are `type: "user"` (people), `"team"` (workspaces) or
 * `"app_user"` (workspace/project/repository access tokens and apps, e.g.
 * atlassian-renovate-bot). Anything but `user` is a bot. The login is the
 * public `nickname` (falling back to `display_name`, then the uuid); bots get the
 * `[bot]` suffix. Nicknames are neither unique nor permanent.
 */
export function normalizeUser(u: BbUser | null | undefined): Actor {
  if (!u) return { login: "ghost", kind: "human" };
  const name = (u.type === "user" ? (u.nickname ?? u.display_name) : (u.display_name ?? u.nickname)) ?? u.uuid ?? "unknown";
  const bot = (u.type !== undefined && u.type !== "user") || name.endsWith(BOT_SUFFIX);
  return bot ? { login: name.endsWith(BOT_SUFFIX) ? name : `${name}${BOT_SUFFIX}`, kind: "bot" } : { login: name, kind: "human" };
}

/** A commit's author: the linked account if Bitbucket matched one, else the git identity. */
export function normalizeCommitAuthor(c: Pick<BbCommit, "author">): Actor {
  if (c.author?.user) return normalizeUser(c.author.user);
  const raw = c.author?.raw ?? "";
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(raw);
  const name = (m ? m[1] : raw) ?? "";
  const email = m?.[2] ?? "";
  if (BOT_EMAIL.test(raw) || name.endsWith(BOT_SUFFIX)) return { login: name.endsWith(BOT_SUFFIX) ? name : `${name}${BOT_SUFFIX}`, kind: "bot" };
  return { login: `git:${email || name || "unknown"}`, kind: "human" };
}

/**
 * Reviews from the PR activity, reconciled with the participants' final state:
 * - `approval` -> APPROVED, `changes_requested` -> CHANGES_REQUESTED, at their dates;
 * - a `comment` by anyone but the author -> one COMMENTED per user, at the first;
 * - a participant whose final state is `approved` / `changes_requested` with no such
 *   activity -> that state at `participated_on` (or the merge time).
 * Bitbucket drops an approval from the activity when it is withdrawn, so a revoked
 * approval leaves no trace (no DISMISSED, unlike GitHub and GitLab).
 */
export function buildReviews(args: { author: BbUser | null; activity: readonly BbActivity[]; participants: readonly BbParticipant[]; mergedAt: string }): Review[] {
  const out: (Review & { key: string })[] = [];
  const commented = new Set<string>();
  const authorKey = userKey(args.author);
  for (const a of args.activity) {
    if ("approval" in a && a.approval) {
      const x = a.approval as { date: string; user: BbUser };
      out.push({ author: normalizeUser(x.user), state: "APPROVED", submittedAt: isoUtcSeconds(x.date), key: userKey(x.user) });
    } else if ("changes_requested" in a && a.changes_requested) {
      const x = a.changes_requested as { date: string; user: BbUser };
      out.push({ author: normalizeUser(x.user), state: "CHANGES_REQUESTED", submittedAt: isoUtcSeconds(x.date), key: userKey(x.user) });
    } else if ("comment" in a && a.comment) {
      const x = a.comment as { created_on: string; user: BbUser | null };
      const k = userKey(x.user);
      if (!x.user || k === authorKey) continue;
      out.push({ author: normalizeUser(x.user), state: "COMMENTED", submittedAt: isoUtcSeconds(x.created_on), key: k });
    }
  }
  // Keep only each user's FIRST comment (activity is newest first).
  out.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
  const reviews = out.filter((r) => {
    if (r.state !== "COMMENTED") return true;
    if (commented.has(r.key)) return false;
    commented.add(r.key);
    return true;
  });
  for (const p of args.participants) {
    const k = userKey(p.user);
    const at = isoUtcSeconds(p.participated_on ?? args.mergedAt);
    if (p.state === "approved" && !reviews.some((r) => r.key === k && r.state === "APPROVED")) reviews.push({ author: normalizeUser(p.user), state: "APPROVED", submittedAt: at, key: k });
    if (p.state === "changes_requested" && !reviews.some((r) => r.key === k && r.state === "CHANGES_REQUESTED")) reviews.push({ author: normalizeUser(p.user), state: "CHANGES_REQUESTED", submittedAt: at, key: k });
  }
  return reviews
    .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0))
    .map(({ key: _k, ...r }) => r);
}

/** The PR's MERGED event: when it merged and who merged it. Activity is newest first; the latest MERGED update wins. */
export function mergeEvent(activity: readonly BbActivity[]): { at: string; by: BbUser | null } | null {
  for (const a of activity) {
    if ("update" in a && a.update && (a.update as { state?: string }).state === "MERGED") {
      const u = a.update as { date: string; author?: BbUser | null };
      return { at: u.date, by: u.author ?? null };
    }
  }
  return null;
}

/**
 * A rebase re-creates commits with new SHAs but keeps the author and message.
 * Used to attribute rebased commits to their PR when Bitbucket lists the PR's
 * original commits.
 */
export const rebaseKey = (c: Pick<BbCommit, "author" | "message">) => `${c.author?.raw ?? ""}\u0000${(c.message ?? "").split("\n")[0]!.trim()}`;

export function normalizePullRequest(repo: string, pr: BbPullRequest, args: { mergeSha: string; mergedAt: string; mergedBy: BbUser | null; reviews: Review[]; changedLines: number; webBase: string }): ChangeRecord {
  return {
    id: `bitbucket-cloud:${repo}#${pr.id}`,
    kind: "pull_request",
    repo,
    url: pr.links?.html?.href ?? `${args.webBase}/${repo}/pull-requests/${pr.id}`,
    mergeSha: args.mergeSha.toLowerCase(),
    mergedAt: isoUtcSeconds(args.mergedAt),
    author: normalizeUser(pr.author),
    mergedBy: args.mergedBy ? normalizeUser(args.mergedBy) : null,
    reviews: args.reviews,
    changedLines: args.changedLines,
    labels: [],
  };
}

export function normalizeDirectPush(repo: string, c: BbCommit, changedLines: number, webBase: string): ChangeRecord {
  const sha = c.hash.toLowerCase();
  return {
    id: `bitbucket-cloud:${repo}@${sha}`,
    kind: "direct_push",
    repo,
    url: c.links?.html?.href ?? `${webBase}/${repo}/commits/${sha}`,
    mergeSha: sha,
    mergedAt: isoUtcSeconds(c.date),
    author: normalizeCommitAuthor(c),
    mergedBy: null,
    reviews: [],
    changedLines,
    labels: [],
  };
}
