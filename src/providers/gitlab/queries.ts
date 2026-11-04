/** GitLab GraphQL: review notes, bot flags and diff stats for a batch of MRs (readable without a token on public projects, unlike REST notes). */
export interface GqlUser {
  /** Global id, e.g. `gid://gitlab/User/1786152` (the REST id is the number at its end). */
  id?: string;
  username: string;
  bot: boolean;
}

export interface GqlNotesPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { system: boolean; body: string; createdAt: string; author: GqlUser | null; systemNoteMetadata?: { action: string | null } | null }[];
}

export interface GqlUsersPage {
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  nodes: GqlUser[];
}

export interface GqlMergeRequest {
  iid: string;
  diffStatsSummary: { additions: number; deletions: number } | null;
  author: GqlUser | null;
  mergeUser: GqlUser | null;
  approvedBy: GqlUsersPage;
  reviewers: GqlUsersPage;
  notes: GqlNotesPage;
}

const USER = "id username bot";
const NOTES = `pageInfo { hasNextPage endCursor } nodes { system body createdAt systemNoteMetadata { action } author { ${USER} } }`;
const USERS = `pageInfo { hasNextPage endCursor } nodes { ${USER} }`;

export const MR_BATCH_QUERY = `query($path: ID!, $iids: [String!], $first: Int) {
  project(fullPath: $path) {
    mergeRequests(iids: $iids, first: $first) {
      nodes {
        iid
        diffStatsSummary { additions deletions }
        author { ${USER} }
        mergeUser { ${USER} }
        approvedBy(first: 100) { ${USERS} }
        reviewers(first: 100) { ${USERS} }
        notes(first: 100) { ${NOTES} }
      }
    }
  }
}`;

export const MORE_NOTES_QUERY = `query($path: ID!, $iid: String!, $after: String) {
  project(fullPath: $path) { mergeRequest(iid: $iid) { notes(first: 100, after: $after) { ${NOTES} } } }
}`;

/** The rest of an MR's approvers or reviewers past the first 100 (so a bot flag is never missing for one of them). */
export const MORE_APPROVERS_QUERY = `query($path: ID!, $iid: String!, $after: String) {
  project(fullPath: $path) { mergeRequest(iid: $iid) { approvedBy(first: 100, after: $after) { ${USERS} } } }
}`;

export const MORE_REVIEWERS_QUERY = `query($path: ID!, $iid: String!, $after: String) {
  project(fullPath: $path) { mergeRequest(iid: $iid) { reviewers(first: 100, after: $after) { ${USERS} } } }
}`;
