/** An actor with its stable account id (`databaseId`, which survives a rename): Actor.id (U3). */
export const ACTOR = "__typename login ... on User { databaseId } ... on Bot { databaseId } ... on Mannequin { databaseId } ... on Organization { databaseId }";

export const PR_FIELDS = `
  number url merged mergedAt baseRefName additions deletions
  author { ${ACTOR} }
  mergedBy { ${ACTOR} }
  mergeCommit { oid }
  labels(first: 50) { totalCount pageInfo { hasNextPage endCursor } nodes { name } }
  reviews(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { state submittedAt author { ${ACTOR} } } }`;

/** One query for up to `numbers.length` PRs via aliases (pr-rla uses batches of 40: 100 returned HTTP 502 on gh-aw). */
export function prBatchQuery(numbers: readonly number[]): string {
  const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${PR_FIELDS} }`).join("\n    ");
  return `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`;
}

export const MORE_REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { state submittedAt author { ${ACTOR} } } }
    }
  }
}`;

/** The rest of a PR's labels, when it carries more than the first 50 (an unpaged cap would drop a label the selector filters on). */
export const MORE_LABELS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      labels(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { name } }
    }
  }
}`;

export const HEAD_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { defaultBranchRef { name target { oid } } }
}`;

const COMMIT_FIELDS = `oid url committedDate additions deletions
  parents(first: 2) { totalCount nodes { oid } }
  author { name email user { login databaseId } }
  associatedPullRequests(first: 5) { totalCount pageInfo { hasNextPage endCursor } nodes { number merged baseRefName } }`;

/**
 * The history query keeps its page cheap (a commit has two parents and is rarely in more than five
 * PRs), and says when a commit exceeds that: these two read the rest of one commit, so an octopus merge
 * or a commit in many PRs is never truncated silently (finding 10 of the master review).
 */
export const COMMIT_PARENTS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit { parents(first: 100) { totalCount nodes { oid } } } }
  }
}`;

export const COMMIT_PRS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $after: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit { associatedPullRequests(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { number merged baseRefName } } } }
  }
}`;

/**
 * Default-branch history from a PINNED head oid (so new pushes during the walk
 * cannot shift the cursor). associatedPullRequests uses first: 5, not 1: a
 * commit can belong to several PRs and first: 1 could return an unmerged one.
 */
export function historyQuery(pageSize: number): string {
  return `query($owner: String!, $name: String!, $head: GitObjectID!, $since: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $head) { ... on Commit { history(first: ${pageSize}, since: $since, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${COMMIT_FIELDS} } } } }
  }
}`;
}
