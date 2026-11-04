import type { Actor, ChangeRecord, Review } from "../../sdk/provider.js";
import { isoUtcSeconds } from "../http.js";

/**
 * The subsets of Bitbucket Data Center / Server REST 1.0 responses pr-rla reads,
 * from Atlassian's documented shapes. UNVERIFIED against a live server.
 */
export interface DcUser {
  /** The user's numeric id: stable across renames of name and slug (Actor.id, U3). */
  id?: number;
  name?: string;
  slug?: string;
  emailAddress?: string;
  displayName?: string;
  /** `NORMAL` (a person) or `SERVICE` (access-token and other service users). */
  type?: string;
}

export interface DcParticipant {
  user: DcUser;
  role?: string;
  approved?: boolean;
  /** APPROVED, NEEDS_WORK or UNAPPROVED. */
  status?: string;
}

export interface DcPullRequest {
  id: number;
  state: string;
  createdDate: number;
  updatedDate: number;
  closedDate?: number;
  toRef: { id: string; displayId?: string };
  fromRef?: { latestCommit?: string };
  author: DcParticipant;
  reviewers?: DcParticipant[];
  participants?: DcParticipant[];
  properties?: { mergeCommit?: { id: string; displayId?: string } };
  links?: { self?: { href: string }[] };
}

export interface DcActivity {
  createdDate: number;
  user: DcUser;
  /** OPENED, APPROVED, UNAPPROVED, REVIEWED (needs work), COMMENTED, MERGED, DECLINED, RESCOPED, UPDATED, ... */
  action: string;
  commentAction?: string;
  /** On MERGED: the merge commit. */
  commit?: { id: string };
}

export interface DcCommit {
  id: string;
  message?: string;
  /** A Person; Bitbucket adds user fields (slug, type) when the e-mail matches an account. */
  author: DcUser;
  authorTimestamp?: number;
  committerTimestamp: number;
  parents: { id: string }[];
}

export interface DcDiff {
  diffs?: { hunks?: { segments: { type: string; lines: unknown[]; truncated?: boolean }[]; truncated?: boolean }[]; truncated?: boolean }[];
  truncated?: boolean;
}

export const BOT_SUFFIX = "[bot]";

/** `SERVICE` users are bots; people are `NORMAL`. The login is the user slug (falling back to the name). */
export function normalizeUser(u: DcUser | null | undefined): Actor {
  if (!u) return { login: "ghost", kind: "human" };
  const name = u.slug ?? u.name ?? u.displayName ?? "unknown";
  const bot = u.type === "SERVICE" || name.endsWith(BOT_SUFFIX);
  const id = typeof u.id === "number" ? { id: String(u.id) } : {};
  return bot ? { login: name.endsWith(BOT_SUFFIX) ? name : `${name}${BOT_SUFFIX}`, kind: "bot", ...id } : { login: name, kind: "human", ...id };
}

/** A commit author: the matched account when Bitbucket resolved one (it then carries `type`), else the git identity. */
export function normalizeCommitAuthor(c: Pick<DcCommit, "author">): Actor {
  if (c.author?.type) return normalizeUser(c.author);
  const name = c.author?.name ?? "";
  if (name.endsWith(BOT_SUFFIX)) return { login: name, kind: "bot" };
  return { login: `git:${c.author?.emailAddress || name || "unknown"}`, kind: "human" };
}

const key = (u: DcUser | null | undefined) => u?.slug ?? u?.name ?? "unknown";

/**
 * Reviews from the activities (oldest first after sorting), reconciled with the
 * reviewers' and participants' final status:
 * - APPROVED -> APPROVED; a later UNAPPROVED by the same user -> that approval DISMISSED;
 * - REVIEWED (the reviewer marked the PR "needs work") -> CHANGES_REQUESTED;
 * - COMMENTED (comment added) by anyone but the author -> one COMMENTED per user;
 * - final status APPROVED / NEEDS_WORK with no such activity -> that state with `timeUnknown` (P1): the
 *   final status has no time of its own (the merge time is recorded beside it), so it is no human decision.
 */
