export const PR_FIELDS = `
  number url merged mergedAt baseRefName additions deletions
  author { __typename login }
  mergedBy { __typename login }
  mergeCommit { oid }
  labels(first: 50) { nodes { name } }
  reviews(first: 100) { totalCount pageInfo { hasNextPage endCursor } nodes { state submittedAt author { __typename login } } }`;

/** One query for up to `numbers.length` PRs via aliases (pr-rla uses batches of 40: 100 returned HTTP 502 on gh-aw). */
export function prBatchQuery(numbers: readonly number[]): string {
  const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${PR_FIELDS} }`).join("\n    ");
  return `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`;
}

export const MORE_REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { state submittedAt author { __typename login } } }
    }
  }
}`;

export const HEAD_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { defaultBranchRef { name target { oid } } }
}`;

const COMMIT_FIELDS = `oid url committedDate additions deletions
  parents(first: 2) { nodes { oid } }
  author { name email user { login } }
  associatedPullRequests(first: 5) { nodes { number merged baseRefName } }`;

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

export const COMMIT_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { ${COMMIT_FIELDS} } } }
}`;
