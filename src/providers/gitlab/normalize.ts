import type { Actor, ChangeRecord, Review, ReviewState } from "../../sdk/provider.js";
import { isoUtcSeconds } from "../http.js";

/** The subsets of GitLab REST (v4) and GraphQL responses pr-rla reads. */
export interface GlUser {
  /** REST: the numeric user id; GraphQL: the global id `gid://gitlab/User/<n>`. */
  id?: number | string;
  username: string;
  /** Present on MR `author` in REST, and on every GraphQL user. */
  bot?: boolean;
}

export interface GlMergeRequest {
  iid: number;
  web_url: string;
  state: string;
  target_branch: string;
  merged_at: string | null;
  updated_at: string;
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
  /** Head of the source branch; what lands on a fast-forward merge. */
  sha: string | null;
  author: GlUser | null;
  merge_user?: GlUser | null;
  merged_by?: GlUser | null;
  labels: string[];
}

export interface GlApprovals {
  approved_by: { user: GlUser; approved_at?: string | null }[];
}

export interface GlReviewer {
  user: GlUser;
  /** unreviewed | review_started | reviewed | requested_changes | approved | unapproved */
  state?: string;
  created_at?: string;
}

export interface GlNote {
  system: boolean;
  body: string;
  createdAt: string;
  author: GlUser | null;
  /**
   * GitLab's own tag for a system note (GraphQL `systemNoteMetadata.action`): `approved`, `unapproved`,
   * `requested_changes`, `reviewed`, `approvals_reset`, … It does not depend on the instance's language;
   * the English body is read only when it is absent (an older instance).
   */
  systemNoteMetadata?: { action: string | null } | null;
}

export interface GlCommit {
  id: string;
  web_url: string;
  committed_date: string;
  author_name: string;
  author_email: string;
  parent_ids: string[];
  stats?: { additions: number; deletions: number };
}

/** GitLab's own bot users: project and group access tokens, service accounts. */
const BOT_USERNAME = /^(?:(?:project|group)_\d+_bot(?:_[0-9a-f]+)?\d*|service_account_.+)$/;
const BOT_EMAIL = /^(?:(?:project|group)_?\d+_bot[^@]*|service_account_[^@]+)@noreply\./;
export const BOT_SUFFIX = "[bot]";

/**
 * GitLab marks bot users with `bot: true` (GraphQL on every user; REST only on
 * an MR's author). Project/group access-token users and service accounts are
 * bots by construction, so their usernames count too. A deleted account is
 * GitLab's `ghost` user: human, as on GitHub (a ghost approval still counts).
 * Bots are normalized to the `login[bot]` form the provider SDK specifies.
 */
export function normalizeUser(u: GlUser | null | undefined, botByUsername: ReadonlyMap<string, boolean> = new Map(), idByUsername: ReadonlyMap<string, string> = new Map()): Actor {
  if (!u) return { login: "ghost", kind: "human" };
  const name = u.username.endsWith(BOT_SUFFIX) ? u.username.slice(0, -BOT_SUFFIX.length) : u.username;
  const bot = botByUsername.get(name) === true || u.bot === true || BOT_USERNAME.test(name) || u.username.endsWith(BOT_SUFFIX);
  const id = userId(u) ?? idByUsername.get(u.username);
  const extra = id !== undefined ? { id } : {};
  return bot ? { login: `${name}${BOT_SUFFIX}`, kind: "bot", ...extra } : { login: name, kind: "human", ...extra };
}

/** The user's numeric id as a string, from REST (`123`) or GraphQL (`gid://gitlab/User/123`). Actor.id (U3). */
export function userId(u: Pick<GlUser, "id"> | null | undefined): string | undefined {
  if (u?.id === undefined || u.id === null) return undefined;
  const m = /(\d+)$/.exec(String(u.id));
  return m ? m[1] : undefined;
}

/** The author of a default-branch commit: GitLab links no account to it, so the git identity is used. */
export function normalizeCommitAuthor(c: Pick<GlCommit, "author_name" | "author_email">): Actor {
  const name = c.author_name ?? "";
  const email = c.author_email ?? "";
  if (BOT_EMAIL.test(email)) return { login: `${email.split("@")[0]}${BOT_SUFFIX}`, kind: "bot" };
  if (name.endsWith(BOT_SUFFIX)) return { login: name, kind: "bot" };
  return { login: `git:${email || name || "unknown"}`, kind: "human" };
}

const APPROVED = /^approved this merge request\s*$/i;
const UNAPPROVED = /^unapproved this merge request\s*$/i;
const REQUESTED_CHANGES = /^requested changes\s*$/i;
const RESET = /^reset approvals from (.+?) by pushing to the branch/i;
// (RESET, APPROVED, UNAPPROVED and REQUESTED_CHANGES are the English texts, the fallback for a note GitLab did not tag.)

/**
 * Builds the review list of one MR, as events in time order. System notes are read by GitLab's own
 * tag (`systemNoteMetadata.action`), which does not change with the instance's language, and by
 * their English text only when a note has no tag:
 * - `approved` ("approved this merge request") -> APPROVED;
 * - `requested_changes` ("requested changes") -> CHANGES_REQUESTED (GitLab 17+ reviewer states);
 * - `unapproved` ("unapproved this merge request"), or `approvals_reset` ("reset approvals from
 *   @a … by pushing to the branch"; the tag says it is a reset, the @references say whose) ->
 *   that user's last approval becomes DISMISSED (it no longer stood);
 * - a user's non-system note on someone else's MR -> one COMMENTED at their first note.
 * Then reconciled with the REST approvals (`approved_by`, with `approved_at`) and
 * reviewer states, for approvals or states the notes do not show. A reviewer
 * state with no note has no review time; its review-request time is used.
 */