export function buildReviews(args: { author: DcUser; activities: readonly DcActivity[]; finals: readonly DcParticipant[]; mergedAtMs: number }): Review[] {
  const out: (Review & { key: string })[] = [];
  const standing = new Map<string, number>();
  const commented = new Set<string>();
  const authorKey = key(args.author);
  const acts = [...args.activities].sort((a, b) => a.createdDate - b.createdDate);
  for (const a of acts) {
    const k = key(a.user);
    const at = isoUtcSeconds(a.createdDate);
    if (a.action === "APPROVED") {
      out.push({ author: normalizeUser(a.user), state: "APPROVED", submittedAt: at, key: k });
      standing.set(k, out.length - 1);
    } else if (a.action === "UNAPPROVED") {
      const i = standing.get(k);
      if (i !== undefined) out[i]!.state = "DISMISSED";
      standing.delete(k);
    } else if (a.action === "REVIEWED") out.push({ author: normalizeUser(a.user), state: "CHANGES_REQUESTED", submittedAt: at, key: k });
    else if (a.action === "COMMENTED" && (a.commentAction ?? "ADDED") === "ADDED" && k !== authorKey && !commented.has(k)) {
      commented.add(k);
      out.push({ author: normalizeUser(a.user), state: "COMMENTED", submittedAt: at, key: k });
    }
  }
  const at = isoUtcSeconds(args.mergedAtMs);
  for (const p of args.finals) {
    const k = key(p.user);
    if (p.status === "APPROVED" && !standing.has(k)) out.push({ author: normalizeUser(p.user), state: "APPROVED", submittedAt: at, timeUnknown: true, key: k });
    if (p.status === "NEEDS_WORK" && !out.some((r) => r.key === k && r.state === "CHANGES_REQUESTED")) out.push({ author: normalizeUser(p.user), state: "CHANGES_REQUESTED", submittedAt: at, timeUnknown: true, key: k });
  }
  return out.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0)).map(({ key: _k, ...r }) => r);
}

/** Lines in ADDED and REMOVED segments of a diff (contextLines=0), and whether Bitbucket truncated it. */
export function countDiff(d: DcDiff): { lines: number; truncated: boolean } {
  let lines = 0;
  let truncated = !!d.truncated;
  for (const f of d.diffs ?? []) {
    truncated ||= !!f.truncated;
    for (const h of f.hunks ?? []) {
      truncated ||= !!h.truncated;
      for (const s of h.segments) if (s.type === "ADDED" || s.type === "REMOVED") lines += s.lines.length;
    }
  }
  return { lines, truncated };
}

/** A rebase keeps the author, the author time and the message; the SHA changes. */
export const rebaseKey = (c: Pick<DcCommit, "author" | "authorTimestamp" | "message">) => `${c.author?.emailAddress ?? c.author?.name ?? ""}\u0000${c.authorTimestamp ?? ""}\u0000${(c.message ?? "").split("\n")[0]!.trim()}`;

export function normalizePullRequest(repo: string, pr: DcPullRequest, args: { mergeSha: string; mergedAtMs: number; mergedBy: DcUser | null; reviews: Review[]; changedLines: number; webBase: string }): ChangeRecord {
  return {
    id: `bitbucket-data-center:${repo}#${pr.id}`,
    kind: "pull_request",
    repo,
    url: pr.links?.self?.[0]?.href ?? `${args.webBase}/pull-requests/${pr.id}`,
    mergeSha: args.mergeSha.toLowerCase(),
    mergedAt: isoUtcSeconds(args.mergedAtMs),
    author: normalizeUser(pr.author.user),
    mergedBy: args.mergedBy ? normalizeUser(args.mergedBy) : null,
    reviews: args.reviews,
    changedLines: args.changedLines,
    labels: [],
  };
}

export function normalizeDirectPush(repo: string, c: DcCommit, changedLines: number, webBase: string, landedVia?: string): ChangeRecord {
  const sha = c.id.toLowerCase();
  return {
    id: `bitbucket-data-center:${repo}@${sha}`,
    kind: "direct_push",
    repo,
    url: `${webBase}/commits/${sha}`,
    mergeSha: sha,
    mergedAt: isoUtcSeconds(c.committerTimestamp),
    author: normalizeCommitAuthor(c),
    mergedBy: null,
    reviews: [],
    changedLines,
    labels: [],
    ...(landedVia ? { landedVia } : {}),
  };
}