export function buildReviews(args: {
  mrAuthor: string | null;
  notes: readonly GlNote[];
  approvals: GlApprovals | null;
  reviewers: readonly GlReviewer[];
  mergedAt: string;
  actor: (u: GlUser | null) => Actor;
  /** Called for an approval-reset note whose approvers it could not read from the body (the reset is then not applied). */
  onUnreadableReset?: (note: GlNote) => void;
}): Review[] {
  const out: (Review & { key: string })[] = [];
  const standing = new Map<string, number>();
  const commented = new Set<string>();
  const add = (u: GlUser, state: ReviewState, at: string) => {
    out.push({ author: args.actor(u), state, submittedAt: isoUtcSeconds(at), key: u.username });
    return out.length - 1;
  };
  const dismiss = (username: string) => {
    const i = standing.get(username);
    if (i !== undefined) out[i]!.state = "DISMISSED";
    standing.delete(username);
  };
  const notes = [...args.notes].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const n of notes) {
    if (!n.author) continue;
    const u = n.author.username;
    const body = n.body.trim();
    if (n.system) {
      // GitLab tags its system notes (systemNoteMetadata.action); the tag is the same in every language.
      // A note with no tag (an older instance) is read by its English text, as before.
      const action = n.systemNoteMetadata?.action ?? null;
      const tagged = n.systemNoteMetadata !== undefined && n.systemNoteMetadata !== null;
      if (action === "approved" || (!tagged && APPROVED.test(body))) standing.set(u, add(n.author, "APPROVED", n.createdAt));
      else if (action === "unapproved" || (!tagged && UNAPPROVED.test(body))) dismiss(u);
      else if (action === "requested_changes" || (!tagged && REQUESTED_CHANGES.test(body))) add(n.author, "CHANGES_REQUESTED", n.createdAt);
      else if (action === "approvals_reset" || (!tagged && RESET.test(body))) {
        // Who was reset is named in the note as @references (`reset approvals from @a and @b by pushing …`).
        const who = [...body.matchAll(/@([\w.-]+)/g)].map((m) => m[1]!);
        if (who.length === 0) args.onUnreadableReset?.(n);
        for (const w of who) dismiss(w);
      }
    } else if (u !== args.mrAuthor && !commented.has(u)) {
      commented.add(u);
      add(n.author, "COMMENTED", n.createdAt);
    }
  }
  for (const a of args.approvals?.approved_by ?? []) {
    if (!standing.has(a.user.username)) standing.set(a.user.username, add(a.user, "APPROVED", a.approved_at ?? args.mergedAt));
  }
  for (const r of args.reviewers) {
    const u = r.user.username;
    const at = r.created_at ?? args.mergedAt;
    if (r.state === "requested_changes" && !out.some((e) => e.key === u && e.state === "CHANGES_REQUESTED")) add(r.user, "CHANGES_REQUESTED", at);
    if (r.state === "reviewed" && !out.some((e) => e.key === u)) add(r.user, "COMMENTED", at);
  }
  return out
    .map(({ key: _key, ...r }) => r)
    .sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
}

/** The commit an MR landed as: its merge commit, else its squash commit, else (fast-forward) its head. */
export function landedSha(mr: Pick<GlMergeRequest, "merge_commit_sha" | "squash_commit_sha" | "sha" | "iid">): string {
  const s = mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha;
  if (!s) throw new Error(`gitlab: merged MR !${mr.iid} has no merge, squash or head commit`);
  return s.toLowerCase();
}

export function normalizeMergeRequest(repo: string, mr: GlMergeRequest, reviews: Review[], changedLines: number, actor: (u: GlUser | null) => Actor): ChangeRecord {
  if (!mr.merged_at) throw new Error(`gitlab:${repo}#${mr.iid} is not merged`);
  const merger = mr.merge_user ?? mr.merged_by ?? null;
  return {
    id: `gitlab:${repo}#${mr.iid}`,
    kind: "pull_request",
    repo,
    url: mr.web_url,
    mergeSha: landedSha(mr),
    mergedAt: isoUtcSeconds(mr.merged_at),
    author: actor(mr.author),
    mergedBy: merger ? actor(merger) : null,
    reviews,
    changedLines,
    labels: [...mr.labels].sort(),
  };
}

export function normalizeDirectPush(repo: string, c: GlCommit, landedVia?: string): ChangeRecord {
  const sha = c.id.toLowerCase();
  return {
    id: `gitlab:${repo}@${sha}`,
    kind: "direct_push",
    repo,
    url: c.web_url,
    mergeSha: sha,
    mergedAt: isoUtcSeconds(c.committed_date),
    author: normalizeCommitAuthor(c),
    mergedBy: null,
    reviews: [],
    changedLines: (c.stats?.additions ?? 0) + (c.stats?.deletions ?? 0),
    labels: [],
    ...(landedVia ? { landedVia } : {}),
  };
}

/** Counts added/removed lines in a GitLab `diff` field (hunks only, no file headers, so every +/- line is content). */
export function countDiffLines(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) if (line.startsWith("+") || line.startsWith("-")) n++;
  return n;
}
